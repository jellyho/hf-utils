"""Render an episode (or a slice of one) to MP4 or GIF with ffmpeg.

An episode is a window into a shared per-camera MP4, so rendering is a single ffmpeg
invocation: seek each camera input to the episode's window, normalise the panels to a
common height, stack them, burn in whatever overlay was asked for, and encode.

Everything is derived from the dataset's own metadata — camera list, resolutions, fps,
task string — so this works on any v3.0 dataset rather than one robot's layout.
"""

from __future__ import annotations

import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Optional

from .video import (
    ff_escape_path,
    ff_escape_text,
    find_ffmpeg,
    find_font,
    video_file,
)


@dataclass
class RenderOptions:
    cameras: list[str] = field(default_factory=list)   # [] = every camera, in meta order
    speed: float = 1.0
    height: int = 320                 # panel height; widths follow each aspect ratio
    fps_cap: int = 60                 # mp4 only
    frame_start: int = 0              # inclusive, episode-local
    frame_end: Optional[int] = None   # inclusive; None = last frame
    fmt: str = "mp4"                  # "mp4" | "gif"
    gif_fps: int = 12
    gif_width: int = 640              # total strip width after stacking
    # burn-in overlay
    show_camera_labels: bool = True
    show_counter: bool = True         # dataset · episode · timecode · frame number
    show_task: bool = False
    # container metadata (mp4 only; a GIF has no tag stream)
    write_metadata: bool = True


class RenderError(Exception):
    pass


def _drawtext(font: Optional[str], text: str, x: str, y: str, size: int) -> str:
    """A drawtext filter with a translucent box. Returns "" when no font is available —
    a missing font must degrade to an unlabelled render, never fail one."""
    if not font:
        return ""
    return (
        f"drawtext=fontfile='{ff_escape_path(font)}':text='{text}':x={x}:y={y}:"
        f"fontsize={size}:fontcolor=white:box=1:boxcolor=black@0.5:boxborderw=6"
    )


def _episode_window(ep_row: dict, key: str, fps: int, opts: RenderOptions) -> tuple[float, float]:
    """Absolute [start, end] seconds in the shared file for the requested frame slice."""
    win = ep_row["videos"][key]
    length = int(ep_row["length"])
    f0 = max(0, int(opts.frame_start))
    f1 = length - 1 if opts.frame_end is None else min(int(opts.frame_end), length - 1)
    if f1 < f0:
        raise RenderError(f"empty frame range: {f0}..{f1}")
    t0 = win["from_timestamp"] + f0 / fps
    # +1 so the last requested frame is included, clamped to the episode's own window
    t1 = min(win["from_timestamp"] + (f1 + 1) / fps, win["to_timestamp"])
    if t1 <= t0:
        raise RenderError(f"empty time window: {t0:.3f}..{t1:.3f}")
    return t0, t1


