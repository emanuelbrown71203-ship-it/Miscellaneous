"""Build a synthetic 'stream' with known highlights, for testing the pipeline without real footage.

    python tests/make_fixture.py out_dir [--face face.png]

Writes fixture.mp4 and fixture_chat.txt. Planted moments:
  40s  triple kill (three kill-feed rows) + loud burst, chat spike a few seconds later
  95s  single kill + loud burst + chat spike
  130s loud burst only
"""
import argparse
import subprocess
import sys
import wave
from pathlib import Path

import cv2
import numpy as np

W, H, FPS, DUR, SR = 1280, 720, 30, 150, 16000
KILLS = [40.0, 41.5, 43.0, 95.0]
BURSTS = [(40.0, 5.0), (95.0, 4.0), (130.0, 3.0)]
CHAT_SPIKES = [(46, 8, "KEKW"), (100, 6, "POG")]
CAM = (40, 470, 300, 210)  # x, y, w, h of the facecam overlay


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--face", help="image of a face to use as the facecam overlay")
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(7)

    # audio: quiet noise bed with loud bursts
    t = np.arange(DUR * SR) / SR
    audio = rng.normal(0, 0.01, len(t))
    for start, length in BURSTS:
        m = (t >= start) & (t < start + length)
        audio[m] += 0.5 * np.sin(2 * np.pi * 1800 * t[m]) * rng.uniform(0.5, 1, m.sum())
    with wave.open(str(out / "fixture.wav"), "wb") as wf:
        wf.setnchannels(1), wf.setsampwidth(2), wf.setframerate(SR)
        wf.writeframes((np.clip(audio, -1, 1) * 32767).astype(np.int16).tobytes())

    face = None
    if args.face:
        face = cv2.imread(args.face)
        if face is None:
            sys.exit(f"could not read {args.face}")
        face = cv2.resize(face, (CAM[2], CAM[3]))

    ff = subprocess.Popen(
        ["ffmpeg", "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{W}x{H}", "-r", str(FPS),
         "-i", "-", "-i", str(out / "fixture.wav"), "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
         "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(out / "fixture.mp4")],
        stdin=subprocess.PIPE)
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    for i in range(DUR * FPS):
        ts = i / FPS
        busy = any(s <= ts < s + l for s, l in BURSTS)
        speed = 9.0 if busy else 1.2
        base = 70 + 40 * np.sin(xx / 90 + ts * speed) + 30 * np.cos(yy / 70 - ts * speed * 0.7)
        frame = np.stack([base * 0.9, base, base * 0.7], axis=-1).clip(0, 255).astype(np.uint8)
        cv2.circle(frame, (int(W / 2 + 300 * np.sin(ts * speed / 3)), int(H / 2 + 150 * np.cos(ts * speed / 4))),
                   60, (40, 60, 200), -1)
        row = 0
        for k in KILLS:                      # each kill-feed row stays up for 6 seconds
            if k <= ts < k + 6:
                cv2.putText(frame, "Player1  [AR]  Enemy%d" % (KILLS.index(k) + 1), (930, 60 + row * 34),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2, cv2.LINE_AA)
                row += 1
        if face is not None:
            x, y, w, h = CAM
            frame[y:y + h, x:x + w] = face
            cv2.rectangle(frame, (x, y), (x + w, y + h), (255, 255, 255), 3)
        ff.stdin.write(frame.tobytes())
    ff.stdin.close()
    ff.wait()

    lines = []
    for s in range(DUR):
        if s % 3 == 0:
            lines.append(f"[{s // 60}:{s % 60:02d}] viewer{s % 7}: just chatting about the game")
        for start, length, emote in CHAT_SPIKES:
            if start <= s < start + length:
                lines += [f"[{s // 60}:{s % 60:02d}] fan{j}: {emote} {emote}" for j in range(6)]
    (out / "fixture_chat.txt").write_text("\n".join(lines) + "\n")
    print(out / "fixture.mp4")


if __name__ == "__main__":
    main()
