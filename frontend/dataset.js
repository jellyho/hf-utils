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
  outcomes: {},        // episode -> success|fail|discard, only for datasets that have them
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
      `${fmtSpan(info.total_frames / (info.fps || 30))} · ` +
      `${info.total_frames.toLocaleString()} frames · ${info.fps} fps` +
      (info.robot_type ? ` · ${info.robot_type}` : "");
    (info.warnings || []).forEach((w) => toast(w, "err", 9000));
    if (!info.cameras.length) toast("This dataset has no video features to play.", "err", 8000);

    DS.outcomes = {};
    if (info.profile?.outcomes) {
      try {
        DS.outcomes = (await api(`/api/ds/outcomes?root=${encodeURIComponent(info.root)}`)).outcomes;
      } catch { /* sidecar unreadable; carry on without it */ }
    }
    $("#dsOutcomeRow").hidden = !info.profile?.outcomes;
    // Same detect-never-assume rule: the strip exists only where the feature does.
    $("#dsCmodeRow").hidden = !info.profile?.control_mode;

    $("#dsCams").replaceChildren();
    renderEpisodeList();
    renderPlotPicker();
    if (typeof annLoad === "function") await annLoad();
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

/** Longer spans than fmtDur: "3h 12m" reads better than "192m 30.0s" for a whole dataset. */
function fmtSpan(seconds) {
  if (!isFinite(seconds) || seconds <= 0) return "0m";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h) return `${h}h ${m}m`;
  const s = Math.round(seconds % 60);
  return m ? `${m}m ${s}s` : `${s}s`;
}

/* How much footage the dataset holds, split by outcome — "how many hours of successes do
 * I actually have?" is the question you ask before training on it, and counting episodes
 * does not answer it when they range from 30s to 2 minutes.
 *
 * Follows the filter, so filtering to one task gives that task's hours. With the filter
 * empty (the default) that is the whole dataset. */
