"use strict";

/* -----------------------------------------------------------------------
 * Control-mode strip — where each frame came from: teleop, policy, an operator
 * intervention, a replay, or the homing tail.
 *
 * Read-only by design. The recorder owns writing observation.control_mode because it is the
 * thing that understands the robot's gripper layout; showing where it was written is useful
 * in any viewer, so that half lives here (see hfutil/dataset/profiles.py).
 *
 * The strip only appears for datasets that actually carry the feature — profile.control_mode
 * from /api/ds/open — the same detect-never-assume rule the outcomes row follows.
 *
 * Colour: only THREE of the five modes get a hue. Any two modes can end up touching on a
 * timeline, so this is an all-pairs palette problem, and the validated categorical palette
 * caps all-pairs at three slots — no 4- or 5-subset of it clears the normal-vision floor in
 * both themes (enumerated, not guessed). So the three that say *who is driving* take the
 * validated trio, and the two that mean "not live control" share one neutral, separated from
 * each other by a hatch rather than a hue. Every band is also named in the legend and on
 * hover, so identity is never colour alone.
 *
 * Reuses $, el, api, toast from app.js and DS/seekToFrame from dataset.js.
 * ----------------------------------------------------------------------- */

const CM = {
  values: [],    // per-frame mode number
  runs: [],      // [{mode, name, start, end}] contiguous, end inclusive
  names: {},     // number -> name, from the server's CONTROL_MODES
  shares: [],    // [{name, frames, pct}] biggest first — the per-episode summary
};

/** Modes that mean "not a live control decision" share the neutral fill. */
const CM_INERT = new Set(["replay", "homing"]);

function cmReset() {
  CM.values = []; CM.runs = []; CM.shares = [];
  $("#cmodeSegs").replaceChildren();
  $("#cmodeLegend").replaceChildren();
  $("#cmodeReadout").textContent = "";
}

/** Load the series for the open episode. Safe to call for datasets without the feature. */
async function cmLoad() {
  if (!DS.info?.profile?.control_mode || !DS.ep) { cmReset(); return; }
  const ep = DS.ep.ep;
  try {
    const data = await api(
      `/api/ds/control-mode?root=${encodeURIComponent(DS.root)}&ep=${ep}`);
    // A newer episode was picked while this was in flight — let that one win.
    if (!DS.ep || DS.ep.ep !== ep) return;
    CM.names = Object.fromEntries(
      Object.entries(data.modes || {}).map(([name, n]) => [Number(n), name]));
    CM.values = data.values || [];
  } catch {
    cmReset();
    return;                       // unreadable parquet; the rest of the viewer is unaffected
  }
  cmBuildRuns();
  cmRender();
}

function cmBuildRuns() {
  CM.runs = [];
  const counts = new Map();
  let start = 0;
  for (let i = 0; i < CM.values.length; i += 1) {
    const v = CM.values[i];
    counts.set(v, (counts.get(v) || 0) + 1);
    const last = i === CM.values.length - 1;
    if (last || CM.values[i + 1] !== v) {
      CM.runs.push({ mode: v, name: cmName(v), start, end: i });
      start = i + 1;
    }
  }
  const total = CM.values.length || 1;
  CM.shares = [...counts.entries()]
    .map(([v, n]) => ({ name: cmName(v), frames: n, pct: (n / total) * 100 }))
    .sort((a, b) => b.frames - a.frames);
}

const cmName = (v) => CM.names[v] ?? `mode ${v}`;

/** CSS class carrying the fill. Unknown modes fall back to the neutral rather than
 *  inventing a hue — a generated colour would sit outside the validated set. */
const cmClass = (name) =>
  ["teleop", "policy", "intervention"].includes(name) ? `cm-${name}`
    : name === "homing" ? "cm-homing"
      : CM_INERT.has(name) ? "cm-inert" : "cm-unknown";

function cmRender() {
  const row = $("#dsCmodeRow");
  if (!CM.runs.length) { cmReset(); row.hidden = !DS.info?.profile?.control_mode; return; }
  row.hidden = false;

  const total = CM.values.length;
  const segs = $("#cmodeSegs");
  segs.replaceChildren(...CM.runs.map((r) => {
    const n = r.end - r.start + 1;
    const seg = el("div", { className: `cmode-seg ${cmClass(r.name)}` });
    seg.style.left = `${(r.start / total) * 100}%`;
    seg.style.width = `${(n / total) * 100}%`;
    seg.title = `${r.name} · frames ${r.start}–${r.end}`;
    // Direct-label the wide bands; the legend and hover carry the narrow ones. This is
    // also the relief the light-mode contrast warning asks for.
    if (n / total > 0.12) seg.append(el("span", { className: "cmode-seglabel" }, r.name));
    return seg;
  }));

  // The legend doubles as the per-episode summary — one row, no duplicated numbers.
  // A mode that is present at all never rounds down to "0%": a single homing frame is
  // still a fact about the episode, and "homing 0%" reads as "no homing".
  const pct = (p) => (p > 0 && p < 0.5 ? "<1%" : `${p.toFixed(0)}%`);
  $("#cmodeLegend").replaceChildren(...CM.shares.map((s) =>
    el("span", { className: "cmode-key", title: `${s.frames} frames` },
      el("span", { className: `cmode-swatch ${cmClass(s.name)}` }),
      `${s.name} ${pct(s.pct)}`)));

  cmUpdateCursor();
}

function cmUpdateCursor() {
  if (!CM.values.length || !DS.ep) return;
  const pct = (DS.frame / Math.max(1, CM.values.length - 1)) * 100;
  $("#cmodeCursor").style.left = `${pct}%`;
}

/** frame under a pointer event on the strip */
function cmFrameAt(evt) {
  const box = $("#cmodeStrip").getBoundingClientRect();
  const f = ((evt.clientX - box.left) / Math.max(1, box.width)) * (CM.values.length - 1);
  return clamp(Math.round(f), 0, CM.values.length - 1);
}

function cmWire() {
  const strip = $("#cmodeStrip");

  strip.addEventListener("click", (e) => {
    if (!CM.values.length) return;
    stopPlayback();
    seekToFrame(cmFrameAt(e));
  });

  strip.addEventListener("mousemove", (e) => {
    if (!CM.values.length) return;
    const f = cmFrameAt(e);
    const run = CM.runs.find((r) => f >= r.start && f <= r.end);
    if (!run) return;
    const n = run.end - run.start + 1;
    $("#cmodeReadout").textContent =
      `${run.name} · frames ${run.start}–${run.end} (${n} · ${(n / DS.fps).toFixed(2)}s)`;
  });

  strip.addEventListener("mouseleave", () => { $("#cmodeReadout").textContent = ""; });
}

cmWire();
