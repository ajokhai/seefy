"""WebSocket hub: every phone and viewer connects here.

Phones send clock pings, their camera pose, tag detections and teacher
keypoints. Viewers (the Live and Sensors screens on any browser) receive
poses as they arrive plus a state summary twice a second.

Timestamps from phones are already converted to the host clock (see the
ping/pong handshake), so the hub can measure each device's latency directly.
"""

from __future__ import annotations

import asyncio
import json
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any

import numpy as np
from fastapi import WebSocket

from . import geometry as g
from .clock import host_ms
from .config import Config
from .lens import LensStore
from .metrics import MetricsLog
from .net import mac_for_ip
from .recorder import Recorder
from .tagmap import TagMap


class RateMeter:
    def __init__(self, window_s: float = 2.0):
        self.window = window_s
        self.times: deque[float] = deque()

    def tick(self) -> None:
        now = time.monotonic()
        self.times.append(now)
        while self.times and now - self.times[0] > self.window:
            self.times.popleft()

    def rate(self) -> float:
        now = time.monotonic()
        while self.times and now - self.times[0] > self.window:
            self.times.popleft()
        return len(self.times) / self.window


def ema(prev: float | None, value: float, alpha: float = 0.1) -> float:
    return value if prev is None else prev + alpha * (value - prev)


@dataclass
class Device:
    id: str
    name: str
    role: str  # phone | viewer
    ip: str
    ua: str
    ws: WebSocket
    tab: str = ""  # one phone can have several tabs open; each is its own connection
    connected_at: float = field(default_factory=time.time)
    mac: str | None = None
    mode: str = "idle"
    status: dict = field(default_factory=dict)
    sync: dict = field(default_factory=dict)
    capture_latency_ms: float | None = None  # camera frame -> host
    net_latency_ms: float | None = None  # phone send -> host
    last_pose: dict | None = None
    rates: dict[str, RateMeter] = field(default_factory=dict)

    def count(self, kind: str) -> None:
        self.rates.setdefault(kind, RateMeter()).tick()

    def summary(self) -> dict:
        def r(v):
            return None if v is None else round(v, 1)

        return {
            "id": self.id, "tab": self.tab, "name": self.name, "role": self.role, "ip": self.ip, "mac": self.mac,
            "mode": self.mode, "status": self.status, "sync": self.sync,
            "capture_latency_ms": r(self.capture_latency_ms), "net_latency_ms": r(self.net_latency_ms),
            "rates": {k: round(m.rate(), 1) for k, m in self.rates.items()},
            "pose_age_ms": r(host_ms() - self.last_pose["t"]) if self.last_pose else None,
            "connected_s": round(time.time() - self.connected_at),
        }


