"""Watch the laptop's own WiFi signal react to movement.

    python -m seefy.wifi.probe [--seconds N] [--still S]

Stay still (or out of the room) for the first few seconds while it measures the still room,
then walk between the laptop and the router, or wave your arms near that line.
"""

from __future__ import annotations

import argparse
import time

from ..clock import host_ms
from . import motion, open_source


def main() -> None:
    ap = argparse.ArgumentParser(prog="seefy.wifi.probe", description=__doc__.split("\n\n")[0])
    ap.add_argument("--seconds", type=float, default=0, help="stop after this long (default: until Ctrl-C)")
    ap.add_argument("--still", type=float, default=10, help="seconds of still room to measure first")
    ap.add_argument("--interval-ms", type=float, default=10, help="how often to poll the WiFi interface")
    args = ap.parse_args()

    tracker = motion.MotionTracker({"baseline_s": args.still})
    t_start = host_ms()
    last_print = 0.0
    ts, vals = [], []
    print(f"Measuring the still room for {args.still:.0f} s. Stay still...")
    try:
        with open_source(args.interval_ms) as src:
            for s in src:
                tracker.add(s.t, s.rssi)
                ts.append(s.t)
                vals.append(s.rssi)
                now = time.monotonic()
                if now - last_print < 0.5:
                    if args.seconds and (s.t - t_start) / 1000 > args.seconds:
                        break
                    continue
                last_print = now
                recent = [v for t, v in zip(ts, vals) if t >= s.t - 2000]
                rate, changes = motion.rates(ts[-400:], vals[-400:])
                m = tracker.motion()
                if m is None:
                    continue
                phase = "still ref " if tracker.baseline_std is None else ("MOVING    " if m.moving else "still     ")
                bar = "#" * min(40, int(m.score * 8))
                print(f"{(s.t - t_start) / 1000:6.1f}s  {phase} rssi {s.rssi:4d} dBm  "
                      f"mean {sum(recent) / len(recent):6.1f} std {motion.spread(recent):4.2f}  "
                      f"score {m.score:5.2f} {bar:<40}  {rate:4.0f} reads/s, {changes:4.1f} changes/s"
                      f"  noise {s.noise} tx {s.tx_mbps} ch {s.channel} ({s.band} GHz)", flush=True)
                if args.seconds and (s.t - t_start) / 1000 > args.seconds:
                    break
    except KeyboardInterrupt:
        pass
    if len(ts) > 1:
        rate, changes = motion.rates(ts, vals)
        print(f"\n{len(ts)} readings in {(ts[-1] - ts[0]) / 1000:.1f} s: {rate:.0f} reads/s, "
              f"{changes:.1f} value changes/s, still spread {tracker.baseline_std} dB")


if __name__ == "__main__":
    main()
