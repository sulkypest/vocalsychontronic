import { db, requestPersistence } from "./db.js";
import { GIFEncoder, quantize, applyPalette } from "./vendor/gifenc.esm.js";

// ---------------------------------------------------------------------------
// Shape definitions (Rhubarb Lip Sync's standard set)
// ---------------------------------------------------------------------------
const SHAPES = [
  { key: "A", desc: "Closed mouth: P, B, M" },
  { key: "B", desc: "Slightly open, teeth together: most consonants, EE" },
  { key: "C", desc: "Open: EH (men), AE (bat)" },
  { key: "D", desc: "Wide open: AA (father)" },
  { key: "E", desc: "Slightly rounded: AO (off), ER (bird)" },
  { key: "F", desc: "Puckered: OO (you), OW (show), W" },
  { key: "G", desc: "Top teeth on lower lip: F, V", optional: true },
  { key: "H", desc: "Tongue raised: long L sounds", optional: true },
  { key: "X", desc: "Rest / idle: pauses and silence", optional: true },
];
const REQUIRED = ["A", "B", "C", "D", "E", "F"];
const FALLBACK = { G: "B", H: "C", X: "A" };

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") n.className = v;
    else if (k === "dataset") Object.assign(n.dataset, v);
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) n.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) n.append(c);
  return n;
};
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const fmtTime = (t) => {
  const m = Math.floor(t / 60);
  const s = (t - m * 60).toFixed(2).padStart(5, "0");
  return `${m}:${s}`;
};
const slug = (s) => (s || "lipsync").trim().replace(/[^\w\-]+/g, "-").replace(/^-+|-+$/g, "") || "lipsync";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  characters: [],
  editingId: null,
  // Make tab
  audioFile: null,
  audioBuffer: null,
  result: null, // { characterId, fps, frames: [shape], original: [shape], duration, images: {shape: ImageBitmap}, w, h }
  currentFrame: 0,
};
const urlCache = new Map(); // Blob -> object URL for thumbnails
const blobUrl = (blob) => {
  if (!blob) return null;
  if (!urlCache.has(blob)) urlCache.set(blob, URL.createObjectURL(blob));
  return urlCache.get(blob);
};

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
document.querySelectorAll(".tabs button").forEach((b) =>
  b.addEventListener("click", () => showTab(b.dataset.tab))
);
function showTab(name) {
  document.querySelectorAll(".tabs button").forEach((b) =>
    b.setAttribute("aria-selected", String(b.dataset.tab === name))
  );
  document.querySelectorAll(".tab").forEach((s) =>
    (s.dataset.active = String(s.id === `tab-${name}`))
  );
  try { localStorage.setItem("lipsync.tab", name); } catch (_) {}
  if (name === "make") renderCharacterSelect();
}

// ---------------------------------------------------------------------------
// Characters
// ---------------------------------------------------------------------------
async function loadCharacters() {
  state.characters = await db.all();
  renderCharacterList();
  renderCharacterSelect();
}

function missingRequired(ch) {
  return REQUIRED.filter((k) => !ch.shapes[k]);
}

function renderCharacterList() {
  const list = $("char-list");
  list.replaceChildren();
  $("char-empty").hidden = state.characters.length > 0;
  for (const ch of state.characters) {
    const thumb = ch.shapes.X || ch.shapes.A || Object.values(ch.shapes)[0];
    const missing = missingRequired(ch);
    list.append(
      el("li", {},
        el("button", {
          "aria-current": String(ch.id === state.editingId),
          onclick: () => editCharacter(ch.id),
        },
          thumb ? el("img", { class: "char-thumb checker", src: blobUrl(thumb), alt: "" })
                : el("div", { class: "char-thumb slot-empty checker" }, "No shapes"),
          el("strong", {}, ch.name),
          el("span", { class: "char-meta" },
            missing.length ? `Missing ${missing.join(", ")}` : `${Object.keys(ch.shapes).length} shapes`)
        )
      )
    );
  }
}

