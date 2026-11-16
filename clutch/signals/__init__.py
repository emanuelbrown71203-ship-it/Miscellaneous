"""Highlight signals. Each detector returns a 1 Hz numpy array of hype scores (robust z-scores, >= 0)."""
from __future__ import annotations

import numpy as np


def rolling_median(x: np.ndarray, window: int) -> np.ndarray:
    if len(x) == 0:
        return x
    window = max(3, min(window, len(x) * 2 - 1) | 1)
    pad = window // 2
    padded = np.pad(x, pad, mode="reflect") if len(x) > pad else np.pad(x, pad, mode="edge")
    view = np.lib.stride_tricks.sliding_window_view(padded, window)
    return np.median(view, axis=1)


def robust_z(x: np.ndarray, window: int = 121) -> np.ndarray:
    """How far each second sits above the local baseline, in robust standard deviations."""
    x = np.asarray(x, dtype=np.float64)
    if len(x) == 0:
        return x
    resid = x - rolling_median(x, window)
    mad = np.median(np.abs(resid - np.median(resid)))
    scale = 1.4826 * mad
    if scale < 1e-9:
        scale = resid.std() or 1.0
    return np.clip(resid / scale, 0, 8)


def fit(x: np.ndarray, n: int) -> np.ndarray:
    """Pad or trim to exactly n seconds."""
    x = np.asarray(x, dtype=np.float64)
    if len(x) >= n:
        return x[:n]
    return np.pad(x, (0, n - len(x)))
