"""Local web server for Clutch."""
from __future__ import annotations

import json
import re
import shutil
from pathlib import Path

from fastapi import Body, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

from . import __version__, ai, config, highlights, media, pipeline
from .signals import speech

app = FastAPI(title="Clutch", version=__version__)
pipeline.load_all()

VIDEO_EXT = {".mp4", ".mkv", ".mov", ".webm", ".flv", ".ts", ".avi", ".m4v"}


def _project(pid: str) -> dict:
    try:
        return pipeline.get(pid)
    except KeyError:
        raise HTTPException(404, "Project not found.")


def _need_source(p: dict) -> Path:
    if not p.get("file") or not p.get("info"):
        raise HTTPException(409, "The video is not ready yet.")
    return pipeline.source_path(p)


@app.get("/api/config")
def get_config():
    return {
        "version": __version__,
        "games": config.GAMES,
        "defaults": config.DEFAULT_SETTINGS,
        "style": config.DEFAULT_STYLE,
        "speech": speech.available(),
        "ai": ai.available(),
    }


@app.get("/api/projects")
def list_projects():
    return pipeline.listing()


@app.post("/api/projects")
def create_project(body: dict = Body(...)):
    url = str(body.get("url") or "").strip()
    if not re.match(r"^https?://", url):
        raise HTTPException(400, "Paste a full link starting with http:// or https://")
    p = pipeline.new_project(url, {"kind": "url", "url": url}, body.get("settings") or {})
    pipeline.start_analysis(p["id"])
    return pipeline.snapshot(p["id"])


@app.post("/api/projects/upload")
def upload_project(file: UploadFile = File(...), settings: str = Form("{}"), chat: UploadFile | None = File(None)):
    ext = Path(file.filename or "").suffix.lower()
    if ext not in VIDEO_EXT:
        raise HTTPException(400, f"Unsupported file type {ext or '(none)'}. Use one of: {', '.join(sorted(VIDEO_EXT))}")
    try:
        opts = json.loads(settings)
    except json.JSONDecodeError:
        opts = {}
    opts.pop("section", None)
    p = pipeline.new_project(Path(file.filename).stem, {"kind": "file", "name": file.filename}, opts)
    dest = pipeline.pdir(p["id"]) / f"source{ext}"
    with dest.open("wb") as out:
        shutil.copyfileobj(file.file, out, length=1024 * 1024)
    p["file"] = dest.name
    if chat is not None and chat.filename:
        try:
            pipeline.set_chat(p["id"], chat.file.read())
        except ValueError as e:
            p["message"] = str(e)
    pipeline.start_analysis(p["id"])
    return pipeline.snapshot(p["id"])


@app.get("/api/projects/{pid}")
def get_project(pid: str):
    _project(pid)
    return pipeline.snapshot(pid)


@app.delete("/api/projects/{pid}")
def delete_project(pid: str):
    p = _project(pid)
    if p["status"] in ("queued", "working"):
        raise HTTPException(409, "Wait for the analysis to finish before deleting this project.")
    pipeline.delete(pid)
    return {"ok": True}


@app.patch("/api/projects/{pid}")
def patch_project(pid: str, body: dict = Body(...)):
    p = _project(pid)
    with pipeline._lock:
        if "facecam" in body:
            box = body["facecam"]
            p["facecam"] = [round(float(v), 4) for v in box] if box else None
        if isinstance(body.get("settings"), dict):
            for k, v in body["settings"].items():
                if k == "weights" and isinstance(v, dict):
                    p["settings"]["weights"].update({n: float(x) for n, x in v.items()})
                elif k in config.DEFAULT_SETTINGS and k != "section":
                    p["settings"][k] = v
        if isinstance(body.get("style"), dict):
            p["style"].update({k: v for k, v in body["style"].items() if k in config.DEFAULT_STYLE})
        pipeline.save(p)
    return pipeline.snapshot(pid)


@app.post("/api/projects/{pid}/analyze")
def analyze(pid: str, body: dict = Body(default={})):
    p = _project(pid)
    if p["status"] in ("queued", "working"):
        raise HTTPException(409, "This project is already being analysed.")
    full = bool(body.get("full", True)) or not (pipeline.pdir(pid) / "signals.npz").exists()
    pipeline.start_analysis(pid, full=full)
    return pipeline.snapshot(pid)


@app.post("/api/projects/{pid}/chat")
def upload_chat(pid: str, file: UploadFile = File(...)):
    _project(pid)
    try:
        count = pipeline.set_chat(pid, file.file.read())
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"messages": count}


