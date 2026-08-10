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

# How many files a transfer may have in flight at once.
#
# The Hub's Xet backend does not stream a file straight to disk -- it fetches content-defined
# chunks in parallel and reassembles them through an in-memory buffer, one per file in flight,
# with nothing bounding the total. snapshot_download's own default of 8 workers came out as 16
# files in flight, so this halves the multiplier. It does NOT bound the buffer itself; see
# _use_xet.
MAX_PARALLEL_FILES = int(os.environ.get("HFUTIL_MAX_PARALLEL_FILES", "4"))

# Below this much free RAM, prefer the streaming download over the fast one (see _use_xet).
# Xet's buffer is sized off the file, and checkpoint shards here are ~3 GB; leaving several GB
# of headroom on top of one shard's worth keeps a concurrent job -- a robot recorder holding an
# episode, a training run -- from being the thing that gets killed.
LOW_MEMORY_GB = float(os.environ.get("HFUTIL_LOW_MEMORY_GB", "10"))

# How many of a partial download's file patterns to echo into the log before summarising.
PATTERN_LOG_LIMIT = 40


def _available_ram_gb() -> float:
    try:
        with open("/proc/meminfo") as fh:
            for line in fh:
                if line.startswith("MemAvailable:"):
                    return int(line.split()[1]) / 1e6
    except Exception:
        pass
    return float("inf")   # unknown (not Linux): do not second-guess the default


def _use_xet() -> bool:
    """Whether to let the Hub use its Xet backend, given how much RAM is free right now.

    Measured on one 3.08 GB checkpoint shard:

        Xet on    peak RSS 1.88 GB    11.5 MB/s
        Xet off   peak RSS 0.06 GB     5.5 MB/s

    Xet buffers roughly 60% of a file in memory to reconstruct it, and pays for that with
    about double the throughput. Neither setting wins outright, and the right answer depends
    on what else the machine is doing: on an idle box the memory is free and the speed is
    worth having, while against a live robot recorder that same 2 GB is what pushes the box
    into swap and gets the recorder OOM-killed mid-episode -- losing an episode to save an
    hour of download is a bad trade. So choose on free RAM rather than picking a side.

    HFUTIL_USE_XET=0/1 forces it either way.
    """
    forced = os.environ.get("HFUTIL_USE_XET")
    if forced is not None:
        return forced not in ("0", "false", "no")
    return _available_ram_gb() >= LOW_MEMORY_GB


def _bound_transfer_memory() -> None:
    """Cap the Xet transfer buffers before huggingface_hub is imported.

    Uploads buffer the same way downloads do -- ingestion chunks each file in memory before
    packing it into a xorb -- so both directions get the same ceiling.

    Xet reads its configuration from the environment once, inside the Rust extension, so this
    has to happen before the first import. Anything already set in the environment wins -- a
    caller who deliberately tuned this keeps their value.
    """
    os.environ.setdefault("HF_XET_DATA_MAX_CONCURRENT_FILE_DOWNLOADS", str(MAX_PARALLEL_FILES))
    os.environ.setdefault("HF_XET_DATA_MAX_CONCURRENT_FILE_INGESTION", str(MAX_PARALLEL_FILES))

    why = ("HFUTIL_USE_XET" if os.environ.get("HFUTIL_USE_XET") is not None
           else f"{_available_ram_gb():.0f} GB RAM free, threshold {LOW_MEMORY_GB:.0f}")
    if _use_xet():
        log(f"[hf] fast transfer via Xet ({why}) — expect a couple of GB resident")
    else:
        os.environ["HF_HUB_DISABLE_XET"] = "1"
        log(f"[hf] streaming transfer ({why}) — about half the speed, but stays under 100 MB")


def do_download(spec: dict) -> None:
    repo_id = spec["repo_id"]
    repo_type = spec["repo_type"]
    local_dir = spec["local_dir"]
    Path(local_dir).mkdir(parents=True, exist_ok=True)
    _bound_transfer_memory()

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

        # A partial download. Spell the rules out in the log: months later the job card is
        # the only record of why a folder holds 12 files instead of the repo's 340.
        allow = spec.get("allow_patterns") or None
        if allow:
            log(f"[hf] partial download — keeping only paths matching {len(allow)} rule(s):")
            for pattern in allow[:PATTERN_LOG_LIMIT]:
                log(f"[hf]   + {pattern}")
            if len(allow) > PATTERN_LOG_LIMIT:
                log(f"[hf]   … and {len(allow) - PATTERN_LOG_LIMIT} more")

        path = snapshot_download(
            repo_id=repo_id,
            repo_type=repo_type,
            local_dir=local_dir,
            max_workers=MAX_PARALLEL_FILES,
            allow_patterns=allow,
        )
        log(f"[hf] done -> {path}")


