"""Optional, dataset-specific capabilities — detected, never assumed.

The core tools work on any LeRobot v3.0 dataset. Some recorders additionally write things
the format itself knows nothing about, and those are worth first-class editing when they
are present. Rather than hardcoding one lab's layout, each capability declares how to
recognise itself, and the UI only offers what a given dataset actually has.

Currently detected:

* ``outcomes`` — an ``outcomes.jsonl`` sidecar with a per-episode success/fail/discard
  label (written by the i2rt/YAM recorder). Read *and* written here.
* ``control_mode`` — an ``observation.control_mode`` scalar feature marking how each frame
  was produced (teleop / policy / intervention / replay / homing). **Display only.**
  Marking a homing tail stays in the recorder that understands the robot's gripper
  layout; showing where it was marked is useful in any viewer.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

CONTROL_MODE_FEATURE = "observation.control_mode"

# The i2rt recorder's encoding. Kept here (rather than inferred) because it is not stored
# in the dataset; the UI shows the names so the mapping is never a black box.
CONTROL_MODES: dict[str, int] = {
    "teleop": 0,
    "policy": 1,
    "intervention": 2,
    "replay": 3,
    "homing": 4,
}

OUTCOMES = ("success", "fail", "discard")
OUTCOMES_FILE = "outcomes.jsonl"


def outcomes_path(root: Path) -> Path:
    return root / OUTCOMES_FILE


def detect(root: Path, info: dict) -> dict:
    """What optional capabilities does this dataset support?"""
    features = info.get("features") or {}
    has_cm = CONTROL_MODE_FEATURE in features
    return {
        "outcomes": outcomes_path(root).is_file(),
        "control_mode": has_cm,
        "control_modes": CONTROL_MODES if has_cm else None,
    }


# --------------------------------------------------------------------------- #
# outcomes.jsonl
# --------------------------------------------------------------------------- #
def read_outcomes(root: Path) -> dict[int, dict]:
    """Per-episode sidecar rows, keyed by episode index. Last write wins."""
    path = outcomes_path(root)
    if not path.is_file():
        return {}
    out: dict[int, dict] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
            out[int(entry["episode"])] = entry
        except (ValueError, KeyError, TypeError):
            continue
    return out


def write_outcomes(root: Path, rows: dict[int, dict]) -> None:
    path = outcomes_path(root)
    tmp = path.with_suffix(".jsonl.tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        for ep in sorted(rows):
            fh.write(json.dumps(rows[ep], ensure_ascii=False) + "\n")
    os.replace(tmp, path)


def set_outcome(root: Path, episode: int, outcome: str) -> dict:
    if outcome not in OUTCOMES:
        raise ValueError(f"outcome must be one of {OUTCOMES}, got {outcome!r}")
    rows = read_outcomes(root)
    entry = dict(rows.get(episode) or {})
    entry["episode"] = int(episode)
    entry["outcome"] = outcome
    rows[int(episode)] = entry
    write_outcomes(root, rows)
    return entry


def remap_outcomes(rows: dict[int, dict], deleted) -> dict[int, dict]:
    """Renumber after episodes are deleted — same shift rule as the annotations."""
    gone = sorted({int(d) for d in deleted})
    out: dict[int, dict] = {}
    for ep, entry in rows.items():
        if ep in gone:
            continue
        shift = sum(1 for d in gone if d < ep)
        new_ep = ep - shift
        entry = dict(entry)
        entry["episode"] = new_ep
        out[new_ep] = entry
    return out


# --------------------------------------------------------------------------- #
# observation.control_mode — read only; the recorder owns writing it
# --------------------------------------------------------------------------- #
def read_control_mode(root: Path, episode: int) -> list[float]:
    """The per-frame control_mode series for one episode (for drawing the strip)."""
    import pyarrow.parquet as pq

    from .meta import data_file, episodes, read_info

    info = read_info(root)
    if CONTROL_MODE_FEATURE not in (info.get("features") or {}):
        return []
    row = next((e for e in episodes(root, info) if e["ep"] == int(episode)), None)
    if row is None:
        return []
    path = data_file(root, info, row["data"]["chunk"], row["data"]["file"])
    if not path.is_file():
        return []
    table = pq.read_table(path, columns=["frame_index", CONTROL_MODE_FEATURE],
                          filters=[("episode_index", "==", int(episode))])
    out = []
    for item in table.column(CONTROL_MODE_FEATURE).to_pylist():
        out.append(float(item[0]) if isinstance(item, list) and item else
                   (float(item) if item is not None else 0.0))
    return out