def build_command(
    root: Path,
    info: dict,
    ep_row: dict,
    out_path: Path,
    opts: RenderOptions,
    dataset_name: str,
) -> list[str]:
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        raise RenderError(
            "ffmpeg not found. Install it on PATH, or `pip install imageio-ffmpeg` "
            "to use the bundled binary."
        )
    fps = int(info.get("fps") or 30)
    font = find_font()

    available = list(ep_row.get("videos") or {})
    cams = [c for c in (opts.cameras or available) if c in available]
    if not cams:
        raise RenderError("no cameras available for this episode")

    cmd: list[str] = [ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-stats"]
    for key in cams:
        t0, t1 = _episode_window(ep_row, key, fps, opts)
        mp4 = video_file(root, info, key, ep_row["videos"][key]["chunk"], ep_row["videos"][key]["file"])
        if not mp4.is_file():
            raise RenderError(f"missing video for {key}: {mp4.name}")
        # Input-level seek: ffmpeg decodes only the requested window.
        cmd += ["-ss", f"{t0:.6f}", "-to", f"{t1:.6f}", "-i", str(mp4)]

    # --- per-panel chains ---------------------------------------------------
    # scale to a common height is mandatory, not cosmetic: hstack refuses inputs of
    # differing height, and real datasets mix resolutions (e.g. 640x480 + 320x240).
    chains: list[str] = []
    tags: list[str] = []
    for i, key in enumerate(cams):
        chain = f"scale=-2:{opts.height},setsar=1"
        if opts.show_camera_labels:
            label = _drawtext(font, ff_escape_text(key.replace("observation.images.", "")),
                              x="8", y="h-th-8", size=max(12, opts.height // 18))
            if label:
                chain += "," + label
        chains.append(f"[{i}:v]{chain}[p{i}]")
        tags.append(f"[p{i}]")

    # The per-panel chains must be part of the graph, not just referenced by it —
    # without them the [pN] labels are undefined, which silently skips the scaling
    # (panels come out at native size) and hard-fails for a single camera.
    graph = ";".join(chains) + ";" + "".join(tags)
    if len(cams) > 1:
        graph += f"hstack=inputs={len(cams)}"
    else:
        # hstack rejects inputs=1 ("out of range [2 - ...]"); one camera needs no stack.
        graph += "null"

    # --- burn-in overlay ----------------------------------------------------
    header_bits: list[str] = []
    if opts.show_counter:
        header_bits.append(
            f"{ff_escape_text(dataset_name)}  ep{ep_row['ep']}  "
            r"t=%{pts\:hms}  f=%{eif\:n\:d}"
        )
    if opts.show_task:
        task = (ep_row.get("tasks") or [""])[0]
        if task:
            header_bits.append(ff_escape_text(task))
    if header_bits:
        size = max(13, opts.height // 20)
        for n, text in enumerate(header_bits):
            head = _drawtext(font, text, x="8", y=str(8 + n * (size + 10)), size=size)
            if head:
                graph += "," + head

    if opts.speed and opts.speed != 1.0:
        graph += f",setpts=PTS/{opts.speed}"

    # --- format -------------------------------------------------------------
    if opts.fmt == "gif":
        # Two-stage palette: a global 256-colour palette makes GIFs of camera footage
        # look washed out, so generate one per scene change and dither against it.
        graph += (
            f",fps={opts.gif_fps},scale={opts.gif_width}:-1:flags=lanczos,"
            "split[gs][gp];[gp]palettegen=stats_mode=diff[pal];"
            "[gs][pal]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle[out]"
        )
        cmd += ["-filter_complex", graph, "-map", "[out]", "-loop", "0", str(out_path)]
        return cmd

    graph += "[out]"
    # Speeding up raises the effective rate (setpts only rescales timestamps); cap it,
    # but never *above* what the sped-up stream actually contains — forcing 60 fps on a
    # 1x render of 20 fps footage would just triplicate every frame.
    out_rate = max(1, min(int(round(fps * max(opts.speed, 0.01))), opts.fps_cap))
    cmd += [
        "-filter_complex", graph,
        "-map", "[out]",
        "-an",
        "-r", str(out_rate),
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-crf", "20",
        "-movflags", "+faststart",
    ]
    if opts.write_metadata:
        task = (ep_row.get("tasks") or [""])[0]
        cmd += [
            "-metadata", f"title={dataset_name} episode {ep_row['ep']}",
            "-metadata", f"comment=task={task}; frames={ep_row['length']}; fps={fps}; "
                         f"speed={opts.speed}x; cameras={','.join(cams)}",
        ]
    cmd += [str(out_path)]
    return cmd


def output_name(dataset_name: str, ep: int, opts: RenderOptions) -> str:
    speed = f"{opts.speed:g}x"
    span = ""
    if opts.frame_start or opts.frame_end is not None:
        span = f"_f{opts.frame_start}-{opts.frame_end if opts.frame_end is not None else 'end'}"
    return f"{dataset_name}_ep{ep}{span}_{speed}.{opts.fmt}"


def render_episode(
    root: Path,
    info: dict,
    ep_row: dict,
    out_dir: Path,
    opts: RenderOptions,
    dataset_name: str,
    log=print,
) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / output_name(dataset_name, ep_row["ep"], opts)
    cmd = build_command(root, info, ep_row, out_path, opts, dataset_name)
    log(f"[render] episode {ep_row['ep']} -> {out_path.name}")
    proc = subprocess.run(cmd, capture_output=True, text=True,
                          encoding="utf-8", errors="replace")
    if proc.returncode != 0:
        tail = (proc.stderr or "").strip().splitlines()[-8:]
        raise RenderError(f"ffmpeg failed for episode {ep_row['ep']}:\n" + "\n".join(tail))
    size = out_path.stat().st_size if out_path.exists() else 0
    log(f"[render] done {out_path.name} ({size / 1e6:.1f} MB)")
    return out_path
