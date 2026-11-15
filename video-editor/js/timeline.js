'use strict';
/* Timeline panel: rendering, ruler, playhead, and all mouse interactions. */

const HEADER_W = 168;               // keep in sync with --hw in styles.css
const TRACK_H = { video: 58, audio: 50 };
const tlScroll = $('#tlScroll');
const tlContent = $('#tlContent');
const tlTracks = $('#tlTracks');
const rulerTrack = $('#tlRulerTrack');
const ruler = $('#ruler');
const playheadEl = $('#playhead');
const snapLine = $('#snapLine');

const displayTracks = () => [...videoTracks().reverse(), ...audioTracks()];
const contentWidth = () => Math.max((seqDuration() + 30) * state.zoom, tlScroll.clientWidth - HEADER_W);
const laneOriginX = () => tlScroll.getBoundingClientRect().left + HEADER_W - tlScroll.scrollLeft;
const xToTime = (clientX) => Math.max(0, (clientX - laneOriginX()) / state.zoom);

/* ---------- rendering ---------- */
function renderTimeline() {
  const W = contentWidth();
  tlContent.style.width = `${W + HEADER_W}px`;
  rulerTrack.style.width = `${W}px`;
  const frag = document.createDocumentFragment();
  for (const track of displayTracks()) {
    const isVideo = track.kind === 'video';
    const head = h('div', { class: 'track-head' },
      h('span', { class: 'tname' }, track.name),
      isVideo ? trackToggle(track, 'hidden', track.hidden ? 'eyeOff' : 'eye', 'Toggle track output') : null,
      trackToggle(track, 'muted', track.muted ? 'mute' : 'volume', 'Mute track'),
      h('button', { class: 'del', title: 'Delete track', html: icon('close', 14), onclick: () => deleteTrack(track) }));
    const lane = h('div', { class: 'lane', 'data-track': track.id, style: { width: `${W}px` } });
    for (const clip of state.clips) if (clip.trackId === track.id) lane.append(renderClip(clip));
    frag.append(h('div', { class: `track ${track.kind}`, style: { height: `${TRACK_H[track.kind]}px` } }, head, lane));
  }
  tlTracks.replaceChildren(frag);
  drawRuler();
  updatePlayheadUI();
}

function trackToggle(track, key, iconName, title) {
  return h('button', {
    class: track[key] ? 'on' : '',
    title,
    html: icon(iconName, 15),
    onclick: () => edit(() => { track[key] = !track[key]; }),
  });
}

function deleteTrack(track) {
  const n = state.clips.filter((c) => c.trackId === track.id).length;
  if (state.tracks.filter((t) => t.kind === track.kind).length <= 1) return toast(`Keep at least one ${track.kind} track`);
  if (n && !confirm(`Delete track ${track.name} and its ${n} clip${n > 1 ? 's' : ''}?`)) return;
  edit(() => removeTrack(track.id));
}

