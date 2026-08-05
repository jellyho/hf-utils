"use strict";

/* ----------------------------------------------------------------------- *
 * Subtask annotation.
 *
 * The interaction is deliberately two clicks and no typing: drag a span on the strip,
 * then click one of the labels you set up once. Segments live in
 * meta/lerobot_annotations.json until you export them, at which point they become a
 * subtask_index column plus meta/subtasks.parquet — the format lerobot 0.4.4 reads back
 * natively (verified: load_subtasks() parses it and .iloc[i].name returns the label).
 * ----------------------------------------------------------------------- */

const ANN = {
  doc: null,          // { labels: [], episodes: { "<ep>": [{start,end,label}] } }
  sel: null,          // { a, b } frame indices while selecting
  dragging: false,
  saveTimer: null,
};

// Distinct hues for segments. Identity here is carried by the label text printed on the
// segment as well, so colour is a secondary cue and may repeat past the palette.
const SEG_COLORS = [
  "#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#4a3aa7", "#008300", "#e34948",
];
const segColor = (label) => {
  const i = (ANN.doc?.labels || []).indexOf(label);
  return SEG_COLORS[(i < 0 ? 0 : i) % SEG_COLORS.length];
};

const annSegments = () => {
  if (!ANN.doc || !DS.ep) return [];
  return ANN.doc.episodes[String(DS.ep.ep)] || [];
};

/* ----------------------------------------------------------------------- *
 * Load / save
 * ----------------------------------------------------------------------- */
async function annLoad() {
  if (!DS.root) return;
  try {
    ANN.doc = await api(`/api/ds/annotations?root=${encodeURIComponent(DS.root)}`);
  } catch {
    ANN.doc = { version: 1, labels: [], episodes: {} };
  }
  if (!ANN.doc.labels?.length) {
    ANN.doc.labels = ["reach", "grasp", "lift", "place", "retreat"];
  }
  annRenderLabels();
  annRender();
}

/** Debounced: dragging a span emits a lot of edits and each one is a disk write. */
function annSave() {
  clearTimeout(ANN.saveTimer);
  ANN.saveTimer = setTimeout(async () => {
    if (!DS.root || !ANN.doc) return;
    try {
      await api("/api/ds/annotations", { method: "POST", body: { root: DS.root, doc: ANN.doc } });
    } catch (e) {
      toast(`Could not save annotations: ${e.message}`, "err", 8000);
    }
  }, 400);
}

/* ----------------------------------------------------------------------- *
 * Rendering
 * ----------------------------------------------------------------------- */
function annRenderLabels() {
  const box = $("#annotLabels");
  box.replaceChildren();
  for (const label of ANN.doc?.labels || []) {
    const chip = el("button", { className: "seg-chip", type: "button", title: `Assign "${label}"` },
      el("span", { className: "seg-dot", style: `background:${segColor(label)}` }),
      el("span", {}, label));
    chip.addEventListener("click", () => annAssign(label));
    box.append(chip);
  }
  const clear = el("button", { className: "seg-chip ghost", type: "button", title: "Remove segments overlapping the selection" }, "✕ erase");
  clear.addEventListener("click", annErase);
  const manage = el("button", { className: "seg-chip ghost", type: "button" }, "⚙ labels…");
  manage.addEventListener("click", annOpenLabelEditor);
  box.append(clear, manage);
}

function annRender() {
  const strip = $("#annotSegs");
  strip.replaceChildren();
  if (!DS.ep) return;
  const last = Math.max(1, DS.ep.length - 1);
  for (const seg of annSegments()) {
    const a = Math.min(seg.start, seg.end), b = Math.max(seg.start, seg.end);
    const box = el("div", { className: "annot-seg", title: `${seg.label}  ·  frames ${a}–${b}` },
      el("span", {}, seg.label));
    box.style.left = `${(a / last) * 100}%`;
    box.style.width = `${((b - a + 1) / last) * 100}%`;
    box.style.background = segColor(seg.label);
    strip.append(box);
  }
  annRenderSelection();
  annUpdateCursor();
}

function annRenderSelection() {
  const box = $("#annotSelBox");
  if (!ANN.sel || !DS.ep) {
    box.hidden = true;
    $("#annotSel").textContent = "no selection";
    return;
  }
  const last = Math.max(1, DS.ep.length - 1);
  const a = Math.min(ANN.sel.a, ANN.sel.b), b = Math.max(ANN.sel.a, ANN.sel.b);
  box.hidden = false;
  box.style.left = `${(a / last) * 100}%`;
  box.style.width = `${((b - a + 1) / last) * 100}%`;
  const fps = DS.fps || 1;
  $("#annotSel").textContent = `frames ${a}–${b} (${b - a + 1} · ${((b - a + 1) / fps).toFixed(2)}s)`;
}

function annUpdateCursor() {
  if (!DS.ep) return;
  const last = Math.max(1, DS.ep.length - 1);
  $("#annotCursor").style.left = `${(DS.frame / last) * 100}%`;
}

/* ----------------------------------------------------------------------- *
 * Selecting
 * ----------------------------------------------------------------------- */
function annFrameAt(clientX) {
  const r = $("#annotStrip").getBoundingClientRect();
  const frac = clamp((clientX - r.left) / r.width, 0, 1);
  return Math.round(frac * Math.max(0, DS.ep.length - 1));
}

