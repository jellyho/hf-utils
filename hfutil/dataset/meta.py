"""Read LeRobot v3.0 dataset metadata with pyarrow only.

Why not use ``LeRobotDataset``?

* ``LeRobotDatasetMetadata.__init__`` falls back to ``snapshot_download()`` when a local
  dataset fails to parse — a hidden network call inside a request handler.
* It memory-maps an Arrow cache, which keeps file handles open. On Windows that makes the
  ``os.replace(dataset_dir, backup)`` used by the editor fail.
* Importing it pulls in torch (seconds, ~1 GB RSS) into the web process.

So everything here is plain ``json`` + ``pyarrow``. The on-disk layout is read from the
templates in ``meta/info.json`` (``data_path`` / ``video_path``) rather than hardcoded,
which is what makes this work across LeRobot's layout changes.
"""

from __future__ import annotations

import json
import math
import os
from pathlib import Path
from typing import Any, Iterable, Optional

import pyarrow.parquet as pq

SUPPORTED_VERSION = "v3.0"

# Columns that describe the frame's position, not its content — never plottable.
_INDEX_COLUMNS = {"index", "episode_index", "frame_index", "task_index", "timestamp"}
_NUMERIC_DTYPES = {"float16", "float32", "float64", "int16", "int32", "int64", "bool"}
_MAX_PLOT_DIMS = 64


class DatasetError(Exception):
    """A dataset could not be read."""


class UnsupportedVersion(DatasetError):
    """The dataset uses a codebase_version this reader does not handle."""


# --------------------------------------------------------------------------- #
# small helpers
# --------------------------------------------------------------------------- #
def _s(value: Any) -> str:
    """Decode a task/label that LeRobot may have stored as bytes."""
    if isinstance(value, (bytes, bytearray)):
        return value.decode("utf-8", "replace")
    return str(value)


def _feature_names(feat: dict) -> Optional[list[str]]:
    """LeRobot allows ``names`` to be a list, a {"motors": [...]} dict, or null."""
    names = feat.get("names")
    if isinstance(names, dict):
        for value in names.values():
            if isinstance(value, list):
                return [_s(n) for n in value]
        return None
    if isinstance(names, list):
        # Video features use names like ["height", "width", "channels"] — not labels.
        return [_s(n) for n in names]
    return None


def _dims(feat: dict) -> int:
    shape = feat.get("shape") or [1]
    try:
        return int(shape[0]) if len(shape) == 1 else int(math.prod(shape))
    except (TypeError, ValueError):
        return 1


# --------------------------------------------------------------------------- #
# root + info
# --------------------------------------------------------------------------- #
def resolve_root(path: str | os.PathLike) -> Path:
    """Expand/absolutise ``path`` and verify it looks like a LeRobot dataset."""
    root = Path(os.path.expanduser(str(path))).resolve(strict=False)
    if not root.is_dir():
        raise DatasetError(f"not a directory: {root}")
    if not (root / "meta" / "info.json").is_file():
        raise DatasetError(f"not a LeRobot dataset (no meta/info.json): {root}")
    return root


# Cache parsed metadata, invalidated by the mtime of the files it was built from.
# Plain dicts only — never Arrow tables/mmaps, which would hold the directory open.
_CACHE: dict[str, tuple[float, Any]] = {}


def _meta_stamp(root: Path) -> float:
    """Newest mtime across the metadata that the caches are derived from."""
    newest = 0.0
    info = root / "meta" / "info.json"
    if info.exists():
        newest = info.stat().st_mtime
    eps_dir = root / "meta" / "episodes"
    if eps_dir.is_dir():
        for p in eps_dir.rglob("*.parquet"):
            newest = max(newest, p.stat().st_mtime)
    return newest


def _cached(root: Path, key: str, build):
    stamp = _meta_stamp(root)
    ck = f"{root}::{key}"
    hit = _CACHE.get(ck)
    if hit and hit[0] == stamp:
        return hit[1]
    value = build()
    _CACHE[ck] = (stamp, value)
    return value


def read_info(root: Path) -> dict:
    """Parse ``meta/info.json`` and reject formats this reader can't handle."""
    def build() -> dict:
        raw = (root / "meta" / "info.json").read_text(encoding="utf-8")
        info = json.loads(raw)
        version = str(info.get("codebase_version", "")).strip()
        if version != SUPPORTED_VERSION:
            raise UnsupportedVersion(
                f'This dataset is codebase_version "{version or "unknown"}". '
                f"The viewer supports {SUPPORTED_VERSION} only. Convert it with:\n"
                f"  python -m lerobot.datasets.v30.convert_dataset_v21_to_v30 --repo-id=<repo_id>"
            )
        return info

    return _cached(root, "info", build)


