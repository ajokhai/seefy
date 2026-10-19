"""Markerless room reconstruction from a walk recorded on the phone.

Pipeline (structure-from-motion with COLMAP, CPU), run incrementally while scanning:
  1. SIFT features in each new frame
  2. match each frame with its neighbours in time (sequential matching)
  3. incremental mapping: register new frames into the existing map (camera poses + sparse
     3D points of the room's fixed features), so the map grows every few seconds

Then put any snapshot of the map in room coordinates (align):
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
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

import numpy as np

from . import imu, resources

Progress = Callable[[str, float], None]


@dataclass
class Result:
    ok: bool
    error: str = ""
    frames: list[dict] = field(default_factory=list)  # name, t, p (world), R (world_from_cam, row-major)
    points: list[list[float]] = field(default_factory=list)
    colors: list[list[int]] = field(default_factory=list)  # RGB per point, from the frames
    camera: dict = field(default_factory=dict)  # intrinsics for the frames as stored: width, height, fx, fy, cx, cy, k
    reproj_err_px: float | None = None  # mean distance between map points and where frames saw them
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


class Mapper:
    """A COLMAP workspace that grows as frames arrive.

    update() extracts features for frames it hasn't seen, matches them with their
    neighbours, and continues mapping from the previous model, so each update only
    pays for the new frames. Not thread-safe by itself; one update at a time.
    """

    def __init__(self, images: Path, work: Path, cfg: dict, fresh: bool = True):
        self.images, self.work, self.cfg = images, work, cfg
        if fresh and work.exists():
            shutil.rmtree(work)
        work.mkdir(parents=True, exist_ok=True)
        self.db = work / "database.db"
        self.model_dir = work / "model"
        self.extracted: set[str] = set()
        self.lock = threading.Lock()
        self.rec = None  # latest pycolmap.Reconstruction
        self.lens: dict | None = None  # the phone's lens calibration (lens.py), if any
        self.last_usage: dict = {}  # CPU and memory the last update used

    @classmethod
    def reopen(cls, images: Path, work: Path, cfg: dict) -> "Mapper":
        """Pick up where an earlier mapper (another process, or before a restart) left off: frames
        already in the database aren't processed again, and mapping continues from the saved model."""
        m = cls(images, work, cfg, fresh=False)
        _quiet_colmap()
        import pycolmap

        try:
            if m.db.exists():
                db = pycolmap.Database.open(str(m.db))
                m.extracted = {im.name for im in db.read_all_images()}
                db.close()
            if (m.model_dir / "images.bin").exists():
                m.rec = pycolmap.Reconstruction(str(m.model_dir))
        except Exception:  # half-written by a cancelled job: start the model again, keep what's readable
            m.rec = None
        return m

    def _lens_prior(self, name: str) -> str:
        """Starting intrinsics for the phone's camera, as COLMAP's comma-separated params.

        Without a starting point COLMAP must guess the lens from the scan itself, which goes wrong
        when the camera mostly turned on the spot (seen on a real scan: a 27° field of view).
        Uses the phone's own lens calibration when there is one for this aspect ratio, otherwise a
        typical phone main camera (focal length = scan.focal_prior_factor x the frame's long side).
        """
        import cv2

        img = cv2.imread(str(self.images / name), cv2.IMREAD_REDUCED_GRAYSCALE_8)
        if img is None:
            return ""
        h, w = img.shape[0] * 8, img.shape[1] * 8
        lens = self.lens
        if lens and lens.get("ok") and abs(lens["w"] / lens["h"] - w / h) < 0.02:
            k = w / lens["w"]
            f, cx, cy = lens["K"][0] * k, lens["K"][2] * k, lens["K"][5] * k
        else:
            f, cx, cy = self.cfg["focal_prior_factor"] * max(w, h), w / 2, h / 2
        extra = {"SIMPLE_PINHOLE": [], "SIMPLE_RADIAL": [0.0], "RADIAL": [0.0, 0.0]}.get(self.cfg["camera_model"])
        if extra is None:  # models with separate fx, fy
            extra4 = {"PINHOLE": [], "OPENCV": [0.0, 0.0, 0.0, 0.0]}.get(self.cfg["camera_model"], [])
            return ",".join(str(round(v, 3)) for v in [f, f, cx, cy, *extra4])
        return ",".join(str(round(v, 3)) for v in [f, cx, cy, *extra])

    def update(self, names: list[str], progress: Progress = lambda s, f: None) -> dict[str, float]:
        """Add frames (file names in capture order) and extend the map. Returns stage timings.

        Runs within the Processing settings (resources.py): a share of the cores, low priority,
        and the photo size and detail per photo they set.
        """
        p = resources.plan(self.cfg.get("processing"))
        with resources.worker(p) as meter:
            timings = self._update(names, progress, p)
        self.last_usage = meter.report()
        return timings

    def _update(self, names: list[str], progress: Progress, p: dict) -> dict[str, float]:
        _quiet_colmap()
        import pycolmap

        timings: dict[str, float] = {}
        new = [n for n in names if n not in self.extracted]
        if new:
            progress("features", 0.05)
            t0 = time.perf_counter()
            reader = pycolmap.ImageReaderOptions()
            reader.camera_model = self.cfg["camera_model"]
            if self.extracted:
                reader.existing_camera_id = 1  # every frame shares the phone's one camera
            else:
                prior = self._lens_prior(new[0])
                if prior:
                    reader.camera_params = prior
            extraction = pycolmap.FeatureExtractionOptions()
            extraction.max_image_size = self.cfg["max_image_size"]
            extraction.sift.max_num_features = self.cfg["max_features"]
            resources.apply(p, extraction)
            pycolmap.extract_features(self.db, self.images, image_names=new, camera_mode=pycolmap.CameraMode.SINGLE,
                                      reader_options=reader, extraction_options=extraction)
            self.extracted.update(new)
            timings["features"] = time.perf_counter() - t0

            progress("matching", 0.35)
            t0 = time.perf_counter()
            pairing = pycolmap.SequentialPairingOptions()
            pairing.overlap = self.cfg["match_overlap"]
            pairing.quadratic_overlap = True
            matching = pycolmap.FeatureMatchingOptions()
            resources.apply(p, pairing, matching)
            pycolmap.match_sequential(self.db, matching_options=matching, pairing_options=pairing)  # skips pairs matched before
            timings["matching"] = time.perf_counter() - t0

        progress("mapping", 0.6)
        t0 = time.perf_counter()
        opts = pycolmap.IncrementalPipelineOptions()
        opts.multiple_models = True  # a bad starting pair then costs one small model, not the whole scan
        opts.min_model_size = 5
        # Phone scans of plain rooms have few features; accept frames on fewer matches than COLMAP's defaults.
        opts.min_num_matches = self.cfg["min_matches"]
        opts.mapper.init_min_num_inliers = self.cfg["init_min_inliers"]
        opts.mapper.abs_pose_min_num_inliers = self.cfg["register_min_inliers"]
        opts.mapper.abs_pose_min_inlier_ratio = 0.15
        opts.extract_colors = True
        # Don't let bundle adjustment re-estimate the lens from a handful of frames: on a real scan the
        # focal length ran from 896 to 1853 px right after the first pair. Refine only once the map is big.
        small = self.rec is None or self.rec.num_reg_images() < self.cfg.get("refine_lens_after_frames", 40)
        opts.ba_refine_focal_length = not small
        opts.ba_refine_extra_params = not small
        resources.apply(p, opts)
        out = self.work / "sparse"
        if out.exists():
            shutil.rmtree(out)
        kw = {"input_path": str(self.model_dir)} if self.rec is not None and self.rec.num_reg_images() >= 10 else {}
        models = pycolmap.incremental_mapping(self.db, self.images, out, options=opts, **kw)
        timings["mapping"] = time.perf_counter() - t0
        if models:
            best = max(models.values(), key=lambda r: r.num_reg_images())
            if self.rec is None or best.num_reg_images() >= self.rec.num_reg_images():
                self.rec = best
                if self.model_dir.exists():
                    shutil.rmtree(self.model_dir)
                self.model_dir.mkdir()
                self.rec.write(self.model_dir)
        return timings


