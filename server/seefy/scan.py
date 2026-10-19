"""Room scans: frames and motion samples recorded on the phone, then reconstructed.

<data>/scans/<id>/
  frames/00000.jpg ...   camera frames in capture order
  frames.jsonl           frame name -> host-clock capture time
  motion.jsonl           phone motion samples (gravity, rotation rate), host clock
  meta.json              device, start/stop, status
  recon/                 COLMAP workspace and result.json
"""

from __future__ import annotations

import bisect
import datetime as dt
import json
import threading
import time
from pathlib import Path

import numpy as np

from . import quality, reconstruct


class Scan:
    def __init__(self, directory: Path):
        self.dir = directory
        self.frames_dir = directory / "frames"
        self.lock = threading.Lock()
        self.mapper: reconstruct.Mapper | None = None
        self.lens: dict | None = None  # the scanning phone's lens calibration, set by the app
        self.live_frames = 0  # frames included in the last live map update
        self.live_registered = 0  # frames placed as of the last live map update
        self.count = len(list(self.frames_dir.glob("*.jpg"))) if self.frames_dir.exists() else 0

    @property
    def id(self) -> str:
        return self.dir.name

    def meta(self) -> dict:
        p = self.dir / "meta.json"
        return json.loads(p.read_text()) if p.exists() else {}

    def update_meta(self, **kv) -> dict:
        m = self.meta() | kv
        (self.dir / "meta.json").write_text(json.dumps(m, indent=2))
        return m

    def add_frame(self, t: float, data: bytes) -> int:
        with self.lock:
            name = f"{self.count:05d}.jpg"
            self.count += 1
        (self.frames_dir / name).write_bytes(data)
        with (self.dir / "frames.jsonl").open("a") as fh:
            fh.write(json.dumps({"name": name, "t": t}) + "\n")
        return self.count

    def add_motion(self, samples: list[dict]) -> None:
        with (self.dir / "motion.jsonl").open("a") as fh:
            for s in samples:
                fh.write(json.dumps(s, separators=(",", ":")) + "\n")

    def result(self) -> dict | None:
        p = self.dir / "recon" / "result.json"
        return json.loads(p.read_text()) if p.exists() else None

    def _read(self, name: str) -> list[dict]:
        p = self.dir / name
        if not p.exists():
            return []
        return [json.loads(line) for line in p.read_text().splitlines() if line.strip()]

    def gravity_per_frame(self, frame_times: dict[str, float]) -> dict[str, list[float]]:
        """Down direction in camera axes for each frame, from the nearest motion sample.

        Uses the phone's accelerometer including gravity, averaged over +-150 ms. Only portrait
        frames are used (screen angle 0): device x right, y up, z out of the screen; the rear
        camera's axes are x right, y down, z out of the back. The sign convention of
        accelerationIncludingGravity differs between browsers, so the result is flipped if it
        disagrees with the image's own "down" on average.
        """
        samples = [s for s in self._read("motion.jsonl") if s.get("g") and s.get("angle", 0) == 0]
        if len(samples) < 10:
            return {}
        ts = [s["t"] for s in samples]
        out: dict[str, np.ndarray] = {}
        for name, t in frame_times.items():
            lo, hi = bisect.bisect_left(ts, t - 150), bisect.bisect_right(ts, t + 150)
            if hi - lo < 2:
                continue
            g = np.mean([samples[k]["g"] for k in range(lo, hi)], axis=0)
            if np.linalg.norm(g) < 5:  # not a usable gravity reading
                continue
            down = np.array([g[0], -g[1], -g[2]])  # device -> camera axes
            out[name] = down / np.linalg.norm(down)
        if not out:
            return {}
        if np.mean([d[1] for d in out.values()]) < 0:  # camera +y should point roughly down
            out = {k: -v for k, v in out.items()}
        return {k: v.tolist() for k, v in out.items()}

    def turn_rate(self, window_ms: float = 2000) -> float | None:
        """The phone's recent turn speed in degrees per second (smoothed rotation rate)."""
        samples = [s for s in self._read("motion.jsonl")[-400:] if s.get("r")]
        if not samples:
            return None
        recent = [s for s in samples if s["t"] >= samples[-1]["t"] - window_ms]
        return float(np.mean([np.linalg.norm(s["r"]) for s in recent]))

    def accelerations(self) -> tuple[np.ndarray, np.ndarray] | None:
        """Portrait-only accelerometer samples without gravity: (times ms, (M,3) m/s²)."""
        samples = [s for s in self._read("motion.jsonl") if s.get("a") and s.get("angle", 0) == 0]
        if len(samples) < 20:
            return None
        samples.sort(key=lambda s: s["t"])
        return np.array([s["t"] for s in samples]), np.array([s["a"] for s in samples], dtype=float)

    def live_update(self, cfg: dict, coverage_cfg: dict | None = None, quality_cfg: dict | None = None) -> dict | None:
        """Extend the map with frames that arrived since the last update (called while recording).

        Returns a summary for the phone and Live, or None if there was nothing new or an update
        is already running. The full live map is written to recon/live.json.
        """
        frames = self._read("frames.jsonl")
        names = [f["name"] for f in frames]
        if len(names) - self.live_frames < cfg["live_min_new_frames"] or len(names) < 10:
            return None
        if self.mapper is None:  # e.g. Scan more after a restart: continue the saved map
            self.mapper = reconstruct.Mapper.reopen(self.frames_dir, self.dir / "recon", cfg)
            self.mapper.lens = self.lens
        if not self.mapper.lock.acquire(blocking=False):
            return None
        try:
            t0 = time.perf_counter()
            prev_frames = self.live_frames
            self.mapper.update(names)
            self.live_frames = len(names)
            if self.mapper.rec is None:
                return {"registered": 0, "frames": len(names), "ok": False}
            frame_times = {f["name"]: f["t"] for f in frames}
            res = reconstruct.align(self.mapper.rec, len(names), frame_times, self.gravity_per_frame(frame_times),
                                    cfg, self.accelerations())
        finally:
            self.mapper.lock.release()
        out = res.to_json()
        out["id"] = self.id
        recent = (res.registered - self.live_registered, len(names) - prev_frames)
        self.live_registered = res.registered
        out["coverage"] = _coverage(out, coverage_cfg, cfg, self.turn_rate(), recent)
        out["layout"] = _layout(out)
        quality.apply(out, quality_cfg)
        (self.dir / "recon" / "live.json").write_text(json.dumps(out))
        return {
            "ok": res.ok, "registered": res.registered, "frames": len(names),
            "room_size_m": res.room_size_m, "scale_method": res.scale_method, "imu": res.imu,
            "coverage": out["coverage"], "update_s": round(time.perf_counter() - t0, 1),
            "layout": {k: out["layout"].get(k) for k in ("ok", "reason", "size_m", "confidence")},
            "quality": out["quality"],
        }

    def set_scale(self, measured_m: float, current_m: float, quality_cfg: dict | None = None) -> dict | None:
        """The user measured a length: rescale the saved map so that length is measured_m."""
        res = self.result()
        if not res or not res.get("ok") or current_m <= 0 or measured_m <= 0:
            return None
        k = measured_m / current_m
        _rescale(res, k)
        res["size_source"] = "measured"
        res["scale_method"] = f"measured ({measured_m:.2f} m)"
        res["layout"] = _layout(res)
        quality.apply(res, quality_cfg)
        (self.dir / "recon" / "result.json").write_text(json.dumps(res))
        self.update_meta(measured_scale=(self.meta().get("measured_scale") or 1.0) * k)
        return res

    def frame_path(self, name: str) -> Path | None:
        p = self.frames_dir / name
        return p if p.parent == self.frames_dir and p.suffix == ".jpg" and p.exists() else None

    def live(self) -> dict | None:
        p = self.dir / "recon" / "live.json"
        return json.loads(p.read_text()) if p.exists() else None

    def process(self, cfg: dict, progress, coverage_cfg: dict | None = None, quality_cfg: dict | None = None) -> dict:
        frame_times = {f["name"]: f["t"] for f in self._read("frames.jsonl")}
        self.update_meta(status="processing", processing_started=time.time())
        try:
            res = reconstruct.run(self.frames_dir, self.dir / "recon", frame_times,
                                  self.gravity_per_frame(frame_times), cfg, progress, self.accelerations(),
                                  mapper=self.mapper)
        except Exception as exc:  # report, don't crash the server
            res = reconstruct.Result(False, f"processing failed: {exc}")
        out = res.to_json()
        out["id"] = self.id
        if res.ok:
            out["coverage"] = _coverage(out, coverage_cfg, cfg)
            out["layout"] = _layout(out)
            k = self.meta().get("measured_scale")
            if k:  # the user measured a wall on an earlier pass; keep their correction
                _rescale(out, k)
                out["size_source"] = "measured"
                out["layout"] = _layout(out)
            quality.apply(out, quality_cfg)
            (self.dir / "recon" / "result.json").write_text(json.dumps(out))
        self.update_meta(status="done" if res.ok else "failed", error=res.error,
                         registered=res.registered, total=res.total, timings_s=res.timings_s)
        if not res.ok:
            (self.dir / "recon").mkdir(exist_ok=True)
            (self.dir / "recon" / "result.json").write_text(json.dumps(out))
        return out


