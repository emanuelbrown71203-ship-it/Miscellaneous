'use strict';
/*
 * Media import, playback engine and compositor.
 *
 * Every timeline clip that uses video/audio gets its own <video>/<audio>
 * element (a "pool" entry) so the same file can appear many times at different
 * source offsets. A wall clock drives the playhead; elements are kept in sync
 * with it and their audio is routed through Web Audio so it can be mixed,
 * faded and recorded during export.
 */

const preview = $('#preview');
const pctx = preview.getContext('2d');

/* ---------- audio graph ---------- */
let audioCtx = null, masterGain = null, monitorGain = null, exportDest = null;
(function initAudio() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  audioCtx = new AC();
  masterGain = audioCtx.createGain();
  monitorGain = audioCtx.createGain();
  masterGain.connect(monitorGain);
  monitorGain.connect(audioCtx.destination);
  if (audioCtx.createMediaStreamDestination) {
    exportDest = audioCtx.createMediaStreamDestination();
    masterGain.connect(exportDest);
  }
})();

function resumeAudio() {
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
}
window.addEventListener('pointerdown', resumeAudio, true);
window.addEventListener('keydown', resumeAudio, true);

/* ---------- import ---------- */
function detectType(file) {
  const t = file.type || '';
  if (t.startsWith('video/')) return 'video';
  if (t.startsWith('audio/')) return 'audio';
  if (t.startsWith('image/')) return 'image';
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (['mp4', 'webm', 'mov', 'mkv', 'm4v', 'ogv'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus'].includes(ext)) return 'audio';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif'].includes(ext)) return 'image';
  return null;
}

/** Import files into the project bin. Returns the media objects that were added. */
async function importFiles(fileList) {
  const files = Array.from(fileList || []);
  const added = [];
  let relinked = 0, failed = 0;
  for (const file of files) {
    const type = detectType(file);
    if (!type) { failed++; continue; }
    const url = URL.createObjectURL(file);
    let media = state.media.find((m) => !m.url && m.name === file.name && m.type === type);
    const isRelink = !!media;
    if (!media) {
      media = { id: uid('m'), name: file.name, type, duration: 0, width: 0, height: 0 };
      state.media.push(media);
    }
    media.url = url;
    media.loading = true;
    renderBin();
    try {
      await probeMedia(media);
    } catch (err) {
      console.warn('Import failed', file.name, err);
      URL.revokeObjectURL(url);
      media.url = null;
      media.loading = false;
      if (!isRelink) state.media = state.media.filter((m) => m !== media);
      failed++;
      renderBin();
      continue;
    }
    media.loading = false;
    if (isRelink) relinked++; else added.push(media);
    renderBin();
    renderTimeline();
    markDirty();
    if (media.type !== 'image') {
      buildWaveform(media, file).then(() => { renderBin(); renderTimeline(); });
    }
  }
  const msg = [];
  if (added.length) msg.push(`Imported ${added.length} file${added.length > 1 ? 's' : ''}`);
  if (relinked) msg.push(`relinked ${relinked}`);
  if (failed) msg.push(`${failed} unsupported`);
  if (msg.length) toast(msg.join(', '), failed && !added.length && !relinked ? 'error' : '');
  return added;
}

async function fixInfiniteDuration(el) {
  if (isFinite(el.duration)) return;
  // MediaRecorder WebM files report Infinity until you seek past the end.
  await new Promise((resolve) => {
    const done = () => { if (isFinite(el.duration)) { el.removeEventListener('durationchange', done); resolve(); } };
    el.addEventListener('durationchange', done);
    el.currentTime = 1e7;
    setTimeout(resolve, 4000);
  });
  el.currentTime = 0;
}

