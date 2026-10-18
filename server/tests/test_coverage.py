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


def test_docs_cover_every_setting():
    assert set(coverage.DEFAULTS) <= set(coverage.DOCS)
    for k in coverage.DEFAULTS:
        assert len(coverage.DOCS[k]) == 3


def test_fast_for_2000_frames():
    frames = _room_walk(2000)
    t0 = time.perf_counter()
    coverage.score(frames, 2000, GOOD_IMU, CFG)
    assert time.perf_counter() - t0 < 0.05
