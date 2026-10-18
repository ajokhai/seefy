import numpy as np

from seefy import layout


def _room(yaw=0.3, w=4.0, d=3.0, door=(1.0, 1.9), seed=0):
    """Points on the edges a scan picks up: wall bands (with a door gap in the first wall) and a bed."""
    rng = np.random.default_rng(seed)
    pts = []
    for (ax, ay), (bx, by) in [((0, 0), (w, 0)), ((w, 0), (w, d)), ((w, d), (0, d)), ((0, d), (0, 0))]:
        t = rng.uniform(0, 1, 500)
        x, y = ax + (bx - ax) * t, ay + (by - ay) * t
        keep = ~((ay == 0) & (by == 0) & (x > door[0]) & (x < door[1]))
        pts.append(np.c_[x[keep], y[keep], rng.uniform(0, 2.4, keep.sum())])
    bed = np.c_[rng.uniform(2.2, 3.6, 300), rng.uniform(0.4, 2.4, 300), rng.uniform(0.0, 0.55, 300)]
    pts.append(bed)
    p = np.concatenate(pts)
    p[:, :2] += rng.normal(0, 0.02, (len(p), 2))
    c, s = np.cos(yaw), np.sin(yaw)
    p[:, :2] = p[:, :2] @ np.array([[c, -s], [s, c]]).T
    return p


def test_finds_walls_door_and_bed():
    out = layout.build({"points": _room().tolist()})
    assert out["ok"]
    assert abs(((out["yaw"] - 0.3) + np.pi / 4) % (np.pi / 2) - np.pi / 4) < np.radians(3)
    assert abs(sorted(out["size_m"])[0] - 3.0) < 0.15 and abs(sorted(out["size_m"])[1] - 4.0) < 0.15
    ops = [o for w in out["walls"] for o in w["openings"]]
    assert len(ops) == 1 and abs((ops[0]["to_m"] - ops[0]["from_m"]) - 0.9) < 0.25
    bed = out["objects"][0]
    assert abs(sorted(bed["size"][:2])[0] - 1.4) < 0.3 and abs(sorted(bed["size"][:2])[1] - 2.0) < 0.3
    assert 0.4 < bed["size"][2] < 0.65
    assert out["confidence"] == "good"


def test_too_sparse_returns_none():
    assert not layout.build({"points": _room()[:50].tolist()})["ok"]
    assert not layout.build({})["ok"]


def test_partial_room_says_why():
    corner = _room()
    corner = corner[(corner[:, 0] < 0.8) & (corner[:, 1] < 0.8)]
    out = layout.build({"points": corner.tolist()}, {"min_points": 50})
    assert not out["ok"] and "Walk along every wall" in out["reason"]
