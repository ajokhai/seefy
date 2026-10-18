"""Tier 0 on macOS: the Mac's link RSSI, noise and transmit rate from CoreWLAN.

There's no Python binding in the venv, so a tiny Swift helper (rssi_helper.swift, next to
this file) is compiled with the system swiftc on first use, cached, and run as a child
process that prints one JSON line per poll. Lines are stamped on the host clock as they
arrive. RSSI needs no Location permission on macOS 26; SSID/BSSID would, and aren't used.
"""

from __future__ import annotations

import collections
import hashlib
import json
import os
import shutil
import subprocess
import threading
from pathlib import Path

from ..clock import host_ms
from . import Sample

HELPER_SRC = Path(__file__).with_name("rssi_helper.swift")
BANDS = {1: "2.4", 2: "5", 3: "6"}  # CWChannelBand raw values


def supported() -> bool:
    return shutil.which("swiftc") is not None and HELPER_SRC.exists()


def _cache_dir() -> Path:
    return Path(os.environ.get("SEEFY_CACHE", Path.home() / "Library" / "Caches" / "seefy"))


def helper_path() -> Path:
    """Compile the helper if this version of its source hasn't been built yet."""
    src = HELPER_SRC.read_bytes()
    out = _cache_dir() / f"rssi_helper-{hashlib.sha256(src).hexdigest()[:10]}"
    if not out.exists():
        out.parent.mkdir(parents=True, exist_ok=True)
        tmp = out.with_suffix(".building")
        subprocess.run(["swiftc", "-O", str(HELPER_SRC), "-o", str(tmp)], check=True, capture_output=True)
        tmp.replace(out)
    return out


def parse(line: str, t: float) -> Sample | None:
    """One helper line -> Sample, or None for errors and junk."""
    try:
        d = json.loads(line)
    except ValueError:
        return None
    if "rssi" not in d or d.get("rssi") == 0:  # 0 means not associated
        return None
    return Sample(t=t, rssi=int(d["rssi"]), noise=d.get("noise"), tx_mbps=d.get("tx"),
                  channel=d.get("ch") or None, band=BANDS.get(d.get("band"), ""))


class LinkRSSI:
    """Context manager streaming tier-0 samples.

    with LinkRSSI() as src:
        for s in src: ...            # blocking iterator
        src.latest(), src.recent(2000)  # or poll from another thread / an event loop
    """

    def __init__(self, interval_ms: float = 10.0, keep: int = 6000):
        self.interval_ms = interval_ms
        self._buf: collections.deque[Sample] = collections.deque(maxlen=keep)
        self._cv = threading.Condition()
        self._proc: subprocess.Popen | None = None
        self._thread: threading.Thread | None = None
        self._count = 0  # samples received so far
        self.error = ""

    def __enter__(self) -> "LinkRSSI":
        self._proc = subprocess.Popen([str(helper_path()), str(self.interval_ms)], stdout=subprocess.PIPE,
                                      stderr=subprocess.DEVNULL, text=True, bufsize=1)
        self._thread = threading.Thread(target=self._read, daemon=True)
        self._thread.start()
        return self

    def __exit__(self, *exc) -> None:
        if self._proc and self._proc.poll() is None:
            self._proc.terminate()
            try:
                self._proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self._proc.kill()

    def _read(self) -> None:
        assert self._proc and self._proc.stdout
        for line in self._proc.stdout:
            s = parse(line, host_ms())
            with self._cv:
                if s is None:
                    if '"error"' in line:
                        self.error = json.loads(line)["error"]
                else:
                    self.error = ""
                    self._buf.append(s)
                    self._count += 1
                self._cv.notify_all()
        with self._cv:
            self.error = self.error or "helper stopped"
            self._cv.notify_all()

    def latest(self) -> Sample | None:
        with self._cv:
            return self._buf[-1] if self._buf else None

    def recent(self, window_ms: float) -> list[Sample]:
        cutoff = host_ms() - window_ms
        with self._cv:
            return [s for s in self._buf if s.t >= cutoff]

    def __iter__(self):
        """Every new sample in order; a slow reader skips ahead rather than falling behind forever."""
        seen = self._count
        while True:
            with self._cv:
                while self._count == seen:
                    if self._proc is None or self._proc.poll() is not None:
                        return
                    self._cv.wait(timeout=1.0)
                fresh = min(self._count - seen, len(self._buf))
                new = list(self._buf)[-fresh:]
                seen = self._count
            yield from new