function renderCharacterSelect() {
  const sel = $("make-character");
  const prev = sel.value || safeGet("lipsync.character");
  sel.replaceChildren();
  if (!state.characters.length) {
    sel.append(el("option", { value: "" }, "No characters yet"));
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  for (const ch of state.characters) {
    const missing = missingRequired(ch);
    sel.append(el("option", { value: ch.id }, missing.length ? `${ch.name} (missing ${missing.join(", ")})` : ch.name));
  }
  if (prev && state.characters.some((c) => c.id === prev)) sel.value = prev;
}
$("make-character").addEventListener("change", (e) => safeSet("lipsync.character", e.target.value));

function safeGet(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); } catch (_) {} }

$("char-new").addEventListener("click", async () => {
  const n = state.characters.length + 1;
  const ch = { id: uid(), name: `Character ${n}`, shapes: {}, created: Date.now() };
  await db.put(ch);
  await loadCharacters();
  editCharacter(ch.id);
  $("char-name").select();
});

function currentCharacter() {
  return state.characters.find((c) => c.id === state.editingId);
}

function editCharacter(id) {
  state.editingId = id;
  renderCharacterList();
  const ch = currentCharacter();
  $("char-editor").hidden = !ch;
  if (!ch) return;
  $("char-name").value = ch.name;
  renderSlots();
  $("char-editor").scrollIntoView({ behavior: "smooth", block: "start" });
}

$("char-name").addEventListener("change", async (e) => {
  const ch = currentCharacter();
  if (!ch) return;
  ch.name = e.target.value.trim() || ch.name;
  await db.put(ch);
  await loadCharacters();
});

async function imageSize(blob) {
  const bmp = await createImageBitmap(blob);
  const size = { w: bmp.width, h: bmp.height };
  bmp.close && bmp.close();
  return size;
}

async function renderSlots() {
  const ch = currentCharacter();
  const wrap = $("slots");
  wrap.replaceChildren();
  // Work out the canvas size the majority of shapes use, to flag mismatches.
  const sizes = {};
  for (const [k, blob] of Object.entries(ch.shapes)) sizes[k] = await imageSize(blob);
  const counts = {};
  for (const s of Object.values(sizes)) counts[`${s.w}×${s.h}`] = (counts[`${s.w}×${s.h}`] || 0) + 1;
  const main = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
  $("char-size").textContent = main ? `Canvas: ${main}px` : "";

  for (const s of SHAPES) {
    const blob = ch.shapes[s.key];
    const sz = sizes[s.key];
    const mismatch = sz && main && `${sz.w}×${sz.h}` !== main;
    const slot = el("div", {
      class: "slot" + (blob ? " filled" : ""),
      role: "button",
      tabindex: "0",
      "aria-label": `Shape ${s.key}: ${s.desc}`,
      onclick: (e) => { if (!e.target.closest(".slot-clear")) pickSlotFile(s.key); },
      onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pickSlotFile(s.key); } },
      ondragover: (e) => { e.preventDefault(); slot.classList.add("dragover"); },
      ondragleave: () => slot.classList.remove("dragover"),
      ondrop: (e) => {
        e.preventDefault(); slot.classList.remove("dragover");
        const f = e.dataTransfer.files[0];
        if (f) setShape(s.key, f);
      },
    },
      el("div", { class: "slot-head" },
        el("span", { class: "slot-letter" }, s.key),
        s.optional ? el("span", { class: "slot-opt" }, `optional → ${FALLBACK[s.key]}`) : null
      ),
      blob ? el("img", { class: "slot-img checker", src: blobUrl(blob), alt: `Shape ${s.key}` })
           : el("div", { class: "slot-empty checker" }, "Tap to add PNG"),
      el("div", { class: "slot-desc" }, s.desc),
      mismatch ? el("div", { class: "slot-warn" }, `Size ${sz.w}×${sz.h} differs from the others`) : null,
      blob ? el("button", { class: "slot-clear", onclick: () => setShape(s.key, null) }, "Remove") : null
    );
    wrap.append(slot);
  }
}

