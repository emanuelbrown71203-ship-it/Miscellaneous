"""Projects and jobs: download, analyse, pick clips, render."""
from __future__ import annotations

import copy
import json
import shutil
import threading
import time
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Optional

import numpy as np

from . import ai, config, highlights, media, render
from .signals import audio, chat, speech, visual

_lock = threading.RLock()
_projects: dict[str, dict] = {}
_analysis = ThreadPoolExecutor(max_workers=1, thread_name_prefix="analyse")
_renders = ThreadPoolExecutor(max_workers=1, thread_name_prefix="render")

SIGNALS = ("audio", "chat", "kills", "motion")


# ---------- storage ----------

def pdir(pid: str) -> Path:
    return config.PROJECTS_DIR / pid


def save(p: dict) -> None:
    with _lock:
        path = pdir(p["id"]) / "project.json"
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(p, indent=1), encoding="utf-8")
        tmp.replace(path)


def load_all() -> None:
    config.ensure_dirs()
    for f in config.PROJECTS_DIR.glob("*/project.json"):
        try:
            p = json.loads(f.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        if p.get("status") in ("queued", "working"):
            p["status"] = "ready" if p.get("clips") else "error"
            p["message"] = "" if p.get("clips") else "Analysis was interrupted. Run it again."
        for c in p.get("clips", []):
            if c.get("render", {}).get("status") in ("queued", "working"):
                c["render"] = {"status": "none", "progress": 0}
        _projects[p["id"]] = p


def get(pid: str) -> dict:
    with _lock:
        if pid not in _projects:
            raise KeyError(pid)
        return _projects[pid]


def snapshot(pid: str) -> dict:
    with _lock:
        return copy.deepcopy(get(pid))


def listing() -> list[dict]:
    with _lock:
        rows = [{k: p.get(k) for k in ("id", "title", "status", "stage", "progress", "message", "created")}
                | {"clips": len(p.get("clips", [])), "duration": (p.get("info") or {}).get("duration")}
                for p in _projects.values()]
    return sorted(rows, key=lambda r: r["created"], reverse=True)


def source_path(p: dict) -> Path:
    return pdir(p["id"]) / p["file"]


def _set(p: dict, persist: bool = False, **fields) -> None:
    with _lock:
        p.update(fields)
        if persist:
            save(p)


def _warn(p: dict, text: str) -> None:
    with _lock:
        if text not in p["warnings"]:
            p["warnings"].append(text)


def new_project(title: str, source: dict, settings: dict) -> dict:
    config.ensure_dirs()
    pid = uuid.uuid4().hex[:10]
    pdir(pid).mkdir(parents=True)
    merged = copy.deepcopy(config.DEFAULT_SETTINGS)
    for k, v in (settings or {}).items():
        if k == "weights" and isinstance(v, dict):
            merged["weights"].update(v)
        elif k in merged:
            merged[k] = v
    p = {
        "id": pid, "title": title, "source": source, "file": None, "meta": {}, "info": None,
        "status": "queued", "stage": "Queued", "progress": 0.0, "message": "", "warnings": [],
        "settings": merged, "style": copy.deepcopy(config.DEFAULT_STYLE), "facecam": None, "markers": [],
        "has": {}, "chat_count": 0, "clips": [], "transcribed": [], "created": time.time(),
    }
    with _lock:
        _projects[pid] = p
        save(p)
    return p


def delete(pid: str) -> None:
    with _lock:
        _projects.pop(pid, None)
    shutil.rmtree(pdir(pid), ignore_errors=True)


# ---------- analysis ----------

def start_analysis(pid: str, full: bool = True) -> None:
    p = get(pid)
    _set(p, persist=True, status="queued", stage="Queued", progress=0.0, message="")
    _analysis.submit(_guard, pid, _analyse if full else _rescore)


def _guard(pid: str, fn) -> None:
    try:
        p = get(pid)
    except KeyError:
        return
    try:
        _set(p, status="working")
        fn(p)
        _set(p, persist=True, status="ready", stage="Ready", progress=1.0)
    except Exception as e:  # surface the failure in the UI instead of dying silently
        traceback.print_exc()
        _set(p, persist=True, status="error", stage="Failed", message=str(e)[:500])


def kill_zone(p: dict) -> Optional[list]:
    s = p["settings"]
    return s.get("kill_zone") or config.GAMES.get(s.get("game"), {}).get("kill_zone")


def _analyse(p: dict) -> None:
    d = pdir(p["id"])
    with _lock:
        p["warnings"] = []
    if not p["file"]:
        _set(p, stage="Downloading", progress=0.0)
        path, meta = media.download(p["source"]["url"], d, lambda f, s: _set(p, progress=f),
                                    section=p["settings"].get("section"))
        _set(p, persist=True, file=path.name, meta=meta, title=meta["title"])
    src = source_path(p)
    info = media.probe(src)
    if info["duration"] < 5:
        raise ValueError("This video is shorter than 5 seconds.")
    _set(p, persist=True, info=info)
    n = int(np.ceil(info["duration"]))

    _set(p, stage="Listening for hype and watching the action", progress=0.0)
    prog = {"a": 0.0, "v": 0.0}

    def tick(key, f):
        prog[key] = f
        _set(p, progress=(prog["a"] + prog["v"]) / 2)

    markers = [dict(m, file=str(d / "markers" / m["file"])) for m in p["markers"]]
    with ThreadPoolExecutor(max_workers=3) as pool:
        fa = pool.submit(audio.analyze, src, info["duration"], lambda f: tick("a", f)) if info["has_audio"] else None
        fv = pool.submit(visual.analyze, src, info, kill_zone(p), markers, lambda f: tick("v", f))
        ff = pool.submit(visual.detect_facecam, src, info) if p["facecam"] is None else None
        a = fa.result() if fa else {"audio": np.zeros(n)}
        v = fv.result()
        if ff:
            try:
                _set(p, facecam=ff.result())
            except Exception as e:
                _warn(p, f"Facecam detection failed: {e}")
    if not info["has_audio"]:
        _warn(p, "This video has no audio track, so loudness and speech are not used.")

    _set(p, stage="Reading chat", progress=0.0)
    messages = _load_chat(p)
    c = chat.score(messages, n, delay=float(p["settings"].get("chat_delay", 6))) if messages else None

    arrays = {"audio": a["audio"], "kills": v["kills"], "motion": v["motion"],
              "chat": c["chat"] if c else np.zeros(n)}
    if c:
        arrays.update({f"mood_{k}": m for k, m in c["moods"].items()})
    np.savez_compressed(d / "signals.npz", **arrays)
    (d / "events.json").write_text(json.dumps(v["events"]), encoding="utf-8")
    _set(p, persist=True, chat_count=len(messages),
         has={k: bool(np.any(arrays[k])) for k in SIGNALS})
    _rescore(p)


def _load_chat(p: dict) -> list:
    d = pdir(p["id"])
    cache = d / "chat.json"
    if cache.exists():
        return [tuple(m) for m in json.loads(cache.read_text(encoding="utf-8"))]
    offset = float((p["settings"].get("section") or [0])[0])
    duration = p["info"]["duration"]
    messages = []
    try:
        extractor = (p.get("meta") or {}).get("extractor", "")
        live = list(d.glob("*.live_chat.json"))
        if extractor.startswith("twitch") and p["meta"].get("video_id"):
            messages = chat.fetch_twitch(p["meta"]["video_id"], offset, offset + duration,
                                         lambda f: _set(p, progress=f))
        elif live:
            messages = chat.parse_youtube_live_chat(live[0].read_text(encoding="utf-8", errors="ignore"))
    except Exception as e:
        _warn(p, f"Could not fetch chat replay ({e}). You can add an exported chat file instead.")
        return []
    messages = [(t - offset, m) for t, m in messages if 0 <= t - offset <= duration]
    if messages:
        cache.write_text(json.dumps(messages), encoding="utf-8")
    return messages


def set_chat(pid: str, data: bytes) -> int:
    p = get(pid)
    messages = chat.parse_file(data)
    if not messages:
        raise ValueError("No chat messages found in that file.")
    (pdir(pid) / "chat.json").write_text(json.dumps(messages), encoding="utf-8")
    return len(messages)


def load_signals(pid: str) -> dict:
    f = pdir(pid) / "signals.npz"
    if not f.exists():
        return {}
    with np.load(f) as z:
        return {k: z[k] for k in z.files}


def load_words(pid: str) -> list:
    f = pdir(pid) / "words.json"
    return json.loads(f.read_text(encoding="utf-8")) if f.exists() else []


def load_events(pid: str) -> list:
    f = pdir(pid) / "events.json"
    return json.loads(f.read_text(encoding="utf-8")) if f.exists() else []


def _mood(arrays: dict, start: float, end: float) -> str:
    totals = {k[5:]: float(v[int(start): int(end) + 1].sum()) for k, v in arrays.items() if k.startswith("mood_")}
    best = max(totals, key=totals.get) if totals else ""
    return best if best and totals[best] >= 3 else ""


def _title(c: dict, index: int) -> str:
    tags = c["tags"]
    multi = next((t for t in tags if t in highlights.MULTI.values()), None)
    if multi:
        return f"{multi} out of nowhere"
    if c.get("mood") == "funny":
        return "Chat lost it at this"
    if c.get("mood") == "fail":
        return "This went so wrong"
    if "Kill" in tags and "Loud reaction" in tags:
        return "The reaction says it all"
    if "Chat spike" in tags:
        return "Chat went wild"
    if "Loud reaction" in tags:
        return "Loudest moment of the stream"
    return f"Highlight {index}"


def _rescore(p: dict) -> None:
    """Cut clips from the cached signals, then transcribe and rank them."""
    pid, s = p["id"], p["settings"]
    arrays = load_signals(pid)
    if not arrays:
        raise ValueError("Nothing analysed yet.")
    events = load_events(pid)
    _set(p, stage="Picking moments", progress=0.0)
    found = highlights.find_clips(
        {k: arrays[k] for k in SIGNALS if k in arrays}, s["weights"], events,
        min_len=float(s["min_len"]), max_len=float(s["max_len"]), max_clips=int(s["max_clips"]),
        pre_roll=float(s["pre_roll"]), post_roll=float(s["post_roll"]))
    for c in found:
        c.update(id=uuid.uuid4().hex[:8], mood=_mood(arrays, c["start"], c["end"]), transcript="",
                 speech=0.0, ai=None, manual=False, style=copy.deepcopy(p["style"]),
                 render={"status": "none", "progress": 0})

    words = load_words(pid)
    if s.get("transcribe") and p["info"]["has_audio"] and found:
        if not speech.available():
            _warn(p, "Speech transcription is off: install faster-whisper to get captions and reaction scoring.")
        else:
            _set(p, stage="Transcribing the best moments", progress=0.0)
            try:
                for i, c in enumerate(found):
                    words = _ensure_words(p, words, c["start"] - 1, c["end"] + 1)
                    _set(p, progress=(i + 1) / len(found))
            except Exception as e:
                _warn(p, f"Speech transcription failed ({str(e)[:160]}). Clips were picked without it.")
    for c in found:
        c["start"], c["end"] = highlights.snap_to_words(c["start"], c["end"], words)
        c["speech"] = speech.score(words, c["start"], c["end"])
        c["transcript"] = speech.text_between(words, c["start"], c["end"])
        if c["speech"] >= 0.5:
            c["tags"].append("Hyped commentary")
        c["score"] = highlights.to_score(c["base"] * (1 + 0.35 * c["speech"]))

    if s.get("use_ai") and found and ai.available():
        _set(p, stage="Ranking and titling with AI", progress=0.5)
        try:
            ranked = ai.rank(found, video_title=p["title"],
                             game=config.GAMES.get(s["game"], {}).get("name", "Unknown"))
            for c in found:
                r = ranked.get(c["id"])
                if r:
                    c["ai"] = {"score": int(r["score"]), "mood": r["mood"], "reason": r["reason"]}
                    c["title"] = r["title"][:80]
                    c["score"] = int(round(0.5 * c["score"] + 0.5 * int(r["score"])))
        except RuntimeError as e:
            _warn(p, str(e))
    found.sort(key=lambda c: c["score"], reverse=True)
    for i, c in enumerate(found, 1):
        c.setdefault("title", _title(c, i))
    with _lock:
        kept = [c for c in p["clips"] if c.get("manual")]
        p["clips"] = found + kept
        save(p)


def _ensure_words(p: dict, words: list, start: float, end: float) -> list:
    """Transcribe [start, end] unless an earlier pass already covered it."""
    start, end = max(0.0, start), min(p["info"]["duration"], end)
    if any(a <= start and end <= b for a, b in p["transcribed"]):
        return words
    new = speech.transcribe(source_path(p), start, end)
    words = sorted([w for w in words if not (start <= w[0] < end)] + new, key=lambda w: w[0])
    with _lock:
        p["transcribed"].append([start, end])
    (pdir(p["id"]) / "words.json").write_text(json.dumps(words), encoding="utf-8")
    return words


# ---------- clips ----------

def find_clip(p: dict, cid: str) -> dict:
    for c in p["clips"]:
        if c["id"] == cid:
            return c
    raise KeyError(cid)


def add_clip(pid: str, start: float, end: float) -> dict:
    p = get(pid)
    c = {"id": uuid.uuid4().hex[:8], "start": round(start, 2), "end": round(end, 2), "peak": int(start),
         "base": 0.0, "score": 0, "kills": 0, "tags": ["Manual"], "contrib": {}, "mood": "", "transcript": "",
         "speech": 0.0, "ai": None, "manual": True, "title": "My clip", "style": copy.deepcopy(p["style"]),
         "render": {"status": "none", "progress": 0}}
    with _lock:
        p["clips"].insert(0, c)
        save(p)
    return c


def update_clip(pid: str, cid: str, fields: dict) -> dict:
    p = get(pid)
    with _lock:
        c = find_clip(p, cid)
        duration = p["info"]["duration"]
        if "start" in fields or "end" in fields:
            start = float(fields.get("start", c["start"]))
            end = float(fields.get("end", c["end"]))
            start = min(max(start, 0.0), duration - 1)
            end = min(max(end, start + 1), duration)
            c["start"], c["end"] = round(start, 2), round(end, 2)
            c["transcript"] = speech.text_between(load_words(pid), c["start"], c["end"])
        if "title" in fields:
            c["title"] = str(fields["title"])[:120]
        if isinstance(fields.get("style"), dict):
            c["style"].update({k: v for k, v in fields["style"].items() if k in config.DEFAULT_STYLE})
        save(p)
        return copy.deepcopy(c)


def remove_clip(pid: str, cid: str) -> None:
    p = get(pid)
    with _lock:
        p["clips"] = [c for c in p["clips"] if c["id"] != cid]
        save(p)
    (pdir(pid) / "clips" / f"{cid}.mp4").unlink(missing_ok=True)


def start_render(pid: str, cid: str) -> None:
    p = get(pid)
    with _lock:
        c = find_clip(p, cid)
        if c["render"]["status"] in ("queued", "working"):
            return
        c["render"] = {"status": "queued", "progress": 0}
    _renders.submit(_render, pid, cid)


def _render(pid: str, cid: str) -> None:
    try:
        p = get(pid)
        with _lock:
            c = find_clip(p, cid)
            c["render"] = {"status": "working", "progress": 0}
            job = copy.deepcopy(c)
            facecam, info = p["facecam"], dict(p["info"])
    except KeyError:
        return

    def set_render(**fields):
        with _lock:
            try:
                find_clip(p, cid)["render"].update(fields)
            except KeyError:
                pass

    try:
        words = load_words(pid)
        if job["style"].get("captions") and p["settings"].get("transcribe") and info["has_audio"] and speech.available():
            try:
                words = _ensure_words(p, words, job["start"], job["end"])
            except Exception as e:
                _warn(p, f"Captions skipped for one clip: transcription failed ({str(e)[:120]}).")
        out = pdir(pid) / "clips" / f"{cid}.mp4"
        render.render(source_path(p), out, start=job["start"], end=job["end"], style=job["style"],
                      facecam=facecam, words=words, title=job["title"], info=info,
                      progress=lambda f: set_render(progress=f))
        set_render(status="done", progress=1.0, file=f"{cid}.mp4", at=time.time(),
                   layout=render.resolve_layout(job["style"], facecam))
    except Exception as e:
        traceback.print_exc()
        set_render(status="error", message=str(e)[:300])
    with _lock:
        if pid in _projects:
            save(p)


# ---------- markers ----------

def add_marker(pid: str, name: str, t: float, box: list) -> dict:
    """Save a crop of the frame at time t as an event template (a kill banner, a victory screen...)."""
    import cv2
    p = get(pid)
    jpg = media.grab_frame(source_path(p), t)
    img = cv2.imdecode(np.frombuffer(jpg, np.uint8), cv2.IMREAD_COLOR)
    h, w = img.shape[:2]
    x0, y0, x1, y1 = visual._px(box, w, h)
    if x1 - x0 < 8 or y1 - y0 < 8:
        raise ValueError("That marker box is too small.")
    mdir = pdir(pid) / "markers"
    mdir.mkdir(exist_ok=True)
    mid = uuid.uuid4().hex[:6]
    cv2.imwrite(str(mdir / f"{mid}.png"), img[y0:y1, x0:x1])
    m = {"id": mid, "name": (name or "Event").strip()[:30], "file": f"{mid}.png", "box": box, "src_w": w, "t": t}
    with _lock:
        p["markers"].append(m)
        save(p)
    return m


def remove_marker(pid: str, mid: str) -> None:
    p = get(pid)
    with _lock:
        p["markers"] = [m for m in p["markers"] if m["id"] != mid]
        save(p)
    (pdir(pid) / "markers" / f"{mid}.png").unlink(missing_ok=True)
