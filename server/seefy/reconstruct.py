"""Markerless room reconstruction from a walk recorded on the phone.

Pipeline (structure-from-motion with COLMAP, CPU):
  1. SIFT features in every frame
  2. match each frame with its neighbours in time (sequential matching)
  3. incremental mapping: camera poses + sparse 3D points of the room's fixed features

Then put it in room coordinates:
  - up:     gravity from the phone's motion sensor at each frame, or, without motion data,
            the average "up" direction of the camera (phones are held roughly upright)
  - floor:  a low percentile of point heights
  - scale:  structure-from-motion has no absolute scale. Fit it from the phone's
            accelerometer (imu.py); if that fit is poor, assume the phone was held at
            chest height (config: scan.camera_height_m)
  - origin: on the floor, below the first camera
"""

from __future__ import annotations

import json
import shutil
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

import numpy as np

from . import imu

Progress = Callable[[str, float], None]


@dataclass
class Result:
    ok: bool
    error: str = ""
    frames: list[dict] = field(default_factory=list)  # name, t, p (world), R (world_from_cam, row-major)
    points: list[list[float]] = field(default_factory=list)
    registered: int = 0
    total: int = 0
    scale: float = 1.0
    scale_method: str = ""
    imu: dict = field(default_factory=dict)  # accelerometer scale fit details
    up_method: str = ""
    floor_z: float = 0.0
    room_size_m: list[float] = field(default_factory=list)
    timings_s: dict[str, float] = field(default_factory=dict)

    def to_json(self) -> dict:
        return self.__dict__


def _up_vector(cams: list[tuple[np.ndarray, np.ndarray]], down_cam: dict[int, np.ndarray]) -> tuple[np.ndarray, str]:
    """Up direction in the reconstruction frame.

    cams: (R_world_cam, centre) per registered frame. down_cam: frame index -> gravity direction in camera axes.
    """
    if down_cam:
        ups = [-(R @ down_cam[i]) for i, (R, _) in enumerate(cams) if i in down_cam]
        if len(ups) >= 3:
            u = np.mean(ups, axis=0)
            return u / np.linalg.norm(u), "gravity"
    # Camera y points down in the image; held upright, -y is roughly world up.
    u = np.mean([-R[:, 1] for R, _ in cams], axis=0)
    return u / np.linalg.norm(u), "camera orientation"


def _rotation_to_z(u: np.ndarray) -> np.ndarray:
    """Rotation taking unit vector u to +z."""
    z = np.array([0.0, 0.0, 1.0])
    v = np.cross(u, z)
    c = float(np.dot(u, z))
    if np.linalg.norm(v) < 1e-9:
        return np.eye(3) if c > 0 else np.diag([1.0, -1.0, -1.0])
    vx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + vx + vx @ vx * (1 / (1 + c))


def _quiet_colmap() -> None:
    """COLMAP logs every frame at INFO level; keep warnings and errors only."""
    import os

    os.environ.setdefault("GLOG_minloglevel", "1")


