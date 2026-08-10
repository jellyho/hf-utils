# 🤗 HF Util

A small **local web GUI** for managing your own Hugging Face account — built to
delete and edit **models / datasets / collections in bulk** instead of clicking
through the website one repo at a time.

> Designed to grow: adding a new tab / utility is just a new API route + a bit of
> frontend. Spaces, file browsing, bulk tag editing, etc. can be layered on later.

## Features

| Tab | What you can do |
|-----|-----------------|
| **Models** | List all your models, filter/sort, multi-select **bulk delete**, inline **rename**, toggle **public/private**. Clicking a repo **name** sets up its download in the Transfer tab — this is a tool for moving repos around, so the local action is the common one; **🤗** in Actions is the way out to huggingface.co |
| **Datasets** | Same as models |
| **Collections** | List collections, multi-select **bulk delete**, **edit** (title / description / private), expand to **remove items** |
| **Transfer** | **Download** any repo from the Hub — all of it, or **just the files you tick** — and **upload** a local folder to the Hub. **LeRobot-aware:** LeRobot datasets are auto-detected and can use the LeRobot API instead of plain file transfer. |
| **Jobs** | Everything long-running — downloads, uploads, renders — with a live log, cancel, **Resume** for anything that stopped part-way, **✕** to drop a job you're done with, and **Open folder** when it's done. **The list survives a restart**, and a transfer that outlived the server is picked back up rather than lost. A badge on the tab counts what's still running, wherever you are in the app. |
| **LeRobot** | Open a local LeRobot **v3.0** dataset and browse it: episode list, all cameras played back **in sync**, frame-accurate scrubbing, keyboard transport, and **state/action plots** that share the video's time cursor. |

- Downloads land in `~/hf_utils_downloads` — outside the checkout, since a model repo can run
  to tens of GB. Set `HFUTIL_DOWNLOAD_ROOT` to put them somewhere else, or type an absolute path.
- A cancelled, failed or interrupted download keeps its files, so **Resume** continues instead
  of starting the transfer over — completed files are skipped outright and a partial one picks
  up from its `.incomplete`.
- **Jobs outlive the server.** Records and logs are kept under `~/.hfutil/jobs`
  (`HFUTIL_STATE_DIR`), so restarting no longer empties the Jobs tab. On startup a transfer
  whose worker is *still running* is re-adopted and keeps streaming into the UI (badged
  `adopted`); one whose worker is gone is marked **interrupted** — amber, not red, because the
  bytes are on disk and it only needs running again. **✕** removes a single job and its log;
  files on disk are never touched.
- Workers log to a **file, not a pipe**, which is what makes the above safe. With a pipe the
  server is the only reader: kill it mid-transfer and nobody drains the pipe, its 64 KB buffer
  fills with tqdm redraws, the writing thread blocks, and every download thread deadlocks
  behind it — a live 82 GB download that never advances another byte and never exits. (That is
  not hypothetical; it is why this changed.) A file has no reader to lose.
- Transfers pick their backend from how much RAM is free. Measured on one 3.08 GB checkpoint
  shard: the Hub's Xet backend peaks at **1.88 GB resident and 11.5 MB/s**, plain streaming at
  **0.06 GB and 5.5 MB/s** — Xet buffers ~60% of a file in memory to reconstruct it, and buys
  about double the speed with it. Neither wins outright, so below 10 GB free
  (`HFUTIL_LOW_MEMORY_GB`) transfers stream instead, and the job log says which it chose and
  why. `HFUTIL_USE_XET=0`/`1` forces it. Files in flight are capped at 4
  (`HFUTIL_MAX_PARALLEL_FILES`) either way.
- Shows downloads, likes, last-modified for every repo.
- Bulk delete requires typing `DELETE` in a confirmation dialog (deletes are permanent).
- Auth uses your existing Hugging Face login — **no token is stored in this repo**.

### Transfer / LeRobot details

- **Download**: generic repos use `snapshot_download`; LeRobot datasets (detected by a
  `meta/info.json`) use `LeRobotDataset(...)` so you get the validated dataset structure.