async function probeMedia(m) {
  if (m.type === 'image') {
    const img = new Image();
    img.src = m.url;
    await img.decode();
    m.img = img;
    m.width = img.naturalWidth || 1280;
    m.height = img.naturalHeight || 720;
    m.duration = 0;
    m.thumb = makeThumb(img, m.width, m.height);
    return;
  }
  const el = document.createElement(m.type === 'video' ? 'video' : 'audio');
  el.preload = 'auto';
  el.muted = true;
  el.playsInline = true;
  el.src = m.url;
  await waitEvent(el, 'loadedmetadata');
  await fixInfiniteDuration(el);
  if (!isFinite(el.duration) || el.duration <= 0) throw new Error('Unknown duration');
  m.duration = el.duration;
  if (m.type === 'video') {
    if (!el.videoWidth) {
      m.type = 'audio';             // e.g. an audio-only .webm
    } else {
      m.width = el.videoWidth;
      m.height = el.videoHeight;
      el.currentTime = Math.min(1, m.duration * 0.1);
      await waitEvent(el, 'seeked', 5000).catch(() => {});
      if (el.readyState >= 2) m.thumb = makeThumb(el, m.width, m.height);
    }
  }
  el.removeAttribute('src');
  el.load();
}

function makeThumb(src, w, hgt) {
  const c = document.createElement('canvas');
  c.height = 90;
  c.width = Math.max(1, Math.round(90 * ((w / hgt) || 16 / 9)));
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.7);
}

async function buildWaveform(m, file) {
  if (!audioCtx || file.size > 300 * 1024 * 1024) return;
  try {
    const buf = await file.arrayBuffer();
    const audio = await audioCtx.decodeAudioData(buf);
    const chans = [];
    for (let i = 0; i < Math.min(2, audio.numberOfChannels); i++) chans.push(audio.getChannelData(i));
    const len = chans[0].length;
    const cols = clamp(Math.round(audio.duration * 40), 200, 6000);
    const step = Math.max(1, Math.floor(len / cols));
    const stride = Math.max(1, Math.floor(step / 400));
    const c = document.createElement('canvas');
    c.width = cols;
    c.height = 64;
    const ctx = c.getContext('2d');
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    for (let x = 0; x < cols; x++) {
      let peak = 0;
      const from = x * step, to = Math.min(len, from + step);
      for (const ch of chans) {
        for (let i = from; i < to; i += stride) {
          const v = Math.abs(ch[i]);
          if (v > peak) peak = v;
        }
      }
      const hgt = Math.max(1, Math.min(1, peak) * 62);
      ctx.fillRect(x, 32 - hgt / 2, 1, hgt);
    }
    m.wave = c.toDataURL('image/png');
  } catch {
    /* no decodable audio track: leave without waveform */
  }
}

/* ---------- element pool ---------- */
const pool = new Map(); // clipId -> { el, gain, url }

function poolGet(clip, media) {
  let rec = pool.get(clip.id);
  if (rec && rec.url === media.url) return rec;
  if (rec) poolDrop(clip.id);
  const el = document.createElement(media.type === 'audio' ? 'audio' : 'video');
  el.preload = 'auto';
  el.playsInline = true;
  el.src = media.url;
  el.addEventListener('seeked', markDirty);
  el.addEventListener('loadeddata', markDirty);
  let gain = null;
  if (audioCtx) {
    try {
      const src = audioCtx.createMediaElementSource(el);
      gain = audioCtx.createGain();
      src.connect(gain);
      gain.connect(masterGain);
    } catch (err) {
      console.warn('Audio routing failed', err);
    }
  }
  rec = { el, gain, url: media.url };
  pool.set(clip.id, rec);
  return rec;
}

function poolDrop(id) {
  const rec = pool.get(id);
  if (!rec) return;
  rec.el.pause();
  rec.el.removeAttribute('src');
  rec.el.load();
  if (rec.gain) rec.gain.disconnect();
  pool.delete(id);
}

