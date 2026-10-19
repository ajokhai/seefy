"""Background jobs (map building, reprocessing, joining scans) that the app can show and control.

Each job runs in its own child process, so it can be paused, resumed or cancelled without
freezing the server, and its CPU and memory can be measured on their own. The processing
limits (resources.plan) apply to the whole child: thread counts, and low priority via macOS
background mode, which the child's worker threads inherit.

A job's work is a function named as "package.module:function", called in the child as
fn(progress, **kwargs). progress(stage, fraction) reports what it's doing, with fraction in
0..1 or None when unknown. Whatever fn returns (JSON-friendly) becomes the job's result.

    runner = JobRunner(on_change=broadcast)          # on_change(snapshot) after every change
    jid = runner.submit("build", "Building the bedroom map", "seefy.reconstruct:build_job",
                        {"scan_id": sid}, plan=resources.plan(cfg["processing"]))
    runner.pause(jid); runner.resume(jid); runner.cancel(jid)
    runner.snapshot() -> [{id, kind, label, state, stage, progress, elapsed_s, eta_s, cpu_pct, ram_mb, ...}]

States: queued, running, paused, done, failed, cancelled. Jobs run one at a time by default.
"""

from __future__ import annotations

import importlib
import itertools
import multiprocessing as mp
import os
import signal
import subprocess
import sys
import threading
import time
import traceback
from dataclasses import dataclass, field

from . import resources

ACTIVE = ("running", "paused")
_PRIO_DARWIN_PROCESS = 4  # setpriority "which" for a whole process on macOS
_PRIO_DARWIN_BG = 0x1000
ETA_MIN_PROGRESS = 0.05  # below this, an estimate of time left is mostly noise
ETA_MIN_ELAPSED_S = 10.0


@dataclass
class Job:
    id: str
    kind: str
    label: str
    target: str
    kwargs: dict
    plan: dict
    state: str = "queued"
    stage: str = "Waiting to start"
    progress: float | None = None
    created: float = field(default_factory=time.time)
    started: float | None = None
    finished: float | None = None
    paused_s: float = 0.0
    _paused_at: float | None = None
    cpu_pct: float | None = None  # 100 = one full core
    ram_mb: float | None = None
    peak_ram_mb: float = 0.0
    error: str = ""
    result: object = None
    proc: object = None  # multiprocessing.Process

    def elapsed_s(self, now: float) -> float:
        if self.started is None:
            return 0.0
        end = self.finished or now
        paused = self.paused_s + ((now - self._paused_at) if self._paused_at else 0.0)
        return max(0.0, end - self.started - paused)

    def eta_s(self, now: float) -> float | None:
        """Rough time left from the average pace so far; None until there's enough to go on."""
        if self.state not in ACTIVE or not self.progress or self.progress < ETA_MIN_PROGRESS:
            return None
        done = self.elapsed_s(now)
        if done < ETA_MIN_ELAPSED_S:
            return None
        return max(0.0, done * (1.0 - self.progress) / self.progress)

    def view(self, now: float) -> dict:
        return {"id": self.id, "kind": self.kind, "label": self.label, "state": self.state, "stage": self.stage,
                "progress": None if self.progress is None else round(self.progress, 3),
                "elapsed_s": round(self.elapsed_s(now), 1),
                "eta_s": None if (eta := self.eta_s(now)) is None else round(eta), "cpu_pct": self.cpu_pct, "ram_mb": self.ram_mb,
                "peak_ram_mb": round(self.peak_ram_mb), "cores_limit": self.plan.get("num_threads"),
                "background": bool(self.plan.get("background")), "error": self.error,
                "pid": self.proc.pid if self.proc is not None and self.state in ACTIVE else None,
                "created": self.created, "started": self.started, "finished": self.finished}


def _child_main(target: str, kwargs: dict, plan: dict, q) -> None:
    """Runs in the child process."""
    if plan.get("background"):
        try:
            if sys.platform == "darwin":
                os.setpriority(_PRIO_DARWIN_PROCESS, 0, _PRIO_DARWIN_BG)
            else:
                os.nice(10)
        except (OSError, AttributeError):
            pass

    def progress(stage: str, fraction: float | None = None) -> None:
        q.put(("progress", stage, None if fraction is None else max(0.0, min(1.0, float(fraction)))))

    try:
        mod, _, name = target.partition(":")
        fn = getattr(importlib.import_module(mod), name)
        q.put(("done", fn(progress, plan=plan, **kwargs)))
    except Exception as exc:  # noqa: BLE001 - reported to the user, not swallowed
        q.put(("error", f"{exc.__class__.__name__}: {exc}", traceback.format_exc()))