- **Partial download.** "Choose files…" opens the repo as a checkbox tree with a size on every
  folder, so a checkpoint repo with one folder per training step doesn't have to come down
  whole. Nothing here asks for a pattern:
  - **Tick folders or files.** A folder shows `4/5 files · 11.3 GB` and goes half-ticked when
    only part of it is picked.
  - **Search by plain words.** Typing `4000 safetensors` keeps the files whose path contains
    every word — no globs, no regex — and **Tick matches** applies it to all of them at once,
    including the ones scrolled off screen.
  - **One-click presets**: Everything / Nothing, a chip per file type (`.safetensors (8)`),
    and — when the repo has step-numbered folders — *Newest only — checkpoint-10000*.
  - **Review before it runs.** The footer always reads `9 of 25 files · 5.3 GB of 45.3 GB`,
    and the review panel lists both the exact files and the rules that will be sent to the Hub.
  The ticks are only turned into `allow_patterns` at the end: a fully-ticked folder becomes
  `<folder>/**` (short to read back, and a resume picks up anything added to it since),
  anything else goes as its exact path. The job's label and log record what was filtered, and
  **Resume** re-applies the same rules. LeRobot downloads always fetch the whole dataset — a
  subset would fail the dataset's own consistency checks — so the button greys out for them.
- **Upload**: generic folders use `create_repo` + `upload_folder`; a local LeRobot dataset
  uses `LeRobotDataset(root=...).push_to_hub(...)` so the `codebase_version` tag and dataset
  card are written correctly.
- The "Use LeRobot API" checkbox auto-toggles from detection but you can override it.
- **Browse…** opens a folder picker so you can navigate the local filesystem and pick the
  download target / upload source instead of pasting a path (with "New folder" + a LeRobot
  badge when a folder contains `meta/info.json`). Works on Windows and Linux/macOS.
- Each transfer runs in a **subprocess** (so torch/lerobot never load into the web server),
  streams its log to the UI, and can be cancelled mid-run.

### LeRobot viewer

Open any local v3.0 dataset folder (including one straight out of the HF cache).

- **Episode list** with frame count, duration and task; filter by index or task text.
- **All cameras in sync.** A v3.0 dataset packs many episodes into one MP4 per camera, so an
  episode is a window `[from_timestamp, to_timestamp]` into a shared file. The viewer serves
  the whole file over HTTP Range and seeks inside it — no clip extraction, no transcoding.
  Measured on a 244 MB / 357 s 3-camera dataset: **~6 ms per scrub step, 0 ms spread between
  cameras, 0 dropped frames**, and it stays that fast for hour-long files because LeRobot
  writes a keyframe every ~2 frames.
- **Control-mode strip** — for datasets that carry `observation.control_mode`, a band under
  the transport showing where each frame came from: **teleop / policy / intervention /
  replay / homing**. Click it to jump to that frame, hover for the mode and frame range, and
  the legend doubles as a per-episode summary (`policy 77% · intervention 23% · homing <1%`),
  so a heavily-intervened episode is obvious at a glance. Read-only — the recorder owns
  writing the feature, since it is the thing that understands the robot.
  Only three of the five modes get a hue: any two modes can end up touching on a timeline, so
  this is an *all-pairs* palette problem, and no 4- or 5-colour subset of the validated
  categorical palette clears the normal-vision floor in both themes (enumerated with
  `validate_palette.js`, not eyeballed). So the three modes that say *who is driving* take the
  validated trio, and the two that mean "not live control" share one neutral, separated by a
  hatch rather than a sixth hue. Every band is also named in the legend, on hover, and
  directly on wide bands — identity is never colour alone.
- **Keyboard**: `space` play/pause, `←/→` step a frame (`shift` = 10), `↑/↓` change episode.
- **Camera order.** ffmpeg `hstack`s the panels in the order it is handed them, so the
  cameras are a reorderable list rather than a checkbox grid — tick what to include, `↑`/`↓`
  to arrange, and the number on each row is where that panel lands in the strip. Top to bottom
  in the dialog is left to right in the video, and the order is recorded in the file's
  `comment` metadata tag.
