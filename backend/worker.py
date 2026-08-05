"""Transfer worker — runs one download/upload job, then exits.

Invoked as a subprocess by backend.jobs:  python -m backend.worker <spec.json>
Everything it prints (stdout+stderr merged by the parent) becomes the job log.
Heavy imports (lerobot / torch) happen lazily so a generic HF transfer stays
lightweight and a missing lerobot install only breaks lerobot jobs.
"""

from __future__ import annotations

import json
import os
import sys
import traceback
from pathlib import Path


def log(msg: str) -> None:
    print(msg, flush=True)


def artifact(path) -> None:
    """Tell the job runner about a file this job produced (see jobs.ARTIFACT_PREFIX)."""
    print(f"@@artifact@@ {path}", flush=True)


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
            produced = render_episode(root, info, row, out_dir, opts, name, log=log)
            artifact(produced)
            ok += 1
        except RenderError as exc:
            log(f"ERROR episode {ep}: {exc}")
            failed.append(ep)
    log(f"[render] {ok}/{len(episodes)} rendered into {out_dir}")
    if not ok:
        raise RuntimeError(f"no episodes rendered (failed: {failed})")
    if failed:
        log(f"[warn] failed episodes: {failed}")


# --------------------------------------------------------------------------- #
# Dataset edits
# --------------------------------------------------------------------------- #
def do_ds_set_tasks(spec: dict) -> None:
    from hfutil.dataset import meta as dsmeta
    from hfutil.dataset.edit import set_episode_tasks

    root = dsmeta.resolve_root(spec["ds_root"])
    mapping = {int(k): v for k, v in spec["episode_tasks"].items()}
    log(f"[task] updating {len(mapping)} episode(s)")
    res = set_episode_tasks(root, mapping, backup=spec.get("backup", True))
    if res["backup"]:
        log(f"[task] backup -> {res['backup']}")
    log(f"[task] {res['rows_changed']} frame rows repointed; {res['total_tasks']} tasks total")


def do_ds_export_subtasks(spec: dict) -> None:
    from hfutil.dataset import meta as dsmeta
    from hfutil.dataset.edit import export_subtasks

    root = dsmeta.resolve_root(spec["ds_root"])
    res = export_subtasks(root, backup=spec.get("backup", True), log=log)
    if res["backup"]:
        log(f"[subtask] backup -> {res['backup']}")
    log(f"[subtask] labels: {res['labels']}")
    log(f"[subtask] {res['frames_labelled']} frames labelled across "
        f"{res['episodes_annotated']} episode(s), {res['files_rewritten']} file(s) rewritten")


def do_ds_delete_episodes(spec: dict) -> None:
    """Delete episodes and re-index, via lerobot's own dataset_tools.

    Writes the re-indexed dataset to a sibling temp dir, verifies it on disk, then moves
    the original aside as a backup and swaps the new one in — both os.replace, so the
    dataset directory is never in a half-written state.
    """
    import json as _json
    import shutil
    from datetime import datetime

    from hfutil.dataset import meta as dsmeta

    root = dsmeta.resolve_root(spec["ds_root"])
    indices = sorted({int(i) for i in spec["episodes"]})
    if not indices:
        raise RuntimeError("no episodes selected")

    info = dsmeta.read_info(root)
    before = len(dsmeta.episodes(root, info))
    if len(indices) >= before:
        raise RuntimeError("refusing to delete every episode")

    log(f"[delete] {len(indices)} of {before} episodes: {indices}")
    log("[delete] loading dataset (this imports lerobot/torch)…")
    from lerobot.datasets.dataset_tools import delete_episodes as _delete
    from lerobot.datasets.lerobot_dataset import LeRobotDataset

    repo_id = spec.get("repo_id") or f"local/{root.name}"
    ds = LeRobotDataset(repo_id, root=str(root))

    stamp = datetime.now().strftime("%Y%m%dT%H%M%S")
    tmp_dir = root.parent / f".{root.name}.edit-{stamp}"
    if tmp_dir.exists():
        shutil.rmtree(tmp_dir, ignore_errors=True)

    log(f"[delete] writing re-indexed dataset to {tmp_dir.name}")
    _delete(ds, episode_indices=indices, output_dir=str(tmp_dir), repo_id=repo_id)
    del ds  # drop handles before touching the directories (Windows)

    # Trust the files on disk, not the return value.
    new_info = tmp_dir / "meta" / "info.json"
    if not new_info.is_file():
        shutil.rmtree(tmp_dir, ignore_errors=True)
        raise RuntimeError("delete produced no meta/info.json; nothing was changed")
    total = int(_json.loads(new_info.read_text(encoding="utf-8")).get("total_episodes", -1))
    if total != before - len(indices):
        shutil.rmtree(tmp_dir, ignore_errors=True)
        raise RuntimeError(
            f"expected {before - len(indices)} episodes after delete, found {total}; "
            "nothing was changed")

    # lerobot writes a fresh meta/ for the new dataset, so our sidecar would be lost.
    # Carry it across and renumber it, since every episode above a deleted one shifts.
    from hfutil.dataset.edit import ANNOTATIONS_FILE, remap_annotations
    src_ann = root / "meta" / ANNOTATIONS_FILE
    carried = None
    if src_ann.is_file():
        try:
            doc = _json.loads(src_ann.read_text(encoding="utf-8"))
            carried = remap_annotations(doc, indices)
            (tmp_dir / "meta" / ANNOTATIONS_FILE).write_text(
                _json.dumps(carried, indent=2, ensure_ascii=False), encoding="utf-8")
            log(f"[delete] carried annotations across "
                f"({len(doc.get('episodes', {}))} -> {len(carried['episodes'])} annotated episodes)")
        except Exception as exc:
            log(f"[warn] could not carry annotations over: {exc} "
                f"(they remain in the backup)")

    backup = root.parent / f"{root.name}.backup-delete-{len(indices)}ep.{stamp}"
    os.replace(root, backup)
    os.replace(tmp_dir, root)
    log(f"[delete] done — {total} episodes remain")
    log(f"[delete] original moved to {backup}")
    artifact(backup)


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
        elif spec["kind"] == "ds_set_tasks":
            do_ds_set_tasks(spec)
        elif spec["kind"] == "ds_export_subtasks":
            do_ds_export_subtasks(spec)
        elif spec["kind"] == "ds_delete_episodes":
            do_ds_delete_episodes(spec)
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
