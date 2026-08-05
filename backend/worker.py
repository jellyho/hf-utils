"""Transfer worker — runs one download/upload job, then exits.

Invoked as a subprocess by backend.jobs:  python -m backend.worker <spec.json>
Everything it prints (stdout+stderr merged by the parent) becomes the job log.
Heavy imports (lerobot / torch) happen lazily so a generic HF transfer stays
lightweight and a missing lerobot install only breaks lerobot jobs.
"""

from __future__ import annotations

import json
import sys
import traceback
from pathlib import Path


def log(msg: str) -> None:
    print(msg, flush=True)


# --------------------------------------------------------------------------- #
# Download
# --------------------------------------------------------------------------- #
def do_download(spec: dict) -> None:
    repo_id = spec["repo_id"]
    repo_type = spec["repo_type"]
    local_dir = spec["local_dir"]
    Path(local_dir).mkdir(parents=True, exist_ok=True)

    if spec["mode"] == "lerobot":
        log(f"[lerobot] downloading dataset '{repo_id}' -> {local_dir}")
        from lerobot.datasets.lerobot_dataset import LeRobotDataset

        ds = LeRobotDataset(repo_id, root=local_dir, download_videos=True)
        meta = getattr(ds, "meta", None)
        n = getattr(meta, "total_episodes", "?") if meta else "?"
        log(f"[lerobot] done -> {n} episodes at {local_dir}")
    else:
        log(f"[hf] snapshot_download '{repo_id}' ({repo_type}) -> {local_dir}")
        from huggingface_hub import snapshot_download

        path = snapshot_download(
            repo_id=repo_id, repo_type=repo_type, local_dir=local_dir
        )
        log(f"[hf] done -> {path}")


# --------------------------------------------------------------------------- #
# Upload
# --------------------------------------------------------------------------- #
def do_upload(spec: dict) -> None:
    repo_id = spec["repo_id"]
    repo_type = spec["repo_type"]
    local_dir = spec["local_dir"]
    private = spec["private"]

    if not Path(local_dir).is_dir():
        raise FileNotFoundError(f"Local folder does not exist: {local_dir}")

    if spec["mode"] == "lerobot":
        log(f"[lerobot] loading local dataset at {local_dir}")
        from lerobot.datasets.lerobot_dataset import LeRobotDataset

        ds = LeRobotDataset(repo_id, root=local_dir)
        log(f"[lerobot] push_to_hub -> '{repo_id}' (private={private})")
        ds.push_to_hub(private=private)
        log("[lerobot] pushed")
    else:
        from huggingface_hub import HfApi

        api = HfApi()
        log(f"[hf] create_repo '{repo_id}' ({repo_type}, private={private}, exist_ok)")
        api.create_repo(repo_id, repo_type=repo_type, private=private, exist_ok=True)
        log(f"[hf] upload_folder {local_dir} -> '{repo_id}'")
        url = api.upload_folder(
            folder_path=local_dir, repo_id=repo_id, repo_type=repo_type
        )
        log(f"[hf] uploaded -> {url}")


# --------------------------------------------------------------------------- #
# Render episodes to MP4 / GIF
# --------------------------------------------------------------------------- #
def do_ds_render(spec: dict) -> None:
    from hfutil.dataset import meta as dsmeta
    from hfutil.dataset.render import RenderError, RenderOptions, render_episode

    root = dsmeta.resolve_root(spec["ds_root"])
    info = dsmeta.read_info(root)
    rows = {e["ep"]: e for e in dsmeta.episodes(root, info)}
    opts = RenderOptions(**spec["options"])
    out_dir = Path(spec["out_dir"])
    name = spec.get("dataset_name") or root.name
    episodes = spec["episodes"]

    log(f"[render] {len(episodes)} episode(s) -> {out_dir}  ({opts.fmt}, {opts.speed:g}x)")
    ok, failed = 0, []
    for n, ep in enumerate(episodes, 1):
        row = rows.get(int(ep))
        if row is None:
            log(f"[skip] episode {ep} not found")
            failed.append(ep)
            continue
        log(f"[{n}/{len(episodes)}] episode {ep}")
        try:
            render_episode(root, info, row, out_dir, opts, name, log=log)
            ok += 1
        except RenderError as exc:
            log(f"ERROR episode {ep}: {exc}")
            failed.append(ep)
    log(f"[render] {ok}/{len(episodes)} rendered into {out_dir}")
    if not ok:
        raise RuntimeError(f"no episodes rendered (failed: {failed})")
    if failed:
        log(f"[warn] failed episodes: {failed}")


def main() -> int:
    if len(sys.argv) < 2:
        log("worker: missing spec file argument")
        return 2
    spec = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8-sig"))
    try:
        if spec["kind"] == "download":
            do_download(spec)
        elif spec["kind"] == "upload":
            do_upload(spec)
        elif spec["kind"] == "ds_render":
            do_ds_render(spec)
        else:
            log(f"worker: unknown kind {spec['kind']!r}")
            return 2
        return 0
    except Exception as exc:
        log(f"ERROR: {exc.__class__.__name__}: {exc}")
        log(traceback.format_exc())
        return 1


if __name__ == "__main__":
    sys.exit(main())