def run(images: Path, work: Path, frame_times: dict[str, float], down_cam: dict[str, list[float]],
        cfg: dict, progress: Progress = lambda stage, frac: None,
        motion: tuple[np.ndarray, np.ndarray] | None = None) -> Result:
    """Reconstruct a scan. frame_times / down_cam are keyed by image file name.

    motion: (times in ms, device-frame accelerations without gravity in m/s²) for metric scale.
    """
    _quiet_colmap()
    import pycolmap

    t_start = time.perf_counter()
    timings: dict[str, float] = {}
    if work.exists():
        shutil.rmtree(work)
    work.mkdir(parents=True)
    db = work / "database.db"
    names = sorted(p.name for p in images.iterdir() if p.suffix.lower() in (".jpg", ".jpeg", ".png"))
    if len(names) < 10:
        return Result(False, f"only {len(names)} frames; record a longer scan")

    progress("features", 0.05)
    t0 = time.perf_counter()
    reader = pycolmap.ImageReaderOptions()
    reader.camera_model = cfg["camera_model"]
    extraction = pycolmap.FeatureExtractionOptions()
    extraction.max_image_size = cfg["max_image_size"]
    extraction.sift.max_num_features = cfg["max_features"]
    pycolmap.extract_features(db, images, image_names=names, camera_mode=pycolmap.CameraMode.SINGLE,
                              reader_options=reader, extraction_options=extraction)
    timings["features"] = time.perf_counter() - t0

    progress("matching", 0.35)
    t0 = time.perf_counter()
    pairing = pycolmap.SequentialPairingOptions()
    pairing.overlap = cfg["match_overlap"]
    pairing.quadratic_overlap = True
    pycolmap.match_sequential(db, pairing_options=pairing)
    timings["matching"] = time.perf_counter() - t0

    progress("mapping", 0.6)
    t0 = time.perf_counter()
    opts = pycolmap.IncrementalPipelineOptions()
    opts.multiple_models = True  # a bad starting pair then costs one small model, not the whole scan
    opts.min_model_size = 5
    models = pycolmap.incremental_mapping(db, images, work / "sparse", options=opts)
    timings["mapping"] = time.perf_counter() - t0
    if not models:
        return Result(False, "couldn't reconstruct: move slower and keep corners, doors or lights in view",
                      total=len(names), timings_s=timings)
    rec = max(models.values(), key=lambda r: r.num_reg_images())

    progress("aligning", 0.95)
    imgs = sorted(rec.images.values(), key=lambda im: im.name)
    cams = []
    for im in imgs:
        T = im.cam_from_world().matrix()  # 3x4
        R_cw, t_cw = T[:, :3], T[:, 3]
        cams.append((R_cw.T, -R_cw.T @ t_cw))
    down = {i: np.asarray(down_cam[im.name], dtype=float) for i, im in enumerate(imgs) if im.name in down_cam}
    up, up_method = _up_vector(cams, down)
    Rz = _rotation_to_z(up)

    pts = np.array([p.xyz for p in rec.points3D.values()]) @ Rz.T
    centres = np.array([c for _, c in cams]) @ Rz.T
    # Floor: low percentile of points below the cameras (ignores stray points far underneath).
    below = pts[pts[:, 2] < np.median(centres[:, 2])]
    floor_z = float(np.percentile(below[:, 2], cfg["floor_percentile"])) if len(below) > 20 else float(pts[:, 2].min())
    cam_height = float(np.median(centres[:, 2]) - floor_z)
    scale = cfg["camera_height_m"] / cam_height if cam_height > 1e-6 else 1.0
    scale_method = f"assumed camera height {cfg['camera_height_m']} m"
    imu_info: dict = {}
    if motion is not None and len(motion[0]):
        timed = [i for i, im in enumerate(imgs) if frame_times.get(im.name) is not None]
        est = imu.estimate(
            np.array([frame_times[imgs[i].name] for i in timed]), centres[timed],
            np.stack([Rz @ cams[i][0] for i in timed]), motion[0], motion[1],
            min_correlation=cfg["imu_min_correlation"],
        )
        imu_info = {"ok": est.ok, "correlation": round(est.correlation, 3), "samples": est.samples,
                    "lag_ms": est.lag_ms, "reason": est.reason,
                    "camera_height_m": round(cam_height * est.scale, 3) if est.scale == est.scale else None}
        if est.ok:
            scale = est.scale
            scale_method = f"accelerometer (correlation {est.correlation:.2f})"

    origin = np.array([centres[0, 0], centres[0, 1], floor_z])
    pts_w = (pts - origin) * scale
    frames = []
    for im, (R_wc, c) in zip(imgs, cams):
        R = Rz @ R_wc
        p = (Rz @ c - origin) * scale
        frames.append({"name": im.name, "t": frame_times.get(im.name), "p": p.round(4).tolist(),
                       "R": R.round(5).ravel().tolist()})

    keep = pts_w[(pts_w[:, 2] > -0.3) & (pts_w[:, 2] < 3.0)]
    if len(keep) > cfg["max_points"]:
        keep = keep[np.random.default_rng(0).choice(len(keep), cfg["max_points"], replace=False)]
    span = keep.max(axis=0) - keep.min(axis=0) if len(keep) else np.zeros(3)
    timings["total"] = time.perf_counter() - t_start
    result = Result(
        True, frames=frames, points=keep.round(3).tolist(), registered=len(imgs), total=len(names),
        scale=round(scale, 5), scale_method=scale_method, imu=imu_info,
        up_method=up_method, floor_z=0.0, room_size_m=span.round(2).tolist(),
        timings_s={k: round(v, 1) for k, v in timings.items()},
    )
    (work / "result.json").write_text(json.dumps(result.to_json()))
    progress("done", 1.0)
    return result
