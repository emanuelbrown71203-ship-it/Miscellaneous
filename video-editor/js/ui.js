'use strict';
/* Panels, commands, keyboard shortcuts, dialogs, export and project files. */

/* ================= commands ================= */
function selectionChanged() {
  renderTimeline();
  renderInspector();
  markDirty();
}

function selectAll() {
  state.selection = new Set(state.clips.map((c) => c.id));
  selectionChanged();
}

function deleteSelection() {
  if (!state.selection.size) return;
  edit(() => { for (const id of [...state.selection]) removeClip(id); });
}

function rippleDeleteSelection() {
  if (!state.selection.size) return;
  edit(() => rippleDelete([...state.selection]));
}

function splitAtPlayhead() {
  const t = state.playhead;
  const under = (c) => t > c.start + EPS && t < clipEnd(c) - EPS;
  let targets = selectedClips().filter(under);
  if (!targets.length) targets = state.clips.filter(under);
  if (!targets.length) return toast('No clip under the playhead');
  edit(() => targets.forEach((c) => splitClip(c, t)));
}

let clipboard = null;
function copySelection() {
  const cs = selectedClips();
  if (!cs.length) return;
  const minStart = Math.min(...cs.map((c) => c.start));
  clipboard = cs.map((c) => ({ clip: JSON.parse(JSON.stringify(c)), offset: c.start - minStart }));
  toast(`Copied ${cs.length} clip${cs.length > 1 ? 's' : ''}`);
}

function insertCopies(entries, at) {
  const sel = new Set();
  for (const { clip, offset } of entries) {
    const c = JSON.parse(JSON.stringify(clip));
    c.id = uid('c');
    c.start = at + offset;
    if (!getTrack(c.trackId)) c.trackId = findFreeTrack(trackKindFor(c.type), c.start, c.duration).id;
    clearRange(c.trackId, c.start, clipEnd(c));
    state.clips.push(c);
    sel.add(c.id);
  }
  state.selection = sel;
}

function pasteClips(at = state.playhead) {
  if (!clipboard) return toast('Clipboard is empty');
  edit(() => insertCopies(clipboard, at));
}

function duplicateSelection() {
  const cs = selectedClips();
  if (!cs.length) return;
  const minStart = Math.min(...cs.map((c) => c.start));
  const maxEnd = Math.max(...cs.map(clipEnd));
  const entries = cs.map((c) => ({ clip: c, offset: c.start - minStart }));
  edit(() => insertCopies(entries, maxEnd));
}

function mediaClipDuration(m) { return m.type === 'image' ? 5 : m.duration; }

/** Put a media clip on a track (overwriting what's there). Call inside edit(). */
function placeMediaClip(media, track, start) {
  const dur = mediaClipDuration(media);
  const c = makeClip(media.type, track.id, start, dur, media.id);
  c.name = media.name;
  clearRange(track.id, start, start + dur);
  state.clips.push(c);
  state.selection = new Set([c.id]);
  return c;
}

function addMediaAtPlayhead(media) {
  if (!media.url || media.loading) return;
  const wasEmpty = seqDuration() === 0;
  const t = state.playhead;
  const c = edit(() => placeMediaClip(media, findFreeTrack(trackKindFor(media.type), t, mediaClipDuration(media)), t));
  setPlayhead(clipEnd(c));    // so the next double-click appends after this one
  if (wasEmpty) zoomToFit();
}

function addTitle() {
  const t = state.playhead;
  edit(() => {
    const track = findFreeTrack('video', t, 5, true);
    const c = makeClip('text', track.id, t, 5);
    c.name = 'Title';
    state.clips.push(c);
    state.selection = new Set([c.id]);
  });
}

function removeMedia(m) {
  const n = state.clips.filter((c) => c.mediaId === m.id).length;
  if (n && !confirm(`Remove "${m.name}" and its ${n} clip${n > 1 ? 's' : ''} from the sequence?`)) return;
  if (n) edit(() => { state.clips = state.clips.filter((c) => c.mediaId !== m.id); });
  if (m.url) URL.revokeObjectURL(m.url);
  state.media = state.media.filter((x) => x !== m);
  renderBin();
  renderTimeline();
}

function stepFrames(n) { pause(); setPlayhead((Math.round(state.playhead * state.settings.fps) + n) / state.settings.fps); }

function jumpEdit(dir) {
  pause();
  const pts = editPoints();
  const t = state.playhead;
  const target = dir < 0 ? [...pts].reverse().find((p) => p < t - EPS) : pts.find((p) => p > t + EPS);
  if (target != null) setPlayhead(target);
}