- **Bulk render.** The render dialog carries the episode list itself — checkboxes with the
  same **✓ success / ✗ fail / · discard** marker the sidebar shows, a filter by index or task,
  and quick-select chips (`All`, `None`, `✓ success (201)`, `✗ fail (8)`, `– unmarked`) that
  act on whatever the filter is showing. So "render every failed run" is two clicks instead of
  cross-referencing the list and typing `3,17,42,…`. The chips only appear for datasets that
  carry an outcomes sidecar, and only for outcomes that are actually present.
  **Frame trimming is single-episode only** — a trim belongs to one episode's timeline, so with
  a bulk selection that block hides and every episode renders in full rather than being cut to
  the first one's length. **Also bundle into one .zip** adds an archive next to the clips —
  stored, not deflated, since MP4/GIF are already compressed and the point is one file to copy,
  not a smaller one. The individual files are kept either way, and the zip only appears once
  it is complete (written to `.part` first).
- **Render** episodes to **MP4 or GIF** — pick episodes (`7`, `0,3,5`, `0-9`), which cameras
  and in what order, speed (0.5×–16×), panel height, and a **frame range** — a two-handle
  slider with **live previews of the start and end frames**, so you can see exactly where
  the cut lands. Overlays are optional: camera labels, an episode/time/frame counter, the
  task text. MP4s also get the dataset, task, fps and speed written into the file's own metadata.
  Renders run as background jobs with a live log, and land in `<dataset>_renders/` next to
  the dataset — never inside it, so they can't ride along on a later upload.
- **Edit**: change an episode's **task** text (one episode, a list, or a range — existing
  strings are offered as chips and reused), and **delete episodes** with automatic
  re-indexing. Deletes go through lerobot's own `dataset_tools`, are verified on disk
  before anything is swapped, keep the original as a `.backup-…` folder beside the
  dataset, and refuse to start if there isn't room for the temporary copy.
- **Split / merge** into new datasets (the sources are only read). Splits take either
  fractions (`train = 0.8`) or explicit episode lists (`val = 0,3,5-9`); merges check that
  fps and the feature set match before writing anything.
- **Check** — episode numbering, `total_episodes` vs reality, `from/to_index` vs `length`,
  each camera's window vs `length/fps`, missing files, columns that differ between data
  files, and optionally the real frame count of every mp4. Timestamp drift (a dropped
  trailing frame is the usual cause, and it's what makes lerobot's `delete_episodes`
  assert) can be repaired in place, with a backup.
- **Subtask annotation**: set your label palette up once, then it's drag-and-click —
  drag on the strip under the video, click a label (or press its number key). What you get
  is a **block**: click to select it, drag its body to move it, drag an edge to resize.
  Blocks butt up against their neighbours and can never overlap, and erase removes the
  whole selected block. Segments live in `meta/lerobot_annotations.json` while you work;
  **Export** writes a `subtask_index` column plus `meta/subtasks.parquet`, which
  **lerobot 0.4.4 reads natively** — `dataset[i]["subtask"]` returns your label string.

### Dataset profiles

Some recorders write things the LeRobot format itself knows nothing about. Rather than
assume one lab's layout, `hfutil/dataset/profiles.py` **detects** them and the UI only
offers what a given dataset actually has:

| Detected by | Enables |
|---|---|
| an `outcomes.jsonl` sidecar | per-episode **success / fail / discard** buttons, and a status column in the episode list |
| an `observation.control_mode` feature | reading the per-frame mode (teleop / policy / intervention / replay / homing) for display — *writing* it stays with the recorder that understands the robot |

Both are carried across and renumbered when episodes are deleted.
- **Plots**: pick up to three features (e.g. `action.joint_pos` + `observation.state.joint_pos`)
  and get one small chart **per dimension**, with the commanded and measured traces overlaid.
  Dimension identity comes from position, not colour — 14 categorical hues would not be
  distinguishable — so colour is free to carry the comparison that matters. The plots share
  the video's time cursor: scrubbing moves it, and clicking or dragging a plot seeks the
  video. Each chart shows its value at the cursor, so numbers never live only in a tooltip.