# --------------------------------------------------------------------------- #
# Upload
# --------------------------------------------------------------------------- #

# Above either of these, an upload is worth doing the resumable way. Both thresholds are
# well under what this tool is normally pointed at (a LeRobot dataset or a checkpoint repo
# runs to tens of GB) and well above a stray config folder, where several commits for a few
# megabytes would be worse than just sending it.
LARGE_UPLOAD_BYTES = 5_000_000_000
LARGE_UPLOAD_FILES = 200


def _folder_size(path: str) -> tuple[int, int]:
    """(file count, total bytes), skipping the caches the Hub client keeps inside the folder."""
    n = total = 0
    for root, dirs, files in os.walk(path):
        dirs[:] = [d for d in dirs if d != ".cache"]
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
                n += 1
            except OSError:
                pass
    return n, total


def do_upload(spec: dict) -> None:
    repo_id = spec["repo_id"]
    repo_type = spec["repo_type"]
    local_dir = spec["local_dir"]
    private = spec["private"]

    if not Path(local_dir).is_dir():
        raise FileNotFoundError(f"Local folder does not exist: {local_dir}")
    _bound_transfer_memory()

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

        n_files, n_bytes = _folder_size(local_dir)
        if n_bytes >= LARGE_UPLOAD_BYTES or n_files >= LARGE_UPLOAD_FILES:
            # upload_large_folder keeps its progress in <folder>/.cache/.huggingface, so an
            # interrupted upload picks up where it stopped instead of re-hashing and
            # re-sending everything. The cost is that it lands as several commits rather
            # than one, which is why a small folder still takes the plain path.
            log(f"[hf] upload_large_folder {local_dir} -> '{repo_id}' "
                f"({n_files} files, {n_bytes / 1e9:.1f} GB, {MAX_PARALLEL_FILES} workers)")
            api.upload_large_folder(
                repo_id=repo_id,
                folder_path=local_dir,
                repo_type=repo_type,
                num_workers=MAX_PARALLEL_FILES,
            )
            log(f"[hf] uploaded -> {api.endpoint}/{repo_id}")
            return

        log(f"[hf] upload_folder {local_dir} -> '{repo_id}' "
            f"({n_files} files, {n_bytes / 1e9:.1f} GB)")
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
    ok, failed, made = 0, [], []
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
            made.append(Path(produced))
            ok += 1
        except RenderError as exc:
            log(f"ERROR episode {ep}: {exc}")
            failed.append(ep)
    log(f"[render] {ok}/{len(episodes)} rendered into {out_dir}")
    if not ok:
        raise RuntimeError(f"no episodes rendered (failed: {failed})")
    if failed:
        log(f"[warn] failed episodes: {failed}")

    if spec.get("zip_output"):
        bundle = _zip_files(made, out_dir, f"{name}_{ok}ep_{opts.fmt}")
        log(f"[render] bundled {ok} file(s) -> {bundle}")
        log("[render] the individual files are kept as well")
        artifact(bundle)


