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
