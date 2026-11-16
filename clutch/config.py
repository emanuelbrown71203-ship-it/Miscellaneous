"""Paths, defaults and game presets."""
from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("CLUTCH_DATA", ROOT.parent / "data")).resolve()
PROJECTS_DIR = DATA_DIR / "projects"
FONTS_DIR = ROOT / "fonts"
STATIC_DIR = ROOT / "static"

WHISPER_MODEL = os.environ.get("CLUTCH_WHISPER_MODEL", "base")
AI_MODEL = os.environ.get("CLUTCH_AI_MODEL", "claude-opus-5-5")

OUT_W, OUT_H = 1080, 1920

# Boxes are [x, y, w, h] as fractions of the source frame.
# Kill-feed zones are starting points: HUD positions shift with game patches
# and HUD scale settings, so the UI lets you drag the zone onto the real feed.
GAMES = {
    "generic": {"name": "Any game", "kill_zone": None,
                "note": "Audio, chat and motion only. Draw a kill-feed zone to add kill detection."},
    "valorant": {"name": "Valorant", "kill_zone": [0.70, 0.08, 0.29, 0.22]},
    "cs2": {"name": "Counter-Strike 2", "kill_zone": [0.70, 0.05, 0.29, 0.20]},
    "apex": {"name": "Apex Legends", "kill_zone": [0.68, 0.10, 0.31, 0.22]},
    "fortnite": {"name": "Fortnite", "kill_zone": [0.01, 0.55, 0.30, 0.20]},
    "warzone": {"name": "Call of Duty / Warzone", "kill_zone": [0.01, 0.42, 0.28, 0.22]},
    "overwatch": {"name": "Overwatch 2", "kill_zone": [0.72, 0.05, 0.27, 0.22]},
    "r6": {"name": "Rainbow Six Siege", "kill_zone": [0.72, 0.10, 0.27, 0.20]},
    "league": {"name": "League of Legends", "kill_zone": [0.30, 0.12, 0.40, 0.12]},
    "rocket": {"name": "Rocket League", "kill_zone": [0.25, 0.10, 0.50, 0.16]},
}

DEFAULT_SETTINGS = {
    "game": "generic",
    "kill_zone": None,          # overrides the preset when set
    "weights": {"audio": 1.0, "chat": 1.2, "kills": 1.5, "motion": 0.4},
    "min_len": 15,
    "max_len": 45,
    "max_clips": 12,
    "pre_roll": 6,              # seconds of build-up kept before the hot moment
    "post_roll": 3,
    "chat_delay": 6,            # chat reacts a few seconds after the moment
    "transcribe": True,
    "use_ai": True,
    "section": None,            # [start, end] seconds to download/analyse only part of a VOD
}

DEFAULT_STYLE = {
    "layout": "split",          # split | blur | crop
    "captions": True,
    "caption_case": "upper",
    "show_title": False,
    "focus_x": 0.5,             # horizontal focus of the gameplay crop, 0..1
    "zoom": 1.0,                # blur layout: 1.0 full width, up to 1.8
    "cam_ratio": 0.36,          # split layout: share of height given to the facecam
}


def ensure_dirs() -> None:
    PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
