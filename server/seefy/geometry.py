"""Rigid-transform helpers. Poses are 4x4 matrices; T_a_b maps points from frame b to frame a."""

from __future__ import annotations

import cv2
import numpy as np


def tag_corners(size: float) -> np.ndarray:
    """Corners of a square tag in its own frame, in OpenCV ArUco order (TL, TR, BR, BL).

    Tag frame: x right, y up, z out of the printed face.
    """
    h = size / 2
    return np.array([[-h, h, 0], [h, h, 0], [h, -h, 0], [-h, -h, 0]], dtype=np.float64)


def to_T(rvec: np.ndarray, tvec: np.ndarray) -> np.ndarray:
    T = np.eye(4)
    T[:3, :3] = cv2.Rodrigues(np.asarray(rvec, dtype=np.float64).reshape(3))[0]
    T[:3, 3] = np.asarray(tvec, dtype=np.float64).reshape(3)
    return T


def from_T(T: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    return cv2.Rodrigues(T[:3, :3])[0].reshape(3), T[:3, 3].copy()


def inv(T: np.ndarray) -> np.ndarray:
    R, t = T[:3, :3], T[:3, 3]
    out = np.eye(4)
    out[:3, :3] = R.T
    out[:3, 3] = -R.T @ t
    return out


def transform(T: np.ndarray, pts: np.ndarray) -> np.ndarray:
    return pts @ T[:3, :3].T + T[:3, 3]


def tag_pose_candidates(corners_px: np.ndarray, K: np.ndarray, local: np.ndarray) -> list[np.ndarray]:
    """Both T_cam_tag solutions for one tag's undistorted corners (local = tag_corners(size)), best first.

    A small or distant square has two orientations that fit almost equally well,
    so callers should pick between them using other evidence.
    """
    n, rvecs, tvecs, _ = cv2.solvePnPGeneric(
        local, corners_px.reshape(4, 1, 2).astype(np.float64), K, None,
        flags=cv2.SOLVEPNP_IPPE_SQUARE,
    )
    return [to_T(rvecs[i], tvecs[i]) for i in range(n)]


def rodrigues_batch(r: np.ndarray) -> np.ndarray:
    """(N, 3) rotation vectors -> (N, 3, 3) rotation matrices."""
    theta = np.linalg.norm(r, axis=1)[:, None, None]
    small = theta[:, 0, 0] < 1e-12
    k = np.where(small[:, None], 0.0, r / np.where(small, 1.0, theta[:, 0, 0])[:, None])
    Kx = np.zeros((len(r), 3, 3))
    Kx[:, 0, 1], Kx[:, 0, 2] = -k[:, 2], k[:, 1]
    Kx[:, 1, 0], Kx[:, 1, 2] = k[:, 2], -k[:, 0]
    Kx[:, 2, 0], Kx[:, 2, 1] = -k[:, 1], k[:, 0]
    return np.eye(3) + np.sin(theta) * Kx + (1 - np.cos(theta)) * (Kx @ Kx)


def project(K: np.ndarray, T_cam_world: np.ndarray, pts_world: np.ndarray) -> np.ndarray:
    pc = transform(T_cam_world, pts_world)
    uv = pc[:, :2] / pc[:, 2:3]
    return uv @ K[:2, :2].T + K[:2, 2]


def body_from_phone(p: np.ndarray, R_world_cam: np.ndarray, offset_m: float) -> tuple[np.ndarray, float]:
    """Floor position (x, y) of the torso behind a chest-height phone, and heading in radians."""
    fwd = R_world_cam[:, 2]  # camera looks along its +z
    f = fwd[:2]
    n = float(np.linalg.norm(f))
    if n < 1e-6:  # pointing straight up or down: no usable heading
        return p[:2].copy(), float("nan")
    f = f / n
    return p[:2] - offset_m * f, float(np.arctan2(f[1], f[0]))
