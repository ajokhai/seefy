import time

import numpy as np

from seefy import coverage

CFG = coverage.DEFAULTS


def _frame(pos, yaw, pitch=0.0):
    """A camera at pos looking along yaw (counterclockwise from +x) tilted up by pitch; x right, y down, z forward."""
    f = np.array([np.cos(pitch) * np.cos(yaw), np.cos(pitch) * np.sin(yaw), np.sin(pitch)])
    right = np.cross(f, [0, 0, 1.0])
    right /= np.linalg.norm(right)
    down = np.cross(f, right)
    R = np.column_stack([right, down, f])
    return {"p": [float(pos[0]), float(pos[1]), float(pos[2])], "R": R.reshape(-1).tolist()}


def _room_walk(n=300):
    """Loop around a 4 x 3 m room twice, facing all around, tilting up now and then."""
    t = np.linspace(0, 4 * np.pi, n)
    pos = np.stack([2 + 1.4 * np.cos(t), 1.5 + 0.9 * np.sin(t), np.full(n, 1.35)], -1)
    yaw = 1.3 * t + 0.4 * np.sin(3 * t)
    pitch = np.where(np.sin(2.5 * t) > 0.8, np.radians(35), 0.0)
    return [_frame(p, y, pt) for p, y, pt in zip(pos, yaw, pitch)]


GOOD_IMU = {"ok": True, "correlation": 0.92, "samples": 3000}


def test_full_room_walk_is_enough_or_extra():
    frames = _room_walk()
    r = coverage.score(frames, len(frames), GOOD_IMU, CFG)
    assert r["level"] in ("enough", "extra"), r
    assert r["score"] >= CFG["enough"]
    assert r["components"]["headings"]["detail"] == "12 of 12 directions"


def test_full_walk_with_good_imu_is_extra():
    frames = _room_walk()
    r = coverage.score(frames, len(frames), GOOD_IMU, CFG)
    assert r["level"] == "extra", r
    assert r["score"] == 1.0
    assert "plenty" in r["hint"]


def test_without_imu_is_enough_but_not_extra():
    frames = _room_walk()
    r = coverage.score(frames, len(frames), None, CFG)
    assert r["level"] == "enough", r
    assert CFG["enough"] <= r["score"] < 1.0
    assert "motion sensor" in r["hint"]


def test_turning_on_the_spot_is_short_and_asks_to_walk():
    yaw = np.linspace(0, 2 * np.pi, 200)
    frames = [_frame((2, 1.5, 1.35), y) for y in yaw]
    r = coverage.score(frames, len(frames), GOOD_IMU, CFG)
    assert r["level"] == "short"
    assert r["score"] < CFG["enough"]
    assert "Walk" in r["hint"], r["hint"]


def test_half_the_room_is_short_and_asks_to_turn():
    n = 200
    x = np.linspace(0.5, 3.5, n)
    yaw = np.linspace(0, np.pi * 0.95, n)  # only ever faces one half of the room
    frames = [_frame((xi, 1.0 + 0.4 * np.sin(xi), 1.35), y) for xi, y in zip(x, yaw)]
    r = coverage.score(frames, n, GOOD_IMU, CFG)
    assert r["level"] == "short"
    assert r["components"]["headings"]["value"] < CFG["headings_min"]
    assert "Turn" in r["hint"], r["hint"]


def test_unseen_half_behind_the_phone_says_behind_you():
    n = 200
    x = np.linspace(0.5, 3.5, n)
    yaw = np.pi / 2 + 0.8 * np.sin(np.linspace(0, 2 * np.pi, n))  # sweeps around +y and ends facing it
    frames = [_frame((xi, 1.5, 1.35), y) for xi, y in zip(x, yaw)]
    r = coverage.score(frames, n, GOOD_IMU, CFG)
    assert r["level"] == "short"
    assert "behind you" in r["hint"], r["hint"]


def test_low_registration_is_short_and_asks_to_slow_down():
    frames = _room_walk()
    r = coverage.score(frames, 3 * len(frames), GOOD_IMU, CFG)
    assert r["level"] == "short"
    assert r["components"]["registered"]["detail"] == "33% of frames placed"
    assert "Slow down" in r["hint"], r["hint"]


def test_nothing_placed_yet():
    r = coverage.score([], 0, None, CFG)
    assert r["level"] == "short" and r["score"] == 0.0
    r = coverage.score([], 40, None, CFG)
    assert "Slow down" in r["hint"]


def test_score_is_monotone_in_progress():
    frames = _room_walk()
    scores = [coverage.score(frames[:k], k, GOOD_IMU, CFG)["score"] for k in (20, 80, 160, 300)]
    assert scores == sorted(scores), scores


def _wall_points(rng, n=3000):
    """Points on the walls of a 4 x 3 x 2.5 m room."""
    side = rng.integers(0, 4, n)
    u, h = rng.random(n), rng.random(n) * 2.5
    x = np.where(side == 0, 0, np.where(side == 1, 4, u * 4))
    y = np.where(side == 2, 0, np.where(side == 3, 3, u * 3))
    return np.stack([x, y, h], -1).tolist()


def test_close_walk_with_points_has_good_detail():
    frames = _room_walk()
    r = coverage.score(frames, len(frames), GOOD_IMU, CFG, points=_wall_points(np.random.default_rng(1)))
    assert r["components"]["detail"]["value"] > CFG["detail_extra"], r["components"]["detail"]
    assert r["level"] == "extra"


def test_far_away_scan_asks_to_move_closer():
    big = {**CFG}
    rng = np.random.default_rng(2)
    pts = (np.array(_wall_points(rng)) * [4, 4, 1]).tolist()  # same walk, walls four times further away
    frames = _room_walk()
    r = coverage.score(frames, len(frames), GOOD_IMU, big, points=pts)
    assert r["components"]["detail"]["value"] < CFG["detail_min"]
    assert r["level"] == "short"
    assert "closer" in r["hint"], r["hints"]


def test_turning_too_fast_comes_first_but_doesnt_change_the_level():
    frames = _room_walk()
    calm = coverage.score(frames, len(frames), GOOD_IMU, CFG, turn_dps=10)
    fast = coverage.score(frames, len(frames), GOOD_IMU, CFG, turn_dps=60)
    assert calm["level"] == fast["level"] == "extra"
    assert "slower" not in calm["hint"]
    assert fast["hint"].startswith("Turn slower"), fast["hints"]
    assert fast["components"]["pace"]["detail"] == "60°/s, limit 25°/s"


def test_hints_are_ranked_weakest_first():
    yaw = np.linspace(0, np.pi, 150)
    frames = [_frame((2, 1.5, 1.35), y) for y in yaw]  # turning on the spot, half the room
    r = coverage.score(frames, 300, None, CFG)
    assert r["level"] == "short"
    assert len(r["hints"]) >= 2 and r["hint"] == r["hints"][0]


def test_docs_cover_every_setting():
    assert set(coverage.DEFAULTS) <= set(coverage.DOCS)
    for k in coverage.DEFAULTS:
        assert len(coverage.DOCS[k]) == 3


def test_fast_for_2000_frames():
    frames = _room_walk(2000)
    t0 = time.perf_counter()
    coverage.score(frames, 2000, GOOD_IMU, CFG)
    assert time.perf_counter() - t0 < 0.05
