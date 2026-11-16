"""Audio hype: loudness bursts and energy in the band where shouting and laughing live."""
from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Callable

import numpy as np

from . import fit, robust_z

SR = 16000


def analyze(path: Path, duration: float, progress: Callable[[float], None] = lambda f: None) -> dict:
    n = max(1, int(np.ceil(duration)))
    proc = subprocess.Popen(
        ["ffmpeg", "-v", "error", "-i", str(path), "-vn", "-ac", "1", "-ar", str(SR), "-f", "s16le", "-"],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
    )
    freqs = np.fft.rfftfreq(SR, 1 / SR)
    voice = (freqs >= 1000) & (freqs <= 4000)
    window = np.hanning(SR)
    loud, shout = [], []
    try:
        while True:
            buf = proc.stdout.read(SR * 2)
            if len(buf) < SR:        # less than half a second left
                break
            x = np.frombuffer(buf[: len(buf) // 2 * 2], dtype=np.int16).astype(np.float32) / 32768.0
            if len(x) < SR:
                x = np.pad(x, (0, SR - len(x)))
            rms = float(np.sqrt(np.mean(x * x)) + 1e-9)
            spec = np.abs(np.fft.rfft(x * window)) ** 2
            loud.append(20 * np.log10(rms))
            shout.append(10 * np.log10(spec[voice].sum() + 1e-9))
            if len(loud) % 30 == 0:
                progress(min(len(loud) / n, 1.0))
    finally:
        proc.stdout.close()
        proc.wait()
    loud_a, shout_a = fit(np.array(loud), n), fit(np.array(shout), n)
    if len(loud) == 0:
        return {"audio": np.zeros(n), "loudness": np.zeros(n)}
    # Floor silence so dead air doesn't make ordinary speech look like a spike.
    loud_a = np.maximum(loud_a, np.percentile(loud_a[: len(loud)], 10))
    shout_a = np.maximum(shout_a, np.percentile(shout_a[: len(loud)], 10))
    score = 0.6 * robust_z(loud_a) + 0.4 * robust_z(shout_a)
    return {"audio": score, "loudness": loud_a}
