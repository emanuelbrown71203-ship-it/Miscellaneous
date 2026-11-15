'use strict';
/* Small DOM + math helpers shared by every module. */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const EPS = 1e-4;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let _uidCounter = 0;
function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}${(_uidCounter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Tiny hyperscript: h('div', {class: 'x', onclick: fn}, child, 'text') */
function h(tag, attrs, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (typeof v !== 'string' && k in e) e[k] = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return e;
}

function timecode(t, fps) {
  t = Math.max(0, t || 0);
  const total = Math.floor(t * fps + 1e-6);
  const f = total % fps;
  const s = Math.floor(total / fps);
  const parts = [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60, f];
  return parts.map((n) => String(n).padStart(2, '0')).join(':');
}

function shortDur(t) {
  if (!isFinite(t) || t <= 0) return '';
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function safeName(s) {
  return String(s || '').replace(/[^\w\- ]+/g, '').trim() || 'sequence';
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

let _toastTimer = 0;
function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `show ${kind}`;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { t.className = ''; }, 2800);
}

/** Resolve when `ev` fires on target; reject on 'error' or timeout. */
function waitEvent(target, ev, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      target.removeEventListener(ev, onOk);
      target.removeEventListener('error', onErr);
    };
    const onOk = () => { cleanup(); resolve(); };
    const onErr = () => { cleanup(); reject(new Error(`${ev} failed`)); };
    const timer = setTimeout(() => { cleanup(); reject(new Error(`timeout waiting for ${ev}`)); }, timeout);
    target.addEventListener(ev, onOk);
    target.addEventListener('error', onErr);
  });
}

/* Inline SVG icon set (24x24 stroke icons). */
const ICONS = {
  play: '<path d="M7 4v16l13-8z" fill="currentColor" stroke="none"/>',
  pause: '<rect x="6" y="4" width="4" height="16" fill="currentColor" stroke="none"/><rect x="14" y="4" width="4" height="16" fill="currentColor" stroke="none"/>',
  stepBack: '<path d="M17 5v14l-9-7z" fill="currentColor" stroke="none"/><path d="M6 5v14"/>',
  stepFwd: '<path d="M7 5v14l9-7z" fill="currentColor" stroke="none"/><path d="M18 5v14"/>',
  toStart: '<path d="M4 5v14"/><path d="M13 5v14l-8-7zM21 5v14l-8-7z" fill="currentColor" stroke="none"/>',
  toEnd: '<path d="M20 5v14"/><path d="M11 5v14l8-7zM3 5v14l8-7z" fill="currentColor" stroke="none"/>',
  eye: '<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><path d="M3 3l18 18"/>',
  volume: '<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16.5 9a4 4 0 0 1 0 6"/>',
  mute: '<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M17 9l5 6M22 9l-5 6"/>',
  cursor: '<path d="M5 3l14 8-6 2-3 6z"/>',
  razor: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4L8.1 15.9M14.5 14.5L20 20M8.1 8.1L12 12"/>',
  magnet: '<path d="M6 3v8a6 6 0 0 0 12 0V3"/><path d="M6 7h4M14 7h4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>',
  fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  text: '<path d="M4 7V4h16v3M12 4v16M9 20h6"/>',
  import: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
  export: '<path d="M12 15V3M7 8l5-5 5 5M5 21h14"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/>',
  split: '<path d="M12 3v18"/><path d="M6 8l-3 4 3 4M18 8l3 4-3 4"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  save: '<path d="M5 3h11l3 3v15H5z"/><path d="M8 3v5h8V3M8 21v-7h8v7"/>',
  file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>',
  keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
  fullscreen: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
};

function icon(name, size = 16) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}
