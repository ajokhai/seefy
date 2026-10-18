"""World map of printed room tags, built from phone camera frames.

Each frame that sees two or more tags links them. Frames accumulate across
mapping passes in observations.jsonl, so every extra pass adds evidence and the
solve gets more precise; nothing is thrown away unless the map is reset.

The origin tag lies flat on the floor and defines the world frame: x and y
along the floor, z up, origin at the tag centre.

Solve: chain single-tag poses outward from the origin for a first guess, then
refine every tag and camera pose together by minimising corner reprojection
error (bundle adjustment) with a robust loss.
"""

from __future__ import annotations

import json
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np
from scipy.optimize import least_squares
from scipy.sparse import lil_matrix

from . import geometry as g


@dataclass
class Frame:
    t: float
    device: str
    pass_id: str
    K: np.ndarray  # 3x3, for undistorted pixels
    dets: dict[int, np.ndarray]  # tag id -> 4x2 undistorted corners

    def to_json(self) -> dict:
        return {
            "t": self.t, "device": self.device, "pass": self.pass_id, "K": self.K.ravel().tolist(),
            "dets": {str(k): v.ravel().tolist() for k, v in self.dets.items()},
        }

    @staticmethod
    def from_json(d: dict) -> Frame:
        return Frame(
            d["t"], d["device"], d.get("pass", ""), np.array(d["K"], dtype=np.float64).reshape(3, 3),
            {int(k): np.array(v, dtype=np.float64).reshape(4, 2) for k, v in d["dets"].items()},
        )


@dataclass
class Solution:
    tags: dict[int, np.ndarray] = field(default_factory=dict)  # id -> T_world_tag
    tag_rms_px: dict[int, float] = field(default_factory=dict)
    tag_obs: dict[int, int] = field(default_factory=dict)
    rms_px: float = float("nan")
    frames_used: int = 0
    solve_ms: float = 0.0


def undistort(corners: np.ndarray, K: np.ndarray, D: np.ndarray | None) -> np.ndarray:
    if D is None or not np.any(D):
        return corners
    return cv2.undistortPoints(corners.reshape(-1, 1, 2), K, D, P=K).reshape(-1, 2)


def _subsample(frames: list[Frame], n: int) -> list[Frame]:
    if len(frames) <= n:
        return frames
    idx = np.linspace(0, len(frames) - 1, n).round().astype(int)
    return [frames[i] for i in idx]


def _reproj_px(K: np.ndarray, T_cw: np.ndarray, T_wt: np.ndarray, local: np.ndarray, uv: np.ndarray) -> float:
    pc = g.transform(T_cw @ T_wt, local)
    if np.any(pc[:, 2] <= 1e-3):
        return float("inf")
    return float(np.sqrt(((g.project(K, T_cw, g.transform(T_wt, local)) - uv) ** 2).sum(axis=1).mean()))


def _pose_frame(f: Frame, cands: dict[int, list[np.ndarray]], world_tag: dict[int, np.ndarray],
                local: dict[int, np.ndarray]) -> tuple[np.ndarray | None, float]:
    """Best T_cam_world for a frame from the tags already in the map, with its reprojection error."""
    known = [i for i in f.dets if i in world_tag and cands[i]]
    if not known:
        return None, float("inf")

    def score(T_cw: np.ndarray) -> float:
        return float(np.mean([_reproj_px(f.K, T_cw, world_tag[i], local[i], f.dets[i]) for i in known]))

    options = [c @ g.inv(world_tag[i]) for i in known for c in cands[i]]
    best = min(options, key=score)
    if len(known) >= 2:
        obj = np.concatenate([g.transform(world_tag[i], local[i]) for i in known])
        img = np.concatenate([f.dets[i] for i in known])
        rvec, tvec = g.from_T(best)
        ok, rvec, tvec = cv2.solvePnP(obj, img, f.K, None, rvec.copy(), tvec.copy(), True, cv2.SOLVEPNP_ITERATIVE)
        if ok and score(g.to_T(rvec, tvec)) <= score(best):
            best = g.to_T(rvec, tvec)
    return best, score(best)


def _initial_guess(frames: list[Frame], local: dict[int, np.ndarray], origin: int, min_obs: int,
                   obs_count: dict[int, int], gate_px: float = 8.0) -> tuple[dict[int, np.ndarray], dict[int, np.ndarray]]:
    """Grow the map outward from the origin.

    Each new tag gets the candidate pose (from every frame, both IPPE solutions)
    that best explains all posed frames seeing it, which rejects flipped poses.
    """
    cands = [{i: g.tag_pose_candidates(c, f.K, local[i]) for i, c in f.dets.items()} for f in frames]
    world_tag: dict[int, np.ndarray] = {origin: np.eye(4)}
    while True:
        cam_world: dict[int, np.ndarray] = {}
        for fi, f in enumerate(frames):
            T, err = _pose_frame(f, cands[fi], world_tag, local)
            if T is not None and err < gate_px:
                cam_world[fi] = T
        added = False
        for u in sorted(obs_count):
            if u in world_tag or obs_count[u] < min_obs:
                continue
            seen = [fi for fi in cam_world if u in frames[fi].dets]
            if not seen:
                continue
            options = [g.inv(cam_world[fi]) @ c for fi in seen for c in cands[fi][u]]
            if len(options) > 60:
                options = [options[k] for k in np.linspace(0, len(options) - 1, 60).round().astype(int)]
            check = seen if len(seen) <= 60 else [seen[k] for k in np.linspace(0, len(seen) - 1, 60).round().astype(int)]

            def score(T_wt: np.ndarray) -> float:
                return float(np.median([_reproj_px(frames[fi].K, cam_world[fi], T_wt, local[u], frames[fi].dets[u])
                                        for fi in check]))

            world_tag[u] = min(options, key=score)
            added = True
        if not added:
            return world_tag, cam_world


