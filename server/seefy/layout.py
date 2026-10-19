"""Floor plan from a space's map: outline, walls with doors, rooms, and furniture boxes.

Input is the scan result: sparse map points and camera poses, in the space frame (z up,
metres, floor at z = 0). Structure-from-motion only places points on texture, so plain
wall paint gives little, but the edges that matter do: corners, skirting, door frames,
furniture.

Walls are assumed to meet at right angles, the usual case indoors. On a top-down grid
aligned with them:
  1. walls: long, thin lines of points (furniture makes blobs, not thin lines)
  2. footprint: everywhere reachable from the walked path without crossing a wall
  3. rooms: the footprint split by the walls once door-sized gaps are closed
  4. doors: gaps of door width between wall pieces on the same line
  5. furniture: clusters of points inside the footprint, off the walls
Each wall carries a support score, so the UI can show unsure walls as dashed.
"""

from __future__ import annotations

import cv2
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
    "cell_m": 0.05,  # top-down grid step
    "wall_min_m": 0.5,  # shortest straight run counted as a wall
    "wall_max_thick_m": 0.25,  # thicker than this is furniture, not a wall
    "door_max_m": 1.6,  # widest gap closed when splitting rooms (wider is an open-plan opening)
    "room_min_m2": 1.5,  # smaller regions are alcoves, merged into a neighbour
    "path_radius_m": 0.3,  # the walked path, widened, seeds the footprint
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


def _line(n: int, axis: int) -> np.ndarray:
    """A 1-cell-wide structuring element n cells long along axis 0 (u) or 1 (v)."""
    return np.ones((n, 1) if axis == 0 else (1, n), bool)


def _wall_masks(occ: np.ndarray, cfg: dict) -> tuple[np.ndarray, np.ndarray]:
    """Cells on walls running along u (mask 0) and along v (mask 1): long and thin, gaps bridged.

    Furniture shows up as solid patches of points; a patch wider than a wall in every direction
    is furniture, so its cells can't be wall."""
    cell = cfg["cell_m"]
    k = max(2, int(cfg["wall_max_thick_m"] / cell))
    solid = ndimage.binary_closing(occ, iterations=3)
    blobs = ndimage.binary_dilation(ndimage.binary_opening(solid, np.ones((k, k), bool)), iterations=1)
    out = []
    for ax in (0, 1):
        bridged = ndimage.binary_closing(occ & ~blobs, _line(max(3, int(0.3 / cell)), ax))
        out.append(ndimage.binary_opening(bridged, _line(int(cfg["wall_min_m"] / cell), ax)))
    return out[0], out[1]


def _segments(mask: np.ndarray, ax: int, cfg: dict) -> list[dict]:
    """Wall pieces in a mask as {pos, a, b, cells} in grid units; collinear pieces split by a gap stay separate."""
    lab, n = ndimage.label(mask)
    segs = []
    for i, sl in enumerate(ndimage.find_objects(lab), 1):
        cells = np.argwhere(lab[sl] == i) + [sl[0].start, sl[1].start]
        along, across = cells[:, ax], cells[:, 1 - ax]
        segs.append({"pos": float(np.median(across)), "a": float(along.min()), "b": float(along.max() + 1), "n": len(cells)})
    return segs


def _merge_walls(segs: list[dict], occ_count: np.ndarray, ax: int, cfg: dict) -> list[dict]:
    """Join collinear pieces into walls; gaps of door width between them become openings."""
    cell = cfg["cell_m"]
    tol = 0.15 / cell
    walls: list[dict] = []
    for s in sorted(segs, key=lambda s: (s["pos"], s["a"])):
        w = next((w for w in walls if abs(w["pos"] - s["pos"]) < tol and s["a"] - w["b"] <= cfg["door_max_m"] / cell), None)
        if w is None:
            walls.append({**s, "gaps": []})
            continue
        gap = s["a"] - w["b"]
        if gap * cell >= cfg["opening_min_m"]:
            w["gaps"].append((w["b"], s["a"]))
        w["b"] = max(w["b"], s["b"])
        w["pos"] = (w["pos"] * w["n"] + s["pos"] * s["n"]) / (w["n"] + s["n"])
        w["n"] += s["n"]
    for w in walls:
        # Support: share of the wall's length with points on it.
        r = int(round(w["pos"]))
        a, b = int(w["a"]), int(w["b"])
        line = occ_count[a:b, max(r - 2, 0):r + 3].sum(1) if ax == 0 else occ_count[max(r - 2, 0):r + 3, a:b].sum(0)
        w["support"] = float((ndimage.binary_closing(line > 0, iterations=2) | (line > 0)).mean()) if len(line) else 0.0
    return walls


