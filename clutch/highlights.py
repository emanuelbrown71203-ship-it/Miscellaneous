"""Fuse the signals into one hype curve and cut it into clip candidates."""
from __future__ import annotations

import numpy as np

MULTI = {2: "Double kill", 3: "Triple kill", 4: "Quad kill", 5: "Ace"}
TAGS = {"audio": "Loud reaction", "chat": "Chat spike", "kills": "Kill", "motion": "Fast action"}


def combine(signals: dict[str, np.ndarray], weights: dict[str, float]) -> np.ndarray:
    """Weighted mean of the available signals, lightly smoothed so a moment reads as one bump."""
    n = len(next(iter(signals.values())))
    total, wsum = np.zeros(n), 0.0
    for name, sig in signals.items():
        w = float(weights.get(name, 0))
        if w <= 0 or not np.any(sig):
            continue
        total += w * np.clip(sig, 0, 6)
        wsum += w
    if wsum == 0:
        return total
    kernel = np.array([1, 2, 3, 4, 3, 2, 1], dtype=float)
    return np.convolve(total / wsum, kernel / kernel.sum(), mode="same")


def find_clips(signals: dict[str, np.ndarray], weights: dict, events: list[dict], *, min_len: float,
               max_len: float, max_clips: int, pre_roll: float, post_roll: float) -> list[dict]:
    curve = combine(signals, weights)
    n = len(curve)
    if n == 0 or curve.max() <= 0:
        return []
    floor = max(float(curve.mean() + curve.std()), 0.25)
    taken = np.zeros(n, dtype=bool)
    clips = []
    for peak in np.argsort(curve)[::-1]:
        if len(clips) >= max_clips or curve[peak] < floor:
            break
        if taken[peak]:
            continue
        # Grow outward while the curve stays hot, so the clip covers the whole moment.
        cut = curve[peak] * 0.35
        lo = hi = int(peak)
        while lo > 0 and curve[lo - 1] > cut and peak - lo < max_len:
            lo -= 1
        while hi < n - 1 and curve[hi + 1] > cut and hi - peak < max_len:
            hi += 1
        start, end = lo - pre_roll, hi + 1 + post_roll
        if end - start < min_len:           # pad short moments, favouring the build-up
            short = min_len - (end - start)
            start, end = start - short * 0.65, end + short * 0.35
        if end - start > max_len:           # trim long ones around the peak
            start = max(start, peak - max_len * 0.65)
            end = start + max_len
        if start < 0:
            start, end = 0.0, min(float(n), end - start)
        if end > n:
            start, end = max(0.0, start - (end - n)), float(n)
        a, b = int(start), int(np.ceil(end))
        if taken[a:b].mean() > 0.3:
            continue
        taken[max(0, a - 2): b + 2] = True

        contrib = {k: float(np.clip(v[lo: hi + 1], 0, 6).max()) for k, v in signals.items() if np.any(v)}
        kill_events = [e for e in events if start <= e["t"] <= end]
        kills = sum(1 for e in kill_events if e["kind"] == "kill")
        tags = []
        if kills >= 2:
            tags.append(MULTI.get(min(kills, 5), "Kill streak"))
        elif kills == 1:
            tags.append("Kill")
        tags += sorted({e["kind"].title() for e in kill_events if e["kind"] != "kill"})
        for name in ("chat", "audio", "motion"):
            if contrib.get(name, 0) >= 2.0:
                tags.append(TAGS[name])
        value = float(curve[peak]) * (1 + 0.15 * max(0, kills - 1))
        clips.append({
            "start": round(float(start), 2), "end": round(float(end), 2), "peak": int(peak),
            "base": value, "kills": kills, "tags": tags, "contrib": contrib,
        })
    return clips


def to_score(value: float) -> int:
    """Map an open-ended hype value onto 0..100."""
    return int(round(100 * (1 - np.exp(-value / 2.2))))


def snap_to_words(start: float, end: float, words: list[list]) -> tuple[float, float]:
    """Nudge the cut points so they don't land in the middle of a word."""
    for t0, t1, _ in words:
        if t0 < start < t1:
            start = max(0.0, t0 - 0.15)
        if t0 < end < t1:
            end = t1 + 0.2
    return round(start, 2), round(end, 2)


def downsample(x: np.ndarray, points: int = 1500) -> list[float]:
    """Max-pool to at most `points` values for drawing."""
    x = np.asarray(x, dtype=float)
    if len(x) <= points:
        return [round(float(v), 3) for v in x]
    step = int(np.ceil(len(x) / points))
    pad = (-len(x)) % step
    return [round(float(v), 3) for v in np.pad(x, (0, pad)).reshape(-1, step).max(axis=1)]