function renderEpisodeStats(rows) {
  const box = $("#epStats");
  const fps = DS.fps || 30;
  if (!rows.length) { box.replaceChildren(); return; }

  const frames = new Map();
  let total = 0;
  for (const e of rows) {
    total += e.length;
    const key = DS.outcomes[String(e.ep)] || "unmarked";
    frames.set(key, (frames.get(key) || 0) + e.length);
  }

  const parts = [el("span", { className: "ep-stat total" },
    `${fmtSpan(total / fps)} total`)];
  // Fixed order so the row doesn't reshuffle as the filter changes; only what is present.
  for (const key of ["success", "fail", "discard", "unmarked"]) {
    const n = frames.get(key);
    if (!n) continue;
    const mark = { success: "✓", fail: "✗", discard: "·", unmarked: "–" }[key];
    const pct = Math.round((n / total) * 100);
    parts.push(el("span", { className: `ep-stat ${key}`, title: `${pct}% of the shown footage` },
      `${mark} ${fmtSpan(n / fps)}`));
  }
  box.replaceChildren(...parts);
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
    // Only datasets that actually carry an outcomes sidecar get this column.
    const outcome = DS.outcomes[String(e.ep)];
    if (outcome) {
      row.classList.add("has-outcome");
      row.prepend(el("span", { className: `ep-outcome ${outcome}`, title: outcome },
        { success: "✓", fail: "✗", discard: "·" }[outcome] || "?"));
    }
    row.addEventListener("click", () => selectEpisode(e.ep));
    list.append(row);
  }
  if (rows.length > shown.length) {
    list.append(el("div", { className: "fs-note" },
      `showing first ${shown.length} of ${rows.length} — use the filter to narrow`));
  }
  if (!rows.length) list.append(el("div", { className: "fs-empty" }, "no episodes match"));
  $("#epCount").textContent = `${rows.length} / ${DS.eps.length}`;
  renderEpisodeStats(rows);
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
  renderOutcome();
  if (typeof cmLoad === "function") cmLoad();
  if (typeof annRender === "function") { ANN.sel = null; annRender(); }
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
  if (typeof annUpdateCursor === "function") annUpdateCursor();
  if (typeof cmUpdateCursor === "function") cmUpdateCursor();
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

  // editing
  $("#dsEditTaskBtn").addEventListener("click", openTaskDialog);
  $("#tkCancel").addEventListener("click", () => ($("#taskModal").hidden = true));
  $("#tkSave").addEventListener("click", saveTask);
  $("#dsDeleteBtn").addEventListener("click", deleteEpisodesDialog);
  document.querySelectorAll("#dsOutcomeRow .btn").forEach((b) =>
    b.addEventListener("click", () => setOutcome(b.dataset.outcome)));
  $("#dsCheckBtn").addEventListener("click", runCheck);
  $("#ckClose").addEventListener("click", () => ($("#checkModal").hidden = true));
  $("#ckRerun").addEventListener("click", runCheck);
  $("#ckRepair").addEventListener("click", repairTimestamps);
  $("#dsSplitBtn").addEventListener("click", openSplitDialog);
  $("#spCancel").addEventListener("click", () => ($("#splitModal").hidden = true));
  $("#spText").addEventListener("input", splitPreview);
  $("#spBrowse").addEventListener("click", () => openFolderPicker("spOutDir", "Choose an output folder"));
  $("#spStart").addEventListener("click", startSplit);
  $("#dsMergeBtn").addEventListener("click", openMergeDialog);
  $("#mgCancel").addEventListener("click", () => ($("#mergeModal").hidden = true));
  $("#mgBrowse").addEventListener("click", () => openFolderPicker("mgAddPath", "Choose a dataset to merge in"));
  $("#mgOutBrowse").addEventListener("click", () => openFolderPicker("mgOutDir", "Choose the output folder"));
  $("#mgAdd").addEventListener("click", addMergeSource);
  $("#mgAddPath").addEventListener("keydown", (e) => { if (e.key === "Enter") addMergeSource(); });
  $("#mgStart").addEventListener("click", startMerge);

  // render dialog
  $("#dsRenderBtn").addEventListener("click", openRenderDialog);
  $("#rdCancel").addEventListener("click", () => ($("#renderModal").hidden = true));
  $("#rdStart").addEventListener("click", startRender);
  $("#rdFormat").addEventListener("change", (e) => {
    $("#rdGifRow").hidden = e.target.value !== "gif";
  });
  $("#rdBrowse").addEventListener("click", () => openFolderPicker("rdOutDir", "Choose an output folder"));
  $("#rdEpFilter").addEventListener("input", rdRenderEpisodes);
  $("#rdFrom").addEventListener("input", () => syncRange("from"));
  $("#rdTo").addEventListener("input", () => syncRange("to"));
  $("#rdUseView").addEventListener("click", () => {
    if (!DS.ep) return;
    $("#rdFrom").value = String(DS.frame);
    if (Number($("#rdTo").value) < DS.frame) $("#rdTo").value = String(DS.ep.length - 1);
    syncRange("from");
  });
  $("#rdFullRange").addEventListener("click", () => {
    if (!DS.ep) return;
    $("#rdFrom").value = "0";
    $("#rdTo").value = String(DS.ep.length - 1);
    syncRange();
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

  RD.sel = new Set([DS.ep.ep]);       // start on the episode you were watching
  $("#rdEpFilter").value = "";
  rdRenderEpisodes();
  setRangeBounds(DS.ep.length - 1);
  $("#rdFrom").value = "0";
  $("#rdTo").value = String(DS.ep.length - 1);
  syncRange();
  RD.cams = Object.keys(DS.ep.videos);      // info.json order to start with
  RD.camOn = new Set(RD.cams);
  rdRenderCameras();
  $("#rdGifRow").hidden = $("#rdFormat").value !== "gif";
  $("#renderModal").hidden = false;
  rdPreviewLoad();
}

/* ---- bulk episode selection ------------------------------------------- *
 * Typing "0,3,5-9" was fine for one or two episodes and useless for picking, say, every
 * failed run out of 54 — you had to cross-reference the list behind the modal and count.
 * So the modal carries the episode list itself, with the outcome marker the sidebar shows,
 * and the quick-select chips do the cross-referencing for you. */
const RD = { sel: new Set(), cams: [], camOn: new Set() };

/* ---- camera order ------------------------------------------------------ *
 * ffmpeg hstacks the panels in the order it is given them, and RenderOptions.cameras has
 * always been an ordered list — the dialog just had no way to say anything but "these ones,
 * in info.json order". A plain checkbox grid cannot express order at all, so the cameras
 * become a reorderable list and the request always names them explicitly. */

/** The ticked cameras, in the order the list shows them = left to right in the output. */
const rdCamOrder = () => RD.cams.filter((k) => RD.camOn.has(k));

function rdRenderCameras() {
  const order = rdCamOrder();
  $("#rdCameras").replaceChildren(...RD.cams.map((key, i) => {
    const on = RD.camOn.has(key);
    const row = el("div", { className: "cam-row" + (on ? "" : " off") });
    const cb = el("input", { type: "checkbox", value: key, checked: on });
    cb.addEventListener("change", () => {
      cb.checked ? RD.camOn.add(key) : RD.camOn.delete(key);
      rdRenderCameras();
      rdPreviewLoad();          // the preview follows the first ticked camera
    });
    const move = (delta, label, disabled) => {
      const b = el("button", { className: "btn tiny ghost", type: "button", disabled }, label);
      b.addEventListener("click", (e) => { e.preventDefault(); rdMoveCamera(i, delta); });
      return b;
    };
    row.append(
      cb,
      el("span", { className: "cam-pos" }, on ? String(order.indexOf(key) + 1) : "–"),
      el("span", { className: "cam-name" }, shortCam(key)),
      move(-1, "↑", i === 0),
      move(1, "↓", i === RD.cams.length - 1));
    return row;
  }));
}

function rdMoveCamera(i, delta) {
  const j = i + delta;
  if (j < 0 || j >= RD.cams.length) return;
  [RD.cams[i], RD.cams[j]] = [RD.cams[j], RD.cams[i]];
  rdRenderCameras();
  rdPreviewLoad();
}

const RD_OUTCOME_MARK = { success: "✓", fail: "✗", discard: "·" };

function rdVisibleEpisodes() {
  const q = $("#rdEpFilter").value.trim().toLowerCase();
  if (!q) return DS.eps;
  return DS.eps.filter((e) =>
    String(e.ep).includes(q) || (e.tasks[0] || "").toLowerCase().includes(q));
}

function rdRenderEpisodes() {
  const rows = rdVisibleEpisodes();
  const list = $("#rdEpList");
  list.replaceChildren(...rows.map((e) => {
    // /api/ds/outcomes maps episode -> the outcome *string*, not a row object.
    const outcome = DS.outcomes[String(e.ep)] || null;
    const row = el("div", { className: "rd-eprow" + (RD.sel.has(e.ep) ? " on" : "") });
    const cb = el("input", { type: "checkbox", checked: RD.sel.has(e.ep) });
    cb.addEventListener("change", () => {
      cb.checked ? RD.sel.add(e.ep) : RD.sel.delete(e.ep);
      rdRenderEpisodes();
    });
    row.append(cb,
      el("span", { className: "ep-idx" }, `#${e.ep}`),
      el("span", { className: `ep-outcome ${outcome || ""}`, title: outcome || "no outcome recorded" },
        outcome ? RD_OUTCOME_MARK[outcome] : "–"),
      el("span", { className: "ep-len" }, `${e.length}f`),
      el("span", { className: "ep-dur" }, fmtDur(e.length / DS.fps)),
      el("span", { className: "ep-task" }, e.tasks[0] || "(no task)"));
    row.addEventListener("click", (ev) => { if (ev.target !== cb) cb.click(); });
    return row;
  }));
  if (!rows.length) list.append(el("div", { className: "pk-note" }, "No episodes match."));

  rdRenderPresets();
  const frames = DS.eps.filter((e) => RD.sel.has(e.ep)).reduce((a, e) => a + e.length, 0);
  $("#rdEpCount").textContent =
    `${RD.sel.size} of ${DS.eps.length} selected · ${frames.toLocaleString()} frames`;
  $("#rdStart").disabled = RD.sel.size === 0;
  $("#rdStart").textContent = RD.sel.size > 1 ? `Render ${RD.sel.size} episodes` : "Render";

  // Trimming is per-episode; with more than one selected there is no shared frame range.
  const single = RD.sel.size === 1;
  $("#rdRangeField").hidden = !single;
  if (single) {
    const only = DS.eps.find((e) => e.ep === [...RD.sel][0]);
    if (only) {
      setRangeBounds(only.length - 1);
      if (Number($("#rdTo").value) > only.length - 1) $("#rdTo").value = String(only.length - 1);
      syncRange();
    }
  }
}

function rdRenderPresets() {
  const chip = (label, fn, title) => {
    const b = el("button", { className: "chip", type: "button", title: title || label }, label);
    b.style.setProperty("--chip-color", "var(--accent-2)");
    b.addEventListener("click", () => { fn(); rdRenderEpisodes(); });
    return b;
  };
  // Chips act on what the filter is showing, so "All" after a filter means "all of these".
  const shown = () => rdVisibleEpisodes();
  const byOutcome = (want) => shown().filter((e) =>
    (DS.outcomes[String(e.ep)] || null) === want);

  const chips = [
    chip("All", () => shown().forEach((e) => RD.sel.add(e.ep)), "Select every episode shown"),
    chip("None", () => RD.sel.clear(), "Clear the selection"),
  ];
  // Only offer outcome filters for datasets that actually carry the sidecar.
  if (DS.info?.profile?.outcomes) {
    for (const [key, mark] of Object.entries(RD_OUTCOME_MARK)) {
      const n = byOutcome(key).length;
      if (!n) continue;
      chips.push(chip(`${mark} ${key} (${n})`,
        () => byOutcome(key).forEach((e) => RD.sel.add(e.ep)),
        `Add the ${n} ${key} episode(s) to the selection`));
    }
    const none = byOutcome(null).length;
    if (none) {
      chips.push(chip(`– unmarked (${none})`,
        () => byOutcome(null).forEach((e) => RD.sel.add(e.ep)),
        `Add the ${none} episode(s) with no outcome recorded`));
    }
  }
  $("#rdEpPresets").replaceChildren(...chips);
}

/** Point the two range inputs at this episode's frame count. */
function setRangeBounds(maxFrame) {
  for (const id of ["#rdFrom", "#rdTo"]) {
    $(id).max = String(Math.max(0, maxFrame));
    $(id).min = "0";
  }
}

/* ---- trim previews ---------------------------------------------------- *
 * Both endpoints are shown as stills from the same shared mp4 the viewer already
 * streams, so the browser serves them out of the byte ranges it has cached. */
const rdPreviewCam = () => {
  if (!DS.ep) return null;
  const keys = Object.keys(DS.ep.videos);
  return rdCamOrder().find((k) => keys.includes(k)) || keys[0] || null;
};

async function rdPreviewLoad() {
  const key = rdPreviewCam();
  const els = [$("#rdPrevFrom"), $("#rdPrevTo")];
  if (!key || !DS.ep) { els.forEach((v) => { v.removeAttribute("src"); }); return; }
  const w = DS.ep.videos[key];
  const abs = new URL(dsVideoUrl(key, w.chunk, w.file), location.href).href;
  await Promise.all(els.map((v) => {
    if (v.src === abs) return Promise.resolve();
    v.src = abs;
    return new Promise((res) => {
      const done = () => res();
      v.addEventListener("loadedmetadata", done, { once: true });
      v.addEventListener("error", done, { once: true });
      setTimeout(done, 10000);
    });
  }));
  rdPreviewSeek();
}

/** Park each preview on its endpoint frame. */
function rdPreviewSeek() {
  const key = rdPreviewCam();
  if (!key || !DS.ep) return;
  const w = DS.ep.videos[key];
  const fps = DS.fps || 1;
  const eps = 0.5 / fps;
  const pairs = [
    [$("#rdPrevFrom"), Number($("#rdFrom").value), $("#rdPrevFromCap")],
    [$("#rdPrevTo"), Number($("#rdTo").value), $("#rdPrevToCap")],
  ];
  for (const [video, frame, cap] of pairs) {
    if (!video.src) continue;
    const t = Math.min(w.from_timestamp + frame / fps, w.to_timestamp - eps);
    if (Math.abs(video.currentTime - t) > eps) video.currentTime = t;
    cap.textContent = `f${frame} · ${(frame / fps).toFixed(2)}s`;
  }
}

/** Keep the handles from crossing, then repaint the fill and the readout. */
function syncRange(pushed) {
  const from = $("#rdFrom"), to = $("#rdTo");
  let a = Number(from.value), b = Number(to.value);
  if (a > b) {
    // Whichever handle the user moved wins; the other one follows it.
    if (pushed === "from") { b = a; to.value = String(b); }
    else { a = b; from.value = String(a); }
  }
  const max = Number(from.max) || 1;
  $("#rdFill").style.left = `${(a / max) * 100}%`;
  $("#rdFill").style.width = `${((b - a) / max) * 100}%`;
  const fps = DS.fps || 1;
  $("#rdRangeText").textContent =
    `${a} – ${b}  (${b - a + 1} frames · ${((b - a + 1) / fps).toFixed(2)}s)`;
  rdPreviewSeek();
}

async function startRender() {
  const episodes = [...RD.sel].sort((a, b) => a - b);
  if (!episodes.length) return toast("Tick at least one episode", "err");
  const single = episodes.length === 1;

  // Always explicit, and in list order — the server stacks them left to right as given.
  const cameras = rdCamOrder();
  if (!cameras.length) return toast("Tick at least one camera", "err");
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
    // A trim belongs to one episode's timeline. Across a bulk selection there is no shared
    // range, so every episode renders in full rather than being cut to the first one's.
    frame_start: single ? Math.max(0, Number($("#rdFrom").value) || 0) : 0,
    frame_end: single ? Number($("#rdTo").value) : null,
    show_camera_labels: $("#rdLabels").checked,
    show_counter: $("#rdCounter").checked,
    show_task: $("#rdTask").checked,
    write_metadata: $("#rdMeta").checked,
    zip_output: $("#rdZip").checked,
  };
  try {
    await api("/api/ds/render", { method: "POST", body });
    $("#renderModal").hidden = true;
    toast(`Rendering ${episodes.length} episode(s)${$("#rdZip").checked ? " + zip" : ""}`
          + " — see the Jobs tab for progress", "info", 7000);
    loadJobs();   // start the badge ticking straight away
  } catch (e) {
    toast(`Render failed to start: ${e.message}`, "err", 10000);
  }
}

