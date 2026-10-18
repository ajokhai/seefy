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

from . import reconstruct


class Scan:
    def __init__(self, directory: Path):
        self.dir = directory
        self.frames_dir = directory / "frames"
        self.lock = threading.Lock()
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

    def accelerations(self) -> tuple[np.ndarray, np.ndarray] | None:
        """Portrait-only accelerometer samples without gravity: (times ms, (M,3) m/s²)."""
        samples = [s for s in self._read("motion.jsonl") if s.get("a") and s.get("angle", 0) == 0]
        if len(samples) < 20:
            return None
        samples.sort(key=lambda s: s["t"])
        return np.array([s["t"] for s in samples]), np.array([s["a"] for s in samples], dtype=float)

    def process(self, cfg: dict, progress) -> dict:
        frame_times = {f["name"]: f["t"] for f in self._read("frames.jsonl")}
        self.update_meta(status="processing", processing_started=time.time())
        try:
            res = reconstruct.run(self.frames_dir, self.dir / "recon", frame_times,
                                  self.gravity_per_frame(frame_times), cfg, progress, self.accelerations())
        except Exception as exc:  # report, don't crash the server
            res = reconstruct.Result(False, f"processing failed: {exc}")
        out = res.to_json()
        self.update_meta(status="done" if res.ok else "failed", error=res.error,
                         registered=res.registered, total=res.total, timings_s=res.timings_s)
        if not res.ok:
            (self.dir / "recon").mkdir(exist_ok=True)
            (self.dir / "recon" / "result.json").write_text(json.dumps(out))
        return out


class ScanStore:
    def __init__(self, root: Path):
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)
        self._scans: dict[str, Scan] = {}

    def start(self, device: str) -> Scan:
        sid = f"{dt.datetime.now():%Y%m%d-%H%M%S}"
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

    def latest_result(self) -> dict | None:
        for m in self.list():
            if m.get("status") == "done":
                s = self.get(m["id"])
                return s.result() if s else None
        return None