# --------------------------------------------------------------------------- #
# feature introspection (this is what makes the tool dataset-agnostic)
# --------------------------------------------------------------------------- #
def camera_keys(info: dict) -> list[str]:
    """Feature keys backed by video, in info.json order."""
    return [k for k, v in (info.get("features") or {}).items() if v.get("dtype") == "video"]


def image_keys(info: dict) -> list[str]:
    """Feature keys backed by loose image files (not supported by the player)."""
    return [k for k, v in (info.get("features") or {}).items() if v.get("dtype") == "image"]


def plottable_features(info: dict) -> list[dict]:
    """Numeric 1-D features worth charting, with legend labels."""
    out: list[dict] = []
    for key, feat in (info.get("features") or {}).items():
        if key in _INDEX_COLUMNS:
            continue
        dtype = feat.get("dtype")
        shape = feat.get("shape") or []
        if dtype not in _NUMERIC_DTYPES or len(shape) != 1:
            continue
        dims = _dims(feat)
        if dims > _MAX_PLOT_DIMS:
            continue
        names = _feature_names(feat)
        if not names or len(names) != dims:
            names = [f"d{i}" for i in range(dims)]
        out.append({"key": key, "dims": dims, "dtype": dtype, "names": names})
    return out


# --------------------------------------------------------------------------- #
# episodes
# --------------------------------------------------------------------------- #
def _episode_files(root: Path) -> list[Path]:
    eps_dir = root / "meta" / "episodes"
    if not eps_dir.is_dir():
        raise DatasetError(f"no episode metadata under {eps_dir}")
    files = sorted(eps_dir.rglob("*.parquet"))
    if not files:
        raise DatasetError(f"no episode metadata parquet under {eps_dir}")
    return files


def episodes(root: Path, info: Optional[dict] = None) -> list[dict]:
    """All episode rows, normalised. ``stats/*`` columns are skipped (large + unused)."""
    info = info or read_info(root)
    cams = camera_keys(info)

    def build() -> list[dict]:
        rows: list[dict] = []
        for path in _episode_files(root):
            schema = pq.read_schema(path)
            wanted = [c for c in schema.names if not c.startswith("stats/")]
            table = pq.read_table(path, columns=wanted)
            for row in table.to_pylist():
                ep = int(row["episode_index"])
                tasks = row.get("tasks") or []
                if isinstance(tasks, (str, bytes, bytearray)):
                    tasks = [tasks]
                videos: dict[str, dict] = {}
                for key in cams:
                    ci, fi = f"videos/{key}/chunk_index", f"videos/{key}/file_index"
                    ft, tt = f"videos/{key}/from_timestamp", f"videos/{key}/to_timestamp"
                    if row.get(ci) is None or row.get(ft) is None:
                        continue  # camera absent from this dataset/episode
                    videos[key] = {
                        "chunk": int(row[ci]),
                        "file": int(row[fi]),
                        "from_timestamp": float(row[ft]),
                        "to_timestamp": float(row[tt]),
                    }
                rows.append({
                    "ep": ep,
                    "length": int(row.get("length") or 0),
                    "tasks": [_s(t) for t in tasks],
                    "data": {
                        "chunk": int(row.get("data/chunk_index") or 0),
                        "file": int(row.get("data/file_index") or 0),
                    },
                    "from_index": int(row.get("dataset_from_index") or 0),
                    "to_index": int(row.get("dataset_to_index") or 0),
                    "videos": videos,
                })
        rows.sort(key=lambda r: r["ep"])
        return rows

    return _cached(root, "episodes", build)


def tasks_by_index(root: Path) -> list[str]:
    """Task strings positionally aligned with ``task_index`` (the parquet's index)."""
    path = root / "meta" / "tasks.parquet"
    if not path.is_file():
        return []

    def build() -> list[str]:
        import pandas as pd

        df = pd.read_parquet(path)
        labels = [_s(x) for x in df.index]
        if "task_index" in df.columns:
            # Rows are not guaranteed to be in task_index order — place them.
            ordered: dict[int, str] = {}
            for label, idx in zip(labels, df["task_index"].tolist()):
                ordered[int(idx)] = label
            if ordered:
                return [ordered.get(i, "") for i in range(max(ordered) + 1)]
        return labels

    return _cached(root, "tasks", build)


