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

    // name (with inline rename)
    const nameTd = el("td", { className: "c-name" });
    const link = el("a", { className: "repo-name", href: r.url, target: "_blank", rel: "noreferrer" }, r.id);
    nameTd.append(link);
    tr.append(nameTd);

    tr.append(el("td", { className: "c-vis" },
      el("span", { className: `badge ${r.private ? "private" : "public"}` }, r.private ? "private" : "public")));
    tr.append(el("td", { className: "c-num" }, fmtNum(r.downloads)));
    tr.append(el("td", { className: "c-num" }, fmtNum(r.likes)));
    tr.append(el("td", { className: "c-date" }, fmtDate(r.lastModified)));

    // actions
    const act = el("td", { className: "c-act" });
    const renameBtn = el("button", { className: "btn tiny ghost", title: "Rename" }, "✎");
    renameBtn.addEventListener("click", () => startRename(r, nameTd, link));
    const visBtn = el("button", { className: "btn tiny ghost", title: "Toggle visibility" },
      r.private ? "Make public" : "Make private");
    visBtn.addEventListener("click", () => toggleVisibility(r, visBtn));
    act.append(renameBtn, " ", visBtn);
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
  const isCol = tab === "collection";
  $("#repoView").hidden = isCol;
  $("#collectionView").hidden = !isCol;
  if (isCol) {
    await loadCollections();
    renderCollections();
  } else {
    await loadRepos(tab);
    renderRepos();
  }
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

  $("#editColCancel").addEventListener("click", () => ($("#editColModal").hidden = true));
  $("#editColSave").addEventListener("click", saveEditCollection);

  // close modals on backdrop click / Escape
  document.querySelectorAll(".modal-backdrop").forEach((m) =>
    m.addEventListener("click", (e) => { if (e.target === m) m.hidden = true; }));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") document.querySelectorAll(".modal-backdrop").forEach((m) => (m.hidden = true));
  });
}

async function init() {
  wire();
  try {
    const me = await api("/api/whoami");
    $("#who").textContent = `${me.fullname || me.name} · @${me.name}`;
  } catch (e) {
    $("#who").textContent = "not authenticated";
    toast(e.message, "err", 12000);
  }
  await switchTab("model");
}

init();