function setTool(tool) {
  state.tool = tool;
  document.body.classList.toggle('tool-razor', tool === 'razor');
  $$('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
}

function toggleSnap() {
  state.snap = !state.snap;
  $('#btnSnap').classList.toggle('active', state.snap);
  toast(`Snapping ${state.snap ? 'on' : 'off'}`);
}

/* ================= project bin ================= */
function renderBin() {
  const list = $('#binList');
  $('#binCount').textContent = state.media.length ? `${state.media.length} item${state.media.length > 1 ? 's' : ''}` : '';
  if (!state.media.length) {
    const saved = readAutosave();
    list.replaceChildren(h('div', { class: 'bin-empty' },
      h('div', { class: 'big' }, 'Drop media here'),
      h('div', null, 'Video, audio and images — or click Import.'),
      h('button', { class: 'primary', style: { marginTop: '12px' }, html: `${icon('import')} Import media`, onclick: () => $('#fileInput').click() }),
      saved && saved.clips && saved.clips.length
        ? h('button', { style: { marginTop: '8px' }, onclick: () => loadProjectData(saved) }, `Restore last session (${saved.clips.length} clip${saved.clips.length > 1 ? 's' : ''})`)
        : null));
    return;
  }
  list.replaceChildren(...state.media.map((m) => {
    const used = state.clips.some((c) => c.mediaId === m.id);
    const ready = m.url && !m.loading;
    const item = h('div', {
      class: `bin-item${!m.url ? ' offline' : ''}${m.loading ? ' loading' : ''}`,
      draggable: !!ready,
      title: `${m.name}${m.width ? ` — ${m.width}×${m.height}` : ''}\nDrag to the timeline or double-click to add at the playhead`,
    },
      h('div', { class: `thumb ${m.type}`, style: m.thumb ? { backgroundImage: `url("${m.thumb}")` } : null },
        m.type === 'audio' && m.wave ? h('img', { class: 'wave', src: m.wave, alt: '' }) : null,
        h('span', { class: `badge ${m.type}` }, m.type),
        m.type !== 'image' && m.duration ? h('span', { class: 'dur' }, shortDur(m.duration)) : null,
        !m.url ? h('span', { class: 'state-tag' }, 'OFFLINE') : null,
        m.loading ? h('span', { class: 'state-tag' }, 'Loading…') : null),
      h('div', { class: 'meta' },
        h('span', { class: 'name' }, m.name),
        used ? h('span', { class: 'used', title: 'Used in sequence' }, '●') : null),
      h('button', { class: 'remove', title: 'Remove from project', html: icon('close', 12), onclick: (ev) => { ev.stopPropagation(); removeMedia(m); } }));
    item.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData(MEDIA_MIME, m.id);
      e.dataTransfer.effectAllowed = 'copy';
    });
    item.addEventListener('dblclick', () => addMediaAtPlayhead(m));
    return item;
  }));
}

/* ================= inspector ================= */
const FONTS = [
  ['Sans', 'Helvetica, Arial, sans-serif'],
  ['Serif', 'Georgia, "Times New Roman", serif'],
  ['Impact', 'Impact, Haettenschweiler, "Arial Narrow Bold", sans-serif'],
  ['Mono', '"Courier New", Courier, monospace'],
  ['Humanist', '"Trebuchet MS", "Segoe UI", sans-serif'],
  ['System', 'system-ui, sans-serif'],
];
const RESOLUTIONS = [
  ['854 × 480 (SD)', 854, 480],
  ['1280 × 720 (HD)', 1280, 720],
  ['1920 × 1080 (Full HD)', 1920, 1080],
  ['1080 × 1920 (Vertical 9:16)', 1080, 1920],
  ['1080 × 1080 (Square)', 1080, 1080],
  ['2560 × 1440 (QHD)', 2560, 1440],
];
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

const lbl = (text) => h('span', { class: 'lbl' }, text);
const wideRow = (label, ...ctl) => h('div', { class: 'insp-row wide' }, lbl(label), ...ctl);
const btn = (text, fn, cls = '') => h('button', { class: cls, onclick: fn }, text);

function section(title, rows, resetKeys, target) {
  const reset = resetKeys && h('button', {
    class: 'link', title: 'Reset to defaults',
    onclick: () => edit(() => { const d = defaultProps(); for (const k of resetKeys) target.props[k] = d[k]; }),
  }, 'Reset');
  return h('div', { class: 'insp-section' }, h('div', { class: 'insp-title' }, h('span', null, title), reset), ...rows);
}

function numCtl(clip, key, label, { min, max, step = 1, unit = '', live } = {}) {
  const p = clip.props;
  const fmt = (v) => String(Math.round(v * 100) / 100);
  const range = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(p[key]) });
  const num = h('input', { type: 'number', step: String(step), value: fmt(p[key]) });
  const apply = (raw, src) => {
    const v = parseFloat(raw);
    if (isNaN(v)) return;
    editStart();
    p[key] = v;
    if (src !== range) range.value = String(v);
    if (src !== num) num.value = fmt(v);
    markDirty();
    if (live) live();
  };
  range.addEventListener('input', () => apply(range.value, range));
  num.addEventListener('input', () => apply(num.value, num));
  range.addEventListener('change', editEnd);
  num.addEventListener('change', editEnd);
  range.addEventListener('dblclick', () => { apply(defaultProps()[key], null); editEnd(); });
  return h('div', { class: 'insp-row' }, lbl(label), range,
    h('span', { class: 'numwrap' }, num, h('span', { class: 'unit' }, unit)));
}