let pendingSlot = null;
function pickSlotFile(key) {
  pendingSlot = key;
  $("slot-file").value = "";
  $("slot-file").click();
}
$("slot-file").addEventListener("change", (e) => {
  const f = e.target.files[0];
  if (f && pendingSlot) setShape(pendingSlot, f);
});

async function toPngBlob(file) {
  // Keep PNGs as-is; convert anything else (e.g. from Photos) to PNG so alpha survives.
  if (file.type === "image/png") return file.slice(0, file.size, "image/png");
  const bmp = await createImageBitmap(file);
  const c = document.createElement("canvas");
  c.width = bmp.width; c.height = bmp.height;
  c.getContext("2d").drawImage(bmp, 0, 0);
  return new Promise((r) => c.toBlob(r, "image/png"));
}

async function setShape(key, file) {
  const ch = currentCharacter();
  if (!ch) return;
  if (file) ch.shapes[key] = await toPngBlob(file);
  else delete ch.shapes[key];
  await db.put(ch);
  await loadCharacters();
  renderSlots();
}

$("char-bulk").addEventListener("click", () => { $("char-bulk-file").value = ""; $("char-bulk-file").click(); });
$("char-bulk-file").addEventListener("change", async (e) => {
  const ch = currentCharacter();
  if (!ch) return;
  const unmatched = [];
  for (const f of e.target.files) {
    const key = shapeFromFilename(f.name);
    if (key) ch.shapes[key] = await toPngBlob(f);
    else unmatched.push(f.name);
  }
  await db.put(ch);
  await loadCharacters();
  renderSlots();
  if (unmatched.length) alertMsg(`Couldn't tell which shape these are, so they were skipped: ${unmatched.join(", ")}. Name each file by its letter, e.g. A.png.`);
});

function shapeFromFilename(name) {
  const base = name.replace(/\.[^.]+$/, "");
  // A letter on its own, or at the end after a separator: "A", "mouth-A", "bob_x"
  const m = /(?:^|[\s_\-.])([A-HXa-hx])$/.exec(base) || /^([A-HXa-hx])(?:$|[\s_\-.])/.exec(base);
  return m ? m[1].toUpperCase() : null;
}

$("char-delete").addEventListener("click", async () => {
  const ch = currentCharacter();
  if (!ch) return;
  if (!confirm(`Delete "${ch.name}" and its mouth shapes from this device?`)) return;
  await db.remove(ch.id);
  state.editingId = null;
  $("char-editor").hidden = true;
  await loadCharacters();
});

// Backup / restore as a single JSON file
const blobToDataURL = (b) => new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(b); });
const dataURLToBlob = async (u) => (await fetch(u)).blob();

$("char-export").addEventListener("click", async () => {
  const ch = currentCharacter();
  if (!ch) return;
  const shapes = {};
  for (const [k, b] of Object.entries(ch.shapes)) shapes[k] = await blobToDataURL(b);
  const json = JSON.stringify({ app: "lipsync", version: 1, name: ch.name, shapes });
  download(new Blob([json], { type: "application/json" }), `${slug(ch.name)}.mouths.json`);
});
$("char-import").addEventListener("click", () => { $("char-import-file").value = ""; $("char-import-file").click(); });
$("char-import-file").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (data.app !== "lipsync" || !data.shapes) throw new Error("Not a Lip Sync character file.");
    const shapes = {};
    for (const [k, u] of Object.entries(data.shapes)) if (/^[A-HX]$/.test(k)) shapes[k] = await dataURLToBlob(u);
    const ch = { id: uid(), name: data.name || "Imported", shapes, created: Date.now() };
    await db.put(ch);
    await loadCharacters();
    editCharacter(ch.id);
  } catch (err) {
    alertMsg(`Couldn't import that file: ${err.message}`);
  }
});

function alertMsg(m) { window.alert(m); }

