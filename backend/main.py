"""HF Util — local GUI backend.

A small FastAPI app that wraps huggingface_hub so you can list, delete,
rename, and re-scope your own models / datasets / collections in bulk
instead of clicking through the website one repo at a time.

The Hugging Face token is read automatically from the local HF cache
(`huggingface-cli login`), so no secret is stored in this repo.
The server binds to 127.0.0.1 only — it is meant to run on your machine.
"""

from __future__ import annotations

import os
import sys
from datetime import datetime
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal, Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from huggingface_hub import HfApi
from huggingface_hub.utils import HfHubHTTPError

from .jobs import JOBS
from .routes_dataset import router as dataset_router

PROJECT_ROOT = Path(__file__).resolve().parent.parent
FRONTEND_DIR = PROJECT_ROOT / "frontend"

# Where a relative local_dir lands. Deliberately *outside* the checkout: model repos run to
# tens of GB apiece, and burying them in the source tree makes every `git status` walk them,
# puts them in the blast radius of a `git clean`, and quietly hides them from disk accounting.
DOWNLOAD_ROOT = Path(
    os.environ.get("HFUTIL_DOWNLOAD_ROOT", Path.home() / "hf_utils_downloads")
).expanduser()

RepoType = Literal["model", "dataset"]
# huggingface_hub uses "models"/"datasets" in URLs but "model"/"dataset" in the API.
_URL_SEGMENT = {"model": "", "dataset": "datasets/"}

app = FastAPI(title="HF Util", version="0.2.0")


# --------------------------------------------------------------------------- #
# HF client helpers
# --------------------------------------------------------------------------- #
@lru_cache(maxsize=1)
def get_api() -> HfApi:
    return HfApi()


@lru_cache(maxsize=1)
def get_username() -> str:
    try:
        return get_api().whoami()["name"]
    except Exception as exc:  # not logged in / no token
        raise HTTPException(
            status_code=401,
            detail=(
                "Not authenticated. Run `huggingface-cli login` (or `hf auth login`) "
                f"and restart the server. Original error: {exc}"
            ),
        )


def _iso(dt: Any) -> Optional[str]:
    return dt.isoformat() if isinstance(dt, datetime) else None


def _repo_url(repo_id: str, repo_type: RepoType) -> str:
    return f"https://huggingface.co/{_URL_SEGMENT[repo_type]}{repo_id}"


def _serialize_repo(info: Any, repo_type: RepoType) -> dict:
    repo_id = info.id
    name = repo_id.split("/", 1)[-1]
    return {
        "id": repo_id,
        "name": name,
        "private": bool(getattr(info, "private", False)),
        "gated": getattr(info, "gated", None),
        "downloads": getattr(info, "downloads", None),
        "likes": getattr(info, "likes", None),
        "lastModified": _iso(getattr(info, "lastModified", None)),
        "url": _repo_url(repo_id, repo_type),
    }


def _hf_error(exc: Exception) -> str:
    """Best-effort human-readable message from an HF exception."""
    msg = str(exc).strip()
    return msg or exc.__class__.__name__


# --------------------------------------------------------------------------- #
# Request models
# --------------------------------------------------------------------------- #
class DeleteReposBody(BaseModel):
    repo_type: RepoType
    ids: list[str]


class VisibilityBody(BaseModel):
    repo_type: RepoType
    id: str
    private: bool


class RenameBody(BaseModel):
    repo_type: RepoType
    id: str
    new_name: str  # new repo name (without namespace)


class DeleteCollectionsBody(BaseModel):
    slugs: list[str]


class UpdateCollectionBody(BaseModel):
    slug: str
    title: Optional[str] = None
    description: Optional[str] = None
    private: Optional[bool] = None


class RemoveCollectionItemBody(BaseModel):
    slug: str
    item_object_id: str


# --------------------------------------------------------------------------- #
# API — identity
# --------------------------------------------------------------------------- #
@app.get("/api/whoami")
def whoami() -> dict:
    api = get_api()
    me = api.whoami()
    return {
        "name": me.get("name"),
        "fullname": me.get("fullname"),
        "email": me.get("email"),
        "type": me.get("type"),
        "avatar": me.get("avatarUrl"),
    }


@app.get("/api/config")
def config() -> dict:
    """Server-side settings the UI needs. Deliberately makes no Hub call.

    The download root used to ride along on /api/whoami. That tied it to being logged in: an
    expired token or an unreachable Hub left the UI with no root at all, and a download form
    whose parent folder was the empty string -- which joins to the filesystem root. Where
    files land must not depend on authentication.
    """
    return {"download_root": str(DOWNLOAD_ROOT)}


