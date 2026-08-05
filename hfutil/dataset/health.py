"""Dataset health checks.

Ported from the diagnostics in i2rt_rllab's recorder (``check_videos`` / ``doctor`` /
``repair_length_consistency``) and generalised: nothing here assumes a camera layout, an
action dimensionality, or the recorder's ``outcomes.jsonl`` sidecar.

The important one is the video/metadata frame-count check. A GPU encoder can drop a
trailing frame, leaving the mp4 shorter than ``length`` claims. Everything reads fine
until you try to edit, at which point lerobot asserts "length mismatch" from deep inside
``delete_episodes`` — so it is worth surfacing before it bites.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Optional

import pyarrow.parquet as pq

from .meta import camera_keys, data_file, episodes, read_info
from .video import video_file


def _frame_count(path: Path) -> Optional[int]:
    """Decoded frame count via PyAV. Counts packets, which is exact for these files and
    far cheaper than decoding; falls back to None if the file is unreadable."""
    try:
        import av
    except ImportError:
        return None
    try:
        with av.open(str(path)) as container:
            stream = container.streams.video[0]
            n = stream.frames                      # from the container index when present
            if n:
                return int(n)
            return sum(1 for _ in container.demux(stream) if _.size)
    except Exception:
        return None


def check(root: Path, deep_video: bool = False) -> dict:
    """Look for the problems that actually break things later.

    ``deep_video`` opens every mp4 to count frames; without it only the metadata is
    cross-checked (fast, and catches the common inconsistencies).
    """
    info = read_info(root)
    fps = int(info.get("fps") or 0)
    rows = episodes(root, info)
    cams = camera_keys(info)
    problems: list[dict] = []

    def add(kind: str, message: str, **extra):
        problems.append({"kind": kind, "message": message, **extra})

    # --- numbering -------------------------------------------------------
    ids = [r["ep"] for r in rows]
    if ids != list(range(len(ids))):
        gaps = sorted(set(range(max(ids) + 1 if ids else 0)) - set(ids))
        add("numbering", f"episode indices are not contiguous 0..{len(ids)-1}"
                         + (f"; missing {gaps[:10]}" if gaps else ""))
    declared = int(info.get("total_episodes") or -1)
    if declared != len(rows):
        add("metadata", f"info.json says total_episodes={declared} but {len(rows)} episode rows exist")

    # --- per-episode -----------------------------------------------------
    missing_files: set[str] = set()
    zero_length = 0
    for r in rows:
        if r["length"] <= 0:
            zero_length += 1
            add("episode", f"episode {r['ep']} has length {r['length']}", episode=r["ep"])

        span = r["to_index"] - r["from_index"]
        if span and span != r["length"]:
            add("episode", f"episode {r['ep']}: dataset_from/to_index spans {span} frames "
                           f"but length is {r['length']}", episode=r["ep"])

        for key in cams:
            win = r["videos"].get(key)
            if win is None:
                add("camera", f"episode {r['ep']} has no window for {key}", episode=r["ep"])
                continue
            if fps:
                # to_timestamp should cover exactly `length` frames from from_timestamp.
                want = win["from_timestamp"] + r["length"] / fps
                if abs(win["to_timestamp"] - want) > 1.5 / fps:
                    add("timestamp",
                        f"episode {r['ep']} {key.split('.')[-1]}: window is "
                        f"{win['to_timestamp'] - win['from_timestamp']:.3f}s but length/fps is "
                        f"{r['length']/fps:.3f}s", episode=r["ep"], camera=key)
            path = video_file(root, info, key, win["chunk"], win["file"])
            if not path.is_file():
                missing_files.add(str(path))

    for path in sorted(missing_files):
        add("missing", f"video file not found: {Path(path).name}", path=path)

    # --- data files ------------------------------------------------------
    seen_files: set[Path] = set()
    for r in rows:
        seen_files.add(data_file(root, info, r["data"]["chunk"], r["data"]["file"]))
    for path in sorted(seen_files):
        if not path.is_file():
            add("missing", f"data file not found: {path.name}", path=str(path))
            continue
        try:
            schema = pq.read_schema(path)
        except Exception as exc:
            add("data", f"{path.name} is unreadable: {exc}", path=str(path))
            continue
        for required in ("episode_index", "frame_index", "timestamp"):
            if required not in schema.names:
                add("data", f"{path.name} has no {required} column", path=str(path))

    # a column present in only some data files makes lerobot unable to load the dataset
    if len(seen_files) > 1:
        colsets = {}
        for path in sorted(seen_files):
            if path.is_file():
                try:
                    colsets[path.name] = frozenset(pq.read_schema(path).names)
                except Exception:
                    pass
        if len(set(colsets.values())) > 1:
            everything = set().union(*colsets.values())
            common = set.intersection(*[set(c) for c in colsets.values()])
            add("data", "data files do not all have the same columns; "
                        f"inconsistent: {sorted(everything - common)}")

    # --- optional: real frame counts -------------------------------------
    checked = 0
    if deep_video:
        for key in cams:
            files: dict[tuple[int, int], list[dict]] = {}
            for r in rows:
                win = r["videos"].get(key)
                if win:
                    files.setdefault((win["chunk"], win["file"]), []).append(r)
            for (chunk, fidx), eps in files.items():
                path = video_file(root, info, key, chunk, fidx)
                if not path.is_file():
                    continue
                actual = _frame_count(path)
                checked += 1
                if actual is None:
                    add("video", f"could not read {path.name}", path=str(path))
                    continue
                expected = sum(e["length"] for e in eps)
                if actual < expected:
                    add("video",
                        f"{key.split('.')[-1]} {path.name}: file has {actual} frames but "
                        f"metadata claims {expected} (short by {expected - actual})",
                        path=str(path), camera=key, actual=actual, expected=expected)

    return {
        "root": str(root),
        "episodes": len(rows),
        "total_frames": sum(r["length"] for r in rows),
        "fps": fps,
        "cameras": cams,
        "videos_checked": checked,
        "deep_video": deep_video,
        "problems": problems,
        "ok": not problems,
    }


def repair_timestamps(root: Path, log=print) -> int:
    """Snap each episode's per-camera ``to_timestamp`` so the window spans exactly
    ``length`` frames.

    This is the metadata half of the encoder-dropped-frame problem, and it is what
    lerobot's ``delete_episodes`` asserts on. Purely a metadata edit — no video is
    touched, so it is safe and reversible from the backup.
    """
    from .edit import atomic_write_table, backup_files, episode_meta_files

    info = read_info(root)
    fps = int(info.get("fps") or 0)
    if not fps:
        raise ValueError("dataset has no fps; refusing to guess")
    cams = camera_keys(info)

    files = episode_meta_files(root)
    backup_files(root, files)
    fixed = 0
    for path in files:
        table = pq.read_table(path)
        names = table.schema.names
        if "length" not in names:
            continue
        lengths = table.column("length").to_pylist()
        changed = False
        for key in cams:
            ft, tt = f"videos/{key}/from_timestamp", f"videos/{key}/to_timestamp"
            if ft not in names or tt not in names:
                continue
            starts = table.column(ft).to_pylist()
            ends = table.column(tt).to_pylist()
            new_ends = list(ends)
            for i, (s, e, n) in enumerate(zip(starts, ends, lengths)):
                if s is None or n is None:
                    continue
                want = s + n / fps
                if e is None or abs(e - want) > 1e-9:
                    new_ends[i] = want
                    changed = True
                    fixed += 1
            if changed:
                import pyarrow as pa
                j = table.schema.get_field_index(tt)
                field = table.schema.field(j)
                table = table.set_column(j, field, pa.array(new_ends, type=field.type))
        if changed:
            atomic_write_table(table, path)
            log(f"[repair] rewrote {path.name}")
    return fixed
