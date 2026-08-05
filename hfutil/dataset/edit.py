"""Write operations on a local LeRobot v3.0 dataset.

Two rules shape this module:

* **Never lose data silently.** Anything structural moves the original aside with
  ``os.replace`` (instant, same filesystem) before the replacement is swapped in;
  anything in-place copies the files it is about to touch into ``.hfutil_bak/<stamp>/``.
* **Write parquet with pyarrow, not pandas round-trips.** ``set_column`` preserves the
  exact schema; ``df.to_parquet`` does not, and lerobot's own ``modify_tasks`` both
  rewrites every data file for a one-episode edit and raises TypeError when the existing
  task strings are bytes and the new one is str (which is the normal state of affairs).

Structural edits that need re-indexing (delete/split/merge) are delegated to
``lerobot.datasets.dataset_tools`` — imported lazily, and only ever from the worker
subprocess so torch never enters the web server.
"""

from __future__ import annotations

import json
import os
import shutil
from datetime import datetime
from pathlib import Path
from typing import Iterable, Optional

import pyarrow as pa
import pyarrow.parquet as pq

from .meta import _s, episodes, read_info

ANNOTATIONS_FILE = "lerobot_annotations.json"
UNLABELED = "unlabeled"


class EditError(Exception):
    pass


def _stamp() -> str:
    return datetime.now().strftime("%Y%m%dT%H%M%S")


def atomic_write_table(table: pa.Table, path: Path) -> None:
    """Write beside the target, then rename over it, so a crash can't truncate a file
    another reader has open."""
    tmp = path.with_suffix(path.suffix + ".tmp")
    pq.write_table(table, tmp)
    os.replace(tmp, path)


def backup_files(root: Path, paths: Iterable[Path], stamp: Optional[str] = None) -> Path:
    """Copy the given files into ``.hfutil_bak/<stamp>/`` preserving relative layout."""
    stamp = stamp or _stamp()
    dest_root = root / ".hfutil_bak" / stamp
    for src in paths:
        if not src.is_file():
            continue
        rel = src.relative_to(root)
        dest = dest_root / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dest)
    return dest_root


def data_files(root: Path) -> list[Path]:
    return sorted((root / "data").rglob("*.parquet"))


def episode_meta_files(root: Path) -> list[Path]:
    return sorted((root / "meta" / "episodes").rglob("*.parquet"))


# --------------------------------------------------------------------------- #
# Task strings
# --------------------------------------------------------------------------- #
def read_tasks(root: Path) -> list[str]:
    path = root / "meta" / "tasks.parquet"
    if not path.is_file():
        return []
    import pandas as pd

    df = pd.read_parquet(path)
    labels = [_s(x) for x in df.index]
    if "task_index" in df.columns:
        ordered: dict[int, str] = {}
        for label, idx in zip(labels, df["task_index"].tolist()):
            ordered[int(idx)] = label
        if ordered:
            return [ordered.get(i, "") for i in range(max(ordered) + 1)]
    return labels


def write_tasks(root: Path, labels: list[str]) -> None:
    """Write meta/tasks.parquet in lerobot's shape: the string is the index."""
    import pandas as pd

    df = pd.DataFrame({"task_index": range(len(labels))}, index=list(labels))
    tmp = root / "meta" / "tasks.parquet.tmp"
    df.to_parquet(tmp)
    os.replace(tmp, root / "meta" / "tasks.parquet")


