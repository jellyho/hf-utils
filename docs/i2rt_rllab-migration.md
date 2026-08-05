# Removing the dataset editor from `i2rt_rllab`

Hand-off note for whoever maintains [`jellyho/i2rt_rllab`](https://github.com/jellyho/i2rt_rllab).

The dataset viewing/editing tooling has been reimplemented in
[`jellyho/hf-utils`](https://github.com/jellyho/hf-utils) as a local web app, generalised so
it works on **any** LeRobot v3.0 dataset rather than only YAM recordings. This note lists
what can be deleted from `i2rt_rllab`, what must stay, and what nothing depends on.

## TL;DR

**`i2rt_rllab` does not need to depend on `hf-utils`.** It is a tool a human runs, not a
library. There is no `pip install`, no import, no submodule. Delete the editor stack, add
a README pointer, done.

Verified with a fresh clone at `HEAD`:

```bash
# Nothing outside the editor stack references it, except its own tests and a design doc:
grep -rn "dataset_editor\|dataset_reader\|visualize_dataset\|editor_gui" \
  --include=*.py --include=*.sh --include=*.md . | grep -v "^./workstation/lerobot_recorder/"
#   docs/superpowers/specs/2026-07-09-dataset-episode-visualizer-design.md  (prose)
#   (nothing else)

# No robot, training or policy code imports the recorder package at all:
grep -rn "from workstation\|import workstation" --include=*.py . | grep -v "^./workstation/"
#   only tests/
```

The dependency runs the *other* way: the editor imports `i2rt.serving.rig_config` and
`workstation.lerobot_recorder.config`, never the reverse.

## Safe to delete

| Path | Lines | Replaced by |
|---|---:|---|
| `workstation/lerobot_recorder/dataset_editor.py` | 585 | `hfutil/dataset/edit.py` + `health.py` |
| `workstation/lerobot_recorder/editor_gui.py` | 683 | the LeRobot tab in the web app |
| `workstation/lerobot_recorder/editor_main.py` | 48 | — (the app has no CLI entry point) |
| `workstation/lerobot_recorder/dataset_reader.py` | 161 | `hfutil/dataset/meta.py` |
| `workstation/lerobot_recorder/views.py` | 105 | the browser lays the cameras out |
| `workstation/lerobot_recorder/theme.py` | 76 | — (PyQt stylesheet only) |
| `workstation/lerobot_recorder/visualize_dataset.py` | 222 | `hfutil/dataset/render.py` (+ GIF, frame ranges, arbitrary cameras) |
| `workstation/lerobot_recorder/check_videos.py` | 137 | `hfutil/dataset/health.py` |
| `workstation/lerobot_recorder/doctor.py` | 113 | `hfutil/dataset/health.py` (the parts that aren't `outcomes.jsonl`) |
| `tests/test_dataset_editor.py` | 224 | — (tests the deleted module) |
| `yam-data` subcommands `edit`, `doctor` | — | the web app |

`outcomes.jsonl` handling is covered too: `hf-utils` **detects** the sidecar and, when it
is there, shows success/fail/discard in the episode list with one-click buttons, and
carries the file across (renumbered) when episodes are deleted. Datasets without it never
see the feature, so nothing YAM-specific leaks into the general tool. See
"Dataset profiles" in the hf-utils README.

Also drop `PyQt5` from `workstation/lerobot_recorder/requirements.txt` if nothing else uses
it, and the `edit`/`doctor` branches from the `yam-data` launcher.

## Keep — genuinely robot-specific

These have no equivalent in `hf-utils` and shouldn't get one; they encode YAM/recorder
assumptions:

- **`dataset_writer.py`** (1028 lines) and **`config.py`** — the recorder itself.
- **Homing-tail marking** — `set_homing_tail` / `clear_homing` / `detect_homing_start`.
  These assume `ARM_DOF = 7`, a bimanual 14-D action and gripper indices 6 / 27, so the
  robot-aware side stays here. `hf-utils` *reads* `observation.control_mode` for display
  when the feature exists, but never writes it.
- **`video_integrity.py`** (372 lines) — *partially* superseded. `hf-utils` detects the same
  problem (mp4 shorter than the metadata claims) and repairs the **metadata** side, but it
  does not re-encode or append frames to the mp4. Keep this if you rely on the
  `--fix` path that rewrites video.
- **`filter_dataset.py`** (idle-frame filtering) — hardcodes `actions.shape[1] >= 14`.
- **`workstation/lerobot_dataset_visualizer/`** — the vendored Next.js fork. Independent
  of everything above; keep or drop on its own merits.

## What `hf-utils` covers

Run it with `./run.sh` (or `.\run.ps1`), open <http://127.0.0.1:8000>, LeRobot tab, point it
at a dataset folder — including one straight out of the HF cache.

- Episode browser; all cameras played back in sync with frame-accurate scrubbing.
- `action` vs `observation.state` plots, one small chart per dimension, sharing the video's
  time cursor.
- Render episodes to **MP4 or GIF** — camera subset and order, 0.5×–16× speed, panel height,
  a frame range with live previews of both endpoints, optional burned-in overlays, and file
  metadata.
- Edit task strings; delete episodes with re-indexing; split; merge.
- Per-episode **success / fail / discard**, when the dataset has an `outcomes.jsonl`.
- **Subtask annotation** — drag a block on the timeline, click a label. Exports to
  `meta/subtasks.parquet` + a `subtask_index` column, which lerobot 0.4.4 reads natively
  (`dataset[i]["subtask"]` returns the label).
- **Dataset check** — episode numbering, `total_episodes` vs actual, `dataset_from/to_index`
  vs `length`, per-camera window vs `length/fps`, missing video/data files, inconsistent
  columns across data files, and optionally real frame counts from every mp4. Timestamp
  drift can be repaired in place (with a backup).
- HF Hub side: bulk delete/rename/visibility for models, datasets and collections;
  download/upload, LeRobot-aware.

Everything destructive keeps a copy: in-place edits back up the touched files into
`<dataset>/.hfutil_bak/<timestamp>/`, and deleting episodes moves the whole original aside
as `<dataset>.backup-delete-Nep.<timestamp>/`.

## If you *do* want programmatic access

Not required, but the core is a plain library with no web framework and no torch import at
module load:

```bash
pip install "hf-utils @ git+https://github.com/jellyho/hf-utils"
```
```python
from hfutil.dataset import meta, health

root = meta.resolve_root("~/lerobot_data/my_dataset")
info = meta.describe(root)                 # cameras, fps, features, tasks
eps  = meta.episodes(root)                 # length, task, per-camera video windows
report = health.check(root, deep_video=True)
```