// ---------------------------------------------------------------------------
// Rhubarb worker
// ---------------------------------------------------------------------------
let worker = null;
let msgId = 0;
const pending = new Map();
let onWorkerProgress = () => {};
function getWorker() {
  if (!worker) {
    worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    worker.onmessage = (e) => {
      const { id, ok, progress, error } = e.data;
      if (progress) { onWorkerProgress(e.data); if (id == null || ok === undefined) return; }
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      ok ? p.resolve(e.data) : p.reject(new Error(error));
    };
    worker.onerror = (e) => {
      for (const p of pending.values()) p.reject(new Error(e.message || "Analysis engine failed to load."));
      pending.clear();
      worker = null;
    };
  }
  return worker;
}
function callWorker(msg, transfer) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ ...msg, id }, transfer || []);
  });
}

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------
let audioEl = null;
$("make-audio").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  state.audioFile = f || null;
  state.audioBuffer = null;
  $("make-audio-info").textContent = "";
  if (!f) return;
  try {
    state.audioBuffer = await decodeAudio(f);
    $("make-audio-info").textContent = `${fmtTime(state.audioBuffer.duration)} long`;
  } catch (err) {
    $("make-audio-info").textContent = "Couldn't read this audio file. Try WAV, MP3 or M4A.";
  }
});

async function decodeAudio(file) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  try {
    const buf = await file.arrayBuffer();
    return await new Promise((resolve, reject) => {
      const p = ctx.decodeAudioData(buf, resolve, reject);
      if (p && p.then) p.then(resolve, reject);
    });
  } finally {
    ctx.close && ctx.close();
  }
}

