"use strict";

/* ----------------------------------------------------------------------- *
 * LeRobot dataset viewer.
 *
 * Playback model: a v3.0 dataset packs many episodes into ONE mp4 per camera, so an
 * episode is a *window* [from_timestamp, to_timestamp] into a shared file. We point one
 * <video> per camera at the whole file (served with HTTP Range) and seek inside it —
 * measured at ~6 ms per scrub step for 3 cameras, with 0 ms spread between them.
 *
 * Reuses $, el, api, toast and openFolderPicker from app.js (loaded before this file).
 * ----------------------------------------------------------------------- */

const DS = {
  root: null,
  info: null,          // /api/ds/open payload
  eps: [],             // episode rows
  ep: null,            // selected episode row
  fps: 30,
  videos: {},          // camera key -> <video>
  masterKey: null,     // camera that drives the clock
  frame: 0,
  playing: false,
  rafId: null,
  speed: 1,
  seekPending: false,
};

const MAX_EPISODE_ROWS = 1000;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function dsVideoUrl(key, chunk, file) {
  return `/api/ds/video?root=${encodeURIComponent(DS.root)}` +
    `&key=${encodeURIComponent(key)}&chunk=${chunk}&file=${file}`;
}

const fmtDur = (s) => {
  if (!isFinite(s)) return "–";
  const m = Math.floor(s / 60), r = s - m * 60;
  return m ? `${m}m ${r.toFixed(1)}s` : `${r.toFixed(1)}s`;
};

/* ----------------------------------------------------------------------- *
 * Open a dataset
 * ----------------------------------------------------------------------- */
async function dsOpen(path) {
  const root = (path ?? $("#dsPath").value).trim();
  if (!root) return toast("Pick a dataset folder first", "err");
  stopPlayback();
  $("#dsInfo").textContent = "opening…";
  try {
    const info = await api(`/api/ds/open?root=${encodeURIComponent(root)}`);
    const eps = await api(`/api/ds/episodes?root=${encodeURIComponent(info.root)}`);
    DS.root = info.root;
    DS.info = info;
    DS.eps = eps.items;
    DS.fps = info.fps || 30;
    DS.videos = {};
    DS.ep = null;
    $("#dsPath").value = info.root;
    try { localStorage.setItem("hfutil.dsRoot", info.root); } catch { /* private mode */ }

    $("#dsEmpty").hidden = true;
    $("#dsBody").hidden = false;
    $("#dsInfo").textContent =
      `${info.name} · ${info.codebase_version} · ${info.total_episodes} episodes · ` +
      `${info.total_frames.toLocaleString()} frames · ${info.fps} fps` +
      (info.robot_type ? ` · ${info.robot_type}` : "");
    (info.warnings || []).forEach((w) => toast(w, "err", 9000));
    if (!info.cameras.length) toast("This dataset has no video features to play.", "err", 8000);

    $("#dsCams").replaceChildren();
    renderEpisodeList();
    renderPlotPicker();
    if (DS.eps.length) selectEpisode(DS.eps[0].ep);
  } catch (e) {
    $("#dsInfo").textContent = "";
    $("#dsEmpty").hidden = false;
    $("#dsBody").hidden = true;
    toast(`Cannot open dataset: ${e.message}`, "err", 12000);
  }
}

/* ----------------------------------------------------------------------- *
 * Episode list
 * ----------------------------------------------------------------------- */
function visibleEpisodes() {
  const q = $("#epFilter").value.trim().toLowerCase();
  if (!q) return DS.eps;
  return DS.eps.filter((e) =>
    String(e.ep).includes(q) || (e.tasks[0] || "").toLowerCase().includes(q));
}

function renderEpisodeList() {
  const rows = visibleEpisodes();
  const shown = rows.slice(0, MAX_EPISODE_ROWS);
  const list = $("#epList");
  list.replaceChildren();

  for (const e of shown) {
    const row = el("div", { className: "ep-row" + (DS.ep && DS.ep.ep === e.ep ? " active" : "") });
    row.dataset.ep = e.ep;
    row.append(
      el("span", { className: "ep-idx" }, `#${e.ep}`),
      el("span", { className: "ep-len" }, `${e.length}f`),
      el("span", { className: "ep-dur" }, fmtDur(e.length / DS.fps)),
      el("span", { className: "ep-task", title: e.tasks[0] || "" }, e.tasks[0] || "—"),
    );
    row.addEventListener("click", () => selectEpisode(e.ep));
    list.append(row);
  }
  if (rows.length > shown.length) {
    list.append(el("div", { className: "fs-note" },
      `showing first ${shown.length} of ${rows.length} — use the filter to narrow`));
  }
  if (!rows.length) list.append(el("div", { className: "fs-empty" }, "no episodes match"));
  $("#epCount").textContent = `${rows.length} / ${DS.eps.length}`;
}