/* ----------------------------------------------------------------------- *
 * Editing: task text, episode deletion
 * ----------------------------------------------------------------------- */
function openTaskDialog() {
  if (!DS.ep) return toast("Pick an episode first", "err");
  $("#taskSub").textContent = `${DS.info.name} · ${DS.eps.length} episodes`;
  $("#tkEpisodes").value = String(DS.ep.ep);
  $("#tkText").value = DS.ep.tasks[0] || "";
  const known = $("#tkKnown");
  known.replaceChildren();
  for (const t of DS.info.tasks || []) {
    const chip = el("button", { className: "chip", type: "button", title: t },
      t.length > 46 ? t.slice(0, 45) + "…" : t);
    chip.addEventListener("click", () => { $("#tkText").value = t; });
    known.append(chip);
  }
  $("#taskModal").hidden = false;
  $("#tkText").focus();
}

async function saveTask() {
  const episodes = parseEpisodeSpec($("#tkEpisodes").value);
  if (!episodes.length) return toast("No valid episodes in that list", "err");
  const text = $("#tkText").value.trim();
  if (!text) return toast("Task text cannot be empty", "err");
  const episode_tasks = Object.fromEntries(episodes.map((e) => [e, text]));
  try {
    await api("/api/ds/edit/tasks", { method: "POST", body: { root: DS.root, episode_tasks } });
    $("#taskModal").hidden = true;
    toast(`Updating task on ${episodes.length} episode(s) — see the Jobs tab`, "info", 6000);
    loadJobs();
    watchEditJob();
  } catch (e) {
    toast(`Could not update task: ${e.message}`, "err", 10000);
  }
}