function colorInput(obj, key) {
  const i = h('input', { type: 'color', value: obj[key] });
  i.addEventListener('input', () => { editStart(); obj[key] = i.value; markDirty(); });
  i.addEventListener('change', editEnd);
  return i;
}

function checkInput(obj, key, label) {
  const i = h('input', { type: 'checkbox', checked: !!obj[key] });
  i.addEventListener('change', () => edit(() => { obj[key] = i.checked; }));
  return h('label', { class: 'chk' }, i, label);
}

function renderInspector() {
  const box = $('#inspector');
  const sel = selectedClips();
  if (!sel.length) box.replaceChildren(...sequenceInspector());
  else if (sel.length > 1) {
    box.replaceChildren(h('div', { class: 'insp-section' },
      h('div', { class: 'insp-title' }, `${sel.length} clips selected`),
      h('div', { class: 'insp-actions' },
        btn('Split at playhead', splitAtPlayhead), btn('Duplicate', duplicateSelection), btn('Delete', deleteSelection, 'danger'))));
  } else box.replaceChildren(...clipInspector(sel[0]));
}

function clipInspector(c) {
  const p = c.props;
  const fps = state.settings.fps;
  const { width: W, height: H } = state.settings;
  const out = [];
  const nameInput = h('input', { class: 'grow', value: c.name || '', placeholder: 'Clip name' });
  nameInput.addEventListener('change', () => edit(() => { c.name = nameInput.value; }));
  const meta = (k, v) => h('div', { class: 'meta-cell' }, h('span', null, k), h('b', null, v));
  out.push(h('div', { class: 'insp-section' },
    h('div', { class: 'insp-name' }, h('span', { class: `badge ${c.type}` }, c.type), nameInput),
    h('div', { class: 'meta-grid' },
      meta('Start', timecode(c.start, fps)),
      meta('End', timecode(clipEnd(c), fps)),
      meta('Duration', timecode(c.duration, fps)),
      c.type === 'video' || c.type === 'audio' ? meta('Source in', timecode(c.in, fps)) : null),
    h('div', { class: 'insp-actions' },
      btn('Split', splitAtPlayhead), btn('Duplicate', duplicateSelection), btn('Delete', deleteSelection, 'danger'))));

  const fadeMax = Math.round(c.duration * 100) / 100;
  const fades = [
    numCtl(c, 'fadeIn', 'Fade in', { min: 0, max: fadeMax, step: 0.05, unit: 's', live: renderTimeline }),
    numCtl(c, 'fadeOut', 'Fade out', { min: 0, max: fadeMax, step: 0.05, unit: 's', live: renderTimeline }),
  ];

  if (c.type === 'text') out.push(textSection(c));
  if (c.type !== 'audio') {
    out.push(section('Motion', [
      numCtl(c, 'x', 'Position X', { min: -W, max: W, unit: 'px' }),
      numCtl(c, 'y', 'Position Y', { min: -H, max: H, unit: 'px' }),
      numCtl(c, 'scale', 'Scale', { min: 1, max: 400, unit: '%' }),
      numCtl(c, 'rotation', 'Rotation', { min: -180, max: 180, unit: '°' }),
    ], ['x', 'y', 'scale', 'rotation'], c));
    out.push(section('Opacity', [numCtl(c, 'opacity', 'Opacity', { min: 0, max: 100, unit: '%' }), ...fades],
      ['opacity', 'fadeIn', 'fadeOut'], c));
    if (c.type !== 'text') {
      out.push(section('Color', [
        numCtl(c, 'brightness', 'Brightness', { min: 0, max: 200, unit: '%' }),
        numCtl(c, 'contrast', 'Contrast', { min: 0, max: 200, unit: '%' }),
        numCtl(c, 'saturation', 'Saturation', { min: 0, max: 300, unit: '%' }),
        numCtl(c, 'hue', 'Hue', { min: -180, max: 180, unit: '°' }),
        numCtl(c, 'blur', 'Blur', { min: 0, max: 40, step: 0.5, unit: 'px' }),
      ], ['brightness', 'contrast', 'saturation', 'hue', 'blur'], c));
    }
  }
  if (c.type === 'video' || c.type === 'audio') {
    const rows = [numCtl(c, 'volume', 'Volume', { min: 0, max: 200, unit: '%' })];
    if (c.type === 'audio') rows.push(...fades);
    out.push(section('Audio', rows, c.type === 'audio' ? ['volume', 'fadeIn', 'fadeOut'] : ['volume'], c));
    const speeds = SPEEDS.includes(p.speed) ? SPEEDS : [...SPEEDS, p.speed].sort((a, b) => a - b);
    const sp = h('select', null, ...speeds.map((v) => h('option', { value: String(v), selected: v === p.speed }, `${v}×`)));
    sp.addEventListener('change', () => edit(() => setClipSpeed(c, parseFloat(sp.value))));
    out.push(section('Speed', [wideRow('Rate', sp), h('div', { class: 'hint' }, 'Changing speed changes the clip length.')]));
  }
  return out;
}

