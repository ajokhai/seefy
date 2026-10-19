import time

import pytest

from seefy import jobs, resources

DEMO = "seefy.jobs:demo_work"


@pytest.fixture
def runner():
    seen = []
    r = jobs.JobRunner(on_change=seen.append, poll_s=0.2)
    r.seen = seen
    yield r
    r.shutdown()


def test_job_runs_in_a_child_and_reports_progress(runner):
    jid = runner.submit("build", "Building the bedroom map", DEMO, {"seconds": 0.6}, plan=resources.plan({"preset": "light"}))
    j = runner.wait(jid, timeout=20)
    assert j["state"] == "done" and j["progress"] == 1.0
    assert j["result"]["ok"] and j["result"]["threads"] == resources.plan({"preset": "light"})["num_threads"]
    stages = {v["stage"] for snap in runner.seen for v in snap if v["id"] == jid}
    assert "Matching photos" in stages and "Done" in stages


def test_failure_is_reported_not_swallowed(runner):
    j = runner.wait(runner.submit("build", "x", DEMO, {"seconds": 0.4, "fail": True}), timeout=20)
    assert j["state"] == "failed" and "demo failure" in j["error"]


def test_pause_freezes_the_child_and_resume_continues(runner):
    t0 = time.time()
    jid = runner.submit("build", "x", DEMO, {"seconds": 3.0})
    while runner.get(jid)["state"] != "running" or runner.get(jid)["progress"] is None:
        time.sleep(0.05)
    assert runner.pause(jid)
    p1 = runner.get(jid)["progress"]
    time.sleep(1.5)
    j = runner.get(jid)
    assert j["state"] == "paused" and j["progress"] == p1
    assert runner.resume(jid)
    j = runner.wait(jid, timeout=30)
    assert j["state"] == "done"
    assert j["elapsed_s"] <= (time.time() - t0) - 1.4  # the 1.5 s pause isn't counted


def test_cancel_running_and_queued(runner):
    a = runner.submit("build", "a", DEMO, {"seconds": 10})
    b = runner.submit("build", "b", DEMO, {"seconds": 10})  # queued: one job at a time
    while runner.get(a)["state"] != "running":
        time.sleep(0.05)
    assert runner.get(b)["state"] == "queued"
    assert runner.cancel(b) and runner.get(b)["state"] == "cancelled"
    assert runner.pause(a) and runner.cancel(a)  # cancelling a paused job works too
    assert runner.get(a)["state"] == "cancelled"


def test_stats_are_measured_while_running(runner):
    jid = runner.submit("build", "x", DEMO, {"seconds": 2.0, "burn": True})
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        j = runner.get(jid)
        if j["ram_mb"]:
            break
        time.sleep(0.1)
    assert j["ram_mb"] and j["ram_mb"] > 5 and j["cpu_pct"] is not None
    assert j["pid"] and j["cores_limit"] >= 1
    runner.wait(jid, timeout=20)
