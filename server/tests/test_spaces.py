from fastapi.testclient import TestClient

from seefy.app import create_app


def test_spaces_rooms_and_scan_targeting(tmp_path):
    with TestClient(create_app(tmp_path)) as c:
        assert c.get("/api/spaces").json() == {"active": None, "spaces": []}
        # A scan with no space yet creates a home and a first room.
        r = c.post("/api/scans/start", json={"device": "p"}).json()
        sp = c.get("/api/spaces").json()
        assert sp["active"] == r["space_id"] and sp["spaces"][0]["rooms"][0]["id"] == r["room_id"]

        sid = r["space_id"]
        kitchen = c.post(f"/api/spaces/{sid}/rooms", json={"name": "Kitchen"}).json()
        assert kitchen["name"] == "Kitchen" and kitchen["placement"]["x"] == 6.0
        # New rooms become active, so the next scan lands there.
        r2 = c.post("/api/scans/start", json={"device": "p"}).json()
        assert r2["room_id"] == kitchen["id"]

        # Activating a scan clears edits made on the previous one.
        c.patch(f"/api/spaces/{sid}/rooms/{kitchen['id']}", json={"layout_overrides": {"objects": [], "junk": 1}})
        c.post(f"/api/spaces/{sid}/rooms/{kitchen['id']}/activate-scan", json={"scan_id": r2["id"]})
        room = c.patch(f"/api/spaces/{sid}/rooms/{kitchen['id']}", json={"layout_overrides": {"objects": []}}).json()
        assert room["edited"] and room["scan_id"] == r2["id"]
        c.post(f"/api/spaces/{sid}/rooms/{kitchen['id']}/activate-scan", json={"scan_id": r["id"]})
        room = [x for x in c.get("/api/spaces").json()["spaces"][0]["rooms"] if x["id"] == kitchen["id"]][0]
        assert not room["edited"]

        assert c.get(f"/api/spaces/{sid}/map").json()["space"]["name"] == "My home"
        assert c.patch(f"/api/spaces/{sid}", json={"name": "Flat"}).json()["name"] == "Flat"
        assert c.delete(f"/api/spaces/{sid}/rooms/{kitchen['id']}").json()["ok"]
        assert c.delete(f"/api/spaces/{sid}").json()["ok"]
        assert c.get("/api/spaces").json()["active"] is None


def test_interrupted_scan_is_recovered_on_startup(tmp_path):
    import json
    with TestClient(create_app(tmp_path)) as c:
        sid = c.post("/api/scans/start", json={"device": "p"}).json()["id"]
    meta = tmp_path / "scans" / sid / "meta.json"
    assert json.loads(meta.read_text())["status"] == "recording"
    with TestClient(create_app(tmp_path)):
        pass  # too few frames to rebuild, so it's marked failed rather than left recording
    assert json.loads(meta.read_text())["status"] == "failed"


def test_room_names_follow_their_point():
    from seefy.spaces import _inside
    square = [[0, 0], [4, 0], [4, 3], [0, 3]]
    assert _inside([1, 1], square) and not _inside([5, 1], square)


def test_restart_stops_work_instead_of_rerunning_it_and_scans_can_be_renamed_and_deleted(tmp_path):
    import json
    with TestClient(create_app(tmp_path)) as c:
        r = c.post("/api/scans/start", json={"device": "p"}).json()
        for i in range(12):
            c.post(f"/api/scans/{r['id']}/frame?t={i * 100}", content=b"jpeg")
    meta = tmp_path / "scans" / r["id"] / "meta.json"
    with TestClient(create_app(tmp_path)) as c:
        # Enough frames to finish, but nothing runs until Resume: a restart mustn't load the Mac by itself.
        assert json.loads(meta.read_text())["status"] == "stopped"
        assert c.get("/api/jobs").json() == {"jobs": []}

        assert c.patch(f"/api/scans/{r['id']}", json={"name": "Living room"}).json()["name"] == "Living room"
        c.post(f"/api/spaces/{r['space_id']}/rooms/{r['room_id']}/activate-scan", json={"scan_id": r["id"]})
        listed = c.get("/api/scans").json()
        assert listed[0]["name"] == "Living room" and listed[0]["in_space"] is False

        assert c.delete(f"/api/scans/{r['id']}").json()["ok"]
        assert c.get("/api/scans").json() == []
        assert (tmp_path / "trash" / r["id"] / "meta.json").exists()  # recoverable
        room = c.get("/api/spaces").json()["spaces"][0]["rooms"][0]
        assert room["scan_id"] is None
        assert c.post("/api/jobs/nope/pause").status_code == 409
