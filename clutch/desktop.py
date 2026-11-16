"""Open Clutch in its own desktop window instead of a browser tab."""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import webbrowser
from pathlib import Path

CHROMIUM_NAMES = ["msedge", "microsoft-edge", "google-chrome", "google-chrome-stable", "chrome", "chromium",
                  "chromium-browser", "brave-browser"]
CHROMIUM_PATHS = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
]


def find_chromium() -> str | None:
    for name in CHROMIUM_NAMES:
        found = shutil.which(name)
        if found:
            return found
    return next((p for p in CHROMIUM_PATHS if Path(p).exists()), None)


def app_window_command(url: str, browser: str, profile: str) -> list[str]:
    cmd = [browser, f"--app={url}", f"--user-data-dir={profile}", "--window-size=1440,960",
           "--no-first-run", "--no-default-browser-check"]
    if hasattr(os, "geteuid") and os.geteuid() == 0:
        cmd.append("--no-sandbox")     # Chromium refuses to start as root otherwise
    return cmd


def open_window(url: str, data_dir: Path) -> str:
    """Show the app and block until the window closes. Returns which kind of window was used.

    Tries a native window (pywebview), then a chromeless Edge/Chrome app window,
    then falls back to a normal browser tab (which returns immediately).
    """
    try:
        import logging
        logging.getLogger("pywebview").setLevel(logging.CRITICAL)   # its toolkit probing is noisy
        import webview
        webview.settings["ALLOW_DOWNLOADS"] = True
        webview.create_window("Clutch", url, width=1440, height=960, min_size=(900, 600),
                              background_color="#12142a")
        webview.start()
        return "native"
    except Exception as e:   # no GUI toolkit, no display, or pywebview not installed
        print(f"Native window unavailable ({str(e)[:100] or type(e).__name__}); trying a browser app window.",
              file=sys.stderr)
    browser = find_chromium()
    if browser:
        profile = data_dir / "window-profile"
        profile.mkdir(parents=True, exist_ok=True)
        try:
            subprocess.run(app_window_command(url, browser, str(profile)),
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return "app"
        except OSError:
            pass
    webbrowser.open(url)
    return "browser"


if __name__ == "__main__":   # manual check: python -m clutch.desktop http://127.0.0.1:8765
    print(open_window(sys.argv[1], Path(tempfile.mkdtemp())))