function textSection(c) {
  const p = c.props;
  const ta = h('textarea', { rows: 3 });
  ta.value = p.text;
  ta.addEventListener('input', () => { editStart(); p.text = ta.value; markDirty(); });
  ta.addEventListener('change', editEnd);
  const font = h('select', null, ...FONTS.map(([n, v]) => h('option', { value: v, selected: v === p.font }, n)));
  font.addEventListener('change', () => edit(() => { p.font = font.value; }));
  return section('Text', [
    wideRow('Text', ta),
    wideRow('Font', font),
    numCtl(c, 'fontSize', 'Size', { min: 8, max: 400, unit: 'px' }),
    wideRow('Fill', h('div', { class: 'inline' }, colorInput(p, 'color'), checkInput(p, 'bold', 'Bold'), checkInput(p, 'shadow', 'Shadow'))),
    wideRow('Background', h('div', { class: 'inline' }, checkInput(p, 'bg', 'Show'), colorInput(p, 'bgColor'))),
    numCtl(c, 'bgOpacity', 'BG opacity', { min: 0, max: 100, unit: '%' }),
  ], ['font', 'fontSize', 'color', 'bold', 'shadow', 'bg', 'bgColor', 'bgOpacity'], c);
}

function sequenceInspector() {
  const s = state.settings;
  const name = h('input', { class: 'grow', value: s.name });
  name.addEventListener('change', () => edit(() => { s.name = name.value || 'Untitled Sequence'; }));
  const res = h('select', null, ...RESOLUTIONS.map(([label, w, hh]) =>
    h('option', { value: `${w}x${hh}`, selected: s.width === w && s.height === hh }, label)));
  if (!RESOLUTIONS.some(([, w, hh]) => w === s.width && hh === s.height)) {
    res.prepend(h('option', { value: `${s.width}x${s.height}`, selected: true }, `${s.width} × ${s.height}`));
  }
  res.addEventListener('change', () => edit(() => { [s.width, s.height] = res.value.split('x').map(Number); }));
  const fps = h('select', null, ...[24, 25, 30, 50, 60].map((f) => h('option', { value: String(f), selected: s.fps === f }, `${f} fps`)));
  fps.addEventListener('change', () => edit(() => { s.fps = Number(fps.value); }));
  const stat = (k, v) => h('div', { class: 'meta-cell' }, h('span', null, k), h('b', null, v));
  return [
    section('Sequence', [wideRow('Name', name), wideRow('Frame size', res), wideRow('Frame rate', fps), wideRow('Background', colorInput(s, 'bg'))]),
    h('div', { class: 'insp-section' }, h('div', { class: 'insp-title' }, 'Overview'),
      h('div', { class: 'meta-grid' },
        stat('Duration', timecode(seqDuration(), s.fps)),
        stat('Clips', String(state.clips.length)),
        stat('Tracks', `${videoTracks().length} video, ${audioTracks().length} audio`),
        stat('Media', String(state.media.length)))),
    h('div', { class: 'insp-section tips' }, h('div', { class: 'insp-title' }, 'Getting started'),
      h('ol', null,
        h('li', null, 'Import or drop media into the Project panel.'),
        h('li', null, 'Drag it onto the timeline, or double-click to add it at the playhead.'),
        h('li', null, h('kbd', null, 'Space'), ' plays, ', h('kbd', null, 'S'), ' splits, ', h('kbd', null, 'C'), ' is the razor, ', h('kbd', null, 'Del'), ' deletes.'),
        h('li', null, 'Select a clip to edit motion, opacity, color, volume and speed here.'),
        h('li', null, 'Click Export to render a video file.'))),
  ];
}

/* ================= monitor & transport ================= */
const tcCurrent = $('#tcCurrent');
function updateTimecode() { tcCurrent.textContent = timecode(state.playhead, state.settings.fps); }

function updateTransportUI() {
  const b = $('#btnPlay');
  b.innerHTML = icon(state.playing ? 'pause' : 'play', 18);
  b.title = state.playing ? 'Pause (Space)' : 'Play (Space)';
  $('#tcDuration').textContent = timecode(seqDuration(), state.settings.fps);
  $('#seqInfo').textContent = `${state.settings.width}×${state.settings.height} · ${state.settings.fps} fps`;
}

