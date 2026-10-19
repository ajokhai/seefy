from seefy import quality


def _result(level="enough", size=(3.5, 4.0), registered=180, total=200, measured=False, scale="accelerometer (0.8)"):
    return {
        "coverage": {"level": level, "hints": ["Turn to face the window side"], "gap_heading_deg": 90.0},
        "layout": {"ok": True, "size_m": list(size), "confidence": "good"},
        "registered": registered, "total": total, "scale_method": scale,
        **({"size_source": "measured"} if measured else {}),
    }


def test_good_scan():
    r = quality.apply(_result())
    assert r["quality"]["verdict"] == "good" and r["layout"]["confidence"] == "good"


def test_small_room_is_weak_and_caps_confidence():
    r = quality.apply(_result(size=(1.3, 1.6)))
    q = r["quality"]
    assert q["verdict"] == "weak" and q["reasons"][0]["code"] == "small"
    assert r["layout"]["confidence"] == "low" and "1.3 × 1.6" in r["layout"]["confidence_reason"]


def test_measured_small_room_is_believed():
    assert quality.assess(_result(size=(1.5, 1.8), measured=True))["verdict"] == "good"


def test_short_coverage_and_few_frames():
    q = quality.assess(_result(level="short", registered=50))
    assert q["verdict"] == "weak"
    assert [r["code"] for r in q["reasons"]][:2] == ["coverage", "few_frames"]
    assert q["missing_heading_deg"] == 90.0


def test_estimated_size_is_mentioned_but_not_weak():
    q = quality.assess(_result(scale="assumed camera height 1.35 m"))
    assert q["verdict"] == "good" and q["reasons"][-1]["code"] == "size_estimated"
