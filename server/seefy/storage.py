"""Disk space used by room scans, and freeing it.

A scan folder holds the photos sent from the phone (frames/), the map builder's working
database (recon/database.db, recon/sparse/) and the finished map (recon/result.json,
recon/model/). The photos and working files are almost all of the size; the finished map
is a few MB. So there are two ways to free space:

  trim_scan    drop the photos and working files, keep the finished map
               (the room still shows; "Scan more" and rebuilding are no longer possible)
  delete_scan  remove the whole scan

Both refuse while a scan is recording or processing. Pure file operations, no server state.
"""

from __future__ import annotations

import json
import os
import re
import shutil
from pathlib import Path

BUSY = {"recording", "processing"}
# Paths inside a scan folder that trimming removes. Everything else (meta, result, model,
# motion and frame lists) stays, so the map, its numbers and the timeline survive.
TRIMMABLE = ("frames", "recon/database.db", "recon/sparse")
_SID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")


class StorageError(Exception):
    """A request that can't be done; the message is fit to show to the user."""


def _size(p: Path) -> int:
    if p.is_symlink() or not p.exists():
        return 0
    if p.is_file():
        return p.stat().st_size
    total = 0
    for root, _, files in os.walk(p):
        for f in files:
            fp = Path(root) / f
            if not fp.is_symlink():
                total += fp.stat().st_size
    return total


def _scan_dir(data: Path, sid: str) -> Path:
    if not _SID.match(sid):
        raise StorageError("That isn't a scan.")
    scans = (Path(data) / "scans").resolve()
    d = (scans / sid).resolve()
    if d.parent != scans or not d.is_dir():
        raise StorageError("That scan doesn't exist.")
    return d


def _meta(d: Path) -> dict:
    try:
        return json.loads((d / "meta.json").read_text())
    except (OSError, ValueError):
        return {}


def _check_idle(d: Path) -> dict:
    meta = _meta(d)
    if meta.get("status") in BUSY:
        raise StorageError("This scan is still being recorded or built. Try again when it's finished.")
    return meta


def scan_usage(data: Path, sid: str) -> dict:
    """Bytes used by one scan: total, what trimming would free, and what would remain."""
    d = _scan_dir(data, sid)
    meta = _meta(d)
    total = _size(d)
    freeable = sum(_size(d / rel) for rel in TRIMMABLE)
    return {"id": sid, "bytes": total, "freeable_bytes": freeable, "kept_bytes": total - freeable,
            "status": meta.get("status", ""), "trimmed": bool(meta.get("trimmed")),
            "busy": meta.get("status") in BUSY}


def usage(data: Path) -> dict:
    """Disk use of every scan, newest first, plus totals and the free space left on the disk."""
    scans_dir = Path(data) / "scans"
    items = []
    if scans_dir.is_dir():
        for d in sorted(scans_dir.iterdir(), reverse=True):
            if d.is_dir() and _SID.match(d.name):
                items.append(scan_usage(data, d.name))
    disk = shutil.disk_usage(Path(data) if Path(data).exists() else Path.home())
    return {"scans": items, "bytes": sum(s["bytes"] for s in items),
            "freeable_bytes": sum(s["freeable_bytes"] for s in items), "disk_free_bytes": disk.free}


def _write_meta(d: Path, meta: dict) -> None:
    tmp = d / "meta.json.tmp"
    tmp.write_text(json.dumps(meta, indent=2))
    tmp.replace(d / "meta.json")


def trim_scan(data: Path, sid: str) -> dict:
    """Remove a scan's photos and working files, keep its finished map. Returns bytes freed."""
    d = _scan_dir(data, sid)
    meta = _check_idle(d)
    freed = 0
    for rel in TRIMMABLE:
        p = d / rel
        freed += _size(p)
        if p.is_dir() and not p.is_symlink():
            shutil.rmtree(p)
        elif p.exists() or p.is_symlink():
            p.unlink()
    meta["trimmed"] = True
    _write_meta(d, meta)
    return {"id": sid, "freed_bytes": freed}


def delete_scan(data: Path, sid: str) -> dict:
    """Remove a whole scan. Returns bytes freed."""
    d = _scan_dir(data, sid)
    _check_idle(d)
    freed = _size(d)
    shutil.rmtree(d)
    return {"id": sid, "freed_bytes": freed}


def human(n: int) -> str:
    """Bytes as a short, friendly size: '404 MB', '2.1 GB'."""
    for unit, step in (("GB", 1e9), ("MB", 1e6), ("KB", 1e3)):
        if n >= step:
            v = n / step
            return f"{v:.1f} {unit}" if v < 10 else f"{v:.0f} {unit}"
    return f"{n} bytes"