# --------------------------------------------------------------------------- #
# the /api/ds/open payload
# --------------------------------------------------------------------------- #
def describe(root: Path) -> dict:
    """Everything the UI needs to render the dataset header and set up players."""
    info = read_info(root)
    eps = episodes(root, info)
    features = info.get("features") or {}
    cams = []
    for key in camera_keys(info):
        shape = features[key].get("shape") or [0, 0, 0]
        # video features are [height, width, channels]
        h, w = (int(shape[0]), int(shape[1])) if len(shape) >= 2 else (0, 0)
        cams.append({"key": key, "width": w, "height": h})

    warnings: list[str] = []
    imgs = image_keys(info)
    if imgs and not cams:
        warnings.append(
            f"This dataset stores frames as images ({', '.join(imgs)}), not video; "
            "playback is unavailable."
        )

    total_frames = sum(e["length"] for e in eps)
    return {
        "root": str(root),
        "name": root.name,
        "codebase_version": info.get("codebase_version"),
        "robot_type": info.get("robot_type"),
        "fps": int(info.get("fps") or 0),
        "total_episodes": len(eps),
        "total_frames": total_frames,
        "cameras": cams,
        "plottable": plottable_features(info),
        "tasks": tasks_by_index(root),
        "has_subtasks": (root / "meta" / "subtasks.parquet").is_file(),
        "has_annotations": (root / "meta" / "lerobot_annotations.json").is_file(),
        "warnings": warnings,
    }


# --------------------------------------------------------------------------- #
# per-episode timeseries (Phase 2 uses this; kept here with the other readers)
# --------------------------------------------------------------------------- #
def data_file(root: Path, info: dict, chunk: int, file: int) -> Path:
    from .video import safe_join

    template = info.get("data_path") or "data/chunk-{chunk_index:03d}/file-{file_index:03d}.parquet"
    return safe_join(root, template.format(chunk_index=chunk, file_index=file))


def series(root: Path, ep: int, keys: Iterable[str], max_points: int = 1500) -> dict:
    """Column-major, downsampled timeseries for one episode.

    Returns ``values[dim][i]`` so each array maps 1:1 onto one SVG polyline.
    """
    info = read_info(root)
    features = info.get("features") or {}
    row = next((e for e in episodes(root, info) if e["ep"] == ep), None)
    if row is None:
        raise DatasetError(f"episode {ep} not found")

    keys = [k for k in keys if k in features]
    if not keys:
        raise DatasetError("no valid feature keys requested")

    path = data_file(root, info, row["data"]["chunk"], row["data"]["file"])
    if not path.is_file():
        raise DatasetError(f"missing data file: {path}")

    # Predicate pushdown: correct no matter how episodes are packed into files.
    table = pq.read_table(
        path,
        columns=["frame_index", "timestamp", *keys],
        filters=[("episode_index", "==", int(ep))],
    )
    n = table.num_rows
    if n == 0:
        raise DatasetError(f"no rows for episode {ep} in {path.name}")

    stride = max(1, math.ceil(n / max(1, max_points)))
    idx = list(range(0, n, stride))
    table = table.take(idx)

    ts = [float(x) for x in table.column("timestamp").to_pylist()]
    t0 = ts[0] if ts else 0.0
    out_series: dict[str, dict] = {}
    for key in keys:
        raw = table.column(key).to_pylist()
        dims = _dims(features[key])
        names = _feature_names(features[key])
        if not names or len(names) != dims:
            names = [f"d{i}" for i in range(dims)]
        values: list[list[float]] = [[] for _ in range(dims)]
        for item in raw:
            if isinstance(item, (list, tuple)):
                for d in range(dims):
                    values[d].append(float(item[d]) if d < len(item) else 0.0)
            else:
                values[0].append(float(item))
        flat = [v for col in values for v in col]
        out_series[key] = {
            "dims": dims,
            "names": names,
            "min": min(flat) if flat else 0.0,
            "max": max(flat) if flat else 0.0,
            "values": values,
        }

    return {
        "ep": ep,
        "fps": int(info.get("fps") or 0),
        "length": row["length"],
        "n": len(idx),
        "stride": stride,
        "t": [round(t - t0, 6) for t in ts],
        "series": out_series,
    }
