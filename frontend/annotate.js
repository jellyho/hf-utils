"use strict";

/* ----------------------------------------------------------------------- *
 * Subtask annotation.
 *
 * Segments are BLOCKS, not just a record of the drag that made them: once created you
 * can click one to select it, drag its body to move it, drag either edge to resize, and
 * erase it outright. Moving and resizing clamp against the neighbours, so blocks butt up
 * against each other and can never overlap.
 *
 * On disk they live in meta/lerobot_annotations.json until you export, at which point
 * they become a subtask_index column plus meta/subtasks.parquet — the format lerobot
 * 0.4.4 reads back natively (dataset[i]["subtask"] returns the label).
 * ----------------------------------------------------------------------- */

const ANN = {
  doc: null,
  sel: null,       // {kind:"range", a, b}  |  {kind:"seg", i}
  drag: null,      // {mode:"range"|"move"|"resize-l"|"resize-r", …}
  saveTimer: null,
};

const SEG_COLORS = [
  "#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#4a3aa7", "#008300", "#e34948",
];
const segColor = (label) => {
  const i = (ANN.doc?.labels || []).indexOf(label);
  return SEG_COLORS[(i < 0 ? 0 : i) % SEG_COLORS.length];
};

const EDGE_PX = 7;          // grab zone for resizing
const annKey = () => String(DS.ep?.ep ?? "");
const annSegs = () => (ANN.doc && DS.ep ? (ANN.doc.episodes[annKey()] || []) : []);
const setSegs = (segs) => {
  if (!ANN.doc || !DS.ep) return;
  segs.sort((a, b) => a.start - b.start);
  if (segs.length) ANN.doc.episodes[annKey()] = segs;
  else delete ANN.doc.episodes[annKey()];
};
const lastFrame = () => Math.max(0, (DS.ep?.length || 1) - 1);

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
  if (!ANN.doc.labels?.length) ANN.doc.labels = ["reach", "grasp", "lift", "place", "retreat"];
  annRenderLabels();
  annRender();
}

function annSave() {
  clearTimeout(ANN.saveTimer);
  ANN.saveTimer = setTimeout(async () => {
    if (!DS.root || !ANN.doc) return;
    try {
      await api("/api/ds/annotations", { method: "POST", body: { root: DS.root, doc: ANN.doc } });
    } catch (e) { toast(`Could not save annotations: ${e.message}`, "err", 8000); }
  }, 400);
}

/* ----------------------------------------------------------------------- *
 * Rendering
 * ----------------------------------------------------------------------- */
function annRenderLabels() {
  const box = $("#annotLabels");
  box.replaceChildren();
  (ANN.doc?.labels || []).forEach((label, i) => {
    const chip = el("button", { className: "seg-chip", type: "button", title: `Assign "${label}"  (${i + 1})` },
      el("span", { className: "seg-dot", style: `background:${segColor(label)}` }),
      el("span", {}, label));
    chip.addEventListener("click", () => annAssign(label));
    box.append(chip);
  });
  const erase = el("button", { className: "seg-chip ghost", type: "button", title: "Delete the selected block (or clear the selected range)" }, "✕ erase");
  erase.addEventListener("click", annErase);
  const manage = el("button", { className: "seg-chip ghost", type: "button" }, "⚙ labels…");
  manage.addEventListener("click", annOpenLabelEditor);
  box.append(erase, manage);
}

function annRender() {
  const strip = $("#annotSegs");
  if (!strip) return;
  strip.replaceChildren();
  if (!DS.ep) return;
  const last = Math.max(1, lastFrame());

  annSegs().forEach((seg, i) => {
    const selected = ANN.sel?.kind === "seg" && ANN.sel.i === i;
    const box = el("div", {
      className: "annot-seg" + (selected ? " selected" : ""),
      title: `${seg.label} · frames ${seg.start}–${seg.end}\ndrag to move, drag an edge to resize`,
    }, el("span", {}, seg.label));
    box.dataset.i = String(i);
    box.style.left = `${(seg.start / last) * 100}%`;
    box.style.width = `${((seg.end - seg.start + 1) / last) * 100}%`;
    box.style.background = segColor(seg.label);
    strip.append(box);
  });

  annRenderSelection();
  annUpdateCursor();
}

