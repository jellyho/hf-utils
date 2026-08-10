"""Background transfer jobs (download / upload).

Each job runs the heavy work (huggingface_hub / lerobot) in a **subprocess**
(`python -m backend.worker`) so torch / lerobot never get imported into the
web-server process, a crash or OOM can't take the server down, and the job can
be cancelled by killing the process.

**The worker writes its log to a file, not to a pipe.** That is deliberate and was
learned the hard way: with `stdout=PIPE`, the pipe's only reader is this server. Kill
the server mid-transfer and nobody drains the pipe, so its 64 KB buffer fills with tqdm
redraws, the writing thread blocks forever, and every download thread deadlocks behind
it -- a 20-minute-old, 82 GB download that will never advance another byte and never
exit. A file has no reader to lose: the worker keeps downloading whatever happens here,
and this process just tails the file.

That also makes jobs **survivable**. Each job's record and log live under
``$HFUTIL_STATE_DIR`` (default ``~/.hfutil/jobs``), so restarting the server no longer
loses the Jobs tab, and a worker that outlived its server is re-adopted on startup
rather than vanishing from the UI while it is still running.
"""

from __future__ import annotations

import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

PROJECT_ROOT = Path(__file__).resolve().parent.parent
MAX_LOG_LINES = 500          # kept in memory; the file on disk keeps everything

# Workers print this prefix followed by a path to report a file they produced.
ARTIFACT_PREFIX = "@@artifact@@"

STATE_DIR = Path(
    os.environ.get("HFUTIL_STATE_DIR", Path.home() / ".hfutil")
).expanduser()
JOBS_DIR = STATE_DIR / "jobs"

# tqdm redraws with \r and never emits \n, so both characters end a display line.
_LINE_SPLIT = re.compile(r"[\r\n]")

# Terminal statuses. "interrupted" means the server went away while the job was running
# and the worker is no longer around either -- distinct from "error" (the worker ran and
# failed) because the fix is simply to run it again.
RUNNING, SUCCESS, ERROR, CANCELLED, INTERRUPTED = (
    "running", "success", "error", "cancelled", "interrupted")


def _pid_alive(pid: Optional[int]) -> bool:
    """Is this pid still running? POSIX only -- see adopt()."""
    if not pid:
        return False
    if os.name == "nt":
        return False
    try:
        os.kill(pid, 0)          # signal 0 = existence check, delivers nothing
    except ProcessLookupError:
        return False
    except PermissionError:
        return True              # exists, owned by someone else
    return True


def _is_our_worker(pid: int, job_id: str) -> bool:
    """Guard against pid reuse: only adopt a process that really is this job's worker."""
    try:
        cmdline = Path(f"/proc/{pid}/cmdline").read_bytes().decode("utf-8", "replace")
    except OSError:
        return False
    return "backend.worker" in cmdline and job_id in cmdline


@dataclass
class Job:
    id: str
    kind: str          # "download" | "upload" | "ds_render" | …
    mode: str = ""     # "generic" | "lerobot"
    repo_id: str = ""
    repo_type: str = ""     # "model" | "dataset"
    local_dir: str = ""
    private: bool = False
    label: str = ""    # what the UI shows; falls back to repo_id
    spec: dict = field(default_factory=dict)   # extra, kind-specific fields
    outputs: list[str] = field(default_factory=list)   # files the job produced
    status: str = RUNNING
    started_at: float = field(default_factory=time.time)
    ended_at: Optional[float] = None
    returncode: Optional[int] = None
    pid: Optional[int] = None
    log: list[str] = field(default_factory=list)
    adopted: bool = False       # re-attached on startup rather than spawned by us
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    @property
    def log_path(self) -> Path:
        return JOBS_DIR / f"{self.id}.log"

    @property
    def record_path(self) -> Path:
        return JOBS_DIR / f"{self.id}.json"

    @property
    def spec_path(self) -> Path:
        return JOBS_DIR / f"{self.id}.spec.json"

    def add_log(self, line: str) -> None:
        with self._lock:
            self.log.append(line)
            if len(self.log) > MAX_LOG_LINES:
                del self.log[: len(self.log) - MAX_LOG_LINES]   # keep the tail

    def save(self) -> None:
        """Persist everything except the log, which is already a file."""
        try:
            JOBS_DIR.mkdir(parents=True, exist_ok=True)
            tmp = self.record_path.with_suffix(".json.tmp")
            tmp.write_text(json.dumps({
                "id": self.id, "kind": self.kind, "mode": self.mode,
                "repo_id": self.repo_id, "repo_type": self.repo_type,
                "local_dir": self.local_dir, "private": self.private,
                "label": self.label, "spec": self.spec, "outputs": self.outputs,
                "status": self.status, "started_at": self.started_at,
                "ended_at": self.ended_at, "returncode": self.returncode,
                "pid": self.pid,
            }), encoding="utf-8")
            os.replace(tmp, self.record_path)      # never a half-written record
        except OSError:
            pass    # a job that cannot be persisted still has to run

    @classmethod
    def from_record(cls, data: dict) -> "Job":
        job = cls(
            id=data["id"], kind=data.get("kind", ""), mode=data.get("mode", ""),
            repo_id=data.get("repo_id", ""), repo_type=data.get("repo_type", ""),
            local_dir=data.get("local_dir", ""), private=bool(data.get("private")),
            label=data.get("label", ""), spec=data.get("spec") or {},
            outputs=list(data.get("outputs") or []),
            status=data.get("status", INTERRUPTED),
            started_at=data.get("started_at") or time.time(),
            ended_at=data.get("ended_at"), returncode=data.get("returncode"),
            pid=data.get("pid"),
        )
        # Only the tail matters for display, and the file can be hundreds of MB.
        try:
            lines = job.log_path.read_text(encoding="utf-8", errors="replace")
            job.log = [l for l in _LINE_SPLIT.split(lines) if l.strip()][-MAX_LOG_LINES:]
        except OSError:
            pass
        return job

    def public(self, log_tail: int = 60) -> dict:
        with self._lock:
            tail = self.log[-log_tail:] if log_tail else list(self.log)
        return {
            "id": self.id,
            "kind": self.kind,
            "mode": self.mode,
            "repo_id": self.repo_id,
            "repo_type": self.repo_type,
            "local_dir": self.local_dir,
            "private": self.private,
            "label": self.label or self.repo_id,
            "outputs": list(self.outputs),
            "status": self.status,
            "started_at": self.started_at,
            "ended_at": self.ended_at,
            "returncode": self.returncode,
            "adopted": self.adopted,
            "log": tail,
            "log_lines": len(self.log),
        }


