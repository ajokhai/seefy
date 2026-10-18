"""Per-phone lens calibration from a printed grid of AprilTags.

Views accumulate across lens passes in <data>/devices/<id>/lens_views.jsonl,
so adding another pass refines the result instead of starting over. Each solve
drops outlier views and, past max_views, keeps the best-fitting ones.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import cv2
import numpy as np


def board_points(cfg: dict) -> dict[int, np.ndarray]:
    """Tag id -> 4x3 corner positions on the board (TL, TR, BR, BL), in tag-size units."""
    pitch = 1 + cfg["board_gap_ratio"]
    pts = {}
    for i in range(cfg["board_cols"] * cfg["board_rows"]):
        c, r = i % cfg["board_cols"], i // cfg["board_cols"]
        x, y = c * pitch, r * pitch
        pts[cfg["board_first_id"] + i] = np.array(
            [[x, y, 0], [x + 1, y, 0], [x + 1, y + 1, 0], [x, y + 1, 0]], dtype=np.float32
        )
    return pts


class LensStore:
    def __init__(self, directory: Path, cfg):
        self.dir = directory
        self.cfg = cfg

    def _dev(self, device: str) -> Path:
        safe = "".join(ch for ch in device if ch.isalnum() or ch in "-_")[:64] or "unknown"
        d = self.dir / safe
        d.mkdir(parents=True, exist_ok=True)
        return d

    def _views(self, device: str) -> list[dict]:
        p = self._dev(device) / "lens_views.jsonl"
        if not p.exists():
            return []
        return [json.loads(line) for line in p.read_text().splitlines() if line.strip()]

    def add_view(self, device: str, w: int, h: int, dets: dict[int, list[float]]) -> int | None:
        """Store a board view if it shows enough board tags. Returns the view count, or None if rejected."""
        lc = self.cfg["lens"]
        board = board_points(lc)
        dets = {i: c for i, c in dets.items() if i in board}
        if len(dets) < lc["min_tags_per_view"]:
            return None
        with (self._dev(device) / "lens_views.jsonl").open("a") as fh:
            fh.write(json.dumps({"t": time.time(), "w": w, "h": h, "dets": {str(k): v for k, v in dets.items()}}) + "\n")
        return len([v for v in self._views(device) if (v["w"], v["h"]) == (w, h)])

    def get(self, device: str) -> dict | None:
        p = self._dev(device) / "lens.json"
        return json.loads(p.read_text()) if p.exists() else None

    def reset(self, device: str) -> None:
        for name in ("lens_views.jsonl", "lens.json"):
            p = self._dev(device) / name
            if p.exists():
                p.unlink()

    def calibrate(self, device: str) -> dict:
        lc = self.cfg["lens"]
        views = self._views(device)
        if not views:
            return {"ok": False, "error": "no views"}
        w, h = views[-1]["w"], views[-1]["h"]  # calibrate for the most recent resolution
        views = [v for v in views if (v["w"], v["h"]) == (w, h)]
        if len(views) < lc["min_views"]:
            return {"ok": False, "error": f"need {lc['min_views']} views, have {len(views)}", "views": len(views)}

        board = board_points(lc)
        objs, imgs = [], []
        for v in views:
            ids = [int(k) for k in v["dets"]]
            objs.append(np.concatenate([board[i] for i in ids]))
            imgs.append(np.concatenate([np.array(v["dets"][str(i)], dtype=np.float32).reshape(4, 2) for i in ids]))
        flags = cv2.CALIB_FIX_K3 if lc["fix_k3"] else 0

        def run(idx: list[int]):
            rms, K, D, rvecs, tvecs = cv2.calibrateCamera(
                [objs[i] for i in idx], [imgs[i] for i in idx], (w, h), None, None, flags=flags
            )
            errs = []
            for n, i in enumerate(idx):
                proj, _ = cv2.projectPoints(objs[i], rvecs[n], tvecs[n], K, D)
                errs.append(float(np.sqrt(((proj.reshape(-1, 2) - imgs[i]) ** 2).sum(axis=1).mean())))
            return rms, K, D, np.array(errs)

        idx = list(range(len(views)))
        rms, K, D, errs = run(idx)
        keep = [i for i, e in zip(idx, errs) if e <= lc["outlier_view_factor"] * np.median(errs)]
        if len(keep) > lc["max_views"]:
            keep = [i for _, i in sorted(zip(errs[[idx.index(k) for k in keep]], keep))][: lc["max_views"]]
        if len(keep) != len(idx) and len(keep) >= lc["min_views"]:
            idx = keep
            rms, K, D, errs = run(idx)

        result = {
            "ok": True, "w": w, "h": h, "K": K.ravel().tolist(), "D": D.ravel().tolist(),
            "rms_px": round(float(rms), 3), "views_used": len(idx), "views_total": len(views),
            "fov_h_deg": round(float(np.degrees(2 * np.arctan(w / (2 * K[0, 0])))), 1),
            "t": time.time(),
        }
        (self._dev(device) / "lens.json").write_text(json.dumps(result))
        return result
