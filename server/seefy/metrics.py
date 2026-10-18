"""Experiment log: what happened and how well it worked, for write-ups and comparisons.

events.jsonl   - one line per event: device connects, passes, map solves, lens calibrations, setting changes
metrics.jsonl  - device and tag-map statistics every few seconds while anything is connected

`seefy report` turns both into a Markdown summary (data/report.md).
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import numpy as np


class MetricsLog:
    def __init__(self, directory: Path):
        self.dir = directory
        self.dir.mkdir(parents=True, exist_ok=True)

    def _append(self, name: str, record: dict) -> None:
        with (self.dir / name).open("a") as fh:
            fh.write(json.dumps({"wall": round(time.time(), 3), **record}, separators=(",", ":")) + "\n")

    def event(self, name: str, /, **data) -> None:
        self._append("events.jsonl", {"event": name, **data})

    def snapshot(self, state: dict) -> None:
        self._append("metrics.jsonl", state)


def _read(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def _stats(values: list[float]) -> str:
    v = np.array([x for x in values if x is not None], dtype=float)
    if not len(v):
        return "–"
    return f"{np.median(v):.1f} (p95 {np.percentile(v, 95):.1f}, n={len(v)})"


def _when(wall: float) -> str:
    return time.strftime("%Y-%m-%d %H:%M", time.localtime(wall))


def report(data: Path) -> str:
    d = data / "metrics"
    events = _read(d / "events.jsonl")
    snaps = _read(d / "metrics.jsonl")
    out = ["# Seefy results log", "", f"Generated {_when(time.time())} from `{d}`.", ""]

    devices = {}
    for e in events:
        if e["event"] == "connect":
            dev = devices.setdefault(e["device"], {"name": e.get("name"), "ua": e.get("ua", ""), "first": e["wall"]})
            dev["last"] = e["wall"]
    out += ["## Devices", "", "| Device | Role | Browser | First seen |", "|---|---|---|---|"]
    for e in events:
        if e["event"] == "connect" and devices.get(e["device"], {}).get("first") == e["wall"]:
            out.append(f"| {e.get('name')} | {e.get('role')} | {e.get('ua', '')[:70]} | {_when(e['wall'])} |")
    out.append("")

    # Phone performance while tracking.
    per_phone: dict[str, dict[str, list]] = {}
    for s in snaps:
        for dev in s.get("devices", []):
            if dev.get("role") != "phone" or dev.get("mode") not in ("track", "lens"):
                continue
            m = per_phone.setdefault(dev["name"] + " " + dev["id"], {k: [] for k in
                                     ("fps", "detect", "sync", "capture", "net", "poses", "tracking")})
            st = dev.get("status", {})
            m["fps"].append(st.get("fps"))
            m["detect"].append(st.get("detect_ms"))
            m["sync"].append((dev.get("sync") or {}).get("err_ms"))
            m["capture"].append(dev.get("capture_latency_ms"))
            m["net"].append(dev.get("net_latency_ms"))
            m["poses"].append((dev.get("rates") or {}).get("pose", 0))
            m["tracking"].append(1.0 if st.get("tracking") else 0.0)
    out += ["## Phone tracking performance", "",
            "Median, 95th percentile and sample count over every 5 s snapshot while the camera was running.", ""]
    if per_phone:
        out += ["| Phone | Camera fps | Detect ms | Clock sync error ms | Camera→host ms | Phone→host ms | Poses/s | Time tracking |",
                "|---|---|---|---|---|---|---|---|"]
        for name, m in per_phone.items():
            share = f"{100 * np.mean(m['tracking']):.0f}%" if m["tracking"] else "–"
            out.append(f"| {name} | {_stats(m['fps'])} | {_stats(m['detect'])} | {_stats(m['sync'])} | "
                       f"{_stats(m['capture'])} | {_stats(m['net'])} | {_stats(m['poses'])} | {share} |")
    else:
        out.append("No phone tracking recorded yet.")
    out.append("")

    solves = [e for e in events if e["event"] == "map_solve"]
    out += ["## Tag map solves", ""]
    if solves:
        out += ["| Time | Passes | Frames used | Tags | Fit (px) | Solve (ms) |", "|---|---|---|---|---|---|"]
        shown = solves if len(solves) <= 30 else solves[:5] + solves[-25:]
        for e in shown:
            out.append(f"| {_when(e['wall'])} | {e.get('passes')} | {e.get('frames_used')} | {e.get('tags')} | "
                       f"{e.get('rms_px')} | {e.get('solve_ms')} |")
    else:
        out.append("No map solves yet.")
    out.append("")

    lens = [e for e in events if e["event"] == "lens_calibration"]
    out += ["## Lens calibrations", ""]
    if lens:
        out += ["| Time | Device | Fit (px) | Views used | Horizontal FOV |", "|---|---|---|---|---|"]
        for e in lens:
            out.append(f"| {_when(e['wall'])} | {e.get('device')} | {e.get('rms_px')} | "
                       f"{e.get('views_used')}/{e.get('views_total')} | {e.get('fov_h_deg')}° |")
    else:
        out.append("No lens calibrations yet.")
    out.append("")

    passes = [e for e in events if e["event"] in ("session_start", "session_stop")]
    out += ["## Passes", ""]
    if passes:
        out += ["| Time | Event | Pass | Duration (s) | Records | Notes |", "|---|---|---|---|---|---|"]
        for e in passes:
            out.append(f"| {_when(e['wall'])} | {e['event'].replace('session_', '')} | {e.get('id')} | "
                       f"{e.get('duration_s', '')} | {e.get('counts', '')} | {e.get('notes', '')} |")
    else:
        out.append("No passes recorded yet.")
    out.append("")

    changes = [e for e in events if e["event"] == "config_change"]
    if changes:
        out += ["## Setting changes", ""]
        out += [f"- {_when(e['wall'])}: `{json.dumps(e.get('changes'))}`" for e in changes]
        out.append("")
    return "\n".join(out)
