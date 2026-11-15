'use strict';
/*
 * Document model + editing operations.
 *
 * Time is always in seconds. A clip occupies [start, start + duration) on the
 * timeline and plays its source from `in` at `props.speed`, so the source range
 * used is [in, in + duration * speed).
 */

function defaultSettings() {
  return { name: 'Untitled Sequence', width: 1280, height: 720, fps: 30, bg: '#000000' };
}

function defaultTracks() {
  const t = (kind, name) => ({ id: uid('t'), kind, name, hidden: false, muted: false });
  return [t('video', 'V1'), t('video', 'V2'), t('video', 'V3'), t('audio', 'A1'), t('audio', 'A2')];
}

function defaultProps() {
  return {
    x: 0, y: 0, scale: 100, rotation: 0,
    opacity: 100, fadeIn: 0, fadeOut: 0,
    brightness: 100, contrast: 100, saturation: 100, hue: 0, blur: 0,
    volume: 100, speed: 1,
    text: 'Your Title', font: 'Helvetica, Arial, sans-serif', fontSize: 96, color: '#ffffff',
    bold: true, shadow: true, bg: false, bgColor: '#000000', bgOpacity: 60,
  };
}

const state = {
  settings: defaultSettings(),
  media: [],          // runtime-only: { id, name, type, url, duration, width, height, thumb, wave, img }
  tracks: defaultTracks(),
  clips: [],
  selection: new Set(),
  playhead: 0,
  zoom: 60,           // timeline pixels per second
  tool: 'select',
  snap: true,
  playing: false,
  exporting: false,
};

/* ---------- lookups ---------- */
const getTrack = (id) => state.tracks.find((t) => t.id === id);
const getClip = (id) => state.clips.find((c) => c.id === id);
const getMedia = (id) => state.media.find((m) => m.id === id);
const videoTracks = () => state.tracks.filter((t) => t.kind === 'video');
const audioTracks = () => state.tracks.filter((t) => t.kind === 'audio');
const clipEnd = (c) => c.start + c.duration;
const frameDur = () => 1 / state.settings.fps;
const trackKindFor = (type) => (type === 'audio' ? 'audio' : 'video');
const seqDuration = () => state.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0);
const selectedClips = () => [...state.selection].map(getClip).filter(Boolean);

function sourceDurationOf(clip) {
  if (clip.type !== 'video' && clip.type !== 'audio') return Infinity;
  const m = getMedia(clip.mediaId);
  return m && isFinite(m.duration) && m.duration > 0 ? m.duration : Infinity;
}

function fadeFactor(clip, t) {
  const p = clip.props;
  const lt = t - clip.start;
  let f = 1;
  if (p.fadeIn > 0 && lt < p.fadeIn) f *= lt / p.fadeIn;
  const rem = clip.duration - lt;
  if (p.fadeOut > 0 && rem < p.fadeOut) f *= rem / p.fadeOut;
  return clamp(f, 0, 1);
}

/* ---------- tracks ---------- */
function renameTracks() {
  let v = 1, a = 1;
  for (const t of state.tracks) t.name = t.kind === 'video' ? `V${v++}` : `A${a++}`;
}

function addTrack(kind) {
  const t = { id: uid('t'), kind, name: '', hidden: false, muted: false };
  const idx = kind === 'video' ? videoTracks().length : state.tracks.length;
  state.tracks.splice(idx, 0, t);
  renameTracks();
  return t;
}

function removeTrack(id) {
  const t = getTrack(id);
  if (!t) return false;
  if (state.tracks.filter((x) => x.kind === t.kind).length <= 1) return false;
  state.clips = state.clips.filter((c) => c.trackId !== id);
  state.tracks = state.tracks.filter((x) => x.id !== id);
  renameTracks();
  return true;
}

/* ---------- clips ---------- */
function makeClip(type, trackId, start, duration, mediaId = null) {
  return { id: uid('c'), type, mediaId, trackId, start, in: 0, duration, name: '', props: defaultProps() };
}

function isFree(trackId, start, end, exclude = new Set()) {
  return !state.clips.some((c) => c.trackId === trackId && !exclude.has(c.id) &&
    c.start < end - EPS && clipEnd(c) > start + EPS);
}

/** First track of `kind` with room for [start, start+dur); creates one if needed. */
function findFreeTrack(kind, start, dur, topFirst = false) {
  let list = state.tracks.filter((t) => t.kind === kind);
  if (topFirst) list = list.slice().reverse();
  for (const t of list) if (isFree(t.id, start, start + dur)) return t;
  return addTrack(kind);
}

