"""Speech: transcribe candidate moments (for captions) and score how hyped the talking is."""
from __future__ import annotations

import re
import threading
from pathlib import Path

from .. import config, media

_model = None
_broken = ""          # set when the model can't load, so later clips fail fast instead of retrying
_lock = threading.Lock()

HYPE_PHRASES = [
    "let's go", "lets go", "no way", "oh my god", "oh my gosh", "omg", "what the", "are you kidding",
    "holy", "insane", "clutch", "i'm cracked", "cracked", "one hp", "one shot", "he's one", "so lucky",
    "how did", "did you see", "clip that", "clip it", "no shot", "wait what", "bro", "dude", "yo",
    "oh no", "i'm dead", "what was that", "get out", "easy", "ace", "headshot", "wiped", "gg",
    "look at this", "watch this", "nah", "sheesh", "trash", "hacker", "hacking", "cheating", "noooo",
]
_SWEAR = re.compile(r"\b(f+u+c+k\w*|sh+i+t\w*|damn|hell|wtf|bs)\b")


def available() -> bool:
    try:
        import faster_whisper  # noqa: F401
        return True
    except ImportError:
        return False


def _load():
    global _model, _broken
    with _lock:
        if _broken:
            raise RuntimeError(_broken)
        if _model is None:
            from faster_whisper import WhisperModel
            try:
                try:
                    _model = WhisperModel(config.WHISPER_MODEL, device="auto", compute_type="auto")
                except ValueError:      # unsupported compute type on this machine
                    _model = WhisperModel(config.WHISPER_MODEL, device="cpu", compute_type="int8")
            except Exception as e:
                _broken = f"could not load the '{config.WHISPER_MODEL}' speech model: {str(e)[:120]}"
                raise RuntimeError(_broken) from e
        return _model


def transcribe(path: Path, start: float, end: float) -> list[list]:
    """Return [[t0, t1, word], ...] in source-video time."""
    audio = media.read_audio(path, start, end - start)
    if len(audio) < 1600:
        return []
    model = _load()
    with _lock:   # one transcription at a time; the model is not re-entrant on CPU
        segments, _ = model.transcribe(audio, word_timestamps=True, vad_filter=True, beam_size=2)
        words = []
        for seg in segments:
            for w in seg.words or []:
                text = w.word.strip()
                if text:
                    words.append([round(start + w.start, 3), round(start + w.end, 3), text])
    return words


def score(words: list[list], start: float, end: float) -> float:
    """0..1: fast, excited, reaction-heavy speech scores high."""
    inside = [w for w in words if start <= w[0] < end]
    if not inside:
        return 0.0
    text = " ".join(w[2] for w in inside).lower()
    hits = sum(text.count(p) for p in HYPE_PHRASES) + len(_SWEAR.findall(text))
    hits += text.count("!") + sum(1 for w in inside if len(w[2]) > 3 and w[2].isupper())
    rate = len(inside) / max(end - start, 1.0)
    return float(min(1.0, hits * 0.12 + max(0.0, rate - 2.2) * 0.25))


def text_between(words: list[list], start: float, end: float) -> str:
    return " ".join(w[2] for w in words if start <= w[0] < end).strip()