SUMMARY_KEYS = ("ok", "error", "registered", "total", "scale_method", "up_method", "room_size_m", "timings_s",
                "coverage", "quality")


def process_job(progress, plan: dict, scan_dir: str, cfg: dict, coverage_cfg: dict | None = None,
                quality_cfg: dict | None = None, lens: dict | None = None, fresh: bool = False) -> dict:
    """Build a scan's map as a background job (jobs.py runs this in a child process).

    Continues from the map saved during the scan (or before a restart) unless fresh is set."""
    s = Scan(Path(scan_dir))
    s.lens = lens
    if not fresh:
        s.mapper = reconstruct.Mapper.reopen(s.frames_dir, s.dir / "recon", cfg)
        s.mapper.lens = lens
    out = s.process(cfg, progress, coverage_cfg, quality_cfg)
    return {k: out.get(k) for k in SUMMARY_KEYS}


def _coverage(result: dict, cfg: dict | None, scan_cfg: dict, turn_dps: float | None = None,
              recent: tuple[int, int] | None = None) -> dict | None:
    """'Is it enough?' score for a (partial) map: level, hints, and per-component detail."""
    if not result.get("ok"):
        return None
    from . import coverage

    c = {**coverage.DEFAULTS, **(cfg or {}),
         # the turn-speed limit follows the scan's own capture settings
         "capture_fps": scan_cfg["capture_fps"], "max_turn_deg_per_frame": scan_cfg["max_turn_deg_per_frame"]}
    try:
        return coverage.score(result["frames"], result["total"], result.get("imu") or None, c,
                              points=result.get("points"), turn_dps=turn_dps,
                              **({"recent": recent} if recent and "recent" in coverage.score.__code__.co_varnames else {}))
    except Exception as exc:  # scoring must never break mapping
        return {"error": str(exc)}