function removeClip(id) {
  state.clips = state.clips.filter((c) => c.id !== id);
  state.selection.delete(id);
}

/** Split `clip` at timeline time t. Returns the new right-hand clip (or null). */
function splitClip(clip, t) {
  if (t <= clip.start + EPS || t >= clipEnd(clip) - EPS) return null;
  const right = JSON.parse(JSON.stringify(clip));
  const d = t - clip.start;
  right.id = uid('c');
  right.start = t;
  right.in = clip.in + d * clip.props.speed;
  right.duration = clip.duration - d;
  right.props.fadeIn = 0;
  clip.duration = d;
  clip.props.fadeOut = 0;
  state.clips.push(right);
  return right;
}

/** Overwrite edit: make [s, e) on a track empty, trimming/splitting/removing clips. */
function clearRange(trackId, s, e, excludeIds = new Set()) {
  for (const c of state.clips.slice()) {
    if (c.trackId !== trackId || excludeIds.has(c.id)) continue;
    const cs = c.start, ce = clipEnd(c);
    if (ce <= s + EPS || cs >= e - EPS) continue;
    if (cs >= s - EPS && ce <= e + EPS) {
      removeClip(c.id);
    } else if (cs < s && ce > e) {
      splitClip(c, e);
      c.duration = s - cs;
    } else if (cs < s) {
      c.duration = s - cs;
      c.props.fadeOut = Math.min(c.props.fadeOut, c.duration);
    } else {
      const d = e - cs;
      c.start = e;
      c.in += d * c.props.speed;
      c.duration -= d;
      c.props.fadeIn = Math.min(c.props.fadeIn, c.duration);
    }
  }
}

/** Delete clips and pull later clips on the same track left to close the gap. */
function rippleDelete(ids) {
  const clips = ids.map(getClip).filter(Boolean).sort((a, b) => b.start - a.start);
  for (const c of clips) {
    const end = clipEnd(c), dur = c.duration, tid = c.trackId;
    removeClip(c.id);
    for (const o of state.clips) {
      if (o.trackId === tid && o.start >= end - EPS) o.start = Math.max(0, o.start - dur);
    }
  }
}

/** Change playback rate, keeping the same source range (so duration changes). */
function setClipSpeed(clip, speed) {
  const srcLen = clip.duration * clip.props.speed;
  clip.props.speed = speed;
  const nextStart = Math.min(Infinity, ...state.clips
    .filter((c) => c.trackId === clip.trackId && c.id !== clip.id && c.start >= clipEnd(clip) - EPS)
    .map((c) => c.start));
  clip.duration = Math.max(frameDur(), Math.min(srcLen / speed, nextStart - clip.start));
}

function editPoints() {
  const pts = new Set([0]);
  for (const c of state.clips) { pts.add(+c.start.toFixed(6)); pts.add(+clipEnd(c).toFixed(6)); }
  return [...pts].sort((a, b) => a - b);
}

/* ---------- undo / redo ---------- */
const hist = { past: [], future: [], pending: null };
let onDocChanged = () => {};   // assigned by the UI layer

function snapshotDoc() {
  return JSON.stringify({ settings: state.settings, tracks: state.tracks, clips: state.clips });
}

/** Call before mutating; safe to call repeatedly during a drag. */
function editStart() {
  if (!hist.pending) hist.pending = snapshotDoc();
}

/** Commit the pending edit as one undo step (no-op if nothing changed). */
function editEnd() {
  if (!hist.pending) return;
  const before = hist.pending;
  hist.pending = null;
  if (snapshotDoc() === before) return;
  hist.past.push(before);
  if (hist.past.length > 200) hist.past.shift();
  hist.future = [];
  onDocChanged();
}

function edit(fn) {
  editStart();
  const r = fn();
  editEnd();
  return r;
}

function restoreDoc(json) {
  const d = JSON.parse(json);
  state.settings = d.settings;
  state.tracks = d.tracks;
  state.clips = d.clips;
}

function undo() {
  editEnd();
  if (!hist.past.length) return toast('Nothing to undo');
  hist.future.push(snapshotDoc());
  restoreDoc(hist.past.pop());
  onDocChanged();
}

function redo() {
  editEnd();
  if (!hist.future.length) return toast('Nothing to redo');
  hist.past.push(snapshotDoc());
  restoreDoc(hist.future.pop());
  onDocChanged();
}