class JobManager:
    def __init__(self) -> None:
        self._jobs: dict[str, Job] = {}
        self._lock = threading.Lock()

    # ----------------------------------------------------------------- start
    def start(self, *, kind: str, mode: str = "", repo_id: str = "", repo_type: str = "",
              local_dir: str = "", private: bool = False, label: str = "", **extra) -> Job:
        job = Job(
            id=uuid.uuid4().hex[:12],
            kind=kind, mode=mode, repo_id=repo_id, repo_type=repo_type,
            local_dir=local_dir, private=private, label=label, spec=extra,
        )
        with self._lock:
            self._jobs[job.id] = job

        JOBS_DIR.mkdir(parents=True, exist_ok=True)
        job.spec_path.write_text(json.dumps({
            "kind": kind, "mode": mode, "repo_id": repo_id,
            "repo_type": repo_type, "local_dir": local_dir, "private": private,
            **extra,
        }), encoding="utf-8")
        job.save()

        threading.Thread(target=self._run, args=(job,), daemon=True).start()
        return job

    def _run(self, job: Job) -> None:
        env = os.environ.copy()
        env["PYTHONUNBUFFERED"] = "1"
        env["PYTHONIOENCODING"] = "utf-8"
        # hf_transfer can hang on process teardown on Windows; keep the stable path.
        env["HF_HUB_ENABLE_HF_TRANSFER"] = "0"

        try:
            log_fh = job.log_path.open("w", encoding="utf-8", errors="replace")
        except OSError as exc:
            job.add_log(f"cannot open log file: {exc}")
            job.status = ERROR
            job.ended_at = time.time()
            job.save()
            return

        job.add_log(f"$ {sys.executable} -m backend.worker  ({job.kind}/{job.mode})")
        try:
            with log_fh:
                proc = subprocess.Popen(
                    [sys.executable, "-m", "backend.worker", str(job.spec_path)],
                    cwd=str(PROJECT_ROOT),
                    # A file, not a pipe: the worker must never block on a reader that
                    # might not be there. See this module's docstring.
                    stdout=log_fh,
                    stderr=subprocess.STDOUT,
                    env=env,
                )
                job.pid = proc.pid
                job.save()
                tail = threading.Thread(target=self._tail, args=(job,), daemon=True)
                tail.start()
                proc.wait()
                job.returncode = proc.returncode
                tail.join(timeout=5)
        except Exception as exc:
            job.add_log(f"failed to run worker: {exc}")
        finally:
            # Always reach a terminal status so the UI never hangs on "running".
            if job.status not in (CANCELLED,):
                job.status = SUCCESS if job.returncode == 0 else ERROR
            job.ended_at = time.time()
            job.pid = None
            job.save()
            try:
                job.spec_path.unlink(missing_ok=True)
            except OSError:
                pass

    # ------------------------------------------------------------------ tail
    def _tail(self, job: Job) -> None:
        """Stream the worker's log file into the in-memory tail the UI reads."""
        pos, buf = 0, ""
        while True:
            running = job.status == RUNNING and (job.pid is None or _pid_alive(job.pid))
            chunk = ""
            try:
                with job.log_path.open("r", encoding="utf-8", errors="replace") as fh:
                    fh.seek(pos)
                    chunk = fh.read()
                    pos = fh.tell()
            except OSError:
                pass

            if chunk:
                buf += chunk
                parts = _LINE_SPLIT.split(buf)
                buf = parts.pop()                  # keep the incomplete trailing fragment
                for line in parts:
                    line = line.rstrip()
                    if not line:
                        continue
                    # Workers announce files they produced on a sentinel line; that is
                    # metadata, not log output.
                    if line.startswith(ARTIFACT_PREFIX):
                        path = line[len(ARTIFACT_PREFIX):].strip()
                        if path and path not in job.outputs:
                            job.outputs.append(path)
                        continue
                    job.add_log(line)
                continue          # there may be more waiting; don't sleep yet

            if not running:
                if buf.strip():
                    job.add_log(buf.strip())
                return
            time.sleep(0.4)

    # ----------------------------------------------------------------- adopt
    def load_persisted(self) -> int:
        """Re-load jobs from disk at startup, adopting any worker that outlived us.

        A job whose worker is still running keeps its "running" status and gets a fresh
        tail thread, so it reappears in the UI mid-transfer instead of silently vanishing.
        One whose worker is gone becomes "interrupted" — a terminal status the UI offers
        Resume on, which for a download continues from the files already on disk.

        Liveness is a POSIX check (``os.kill(pid, 0)`` plus a /proc cmdline match to rule
        out pid reuse). On Windows every previously-running job is marked interrupted
        instead — one needless resume of an already-complete download is a far better
        failure than adopting the wrong process.
        """
        if not JOBS_DIR.is_dir():
            return 0
        loaded = 0
        for record in sorted(JOBS_DIR.glob("*.json")):
            if record.name.endswith(".spec.json"):
                continue
            try:
                job = Job.from_record(json.loads(record.read_text(encoding="utf-8")))
            except (OSError, ValueError, KeyError):
                continue
            if job.status == RUNNING:
                if job.pid and _pid_alive(job.pid) and _is_our_worker(job.pid, job.id):
                    job.adopted = True
                    job.add_log("— server restarted; re-attached to the running worker —")
                    threading.Thread(target=self._watch_adopted, args=(job,),
                                     daemon=True).start()
                else:
                    job.status = INTERRUPTED
                    job.ended_at = job.ended_at or time.time()
                    job.pid = None
                    job.add_log("— interrupted: the server stopped while this was running —")
                    job.save()
            with self._lock:
                self._jobs[job.id] = job
            loaded += 1
        return loaded

    def _watch_adopted(self, job: Job) -> None:
        """Tail an adopted worker and notice when it exits.

        It is not our child, so there is no returncode to wait for — the worker's own
        last log line is the only signal, which is why success is inferred from it.
        """
        threading.Thread(target=self._tail, args=(job,), daemon=True).start()
        while _pid_alive(job.pid) and job.status == RUNNING:
            time.sleep(1.5)
        if job.status == RUNNING:
            tail = " ".join(job.log[-3:])
            job.status = SUCCESS if ("done ->" in tail or "pushed" in tail) else ERROR
            job.ended_at = time.time()
            job.pid = None
            job.save()

    # ---------------------------------------------------------------- control
    def cancel(self, job_id: str) -> bool:
        job = self._jobs.get(job_id)
        if not job or job.status != RUNNING or not job.pid:
            return False
        job.status = CANCELLED
        job.add_log("— cancelled by user —")
        try:
            os.kill(job.pid, signal.SIGTERM)     # works for adopted workers too
        except OSError:
            pass
        job.ended_at = time.time()
        job.save()
        return True

    def restart(self, job_id: str) -> Optional[Job]:
        """Run a finished job's spec again, as a new job.

        For a download this resumes rather than restarts: huggingface_hub keeps each
        partial file as ``<local_dir>/.cache/huggingface/download/*.incomplete`` and
        picks it up where it stopped, and files that are already complete are skipped
        outright -- so an interrupted 190 GB pull continues instead of starting over.
        Nothing here has to know that; re-running the same spec is enough, which is also
        why it is safe for the other job kinds.

        Returns the new job, or None if the id is unknown or that job is still running.
        """
        old = self._jobs.get(job_id)
        if old is None or old.status == RUNNING:
            return None
        return self.start(
            kind=old.kind, mode=old.mode, repo_id=old.repo_id, repo_type=old.repo_type,
            local_dir=old.local_dir, private=old.private, label=old.label, **old.spec,
        )

    def _forget(self, job: Job) -> None:
        """Delete a job's stored record, log and spec. Never touches transferred files."""
        for path in (job.record_path, job.log_path, job.spec_path):
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass

    def remove(self, job_id: str):
        """Drop one job. None if unknown, False if still running, True if removed."""
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return None
            if job.status == RUNNING:
                return False
            del self._jobs[job_id]
        self._forget(job)
        return True

    def clear_finished(self) -> int:
        with self._lock:
            done = [j for j in self._jobs.values() if j.status != RUNNING]
            for job in done:
                del self._jobs[job.id]
        for job in done:
            self._forget(job)
        return len(done)

    def get(self, job_id: str) -> Optional[Job]:
        return self._jobs.get(job_id)

    def list(self) -> list[Job]:
        with self._lock:
            return sorted(self._jobs.values(), key=lambda j: j.started_at, reverse=True)


JOBS = JobManager()
JOBS.load_persisted()