def build(result: dict, cfg: dict | None = None) -> dict:
    """Floor plan for a scan result. When there isn't enough to go on, ok is False and reason says what to do."""
    cfg = {**DEFAULTS, **(cfg or {})}
    pts = np.asarray(result.get("points") or [], float).reshape(-1, 3)
    if len(pts) < cfg["min_points"]:
        return _short("Too few points mapped. Scan again more slowly, with the lights on.")
    z0, z1 = cfg["band_z"]
    band = pts[(pts[:, 2] > z0) & (pts[:, 2] < z1)]
    if len(band) < cfg["min_points"] // 2:
        return _short("Too few points at wall height. Point the phone across the room, not at the floor.")

    theta = _dominant_angle(band[:, :2], cfg["neighbours"])
    c, s = np.cos(theta), np.sin(theta)
    to_uv = np.array([[c, s], [-s, c]])  # world xy -> wall-aligned uv
    uv = band[:, :2] @ to_uv.T
    cell = cfg["cell_m"]
    lo = np.percentile(uv, 0.5, axis=0) - 0.3
    hi = np.percentile(uv, 99.5, axis=0) + 0.3
    shape = tuple(np.ceil((hi - lo) / cell).astype(int) + 1)
    if min(shape) * cell < 1.0:
        return _short("The map covers only a small part of the space. Walk through it slowly, "
                      "pointing the phone across each room at furniture, corners and doors.")
    gi = lambda q: np.clip(np.floor((q - lo) / cell).astype(int), 0, np.array(shape) - 1)  # noqa: E731
    to_world = lambda u, v: (np.array([u, v]) @ to_uv).round(3).tolist()  # noqa: E731
    g = gi(uv)
    count = np.zeros(shape, int)
    np.add.at(count, (g[:, 0], g[:, 1]), 1)
    occ = count > 0

    wu, wv = _wall_masks(occ, cfg)
    wall = wu | wv
    if wall.sum() * cell < 2 * cfg["wall_min_m"] / cell * cell:
        return _short("No walls found yet. Walk through the space pointing the phone across each room, "
                      "so its walls and corners are seen.")

    # Walls with door-sized gaps closed: rooms are what they enclose, and the flood below can't
    # leak out through a front door.
    close = int(cfg["door_max_m"] / cell)
    closed = ndimage.binary_closing(wu, _line(close, 0)) | ndimage.binary_closing(wv, _line(close, 1))
    barrier = ndimage.binary_dilation(closed | wall, iterations=2)

    # Footprint: flood from the walked path (or, without one, the most open spot) without crossing walls.
    seeds = np.zeros(shape, bool)
    frames = result.get("frames") or []
    if frames:
        cam = np.array([f["p"][:2] for f in frames], float) @ to_uv.T
        cg = gi(cam)
        seeds[cg[:, 0], cg[:, 1]] = True
        seeds = ndimage.binary_dilation(seeds, iterations=max(1, int(cfg["path_radius_m"] / cell))) & ~barrier
    if not seeds.any():
        dist = ndimage.distance_transform_edt(~barrier)
        seeds[np.unravel_index(np.argmax(dist), shape)] = True
    lab, _ = ndimage.label(~barrier)
    foot = np.isin(lab, np.unique(lab[seeds & (lab > 0)]))
    # A flood that reaches the edge of the grid means an outer wall wasn't seen there.
    leaks = sum(bool(x.any()) for x in (foot[0], foot[-1], foot[:, 0], foot[:, -1]))
    if leaks > 1:
        return _short("The map covers only part of the space. Walk through each room, "
                      "pointing the phone across it so every wall and corner is seen.")
    edge_leak = leaks == 1
    rooms_free = foot.copy()  # rooms are split along the barrier; the footprint then takes the walls in
    foot = ndimage.binary_fill_holes(ndimage.binary_dilation(foot, iterations=3))

    # Rooms: the walked-into regions between walls.
    rlab, nr = ndimage.label(rooms_free)
    areas = ndimage.sum(np.ones(shape), rlab, range(1, nr + 1)) * cell * cell
    keep = [i + 1 for i, a in enumerate(areas) if a >= cfg["room_min_m2"]]
    if not keep:
        return _short("The map covers only part of the space. Walk through each room, "
                      "pointing the phone across it so every wall and corner is seen.")
    # Every footprint cell joins its nearest kept room, so rooms tile the footprint with no seams.
    kept = np.isin(rlab, keep)
    _, (ii, jj) = ndimage.distance_transform_edt(~kept, return_indices=True)
    rooms_grid = np.where(foot, rlab[ii, jj], 0)

    def polygon(mask: np.ndarray) -> list[list[float]]:
        cs, _ = cv2.findContours(mask.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        cnt = max(cs, key=cv2.contourArea)
        cnt = cv2.approxPolyDP(cnt, 0.12 / cell, True)[:, 0, :]  # (col=v, row=u) in grid cells
        return [to_world(*(lo + (np.array([r, c_]) + 0.5) * cell)) for c_, r in cnt]

    rooms = []
    for k, i in enumerate(keep):
        m = rooms_grid == i
        cu, cv_ = (np.argwhere(m).mean(0) + 0.5) * cell + lo
        rooms.append({"id": f"r{k + 1}", "outline": polygon(m), "area_m2": round(float(m.sum() * cell * cell), 1),
                      "center": to_world(cu, cv_)})
    rooms.sort(key=lambda r: -r["area_m2"])

    # Walls: collinear pieces joined, door gaps kept as openings, only where they bound the footprint.
    near_foot = ndimage.binary_dilation(foot, iterations=3)
    walls = []
    for ax, mask in ((0, wu), (1, wv)):
        for w in _merge_walls(_segments(mask & near_foot, ax, cfg), count, ax, cfg):
            if (w["b"] - w["a"]) * cell < cfg["wall_min_m"]:
                continue
            p = lo[1 - ax] + (w["pos"] + 0.5) * cell
            ends = [lo[ax] + w["a"] * cell, lo[ax] + w["b"] * cell]
            a = to_world(ends[0], p) if ax == 0 else to_world(p, ends[0])
            b = to_world(ends[1], p) if ax == 0 else to_world(p, ends[1])
            walls.append({
                "a": a, "b": b, "length_m": round((w["b"] - w["a"]) * cell, 2), "support": round(w["support"], 2),
                "openings": [{"from_m": round((g0 - w["a"]) * cell, 2), "to_m": round((g1 - w["a"]) * cell, 2)} for g0, g1 in w["gaps"]],
            })

    # Furniture: points inside the footprint, off the walls, grouped on a floor grid.
    uv_all = pts[:, :2] @ to_uv.T
    ga = gi(uv_all)
    off_wall = ~ndimage.binary_dilation(wall, iterations=max(1, int(cfg["object_margin_m"] / cell)))
    inside = foot[ga[:, 0], ga[:, 1]] & off_wall[ga[:, 0], ga[:, 1]] & (pts[:, 2] > 0.05) & (pts[:, 2] < 2.0)
    objects = []
    if inside.sum() >= cfg["object_min_points"]:
        q, zz = uv_all[inside], pts[inside, 2]
        oc = cfg["object_cell_m"]
        og = np.floor((q - q.min(0)) / oc).astype(int)
        grid = np.zeros(og.max(0) + 1, int)
        np.add.at(grid, (og[:, 0], og[:, 1]), 1)
        olab, n = ndimage.label(ndimage.binary_closing(grid >= 1, iterations=2) | (grid >= 1))
        which = olab[og[:, 0], og[:, 1]]
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

    fu = np.argwhere(foot)
    size = (fu.max(0) - fu.min(0) + 1) * cell
    support = float(np.average([w["support"] for w in walls], weights=[w["length_m"] for w in walls])) if walls else 0.0
    confidence = "good" if support > 0.6 and not edge_leak else "fair" if support > 0.35 else "low"
    return {
        "ok": True,
        "yaw": round(theta, 4),
        "height_m": round(float(np.percentile(pts[:, 2], 99)), 2),
        "outline": polygon(foot),
        "size_m": [round(float(size[0]), 2), round(float(size[1]), 2)],
        "rooms": rooms,
        "walls": walls,
        "objects": objects[:30],
        "confidence": confidence,
        **({"note": "Part of the outer wall wasn't seen, so the outline is a guess there."} if edge_leak else {}),
    }