def align(rec, total: int, frame_times: dict[str, float], down_cam: dict[str, list[float]], cfg: dict,
          motion: tuple[np.ndarray, np.ndarray] | None = None) -> Result:
    """Put a reconstruction in room coordinates (z up, floor at 0, metres)."""
    imgs = sorted(rec.images.values(), key=lambda im: im.name)
    if len(imgs) < 3:
        return Result(False, "not enough frames placed yet", registered=len(imgs), total=total)
    cams = []
    for im in imgs:
        T = im.cam_from_world().matrix()  # 3x4
        R_cw, t_cw = T[:, :3], T[:, 3]
        cams.append((R_cw.T, -R_cw.T @ t_cw))
    down = {i: np.asarray(down_cam[im.name], dtype=float) for i, im in enumerate(imgs) if im.name in down_cam}
    up, up_method = _up_vector(cams, down)
    Rz = _rotation_to_z(up)

    pts = np.array([p.xyz for p in rec.points3D.values()]).reshape(-1, 3) @ Rz.T
    rgb = np.array([p.color for p in rec.points3D.values()], dtype=np.uint8).reshape(-1, 3)
    centres = np.array([c for _, c in cams]) @ Rz.T
    # Floor: low percentile of points below the cameras (ignores stray points far underneath).
    below = pts[pts[:, 2] < np.median(centres[:, 2])]
    if len(below) > 20:
        floor_z = float(np.percentile(below[:, 2], cfg["floor_percentile"]))
    else:
        floor_z = float(pts[:, 2].min()) if len(pts) else float(centres[:, 2].min()) - 1.0
    cam_height = float(np.median(centres[:, 2]) - floor_z)
    scale = cfg["camera_height_m"] / cam_height if cam_height > 1e-6 else 1.0
    scale_method = f"assumed camera height {cfg['camera_height_m']} m"
    imu_info: dict = {}
    if motion is not None and len(motion[0]):
        timed = [i for i, im in enumerate(imgs) if frame_times.get(im.name) is not None]
        if len(timed) >= 3:
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
    cam0 = next(iter(rec.cameras.values()))
    frames = []
    all_err: list[float] = []
    for im, (R_wc, c) in zip(imgs, cams):
        R = Rz @ R_wc
        p = (Rz @ c - origin) * scale
        # How well the map's points line up with what this frame actually saw (pixels).
        obs = [(p2.xy, rec.points3D[p2.point3D_id].xyz) for p2 in im.points2D if p2.has_point3D()]
        err = None
        if obs:
            T = im.cam_from_world().matrix()
            xyz = np.array([o[1] for o in obs]) @ T[:, :3].T + T[:, 3]
            uv = np.array(cam0.img_from_cam(xyz))
            e = np.linalg.norm(uv - np.array([o[0] for o in obs]), axis=1)
            err = float(e.mean())
            all_err.extend(e.tolist())
        frames.append({"name": im.name, "t": frame_times.get(im.name), "p": p.round(4).tolist(),
                       "R": R.round(5).ravel().tolist(), "err_px": None if err is None else round(err, 3),
                       "obs": len(obs)})

    sel = np.flatnonzero((pts_w[:, 2] > -0.3) & (pts_w[:, 2] < 3.0))
    if len(sel) > cfg["max_points"]:
        sel = np.random.default_rng(0).choice(sel, cfg["max_points"], replace=False)
    keep, keep_rgb = pts_w[sel], rgb[sel]
    span = keep.max(axis=0) - keep.min(axis=0) if len(keep) else np.zeros(3)
    cam = next(iter(rec.cameras.values()))
    params = list(cam.params)  # SIMPLE_RADIAL: f, cx, cy, k; RADIAL: f, cx, cy, k1, k2; PINHOLE: fx, fy, cx, cy; OPENCV: fx, fy, cx, cy, ...
    model = cam.model.name if hasattr(cam.model, "name") else str(cam.model)
    if model.startswith("SIMPLE") or model == "RADIAL":
        fx = fy = params[0]
        cx, cy, dist = params[1], params[2], params[3:]
    else:
        fx, fy, cx, cy, dist = params[0], params[1], params[2], params[3], params[4:]
    camera = {"model": model, "width": int(cam.width), "height": int(cam.height), "fx": round(float(fx), 3),
              "fy": round(float(fy), 3), "cx": round(float(cx), 3), "cy": round(float(cy), 3),
              "k": [round(float(v), 6) for v in dist]}
    return Result(
        True, frames=frames, camera=camera, reproj_err_px=round(float(np.mean(all_err)), 3) if all_err else None, points=keep.round(3).tolist(), colors=keep_rgb.tolist(), registered=len(imgs), total=total,
        scale=round(scale, 5), scale_method=scale_method, imu=imu_info,
        up_method=up_method, floor_z=0.0, room_size_m=span.round(2).tolist(),
    )