// Mono, 16 kHz, 16-bit little-endian PCM: what the Rhubarb build expects.
async function toPcm16k(audioBuffer) {
  const rate = 16000;
  const length = Math.max(1, Math.ceil(audioBuffer.duration * rate));
  const Off = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const off = new Off(1, length, rate);
  const src = off.createBufferSource();
  src.buffer = audioBuffer;
  src.connect(off.destination);
  src.start(0);
  const rendered = await off.startRendering();
  const data = rendered.getChannelData(0);
  const out = new Int16Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const s = Math.max(-1, Math.min(1, data[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out.buffer;
}

// ---------------------------------------------------------------------------
// Generate
// ---------------------------------------------------------------------------
function setStatus(id, text, isError = false) {
  const s = $(id);
  s.textContent = text;
  s.classList.toggle("error", isError);
}

$("make-go").addEventListener("click", generate);

async function generate() {
  const ch = state.characters.find((c) => c.id === $("make-character").value);
  if (!ch) return setStatus("make-status", "Create a character first (Characters tab).", true);
  const missing = missingRequired(ch);
  if (missing.length) return setStatus("make-status", `${ch.name} is missing shape${missing.length > 1 ? "s" : ""} ${missing.join(", ")}.`, true);
  if (!state.audioBuffer) return setStatus("make-status", "Choose an audio file first.", true);

  const btn = $("make-go");
  btn.disabled = true;
  stopPlayback();
  try {
    setStatus("make-status", "Preparing audio…");
    const pcm = await toPcm16k(state.audioBuffer);

    onWorkerProgress = (p) => {
      if (p.progress === "download" && p.total) {
        setStatus("make-status", `Loading speech engine (first run only)… ${Math.round((p.loaded / p.total) * 100)}%`);
      } else if (p.progress === "analysing") {
        setStatus("make-status", "Analysing speech… this can take a little while for long clips.");
      }
    };
    setStatus("make-status", "Loading speech engine…");
    const t0 = performance.now();
    const { cues } = await callWorker(
      { type: "analyse", pcm, dialog: $("make-transcript").value.trim() },
      [pcm]
    );
    const secs = ((performance.now() - t0) / 1000).toFixed(1);

    const fps = Number($("make-fps").value);
    const duration = state.audioBuffer.duration;
    const frames = cuesToFrames(cues, fps, duration);
    const images = await loadShapeImages(ch);
    const { w, h, crop } = computeCanvas(images, $("make-trim").checked);

    state.result = {
      characterId: ch.id, characterName: ch.name, fps, duration, cues,
      frames, original: frames.slice(), images, w, h, crop,
      audioName: state.audioFile?.name || "audio",
    };
    state.currentFrame = 0;
    setupPreview();
    setStatus("make-status", `Done in ${secs}s: ${frames.length} frames.`);
    $("result").hidden = false;
    $("result").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    console.error(err);
    setStatus("make-status", `Something went wrong: ${err.message}`, true);
  } finally {
    btn.disabled = false;
  }
}

// Sample the cue active at the start of each frame.
function cuesToFrames(cues, fps, duration) {
  const n = Math.max(1, Math.ceil(duration * fps - 1e-6));
  const frames = new Array(n);
  let ci = 0;
  for (let k = 0; k < n; k++) {
    const t = k / fps + 1e-6;
    while (ci < cues.length - 1 && cues[ci].end <= t) ci++;
    const c = cues[ci];
    frames[k] = c && t >= c.start && t < c.end ? c.value : "X";
  }
  return frames;
}

async function loadShapeImages(ch) {
  const images = {};
  for (const [k, blob] of Object.entries(ch.shapes)) images[k] = await createImageBitmap(blob);
  return images;
}

const resolveShape = (images, s) => (images[s] ? s : images[FALLBACK[s]] ? FALLBACK[s] : "A");

function computeCanvas(images, trim) {
  const list = Object.values(images);
  const w = Math.max(...list.map((b) => b.width));
  const h = Math.max(...list.map((b) => b.height));
  if (!trim) return { w, h, crop: { x: 0, y: 0, w, h } };
  // Union of the non-transparent areas across all shapes, plus a small margin.
  const c = new OffscreenCanvasOr(w, h);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (const b of list) {
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(b, 0, 0);
    const d = ctx.getImageData(0, 0, w, h).data;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (d[(y * w + x) * 4 + 3] > 8) {
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
    }
  }
  if (x1 < 0) return { w, h, crop: { x: 0, y: 0, w, h } };
  const m = 4;
  x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m);
  x1 = Math.min(w - 1, x1 + m); y1 = Math.min(h - 1, y1 + m);
  const cw = x1 - x0 + 1, chh = y1 - y0 + 1;
  return { w: cw, h: chh, crop: { x: x0, y: y0, w: cw, h: chh } };
}

function OffscreenCanvasOr(w, h) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return c;
}

// ---------------------------------------------------------------------------
// Preview + timeline
// ---------------------------------------------------------------------------
let raf = 0;
function setupPreview() {
  const r = state.result;
  const canvas = $("preview");
  canvas.width = r.w;
  canvas.height = r.h;
  if (audioEl) { audioEl.pause(); URL.revokeObjectURL(audioEl.src); }
  audioEl = new Audio(URL.createObjectURL(state.audioFile));
  audioEl.preload = "auto";
  audioEl.addEventListener("ended", () => { stopPlayback(); seekFrame(0); });
  renderTimeline();
  seekFrame(0);
}

function drawFrame(k) {
  const r = state.result;
  const ctx = $("preview").getContext("2d");
  ctx.clearRect(0, 0, r.w, r.h);
  const img = r.images[resolveShape(r.images, r.frames[k])];
  ctx.drawImage(img, -r.crop.x, -r.crop.y);
}

function renderTimeline() {
  const r = state.result;
  const tl = $("timeline");
  tl.replaceChildren();
  r.frames.forEach((s, k) => {
    const isSec = k % r.fps === 0;
    tl.append(
      el("button", {
        class: "cell" + (isSec ? " sec" : "") + (s !== r.original[k] ? " edited" : ""),
        dataset: { k },
        role: "listitem",
        "aria-label": `Frame ${k + 1}: shape ${s}`,
        onclick: () => (k === state.currentFrame && !isPlaying() ? openPicker(k) : (stopPlayback(), seekFrame(k))),
      },
        s,
        el("small", {}, isSec ? `${k / r.fps}s` : String((k % r.fps) + 1))
      )
    );
  });
}

function updateTimelineCell(k) {
  const r = state.result;
  const cell = $("timeline").children[k];
  if (!cell) return;
  cell.firstChild.nodeValue = r.frames[k];
  cell.classList.toggle("edited", r.frames[k] !== r.original[k]);
  cell.setAttribute("aria-label", `Frame ${k + 1}: shape ${r.frames[k]}`);
}

function highlight(k, scroll) {
  const tl = $("timeline");
  tl.querySelector(".cell.current")?.classList.remove("current");
  const cell = tl.children[k];
  if (!cell) return;
  cell.classList.add("current");
  if (scroll) {
    const left = cell.offsetLeft - tl.clientWidth / 2 + cell.clientWidth / 2;
    tl.scrollTo({ left, behavior: isPlaying() ? "auto" : "smooth" });
  }
}

function seekFrame(k) {
  const r = state.result;
  k = Math.max(0, Math.min(r.frames.length - 1, k));
  state.currentFrame = k;
  drawFrame(k);
  highlight(k, true);
  const t = k / r.fps;
  if (audioEl) { try { audioEl.currentTime = t; } catch (_) {} }
  updateClock(t, k);
}

function updateClock(t, k) {
  $("clock").textContent = fmtTime(t);
  $("frame-label").textContent = `Frame ${k + 1} / ${state.result.frames.length}`;
}

const isPlaying = () => audioEl && !audioEl.paused;
$("play").addEventListener("click", () => (isPlaying() ? stopPlayback() : startPlayback()));

function startPlayback() {
  if (!audioEl || !state.result) return;
  const r = state.result;
  if (state.currentFrame >= r.frames.length - 1) seekFrame(0);
  audioEl.play();
  $("play").textContent = "❚❚";
  $("play").setAttribute("aria-label", "Pause");
  let last = -1;
  const tick = () => {
    const t = audioEl.currentTime;
    const k = Math.min(r.frames.length - 1, Math.floor(t * r.fps + 1e-6));
    if (k !== last) {
      last = k;
      state.currentFrame = k;
      drawFrame(k);
      highlight(k, true);
      updateClock(t, k);
    }
    if (!audioEl.paused) raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
}

function stopPlayback() {
  cancelAnimationFrame(raf);
  if (audioEl && !audioEl.paused) audioEl.pause();
  $("play").textContent = "▶";
  $("play").setAttribute("aria-label", "Play");
}

// Shape picker for correcting a frame
let pickerFrame = -1;
function openPicker(k) {
  const r = state.result;
  pickerFrame = k;
  $("picker-frame").textContent = String(k + 1);
  const grid = $("picker-grid");
  grid.replaceChildren();
  for (const s of SHAPES) {
    const shown = resolveShape(r.images, s.key);
    grid.append(
      el("button", {
        class: r.frames[k] === s.key ? "on" : "",
        onclick: () => {
          r.frames[k] = s.key;
          updateTimelineCell(k);
          drawFrame(k);
          closePicker();
        },
      },
        el("img", { class: "checker", src: bitmapThumb(r.images[shown]), alt: "" }),
        el("span", {}, s.key + (shown !== s.key ? ` (=${shown})` : ""))
      )
    );
  }
  if (r.frames[k] !== r.original[k]) {
    grid.append(el("button", { onclick: () => { r.frames[k] = r.original[k]; updateTimelineCell(k); drawFrame(k); closePicker(); } },
      el("span", {}, `Undo (was ${r.original[k]})`)));
  }
  $("picker").hidden = false;
}
function closePicker() { $("picker").hidden = true; pickerFrame = -1; }
$("picker-cancel").addEventListener("click", closePicker);
$("picker").addEventListener("click", (e) => { if (e.target === $("picker")) closePicker(); });

const thumbCache = new WeakMap();
function bitmapThumb(bmp) {
  if (thumbCache.has(bmp)) return thumbCache.get(bmp);
  const c = document.createElement("canvas");
  const s = Math.min(1, 240 / Math.max(bmp.width, bmp.height));
  c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  const url = c.toDataURL("image/png");
  thumbCache.set(bmp, url);
  return url;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
$("dl-gif").addEventListener("click", async () => {
  const r = state.result;
  if (!r) return;
  const btn = $("dl-gif");
  btn.disabled = true;
  setStatus("export-status", "Building GIF…");
  await new Promise((res) => setTimeout(res, 30));
  try {
    const blob = await buildGif(r);
    const name = `${slug(r.characterName)}_${slug(r.audioName.replace(/\.[^.]+$/, ""))}_${r.fps}fps.gif`;
    download(blob, name);
    setStatus("export-status", `${(blob.size / 1024 / 1024).toFixed(1)} MB`);
  } catch (err) {
    console.error(err);
    setStatus("export-status", `Couldn't build the GIF: ${err.message}`, true);
  } finally {
    btn.disabled = false;
  }
});

function buildGif(r) {
  const { w, h, crop } = r;
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });

  // Pixels for each shape actually used.
  const used = [...new Set(r.frames.map((s) => resolveShape(r.images, s)))];
  const pixels = {};
  for (const s of used) {
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(r.images[s], -crop.x, -crop.y);
    pixels[s] = new Uint8Array(ctx.getImageData(0, 0, w, h).data.buffer.slice(0));
  }

  // One shared palette across all shapes so colours stay identical between frames.
  const all = new Uint8Array(used.length * w * h * 4);
  used.forEach((s, i) => all.set(pixels[s], i * w * h * 4));
  const palette = quantize(all, 256, { format: "rgba4444", oneBitAlpha: true, clearAlpha: true, clearAlphaThreshold: 127 });
  let tIndex = palette.findIndex((p) => p[3] === 0);
  const hasTransparent = tIndex >= 0;
  const indexed = {};
  for (const s of used) indexed[s] = applyPalette(pixels[s], palette, "rgba4444");

  // One GIF frame per animation frame, with delays rounded so the total stays in sync.
  const gif = GIFEncoder();
  const n = r.frames.length;
  for (let k = 0; k < n; k++) {
    const cs0 = Math.round((k / r.fps) * 100);
    const cs1 = Math.round(((k + 1) / r.fps) * 100);
    const s = resolveShape(r.images, r.frames[k]);
    gif.writeFrame(indexed[s], w, h, {
      palette: k === 0 ? palette : undefined,
      delay: (cs1 - cs0) * 10,
      transparent: hasTransparent,
      transparentIndex: hasTransparent ? tIndex : 0,
      dispose: 2,
      repeat: 0,
    });
  }
  gif.finish();
  return new Blob([gif.bytes()], { type: "image/gif" });
}

$("dl-timing").addEventListener("click", () => {
  const r = state.result;
  if (!r) return;
  const lines = [
    `# ${r.characterName}: ${r.audioName}`,
    `# ${r.fps} fps, ${r.frames.length} frames. Columns: frame, time, shape (only where the shape changes)`,
  ];
  let prev = null;
  r.frames.forEach((s, k) => {
    if (s !== prev) lines.push(`${String(k + 1).padStart(5)}  ${fmtTime(k / r.fps)}  ${s}`);
    prev = s;
  });
  download(new Blob([lines.join("\n") + "\n"], { type: "text/plain" }),
    `${slug(r.characterName)}_${slug(r.audioName.replace(/\.[^.]+$/, ""))}_${r.fps}fps.txt`);
});

function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
(async function init() {
  requestPersistence();
  await loadCharacters();
  showTab(safeGet("lipsync.tab") || (state.characters.length ? "make" : "characters"));
  // Start fetching the speech engine in the background so the first Generate is quicker.
  setTimeout(() => callWorker({ type: "warmup" }).catch(() => {}), 1500);
})();