def _ps(pid: int) -> tuple[float, float] | None:
    """(cpu %, resident MB) of a process and its children, via ps; None if it's gone."""
    try:
        out = subprocess.run(["ps", "-o", "pid=,ppid=,pcpu=,rss=", "-A"], capture_output=True, text=True,
                             timeout=2).stdout
    except (OSError, subprocess.TimeoutExpired):
        return None
    rows = [r.split() for r in out.splitlines() if r.strip()]
    procs = {int(r[0]): (int(r[1]), float(r[2]), float(r[3])) for r in rows if len(r) == 4}
    if pid not in procs:
        return None
    family, grew = {pid}, True
    while grew:
        grew = False
        for p, (pp, _, _) in procs.items():
            if pp in family and p not in family:
                family.add(p)
                grew = True
    cpu = sum(procs[p][1] for p in family)
    rss_mb = sum(procs[p][2] for p in family) / 1024  # ps reports KB
    return cpu, rss_mb


class JobRunner:
    def __init__(self, on_change=None, max_concurrent: int = 1, keep_finished: int = 20, poll_s: float = 1.0):
        self._ctx = mp.get_context("spawn")
        self._jobs: dict[str, Job] = {}
        self._order: list[str] = []
        self._lock = threading.RLock()
        self._ids = itertools.count(1)
        self.on_change = on_change
        self.max_concurrent = max_concurrent
        self.keep_finished = keep_finished
        self.poll_s = poll_s
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._loop, name="seefy-jobs", daemon=True)
        self._thread.start()

    # -- public ------------------------------------------------------------------------------------------

    def submit(self, kind: str, label: str, target: str, kwargs: dict | None = None, plan: dict | None = None) -> str:
        jid = f"j{next(self._ids)}-{int(time.time())}"
        job = Job(id=jid, kind=kind, label=label, target=target, kwargs=dict(kwargs or {}),
                  plan=plan or resources.plan())
        with self._lock:
            self._jobs[jid] = job
            self._order.append(jid)
        self._changed()
        return jid

    def pause(self, jid: str) -> bool:
        with self._lock:
            job = self._jobs.get(jid)
            if not job or job.state != "running":
                return False
            os.kill(job.proc.pid, signal.SIGSTOP)
            job.state, job._paused_at, job.cpu_pct = "paused", time.time(), 0.0
        self._changed()
        return True

    def resume(self, jid: str) -> bool:
        with self._lock:
            job = self._jobs.get(jid)
            if not job or job.state != "paused":
                return False
            os.kill(job.proc.pid, signal.SIGCONT)
            job.paused_s += time.time() - (job._paused_at or time.time())
            job.state, job._paused_at = "running", None
        self._changed()
        return True

    def cancel(self, jid: str) -> bool:
        with self._lock:
            job = self._jobs.get(jid)
            if not job or job.state not in ("queued", *ACTIVE):
                return False
            if job.state == "queued":
                job.state, job.finished = "cancelled", time.time()
            else:
                proc = job.proc
                if job.state == "paused":
                    job.paused_s += time.time() - (job._paused_at or time.time())
                    job._paused_at = None
                    os.kill(proc.pid, signal.SIGCONT)  # a stopped process can't act on SIGTERM
                proc.terminate()
                job.state, job.finished, job.stage = "cancelled", time.time(), "Cancelled"
        if job.proc is not None:
            job.proc.join(timeout=3)
            if job.proc.is_alive():
                job.proc.kill()
        self._changed()
        return True

    def pause_all(self) -> int:
        return sum(self.pause(j["id"]) for j in self.snapshot() if j["state"] == "running")

    def resume_all(self) -> int:
        return sum(self.resume(j["id"]) for j in self.snapshot() if j["state"] == "paused")

    def get(self, jid: str) -> dict | None:
        with self._lock:
            job = self._jobs.get(jid)
            return None if job is None else {**job.view(time.time()), "result": job.result}

    def snapshot(self) -> list[dict]:
        now = time.time()
        with self._lock:
            return [self._jobs[j].view(now) for j in self._order]

    def wait(self, jid: str, timeout: float | None = None) -> dict | None:
        """Block until a job finishes (for tests and scripts)."""
        end = None if timeout is None else time.monotonic() + timeout
        while end is None or time.monotonic() < end:
            j = self.get(jid)
            if j and j["state"] in ("done", "failed", "cancelled"):
                return j
            time.sleep(0.05)
        return self.get(jid)

    def shutdown(self) -> None:
        for j in self.snapshot():
            if j["state"] in ("queued", *ACTIVE):
                self.cancel(j["id"])
        self._stop.set()
        self._thread.join(timeout=3)

    # -- internals ---------------------------------------------------------------------------------------

    def _changed(self) -> None:
        if self.on_change:
            try:
                self.on_change(self.snapshot())
            except Exception:  # noqa: BLE001 - a broken listener mustn't stop the runner
                pass

    def _start(self, job: Job) -> None:
        q = self._ctx.Queue()
        job.proc = self._ctx.Process(target=_child_main, args=(job.target, job.kwargs, job.plan, q),
                                     name=f"seefy-{job.kind}", daemon=True)
        job.proc.start()
        job._q = q
        job.state, job.started, job.stage = "running", time.time(), "Starting"

    def _loop(self) -> None:
        last_stats = 0.0
        while not self._stop.is_set():
            changed = False
            with self._lock:
                jobs = [self._jobs[j] for j in self._order]
                for job in jobs:
                    if job.state not in ACTIVE:
                        continue
                    q = job._q
                    while True:
                        try:
                            msg = q.get_nowait()
                        except Exception:  # queue.Empty, or the queue closed under us
                            break
                        changed = True
                        if msg[0] == "progress":
                            job.stage, job.progress = msg[1], msg[2] if msg[2] is not None else job.progress
                        elif msg[0] == "done":
                            job.state, job.result, job.progress, job.stage = "done", msg[1], 1.0, "Done"
                            job.finished = time.time()
                        elif msg[0] == "error":
                            job.state, job.error, job.stage = "failed", msg[1], "Failed"
                            job.finished = time.time()
                    if job.state in ACTIVE and not job.proc.is_alive():
                        job.state, job.finished = "failed", time.time()
                        job.error = job.error or f"stopped unexpectedly (exit code {job.proc.exitcode})"
                        job.stage = "Failed"
                        changed = True
                running = sum(1 for j in jobs if j.state in ACTIVE)
                for job in jobs:
                    if running >= self.max_concurrent:
                        break
                    if job.state == "queued":
                        self._start(job)
                        running += 1
                        changed = True
                finished = [j for j in self._order if self._jobs[j].state in ("done", "failed", "cancelled")]
                for jid in finished[:-self.keep_finished] if len(finished) > self.keep_finished else []:
                    self._order.remove(jid)
                    del self._jobs[jid]
            now = time.monotonic()
            if now - last_stats >= self.poll_s:
                last_stats = now
                with self._lock:
                    for job in self._jobs.values():
                        if job.state == "running" and job.proc is not None:
                            s = _ps(job.proc.pid)
                            if s:
                                job.cpu_pct, job.ram_mb = round(s[0]), round(s[1])
                                job.peak_ram_mb = max(job.peak_ram_mb, s[1])
                                changed = True
            if changed:
                self._changed()
            self._stop.wait(0.1)


def demo_work(progress, plan=None, seconds: float = 1.0, steps: int = 10, fail: bool = False, burn: bool = False):
    """A stand-in job for tests and for trying the UI: reports progress through a few stages."""
    for i in range(steps):
        progress(["Finding features", "Matching photos", "Placing the camera"][i * 3 // steps], i / steps)
        end = time.monotonic() + seconds / steps
        while time.monotonic() < end:
            if burn:
                sum(k * k for k in range(2000))
            else:
                time.sleep(0.01)
        if fail and i == steps // 2:
            raise RuntimeError("demo failure")
    return {"ok": True, "steps": steps, "threads": (plan or {}).get("num_threads")}
