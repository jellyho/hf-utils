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
| **Transfer** | **Download** any repo from the Hub and **upload** a local folder to the Hub, as background jobs with live logs + cancel. **LeRobot-aware:** LeRobot datasets are auto-detected and can use the LeRobot API instead of plain file transfer. |

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
- Each transfer runs in a **subprocess** (so torch/lerobot never load into the web server),
  streams its log to the UI, and can be cancelled mid-run.

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

**Any OS (manual):**
```bash
python -m venv .venv
# Windows: .venv\Scripts\activate    |  macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
python -m backend.main
```

Then open <http://127.0.0.1:8000>. The server binds to `127.0.0.1` only.

## Project layout

```
hf-util/
├── backend/
│   ├── main.py        # FastAPI app: endpoints for repos / collections / transfer / jobs
│   ├── jobs.py        # background job manager (spawns worker subprocesses, tails logs)
│   └── worker.py      # runs one download/upload job (huggingface_hub or lerobot), then exits
├── frontend/
│   ├── index.html     # single-page GUI
│   ├── app.js         # all UI logic (vanilla JS, no build step)
│   └── styles.css
├── requirements.txt
├── run.ps1            # one-command launcher (creates venv on first run)
└── README.md
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
```