async function deleteEpisodesDialog() {
  if (!DS.ep) return toast("Open a dataset first", "err");
  const spec = window.prompt(
    `Delete which episodes? (e.g. ${DS.ep.ep}, or 0,3,5, or 0-9)\n\n` +
    "The dataset is re-indexed afterwards, and the original is kept as a .backup- folder.",
    String(DS.ep.ep));
  if (spec === null) return;
  const episodes = parseEpisodeSpec(spec);
  if (!episodes.length) return toast("No valid episodes in that list", "err");
  if (episodes.length >= DS.eps.length) return toast("Cannot delete every episode", "err");

  const go = await confirmDelete({
    title: `Delete ${episodes.length} episode(s)?`,
    sub: "The dataset is rebuilt without them and every later episode is renumbered. " +
         "The original is moved aside as a .backup- folder next to the dataset.",
    items: episodes.map((e) => {
      const row = DS.eps.find((x) => x.ep === e);
      return `episode ${e} · ${row ? row.length : "?"} frames · ${row ? (row.tasks[0] || "") : ""}`;
    }),
  });
  if (!go) return;
  try {
    await api("/api/ds/edit/delete-episodes", { method: "POST", body: { root: DS.root, episodes } });
    toast(`Deleting ${episodes.length} episode(s) — see the Jobs tab`, "info", 6000);
    loadJobs();
    watchEditJob();
  } catch (e) {
    toast(`Delete failed to start: ${e.message}`, "err", 12000);
  }
}