def _rescale(result: dict, k: float) -> None:
    """Multiply every distance in a result by k (positions, points, sizes, scale)."""
    result["points"] = [[round(c * k, 3) for c in q] for q in result.get("points", [])]
    for f in result.get("frames", []):
        f["p"] = [round(c * k, 4) for c in f["p"]]
    result["room_size_m"] = [round(c * k, 2) for c in result.get("room_size_m", [])]
    result["scale"] = round(result.get("scale", 1.0) * k, 5)


def _layout(result: dict) -> dict:
    """Walls, openings and furniture boxes from the map points (layout.py)."""
    if not result.get("ok"):
        return {"ok": False, "reason": "no map yet"}
    try:
        from . import layout

        return layout.build(result)
    except Exception as exc:  # layout must never break mapping
        return {"ok": False, "reason": f"layout failed: {exc}"}


class ScanStore:
    def __init__(self, root: Path):
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)
        self._scans: dict[str, Scan] = {}

    def start(self, device: str) -> Scan:
        sid = f"{dt.datetime.now():%Y%m%d-%H%M%S}"
        n = 2
        while (self.root / sid).exists():  # two scans in the same second
            sid = f"{dt.datetime.now():%Y%m%d-%H%M%S}-{n}"
            n += 1
        d = self.root / sid
        (d / "frames").mkdir(parents=True)
        s = Scan(d)
        s.update_meta(id=sid, device=device, status="recording", started=time.time())
        self._scans[sid] = s
        return s

    def get(self, sid: str) -> Scan | None:
        if sid in self._scans:
            return self._scans[sid]
        d = self.root / sid
        if d.is_dir() and d.parent == self.root:
            self._scans[sid] = Scan(d)
            return self._scans[sid]
        return None

    def list(self) -> list[dict]:
        out = []
        for d in sorted(self.root.iterdir(), reverse=True):
            if (d / "meta.json").exists():
                out.append(Scan(d).meta())
        return out

    def remove(self, sid: str) -> bool:
        """Move a scan to data/trash/ (recoverable by moving it back) and forget it."""
        s = self.get(sid)
        if not s:
            return False
        trash = self.root.parent / "trash"
        trash.mkdir(exist_ok=True)
        dest = trash / sid
        n = 2
        while dest.exists():
            dest = trash / f"{sid}-{n}"
            n += 1
        s.dir.rename(dest)
        self._scans.pop(sid, None)
        return True

    def latest_result(self) -> dict | None:
        for m in self.list():
            if m.get("status") == "done":
                s = self.get(m["id"])
                return s.result() if s else None
        return None