def solve(frames: list[Frame], size: float, origin: int, huber_px: float, min_obs: int, max_frames: int,
          origin_size: float | None = None) -> Solution:
    """Solve tag world poses. Room tags are `size` metres; the origin tag may be larger (`origin_size`)."""
    t0 = time.perf_counter()
    frames = _subsample(frames, max_frames)
    obs_count: dict[int, int] = {}
    for f in frames:
        for i in f.dets:
            obs_count[i] = obs_count.get(i, 0) + 1
    if obs_count.get(origin, 0) == 0:
        return Solution(tag_obs=obs_count)

    local = {i: g.tag_corners(origin_size if (i == origin and origin_size) else size) for i in obs_count}
    world_tag, cam_world = _initial_guess(frames, local, origin, min_obs, obs_count)
    tag_ids = [i for i in world_tag if i != origin]
    frame_ids = sorted(cam_world)
    if not frame_ids:
        return Solution(tags={origin: np.eye(4)}, tag_obs=obs_count)

    # Bundle adjustment over all tag poses (origin fixed) and camera poses.
    nt, nf = len(tag_ids), len(frame_ids)
    tidx = {i: n for n, i in enumerate(tag_ids)}
    tidx[origin] = nt  # fixed identity slot
    fidx = {fi: n for n, fi in enumerate(frame_ids)}
    obs = [(fi, i) for fi in frame_ids for i in frames[fi].dets if i in world_tag]
    obs_f = np.array([fidx[fi] for fi, _ in obs])
    obs_t = np.array([tidx[i] for _, i in obs])
    uv = np.stack([frames[fi].dets[i] for fi, i in obs])
    Ks = np.stack([frames[fi].K for fi, _ in obs])
    fx, fy, cx, cy = Ks[:, 0, 0, None], Ks[:, 1, 1, None], Ks[:, 0, 2, None], Ks[:, 1, 2, None]
    local_t = np.stack([local[i] for i in tag_ids] + [local[origin]])

    x0 = np.concatenate(
        [np.concatenate(g.from_T(world_tag[i])) for i in tag_ids]
        + [np.concatenate(g.from_T(cam_world[fi])) for fi in frame_ids]
    )

    def residuals(x: np.ndarray) -> np.ndarray:
        pt = x[:6 * nt].reshape(nt, 6)
        pf = x[6 * nt:].reshape(nf, 6)
        Rt = np.concatenate([g.rodrigues_batch(pt[:, :3]), np.eye(3)[None]])
        tt = np.concatenate([pt[:, 3:], np.zeros((1, 3))])
        Rf, tf = g.rodrigues_batch(pf[:, :3]), pf[:, 3:]
        pw = np.einsum("nij,nkj->nki", Rt[obs_t], local_t[obs_t]) + tt[obs_t][:, None, :]
        pc = np.einsum("nij,nkj->nki", Rf[obs_f], pw) + tf[obs_f][:, None, :]
        z = np.maximum(pc[..., 2], 1e-6)
        proj = np.stack([fx * pc[..., 0] / z + cx, fy * pc[..., 1] / z + cy], axis=-1)
        return (proj - uv).ravel()

    sparsity = lil_matrix((8 * len(obs), x0.size), dtype=np.int8)
    for k, (fi, i) in enumerate(obs):
        n = 6 * (nt + fidx[fi])
        sparsity[8 * k:8 * k + 8, n:n + 6] = 1
        if i != origin:
            m = 6 * tidx[i]
            sparsity[8 * k:8 * k + 8, m:m + 6] = 1

    res = least_squares(residuals, x0, jac_sparsity=sparsity, loss="huber", f_scale=huber_px,
                        x_scale="jac", method="trf", max_nfev=1000)
    per_obs = np.sqrt((res.fun.reshape(-1, 4, 2) ** 2).sum(axis=2).mean(axis=1))

    sol = Solution(tag_obs=obs_count, frames_used=nf)
    sol.tags[origin] = np.eye(4)
    for i in tag_ids:
        n = 6 * tidx[i]
        sol.tags[i] = g.to_T(res.x[n:n + 3], res.x[n + 3:n + 6])
    for i in sol.tags:
        e = per_obs[obs_t == tidx[i]]
        sol.tag_rms_px[i] = float(np.sqrt(np.mean(e ** 2))) if len(e) else float("nan")
    sol.rms_px = float(np.sqrt(np.mean(per_obs ** 2))) if len(per_obs) else float("nan")
    sol.solve_ms = (time.perf_counter() - t0) * 1000
    return sol