function fitPreview() {
  const stage = $('#stage');
  const sw = stage.clientWidth - 24, sh = stage.clientHeight - 24;
  if (sw <= 0 || sh <= 0) return;
  const ar = state.settings.width / state.settings.height;
  let w = sw, hh = sw / ar;
  if (hh > sh) { hh = sh; w = sh * ar; }
  preview.style.width = `${Math.floor(w)}px`;
  preview.style.height = `${Math.floor(hh)}px`;
}

// Drag in the program monitor to reposition the selected visual clip.
preview.addEventListener('mousedown', (e) => {
  const sel = selectedClips();
  const c = sel.length === 1 ? sel[0] : null;
  if (!c || c.type === 'audio' || state.playhead < c.start || state.playhead >= clipEnd(c)) return;
  e.preventDefault();
  pause();
  const k = preview.width / preview.getBoundingClientRect().width;
  const sx = e.clientX, sy = e.clientY, ox = c.props.x, oy = c.props.y;
  editStart();
  const move = (ev) => {
    c.props.x = Math.round(ox + (ev.clientX - sx) * k);
    c.props.y = Math.round(oy + (ev.clientY - sy) * k);
    markDirty();
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', () => { window.removeEventListener('mousemove', move); editEnd(); }, { once: true });
});

/* ================= menus & dialogs ================= */
const ctxMenu = $('#ctxMenu');
function showMenu(x, y, items) {
  ctxMenu.replaceChildren(...items.map((it) => {
    if (!it) return h('hr');
    const [label, kbd, fn, disabled] = it;
    return h('button', { disabled: !!disabled, onclick: () => { hideMenu(); fn(); } }, h('span', null, label), h('span', { class: 'kbd' }, kbd));
  }));
  ctxMenu.classList.remove('hidden');
  const r = ctxMenu.getBoundingClientRect();
  ctxMenu.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`;
  ctxMenu.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`;
}
function hideMenu() { ctxMenu.classList.add('hidden'); }
window.addEventListener('mousedown', (e) => { if (!ctxMenu.contains(e.target)) hideMenu(); });
window.addEventListener('blur', hideMenu);

const modal = $('#modal');
let modalOnClose = null;
function showModal(title, body, buttons, onClose) {
  modalOnClose = onClose || null;
  modal.replaceChildren(h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true' },
    h('h2', null, title),
    h('div', { class: 'body' }, body),
    h('div', { class: 'foot' }, buttons)));
  modal.classList.remove('hidden');
}
function closeModal() {
  if (modal.classList.contains('hidden')) return;
  modal.classList.add('hidden');
  modal.replaceChildren();
  const cb = modalOnClose;
  modalOnClose = null;
  if (cb) cb();
}
const modalOpen = () => !modal.classList.contains('hidden');

const SHORTCUTS = [
  ['Space', 'Play / pause'], ['K / L', 'Pause / play'],
  ['← / →', 'Step one frame (Shift: 1 second)'], ['↑ / ↓', 'Previous / next edit point'],
  ['Home / End', 'Go to start / end'], ['V', 'Selection tool'], ['C', 'Razor tool'],
  ['S or Ctrl+K', 'Split at playhead'], ['Delete', 'Delete selected clips'], ['Shift+Delete', 'Ripple delete'],
  ['Ctrl+C / X / V', 'Copy / cut / paste at playhead'], ['Ctrl+D', 'Duplicate'], ['Ctrl+A', 'Select all'],
  ['Ctrl+Z / Ctrl+Shift+Z', 'Undo / redo'], ['N', 'Toggle snapping'], ['T', 'New title'],
  ['+ / −', 'Zoom timeline'], ['\\', 'Zoom to fit'], ['Ctrl/Alt + wheel', 'Zoom at cursor'],
  ['Ctrl+I', 'Import media'], ['Ctrl+S', 'Save project'], ['Ctrl+M', 'Export'], ['Esc', 'Deselect'],
];
function showShortcuts() {
  showModal('Keyboard shortcuts',
    h('table', { class: 'kbd-table' }, ...SHORTCUTS.map(([k, d]) => h('tr', null, h('td', null, h('kbd', null, k)), h('td', null, d)))),
    [btn('Close', closeModal, 'primary')]);
}

/* ================= export ================= */
const QUALITIES = [['Low (2.5 Mbps)', 2_500_000], ['Medium (6 Mbps)', 6_000_000], ['High (12 Mbps)', 12_000_000], ['Maximum (25 Mbps)', 25_000_000]];

function supportedFormats() {
  if (!window.MediaRecorder) return [];
  const cands = [
    ['MP4 (H.264 + AAC)', 'video/mp4;codecs=avc1.640028,mp4a.40.2'],
    ['MP4 (H.264 + AAC)', 'video/mp4;codecs=avc1.42E01F,mp4a.40.2'],
    ['MP4', 'video/mp4'],
    ['WebM (VP9 + Opus)', 'video/webm;codecs=vp9,opus'],
    ['WebM (VP8 + Opus)', 'video/webm;codecs=vp8,opus'],
    ['WebM', 'video/webm'],
  ];
  const seen = new Set();
  return cands.filter(([label, mime]) => {
    if (seen.has(label) || !MediaRecorder.isTypeSupported(mime)) return false;
    seen.add(label);
    return true;
  });
}

