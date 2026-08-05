"""Background transfer jobs (download / upload).

Each job runs the heavy work (huggingface_hub / lerobot) in a **subprocess**
(`python -m backend.worker`) so torch / lerobot never get imported into the
web-server process, a crash or OOM can't take the server down, and the job can
be cancelled by killing the process. The subprocess streams progress to stdout,
which a reader thread tails into the job's in-memory log.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

PROJECT_ROOT = Path(__file__).resolve().parent.parent
MAX_LOG_LINES = 500


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
    status: str = "running"   # running | success | error | cancelled
    started_at: float = field(default_factory=time.time)
    ended_at: Optional[float] = None
    returncode: Optional[int] = None
    log: list[str] = field(default_factory=list)
    _proc: Optional[subprocess.Popen] = field(default=None, repr=False)
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def add_log(self, line: str) -> None:
        with self._lock:
            self.log.append(line)
            if len(self.log) > MAX_LOG_LINES:
                # keep the tail
                del self.log[: len(self.log) - MAX_LOG_LINES]

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
            "status": self.status,
            "started_at": self.started_at,
            "ended_at": self.ended_at,
            "returncode": self.returncode,
            "log": tail,
            "log_lines": len(self.log),
        }


class JobManager:
    def __init__(self) -> None:
        self._jobs: dict[str, Job] = {}
        self._lock = threading.Lock()

    def start(self, *, kind: str, mode: str = "", repo_id: str = "", repo_type: str = "",
              local_dir: str = "", private: bool = False, label: str = "", **extra) -> Job:
        job = Job(
            id=uuid.uuid4().hex[:12],
            kind=kind, mode=mode, repo_id=repo_id, repo_type=repo_type,
            local_dir=local_dir, private=private, label=label, spec=extra,
        )
        with self._lock:
            self._jobs[job.id] = job

        spec = {
            "kind": kind, "mode": mode, "repo_id": repo_id,
            "repo_type": repo_type, "local_dir": local_dir, "private": private,
            **extra,
        }
        spec_file = Path(tempfile.gettempdir()) / f"hfutil_job_{job.id}.json"
        spec_file.write_text(json.dumps(spec), encoding="utf-8")

        threading.Thread(target=self._run, args=(job, spec_file), daemon=True).start()
        return job

    def _run(self, job: Job, spec_file: Path) -> None:
        import os

        env = os.environ.copy()
        env["PYTHONUNBUFFERED"] = "1"
        env["PYTHONIOENCODING"] = "utf-8"
        # hf_transfer can hang on process teardown on Windows; keep the stable path.
        env["HF_HUB_ENABLE_HF_TRANSFER"] = "0"
        job.add_log(f"$ {sys.executable} -m backend.worker  ({job.kind}/{job.mode})")
        try:
            proc = subprocess.Popen(
                [sys.executable, "-m", "backend.worker", str(spec_file)],
                cwd=str(PROJECT_ROOT),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                # Worker emits UTF-8 (PYTHONIOENCODING); decode it as UTF-8 here too.
                # Without this the parent uses the Windows ANSI codepage (e.g. cp949)
                # and a UnicodeDecodeError on tqdm block chars would kill this reader
                # thread, leaving the job stuck "running" forever.
                encoding="utf-8",
                errors="replace",
                bufsize=1,
                env=env,
            )
        except Exception as exc:
            job.add_log(f"failed to start worker: {exc}")
            job.status = "error"
            job.ended_at = time.time()
            return

        job._proc = proc
        try:
            assert proc.stdout is not None
            for raw in proc.stdout:
                # tqdm uses \r to redraw; keep only the latest fragment of each chunk
                line = raw.rstrip("\n").split("\r")[-1].rstrip()
                if line:
                    job.add_log(line)
            proc.wait()
            job.returncode = proc.returncode
        except Exception as exc:
            job.add_log(f"reader error: {exc!r}")
            try:
                proc.kill()
            except Exception:
                pass
        finally:
            # Always reach a terminal status so the UI never hangs on "running".
            if job.status != "cancelled":
                job.status = "success" if job.returncode == 0 else "error"
            job.ended_at = time.time()
            try:
                spec_file.unlink(missing_ok=True)
            except Exception:
                pass

    def cancel(self, job_id: str) -> bool:
        job = self._jobs.get(job_id)
        if not job or job.status != "running" or job._proc is None:
            return False
        job.status = "cancelled"
        job.add_log("— cancelled by user —")
        try:
            job._proc.terminate()
        except Exception:
            pass
        return True

    def clear_finished(self) -> int:
        with self._lock:
            done = [j.id for j in self._jobs.values() if j.status != "running"]
            for job_id in done:
                del self._jobs[job_id]
        return len(done)

    def get(self, job_id: str) -> Optional[Job]:
        return self._jobs.get(job_id)

    def list(self) -> list[Job]:
        with self._lock:
            return sorted(self._jobs.values(), key=lambda j: j.started_at, reverse=True)


JOBS = JobManager()