/** Keep every media element aligned with the playhead (called every frame). */
function syncMedia() {
  const t = state.playhead;
  const playing = state.playing;
  const alive = new Set();
  for (const clip of state.clips) {
    if (clip.type !== 'video' && clip.type !== 'audio') continue;
    const media = getMedia(clip.mediaId);
    if (!media || !media.url) continue;
    const end = clipEnd(clip);
    if (t < clip.start - 5 || t > end + 1) continue;   // only keep nearby clips loaded
    alive.add(clip.id);
    const rec = poolGet(clip, media);
    const el = rec.el;
    const speed = clip.props.speed || 1;

    if (t < clip.start || t >= end) {
      if (!el.paused) el.pause();
      // Pre-roll upcoming clips to their in-point so they start without a hitch.
      if (t < clip.start && !el.seeking && el.readyState >= 1 && Math.abs(el.currentTime - clip.in) > 0.05) {
        el.currentTime = clip.in;
      }
      continue;
    }

    const src = clip.in + (t - clip.start) * speed;
    if (el.playbackRate !== speed) el.playbackRate = speed;
    const track = getTrack(clip.trackId);
    const vol = (track && track.muted ? 0 : 1) * (clip.props.volume / 100) * fadeFactor(clip, t);
    if (rec.gain) rec.gain.gain.value = vol;
    else el.volume = clamp(vol, 0, 1);

    if (playing) {
      if (el.paused) {
        if (Math.abs(el.currentTime - src) > 0.05) el.currentTime = src;
        el.play().catch(() => {});
      } else if (Math.abs(el.currentTime - src) > 0.3) {
        el.currentTime = src;
      }
    } else {
      if (!el.paused) el.pause();
      if (!el.seeking && Math.abs(el.currentTime - src) > 0.02) el.currentTime = src;
    }
  }
  for (const id of pool.keys()) if (!alive.has(id)) poolDrop(id);
}

/* ---------- compositor ---------- */
let dirty = true;
function markDirty() { dirty = true; }

function filterString(p) {
  const f = [];
  if (p.brightness !== 100) f.push(`brightness(${p.brightness / 100})`);
  if (p.contrast !== 100) f.push(`contrast(${p.contrast / 100})`);
  if (p.saturation !== 100) f.push(`saturate(${p.saturation / 100})`);
  if (p.hue) f.push(`hue-rotate(${p.hue}deg)`);
  if (p.blur > 0) f.push(`blur(${p.blur}px)`);
  return f.join(' ');
}

function drawFrame() {
  const { width: W, height: H, bg } = state.settings;
  if (preview.width !== W) preview.width = W;
  if (preview.height !== H) preview.height = H;
  const t = state.playhead;
  pctx.save();
  pctx.fillStyle = bg;
  pctx.fillRect(0, 0, W, H);
  pctx.restore();
  const guides = !state.playing && !state.exporting;
  // V1 is the bottom layer; higher tracks composite on top.
  for (const track of videoTracks()) {
    if (track.hidden) continue;
    const clips = state.clips
      .filter((c) => c.trackId === track.id && t >= c.start && t < clipEnd(c))
      .sort((a, b) => a.start - b.start);
    for (const clip of clips) drawClip(clip, t, W, H, guides && state.selection.has(clip.id));
  }
}

function drawOffline(W, H) {
  pctx.save();
  pctx.fillStyle = '#5a1418';
  pctx.fillRect(0, 0, W, H);
  pctx.fillStyle = '#ff9a9a';
  pctx.font = `700 ${Math.round(H * 0.06)}px system-ui, sans-serif`;
  pctx.textAlign = 'center';
  pctx.textBaseline = 'middle';
  pctx.fillText('MEDIA OFFLINE', W / 2, H / 2);
  pctx.restore();
}

