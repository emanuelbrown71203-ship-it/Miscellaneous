#!/usr/bin/env bash
# Install (first run) and start Clutch on macOS or Linux.
set -e
cd "$(dirname "$0")"
if ! command -v ffmpeg >/dev/null; then
  echo "ffmpeg is not installed."
  if command -v brew >/dev/null; then brew install ffmpeg
  elif command -v apt-get >/dev/null; then sudo apt-get install -y ffmpeg
  else echo "Install ffmpeg from https://ffmpeg.org/download.html and run this again."; exit 1; fi
fi
if [ ! -x .venv/bin/python ]; then
  echo "Setting up Clutch for the first time. This takes a few minutes."
  python3 -m venv .venv
  .venv/bin/python -m pip install --upgrade pip
  .venv/bin/python -m pip install -r requirements.txt
fi
exec .venv/bin/python run.py --phone "$@"
