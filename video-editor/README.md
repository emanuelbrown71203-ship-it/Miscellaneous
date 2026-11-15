# Cutroom: a browser video editor

Cutroom is a non-linear video editor that runs entirely in the browser. Its layout follows the standard
desktop editor: a project bin, a program monitor, an effect-controls inspector and a multi-track
timeline. Nothing is uploaded. Your media stays on your machine.

## Run it

There are no dependencies and no build step. Open `index.html` in a recent Chrome, Edge or Firefox.
If your browser blocks local files, serve the folder instead:

```bash
cd video-editor
python3 -m http.server 8000   # then visit http://localhost:8000
```

## Features

| Area | What you can do |
| --- | --- |
| **Project bin** | Import video, audio and images with the button, Ctrl+I or by dragging files in. Thumbnails, waveforms and durations are generated for each item. |
| **Timeline** | Unlimited video and audio tracks. V1 is the bottom layer and higher tracks composite on top. Drag clips in from the bin, move them between tracks, trim either edge, split with S or the razor (C), ripple delete, copy, paste and duplicate. Snapping covers clip edges and the playhead. Zoom with the slider, +/−, \ or Ctrl/Alt + wheel. |
| **Edits** | Placing or moving a clip over another one overwrites it, the same way desktop NLEs behave. Trims stop at neighbouring clips and at the end of the source media. |
| **Effect controls** | Position, scale and rotation (you can also drag in the monitor), opacity, fade in/out, brightness, contrast, saturation, hue, blur, volume (up to 200%) and speed (0.25×–4×). |
| **Titles** | Text clips with font, size, colour, bold, drop shadow and an optional background box. Multi-line text is supported. |
| **Track controls** | Hide video tracks, mute any track, add or delete tracks. |
| **Undo / redo** | Every edit can be undone, up to 200 steps. |
| **Projects** | Save and open `.cutroom.json` project files. When a project is opened, media starts *offline*. Import the same files again and they relink by name. The last session is also autosaved locally. |
| **Export** | Renders the sequence with mixed audio to MP4 (H.264/AAC where the browser supports it) or WebM, at a choice of bitrate. You can also save the current frame as a PNG. |
| **Sequence settings** | 480p, 720p, 1080p, 1440p, vertical 9:16 or square, at 24–60 fps, with a background colour. |

Press the keyboard icon in the top bar for the full list of shortcuts. The main ones are:
Space play/pause · S split · C razor · V select · Del delete · Shift+Del ripple delete ·
←/→ step a frame · ↑/↓ jump between edits · Ctrl+Z / Ctrl+Shift+Z undo/redo.

## How it works

```
js/util.js      DOM helpers, timecode formatting, icons
js/state.js     document model (tracks, clips, settings), edit operations, undo/redo
js/engine.js    media import/probing, per-clip <video>/<audio> pool, Web Audio mixing, canvas compositor, transport
js/timeline.js  timeline rendering, ruler, snapping, drag/trim/razor interactions
js/ui.js        bin, inspector, monitor, menus, keyboard, export, project files, startup
```

- **Playback.** A wall clock drives the playhead. Each clip near the playhead gets its own media
  element, which is pre-rolled to its in-point and kept within a few frames of the clock. Every frame is
  composited onto a `<canvas>` using 2D transforms and `ctx.filter` for the colour effects.
- **Audio.** Each media element is routed through a Web Audio gain node, which applies clip volume,
  fades and track mute. The mix goes to the speakers and to a `MediaStreamDestination`.
- **Export.** The canvas stream (`captureStream`) and the audio stream are recorded together with
  `MediaRecorder` while the sequence plays from the start, so export runs in real time.

## Known limitations

- Export runs in real time, and the tab must stay in the foreground while it renders.
- Effects are per clip. There are no keyframes or cross-track transitions yet: fades work as
  dip-to-black or dip-to-silence.
- Format support depends on the browser. For example, Chromium builds without proprietary codecs
  can't import H.264 `.mp4` files.
- Project files store media file names, not the media itself.
