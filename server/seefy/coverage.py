"""How complete a room scan is: a 0-1 progress score, a level and one hint.

Structure-from-motion needs the room seen from every direction and from more than one
place. Each component below measures one of those needs from the registered camera
poses. "Enough" means every component clears its minimum (the weakest one decides),
not just a good average; "extra" means every component reaches its extra-sure target.

Frames are in the room frame: z up, metres, origin on the floor. Camera axes are
x right, y down, z forward, so the viewing direction is the third column of R.
"""

from __future__ import annotations

import math

import numpy as np

DEFAULTS: dict = {
    "enough": 0.7,  # score at which the scan counts as enough; 1.0 is extra sure
    "min_frames": 10,  # registered frames needed before any component is scored
    "heading_bins": 12,  # compass directions the room is split into
    "heading_min_frames": 2,  # frames needed for a direction to count as seen
    "headings_min": 0.75,  # share of directions needed for "enough"
    "headings_extra": 1.0,  # share of directions needed for "extra"
    "walk_span_m": 1.5,  # walked extent (mean of the two floor axes) that scores 1
    "walk_min": 0.6,
    "walk_extra": 1.0,
    "registered_min": 0.6,  # share of captured frames placed in the map
    "registered_extra": 0.9,
    "parallax_baseline_m": 0.5,  # a direction needs views this far apart to count
    "parallax_min": 0.5,  # share of seen directions with that baseline
    "parallax_extra": 0.9,
    "ceiling_pitch_deg": 25.0,  # a frame tilted up at least this much sees the ceiling
    "ceiling_share": 0.08,  # share of upward frames that scores 1
    "ceiling_min": 0.0,  # helpful, never required
    "ceiling_extra": 1.0,
    "scale_corr_low": 0.5,  # accelerometer agreement that scores 0
    "scale_corr_high": 0.9,  # accelerometer agreement that scores 1
    "scale_no_imu": 0.5,  # score without accelerometer data (assumed phone height)
    "scale_failed": 0.25,  # score when the accelerometer fit failed
    "scale_min": 0.0,  # the assumed-height fallback still gives a usable map
    "scale_extra": 0.8,
    "detail_close_m": 2.0,  # median distance to what the camera sees that scores 1
    "detail_far_m": 4.0,  # ...and that scores 0
    "detail_points": 300,  # map points in view per frame that score 1
    "detail_min": 0.4,
    "detail_extra": 0.8,
    "capture_fps": 5,  # frames per second the phone sends; sets the turn-speed limit
    "max_turn_deg_per_frame": 5.0,  # turning more than this between frames loses frames (real scan: 46% placed under 5°, 18% at 5-10°)
    "hfov_deg": 50.0,  # horizontal field of view used to decide which points are in view
    "lost_min_frames": 15,  # recent frames needed before judging whether tracking is lost
    "lost_share": 0.2,  # below this share of recent frames placed, tracking counts as lost
}

