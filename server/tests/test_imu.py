import numpy as np

from seefy import imu


def _rot_z(a):
    c, s = np.cos(a), np.sin(a)
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])


def _walk(rng, true_scale=0.37, noise_a=0.15, noise_px=0.003):
    """A wandering walk: metres in the world, reconstruction units = metres / true_scale."""
    T = 40.0
    mt = np.arange(0, T, 1 / 60)  # accelerometer at 60 Hz
    ft = np.arange(0, T, 1 / 5)  # frames at 5 fps

    def pos(t):
        return np.stack([1.5 * np.sin(0.4 * t) + 0.3 * np.sin(1.3 * t), 1.0 * np.cos(0.3 * t), 1.35 + 0.03 * np.sin(2 * t)], -1)

    def acc(t):
        return np.stack([-1.5 * 0.16 * np.sin(0.4 * t) - 0.3 * 1.69 * np.sin(1.3 * t), -0.09 * np.cos(0.3 * t),
                         -0.03 * 4 * np.sin(2 * t)], -1)

    # Camera looks horizontally, turning slowly; R_world_cam for a camera with y down, z forward.
    base = np.column_stack([[0, -1, 0], [0, 0, -1], [1, 0, 0]])  # camera x, y, z axes in world
    rot = lambda t: _rot_z(0.2 * t) @ base  # noqa: E731

    centres = pos(ft) / true_scale + rng.normal(0, noise_px, (len(ft), 3))
    R = np.stack([rot(t) for t in ft])
    # Device-frame acceleration: world -> camera -> device (inverse of x, -y, -z).
    a_dev = []
    for t in mt:
        a_cam = rot(t).T @ acc(t)
        a_dev.append([a_cam[0], -a_cam[1], -a_cam[2]])
    a_dev = np.array(a_dev) + rng.normal(0, noise_a, (len(mt), 3))
    return ft * 1000, centres, R, mt * 1000, a_dev


def test_recovers_scale_within_5_percent():
    rng = np.random.default_rng(0)
    ft, c, R, mt, a = _walk(rng)
    r = imu.estimate(ft, c, R, mt, a)
    assert r.ok, r.reason
    assert abs(r.scale - 0.37) / 0.37 < 0.05
    assert r.correlation > 0.8


def test_finds_clock_offset():
    rng = np.random.default_rng(1)
    ft, c, R, mt, a = _walk(rng)
    r = imu.estimate(ft, c, R, mt + 100, a)  # accelerometer clock runs 100 ms late
    assert r.ok and abs(r.lag_ms - 100) <= 40


def test_rejects_unrelated_motion():
    rng = np.random.default_rng(2)
    ft, c, R, mt, _ = _walk(rng)
    r = imu.estimate(ft, c, R, mt, rng.normal(0, 0.5, (len(mt), 3)))
    assert not r.ok