function annWireStrip() {
  const strip = $("#annotStrip");
  strip.addEventListener("pointerdown", (e) => {
    if (!DS.ep) return;
    // Capture is a nicety (keeps the drag alive outside the strip); never let it abort
    // the selection if the browser refuses the pointer id.
    try { strip.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    ANN.dragging = true;
    const f = annFrameAt(e.clientX);
    ANN.sel = { a: f, b: f };
    stopPlayback();
    seekToFrame(f, true);
    annRenderSelection();
  });
  strip.addEventListener("pointermove", (e) => {
    if (!ANN.dragging || !DS.ep) return;
    ANN.sel.b = annFrameAt(e.clientX);
    seekToFrame(ANN.sel.b, true);   // scrub while dragging so you see the boundary
    annRenderSelection();
  });
  const end = (e) => {
    ANN.dragging = false;
    try { strip.releasePointerCapture(e.pointerId); } catch { /* never captured */ }
  };
  strip.addEventListener("pointerup", end);
  strip.addEventListener("pointercancel", end);
}

/* ----------------------------------------------------------------------- *
 * Assigning / erasing
 * ----------------------------------------------------------------------- */
/** Cut [a,b] out of any existing segment, so segments never overlap. */
function annCarve(segs, a, b) {
  const out = [];
  for (const s of segs) {
    const sa = Math.min(s.start, s.end), sb = Math.max(s.start, s.end);
    if (sb < a || sa > b) { out.push(s); continue; }      // untouched
    if (sa < a) out.push({ ...s, start: sa, end: a - 1 }); // keep the left remainder
    if (sb > b) out.push({ ...s, start: b + 1, end: sb }); // keep the right remainder
  }
  return out;
}

function annAssign(label) {
  if (!DS.ep) return;
  if (!ANN.sel) return toast("Drag a span on the strip first", "info");
  const a = Math.min(ANN.sel.a, ANN.sel.b), b = Math.max(ANN.sel.a, ANN.sel.b);
  const key = String(DS.ep.ep);
  const segs = annCarve(ANN.doc.episodes[key] || [], a, b);
  segs.push({ start: a, end: b, label });
  segs.sort((x, y) => x.start - y.start);
  ANN.doc.episodes[key] = segs;
  annSave();
  annRender();
  toast(`${label}: frames ${a}–${b}`, "ok", 2500);
}

function annErase() {
  if (!DS.ep || !ANN.sel) return toast("Drag a span on the strip first", "info");
  const a = Math.min(ANN.sel.a, ANN.sel.b), b = Math.max(ANN.sel.a, ANN.sel.b);
  const key = String(DS.ep.ep);
  const before = (ANN.doc.episodes[key] || []).length;
  const segs = annCarve(ANN.doc.episodes[key] || [], a, b);
  if (segs.length) ANN.doc.episodes[key] = segs; else delete ANN.doc.episodes[key];
  annSave();
  annRender();
  toast(`Erased over frames ${a}–${b} (${before} → ${segs.length} segments)`, "ok", 2500);
}

/* ----------------------------------------------------------------------- *
 * Label editor + export
 * ----------------------------------------------------------------------- */
function annOpenLabelEditor() {
  $("#lbText").value = (ANN.doc?.labels || []).join("\n");
  $("#labelModal").hidden = false;
  $("#lbText").focus();
}

function annSaveLabels() {
  const labels = $("#lbText").value.split("\n").map((s) => s.trim()).filter(Boolean);
  const seen = new Set();
  ANN.doc.labels = labels.filter((l) => (seen.has(l) ? false : seen.add(l)));
  annSave();
  annRenderLabels();
  annRender();
  $("#labelModal").hidden = true;
}

async function annExport() {
  const episodes = Object.keys(ANN.doc?.episodes || {}).length;
  if (!episodes) return toast("Nothing annotated yet", "err");
  const go = await confirmDelete({
    title: "Write subtasks into the dataset?",
    sub: `This adds a subtask_index column to every data file and writes ` +
         `meta/subtasks.parquet. ${episodes} episode(s) annotated. The files it touches ` +
         `are copied into .hfutil_bak/ first.`,
    items: (ANN.doc.labels || []).slice(0, 20),
  });
  if (!go) return;
  try {
    await api("/api/ds/edit/export-subtasks", { method: "POST", body: { root: DS.root } });
    toast("Exporting subtasks — see the Jobs tab", "info", 6000);
    loadJobs();
  } catch (e) {
    toast(`Export failed: ${e.message}`, "err", 10000);
  }
}

function annWire() {
  annWireStrip();
  $("#annotClearSel").addEventListener("click", () => { ANN.sel = null; annRenderSelection(); });
  $("#annotExport").addEventListener("click", annExport);
  $("#lbCancel").addEventListener("click", () => ($("#labelModal").hidden = true));
  $("#lbSave").addEventListener("click", annSaveLabels);

  // number keys assign the Nth label — the fast path once the palette is set up
  document.addEventListener("keydown", (e) => {
    if ($("#lerobotView").hidden || !DS.ep || !ANN.sel) return;
    if (document.querySelector(".modal-backdrop:not([hidden])")) return;
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return;
    if (!/^[1-9]$/.test(e.key)) return;
    const label = (ANN.doc?.labels || [])[Number(e.key) - 1];
    if (label) { e.preventDefault(); annAssign(label); }
  });
}

annWire();