# --------------------------------------------------------------------------- #
# API — repos (models & datasets)
# --------------------------------------------------------------------------- #
@app.get("/api/repos")
def list_repos(repo_type: RepoType) -> dict:
    api = get_api()
    author = get_username()
    expand = ["private", "downloads", "likes", "lastModified", "gated"]
    try:
        if repo_type == "model":
            it = api.list_models(author=author, expand=expand)
        else:
            it = api.list_datasets(author=author, expand=expand)
        items = [_serialize_repo(x, repo_type) for x in it]
    except HfHubHTTPError as exc:
        raise HTTPException(status_code=502, detail=_hf_error(exc))
    items.sort(key=lambda r: r["lastModified"] or "", reverse=True)
    return {"author": author, "repo_type": repo_type, "count": len(items), "items": items}


@app.post("/api/repos/delete")
def delete_repos(body: DeleteReposBody) -> dict:
    api = get_api()
    results = []
    for repo_id in body.ids:
        try:
            api.delete_repo(repo_id=repo_id, repo_type=body.repo_type, missing_ok=True)
            results.append({"id": repo_id, "ok": True})
        except Exception as exc:
            results.append({"id": repo_id, "ok": False, "error": _hf_error(exc)})
    return {"results": results, "ok_count": sum(r["ok"] for r in results)}


@app.post("/api/repos/visibility")
def set_visibility(body: VisibilityBody) -> dict:
    api = get_api()
    try:
        api.update_repo_settings(
            repo_id=body.id, repo_type=body.repo_type, private=body.private
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=_hf_error(exc))
    return {"id": body.id, "private": body.private, "ok": True}


@app.post("/api/repos/rename")
def rename_repo(body: RenameBody) -> dict:
    api = get_api()
    author = get_username()
    new_name = body.new_name.strip().strip("/")
    if not new_name or "/" in new_name:
        raise HTTPException(status_code=400, detail="New name must be a single path segment.")
    to_id = f"{author}/{new_name}"
    if to_id == body.id:
        return {"from": body.id, "to": to_id, "ok": True, "unchanged": True}
    try:
        api.move_repo(from_id=body.id, to_id=to_id, repo_type=body.repo_type)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=_hf_error(exc))
    return {"from": body.id, "to": to_id, "ok": True}


# --------------------------------------------------------------------------- #
# API — collections
# --------------------------------------------------------------------------- #
def _serialize_collection(col: Any, with_items: bool = False) -> dict:
    data = {
        "slug": col.slug,
        "title": col.title,
        "description": col.description or "",
        "private": bool(getattr(col, "private", False)),
        "upvotes": getattr(col, "upvotes", None),
        "url": getattr(col, "url", None) or f"https://huggingface.co/collections/{col.slug}",
        "item_count": len(col.items) if getattr(col, "items", None) is not None else None,
    }
    if with_items:
        data["items"] = [
            {
                "item_object_id": it.item_object_id,
                "item_id": it.item_id,
                "item_type": it.item_type,
                "note": getattr(it, "note", None),
                "position": getattr(it, "position", None),
            }
            for it in (col.items or [])
        ]
    return data


@app.get("/api/collections")
def list_collections() -> dict:
    api = get_api()
    author = get_username()
    try:
        cols = list(api.list_collections(owner=author))
    except HfHubHTTPError as exc:
        raise HTTPException(status_code=502, detail=_hf_error(exc))
    items = [_serialize_collection(c) for c in cols]
    return {"author": author, "count": len(items), "items": items}


@app.get("/api/collection")
def get_collection_detail(slug: str) -> dict:
    api = get_api()
    try:
        col = api.get_collection(slug)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=_hf_error(exc))
    return _serialize_collection(col, with_items=True)


@app.post("/api/collections/delete")
def delete_collections(body: DeleteCollectionsBody) -> dict:
    api = get_api()
    results = []
    for slug in body.slugs:
        try:
            api.delete_collection(slug, missing_ok=True)
            results.append({"slug": slug, "ok": True})
        except Exception as exc:
            results.append({"slug": slug, "ok": False, "error": _hf_error(exc)})
    return {"results": results, "ok_count": sum(r["ok"] for r in results)}


