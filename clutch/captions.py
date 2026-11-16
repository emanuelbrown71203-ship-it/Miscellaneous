"""Word-by-word animated captions as an ASS subtitle file (burned in by ffmpeg/libass)."""
from __future__ import annotations

from pathlib import Path

from . import config

WHITE, YELLOW = "&HFFFFFF&", "&H3DC5FF&"   # ASS colours are BGR


def _ts(t: float) -> str:
    t = max(t, 0.0)
    h, rem = divmod(t, 3600)
    m, s = divmod(rem, 60)
    return f"{int(h)}:{int(m):02d}:{s:05.2f}"


def _clean(word: str, upper: bool) -> str:
    word = word.replace("{", "(").replace("}", ")").replace("\\", "").strip().rstrip(",.;:")
    return word.upper() if upper else word


def chunk_words(words: list[list], max_words: int = 3, max_chars: int = 16, max_gap: float = 0.6) -> list[list[list]]:
    """Group words into short on-screen phrases."""
    chunks, cur = [], []
    for w in words:
        if cur:
            chars = sum(len(x[2]) for x in cur) + len(cur) + len(w[2])
            if len(cur) >= max_words or chars > max_chars or w[0] - cur[-1][1] > max_gap:
                chunks.append(cur)
                cur = []
        cur.append(w)
    if cur:
        chunks.append(cur)
    return chunks


def build_ass(words: list[list], start: float, end: float, *, y: int, upper: bool = True,
              title: str = "", title_y: int = 210) -> str:
    """Build the subtitle file for one clip. Times are shifted so the clip starts at 0."""
    head = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {config.OUT_W}
PlayResY: {config.OUT_H}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,Anton,104,&H00FFFFFF,&H00FFFFFF,&H00000000,&H96000000,0,0,0,0,100,100,1,0,1,7,3,5,40,40,40,1
Style: Title,Anton,64,&H00141414,&H00141414,&H003DC5FF,&H003DC5FF,0,0,0,0,100,100,1,0,3,14,0,5,60,60,40,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    lines = []
    if title:
        text = _clean(title, upper)
        lines.append(f"Dialogue: 1,{_ts(0)},{_ts(min(3.0, end - start))},Title,,0,0,0,,"
                     f"{{\\pos({config.OUT_W // 2},{title_y})\\fad(120,250)}}{text}")
    inside = [[max(w[0], start) - start, min(w[1], end) - start, _clean(w[2], upper)]
              for w in words if w[1] > start and w[0] < end]
    inside = [w for w in inside if w[2]]
    chunks = chunk_words(inside)
    for ci, chunk in enumerate(chunks):
        next_start = chunks[ci + 1][0][0] if ci + 1 < len(chunks) else end - start
        for wi, w in enumerate(chunk):
            t0 = w[0]
            t1 = chunk[wi + 1][0] if wi + 1 < len(chunk) else min(w[1] + 0.35, next_start)
            if t1 - t0 < 0.02:
                continue
            parts = [f"{{\\c{YELLOW}}}{x[2]}{{\\c{WHITE}}}" if k == wi else x[2] for k, x in enumerate(chunk)]
            pop = "\\fscx88\\fscy88\\t(0,90,\\fscx100\\fscy100)" if wi == 0 else ""
            lines.append(f"Dialogue: 0,{_ts(t0)},{_ts(t1)},Cap,,0,0,0,,"
                         f"{{\\pos({config.OUT_W // 2},{y}){pop}}}{' '.join(parts)}")
    return head + "\n".join(lines) + "\n"


def write(path: Path, *args, **kwargs) -> None:
    path.write_text(build_ass(*args, **kwargs), encoding="utf-8")
