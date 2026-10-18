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
        "capture_fps": 8,  # frames per second sent from the phone while scanning
        "max_turn_deg_per_frame": 5.0,  # turning more than this between frames breaks the map (measured on real scans)
        "capture_max_side": 1280,  # longest frame side in pixels
        "jpeg_quality": 0.85,
        "camera_model": "SIMPLE_RADIAL",  # COLMAP lens model; OPENCV for stronger distortion
        "focal_prior_factor": 0.7,  # starting focal length = this x the frame's long side (typical phone main camera)
        "max_image_size": 1280,  # frames are downscaled to this for feature extraction
        "max_features": 8192,  # SIFT features per frame; more = slower, more robust
        "match_overlap": 20,  # each frame is matched with this many neighbours in time
        "min_matches": 10,  # matches needed to link two frames; lower links weak frames, risks errors
        "init_min_inliers": 50,  # agreeing matches needed to start the map
        "register_min_inliers": 15,  # agreeing matches needed to add a frame to the map
        "floor_percentile": 3.0,  # floor height = this percentile of point heights below the cameras
        "camera_height_m": 1.35,  # assumed phone height while scanning; sets scale until measured
        "imu_min_correlation": 0.5,  # accelerometer scale is used only if it agrees with the camera this well
        "max_points": 20000,  # points kept for the room view
        "live_interval_s": 3.0,  # how often the map is extended while scanning
        "live_min_new_frames": 10,  # extend the map once this many new frames have arrived
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


