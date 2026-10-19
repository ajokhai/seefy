import json

import pytest

from seefy import storage


def _scan(data, sid, status="done", photos=3):
    d = data / "scans" / sid
    (d / "frames").mkdir(parents=True)
    for i in range(photos):
        (d / "frames" / f"{i:05d}.jpg").write_bytes(b"x" * 1000)
    (d / "recon" / "model").mkdir(parents=True)
    (d / "recon" / "sparse").mkdir()
    (d / "recon" / "database.db").write_bytes(b"d" * 5000)
    (d / "recon" / "sparse" / "points3D.bin").write_bytes(b"s" * 200)
    (d / "recon" / "model" / "points3D.bin").write_bytes(b"m" * 300)
    (d / "recon" / "result.json").write_text('{"ok": true}')
    (d / "meta.json").write_text(json.dumps({"id": sid, "status": status}))
    return d


def test_usage_counts_what_trimming_frees(tmp_path):
    _scan(tmp_path, "20261019-003058")
    _scan(tmp_path, "20261019-005352", photos=10)
    u = storage.usage(tmp_path)
    assert [s["id"] for s in u["scans"]] == ["20261019-005352", "20261019-003058"]  # newest first
    first = u["scans"][1]
    assert first["freeable_bytes"] == 3000 + 5000 + 200
    assert first["kept_bytes"] == first["bytes"] - first["freeable_bytes"]
    assert u["disk_free_bytes"] > 0


def test_trim_keeps_the_finished_map(tmp_path):
    d = _scan(tmp_path, "s1")
    r = storage.trim_scan(tmp_path, "s1")
    assert r["freed_bytes"] == 8200 and r["undo"]
    assert not (d / "frames").exists() and not (d / "recon" / "database.db").exists()
    assert (d / "recon" / "result.json").exists() and (d / "recon" / "model" / "points3D.bin").exists()
    assert json.loads((d / "meta.json").read_text())["trimmed"] is True
    assert storage.scan_usage(tmp_path, "s1")["freeable_bytes"] == 0
    again = storage.trim_scan(tmp_path, "s1")  # trimming twice is harmless
    assert again["freed_bytes"] == 0 and again["undo"] is None


def test_trim_then_undo_puts_everything_back(tmp_path):
    d = _scan(tmp_path, "s1")
    r = storage.trim_scan(tmp_path, "s1")
    storage.restore(tmp_path, r["undo"])
    assert len(list((d / "frames").iterdir())) == 3 and (d / "recon" / "database.db").exists()
    assert "trimmed" not in json.loads((d / "meta.json").read_text())
    assert storage.usage(tmp_path)["trash_bytes"] == 0


def test_delete_then_undo_and_purge(tmp_path):
    d = _scan(tmp_path, "s1")
    r = storage.delete_scan(tmp_path, "s1")
    assert r["freed_bytes"] > 8000 and not d.exists()
    assert storage.usage(tmp_path)["trash_bytes"] > 8000  # space comes back only after purge
    storage.restore(tmp_path, r["undo"])
    assert (d / "frames" / "00000.jpg").exists()
    r = storage.delete_scan(tmp_path, "s1")
    assert storage.purge_trash(tmp_path, older_than_s=3600)["freed_bytes"] == 0  # still in the undo window
    assert storage.purge_trash(tmp_path)["freed_bytes"] > 8000
    with pytest.raises(storage.StorageError):
        storage.restore(tmp_path, r["undo"])


@pytest.mark.parametrize("status", ["recording", "processing"])
def test_busy_scans_are_refused(tmp_path, status):
    d = _scan(tmp_path, "s1", status=status)
    with pytest.raises(storage.StorageError):
        storage.trim_scan(tmp_path, "s1")
    with pytest.raises(storage.StorageError):
        storage.delete_scan(tmp_path, "s1")
    assert (d / "frames").exists()


@pytest.mark.parametrize("sid", ["../metrics", "..", "", "a/b", "nope"])
def test_only_real_scans_inside_the_scans_folder(tmp_path, sid):
    _scan(tmp_path, "s1")
    (tmp_path / "metrics").mkdir()
    with pytest.raises(storage.StorageError):
        storage.delete_scan(tmp_path, sid)
    assert (tmp_path / "metrics").exists()


def test_human_sizes():
    assert storage.human(404_000_000) == "404 MB"
    assert storage.human(2_100_000_000) == "2.1 GB"
    assert storage.human(512) == "512 bytes"