/* ----------------------------------------------------------------------- *
 * Camera players
 * ----------------------------------------------------------------------- */
async function ensurePlayers(ep) {
  const keys = Object.keys(ep.videos);
  DS.masterKey = keys[0] || null;
  const box = $("#dsCams");

  // Rebuild only when the set of cameras changes; otherwise keep the elements (and
  // their buffered data) and just retarget/seek them.
  const existing = Object.keys(DS.videos);
  const same = existing.length === keys.length && existing.every((k) => keys.includes(k));
  if (!same) {
    box.replaceChildren();
    DS.videos = {};
    for (const key of keys) {
      const cam = (DS.info.cameras || []).find((c) => c.key === key) || {};
      const v = el("video", { muted: true, playsInline: true, preload: "auto" });
      v.className = "ds-video";
      // Declare the aspect ratio up front (we know it from meta) so the panel has its
      // final width before the first frame decodes — otherwise the strip reflows on load.
      if (cam.width && cam.height) v.style.aspectRatio = `${cam.width} / ${cam.height}`;
      // Backstop for the episode boundary. playbackTick() normally handles it, but it
      // runs on requestAnimationFrame, which is suspended while the tab is hidden — the
      // video would then keep playing straight into the next episode of the shared file.
      // timeupdate keeps firing (throttled) in background tabs.
      v.addEventListener("timeupdate", () => {
        if (!DS.playing || !DS.ep) return;
        const win = DS.ep.videos[key];
        if (win && v.currentTime >= win.to_timestamp - 0.5 / DS.fps) endOfEpisode();
      });
      const cell = el("div", { className: "ds-cam" },
        v, el("div", { className: "ds-camlabel" }, shortCam(key) + (cam.width ? ` · ${cam.width}×${cam.height}` : "")));
      box.append(cell);
      DS.videos[key] = v;
    }
  }

  // Point each player at the right shared file. src changes only when the episode lives in
  // a different chunk/file, so stepping through episodes inside one file never reloads.
  // When it *does* change we must wait for metadata: seeking a video that hasn't loaded
  // yet is silently ignored, which would leave a multi-file dataset on the wrong frame.
  const pending = [];
  for (const key of keys) {
    const w = ep.videos[key];
    const abs = new URL(dsVideoUrl(key, w.chunk, w.file), location.href).href;
    const v = DS.videos[key];
    if (v.src !== abs) {
      v.src = abs;
      pending.push(new Promise((res) => {
        const done = () => res();
        v.addEventListener("loadedmetadata", done, { once: true });
        v.addEventListener("error", done, { once: true });
        setTimeout(done, 15000);
      }));
    }
    v.playbackRate = DS.speed;
  }
  layoutCams();
  if (pending.length) await Promise.all(pending);
}

const shortCam = (key) => key.replace(/^observation\.images\./, "");

const CAM_GAP = 10;
const CAM_MIN_H = 90;

/** Size the camera strip: the requested height, capped so every panel fits on one row.
 *  Panels are height-driven (width follows each camera's aspect ratio), so the row width
 *  is `height * sum(aspect ratios)` — invert that to get the tallest height that fits. */
function layoutCams() {
  const box = $("#dsCams");
  const keys = DS.ep ? Object.keys(DS.ep.videos) : [];
  if (!box || !keys.length) return;

  const ratios = keys.map((k) => {
    const cam = (DS.info?.cameras || []).find((c) => c.key === k);
    return cam && cam.width && cam.height ? cam.width / cam.height : 4 / 3;
  });
  const totalRatio = ratios.reduce((s, r) => s + r, 0) || 1;
  const avail = box.clientWidth - CAM_GAP * (keys.length - 1);
  const fitH = Math.floor(avail / totalRatio);
  const want = Number($("#dsCamSize").value) || 200;
  box.style.setProperty("--cam-h", `${Math.max(CAM_MIN_H, Math.min(want, fitH))}px`);
}