@app.post("/api/collections/update")
def update_collection(body: UpdateCollectionBody) -> dict:
    api = get_api()
    kwargs: dict[str, Any] = {}
    if body.title is not None:
        kwargs["title"] = body.title
    if body.description is not None:
        kwargs["description"] = body.description
    if body.private is not None:
        kwargs["private"] = body.private
    if not kwargs:
        raise HTTPException(status_code=400, detail="Nothing to update.")
    try:
        col = api.update_collection_metadata(body.slug, **kwargs)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=_hf_error(exc))
    return {"ok": True, "collection": _serialize_collection(col)}


@app.post("/api/collections/remove-item")
def remove_collection_item(body: RemoveCollectionItemBody) -> dict:
    api = get_api()
    try:
        api.delete_collection_item(
            collection_slug=body.slug,
            item_object_id=body.item_object_id,
            missing_ok=True,
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=_hf_error(exc))
    return {"ok": True}


# --------------------------------------------------------------------------- #
# Transfer — download / upload (LeRobot-aware), run as background jobs
# --------------------------------------------------------------------------- #
def _resolve_dir(p: str) -> str:
    path = Path(p).expanduser()
    if not path.is_absolute():
        path = DOWNLOAD_ROOT / path
    return str(path)


class DownloadBody(BaseModel):
    repo_id: str
    repo_type: RepoType = "dataset"
    local_dir: str
    use_lerobot: bool = False
    # Partial download. Only files matching one of these globs are fetched; empty means the
    # whole repo. The UI builds them from a checkbox tree, so each entry is either an exact
    # file path or "<folder>/**" — it never asks the user to write a pattern by hand.
    allow_patterns: Optional[list[str]] = None
    # What the UI showed in its preview. Only used to label the job, so the Jobs tab can say
    # "12 of 340 files" instead of leaving a partial download indistinguishable from a full one.
    selected_files: Optional[int] = None
    selected_bytes: Optional[int] = None


class UploadBody(BaseModel):
    repo_id: str
    repo_type: RepoType = "dataset"
    local_dir: str
    private: bool = False
    use_lerobot: bool = False


@app.get("/api/detect/hub")
def detect_hub(repo_id: str, repo_type: RepoType = "dataset") -> dict:
    """Is this Hub repo a LeRobot dataset? (has meta/info.json)"""
    if repo_type != "dataset":
        return {"lerobot": False, "reason": "not a dataset"}
    try:
        exists = get_api().file_exists(repo_id, "meta/info.json", repo_type="dataset")
    except Exception as exc:
        return {"lerobot": False, "error": _hf_error(exc)}
    return {"lerobot": bool(exists)}


@app.get("/api/detect/local")
def detect_local(path: str) -> dict:
    """Is this local folder a LeRobot dataset? (has meta/info.json)"""
    base = Path(_resolve_dir(path))
    return {
        "resolved": str(base),
        "exists": base.exists(),
        "lerobot": (base / "meta" / "info.json").is_file(),
    }


def _fmt_bytes(n: Optional[int]) -> str:
    if not n:
        return ""
    size = float(n)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if size < 1000 or unit == "TB":
            return f"{size:.0f} {unit}" if unit == "B" else f"{size:.1f} {unit}"
        size /= 1000.0
    return ""


# A checkpoint repo with one folder per training step can hold a few thousand files; a
# LeRobot dataset with per-episode parquet runs higher still. Past this the picker stops
# being usable anyway, so cut it off and say so rather than shipping a 50 MB JSON payload.
MAX_TREE_FILES = 20_000


@app.get("/api/repo/files")
def repo_files(repo_id: str, repo_type: RepoType = "model",
               revision: Optional[str] = None) -> dict:
    """Every file in a Hub repo, with its size — the input to the download picker.

    Flat rather than nested: the tree the UI draws is one grouping pass over this, and a flat
    list keeps the payload small and the response shape independent of how it gets displayed.
    """
    from huggingface_hub.hf_api import RepoFile

    files: list[dict] = []
    truncated = False
    try:
        for item in get_api().list_repo_tree(
            repo_id, repo_type=repo_type, revision=revision, recursive=True
        ):
            if not isinstance(item, RepoFile):   # RepoFolder — the paths already carry it
                continue
            if len(files) >= MAX_TREE_FILES:
                truncated = True
                break
            files.append({"path": item.path, "size": int(item.size or 0)})
    except Exception as exc:
        raise HTTPException(status_code=502, detail=_hf_error(exc))

    files.sort(key=lambda f: f["path"])
    return {
        "repo_id": repo_id,
        "repo_type": repo_type,
        "count": len(files),
        "total_bytes": sum(f["size"] for f in files),
        "truncated": truncated,
        "files": files,
    }


