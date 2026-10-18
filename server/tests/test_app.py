import numpy as np
from fastapi.testclient import TestClient

from seefy import geometry as g
from seefy.app import create_app
from seefy.lens import board_points
from seefy.config import DEFAULTS


def test_state_config_and_clock_ping(tmp_path):
    with TestClient(create_app(tmp_path)) as client:
        assert client.get("/api/state").json()["devices"] == []
        r = client.put("/api/config", json={"tracking": {"tag_size_m": 0.12}, "bogus": {"x": 1}})
        assert r.json()["values"]["tracking"]["tag_size_m"] == 0.12
        assert "bogus" not in r.json()["overrides"]

        with client.websocket_connect("/ws?role=phone&device=p1&name=test") as ws:
            assert ws.receive_json()["type"] == "welcome"
            ws.send_json({"type": "ping", "id": 1, "t0": 123.0})
            msg = ws.receive_json()
            while msg["type"] != "pong":
                msg = ws.receive_json()
            assert msg["id"] == 1 and msg["t0"] == 123.0 and msg["host"] > 0


def test_session_records_poses(tmp_path):
    with TestClient(create_app(tmp_path)) as client:
        s = client.post("/api/session/start", json={"kind": "walk", "notes": "t"}).json()
        assert s["kind"] == "walk" and s["pass"] == 1
        with client.websocket_connect("/ws?role=phone&device=p1") as ws:
            ws.receive_json()
            ws.send_json({"type": "pose", "t": 1.0, "ts": 1.0, "src": "tags", "p": [1, 2, 1.4],
                          "R": np.eye(3).ravel().tolist(), "err": 0.5, "tags": [0]})
            ws.send_json({"type": "ping", "id": 2, "t0": 0})  # round trip so the pose is processed
            while ws.receive_json()["type"] != "pong":
                pass
        summary = client.post("/api/session/stop").json()
        assert summary["counts"]["phone"] == 1
        assert client.post("/api/session/start", json={"kind": "walk"}).json()["pass"] == 2


def test_lens_calibration_accumulates_views(tmp_path):
    lc = DEFAULTS["lens"]
    board = board_points(lc)
    K = np.array([[1000.0, 0, 640], [0, 1000.0, 360], [0, 0, 1]])
    rng = np.random.default_rng(0)
    with TestClient(create_app(tmp_path)) as client:
        with client.websocket_connect("/ws?role=phone&device=cam") as ws:
            ws.receive_json()
            for v in range(14):
                rvec = np.array([rng.uniform(-0.5, 0.5), rng.uniform(-0.5, 0.5), rng.uniform(-0.3, 0.3)])
                T = g.to_T(rvec, [-3.5 * 0.03, -4.5 * 0.03, 0.45 + 0.02 * v])
                dets = []
                for i, pts in board.items():
                    uv = g.project(K, T, pts.astype(np.float64) * 0.03) + rng.normal(0, 0.2, (4, 2))
                    dets.append({"id": i, "c": uv.ravel().tolist()})
                ws.send_json({"type": "tags", "mode": "lens", "t": v, "w": 1280, "h": 720, "dets": dets})
                msg = ws.receive_json()
                while msg["type"] != "lens_view":
                    msg = ws.receive_json()
                assert msg["accepted"]
        result = client.post("/api/lens/cam/calibrate").json()
        assert result["ok"]
        assert abs(result["K"][0] - 1000) < 15 and abs(result["K"][2] - 640) < 15
        assert result["rms_px"] < 0.5