function annRenderSelection() {
  const box = $("#annotSelBox");
  const info = $("#annotSel");
  if (!DS.ep || !ANN.sel) {
    box.hidden = true;
    info.textContent = "nothing selected";
    return;
  }
  const fps = DS.fps || 1;
  if (ANN.sel.kind === "seg") {
    box.hidden = true;   // the block itself shows the selection outline
    const seg = annSegs()[ANN.sel.i];
    info.textContent = seg
      ? `block “${seg.label}” · frames ${seg.start}–${seg.end} (${seg.end - seg.start + 1} · ${((seg.end - seg.start + 1) / fps).toFixed(2)}s)`
      : "nothing selected";
    return;
  }
  const last = Math.max(1, lastFrame());
  const a = Math.min(ANN.sel.a, ANN.sel.b), b = Math.max(ANN.sel.a, ANN.sel.b);
  box.hidden = false;
  box.style.left = `${(a / last) * 100}%`;
  box.style.width = `${((b - a + 1) / last) * 100}%`;
  info.textContent = `frames ${a}–${b} (${b - a + 1} · ${((b - a + 1) / fps).toFixed(2)}s)`;
}

function annUpdateCursor() {
  if (!DS.ep) return;
  const cur = $("#annotCursor");
  if (cur) cur.style.left = `${(DS.frame / Math.max(1, lastFrame())) * 100}%`;
}

/* ----------------------------------------------------------------------- *
 * Pointer handling
 * ----------------------------------------------------------------------- */
function annFrameAt(clientX) {
  const r = $("#annotStrip").getBoundingClientRect();
  return Math.round(clamp((clientX - r.left) / r.width, 0, 1) * lastFrame());
}

/** How much room a block has before it hits its neighbours (or the episode ends). */
function annBounds(i) {
  const segs = annSegs();
  return {
    lo: i > 0 ? segs[i - 1].end + 1 : 0,
    hi: i < segs.length - 1 ? segs[i + 1].start - 1 : lastFrame(),
  };
}

