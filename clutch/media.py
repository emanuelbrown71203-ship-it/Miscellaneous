"""ffmpeg / ffprobe / yt-dlp helpers."""
from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Callable, Optional

import numpy as np


def probe(path: Path) -> dict:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)],
        capture_output=True, text=True, check=True,
    ).stdout
    info = json.loads(out)
    v = next((s for s in info["streams"] if s["codec_type"] == "video"), None)
    a = next((s for s in info["streams"] if s["codec_type"] == "audio"), None)
    if v is None:
        raise ValueError("This file has no video track.")
    num, _, den = (v.get("avg_frame_rate") or "30/1").partition("/")
    fps = float(num) / float(den or 1) if float(den or 1) else 30.0
    duration = float(info["format"].get("duration") or v.get("duration") or 0)
    return {
        "duration": duration,
        "width": int(v["width"]),
        "height": int(v["height"]),
        "fps": fps or 30.0,
        "has_audio": a is not None,
        "vcodec": v.get("codec_name"),
    }


def download(url: str, dest: Path, progress: Callable[[float, str], None],
             section: Optional[list] = None) -> tuple[Path, dict]:
    """Download a video or VOD with yt-dlp. Returns (file, metadata)."""
    import yt_dlp

    def hook(d):
        if d.get("status") == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            frac = d.get("downloaded_bytes", 0) / total if total else 0
            progress(min(frac, 0.99), "Downloading")

    opts = {
        # Prefer H.264 + AAC so the browser can preview the source directly.
        "format": "bv*[vcodec^=avc1][height<=1080]+ba[acodec^=mp4a]/b[vcodec^=avc1][height<=1080]/bv*[height<=1080]+ba/b",
        "merge_output_format": "mp4",
        "outtmpl": str(dest / "source.%(ext)s"),
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "progress_hooks": [hook],
        "writesubtitles": True,
        "subtitleslangs": ["live_chat"],   # YouTube live chat replay, when the video has one
        "ignoreerrors": False,
    }
    if section:
        opts["download_ranges"] = yt_dlp.utils.download_range_func(None, [(float(section[0]), float(section[1]))])
        opts["force_keyframes_at_cuts"] = False
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=True)
    files = [p for p in dest.glob("source.*") if p.suffix.lower() in (".mp4", ".mkv", ".webm", ".mov")]
    if not files:
        raise RuntimeError("The download finished but no video file was produced.")
    meta = {
        "title": info.get("title") or "Untitled",
        "extractor": (info.get("extractor_key") or "").lower(),
        "video_id": str(info.get("id") or ""),
        "uploader": info.get("uploader") or info.get("channel") or "",
        "webpage_url": info.get("webpage_url") or url,
    }
    return files[0], meta


def read_audio(path: Path, start: float, duration: float, sr: int = 16000) -> np.ndarray:
    """Decode a span of audio to mono float32."""
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-ss", f"{start:.3f}", "-t", f"{duration:.3f}", "-i", str(path),
         "-vn", "-ac", "1", "-ar", str(sr), "-f", "s16le", "-"],
        capture_output=True, check=True,
    ).stdout
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0


def grab_frame(path: Path, t: float, width: int = 0) -> bytes:
    """Return one JPEG frame at time t."""
    vf = ["-vf", f"scale={width}:-2"] if width else []
    return subprocess.run(
        ["ffmpeg", "-v", "error", "-ss", f"{max(t, 0):.3f}", "-i", str(path), "-frames:v", "1", *vf,
         "-q:v", "3", "-f", "image2pipe", "-vcodec", "mjpeg", "-"],
        capture_output=True, check=True,
    ).stdout
