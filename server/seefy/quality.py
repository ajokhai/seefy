"""An honest verdict on a scan: "good" or "weak", with plain reasons.

A weak scan must never look confident: when the verdict is weak, the layout's confidence
is capped to "low" and the first reason says what's wrong in words a person can act on.
"""

from __future__ import annotations

DEFAULTS = {
    "min_side_m": 2.0,  # rooms smaller than this on a side are suspicious unless a wall was measured
    "min_registered": 0.4,  # share of captured frames that must be placed in the map
}

DOCS = {
    "_": ("Scan verdict", "When a scan counts as good. A weak scan says what's missing instead of showing a confident plan."),
    "min_side_m": ("Smallest believable room", "A room smaller than this on either side is flagged as probably incomplete, unless you measured a wall.", "m"),
    "min_registered": ("Frames that must fit", "Share of captured frames that must fit into the map for the scan to count as good.", ""),
}


def assess(result: dict, cfg: dict | None = None) -> dict:
    cfg = {**DEFAULTS, **(cfg or {})}
    reasons: list[dict] = []
    cov = result.get("coverage") or {}
    lay = result.get("layout") or {}
    measured = result.get("size_source") == "measured"

    size = lay.get("size_m") if lay.get("ok") else result.get("room_size_m", [None, None])[:2]
    size = size if size and all(v is not None for v in size) else None

    if cov.get("level") == "short":
        hint = (cov.get("hints") or [""])[0]
        reasons.append({"code": "coverage", "text": "Part of this room is missing." + (f" {hint}" if hint else "")})
    if size and min(size) < cfg["min_side_m"] and not measured:
        reasons.append({"code": "small", "text": f"The room comes out at {size[0]:.1f} × {size[1]:.1f} m, smaller than "
                        "most rooms, so part of it is probably missing."})
    total = result.get("total") or 0
    if total and (result.get("registered") or 0) / total < cfg["min_registered"]:
        reasons.append({"code": "few_frames", "text": "Much of the video couldn't be used (blurry, dark, or too close "
                        "to plain walls)."})
    if not lay.get("ok"):
        reasons.append({"code": "no_layout", "text": lay.get("reason") or "The walls couldn't be found yet."})
    verdict = "weak" if reasons else "good"
    if not measured and not str(result.get("scale_method", "")).startswith("accelerometer"):
        # Not a reason for "weak", but worth saying: sizes are a guess until a wall is measured.
        reasons.append({"code": "size_estimated", "text": "Size is estimated. Measure one wall for exact distances."})
    return {
        "verdict": verdict,
        "reasons": reasons,
        "missing_heading_deg": cov.get("gap_heading_deg"),
        "size_m": [round(float(v), 2) for v in size] if size else None,
        "size_source": "measured" if measured else "estimated",
    }


def apply(result: dict, cfg: dict | None = None) -> dict:
    """Attach `quality` to a result and cap the layout's confidence when the verdict is weak."""
    q = assess(result, cfg)
    result["quality"] = q
    lay = result.get("layout")
    if lay and lay.get("ok") and q["verdict"] == "weak":
        lay["confidence"] = "low"
        lay["confidence_reason"] = q["reasons"][0]["text"]
    return result
