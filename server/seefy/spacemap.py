"""One map per space, built from many scans and joined where they overlap.

Layout (shared with the live streaming mapper):
  data/spaces/<space_id>/images/<scan_id>  -> symlink to data/scans/<scan_id>/frames
  data/spaces/<space_id>/map/database.db   features and matches for every frame of every scan
  data/spaces/<space_id>/map/model/        the main (largest) joined model
  data/spaces/<space_id>/map/pieces/<k>/   parts that don't connect to the main model yet
  data/spaces/<space_id>/map/result.json   the merged map in room coordinates (same shape as a scan result)

Joining: frames are matched with their neighbours in time within each scan, and every few
frames of each scan are also matched against keyframes spread through the other scans. Shared
corners, doors and furniture then link the scans, and mapping continues from the existing
model. A scan that doesn't overlap yet stays a separate piece; every later scan retries, so one
scan can bridge two pieces.
"""

from __future__ import annotations

import json
import os
import shutil
import threading
import time
from pathlib import Path

import numpy as np

from . import imu, quality, reconstruct, resources


def cross_scan_pairs(by_scan: dict[str, list[str]], every: int = 5, keyframes: int = 40) -> list[tuple[str, str]]:
    """Candidate frame pairs across scans: every Nth frame of each scan vs keyframes of the others."""
    pairs: set[tuple[str, str]] = set()
    for sid, names in by_scan.items():
        others = [n for o, ns in by_scan.items() if o != sid for n in ns]
        if not others:
            continue
        idx = np.linspace(0, len(others) - 1, min(keyframes, len(others))).round().astype(int)
        keys = [others[i] for i in sorted(set(idx))]
        for a in names[::every]:
            for b in keys:
                pairs.add((a, b) if a < b else (b, a))
    return sorted(pairs)


