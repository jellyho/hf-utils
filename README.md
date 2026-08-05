# 🤗 HF Util

A small **local web GUI** for managing your own Hugging Face account — built to
delete and edit **models / datasets / collections in bulk** instead of clicking
through the website one repo at a time.

> Designed to grow: adding a new tab / utility is just a new API route + a bit of
> frontend. Spaces, file browsing, bulk tag editing, etc. can be layered on later.

## Features

| Tab | What you can do |
|-----|-----------------|
| **Models** | List all your models, filter/sort, multi-select **bulk delete**, inline **rename**, toggle **public/private**, one-click **download** |
| **Datasets** | Same as models |
| **Collections** | List collections, multi-select **bulk delete**, **edit** (title / description / private), expand to **remove items** |
| **Transfer** | **Download** any repo from the Hub and **upload** a local folder to the Hub. **LeRobot-aware:** LeRobot datasets are auto-detected and can use the LeRobot API instead of plain file transfer. |
| **Jobs** | Everything long-running — downloads, uploads, renders — with a live log, cancel, and **Open folder** when it's done. A badge on the tab counts what's still running, wherever you are in the app. |
| **LeRobot** | Open a local LeRobot **v3.0** dataset and browse it: episode list, all cameras played back **in sync**, frame-accurate scrubbing, keyboard transport, and **state/action plots** that share the video's time cursor. |

- Shows downloads, likes, last-modified for every repo.
- Bulk delete requires typing `DELETE` in a confirmation dialog (deletes are permanent).
- Auth uses your existing Hugging Face login — **no token is stored in this repo**.

### Transfer / LeRobot details

- **Download**: generic repos use `snapshot_download`; LeRobot datasets (detected by a
  `meta/info.json`) use `LeRobotDataset(...)` so you get the validated dataset structure.
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
- **Keyboard**: `space` play/pause, `←/→` step a frame (`shift` = 10), `↑/↓` change episode.
- **Render** episodes to **MP4 or GIF** — pick episodes (`7`, `0,3,5`, `0-9`), which cameras
  and in what order, speed (0.5×–16×), panel height, and a **frame range** — a two-handle
  slider with **live previews of the start and end frames**, so you can see exactly where
  the cut lands. Overlays are optional: camera labels, an episode/time/frame counter, the
  task text. MP4s also get the dataset, task, fps and speed written into the file's own metadata.
  Renders run as background jobs with a live log, and land in `<dataset>_renders/` next to
  the dataset — never inside it, so they can't ride along on a later upload.
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

Then open <http://127.0.0.1:8000>. The server binds to `127.0.0.1` only — including the
filesystem-browsing endpoints used by the folder picker, so they're reachable only from
your own machine.

## Project layout

```
hf-util/
├── hfutil/                 # reusable library — no FastAPI, no lerobot/torch at import time
│   └── dataset/
│       ├── meta.py         # LeRobot v3.0 metadata reader (pyarrow only)
│       ├── video.py        # video path resolution, ffmpeg/font discovery, codec probe
│       └── render.py       # builds the ffmpeg command for an episode -> MP4 / GIF
├── backend/                # the local web app
│   ├── main.py             # FastAPI app: repos / collections / transfer / jobs
│   ├── routes_dataset.py   # /api/ds/* — the LeRobot viewer endpoints
│   ├── jobs.py             # background job manager (spawns worker subprocesses, tails logs)
│   └── worker.py           # runs one heavy job (huggingface_hub or lerobot), then exits
├── frontend/
│   ├── index.html          # single-page GUI
│   ├── app.js              # repos / collections / transfer / folder picker
│   ├── dataset.js          # the LeRobot viewer
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
POST /api/transfer/download      {repo_id, repo_type, local_dir, use_lerobot}
POST /api/transfer/upload        {repo_id, repo_type, local_dir, private, use_lerobot}
GET  /api/jobs                             # all transfer jobs (short log tail)
GET  /api/jobs/{id}                        # one job (full log tail)
POST /api/jobs/{id}/cancel

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
                                  show_camera_labels, show_counter, show_task, out_dir}
```