# Plain-language help for every setting, shown next to it in the app.
# section -> {"_": (title, what the section is for), key: (label, explanation, unit)}
DOCS: dict[str, dict[str, tuple]] = {
    "scan": {
        "_": ("Room scan", "The default way to map a room: no markers. Affects how the phone records and how the laptop builds the map."),
        "capture_fps": ("Frames per second", "How many camera frames the phone sends while scanning. More lets you turn faster but takes longer to process.", "fps"),
        "max_turn_deg_per_frame": ("Turn limit per frame", "The camera only sends a few frames a second; turning more than this between two frames breaks the map. The safe turn speed is this times the frame rate.", "°"),
        "capture_max_side": ("Frame size", "Longest side of each frame sent. Bigger shows more detail but uploads and processes slower.", "px"),
        "jpeg_quality": ("Image quality", "JPEG quality of uploaded frames, 0 to 1. Lower uploads faster but loses fine detail.", ""),
        "focal_prior_factor": ("Lens starting guess", "Starting focal length as a fraction of the frame's long side, used when the phone has no lens calibration. 0.7 fits most phone main cameras.", "×"),
        "camera_model": ("Lens model", "How lens distortion is modelled. SIMPLE_RADIAL suits phone main cameras; OPENCV for wide lenses.", ""),
        "max_image_size": ("Processing size", "Frames are shrunk to this before finding features. Larger is more precise and slower.", "px"),
        "max_features": ("Features per frame", "How many distinctive points (corners, edges, lights) are kept per frame. More is sturdier in plain rooms, but slower.", ""),
        "match_overlap": ("Frames compared", "Each frame is compared with this many frames before and after it. Raise it if scans break apart.", "frames"),
        "min_matches": ("Matches to link frames", "How many matching points two frames need before they're linked. Lower keeps weak frames, but can link wrong ones.", ""),
        "init_min_inliers": ("Matches to start the map", "How many consistent matches the first two frames need to start the map.", ""),
        "register_min_inliers": ("Matches to add a frame", "How many consistent matches a frame needs to be placed in the map. Lower places more frames in plain rooms.", ""),
        "floor_percentile": ("Floor detection", "The floor is placed at this low percentile of point heights. Raise it if the floor comes out too low.", "%"),
        "camera_height_m": ("Phone height (fallback)", "Assumed height of the phone during the scan. Only used for scale when the accelerometer fit fails.", "m"),
        "imu_min_correlation": ("Accelerometer agreement", "How well the accelerometer must match the camera motion before it's trusted for scale (0 to 1).", ""),
        "max_points": ("Points shown", "How many map points are kept for the room view.", ""),
        "live_interval_s": ("Live map interval", "How often the map is extended while you scan. Shorter is more responsive but uses more of the laptop.", "s"),
        "live_min_new_frames": ("Frames per live update", "The map is extended once this many new frames have arrived.", "frames"),
    },
    "tracking": {
        "_": ("Tag tracking (optional)", "Only used if you place tags (printed or shown on screens) for live, extra-accurate tracking."),
        "tag_size_m": ("Tag size", "Edge length of the black square of each tag. Must match the real size exactly; it sets the map's scale.", "m"),
        "origin_tag_id": ("Origin tag", "Which tag defines the room's starting point and direction.", ""),
        "origin_mount": ("Origin placement", "floor: lying flat. upright: standing on a screen or wall.", ""),
        "origin_height_m": ("Origin height", "For an upright origin: height of the tag's centre above the floor.", "m"),
        "origin_tag_size_m": ("Origin tag size", "Edge length of the origin tag (printed bigger because it's seen at an angle).", "m"),
        "tag_sizes": ("Per-tag sizes", "Sizes for individual tags, e.g. tags on different screens. JSON like {\"3\": 0.142}.", "m"),
        "room_tag_max_id": ("Highest room tag", "Tags numbered above this are ignored by tracking (the calibration grid uses 200+).", ""),
        "capture_width": ("Camera width", "Requested camera resolution, width.", "px"),
        "capture_height": ("Camera height", "Requested camera resolution, height.", "px"),
        "detect_scale": ("Detection scale", "Shrink frames before looking for tags. 0.5 is about 4x faster but sees less far.", ""),
        "detect_max_fps": ("Detection rate", "Maximum tag detections per second.", "fps"),
        "corner_refinement": ("Corner precision", "none is fastest, subpix is precise, apriltag is the most precise and slowest.", ""),
        "min_tag_px": ("Smallest tag", "Tags smaller than this on screen are ignored as too imprecise.", "px"),
        "max_reproj_px": ("Pose quality limit", "Phone positions that fit the tags worse than this are thrown away.", "px"),
        "body_offset_m": ("Body offset", "Distance from a chest-height phone back to the centre of your body. Applies to every body-position label.", "m"),
    },
    "mapping": {
        "_": ("Tag map (optional)", "How tag positions are worked out from what the camera sees."),
        "keyframe_interval_s": ("Time between samples", "Minimum time between stored tag observations.", "s"),
        "min_tags_per_frame": ("Tags per sample", "A frame must show this many tags to link them.", ""),
        "max_frames": ("Samples used", "How many observations the map uses, across all passes.", ""),
        "huber_px": ("Outlier tolerance", "Lower ignores bad detections more aggressively.", "px"),
        "min_obs_per_tag": ("Sightings needed", "A tag must be seen this many times before it joins the map.", ""),
        "solve_debounce_s": ("Solve delay", "Wait this long after new data before re-solving.", "s"),
    },
    "lens": {
        "_": ("Lens calibration (optional)", "Measuring the phone camera's lens with a grid of tags. Improves tag tracking accuracy."),
        "board_cols": ("Grid columns", "Tags across the calibration grid.", ""),
        "board_rows": ("Grid rows", "Tags down the calibration grid.", ""),
        "board_first_id": ("First grid tag", "Number of the grid's first tag.", ""),
        "board_gap_ratio": ("Grid spacing", "Gap between grid tags, as a fraction of a tag's size.", ""),
        "min_tags_per_view": ("Tags per view", "Grid tags that must be visible for a view to count.", ""),
        "min_views": ("Views needed", "Views collected before calibrating.", ""),
        "max_views": ("Views kept", "The best views kept across calibration passes.", ""),
        "fix_k3": ("Simple distortion", "Use a simpler distortion model. Turn off only for wide or fisheye lenses.", ""),
        "outlier_view_factor": ("Bad view cutoff", "Views with error above this many times the median are dropped.", "×"),
    },
    "sync": {
        "_": ("Clock sync", "Keeps the phone's timestamps on the laptop's clock. Each 10 ms of error is about 1.4 cm of position error at walking pace."),
        "interval_s": ("Sync interval", "Time between rounds of clock pings.", "s"),
        "burst": ("Pings per round", "How many pings per round.", ""),
        "window": ("Samples kept", "How many recent pings the estimate uses.", ""),
        "rtt_slack_ms": ("Trusted pings", "Pings within this much of the fastest round trip are trusted.", "ms"),
    },
    "teacher": {
        "_": ("Skeleton teacher (later)", "For training full-body poses. Not used yet."),
        "model": ("Pose model", "lite is fastest, heavy is most accurate.", ""),
        "min_visibility": ("Joint confidence", "Joints less certain than this are ignored.", ""),
        "stand_pose_average_s": ("Stand averaging", "Time spent locating the phone stand.", "s"),
    },
    "learn": {
        "_": ("Learn walks (later)", "For training WiFi sensing. Not used yet."),
        "baseline_s": ("Empty-room capture", "Length of the empty-room recording before a walk.", "s"),
        "coverage_cell_m": ("Coverage grid", "Size of each floor square in the coverage map.", "m"),
        "target_samples_per_cell": ("Samples per square", "When a floor square counts as covered.", ""),
    },
}


# The scan-coverage thresholds live with their scoring code; expose them as a normal settings section.
from .coverage import DEFAULTS as _COVERAGE_DEFAULTS, DOCS as _COVERAGE_DOCS  # noqa: E402

DEFAULTS["coverage"] = dict(_COVERAGE_DEFAULTS)
DOCS["coverage"] = dict(_COVERAGE_DOCS)
