"""Metric scale from the phone's accelerometer (visual-inertial scale).

Structure-from-motion recovers the camera path only up to an unknown scale. The
accelerometer measures real acceleration in m/s². Differentiate the (smoothed)
camera path twice, rotate the phone's acceleration into the same frame, and the
single factor that makes them agree is the scale. Comparing accelerations,
rather than integrating the accelerometer into distances, avoids drift.
"""

from __future__ import annotations

import bisect
from dataclasses import dataclass

import numpy as np
from scipy.interpolate import make_smoothing_spline


@dataclass
class ImuScale:
    ok: bool
    scale: float = float("nan")  # metres per reconstruction unit
    correlation: float = 0.0
    samples: int = 0
    lag_ms: float = 0.0
    reason: str = ""


def _device_to_camera(a: np.ndarray) -> np.ndarray:
    """Phone held in portrait: device x right, y up, z out of the screen -> rear camera x right, y down, z forward."""
    return np.array([a[0], -a[1], -a[2]])


def estimate(frame_t: np.ndarray, centres: np.ndarray, R_world_cam: np.ndarray,
             motion_t: np.ndarray, motion_a: np.ndarray, *, window_ms: float = 120.0,
             min_samples: int = 20, min_correlation: float = 0.5, max_lag_ms: float = 200.0) -> ImuScale:
    """Fit metres-per-unit from frame times (ms), camera centres (N,3), rotations (N,3,3) and
    device-frame accelerations without gravity (M,3) at motion_t (ms)."""
    order = np.argsort(frame_t)
    t, c, R = frame_t[order] / 1000.0, centres[order], R_world_cam[order]
    keep = np.concatenate([[True], np.diff(t) > 1e-3])  # spline needs strictly increasing times
    t, c, R = t[keep], c[keep], R[keep]
    if len(t) < min_samples or len(motion_t) < min_samples:
        return ImuScale(False, reason="not enough frames or motion samples")

    # Visual acceleration: smoothing spline per axis, second derivative at frame times.
    a_vis = np.stack([make_smoothing_spline(t, c[:, k]).derivative(2)(t) for k in range(3)], axis=1)

    mt = motion_t / 1000.0
    best: ImuScale | None = None
    for lag in np.arange(-max_lag_ms, max_lag_ms + 1, 20.0) / 1000.0:
        a_imu = []
        rows = []
        for i, ti in enumerate(t):
            lo = bisect.bisect_left(mt, ti + lag - window_ms / 2000)
            hi = bisect.bisect_right(mt, ti + lag + window_ms / 2000)
            if hi - lo < 2:
                continue
            a_dev = motion_a[lo:hi].mean(axis=0)
            a_imu.append(R[i] @ _device_to_camera(a_dev))
            rows.append(i)
        if len(rows) < min_samples:
            continue
        a_imu = np.array(a_imu)
        av = a_vis[rows]
        # Same smoothing on both sides: the spline already low-passes the visual path,
        # so low-pass the accelerometer with a matching spline before comparing.
        tr = t[rows]
        a_imu = np.stack([make_smoothing_spline(tr, a_imu[:, k])(tr) for k in range(3)], axis=1)
        x, y = av.ravel(), a_imu.ravel()
        if np.dot(x, x) < 1e-12:
            continue
        s = float(np.dot(x, y) / np.dot(x, x))
        # Sign conventions for browser acceleration differ; a consistent flip still gives the scale.
        corr = float(np.corrcoef(x, y)[0, 1])
        cand = ImuScale(True, abs(s), abs(corr), len(rows), float(lag * 1000))
        if best is None or cand.correlation > best.correlation:
            best = cand
    if best is None:
        return ImuScale(False, reason="motion samples don't overlap the frames")
    if best.correlation < min_correlation:
        return ImuScale(False, best.scale, best.correlation, best.samples, best.lag_ms,
                        reason=f"camera and accelerometer disagree (correlation {best.correlation:.2f})")
    return best