def set_episode_tasks(root: Path, episode_tasks: dict[int, str], backup: bool = True) -> dict:
    """Point the given episodes at (possibly new) task strings.

    Append-only: an existing task index is never renumbered, so only the data files that
    actually contain the edited episodes are rewritten — O(edited), not O(dataset).
    """
    if not episode_tasks:
        raise EditError("no episodes given")
    info = read_info(root)
    rows = {e["ep"]: e for e in episodes(root, info)}
    unknown = [ep for ep in episode_tasks if ep not in rows]
    if unknown:
        raise EditError(f"no such episode(s): {unknown}")

    labels = read_tasks(root)
    index_of = {lab: i for i, lab in enumerate(labels)}
    for text in episode_tasks.values():
        if text not in index_of:
            index_of[text] = len(labels)
            labels.append(text)

    touched = {rows[ep]["data"]["chunk"]: None for ep in episode_tasks}  # noqa: F841
    targets: set[Path] = set()
    for ep in episode_tasks:
        d = rows[ep]["data"]
        targets.add(
            root / info["data_path"].format(chunk_index=d["chunk"], file_index=d["file"])
        )
    meta_targets = set(episode_meta_files(root))

    stamp = _stamp()
    backup_dir = ""
    if backup:
        backup_dir = str(backup_files(
            root, list(targets) + list(meta_targets) + [root / "meta" / "tasks.parquet",
                                                        root / "meta" / "info.json"], stamp))

    # 1. data parquets: repoint task_index for the affected rows
    changed_rows = 0
    for path in sorted(targets):
        table = pq.read_table(path)
        ep_col = table.column("episode_index").to_pylist()
        task_col = table.column("task_index").to_pylist()
        new_col = list(task_col)
        for i, ep in enumerate(ep_col):
            text = episode_tasks.get(int(ep))
            if text is not None:
                want = index_of[text]
                if new_col[i] != want:
                    new_col[i] = want
                    changed_rows += 1
        idx = table.schema.get_field_index("task_index")
        field = table.schema.field(idx)
        table = table.set_column(idx, field, pa.array(new_col, type=field.type))
        atomic_write_table(table, path)

    # 2. episode metadata: the `tasks` list column (normalised to str while we're here)
    for path in meta_targets:
        table = pq.read_table(path)
        if "tasks" not in table.schema.names:
            continue
        eps_col = table.column("episode_index").to_pylist()
        tasks_col = table.column("tasks").to_pylist()
        new_tasks = []
        for ep, current in zip(eps_col, tasks_col):
            text = episode_tasks.get(int(ep))
            if text is not None:
                new_tasks.append([text])
            elif isinstance(current, (list, tuple)):
                new_tasks.append([_s(t) for t in current])
            else:
                new_tasks.append([] if current is None else [_s(current)])
        idx = table.schema.get_field_index("tasks")
        table = table.set_column(idx, pa.field("tasks", pa.list_(pa.string())),
                                 pa.array(new_tasks, type=pa.list_(pa.string())))
        atomic_write_table(table, path)

    # 3. task table + info.json
    write_tasks(root, labels)
    info_path = root / "meta" / "info.json"
    raw = json.loads(info_path.read_text(encoding="utf-8"))
    raw["total_tasks"] = len(labels)
    tmp = info_path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(raw, indent=4), encoding="utf-8")
    os.replace(tmp, info_path)

    return {
        "episodes": sorted(episode_tasks),
        "rows_changed": changed_rows,
        "total_tasks": len(labels),
        "backup": backup_dir,
    }


# --------------------------------------------------------------------------- #
# Subtask annotations
# --------------------------------------------------------------------------- #
def annotations_path(root: Path) -> Path:
    return root / "meta" / ANNOTATIONS_FILE


def read_annotations(root: Path) -> dict:
    path = annotations_path(root)
    if not path.is_file():
        return {"version": 1, "tool": "hf-util", "labels": [], "episodes": {}}
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise EditError(f"could not read {path.name}: {exc}")
    doc.setdefault("labels", [])
    doc.setdefault("episodes", {})
    return doc


def write_annotations(root: Path, doc: dict) -> None:
    doc = dict(doc)
    doc["version"] = 1
    doc["tool"] = "hf-util"
    path = annotations_path(root)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(doc, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)


def remap_annotations(doc: dict, deleted: Iterable[int]) -> dict:
    """Renumber annotation episode keys after episodes were deleted.

    Deleting re-indexes the dataset, so every key above a deleted episode shifts down.
    Silently stale annotations (pointing at whatever episode inherited the number) are
    worse than dropped ones, so this drops the deleted episodes and shifts the rest.
    """
    gone = sorted({int(d) for d in deleted})
    out: dict[str, list] = {}
    for key, segs in (doc.get("episodes") or {}).items():
        try:
            ep = int(key)
        except (TypeError, ValueError):
            continue
        if ep in gone:
            continue
        shift = sum(1 for d in gone if d < ep)
        out[str(ep - shift)] = segs
    new_doc = dict(doc)
    new_doc["episodes"] = out
    return new_doc


