# Clutch

An automatic clipper built for gaming. Give it a Twitch VOD, a YouTube video or a recording, and it finds
the moments worth posting and renders them as 1080x1920 shorts.

It runs on your own PC: a small Python server plus a page in your browser. Nothing is uploaded anywhere.

## How it finds highlights

| Signal | What it looks for |
| --- | --- |
| Loudness | Bursts above the video's own baseline, weighted toward the band where shouting and laughing sit |
| Chat | Message rate and emote spam (POG, KEKW, LUL, W, L...) from the Twitch or YouTube chat replay, shifted earlier because chat reacts late |
| Kill feed | New rows appearing in the game's kill-feed zone. Rows close together become Double / Triple / Quad kill tags |
| Event markers | You box something that only shows on a highlight (an elimination banner, a victory screen) and it finds every other time it appears |
| Action | How fast the picture is changing |
| Speech | The best candidates are transcribed; hyped, fast commentary raises the score, and the words become captions |
| AI (optional) | With an Anthropic API key, each candidate is scored as a standalone short and given a title |

The signals are fused into one hype curve, the peaks become clips, and you can re-weight the signals and
re-pick in a second without re-analysing the video.

## Layouts

- **Facecam on top**: your webcam (found automatically, or drag a box) above the gameplay
- **Blurred fill**: full-width gameplay over a blurred background, with optional zoom
- **Full crop**: a 9:16 crop you can aim left or right
- **Animated captions**: word-by-word, burned in, on any layout

## Run it

**Windows:** double-click `Clutch.bat`. **macOS / Linux:** run `./clutch.sh`.

The first run sets everything up (a Python environment, the libraries, and ffmpeg if it's missing), then
opens Clutch. You need Python 3.10+ installed first.

To do it by hand:

```bash
python -m venv .venv
.venv/bin/pip install -r requirements.txt      # Windows: .venv\Scripts\pip
.venv/bin/python run.py --phone
```

### Desktop and phone

- **Desktop:** Clutch opens in its own app window. If a native window isn't available it uses an Edge or
  Chrome app window, and failing that a normal browser tab (`--browser` forces a tab).
- **Phone:** start with `--phone` (the launchers do), click **Use on phone** in the app and scan the QR code
  with a phone on the same Wi-Fi. You get a phone-sized version of the whole app: paste links, send a video
  from the phone, pick clips, edit, render and download the finished shorts to the phone. Use "Add to Home
  Screen" to keep it as an icon.

The PC does the work and keeps the videos; the phone is a screen for it, so Clutch has to be running on the
PC. Phone access only listens on your local network and only answers devices that opened the QR link.
Without `--phone`, nothing outside the PC can reach it.

Optional settings:

- `ANTHROPIC_API_KEY=...` turns on AI ranking and titles.
- `CLUTCH_WHISPER_MODEL=small` (default `base`) trades speed for caption accuracy. The model downloads on first use.
- `CLUTCH_DATA=/path` changes where videos and clips are stored (default `./data`).

## Using it

1. Paste a link or drop in a recording, and pick the game. For a long VOD, fill in "Only this part of the video".
2. When analysis finishes, the timeline shows each signal and the clips it picked, best first.
3. Open **Set up detection** to drag the kill-feed zone onto your HUD, mark your facecam, add event markers,
   or change how much each signal counts.
4. Pick a clip, choose a layout, trim it, and render. Finished shorts are in `data/projects/<id>/clips/`.

The per-game kill-feed zones are starting positions only. HUD layout changes with patches, resolution and
HUD scale, so check the zone on a frame of your own footage.

Recordings have no chat replay; export one (for example with TwitchDownloader) and add it as a chat log.
Accepted formats: TwitchDownloader JSON, yt-dlp `live_chat.json`, CSV, or `[h:mm:ss] name: message` lines.

Only clip videos you made or have permission to use.

## Development

```bash
.venv/bin/pip install pytest
.venv/bin/python -m pytest tests                         # fast unit tests
.venv/bin/python tests/make_fixture.py /tmp/fx           # synthetic stream with planted highlights
```

Layout: `clutch/signals/` (detectors), `clutch/highlights.py` (fusion and clip picking),
`clutch/render.py` + `clutch/captions.py` (ffmpeg output), `clutch/pipeline.py` (jobs),
`clutch/server.py` + `clutch/static/` (web app), `clutch/desktop.py` (app window), `clutch/phone.py` (phone pairing).

The caption font is Anton, under the SIL Open Font License (`clutch/fonts/OFL-Anton.txt`).
