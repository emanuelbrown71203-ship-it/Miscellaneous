"use strict";
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const COLORS = { audio: "#4cc9f0", chat: "#b98cff", kills: "#ff5a6e", motion: "#7be495" };
const NAMES = { audio: "Loudness", chat: "Chat", kills: "Kill feed", motion: "Action" };
const PW = 540, PH = 960;

const S = { cfg: null, pid: null, p: null, sig: null, sel: null, editorFor: null, words: [], wordsFor: "",
            t: 0, mode: "cam", frameT: 0, poll: null, lastStatus: null, drag: null };

async function api(method, url, body) {
  const opt = { method, headers: {} };
  if (body instanceof FormData) opt.body = body;
  else if (body !== undefined) { opt.body = JSON.stringify(body); opt.headers["Content-Type"] = "application/json"; }
  const r = await fetch(url, opt);
  if (!r.ok) {
    let msg = `Request failed (${r.status})`;
    try { msg = (await r.json()).detail || msg; } catch (e) { /* not JSON */ }
    throw new Error(typeof msg === "string" ? msg : "Request failed");
  }
  return r.json();
}

function clock(t, tenths) {
  t = Math.max(0, t || 0);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const ss = tenths ? s.toFixed(1).padStart(4, "0") : String(Math.floor(s)).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
function parseClock(v) {
  v = (v || "").trim();
  if (!v) return null;
  const parts = v.split(":").map(Number);
  if (parts.some(isNaN)) return NaN;
  return parts.reduce((a, b) => a * 60 + b, 0);
}
function debounce(fn, ms) { let h; return (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); }; }

/* ---------- home ---------- */

let DROP_HINT = "Drop a video here, or click to choose one. MP4, MKV, MOV.";

function homeSettings() {
  const s = { game: $("game").value };
  const a = parseClock($("sec-start").value), b = parseClock($("sec-end").value);
  if (Number.isNaN(a) || Number.isNaN(b)) throw new Error("Write times like 1:23:45.");
  if (a !== null || b !== null) {
    if (b === null) throw new Error("Give an end time for the part you want analysed.");
    if (b <= (a || 0)) throw new Error("The end time has to be after the start time.");
    s.section = [a || 0, b];
  }
  return s;
}
function homeError(msg) { $("home-error").textContent = msg || ""; $("home-error").hidden = !msg; }

async function showHome() {
  clearInterval(S.poll);
  S.pid = null; S.p = null;
  $("src").pause();
  $("project").hidden = true; $("home").hidden = false; $("crumbs").textContent = "";
  const rows = await api("GET", "/api/projects");
  $("recent").hidden = !rows.length;
  $("project-list").innerHTML = rows.map((r) => {
    const state = r.status === "ready" ? `${r.clips} clip${r.clips === 1 ? "" : "s"}`
      : r.status === "error" ? "Failed" : `${r.stage} ${Math.round((r.progress || 0) * 100)}%`;
    const busy = r.status === "queued" || r.status === "working";
    return `<li><a href="#/p/${r.id}"><b>${esc(r.title)}</b><span>${r.duration ? clock(r.duration) : ""}</span><span>${esc(state)}</span></a>
      <button class="link danger" data-del="${r.id}" ${busy ? "disabled" : ""}>Delete</button></li>`;
  }).join("");
}

$("project-list").addEventListener("click", async (e) => {
  const id = e.target.dataset.del;
  if (!id || !confirm("Delete this video and its rendered clips?")) return;
  try { await api("DELETE", `/api/projects/${id}`); showHome(); } catch (err) { homeError(err.message); }
});

$("url-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  homeError("");
  try {
    const p = await api("POST", "/api/projects", { url: $("url").value, settings: homeSettings() });
    $("url").value = "";
    location.hash = `#/p/${p.id}`;
  } catch (err) { homeError(err.message); }
});