/* ---- outcomes (only for datasets that carry the sidecar) ---------------- */
async function setOutcome(outcome) {
  if (!DS.ep) return;
  try {
    await api("/api/ds/outcomes", {
      method: "POST", body: { root: DS.root, episode: DS.ep.ep, outcome },
    });
    DS.outcomes[String(DS.ep.ep)] = outcome;
    renderOutcome();
    renderEpisodeList();
    toast(`Episode ${DS.ep.ep}: ${outcome}`, "ok", 2000);
  } catch (e) { toast(`Could not set outcome: ${e.message}`, "err", 8000); }
}

function renderOutcome() {
  const now = DS.ep ? DS.outcomes[String(DS.ep.ep)] : null;
  $("#dsOutcomeNow").textContent = now ? now : "not set";
  document.querySelectorAll("#dsOutcomeRow .btn").forEach((b) => {
    b.classList.toggle("primary", b.dataset.outcome === now);
  });
}

/* ---- health check ------------------------------------------------------ */
async function runCheck() {
  if (!DS.root) return toast("Open a dataset first", "err");
  const deep = $("#ckDeep").checked;
  $("#checkModal").hidden = false;
  $("#ckSub").textContent = deep ? "checking (reading every video)…" : "checking…";
  $("#ckBody").replaceChildren();
  $("#ckRepair").hidden = true;
  try {
    const res = await api(
      `/api/ds/check?root=${encodeURIComponent(DS.root)}&deep_video=${deep}`);
    $("#ckSub").textContent =
      `${res.episodes} episodes · ${res.total_frames.toLocaleString()} frames · ${res.fps} fps · ` +
      `${res.cameras.length} camera(s)` + (res.videos_checked ? ` · ${res.videos_checked} video file(s) read` : "");

    const body = $("#ckBody");
    if (res.ok) {
      body.append(el("p", { className: "check-ok" }, "✓ No problems found."));
      return;
    }
    const byKind = {};
    for (const p of res.problems) (byKind[p.kind] ||= []).push(p);
    for (const [kind, list] of Object.entries(byKind)) {
      body.append(el("h4", { className: "check-kind" }, `${kind} — ${list.length}`));
      const ul = el("ul", { className: "confirm-list" });
      for (const p of list.slice(0, 40)) ul.append(el("li", {}, p.message));
      if (list.length > 40) ul.append(el("li", {}, `… and ${list.length - 40} more`));
      body.append(ul);
    }
    // Timestamp drift is the one thing we can fix safely, and it is what makes
    // lerobot's delete_episodes assert.
    $("#ckRepair").hidden = !byKind.timestamp;
  } catch (e) {
    $("#ckSub").textContent = "";
    $("#ckBody").replaceChildren(el("p", { className: "warn" }, `Check failed: ${e.message}`));
  }
}