/* ----------------------------------------------------------------------- *
 * Selection + transport
 * ----------------------------------------------------------------------- */
let selectToken = 0;

async function selectEpisode(index) {
  const ep = DS.eps.find((e) => e.ep === index);
  if (!ep) return;
  const token = ++selectToken;
  stopPlayback();
  DS.ep = ep;
  await ensurePlayers(ep);
  // A newer click landed while we waited for video metadata — let that one win.
  if (token !== selectToken) return;

  $("#dsSlider").max = String(Math.max(0, ep.length - 1));
  $("#dsSlider").value = "0";
  document.querySelectorAll("#epList .ep-row").forEach((r) =>
    r.classList.toggle("active", Number(r.dataset.ep) === index));

  $("#dsEpMeta").replaceChildren(
    el("span", { className: "badge muted" }, `episode ${ep.ep}`),
    el("span", { className: "badge muted" }, `${ep.length} frames`),
    el("span", { className: "badge muted" }, fmtDur(ep.length / DS.fps)),
    el("span", { className: "ds-tasktext" }, ep.tasks[0] || "(no task)"),
  );
  seekToFrame(0, true);
  onEpisodeChangedForPlots();
}

function seekToFrame(f, force = false) {
  if (!DS.ep) return;
  DS.frame = clamp(Math.round(f), 0, Math.max(0, DS.ep.length - 1));
  const eps = 0.5 / DS.fps;
  for (const [key, v] of Object.entries(DS.videos)) {
    const w = DS.ep.videos[key];
    if (!w) continue;
    // Clamp inside the episode window so we never spill into the neighbouring episode.
    const t = Math.min(w.from_timestamp + DS.frame / DS.fps, w.to_timestamp - eps);
    if (force || Math.abs(v.currentTime - t) > eps) v.currentTime = t;
  }
  updateTransport();
}

function updateTransport() {
  if (!DS.ep) return;
  $("#dsSlider").value = String(DS.frame);
  const t = DS.frame / DS.fps;
  $("#dsFrame").textContent =
    `${DS.frame} / ${DS.ep.length - 1}  ·  ${t.toFixed(2)}s`;
  $("#dsPlay").textContent = DS.playing ? "❚❚" : "▶";
  if (typeof updatePlotCursor === "function") updatePlotCursor();
}

/* ----------------------------------------------------------------------- *
 * Playback — camera 0 is the clock, rAF drives the UI, slaves get drift-corrected
 * ----------------------------------------------------------------------- */
function playbackTick() {
  if (!DS.playing || !DS.ep || !DS.masterKey) return;
  const master = DS.videos[DS.masterKey];
  const w = DS.ep.videos[DS.masterKey];
  const tol = 1.5 / DS.fps;

  const f = Math.round((master.currentTime - w.from_timestamp) * DS.fps);
  DS.frame = clamp(f, 0, DS.ep.length - 1);

  for (const [key, v] of Object.entries(DS.videos)) {
    if (key === DS.masterKey) continue;
    const ww = DS.ep.videos[key];
    if (!ww) continue;
    const want = ww.from_timestamp + DS.frame / DS.fps;
    if (Math.abs(v.currentTime - want) > tol) v.currentTime = want;
  }
  updateTransport();

  // Stop at the episode boundary — the file keeps going into the next episode.
  if (DS.frame >= DS.ep.length - 1 || master.currentTime >= w.to_timestamp - 0.5 / DS.fps) {
    endOfEpisode();
    return;
  }
  DS.rafId = requestAnimationFrame(playbackTick);
}

/** Pause and snap back onto the episode's last frame.
 *  Neither watchdog fires exactly on the boundary (rAF ~16 ms, timeupdate ~250 ms), so
 *  without the snap-back the viewer can sit on a frame belonging to the NEXT episode. */
function endOfEpisode() {
  if (!DS.ep) return;
  stopPlayback();
  seekToFrame(DS.ep.length - 1, true);
}

let playToken = 0;

