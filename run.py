"""Start Clutch: python run.py  (then open http://127.0.0.1:8765)"""
import argparse
import shutil
import sys
import threading
import webbrowser

import uvicorn


def main() -> None:
    ap = argparse.ArgumentParser(description="Clutch: automatic gaming clipper")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()
    for tool in ("ffmpeg", "ffprobe"):
        if not shutil.which(tool):
            sys.exit(f"{tool} was not found. Install ffmpeg (https://ffmpeg.org/download.html) and try again.")
    if not args.no_browser:
        threading.Timer(1.2, lambda: webbrowser.open(f"http://{args.host}:{args.port}")).start()
    uvicorn.run("clutch.server:app", host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