async function repairTimestamps() {
  try {
    const res = await api("/api/ds/repair/timestamps", { method: "POST", body: { root: DS.root } });
    toast(`Repaired ${res.fixed} timestamp(s) — originals in .hfutil_bak/`, "ok", 6000);
    await dsOpen(DS.root);
    runCheck();
  } catch (e) { toast(`Repair failed: ${e.message}`, "err", 10000); }
}

/* ---- split ------------------------------------------------------------ */
/** "train = 0.8" or "train = 0,3,5-9" per line. */
function parseSplitSpec(text, total) {
  const splits = {};
  let mode = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^([^=]+)=(.+)$/);
    if (!m) throw new Error(`cannot parse "${line}" — use  name = 0.8  or  name = 0,3,5-9`);
    const name = m[1].trim(), value = m[2].trim();
    if (!name) throw new Error("split name cannot be empty");
    if (/^[0-9]*\.?[0-9]+$/.test(value) && Number(value) <= 1) {
      if (mode === "list") throw new Error("use either fractions or episode lists, not both");
      mode = "fraction";
      splits[name] = Number(value);
    } else {
      if (mode === "fraction") throw new Error("use either fractions or episode lists, not both");
      mode = "list";
      const eps = parseEpisodeSpec(value);
      if (!eps.length) throw new Error(`"${value}" matched no episodes`);
      splits[name] = eps;
    }
  }
  if (Object.keys(splits).length < 2) throw new Error("give at least two splits");
  if (mode === "fraction") {
    const sum = Object.values(splits).reduce((a, b) => a + b, 0);
    if (Math.abs(sum - 1) > 1e-6) throw new Error(`fractions must sum to 1 (they sum to ${sum.toFixed(3)})`);
  }
  return { splits, mode };
}