async function uploadFile(file) {
  homeError("");
  try {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("settings", JSON.stringify(homeSettings()));
    if ($("chat-file").files[0]) fd.append("chat", $("chat-file").files[0]);
    $("drop-hint").textContent = `Copying ${file.name}…`;
    const p = await api("POST", "/api/projects/upload", fd);
    location.hash = `#/p/${p.id}`;
  } catch (err) { homeError(err.message); }
  $("drop-hint").textContent = DROP_HINT;
}
const drop = $("drop");
drop.addEventListener("click", () => $("file").click());
drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("file").click(); } });
$("file").addEventListener("change", (e) => { if (e.target.files[0]) uploadFile(e.target.files[0]); e.target.value = ""; });
["dragenter", "dragover"].forEach((n) => drop.addEventListener(n, (e) => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach((n) => drop.addEventListener(n, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", (e) => { if (e.dataTransfer.files[0]) uploadFile(e.dataTransfer.files[0]); });

/* ---------- project ---------- */

const busy = () => S.p && (S.p.status === "queued" || S.p.status === "working");
const rendering = () => S.p && S.p.clips.some((c) => ["queued", "working"].includes(c.render.status));
const clip = () => S.p && S.p.clips.find((c) => c.id === S.sel);

async function openProject(pid) {
  clearInterval(S.poll);
  Object.assign(S, { pid, p: null, sig: null, sel: null, editorFor: null, t: 0, lastStatus: null, frameT: 0, wordsFor: "" });
  $("home").hidden = true; $("project").hidden = false; $("setup").hidden = true;
  $("project").dataset.pane = "clips";
  $("src").removeAttribute("src");
  try { await refresh(); } catch (err) { location.hash = ""; return; }
  S.poll = setInterval(() => { if (busy() || rendering()) refresh().catch(() => {}); }, 1000);
}

async function refresh() {
  const p = await api("GET", `/api/projects/${S.pid}`);
  if (p.id !== S.pid) return;
  const was = S.lastStatus;
  S.p = p; S.lastStatus = p.status;
  if (p.info && p.file && !$("src").getAttribute("src")) $("src").src = `/api/projects/${p.id}/video`;
  if (p.status === "ready" && (was !== "ready" || !S.sig)) {
    S.sig = await api("GET", `/api/projects/${p.id}/signals`);
    if (!clip()) { S.sel = p.clips[0] ? p.clips[0].id : null; S.editorFor = null; if (clip()) seek(clip().start); }
    if (!S.frameT && p.info) { S.frameT = Math.round(p.info.duration / 2); loadFrame(); }
    fillSetup();
  }
  paint();
}

function paint() {
  const p = S.p;
  $("crumbs").textContent = p.title;
  $("p-title").textContent = p.title;
  const bits = [];
  if (p.info) bits.push(clock(p.info.duration) + " long");
  if (p.chat_count) bits.push(`${p.chat_count.toLocaleString()} chat messages`);
  if (p.meta && p.meta.uploader) bits.push(p.meta.uploader);
  $("p-sub").textContent = bits.join(", ");
  $("working").hidden = !busy();
  $("stage").textContent = p.stage;
  $("pct").textContent = `${Math.round((p.progress || 0) * 100)}%`;
  $("meter-fill").style.width = `${(p.progress || 0) * 100}%`;
  $("p-error").hidden = p.status !== "error";
  $("p-error").textContent = p.status === "error" ? `Analysis failed: ${p.message}` : "";
  $("warnings").innerHTML = (p.warnings || []).map((w) => `<li>${esc(w)}</li>`).join("");
  $("btn-render-all").disabled = busy() || !p.clips.length;
  $("btn-setup").disabled = !p.info;
  ["btn-repick", "btn-reanalyze"].forEach((id) => { $(id).disabled = busy(); });

  const has = p.has || {};
  $("legend").innerHTML = Object.keys(NAMES).map((k) =>
    `<span class="${has[k] ? "" : "off"}" title="${has[k] ? "" : "No data for this signal in this video"}"><i style="background:${COLORS[k]}"></i>${NAMES[k]}</span>`
  ).join("") + `<span><i style="background:#ffc53d"></i>Combined hype</span>`;

  $("clips-h").textContent = p.clips.length ? `${p.clips.length} clip${p.clips.length === 1 ? "" : "s"}, best first` : "Clips";
  $("clip-list").innerHTML = p.clips.map((c) => {
    const tags = c.tags.map((t) => `<span class="tag ${tagClass(t)}">${esc(t)}</span>`).join("");
    const r = c.render.status;
    const state = r === "done" ? `<span class="tag done">Rendered</span>`
      : r === "working" ? `<span class="tag">Rendering ${Math.round(c.render.progress * 100)}%</span>`
      : r === "queued" ? `<span class="tag">Waiting to render</span>`
      : r === "error" ? `<span class="tag k">Render failed</span>` : "";
    return `<li><button class="clip ${c.id === S.sel ? "on" : ""}" data-id="${c.id}">
      <span class="score">${c.manual ? "+" : c.score}<small>${c.manual ? "yours" : "hype"}</small></span>
      <span><b>${esc(c.title)}</b><span class="meta">${clock(c.start)} to ${clock(c.end)}, ${Math.round(c.end - c.start)}s</span>
      <span class="tags">${tags}${state}</span></span></button></li>`;
  }).join("");
  const empty = !p.clips.length && !busy();
  $("clips-empty").hidden = !empty;
  if (empty) $("clips-empty").textContent = p.status === "error" ? "Fix the problem above, then analyse the video again from Set up detection."
    : "Nothing stood out in this video. Lower the shortest clip length or raise a signal's weight in Set up detection, or click the timeline and add a clip yourself.";
  paintEditor();
  drawTimeline();
}

function tagClass(t) {
  if (/kill|ace|streak/i.test(t)) return "k";
  if (/chat/i.test(t)) return "c";
  if (/loud|hyped/i.test(t)) return "a";
  if (/action/i.test(t)) return "m";
  return "";
}

$("clip-list").addEventListener("click", (e) => {
  const b = e.target.closest(".clip");
  if (b) selectClip(b.dataset.id);
});

function setPane(pane) { $("project").dataset.pane = pane; if (pane === "edit" && matchMedia("(max-width: 700px)").matches) window.scrollTo(0, 0); else drawTimeline(); }
$("btn-back").addEventListener("click", () => { $("src").pause(); setPane("clips"); });

function selectClip(id) {
  S.sel = id; S.editorFor = null;
  setPane("edit");
  const c = clip();
  if (c) seek(c.start);
  paint();
}

function seek(t) {
  S.t = t;
  const v = $("src");
  if (v.readyState >= 1) v.currentTime = t; else v.addEventListener("loadedmetadata", () => { v.currentTime = t; }, { once: true });
  drawTimeline();
}

/* ---------- editor ---------- */

function paintEditor() {
  const c = clip();
  $("editor").hidden = !c;
  if (!c) return;
  const st = c.style;
  if (S.editorFor !== c.id) {            // fill inputs only on selection, so polling never fights typing
    S.editorFor = c.id;
    $("c-title").value = c.title;
    $("c-cam").value = st.cam_ratio; $("c-zoom").value = st.zoom; $("c-focus").value = st.focus_x;
    $("c-caps").checked = !!st.captions; $("c-showtitle").checked = !!st.show_title;
    $("c-result").hidden = true; $("c-result").removeAttribute("src");
    loadWords(c);
  }
  [...$("c-layout").children].forEach((b) => b.classList.toggle("on", b.dataset.v === st.layout));
  const noCam = st.layout === "split" && !S.p.facecam;
  $("layout-note").textContent = noCam ? "No facecam found, so this renders as Blurred fill. Mark your facecam in Set up detection to use this layout." : "";
  $("row-cam").hidden = st.layout !== "split" || noCam;
  $("row-zoom").hidden = !(st.layout === "blur" || noCam);
  $("c-start").textContent = clock(c.start, true);
  $("c-end").textContent = `${clock(c.end, true)} (${Math.round(c.end - c.start)}s)`;
  const why = [];
  if (c.ai) why.push(c.ai.reason);
  if (c.transcript) why.push(`“${c.transcript.length > 180 ? c.transcript.slice(0, 180) + "…" : c.transcript}”`);
  $("c-why").textContent = why.join(" ");
  const r = c.render;
  const active = r.status === "queued" || r.status === "working";
  $("c-render").disabled = active;
  $("c-render").textContent = active ? (r.status === "queued" ? "Waiting to render" : `Rendering ${Math.round(r.progress * 100)}%`)
    : r.status === "done" ? "Render again" : "Render this clip";
  $("c-progress").hidden = !active;
  $("c-progress").firstElementChild.style.width = `${(r.progress || 0) * 100}%`;
  $("c-error").hidden = r.status !== "error";
  $("c-error").textContent = r.status === "error" ? r.message : "";
  const done = r.status === "done";
  $("c-download").hidden = !done;
  if (done) {
    const url = `/api/projects/${S.pid}/clips/${c.id}/file`;
    $("c-download").href = `${url}?download=1`;
    const v = $("c-result"), want = `${url}?v=${Math.round(r.at || 0)}`;
    if (v.getAttribute("src") !== want) { v.src = want; v.hidden = false; }
  }
}

async function loadWords(c) {
  const key = `${c.id}:${c.start}:${c.end}`;
  S.wordsFor = key;
  try {
    const w = await api("GET", `/api/projects/${S.pid}/words?start=${c.start}&end=${c.end}`);
    if (S.wordsFor === key) S.words = chunkWords(w);
  } catch (e) { S.words = []; }
}
function chunkWords(words) {            // mirrors captions.py
  const chunks = []; let cur = [];
  for (const w of words) {
    if (cur.length) {
      const chars = cur.reduce((n, x) => n + x[2].length, 0) + cur.length + w[2].length;
      if (cur.length >= 3 || chars > 16 || w[0] - cur[cur.length - 1][1] > 0.6) { chunks.push(cur); cur = []; }
    }
    cur.push(w);
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

const pushClip = debounce(async (id, body) => {
  try {
    const c = await api("PATCH", `/api/projects/${S.pid}/clips/${id}`, body);
    const i = S.p.clips.findIndex((x) => x.id === id);
    if (i >= 0) { S.p.clips[i] = c; paint(); if (body.start !== undefined || body.end !== undefined) loadWords(c); }
  } catch (err) { $("c-error").hidden = false; $("c-error").textContent = err.message; }
}, 250);

function setStyle(patch) {
  const c = clip(); if (!c) return;
  Object.assign(c.style, patch);
  pushClip(c.id, { style: c.style });
  paintEditor();
}
$("c-layout").addEventListener("click", (e) => { if (e.target.dataset.v) setStyle({ layout: e.target.dataset.v }); });
$("c-cam").addEventListener("input", (e) => setStyle({ cam_ratio: +e.target.value }));
$("c-zoom").addEventListener("input", (e) => setStyle({ zoom: +e.target.value }));
$("c-focus").addEventListener("input", (e) => setStyle({ focus_x: +e.target.value }));
$("c-caps").addEventListener("change", (e) => setStyle({ captions: e.target.checked }));
$("c-showtitle").addEventListener("change", (e) => setStyle({ show_title: e.target.checked }));
$("c-title").addEventListener("input", (e) => { const c = clip(); if (c) { c.title = e.target.value; pushClip(c.id, { title: c.title, style: c.style }); } });

document.querySelector(".trim").addEventListener("click", (e) => {
  const b = e.target.closest("button"), c = clip();
  if (!b || !c) return;
  const edge = b.dataset.edge, dur = S.p.info.duration;
  let v = b.dataset.d === "here" ? $("src").currentTime : c[edge] + Number(b.dataset.d);
  if (edge === "start") c.start = Math.min(Math.max(0, v), c.end - 1);
  else c.end = Math.max(Math.min(dur, v), c.start + 1);
  pushClip(c.id, { start: c.start, end: c.end, style: c.style });
  if (edge === "start") seek(c.start);
  paint();
});

$("c-render").addEventListener("click", async () => {
  const c = clip(); if (!c) return;
  try { await api("POST", `/api/projects/${S.pid}/clips/${c.id}/render`); await refresh(); }
  catch (err) { $("c-error").hidden = false; $("c-error").textContent = err.message; }
});
$("c-delete").addEventListener("click", async () => {
  const c = clip(); if (!c) return;
  await api("DELETE", `/api/projects/${S.pid}/clips/${c.id}`);
  S.sel = null; setPane("clips"); await refresh();
});
$("btn-render-all").addEventListener("click", async () => { await api("POST", `/api/projects/${S.pid}/render-all`); refresh(); });
$("btn-add-clip").addEventListener("click", async () => {
  const c = await api("POST", `/api/projects/${S.pid}/clips`, { start: Math.max(0, S.t - 10), end: S.t + 10 });
  await refresh(); selectClip(c.id);
});

/* ---------- live preview ---------- */

const pv = $("pv").getContext("2d");
function drawPreview() {
  requestAnimationFrame(drawPreview);
  const c = clip(), v = $("src");
  if (!c || $("project").hidden) return;
  if (!v.paused && (v.currentTime >= c.end || v.currentTime < c.start - 0.5)) v.currentTime = c.start;
  if (Math.abs(v.currentTime - S.t) > 0.25) { S.t = v.currentTime; drawTimeline(); }
  const vw = v.videoWidth, vh = v.videoHeight;
  pv.fillStyle = "#000"; pv.fillRect(0, 0, PW, PH);
  if (!vw) return;
  const st = c.style, fx = st.focus_x, cam = S.p.facecam;
  const layout = st.layout === "split" && !cam ? "blur" : st.layout;
  const cover = (dx, dy, dw, dh) => {
    const s = Math.max(dw / vw, dh / vh), sw = dw / s, sh = dh / s;
    pv.drawImage(v, (vw - sw) * fx, (vh - sh) / 2, sw, sh, dx, dy, dw, dh);
  };
  let capY = PH * 0.72;
  if (layout === "crop") cover(0, 0, PW, PH);
  else if (layout === "split") {
    const camH = Math.round(PH * st.cam_ratio);
    let [bx, by, bw, bh] = [cam[0] * vw, cam[1] * vh, cam[2] * vw, cam[3] * vh];
    const s = Math.max(PW / bw, camH / bh), sw = PW / s, sh = camH / s;
    pv.drawImage(v, bx + (bw - sw) / 2, by + (bh - sh) / 2, sw, sh, 0, 0, PW, camH);
    cover(0, camH, PW, PH - camH);
    capY = camH;
  } else {
    pv.filter = "blur(14px) brightness(0.75)";
    const s = Math.max(PW / vw, PH / vh);
    pv.drawImage(v, (vw - PW / s) / 2, (vh - PH / s) / 2, PW / s, PH / s, -20, -20, PW + 40, PH + 40);
    pv.filter = "none";
    const fs = (PW * st.zoom) / vw, dh = vh * fs, sw = PW / fs;
    pv.drawImage(v, (vw - sw) * fx, 0, sw, vh, 0, (PH - dh) / 2, PW, dh);
  }
  const t = v.currentTime;
  if (st.show_title && c.title && t - c.start < 3 && t >= c.start) {
    pv.font = "32px Anton, Impact, sans-serif"; pv.textAlign = "center"; pv.textBaseline = "middle";
    const text = st.caption_case === "upper" ? c.title.toUpperCase() : c.title;
    const w = Math.min(pv.measureText(text).width + 28, PW - 20);
    const ty = layout === "split" ? capY + 75 : 105;
    pv.fillStyle = "#ffc53d"; pv.fillRect((PW - w) / 2, ty - 23, w, 46);
    pv.fillStyle = "#141414"; pv.fillText(text, PW / 2, ty + 1, PW - 40);
  }
  if (st.captions && S.words.length) {
    const i = S.words.findIndex((ch, k) => {
      const next = S.words[k + 1] ? S.words[k + 1][0][0] : c.end;
      return t >= ch[0][0] && t < Math.min(ch[ch.length - 1][1] + 0.35, next);
    });
    if (i >= 0) {
      const ch = S.words[i], up = st.caption_case === "upper";
      const texts = ch.map((w) => { const x = w[2].replace(/[,.;:]+$/, ""); return up ? x.toUpperCase() : x; });
      pv.font = "52px Anton, Impact, sans-serif"; pv.textAlign = "left"; pv.textBaseline = "middle";
      const gap = pv.measureText(" ").width, widths = texts.map((x) => pv.measureText(x).width);
      let x = (PW - widths.reduce((a, b) => a + b, 0) - gap * (texts.length - 1)) / 2;
      let cur = 0; ch.forEach((w, k) => { if (t >= w[0]) cur = k; });
      pv.lineJoin = "round"; pv.lineWidth = 8; pv.strokeStyle = "#000";
      texts.forEach((txt, k) => {
        pv.strokeText(txt, x, capY); pv.fillStyle = k === cur ? "#ffc53d" : "#fff"; pv.fillText(txt, x, capY);
        x += widths[k] + gap;
      });
    }
  }
}
requestAnimationFrame(drawPreview);

$("pv-play").addEventListener("click", () => {
  const v = $("src"), c = clip(); if (!c) return;
  if (v.paused) { if (v.currentTime < c.start || v.currentTime >= c.end - 0.2) v.currentTime = c.start; v.play().catch(() => {}); }
  else v.pause();
});
$("src").addEventListener("play", () => { $("pv-play").textContent = "Pause"; });
$("src").addEventListener("pause", () => { $("pv-play").textContent = "Play"; });
$("src").addEventListener("error", () => {
  if (!$("src").getAttribute("src")) return;
  $("pv-note").hidden = false;
  $("pv-note").textContent = "Your browser can't play this file format, so there's no live preview. Rendering still works.";
});
$("src").addEventListener("loadeddata", () => { $("pv-note").hidden = true; });

/* ---------- timeline ---------- */

function drawTimeline() {
  const cv = $("tl"), sig = S.sig, p = S.p;
  const dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = 190;
  if (!W) return;
  if (cv.width !== W * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
  const g = cv.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  const dur = p && p.info ? p.info.duration : 0;
  if (!dur) return;
  const X = (t) => (t / dur) * W;
  const lanes = ["audio", "chat", "kills", "motion"], laneH = 24, top = 18, combY = top + lanes.length * laneH + 8, combH = H - combY - 16;

  if (p.clips) p.clips.forEach((c, i) => {      // clip bands sit behind the curves
    const on = c.id === S.sel;
    g.fillStyle = on ? "rgba(255,197,61,.30)" : "rgba(255,197,61,.12)";
    g.fillRect(X(c.start), top - 2, Math.max(2, X(c.end) - X(c.start)), H - top - 12);
    g.fillStyle = on ? "#ffc53d" : "#a2a4cc"; g.font = "600 11px Saira, sans-serif"; g.textAlign = "center";
    g.fillText(String(i + 1), (X(c.start) + X(c.end)) / 2, 11);
  });
  if (sig && sig.signals) {
    const area = (arr, y0, h, color, max) => {
      if (!arr || !arr.length) return;
      const m = max || Math.max(...arr, 1e-6);
      g.beginPath(); g.moveTo(0, y0 + h);
      arr.forEach((v, i) => g.lineTo((i / (arr.length - 1 || 1)) * W, y0 + h - Math.min(v / m, 1) * h));
      g.lineTo(W, y0 + h); g.closePath(); g.fillStyle = color; g.fill();
    };
    lanes.forEach((k, i) => {
      const y = top + i * laneH;
      g.fillStyle = "rgba(255,255,255,.035)"; g.fillRect(0, y, W, laneH - 4);
      if (k === "kills") {
        g.fillStyle = COLORS.kills;
        (sig.events || []).forEach((e) => g.fillRect(X(e.t) - 1, y + 2, 2.5, laneH - 8));
      } else area(sig.signals[k], y, laneH - 4, COLORS[k], 6);
    });
    area(sig.combined, combY, combH, "#ffc53d");
  }
  g.fillStyle = "#a2a4cc"; g.font = "11px Saira, sans-serif";
  const step = [15, 30, 60, 120, 300, 600, 1200, 1800, 3600].find((s) => dur / s <= W / 90) || 7200;
  for (let t = 0; t <= dur; t += step) { if (X(t) > W - 24) break; g.textAlign = t === 0 ? "left" : "center"; g.fillText(clock(t), X(t), H - 3); }
  g.fillStyle = "#fff"; g.fillRect(X(S.t) - 0.75, top - 4, 1.5, H - top - 10);
  $("tl-time").textContent = `Playhead ${clock(S.t)}`;
}
$("tl").addEventListener("click", (e) => {
  if (!S.p || !S.p.info) return;
  const r = e.target.getBoundingClientRect(), t = ((e.clientX - r.left) / r.width) * S.p.info.duration;
  const hit = S.p.clips.find((c) => t >= c.start && t <= c.end);
  if (hit && hit.id !== S.sel) { S.sel = hit.id; S.editorFor = null; setPane("edit"); }
  seek(t); paint();
});
window.addEventListener("resize", drawTimeline);

/* ---------- detection setup ---------- */

const MODE_HELP = {
  cam: "Drag around your webcam so the facecam layout crops it correctly. Applies right away.",
  kill: "Drag around the kill feed. Clutch counts each new row that appears there. Analyse the video again to apply.",
  marker: "Scrub to a frame showing something that only appears on a highlight (an elimination banner, a victory screen), then drag a tight box around it. Analyse the video again to find every time it shows up.",
};
$("btn-setup").addEventListener("click", () => { $("setup").hidden = !$("setup").hidden; if (!$("setup").hidden) { fillSetup(); loadFrame(); } });
$("draw-mode").addEventListener("click", (e) => {
  if (!e.target.dataset.mode) return;
  S.mode = e.target.dataset.mode;
  [...$("draw-mode").children].forEach((b) => b.classList.toggle("on", b === e.target));
  $("mode-help").textContent = MODE_HELP[S.mode];
});

function loadFrame() {
  if (!S.p || !S.p.info) return;
  $("frame-time").max = Math.floor(S.p.info.duration);
  $("frame-time").value = S.frameT;
  $("frame-img").src = `/api/projects/${S.pid}/frame?t=${S.frameT}&w=960`;
}
$("frame-time").addEventListener("input", debounce((e) => { S.frameT = +e.target.value; loadFrame(); }, 150));

function placeBox(el, box) {
  el.hidden = !box; if (!box) return;
  el.style.left = `${box[0] * 100}%`; el.style.top = `${box[1] * 100}%`;
  el.style.width = `${box[2] * 100}%`; el.style.height = `${box[3] * 100}%`;
}
function killZone() {
  const s = S.p.settings;
  return s.kill_zone || (S.cfg.games[s.game] || {}).kill_zone || null;
}
function fillSetup() {
  const p = S.p; if (!p) return;
  placeBox($("box-cam"), p.facecam);
  placeBox($("box-kill"), killZone());
  $("mode-help").textContent = MODE_HELP[S.mode];
  $("marker-list").innerHTML = p.markers.map((m) => `<li>${esc(m.name)}<button data-mid="${m.id}" aria-label="Remove ${esc(m.name)}">×</button></li>`).join("");
  const w = p.settings.weights;
  $("weights").innerHTML = Object.keys(NAMES).map((k) =>
    `<label for="w-${k}"><i style="background:${COLORS[k]}"></i>${NAMES[k]}</label><input id="w-${k}" data-k="${k}" type="range" min="0" max="2" step="0.1" value="${w[k]}"><output>${(+w[k]).toFixed(1)}</output>`).join("");
  $("min-len").value = p.settings.min_len; $("max-len").value = p.settings.max_len; $("max-clips").value = p.settings.max_clips;
}
const note = (msg) => { $("setup-note").textContent = msg; };

const wrap = $("frame-wrap");
const rel = (e) => { const r = wrap.getBoundingClientRect(); return [Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1), Math.min(Math.max((e.clientY - r.top) / r.height, 0), 1)]; };
wrap.addEventListener("pointerdown", (e) => { S.drag = rel(e); wrap.setPointerCapture(e.pointerId); });
wrap.addEventListener("pointermove", (e) => {
  if (!S.drag) return;
  const [x, y] = rel(e), [x0, y0] = S.drag;
  placeBox($("box-draw"), [Math.min(x, x0), Math.min(y, y0), Math.abs(x - x0), Math.abs(y - y0)]);
});
wrap.addEventListener("pointerup", async (e) => {
  if (!S.drag) return;
  const [x, y] = rel(e), [x0, y0] = S.drag;
  S.drag = null; $("box-draw").hidden = true;
  const box = [Math.min(x, x0), Math.min(y, y0), Math.abs(x - x0), Math.abs(y - y0)].map((v) => +v.toFixed(4));
  if (box[2] < 0.02 || box[3] < 0.02) return;
  try {
    if (S.mode === "cam") { S.p = await api("PATCH", `/api/projects/${S.pid}`, { facecam: box }); note("Facecam saved."); }
    else if (S.mode === "kill") { S.p = await api("PATCH", `/api/projects/${S.pid}`, { settings: { kill_zone: box } }); note("Kill-feed zone saved. Analyse the video again to use it."); }
    else {
      const name = prompt("Name this event (for example: Elimination, Victory)", "Elimination");
      if (!name) return;
      await api("POST", `/api/projects/${S.pid}/markers`, { name, t: S.frameT, box });
      S.p = await api("GET", `/api/projects/${S.pid}`);
      note("Marker saved. Analyse the video again to find it.");
    }
    fillSetup(); paint();
  } catch (err) { note(err.message); }
});
$("marker-list").addEventListener("click", async (e) => {
  if (!e.target.dataset.mid) return;
  await api("DELETE", `/api/projects/${S.pid}/markers/${e.target.dataset.mid}`);
  S.p = await api("GET", `/api/projects/${S.pid}`); fillSetup();
});

const pushSettings = debounce(async () => {
  const weights = {};
  document.querySelectorAll("#weights input").forEach((i) => { weights[i.dataset.k] = +i.value; });
  try {
    S.p = await api("PATCH", `/api/projects/${S.pid}`, { settings: { weights, min_len: +$("min-len").value, max_len: Math.max(+$("max-len").value, +$("min-len").value), max_clips: +$("max-clips").value } });
    S.sig = await api("GET", `/api/projects/${S.pid}/signals`);
    drawTimeline(); note("Saved. Pick clips again to apply.");
  } catch (err) { note(err.message); }
}, 300);
$("weights").addEventListener("input", (e) => { e.target.nextElementSibling.textContent = (+e.target.value).toFixed(1); pushSettings(); });
["min-len", "max-len", "max-clips"].forEach((id) => $(id).addEventListener("change", pushSettings));

async function rerun(full) {
  try { note(""); await api("POST", `/api/projects/${S.pid}/analyze`, { full }); S.sel = null; S.sig = null; await refresh(); }
  catch (err) { note(err.message); }
}
$("btn-repick").addEventListener("click", () => rerun(false));
$("btn-reanalyze").addEventListener("click", () => rerun(true));
$("chat-add").addEventListener("change", async (e) => {
  const f = e.target.files[0]; if (!f) return;
  const fd = new FormData(); fd.append("file", f);
  try { const r = await api("POST", `/api/projects/${S.pid}/chat`, fd); note(`${r.messages.toLocaleString()} chat messages loaded. Analyse the video again to use them.`); }
  catch (err) { note(err.message); }
  e.target.value = "";
});

/* ---------- phone pairing ---------- */

$("btn-phone").addEventListener("click", async () => {
  const body = $("phone-body");
  try {
    const info = await api("GET", "/api/phone");
    body.innerHTML = info.enabled
      ? `<ol><li>Connect your phone to the same Wi-Fi as this PC.</li><li>Scan this code with the phone's camera.</li><li>To keep it handy, use your phone browser's "Add to Home Screen".</li></ol>
         <div class="qr">${info.qr}</div><p class="muted">Or type this address into the phone's browser:</p><code>${esc(info.url)}</code>
         <p class="muted">Anyone with this code can use Clutch while they are on your Wi-Fi, so only share it with people you trust. Videos stay on the PC; the phone controls it.</p>`
      : `<p>Phone access is off. Close Clutch and start it again with phone access:</p><code>python run.py --phone</code>
         <p class="muted">Starting Clutch with Clutch.bat or clutch.sh turns it on for you.</p>`;
  } catch (err) { body.textContent = err.message; }
  $("phone-dialog").showModal();
});

/* ---------- boot ---------- */

function route() {
  const m = location.hash.match(/^#\/p\/(\w+)/);
  if (m) openProject(m[1]); else showHome().catch((e) => homeError(e.message));
}
$("home-link").addEventListener("click", (e) => { e.preventDefault(); location.hash = ""; });
window.addEventListener("hashchange", route);
(async () => {
  S.cfg = await api("GET", "/api/config");
  $("game").innerHTML = Object.entries(S.cfg.games).map(([k, g]) => `<option value="${k}">${esc(g.name)}</option>`).join("");
  const off = [];
  if (!S.cfg.speech) off.push("captions off (install faster-whisper)");
  if (!S.cfg.ai) off.push("AI titles off (set ANTHROPIC_API_KEY)");
  $("caps").textContent = off.join(", ");
  api("GET", "/api/phone").then((info) => {
    $("btn-phone").hidden = !info.on_pc;
    if (!info.on_pc) {                 // on a paired phone the file comes from the phone, then is copied to the PC
      DROP_HINT = "Tap to choose a video. It is copied to your PC over Wi-Fi.";
      drop.querySelector("strong").textContent = "Or use a video from this phone";
      $("drop-hint").textContent = DROP_HINT;
    }
  }).catch(() => {});
  route();
})();
