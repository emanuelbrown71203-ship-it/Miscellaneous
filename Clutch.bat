@echo off
rem Double-click to install (first run) and start Clutch on Windows.
cd /d "%~dp0"
where ffmpeg >nul 2>nul
if errorlevel 1 (
  echo ffmpeg is not installed. Trying to install it with winget...
  winget install -e --id Gyan.FFmpeg --accept-source-agreements --accept-package-agreements
  echo If ffmpeg was just installed, close this window and start Clutch again.
)
if not exist .venv\Scripts\python.exe (
  echo Setting up Clutch for the first time. This takes a few minutes.
  py -3 -m venv .venv || python -m venv .venv
  .venv\Scripts\python -m pip install --upgrade pip
  .venv\Scripts\python -m pip install -r requirements.txt
)
.venv\Scripts\python run.py --phone %*
if errorlevel 1 pause
