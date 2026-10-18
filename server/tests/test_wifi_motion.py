import numpy as np

from seefy.wifi import macos, motion


def _series(rng, seconds, rate=5.0, std=0.4, mean=-69.0, t0=0.0):
    """RSSI as macOS reports it: whole dB, a few new values a second."""
    t = t0 + np.arange(0, seconds, 1 / rate) * 1000
    return t, np.round(mean + rng.normal(0, std, t.size))


def test_still_room_is_not_moving():
    rng = np.random.default_rng(0)
    tr = motion.MotionTracker({"baseline_s": 10})
    t, r = _series(rng, 30)
    for ti, ri in zip(t, r):
        tr.add(ti, ri)
    m = tr.motion()
    assert m is not None and not m.moving, m


def test_movement_near_the_link_is_detected():
    rng = np.random.default_rng(1)
    tr = motion.MotionTracker({"baseline_s": 10})
    t, r = _series(rng, 12)
    for ti, ri in zip(t, r):
        tr.add(ti, ri)
    # Someone walks through the path: a few dB of swings for two seconds.
    t2, r2 = _series(rng, 2, std=3.0, t0=t[-1] + 200)
    for ti, ri in zip(t2, r2):
        tr.add(ti, ri)
    m = tr.motion()
    assert m.moving and m.score >= 2, m


def test_flat_baseline_does_not_make_one_tick_look_like_motion():
    tr = motion.MotionTracker({"baseline_s": 5})
    t = np.arange(0, 8, 0.2) * 1000
    r = np.full(t.size, -70.0)
    r[-3] = -69.0  # a single 1 dB tick
    for ti, ri in zip(t, r):
        tr.add(ti, ri)
    assert not tr.motion().moving


def test_slow_drift_is_not_motion():
    rng = np.random.default_rng(3)
    tr = motion.MotionTracker({"baseline_s": 10})
    t, r = _series(rng, 30)
    r = np.round(r + np.clip((t - 12000) / 1000 * 0.4, 0, None))  # router power creeps up 0.4 dB/s after 12 s
    for ti, ri in zip(t, r):
        tr.add(ti, ri)
        m = tr.motion()
        if ti > 14000 and m is not None:
            assert not m.moving, (ti, m)
    raw = motion.MotionTracker({"baseline_s": 10, "detrend": False})
    for ti, ri in zip(t, r):
        raw.add(ti, ri)
    assert raw.motion().window_std_db > tr.motion().window_std_db


def test_explicit_baseline_and_too_few_samples():
    tr = motion.MotionTracker()
    tr.set_baseline([-70, -70, -71, -70, -69])
    assert tr.baseline_std >= motion.DEFAULTS["min_std_db"]
    tr.add(0, -70)
    assert tr.motion() is None


def test_rates():
    t = np.arange(0, 2000, 20.0)  # 50 reads/s
    r = np.repeat([-70, -71, -70, -69, -70], 20)  # changes 4 times over ~2 s
    reads, changes = motion.rates(t, r)
    assert round(reads) == 50
    assert 1.5 < changes < 2.5


def test_parse_helper_lines():
    s = macos.parse('{"rssi":-70,"noise":-89,"tx":195.0,"ch":40,"band":2,"if":"en0"}', 123.0)
    assert (s.t, s.rssi, s.noise, s.tx_mbps, s.channel, s.band, s.tier) == (123.0, -70, -89, 195.0, 40, "5", 0)
    assert macos.parse('{"rssi":0,"noise":0,"tx":0,"ch":0,"band":0}', 1.0) is None  # not associated
    assert macos.parse('{"error":"WiFi is off"}', 1.0) is None
    assert macos.parse("garbage", 1.0) is None


def test_docs_cover_every_setting():
    assert set(motion.DEFAULTS) <= set(motion.DOCS)