def export_subtasks(root: Path, backup: bool = True, log=print) -> dict:
    """Materialise the annotation segments into the dataset itself.

    Writes ``meta/subtasks.parquet`` (indexed by the label string, the same shape as
    tasks.parquet) and adds a ``subtask_index`` column to EVERY data file. lerobot 0.4.4
    reads both natively: its metadata loads subtasks.parquet if present, and __getitem__
    resolves ``subtasks.iloc[subtask_index].name``.
    """
    doc = read_annotations(root)
    info = read_info(root)
    fps = int(info.get("fps") or 30)

    used: list[str] = []
    for segs in doc.get("episodes", {}).values():
        for seg in segs:
            label = str(seg.get("label") or "").strip()
            if label and label != UNLABELED and label not in used:
                used.append(label)
    # Index 0 is a reserved sentinel: lerobot resolves the label with .iloc[], so a -1
    # for unannotated frames would silently return the LAST label.
    labels = [UNLABELED] + sorted(used)
    index_of = {lab: i for i, lab in enumerate(labels)}

    # episode -> [(first_frame, last_frame, subtask_index)], inclusive
    spans: dict[int, list[tuple[int, int, int]]] = {}
    for ep_str, segs in doc.get("episodes", {}).items():
        try:
            ep = int(ep_str)
        except (TypeError, ValueError):
            continue
        out: list[tuple[int, int, int]] = []
        for seg in segs:
            label = str(seg.get("label") or "").strip()
            if not label or label == UNLABELED:
                continue
            f0, f1 = int(seg["start"]), int(seg["end"])
            if f1 < f0:
                f0, f1 = f1, f0
            out.append((f0, f1, index_of[label]))
        if out:
            spans[ep] = out

    files = data_files(root)
    if not files:
        raise EditError("no data parquet files found")

    stamp = _stamp()
    backup_dir = ""
    if backup:
        backup_dir = str(backup_files(root, files + [root / "meta" / "info.json"], stamp))

    labelled_frames = 0
    for n, path in enumerate(files, 1):
        table = pq.read_table(path)
        ep_col = table.column("episode_index").to_pylist()
        fr_col = table.column("frame_index").to_pylist()
        # Match on frame_index, never on timestamp: timestamps are float32 and drift.
        col = [0] * len(ep_col)
        for i, (ep, fr) in enumerate(zip(ep_col, fr_col)):
            for f0, f1, idx in spans.get(int(ep), ()):
                if f0 <= fr <= f1:
                    col[i] = idx
                    labelled_frames += 1
                    break
        arr = pa.array(col, type=pa.int64())
        if "subtask_index" in table.schema.names:
            j = table.schema.get_field_index("subtask_index")
            table = table.set_column(j, pa.field("subtask_index", pa.int64()), arr)
        else:
            table = table.append_column(pa.field("subtask_index", pa.int64()), arr)
        atomic_write_table(table, path)
        log(f"[subtask] data file {n}/{len(files)}: {path.name}")

    # Every data file must carry the column — lerobot loads them as one nested dataset
    # and a column present in only some files makes the whole thing unloadable. That is
    # why the loop above writes zeros rather than skipping unannotated files.
    import pandas as pd

    sub = pd.DataFrame({"subtask_index": range(len(labels))}, index=list(labels))
    tmp = root / "meta" / "subtasks.parquet.tmp"
    sub.to_parquet(tmp)
    os.replace(tmp, root / "meta" / "subtasks.parquet")

    info_path = root / "meta" / "info.json"
    raw = json.loads(info_path.read_text(encoding="utf-8"))
    feats = raw.setdefault("features", {})
    if "task_index" in feats:
        # Clone the existing index feature so the shape convention matches this dataset.
        feats["subtask_index"] = json.loads(json.dumps(feats["task_index"]))
    else:
        feats["subtask_index"] = {"dtype": "int64", "shape": [1], "names": None}
    tmp = info_path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(raw, indent=4), encoding="utf-8")
    os.replace(tmp, info_path)

    return {
        "labels": labels,
        "episodes_annotated": len(spans),
        "frames_labelled": labelled_frames,
        "files_rewritten": len(files),
        "backup": backup_dir,
    }
