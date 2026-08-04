# 🤗 HF Util

A small **local web GUI** for managing your own Hugging Face account — built to
delete and edit **models / datasets / collections in bulk** instead of clicking
through the website one repo at a time.

> Designed to grow: adding a new tab / utility is just a new API route + a bit of
> frontend. Spaces, file browsing, bulk tag editing, etc. can be layered on later.

## Features (v1)

| Tab | What you can do |
|-----|-----------------|
| **Models** | List all your models, filter/sort, multi-select **bulk delete**, inline **rename**, toggle **public/private** |
| **Datasets** | Same as models |
| **Collections** | List collections, multi-select **bulk delete**, **edit** (title / description / private), expand to **remove items** |

- Shows downloads, likes, storage size, last-modified for every repo.
- Bulk delete requires typing `DELETE` in a confirmation dialog (deletes are permanent).
- Auth uses your existing Hugging Face login — **no token is stored in this repo**.

## Requirements

- Python 3.10+ (developed on 3.12)
- A Hugging Face login. If you haven't logged in on this machine:
  ```bash
  hf auth login
  ```
  (older versions: `huggingface-cli login`). The token is read from the standard
  HF cache automatically.

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
│   └── main.py        # FastAPI app: wraps huggingface_hub (list/delete/rename/visibility/collections)
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
```
