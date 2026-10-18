"""WiFi signal sources (Phase 3). Tier 0 is the laptop's own link RSSI to the router.

Every source yields `Sample`s stamped on the host clock (seefy.clock.host_ms), so they line
up with phone poses and camera frames on one timeline.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass


@dataclass(frozen=True)
class Sample:
    t: float  # host clock, ms
    rssi: int  # dBm
    noise: int | None = None  # dBm
    tx_mbps: float | None = None  # current transmit rate
    channel: int | None = None
    band: str = ""  # "2.4", "5", "6" GHz, or "" when unknown
    tier: int = 0
    link: str = "router"  # which transmitter this reading is of; tier 0 has only one

    def to_json(self) -> dict:
        return {"t": round(self.t, 3), "rssi": self.rssi, "noise": self.noise, "tx": self.tx_mbps,
                "ch": self.channel, "band": self.band, "tier": self.tier, "link": self.link}


def available() -> list[str]:
    """Which signal sources this machine can provide, best tier last."""
    found = []
    if sys.platform == "darwin":
        from . import macos
        if macos.supported():
            found.append("macos-link-rssi")
    return found


def open_source(interval_ms: float = 10.0):
    """The best available source, as a context manager yielding Samples. Raises if there's none."""
    if sys.platform == "darwin":
        from .macos import LinkRSSI
        return LinkRSSI(interval_ms=interval_ms)
    raise RuntimeError("no WiFi signal source for this platform yet (tier 0 is macOS only so far)")