@app.post("/api/transfer/download")
def transfer_download(body: DownloadBody) -> dict:
    mode = "lerobot" if body.use_lerobot else "generic"
    patterns = [p.strip() for p in (body.allow_patterns or []) if p.strip()]
    if patterns and mode == "lerobot":
        # LeRobotDataset() validates and materialises the whole dataset; handing it a subset
        # would produce a folder that fails its own consistency checks. Refuse rather than
        # silently download everything after the user picked a subset.
        raise HTTPException(
            status_code=400,
            detail="File filters apply to plain Hub downloads only — "
                   "a LeRobot download always fetches the whole dataset.",
        )

    label = body.repo_id
    if patterns:
        n = body.selected_files
        size = _fmt_bytes(body.selected_bytes)
        label = (f"{body.repo_id} ({n} file{'' if n == 1 else 's'}"
                 f"{', ' + size if size else ''})") if n else f"{body.repo_id} (partial)"

    job = JOBS.start(
        kind="download", mode=mode, repo_id=body.repo_id,
        repo_type=body.repo_type, local_dir=_resolve_dir(body.local_dir),
        label=label, allow_patterns=patterns or None,
    )
    return job.public()


@app.post("/api/transfer/upload")
def transfer_upload(body: UploadBody) -> dict:
    mode = "lerobot" if body.use_lerobot else "generic"
    repo_type = "dataset" if mode == "lerobot" else body.repo_type
    job = JOBS.start(
        kind="upload", mode=mode, repo_id=body.repo_id, repo_type=repo_type,
        local_dir=_resolve_dir(body.local_dir), private=body.private,
    )
    return job.public()


@app.get("/api/jobs")
def jobs_list() -> dict:
    return {"jobs": [j.public(log_tail=8) for j in JOBS.list()]}


@app.post("/api/jobs/clear")
def jobs_clear() -> dict:
    """Drop every job that has already finished. Running jobs are untouched."""
    return {"removed": JOBS.clear_finished()}


@app.get("/api/jobs/{job_id}")
def job_get(job_id: str) -> dict:
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job not found")
    return job.public(log_tail=200)


@app.post("/api/jobs/{job_id}/cancel")
def job_cancel(job_id: str) -> dict:
    if not JOBS.cancel(job_id):
        raise HTTPException(status_code=409, detail="job not running / not cancellable")
    return {"ok": True}


@app.post("/api/jobs/{job_id}/resume")
def job_resume(job_id: str) -> dict:
    """Run a finished job again. Downloads continue from their partial files."""
    job = JOBS.restart(job_id)
    if job is None:
        raise HTTPException(status_code=409, detail="unknown job, or it is still running")
    return {"ok": True, "id": job.id}


# --------------------------------------------------------------------------- #
# Local filesystem browsing (for the folder picker) — 127.0.0.1 only
# --------------------------------------------------------------------------- #
_MAX_FILES = 300


def _drives() -> list[str]:
    if os.name != "nt":
        return []
    try:
        return list(os.listdrives())  # py3.12+
    except Exception:
        import string
        return [f"{c}:\\" for c in string.ascii_uppercase if os.path.exists(f"{c}:\\")]


@app.get("/api/fs/list")
def fs_list(path: str = "") -> dict:
    home = str(Path.home())
    drives = _drives()

    # empty path == "This PC" (drive list on Windows; home on POSIX)
    if not path:
        if drives:
            return {"path": "", "display": "This PC", "parent": None, "home": home,
                    "sep": os.sep, "drives": drives,
                    "dirs": [{"name": d, "path": d} for d in drives],
                    "files": [], "files_truncated": False, "is_lerobot": False}
        path = home

    try:
        base = Path(path).expanduser()
        if not base.is_absolute():
            base = DOWNLOAD_ROOT / base
        base = base.resolve(strict=False)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"bad path: {exc}")

    if not base.is_dir():
        raise HTTPException(status_code=404, detail=f"not a directory: {base}")

    dirs: list[dict] = []
    files: list[dict] = []
    try:
        entries = sorted(os.scandir(base), key=lambda e: e.name.lower())
    except PermissionError:
        raise HTTPException(status_code=403, detail=f"permission denied: {base}")
    for entry in entries:
        try:
            if entry.is_dir():
                dirs.append({"name": entry.name, "path": str(Path(entry.path))})
            elif entry.is_file() and len(files) < _MAX_FILES:
                files.append({"name": entry.name})
        except OSError:
            continue

    parent: Optional[str] = str(base.parent)
    if base.parent == base:  # drive / fs root -> go to "This PC"
        parent = "" if drives else None

    return {
        "path": str(base), "display": str(base), "parent": parent, "home": home,
        "sep": os.sep, "drives": drives,
        "dirs": dirs, "files": files,
        "files_truncated": len(files) >= _MAX_FILES,
        "is_lerobot": (base / "meta" / "info.json").is_file(),
    }


