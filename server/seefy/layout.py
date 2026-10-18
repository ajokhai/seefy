"""Room structure from a scan: floor outline, walls with openings, and furniture boxes.

Input is the scan result: sparse map points and camera poses, in the room frame (z up,
metres, floor at z = 0). Structure-from-motion only places points on texture, so plain
wall paint gives little, but the edges that matter do: corners, skirting, door frames,
furniture. Walking along the walls during the scan gives enough of them.

Rooms are assumed rectangular-ish (walls meet at right angles), the usual case indoors:
  1. wall direction: the dominant direction of line-like point neighbourhoods, modulo 90°
  2. walls: in that rotated frame, the outermost dense bands of points on each side
  3. openings: stretches of a wall with no points from the floor to door height
  4. objects: clusters of points inside the room, off the walls, as boxes on the floor
Each part carries a support score, so the UI can show weak walls as dashed.
"""

from __future__ import annotations

import numpy as np
from scipy import ndimage
from scipy.spatial import cKDTree

DEFAULTS: dict = {
    "min_points": 200,  # below this the scan is too sparse to say anything
    "band_z": [0.15, 2.2],  # heights used to find walls (above the floor, below most ceilings)
    "neighbours": 12,  # points per neighbourhood when measuring local direction
    "wall_bin_m": 0.05,  # histogram step across a wall
    "wall_search_m": 0.6,  # look this far inside the outermost points for a wall's band
    "wall_thickness_m": 0.12,  # points this close to a wall line belong to it
    "gap_bin_m": 0.1,  # step along a wall when looking for openings
    "opening_min_m": 0.7,  # narrowest gap reported as an opening (a door is ~0.8 m)
    "object_cell_m": 0.12,  # floor grid for grouping object points
    "object_min_points": 25,  # smaller clusters are noise
    "object_margin_m": 0.2,  # ignore points this close to a wall when finding objects
}


def _dominant_angle(xy: np.ndarray, k: int) -> float:
    """Direction of walls, modulo 90°, from the principal axis of each point's neighbourhood."""
    tree = cKDTree(xy)
    _, idx = tree.query(xy, k=min(k, len(xy)))
    nb = xy[idx] - xy[idx].mean(1, keepdims=True)
    cov = np.einsum("nki,nkj->nij", nb, nb)
    w, v = np.linalg.eigh(cov)
    linear = 1 - w[:, 0] / np.maximum(w[:, 1], 1e-12)  # 1 = a clean line, 0 = a blob
    ang = np.arctan2(v[:, 1, 1], v[:, 0, 1]) % (np.pi / 2)
    hist, edges = np.histogram(ang, bins=90, range=(0, np.pi / 2), weights=linear**2)
    hist = ndimage.uniform_filter1d(hist, 5, mode="wrap")
    coarse = float(edges[np.argmax(hist)] + (edges[1] - edges[0]) / 2)
    # Refine: walls seen square-on pile their points into the fewest histogram bins.
    best, score = coarse, -1.0
    for a in coarse + np.radians(np.arange(-6, 6.25, 0.25)):
        c, s = np.cos(a), np.sin(a)
        u, v = xy @ np.array([c, s]), xy @ np.array([-s, c])
        sharp = sum((np.histogram(x, bins=np.arange(x.min(), x.max() + 0.05, 0.05))[0] ** 2).sum() for x in (u, v))
        if sharp > score:
            best, score = float(a), sharp
    return best % (np.pi / 2)


def _wall_position(v: np.ndarray, outer: float, inward: float, cfg: dict) -> tuple[float, float]:
    """Densest band within wall_search_m inside the outermost points on one side. Returns (position, share)."""
    lo, hi = sorted((outer, outer + inward * cfg["wall_search_m"]))
    sel = v[(v >= lo - cfg["wall_bin_m"]) & (v <= hi + cfg["wall_bin_m"])]
    if len(sel) < 5:
        return outer, 0.0
    bins = np.arange(lo - cfg["wall_bin_m"], hi + 2 * cfg["wall_bin_m"], cfg["wall_bin_m"])
    h, e = np.histogram(sel, bins=bins)
    h = ndimage.uniform_filter1d(h.astype(float), 2)
    i = int(np.argmax(h))
    return float((e[i] + e[i + 1]) / 2), float(h[i] / len(v))


def _openings(along: np.ndarray, a: float, b: float, cfg: dict) -> tuple[list[list[float]], float]:
    """Gaps along a wall segment [a, b] with no points. Returns (openings, share of the wall supported)."""
    step = cfg["gap_bin_m"]
    n = max(1, int(np.ceil((b - a) / step)))
    filled = np.zeros(n, bool)
    i = np.clip(((along - a) / step).astype(int), 0, n - 1)
    filled[i[(along >= a) & (along <= b)]] = True
    filled = ndimage.binary_closing(filled, iterations=1) | filled
    out = []
    lab, k = ndimage.label(~filled)
    for j in range(1, k + 1):
        cells = np.flatnonzero(lab == j)
        if cells[0] == 0 or cells[-1] == n - 1:
            continue  # a gap at the end is an unseen corner, not an opening
        g0, g1 = a + cells[0] * step, a + (cells[-1] + 1) * step
        if g1 - g0 >= cfg["opening_min_m"]:
            out.append([round(g0, 2), round(g1, 2)])
    return out, float(filled.mean())