DOCS: dict = {
    "_": ("Scan coverage", "How the app decides a room scan is complete, and what it asks you to do next."),
    "enough": ("Enough at", "Where the progress bar says the scan is enough. The full bar means extra sure.", ""),
    "min_frames": ("Frames before scoring", "Placed frames needed before the app starts judging coverage.", "frames"),
    "heading_bins": ("Directions", "How many compass directions the room is split into when checking you looked all around.", ""),
    "heading_min_frames": ("Frames per direction", "Frames needed facing a direction before it counts as seen.", "frames"),
    "headings_min": ("Directions for enough", "Share of directions you must have faced for the scan to count as enough.", ""),
    "headings_extra": ("Directions for extra", "Share of directions needed to be extra sure.", ""),
    "walk_span_m": ("Walking distance", "How far across the room you should move. Turning on the spot can't measure depth.", "m"),
    "walk_min": ("Walking for enough", "Share of that distance needed for the scan to count as enough.", ""),
    "walk_extra": ("Walking for extra", "Share of that distance needed to be extra sure.", ""),
    "registered_min": ("Frames placed for enough", "Share of frames the map must place. Low means moving too fast or too dark.", ""),
    "registered_extra": ("Frames placed for extra", "Share of frames placed needed to be extra sure.", ""),
    "parallax_baseline_m": ("Viewpoint spread", "Each direction should be seen from spots at least this far apart, so depth can be measured.", "m"),
    "parallax_min": ("Spread for enough", "Share of seen directions that need that spread for the scan to count as enough.", ""),
    "parallax_extra": ("Spread for extra", "Share of seen directions with that spread needed to be extra sure.", ""),
    "ceiling_pitch_deg": ("Looking up", "A frame tilted up at least this much counts as seeing the ceiling and its lights.", "°"),
    "ceiling_share": ("Ceiling frames", "Share of frames looking up that scores full marks. Ceiling lights make good reference points.", ""),
    "ceiling_min": ("Ceiling for enough", "Ceiling views needed for enough. Zero: helpful but not required.", ""),
    "ceiling_extra": ("Ceiling for extra", "Ceiling views needed to be extra sure.", ""),
    "scale_corr_low": ("Scale: weakest agreement", "Accelerometer agreement that counts as no scale confidence.", ""),
    "scale_corr_high": ("Scale: full agreement", "Accelerometer agreement that counts as full scale confidence.", ""),
    "scale_no_imu": ("Scale without motion data", "Confidence when there's no accelerometer data and the phone height is assumed.", ""),
    "scale_failed": ("Scale when the fit fails", "Confidence when the accelerometer didn't match the camera motion.", ""),
    "scale_min": ("Scale for enough", "Scale confidence needed for enough. Zero: the assumed phone height still gives a usable map.", ""),
    "scale_extra": ("Scale for extra", "Scale confidence needed to be extra sure.", ""),
    "detail_close_m": ("Close enough", "Scanning from this close or closer to walls and furniture picks up full detail.", "m"),
    "detail_far_m": ("Too far", "Scanning from this far away picks up too little detail to map well.", "m"),
    "detail_points": ("Detail in view", "Map points in view per frame that count as plenty of detail.", "points"),
    "detail_min": ("Detail for enough", "Detail score needed for the scan to count as enough.", ""),
    "detail_extra": ("Detail for extra", "Detail score needed to be extra sure.", ""),
    "capture_fps": ("Frames per second", "Frames the phone sends while scanning. Sets how fast you can turn.", "fps"),
    "max_turn_deg_per_frame": ("Turn per frame", "Turning more than this between two frames breaks the map, so the app asks you to turn slower.", "°"),
    "hfov_deg": ("Field of view", "How wide the camera sees, used to work out what's in view.", "°"),
    "lost_min_frames": ("Frames before 'lost'", "Recent frames needed before the app decides the map has lost track.", "frames"),
    "lost_share": ("Lost track below", "If fewer than this share of recent frames are placed, the app asks you to point back at somewhere already scanned.", ""),
}

LABELS = {
    "headings": "Directions",
    "walk": "Walking",
    "registered": "Frames placed",
    "parallax": "Viewpoints",
    "ceiling": "Ceiling",
    "scale": "Scale",
    "detail": "Detail",
    "pace": "Turn speed",
}

HINTS = {
    "walk": "Walk a few steps, don't just turn",
    "registered": "Slow down: some frames couldn't be placed",
    "parallax": "Step to a new spot and look at the same walls again",
    "ceiling": "Tilt up at the ceiling lights now and then",
    "scale": "Keep the phone moving steadily so the motion sensor can measure scale",
    "detail": "Move closer to the walls and furniture so they fill the view",
    "pace": "Turn slower: the camera can't keep up",
    "lost": "Lost track: point back at somewhere you've already scanned, then carry on slowly",
}


def _clamp(v: float) -> float:
    return float(min(1.0, max(0.0, v)))


def _views(frames: list[dict]) -> tuple[np.ndarray, np.ndarray]:
    p = np.asarray([f["p"] for f in frames], dtype=float).reshape(-1, 3)
    R = np.asarray([f["R"] for f in frames], dtype=float).reshape(-1, 9)
    fwd = R[:, [2, 5, 8]]
    fwd /= np.linalg.norm(fwd, axis=1, keepdims=True) + 1e-12
    return p, fwd


def _gap(seen: np.ndarray) -> tuple[int, float]:
    """The largest run of unseen directions: (its length in bins, its middle as a heading in radians)."""
    n = len(seen)
    best_len, best_mid = 0, 0
    for start in range(n):  # a run of unseen directions starts right after a seen one
        if seen[start] or not seen[start - 1]:
            continue
        length = 0
        while length < n and not seen[(start + length) % n]:
            length += 1
        if length > best_len:
            best_len, best_mid = length, start + (length - 1) / 2
    return best_len, ((best_mid + 0.5) * 2 * math.pi / n) % (2 * math.pi)


def _heading_hint(gap_len: int, target: float, last_heading: float) -> str:
    """Say how far, and which way, to turn from where the phone faced in the last placed frame."""
    if gap_len == 0:  # nothing seen yet, or everything unseen
        return "Turn slowly to face every wall"
    diff = (target - last_heading + math.pi) % (2 * math.pi) - math.pi  # + is to the left (counterclockwise)
    deg = int(round(abs(math.degrees(diff)) / 45) * 45)
    if deg >= 135:
        return "Turn around: the part of the room behind you isn't scanned yet"
    if deg == 0:
        return "Keep facing this way: the part of the room ahead isn't scanned yet"
    return f"Turn about {deg}° to your {'left' if diff > 0 else 'right'}: that side of the room isn't scanned yet"


