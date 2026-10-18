"""Session recorder.

A session is one pass: a tag-mapping sweep, a learn walk or a teacher capture.
Streams are appended as JSON lines while recording and converted to Parquet
when the session stops. meta.json holds the config snapshot, tag map and
device list, so any pass can be replayed or compared with others later.
"""

from __future__ import annotations

import datetime as dt
import json
import threading
import time
from pathlib import Path
from typing import IO

import pyarrow.json as pj
import pyarrow.parquet as pq

from .clock import host_ms

KINDS = ("map", "walk", "teacher")


class Session:
    def __init__(self, root: Path, kind: str, pass_no: int, notes: str):
        now = dt.datetime.now()
        self.id = f"{now:%Y%m%d-%H%M%S}-{kind}{pass_no}"
        self.dir = root / self.id
        self.dir.mkdir(parents=True)
        self.kind, self.pass_no, self.notes = kind, pass_no, notes
        self.started_host_ms = host_ms()
        self.started_wall = time.time()
        self.counts: dict[str, int] = {}
        self._files: dict[str, IO] = {}
        self._lock = threading.Lock()

    def write(self, stream: str, record: dict) -> None:
        with self._lock:
            fh = self._files.get(stream)
            if fh is None:
                fh = self._files[stream] = (self.dir / f"{stream}.jsonl").open("a")
            fh.write(json.dumps(record, separators=(",", ":")) + "\n")
            self.counts[stream] = self.counts.get(stream, 0) + 1

    def close(self) -> None:
        with self._lock:
            for fh in self._files.values():
                fh.close()
            self._files.clear()

    def summary(self) -> dict:
        return {
            "id": self.id, "kind": self.kind, "pass": self.pass_no, "notes": self.notes,
            "duration_s": round((host_ms() - self.started_host_ms) / 1000, 1), "counts": dict(self.counts),
        }


def _to_parquet(directory: Path) -> None:
    for jl in directory.glob("*.jsonl"):
        try:
            pq.write_table(pj.read_json(jl), jl.with_suffix(".parquet"), compression="zstd")
            jl.unlink()
        except Exception as exc:  # keep the raw JSON lines if conversion fails
            (directory / f"{jl.stem}.convert-error.txt").write_text(str(exc))


class Recorder:
    def __init__(self, root: Path):
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)
        self.active: Session | None = None

    def _next_pass(self, kind: str) -> int:
        return 1 + sum(1 for d in self.root.iterdir() if d.is_dir() and d.name.rsplit("-", 1)[-1].startswith(kind))

    def start(self, kind: str, notes: str, meta: dict) -> Session:
        if kind not in KINDS:
            raise ValueError(f"kind must be one of {KINDS}")
        if self.active:
            self.stop()
        s = Session(self.root, kind, self._next_pass(kind), notes)
        (s.dir / "meta.json").write_text(json.dumps({
            "id": s.id, "kind": kind, "pass": s.pass_no, "notes": notes,
            "started_wall": s.started_wall, "started_host_ms": s.started_host_ms, **meta,
        }, indent=2))
        self.active = s
        return s

    def write(self, stream: str, record: dict) -> None:
        if self.active:
            self.active.write(stream, record)

    def stop(self) -> dict | None:
        s, self.active = self.active, None
        if not s:
            return None
        s.close()
        summary = s.summary()
        meta_path = s.dir / "meta.json"
        meta = json.loads(meta_path.read_text())
        meta.update({"stopped_wall": time.time(), "duration_s": summary["duration_s"], "counts": summary["counts"]})
        meta_path.write_text(json.dumps(meta, indent=2))
        threading.Thread(target=_to_parquet, args=(s.dir,), daemon=True).start()
        return summary

    def list(self) -> list[dict]:
        out = []
        for d in sorted(self.root.iterdir(), reverse=True):
            m = d / "meta.json"
            if m.exists():
                meta = json.loads(m.read_text())
                out.append({k: meta.get(k) for k in ("id", "kind", "pass", "notes", "duration_s", "counts")})
        return out