def run(images: Path, work: Path, frame_times: dict[str, float], down_cam: dict[str, list[float]],
        cfg: dict, progress: Progress = lambda stage, frac: None,
        motion: tuple[np.ndarray, np.ndarray] | None = None, mapper: Mapper | None = None) -> Result:
    """Reconstruct a whole scan (continuing from `mapper` if it already mapped part of it).

    frame_times / down_cam are keyed by image file name. motion: (times in ms, device-frame
    accelerations without gravity in m/s²) for metric scale.
    """
    t_start = time.perf_counter()
    names = sorted(p.name for p in images.iterdir() if p.suffix.lower() in (".jpg", ".jpeg", ".png"))
    if len(names) < 10:
        return Result(False, f"only {len(names)} frames; record a longer scan")
    mapper = mapper or Mapper(images, work, cfg)
    with mapper.lock:
        timings = mapper.update(names, progress)
    if mapper.rec is None:
        return Result(False, "couldn't reconstruct: move slower and keep corners, doors or lights in view",
                      total=len(names), timings_s=timings)
    progress("aligning", 0.95)
    result = align(mapper.rec, len(names), frame_times, down_cam, cfg, motion)
    timings["total"] = time.perf_counter() - t_start
    result.timings_s = {k: round(v, 1) for k, v in timings.items()}
    (work / "result.json").write_text(json.dumps(result.to_json()))
    progress("done", 1.0)
    return result