def _detail(p: np.ndarray, fwd: np.ndarray, points, c: dict) -> dict:
    """How close the camera was to what it saw, and how much of the map was in view, per frame."""
    P = np.asarray(points, dtype=float).reshape(-1, np.asarray(points[0]).size)[:, :3]
    tan_h = math.tan(math.radians(c["hfov_deg"]) / 2)
    step = max(1, len(p) // 200)  # a sample of frames keeps this fast
    dists, counts = [], []
    for i in range(0, len(p), step):
        rel = P - p[i]
        z = rel @ fwd[i]
        lateral = np.linalg.norm(rel - np.outer(z, fwd[i]), axis=1)
        vis = (z > 0.2) & (lateral < tan_h * z * 1.3)  # a cone a little wider than the horizontal view
        counts.append(int(vis.sum()))
        if vis.any():
            dists.append(float(np.median(z[vis])))
    if not dists:
        return {"value": 0.0, "detail": "nothing in view yet"}
    d, n = float(np.median(dists)), float(np.median(counts))
    near = _clamp((c["detail_far_m"] - d) / (c["detail_far_m"] - c["detail_close_m"]))
    return {"value": near * _clamp(n / c["detail_points"]), "detail": f"about {d:.1f} m from what's in view"}


def score(frames: list[dict], total_frames: int, imu: dict | None, cfg: dict, *,
          points: list | None = None, turn_dps: float | None = None,
          recent: tuple[int, int] | None = None) -> dict:
    """Score a scan's coverage from its registered frames. See the module docstring.

    Optional: points, the map's 3D points (room frame), adds a "detail" component that asks
    you to move closer; turn_dps, the phone's current turn speed in degrees per second, adds
    a "pace" component and puts "turn slower" first whenever it's over the limit; recent,
    (placed, captured) for the frames since the previous live update, puts "lost track"
    first when the map has stopped placing new frames."""
    result = _score(frames, total_frames, imu, cfg, points=points, turn_dps=turn_dps)
    c = {**DEFAULTS, **(cfg or {})}
    if recent is not None:
        placed, captured = recent
        lost = captured >= c["lost_min_frames"] and placed / captured < c["lost_share"]
        result["lost"] = bool(lost)
        if lost:
            # Turn directions are measured from the last placed frame, which is stale once tracking is lost.
            rest = [h for h in result["hints"] if h != HINTS["lost"] and not h.startswith(("Turn about", "Turn around", "Keep facing"))]
            result["hints"] = [HINTS["lost"]] + rest[:2]
            result["hint"] = HINTS["lost"]
    return result


def _score(frames: list[dict], total_frames: int, imu: dict | None, cfg: dict, *,
           points: list | None = None, turn_dps: float | None = None) -> dict:
    c = {**DEFAULTS, **(cfg or {})}
    pace = None
    if turn_dps is not None:
        limit = c["max_turn_deg_per_frame"] * c["capture_fps"]
        pace = {"value": _clamp(limit / turn_dps) if turn_dps > 0 else 1.0,
                "detail": f"{turn_dps:.0f}°/s, limit {limit:.0f}°/s", "_over": turn_dps > limit}
    n = len(frames)
    total = max(int(total_frames), n)
    comps: dict[str, dict] = {}

    reg = n / total if total else 0.0
    comps["registered"] = {"value": _clamp(reg), "detail": f"{round(100 * reg)}% of frames placed"}

    if n < c["min_frames"]:
        for k in ("headings", "walk", "parallax", "ceiling"):
            comps[k] = {"value": 0.0, "detail": "not enough frames yet"}
        comps["scale"] = {"value": 0.0, "detail": "not enough frames yet"}
        hint = "Slow down: frames aren't being placed yet" if total >= 2 * c["min_frames"] else \
            "Walk slowly around the room with the camera facing the walls"
        if pace is not None:
            comps["pace"] = pace
        return _finish(comps, c, override_hint=hint)

    p, fwd = _views(frames)
    nb = int(c["heading_bins"])
    heading = np.arctan2(fwd[:, 1], fwd[:, 0]) % (2 * math.pi)
    bins = np.minimum((heading / (2 * math.pi) * nb).astype(int), nb - 1)
    counts = np.bincount(bins, minlength=nb)
    seen = counts >= c["heading_min_frames"]
    comps["headings"] = {"value": float(seen.mean()), "detail": f"{int(seen.sum())} of {nb} directions"}

    xy = p[:, :2] - p[:, :2].mean(0)
    if n >= 3:
        _, _, axes = np.linalg.svd(xy, full_matrices=False)
        proj = xy @ axes.T
        ext = np.percentile(proj, 95, axis=0) - np.percentile(proj, 5, axis=0)
    else:
        ext = np.zeros(2)
    ext = np.pad(ext, (0, 2 - len(ext)))
    comps["walk"] = {"value": _clamp(float(ext.mean()) / c["walk_span_m"]),
                     "detail": f"{ext[0]:.1f} × {ext[1]:.1f} m walked"}

    spread_ok = 0
    for b in np.flatnonzero(seen):
        pts = p[bins == b, :2]
        if np.linalg.norm(pts.max(0) - pts.min(0)) >= c["parallax_baseline_m"]:
            spread_ok += 1
    par = spread_ok / max(1, int(seen.sum()))
    comps["parallax"] = {"value": _clamp(par), "detail": f"{spread_ok} of {int(seen.sum())} directions seen from two spots"}

    up = float((np.degrees(np.arcsin(np.clip(fwd[:, 2], -1, 1))) >= c["ceiling_pitch_deg"]).mean())
    comps["ceiling"] = {"value": _clamp(up / c["ceiling_share"]), "detail": f"{round(100 * up)}% of frames look up"}

    if imu is None:
        sc, sd = c["scale_no_imu"], "no motion data; phone height assumed"
    elif not imu.get("ok"):
        sc, sd = c["scale_failed"], "motion sensor didn't match; phone height assumed"
    else:
        corr = float(imu.get("correlation", 0.0))
        sc = _clamp((corr - c["scale_corr_low"]) / (c["scale_corr_high"] - c["scale_corr_low"]))
        sd = f"motion sensor agreement {corr:.2f}"
    comps["scale"] = {"value": _clamp(sc), "detail": sd}
    if points is not None and len(points):
        comps["detail"] = _detail(p, fwd, points, c)
    if pace is not None:
        comps["pace"] = pace

    gap_len, gap_heading = _gap(seen)
    result = _finish(comps, c, heading_hint=_heading_hint(gap_len, gap_heading, float(heading[-1])))
    # Absolute directions in the room frame (degrees counterclockwise from +x), so the app can draw an
    # arrow on the map instead of relying on "left" and "right".
    result["gap_heading_deg"] = round(math.degrees(gap_heading), 1) if gap_len else None
    result["last_heading_deg"] = round(math.degrees(float(heading[-1])), 1)
    return result


def _finish(comps: dict, c: dict, *, heading_hint: str = "Turn slowly to face every wall",
            override_hint: str | None = None) -> dict:
    pace = comps.pop("pace", None)  # advisory: describes this moment, never gates the level
    for k, v in comps.items():
        v["label"] = LABELS[k]

    # Progress toward "enough": the weakest required component, as a share of its minimum.
    need = {k: c[f"{k}_min"] for k in comps if c[f"{k}_min"] > 0}
    to_enough = {k: comps[k]["value"] / m for k, m in need.items()}
    bottleneck = min(to_enough.values()) if to_enough else 1.0

    # Progress from "enough" to "extra": the weakest component between its minimum and its extra target.
    to_extra = {}
    for k in comps:
        lo, hi = c[f"{k}_min"], c[f"{k}_extra"]
        to_extra[k] = 1.0 if hi <= lo else _clamp((comps[k]["value"] - lo) / (hi - lo))

    enough = c["enough"]
    if bottleneck < 1.0:
        level, s = "short", enough * bottleneck
    else:
        e = min(to_extra.values())
        level = "extra" if e >= 1.0 else "enough"
        s = enough + (1 - enough) * e

    # Every component short of its target, weakest first, as one instruction each.
    gaps = to_enough if level == "short" else to_extra
    hints = [heading_hint if k == "headings" else HINTS[k] for k, g in sorted(gaps.items(), key=lambda kv: kv[1]) if g < 1.0]
    if override_hint is not None:
        hints = [override_hint] + [h for h in hints if h != override_hint]
    elif level == "extra":
        hints = ["That's plenty. You can stop scanning"]
    if pace is not None:
        over = pace.pop("_over")
        pace["label"] = LABELS["pace"]
        comps["pace"] = pace
        if over:
            hints = [HINTS["pace"]] + hints
    return {"score": round(float(s), 3), "level": level, "components": comps,
            "hint": hints[0] if hints else "Keep going", "hints": hints[:3]}