class Hub:
    def __init__(self, cfg: Config, tagmap: TagMap, lens: LensStore, recorder: Recorder, metrics: MetricsLog):
        self.cfg, self.tagmap, self.lens, self.recorder, self.metrics = cfg, tagmap, lens, recorder, metrics
        self.devices: dict[str, Device] = {}
        self._solve_pending_since: float | None = None
        self._solving = False
        self._tasks: list[asyncio.Task] = []
        self.scans = None  # ScanStore, set by the app

    # -- lifecycle ----------------------------------------------------------

    def start(self) -> None:
        self._tasks = [asyncio.create_task(self._state_loop()), asyncio.create_task(self._solve_loop())]

    async def stop(self) -> None:
        for t in self._tasks:
            t.cancel()
        self.recorder.stop()

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        q = ws.query_params
        ip = ws.client.host if ws.client else "?"
        dev = Device(
            id=q.get("device", "")[:64] or f"anon-{id(ws)}", name=q.get("name", "")[:40] or "device",
            role=q.get("role", "viewer"), ip=ip, ua=ws.headers.get("user-agent", "")[:200], ws=ws,
            tab=q.get("tab", "")[:32],
        )
        key = f"{dev.id}:{dev.tab}"
        old = self.devices.get(key)
        if old:  # same tab reconnected (page reload); drop the stale socket
            try:
                await old.ws.close()
            except Exception:
                pass
        if dev.role == "phone":
            dev.mac = await asyncio.to_thread(mac_for_ip, ip)
        await self._send(dev, {
            "type": "welcome", "device": dev.id, "host": host_ms(), "config": self.cfg.values,
            "tagmap": self.tagmap.to_json(), "lens": self.lens.get(dev.id), "session": self._session(),
        })
        self.devices[key] = dev  # only now does it receive broadcasts, so "welcome" always comes first
        self.metrics.event("connect", device=dev.id, name=dev.name, role=dev.role, ip=ip, ua=dev.ua)
        try:
            while True:
                msg = await ws.receive_text()
                await self._handle(dev, msg)
        except Exception:
            pass
        finally:
            if self.devices.get(key) is dev:
                del self.devices[key]
                self.metrics.event("disconnect", device=dev.id, connected_s=round(time.time() - dev.connected_at))

    # -- messages -----------------------------------------------------------

    async def _handle(self, dev: Device, raw: str) -> None:
        recv = host_ms()
        msg: dict[str, Any] = json.loads(raw)
        kind = msg.get("type")
        dev.count(kind or "?")

        if kind == "ping":  # clock sync: answer immediately, nothing else
            await self._send(dev, {"type": "pong", "id": msg.get("id"), "t0": msg.get("t0"), "host": host_ms()})
            return
        if "ts" in msg:
            dev.net_latency_ms = ema(dev.net_latency_ms, recv - msg["ts"])

        if kind == "sync":
            dev.sync = {k: msg.get(k) for k in ("offset_ms", "rtt_ms", "err_ms", "samples")}
        elif kind == "status":
            dev.mode = str(msg.get("mode", dev.mode))
            dev.status = {k: v for k, v in msg.items() if k not in ("type", "ts")}
        elif kind == "pose":
            await self._on_pose(dev, msg, recv)
        elif kind == "tags":
            await self._on_tags(dev, msg, recv)
        elif kind == "motion":
            scan = self.scans.get(str(msg.get("scan", ""))) if self.scans else None
            if scan:
                scan.add_motion(msg.get("samples", []))
        elif kind == "keypoints":
            dev.capture_latency_ms = ema(dev.capture_latency_ms, recv - msg["t"])
            self.recorder.write("keypoints", {"device": dev.id, "recv": recv, **_strip(msg)})
            await self._broadcast({"type": "keypoints", "device": dev.id, "t": msg["t"], "kp": msg.get("kp")})

    async def _on_pose(self, dev: Device, msg: dict, recv: float) -> None:
        dev.capture_latency_ms = ema(dev.capture_latency_ms, recv - msg["t"])
        p = np.array(msg["p"], dtype=np.float64)
        R = np.array(msg["R"], dtype=np.float64).reshape(3, 3)
        body, heading = g.body_from_phone(p, R, self.cfg["tracking"]["body_offset_m"])
        pose = {
            "type": "pose", "device": dev.id, "t": msg["t"], "recv": recv, "src": msg.get("src"),
            "p": msg["p"], "R": msg["R"], "err": msg.get("err"), "tags": msg.get("tags"),
            "body": [round(float(body[0]), 4), round(float(body[1]), 4)],
            "heading": None if np.isnan(heading) else round(heading, 4),
        }
        dev.last_pose = pose
        self.recorder.write("phone", pose)
        await self._broadcast(pose)

    async def _on_tags(self, dev: Device, msg: dict, recv: float) -> None:
        dets = {int(d["id"]): d["c"] for d in msg.get("dets", [])}
        if msg.get("mode") == "lens":
            n = self.lens.add_view(dev.id, int(msg["w"]), int(msg["h"]), dets)
            await self._send(dev, {"type": "lens_view", "accepted": n is not None, "views": n})
            return
        K = np.array(msg["K"], dtype=np.float64).reshape(3, 3)
        D = np.array(msg["D"], dtype=np.float64) if msg.get("D") else None
        arr = {i: np.array(c, dtype=np.float64).reshape(4, 2) for i, c in dets.items()}
        pass_id = self.recorder.active.id if self.recorder.active else "unrecorded"
        self.recorder.write("tags", {"device": dev.id, "recv": recv, **_strip(msg)})
        if self.tagmap.add_frame(msg["t"], dev.id, pass_id, K, D, arr):
            self._solve_pending_since = time.monotonic()

    # -- background ---------------------------------------------------------

    async def _solve_loop(self) -> None:
        while True:
            await asyncio.sleep(0.25)
            since = self._solve_pending_since
            if since is None or self._solving:
                continue
            if time.monotonic() - since < self.cfg["mapping"]["solve_debounce_s"]:
                continue
            await self.solve_now()

    async def solve_now(self) -> dict:
        self._solving = True
        self._solve_pending_since = None
        try:
            await asyncio.to_thread(self.tagmap.solve)
        finally:
            self._solving = False
        tm = self.tagmap.to_json()
        self.metrics.event("map_solve", **{k: tm[k] for k in ("passes", "frames", "frames_used", "rms_px", "solve_ms")},
                           tags=len(tm["tags"]), tag_rms_px={k: v["rms_px"] for k, v in tm["tags"].items()})
        await self._broadcast({"type": "tagmap", "tagmap": tm})
        return tm

    async def _state_loop(self) -> None:
        n = 0
        while True:
            await asyncio.sleep(0.5)
            state = self.state()
            await self._broadcast({"type": "state", **state})
            n += 1
            if n % 10 == 0 and self.devices:  # every 5 s while anything is connected
                self.metrics.snapshot(state)

    def state(self) -> dict:
        tm = self.tagmap.to_json()
        return {
            "host": host_ms(),
            "devices": [d.summary() for d in self.devices.values()],
            "session": self._session(),
            "tagmap": {k: tm[k] for k in ("version", "frames", "frames_used", "passes", "rms_px", "solve_ms")}
            | {"tags": len(tm["tags"]), "solving": self._solving},
        }

    def _session(self) -> dict | None:
        return self.recorder.active.summary() if self.recorder.active else None

    # -- sending ------------------------------------------------------------

    async def _send(self, dev: Device, msg: dict) -> None:
        try:
            await dev.ws.send_text(json.dumps(msg, separators=(",", ":")))
        except Exception:
            pass

    async def _broadcast(self, msg: dict, roles: tuple[str, ...] = ("viewer", "phone")) -> None:
        text = json.dumps(msg, separators=(",", ":"))
        targets = [d for d in self.devices.values() if d.role in roles]
        await asyncio.gather(*(self._send_text(d, text) for d in targets))

    async def _send_text(self, dev: Device, text: str) -> None:
        try:
            await dev.ws.send_text(text)
        except Exception:
            pass

    async def broadcast(self, msg: dict) -> None:
        await self._broadcast(msg)

    async def broadcast_config(self) -> None:
        await self._broadcast({"type": "config", "config": self.cfg.values})

    async def broadcast_session(self) -> None:
        await self._broadcast({"type": "session", "session": self._session()})

    async def broadcast_tagmap(self) -> None:
        await self._broadcast({"type": "tagmap", "tagmap": self.tagmap.to_json()})

    async def send_lens(self, device: str) -> None:
        for dev in [d for d in self.devices.values() if d.id == device]:
            await self._send(dev, {"type": "lens", "lens": self.lens.get(device)})


def _strip(msg: dict) -> dict:
    return {k: v for k, v in msg.items() if k != "type"}
