"use strict";

/* ----------------------------------------------------------------------- *
 * State
 * ----------------------------------------------------------------------- */
const state = {
  tab: "model",
  repos: { model: [], dataset: [] },
  reposLoaded: { model: false, dataset: false },
  sel: { model: new Set(), dataset: new Set() },
  collections: [],
  collectionsLoaded: false,
  selCol: new Set(),
  colItems: {}, // slug -> items[]
  colOpen: new Set(),
  jobStatus: {}, // jobId -> last seen status (for completion toasts)
};

/* ----------------------------------------------------------------------- *
 * Tiny helpers
 * ----------------------------------------------------------------------- */
const $ = (sel) => document.querySelector(sel);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of kids) n.append(k?.nodeType ? k : document.createTextNode(k ?? ""));
  return n;
};

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data;
}

const fmtNum = (n) => (n == null ? "–" : Intl.NumberFormat("en-US").format(n));
function fmtDate(iso) {
  if (!iso) return "–";
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function toast(msg, kind = "info", ms = 4000) {
  const t = el("div", { className: `toast ${kind}` }, msg);
  $("#toasts").append(t);
  setTimeout(() => t.remove(), ms);
}

/* ----------------------------------------------------------------------- *
 * Confirm modal (promise-based, requires typing DELETE)
 * ----------------------------------------------------------------------- */
function confirmDelete({ title, sub, items }) {
  return new Promise((resolve) => {
    const modal = $("#confirmModal");
    $("#confirmTitle").textContent = title;
    $("#confirmSub").textContent = sub;
    const list = $("#confirmList");
    list.replaceChildren(...items.map((i) => el("li", {}, i)));
    const input = $("#confirmInput");
    const ok = $("#confirmOk");
    input.value = "";
    ok.disabled = true;
    modal.hidden = false;
    input.focus();

    const onInput = () => { ok.disabled = input.value.trim() !== "DELETE"; };
    const cleanup = (result) => {
      modal.hidden = true;
      input.removeEventListener("input", onInput);
      ok.removeEventListener("click", onOk);
      $("#confirmCancel").removeEventListener("click", onCancel);
      resolve(result);
    };
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    input.addEventListener("input", onInput);
    ok.addEventListener("click", onOk);
    $("#confirmCancel").addEventListener("click", onCancel);
  });
}

/* ----------------------------------------------------------------------- *
 * Repos (models & datasets)
 * ----------------------------------------------------------------------- */
async function loadRepos(type, force = false) {
  if (state.reposLoaded[type] && !force) return;
  setRepoBusy(true);
  try {
    const data = await api(`/api/repos?repo_type=${type}`);
    state.repos[type] = data.items;
    state.reposLoaded[type] = true;
    state.sel[type].clear();
  } catch (e) {
    toast(`Failed to load ${type}s: ${e.message}`, "err", 8000);
  } finally {
    setRepoBusy(false);
  }
}

function setRepoBusy(b) {
  $("#repoCount").textContent = b ? "loading…" : $("#repoCount").textContent;
}

function visibleRepos() {
  const type = state.tab;
  const q = $("#repoSearch").value.trim().toLowerCase();
  const vis = $("#repoVisFilter").value;
  const sort = $("#repoSort").value;
  let rows = state.repos[type].filter((r) => {
    if (q && !r.id.toLowerCase().includes(q)) return false;
    if (vis === "public" && r.private) return false;
    if (vis === "private" && !r.private) return false;
    return true;
  });
  const cmp = {
    name: (a, b) => a.name.localeCompare(b.name),
    downloads: (a, b) => (b.downloads || 0) - (a.downloads || 0),
    likes: (a, b) => (b.likes || 0) - (a.likes || 0),
    modified: (a, b) => (b.lastModified || "").localeCompare(a.lastModified || ""),
  }[sort];
  return rows.sort(cmp);
}

function renderRepos() {
  const type = state.tab;
  const rows = visibleRepos();
  const sel = state.sel[type];
  const body = $("#repoBody");
  body.replaceChildren();

  for (const r of rows) {
    const checked = sel.has(r.id);
    const tr = el("tr", { className: checked ? "selected" : "" });

    const cb = el("input", { type: "checkbox", checked });
    cb.addEventListener("change", () => {
      cb.checked ? sel.add(r.id) : sel.delete(r.id);
      tr.classList.toggle("selected", cb.checked);
      updateRepoToolbar();
    });
    tr.append(el("td", { className: "c-check" }, cb));

    // name (with inline rename). Clicking it sets up a download rather than leaving for the
    // Hub — this is a tool for moving repos around, so the local action is the common one and
    // the website is the detour. The 🤗 button in Actions is the way out to huggingface.co.
    const nameTd = el("td", { className: "c-name" });
    const link = el("button", {
      className: "repo-name", type: "button",
      title: "Set up a download in the Transfer tab",
    }, r.id);
    link.addEventListener("click", () => prefillDownload(r, state.tab));
    nameTd.append(link);
    tr.append(nameTd);

    tr.append(el("td", { className: "c-vis" },
      el("span", { className: `badge ${r.private ? "private" : "public"}` }, r.private ? "private" : "public")));
    tr.append(el("td", { className: "c-num" }, fmtNum(r.downloads)));
    tr.append(el("td", { className: "c-num" }, fmtNum(r.likes)));
    tr.append(el("td", { className: "c-date" }, fmtDate(r.lastModified)));

    // actions
    const act = el("td", { className: "c-act" });
    // A real <a>, not a button that calls window.open — middle-click, "copy link" and
    // open-in-new-tab all have to keep working.
    const hubBtn = el("a", {
      className: "btn tiny ghost", href: r.url, target: "_blank", rel: "noreferrer",
      title: "Open on huggingface.co",
    }, "🤗");
    const renameBtn = el("button", { className: "btn tiny ghost", title: "Rename" }, "✎");
    renameBtn.addEventListener("click", () => startRename(r, nameTd, link));
    const visBtn = el("button", { className: "btn tiny ghost", title: "Toggle visibility" },
      r.private ? "Make public" : "Make private");
    visBtn.addEventListener("click", () => toggleVisibility(r, visBtn));
    act.append(hubBtn, " ", renameBtn, " ", visBtn);
    tr.append(act);

    body.append(tr);
  }

  $("#repoEmpty").hidden = rows.length > 0;
  $("#repoEmpty").textContent = state.reposLoaded[type]
    ? `No ${type}s match.` : "Loading…";
  updateRepoToolbar();
}

function updateRepoToolbar() {
  const type = state.tab;
  const total = state.repos[type].length;
  const shown = visibleRepos().length;
  const selN = state.sel[type].size;
  $("#repoCount").textContent =
    `${shown} shown · ${total} total${selN ? ` · ${selN} selected` : ""}`;
  $("#repoDeleteBtn").disabled = selN === 0;
  $("#repoDeleteBtn").textContent = selN ? `Delete selected (${selN})` : "Delete selected";
  // header select-all reflects "all visible selected"
  const vis = visibleRepos();
  const allSel = vis.length > 0 && vis.every((r) => state.sel[type].has(r.id));
  $("#repoSelectAll").checked = allSel;
  $("#repoSelectAll").indeterminate = !allSel && vis.some((r) => state.sel[type].has(r.id));
}

async function startRename(repo, nameTd, link) {
  const input = el("input", { className: "search rename-input", value: repo.name });
  const save = el("button", { className: "btn tiny primary" }, "Save");
  const cancel = el("button", { className: "btn tiny ghost" }, "✕");
  nameTd.replaceChildren(input, " ", save, " ", cancel);
  input.focus();
  input.select();

  const restore = () => nameTd.replaceChildren(link);
  cancel.addEventListener("click", restore);
  input.addEventListener("keydown", (e) => { if (e.key === "Escape") restore(); if (e.key === "Enter") save.click(); });
  save.addEventListener("click", async () => {
    const newName = input.value.trim();
    if (!newName || newName === repo.name) return restore();
    save.textContent = "…";
    try {
      const res = await api("/api/repos/rename", {
        method: "POST",
        body: { repo_type: state.tab, id: repo.id, new_name: newName },
      });
      // update in place
      const old = repo.id;
      repo.id = res.to; repo.name = newName;
      repo.url = repo.url.replace(old, res.to);
      if (state.sel[state.tab].delete(old)) state.sel[state.tab].add(res.to);
      toast(`Renamed to ${res.to}`, "ok");
      renderRepos();
    } catch (e) {
      toast(`Rename failed: ${e.message}`, "err", 8000);
      restore();
    }
  });
}

async function toggleVisibility(repo, btn) {
  const makePrivate = !repo.private;
  const prev = btn.textContent;
  btn.textContent = "…"; btn.disabled = true;
  try {
    await api("/api/repos/visibility", {
      method: "POST",
      body: { repo_type: state.tab, id: repo.id, private: makePrivate },
    });
    repo.private = makePrivate;
    toast(`${repo.id} is now ${makePrivate ? "private" : "public"}`, "ok");
    renderRepos();
  } catch (e) {
    toast(`Visibility change failed: ${e.message}`, "err", 8000);
    btn.textContent = prev; btn.disabled = false;
  }
}

async function deleteSelectedRepos() {
  const type = state.tab;
  const ids = [...state.sel[type]];
  if (!ids.length) return;
  const go = await confirmDelete({
    title: `Delete ${ids.length} ${type}${ids.length > 1 ? "s" : ""}?`,
    sub: "The following repositories will be permanently deleted from Hugging Face:",
    items: ids,
  });
  if (!go) return;
  try {
    const res = await api("/api/repos/delete", { method: "POST", body: { repo_type: type, ids } });
    const okIds = new Set(res.results.filter((r) => r.ok).map((r) => r.id));
    state.repos[type] = state.repos[type].filter((r) => !okIds.has(r.id));
    okIds.forEach((id) => state.sel[type].delete(id));
    const failed = res.results.filter((r) => !r.ok);
    toast(`Deleted ${res.ok_count}/${ids.length} ${type}s`, failed.length ? "err" : "ok", 6000);
    failed.forEach((f) => toast(`✕ ${f.id}: ${f.error}`, "err", 9000));
    renderRepos();
  } catch (e) {
    toast(`Delete failed: ${e.message}`, "err", 8000);
  }
}

/* ----------------------------------------------------------------------- *
 * Collections
 * ----------------------------------------------------------------------- */
async function loadCollections(force = false) {
  if (state.collectionsLoaded && !force) return;
  try {
    const data = await api("/api/collections");
    state.collections = data.items;
    state.collectionsLoaded = true;
    state.selCol.clear();
  } catch (e) {
    toast(`Failed to load collections: ${e.message}`, "err", 8000);
  }
}

function visibleCollections() {
  const q = $("#colSearch").value.trim().toLowerCase();
  return state.collections.filter((c) => !q || (c.title || "").toLowerCase().includes(q));
}

function renderCollections() {
  const list = $("#colList");
  list.replaceChildren();
  const cols = visibleCollections();

  for (const c of cols) {
    const card = el("div", { className: "col-card" + (state.selCol.has(c.slug) ? " selected" : "") });

    const head = el("div", { className: "col-head" });
    const cb = el("input", { type: "checkbox", checked: state.selCol.has(c.slug) });
    cb.addEventListener("change", () => {
      cb.checked ? state.selCol.add(c.slug) : state.selCol.delete(c.slug);
      card.classList.toggle("selected", cb.checked);
      updateColToolbar();
    });

    const open = state.colOpen.has(c.slug);
    const expander = el("button", { className: "expander" }, open ? "▼" : "▶");
    const title = el("div", { className: "col-title" },
      el("a", { href: c.url, target: "_blank", rel: "noreferrer" }, c.title || "(untitled)"));
    const badges = el("span", {},
      el("span", { className: `badge ${c.private ? "private" : "public"}` }, c.private ? "private" : "public"),
      " ",
      el("span", { className: "badge muted" }, `♥ ${c.upvotes ?? 0}`));

    const actions = el("div", { className: "col-actions" });
    const editBtn = el("button", { className: "btn tiny ghost" }, "Edit");
    editBtn.addEventListener("click", () => openEditCollection(c));
    actions.append(editBtn);

    head.append(cb, expander, title, badges, actions);
    card.append(head);
    if (c.description) card.append(el("div", { className: "col-desc" }, c.description));

    const itemsBox = el("div", { className: "col-items" + (open ? " open" : "") });
    card.append(itemsBox);
    if (open) renderCollectionItems(c, itemsBox);

    const toggleOpen = async () => {
      if (state.colOpen.has(c.slug)) { state.colOpen.delete(c.slug); }
      else { state.colOpen.add(c.slug); await ensureColItems(c.slug); }
      renderCollections();
    };
    expander.addEventListener("click", toggleOpen);
    title.addEventListener("click", (e) => { if (e.target.tagName !== "A") toggleOpen(); });

    list.append(card);
  }
  $("#colEmpty").hidden = cols.length > 0;
  $("#colEmpty").textContent = state.collectionsLoaded ? "No collections match." : "Loading…";
  updateColToolbar();
}

async function ensureColItems(slug) {
  if (state.colItems[slug]) return;
  try {
    const data = await api(`/api/collection?slug=${encodeURIComponent(slug)}`);
    state.colItems[slug] = data.items || [];
  } catch (e) {
    toast(`Failed to load items: ${e.message}`, "err", 8000);
    state.colItems[slug] = [];
  }
}

function renderCollectionItems(c, box) {
  const items = state.colItems[c.slug] || [];
  box.replaceChildren();
  if (!items.length) { box.append(el("div", { className: "col-desc" }, "No items.")); return; }
  for (const it of items) {
    const row = el("div", { className: "col-item" });
    const url = it.item_type === "dataset"
      ? `https://huggingface.co/datasets/${it.item_id}`
      : it.item_type === "model"
        ? `https://huggingface.co/${it.item_id}`
        : `https://huggingface.co/${it.item_type}s/${it.item_id}`;
    row.append(
      el("span", { className: "it-type" }, it.item_type),
      el("a", { href: url, target: "_blank", rel: "noreferrer" }, it.item_id),
    );
    const rm = el("button", { className: "btn tiny ghost it-rm", title: "Remove from collection" }, "✕");
    rm.addEventListener("click", async () => {
      rm.textContent = "…";
      try {
        await api("/api/collections/remove-item", {
          method: "POST", body: { slug: c.slug, item_object_id: it.item_object_id },
        });
        state.colItems[c.slug] = state.colItems[c.slug].filter((x) => x.item_object_id !== it.item_object_id);
        toast(`Removed ${it.item_id}`, "ok");
        renderCollections();
      } catch (e) { toast(`Remove failed: ${e.message}`, "err", 8000); rm.textContent = "✕"; }
    });
    row.append(rm);
    box.append(row);
  }
}

function updateColToolbar() {
  const total = state.collections.length;
  const shown = visibleCollections().length;
  const selN = state.selCol.size;
  $("#colCount").textContent = `${shown} shown · ${total} total${selN ? ` · ${selN} selected` : ""}`;
  $("#colDeleteBtn").disabled = selN === 0;
  $("#colDeleteBtn").textContent = selN ? `Delete selected (${selN})` : "Delete selected";
}

async function deleteSelectedCollections() {
  const slugs = [...state.selCol];
  if (!slugs.length) return;
  const titles = slugs.map((s) => (state.collections.find((c) => c.slug === s)?.title) || s);
  const go = await confirmDelete({
    title: `Delete ${slugs.length} collection${slugs.length > 1 ? "s" : ""}?`,
    sub: "The following collections will be permanently deleted (the repos inside are NOT deleted):",
    items: titles,
  });
  if (!go) return;
  try {
    const res = await api("/api/collections/delete", { method: "POST", body: { slugs } });
    const okSlugs = new Set(res.results.filter((r) => r.ok).map((r) => r.slug));
    state.collections = state.collections.filter((c) => !okSlugs.has(c.slug));
    okSlugs.forEach((s) => state.selCol.delete(s));
    const failed = res.results.filter((r) => !r.ok);
    toast(`Deleted ${res.ok_count}/${slugs.length} collections`, failed.length ? "err" : "ok", 6000);
    failed.forEach((f) => toast(`✕ ${f.slug}: ${f.error}`, "err", 9000));
    renderCollections();
  } catch (e) {
    toast(`Delete failed: ${e.message}`, "err", 8000);
  }
}

/* ---- edit collection modal ---- */
let editingSlug = null;
function openEditCollection(c) {
  editingSlug = c.slug;
  $("#editColTitle").value = c.title || "";
  $("#editColDesc").value = c.description || "";
  $("#editColPrivate").checked = !!c.private;
  $("#editColModal").hidden = false;
  $("#editColTitle").focus();
}
async function saveEditCollection() {
  const c = state.collections.find((x) => x.slug === editingSlug);
  if (!c) return;
  const body = {
    slug: editingSlug,
    title: $("#editColTitle").value.trim(),
    description: $("#editColDesc").value,
    private: $("#editColPrivate").checked,
  };
  try {
    const res = await api("/api/collections/update", { method: "POST", body });
    Object.assign(c, {
      title: res.collection.title,
      description: res.collection.description,
      private: res.collection.private,
    });
    toast("Collection updated", "ok");
    $("#editColModal").hidden = true;
    renderCollections();
  } catch (e) {
    toast(`Update failed: ${e.message}`, "err", 8000);
  }
}

/* ----------------------------------------------------------------------- *
 * Tabs & wiring
 * ----------------------------------------------------------------------- */
async function switchTab(tab) {
  state.tab = tab;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
  const isRepo = tab === "model" || tab === "dataset";
  $("#repoView").hidden = !isRepo;
  $("#collectionView").hidden = tab !== "collection";
  $("#transferView").hidden = tab !== "transfer";
  $("#lerobotView").hidden = tab !== "lerobot";
  $("#jobsView").hidden = tab !== "jobs";
  measureChrome();   // each view has its own toolbar, so the offset changes with the tab
  if (typeof dsOnTab === "function") dsOnTab(tab === "lerobot");
  if (tab === "collection") {
    await loadCollections();
    renderCollections();
  } else if (tab === "jobs") {
    loadJobs();
  } else if (isRepo) {
    await loadRepos(tab);
    renderRepos();
  }
}

/* ----------------------------------------------------------------------- *
 * Transfer (download / upload) + jobs
 * ----------------------------------------------------------------------- */
const JOB_LOG_TAIL = 8;

let jobsTimer = null;
function stopJobsPolling() { if (jobsTimer) { clearInterval(jobsTimer); jobsTimer = null; } }
function ensurePolling(anyRunning) {
  // Polls regardless of which tab is showing: a render started from the LeRobot tab
  // still has to drive the tab badge and the completion toast.
  if (anyRunning && !jobsTimer) jobsTimer = setInterval(loadJobs, 1500);
  else if (!anyRunning) stopJobsPolling();
}

async function loadJobs() {
  try {
    const data = await api("/api/jobs");
    renderJobs(data.jobs);
  } catch { /* ignore transient poll errors */ }
}

function updateJobsBadge(jobs) {
  const running = jobs.filter((j) => j.status === "running").length;
  const badge = $("#jobsBadge");
  badge.hidden = running === 0;
  badge.textContent = String(running);
}

async function clearFinishedJobs() {
  try {
    const res = await api("/api/jobs/clear", { method: "POST" });
    toast(`Cleared ${res.removed} finished job${res.removed === 1 ? "" : "s"}`, "ok");
    loadJobs();
  } catch (e) { toast(`Clear failed: ${e.message}`, "err"); }
}

function fmtElapsed(j) {
  const end = j.ended_at || Date.now() / 1000;
  const s = Math.max(0, Math.round(end - j.started_at));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function renderJobs(jobs) {
  $("#jobsEmpty").hidden = jobs.length > 0;
  $("#jobsCount").textContent = jobs.length ? `${jobs.length} job${jobs.length > 1 ? "s" : ""}` : "";
  for (const j of jobs) {
    const prev = state.jobStatus[j.id];
    if (prev === "running" && j.status !== "running") {
      const kind = j.status === "success" ? "ok" : j.status === "error" ? "err" : "info";
      toast(`${j.kind} ${j.status}: ${j.repo_id}`, kind, 7000);
    }
    state.jobStatus[j.id] = j.status;
  }
  $("#jobsList").replaceChildren(...jobs.map(renderJobCard));
  updateJobsBadge(jobs);
  ensurePolling(jobs.some((j) => j.status === "running"));
}

function renderJobCard(j) {
  const card = el("div", { className: "job" });
  const head = el("div", { className: "job-head" });
  const arrow = { download: "⤓", upload: "⤒", ds_render: "⎙" }[j.kind] || "•";
  const meta = j.kind === "ds_render"
    ? `render · ${fmtElapsed(j)}`
    : `${j.mode}${j.mode === "lerobot" ? " 🤖" : ""} · ${j.repo_type} · ${fmtElapsed(j)}`;
  head.append(
    el("span", { className: `badge ${j.status}` }, j.status),
    el("span", { className: "job-title" }, `${arrow} ${j.label || j.repo_id}`),
    el("span", { className: "job-meta" }, meta),
  );
  if (j.status === "running") {
    if (j.adopted) {
      // Survived a server restart — say so, or "running" with no cancel history looks wrong.
      head.append(el("span", { className: "badge muted", title: "re-attached after a server restart" }, "adopted"));
    }
    const cancel = el("button", { className: "btn tiny danger" }, "Cancel");
    cancel.addEventListener("click", () => cancelJob(j.id));
    head.append(cancel);
  } else {
    // An interrupted, cancelled or failed download still has its files on disk, so running
    // it again continues from where it stopped instead of re-fetching what it already has.
    if (j.status !== "success") {
      const resume = el("button", { className: "btn tiny" },
                        j.kind === "download" ? "↻ Resume" : "↻ Retry");
      resume.addEventListener("click", () => resumeJob(j.id));
      head.append(resume);
    }
    if (j.local_dir && (j.kind === "ds_render" || j.kind === "download")) {
      // Renders and downloads produce files worth looking at — jump straight to them.
      const open = el("button", { className: "btn tiny", title: j.local_dir }, "📂 Open folder");
      open.addEventListener("click", () => revealFolder(j.local_dir));
      head.append(open);
    }
    const rm = el("button", {
      className: "btn tiny ghost job-rm",
      title: "Remove this job from the list (downloaded files are kept)",
    }, "✕");
    rm.addEventListener("click", () => removeJob(j.id, j.label || j.repo_id));
    head.append(rm);
  }
  card.append(head);

  // Name the files this job produced — the whole point of opening the folder is to
  // find them, so don't make the user dig them out of the log.
  if (j.outputs && j.outputs.length) {
    const files = el("div", { className: "job-files" });
    for (const path of j.outputs) {
      const name = path.split(/[\\/]/).pop();
      const chip = el("button", { className: "file-chip", title: path, type: "button" }, name);
      chip.addEventListener("click", () => revealFolder(path));
      files.append(chip);
    }
    card.append(files);
  }

  // Show only the tail by default — a download's tqdm output runs to hundreds of lines
  // and would bury every other job on the page.
  const lines = j.log || [];
  if (lines.length) {
    const wrap = el("div", { className: "job-logwrap" });
    const pre = el("pre", { className: "job-log" }, lines.slice(-JOB_LOG_TAIL).join("\n"));
    wrap.append(pre);
    const total = j.log_lines ?? lines.length;
    if (total > JOB_LOG_TAIL) {
      // The list endpoint only sends a short tail, so expanding fetches the full log.
      const more = el("button", { className: "job-logmore", type: "button" },
        `▼ show all ${total} lines`);
      let expanded = false;
      more.addEventListener("click", async () => {
        if (expanded) {
          pre.textContent = lines.slice(-JOB_LOG_TAIL).join("\n");
          more.textContent = `▼ show all ${total} lines`;
          expanded = false;
          return;
        }
        try {
          const full = await api(`/api/jobs/${j.id}`);
          pre.textContent = (full.log || []).join("\n");
          more.textContent = "▲ show less";
          expanded = true;
        } catch (e) { toast(`Could not load log: ${e.message}`, "err"); }
      });
      wrap.append(more);
    }
    card.append(wrap);
  }
  return card;
}

async function revealFolder(path) {
  try {
    await api("/api/fs/reveal", { method: "POST", body: { path } });
  } catch (e) {
    toast(`Could not open folder: ${e.message}`, "err", 8000);
  }
}

async function cancelJob(id) {
  try { await api(`/api/jobs/${id}/cancel`, { method: "POST" }); loadJobs(); }
  catch (e) { toast(`Cancel failed: ${e.message}`, "err"); }
}

async function removeJob(id, label) {
  try {
    await api(`/api/jobs/${id}`, { method: "DELETE" });
    toast(`Removed ${label} from the list — files on disk are untouched`, "ok");
    loadJobs();
  } catch (e) { toast(`Remove failed: ${e.message}`, "err", 8000); }
}

async function resumeJob(id) {
  try {
    await api(`/api/jobs/${id}/resume`, { method: "POST" });
    toast("Resumed — already-downloaded files are kept");
    loadJobs();
  } catch (e) { toast(`Resume failed: ${e.message}`, "err"); }
}

async function detectDownload() {
  const id = $("#dlRepoId").value.trim();
  const type = $("#dlRepoType").value;
  const hint = $("#dlDetect");
  if (!id.includes("/")) { hint.textContent = ""; hint.className = "hint"; return; }
  hint.textContent = "checking…"; hint.className = "hint";
  try {
    const res = await api(`/api/detect/hub?repo_id=${encodeURIComponent(id)}&repo_type=${type}`);
    $("#dlLerobot").checked = !!res.lerobot;
    hint.textContent = res.lerobot ? "LeRobot dataset detected" : (type === "dataset" ? "not a LeRobot dataset" : "");
    hint.className = "hint" + (res.lerobot ? " on" : "");
  } catch { hint.textContent = ""; }
  // Setting .checked in code fires no "change", so tell the file picker itself — the
  // LeRobot path can't take a file filter and its button has to grey out.
  if (typeof pkUpdateDownloadSummary === "function") pkUpdateDownloadSummary();
}

// Where downloads land, as the server resolves it. Filled in from /api/whoami at start-up;
// until then a relative path still works, because the server anchors it to the same root.
let DOWNLOAD_ROOT = "";

// The form asks only for the parent — the repo's own name is always the folder inside it, so
// there is no way to typo it, and picking a parent once is enough for every later download.
function dlParent() {
  return $("#dlParentDir").value.trim() || DOWNLOAD_ROOT;
}

function joinPath(parent, name) {
  const sep = parent.includes("\\") && !parent.includes("/") ? "\\" : "/";
  return `${parent.replace(/[\\/]+$/, "")}${sep}${name}`;
}

function dlRepoName() {
  const id = $("#dlRepoId").value.trim();
  return id.includes("/") ? id.split("/").pop() : "";
}

/** Spell out the folder the download will actually create, so the parent is unambiguous. */
function showDlDest() {
  const name = dlRepoName();
  const parent = dlParent();
  $("#dlDest").textContent = name && parent ? `→ ${joinPath(parent, name)}` : "";
}

async function prefillDownload(r, type) {
  await switchTab("transfer");
  $("#dlRepoId").value = r.id;
  $("#dlRepoType").value = type;
  showDlDest();
  // Assigning .value fires no event, so the file picker would keep the previous repo's tree.
  if (typeof pkSyncRepo === "function") pkSyncRepo();
  detectDownload();
  $("#dlRepoId").scrollIntoView({ behavior: "smooth", block: "center" });
}

async function startDownload() {
  const repo_id = $("#dlRepoId").value.trim();
  if (!repo_id.includes("/")) return toast("Enter a full repo id like user/name", "err");
  const parent = dlParent();
  if (!parent) return toast("Choose a folder to download into", "err");
  const repo_type = $("#dlRepoType").value;
  const local_dir = joinPath(parent, repo_id.split("/").pop());
  // Null unless the user ticked a subset in the file picker (download-picker.js), which
  // guards on the repo id, so a filter can never be carried over to a different repo.
  const filter = typeof pkFilterFor === "function" ? pkFilterFor(repo_id, repo_type) : null;
  try {
    await api("/api/transfer/download", {
      method: "POST",
      body: {
        repo_id, repo_type, local_dir, use_lerobot: $("#dlLerobot").checked,
        allow_patterns: filter ? filter.patterns : null,
        selected_files: filter ? filter.count : null,
        selected_bytes: filter ? filter.bytes : null,
      },
    });
    toast(filter
      ? `Download started: ${repo_id} (${filter.count} of ${filter.total} files)`
      : `Download started: ${repo_id}`, "info");
    loadJobs();
  } catch (e) { toast(`Failed to start: ${e.message}`, "err", 8000); }
}

async function detectUpload() {
  const path = $("#upLocalDir").value.trim();
  const hint = $("#upDetect");
  if (!path) { hint.textContent = ""; hint.className = "hint"; return; }
  hint.textContent = "checking…"; hint.className = "hint";
  try {
    const res = await api(`/api/detect/local?path=${encodeURIComponent(path)}`);
    if (!res.exists) {
      $("#upLerobot").checked = false;
      hint.textContent = "folder not found"; hint.className = "hint";
      return;
    }
    $("#upLerobot").checked = !!res.lerobot;
    if (res.lerobot) $("#upRepoType").value = "dataset";
    hint.textContent = res.lerobot ? "LeRobot dataset detected" : "plain folder";
    hint.className = "hint" + (res.lerobot ? " on" : "");
  } catch { hint.textContent = ""; }
}

async function startUpload() {
  const repo_id = $("#upRepoId").value.trim();
  const local_dir = $("#upLocalDir").value.trim();
  if (!repo_id.includes("/")) return toast("Enter target repo id like user/name", "err");
  if (!local_dir) return toast("Enter the local folder to upload", "err");
  const useLerobot = $("#upLerobot").checked;
  try {
    await api("/api/transfer/upload", {
      method: "POST",
      body: {
        repo_id, local_dir, use_lerobot: useLerobot,
        repo_type: useLerobot ? "dataset" : $("#upRepoType").value,
        private: $("#upPrivate").checked,
      },
    });
    toast(`Upload started: ${repo_id}`, "info");
    loadJobs();
  } catch (e) { toast(`Failed to start: ${e.message}`, "err", 8000); }
}

/* ----------------------------------------------------------------------- *
 * Folder picker (browse the local filesystem — cross-platform)
 * ----------------------------------------------------------------------- */
const fsPicker = { current: "", parent: null, home: "", sep: "/", target: null };

function openFolderPicker(targetId, title) {
  fsPicker.target = targetId;
  $("#fsTitle").textContent = title;
  $("#fsNewName").value = "";
  $("#fsModal").hidden = false;
  const cur = $("#" + targetId).value.trim();
  const looksAbsolute = /^([A-Za-z]:[\\/]|[\\/]|~)/.test(cur);
  fsNavigate(looksAbsolute ? cur : "~");
}

async function fsNavigate(path) {
  try {
    const data = await api(`/api/fs/list?path=${encodeURIComponent(path)}`);
    fsPicker.current = data.path;
    fsPicker.parent = data.parent;
    fsPicker.home = data.home;
    fsPicker.sep = data.sep;
    fsRenderList(data);
  } catch (e) {
    if (path !== "~" && path !== "") return fsNavigate("~");
    if (path === "~") return fsNavigate("");
    toast(`Cannot open folder: ${e.message}`, "err");
  }
}

function fsRenderList(data) {
  $("#fsPath").value = data.path || (data.drives.length ? "This PC" : "/");
  const info = $("#fsInfo");
  if (data.is_lerobot) {
    info.textContent = "🤖 LeRobot dataset (has meta/info.json)";
    info.className = "fs-info on";
  } else {
    info.textContent = data.files_truncated ? `showing first ${data.files.length} files` : "";
    info.className = "fs-info";
  }
  const list = $("#fsList");
  list.replaceChildren();
  for (const d of data.dirs) {
    const row = el("div", { className: "fs-row dir" },
      el("span", { className: "fs-ic" }, "📁"), el("span", {}, d.name));
    row.addEventListener("click", () => fsNavigate(d.path));
    list.append(row);
  }
  for (const f of data.files) {
    list.append(el("div", { className: "fs-row file" },
      el("span", { className: "fs-ic" }, "📄"), el("span", {}, f.name)));
  }
  if (!data.dirs.length && !data.files.length) list.append(el("div", { className: "fs-empty" }, "(empty folder)"));
  $("#fsUp").disabled = data.parent === null;
}

function fsSelectCurrent() {
  if (!fsPicker.current) return toast("Navigate into a folder first", "err");
  const input = $("#" + fsPicker.target);
  input.value = fsPicker.current;
  $("#fsModal").hidden = true;
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

async function fsMkdir() {
  const name = $("#fsNewName").value.trim();
  if (!name) return;
  if (!fsPicker.current) return toast("Open a folder to create in", "err");
  try {
    const res = await api("/api/fs/mkdir", { method: "POST", body: { path: fsPicker.current, name } });
    $("#fsNewName").value = "";
    toast(`Created ${name}`, "ok");
    fsNavigate(res.path);
  } catch (e) { toast(`Create failed: ${e.message}`, "err"); }
}

function wire() {
  document.querySelectorAll(".tab").forEach((t) =>
    t.addEventListener("click", () => switchTab(t.dataset.tab)));

  $("#refreshBtn").addEventListener("click", async () => {
    const btn = $("#refreshBtn");
    btn.innerHTML = '<span class="spin">↻</span> Refresh';
    if (state.tab === "collection") {
      state.colItems = {};
      await loadCollections(true); renderCollections();
    } else if (state.tab === "lerobot") {
      // Not a repo tab — reloading it through loadRepos() would 422 and then blow up on
      // state.repos["lerobot"]. Re-open the dataset instead.
      if (typeof dsReload === "function") await dsReload();
    } else if (state.tab === "jobs" || state.tab === "transfer") {
      await loadJobs();
    } else {
      await loadRepos(state.tab, true); renderRepos();
    }
    btn.textContent = "↻ Refresh";
  });

  ["#repoSearch", "#repoVisFilter", "#repoSort"].forEach((s) =>
    $(s).addEventListener("input", renderRepos));
  $("#repoSelectAll").addEventListener("change", (e) => {
    const type = state.tab;
    const vis = visibleRepos();
    if (e.target.checked) vis.forEach((r) => state.sel[type].add(r.id));
    else vis.forEach((r) => state.sel[type].delete(r.id));
    renderRepos();
  });
  $("#repoDeleteBtn").addEventListener("click", deleteSelectedRepos);

  $("#colSearch").addEventListener("input", renderCollections);
  $("#colDeleteBtn").addEventListener("click", deleteSelectedCollections);
  $("#jobsClear").addEventListener("click", clearFinishedJobs);

  // transfer: download
  $("#dlRepoId").addEventListener("input", showDlDest);
  $("#dlRepoId").addEventListener("change", () => { showDlDest(); detectDownload(); });
  // The folder picker commits its choice by dispatching "change" on the input.
  for (const ev of ["input", "change"]) $("#dlParentDir").addEventListener(ev, showDlDest);
  $("#dlRepoType").addEventListener("change", detectDownload);
  $("#dlStart").addEventListener("click", startDownload);
  // transfer: upload
  $("#upLocalDir").addEventListener("change", detectUpload);
  $("#upStart").addEventListener("click", startUpload);

  // folder picker
  $("#dlBrowse").addEventListener("click", () =>
    openFolderPicker("dlParentDir", "Choose the folder to download into"));
  $("#upBrowse").addEventListener("click", () => openFolderPicker("upLocalDir", "Choose folder to upload"));
  $("#fsRoot").addEventListener("click", () => fsNavigate(fsPicker.sep === "/" ? "/" : ""));
  $("#fsHome").addEventListener("click", () => fsNavigate(fsPicker.home || "~"));
  $("#fsUp").addEventListener("click", () => { if (fsPicker.parent !== null) fsNavigate(fsPicker.parent); });
  $("#fsSelect").addEventListener("click", fsSelectCurrent);
  $("#fsCancel").addEventListener("click", () => ($("#fsModal").hidden = true));
  $("#fsMkdir").addEventListener("click", fsMkdir);
  $("#fsNewName").addEventListener("keydown", (e) => { if (e.key === "Enter") fsMkdir(); });

  $("#editColCancel").addEventListener("click", () => ($("#editColModal").hidden = true));
  $("#editColSave").addEventListener("click", saveEditCollection);

  // close modals on backdrop click / Escape
  document.querySelectorAll(".modal-backdrop").forEach((m) =>
    m.addEventListener("click", (e) => { if (e.target === m) m.hidden = true; }));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") document.querySelectorAll(".modal-backdrop").forEach((m) => (m.hidden = true));
  });
}

/* The sticky offsets can't be hardcoded: the toolbar wraps to two rows on a narrow
 * window, and the app bar's height depends on the font. Measure both and publish them
 * as CSS variables so the toolbar sticks under the tabs and the table header under the
 * toolbar, at any size. */
function measureChrome() {
  const appbar = $(".appbar");
  if (!appbar) return;
  const appH = appbar.getBoundingClientRect().height;
  const toolbar = [...document.querySelectorAll(".view:not([hidden]) .toolbar")][0];
  const toolH = toolbar ? toolbar.getBoundingClientRect().height : 0;
  const root = document.documentElement.style;
  root.setProperty("--appbar-h", `${Math.round(appH)}px`);
  root.setProperty("--chrome-h", `${Math.round(appH + toolH)}px`);
}

function watchChrome() {
  measureChrome();
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(measureChrome);
    document.querySelectorAll(".appbar, .toolbar").forEach((n) => ro.observe(n));
  }
  window.addEventListener("resize", measureChrome);
}

async function init() {
  wire();
  watchChrome();
  try {
    const cfg = await api("/api/config");
    DOWNLOAD_ROOT = cfg.download_root || "";
    $("#dlParentDir").placeholder = DOWNLOAD_ROOT;
    if (!$("#dlParentDir").value.trim()) $("#dlParentDir").value = DOWNLOAD_ROOT;
    showDlDest();
  } catch (e) {
    toast(`Could not read server config: ${e.message}`, "err", 8000);
  }
  try {
    const me = await api("/api/whoami");
    $("#who").textContent = `${me.fullname || me.name} · @${me.name}`;
  } catch (e) {
    $("#who").textContent = "not authenticated";
    toast(e.message, "err", 12000);
  }
  loadJobs();   // a job may still be running from before this page load
  await switchTab("model");
}

init();
