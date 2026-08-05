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
        path = PROJECT_ROOT / path
    return str(path)


class DownloadBody(BaseModel):
    repo_id: str
    repo_type: RepoType = "dataset"
    local_dir: str
    use_lerobot: bool = False


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


@app.post("/api/transfer/download")
def transfer_download(body: DownloadBody) -> dict:
    mode = "lerobot" if body.use_lerobot else "generic"
    job = JOBS.start(
        kind="download", mode=mode, repo_id=body.repo_id,
        repo_type=body.repo_type, local_dir=_resolve_dir(body.local_dir),
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
            base = PROJECT_ROOT / base
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
        base = PROJECT_ROOT / base
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


def main() -> None:
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8000)


if __name__ == "__main__":
    main()
