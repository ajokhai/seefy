import pycolmap

from seefy import resources


def test_balanced_uses_half_the_cores(monkeypatch):
    monkeypatch.setattr(resources, "cores", lambda: 10)
    p = resources.plan()
    assert p["preset"] == "balanced" and p["num_threads"] == 5


def test_overrides_and_bounds(monkeypatch):
    monkeypatch.setattr(resources, "cores", lambda: 10)
    assert resources.plan({"preset": "light"})["num_threads"] == 2  # 25% of 10, rounded
    assert resources.plan({"preset": "full"})["num_threads"] == 10
    assert resources.plan({"cpu_share": 0.0})["num_threads"] == 1  # never zero
    assert resources.plan({"cpu_share": 7})["num_threads"] == 10  # clamped
    p = resources.plan({"preset": "light", "photo_px": 1024, "background": False})
    assert (p["photo_px"], p["features"], p["background"]) == (1024, 4000, False)
    assert resources.plan({"preset": "nonsense"})["preset"] == "balanced"


def test_apply_sets_pycolmap_options(monkeypatch):
    monkeypatch.setattr(resources, "cores", lambda: 10)
    p = resources.plan({"preset": "light"})
    ext, match = pycolmap.FeatureExtractionOptions(), pycolmap.FeatureMatchingOptions()
    pair, pipe = pycolmap.SequentialPairingOptions(), pycolmap.IncrementalPipelineOptions()
    resources.apply(p, ext, match, pair, pipe, None)
    assert ext.num_threads == match.num_threads == pair.num_threads == pipe.num_threads == 2
    assert ext.max_image_size == 960 and ext.sift.max_num_features == 4000


def test_worker_measures_and_restores_priority():
    p = resources.plan({"preset": "light"})
    with resources.worker(p) as m:
        sum(i * i for i in range(200_000))
    r = m.report()
    assert r["wall_s"] > 0 and r["cpu_s"] >= 0 and r["peak_ram_mb"] > 0


def test_gate_spaces_out_live_updates():
    g = resources.Gate({"live_every_s": 5.0})
    assert g.ready(100.0) and not g.ready(103.0) and g.ready(105.0)


def test_docs_cover_every_setting():
    assert set(resources.DEFAULTS) <= set(resources.DOCS)