async function startPlayback() {
  if (!DS.ep || !DS.masterKey) return;
  if (DS.frame >= DS.ep.length - 1) seekToFrame(0, true);
  const token = ++playToken;
  DS.playing = true;
  updateTransport();
  try {
    await Promise.all(Object.values(DS.videos).map((v) => {
      v.playbackRate = DS.speed;
      return v.play();
    }));
  } catch (e) {
    // Pausing/scrubbing/tab-switching while play() is still starting rejects those
    // promises with AbortError. That is the user pausing, not a failure — and the
    // session it belonged to is already over, so never tear down a newer one.
    if (token !== playToken) return;
    stopPlayback();
    if (e && e.name !== "AbortError") toast(`Playback failed: ${e.message}`, "err", 8000);
    return;
  }
  if (token !== playToken || !DS.playing) return;
  DS.rafId = requestAnimationFrame(playbackTick);
}

function stopPlayback() {
  playToken++;  // invalidate any in-flight startPlayback()
  DS.playing = false;
  if (DS.rafId) { cancelAnimationFrame(DS.rafId); DS.rafId = null; }
  Object.values(DS.videos).forEach((v) => { try { v.pause(); } catch { /* not ready */ } });
  updateTransport();
}

const togglePlayback = () => (DS.playing ? stopPlayback() : startPlayback());

/* ----------------------------------------------------------------------- *
 * Wiring
 * ----------------------------------------------------------------------- */
function dsWire() {
  $("#dsBrowse").addEventListener("click", () => openFolderPicker("dsPath", "Choose a LeRobot dataset folder"));
  $("#dsOpen").addEventListener("click", () => dsOpen());
  $("#dsPath").addEventListener("keydown", (e) => { if (e.key === "Enter") dsOpen(); });
  $("#epFilter").addEventListener("input", renderEpisodeList);

  $("#dsPlay").addEventListener("click", togglePlayback);
  $("#dsSlider").addEventListener("input", (e) => {
    if (DS.playing) stopPlayback();
    seekToFrame(Number(e.target.value));
  });
  $("#dsSpeed").addEventListener("change", (e) => {
    DS.speed = Number(e.target.value);
    Object.values(DS.videos).forEach((v) => { v.playbackRate = DS.speed; });
  });

  // render dialog
  $("#dsRenderBtn").addEventListener("click", openRenderDialog);
  $("#rdCancel").addEventListener("click", () => ($("#renderModal").hidden = true));
  $("#rdStart").addEventListener("click", startRender);
  $("#rdFormat").addEventListener("change", (e) => {
    $("#rdGifRow").hidden = e.target.value !== "gif";
  });
  $("#rdBrowse").addEventListener("click", () => openFolderPicker("rdOutDir", "Choose an output folder"));
  $("#rdUseView").addEventListener("click", () => {
    // "from the current frame to the end" is the common case for trimming a clip
    $("#rdFrom").value = String(DS.frame);
    $("#rdTo").value = String(DS.ep ? DS.ep.length - 1 : "");
    toast(`Range set to frames ${DS.frame}–${DS.ep.length - 1}`, "info", 3000);
  });

  $("#dsCamSize").addEventListener("input", (e) => {
    try { localStorage.setItem("hfutil.camSize", e.target.value); } catch { /* private mode */ }
    layoutCams();
  });
  let savedSize = 200;
  try { savedSize = Number(localStorage.getItem("hfutil.camSize")) || 200; } catch { /* ignore */ }
  $("#dsCamSize").value = String(savedSize);
  window.addEventListener("resize", layoutCams);

  // Keyboard transport, only while the LeRobot tab is showing and not typing in a field.
  document.addEventListener("keydown", (e) => {
    if ($("#lerobotView").hidden || !DS.ep) return;
    // Don't steal keys from an open modal (folder picker, confirm dialog, …).
    if (document.querySelector(".modal-backdrop:not([hidden])")) return;
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return;
    if (e.key === " ") { e.preventDefault(); togglePlayback(); }
    else if (e.key === "ArrowRight") { e.preventDefault(); stopPlayback(); seekToFrame(DS.frame + (e.shiftKey ? 10 : 1)); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); stopPlayback(); seekToFrame(DS.frame - (e.shiftKey ? 10 : 1)); }
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const i = DS.eps.findIndex((x) => x.ep === DS.ep.ep);
      const next = DS.eps[i + (e.key === "ArrowDown" ? 1 : -1)];
      if (next) {
        selectEpisode(next.ep);
        document.querySelector(`#epList .ep-row[data-ep="${next.ep}"]`)
          ?.scrollIntoView({ block: "nearest" });
      }
    }
  });

  try {
    const last = localStorage.getItem("hfutil.dsRoot");
    if (last) $("#dsPath").value = last;
  } catch { /* private mode */ }
}

