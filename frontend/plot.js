"use strict";

/* ----------------------------------------------------------------------- *
 * Per-episode timeseries, drawn as small multiples.
 *
 * A robot feature has 14–20 dimensions. Drawing them as 14 coloured lines in one
 * axis would need 14 categorical hues, which is not distinguishable (and not
 * colourblind-safe) at any size. So dimension identity is carried by POSITION —
 * one small chart per dimension — and colour is left to carry the only comparison
 * that matters here: commanded vs measured (action vs observation.state).
 *
 * Colours are the first three categorical slots of the validated palette. Verified
 * with the palette validator against this app's own surfaces (#ffffff / #171a21),
 * all-pairs: worst CVD ΔE 9.2 light / 9.4 dark, normal-vision 24.0 / 20.9. On the
 * light surface aqua sits at 2.82:1, which carries the "relief" obligation — met by
 * the always-visible legend labels and the per-chart value readout at the cursor.
 * ----------------------------------------------------------------------- */

const SERIES_COLORS = ["var(--series-1)", "var(--series-2)", "var(--series-3)"];
const MAX_SERIES = SERIES_COLORS.length;

const VB_W = 300;          // logical viewBox width; the SVG stretches to the cell
const VB_H = 64;
const PAD_Y = 4;

const PLOT = {
  keys: [],        // selected feature keys
  data: null,      // /api/ds/series payload
  cells: [],       // { dim, cursor, readouts: [{el, values}] }
  reqToken: 0,
};

/* ----------------------------------------------------------------------- *
 * Feature picker
 * ----------------------------------------------------------------------- */
function renderPlotPicker() {
  const box = $("#plotPicker");
  box.replaceChildren();
  const feats = (DS.info && DS.info.plottable) || [];
  if (!feats.length) {
    box.append(el("span", { className: "hint" }, "no plottable features"));
    return;
  }
  for (const f of feats) {
    const on = PLOT.keys.includes(f.key);
    const chip = el("button", {
      className: "chip" + (on ? " on" : ""),
      type: "button",
      title: `${f.key} · ${f.dims} dims`,
    }, shortFeat(f.key));
    if (on) {
      const slot = PLOT.keys.indexOf(f.key);
      chip.style.setProperty("--chip-color", SERIES_COLORS[slot]);
    }
    chip.addEventListener("click", () => toggleFeature(f.key));
    box.append(chip);
  }
}

const shortFeat = (key) => key.replace(/^observation\./, "obs.");

function toggleFeature(key) {
  const at = PLOT.keys.indexOf(key);
  if (at >= 0) {
    PLOT.keys.splice(at, 1);
  } else {
    if (PLOT.keys.length >= MAX_SERIES) {
      // Past three series the validated palette can no longer separate all pairs;
      // the fix is fewer series, not an invented fourth hue.
      return toast(`Up to ${MAX_SERIES} features at a time — deselect one first.`, "info");
    }
    PLOT.keys.push(key);
  }
  try { localStorage.setItem("hfutil.plotKeys", JSON.stringify(PLOT.keys)); } catch { /* ignore */ }
  renderPlotPicker();
  loadPlots();
}

/* ----------------------------------------------------------------------- *
 * Data + rendering
 * ----------------------------------------------------------------------- */
async function loadPlots() {
  const grid = $("#plotGrid");
  if (!DS.ep || !PLOT.keys.length) {
    PLOT.data = null;
    PLOT.cells = [];
    grid.replaceChildren();
    $("#plotLegend").replaceChildren();
    $("#plotEmpty").hidden = !DS.ep;
    return;
  }
  $("#plotEmpty").hidden = true;
  const token = ++PLOT.reqToken;
  try {
    const data = await api(
      `/api/ds/series?root=${encodeURIComponent(DS.root)}&ep=${DS.ep.ep}` +
      `&keys=${encodeURIComponent(PLOT.keys.join(","))}&max_points=500`);
    if (token !== PLOT.reqToken) return;   // a newer episode/selection won
    PLOT.data = data;
    renderPlots();
  } catch (e) {
    if (token === PLOT.reqToken) toast(`Plot failed: ${e.message}`, "err", 8000);
  }
}

function renderLegend() {
  const box = $("#plotLegend");
  box.replaceChildren();
  // A legend is always present for >= 2 series, and its visible labels are what
  // lets a sub-3:1 series colour be used at all.
  PLOT.keys.forEach((key, i) => {
    box.append(el("span", { className: "legend-item" },
      el("span", { className: "legend-swatch", style: `background:${SERIES_COLORS[i]}` }),
      el("span", {}, shortFeat(key))));
  });
}

