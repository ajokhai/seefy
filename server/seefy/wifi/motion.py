"""Motion from a single link's RSSI: is someone moving near the path between router and laptop?

A body near a link's direct path makes its RSSI fluctuate. Compare the RSSI spread over a
short window with the spread measured while the space was still. RSSI comes in whole dB,
so spread has a floor, otherwise a perfectly flat baseline would make any 1 dB tick look
like motion. Pure functions and a small stateful tracker; no I/O.
"""

from __future__ import annotations

import collections
from dataclasses import dataclass

import numpy as np

DEFAULTS: dict = {
    "window_s": 1.5,  # RSSI spread is measured over this much recent signal
    "baseline_s": 20.0,  # still-space reference; the empty-space capture is 30 s
    "min_std_db": 0.5,  # floor on the still spread (RSSI is quantised to 1 dB)
    "moving_ratio": 2.0,  # window spread this many times the still spread counts as motion
    "min_samples": 8,  # samples needed in a window before scoring
    "detrend": True,  # remove each window's straight-line trend, so slow drift isn't counted as motion
}

DOCS: dict = {
    "_": ("WiFi motion (link signal)", "How the laptop decides someone is moving from its own WiFi signal strength."),
    "window_s": ("Motion window", "How much recent signal is compared against the still room. Shorter reacts faster but is jumpier.", "s"),
    "baseline_s": ("Still reference", "How long the still-room reference lasts. Record it with nobody moving.", "s"),
    "min_std_db": ("Noise floor", "The smallest signal wobble treated as normal, because WiFi reports whole decibels.", "dB"),
    "moving_ratio": ("Motion threshold", "How many times wobblier than the still room the signal must be to count as movement.", "×"),
    "min_samples": ("Samples needed", "Readings needed in a window before it's scored.", ""),
    "detrend": ("Ignore slow drift", "Ignore slow changes, like the router adjusting its power, so only quick wobbles from a moving body count.", ""),
}


def spread(rssi, t_ms=None) -> float:
    """Standard deviation of RSSI values, in dB. Given times, a straight-line trend is removed first,
    so slow drift (router power or rate changes, well under 0.1 Hz) isn't mistaken for a moving body."""
    a = np.asarray(rssi, dtype=float)
    if a.size < 2:
        return 0.0
    if t_ms is not None and a.size >= 3:
        t = np.asarray(t_ms, dtype=float)
        if np.ptp(t) > 0:
            a = a - np.polyval(np.polyfit(t - t[0], a, 1), t - t[0])
    return float(a.std())


@dataclass
class Motion:
    score: float  # window spread / still spread; ~1 when still
    moving: bool
    window_std_db: float
    baseline_std_db: float
    samples: int


class MotionTracker:
    """Feed (t_ms, rssi) as they arrive; call `motion()` for the current reading.

    Without an explicit baseline, the first `baseline_s` seconds are taken as still."""

    def __init__(self, cfg: dict | None = None):
        self.c = {**DEFAULTS, **(cfg or {})}
        self._win: collections.deque[tuple[float, float]] = collections.deque()
        self._base: list[float] = []
        self._base_until: float | None = None
        self.baseline_std: float | None = None

    def set_baseline(self, rssi) -> None:
        """Use these readings, taken with nobody moving, as the still reference."""
        self.baseline_std = max(self.c["min_std_db"], spread(rssi))
        self._base_until = -1.0

    def add(self, t_ms: float, rssi: float) -> None:
        if self._base_until is None:
            self._base_until = t_ms + 1000 * self.c["baseline_s"]
        if self.baseline_std is None:
            self._base.append(rssi)
            if t_ms >= self._base_until:
                self.set_baseline(self._base)
        self._win.append((t_ms, rssi))
        cutoff = t_ms - 1000 * self.c["window_s"]
        while self._win and self._win[0][0] < cutoff:
            self._win.popleft()

    def motion(self) -> Motion | None:
        n = len(self._win)
        if n < self.c["min_samples"]:
            return None
        base = self.baseline_std if self.baseline_std is not None else max(self.c["min_std_db"], spread(self._base))
        w = spread([r for _, r in self._win], [t for t, _ in self._win] if self.c["detrend"] else None)
        ratio = max(w, self.c["min_std_db"]) / base
        return Motion(score=round(ratio, 2), moving=ratio >= self.c["moving_ratio"], window_std_db=round(w, 2),
                      baseline_std_db=round(base, 2), samples=n)


def rates(t_ms, rssi) -> tuple[float, float]:
    """(readings per second, value changes per second) over a series."""
    t = np.asarray(t_ms, dtype=float)
    if t.size < 2 or t[-1] <= t[0]:
        return 0.0, 0.0
    dur = (t[-1] - t[0]) / 1000
    changes = int(np.count_nonzero(np.diff(np.asarray(rssi)) != 0))
    return (t.size - 1) / dur, changes / dur