function annWireStrip() {
  const strip = $("#annotStrip");

  strip.addEventListener("pointerdown", (e) => {
    if (!DS.ep) return;
    try { strip.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    const frame = annFrameAt(e.clientX);
    const hit = e.target.closest(".annot-seg");

    if (hit) {
      const i = Number(hit.dataset.i);
      const seg = annSegs()[i];
      const r = hit.getBoundingClientRect();
      const nearL = e.clientX - r.left <= EDGE_PX;
      const nearR = r.right - e.clientX <= EDGE_PX;
      ANN.sel = { kind: "seg", i };
      ANN.drag = nearL ? { mode: "resize-l", i }
        : nearR ? { mode: "resize-r", i }
        : { mode: "move", i, grab: frame, start: seg.start, end: seg.end };
      stopPlayback();
      seekToFrame(nearR ? seg.end : seg.start, true);
    } else {
      ANN.sel = { kind: "range", a: frame, b: frame };
      ANN.drag = { mode: "range" };
      stopPlayback();
      seekToFrame(frame, true);
    }
    annRender();
  });

  strip.addEventListener("pointermove", (e) => {
    if (!DS.ep) return;
    if (!ANN.drag) {                       // hover affordance for the resize edges
      const hit = e.target.closest(".annot-seg");
      if (hit) {
        const r = hit.getBoundingClientRect();
        const near = e.clientX - r.left <= EDGE_PX || r.right - e.clientX <= EDGE_PX;
        strip.style.cursor = near ? "ew-resize" : "grab";
      } else {
        strip.style.cursor = "crosshair";
      }
      return;
    }
    const frame = annFrameAt(e.clientX);
    const segs = annSegs().map((s) => ({ ...s }));

    if (ANN.drag.mode === "range") {
      ANN.sel.b = frame;
      seekToFrame(frame, true);
      annRenderSelection();
      return;
    }

    const i = ANN.drag.i;
    const seg = segs[i];
    if (!seg) return;
    const { lo, hi } = annBounds(i);

    if (ANN.drag.mode === "move") {
      // Slide by the pointer delta, clamped so the block stays between its neighbours.
      const len = ANN.drag.end - ANN.drag.start;
      let start = ANN.drag.start + (frame - ANN.drag.grab);
      start = clamp(start, lo, hi - len);
      seg.start = start;
      seg.end = start + len;
    } else if (ANN.drag.mode === "resize-l") {
      seg.start = clamp(frame, lo, seg.end);
    } else {
      seg.end = clamp(frame, seg.start, hi);
    }
    setSegs(segs);
    // setSegs re-sorts; a moved block keeps its identity by position, so re-find it.
    ANN.sel = { kind: "seg", i: annSegs().findIndex((s) => s.start === seg.start && s.label === seg.label) };
    seekToFrame(ANN.drag.mode === "resize-r" ? seg.end : seg.start, true);
    annRender();
  });

  const end = (e) => {
    if (ANN.drag && ANN.drag.mode !== "range") annSave();
    ANN.drag = null;
    strip.style.cursor = "";
    try { strip.releasePointerCapture(e.pointerId); } catch { /* never captured */ }
  };
  strip.addEventListener("pointerup", end);
  strip.addEventListener("pointercancel", end);
}

/* ----------------------------------------------------------------------- *
 * Assign / erase
 * ----------------------------------------------------------------------- */
/** Cut [a,b] out of existing blocks so nothing overlaps. */
function annCarve(segs, a, b) {
  const out = [];
  for (const s of segs) {
    if (s.end < a || s.start > b) { out.push(s); continue; }
    if (s.start < a) out.push({ ...s, end: a - 1 });
    if (s.end > b) out.push({ ...s, start: b + 1 });
  }
  return out;
}

function annAssign(label) {
  if (!DS.ep) return;
  if (!ANN.sel) return toast("Drag on the strip, or click a block first", "info");

  if (ANN.sel.kind === "seg") {          // relabel the selected block in place
    const segs = annSegs().map((s) => ({ ...s }));
    const seg = segs[ANN.sel.i];
    if (!seg) return;
    seg.label = label;
    setSegs(segs);
    annSave();
    annRender();
    return toast(`${label}: frames ${seg.start}–${seg.end}`, "ok", 2000);
  }

  const a = Math.min(ANN.sel.a, ANN.sel.b), b = Math.max(ANN.sel.a, ANN.sel.b);
  const segs = annCarve(annSegs().map((s) => ({ ...s })), a, b);
  segs.push({ start: a, end: b, label });
  setSegs(segs);
  ANN.sel = { kind: "seg", i: annSegs().findIndex((s) => s.start === a) };
  annSave();
  annRender();
  toast(`${label}: frames ${a}–${b}`, "ok", 2000);
}

function annErase() {
  if (!DS.ep || !ANN.sel) return toast("Click a block, or drag a span first", "info");
  if (ANN.sel.kind === "seg") {
    const segs = annSegs().map((s) => ({ ...s }));
    const [gone] = segs.splice(ANN.sel.i, 1);
    setSegs(segs);
    ANN.sel = null;
    annSave();
    annRender();
    return toast(`Removed “${gone.label}” (${gone.start}–${gone.end})`, "ok", 2500);
  }
  const a = Math.min(ANN.sel.a, ANN.sel.b), b = Math.max(ANN.sel.a, ANN.sel.b);
  setSegs(annCarve(annSegs().map((s) => ({ ...s })), a, b));
  ANN.sel = null;
  annSave();
  annRender();
  toast(`Cleared frames ${a}–${b}`, "ok", 2500);
}

/* ----------------------------------------------------------------------- *
 * Labels + export
 * ----------------------------------------------------------------------- */
function annOpenLabelEditor() {
  $("#lbText").value = (ANN.doc?.labels || []).join("\n");
  $("#labelModal").hidden = false;
  $("#lbText").focus();
}

function annSaveLabels() {
  const seen = new Set();
  ANN.doc.labels = $("#lbText").value.split("\n").map((s) => s.trim())
    .filter((l) => l && !seen.has(l) && seen.add(l));
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
    sub: `Adds a subtask_index column to every data file and writes meta/subtasks.parquet. ` +
         `${episodes} episode(s) annotated. The files it touches are copied into .hfutil_bak/ first.`,
    items: (ANN.doc.labels || []).slice(0, 20),
  });
  if (!go) return;
  try {
    await api("/api/ds/edit/export-subtasks", { method: "POST", body: { root: DS.root } });
    toast("Exporting subtasks — see the Jobs tab", "info", 6000);
    loadJobs();
  } catch (e) { toast(`Export failed: ${e.message}`, "err", 10000); }
}

function annWire() {
  annWireStrip();
  $("#annotClearSel").addEventListener("click", () => { ANN.sel = null; annRender(); });
  $("#annotExport").addEventListener("click", annExport);
  $("#lbCancel").addEventListener("click", () => ($("#labelModal").hidden = true));
  $("#lbSave").addEventListener("click", annSaveLabels);

  document.addEventListener("keydown", (e) => {
    if ($("#lerobotView").hidden || !DS.ep) return;
    if (document.querySelector(".modal-backdrop:not([hidden])")) return;
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return;
    if ((e.key === "Delete" || e.key === "Backspace") && ANN.sel) { e.preventDefault(); return annErase(); }
    if (!ANN.sel || !/^[1-9]$/.test(e.key)) return;
    const label = (ANN.doc?.labels || [])[Number(e.key) - 1];
    if (label) { e.preventDefault(); annAssign(label); }
  });
}

annWire();
