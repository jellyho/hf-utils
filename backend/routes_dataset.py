"""API routes for local LeRobot datasets (viewer / editor / renderer / annotator).

Everything here reads with pyarrow only — no lerobot, no torch in the web process.
Mutating operations go through the existing subprocess job runner (backend.jobs).
"""

from __future__ import annotations

from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from hfutil.dataset import meta as dsmeta
from hfutil.dataset import video as dsvideo

from .jobs import JOBS

router = APIRouter(prefix="/api/ds", tags=["dataset"])


def _root(path: str) -> Path:
    try:
        return dsmeta.resolve_root(path)
    except dsmeta.DatasetError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


def _info(root: Path) -> dict:
    try:
        return dsmeta.read_info(root)
    except dsmeta.UnsupportedVersion as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except dsmeta.DatasetError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/capabilities")
def capabilities() -> dict:
    return dsvideo.capabilities()


@router.get("/open")
def open_dataset(root: str) -> dict:
    base = _root(root)
    _info(base)  # surface an unsupported version as 422 before the heavier read
    try:
        return dsmeta.describe(base)
    except dsmeta.DatasetError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/episodes")
def list_episodes(root: str, offset: int = 0, limit: Optional[int] = None) -> dict:
    """All episodes by default.

    `limit` is opt-in: defaulting it would silently truncate large datasets, since the
    viewer loads the list in one shot and keys its filter/keyboard navigation off it.
    """
    base = _root(root)
    info = _info(base)
    try:
        rows = dsmeta.episodes(base, info)
    except dsmeta.DatasetError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    offset = max(0, offset)
    window = rows[offset: offset + limit] if limit is not None else rows[offset:]
    return {"total": len(rows), "offset": offset, "items": window}


@router.get("/video")
def get_video(
    root: str,
    key: str,
    chunk: int = 0,
    file: int = 0,
) -> FileResponse:
    """Serve a camera's shared MP4.

    Starlette's FileResponse implements HTTP Range (206) itself, which is what makes
    per-episode playback possible without cutting clips: the browser seeks to the
    episode's from_timestamp and only fetches the bytes it plays.
    """
    base = _root(root)
    info = _info(base)
    if key not in dsmeta.camera_keys(info):
        raise HTTPException(status_code=404, detail=f"no such camera: {key}")

    # safe_join keeps the path inside the dataset dir (see hfutil.dataset.video).
    try:
        path = dsvideo.video_file(base, info, key, chunk, file)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if path.suffix.lower() != ".mp4":
        raise HTTPException(status_code=400, detail="not an mp4")
    if not path.is_file():
        raise HTTPException(status_code=404, detail=f"missing video file: {path.name}")

    return FileResponse(
        path,
        media_type="video/mp4",
        headers={"Accept-Ranges": "bytes", "Cache-Control": "private, max-age=3600"},
    )


@router.get("/videoprobe")
def probe_video(root: str, key: str, chunk: int = 0, file: int = 0) -> dict:
    base = _root(root)
    info = _info(base)
    try:
        path = dsvideo.video_file(base, info, key, chunk, file)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if not path.is_file():
        raise HTTPException(status_code=404, detail=f"missing video file: {path.name}")
    return dsvideo.probe(path)


class RenderBody(BaseModel):
    root: str
    episodes: list[int]
    out_dir: Optional[str] = None
    cameras: list[str] = Field(default_factory=list)   # [] = all, in meta order
    speed: float = 1.0
    height: int = 320
    fps_cap: int = 60
    frame_start: int = 0
    frame_end: Optional[int] = None
    fmt: str = "mp4"
    gif_fps: int = 12
    gif_width: int = 640
    show_camera_labels: bool = True
    show_counter: bool = True
    show_task: bool = False
    write_metadata: bool = True


@router.post("/render")
def render(body: RenderBody) -> dict:
    base = _root(body.root)
    info = _info(base)
    if not body.episodes:
        raise HTTPException(status_code=400, detail="no episodes selected")
    if body.fmt not in ("mp4", "gif"):
        raise HTTPException(status_code=400, detail="fmt must be mp4 or gif")
    if not dsvideo.find_ffmpeg():
        raise HTTPException(
            status_code=503,
            detail="ffmpeg not found — install it on PATH or `pip install imageio-ffmpeg`",
        )

    known = set(dsmeta.camera_keys(info))
    unknown = [c for c in body.cameras if c not in known]
    if unknown:
        raise HTTPException(status_code=400, detail=f"unknown camera(s): {unknown}")

    # Renders go OUTSIDE the dataset folder by default, so they never ride along on a
    # subsequent push_to_hub.
    out_dir = Path(body.out_dir).expanduser() if body.out_dir else base.parent / f"{base.name}_renders"

    options = body.model_dump(exclude={"root", "episodes", "out_dir"})
    job = JOBS.start(
        kind="ds_render",
        label=f"{base.name} · {len(body.episodes)} ep → {body.fmt}",
        local_dir=str(out_dir),
        ds_root=str(base),
        dataset_name=base.name,
        episodes=body.episodes,
        out_dir=str(out_dir),
        options=options,
    )
    return job.public()


@router.get("/series")
def get_series(
    root: str,
    ep: int,
    keys: str = Query(..., description="comma-separated feature keys"),
    max_points: int = 1500,
) -> dict:
    base = _root(root)
    wanted = [k.strip() for k in keys.split(",") if k.strip()]
    try:
        return dsmeta.series(base, ep, wanted, max_points=max_points)
    except dsmeta.DatasetError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