function splitPreview() {
  const box = $("#spPreview");
  if (!DS.eps.length) return;
  try {
    const { splits, mode } = parseSplitSpec($("#spText").value, DS.eps.length);
    const parts = Object.entries(splits).map(([name, v]) =>
      mode === "fraction"
        ? `${name}: ~${Math.round(v * DS.eps.length)} ep`
        : `${name}: ${v.length} ep`);
    box.textContent = parts.join("   ·   ");
    box.classList.remove("bad");
  } catch (e) {
    box.textContent = e.message;
    box.classList.add("bad");
  }
}

function openSplitDialog() {
  if (!DS.root) return toast("Open a dataset first", "err");
  $("#splitSub").textContent = `${DS.info.name} · ${DS.eps.length} episodes`;
  $("#spText").value = "train = 0.8\nval = 0.2";
  $("#spOutDir").value = "";
  splitPreview();
  $("#splitModal").hidden = false;
}

async function startSplit() {
  let splits;
  try { ({ splits } = parseSplitSpec($("#spText").value, DS.eps.length)); }
  catch (e) { return toast(e.message, "err", 8000); }
  try {
    await api("/api/ds/edit/split", {
      method: "POST",
      body: { root: DS.root, splits, out_dir: $("#spOutDir").value.trim() || null },
    });
    $("#splitModal").hidden = true;
    toast("Splitting — see the Jobs tab", "info", 6000);
    loadJobs();
  } catch (e) { toast(`Split failed to start: ${e.message}`, "err", 10000); }
}