def _zip_files(paths, out_dir: Path, stem: str) -> Path:
    """Bundle rendered clips into one archive beside them.

    Stored, not deflated: MP4 and GIF are already compressed, so deflate spends real CPU on
    a percent or so. The point of the zip is one file to copy, not a smaller one.
    """
    import zipfile

    target = out_dir / f"{stem}.zip"
    n = 2
    while target.exists():          # never silently replace an earlier bundle
        target = out_dir / f"{stem}({n}).zip"
        n += 1

    tmp = target.with_suffix(".zip.part")
    with zipfile.ZipFile(tmp, "w", compression=zipfile.ZIP_STORED, allowZip64=True) as zf:
        for i, path in enumerate(paths, 1):
            path = Path(path)
            if not path.is_file():
                log(f"[warn] missing when zipping: {path}")
                continue
            log(f"[zip] {i}/{len(paths)} {path.name}")
            zf.write(path, arcname=path.name)
    os.replace(tmp, target)         # only appears once it is complete
    return target


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

    # Same for the recorder's outcomes sidecar, when the dataset has one.
    from hfutil.dataset import profiles as _profiles
    src_out = _profiles.outcomes_path(root)
    if src_out.is_file():
        try:
            remapped = _profiles.remap_outcomes(_profiles.read_outcomes(root), indices)
            _profiles.write_outcomes(tmp_dir, remapped)
            log(f"[delete] carried outcomes.jsonl across ({len(remapped)} episodes)")
        except Exception as exc:
            log(f"[warn] could not carry outcomes.jsonl over: {exc} (it remains in the backup)")

    backup = root.parent / f"{root.name}.backup-delete-{len(indices)}ep.{stamp}"
    os.replace(root, backup)
    os.replace(tmp_dir, root)
    log(f"[delete] done — {total} episodes remain")
    log(f"[delete] original moved to {backup}")
    artifact(backup)


def do_ds_split(spec: dict) -> None:
    """Split into new datasets. Non-destructive: the source is only read."""
    from hfutil.dataset import meta as dsmeta

    root = dsmeta.resolve_root(spec["ds_root"])
    out_dir = Path(spec["out_dir"])
    splits = spec["splits"]          # {"train": 0.8, "val": 0.2} or {"train": [0,1,2], …}
    log(f"[split] {root.name} -> {out_dir}  ({', '.join(splits)})")
    log("[split] loading dataset (this imports lerobot/torch)…")

    from lerobot.datasets.dataset_tools import split_dataset as _split
    from lerobot.datasets.lerobot_dataset import LeRobotDataset

    repo_id = spec.get("repo_id") or f"local/{root.name}"
    ds = LeRobotDataset(repo_id, root=str(root))
    out_dir.mkdir(parents=True, exist_ok=True)
    result = _split(ds, splits=splits, output_dir=str(out_dir))
    del ds

    for name in result:
        path = out_dir / name
        if path.is_dir():
            n = dsmeta.read_info(path).get("total_episodes", "?")
            log(f"[split] {name}: {n} episodes -> {path}")
            artifact(path)
    log(f"[split] done — source dataset untouched")


def do_ds_merge(spec: dict) -> None:
    """Merge several datasets into a new one. Non-destructive."""
    from hfutil.dataset import meta as dsmeta

    roots = [dsmeta.resolve_root(p) for p in spec["roots"]]
    out_dir = Path(spec["out_dir"])
    if len(roots) < 2:
        raise RuntimeError("merging needs at least two datasets")

    # Fail early on a mismatch rather than halfway through the copy.
    infos = [dsmeta.read_info(r) for r in roots]
    fps = {int(i.get("fps") or 0) for i in infos}
    if len(fps) > 1:
        raise RuntimeError(f"datasets disagree on fps: {sorted(fps)}")
    feats = [tuple(sorted((i.get("features") or {}).keys())) for i in infos]
    if len(set(feats)) > 1:
        only = set(feats[0]).symmetric_difference(*[set(f) for f in feats[1:]])
        raise RuntimeError(f"datasets have different features; differing keys: {sorted(only)}")

    log(f"[merge] {len(roots)} datasets -> {out_dir}")
    for r, i in zip(roots, infos):
        log(f"[merge]   {r.name}: {i.get('total_episodes')} episodes")
    log("[merge] loading datasets (this imports lerobot/torch)…")

    from lerobot.datasets.dataset_tools import merge_datasets as _merge
    from lerobot.datasets.lerobot_dataset import LeRobotDataset

    dss = [LeRobotDataset(f"local/{r.name}", root=str(r)) for r in roots]
    out_dir.parent.mkdir(parents=True, exist_ok=True)
    _merge(dss, output_repo_id=spec.get("repo_id") or f"local/{out_dir.name}",
           output_dir=str(out_dir))
    del dss

    total = dsmeta.read_info(out_dir).get("total_episodes", "?")
    log(f"[merge] done — {total} episodes at {out_dir}")
    artifact(out_dir)


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
        elif spec["kind"] == "ds_split":
            do_ds_split(spec)
        elif spec["kind"] == "ds_merge":
            do_ds_merge(spec)
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
