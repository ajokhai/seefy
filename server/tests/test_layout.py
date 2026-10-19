import numpy as np

from seefy import layout


def _wall(rng, a, b, n, gaps=()):
    """Points along a wall from a to b, from the floor to 2.4 m, leaving out each (from, to) gap in metres."""
    a, b = np.asarray(a, float), np.asarray(b, float)
    t = rng.uniform(0, 1, n)
    d = t * np.linalg.norm(b - a)
    keep = np.ones(n, bool)
    for g0, g1 in gaps:
        keep &= ~((d > g0) & (d < g1))
    xy = a + np.outer(t[keep], b - a)
    return np.c_[xy, rng.uniform(0, 2.4, keep.sum())]


def _box(rng, x0, x1, y0, y1, top, n):
    return np.c_[rng.uniform(x0, x1, n), rng.uniform(y0, y1, n), rng.uniform(0, top, n)]


def _rotate(p, yaw):
    c, s = np.cos(yaw), np.sin(yaw)
    p = p.copy()
    p[:, :2] = p[:, :2] @ np.array([[c, -s], [s, c]]).T
    return p


def _frames(path, yaw):
    pts = _rotate(np.c_[np.asarray(path, float), np.full(len(path), 1.35)], yaw)
    return [{"p": q.tolist(), "R": np.eye(3).reshape(-1).tolist()} for q in pts]


def _room(yaw=0.3, seed=0):
    """A 4 x 3 m room with a 0.9 m door in the first wall and a bed."""
    rng = np.random.default_rng(seed)
    p = np.concatenate([
        _wall(rng, (0, 0), (4, 0), 600, gaps=[(1.0, 1.9)]),
        _wall(rng, (4, 0), (4, 3), 450), _wall(rng, (4, 3), (0, 3), 600), _wall(rng, (0, 3), (0, 0), 450),
        _box(rng, 2.2, 3.6, 0.4, 2.4, 0.55, 300),
    ])
    p[:, :2] += rng.normal(0, 0.02, (len(p), 2))
    return _rotate(p, yaw), _frames([(1, 1), (2, 1.5), (1.5, 2.2)], yaw)


def _flat(seed=1):
    """Two rooms side by side (4 x 3 m and 3 x 3 m) with a 0.9 m door in the shared wall at x = 4."""
    rng = np.random.default_rng(seed)
    p = np.concatenate([
        _wall(rng, (0, 0), (7, 0), 1000), _wall(rng, (7, 0), (7, 3), 450),
        _wall(rng, (7, 3), (0, 3), 1000), _wall(rng, (0, 3), (0, 0), 450),
        _wall(rng, (4, 0), (4, 3), 450, gaps=[(1.0, 1.9)]),
        _box(rng, 0.5, 2.5, 1.8, 2.7, 0.75, 250),  # sofa in the first room
    ])
    p[:, :2] += rng.normal(0, 0.02, (len(p), 2))
    return _rotate(p, 0.0), _frames([(1, 1), (3, 1.4), (4, 1.45), (5, 1.5), (6, 2)], 0.0)


def _angle_err(a, b):
    return abs(((a - b) + np.pi / 4) % (np.pi / 2) - np.pi / 4)


def test_single_room_walls_door_and_bed():
    pts, frames = _room()
    out = layout.build({"points": pts.tolist(), "frames": frames})
    assert out["ok"], out
    assert _angle_err(out["yaw"], 0.3) < np.radians(3)
    w, d = sorted(out["size_m"])
    assert abs(w - 3.0) < 0.2 and abs(d - 4.0) < 0.2
    assert len(out["rooms"]) == 1
    ops = [o for wl in out["walls"] for o in wl["openings"]]
    assert len(ops) == 1 and abs((ops[0]["to_m"] - ops[0]["from_m"]) - 0.9) < 0.25
    bed = out["objects"][0]
    assert abs(sorted(bed["size"][:2])[0] - 1.4) < 0.3 and abs(sorted(bed["size"][:2])[1] - 2.0) < 0.3
    assert 0.4 < bed["size"][2] < 0.65


def test_two_rooms_joined_by_a_door():
    pts, frames = _flat()
    out = layout.build({"points": pts.tolist(), "frames": frames})
    assert out["ok"], out
    assert len(out["rooms"]) == 2
    areas = sorted(r["area_m2"] for r in out["rooms"])
    assert abs(areas[0] - 9) < 1.5 and abs(areas[1] - 12) < 1.5
    w, d = sorted(out["size_m"])
    assert abs(w - 3.0) < 0.2 and abs(d - 7.0) < 0.2
    inner = [wl for wl in out["walls"] if wl["openings"]]
    assert len(inner) == 1 and abs(inner[0]["a"][0] - 4) < 0.15  # the door is in the shared wall
    assert any(abs(max(o["size"][:2]) - 2.0) < 0.35 for o in out["objects"])  # the sofa


def test_too_sparse_says_why():
    pts, frames = _room()
    assert not layout.build({"points": pts[:50].tolist()})["ok"]
    assert not layout.build({})["ok"]


def test_partial_room_says_why():
    pts, frames = _room(yaw=0.0)
    corner = pts[(pts[:, 0] < 0.8) & (pts[:, 1] < 0.8)]
    out = layout.build({"points": corner.tolist()}, {"min_points": 50})
    assert not out["ok"] and out["reason"]
