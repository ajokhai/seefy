"""Spaces (homes) made of rooms, each with an active scan and the user's layout edits.

Stored in <data>/spaces.json:
  {"active": sid, "spaces": {sid: {id, name, created, active_room, rooms: {rid: Room}}}}
Room: {id, name, created, order, scan_id, layout_overrides, overrides_scan_id, placement}

Rooms aren't stitched together yet: each scan has its own origin, so a room's placement
({x, y, yaw}) says where it sits on the Home map. Layout edits replace whole keys of the
layout built from the scan (outline, walls, objects) and belong to the scan they were made on.
"""

from __future__ import annotations

import json
import math
import secrets
import threading
import time
from pathlib import Path

OVERRIDE_KEYS = ("outline", "size_m", "walls", "objects")


def _new_id() -> str:
    return secrets.token_hex(4)


class Spaces:
    def __init__(self, path: Path, scans):
        self.path = path
        self.scans = scans  # ScanStore
        self.lock = threading.Lock()
        self.data = {"active": None, "spaces": {}}
        if path.exists():
            self.data = json.loads(path.read_text())

    def _save(self) -> None:
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.data, indent=2))
        tmp.replace(self.path)  # atomic: a crash can't leave a half-written file

    # -- reading ---------------------------------------------------------------

    def _scan_summary(self, sid: str | None) -> dict | None:
        s = self.scans.get(sid) if sid else None
        if not s:
            return None
        m = s.meta()
        res = s.result() if m.get("status") == "done" else None
        return {
            "id": sid, "status": m.get("status"), "registered": m.get("registered"), "total": m.get("total"),
            "room_size_m": (res or {}).get("room_size_m"), "level": ((res or {}).get("coverage") or {}).get("level"),
            "finished": m.get("stopped"),
        }

    def merged_layout(self, room: dict) -> dict | None:
        s = self.scans.get(room["scan_id"]) if room.get("scan_id") else None
        res = s.result() if s else None
        if not res or not res.get("layout"):
            return None
        layout = dict(res["layout"])
        if room.get("overrides_scan_id") == room.get("scan_id"):
            for k in OVERRIDE_KEYS:
                if k in room.get("layout_overrides", {}):
                    layout[k] = room["layout_overrides"][k]
                    layout["ok"] = True
        return layout

    def room_view(self, room: dict, with_layout: bool = True) -> dict:
        overrides = room.get("layout_overrides", {}) if room.get("overrides_scan_id") == room.get("scan_id") else {}
        out = {k: room.get(k) for k in ("id", "name", "created", "order", "scan_id", "placement")}
        out["scan"] = self._scan_summary(room.get("scan_id"))
        out["edited"] = bool(overrides)
        if with_layout:
            out["layout"] = self.merged_layout(room)
        return out

    def space_view(self, space: dict, with_layout: bool = True) -> dict:
        rooms = sorted(space["rooms"].values(), key=lambda r: (r.get("order", 0), r["created"]))
        return {"id": space["id"], "name": space["name"], "created": space["created"],
                "active_room": space.get("active_room"), "rooms": [self.room_view(r, with_layout) for r in rooms]}

    def list(self) -> dict:
        return {"active": self.data["active"],
                "spaces": [self.space_view(s) for s in sorted(self.data["spaces"].values(), key=lambda s: s["created"])]}

    def summary(self) -> dict | None:
        """Small form for state/welcome messages."""
        sp = self.data["spaces"].get(self.data["active"] or "")
        if not sp:
            return None
        rooms = sorted(sp["rooms"].values(), key=lambda r: (r.get("order", 0), r["created"]))
        return {"id": sp["id"], "name": sp["name"], "active_room": sp.get("active_room"),
                "rooms": [{"id": r["id"], "name": r["name"], "scan_id": r.get("scan_id"),
                           "level": (self._scan_summary(r.get("scan_id")) or {}).get("level")} for r in rooms]}

    def get(self, sid: str) -> dict | None:
        return self.data["spaces"].get(sid)

    def room(self, sid: str, rid: str) -> dict | None:
        sp = self.get(sid)
        return sp["rooms"].get(rid) if sp else None

    def map(self, sid: str) -> dict | None:
        sp = self.get(sid)
        if not sp:
            return None
        rooms = []
        for r in sorted(sp["rooms"].values(), key=lambda r: (r.get("order", 0), r["created"])):
            s = self.scans.get(r["scan_id"]) if r.get("scan_id") else None
            res = s.result() if s else None
            if res and res.get("ok"):
                res = dict(res)
                res["layout"] = self.merged_layout(r)
            rooms.append({"room": self.room_view(r, with_layout=False), "map": res if res and res.get("ok") else None})
        return {"space": self.space_view(sp, with_layout=False), "rooms": rooms}

    # -- writing ---------------------------------------------------------------

    def create_space(self, name: str) -> dict:
        with self.lock:
            sid = _new_id()
            self.data["spaces"][sid] = {"id": sid, "name": name.strip()[:80] or "My home", "created": time.time(),
                                        "active_room": None, "rooms": {}}
            if not self.data["active"]:
                self.data["active"] = sid
            self._save()
            return self.data["spaces"][sid]

    def update_space(self, sid: str, changes: dict) -> dict | None:
        with self.lock:
            sp = self.get(sid)
            if not sp:
                return None
            if "name" in changes:
                sp["name"] = str(changes["name"]).strip()[:80] or sp["name"]
            if changes.get("active"):
                self.data["active"] = sid
            if "active_room" in changes and changes["active_room"] in sp["rooms"]:
                sp["active_room"] = changes["active_room"]
            self._save()
            return sp

    def delete_space(self, sid: str) -> bool:
        with self.lock:
            if sid not in self.data["spaces"]:
                return False
            del self.data["spaces"][sid]
            if self.data["active"] == sid:
                self.data["active"] = next(iter(self.data["spaces"]), None)
            self._save()
            return True

    def create_room(self, sid: str, name: str) -> dict | None:
        with self.lock:
            sp = self.get(sid)
            if not sp:
                return None
            rid = _new_id()
            n = len(sp["rooms"])
            sp["rooms"][rid] = {
                "id": rid, "name": name.strip()[:80] or f"Room {n + 1}", "created": time.time(), "order": n,
                "scan_id": None, "layout_overrides": {}, "overrides_scan_id": None,
                # Not stitched yet: lay rooms out side by side, 6 m apart.
                "placement": {"x": 6.0 * n, "y": 0.0, "yaw": 0.0},
            }
            sp["active_room"] = rid
            self._save()
            return sp["rooms"][rid]

    def update_room(self, sid: str, rid: str, changes: dict) -> dict | None:
        with self.lock:
            r = self.room(sid, rid)
            if not r:
                return None
            if "name" in changes:
                r["name"] = str(changes["name"]).strip()[:80] or r["name"]
            if "order" in changes:
                r["order"] = int(changes["order"])
            if "placement" in changes:
                p = changes["placement"] or {}
                r["placement"] = {"x": float(p.get("x", 0)), "y": float(p.get("y", 0)),
                                  "yaw": float(p.get("yaw", 0)) % (2 * math.pi)}
            if "layout_overrides" in changes:
                ov = changes["layout_overrides"] or {}
                r["layout_overrides"] = {k: ov[k] for k in OVERRIDE_KEYS if k in ov}
                r["overrides_scan_id"] = r.get("scan_id")
            self._save()
            return r

    def delete_room(self, sid: str, rid: str) -> bool:
        with self.lock:
            sp = self.get(sid)
            if not sp or rid not in sp["rooms"]:
                return False
            del sp["rooms"][rid]
            if sp.get("active_room") == rid:
                sp["active_room"] = next(iter(sp["rooms"]), None)
            self._save()
            return True

    def activate_scan(self, sid: str, rid: str, scan_id: str) -> dict | None:
        with self.lock:
            r = self.room(sid, rid)
            if not r or not self.scans.get(scan_id):
                return None
            if r.get("scan_id") != scan_id:
                r["scan_id"] = scan_id
                r["layout_overrides"], r["overrides_scan_id"] = {}, None  # edits belonged to the old scan
            self._save()
            return r

    def target_room(self, room_id: str | None) -> tuple[str, str]:
        """Where a new scan goes: the given room, else the active room, creating a home/room if needed."""
        if room_id:
            for sp in self.data["spaces"].values():
                if room_id in sp["rooms"]:
                    return sp["id"], room_id
        sp = self.get(self.data["active"] or "") or self.create_space("My home")
        rid = sp.get("active_room")
        if not rid or rid not in sp["rooms"]:
            rid = self.create_room(sp["id"], "")["id"]
        return sp["id"], rid
