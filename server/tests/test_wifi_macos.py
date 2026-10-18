"""Live check of the macOS link-RSSI source. Runs only on a Mac with SEEFY_WIFI_LIVE=1, since it
compiles the Swift helper and reads the real WiFi interface."""

import os
import sys
import time

import pytest

from seefy.wifi import available, open_source

live = pytest.mark.skipif(sys.platform != "darwin" or not os.environ.get("SEEFY_WIFI_LIVE"),
                          reason="needs a Mac and SEEFY_WIFI_LIVE=1")


@live
def test_streams_real_samples():
    assert "macos-link-rssi" in available()
    with open_source(interval_ms=10) as src:
        time.sleep(2.0)
        got = src.recent(2000)
    assert len(got) >= 20, src.error
    assert all(-100 < s.rssi < 0 for s in got)
    assert got[-1].t > got[0].t