- Everything is derived from `meta/info.json` — cameras are the features with
  `dtype: "video"`, paths come from the `data_path`/`video_path` templates — so it works on
  any v3.0 dataset, not just one robot. v2.x datasets are rejected with a conversion hint.

## Requirements

- Python 3.10–3.12 (developed on 3.12).
- A Hugging Face login. If you haven't logged in on this machine:
  ```bash
  hf auth login
  ```
  (older versions: `huggingface-cli login`). The token is read from the standard
  HF cache automatically.
- `lerobot==0.4.4` is pinned in `requirements.txt` for the Transfer tab. It pulls
  in torch / torchvision / transformers, so the **first install is large (a few
  hundred MB+)** and may take a while. It also constrains `huggingface_hub<0.36`.

## Run

**Windows (PowerShell):**
```powershell
.\run.ps1
```

**Linux / macOS:**
```bash
./run.sh
```

**Any OS (manual):**
```bash
python -m venv .venv
# Windows: .venv\Scripts\activate    |  macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
python -m backend.main
```

It serves on **<http://127.0.0.1:8765>** and opens a browser for you. If that port is
already taken it moves to the next free one and says so, so two copies can run side by
side.

```bash
./run.sh --port 9000        # a specific port
./run.sh --no-browser       # e.g. when you'll tunnel in over ssh
HFUTIL_PORT=9000 ./run.sh   # same as --port, via the environment
./run.sh --exact-port       # fail instead of moving off a busy port
```

The server binds to `127.0.0.1` only — including the filesystem-browsing endpoints used
by the folder picker, so they're reachable only from your own machine. To view a dataset
that lives on a workstation, forward the port rather than binding wider:

```bash
ssh -L 8765:localhost:8765 my-workstation
```

## Project layout

```
hf-util/
├── hfutil/                 # reusable library — no FastAPI, no lerobot/torch at import time
│   └── dataset/
│       ├── meta.py         # LeRobot v3.0 metadata reader (pyarrow only)
│       ├── video.py        # video path resolution, ffmpeg/font discovery, codec probe
│       ├── render.py       # builds the ffmpeg command for an episode -> MP4 / GIF
│       ├── edit.py         # task strings, subtask annotations + export (pyarrow, atomic)
│       ├── health.py       # integrity checks + timestamp repair
│       └── profiles.py     # optional per-recorder capabilities, detected not assumed
├── backend/                # the local web app
│   ├── main.py             # FastAPI app: repos / collections / transfer / jobs
│   ├── routes_dataset.py   # /api/ds/* — the LeRobot viewer endpoints
│   ├── jobs.py             # background job manager (spawns worker subprocesses, tails logs)
│   └── worker.py           # runs one heavy job (huggingface_hub or lerobot), then exits
├── frontend/
│   ├── index.html          # single-page GUI
│   ├── app.js              # repos / collections / transfer / folder picker
│   ├── dataset.js          # the LeRobot viewer + edit dialogs
│   ├── annotate.js         # subtask annotation strip (drag a span, click a label)
│   ├── plot.js             # small-multiple timeseries charts (inline SVG)
│   └── styles.css
├── pyproject.toml          # `pip install -e .` — lets other projects import hfutil
├── requirements.txt
├── run.ps1 / run.sh        # one-command launchers (create the venv on first run)
└── README.md
```

### Using `hfutil` from another project

The dataset logic is deliberately separate from the web app, so other repos can depend on it
instead of copying code:

```bash
pip install "hf-utils @ git+https://github.com/jellyho/hf-utils"
```
```python
from hfutil.dataset import meta

root = meta.resolve_root("~/lerobot_data/my_dataset")
info = meta.describe(root)          # cameras, fps, plottable features, tasks
eps  = meta.episodes(root)          # per-episode length / task / video windows
s    = meta.series(root, ep=0, keys=["action.joint_pos"])
```

## Safety notes

- **Deletion is permanent.** The API mirrors `huggingface_hub.delete_repo` /
  `delete_collection`; there is no trash/undo on the Hub.