class TagMap:
    """Accumulating tag observations plus the latest solution, persisted under <data>/tagmap/."""

    def __init__(self, directory: Path, cfg):
        self.dir = directory
        self.cfg = cfg
        self.frames: list[Frame] = []
        self.solution = Solution()
        self.version = 0
        self.passes: set[str] = set()
        self._lock = threading.Lock()
        self._last_frame_t: dict[str, float] = {}
        self.dir.mkdir(parents=True, exist_ok=True)
        obs_path = self.dir / "observations.jsonl"
        if obs_path.exists():
            for line in obs_path.read_text().splitlines():
                if line.strip():
                    f = Frame.from_json(json.loads(line))
                    self.frames.append(f)
                    self.passes.add(f.pass_id)
        sol_path = self.dir / "map.json"
        if sol_path.exists():
            self._load_solution(json.loads(sol_path.read_text()))

    # -- input --------------------------------------------------------------

    def add_frame(self, t: float, device: str, pass_id: str, K: np.ndarray, D: np.ndarray | None,
                  dets: dict[int, np.ndarray]) -> bool:
        """Store a frame if it links enough room tags and enough time has passed. Returns True if kept."""
        m = self.cfg["mapping"]
        tr = self.cfg["tracking"]
        dets = {i: c for i, c in dets.items() if 0 <= i <= tr["room_tag_max_id"]}
        if len(dets) < m["min_tags_per_frame"]:
            return False
        if t - self._last_frame_t.get(device, -1e12) < m["keyframe_interval_s"] * 1000:
            return False
        self._last_frame_t[device] = t
        frame = Frame(t, device, pass_id, K, {i: undistort(c, K, D) for i, c in dets.items()})
        with self._lock:
            self.frames.append(frame)
            self.passes.add(pass_id)
        with (self.dir / "observations.jsonl").open("a") as fh:
            fh.write(json.dumps(frame.to_json()) + "\n")
        return True

    def reset(self) -> None:
        with self._lock:
            self.frames.clear()
            self.passes.clear()
            self.solution = Solution()
            self.version += 1
        for name in ("observations.jsonl", "map.json"):
            p = self.dir / name
            if p.exists():
                p.unlink()

    # -- solve --------------------------------------------------------------

    def solve(self) -> Solution:
        with self._lock:
            frames = list(self.frames)
        m, tr = self.cfg["mapping"], self.cfg["tracking"]
        sol = solve(frames, tr["tag_size_m"], tr["origin_tag_id"], m["huber_px"], m["min_obs_per_tag"],
                    m["max_frames"], tr["origin_tag_size_m"])
        with self._lock:
            self.solution = sol
            self.version += 1
        (self.dir / "map.json").write_text(json.dumps(self.to_json()))
        return sol

    # -- output -------------------------------------------------------------

    def to_json(self) -> dict:
        s = self.solution
        tr = self.cfg["tracking"]
        size, origin = tr["tag_size_m"], tr["origin_tag_id"]

        def corners(i: int) -> np.ndarray:
            return g.tag_corners(tr["origin_tag_size_m"] if i == origin else size)

        def num(v: float):
            return None if np.isnan(v) else round(v, 3)

        return {
            "version": self.version,
            "origin": origin,
            "tag_size_m": size,
            "origin_tag_size_m": tr["origin_tag_size_m"],
            "frames": len(self.frames),
            "frames_used": s.frames_used,
            "passes": len(self.passes),
            "rms_px": num(s.rms_px),
            "solve_ms": round(s.solve_ms, 1),
            "observed": {str(k): v for k, v in sorted(s.tag_obs.items())},
            "tags": {
                str(i): {
                    "T": T.ravel().tolist(),
                    "corners": g.transform(T, corners(i)).ravel().tolist(),
                    "size": tr["origin_tag_size_m"] if i == origin else size,
                    "rms_px": num(s.tag_rms_px.get(i, float("nan"))),
                    "obs": s.tag_obs.get(i, 0),
                }
                for i, T in sorted(s.tags.items())
            },
        }

    def _load_solution(self, d: dict) -> None:
        s = Solution()
        for k, v in d.get("tags", {}).items():
            s.tags[int(k)] = np.array(v["T"], dtype=np.float64).reshape(4, 4)
            s.tag_rms_px[int(k)] = v["rms_px"] if v.get("rms_px") is not None else float("nan")
        s.tag_obs = {int(k): v for k, v in d.get("observed", {}).items()}
        s.rms_px = d["rms_px"] if d.get("rms_px") is not None else float("nan")
        s.frames_used = d.get("frames_used", 0)
        self.solution = s
        self.version = d.get("version", 0)
