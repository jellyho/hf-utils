"use strict";

/* -----------------------------------------------------------------------
 * Partial download — tick exactly which files come down from a Hub repo.
 *
 * Why a tree and not a pattern box: the case this exists for is a model repo holding one
 * folder per training step, where the repo is tens of GB and you want one checkpoint out of
 * it. Ticking `checkpoint-4000/` is something you get right the first time; `*4000*` is not —
 * a mistyped glob quietly downloads nothing, or everything, and you find out an hour later.
 *
 * So the checkbox tree is the source of truth, the search box is only a *bulk ticker* over
 * it (plain words, never a pattern), and the exact resolved file list is shown before
 * anything starts. The globs handed to snapshot_download are derived at the end, from the
 * ticks — the user never writes one.
 *
 * Reuses $, el, api, toast from app.js (loaded before this file).
 * ----------------------------------------------------------------------- */

const PK = {
  repoId: "",        // what `files` was fetched for
  repoType: "",
  files: [],         // [{path, size}], sorted by path
  totalBytes: 0,
  truncated: false,
  tree: null,        // pkBuildTree(files)
  sel: new Set(),    // ticked paths — the working copy inside the modal
  open: new Set(),   // expanded folder paths
  applied: null,     // {repoId, repoType, patterns, count, total, bytes, sel} after Apply
};

// Drawing every row of a 20k-file repo would lock the page up for seconds, and nobody reads
// 20k rows anyway. Past this the tree says so; ticking still works on the full match set.
const PK_MAX_ROWS = 600;
const PK_MAX_REVIEW_ROWS = 400;
const PK_MAX_RULE_ROWS = 40;
const PK_MAX_TYPE_CHIPS = 8;
// Below this, the repo is small enough that a collapsed tree is just extra clicking.
const PK_EXPAND_ALL_UNDER = 40;

function fmtBytes(n) {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1000 && i < units.length - 1) { n /= 1000; i += 1; }
  return `${i === 0 ? n : n.toFixed(1)} ${units[i]}`;
}

const pkBase = (path) => path.split("/").pop();

/* ----------------------------------------------------------------------- *
 * Tree
 * ----------------------------------------------------------------------- */
function pkBuildTree(files) {
  const root = { name: "", path: "", dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      let child = node.dirs.get(parts[i]);
      if (!child) {
        child = { name: parts[i], path: parts.slice(0, i + 1).join("/"), dirs: new Map(), files: [] };
        node.dirs.set(parts[i], child);
      }
      node = child;
    }
    node.files.push(f);
  }
  return root;
}

