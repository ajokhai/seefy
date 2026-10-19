"""How much of the computer map building may use: CPU cores, memory, priority and pace.

Map building (COLMAP via pycolmap) uses every CPU core unless told otherwise, which makes the
Mac sluggish while a room is processed. One setting picks a preset, and each lever can be
overridden:

  cpu_share     share of CPU cores map building may use (1 core minimum)
  photo_px      longest side photos are shrunk to before features are found; the main memory lever
  features      distinctive points kept per photo; more is sturdier, slower and uses more memory
  background    run at low priority (macOS background mode) so everything else on the Mac comes first
  live_every_s  how often the live map is rebuilt during a scan; longer means less work while scanning

Use:
  plan = resources.plan(cfg)                    # concrete numbers for this Mac
  resources.apply(plan, extraction, matching, pairing, pipeline)  # sets num_threads on pycolmap options
  with resources.worker(plan) as meter: ...     # low priority for the calling thread, measures CPU and RAM
  meter.report() -> {"cpu_s", "wall_s", "cpu_cores_used", "peak_ram_mb"}
"""

from __future__ import annotations

import contextlib
import os
import resource
import sys
import threading
import time
from dataclasses import dataclass

PRESETS: dict[str, dict] = {
    "light": {"cpu_share": 0.25, "photo_px": 960, "features": 4000, "background": True, "live_every_s": 10.0},
    "balanced": {"cpu_share": 0.5, "photo_px": 1280, "features": 6000, "background": True, "live_every_s": 5.0},
    "full": {"cpu_share": 1.0, "photo_px": 1600, "features": 8000, "background": False, "live_every_s": 3.0},
}

DEFAULTS: dict = {
    "preset": "balanced",  # light, balanced or full; the other keys override it when set
    "cpu_share": None,
    "photo_px": None,
    "features": None,
    "background": None,
    "live_every_s": None,
}

DOCS: dict = {
    "_": ("Processing", "How much of this Mac building a room's map may use. Lower is gentler on other apps but takes longer."),
    "preset": ("Speed", "Light keeps the Mac responsive, Full finishes fastest. Balanced is in between.", ""),
    "cpu_share": ("CPU", "Share of the processor's cores map building may use.", "%"),
    "photo_px": ("Photo size", "Photos are shrunk to this before processing. Smaller uses less memory and is faster, but picks up less detail.", "px"),
    "features": ("Detail per photo", "Distinct points kept per photo. Fewer uses less memory and time; more copes better with plain rooms.", ""),
    "background": ("Low priority", "Let everything else on this Mac go first. Map building pauses while you're busy and catches up when you're not.", ""),
    "live_every_s": ("Live map refresh", "How often the map updates while you scan. Less often means less work during the scan.", "s"),
}


def cores() -> int:
    return os.cpu_count() or 1


def plan(cfg: dict | None = None) -> dict:
    """Concrete settings for this machine: the preset, with any explicit overrides, plus num_threads."""
    c = {**DEFAULTS, **(cfg or {})}
    base = PRESETS.get(str(c["preset"]), PRESETS["balanced"])
    p = {k: (c[k] if c.get(k) is not None else v) for k, v in base.items()}
    share = min(1.0, max(0.0, float(p["cpu_share"])))
    p["cpu_share"] = share
    p["num_threads"] = max(1, round(cores() * share))
    p["photo_px"] = int(p["photo_px"])
    p["features"] = int(p["features"])
    p["background"] = bool(p["background"])
    p["live_every_s"] = float(p["live_every_s"])
    p["preset"] = c["preset"] if c["preset"] in PRESETS else "balanced"
    return p


def apply(p: dict, *options) -> None:
    """Set the thread limit, photo size and feature count on any pycolmap options objects passed.
    Objects without a given setting are left alone, so any mix of options can be passed."""
    for o in options:
        if o is None:
            continue
        for target in (o, getattr(o, "mapper", None), getattr(o, "sift", None)):
            if target is not None and hasattr(target, "num_threads"):
                target.num_threads = p["num_threads"]
        if hasattr(o, "max_image_size"):
            o.max_image_size = p["photo_px"]
        sift = getattr(o, "sift", None)
        if sift is not None and hasattr(sift, "max_num_features"):
            sift.max_num_features = p["features"]


# macOS: put the calling thread in background mode (low CPU priority, throttled disk access).
# Threads it starts afterwards, like COLMAP's workers, are created at the same priority.
_PRIO_DARWIN_THREAD = getattr(os, "PRIO_DARWIN_THREAD", 3)
_PRIO_DARWIN_BG = getattr(os, "PRIO_DARWIN_BG", 0x1000)


def _set_background(on: bool) -> bool:
    if sys.platform != "darwin":
        return False
    try:
        os.setpriority(_PRIO_DARWIN_THREAD, 0, _PRIO_DARWIN_BG if on else 0)
        return True
    except (OSError, AttributeError):
        return False


def _peak_rss_mb() -> float:
    r = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return r / 1e6 if sys.platform == "darwin" else r / 1e3  # bytes on macOS, KB on Linux


@dataclass
class Meter:
    t0: float
    cpu0: float
    rss0: float
    background: bool
    wall_s: float = 0.0
    cpu_s: float = 0.0
    peak_ram_mb: float = 0.0

    def report(self) -> dict:
        return {"wall_s": round(self.wall_s, 2), "cpu_s": round(self.cpu_s, 2),
                "cpu_cores_used": round(self.cpu_s / self.wall_s, 2) if self.wall_s else 0.0,
                "peak_ram_mb": round(self.peak_ram_mb), "background": self.background}


@contextlib.contextmanager
def worker(p: dict):
    """Run a block of map building at the planned priority, measuring CPU time and peak memory.
    Use it in the thread that does the work (e.g. inside asyncio.to_thread)."""
    bg = _set_background(True) if p.get("background") else False
    ru = resource.getrusage(resource.RUSAGE_SELF)
    m = Meter(t0=time.monotonic(), cpu0=ru.ru_utime + ru.ru_stime, rss0=_peak_rss_mb(), background=bg)
    try:
        yield m
    finally:
        ru = resource.getrusage(resource.RUSAGE_SELF)
        m.wall_s = time.monotonic() - m.t0
        m.cpu_s = ru.ru_utime + ru.ru_stime - m.cpu0  # whole process: the server itself adds a little
        m.peak_ram_mb = _peak_rss_mb()
        if bg:
            _set_background(False)


class Gate:
    """Spaces out live map rebuilds: ready() is true at most once every live_every_s seconds."""

    def __init__(self, p: dict):
        self.every = p["live_every_s"]
        self._last = -1e18
        self._lock = threading.Lock()

    def ready(self, now: float | None = None) -> bool:
        now = time.monotonic() if now is None else now
        with self._lock:
            if now - self._last >= self.every:
                self._last = now
                return True
            return False