function renderPlots() {
  const data = PLOT.data;
  const grid = $("#plotGrid");
  grid.replaceChildren();
  PLOT.cells = [];
  renderLegend();
  if (!data) return;

  const tMax = data.t.length ? data.t[data.t.length - 1] : 1;
  const dims = Math.max(...PLOT.keys.map((k) => (data.series[k] || { dims: 0 }).dims));

  for (let d = 0; d < dims; d++) {
    // Shared y-scale across the selected features for THIS dimension — that is the
    // whole point of overlaying commanded and measured.
    let lo = Infinity, hi = -Infinity;
    const lines = [];
    PLOT.keys.forEach((key, slot) => {
      const s = data.series[key];
      if (!s || d >= s.dims) return;
      const vals = s.values[d];
      for (const v of vals) { if (v < lo) lo = v; if (v > hi) hi = v; }
      lines.push({ slot, vals, key });
    });
    if (!lines.length) continue;
    if (!isFinite(lo)) { lo = 0; hi = 1; }
    if (hi - lo < 1e-9) { lo -= 0.5; hi += 0.5; }   // constant signal: centre it

    const xAt = (i) => (tMax > 0 ? (data.t[i] / tMax) * VB_W : 0);
    const yAt = (v) => VB_H - PAD_Y - ((v - lo) / (hi - lo)) * (VB_H - 2 * PAD_Y);

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${VB_W} ${VB_H}`);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.classList.add("plot-svg");

    const mk = (tag, attrs) => {
      const n = document.createElementNS("http://www.w3.org/2000/svg", tag);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
      return n;
    };

    // Recessive hairline baseline at zero when zero is in range.
    if (lo < 0 && hi > 0) {
      svg.append(mk("line", {
        x1: 0, x2: VB_W, y1: yAt(0), y2: yAt(0),
        class: "plot-zero", "vector-effect": "non-scaling-stroke",
      }));
    }

    for (const ln of lines) {
      const pts = ln.vals.map((v, i) => `${xAt(i).toFixed(2)},${yAt(v).toFixed(2)}`).join(" ");
      svg.append(mk("polyline", {
        points: pts, fill: "none", stroke: SERIES_COLORS[ln.slot],
        "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round",
        "vector-effect": "non-scaling-stroke",
      }));
    }

    const cursor = mk("line", {
      x1: 0, x2: 0, y1: 0, y2: VB_H,
      class: "plot-cursor", "vector-effect": "non-scaling-stroke",
    });
    svg.append(cursor);

    const name = (data.series[lines[0].key].names || [])[d] || `d${d}`;
    const readout = el("span", { className: "plot-val" });
    const cell = el("div", { className: "plot-cell" },
      el("div", { className: "plot-cell-head" },
        el("span", { className: "plot-name", title: name }, name), readout),
      svg);

    // Click/drag to seek — the plots and the video share one time cursor.
    const seekFromEvent = (e) => {
      const r = svg.getBoundingClientRect();
      const frac = clamp((e.clientX - r.left) / r.width, 0, 1);
      stopPlayback();
      seekToFrame(Math.round(frac * (DS.ep.length - 1)), true);
    };
    svg.addEventListener("pointerdown", (e) => {
      svg.setPointerCapture(e.pointerId);
      seekFromEvent(e);
    });
    svg.addEventListener("pointermove", (e) => { if (e.buttons & 1) seekFromEvent(e); });

    grid.append(cell);
    PLOT.cells.push({ dim: d, cursor, readout, lines });
  }
  updatePlotCursor();
}

/** Move the shared cursor and refresh the per-chart value readouts. Called on every
 *  seek, so it only touches attributes — no re-render. */
function updatePlotCursor() {
  const data = PLOT.data;
  if (!data || !DS.ep) return;
  const tMax = data.t.length ? data.t[data.t.length - 1] : 1;
  const tCur = DS.frame / (DS.fps || 1);
  const x = tMax > 0 ? clamp((tCur / tMax) * VB_W, 0, VB_W) : 0;
  const i = clamp(Math.round(DS.frame / (data.stride || 1)), 0, data.n - 1);

  for (const cell of PLOT.cells) {
    cell.cursor.setAttribute("x1", x);
    cell.cursor.setAttribute("x2", x);
    const parts = cell.lines.map((ln) => {
      const v = ln.vals[i];
      return v === undefined ? "–" : (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2));
    });
    cell.readout.textContent = parts.join(" / ");
  }
  $("#plotCursor").textContent = data.stride > 1 ? `1/${data.stride} samples` : "";
}

/** Called by dataset.js when the episode changes. */
function onEpisodeChangedForPlots() {
  loadPlots();
}

function plotInit() {
  try {
    const saved = JSON.parse(localStorage.getItem("hfutil.plotKeys") || "[]");
    if (Array.isArray(saved)) PLOT.keys = saved.slice(0, MAX_SERIES);
  } catch { /* ignore */ }
}

plotInit();