@app.get("/api/projects/{pid}/signals")
def signals(pid: str):
    p = _project(pid)
    arrays = pipeline.load_signals(pid)
    core = {k: arrays[k] for k in pipeline.SIGNALS if k in arrays}
    if not core:
        return {"duration": 0, "signals": {}, "combined": [], "events": []}
    return {
        "duration": p["info"]["duration"],
        "signals": {k: highlights.downsample(v) for k, v in core.items()},
        "combined": highlights.downsample(highlights.combine(core, p["settings"]["weights"])),
        "events": pipeline.load_events(pid),
    }


@app.get("/api/projects/{pid}/video")
def video(pid: str):
    p = _project(pid)
    return FileResponse(_need_source(p))


@app.get("/api/projects/{pid}/frame")
def frame(pid: str, t: float = 0.0, w: int = 960):
    p = _project(pid)
    src = _need_source(p)
    try:
        jpg = media.grab_frame(src, min(max(t, 0.0), max(p["info"]["duration"] - 0.2, 0)), width=min(max(w, 160), 1920))
    except Exception:
        raise HTTPException(500, "Could not read a frame at that time.")
    return Response(jpg, media_type="image/jpeg", headers={"Cache-Control": "max-age=3600"})


@app.get("/api/projects/{pid}/words")
def words(pid: str, start: float = 0.0, end: float = 1e9):
    _project(pid)
    return [w for w in pipeline.load_words(pid) if w[1] > start and w[0] < end]


@app.post("/api/projects/{pid}/markers")
def add_marker(pid: str, body: dict = Body(...)):
    p = _project(pid)
    _need_source(p)
    try:
        return pipeline.add_marker(pid, str(body.get("name") or "Event"), float(body["t"]), [float(v) for v in body["box"]])
    except (KeyError, TypeError, ValueError) as e:
        raise HTTPException(400, str(e) or "A marker needs a time and a box.")


@app.delete("/api/projects/{pid}/markers/{mid}")
def delete_marker(pid: str, mid: str):
    _project(pid)
    pipeline.remove_marker(pid, mid)
    return {"ok": True}


@app.post("/api/projects/{pid}/clips")
def add_clip(pid: str, body: dict = Body(...)):
    p = _project(pid)
    _need_source(p)
    start = float(body.get("start", 0))
    end = float(body.get("end", start + 20))
    duration = p["info"]["duration"]
    start = min(max(start, 0), max(duration - 1, 0))
    return pipeline.add_clip(pid, start, min(max(end, start + 1), duration))


@app.patch("/api/projects/{pid}/clips/{cid}")
def patch_clip(pid: str, cid: str, body: dict = Body(...)):
    _project(pid)
    try:
        return pipeline.update_clip(pid, cid, body)
    except KeyError:
        raise HTTPException(404, "Clip not found.")


@app.delete("/api/projects/{pid}/clips/{cid}")
def delete_clip(pid: str, cid: str):
    _project(pid)
    pipeline.remove_clip(pid, cid)
    return {"ok": True}


@app.post("/api/projects/{pid}/clips/{cid}/render")
def render_clip(pid: str, cid: str):
    p = _project(pid)
    _need_source(p)
    try:
        pipeline.start_render(pid, cid)
    except KeyError:
        raise HTTPException(404, "Clip not found.")
    return {"ok": True}


@app.post("/api/projects/{pid}/render-all")
def render_all(pid: str):
    p = _project(pid)
    _need_source(p)
    ids = [c["id"] for c in p["clips"] if c["render"]["status"] != "done"]
    for cid in ids:
        pipeline.start_render(pid, cid)
    return {"queued": len(ids)}


@app.get("/api/projects/{pid}/clips/{cid}/file")
def clip_file(pid: str, cid: str, download: int = 0):
    p = _project(pid)
    try:
        c = pipeline.find_clip(p, cid)
    except KeyError:
        raise HTTPException(404, "Clip not found.")
    f = pipeline.pdir(pid) / "clips" / f"{cid}.mp4"
    if not f.exists():
        raise HTTPException(404, "This clip has not been rendered yet.")
    name = re.sub(r"[^\w\- ]+", "", c["title"]).strip().replace(" ", "_") or cid
    return FileResponse(f, media_type="video/mp4", filename=f"{name}.mp4" if download else None)


app.mount("/fonts", StaticFiles(directory=config.FONTS_DIR), name="fonts")
app.mount("/", StaticFiles(directory=config.STATIC_DIR, html=True), name="static")
