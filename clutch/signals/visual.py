"""Visual signals: kill-feed activity, user-marked event templates, action intensity and facecam location."""
from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Callable, Optional

import cv2
import numpy as np

from .. import media
from . import fit, robust_z

FPS = 2  # analysis frames per second


def _px(box, w, h):
    x, y, bw, bh = box
    x0, y0 = int(np.clip(x, 0, 1) * w), int(np.clip(y, 0, 1) * h)
    x1, y1 = int(np.clip(x + bw, 0, 1) * w), int(np.clip(y + bh, 0, 1) * h)
    return x0, y0, max(x1, x0 + 2), max(y1, y0 + 2)


def hud_density(gray_roi: np.ndarray) -> float:
    """Share of pixels that look like HUD text: bright and sharply edged.

    Kill-feed rows are crisp light text and icons, so each new row adds a
    step of such pixels. Sky, smoke and explosions are bright but soft.
    """
    lap = np.abs(cv2.Laplacian(gray_roi, cv2.CV_16S, ksize=3))
    return float(np.mean((gray_roi > 165) & (lap > 60)))


def find_steps(density: np.ndarray, fps: int = FPS) -> list[tuple[float, float]]:
    """Find moments where HUD density steps up and stays up (a new kill-feed row)."""
    d = np.asarray(density, dtype=np.float64)
    if len(d) < fps * 4:
        return []
    # Compare the lowest value just after with the highest just before: a real row
    # clears that bar once, when it appears, so rows a second apart count separately.
    back, ahead = fps, fps
    steps = np.zeros(len(d))
    for i in range(back, len(d) - ahead + 1):
        steps[i] = d[i: i + ahead].min() - d[i - back: i].max()
    noise = 1.4826 * np.median(np.abs(np.diff(d) - np.median(np.diff(d))))
    thresh = max(0.004, 5 * noise)
    events, i = [], 0
    while i < len(steps):
        if steps[i] > thresh:
            j = i
            while j + 1 < len(steps) and steps[j + 1] > thresh:
                j += 1
            k = i + int(np.argmax(steps[i: j + 1]))
            events.append((i / fps, float(steps[k] / thresh)))   # time of first appearance
            i = j + 1
        else:
            i += 1
    return events


def analyze(path: Path, info: dict, kill_zone: Optional[list], markers: list[dict],
            progress: Callable[[float], None] = lambda f: None) -> dict:
    n = max(1, int(np.ceil(info["duration"])))
    w = 960 if markers else 640
    h = int(round(w * info["height"] / info["width"] / 2)) * 2
    proc = subprocess.Popen(
        ["ffmpeg", "-v", "error", "-i", str(path), "-an", "-vf", f"fps={FPS},scale={w}:{h}",
         "-f", "rawvideo", "-pix_fmt", "gray", "-"],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
    )
    zone = _px(kill_zone, w, h) if kill_zone else None
    tmpls = []
    for m in markers:
        img = cv2.imread(str(m["file"]), cv2.IMREAD_GRAYSCALE)
        if img is None:
            continue
        scale = w / m["src_w"]
        img = cv2.resize(img, (max(8, int(img.shape[1] * scale)), max(8, int(img.shape[0] * scale))),
                         interpolation=cv2.INTER_AREA)
        bx, by, bw, bh = m["box"]
        region = _px([bx - bw * 0.3, by - bh * 0.3, bw * 1.6, bh * 1.6], w, h)
        tmpls.append({"name": m["name"], "img": img, "region": region, "hits": [], "last": -99.0})

    density, motion, prev = [], [], None
    total = n * FPS
    try:
        while True:
            buf = proc.stdout.read(w * h)
            if len(buf) < w * h:
                break
            frame = np.frombuffer(buf, dtype=np.uint8).reshape(h, w)
            t = len(motion) / FPS
            small = cv2.resize(frame, (160, 90), interpolation=cv2.INTER_AREA).astype(np.int16)
            motion.append(float(np.mean(np.abs(small - prev))) if prev is not None else 0.0)
            prev = small
            if zone:
                x0, y0, x1, y1 = zone
                density.append(hud_density(frame[y0:y1, x0:x1]))
            for tm in tmpls:
                x0, y0, x1, y1 = tm["region"]
                roi = frame[y0:y1, x0:x1]
                if roi.shape[0] < tm["img"].shape[0] or roi.shape[1] < tm["img"].shape[1]:
                    continue
                score = float(cv2.matchTemplate(roi, tm["img"], cv2.TM_CCOEFF_NORMED).max())
                if score >= 0.8:
                    if t - tm["last"] > 2.0:
                        tm["hits"].append(t)
                    tm["last"] = t
            if len(motion) % 40 == 0:
                progress(min(len(motion) / total, 1.0))
    finally:
        proc.stdout.close()
        proc.wait()

    events = [{"t": t, "kind": "kill", "strength": s} for t, s in find_steps(np.array(density))] if zone else []
    for tm in tmpls:
        events += [{"t": t, "kind": tm["name"], "strength": 2.0} for t in tm["hits"]]
    events.sort(key=lambda e: e["t"])

    kills = np.zeros(n)
    for e in events:
        kills[min(int(e["t"]), n - 1)] += 4.0
    m = np.array(motion)
    per_sec = m[: len(m) // FPS * FPS].reshape(-1, FPS).max(axis=1) if len(m) >= FPS else np.zeros(0)
    return {"kills": np.clip(kills, 0, 8), "motion": robust_z(fit(per_sec, n)), "events": events}


def detect_facecam(path: Path, info: dict, samples: int = 24) -> Optional[list]:
    """Locate a webcam overlay: a face that stays in the same place across the video."""
    cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
    if cascade.empty():
        return None
    faces = []
    for i in range(samples):
        t = info["duration"] * (i + 0.5) / samples
        try:
            jpg = media.grab_frame(path, t, width=1280)
        except subprocess.CalledProcessError:
            continue
        img = cv2.imdecode(np.frombuffer(jpg, np.uint8), cv2.IMREAD_GRAYSCALE)
        if img is None:
            continue
        H, W = img.shape
        for (x, y, fw, fh) in cascade.detectMultiScale(img, scaleFactor=1.1, minNeighbors=6, minSize=(40, 40)):
            faces.append((x / W, y / H, fw / W, fh / H))
    if not faces:
        return None
    arr = np.array(faces)
    centers = arr[:, :2] + arr[:, 2:] / 2
    best, best_members = 0, None
    for c in centers:
        members = np.linalg.norm(centers - c, axis=1) < 0.06
        if members.sum() > best:
            best, best_members = int(members.sum()), members
    if best < max(4, samples * 0.3):
        return None
    x, y, fw, fh = np.median(arr[best_members], axis=0)
    cx, cy = x + fw / 2, y + fh / 2 + fh * 0.25      # include shoulders
    bw, bh = min(fw * 3.2, 1.0), min(fh * 2.6, 1.0)
    bx, by = float(np.clip(cx - bw / 2, 0, 1 - bw)), float(np.clip(cy - bh / 2, 0, 1 - bh))
    return [round(bx, 4), round(by, 4), round(float(bw), 4), round(float(bh), 4)]