let exportCancel = null;

async function runExport({ mime, bitrate, mute }, onProgress) {
  pause();
  resumeAudio();
  state.exporting = true;
  const total = seqDuration();
  const stream = preview.captureStream(state.settings.fps);
  if (exportDest) exportDest.stream.getAudioTracks().forEach((tr) => stream.addTrack(tr));
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitrate, audioBitsPerSecond: 192_000 });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise((r) => { rec.onstop = r; });
  if (mute && monitorGain) monitorGain.gain.value = 0;
  let cancelled = false;
  exportCancel = () => { cancelled = true; pause(); };
  try {
    setPlayhead(0);
    await prerollAt(0);
    rec.start(500);
    play();
    await new Promise((resolve) => {
      const tick = () => {
        if (cancelled || !state.playing) return resolve();
        onProgress(state.playhead / total, state.playhead);
        requestAnimationFrame(tick);
      };
      tick();
    });
    await sleep(200);           // let the last frames reach the encoder
    rec.stop();
    await stopped;
  } finally {
    stream.getVideoTracks().forEach((tr) => tr.stop());
    if (monitorGain) monitorGain.gain.value = 1;
    state.exporting = false;
    exportCancel = null;
    markDirty();
  }
  return cancelled ? null : new Blob(chunks, { type: mime.split(';')[0] });
}

function exportFrame() {
  state.exporting = true;          // hide selection guides
  drawFrame();
  state.exporting = false;
  const name = `${safeName(state.settings.name)}_${timecode(state.playhead, state.settings.fps).replace(/:/g, '-')}.png`;
  preview.toBlob((b) => { if (b) downloadBlob(b, name); markDirty(); }, 'image/png');
}

function openExportDialog() {
  if (state.exporting) return;
  const dur = seqDuration();
  if (dur <= 0) return toast('Add some clips to the timeline first');
  pause();
  const s = state.settings;
  const formats = supportedFormats();
  const canRecord = formats.length > 0 && typeof preview.captureStream === 'function';
  const fmt = h('select', null, ...formats.map(([label, mime]) => h('option', { value: mime }, label)));
  const quality = h('select', null, ...QUALITIES.map(([label, bps], i) => h('option', { value: String(bps), selected: i === 2 }, label)));
  const mute = h('input', { type: 'checkbox', checked: true });
  const bar = h('div');
  const prog = h('div', { class: 'progress hidden' }, bar);
  const status = h('div', { class: 'export-status' }, `${s.width}×${s.height} · ${s.fps} fps · ${timecode(dur, s.fps)}`);
  const result = h('div', { class: 'export-result' });
  const startBtn = h('button', { class: 'primary', disabled: !canRecord }, 'Export video');
  const frameBtn = h('button', { onclick: exportFrame }, 'Save frame as PNG');
  const closeBtn = h('button', { onclick: closeModal }, 'Close');

  const body = h('div', { class: 'export-body' },
    canRecord
      ? [h('label', { class: 'field' }, h('span', null, 'Format'), fmt),
        h('label', { class: 'field' }, h('span', null, 'Quality'), quality),
        h('label', { class: 'field' }, h('span', null, 'Monitor audio'), h('span', { class: 'chk' }, mute, 'Mute speakers while rendering'))]
      : h('div', { class: 'note error' }, 'This browser cannot record video from a canvas. Try a recent Chrome, Edge or Firefox.'),
    status, prog, result,
    h('div', { class: 'note' }, 'Export renders in real time — keep this tab in the foreground until it finishes.'));

  showModal('Export sequence', body, [frameBtn, closeBtn, startBtn], () => { if (exportCancel) exportCancel(); });

  startBtn.addEventListener('click', async () => {
    [startBtn, fmt, quality, mute, frameBtn].forEach((x) => { x.disabled = true; });
    prog.classList.remove('hidden');
    result.replaceChildren();
    closeBtn.textContent = 'Cancel';
    try {
      const blob = await runExport({ mime: fmt.value, bitrate: Number(quality.value), mute: mute.checked }, (f, t) => {
        bar.style.width = `${(f * 100).toFixed(1)}%`;
        status.textContent = `Rendering… ${timecode(t, s.fps)} / ${timecode(dur, s.fps)}`;
      });
      if (!modalOpen()) return;
      if (!blob) {
        status.textContent = 'Export cancelled.';
      } else {
        const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
        const fname = `${safeName(s.name)}.${ext}`;
        downloadBlob(blob, fname);
        bar.style.width = '100%';
        status.textContent = `Done — ${fname} (${fmtSize(blob.size)})`;
        result.replaceChildren(h('button', { onclick: () => downloadBlob(blob, fname) }, 'Download again'));
      }
    } catch (err) {
      console.error(err);
      status.textContent = `Export failed: ${err.message}`;
    }
    closeBtn.textContent = 'Close';
    [startBtn, fmt, quality, mute, frameBtn].forEach((x) => { x.disabled = false; });
  });
}

