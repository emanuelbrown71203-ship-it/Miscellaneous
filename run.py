"""Start Clutch.

    python run.py              desktop app window
    python run.py --phone      also let phones on your Wi-Fi use it (scan the QR code shown)
    python run.py --browser    open in your normal browser instead of an app window
"""
import argparse
import os
import shutil
import sys
import threading
import time
import urllib.request

import uvicorn


def main() -> None:
    ap = argparse.ArgumentParser(description="Clutch: automatic gaming clipper")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--phone", action="store_true", help="allow paired phones on your local network")
    ap.add_argument("--browser", action="store_true", help="use a browser tab instead of an app window")
    ap.add_argument("--no-window", "--no-browser", dest="no_window", action="store_true",
                    help="only run the server")
    args = ap.parse_args()
    for tool in ("ffmpeg", "ffprobe"):
        if not shutil.which(tool):
            sys.exit(f"{tool} was not found. Install ffmpeg (https://ffmpeg.org/download.html) and try again.")

    os.environ["CLUTCH_PORT"] = str(args.port)
    os.environ["CLUTCH_PHONE"] = "1" if args.phone else "0"
    from clutch import config, desktop, phone

    host = "0.0.0.0" if args.phone else "127.0.0.1"
    local = f"http://127.0.0.1:{args.port}"
    server = uvicorn.Server(uvicorn.Config("clutch.server:app", host=host, port=args.port, log_level="warning"))
    print(f"Clutch is running at {local}")
    if args.phone:
        print(f"On your phone (same Wi-Fi), open: {phone.url()}\nor scan the QR code under 'Use on phone' in the app.")
    if args.no_window:
        server.run()
        return

    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    for _ in range(100):                     # wait for the server before opening the window
        try:
            urllib.request.urlopen(f"{local}/api/config", timeout=1)
            break
        except OSError:
            time.sleep(0.1)
    if args.browser:
        import webbrowser
        webbrowser.open(local)
        kind = "browser"
    else:
        kind = desktop.open_window(local, config.DATA_DIR)
    if kind == "browser":                    # a tab doesn't block, so keep serving until Ctrl+C
        print("Press Ctrl+C to stop.")
        try:
            while thread.is_alive():
                time.sleep(0.5)
        except KeyboardInterrupt:
            pass
    server.should_exit = True
    thread.join(timeout=5)


if __name__ == "__main__":
    main()
