import asyncio
import json
import random

from fastapi import FastAPI
from fastapi.testclient import TestClient

from seefy.clock import host_ms
from seefy.wifi import Sample, live


class FakeSource:
    """Synthetic link RSSI at ~100 readings/s: flat ±1 dB until `wobble` is set, then ±8 dB."""

    def __init__(self):
        self.t0 = host_ms()
        self.wobble = False
        self.error = ""
        self._rng = random.Random(0)
        self._buf: list[Sample] = []
        self._last = self.t0

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        pass

    def recent(self, window_ms):
        now = host_ms()
        while self._last + 10 <= now:
            self._last += 10
            amp = 8 if self.wobble else 1
            self._buf.append(Sample(t=self._last, rssi=-60 + self._rng.randint(-amp, amp)))
        return [s for s in self._buf if s.t >= now - window_ms]


class FakeHub:
    def __init__(self):
        self.sent = []

    async def broadcast(self, msg):
        self.sent.append(msg)


CFG = {"wifi": {"window_s": 0.5, "min_samples": 5}}


def test_broadcasts_calibrates_and_detects_motion(tmp_path, monkeypatch):
    monkeypatch.delenv("SEEFY_WIFI", raising=False)
    src, hub = FakeSource(), FakeHub()

    async def scenario():
        w = live.WifiLive(hub, CFG, tmp_path, source=lambda: src)
        w.start()
        await asyncio.sleep(0.5)
        assert w.status()["baseline"] == "learning"
        w.record_baseline(0.6)
        await asyncio.sleep(0.3)
        assert hub.sent[-1]["baseline"] == "recording" and hub.sent[-1]["calibrate_left_s"] > 0
        await asyncio.sleep(0.8)
        assert w.status()["baseline"] == "saved"
        assert not hub.sent[-1]["moving"]
        src.wobble = True
        await asyncio.sleep(0.8)
        await w.stop()
        return w

    w = asyncio.run(scenario())
    last = hub.sent[-1]
    assert last["type"] == "wifi" and last["moving"] and last["score"] >= 2
    assert last["rate_hz"] > 50 and -70 < last["rssi"] < -50
    saved = json.loads((tmp_path / "wifi" / "baseline.json").read_text())
    assert saved["rssi"] and saved["std_db"] >= 0.5
    # A restart picks the saved reference up again instead of re-learning.
    assert live.WifiLive(FakeHub(), CFG, tmp_path, source=lambda: src).status()["baseline"] == "saved"
    assert len(w.history) == len(hub.sent)


def test_routes_and_missing_source(tmp_path, monkeypatch):
    monkeypatch.delenv("SEEFY_WIFI", raising=False)

    def no_source():
        raise RuntimeError("no WiFi signal source for this platform yet")

    app = FastAPI()
    hub = FakeHub()
    w = live.attach(app, hub, {}, tmp_path, source=no_source)

    async def run():
        w.start()
        await asyncio.sleep(0.05)

    asyncio.run(run())
    assert "no WiFi signal source" in hub.sent[-1]["error"]
    client = TestClient(app)
    r = client.get("/api/wifi").json()
    assert r["type"] == "wifi" and r["history"] == [] and r["baseline"] == "none"
    assert client.post("/api/wifi/baseline", json={"seconds": 5}).status_code == 409
