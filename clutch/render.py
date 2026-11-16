"""Render a clip to a 1080x1920 short with ffmpeg."""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path
from typing import Callable, Optional

from . import captions, config

W, H = config.OUT_W, config.OUT_H


def _even(v: float) -> int:
    return max(2, int(round(v / 2)) * 2)


def resolve_layout(style: dict, facecam: Optional[list]) -> str:
    """Split needs a facecam box; without one, fall back to the blurred layout."""
    layout = style.get("layout", "blur")
    return "blur" if layout == "split" and not facecam else layout


def caption_y(layout: str, style: dict) -> int:
    if layout == "split":
        return _even(H * float(style.get("cam_ratio", 0.36)))   # sit on the seam
    return int(H * 0.72)


def filter_graph(style: dict, facecam: Optional[list], fps: float, subs: Optional[str]) -> str:
    layout = resolve_layout(style, facecam)
    fx = min(max(float(style.get("focus_x", 0.5)), 0.0), 1.0)
    if layout == "crop":
        g = (f"[0:v]scale={W}:{H}:force_original_aspect_ratio=increase,"
             f"crop={W}:{H}:(iw-{W})*{fx}:(ih-{H})/2[v]")
    elif layout == "split":
        cam_h = _even(H * float(style.get("cam_ratio", 0.36)))
        game_h = H - cam_h
        x, y, w, h = facecam
        g = (f"[0:v]split[a][b];"
             f"[a]crop=iw*{w:.4f}:ih*{h:.4f}:iw*{x:.4f}:ih*{y:.4f},"
             f"scale={W}:{cam_h}:force_original_aspect_ratio=increase,crop={W}:{cam_h}[cam];"
             f"[b]scale={W}:{game_h}:force_original_aspect_ratio=increase,"
             f"crop={W}:{game_h}:(iw-{W})*{fx}:(ih-{game_h})/2[game];"
             f"[cam][game]vstack[v]")
    else:
        zoom = min(max(float(style.get("zoom", 1.0)), 1.0), 1.8)
        fg_w = _even(W * zoom)
        # Blur at quarter size: same look, a fraction of the cost.
        g = (f"[0:v]split[a][b];"
             f"[a]scale={W // 4}:{H // 4}:force_original_aspect_ratio=increase,crop={W // 4}:{H // 4},"
             f"boxblur=8:2,scale={W}:{H},eq=brightness=-0.10[bg];"
             f"[b]scale={fg_w}:-2,crop={W}:ih:(iw-{W})*{fx}:0[fg];"
             f"[bg][fg]overlay=0:(H-h)/2[v]")
    tail = f"[v]fps={fps:g},setsar=1"
    if subs:
        tail += f",subtitles={subs}:fontsdir=fonts"
    return g + ";" + tail + ",format=yuv420p[out]"


def render(src: Path, out: Path, *, start: float, end: float, style: dict, facecam: Optional[list],
           words: list[list], title: str, info: dict,
           progress: Callable[[float], None] = lambda f: None) -> None:
    work = out.parent
    work.mkdir(parents=True, exist_ok=True)
    duration = max(end - start, 0.5)
    layout = resolve_layout(style, facecam)
    want_caps = bool(style.get("captions")) and bool(words)
    want_title = bool(style.get("show_title")) and bool(title)
    subs = None
    if want_caps or want_title:
        fonts = work / "fonts"
        fonts.mkdir(exist_ok=True)
        for f in config.FONTS_DIR.glob("*.ttf"):
            if not (fonts / f.name).exists():
                shutil.copy(f, fonts / f.name)
        subs = f"{out.stem}.ass"
        captions.write(work / subs, words if want_caps else [], start, end,
                       y=caption_y(layout, style), upper=style.get("caption_case", "upper") == "upper",
                       title=title if want_title else "",
                       # in the split layout the top is the streamer's face, so the title goes on the gameplay
                       title_y=caption_y(layout, style) + 150 if layout == "split" else 210)
    fps = min(info.get("fps") or 30.0, 60.0)
    cmd = ["ffmpeg", "-y", "-v", "error", "-ss", f"{start:.3f}", "-t", f"{duration:.3f}", "-i", str(src),
           "-filter_complex", filter_graph(style, facecam, fps, subs), "-map", "[out]"]
    if info.get("has_audio"):
        cmd += ["-map", "0:a:0", "-af", "loudnorm=I=-14:TP=-1.5:LRA=11", "-c:a", "aac", "-b:a", "160k", "-ar", "48000"]
    cmd += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-movflags", "+faststart",
            "-progress", "pipe:1", "-nostats", out.name]
    # Run inside the clip folder so the subtitle and font paths need no escaping.
    proc = subprocess.Popen(cmd, cwd=work, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    for line in proc.stdout:
        if line.startswith("out_time_ms=") or line.startswith("out_time_us="):
            try:
                progress(min(int(line.split("=")[1]) / 1e6 / duration, 0.99))
            except ValueError:
                pass
    err = proc.stderr.read()
    if proc.wait() != 0:
        raise RuntimeError(f"ffmpeg could not render this clip: {err.strip()[-400:]}")
    progress(1.0)
