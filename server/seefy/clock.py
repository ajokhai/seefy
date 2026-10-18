"""The host clock every device is synced to."""

import time


def host_ms() -> float:
    """Monotonic milliseconds. All recorded timestamps use this timeline."""
    return time.monotonic_ns() / 1e6
