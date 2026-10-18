"""Tunable settings ("fidelity knobs").

Every value here can change how accurate calibration and sensing end up.
Defaults live in DEFAULTS; overrides are saved to <data>/config.json and a
full snapshot is written into every recorded session, so passes made with
different settings can be compared later. docs/FIDELITY.md explains each one.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

DEFAULTS: dict[str, dict[str, Any]] = {
    "tracking": {
        "tag_size_m": 0.10,  # printed black-square edge length of room tags
        "origin_tag_id": 0,  # defines the world origin and "up"
        "origin_mount": "floor",  # floor: printed tag lying flat | upright: on a screen or wall, standing straight
        "origin_height_m": 1.0,  # upright origin only: height of the tag centre above the floor
        "origin_tag_size_m": 0.20,  # floor tag is seen at a steep angle, so it is printed larger
        "tag_sizes": {},  # per-tag sizes in metres, e.g. tags shown on screens: {"3": 0.142}
        "room_tag_max_id": 49,  # room tags are 0..this; higher ids are ignored by tracking
        "capture_width": 1280,
        "capture_height": 720,
        "detect_scale": 1.0,  # downscale before detection (0.5 = half size, faster, less precise)
        "detect_max_fps": 30,
        "corner_refinement": "subpix",  # none | subpix | contour | apriltag
        "min_tag_px": 24,  # ignore tags whose edge is shorter than this in the image
        "max_reproj_px": 4.0,  # reject a phone pose whose reprojection error is above this
        "body_offset_m": 0.35,  # torso centre sits this far behind a chest-height phone
    },
    "mapping": {
        "keyframe_interval_s": 0.25,  # min time between tag-map observations per device
        "min_tags_per_frame": 2,  # a frame must see this many tags to link them
        "max_frames": 2000,  # observations kept for the solve, across all passes
        "huber_px": 1.5,  # robust loss scale; larger trusts outliers more
        "min_obs_per_tag": 3,  # a tag needs this many observations to enter the map
        "solve_debounce_s": 1.0,
    },
    "lens": {
        "board_cols": 5,
        "board_rows": 7,
        "board_first_id": 200,
        "board_gap_ratio": 0.25,  # gap between board tags as a fraction of tag size
        "min_tags_per_view": 8,
        "min_views": 12,
        "max_views": 80,  # views kept across lens passes (best kept when trimming)
        "fix_k3": True,  # simpler distortion model; turn off for wide or fisheye lenses
        "outlier_view_factor": 3.0,  # drop views whose error exceeds this x the median
    },
    "sync": {
        "interval_s": 2.0,  # time between ping bursts
        "burst": 5,  # pings per burst
        "window": 60,  # samples kept for the offset estimate
        "rtt_slack_ms": 2.0,  # samples within min_rtt + slack are trusted
    },
    "teacher": {
        "model": "lite",  # lite | full | heavy (heavier = more accurate, slower)
        "min_visibility": 0.5,
        "stand_pose_average_s": 2.0,
    },
    "scan": {
        "capture_fps": 5,  # frames per second sent from the phone while scanning
        "capture_max_side": 1280,  # longest frame side in pixels
        "jpeg_quality": 0.85,
        "camera_model": "SIMPLE_RADIAL",  # COLMAP lens model; OPENCV for stronger distortion
        "max_image_size": 1024,  # frames are downscaled to this for feature extraction
        "max_features": 4096,  # SIFT features per frame; more = slower, more robust
        "match_overlap": 10,  # each frame is matched with this many neighbours in time
        "floor_percentile": 3.0,  # floor height = this percentile of point heights below the cameras
        "camera_height_m": 1.35,  # assumed phone height while scanning; sets scale until measured
        "imu_min_correlation": 0.5,  # accelerometer scale is used only if it agrees with the camera this well
        "max_points": 20000,  # points kept for the room view
    },
    "learn": {
        "baseline_s": 30,  # empty-space capture before a walk
        "coverage_cell_m": 0.25,  # floor grid size for the coverage heatmap
        "target_samples_per_cell": 60,  # coverage counts as complete at this many labels
    },
}


def _merge(base: dict, over: dict) -> dict:
    out = copy.deepcopy(base)
    for k, v in over.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _merge(out[k], v)
        else:
            out[k] = v
    return out


def _validate(over: dict) -> dict:
    """Keep only known sections/keys, coerced to the default's type."""
    clean: dict = {}
    for section, values in over.items():
        if section not in DEFAULTS or not isinstance(values, dict):
            continue
        for key, value in values.items():
            if key not in DEFAULTS[section]:
                continue
            default = DEFAULTS[section][key]
            if isinstance(default, dict):
                value = {str(k): float(v) for k, v in dict(value).items() if v}
            elif isinstance(default, bool):
                value = bool(value)
            elif isinstance(default, int):
                value = int(value)
            elif isinstance(default, float):
                value = float(value)
            elif isinstance(default, str):
                value = str(value)
            clean.setdefault(section, {})[key] = value
    return clean


class Config:
    def __init__(self, path: Path):
        self.path = path
        self.overrides: dict = {}
        if path.exists():
            self.overrides = _validate(json.loads(path.read_text()))
        self.values = _merge(DEFAULTS, self.overrides)

    def __getitem__(self, section: str) -> dict:
        return self.values[section]

    def update(self, changes: dict) -> dict:
        self.overrides = _merge(self.overrides, _validate(changes))
        self.values = _merge(DEFAULTS, self.overrides)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(self.overrides, indent=2))
        return self.values

    def reset(self) -> dict:
        self.overrides = {}
        self.values = copy.deepcopy(DEFAULTS)
        if self.path.exists():
            self.path.unlink()
        return self.values

    def snapshot(self) -> dict:
        return copy.deepcopy(self.values)