class OpenBody(BaseModel):
    path: str


@app.post("/api/fs/reveal")
def fs_reveal(body: OpenBody) -> dict:
    """Open a folder in the OS file manager (Explorer / Finder / xdg-open).

    Only ever opens a *directory* that already exists — never executes a file — and the
    server is bound to 127.0.0.1, so this cannot be triggered from another machine.
    """
    import shutil
    import subprocess

    target = Path(body.path).expanduser()
    if target.is_file():
        target = target.parent
    if not target.is_dir():
        raise HTTPException(status_code=404, detail=f"no such folder: {target}")

    try:
        if os.name == "nt":
            os.startfile(str(target))  # noqa: S606 — a directory, not a program
        elif sys.platform == "darwin":
            subprocess.Popen(["open", str(target)])
        else:
            opener = shutil.which("xdg-open") or shutil.which("gio")
            if not opener:
                raise HTTPException(status_code=501, detail="no xdg-open on this system")
            subprocess.Popen([opener, str(target)])
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"could not open folder: {exc}")
    return {"ok": True, "path": str(target)}


class MkdirBody(BaseModel):
    path: str
    name: str


@app.post("/api/fs/mkdir")
def fs_mkdir(body: MkdirBody) -> dict:
    name = body.name.strip().strip("/\\")
    if not name or any(c in name for c in '<>:"/\\|?*'):
        raise HTTPException(status_code=400, detail="invalid folder name")
    base = Path(body.path).expanduser()
    if not base.is_absolute():
        base = DOWNLOAD_ROOT / base
    target = base / name
    try:
        target.mkdir(parents=False, exist_ok=True)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"could not create folder: {exc}")
    return {"path": str(target.resolve(strict=False))}


# --------------------------------------------------------------------------- #
# Error shaping + static frontend
# --------------------------------------------------------------------------- #
@app.exception_handler(HTTPException)
async def http_exc_handler(_req, exc: HTTPException):
    return JSONResponse(status_code=exc.status_code, content={"error": exc.detail})


app.include_router(dataset_router)

# Mounted LAST so /api/* routes above take precedence.
app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")


# 8000 collides with almost every other dev server; this one is far less contested.
DEFAULT_PORT = 8765
PORT_SCAN = 20      # how many ports to try before giving up


def _port_free(host: str, port: int) -> bool:
    import socket

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        # No SO_REUSEADDR: we want to know whether anything is actually listening.
        try:
            sock.bind((host, port))
            return True
        except OSError:
            return False


def pick_port(host: str, preferred: int) -> int:
    """The requested port, or the next free one after it."""
    for candidate in range(preferred, preferred + PORT_SCAN):
        if _port_free(host, candidate):
            return candidate
    raise SystemExit(
        f"no free port in {preferred}..{preferred + PORT_SCAN - 1}; "
        f"pass --port or set HFUTIL_PORT")


def main(argv: Optional[list[str]] = None) -> None:
    import argparse
    import threading
    import uvicorn

    parser = argparse.ArgumentParser(prog="hf-util", description="Local GUI for HF repos and LeRobot datasets")
    parser.add_argument("--port", type=int, default=int(os.environ.get("HFUTIL_PORT") or DEFAULT_PORT),
                        help=f"port to serve on (default {DEFAULT_PORT}, or $HFUTIL_PORT)")
    parser.add_argument("--host", default=os.environ.get("HFUTIL_HOST", "127.0.0.1"),
                        help="interface to bind (default 127.0.0.1)")
    parser.add_argument("--no-browser", action="store_true", help="don't open a browser window")
    parser.add_argument("--exact-port", action="store_true",
                        help="fail instead of moving to the next free port")
    args = parser.parse_args(argv)

    port = args.port if args.exact_port else pick_port(args.host, args.port)
    if port != args.port:
        print(f"port {args.port} is in use — using {port} instead")
    url = f"http://{args.host}:{port}"
    print(f"HF Util at {url}")

    if not args.no_browser:
        # Opened from a timer so the browser doesn't race the server's first bind.
        import webbrowser

        threading.Timer(1.0, lambda: webbrowser.open(url)).start()

    uvicorn.run(app, host=args.host, port=port)


if __name__ == "__main__":
    main()