function drawClip(clip, t, W, H, outline) {
  const p = clip.props;
  let source = null, sw = 0, sh = 0;
  if (clip.type === 'video') {
    const m = getMedia(clip.mediaId);
    if (!m || !m.url) return drawOffline(W, H);
    const rec = pool.get(clip.id);
    if (!rec || rec.el.readyState < 2 || !rec.el.videoWidth) return;
    source = rec.el; sw = rec.el.videoWidth; sh = rec.el.videoHeight;
  } else if (clip.type === 'image') {
    const m = getMedia(clip.mediaId);
    if (!m || !m.img) return drawOffline(W, H);
    source = m.img; sw = m.width; sh = m.height;
  } else if (clip.type !== 'text') {
    return;
  }

  const ctx = pctx;
  ctx.save();
  ctx.globalAlpha = clamp((p.opacity / 100) * fadeFactor(clip, t), 0, 1);
  ctx.filter = filterString(p) || 'none';
  ctx.translate(W / 2 + p.x, H / 2 + p.y);
  ctx.rotate((p.rotation * Math.PI) / 180);
  const s = Math.max(0.001, p.scale / 100);
  ctx.scale(s, s);
  let bw, bh;
  if (source) {
    const fit = Math.min(W / sw, H / sh);   // "fit to frame", letterboxed
    bw = sw * fit; bh = sh * fit;
    ctx.drawImage(source, -bw / 2, -bh / 2, bw, bh);
  } else {
    [bw, bh] = drawText(ctx, p);
  }
  if (outline) {
    ctx.filter = 'none';
    ctx.globalAlpha = 1;
    ctx.shadowColor = 'transparent';
    ctx.lineWidth = 2 / s;
    ctx.setLineDash([8 / s, 6 / s]);
    ctx.strokeStyle = '#4da3ff';
    ctx.strokeRect(-bw / 2, -bh / 2, bw, bh);
  }
  ctx.restore();
}

function drawText(ctx, p) {
  const lines = String(p.text || '').split('\n');
  const size = p.fontSize;
  ctx.font = `${p.bold ? 700 : 400} ${size}px ${p.font}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lh = size * 1.2;
  const tw = Math.max(1, ...lines.map((l) => ctx.measureText(l).width));
  const th = lh * lines.length;
  const pad = size * 0.35;
  const boxW = tw + pad * 2, boxH = th + pad * 1.2;
  if (p.bg) {
    ctx.save();
    ctx.globalAlpha *= p.bgOpacity / 100;
    ctx.fillStyle = p.bgColor;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(-boxW / 2, -boxH / 2, boxW, boxH, pad * 0.5);
    else ctx.rect(-boxW / 2, -boxH / 2, boxW, boxH);
    ctx.fill();
    ctx.restore();
  }
  ctx.save();
  if (p.shadow) {
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = size * 0.12;
    ctx.shadowOffsetY = size * 0.04;
  }
  ctx.fillStyle = p.color;
  lines.forEach((l, i) => ctx.fillText(l, 0, -th / 2 + lh * (i + 0.5)));
  ctx.restore();
  return [boxW, boxH];
}

/* ---------- transport ---------- */
let lastTs = 0;

function play() {
  if (state.playing) return;
  const d = seqDuration();
  if (d <= 0) return;
  if (state.playhead >= d - EPS) state.playhead = 0;
  state.playing = true;
  lastTs = performance.now();
  resumeAudio();
  updateTransportUI();
}

function pause() {
  if (!state.playing) return;
  state.playing = false;
  for (const r of pool.values()) r.el.pause();
  markDirty();
  updateTransportUI();
}

function togglePlay() { state.playing ? pause() : play(); }

function setPlayhead(t) {
  state.playhead = Math.max(0, t);
  markDirty();
}

function frameLoop(ts) {
  if (state.playing) {
    const dt = Math.min(0.25, (ts - lastTs) / 1000);
    lastTs = ts;
    state.playhead += dt;
    const d = seqDuration();
    if (state.playhead >= d) {
      state.playhead = d;
      pause();
    }
    dirty = true;
  }
  syncMedia();
  if (dirty) {
    dirty = false;
    drawFrame();
    updatePlayheadUI();
  }
  requestAnimationFrame(frameLoop);
}

/** Wait until every clip active at time t has a decoded frame ready. */
async function prerollAt(t) {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    syncMedia();
    const pending = state.clips
      .filter((c) => (c.type === 'video' || c.type === 'audio') && t >= c.start && t < clipEnd(c))
      .map((c) => pool.get(c.id))
      .filter((r) => r && (r.el.readyState < 2 || r.el.seeking));
    if (!pending.length) break;
    await sleep(50);
  }
  drawFrame();
}