/* ---- merge ------------------------------------------------------------ */
const MERGE = { roots: [] };

function renderMergeList() {
  const box = $("#mgList");
  box.replaceChildren();
  MERGE.roots.forEach((path, i) => {
    const row = el("div", { className: "merge-row" },
      el("span", { className: "merge-idx" }, `${i + 1}`),
      el("span", { className: "merge-path", title: path }, path));
    if (i > 0) {
      const rm = el("button", { className: "btn tiny ghost", type: "button", title: "Remove" }, "✕");
      rm.addEventListener("click", () => { MERGE.roots.splice(i, 1); renderMergeList(); });
      row.append(rm);
    } else {
      row.append(el("span", { className: "hint" }, "open dataset"));
    }
    box.append(row);
  });
}

function openMergeDialog() {
  if (!DS.root) return toast("Open a dataset first", "err");
  MERGE.roots = [DS.root];
  $("#mgAddPath").value = "";
  $("#mgOutDir").value = "";
  renderMergeList();
  $("#mergeModal").hidden = false;
}

async function addMergeSource() {
  const path = $("#mgAddPath").value.trim();
  if (!path) return;
  if (MERGE.roots.includes(path)) return toast("Already in the list", "info");
  try {
    const info = await api(`/api/ds/open?root=${encodeURIComponent(path)}`);
    if (info.fps !== DS.info.fps) {
      return toast(`fps mismatch: ${info.name} is ${info.fps}, this one is ${DS.info.fps}`, "err", 9000);
    }
    MERGE.roots.push(info.root);
    $("#mgAddPath").value = "";
    renderMergeList();
    toast(`Added ${info.name} (${info.total_episodes} episodes)`, "ok");
  } catch (e) { toast(`Not a usable dataset: ${e.message}`, "err", 9000); }
}

async function startMerge() {
  if (MERGE.roots.length < 2) return toast("Add at least one more dataset", "err");
  const out = $("#mgOutDir").value.trim();
  if (!out) return toast("Choose an output folder", "err");
  try {
    await api("/api/ds/edit/merge", { method: "POST", body: { roots: MERGE.roots, out_dir: out } });
    $("#mergeModal").hidden = true;
    toast("Merging — see the Jobs tab", "info", 6000);
    loadJobs();
  } catch (e) { toast(`Merge failed to start: ${e.message}`, "err", 10000); }
}

/** After a mutating job finishes, the on-disk state (and episode numbering) has moved —
 *  reload rather than leaving the UI pointing at stale rows. */
function watchEditJob() {
  const started = Date.now();
  const timer = setInterval(async () => {
    try {
      const data = await api("/api/jobs");
      const busy = data.jobs.some((j) =>
        j.status === "running" && String(j.kind).startsWith("ds_") && j.kind !== "ds_render");
      if (!busy) {
        clearInterval(timer);
        await dsOpen(DS.root);
        if (typeof annLoad === "function") annLoad();
      }
    } catch { /* transient */ }
    if (Date.now() - started > 10 * 60 * 1000) clearInterval(timer);
  }, 1500);
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
