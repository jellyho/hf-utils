"""Video file resolution, codec probing, and ffmpeg/font discovery.

Playback strategy: LeRobot v3.0 packs many episodes into one MP4, so an episode is a
*window* into a shared file. We serve the whole file with HTTP Range and let the browser
seek — verified viable on real data: the files are written with the moov atom at the front
and a keyframe every ~2 frames, so an arbitrary seek costs one range request and a couple
of decoded frames. Cutting per-episode clips would cost far more (CPU + temp files) and
buys nothing.
"""

from __future__ import annotations

import functools
import os
import shutil
from pathlib import Path
from typing import Optional

# Fonts tried for ffmpeg drawtext labels, in order. A missing font must never fail a
# render — the caller drops the drawtext filters instead.
_FONT_CANDIDATES = (
    os.environ.get("HFUTIL_FONT", ""),
    # Windows
    r"C:\Windows\Fonts\consola.ttf",
    r"C:\Windows\Fonts\arial.ttf",
    r"C:\Windows\Fonts\segoeui.ttf",
    # Linux
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf",
    "/usr/share/fonts/TTF/DejaVuSansMono.ttf",
    # macOS
    "/System/Library/Fonts/Supplemental/Menlo.ttc",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
)


def safe_join(root: Path, relative: str) -> Path:
    """Join ``relative`` onto ``root``, refusing to escape it.

    Containment is checked **lexically** (``normpath``), deliberately *not* via
    ``Path.resolve()``: in the Hugging Face cache every dataset file is a symlink into
    ``../../blobs/<sha>``, so resolving first would reject datasets viewed straight out of
    the cache. Traversal is still impossible because the path is built from an info.json
    template with a validated feature key and integer chunk/file indices.
    """
    candidate = Path(os.path.normpath(str(root / relative)))
    if not candidate.is_relative_to(root):
        raise ValueError(f"path escapes dataset root: {relative}")
    return candidate


def video_file(root: Path, info: dict, key: str, chunk: int, file: int) -> Path:
    """Resolve a camera's MP4 via the ``video_path`` template from info.json."""
    template = info.get("video_path") or (
        "videos/{video_key}/chunk-{chunk_index:03d}/file-{file_index:03d}.mp4"
    )
    return safe_join(root, template.format(video_key=key, chunk_index=chunk, file_index=file))


@functools.lru_cache(maxsize=1)
def find_ffmpeg() -> Optional[str]:
    """A user's own ffmpeg first, else the one imageio-ffmpeg ships with the venv."""
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    try:
        import imageio_ffmpeg

        exe = imageio_ffmpeg.get_ffmpeg_exe()
        return exe if exe and Path(exe).exists() else None
    except Exception:
        return None


@functools.lru_cache(maxsize=1)
def find_font() -> Optional[str]:
    for candidate in _FONT_CANDIDATES:
        if candidate and Path(candidate).is_file():
            return candidate
    try:  # matplotlib always ships DejaVuSans; use it as a last resort
        from matplotlib import font_manager

        path = font_manager.findfont("DejaVu Sans", fallback_to_default=False)
        return path if path and Path(path).is_file() else None
    except Exception:
        return None


def ff_escape_path(path: str) -> str:
    r"""Escape a Windows path for use *inside* an ffmpeg filtergraph.

    ``C:\Windows\Fonts\consola.ttf`` must become ``C\:/Windows/Fonts/consola.ttf``:
    backslashes confuse the filter parser, and the drive colon separates filter options.
    """
    return path.replace("\\", "/").replace(":", r"\:")


def ff_escape_text(text: str) -> str:
    """Make a label safe for ``drawtext=text='...'``."""
    safe = "".join(c if (c.isalnum() or c in " ._-/") else " " for c in text)
    return safe.strip()[:80]


def probe(path: Path) -> dict:
    """Codec/resolution via PyAV (imageio-ffmpeg does not bundle ffprobe)."""
    try:
        import av
    except ImportError:
        return {"error": "PyAV not installed"}
    try:
        with av.open(str(path)) as container:
            stream = container.streams.video[0]
            ctx = stream.codec_context
            # PyAV reports the *decoder* name; map the common ones back to the codec.
            codec = {"libdav1d": "av1", "libaom-av1": "av1"}.get(ctx.name, ctx.name)
            return {
                "codec": codec,
                "pix_fmt": ctx.pix_fmt,
                "width": ctx.width,
                "height": ctx.height,
                "duration": float(container.duration or 0) / 1e6,
                "fps": float(stream.average_rate or 0),
                # AV1 needs a reasonably modern browser; Safari < 17/M3 can't decode it.
                "browser_ok": codec in {"h264", "avc1", "vp9", "av1", "vp8"},
            }
    except Exception as exc:
        return {"error": f"{exc.__class__.__name__}: {exc}"}


def capabilities() -> dict:
    """What optional tooling is available, so the UI can disable what won't work."""
    ffmpeg = find_ffmpeg()
    font = find_font()
    source = None
    if ffmpeg:
        source = "PATH" if shutil.which("ffmpeg") else "imageio-ffmpeg"
    return {
        "ffmpeg": ffmpeg,
        "ffmpeg_source": source,
        "font": font,
        "can_render": bool(ffmpeg),
        "can_label": bool(ffmpeg and font),
    }