/* ================= project files ================= */
const AUTOSAVE_KEY = 'cutroom.autosave.v1';

function projectJSON() {
  return JSON.stringify({
    app: 'cutroom',
    version: 1,
    settings: state.settings,
    tracks: state.tracks,
    clips: state.clips,
    media: state.media.map(({ id, name, type, duration, width, height }) => ({ id, name, type, duration, width, height })),
  });
}

let autosaveTimer = 0;
function flushAutosave() {
  if (!autosaveTimer) return;
  clearTimeout(autosaveTimer);
  autosaveTimer = 0;
  try { localStorage.setItem(AUTOSAVE_KEY, projectJSON()); } catch { /* storage unavailable */ }
}
function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(flushAutosave, 800);
}
window.addEventListener('pagehide', flushAutosave);
document.addEventListener('visibilitychange', () => { if (document.hidden) flushAutosave(); });

function readAutosave() {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveProject() {
  downloadBlob(new Blob([projectJSON()], { type: 'application/json' }), `${safeName(state.settings.name)}.cutroom.json`);
  toast('Project saved. Media files are referenced by name — keep them alongside.');
}

function loadProjectData(d) {
  if (!d || d.app !== 'cutroom' || !Array.isArray(d.clips) || !Array.isArray(d.tracks)) {
    throw new Error('Not a Cutroom project file');
  }
  pause();
  // Reuse already-imported media when names match; everything else starts offline.
  const media = (d.media || []).map((pm) => {
    const live = state.media.find((m) => m.url && m.name === pm.name && m.type === pm.type);
    if (live) { live.id = pm.id; return live; }
    return { ...pm, url: null };
  });
  const extra = state.media.filter((m) => !media.includes(m));
  state.media = [...media, ...extra];
  state.settings = { ...defaultSettings(), ...d.settings };
  state.tracks = d.tracks;
  state.clips = d.clips.map((c) => ({ ...c, props: { ...defaultProps(), ...c.props } }));
  state.selection = new Set();
  state.playhead = 0;
  hist.past = [];
  hist.future = [];
  renderAll();
  zoomToFit();
  const offline = state.media.filter((m) => !m.url).length;
  toast(offline ? `Project opened — import ${offline} missing file${offline > 1 ? 's' : ''} to relink` : 'Project opened');
}

function newProject() {
  if (state.clips.length && !confirm('Start a new project? Unsaved changes will be lost.')) return;
  pause();
  for (const m of state.media) if (m.url) URL.revokeObjectURL(m.url);
  state.media = [];
  state.settings = defaultSettings();
  state.tracks = defaultTracks();
  state.clips = [];
  state.selection = new Set();
  state.playhead = 0;
  hist.past = [];
  hist.future = [];
  try { localStorage.removeItem(AUTOSAVE_KEY); } catch { /* ignore */ }
  state.zoom = 60;
  renderAll();
}

/* ================= global wiring ================= */
function renderAll() {
  renderBin();
  renderTimeline();
  renderInspector();
  updateTransportUI();
  fitPreview();
  $('#btnUndo').disabled = !hist.past.length;
  $('#btnRedo').disabled = !hist.future.length;
  $('#zoomSlider').value = String(zoomToSlider(state.zoom));
  markDirty();
}

onDocChanged = () => {
  for (const id of [...state.selection]) if (!getClip(id)) state.selection.delete(id);
  renderAll();
  scheduleAutosave();
};

function onKeyDown(e) {
  if (e.target.closest('input, textarea, select')) {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  if (modalOpen()) {
    if (e.key === 'Escape' && !state.exporting) closeModal();
    return;
  }
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const handled = () => e.preventDefault();

  if (mod) {
    const cmds = {
      z: () => (e.shiftKey ? redo() : undo()), y: redo, c: copySelection, v: () => pasteClips(),
      x: () => { copySelection(); deleteSelection(); }, d: duplicateSelection, a: selectAll,
      k: splitAtPlayhead, s: saveProject, i: () => $('#fileInput').click(), m: openExportDialog, o: () => $('#projectInput').click(),
    };
    if (cmds[k]) { handled(); cmds[k](); }
    return;
  }
  if (e.altKey) return;
  const keys = {
    ' ': togglePlay, k: pause, l: play,
    v: () => setTool('select'), c: () => setTool('razor'), s: splitAtPlayhead,
    n: toggleSnap, t: addTitle,
    Delete: () => (e.shiftKey ? rippleDeleteSelection() : deleteSelection()),
    Backspace: () => (e.shiftKey ? rippleDeleteSelection() : deleteSelection()),
    ArrowLeft: () => stepFrames(e.shiftKey ? -state.settings.fps : -1),
    ArrowRight: () => stepFrames(e.shiftKey ? state.settings.fps : 1),
    ArrowUp: () => jumpEdit(-1), ArrowDown: () => jumpEdit(1),
    Home: () => { pause(); setPlayhead(0); }, End: () => { pause(); setPlayhead(seqDuration()); },
    '=': () => setZoom(state.zoom * 1.4), '+': () => setZoom(state.zoom * 1.4),
    '-': () => setZoom(state.zoom / 1.4), _: () => setZoom(state.zoom / 1.4),
    '\\': zoomToFit,
    Escape: () => { hideMenu(); if (state.selection.size) { state.selection.clear(); selectionChanged(); } },
  };
  if (keys[k]) { handled(); keys[k](); }
}

function initResizer() {
  const handle = $('#tlResizer');
  const ws = $('.workspace');
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = $('.timeline').getBoundingClientRect().height;
    const move = (ev) => {
      const hgt = clamp(startH - (ev.clientY - startY), 160, innerHeight - 260);
      ws.style.setProperty('--tl-h', `${hgt}px`);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', () => window.removeEventListener('mousemove', move), { once: true });
  });
}

function initFileDrop() {
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    document.body.classList.add('file-drag');
  });
  window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('file-drag'); });
  window.addEventListener('drop', async (e) => {
    document.body.classList.remove('file-drag');
    if (!hasFiles(e)) return;
    e.preventDefault();
    const lane = e.target.closest && e.target.closest('.lane');
    const at = lane ? xToTime(e.clientX) : null;
    const laneTrack = lane ? lane.dataset.track : null;
    const wasEmpty = seqDuration() === 0;
    const added = await importFiles(e.dataTransfer.files);
    // Files dropped straight onto a track are placed there one after another.
    if (at != null && added.length) {
      edit(() => {
        let t = at;
        for (const m of added) {
          const kind = trackKindFor(m.type);
          const dur = mediaClipDuration(m);
          let track = getTrack(laneTrack);
          if (!track || track.kind !== kind) track = findFreeTrack(kind, t, dur);
          placeMediaClip(m, track, t);
          t += dur;
        }
      });
      if (wasEmpty) zoomToFit();
    }
  });
}