/** Folders sorted the way a human reads them: checkpoint-2000 before checkpoint-10000. */
const pkDirs = (node) =>
  [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

/** Per folder path (and "" for the repo root): how many of `files` sit under it, their
 *  total size, and how much of that is ticked. One pass over every path segment. */
function pkStats(files) {
  const stats = new Map();
  const bump = (key, f, on) => {
    let s = stats.get(key);
    if (!s) stats.set(key, (s = { n: 0, size: 0, selN: 0, selSize: 0 }));
    s.n += 1; s.size += f.size;
    if (on) { s.selN += 1; s.selSize += f.size; }
  };
  for (const f of files) {
    const on = PK.sel.has(f.path);
    const parts = f.path.split("/");
    bump("", f, on);
    for (let i = 0; i < parts.length - 1; i += 1) bump(parts.slice(0, i + 1).join("/"), f, on);
  }
  return stats;
}

function pkEachFile(node, fn) {
  for (const f of node.files) fn(f);
  for (const d of node.dirs.values()) pkEachFile(d, fn);
}

function pkTickSubtree(node, on) {
  pkEachFile(node, (f) => (on ? PK.sel.add(f.path) : PK.sel.delete(f.path)));
}

function pkFolderPaths(node, out = []) {
  for (const d of node.dirs.values()) { out.push(d.path); pkFolderPaths(d, out); }
  return out;
}

/* ----------------------------------------------------------------------- *
 * Search — plain words, every one has to appear somewhere in the path
 * ----------------------------------------------------------------------- */
const pkTerms = () => $("#pkSearch").value.toLowerCase().split(/[\s,]+/).filter(Boolean);

function pkMatches(terms) {
  if (!terms.length) return PK.files;
  return PK.files.filter((f) => {
    const p = f.path.toLowerCase();
    return terms.every((t) => p.includes(t));
  });
}

function pkTickMatches(on) {
  const hits = pkMatches(pkTerms());
  if (!hits.length) return toast("Nothing matches those words", "err");
  for (const f of hits) (on ? PK.sel.add(f.path) : PK.sel.delete(f.path));
  pkRender();
}

/* ----------------------------------------------------------------------- *
 * Rendering
 * ----------------------------------------------------------------------- */
function pkRender() {
  pkRenderTree();
  pkRenderChips();
  pkRenderSummary();
}

function pkRenderTree() {
  const terms = pkTerms();
  const searching = terms.length > 0;
  const hits = pkMatches(terms);
  // While searching, the tree is rebuilt from the matches alone and shown fully expanded, so
  // what you typed and what you can tick are the same thing.
  const tree = searching ? pkBuildTree(hits) : PK.tree;
  const stats = pkStats(hits);
  const box = $("#pkTree");
  box.replaceChildren();

  let budget = PK_MAX_ROWS;
  const rows = (node, depth) => {
    const out = [];
    for (const d of pkDirs(node)) {
      if (budget <= 0) break;
      budget -= 1;
      const expanded = searching || PK.open.has(d.path);
      out.push(pkFolderRow(d, depth, stats, expanded, searching));
      if (expanded) out.push(...rows(d, depth + 1));
    }
    for (const f of node.files) {
      if (budget <= 0) break;
      budget -= 1;
      out.push(pkFileRow(f, depth));
    }
    return out;
  };

  box.append(...rows(tree, 0));
  if (!hits.length) {
    box.append(el("div", { className: "pk-note" }, "Nothing matches those words."));
  } else if (budget <= 0) {
    box.append(el("div", { className: "pk-note" },
      `Too many rows to draw — collapse a folder or narrow the search. ` +
      `“Tick matches” still applies to all ${hits.length} matching files.`));
  }

  const hint = $("#pkSearchHint");
  hint.textContent = searching
    ? `${hits.length} file${hits.length === 1 ? "" : "s"} match · ` +
      `${fmtBytes(hits.reduce((a, f) => a + f.size, 0))}`
    : "Plain words, not patterns — a file matches when its path contains every word you type.";
  hint.className = searching ? "hint on" : "hint";
}

function pkFolderRow(node, depth, stats, expanded, searching) {
  const s = stats.get(node.path) || { n: 0, size: 0, selN: 0 };
  const row = el("div", { className: "pk-row dir" });
  row.style.paddingLeft = `${8 + depth * 16}px`;

  const cb = el("input", { type: "checkbox", checked: s.n > 0 && s.selN === s.n });
  cb.indeterminate = s.selN > 0 && s.selN < s.n;
  cb.addEventListener("click", (e) => e.stopPropagation());
  cb.addEventListener("change", () => { pkTickSubtree(node, cb.checked); pkRender(); });

  const twisty = el("span", { className: "expander" }, expanded ? "▼" : "▶");
  const label = el("span", { className: "pk-name" }, node.name);
  const count = el("span", { className: "pk-size" },
    `${s.selN < s.n ? `${s.selN}/` : ""}${s.n} file${s.n === 1 ? "" : "s"} · ${fmtBytes(s.size)}`);

  row.append(cb, twisty, el("span", { className: "pk-ic" }, "📁"), label, count);
  // The whole row toggles the folder open; only the checkbox ticks it.
  if (!searching) {
    row.addEventListener("click", () => {
      PK.open.has(node.path) ? PK.open.delete(node.path) : PK.open.add(node.path);
      pkRenderTree();
    });
  } else {
    row.classList.add("locked");
  }
  return row;
}

function pkFileRow(f, depth) {
  const row = el("div", { className: "pk-row file" });
  row.style.paddingLeft = `${8 + depth * 16}px`;
  const cb = el("input", { type: "checkbox", checked: PK.sel.has(f.path) });
  cb.addEventListener("change", () => {
    cb.checked ? PK.sel.add(f.path) : PK.sel.delete(f.path);
    pkRender();
  });
  row.append(cb, el("span", { className: "expander" }, ""),
    el("span", { className: "pk-ic" }, "📄"),
    el("span", { className: "pk-name", title: f.path }, pkBase(f.path)),
    el("span", { className: "pk-size" }, fmtBytes(f.size)));
  row.addEventListener("click", (e) => { if (e.target !== cb) cb.click(); });
  return row;
}

/* ---- quick pickers above the tree ---- */

/** Extensions present in the repo, biggest first — one chip ticks or unticks all of them. */
function pkExtensions() {
  const m = new Map();
  for (const f of PK.files) {
    const base = pkBase(f.path);
    const dot = base.lastIndexOf(".");
    const ext = dot > 0 ? base.slice(dot).toLowerCase() : "(no extension)";
    let e = m.get(ext);
    if (!e) m.set(ext, (e = { ext, n: 0, size: 0, paths: [] }));
    e.n += 1; e.size += f.size; e.paths.push(f.path);
  }
  return [...m.values()].sort((a, b) => b.size - a.size || b.n - a.n);
}

/** Top-level folders that look like one-per-training-step (checkpoint-1000, step_4000, …),
 *  newest first. Empty unless the repo actually has two or more siblings of one shape. */
function pkStepFolders() {
  const groups = new Map();
  for (const name of PK.tree.dirs.keys()) {
    const m = /^(.*?)(\d+)$/.exec(name);
    if (!m) continue;
    const prefix = m[1];
    if (!groups.has(prefix)) groups.set(prefix, []);
    groups.get(prefix).push({ name, num: Number(m[2]) });
  }
  let best = [];
  for (const list of groups.values()) if (list.length > best.length) best = list;
  return best.length >= 2 ? best.sort((a, b) => b.num - a.num) : [];
}

function pkRenderChips() {
  // state: "on" (all of it ticked), "part" (some), "" (none)
  const chip = (text, state, title, fn) => {
    const b = el("button", { className: `chip${state ? ` ${state}` : ""}`, type: "button", title: title || text }, text);
    b.style.setProperty("--chip-color", "var(--accent-2)");
    b.addEventListener("click", fn);
    return b;
  };

  const presets = [
    chip("Everything", PK.sel.size === PK.files.length ? "on" : "", "Tick every file",
      () => { PK.sel = new Set(PK.files.map((f) => f.path)); pkRender(); }),
    chip("Nothing", PK.sel.size === 0 ? "on" : "", "Untick everything",
      () => { PK.sel = new Set(); pkRender(); }),
  ];
  const steps = pkStepFolders();
  if (steps.length) {
    const newest = steps[0];
    presets.push(chip(`Newest only — ${newest.name}`, "",
      `Keep ${newest.name} and everything outside the ${steps.length} step folders`, () => {
        const stepDirs = new Set(steps.map((s) => s.name));
        PK.sel = new Set(PK.files.filter((f) => {
          const top = f.path.includes("/") ? f.path.split("/")[0] : null;
          return top === null || !stepDirs.has(top) || top === newest.name;
        }).map((f) => f.path));
        pkRender();
      }));
  }
  $("#pkPresets").replaceChildren(...presets);

  const exts = pkExtensions();
  const types = exts.slice(0, PK_MAX_TYPE_CHIPS).map((e) => {
    const ticked = e.paths.filter((p) => PK.sel.has(p)).length;
    const all = ticked === e.n;
    return chip(`${e.ext} (${e.n})`, all ? "on" : ticked ? "part" : "",
      `${ticked} of ${e.n} ticked · ${fmtBytes(e.size)} in total`, () => {
        for (const p of e.paths) (all ? PK.sel.delete(p) : PK.sel.add(p));
        pkRender();
      });
  });
  if (exts.length > PK_MAX_TYPE_CHIPS) {
    types.push(el("span", { className: "hint" }, `+${exts.length - PK_MAX_TYPE_CHIPS} more types`));
  }
  $("#pkTypes").replaceChildren(...types);
}

/* ---- the review panel: what this selection actually resolves to ---- */
function pkRenderSummary() {
  const picked = PK.files.filter((f) => PK.sel.has(f.path));
  const bytes = picked.reduce((a, f) => a + f.size, 0);
  $("#pkSummary").textContent = picked.length === PK.files.length
    ? `Everything — ${picked.length} files · ${fmtBytes(PK.totalBytes)}`
    : `${picked.length} of ${PK.files.length} files · ${fmtBytes(bytes)} of ${fmtBytes(PK.totalBytes)}`;
  $("#pkApply").disabled = picked.length === 0;
  $("#pkReviewHead").textContent = picked.length
    ? `Review the ${picked.length} file${picked.length === 1 ? "" : "s"} that will be downloaded`
    : "Nothing ticked yet";
  // Only build the list when it is on screen — it re-renders on every tick.
  if ($("#pkReview").open) pkRenderReview();
}

function pkRenderReview() {
  const body = $("#pkReviewBody");
  body.replaceChildren();
  const picked = PK.files.filter((f) => PK.sel.has(f.path));
  if (!picked.length) return;

  const patterns = pkPatterns();
  body.append(el("div", { className: "pk-head" },
    patterns.length ? "Rules sent to the Hub" : "No filter — the whole repo comes down"));
  for (const p of patterns.slice(0, PK_MAX_RULE_ROWS)) {
    body.append(el("div", { className: "pk-rule" }, p));
  }
  if (patterns.length > PK_MAX_RULE_ROWS) {
    body.append(el("div", { className: "pk-note" }, `… and ${patterns.length - PK_MAX_RULE_ROWS} more`));
  }

  body.append(el("div", { className: "pk-head" }, "Files"));
  for (const f of picked.slice(0, PK_MAX_REVIEW_ROWS)) {
    body.append(el("div", { className: "pk-review-row" },
      el("span", { className: "pk-name" }, f.path),
      el("span", { className: "pk-size" }, fmtBytes(f.size))));
  }
  if (picked.length > PK_MAX_REVIEW_ROWS) {
    body.append(el("div", { className: "pk-note" },
      `… and ${picked.length - PK_MAX_REVIEW_ROWS} more files`));
  }
}

/**
 * The ticks, compressed into snapshot_download's `allow_patterns`.
 *
 * A fully-ticked folder collapses to `<folder>/**` rather than listing its files — it keeps
 * the rule list short enough to read back, and a resumed download then also picks up files
 * added to that folder since. Everything else goes in as its exact path.
 *
 * fnmatch has no escape, so a repo file whose own name contained `*`, `?` or `[` would go out
 * as a pattern matching more than itself. That can only ever pull in extra files, never drop
 * a ticked one, and Hub repos do not have names like that in practice.
 */
function pkPatterns() {
  const stats = pkStats(PK.files);
  const out = [];
  const walk = (node) => {
    const s = stats.get(node.path);
    if (node.path && s && s.n > 0 && s.selN === s.n) { out.push(`${node.path}/**`); return; }
    for (const d of pkDirs(node)) walk(d);
    for (const f of node.files) if (PK.sel.has(f.path)) out.push(f.path);
  };
  walk(PK.tree);
  return out;
}

/* ----------------------------------------------------------------------- *
 * Open / apply / clear
 * ----------------------------------------------------------------------- */
async function pkOpen() {
  const repoId = $("#dlRepoId").value.trim();
  const repoType = $("#dlRepoType").value;
  if (!repoId.includes("/")) return toast("Enter a full repo id like user/name first", "err");
  if ($("#dlLerobot").checked) {
    return toast("A LeRobot download always fetches the whole dataset — untick “Use LeRobot API” to pick files", "err", 8000);
  }

  $("#pkModal").hidden = false;
  $("#pkSearch").value = "";
  $("#pkSub").textContent = `${repoId} — reading the file list…`;
  $("#pkTree").replaceChildren(el("div", { className: "pk-note" }, "Loading…"));
  $("#pkPresets").replaceChildren();
  $("#pkTypes").replaceChildren();
  $("#pkSummary").textContent = "";

  if (PK.repoId !== repoId || PK.repoType !== repoType) {
    try {
      const data = await api(
        `/api/repo/files?repo_id=${encodeURIComponent(repoId)}&repo_type=${repoType}`);
      PK.repoId = repoId;
      PK.repoType = repoType;
      PK.files = data.files;
      PK.totalBytes = data.total_bytes;
      PK.truncated = data.truncated;
      PK.tree = pkBuildTree(PK.files);
      PK.open = new Set(PK.files.length <= PK_EXPAND_ALL_UNDER ? pkFolderPaths(PK.tree) : []);
    } catch (e) {
      $("#pkModal").hidden = true;
      return toast(`Could not read ${repoId}: ${e.message}`, "err", 9000);
    }
  }

  if (!PK.files.length) {
    $("#pkSub").textContent = `${repoId} — this repo has no files.`;
    $("#pkTree").replaceChildren(el("div", { className: "pk-note" }, "(empty repo)"));
    return;
  }

  // Always start from what is currently in force, so closing with Escape can't leave a
  // half-edited selection behind: reopening shows the applied filter, or everything.
  const applied = pkFilterFor(repoId, repoType);
  PK.sel = new Set(applied ? applied.sel : PK.files.map((f) => f.path));

  $("#pkSub").textContent =
    `${repoId} — ${PK.files.length} files · ${fmtBytes(PK.totalBytes)}` +
    (PK.truncated ? ` (the first ${PK.files.length} only — the repo has more)` : "");
  pkRender();
}

function pkApplySelection() {
  const picked = PK.files.filter((f) => PK.sel.has(f.path));
  if (!picked.length) return toast("Tick at least one file", "err");
  PK.applied = picked.length === PK.files.length ? null : {
    repoId: PK.repoId,
    repoType: PK.repoType,
    patterns: pkPatterns(),
    count: picked.length,
    total: PK.files.length,
    bytes: picked.reduce((a, f) => a + f.size, 0),
    sel: new Set(PK.sel),
  };
  $("#pkModal").hidden = true;
  pkUpdateDownloadSummary();
  toast(PK.applied
    ? `Download limited to ${picked.length} of ${PK.files.length} files (${fmtBytes(PK.applied.bytes)})`
    : "Downloading the whole repo", "ok");
}

function pkClearFilter() {
  PK.applied = null;
  pkUpdateDownloadSummary();
}

/** The filter app.js should send with the download, or null for the whole repo.
 *  Guards on the repo, so a filter picked for one repo can never leak into another. */
function pkFilterFor(repoId, repoType) {
  const a = PK.applied;
  if (!a || a.repoId !== repoId || a.repoType !== repoType || !a.patterns.length) return null;
  return a;
}

/** Reflect the current filter on the Transfer panel. Also called by app.js after prefill. */
function pkUpdateDownloadSummary() {
  const line = $("#dlPickSummary");
  const lerobot = $("#dlLerobot").checked;
  const filter = pkFilterFor($("#dlRepoId").value.trim(), $("#dlRepoType").value);

  $("#dlPick").disabled = lerobot;
  $("#dlPickClear").hidden = !filter;
  if (lerobot) {
    line.textContent = "LeRobot downloads always fetch the whole dataset.";
    line.className = "hint";
  } else if (filter) {
    line.textContent = `${filter.count} of ${filter.total} files · ${fmtBytes(filter.bytes)}`;
    line.className = "hint on";
  } else {
    line.textContent = "Everything in the repo";
    line.className = "hint";
  }
}

/** Drop a cached tree / applied filter that belongs to a repo the form no longer names. */
function pkSyncRepo() {
  const repoId = $("#dlRepoId").value.trim();
  const repoType = $("#dlRepoType").value;
  if (PK.repoId && (PK.repoId !== repoId || PK.repoType !== repoType)) {
    PK.repoId = "";
    PK.repoType = "";
    PK.files = [];
    PK.tree = null;
    PK.sel = new Set();
    PK.open = new Set();
    PK.applied = null;
  }
  pkUpdateDownloadSummary();
}

function pkWire() {
  $("#dlPick").addEventListener("click", pkOpen);
  $("#dlPickClear").addEventListener("click", pkClearFilter);
  $("#pkCancel").addEventListener("click", () => ($("#pkModal").hidden = true));
  $("#pkApply").addEventListener("click", pkApplySelection);
  $("#pkSearch").addEventListener("input", pkRender);
  $("#pkSelMatch").addEventListener("click", () => pkTickMatches(true));
  $("#pkDeselMatch").addEventListener("click", () => pkTickMatches(false));
  $("#pkReview").addEventListener("toggle", () => { if ($("#pkReview").open) pkRenderReview(); });

  for (const ev of ["input", "change"]) $("#dlRepoId").addEventListener(ev, pkSyncRepo);
  $("#dlRepoType").addEventListener("change", pkSyncRepo);
  $("#dlLerobot").addEventListener("change", pkUpdateDownloadSummary);
  pkUpdateDownloadSummary();
}

pkWire();