function renderClip(clip) {
  const m = getMedia(clip.mediaId);
  const z = state.zoom;
  const sp = clip.props.speed || 1;
  const offline = clip.mediaId && (!m || !m.url);
  const el = h('div', {
    class: `clip type-${clip.type}${state.selection.has(clip.id) ? ' selected' : ''}${offline ? ' offline' : ''}`,
    'data-clip': clip.id,
    title: `${clip.name || clip.type} — ${clip.duration.toFixed(2)}s`,
    style: { left: `${clip.start * z}px`, width: `${Math.max(2, clip.duration * z)}px` },
  });

  const layers = [];
  if (m && !offline) {
    const waveW = `${(m.duration * z) / sp}px`;
    const waveX = `${(-clip.in * z) / sp}px`;
    if (clip.type === 'audio' && m.wave) layers.push([`url("${m.wave}")`, `${waveW} 80%`, `${waveX} 70%`, 'no-repeat']);
    if (clip.type === 'video') {
      if (m.wave) layers.push([`url("${m.wave}")`, `${waveW} 34%`, `${waveX} 100%`, 'no-repeat']);
      if (m.thumb) layers.push([`url("${m.thumb}")`, 'auto 64%', '0 0', 'repeat-x']);
    }
    if (clip.type === 'image' && m.thumb) layers.push([`url("${m.thumb}")`, 'auto 100%', '0 0', 'repeat-x']);
  }
  if (layers.length) {
    el.style.backgroundImage = layers.map((l) => l[0]).join(',');
    el.style.backgroundSize = layers.map((l) => l[1]).join(',');
    el.style.backgroundPosition = layers.map((l) => l[2]).join(',');
    el.style.backgroundRepeat = layers.map((l) => l[3]).join(',');
  }

  const p = clip.props;
  if (p.fadeIn > 0) el.append(h('div', { class: 'fade in', style: { width: `${p.fadeIn * z}px` } }));
  if (p.fadeOut > 0) el.append(h('div', { class: 'fade out', style: { width: `${p.fadeOut * z}px` } }));
  let label = clip.type === 'text' ? `T  ${String(p.text).split('\n')[0] || 'Title'}` : (clip.name || clip.type);
  if (sp !== 1) label = `${sp}× ${label}`;
  if (offline) label = `OFFLINE — ${label}`;
  el.append(h('div', { class: 'clip-label' }, label), h('div', { class: 'handle l' }), h('div', { class: 'handle r' }));
  return el;
}

/* ---------- ruler & playhead ---------- */
const RULER_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];