function init() {
  $$('[data-icon]').forEach((b) => b.insertAdjacentHTML('afterbegin', icon(b.dataset.icon)));
  const on = (sel, fn) => $(sel).addEventListener('click', fn);
  on('#btnImport', () => $('#fileInput').click());
  on('#btnTitle', addTitle);
  on('#btnUndo', undo);
  on('#btnRedo', redo);
  on('#btnNew', newProject);
  on('#btnOpen', () => $('#projectInput').click());
  on('#btnSave', saveProject);
  on('#btnExport', openExportDialog);
  on('#btnShortcuts', showShortcuts);
  on('#btnPlay', togglePlay);
  on('#btnToStart', () => { pause(); setPlayhead(0); });
  on('#btnToEnd', () => { pause(); setPlayhead(seqDuration()); });
  on('#btnStepBack', () => stepFrames(-1));
  on('#btnStepFwd', () => stepFrames(1));
  on('#btnFullscreen', () => { if (preview.requestFullscreen) preview.requestFullscreen().catch(() => {}); });
  on('#btnSnap', toggleSnap);
  on('#btnSplit', splitAtPlayhead);
  on('#btnDelete', deleteSelection);
  on('#btnAddV', () => edit(() => addTrack('video')));
  on('#btnAddA', () => edit(() => addTrack('audio')));
  on('#btnZoomIn', () => setZoom(state.zoom * 1.4));
  on('#btnZoomOut', () => setZoom(state.zoom / 1.4));
  on('#btnFit', zoomToFit);
  $$('[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
  $('#zoomSlider').addEventListener('input', (e) => setZoom(sliderToZoom(Number(e.target.value))));

  $('#fileInput').addEventListener('change', async (e) => {
    const wasEmpty = seqDuration() === 0;
    await importFiles(e.target.files);
    e.target.value = '';
    if (wasEmpty) renderTimeline();
  });
  $('#projectInput').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try { loadProjectData(JSON.parse(await f.text())); } catch (err) { toast(err.message, 'error'); }
  });

  // Buttons shouldn't keep focus, or Space would re-click them instead of playing.
  document.addEventListener('click', (e) => {
    const b = e.target.closest('button, select');
    if (b && b.tagName === 'BUTTON') b.blur();
  });
  document.addEventListener('change', (e) => { if (e.target.tagName === 'SELECT') e.target.blur(); });
  document.addEventListener('keydown', onKeyDown);

  new ResizeObserver(fitPreview).observe($('#stage'));
  new ResizeObserver(() => renderTimeline()).observe(tlScroll);
  initResizer();
  initFileDrop();
  setTool('select');
  renderAll();
  requestAnimationFrame(frameLoop);
}

init();