def _short(reason: str) -> dict:
    return {"ok": False, "reason": reason}


def build(result: dict, cfg: dict | None = None) -> dict:
    """Layout for a scan result. When there isn't enough to go on, ok is False and reason says what to do."""
    cfg = {**DEFAULTS, **(cfg or {})}
    pts = np.asarray(result.get("points") or [], float).reshape(-1, 3)
    if len(pts) < cfg["min_points"]:
        return _short("Too few points mapped. Scan again more slowly, with the lights on.")
    z0, z1 = cfg["band_z"]
    band = pts[(pts[:, 2] > z0) & (pts[:, 2] < z1)]
    if len(band) < cfg["min_points"] // 2:
        return _short("Too few points at wall height. Point the phone at the walls, not the floor.")

    theta = _dominant_angle(band[:, :2], cfg["neighbours"])
    c, s = np.cos(theta), np.sin(theta)
    to_room = np.array([[c, s], [-s, c]])  # world xy -> wall-aligned uv
    uv = band[:, :2] @ to_room.T

    # Outer walls: robust extremes on each axis, then the densest band just inside each.
    lo, hi = np.percentile(uv, 1, axis=0), np.percentile(uv, 99, axis=0)
    edge = {}
    for ax in (0, 1):
        edge[(ax, -1)] = _wall_position(uv[:, ax], lo[ax], +1, cfg)
        edge[(ax, +1)] = _wall_position(uv[:, ax], hi[ax], -1, cfg)
    u0, u1 = edge[(0, -1)][0], edge[(0, +1)][0]
    v0, v1 = edge[(1, -1)][0], edge[(1, +1)][0]
    if u1 - u0 < 1.0 or v1 - v0 < 1.0:
        return _short("The map covers only part of the room. Walk along every wall, "
                      "keeping about a metre from it, so each wall and corner is seen.")

    to_world = lambda u, v: (np.array([u, v]) @ to_room).round(3).tolist()  # noqa: E731
    height = float(np.percentile(pts[:, 2], 99))
    walls = []
    corners = [(u0, v0), (u1, v0), (u1, v1), (u0, v1)]
    for k in range(4):
        (ua, va), (ub, vb) = corners[k], corners[(k + 1) % 4]
        ax = 1 if va == vb else 0  # the axis the wall sits at a fixed value of
        pos = va if ax == 1 else ua
        on = np.abs(uv[:, ax] - pos) < cfg["wall_thickness_m"]
        a, b = sorted((ua, ub) if ax == 1 else (va, vb))
        along = uv[on, 1 - ax]
        openings, support = _openings(along, a, b, cfg)
        # Openings in world coordinates, as distances along the wall from its start.
        start = np.array([ua, va])
        ops = []
        for g0, g1 in openings:
            d0, d1 = sorted(abs(np.array([g0, g1]) - (start[1 - ax])))
            ops.append({"from_m": round(float(d0), 2), "to_m": round(float(d1), 2)})
        walls.append({
            "a": to_world(ua, va), "b": to_world(ub, vb),
            "length_m": round(float(abs(ub - ua) + abs(vb - va)), 2),
            "support": round(support, 2), "openings": sorted(ops, key=lambda o: o["from_m"]),
        })

    # Objects: points inside the room, away from the walls, grouped on a floor grid.
    uv_all = pts[:, :2] @ to_room.T
    m = cfg["object_margin_m"]
    inside = ((uv_all[:, 0] > u0 + m) & (uv_all[:, 0] < u1 - m) & (uv_all[:, 1] > v0 + m) & (uv_all[:, 1] < v1 - m)
              & (pts[:, 2] > 0.05) & (pts[:, 2] < 2.0))
    objects = []
    if inside.sum() >= cfg["object_min_points"]:
        q, zz = uv_all[inside], pts[inside, 2]
        cell = cfg["object_cell_m"]
        g = np.floor((q - [u0, v0]) / cell).astype(int)
        grid = np.zeros(g.max(0) + 1, int)
        np.add.at(grid, (g[:, 0], g[:, 1]), 1)
        lab, n = ndimage.label(ndimage.binary_closing(grid >= 1, iterations=2) | (grid >= 1))
        which = lab[g[:, 0], g[:, 1]]
        for i in range(1, n + 1):
            sel = which == i
            if sel.sum() < cfg["object_min_points"]:
                continue
            a, b = np.percentile(q[sel], 2, axis=0), np.percentile(q[sel], 98, axis=0)
            top = float(np.percentile(zz[sel], 95))
            if min(b - a) < 0.1 or top < 0.15:
                continue
            objects.append({
                "center": to_world(*(a + b) / 2) + [round(top / 2, 3)],
                "size": [round(float(b[0] - a[0]), 2), round(float(b[1] - a[1]), 2), round(top, 2)],
                "yaw": round(theta, 4), "points": int(sel.sum()),
            })
    objects.sort(key=lambda o: -o["points"])

    support = float(np.mean([w["support"] for w in walls]))
    return {
        "ok": True,
        "yaw": round(theta, 4),
        "height_m": round(height, 2),
        "outline": [to_world(u, v) for u, v in corners],
        "size_m": [round(u1 - u0, 2), round(v1 - v0, 2)],
        "walls": walls,
        "objects": objects[:20],
        "confidence": "good" if support > 0.6 else "fair" if support > 0.35 else "low",
    }