class SpaceMap:
    def __init__(self, root: Path, scans_root: Path, cfg: dict):
        self.root, self.scans_root, self.cfg = root, scans_root, cfg
        self.images = root / "images"
        self.work = root / "map"
        self.db = self.work / "database.db"
        self.model_dir = self.work / "model"
        self.lock = threading.Lock()

    # -- frames ------------------------------------------------------------------

    def _link(self, scan_ids: list[str]) -> dict[str, list[str]]:
        """Make each scan's frames visible in the space workspace; returns frame names per scan."""
        self.images.mkdir(parents=True, exist_ok=True)
        by_scan: dict[str, list[str]] = {}
        for sid in scan_ids:
            src = self.scans_root / sid / "frames"
            if not src.is_dir():
                continue
            link = self.images / sid
            if not link.exists():
                os.symlink(src.resolve(), link)
            by_scan[sid] = [f"{sid}/{p.name}" for p in sorted(src.glob("*.jpg"))]
        return by_scan

    def _frame_info(self, scan_ids: list[str]) -> tuple[dict[str, float], dict[str, list[float]], dict[str, tuple]]:
        """Capture times and gravity per frame (space names), and accelerometer data per scan."""
        from .scan import Scan

        times: dict[str, float] = {}
        down: dict[str, list[float]] = {}
        motion: dict[str, tuple] = {}
        for sid in scan_ids:
            s = Scan(self.scans_root / sid)
            ft = {f["name"]: f["t"] for f in s._read("frames.jsonl")}
            times.update({f"{sid}/{n}": t for n, t in ft.items()})
            down.update({f"{sid}/{n}": g for n, g in s.gravity_per_frame(ft).items()})
            acc = s.accelerations()
            if acc is not None:
                motion[sid] = acc
        return times, down, motion

    # -- join ----------------------------------------------------------------------

    def join(self, scan_ids: list[str], progress=lambda stage, frac: None) -> dict:
        """Add every scan's frames, match within and across scans, and grow the space model."""
        p = resources.plan(self.cfg.get("processing"))
        with resources.worker(p) as meter:
            out = self._join(scan_ids, progress, p)
        out["usage"] = meter.report()
        return out

    def _join(self, scan_ids: list[str], progress, p: dict) -> dict:
        reconstruct._quiet_colmap()
        import pycolmap

        t0 = time.perf_counter()
        timings: dict[str, float] = {}
        self.work.mkdir(parents=True, exist_ok=True)
        by_scan = self._link(scan_ids)
        names = [n for sid in scan_ids for n in by_scan.get(sid, [])]
        if len(names) < 10:
            return {"ok": False, "error": "not enough frames in this space yet"}

        # Features for frames the database hasn't seen.
        progress("features", 0.1)
        t = time.perf_counter()
        known: set[str] = set()
        if self.db.exists():
            db = pycolmap.Database.open(str(self.db))
            known = {im.name for im in db.read_all_images()}
            db.close()
        new = [n for n in names if n not in known]
        if new:
            mapper = reconstruct.Mapper(self.images, self.work, self.cfg, fresh=False)
            reader = pycolmap.ImageReaderOptions()
            reader.camera_model = self.cfg["camera_model"]
            if known:
                reader.existing_camera_id = 1  # one phone camera for the whole space
            else:
                prior = mapper._lens_prior(new[0])
                if prior:
                    reader.camera_params = prior
            extraction = pycolmap.FeatureExtractionOptions()
            extraction.max_image_size = self.cfg["max_image_size"]
            extraction.sift.max_num_features = self.cfg["max_features"]
            resources.apply(p, extraction)
            pycolmap.extract_features(self.db, self.images, image_names=new, camera_mode=pycolmap.CameraMode.SINGLE,
                                      reader_options=reader, extraction_options=extraction)
        timings["features"] = time.perf_counter() - t

        # Matches: neighbours in time within each scan, plus candidates across scans.
        progress("matching", 0.4)
        t = time.perf_counter()
        seq = pycolmap.SequentialPairingOptions()
        seq.overlap = self.cfg["match_overlap"]
        seq.quadratic_overlap = True
        matching = pycolmap.FeatureMatchingOptions()
        resources.apply(p, seq, matching)
        pycolmap.match_sequential(self.db, matching_options=matching, pairing_options=seq)
        pairs = cross_scan_pairs(by_scan, self.cfg.get("join_every", 5), self.cfg.get("join_keyframes", 40))
        if pairs:
            pair_file = self.work / "cross_pairs.txt"
            pair_file.write_text("\n".join(f"{a} {b}" for a, b in pairs))
            imported = pycolmap.ImportedPairingOptions()
            imported.match_list_path = str(pair_file)
            pycolmap.match_image_pairs(self.db, matching_options=matching, pairing_options=imported)
        timings["matching"] = time.perf_counter() - t

        # Mapping, continuing from the space's model when there is one.
        progress("mapping", 0.6)
        t = time.perf_counter()
        opts = pycolmap.IncrementalPipelineOptions()
        opts.multiple_models = True
        opts.min_model_size = 5
        opts.min_num_matches = self.cfg["min_matches"]
        opts.mapper.init_min_num_inliers = self.cfg["init_min_inliers"]
        opts.mapper.abs_pose_min_num_inliers = self.cfg["register_min_inliers"]
        opts.mapper.abs_pose_min_inlier_ratio = 0.15
        opts.extract_colors = True
        resources.apply(p, opts)
        out = self.work / "sparse"
        if out.exists():
            shutil.rmtree(out)
        kw = {"input_path": str(self.model_dir)} if (self.model_dir / "images.bin").exists() else {}
        models = pycolmap.incremental_mapping(self.db, self.images, out, options=opts, **kw)
        timings["mapping"] = time.perf_counter() - t
        if not models:
            return {"ok": False, "error": "no part of this space could be mapped yet", "timings_s": timings}
        ranked = sorted(models.values(), key=lambda r: -r.num_reg_images())
        main = ranked[0]
        for d in (self.model_dir, self.work / "pieces"):
            if d.exists():
                shutil.rmtree(d)
        self.model_dir.mkdir()
        main.write(self.model_dir)

        def members(rec) -> dict[str, int]:
            counts: dict[str, int] = {}
            for im in rec.images.values():
                sid = im.name.split("/", 1)[0]
                counts[sid] = counts.get(sid, 0) + 1
            return counts

        pieces = [{"scans": sorted(members(main)), "images": main.num_reg_images(), "main": True}]
        for k, rec in enumerate(ranked[1:], 1):
            d = self.work / "pieces" / str(k)
            d.mkdir(parents=True)
            rec.write(d)
            pieces.append({"scans": sorted(members(rec)), "images": rec.num_reg_images(), "main": False})
        main_members = members(main)
        joined = {sid: main_members.get(sid, 0) >= 10 for sid in by_scan}  # enough of the scan sits in the main map
        (self.work / "pieces.json").write_text(json.dumps(pieces))
        timings["total"] = time.perf_counter() - t0
        return {"ok": True, "rec": main, "pieces": pieces, "joined": joined, "frames": len(names),
                "timings_s": {k: round(v, 1) for k, v in timings.items()}}

    # -- merged result -----------------------------------------------------------

    def build(self, scan_ids: list[str], coverage_cfg: dict | None, quality_cfg: dict | None,
              measured_scale: float | None = None, progress=lambda stage, frac: None) -> dict:
        from .scan import _coverage, _layout, _rescale

        with self.lock:
            j = self.join(scan_ids, progress)
        if not j["ok"]:
            return {"ok": False, "error": j["error"], "pieces": [], "joined": {}}
        progress("aligning", 0.95)
        times, down, motion = self._frame_info(scan_ids)
        res = reconstruct.align(j["rec"], j["frames"], times, down, self.cfg, None)
        out = res.to_json()
        for f in out["frames"]:
            f["scan"] = f["name"].split("/", 1)[0]

        # Scale from every scan's accelerometer, each on its own timeline.
        fits = []
        for sid, (mt, ma) in motion.items():
            fr = [f for f in out["frames"] if f["scan"] == sid and f.get("t") is not None]
            if len(fr) < 20:
                continue
            est = imu.estimate(np.array([f["t"] for f in fr]), np.array([f["p"] for f in fr]),
                               np.array([f["R"] for f in fr]).reshape(-1, 3, 3), mt, ma,
                               min_correlation=self.cfg["imu_min_correlation"])
            if est.ok:
                fits.append((est.scale, est.correlation, sid))
        if fits:
            k = float(np.median([f[0] for f in fits]))
            _rescale(out, k)
            out["scale_method"] = f"accelerometer ({len(fits)} of {len(motion)} scans)"
            out["imu"] = {"ok": True, "correlation": round(float(np.median([f[1] for f in fits])), 3), "scans": len(fits)}
        if measured_scale:
            _rescale(out, measured_scale)
            out["size_source"] = "measured"
            out["scale_method"] = "measured"

        out["coverage"] = _coverage(out, coverage_cfg, self.cfg)
        out["layout"] = _layout(out)
        quality.apply(out, quality_cfg)
        out["pieces"] = j["pieces"]
        out["joined"] = j["joined"]
        out["timings_s"] = j["timings_s"]
        out["usage"] = j.get("usage")
        (self.work / "result.json").write_text(json.dumps(out))
        return out

    def result(self) -> dict | None:
        p = self.work / "result.json"
        return json.loads(p.read_text()) if p.exists() else None


def join_job(progress, plan: dict, root: str, scans_root: str, cfg: dict, scan_ids: list[str],
             coverage_cfg: dict | None = None, quality_cfg: dict | None = None,
             measured_scale: float | None = None) -> dict:
    """Rebuild a space's merged map as a background job (jobs.py runs this in a child process).
    The map itself is written to map/result.json; the job returns a summary."""
    out = SpaceMap(Path(root), Path(scans_root), cfg).build(scan_ids, coverage_cfg, quality_cfg, measured_scale, progress)
    return {k: out.get(k) for k in ("ok", "error", "pieces", "joined", "registered", "total", "timings_s", "quality",
                                    "usage")}