function rulerLabel(t, step) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  if (step < 1) return `${m}:${s.toFixed(1).padStart(4, '0')}`;
  const hh = Math.floor(m / 60);
  const ss = String(Math.round(s)).padStart(2, '0');
  return hh ? `${hh}:${String(m % 60).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function drawRuler() {
  const viewW = Math.max(1, tlScroll.clientWidth - HEADER_W);
  const RH = 26;
  const dpr = window.devicePixelRatio || 1;
  if (ruler.width !== Math.round(viewW * dpr) || ruler.height !== Math.round(RH * dpr)) {
    ruler.width = Math.round(viewW * dpr);
    ruler.height = Math.round(RH * dpr);
    ruler.style.width = `${viewW}px`;
    ruler.style.height = `${RH}px`;
  }
  const ctx = ruler.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, viewW, RH);
  const z = state.zoom;
  const t0 = tlScroll.scrollLeft / z;
  const t1 = t0 + viewW / z;
  const step = RULER_STEPS.find((s) => s * z >= 80) || 3600;
  const sub = [2, 0.2, 120].includes(step) ? 4 : [15, 30].includes(step) ? 3 : 5;

  // Shade the sequence's used range.
  const endX = (seqDuration() - t0) * z;
  ctx.fillStyle = 'rgba(61,139,253,0.10)';
  ctx.fillRect(0, RH - 5, Math.max(0, Math.min(viewW, endX)), 5);

  ctx.strokeStyle = '#55555d';
  ctx.fillStyle = '#9a9aa3';
  ctx.font = '10px system-ui, sans-serif';
  ctx.textBaseline = 'top';
  ctx.beginPath();
  for (let i = Math.floor(t0 / step); i * step <= t1; i++) {
    const t = i * step;
    const x = Math.round((t - t0) * z) + 0.5;
    ctx.moveTo(x, 10); ctx.lineTo(x, RH);
    ctx.fillText(rulerLabel(t, step), x + 4, 3);
    for (let j = 1; j < sub; j++) {
      const xx = Math.round((t + (j * step) / sub - t0) * z) + 0.5;
      ctx.moveTo(xx, RH - 6); ctx.lineTo(xx, RH);
    }
  }
  ctx.stroke();

  const px = (state.playhead - t0) * z;
  if (px >= -8 && px <= viewW + 8) {
    ctx.fillStyle = '#3d8bfd';
    ctx.beginPath();
    ctx.moveTo(px - 6, 0); ctx.lineTo(px + 6, 0); ctx.lineTo(px + 6, 10); ctx.lineTo(px, 16); ctx.lineTo(px - 6, 10);
    ctx.closePath();
    ctx.fill();
    ctx.fillRect(Math.round(px), 16, 1, RH - 16);
  }
}

function updatePlayheadUI() {
  const x = state.playhead * state.zoom;
  playheadEl.style.transform = `translateX(${HEADER_W + x}px)`;
  if (state.playing) {
    const viewW = tlScroll.clientWidth - HEADER_W;
    if (x > tlScroll.scrollLeft + viewW - 30 || x < tlScroll.scrollLeft) tlScroll.scrollLeft = Math.max(0, x - 60);
  }
  drawRuler();
  updateTimecode();
}

/* ---------- zoom ---------- */
const ZOOM_MIN = 2, ZOOM_MAX = 400;
const zoomToSlider = (z) => (100 * Math.log(z / ZOOM_MIN)) / Math.log(ZOOM_MAX / ZOOM_MIN);
const sliderToZoom = (v) => ZOOM_MIN * Math.pow(ZOOM_MAX / ZOOM_MIN, v / 100);

function setZoom(z, anchorClientX) {
  z = clamp(z, ZOOM_MIN, ZOOM_MAX);
  const ax = anchorClientX != null
    ? anchorClientX - (tlScroll.getBoundingClientRect().left + HEADER_W)
    : state.playhead * state.zoom - tlScroll.scrollLeft;
  const tAnchor = (tlScroll.scrollLeft + ax) / state.zoom;
  state.zoom = z;
  renderTimeline();
  tlScroll.scrollLeft = Math.max(0, tAnchor * z - ax);
  drawRuler();
  $('#zoomSlider').value = String(zoomToSlider(z));
}

function zoomToFit() {
  const d = seqDuration() || 30;
  setZoom((tlScroll.clientWidth - HEADER_W - 60) / d);
  tlScroll.scrollLeft = 0;
  drawRuler();
}

/* ---------- snapping ---------- */
function snapPoints(excludeIds) {
  const pts = [0, state.playhead];
  for (const c of state.clips) if (!excludeIds.has(c.id)) pts.push(c.start, clipEnd(c));
  return pts;
}

function snapValue(t, pts) {
  const thr = 8 / state.zoom;
  let best = null, bd = thr;
  for (const p of pts) { const d = Math.abs(p - t); if (d < bd) { bd = d; best = p; } }
  return best == null ? { t, at: null } : { t: best, at: best };
}

/** Snap a clip's start or end (whichever is closer) to a point. */
function snapRange(start, dur, pts) {
  const a = snapValue(start, pts);
  const b = snapValue(start + dur, pts);
  const da = a.at == null ? Infinity : Math.abs(a.t - start);
  const db = b.at == null ? Infinity : Math.abs(b.t - (start + dur));
  if (da === Infinity && db === Infinity) return { t: start, at: null };
  return da <= db ? { t: a.t, at: a.at } : { t: b.t - dur, at: b.at };
}

function showSnap(at) {
  if (at == null) { snapLine.style.display = 'none'; return; }
  snapLine.style.display = 'block';
  snapLine.style.transform = `translateX(${HEADER_W + at * state.zoom}px)`;
}

function trackAtY(clientY) {
  for (const lane of tlTracks.querySelectorAll('.lane')) {
    const r = lane.getBoundingClientRect();
    if (clientY >= r.top && clientY < r.bottom) return lane.dataset.track;
  }
  return null;
}

/* ---------- interactions ---------- */
function startScrub(e) {
  pause();
  const move = (ev) => setPlayhead(xToTime(ev.clientX));
  move(e);
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', () => window.removeEventListener('mousemove', move), { once: true });
}

rulerTrack.addEventListener('mousedown', (e) => { if (e.button === 0) { e.preventDefault(); startScrub(e); } });
tlScroll.addEventListener('scroll', drawRuler);

tlScroll.addEventListener('wheel', (e) => {
  if (!(e.ctrlKey || e.altKey || e.metaKey)) return;
  e.preventDefault();
  setZoom(state.zoom * Math.exp(-e.deltaY * 0.002), e.clientX);
}, { passive: false });

tlTracks.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || e.target.closest('.track-head')) return;
  const lane = e.target.closest('.lane');
  if (!lane) return;
  const clipEl = e.target.closest('.clip');
  if (!clipEl) {
    e.preventDefault();
    if (state.selection.size) { state.selection.clear(); selectionChanged(); }
    startScrub(e);
    return;
  }
  e.preventDefault();
  const clip = getClip(clipEl.dataset.clip);
  if (!clip) return;

  if (state.tool === 'razor') {
    let t = xToTime(e.clientX);
    if (state.snap) t = snapValue(t, [state.playhead]).t;
    edit(() => splitClip(clip, t));
    return;
  }

  const wasSelected = state.selection.has(clip.id);
  const additive = e.shiftKey || e.ctrlKey || e.metaKey;
  if (additive) {
    if (wasSelected) { state.selection.delete(clip.id); selectionChanged(); return; }
    state.selection.add(clip.id);
    selectionChanged();
  } else if (!wasSelected) {
    state.selection = new Set([clip.id]);
    selectionChanged();
  }
  const mode = e.target.classList.contains('handle')
    ? (e.target.classList.contains('l') ? 'trim-l' : 'trim-r')
    : 'move';
  startClipDrag(e, clip, mode, wasSelected && !additive);
});

function startClipDrag(e, clip, mode, collapseOnClick) {
  const startX = e.clientX, startY = e.clientY;
  const ids = mode === 'move' ? [...state.selection] : [clip.id];
  const orig = new Map(ids.map((id) => {
    const c = getClip(id);
    return [id, { start: c.start, in: c.in, duration: c.duration, trackId: c.trackId }];
  }));
  const o = orig.get(clip.id);
  const excl = new Set(ids);
  const points = snapPoints(excl);
  const speed = clip.props.speed || 1;
  const kind = trackKindFor(clip.type);

  // Trims can't cross neighbours or run past the source media.
  let minStart = 0, maxEnd = Infinity;
  if (mode !== 'move') {
    const others = state.clips.filter((c) => c.trackId === clip.trackId && c.id !== clip.id);
    const prevEnd = Math.max(0, ...others.filter((c) => clipEnd(c) <= o.start + EPS).map(clipEnd));
    const nextStart = Math.min(Infinity, ...others.filter((c) => c.start >= o.start + o.duration - EPS).map((c) => c.start));
    const srcDur = sourceDurationOf(clip);
    minStart = Math.max(prevEnd, o.start - o.in / speed);
    maxEnd = Math.min(nextStart, o.start + (srcDur - o.in) / speed);
  }

  let moved = false;
  editStart();
  const onMove = (ev) => {
    const dxPx = ev.clientX - startX;
    if (!moved && Math.abs(dxPx) < 3 && Math.abs(ev.clientY - startY) < 3) return;
    moved = true;
    const dx = dxPx / state.zoom;
    const minF = frameDur();
    let at = null;
    if (mode === 'move') {
      let ns = o.start + dx;
      if (state.snap) ({ t: ns, at } = snapRange(ns, o.duration, points));
      let delta = ns - o.start;
      const minOrig = Math.min(...[...orig.values()].map((v) => v.start));
      if (minOrig + delta < 0) delta = -minOrig;
      for (const [id, v] of orig) getClip(id).start = v.start + delta;
      if (ids.length === 1) {
        const tid = trackAtY(ev.clientY);
        const tr = tid && getTrack(tid);
        if (tr && tr.kind === kind) clip.trackId = tid;
      }
    } else if (mode === 'trim-r') {
      let ne = o.start + o.duration + dx;
      if (state.snap) ({ t: ne, at } = snapValue(ne, points));
      ne = clamp(ne, o.start + minF, maxEnd);
      clip.duration = ne - o.start;
      clip.props.fadeOut = Math.min(clip.props.fadeOut, clip.duration);
    } else {
      let ns = o.start + dx;
      if (state.snap) ({ t: ns, at } = snapValue(ns, points));
      ns = clamp(ns, minStart, o.start + o.duration - minF);
      const d = ns - o.start;
      clip.start = ns;
      clip.in = Math.max(0, o.in + d * speed);
      clip.duration = o.duration - d;
      clip.props.fadeIn = Math.min(clip.props.fadeIn, clip.duration);
    }
    showSnap(at);
    renderTimeline();
    markDirty();
  };
  const onUp = () => {
    window.removeEventListener('mousemove', onMove);
    showSnap(null);
    if (moved && mode === 'move') {
      // Overwrite whatever the moved clips now cover.
      for (const id of ids) {
        const c = getClip(id);
        if (c) clearRange(c.trackId, c.start, clipEnd(c), excl);
      }
    }
    if (!moved && collapseOnClick && state.selection.size > 1) {
      state.selection = new Set([clip.id]);
      selectionChanged();
    }
    editEnd();
    renderTimeline();
    renderInspector();
    markDirty();
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp, { once: true });
}

/* Drag media from the Project bin onto a track. */
const MEDIA_MIME = 'application/x-cutroom-media';
let dropLane = null;
function setDropLane(lane) {
  if (dropLane === lane) return;
  if (dropLane) dropLane.classList.remove('drop-target');
  dropLane = lane;
  if (lane) lane.classList.add('drop-target');
}

tlTracks.addEventListener('dragover', (e) => {
  if (!Array.from(e.dataTransfer.types).includes(MEDIA_MIME)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  setDropLane(e.target.closest('.lane'));
});
tlTracks.addEventListener('dragleave', (e) => { if (!tlTracks.contains(e.relatedTarget)) setDropLane(null); });
tlTracks.addEventListener('drop', (e) => {
  setDropLane(null);
  const id = e.dataTransfer.getData(MEDIA_MIME);
  if (!id) return;
  e.preventDefault();
  e.stopPropagation();
  const media = getMedia(id);
  if (!media || !media.url || media.loading) return;
  const dur = mediaClipDuration(media);
  let t = xToTime(e.clientX);
  if (state.snap) t = Math.max(0, snapRange(t, dur, snapPoints(new Set())).t);
  const lane = e.target.closest('.lane');
  let track = lane && getTrack(lane.dataset.track);
  edit(() => {
    if (!track || track.kind !== trackKindFor(media.type)) track = findFreeTrack(trackKindFor(media.type), t, dur);
    placeMediaClip(media, track, t);
  });
});

tlTracks.addEventListener('contextmenu', (e) => {
  const lane = e.target.closest('.lane');
  if (!lane) return;
  e.preventDefault();
  const clipEl = e.target.closest('.clip');
  if (clipEl) {
    const id = clipEl.dataset.clip;
    if (!state.selection.has(id)) { state.selection = new Set([id]); selectionChanged(); }
    showMenu(e.clientX, e.clientY, [
      ['Split at playhead', 'S', splitAtPlayhead],
      ['Duplicate', 'Ctrl+D', duplicateSelection],
      ['Copy', 'Ctrl+C', copySelection],
      null,
      ['Delete', 'Del', deleteSelection],
      ['Ripple delete', 'Shift+Del', rippleDeleteSelection],
    ]);
  } else {
    const t = xToTime(e.clientX);
    showMenu(e.clientX, e.clientY, [
      ['Paste here', 'Ctrl+V', () => pasteClips(t), !clipboard],
      ['Select all', 'Ctrl+A', selectAll],
    ]);
  }
});