/* ----------------------------------------------------------------------- *
 * Render dialog
 * ----------------------------------------------------------------------- */
/** "7", "0,3,5", "0-9" and combinations thereof -> a sorted list of valid episodes. */
function parseEpisodeSpec(text) {
  const valid = new Set(DS.eps.map((e) => e.ep));
  const out = new Set();
  for (const chunk of text.split(",")) {
    const part = chunk.trim();
    if (!part) continue;
    const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const [a, b] = [Number(range[1]), Number(range[2])].sort((x, y) => x - y);
      for (let i = a; i <= b; i++) if (valid.has(i)) out.add(i);
    } else if (/^\d+$/.test(part) && valid.has(Number(part))) {
      out.add(Number(part));
    }
  }
  return [...out].sort((a, b) => a - b);
}

async function openRenderDialog() {
  if (!DS.ep) return toast("Open a dataset and pick an episode first", "err");
  try {
    const caps = await api("/api/ds/capabilities");
    if (!caps.can_render) {
      return toast("ffmpeg not found — install it on PATH or `pip install imageio-ffmpeg`", "err", 12000);
    }
    $("#renderSub").textContent = caps.can_label
      ? `${DS.info.name} · ffmpeg from ${caps.ffmpeg_source}`
      : `${DS.info.name} · ffmpeg from ${caps.ffmpeg_source} — no usable font, overlays will be skipped`;
  } catch (e) {
    return toast(`Cannot check ffmpeg: ${e.message}`, "err");
  }

  $("#rdEpisodes").value = String(DS.ep.ep);
  $("#rdFrom").value = "0";
  $("#rdTo").value = "";
  const cams = $("#rdCameras");
  cams.replaceChildren(...Object.keys(DS.ep.videos).map((key) => {
    const cb = el("input", { type: "checkbox", value: key });
    return el("label", { className: "checkline" }, cb, el("span", {}, shortCam(key)));
  }));
  $("#rdGifRow").hidden = $("#rdFormat").value !== "gif";
  $("#renderModal").hidden = false;
}

async function startRender() {
  const episodes = parseEpisodeSpec($("#rdEpisodes").value);
  if (!episodes.length) return toast("No valid episodes in that list", "err");

  const cameras = [...document.querySelectorAll("#rdCameras input:checked")].map((c) => c.value);
  const toRaw = $("#rdTo").value.trim();
  const body = {
    root: DS.root,
    episodes,
    cameras,
    out_dir: $("#rdOutDir").value.trim() || null,
    fmt: $("#rdFormat").value,
    speed: Number($("#rdSpeed").value),
    height: Number($("#rdHeight").value) || 320,
    gif_fps: Number($("#rdGifFps").value) || 12,
    gif_width: Number($("#rdGifWidth").value) || 640,
    frame_start: Math.max(0, Number($("#rdFrom").value) || 0),
    frame_end: toRaw === "" ? null : Number(toRaw),
    show_camera_labels: $("#rdLabels").checked,
    show_counter: $("#rdCounter").checked,
    show_task: $("#rdTask").checked,
    write_metadata: $("#rdMeta").checked,
  };
  try {
    await api("/api/ds/render", { method: "POST", body });
    $("#renderModal").hidden = true;
    toast(`Rendering ${episodes.length} episode(s) — see the Transfer tab for progress`, "info", 7000);
  } catch (e) {
    toast(`Render failed to start: ${e.message}`, "err", 10000);
  }
}

/** Called by app.js when the LeRobot tab is shown or hidden. */
function dsOnTab(active) {
  if (!active) stopPlayback();
}

/** Called by app.js's Refresh button while the LeRobot tab is active. */
async function dsReload() {
  if (DS.root) await dsOpen(DS.root);
}

dsWire();
