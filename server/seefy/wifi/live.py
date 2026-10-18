"""Live WiFi motion for the app: read the link signal in the background, score it, broadcast it.

    wifi = live.attach(app, hub, cfg, data)   # routes: GET /api/wifi, POST /api/wifi/baseline
    wifi.start() ... await wifi.stop()        # from the app's lifespan

A few times a second every viewer gets
    {"type": "wifi", "t", "rssi", "score", "moving", "window_std_db", "baseline_std_db", "rate_hz",
     "baseline": "saved" | "learning" | "auto" | "recording" | "none", "calibrate_left_s", "error"}
rssi is the mean over that tick (dBm, one decimal) so a sparkline needs no other data.

The still-room reference is recorded on request (nobody moving, 20 s) and saved to
<data>/wifi/baseline.json, so it survives restarts. Until one exists, the tracker takes its
first baseline_s seconds as still, which is only right if the room happened to be quiet.
Set SEEFY_WIFI=off to skip the radio entirely (tests, machines without a source).
"""

from __future__ import annotations

import asyncio
import collections
import contextlib
import json
import os
import time
from pathlib import Path
from typing import Callable

from fastapi import Body, FastAPI, HTTPException

from ..clock import host_ms
from . import motion, open_source

TICK_S = 0.2  # broadcast rate: 5 per second
HISTORY_S = 120  # ticks kept for GET /api/wifi, so a freshly opened page can draw its sparkline
RETRY_S = 5.0  # wait before reopening a source that failed or stopped


class WifiLive:
    def __init__(self, hub, cfg, data: Path, source: Callable = open_source):
        self.hub, self.cfg, self.source = hub, cfg, source
        self.path = data / "wifi" / "baseline.json"
        self.tracker = motion.MotionTracker(self._settings())
        self.history: collections.deque[dict] = collections.deque(maxlen=int(HISTORY_S / TICK_S))
        self.error = ""
        self.rate_hz = 0.0
        self._baseline = "none"
        self._recording: list[int] | None = None
        self._record_until = 0.0  # host ms
        self._task: asyncio.Task | None = None
        saved = self._load()
        if saved:
            self.tracker.set_baseline(saved["rssi"])
            self._baseline = "saved"

    def _settings(self) -> dict:
        try:
            return {**motion.DEFAULTS, **self.cfg["wifi"]}
        except KeyError:
            return dict(motion.DEFAULTS)

    def _load(self) -> dict | None:
        try:
            d = json.loads(self.path.read_text())
            return d if d.get("rssi") else None
        except (OSError, ValueError):
            return None

    # -- lifecycle ----------------------------------------------------------

    def start(self) -> None:
        if os.environ.get("SEEFY_WIFI", "").lower() in ("0", "off", "no", "false"):
            self.error = "WiFi sensing is turned off (SEEFY_WIFI=off)"
            return
        self._task = asyncio.create_task(self._run())

    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task

    async def _run(self) -> None:
        while True:
            try:
                src = self.source()
            except Exception as e:  # no source on this machine: say so once and stop trying
                self.error = str(e)
                await self.hub.broadcast(self.message(None))
                return
            try:
                await asyncio.to_thread(src.__enter__)  # may compile the helper on first use
                self.error = ""
                await self._read(src)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                self.error = f"WiFi reader failed: {e}"
            finally:
                await asyncio.to_thread(src.__exit__, None, None, None)
            await self.hub.broadcast(self.message(None))
            await asyncio.sleep(RETRY_S)

    async def _read(self, src) -> None:
        last_t = host_ms()
        stale = 0
        while True:
            await asyncio.sleep(TICK_S)
            self.tracker.c.update(self._settings())  # settings edits apply live
            fresh = [s for s in src.recent(2000) if s.t > last_t]
            if fresh:
                last_t = fresh[-1].t
                stale = 0
            else:
                stale += 1
            for s in fresh:
                self._add(s.t, s.rssi)
            span = src.recent(2000)
            self.rate_hz = round(float(motion.rates([s.t for s in span], [s.rssi for s in span])[0]), 1)
            if getattr(src, "error", ""):
                self.error = src.error
            if stale * TICK_S > 5:  # nothing for 5 s: the helper died or the Mac left the network
                raise RuntimeError(self.error or "no WiFi readings for 5 s (is the Mac on WiFi?)")
            msg = self.message(sum(s.rssi for s in fresh) / len(fresh) if fresh else None)
            self.history.append(msg)
            await self.hub.broadcast(msg)

    def _add(self, t: float, rssi: int) -> None:
        self.tracker.add(t, rssi)
        if self._recording is not None:
            self._recording.append(rssi)
            if t >= self._record_until:
                self._finish_recording()

    # -- still-room reference -------------------------------------------------

    def record_baseline(self, seconds: float) -> dict:
        if not self.running():
            raise HTTPException(409, self.error or "WiFi sensing isn't running")
        self._recording = []
        self._record_until = host_ms() + 1000 * seconds
        return self.status()

    def _finish_recording(self) -> None:
        rssi, self._recording = self._recording or [], None
        if len(rssi) < self.tracker.c["min_samples"]:
            self.error = "too few WiFi readings while calibrating; try again"
            return
        self.tracker.set_baseline(rssi)
        self._baseline = "saved"
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps({"recorded": time.time(), "std_db": self.tracker.baseline_std,
                                         "mean_dbm": round(sum(rssi) / len(rssi), 2), "rssi": rssi}))

    # -- reporting ------------------------------------------------------------

    def _baseline_state(self) -> str:
        if self._recording is not None:
            return "recording"
        if self._baseline == "saved":
            return "saved"
        return "auto" if self.tracker.baseline_std is not None else "learning" if self.running() else "none"

    def message(self, rssi: float | None) -> dict:
        m = self.tracker.motion()
        left = max(0.0, (self._record_until - host_ms()) / 1000) if self._recording is not None else 0.0
        return {"type": "wifi", "t": round(host_ms(), 1), "rssi": None if rssi is None else round(rssi, 1),
                "score": m.score if m else None, "moving": bool(m and m.moving and self._baseline_state() != "learning"),
                "window_std_db": m.window_std_db if m else None,
                "baseline_std_db": m.baseline_std_db if m else self.tracker.baseline_std,
                "rate_hz": self.rate_hz, "baseline": self._baseline_state(),
                "calibrate_left_s": round(left, 1), "error": self.error}

    def status(self) -> dict:
        return self.message(self.history[-1]["rssi"] if self.history else None)


def attach(app: FastAPI, hub, cfg, data: Path, source: Callable = open_source) -> WifiLive:
    wifi = WifiLive(hub, cfg, data, source)

    @app.get("/api/wifi")
    def wifi_status():
        return {**wifi.status(), "history": [[m["t"], m["rssi"], m["score"]] for m in wifi.history]}

    @app.post("/api/wifi/baseline")
    def wifi_baseline(body: dict = Body(default={})):
        return wifi.record_baseline(float(body.get("seconds", 20)))

    return wifi