- Deleting a *collection* does **not** delete the models/datasets it references.
- The app only ever touches repos under **your own** username (from `whoami`).

## API endpoints (for extending)

```
GET  /api/whoami
GET  /api/repos?repo_type=model|dataset
POST /api/repos/delete           {repo_type, ids[]}
POST /api/repos/visibility       {repo_type, id, private}
POST /api/repos/rename           {repo_type, id, new_name}
GET  /api/collections
GET  /api/collection?slug=...
POST /api/collections/delete     {slugs[]}
POST /api/collections/update     {slug, title?, description?, private?}
POST /api/collections/remove-item {slug, item_object_id}

GET  /api/detect/hub?repo_id=&repo_type=   # is this Hub repo a LeRobot dataset?
GET  /api/detect/local?path=               # is this local folder a LeRobot dataset?
GET  /api/repo/files?repo_id=&repo_type=&revision=  # every file + size (the picker's input)
POST /api/transfer/download      {repo_id, repo_type, local_dir, use_lerobot,
                                  allow_patterns?, selected_files?, selected_bytes?}
POST /api/transfer/upload        {repo_id, repo_type, local_dir, private, use_lerobot}
GET  /api/jobs                             # all transfer jobs (short log tail)
GET  /api/jobs/{id}                        # one job (full log tail)
POST /api/jobs/{id}/cancel
POST /api/jobs/{id}/resume                 # re-run the spec; downloads continue
DELETE /api/jobs/{id}                      # drop one job + its log (files are kept)
POST /api/jobs/clear                       # drop every finished job

GET  /api/fs/list?path=                     # browse a local dir (drives/home when empty)
POST /api/fs/mkdir               {path, name}

GET  /api/ds/capabilities                   # is ffmpeg / a usable font available?
GET  /api/ds/open?root=                     # dataset header: cameras, fps, features, tasks
GET  /api/ds/episodes?root=                 # per-episode length, task, video windows
GET  /api/ds/video?root=&key=&chunk=&file=  # the shared MP4, served with HTTP Range
GET  /api/ds/videoprobe?root=&key=&…        # codec / resolution (PyAV)
GET  /api/ds/series?root=&ep=&keys=&max_points=   # downsampled per-episode timeseries
POST /api/ds/render              {root, episodes[], cameras[], fmt, speed, height,
                                  frame_start, frame_end, gif_fps, gif_width,
                                  show_camera_labels, show_counter, show_task, out_dir,
                                  zip_output}

POST /api/ds/edit/tasks          {root, episode_tasks: {ep: text}}
POST /api/ds/edit/delete-episodes {root, episodes[]}
GET  /api/ds/annotations?root=
POST /api/ds/annotations         {root, doc}
POST /api/ds/edit/export-subtasks {root}
POST /api/ds/edit/split          {root, splits, out_dir}
POST /api/ds/edit/merge          {roots[], out_dir}

GET  /api/ds/check?root=&deep_video=
POST /api/ds/repair/timestamps   {root}
GET  /api/ds/outcomes?root=          # only meaningful for datasets that have the sidecar
POST /api/ds/outcomes            {root, episode, outcome}
GET  /api/ds/control-mode?root=&ep=  # read-only
```

Migrating away from another repo's copy of this tooling? See
[docs/i2rt_rllab-migration.md](docs/i2rt_rllab-migration.md).

## Safety

Nothing destructive happens without a copy first.

| Operation | What is kept |
|---|---|
| Edit task | the files it touches → `<dataset>/.hfutil_bak/<timestamp>/` |
| Export subtasks | same |
| Delete episodes | the **whole original dataset** → `<dataset>.backup-delete-Nep.<timestamp>/` beside it |

Deletes additionally: verify the rebuilt dataset on disk (episode count) *before* swapping
it in, refuse to delete every episode, refuse to start without enough free disk for the
temporary copy, and carry `meta/lerobot_annotations.json` across — renumbering it, since
deleting shifts every later episode index and lerobot writes a fresh `meta/` of its own.
