"""Disk space used by room scans, and freeing it.

A scan folder holds the photos sent from the phone (frames/), the map builder's working
database (recon/database.db, recon/sparse/) and the finished map (recon/result.json,
recon/model/). The photos and working files are almost all of the size; the finished map
is a few MB. So there are two ways to free space:

  trim_scan    drop the photos and working files, keep the finished map
               (the room still shows; "Scan more" and rebuilding are no longer possible)
  delete_scan  remove the whole scan

Both refuse while a scan is recording or processing. Neither destroys anything straight away:
the removed files move to data/trash, so the app can offer Undo (restore) instead of an
"are you sure?" prompt, and purge_trash frees the space once the undo window has passed.
Pure file operations, no server state.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import time
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
            "freeable_bytes": sum(s["freeable_bytes"] for s in items), "disk_free_bytes": disk.free,
            "trash_bytes": _size(Path(data) / "trash")}


def _to_trash(data: Path, sid: str, kind: str, paths: dict[str, Path]) -> str:
    """Move paths (keyed by their path inside the scan) into one trash entry; returns its id."""
    tid = f"{sid}.{kind}.{int(time.time() * 1000)}"
    entry = Path(data) / "trash" / tid
    entry.mkdir(parents=True)
    moved = []
    for rel, p in paths.items():
        if p.exists() or p.is_symlink():
            dest = entry / "files" / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            p.rename(dest)  # same disk, so this is instant and needs no extra space
            moved.append(rel)
    (entry / "trash.json").write_text(json.dumps({"scan": sid, "kind": kind, "at": time.time(), "paths": moved}))
    return tid


def _write_meta(d: Path, meta: dict) -> None:
    tmp = d / "meta.json.tmp"
    tmp.write_text(json.dumps(meta, indent=2))
    tmp.replace(d / "meta.json")


def trim_scan(data: Path, sid: str) -> dict:
    """Move a scan's photos and working files to the trash, keep its finished map.
    Returns the bytes that will be freed and an undo id for restore()."""
    d = _scan_dir(data, sid)
    meta = _check_idle(d)
    freed = sum(_size(d / rel) for rel in TRIMMABLE)
    undo = _to_trash(data, sid, "trim", {rel: d / rel for rel in TRIMMABLE}) if freed else None
    meta["trimmed"] = True
    _write_meta(d, meta)
    return {"id": sid, "freed_bytes": freed, "undo": undo}


def delete_scan(data: Path, sid: str) -> dict:
    """Move a whole scan to the trash. Returns the bytes that will be freed and an undo id."""
    d = _scan_dir(data, sid)
    _check_idle(d)
    freed = _size(d)
    return {"id": sid, "freed_bytes": freed, "undo": _to_trash(data, sid, "delete", {"": d})}


def restore(data: Path, undo: str) -> dict:
    """Undo a trim or delete that's still in the trash."""
    entry = (Path(data) / "trash" / undo).resolve()
    if not _SID.match(undo) or entry.parent != (Path(data) / "trash").resolve() or not entry.is_dir():
        raise StorageError("That can't be undone any more.")
    info = json.loads((entry / "trash.json").read_text())
    scan = Path(data) / "scans" / info["scan"]
    if info["kind"] == "delete":
        if scan.exists():
            raise StorageError("A scan with that name already exists.")
        (entry / "files").rename(scan)
    else:
        for rel in info["paths"]:
            dest = scan / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            (entry / "files" / rel).rename(dest)
        meta = _meta(scan)
        meta.pop("trimmed", None)
        _write_meta(scan, meta)
    shutil.rmtree(entry)
    return {"id": info["scan"], "restored": info["kind"]}


def purge_trash(data: Path, older_than_s: float = 0.0) -> dict:
    """Permanently remove trash entries older than this many seconds. Returns bytes freed."""
    trash = Path(data) / "trash"
    freed, now = 0, time.time()
    if trash.is_dir():
        for entry in trash.iterdir():
            try:
                at = json.loads((entry / "trash.json").read_text())["at"]
            except (OSError, ValueError, KeyError):
                at = entry.stat().st_mtime
            if now - at >= older_than_s:
                freed += _size(entry)
                shutil.rmtree(entry, ignore_errors=True)
    return {"freed_bytes": freed}


def human(n: int) -> str:
    """Bytes as a short, friendly size: '404 MB', '2.1 GB'."""
    for unit, step in (("GB", 1e9), ("MB", 1e6), ("KB", 1e3)):
        if n >= step:
            v = n / step
            return f"{v:.1f} {unit}" if v < 10 else f"{v:.0f} {unit}"
    return f"{n} bytes"
