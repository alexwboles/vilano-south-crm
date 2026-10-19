/* Vilano South GR CRM — frontend (3.7.4). Vanilla JS, no dependencies. */

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

let csrfToken = null;
let userRole = "user";

async function api(path, opts = {}) {
  const method = (opts.method || "GET").toUpperCase();
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  if (csrfToken && method !== "GET" && method !== "HEAD") headers["X-CSRF-Token"] = csrfToken;
  let r;
  try {
    r = await fetch(path, { ...opts, headers });
  } catch (e) {
    // Network failure on a mutation: queue it for background sync instead of
    // losing it. Reads just fail — the service worker serves cached data.
    if (method !== "GET" && method !== "HEAD" && queueableMutation(path, opts.body)) {
      await queueMutation(path, method, opts.body);
      throw new Error("Offline — change queued. It will sync when you're back online.");
    }
    throw e;
  }
  if (r.status === 401) { location.href = "/login.html"; throw new Error("signed out"); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
  return data;
}

// Mutations safe to queue offline: data writes only. Auth, file uploads,
// backups, imports, and installs are never queued.
function queueableMutation(path, body) {
  if (!path.startsWith("/api/")) return false;
  if (["/api/login", "/api/setup", "/api/logout", "/api/password", "/api/documents",
       "/api/admin/backup", "/api/admin/import-interactions", "/api/admin/update-install",
       "/api/update-install"].includes(path)) return false;
  return true;
}

// ---- offline outbox: failed mutations wait in IndexedDB, the service
// worker replays them via Background Sync when connectivity returns ----
const OUTBOX_DB = "grcrm-outbox";
function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(OUTBOX_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("queue", { autoIncrement: true });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function outboxCount() {
  try {
    const db = await idb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("queue", "readonly");
      const q = tx.objectStore("queue").count();
      q.onsuccess = () => resolve(q.result);
      q.onerror = () => reject(q.error);
    });
  } catch { return 0; }
}
async function queueMutation(path, method, body) {
  try {
    const db = await idb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction("queue", "readwrite");
      tx.objectStore("queue").add({
        path, method, body: typeof body === "string" ? body : null,
        csrf: csrfToken, ts: Date.now(),
      });
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    if ("serviceWorker" in navigator) {
      const reg = await navigator.serviceWorker.ready.catch(() => null);
      if (reg && "sync" in reg) { try { await reg.sync.register("grcrm-outbox"); } catch {} }
    }
  } catch { /* queueing failed — the error below still informs the user */ }
  updateOfflineIndicator();
}
async function updateOfflineIndicator() {
  const bar = $("#offline-banner");
  if (!bar) return;
  const n = await outboxCount();
  const offline = !navigator.onLine;
  if (n > 0) {
    bar.hidden = false;
    $("#offline-text").textContent = offline
      ? `Offline — ${n} change${n === 1 ? "" : "s"} queued. They'll sync when you're back online.`
      : `Syncing ${n} queued change${n === 1 ? "" : "s"}…`;
  } else if (offline) {
    bar.hidden = false;
    $("#offline-text").textContent = "You're offline — showing cached data. Changes will queue.";
  } else {
    bar.hidden = true;
  }
}
window.addEventListener("online", updateOfflineIndicator);
window.addEventListener("offline", updateOfflineIndicator);
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data && e.data.type === "outbox") updateOfflineIndicator();
  });
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove("show"), 2400);
}

// A record that vanished between list render and action (deleted in another
// tab, etc.): the API answers 404 "not-found". Say so plainly and refresh
// instead of showing the raw error.
function isNotFound(e) { return !!e && e.message === "not-found"; }
function notFoundToast(what) {
  toast(`That ${what} is no longer on record — refreshing the list.`);
}

// "Rep. Andrew Smith (R-FL-12)" / "Sen. Laura Richards (R-FL)"
function memberLabel(m) {
  const title = m.chamber === "house" ? "Rep." : "Sen.";
  const geo = m.chamber === "house"
    ? `(${m.party}-${m.state}-${m.district})`
    : `(${m.party}-${m.state})`;
  return `${title} ${m.first_name} ${m.last_name} ${geo}`;
}

function fmtDate(iso) {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function isOverdue(iso) {
  if (!iso) return false;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d) < today;
}

const STATUS_LABEL = { open: "Open", in_progress: "In progress", done: "Done" };
// Searchable combobox: type to filter, click or Enter to pick.
// Returns { get value(), setItems(items), set(id) }.
function makeCombo(el, { items = [], selectedId = null, placeholder = "Type to search…", onChange = null } = {}) {
  el.innerHTML = `<input type="text" placeholder="${esc(placeholder)}" autocomplete="off" aria-label="${esc(placeholder)}">
    <div class="combo-list" role="listbox"></div>`;
  const input = el.querySelector("input");
  const list = el.querySelector(".combo-list");
  let current = items;
  let value = selectedId;
  let hot = -1;

  const labelOf = (id) => (current.find(x => String(x.id) === String(id)) || {}).label || "";
  const render = (filter = "") => {
    const q = filter.trim().toLowerCase();
    const shown = q ? current.filter(x => x.label.toLowerCase().includes(q)) : current;
    hot = -1;
    list.innerHTML = shown.length
      ? shown.map((x, i) => `<div class="combo-item" data-i="${i}" role="option">${esc(x.label)}</div>`).join("")
      : `<div class="combo-empty">No matches.</div>`;
    list.querySelectorAll(".combo-item").forEach(n => {
      n.onclick = () => pick(shown[Number(n.dataset.i)]);
    });
    list._shown = shown;
  };
  const pick = (item) => {
    if (!item) return;
    value = item.id;
    input.value = item.label;
    el.classList.remove("open");
    onChange && onChange(item.id);
  };
  input.addEventListener("focus", () => { render(input.value); el.classList.add("open"); });
  input.addEventListener("input", () => { render(input.value); el.classList.add("open"); });
  input.addEventListener("keydown", (e) => {
    const shown = list._shown || [];
    if (e.key === "Escape") { el.classList.remove("open"); }
    else if (e.key === "ArrowDown" && shown.length) { e.preventDefault(); hot = (hot + 1) % shown.length; hl(); }
    else if (e.key === "ArrowUp" && shown.length) { e.preventDefault(); hot = (hot - 1 + shown.length) % shown.length; hl(); }
    else if (e.key === "Enter" && shown.length) { e.preventDefault(); pick(shown[hot >= 0 ? hot : 0]); }
  });
  const hl = () => list.querySelectorAll(".combo-item").forEach((n, i) => n.classList.toggle("hot", i === hot));
  document.addEventListener("click", (e) => { if (!el.contains(e.target)) el.classList.remove("open"); });
  if (value != null) input.value = labelOf(value);

  return {
    get value() { return value; },
    setItems(next) { current = next; value = null; input.value = ""; render(""); },
    set(id) { value = id; input.value = labelOf(id); },
  };
}

function statusPill(s) {
  return `<span class="pill ${esc(s)}">${esc(STATUS_LABEL[s] || s)}</span>`;
}

// Chamber badge: Senate = solid navy, House = navy outline. Dignified, scannable.
function chamberBadge(chamber) {
  const house = chamber === "house";
  return `<span class="chamber ${house ? "house" : "senate"}">${house ? "House" : "Senate"}</span>`;
}

// Committee chip: a real <button> so it's clickable + keyboard-accessible.
// Opens the Committee view (delegated click on [data-committee]).
function committeeChip(name) {
  return `<button class="committee-chip" data-committee="${esc(name)}" title="View committee">${esc(name)}</button>`;
}

// Shared member staff section (interaction detail + committee view).
function memberStaffHTML(m) {
  const cur = (m?.current_staff || []).map(s =>
    `<div class="assign-row"><span class="member-name">${esc(staffName(s))}</span><span class="cap">${esc(s.title || "")}</span></div>`).join("");
  const former = (m?.former_staff || []).map(s =>
    `<div class="assign-row"><span>${esc(staffName(s))}</span><span class="former-tag">Former</span><span class="cap">${esc(s.title || "")}</span></div>`).join("");
  return cur || former ? cur + former : '<span style="color:var(--ink-faint)">No staff on record.</span>';
}

// Staffers (aides/assistants): "Jane Doe" / "Jane Doe, Legislative Director".
function staffName(s) {
  return `${s.first_name || ""} ${s.last_name || ""}`.trim();
}
// Find a staffer's identity across every member's current + former staff lists.
function lookupStaffer(id) {
  for (const m of state.members || []) {
    for (const s of [...(m.current_staff || []), ...(m.former_staff || [])]) {
      if (s.id === id) return s;
    }
  }
  return null;
}
function staffWithTitle(s) {
  const n = staffName(s);
  return s.title ? `${n}, ${s.title}` : n;
}
// "via Jane Doe, Legislative Director" — interactions stay tied to a member.
function viaLine(r) {
  if (!r.staff_first_name) return "";
  const t = r.staff_title ? `, ${r.staff_title}` : "";
  return `<div class="via">via ${esc(r.staff_first_name)} ${esc(r.staff_last_name)}${esc(t)}</div>`;
}
function localISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function todayISO() {
  return localISO(new Date());
}

// Branded empty state: serif headline + one line of guidance + optional CTA button.
function emptyState(title, sub, ctaLabel, ctaKey, ctaAttrs) {
  const btn = ctaLabel
    ? `<button class="btn primary" data-empty-cta="${esc(ctaKey)}"${ctaAttrs ? " " + ctaAttrs : ""}>${esc(ctaLabel)}</button>`
    : "";
  return `<div class="empty-state"><div class="empty-title">${esc(title)}</div>` +
    `<div class="empty-sub">${esc(sub)}</div>${btn}</div>`;
}
function wireEmptyCta(scope, key, fn) {
  const b = scope.querySelector(`[data-empty-cta="${key}"]`);
  if (b) b.addEventListener("click", fn);
}

// ---------- panel & modal ----------
function openPanel(title, bodyHTML, footHTML) {
  $("#panel-title").textContent = title;
  $("#panel-body").innerHTML = bodyHTML;
  $("#panel-foot").innerHTML = footHTML || "";
  $("#panel").classList.add("show");
  $("#panel").setAttribute("aria-hidden", "false");
  $("#scrim").classList.add("show");
}
function closePanel() {
  $("#panel").classList.remove("show");
  $("#panel").setAttribute("aria-hidden", "true");
  $("#scrim").classList.remove("show");
}
function openModal(title, bodyHTML, footHTML) {
  $("#modal-title").textContent = title;
  $("#modal-body").innerHTML = bodyHTML;
  $("#modal-foot").innerHTML = footHTML || "";
  $("#modal-wrap").classList.add("show");
}
function closeModal() { $("#modal-wrap").classList.remove("show"); }

$("#panel-close").addEventListener("click", closePanel);
$("#scrim").addEventListener("click", closePanel);
$("#modal-close").addEventListener("click", closeModal);
$("#modal-scrim").addEventListener("click", closeModal);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { closePanel(); closeModal(); return; }
  // "L" opens the log panel — never while typing or when a panel/modal is open.
  if ((e.key === "l" || e.key === "L") && !e.metaKey && !e.ctrlKey && !e.altKey) {
    const t = e.target;
    const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
    if (!typing && !$("#panel").classList.contains("show") && !$("#modal-wrap").classList.contains("show")) {
      e.preventDefault();
      openInteractionPanel(null);
    }
  }
});
$("#quick-log").addEventListener("click", () => openInteractionPanel(null));

function confirmDialog(title, message, onYes) {
  openModal(title, `<p style="margin:0 0 6px">${esc(message)}</p>`,
    `<button class="btn" id="cf-no">Cancel</button><button class="btn danger" id="cf-yes">Delete</button>`);
  $("#cf-no").onclick = closeModal;
  $("#cf-yes").onclick = async () => { closeModal(); await onYes(); };
}

function fieldErr(msg) {
  const e = $("#form-err");
  if (!e) return;
  if (msg) { e.textContent = msg; e.classList.add("show"); }
  else e.classList.remove("show");
}

// Submit guard: disable a save button while its async work is in flight so a
// double click / double Enter can't create duplicate records. The button is
// re-enabled if the request fails (on success the panel/modal usually closes).
function guard(btn, fn) {
  return async function (...args) {
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    try { return await fn.apply(this, args); }
    finally { btn.disabled = false; }
  };
}

// ---------- state ----------
const state = { members: [], view: "interactions" };

// =====================================================================
// INTERACTION LOG
// =====================================================================
const ifilter = { q: "", chamber: "", status: "", from: "", to: "", type: "" };
const INTERACTION_TYPES = ["Meeting", "Call", "Email", "Hallway touch"];

async function renderInteractions() {
  const v = $("#view");
  v.innerHTML = `
    <div class="view-head">
      <div><h2>Interaction Log</h2><p class="hint">Every meeting and touch with members of Congress.</p></div>
      <div class="view-actions">
        <button class="btn" id="export-csv-btn">Export CSV</button>
        <button class="btn primary" id="log-btn">Log interaction</button>
      </div>
    </div>
    <div id="attention-strip"></div>
    <div class="filters">
      <div class="field grow"><label>Search</label><input type="text" id="f-q" placeholder="Member, summary, next step…" value="${esc(ifilter.q)}"></div>
      <div class="field"><label>Chamber</label><select id="f-chamber">
        <option value="">All</option><option value="house" ${ifilter.chamber === "house" ? "selected" : ""}>House</option>
        <option value="senate" ${ifilter.chamber === "senate" ? "selected" : ""}>Senate</option></select></div>
      <div class="field"><label>Status</label><select id="f-status">
        <option value="">All</option>${Object.entries(STATUS_LABEL).map(([k, l]) =>
          `<option value="${k}" ${ifilter.status === k ? "selected" : ""}>${l}</option>`).join("")}</select></div>
      <div class="field"><label>Type</label><select id="f-type">
        <option value="">All</option>${INTERACTION_TYPES.map(t =>
          `<option value="${t}" ${ifilter.type === t ? "selected" : ""}>${t}</option>`).join("")}</select></div>
      <div class="field"><label>From</label><input type="date" id="f-from" value="${esc(ifilter.from)}"></div>
      <div class="field"><label>To</label><input type="date" id="f-to" value="${esc(ifilter.to)}"></div>
      <div class="field"><label>&nbsp;</label><button class="btn" id="f-clear">Clear</button></div>
    </div>
    <p class="result-count" id="res-count"></p>
    <div class="card ix-list"><div class="ix-head"><span>Interaction</span><span>Status</span></div><div id="ix-rows"></div></div>`;
  $("#log-btn").onclick = () => openInteractionPanel(null);
  $("#export-csv-btn").onclick = () => {
    const p = new URLSearchParams();
    if (ifilter.q) p.set("q", ifilter.q);
    if (ifilter.chamber) p.set("chamber", ifilter.chamber);
    if (ifilter.status) p.set("status", ifilter.status);
    if (ifilter.type) p.set("type", ifilter.type);
    if (ifilter.from) p.set("from", ifilter.from);
    if (ifilter.to) p.set("to", ifilter.to);
    const qs = p.toString();
    window.location.href = "/api/interactions.csv" + (qs ? "?" + qs : "");
  };
  renderAttentionStrip();
  const apply = () => {
    ifilter.q = $("#f-q").value; ifilter.chamber = $("#f-chamber").value;
    ifilter.status = $("#f-status").value; ifilter.type = $("#f-type").value;
    ifilter.from = $("#f-from").value; ifilter.to = $("#f-to").value;
    loadInteractions();
  };
  ["f-q", "f-from", "f-to"].forEach(id => $("#" + id).addEventListener("input", apply));
  ["f-chamber", "f-status", "f-type"].forEach(id => $("#" + id).addEventListener("change", apply));
  $("#f-clear").onclick = () => { Object.keys(ifilter).forEach(k => ifilter[k] = ""); renderInteractions(); };
  state.members = await api("/api/members");
  await loadInteractions();
}

// Needs-attention data, grouped for the briefing-panel treatment (dark navy
// header, Quorum idiom). Shared by the interaction-log strip and the dashboard.
async function attentionGroups() {
  let data;
  try { data = await api("/api/attention"); }
  catch { return null; }
  let quiet = [];
  try { quiet = (await api("/api/members/needing-contact")) || []; } catch { /* strip still renders */ }
  const groups = [];
  const stale = data.stale_interactions || [];
  if (stale.length) groups.push({
    tag: "stale", label: "Stale follow-ups",
    items: stale.map(r => ({ kind: "interaction", id: r.id,
      html: `<span class="att-tag stale">Stale</span><span><span class="who">${esc(r.member_label)}</span> <span class="what">— next step "${esc(r.next_step)}" from ${esc(fmtDate(r.date))} is still ${esc(STATUS_LABEL[r.status] || r.status)}</span></span>` })),
  });
  const overdue = data.overdue_tasks || [];
  if (overdue.length) groups.push({
    tag: "overdue", label: "Overdue tasks",
    items: overdue.map(t => ({ kind: "task", id: t.id,
      html: `<span class="att-tag overdue">Overdue</span><span><span class="who">"${esc(t.title)}"</span> <span class="what">${t.group_name ? `(${esc(t.group_name)}) ` : ""}was due ${esc(fmtDate(t.due_date))}</span></span>` })),
  });
  const upcoming = data.upcoming_events || [];
  if (upcoming.length) groups.push({
    tag: "upcoming", label: "Coming up",
    items: upcoming.map(e => ({ kind: "event", id: e.id,
      html: `<span class="att-tag upcoming">Upcoming</span><span><span class="who">${esc(e.description)}</span> <span class="what">— ${esc(fmtDate(e.date))}${e.lead_person ? ` (${esc(e.lead_person)})` : ""}</span></span>` })),
  });
  const qb = (quiet || []).slice(0, 8);
  if (qb.length) groups.push({
    tag: "touchbase", label: "Touch base",
    items: qb.map(m => ({ kind: "member", id: m.id,
      html: `<span class="att-tag touchbase">Touch base</span><span><span class="who">${esc(m.member_label)}</span> <span class="what">— ${m.last_contact ? `no logged contact since ${esc(fmtDate(m.last_contact))}` : "never contacted on record"}</span></span>` })),
  });
  return groups;
}

function attentionPanelHTML(groups) {
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  return `<div class="card"><div class="p-head"><h3>Needs attention</h3><span class="p-sub">${total} open item${total === 1 ? "" : "s"}</span></div>
    <div class="attn-list">${groups.map(g => `
      <div class="attn-group">${esc(g.label)}</div>
      <ul>${g.items.map(i => `<li class="attn-item" data-kind="${i.kind}" data-id="${i.id}" role="button" tabindex="0" title="Open">${i.html}</li>`).join("")}</ul>`).join("")}
    </div></div>`;
}

// Clicking a needs-attention item opens it for updating.
async function openAttentionItem(kind, id) {
  try {
    if (kind === "interaction") {
      const r = await api("/api/interactions/" + id);
      openInteractionPanel(r);
    } else if (kind === "task") {
      const t = await api("/api/tasks/" + id);
      openTaskModal(t.group_id, t);
    } else if (kind === "event") {
      const e = await api("/api/events/" + id);
      openEventModal(e);
    } else if (kind === "member") {
      openMemberFromSearch(id);
    }
  } catch (e) { if (e.message !== "signed out") toast("Error: " + e.message); }
}

function wireAttentionClicks(box) {
  if (!box) return;
  box.querySelectorAll(".attn-item[data-kind]").forEach(li => {
    const open = () => openAttentionItem(li.dataset.kind, li.dataset.id);
    li.onclick = open;
    li.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } };
  });
}

// Needs-attention strip on the interaction log (same data as the dashboard).
async function renderAttentionStrip() {
  const box = $("#attention-strip");
  if (!box) return;
  const groups = await attentionGroups();
  if (!groups || !groups.length) return;
  box.innerHTML = attentionPanelHTML(groups);
  wireAttentionClicks(box);
}

async function loadInteractions() {
  const p = new URLSearchParams();
  if (ifilter.q) p.set("q", ifilter.q);
  if (ifilter.chamber) p.set("chamber", ifilter.chamber);
  if (ifilter.status) p.set("status", ifilter.status);
  if (ifilter.type) p.set("type", ifilter.type);
  if (ifilter.from) p.set("from", ifilter.from);
  if (ifilter.to) p.set("to", ifilter.to);
  const rows = await api("/api/interactions?" + p.toString());
  $("#res-count").textContent = `${rows.length} interaction${rows.length === 1 ? "" : "s"}`;
  const wrap = $("#ix-rows");
  if (!rows.length) {
    const filtered = Object.values(ifilter).some(v => v);
    wrap.innerHTML = filtered
      ? emptyState("No interactions match these filters.", "Try widening the search or clearing the filters.", "Clear filters", "clear")
      : emptyState("No interactions logged yet.", "Record every meeting and touch with members of Congress.", "Log interaction", "log");
    wireEmptyCta(wrap, "log", () => openInteractionPanel(null));
    wireEmptyCta(wrap, "clear", () => $("#f-clear").click());
    return;
  }
  const byMember = new Map(state.members.map(m => [m.id, m]));
  wrap.innerHTML = rows.map(r => {
    const m = byMember.get(r.member_id);
    // Identity once: memberLabel already carries party/state/district.
    const ch = r.chamber === "senate" ? "Senate" : "House";
    const comms = m ? m.committees.map(committeeChip).join("") : "";
    return `
    <div class="ix-row" data-id="${r.id}">
      <div class="ix-r1">
        <span class="ix-member">${esc(memberLabel(r))}<span class="ix-ch">${ch}</span></span>
        <span class="ix-date">${esc(fmtDate(r.date))}${r.interaction_type ? `<span class="ix-type-badge">${esc(r.interaction_type)}</span>` : ""}</span>
      </div>
      <div class="ix-summary">${esc(r.summary)}</div>
      <div class="ix-r3">
        ${statusPill(r.status)}
        ${r.next_step ? `<span class="ix-next">Next: ${esc(r.next_step)}</span>` : ""}
        ${comms ? `<span class="ix-comms">${comms}</span>` : ""}
        ${viaLine(r)}
      </div>
      <div class="ix-detail" style="display:none"></div>
    </div>`;
  }).join("");
  // wire expand
  $$("#ix-rows .ix-row").forEach((el, i) => {
    el.addEventListener("click", (e) => {
      if (e.target.closest("[data-committee]")) return; // committee chip handles itself
      toggleInteractionDetail(el, rows[i], byMember.get(rows[i].member_id));
    });
  });
}

function toggleInteractionDetail(el, r, m) {
  const d = el.querySelector(".ix-detail");
  if (d.style.display !== "none") { d.style.display = "none"; d.innerHTML = ""; return; }
  d.innerHTML = `<div class="detail-box">
    <div class="full"><div class="lbl">Summary</div><div class="val">${esc(r.summary)}</div></div>
    <div><div class="lbl">Member</div><div class="val"><span class="member-name">${esc(memberLabel(r))}</span><br>
      ${chamberBadge(r.chamber)}</div></div>
    ${r.staff_first_name ? `<div><div class="lbl">Staffer</div><div class="val">${esc(r.staff_first_name)} ${esc(r.staff_last_name)}${r.staff_title ? `, ${esc(r.staff_title)}` : ""}</div></div>` : ""}
    <div><div class="lbl">Committees</div><div class="val">${m && m.committees.length ? m.committees.map(committeeChip).join("") : "—"}</div></div>
    <div class="full"><div class="lbl">Staff</div><div class="val">${memberStaffHTML(m)}</div></div>
    ${r.parent_id ? `<div class="full"><div class="lbl">Follow-up to</div><div class="val"><button class="linklike" data-act="goparent">${esc(fmtDate(r.parent_date))} — ${esc(r.parent_label || "")}</button></div></div>` : ""}
    <div class="full"><div class="lbl">Follow-ups</div><div class="val" id="ix-children-${r.id}"><span style="color:var(--ink-faint)">Loading…</span></div></div>
    <div class="full"><div class="lbl">Next step</div><div class="val">${esc(r.next_step || "—")}</div></div>
    <div><div class="lbl">Type</div><div class="val">${esc(r.interaction_type || "—")}</div></div>
    <div><div class="lbl">Status</div><div class="val"><select class="status-sel ${esc(r.status)}" id="ix-d-status-${r.id}" aria-label="Status">
      ${Object.entries(STATUS_LABEL).map(([k, l]) => `<option value="${k}" ${r.status === k ? "selected" : ""}>${l}</option>`).join("")}
    </select></div></div>
    <div><div class="lbl">Date</div><div class="val">${esc(fmtDate(r.date))}</div></div>
    <div class="full" id="ix-outcomes-${r.id}" style="${r.status === "done" ? "" : "display:none"}">
      <div class="lbl">Outcomes</div>
      <div class="val">
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
          <button class="btn small" data-act="oc-task">New task</button>
          <button class="btn small" data-act="oc-event">New event</button>
        </div>
        <div id="oc-form-${r.id}"></div>
      </div>
    </div>
    <div class="detail-actions">
      <button class="btn small" data-act="followup">Log follow-up</button>
      <button class="btn small" data-act="edit">Edit</button>
      <button class="btn small danger" data-act="del">Delete</button>
    </div>
  </div>`;
  d.style.display = "block";

  // Follow-ups list (lazy).
  api("/api/interactions/" + r.id + "/followups").then(kids => {
    const box = d.querySelector(`#ix-children-${r.id}`);
    if (!box || !box.isConnected) return;
    box.innerHTML = kids.length ? kids.map(k =>
      `<div class="assign-row"><span style="white-space:nowrap">${esc(fmtDate(k.date))}</span>
       <span class="trunc">${esc(k.summary)}</span>${statusPill(k.status)}
       <button class="linklike" data-openfu="${k.id}">Open</button></div>`).join("")
      : '<span style="color:var(--ink-faint)">None yet.</span>';
    box.querySelectorAll("[data-openfu]").forEach(b => b.onclick = () => openInteractionById(b.dataset.openfu));
  }).catch(() => {
    const box = d.querySelector(`#ix-children-${r.id}`);
    if (box && box.isConnected) box.innerHTML = '<span style="color:var(--ink-faint)">None yet.</span>';
  });

  const openRow = (id) => openInteractionById(id);
  d.querySelector('[data-act="followup"]').onclick = (e) => {
    e.stopPropagation();
    openInteractionPanel(null, {
      member_id: r.member_id, staff_id: r.staff_id || null,
      staff_first_name: r.staff_first_name, staff_last_name: r.staff_last_name,
      staff_title: r.staff_title,
      interaction_type: r.interaction_type || null,
      parent_id: r.id, parentLabel: `${fmtDate(r.date)} — ${memberLabel(r)}`,
    });
  };
  const gp = d.querySelector('[data-act="goparent"]');
  if (gp) gp.onclick = (e) => { e.stopPropagation(); openRow(r.parent_id); };
  d.querySelector('[data-act="edit"]').onclick = (e) => { e.stopPropagation(); openInteractionPanel(r); };
  d.querySelector('[data-act="del"]').onclick = (e) => {
    e.stopPropagation();
    confirmDialog("Delete interaction", "Delete this interaction? This cannot be undone.", async () => {
      await api("/api/interactions/" + r.id, { method: "DELETE" });
      toast("Interaction deleted."); loadInteractions();
    });
  };

  // Inline status: setting Done reveals the outcome shortcuts.
  d.querySelector(`#ix-d-status-${r.id}`).onchange = async (e) => {
    const v = e.target.value;
    try {
      await api(`/api/interactions/${r.id}/status`, { method: "POST", body: JSON.stringify({ status: v }) });
      r.status = v;
      e.target.className = "status-sel " + v;
      el.querySelector(".ix-r3 .pill").outerHTML = statusPill(v);
      d.querySelector(`#ix-outcomes-${r.id}`).style.display = v === "done" ? "" : "none";
      toast("Status updated.");
    } catch (err) { toast("Error: " + err.message); e.target.value = r.status; }
  };

  d.querySelector('[data-act="oc-task"]').onclick = () => renderOutcomeTaskForm(d, r);
  d.querySelector('[data-act="oc-event"]').onclick = () => renderOutcomeEventForm(d, r);
}

// Scroll to an interaction row and expand it (used by follow-up links).
function openInteractionById(id) {
  const row = document.querySelector(`#ix-rows .ix-row[data-id="${id}"]`);
  if (row) {
    row.scrollIntoView({ block: "center" });
    const d = row.querySelector(".ix-detail");
    if (d && d.style.display === "none") row.click();
  } else {
    toast("That interaction isn't in the current view.");
  }
}

function plusDaysISO(n) {
  const t = new Date();
  t.setDate(t.getDate() + n);
  return localISO(t);
}

async function renderOutcomeTaskForm(d, r) {
  const box = d.querySelector(`#oc-form-${r.id}`);
  let groups = [];
  try { groups = await api("/api/projects"); } catch (e) { toast("Error: " + e.message); return; }
  if (!groups.length) { toast("Create a project group first."); return; }
  box.innerHTML = `
    <div class="oc-form">
      <div class="field"><label>Project group</label><select id="oc-group">
        ${groups.map(g => `<option value="${g.id}">${esc(g.name)}</option>`).join("")}</select></div>
      <div class="field"><label>Task title</label><input type="text" id="oc-title"
        value="${esc(r.next_step || r.summary.slice(0, 80))}"></div>
      <div style="display:flex;gap:8px">
        <button class="btn small primary" id="oc-create">Create task</button>
        <button class="btn small" id="oc-cancel">Cancel</button>
      </div>
    </div>`;
  box.querySelector("#oc-cancel").onclick = () => box.innerHTML = "";
  const ocCreateTask = box.querySelector("#oc-create");
  ocCreateTask.onclick = guard(ocCreateTask, async () => {
    const title = box.querySelector("#oc-title").value.trim();
    if (!title) { toast("Task title is required."); return; }
    try {
      await api(`/api/projects/groups/${box.querySelector("#oc-group").value}/tasks`,
        { method: "POST", body: JSON.stringify({ title }) });
      box.innerHTML = "";
      toast("Task created.");
    } catch (e) { toast("Error: " + e.message); }
  });
}

function renderOutcomeEventForm(d, r) {
  const box = d.querySelector(`#oc-form-${r.id}`);
  box.innerHTML = `
    <div class="oc-form">
      <div class="field"><label>Description</label><input type="text" id="oc-desc"
        value="${esc(r.next_step || "")}" placeholder="e.g. Follow-up call"></div>
      <div class="form-row">
        <div class="field"><label>Date</label><input type="date" id="oc-date" value="${plusDaysISO(7)}"></div>
        <div class="field"><label>Lead person</label><input type="text" id="oc-lead" placeholder="e.g. T. Boles"></div>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn small primary" id="oc-create">Create event</button>
        <button class="btn small" id="oc-cancel">Cancel</button>
      </div>
    </div>`;
  box.querySelector("#oc-cancel").onclick = () => box.innerHTML = "";
  const ocCreateEvent = box.querySelector("#oc-create");
  ocCreateEvent.onclick = guard(ocCreateEvent, async () => {
    const payload = {
      description: box.querySelector("#oc-desc").value,
      date: box.querySelector("#oc-date").value,
      lead_person: box.querySelector("#oc-lead").value,
    };
    try {
      await api("/api/events", { method: "POST", body: JSON.stringify(payload) });
      box.innerHTML = "";
      toast("Event created.");
    } catch (e) { toast("Error: " + e.message); }
  });
}

// Interaction templates: type chips + summary starters + next-step suggestions.
const IX_TYPES = ["Meeting", "Call", "Email", "Hallway touch"];
const IX_STARTERS = {
  "Meeting": "Met with ",
  "Call": "Phone call with ",
  "Email": "Emailed ",
  "Hallway touch": "Brief hallway conversation with ",
};
const NEXT_STEP_SUGGESTIONS = ["Schedule follow-up call", "Send briefing memo", "Send one-pager", "Draft request letter"];

function getRecentMembers() {
  try { return JSON.parse(localStorage.getItem("vs_recent_members") || "[]"); } catch { return []; }
}
function pushRecentMember(id) {
  try {
    const r = [id, ...getRecentMembers().filter(x => x !== id)].slice(0, 5);
    localStorage.setItem("vs_recent_members", JSON.stringify(r));
  } catch {}
}

function openInteractionPanel(existing, prefill) {
  const isEdit = !!existing;
  const today = todayISO();
  // Smart default: recently-used members first (new entries only).
  const recent = getRecentMembers();
  const ordered = isEdit ? state.members : [...state.members].sort((a, b) => {
    const ai = recent.indexOf(a.id), bi = recent.indexOf(b.id);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });
  const selMemberId = prefill?.member_id || existing?.member_id;
  const memberOpts = ordered.map(m =>
    `<option value="${m.id}" ${selMemberId === m.id ? "selected" : ""}>${esc(memberLabel(m))}</option>`).join("");
  let ixType = prefill?.interaction_type || existing?.interaction_type || "";

  openPanel(isEdit ? "Edit interaction" : "Log interaction", `
    <div class="form-err" id="form-err"></div>
    ${prefill?.parent_id ? `<div class="followup-note"><span>Follow-up to ${esc(prefill.parentLabel || "previous interaction")}</span>
      <label class="check"><input type="checkbox" id="p-markdone"> Mark previous Done</label></div>` : ""}
    <div class="field"><label>Type <span class="cap">— optional</span></label>
      <div class="chip-row" id="p-types">
        ${IX_TYPES.map(t => `<button type="button" class="chip-btn${ixType === t ? " on" : ""}" data-type="${t}">${t}</button>`).join("")}
      </div>
    </div>
    <div class="field">
      <label>Member</label>
      <div style="display:flex;gap:8px;align-items:center">
        <div class="combo" id="p-member-combo" style="flex:1"></div>
        <span id="p-chamber"></span>
      </div>
      <div style="margin-top:6px"><button class="linklike" id="p-newm">+ New member</button></div>
    </div>
    <div class="field">
      <label>Staffer <span class="cap">— optional</span></label>
      <div class="combo" id="p-staffer-combo"></div>
    </div>
    <div id="p-newm-form" style="display:none;border:1px solid var(--line);border-radius:0;padding:12px;margin-bottom:14px">
      <div class="form-row">
        <div class="field"><label>First name</label><input type="text" id="nm-first"></div>
        <div class="field"><label>Last name</label><input type="text" id="nm-last"></div>
      </div>
      <div class="form-row three">
        <div class="field"><label>Chamber</label><select id="nm-chamber"><option value="house">House</option><option value="senate">Senate</option></select></div>
        <div class="field"><label>Party</label><select id="nm-party"><option value="R">R</option><option value="D">D</option><option value="I">I</option></select></div>
        <div class="field"><label>State</label><input type="text" id="nm-state" maxlength="2" placeholder="FL" style="text-transform:uppercase"></div>
      </div>
      <div class="field" id="nm-district-wrap"><label>District</label><input type="number" id="nm-district" min="1" placeholder="12"></div>
      <div class="field"><label>Committees <span class="cap">— comma separated</span></label>
        <input type="text" id="nm-committees" placeholder="Appropriations, Veterans' Affairs"></div>
    </div>
    <div class="field"><label>Date</label><input type="date" id="p-date" value="${esc(existing?.date || today)}"></div>
    <div class="field"><label>Summary notes</label>
      <div class="dict-wrap">
        <textarea id="p-summary" rows="4" placeholder="What was discussed…">${esc(existing?.summary || "")}</textarea>
        <button type="button" class="mic-btn" id="p-mic" title="Dictate summary" aria-label="Dictate summary" style="display:none">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><path d="M12 17v4"/></svg>
        </button>
      </div>
    </div>
    <div class="field"><label>Next step</label><input type="text" id="p-next" placeholder="e.g. Send files we talked about" value="${esc(existing?.next_step || "")}">
      <div class="chip-row" id="p-nextsugs" style="margin-top:8px">
        ${NEXT_STEP_SUGGESTIONS.map(s => `<button type="button" class="chip-btn sm" data-sug="${esc(s)}">${esc(s)}</button>`).join("")}
      </div>
    </div>
    <div class="field"><label>Status</label><select id="p-status">
      ${Object.entries(STATUS_LABEL).map(([k, l]) => `<option value="${k}" ${(existing?.status || "open") === k ? "selected" : ""}>${l}</option>`).join("")}
    </select></div>
  `, `<button class="btn" id="p-cancel">Cancel</button>${isEdit ? "" : `<button class="btn" id="p-another">Log another</button>`}<button class="btn primary" id="p-save">${isEdit ? "Save changes" : "Log interaction"}</button>`);

  $("#p-cancel").onclick = closePanel;
  $("#p-newm").onclick = () => {
    const f = $("#p-newm-form");
    const show = f.style.display === "none";
    f.style.display = show ? "block" : "none";
    $("#p-newm").textContent = show ? "− Use existing member" : "+ New member";
    $("#p-member-combo").querySelector("input").disabled = show;
  };
  $("#nm-chamber").onchange = (e) => {
    $("#nm-district-wrap").style.display = e.target.value === "house" ? "block" : "none";
  };

  // Template chips: set type; drop a starter into an empty summary.
  $$("#p-types .chip-btn").forEach(b => b.onclick = () => {
    ixType = ixType === b.dataset.type ? "" : b.dataset.type;
    $$("#p-types .chip-btn").forEach(x => x.classList.toggle("on", x.dataset.type === ixType));
    const ta = $("#p-summary");
    if (ixType && !ta.value.trim()) {
      ta.value = IX_STARTERS[ixType] || "";
      ta.focus();
    }
  });

  // Next-step suggestion chips: fill, or append when text exists.
  $$("#p-nextsugs .chip-btn").forEach(b => b.onclick = () => {
    const inp = $("#p-next");
    const cur = inp.value.trim();
    inp.value = cur ? cur.replace(/\s*[;.]$/, "") + "; " + b.dataset.sug : b.dataset.sug;
    inp.focus();
  });

  // Phone dictation: shown only when the browser supports it.
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SR) {
    const mic = $("#p-mic");
    mic.style.display = "";
    let rec = null, listening = false;
    mic.onclick = () => {
      if (listening) { try { rec.stop(); } catch {} return; }
      rec = new SR();
      rec.lang = "en-US";
      rec.interimResults = false;
      rec.onresult = (e) => {
        const text = [...e.results].map(r => r[0].transcript).join(" ").trim();
        const ta = $("#p-summary");
        ta.value = (ta.value ? ta.value.replace(/\s+$/, "") + " " : "") + text;
      };
      rec.onend = rec.onerror = () => { listening = false; mic.classList.remove("on"); };
      try { rec.start(); listening = true; mic.classList.add("on"); }
      catch { listening = false; mic.classList.remove("on"); }
    };
  }

  const memberCombo = makeCombo($("#p-member-combo"), {
    items: ordered.map(m => ({ id: m.id, label: memberLabel(m) })),
    selectedId: selMemberId,
    placeholder: "Type a name to search…",
    onChange: () => syncPanelChamber(),
  });
  const stafferCombo = makeCombo($("#p-staffer-combo"), {
    items: [],
    placeholder: "Type a name to search… (optional)",
  });
  const syncPanelChamber = () => {
    const m = state.members.find(x => x.id === Number(memberCombo.value));
    $("#p-chamber").innerHTML = m ? chamberBadge(m.chamber) : "";
    // Staffer options: the member's current staff, plus "None".
    const staff = m?.current_staff || [];
    const selStaff = prefill?.staff_id || existing?.staff_id;
    let items = [{ id: "", label: "None" }].concat(staff.map(s => ({ id: s.id, label: staffWithTitle(s) })));
    // Keep a previously-attached staffer selectable even when they are no
    // longer on the member's current staff (edit flow, follow-up prefill,
    // "log another"). The staffer is never silently dropped.
    if (selStaff && !staff.some(s => s.id === selStaff)) {
      let nm = null;
      if (prefill?.staff_id && prefill.staff_first_name) {
        nm = { first: prefill.staff_first_name, last: prefill.staff_last_name, title: prefill.staff_title };
      } else if (existing?.staff_id === selStaff && existing.staff_first_name) {
        nm = { first: existing.staff_first_name, last: existing.staff_last_name, title: existing.staff_title };
      } else {
        const found = lookupStaffer(selStaff);
        if (found) nm = { first: found.first_name, last: found.last_name, title: found.title };
      }
      if (nm && nm.first) {
        items.unshift({ id: selStaff, label: `${nm.first} ${nm.last}${nm.title ? `, ${nm.title}` : ""} (former)` });
      }
    }
    stafferCombo.setItems(items);
    if (selStaff) stafferCombo.set(selStaff);
  };
  syncPanelChamber();

  const doSave = async (keepOpen) => {
    fieldErr(null);
    try {
      let memberId = $("#p-member-combo").querySelector("input").disabled ? null : Number(memberCombo.value);
      let createdNewMember = false;
      if ($("#p-newm-form").style.display !== "none") {
        const committees = $("#nm-committees").value.split(",").map(s => s.trim()).filter(Boolean);
        const m = await api("/api/members", { method: "POST", body: JSON.stringify({
          chamber: $("#nm-chamber").value,
          first_name: $("#nm-first").value, last_name: $("#nm-last").value,
          party: $("#nm-party").value, state: $("#nm-state").value,
          district: $("#nm-district").value || null, committees,
        })});
        memberId = m.id;
        state.members = await api("/api/members");
        createdNewMember = true;
      }
      if (!memberId) throw new Error("Choose a member or add a new one.");
      const payload = {
        member_id: memberId,
        date: $("#p-date").value,
        summary: $("#p-summary").value,
        next_step: $("#p-next").value,
        status: $("#p-status").value,
        staff_id: stafferCombo.value ? Number(stafferCombo.value) : null,
        interaction_type: ixType || null,
        parent_id: prefill?.parent_id || existing?.parent_id || null,
      };
      const saveNow = async () => {
        if (isEdit) await api("/api/interactions/" + existing.id, { method: "PUT", body: JSON.stringify(payload) });
        else await api("/api/interactions", { method: "POST", body: JSON.stringify(payload) });
        // Follow-up chaining: optionally mark the parent Done.
        if (!isEdit && prefill?.parent_id && $("#p-markdone")?.checked) {
          await api(`/api/interactions/${prefill.parent_id}/status`, { method: "POST", body: JSON.stringify({ status: "done" }) });
        }
        pushRecentMember(memberId);
        if (state.view === "interactions") loadInteractions();
        if (keepOpen) {
          toast("Interaction logged.");
          openInteractionPanel(null, { member_id: memberId, staff_id: payload.staff_id, interaction_type: ixType || null });
        } else {
          closePanel();
          toast(isEdit ? "Interaction updated." : "Interaction logged.");
        }
      };
      // Possible-duplicate guard: same member, same few days, overlapping
      // summary. Warns, never blocks — the user always decides.
      if (!createdNewMember) {
        try {
          const q = new URLSearchParams({ member_id: String(memberId), date: payload.date, summary: payload.summary });
          if (isEdit) q.set("exclude_id", String(existing.id));
          const dupes = await api("/api/interactions/possible-duplicates?" + q.toString());
          if (dupes.length) {
            openModal("Possible duplicate",
              `<p style="margin:0 0 6px">This member already has a similar interaction on record:</p>` +
              `<ul class="list-plain">` + dupes.slice(0, 3).map(d =>
                `<li><strong>${esc(d.date)}</strong> — ${esc(d.summary.length > 120 ? d.summary.slice(0, 120) + "…" : d.summary)}</li>`
              ).join("") + `</ul><p>Log this one anyway?</p>`,
              `<button class="btn" id="dup-back">Go back</button><button class="btn primary" id="dup-save">Log anyway</button>`);
            $("#dup-back").onclick = closeModal;
            $("#dup-save").onclick = guard($("#dup-save"), async () => { closeModal(); await saveNow(); });
            return;
          }
        } catch { /* duplicate check failed — save anyway */ }
      }
      await saveNow();
    } catch (e) { fieldErr(e.message); }
  };
  $("#p-save").onclick = guard($("#p-save"), () => doSave(false));
  const another = $("#p-another");
  if (another) another.onclick = guard(another, () => doSave(true));
}


// =====================================================================
// EVENTS
// =====================================================================
async function renderEvents() {
  const v = $("#view");
  v.innerHTML = `
    <div class="view-head">
      <div><h2>Events</h2><p class="hint">Upcoming events — simple list.</p></div>
      <div style="display:flex;gap:12px;align-items:center">
        <label class="pager-toggle" title="Include past events"><input type="checkbox" id="ev-past"> Show past events</label>
        <button class="btn primary" id="ev-add">Add event</button>
      </div>
    </div>
    <div class="card"><div class="table-wrap"><table class="grid">
      <thead><tr><th>Date</th><th>Description</th><th>Lead person</th><th style="width:130px"></th></tr></thead>
      <tbody id="ev-body"></tbody>
    </table></div></div>`;
  $("#ev-add").onclick = () => openEventModal(null);
  $("#ev-past").onchange = (e) => loadEvents(e.target.checked);
  await loadEvents(false);
}

async function loadEvents(showPast) {
  if (showPast === undefined) showPast = !!$("#ev-past")?.checked;
  const rows = await api(showPast ? "/api/events" : "/api/events?upcoming=1");
  const tb = $("#ev-body");
  if (!rows.length) {
    tb.innerHTML = `<tr><td colspan="4">${emptyState("No events on the calendar.", "Add fundraisers, meetings, and deadlines as they come up.", "Add event", "add")}</td></tr>`;
    wireEmptyCta(tb, "add", () => openEventModal(null));
    return;
  }
  tb.innerHTML = rows.map(r => `<tr>
    <td style="white-space:nowrap">${esc(fmtDate(r.date))}</td>
    <td>${esc(r.description)}</td><td>${esc(r.lead_person)}</td>
    <td><button class="btn small" data-edit="${r.id}">Edit</button>
        <button class="btn small danger" data-del="${r.id}">Delete</button></td>
  </tr>`).join("");
  $$("#ev-body [data-edit]").forEach(b => b.onclick = () => openEventModal(rows.find(x => x.id == b.dataset.edit)));
  $$("#ev-body [data-del]").forEach(b => b.onclick = () => {
    const r = rows.find(x => x.id == b.dataset.del);
    confirmDialog("Delete event", `Delete "${r.description}"?`, async () => {
      await api("/api/events/" + r.id, { method: "DELETE" });
      toast("Event deleted."); loadEvents();
    });
  });
}

function openEventModal(existing) {
  const today = todayISO();
  openModal(existing ? "Edit event" : "Add event", `
    <div class="form-err" id="form-err"></div>
    <div class="field"><label>Date</label><input type="date" id="e-date" value="${esc(existing?.date || today)}"></div>
    <div class="field"><label>Description</label><input type="text" id="e-desc" value="${esc(existing?.description || "")}" placeholder="e.g. Fundraiser, Rep. Smith"></div>
    <div class="field"><label>Lead person <span style="color:var(--red-ink)">*</span></label><input type="text" id="e-lead" required value="${esc(existing?.lead_person || "")}" placeholder="e.g. T. Boles"></div>
  `, `<button class="btn" id="e-cancel">Cancel</button><button class="btn primary" id="e-save">${existing ? "Save changes" : "Add event"}</button>`);
  $("#e-cancel").onclick = closeModal;
  $("#e-save").onclick = guard($("#e-save"), async () => {
    fieldErr(null);
    try {
      const payload = { date: $("#e-date").value, description: $("#e-desc").value, lead_person: $("#e-lead").value };
      if (existing) await api("/api/events/" + existing.id, { method: "PUT", body: JSON.stringify(payload) });
      else await api("/api/events", { method: "POST", body: JSON.stringify(payload) });
      closeModal(); toast(existing ? "Event updated." : "Event added."); loadEvents();
    } catch (e) { fieldErr(e.message); }
  });
}

// =====================================================================
// PROJECTS & TASKS
// =====================================================================
async function renderProjects() {
  const v = $("#view");
  v.innerHTML = `
    <div class="view-head">
      <div><h2>Projects &amp; Tasks</h2><p class="hint">Live work, grouped under main projects.</p></div>
      <button class="btn primary" id="pg-add">New project group</button>
    </div>
    <div id="proj-list"></div>`;
  $("#pg-add").onclick = () => openGroupModal(null);
  await loadProjects();
}

async function loadProjects() {
  const groups = await api("/api/projects");
  const wrap = $("#proj-list");
  if (!groups.length) {
    wrap.innerHTML = `<div class="card">${emptyState("No project groups yet.", "Group live work under main projects.", "New project group", "new")}</div>`;
    wireEmptyCta(wrap, "new", () => openGroupModal(null));
    return;
  }
  wrap.innerHTML = groups.map((g, gi) => `
    <div class="card proj">
      <div class="proj-head">
        <div class="reorder">
          <button data-gup="${g.id}" ${gi === 0 ? "disabled" : ""} title="Move up">▲</button>
          <button data-gdown="${g.id}" ${gi === groups.length - 1 ? "disabled" : ""} title="Move down">▼</button>
        </div>
        <h3>${esc(g.name)}</h3><span class="count">${g.tasks.length}</span>
        <label class="pager-toggle" title="Show this project on the executive one-pager">
          <input type="checkbox" data-gpager="${g.id}" ${g.show_on_pager ? "checked" : ""}> One-pager
        </label>
        <button class="btn small" data-gedit="${g.id}">Rename</button>
        <button class="btn small" data-gadd="${g.id}">Add task</button>
        <button class="btn small danger" data-gdel="${g.id}">Delete</button>
      </div>
      <div class="table-wrap"><table class="grid">
        <thead><tr><th></th><th>Task</th><th>Owner</th><th>Due date</th><th>Status</th><th style="width:110px"></th></tr></thead>
        <tbody>
        ${g.tasks.length ? g.tasks.map((t, ti) => `
          <tr>
            <td><div class="reorder">
              <button data-tup="${t.id}" ${ti === 0 ? "disabled" : ""} title="Move up">▲</button>
              <button data-tdown="${t.id}" ${ti === g.tasks.length - 1 ? "disabled" : ""} title="Move down">▼</button>
            </div></td>
            <td><span class="task-title">${esc(t.title)}</span>
              ${t.note ? `<div class="task-note">${esc(t.note)}</div>` : ""}</td>
            <td>${esc(t.owner || "—")}</td>
            <td><span class="due ${t.status !== "done" && isOverdue(t.due_date) ? "overdue" : ""}">${esc(fmtDate(t.due_date))}</span></td>
            <td><select class="status-sel ${esc(t.status)}" data-tstatus="${t.id}">
              ${Object.entries(STATUS_LABEL).map(([k, l]) => `<option value="${k}" ${t.status === k ? "selected" : ""}>${l}</option>`).join("")}
            </select></td>
            <td><button class="btn small" data-tedit="${t.id}">Edit</button>
                <button class="btn small danger" data-tdel="${t.id}">Delete</button></td>
          </tr>`).join("") : `<tr><td colspan="6">${emptyState("No tasks in this group yet.", "Add the first task to get started.", "Add task", "task", `data-g="${g.id}"`)}</td></tr>`}
        </tbody>
      </table></div>
    </div>`).join("");

  $$("#proj-list [data-gup]").forEach(b => b.onclick = () => moveGroup(b.dataset.gup, "up"));
  $$("#proj-list [data-gdown]").forEach(b => b.onclick = () => moveGroup(b.dataset.gdown, "down"));
  $$("#proj-list [data-gadd]").forEach(b => b.onclick = () => openTaskModal(Number(b.dataset.gadd), null));
  $$("#proj-list [data-empty-cta='task']").forEach(b => b.onclick = () => openTaskModal(Number(b.dataset.g), null));
  $$("#proj-list [data-gedit]").forEach(b => b.onclick = () => {
    const g = groups.find(x => x.id == b.dataset.gedit); openGroupModal(g);
  });
  $$("#proj-list [data-gpager]").forEach(cb => cb.onchange = async () => {
    const g = groups.find(x => x.id == cb.dataset.gpager);
    await api("/api/projects/groups/" + g.id, { method: "PUT", body: JSON.stringify({ name: g.name, show_on_pager: cb.checked }) });
    toast(cb.checked ? "Project will show on the one-pager." : "Project hidden from the one-pager.");
  });
  $$("#proj-list [data-gdel]").forEach(b => b.onclick = () => {
    const g = groups.find(x => x.id == b.dataset.gdel);
    confirmDialog("Delete project group", `Delete "${g.name}" and all its tasks?`, async () => {
      await api("/api/projects/groups/" + g.id, { method: "DELETE" });
      toast("Project group deleted."); loadProjects();
    });
  });
  $$("#proj-list [data-tup]").forEach(b => b.onclick = () => moveTask(b.dataset.tup, "up"));
  $$("#proj-list [data-tdown]").forEach(b => b.onclick = () => moveTask(b.dataset.tdown, "down"));
  $$("#proj-list [data-tedit]").forEach(b => b.onclick = () => {
    const t = groups.flatMap(g => g.tasks).find(x => x.id == b.dataset.tedit);
    const g = groups.find(x => x.tasks.some(y => y.id == b.dataset.tedit));
    openTaskModal(g.id, t);
  });
  $$("#proj-list [data-tdel]").forEach(b => b.onclick = () => {
    const t = groups.flatMap(g => g.tasks).find(x => x.id == b.dataset.tdel);
    confirmDialog("Delete task", `Delete "${t.title}"?`, async () => {
      await api("/api/tasks/" + t.id, { method: "DELETE" });
      toast("Task deleted."); loadProjects();
    });
  });
  $$("#proj-list [data-tstatus]").forEach(sel => sel.onchange = async () => {
    const t = groups.flatMap(g => g.tasks).find(x => x.id == sel.dataset.tstatus);
    await api("/api/tasks/" + t.id, { method: "PUT", body: JSON.stringify({ ...t, status: sel.value }) });
    sel.className = "status-sel " + sel.value;
    toast("Status updated.");
  });
}

async function moveGroup(id, direction) {
  await api(`/api/projects/groups/${id}/move`, { method: "POST", body: JSON.stringify({ direction }) });
  loadProjects();
}
async function moveTask(id, direction) {
  await api(`/api/tasks/${id}/move`, { method: "POST", body: JSON.stringify({ direction }) });
  loadProjects();
}

function openGroupModal(existing) {
  openModal(existing ? "Rename project group" : "New project group", `
    <div class="form-err" id="form-err"></div>
    <div class="field"><label>Group name</label><input type="text" id="g-name" value="${esc(existing?.name || "")}" placeholder="e.g. Appropriations exemption language"></div>
  `, `<button class="btn" id="g-cancel">Cancel</button><button class="btn primary" id="g-save">${existing ? "Save" : "Create group"}</button>`);
  $("#g-cancel").onclick = closeModal;
  $("#g-save").onclick = guard($("#g-save"), async () => {
    fieldErr(null);
    try {
      if (existing) await api("/api/projects/groups/" + existing.id, { method: "PUT", body: JSON.stringify({ name: $("#g-name").value }) });
      else await api("/api/projects/groups", { method: "POST", body: JSON.stringify({ name: $("#g-name").value }) });
      closeModal(); toast(existing ? "Group renamed." : "Group created."); loadProjects();
    } catch (e) { fieldErr(e.message); }
  });
}

function noteStats(note) {
  const t = note.trim();
  const sentences = t ? t.split(/[.!?]+/).map(s => s.trim()).filter(Boolean).length : 0;
  return { sentences, chars: note.length };
}

function openTaskModal(groupId, existing) {
  openModal(existing ? "Edit task" : "Add task", `
    <div class="form-err" id="form-err"></div>
    <div class="field"><label>Task</label><input type="text" id="t-title" value="${esc(existing?.title || "")}"></div>
    <div class="form-row">
      <div class="field"><label>Owner</label><input type="text" id="t-owner" value="${esc(existing?.owner || "")}" placeholder="e.g. T. Boles"></div>
      <div class="field"><label>Due date</label><input type="date" id="t-due" value="${esc(existing?.due_date || "")}"></div>
    </div>
    <div class="field"><label>Status</label><select id="t-status">
      ${Object.entries(STATUS_LABEL).map(([k, l]) => `<option value="${k}" ${(existing?.status || "open") === k ? "selected" : ""}>${l}</option>`).join("")}
    </select></div>
    <div class="field"><label>Note <span class="cap" id="t-note-cap">— max 2 sentences, 300 characters</span></label>
      <textarea id="t-note" rows="3">${esc(existing?.note || "")}</textarea></div>
  `, `<button class="btn" id="t-cancel">Cancel</button><button class="btn primary" id="t-save">${existing ? "Save changes" : "Add task"}</button>`);
  $("#t-cancel").onclick = closeModal;
  const cap = $("#t-note-cap");
  $("#t-note").addEventListener("input", (e) => {
    const s = noteStats(e.target.value);
    cap.textContent = `— ${s.sentences}/2 sentences, ${s.chars}/300 characters`;
    cap.style.color = (s.sentences > 2 || s.chars > 300) ? "var(--red-ink)" : "";
  });
  $("#t-note").dispatchEvent(new Event("input"));
  $("#t-save").onclick = guard($("#t-save"), async () => {
    fieldErr(null);
    try {
      const payload = {
        title: $("#t-title").value, owner: $("#t-owner").value,
        due_date: $("#t-due").value || null, status: $("#t-status").value,
        note: $("#t-note").value,
      };
      if (existing) await api("/api/tasks/" + existing.id, { method: "PUT", body: JSON.stringify(payload) });
      else await api(`/api/projects/groups/${groupId}/tasks`, { method: "POST", body: JSON.stringify(payload) });
      closeModal(); toast(existing ? "Task updated." : "Task added."); loadProjects();
    } catch (e) { fieldErr(e.message); }
  });
}

// =====================================================================
// SETTINGS
// =====================================================================
async function renderSettings() {
  const me = await api("/api/me").catch(() => null);
  userRole = me?.role || "user";
  const isAdmin = userRole === "admin";
  const v = $("#view");
  v.innerHTML = `
    <div class="view-head"><div><h2>Settings</h2><p class="hint">${isAdmin ? "Access control for this workspace." : "Your account."} <span id="app-version" class="muted"></span></p></div></div>
    <div class="settings-grid">
      <div class="card"><div class="pad">
        <h3>Change my password</h3>
        <p class="desc">Update the password for the account you're signed in with.</p>
        <div class="field"><input type="password" id="pw-new" placeholder="New password (8+ characters)"></div>
        <button class="btn" id="pw-save">Update password</button>
      </div></div>
      <div class="card"><div class="pad">
        <h3>Signed-in sessions</h3>
        <p class="desc">Devices signed in as you. Revoking signs that device out.</p>
        <ul class="list-plain" id="session-list"><li><span style="color:var(--ink-faint)">Loading…</span></li></ul>
      </div></div>
      ${isAdmin ? `
      <div class="card"><div class="pad">
        <h3>Approved emails</h3>
        <p class="desc">Only these email addresses can have an account. No self-registration.</p>
        <ul class="list-plain" id="allow-list"></ul>
        <div class="inline-form"><input type="email" id="allow-email" placeholder="name@example.com">
        <button class="btn primary" id="allow-add">Add</button></div>
      </div></div>
      <div class="card"><div class="pad">
        <h3>Users</h3>
        <p class="desc">Create accounts for approved emails. Passwords need 8+ characters.</p>
        <ul class="list-plain" id="user-list"></ul>
        <div class="form-row">
          <div class="field" style="margin:0"><input type="email" id="u-email" placeholder="Approved email"></div>
          <div class="field" style="margin:0"><input type="password" id="u-pass" placeholder="Temporary password"></div>
        </div>
        <div style="margin-top:10px;display:flex;gap:8px">
          <button class="btn primary" id="u-add">Create user</button>
        </div>
        <div class="form-err" id="form-err" style="margin-top:10px"></div>
      </div></div>
      <div class="card"><div class="pad">
        <h3>Members of Congress</h3>
        <p class="desc">Fix details or remove members. Removal is blocked while interactions or staff history reference a member.</p>
        <div style="margin-bottom:10px"><button class="btn" id="member-csv-btn">Export roster CSV</button></div>
        <ul class="list-plain" id="member-list"></ul>
      </div></div>
      <div class="card"><div class="pad">
        <h3>Backup</h3>
        <p class="desc">Download a timestamped zip of the database plus all uploaded files.</p>
        <button class="btn primary" id="backup-btn">Download backup</button>
      </div></div>
      <div class="card"><div class="pad">
        <h3>Import interactions</h3>
        <p class="desc">Upload a CSV with columns <code>member,date,type,summary,follow_up</code>. Member matches "First Last". Max ~200 KB per import.</p>
        <div class="field"><input type="file" id="import-file" accept=".csv,text/csv"></div>
        <button class="btn primary" id="import-btn">Import CSV</button>
        <div id="import-report" style="margin-top:10px"></div>
      </div></div>
      <div class="card"><div class="pad">
        <h3>Sample data</h3>
        <p class="desc">Load the current U.S. House &amp; Senate roster (real public data) plus demo interactions, events, projects, staff, and documents for meetings. Delete it when you're done — your real records are never touched.</p>
        <p class="desc" id="sample-status">Checking…</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn primary" id="sample-load">Load sample data</button>
          <button class="btn danger" id="sample-purge">Delete sample data</button>
        </div>
      </div></div>
      <div class="card"><div class="pad">
        <h3>Public link (Cloudflare Tunnel)</h3>
        <p class="desc">Link your Cloudflare account for a stable public address your team can use instead of the temporary one. Create a tunnel in your Cloudflare dashboard (Zero Trust → Tunnels), then paste the token and the hostname here.</p>
        <p class="desc" id="tunnel-status">Checking…</p>
        <div style="display:grid;gap:8px;max-width:520px">
          <label class="fld"><span>Tunnel token</span><input type="password" id="tunnel-token" placeholder="Paste the tunnel token from your Cloudflare dashboard" autocomplete="off"></label>
          <label class="fld"><span>Public hostname</span><input id="tunnel-hostname" placeholder="crm.yourdomain.com" autocomplete="off"></label>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
          <button class="btn primary" id="tunnel-save">Save and connect</button>
          <button class="btn" id="tunnel-clear">Disconnect</button>
        </div>
      </div></div>
      <div class="card"><div class="pad">
        <h3>Activity log</h3>
        <p class="desc">Who created, changed, or deleted what — newest first.</p>
        <div style="margin-bottom:10px"><button class="btn" id="audit-refresh">Refresh</button></div>
        <div class="table-wrap"><table class="grid">
          <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Detail</th></tr></thead>
          <tbody id="audit-body"><tr><td colspan="4">Loading…</td></tr></tbody>
        </table></div>
      </div></div>
      ` : ""}
    </div>`;
  // --- everyone: password + sessions ---
  $("#pw-save").onclick = guard($("#pw-save"), async () => {
    fieldErr(null);
    try {
      await api("/api/password", { method: "POST", body: JSON.stringify({ password: $("#pw-new").value }) });
      $("#pw-new").value = ""; toast("Password updated. Other sessions were signed out.");
    } catch (e) { fieldErr(e.message); }
  });
  await loadSessions();
  if (!isAdmin) {
    api("/api/update-status").then(u => { $("#app-version").textContent = `v${u.current}`; }).catch(() => {});
    return;
  }
  // --- admin only below ---
  $("#allow-add").onclick = guard($("#allow-add"), async () => {
    fieldErr(null);
    try {
      await api("/api/admin/allowed", { method: "POST", body: JSON.stringify({ email: $("#allow-email").value }) });
      $("#allow-email").value = ""; toast("Email approved."); loadSettings();
    } catch (e) { fieldErr(e.message); }
  });
  $("#u-add").onclick = guard($("#u-add"), async () => {
    fieldErr(null);
    try {
      await api("/api/admin/users", { method: "POST", body: JSON.stringify({ email: $("#u-email").value, password: $("#u-pass").value }) });
      $("#u-email").value = ""; $("#u-pass").value = ""; toast("User created."); loadSettings();
    } catch (e) { fieldErr(e.message); }
  });
  $("#backup-btn").onclick = () => { window.location.href = "/api/admin/backup"; };
  $("#import-btn").onclick = guard($("#import-btn"), async () => {
    const f = $("#import-file").files[0];
    const box = $("#import-report");
    if (!f) { box.innerHTML = `<p class="desc">Choose a CSV file first.</p>`; return; }
    const text = await f.text();
    box.innerHTML = `<p class="desc">Importing…</p>`;
    try {
      const r = await api("/api/admin/import-interactions", { method: "POST", body: JSON.stringify({ csv: text }) });
      box.innerHTML = `<p><strong>Imported ${r.imported} of ${r.total} rows.</strong></p>` +
        (r.errors.length ? `<ul class="list-plain">` + r.errors.slice(0, 20).map(e =>
          `<li><span>Row ${e.row}</span><span style="color:var(--red-ink)">${esc(e.error)}</span></li>`).join("") +
          (r.errors.length > 20 ? `<li><span>…and ${r.errors.length - 20} more</span></li>` : "") + `</ul>`
          : `<p class="desc">No errors.</p>`);
      toast(`Imported ${r.imported} interactions.`);
    } catch (e) { box.innerHTML = `<p style="color:var(--red-ink)">${esc(e.message)}</p>`; }
  });
  $("#audit-refresh").onclick = () => loadAudit();
  await loadSettings();
  await loadAudit();
  // sample legislator roster: load / purge
  async function refreshSampleStatus() {
    try {
      const s = await api("/api/admin/sample-legislators");
      $("#sample-status").textContent = s.count > 0
        ? `${s.count} sample legislators loaded.`
        : "No sample data loaded.";
      $("#sample-load").disabled = s.full === true;
      $("#sample-purge").disabled = s.count === 0;
    } catch { $("#sample-status").textContent = "Could not check sample data status."; }
  }
  $("#sample-load").onclick = guard($("#sample-load"), async () => {
    try {
      const r = await api("/api/admin/sample-legislators", { method: "POST" });
      const n = r.legislators?.loaded || 0;
      toast(r.legislators?.skipped && r.content?.skipped
        ? "Sample data is already loaded."
        : `Loaded ${n} sample legislators plus demo interactions, events, projects, staff, and documents.`);
      refreshSampleStatus();
    } catch (e) { fieldErr(e.message); }
  });
  $("#sample-purge").onclick = guard($("#sample-purge"), async () => {
    if (!confirm("Delete all sample data? Your real records are not affected.")) return;
    try {
      const r = await api("/api/admin/sample-legislators", { method: "DELETE" });
      const n = (r.legislators?.deleted || 0) + Object.values(r.content || {}).reduce((a, b) => a + b, 0);
      toast(`Deleted ${n} sample records.`);
      refreshSampleStatus();
    } catch (e) { fieldErr(e.message); }
  });
  refreshSampleStatus();
  async function refreshTunnelStatus() {
    try {
      const t = await api("/api/admin/tunnel");
      $("#tunnel-hostname").value = t.hostname || "";
      $("#tunnel-status").textContent = t.linked
        ? `Connected${t.live ? ` — live at ${t.live}` : " — starting…"}.`
        : "Not linked — using the temporary public link (changes on restart).";
    } catch { $("#tunnel-status").textContent = "Could not check tunnel status."; }
  }
  $("#tunnel-save").onclick = guard($("#tunnel-save"), async () => {
    fieldErr(null);
    try {
      const r = await api("/api/admin/tunnel", { method: "POST", body: JSON.stringify({
        token: $("#tunnel-token").value, hostname: $("#tunnel-hostname").value,
      }) });
      $("#tunnel-token").value = "";
      toast(r.live ? `Public link live at ${r.live}.` : "Saved. Tunnel is starting…");
      refreshTunnelStatus();
    } catch (e) { fieldErr(e.message); }
  });
  $("#tunnel-clear").onclick = guard($("#tunnel-clear"), async () => {
    if (!confirm("Disconnect your Cloudflare tunnel? The temporary public link will be used instead.")) return;
    try {
      await api("/api/admin/tunnel", { method: "POST", body: JSON.stringify({ token: "", hostname: "" }) });
      $("#tunnel-hostname").value = "";
      toast("Disconnected.");
      refreshTunnelStatus();
    } catch (e) { fieldErr(e.message); }
  });
  refreshTunnelStatus();
  api("/api/update-status").then(u => {
    $("#app-version").textContent = `v${u.current}`;
  }).catch(() => {});
}

async function loadSessions() {
  const box = $("#session-list");
  try {
    const rows = await api("/api/sessions");
    box.innerHTML = rows.length ? rows.map(s => {
      const ua = s.user_agent || "Unknown device";
      const when = s.created_at ? s.created_at.slice(0, 16).replace("T", " ") : "";
      return `<li><span>${esc(ua)}${s.current ? ' <span class="cap" style="color:var(--ink-faint)">(this device)</span>' : ""}<br><span style="color:var(--ink-faint);font-size:12px">${esc(when)}${s.ip ? ` · ${esc(s.ip)}` : ""}</span></span>
        ${s.current ? "" : `<button class="linklike" data-revoke="${s.id}" style="color:var(--red-ink)">Revoke</button>`}</li>`;
    }).join("") : `<li><span style="color:var(--ink-faint)">No sessions.</span></li>`;
    box.querySelectorAll("[data-revoke]").forEach(b => b.onclick = guard(b, async () => {
      try { await api("/api/sessions/" + b.dataset.revoke, { method: "DELETE" }); toast("Session revoked."); loadSessions(); }
      catch (e) { toast("Error: " + e.message); }
    }));
  } catch { box.innerHTML = `<li><span style="color:var(--ink-faint)">Could not load sessions.</span></li>`; }
}

async function loadAudit() {
  const tb = $("#audit-body");
  if (!tb) return;
  try {
    const rows = await api("/api/admin/audit?limit=100");
    tb.innerHTML = rows.length ? rows.map(a =>
      `<tr><td style="white-space:nowrap">${esc((a.created_at || "").slice(0, 16).replace("T", " "))}</td>` +
      `<td>${esc(a.email || "—")}</td><td>${esc(a.action)}${a.entity ? ` ${esc(a.entity)}` : ""}</td>` +
      `<td class="trunc">${esc(a.detail || "")}</td></tr>`).join("")
      : `<tr><td colspan="4">No activity yet.</td></tr>`;
  } catch { tb.innerHTML = `<tr><td colspan="4">Could not load the activity log.</td></tr>`; }
}

async function loadSettings() {
  const [allowed, users] = await Promise.all([api("/api/admin/allowed"), api("/api/admin/users")]);
  $("#allow-list").innerHTML = allowed.length ? allowed.map(a =>
    `<li><span>${esc(a.email)}</span><button class="linklike" data-unallow="${esc(a.email)}" style="color:var(--red-ink)">Remove</button></li>`).join("")
    : `<li><span style="color:var(--ink-faint)">No approved emails.</span></li>`;
  $$("#allow-list [data-unallow]").forEach(b => b.onclick = guard(b, async () => {
    try { await api("/api/admin/allowed/" + encodeURIComponent(b.dataset.unallow), { method: "DELETE" }); toast("Removed."); loadSettings(); }
    catch (e) { fieldErr(e.message); }
  }));
  const me = (await api("/api/me")).email;
  $("#user-list").innerHTML = users.length ? users.map(u =>
    `<li><span>${esc(u.email)}${u.email === me ? ' <span class="cap" style="color:var(--ink-faint)">(you)</span>' : ""}</span>
     <span><button class="linklike" data-reset="${u.id}">Reset password</button>
     ${u.email === me ? "" : ` · <button class="linklike" data-rmuser="${u.id}" style="color:var(--red-ink)">Remove</button>`}</span></li>`).join("")
    : `<li><span style="color:var(--ink-faint)">No users.</span></li>`;
  $$("#user-list [data-reset]").forEach(b => b.onclick = () => {
    openModal("Reset password", `
      <div class="form-err" id="form-err"></div>
      <div class="field"><label>New password for user</label><input type="password" id="rp-pass" placeholder="8+ characters"></div>
    `, `<button class="btn" id="rp-cancel">Cancel</button><button class="btn primary" id="rp-save">Reset password</button>`);
    $("#rp-cancel").onclick = closeModal;
    $("#rp-save").onclick = guard($("#rp-save"), async () => {
      fieldErr(null);
      try {
        await api(`/api/admin/users/${b.dataset.reset}/password`, { method: "POST", body: JSON.stringify({ password: $("#rp-pass").value }) });
        closeModal(); toast("Password reset. They'll need to sign in again.");
      } catch (e) { fieldErr(e.message); }
    });
  });
  $$("#user-list [data-rmuser]").forEach(b => b.onclick = () =>
    confirmDialog("Remove user", "Remove this user account? They will no longer be able to sign in.", async () => {
      await api("/api/admin/users/" + b.dataset.rmuser, { method: "DELETE" });
      toast("User removed."); loadSettings();
    }));

  // Members of Congress: edit details or remove (blocked while referenced).
  state.members = await api("/api/members");
  $("#member-csv-btn").onclick = () => { window.location.href = "/api/members.csv"; };
  $("#member-list").innerHTML = state.members.length ? state.members.map(m =>
    `<li><span><span class="member-name">${esc(memberLabel(m))}</span> ${chamberBadge(m.chamber)}</span>
     <span><button class="linklike" data-editmember="${m.id}">Edit</button>
      · <button class="linklike" data-delmember="${m.id}" style="color:var(--red-ink)">Delete</button></span></li>`).join("")
    : `<li><span style="color:var(--ink-faint)">No members.</span></li>`;
  $$("#member-list [data-editmember]").forEach(b => b.onclick = () =>
    openMemberPanel(state.members.find(m => m.id == b.dataset.editmember)));
  $$("#member-list [data-delmember]").forEach(b => b.onclick = () => {
    const m = state.members.find(x => x.id == b.dataset.delmember);
    confirmDialog("Delete member", `Delete ${memberLabel(m)}? Only possible when no interactions or staff history reference them.`, async () => {
      try {
        await api("/api/members/" + m.id, { method: "DELETE" });
        toast("Member deleted.");
        state.members = await api("/api/members");
        loadSettings();
      } catch (err) { toast("Error: " + err.message); }
    });
  });
}

function openMemberPanel(existing) {
  const isEdit = !!existing;
  openPanel(isEdit ? "Edit member" : "Add member", `
    <div class="form-err" id="form-err"></div>
    <div class="form-row">
      <div class="field"><label>First name</label><input type="text" id="mm-first" value="${esc(existing?.first_name || "")}"></div>
      <div class="field"><label>Last name</label><input type="text" id="mm-last" value="${esc(existing?.last_name || "")}"></div>
    </div>
    <div class="form-row three">
      <div class="field"><label>Chamber</label><select id="mm-chamber">
        <option value="house" ${!existing || existing.chamber === "house" ? "selected" : ""}>House</option>
        <option value="senate" ${existing?.chamber === "senate" ? "selected" : ""}>Senate</option>
      </select></div>
      <div class="field"><label>Party</label><select id="mm-party">
        ${["R", "D", "I"].map(p => `<option ${existing?.party === p ? "selected" : ""}>${p}</option>`).join("")}
      </select></div>
      <div class="field"><label>State</label><input type="text" id="mm-state" maxlength="2" value="${esc(existing?.state || "")}" placeholder="FL" style="text-transform:uppercase"></div>
    </div>
    <div class="field" id="mm-district-wrap" style="${existing?.chamber === "senate" ? "display:none" : ""}">
      <label>District</label><input type="number" id="mm-district" min="1" value="${existing?.district || ""}" placeholder="12">
    </div>
    <div class="field"><label>Committees <span class="cap">— comma separated</span></label>
      <input type="text" id="mm-committees" value="${esc((existing?.committees || []).join(", "))}" placeholder="Appropriations, Veterans' Affairs"></div>
  `, `<button class="btn" id="mm-cancel">Cancel</button><button class="btn primary" id="mm-save">${isEdit ? "Save changes" : "Add member"}</button>`);
  $("#mm-cancel").onclick = closePanel;
  $("#mm-chamber").onchange = (e) => {
    $("#mm-district-wrap").style.display = e.target.value === "house" ? "block" : "none";
  };
  $("#mm-save").onclick = guard($("#mm-save"), async () => {
    fieldErr(null);
    try {
      const payload = {
        chamber: $("#mm-chamber").value,
        first_name: $("#mm-first").value, last_name: $("#mm-last").value,
        party: $("#mm-party").value, state: $("#mm-state").value,
        district: $("#mm-district").value || null,
        committees: $("#mm-committees").value.split(",").map(s => s.trim()).filter(Boolean),
      };
      if (isEdit) await api("/api/members/" + existing.id, { method: "PUT", body: JSON.stringify(payload) });
      else await api("/api/members", { method: "POST", body: JSON.stringify(payload) });
      state.members = await api("/api/members");
      closePanel();
      toast(isEdit ? "Member updated." : "Member added.");
      if (state.view === "settings") loadSettings();
      else if (state.view === "members") loadMembers();
    } catch (e) { fieldErr(e.message); }
  });
}

// =====================================================================
// DOCUMENTS (finalized library — user uploads only)
// =====================================================================
function fmtSize(bytes) {
  const b = Number(bytes) || 0;
  if (b < 1024) return b + " B";
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
  return (b / 1024 / 1024).toFixed(1) + " MB";
}

function fmtDateTime(sql) {
  if (!sql) return "—";
  const d = new Date(String(sql).replace(" ", "T") + "Z");
  if (isNaN(d)) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) + ", " +
    d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function readFileAsBase64(f) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => reject(new Error("Could not read file."));
    r.readAsDataURL(f);
  });
}

async function renderDocuments() {
  const v = $("#view");
  v.innerHTML = `
    <div class="view-head">
      <div><h2>Documents</h2><p class="hint">Finalized documents — uploaded files only.</p></div>
      <button class="btn primary" id="doc-upload-btn">Upload document</button>
      <input type="file" id="doc-file" style="display:none">
    </div>
    <div class="card"><div class="table-wrap"><table class="grid">
      <thead><tr><th>Document</th><th>Size</th><th>Uploaded by</th><th>Uploaded</th><th style="width:180px"></th></tr></thead>
      <tbody id="doc-body"></tbody>
    </table></div></div>`;
  $("#doc-upload-btn").onclick = () => $("#doc-file").click();
  $("#doc-file").onchange = async (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (!f) return;
    if (f.size > 25 * 1024 * 1024) { toast("File exceeds the 25 MB limit."); return; }
    try {
      toast("Uploading…");
      const data = await readFileAsBase64(f);
      await api("/api/documents", { method: "POST", body: JSON.stringify({ name: f.name, data }) });
      toast("Document uploaded.");
    } catch (err) { toast("Error: " + err.message); }
    loadDocuments();
  };
  await loadDocuments();
}

async function loadDocuments() {
  const rows = await api("/api/documents");
  const tb = $("#doc-body");
  if (!rows.length) {
    tb.innerHTML = `<tr><td colspan="5">${emptyState("No documents yet.", "Upload finalized documents to the library.", "Upload document", "upload")}</td></tr>`;
    wireEmptyCta(tb, "upload", () => $("#doc-file").click());
    return;
  }
  tb.innerHTML = rows.map(r => `<tr>
    <td>${esc(r.orig_name)}</td>
    <td style="white-space:nowrap">${esc(fmtSize(r.size))}</td>
    <td>${esc(r.uploaded_by)}</td>
    <td style="white-space:nowrap">${esc(fmtDateTime(r.uploaded_at))}</td>
    <td><a class="btn small" href="/api/documents/${r.id}/download">Download</a>
        <button class="btn small danger" data-deldoc="${r.id}">Delete</button></td>
  </tr>`).join("");
  $$("#doc-body [data-deldoc]").forEach(b => b.onclick = () => {
    const r = rows.find(x => x.id == b.dataset.deldoc);
    confirmDialog("Delete document", `Delete "${r.orig_name}"? This cannot be undone.`, async () => {
      await api("/api/documents/" + r.id, { method: "DELETE" });
      toast("Document deleted."); loadDocuments();
    });
  });
}

// =====================================================================
// STAFF (aides/assistants) — individuals, viewable alone or by member
// =====================================================================
const sfilter = { q: "", member_id: "" };

async function renderStaff() {
  if (!state.members.length) state.members = await api("/api/members");
  const v = $("#view");
  v.innerHTML = `
    <div class="view-head">
      <div><h2>Staff</h2><p class="hint">Aides and assistants — on their own, or assigned to members.</p></div>
      <button class="btn primary" id="staff-add">Add staffer</button>
    </div>
    <div class="filters">
      <div class="field grow"><label>Search</label><input type="text" id="sf-q" placeholder="Name, title, email…" value="${esc(sfilter.q)}"></div>
      <div class="field"><label>Member</label><select id="sf-member">
        <option value="">All members</option>
        ${state.members.map(m => `<option value="${m.id}" ${String(sfilter.member_id) === String(m.id) ? "selected" : ""}>${esc(memberLabel(m))}</option>`).join("")}
      </select></div>
      <div class="field"><label>&nbsp;</label><button class="btn" id="sf-clear">Clear</button></div>
    </div>
    <p class="result-count" id="res-count"></p>
    <div class="card"><div class="table-wrap"><table class="grid" id="staff-table">
      <thead><tr><th>Name</th><th>Title</th><th>Current members</th><th>Contact</th></tr></thead>
      <tbody></tbody>
    </table></div></div>`;
  $("#staff-add").onclick = () => openStafferPanel(null);
  const apply = () => {
    sfilter.q = $("#sf-q").value; sfilter.member_id = $("#sf-member").value;
    loadStaff();
  };
  $("#sf-q").addEventListener("input", apply);
  $("#sf-member").addEventListener("change", apply);
  $("#sf-clear").onclick = () => { sfilter.q = ""; sfilter.member_id = ""; renderStaff(); };
  await loadStaff();
}

async function loadStaff() {
  const p = new URLSearchParams();
  if (sfilter.q) p.set("q", sfilter.q);
  if (sfilter.member_id) p.set("member_id", sfilter.member_id);
  let rows;
  try {
    rows = await api("/api/staff?" + p.toString());
  } catch (e) {
    if (isNotFound(e)) {
      // The server predates the staff feature (old install still running) —
      // say so plainly instead of "Error: not-found".
      $("#res-count").textContent = "";
      $("#staff-table tbody").innerHTML = `<tr><td colspan="4">${emptyState(
        "Staff needs a newer CRM version.",
        "This page isn't available on the running server version. Quit the old Vilano app completely (check the system tray), install the latest Setup, and reopen.",
        "", "")}</td></tr>`;
      return;
    }
    throw e;
  }
  $("#res-count").textContent = `${rows.length} staffer${rows.length === 1 ? "" : "s"}`;
  const tb = $("#staff-table tbody");
  if (!rows.length) {
    const filtered = sfilter.q || sfilter.member_id;
    tb.innerHTML = `<tr><td colspan="4">${filtered
      ? emptyState("No staff match these filters.", "Try widening the search or clearing the filters.", "Clear filters", "clear")
      : emptyState("No staff on record yet.", "Add aides and assistants, then assign them to members.", "Add staffer", "add")}</td></tr>`;
    wireEmptyCta(tb, "add", () => openStafferPanel(null));
    wireEmptyCta(tb, "clear", () => $("#sf-clear").click());
    return;
  }
  tb.innerHTML = rows.map(s => `
    <tr class="row" data-id="${s.id}">
      <td><span class="member-name">${esc(staffName(s))}</span></td>
      <td>${esc(s.title || "—")}</td>
      <td>${s.current_members.length
        ? s.current_members.map(m => `<span class="committee-chip">${esc(m.label)}</span>`).join("")
        : '<span style="color:var(--ink-faint)">Unassigned</span>'}</td>
      <td>${esc(s.email || s.phone || "—")}</td>
    </tr>`).join("");
  $$("#staff-table tbody tr.row").forEach((tr, i) => {
    tr.addEventListener("click", () => toggleStaffDetail(tr, rows[i]));
  });
}

async function toggleStaffDetail(tr, s) {
  const next = tr.nextSibling;
  if (next && next.classList && next.classList.contains("detail")) { next.remove(); return; }
  let d;
  try {
    d = await api("/api/staff/" + s.id);
  } catch (e) {
    if (isNotFound(e)) { notFoundToast("staffer"); loadStaff(); return; }
    throw e;
  }
  const current = d.assignments.filter(a => a.current);
  const former = d.assignments.filter(a => !a.current);
  const el = document.createElement("tr");
  el.className = "detail";
  el.innerHTML = `<td colspan="4"><div class="detail-box">
    <div><div class="lbl">Title</div><div class="val">${esc(d.title || "—")}</div></div>
    <div><div class="lbl">Contact</div><div class="val">${esc(d.email || "—")}${d.phone ? `<br>${esc(d.phone)}` : ""}</div></div>
    ${d.notes ? `<div class="full"><div class="lbl">Notes</div><div class="val">${esc(d.notes)}</div></div>` : ""}
    <div class="full"><div class="lbl">Current assignments</div><div class="val">
      ${current.map(a => `<div class="assign-row"><span>${esc(a.label)}</span>
        <span class="cap">since ${esc(fmtDate(a.started_on))}</span>
        <button class="linklike" data-endassign="${a.id}" style="color:var(--red-ink)">End</button></div>`).join("")
        || '<span style="color:var(--ink-faint)">None.</span>'}
    </div></div>
    <div class="full"><div class="lbl">Former assignments</div><div class="val">
      ${former.map(a => `<div class="assign-row"><span>${esc(a.label)}</span>
        <span class="former-tag">Former</span>
        <span class="cap">${esc(fmtDate(a.started_on))} – ${esc(fmtDate(a.ended_on))}</span></div>`).join("")
        || '<span style="color:var(--ink-faint)">None.</span>'}
    </div></div>
    <div class="full"><div class="lbl">Assign to member</div><div class="val">
      <div class="inline-form">
        <select id="as-member">${state.members.map(m => `<option value="${m.id}">${esc(memberLabel(m))}</option>`).join("")}</select>
        <input type="date" id="as-start" value="${todayISO()}">
        <button class="btn small primary" id="as-add">Assign</button>
      </div>
    </div></div>
    <div class="full"><div class="lbl">Interaction history</div><div class="val">
      ${d.interactions.length ? `<div class="table-wrap"><table class="grid compact"><tbody>` +
        d.interactions.map(ix => `<tr>
          <td style="white-space:nowrap">${esc(fmtDate(ix.date))}</td>
          <td><span class="member-name">${esc(ix.member_label)}</span></td>
          <td><span class="trunc">${esc(ix.summary)}</span></td>
          <td>${statusPill(ix.status)}</td>
        </tr>`).join("") + `</tbody></table></div>`
        : '<span style="color:var(--ink-faint)">No interactions with this staffer yet.</span>'}
    </div></div>
    <div class="detail-actions">
      <button class="btn small" data-act="edit">Edit</button>
      <button class="btn small danger" data-act="del">Delete</button>
    </div>
  </div></td>`;
  tr.after(el);

  const asAdd = el.querySelector("#as-add");
  asAdd.onclick = guard(asAdd, async () => {
    try {
      await api(`/api/staff/${d.id}/assignments`, { method: "POST", body: JSON.stringify({
        member_id: Number(el.querySelector("#as-member").value),
        started_on: el.querySelector("#as-start").value || todayISO(),
      })});
      toast("Staffer assigned.");
      const fresh = tr; // re-render detail
      el.remove(); toggleStaffDetail(fresh, s);
    } catch (e) {
      if (isNotFound(e)) { notFoundToast("staffer"); loadStaff(); return; }
      toast("Error: " + e.message);
    }
  });
  el.querySelectorAll("[data-endassign]").forEach(b => b.onclick = () => openEndAssignmentModal(b.dataset.endassign, () => {
    el.remove(); toggleStaffDetail(tr, s);
  }));
  el.querySelector('[data-act="edit"]').onclick = (e) => { e.stopPropagation(); openStafferPanel(d); };
  el.querySelector('[data-act="del"]').onclick = (e) => {
    e.stopPropagation();
    confirmDialog("Delete staffer", `Delete ${staffName(d)}? Only possible when they have no assignments or interactions on record.`, async () => {
      try {
        await api("/api/staff/" + d.id, { method: "DELETE" });
        toast("Staffer deleted."); loadStaff();
      } catch (err) {
        if (isNotFound(err)) { notFoundToast("staffer"); loadStaff(); return; }
        toast("Error: " + err.message);
      }
    });
  };
}

function openEndAssignmentModal(assignId, onDone) {
  openModal("End assignment", `
    <div class="form-err" id="form-err"></div>
    <p style="margin:0 0 14px;font-size:13.5px">The assignment stays on record as a former assignment — history is kept.</p>
    <div class="field"><label>End date</label><input type="date" id="ea-date" value="${todayISO()}"></div>
  `, `<button class="btn" id="ea-cancel">Cancel</button><button class="btn primary" id="ea-save">End assignment</button>`);
  $("#ea-cancel").onclick = closeModal;
  $("#ea-save").onclick = guard($("#ea-save"), async () => {
    fieldErr(null);
    try {
      await api(`/api/assignments/${assignId}/end`, { method: "POST", body: JSON.stringify({ ended_on: $("#ea-date").value || todayISO() }) });
      closeModal(); toast("Assignment ended — kept as former."); onDone();
    } catch (e) {
      if (isNotFound(e)) { closeModal(); notFoundToast("assignment"); onDone(); return; }
      fieldErr(e.message);
    }
  });
}

function openStafferPanel(existing) {
  const isEdit = !!existing;
  openPanel(isEdit ? "Edit staffer" : "Add staffer", `
    <div class="form-err" id="form-err"></div>
    <div class="form-row">
      <div class="field"><label>First name</label><input type="text" id="st-first" value="${esc(existing?.first_name || "")}"></div>
      <div class="field"><label>Last name</label><input type="text" id="st-last" value="${esc(existing?.last_name || "")}"></div>
    </div>
    <div class="field"><label>Title</label><input type="text" id="st-title" value="${esc(existing?.title || "")}" placeholder="e.g. Legislative Director"></div>
    <div class="form-row">
      <div class="field"><label>Email</label><input type="email" id="st-email" value="${esc(existing?.email || "")}" placeholder="name@example.gov"></div>
      <div class="field"><label>Phone</label><input type="text" id="st-phone" value="${esc(existing?.phone || "")}" placeholder="202-555-0100"></div>
    </div>
    <div class="field"><label>Notes</label><textarea id="st-notes" rows="3" placeholder="Anything worth remembering…">${esc(existing?.notes || "")}</textarea></div>
  `, `<button class="btn" id="st-cancel">Cancel</button><button class="btn primary" id="st-save">${isEdit ? "Save changes" : "Add staffer"}</button>`);
  $("#st-cancel").onclick = closePanel;
  $("#st-save").onclick = guard($("#st-save"), async () => {
    fieldErr(null);
    try {
      const payload = {
        first_name: $("#st-first").value, last_name: $("#st-last").value,
        title: $("#st-title").value, email: $("#st-email").value,
        phone: $("#st-phone").value, notes: $("#st-notes").value,
      };
      if (isEdit) await api("/api/staff/" + existing.id, { method: "PUT", body: JSON.stringify(payload) });
      else await api("/api/staff", { method: "POST", body: JSON.stringify(payload) });
      closePanel(); toast(isEdit ? "Staffer updated." : "Staffer added.");
      if (state.view === "staff") loadStaff();
    } catch (e) {
      if (isNotFound(e)) { closePanel(); notFoundToast("staffer"); if (state.view === "staff") loadStaff(); return; }
      fieldErr(e.message);
    }
  });
}

// =====================================================================
// COMMITTEE VIEW — opened by clicking any committee chip
// =====================================================================
async function showCommittee(name) {
  if (!state.members.length) state.members = await api("/api/members");
  const members = state.members.filter(m => m.committees.includes(name));
  const v = $("#view");
  v.innerHTML = `
    <div class="view-head">
      <div><h2>${esc(name)}</h2><p class="hint">${members.length} member${members.length === 1 ? "" : "s"} on this committee.</p></div>
      <button class="btn" id="comm-back">← Interaction Log</button>
    </div>
    <div class="card"><div class="table-wrap"><table class="grid" id="committee-table">
      <thead><tr><th>Member</th><th>Chamber</th><th>Committees</th></tr></thead>
      <tbody>
      ${members.map(m => `
        <tr class="row" data-id="${m.id}">
          <td><span class="member-name">${esc(memberLabel(m))}</span></td>
          <td>${chamberBadge(m.chamber)}</td>
          <td>${m.committees.map(committeeChip).join("")}</td>
        </tr>`).join("")}
      </tbody>
    </table></div></div>`;
  $("#comm-back").onclick = () => go("interactions");
  const byId = new Map(members.map(m => [m.id, m]));
  $$("#committee-table tbody tr.row").forEach(tr => {
    tr.addEventListener("click", () => toggleCommitteeMemberDetail(tr, byId.get(Number(tr.dataset.id))));
  });
}

function toggleCommitteeMemberDetail(tr, m) {
  const next = tr.nextSibling;
  if (next && next.classList && next.classList.contains("detail")) { next.remove(); return; }
  const d = document.createElement("tr");
  d.className = "detail";
  d.innerHTML = `<td colspan="3"><div class="detail-box">
    <div><div class="lbl">Member</div><div class="val"><span class="member-name">${esc(memberLabel(m))}</span><br>${chamberBadge(m.chamber)}</div></div>
    <div><div class="lbl">Committees</div><div class="val">${m.committees.map(committeeChip).join("")}</div></div>
    <div class="full"><div class="lbl">Staff</div><div class="val">${memberStaffHTML(m)}</div></div>
    <div class="detail-actions">
      <button class="btn small" data-act="ix">View interactions</button>
    </div>
  </div></td>`;
  tr.after(d);
  d.querySelector('[data-act="ix"]').onclick = (e) => {
    e.stopPropagation();
    ifilter.q = ""; ifilter.chamber = ""; ifilter.status = ""; ifilter.from = ""; ifilter.to = "";
    go("interactions");
    // after render, filter to this member via search on last name
    setTimeout(() => {
      const q = $("#f-q");
      if (q) { q.value = m.last_name; q.dispatchEvent(new Event("input")); }
    }, 150);
  };
}

// Committee chips are buttons rendered inside dynamic HTML — delegate in the
// capture phase so a chip click never also toggles the row it sits in.
document.addEventListener("click", (e) => {
  const chip = e.target.closest("[data-committee]");
  if (!chip) return;
  e.stopPropagation();
  e.preventDefault();
  go("committee/" + encodeURIComponent(chip.dataset.committee));
}, true);

// ---------- mobile nav drawer (hamburger) ----------
const navToggle = $("#nav-toggle");
const navScrim = $("#nav-scrim");
function setNav(open) {
  document.body.classList.toggle("nav-open", open);
  if (navToggle) navToggle.setAttribute("aria-expanded", String(open));
}
if (navToggle && navScrim) {
  navToggle.addEventListener("click", () => setNav(!document.body.classList.contains("nav-open")));
  navScrim.addEventListener("click", () => setNav(false));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") setNav(false); });
}

// ---------- nav ----------
const views = { dashboard: renderDashboard, interactions: renderInteractions, members: renderMembers, events: renderEvents, projects: renderProjects, documents: renderDocuments, staff: renderStaff, settings: renderSettings };

// In-app fragment navigation: the one-pager links to /#events etc., and any
// same-document hash change now switches views without a reload.
window.addEventListener("hashchange", () => {
  const h = (location.hash || "").replace(/^#/, "");
  if (!h || h === state.view) return;
  if (h === "phone") { location.href = "/phone"; return; }
  if (h === "onepager") { location.href = "/one-pager"; return; }
  if (views[h] || h.startsWith("committee/")) go(h);
});

function go(view) {
  state.view = view;
  $$("#nav button").forEach(b => b.classList.toggle("active", b.dataset.view === view));
  // Committee views live outside the sidebar: committee/<name>
  if (view.startsWith("committee/")) {
    try { history.replaceState(null, "", "#committee/" + view.slice(10)); } catch {}
    showCommittee(decodeURIComponent(view.slice(10)));
    return;
  }
  try { if (location.hash !== "#" + view) history.replaceState(null, "", "#" + view); } catch {}
  (views[view] || views.interactions)().catch(e => { if (e.message !== "signed out") toast("Error: " + e.message); });
}
$("#nav").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-view]");
  if (!b) return;
  setNav(false);
  if (b.dataset.view === "onepager") { location.href = "/one-pager"; return; }
  if (b.dataset.view === "phone") { location.href = "/phone"; return; }
  go(b.dataset.view);
});
$("#logout").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" }).catch(() => {});
  location.href = "/login.html";
});

// ---------- PWA install prompt ----------
// The one-tap "Install" button only fires on secure contexts (https). Over
// plain http the browser never fires beforeinstallprompt, so phones fall back
// to the manual Add-to-Home-Screen steps (iOS) or the browser menu.
let deferredInstallPrompt = null;
const installBanner = $("#install-banner");
const installBtn = $("#install-btn");
const installDismissBtn = $("#install-dismiss");
function setInstallVisible(v) {
  if (!installBanner) return;
  installBanner.hidden = !v;
  document.body.classList.toggle("install-showing", v);
}
function installDismissed() {
  try { return localStorage.getItem("grcrm-install-dismissed") === "1"; } catch { return false; }
}
function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}
function isIos() { return /iphone|ipad|ipod/i.test(navigator.userAgent || ""); }
function maybeShowInstall(mode) {
  if (!installBanner || isStandalone() || installDismissed()) return;
  if (mode === "manual") {
    installBanner.querySelector(".install-text").innerHTML =
      "<strong>Add GR CRM to your Home Screen</strong><span>Tap Share, then “Add to Home Screen”.</span>";
    if (installBtn) installBtn.hidden = true;
  }
  setInstallVisible(true);
}
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  maybeShowInstall("prompt");
});
if (installBtn) installBtn.addEventListener("click", async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  try { await deferredInstallPrompt.userChoice; } catch {}
  deferredInstallPrompt = null;
  setInstallVisible(false);
});
if (installDismissBtn) installDismissBtn.addEventListener("click", () => {
  setInstallVisible(false);
  try { localStorage.setItem("grcrm-install-dismissed", "1"); } catch {}
});
window.addEventListener("appinstalled", () => setInstallVisible(false));
// iOS never fires beforeinstallprompt — show the manual steps instead.
if (isIos()) maybeShowInstall("manual");

// ---------- auto-update ----------
let updateDismissed = false;
async function checkForUpdate() {
  if (updateDismissed) return;
  try {
    const u = await api("/api/update-status");
    if (u.ready && u.latest) {
      $("#update-banner-text").textContent = `Version ${u.latest} is downloaded and ready to install.`;
      $("#update-banner").hidden = false;
    }
  } catch {}
}
$("#update-dismiss-btn").onclick = () => { updateDismissed = true; $("#update-banner").hidden = true; };
$("#update-install-btn").onclick = async () => {
  if (!confirm("Install the update now? The CRM will close and reopen on the new version.")) return;
  try {
    await api("/api/admin/update-install", { method: "POST" });
    $("#update-banner-text").textContent = "Installing… the CRM will reopen shortly.";
    $("#update-install-btn").disabled = true;
  } catch (e) { toast("Could not start the update: " + e.message); }
};

// ---------- boot ----------
(async () => {
  try {
    if ("serviceWorker" in navigator) {
      window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
    }
    const me = await api("/api/me");
    $("#who").textContent = me.email;
    csrfToken = me.csrf || null;
    userRole = me.role || "user";
    updateOfflineIndicator();
    const h = (location.hash || "").replace(/^#/, "");
    go(h || "dashboard");
    checkForUpdate();
    setInterval(checkForUpdate, 30 * 60 * 1000);
  } catch { location.href = "/login.html"; }
})();

// =====================================================================
// DASHBOARD — command center (Quorum/FiscalNote/BGOV idiom). Read-only.
// =====================================================================
function isoDaysAgo(n) {
  const t = new Date(); t.setDate(t.getDate() - n);
  return localISO(t);
}

// Jump to the interaction log filtered to one member (by last name).
function filterLogToMember(lastName) {
  ifilter.q = ""; ifilter.chamber = ""; ifilter.status = ""; ifilter.type = "";
  ifilter.from = ""; ifilter.to = "";
  go("interactions");
  setTimeout(() => {
    const q = $("#f-q");
    if (q) { q.value = lastName || ""; q.dispatchEvent(new Event("input")); }
  }, 200);
}

async function renderDashboard() {
  const v = $("#view");
  v.innerHTML = `
    <div class="view-head">
      <div><p class="eyebrow">Vilano South · Government Relations</p><h2>Dashboard</h2>
      <p class="hint">Your briefing at a glance — activity, people, and what needs you.</p></div>
    </div>
    <div class="smart-search" id="ss">
      <div class="ss-box">
        <input type="text" id="ss-input" placeholder="Search members, summaries, staff…" aria-label="Search members and interactions" autocomplete="off">
        <button class="btn primary" id="ss-go">Search</button>
      </div>
      <div class="ss-results" id="ss-results" role="listbox"></div>
    </div>
    <div class="kpi-grid" id="kpis"></div>
    <div class="dash-grid">
      <div>
        <div class="card"><div class="p-head"><h3>Recent interactions</h3><div class="p-actions"><button class="btn ghost" id="ri-all">View log</button></div></div>
          <div id="ri-list"></div></div>
      </div>
      <div id="dash-attn"></div>
    </div>`;
  wireSmartSearch();
  $("#ri-all").onclick = () => go("interactions");
  try {
    const [members, interactions, projects, events] = await Promise.all([
      api("/api/members"), api("/api/interactions"),
      api("/api/projects").catch(() => []), api("/api/events").catch(() => []),
    ]);
    state.members = members;
    renderKpis(interactions, members, projects, events);
    renderRecentInteractions(interactions.slice(0, 6));
    const groups = await attentionGroups();
    const box = $("#dash-attn");
    if (box) {
      box.innerHTML = groups && groups.length ? attentionPanelHTML(groups)
        : `<div class="card"><div class="p-head"><h3>Needs attention</h3></div><div class="empty-state"><div class="empty-title">All clear.</div><div class="empty-sub">No stale follow-ups, overdue tasks, or quiet relationships.</div></div></div>`;
      wireAttentionClicks(box);
    }
  } catch (e) { if (e.message !== "signed out") toast("Error: " + e.message); }
}

function renderKpis(interactions, members, projects, events) {
  const box = $("#kpis"); if (!box) return;
  const cutoff = isoDaysAgo(90);
  const recent = interactions.filter(i => i.date >= cutoff);
  const touched = new Set(recent.map(i => i.member_id)).size;
  const everTouched = new Set(interactions.map(i => i.member_id)).size;
  const openSteps = interactions.filter(i =>
    (i.status === "open" || i.status === "in_progress") && (i.next_step || "").trim()).length;
  const today = todayISO(), plus30 = isoDaysAgo(-30);
  const upcoming = events.filter(e => e.date >= today && e.date <= plus30).length;
  const overdueTasks = (projects || []).flatMap(g => g.tasks || [])
    .filter(t => t.status !== "done" && t.due_date && isOverdue(t.due_date)).length;
  const kpis = [
    [recent.length, "Interactions · 90 days", `${touched} member${touched === 1 ? "" : "s"} engaged`],
    [members.length, "Members tracked", `${everTouched} with logged contact`],
    [openSteps, "Open next steps", overdueTasks ? `${overdueTasks} overdue task${overdueTasks === 1 ? "" : "s"}` : "nothing overdue"],
    [upcoming, "Events · 30 days", upcoming ? "on the calendar" : "nothing scheduled"],
  ];
  box.innerHTML = kpis.map(([n, lbl, sub]) =>
    `<div class="kpi"><div class="num">${n}</div><div class="lbl">${lbl}</div><div class="sub">${esc(sub)}</div></div>`).join("");
}

function renderRecentInteractions(rows) {
  const box = $("#ri-list"); if (!box) return;
  if (!rows.length) {
    box.innerHTML = `<div class="empty-state"><div class="empty-title">No interactions yet.</div><div class="empty-sub">Log the first meeting or touch to start the briefing.</div></div>`;
    return;
  }
  const byMember = new Map(state.members.map(m => [m.id, m]));
  box.innerHTML = rows.map(r => {
    const m = byMember.get(r.member_id);
    const sum = r.summary.length > 140 ? r.summary.slice(0, 140) + "…" : r.summary;
    return `<div class="ri-row" data-ln="${esc(m ? m.last_name : r.last_name)}">
      <div class="ri-top"><span class="ri-who">${esc(memberLabel(r))}</span><span class="ri-date">${esc(fmtDate(r.date))}</span></div>
      <div class="ri-sum">${esc(sum)}</div>
      <div class="ri-meta">${statusPill(r.status)}${r.interaction_type ? `<span class="ix-type-badge">${esc(r.interaction_type)}</span>` : ""}${r.next_step ? `<span class="ix-next">Next: ${esc(r.next_step)}</span>` : ""}</div>
    </div>`;
  }).join("");
  box.querySelectorAll(".ri-row").forEach(el => el.onclick = () => filterLogToMember(el.dataset.ln));
}

// Smart search (BGOV idiom): one box across members + interactions.
function wireSmartSearch() {
  const wrap = $("#ss"), input = $("#ss-input"), res = $("#ss-results");
  if (!wrap) return;
  let t = null;
  const close = () => wrap.classList.remove("open");
  const submitSearch = () => {
    const q = input.value.trim();
    close(); input.value = "";
    if (!q) return;
    filterLogToMember("");
    setTimeout(() => {
      const f = $("#f-q");
      if (f) { f.value = q; f.dispatchEvent(new Event("input")); }
    }, 200);
  };
  const run = async () => {
    const q = input.value.trim();
    if (q.length < 2) { close(); return; }
    const ql = q.toLowerCase();
    if (!state.members.length) {
      try { state.members = await api("/api/members"); } catch { return; }
    }
    const mems = state.members.filter(m =>
      `${m.first_name} ${m.last_name}`.toLowerCase().includes(ql) ||
      (m.committees || []).some(c => c.toLowerCase().includes(ql))).slice(0, 5);
    let ixs = [];
    try {
      const rows = await api("/api/interactions?" + new URLSearchParams({ q }));
      ixs = rows.slice(0, 5);
    } catch { /* results still show members */ }
    let staff = [];
    try {
      const rows = await api("/api/staff?" + new URLSearchParams({ q }));
      staff = rows.slice(0, 5);
    } catch { /* results still show members + interactions */ }
    if (!mems.length && !ixs.length && !staff.length) {
      res.innerHTML = `<div class="ss-empty">No members, staff, or interactions match "${esc(q)}".</div>`;
    } else {
      res.innerHTML =
        (mems.length ? `<div class="ss-sec">Members</div>` + mems.map(m =>
          `<div class="ss-item" role="option" data-mem="${m.id}"><span class="party-dot ${esc(m.party || "I")}">${esc((m.party || "I")[0])}</span><span class="member-name">${esc(m.first_name)} ${esc(m.last_name)}</span>${chamberBadge(m.chamber)}<span class="ss-meta">${esc(m.state)}${m.district ? `-${m.district}` : ""}</span></div>`).join("") : "") +
        (staff.length ? `<div class="ss-sec">Staff</div>` + staff.map(s =>
          `<div class="ss-item" role="option" data-staff="${s.id}"><span class="member-name">${esc(s.first_name)} ${esc(s.last_name)}</span><span class="ss-meta">${esc(s.title || "")}</span></div>`).join("") : "") +
        (ixs.length ? `<div class="ss-sec">Interactions</div>` + ixs.map(r =>
          `<div class="ss-item" role="option" data-ixq="${esc(r.last_name)}"><span class="stat-mini">${esc(fmtDate(r.date))}</span><span class="trunc">${esc(r.summary)}</span><span class="ss-meta">${esc(memberLabel(r))}</span></div>`).join("") : "");
    }
    wrap.classList.add("open");
    res.querySelectorAll("[data-mem]").forEach(el => el.onclick = () => { close(); openMemberFromSearch(Number(el.dataset.mem)); });
    res.querySelectorAll("[data-staff]").forEach(el => el.onclick = () => { close(); input.value = ""; go("staff"); setTimeout(() => { const f = $("#sf-q"); if (f) { f.value = el.querySelector(".member-name").textContent; f.dispatchEvent(new Event("input")); } }, 250); });
    res.querySelectorAll("[data-ixq]").forEach(el => el.onclick = () => { close(); input.value = ""; filterLogToMember(el.dataset.ixq); });
  };
  input.addEventListener("input", () => { clearTimeout(t); t = setTimeout(run, 220); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { close(); return; }
    if (e.key === "Enter") { e.preventDefault(); submitSearch(); }
  });
  document.addEventListener("click", (e) => { if (!wrap.contains(e.target)) close(); });
  $("#ss-go").onclick = submitSearch;
}

async function openMemberFromSearch(id) {
  go("members");
  setTimeout(() => {
    const tr = document.querySelector(`#member-table tbody tr.row[data-id="${id}"]`);
    if (tr) { tr.scrollIntoView({ block: "center" }); tr.click(); }
  }, 350);
}

// =====================================================================
// MEMBERS — legislator directory + profiles (BGOV directory idiom)
// =====================================================================
const mfilter = { q: "", chamber: "" };

async function renderMembers() {
  if (!state.members.length) state.members = await api("/api/members");
  const v = $("#view");
  v.innerHTML = `
    <div class="view-head">
      <div><p class="eyebrow">Directory</p><h2>Members of Congress</h2>
      <p class="hint">Every tracked member — committees, staff, and last contact at a glance.</p></div>
      <div class="view-actions"><button class="btn primary" id="mem-add">Add member</button></div>
    </div>
    <div class="filters">
      <div class="field grow"><label>Search</label><input type="text" id="mf-q" placeholder="Name or committee…" value="${esc(mfilter.q)}"></div>
      <div class="field"><label>Chamber</label><select id="mf-chamber">
        <option value="">All</option><option value="house" ${mfilter.chamber === "house" ? "selected" : ""}>House</option>
        <option value="senate" ${mfilter.chamber === "senate" ? "selected" : ""}>Senate</option></select></div>
      <div class="field"><label>&nbsp;</label><button class="btn" id="mf-clear">Clear</button></div>
    </div>
    <p class="result-count" id="res-count"></p>
    <div class="card"><div class="table-wrap"><table class="grid" id="member-table">
      <thead><tr><th>Member</th><th>Chamber</th><th>Committees</th><th>Staff</th><th>Last contact</th></tr></thead>
      <tbody id="mem-body"></tbody>
    </table></div></div>`;
  $("#mem-add").onclick = () => openMemberPanel(null);
  const apply = () => { mfilter.q = $("#mf-q").value; mfilter.chamber = $("#mf-chamber").value; loadMembers(); };
  $("#mf-q").addEventListener("input", apply);
  $("#mf-chamber").addEventListener("change", apply);
  $("#mf-clear").onclick = () => { mfilter.q = ""; mfilter.chamber = ""; renderMembers(); };
  await loadMembers();
}

async function loadMembers() {
  const tb = $("#mem-body");
  if (!tb) return;
  const [rows, quiet] = await Promise.all([
    api("/api/interactions").catch(() => []),
    api("/api/members/needing-contact").catch(() => []),
  ]);
  const lastBy = new Map(), countBy = new Map();
  for (const r of rows) {
    if (!lastBy.has(r.member_id) || r.date > lastBy.get(r.member_id)) lastBy.set(r.member_id, r.date);
    countBy.set(r.member_id, (countBy.get(r.member_id) || 0) + 1);
  }
  const quietIds = new Set((quiet || []).map(m => m.id));
  const q = mfilter.q.trim().toLowerCase();
  const list = state.members.filter(m => {
    if (mfilter.chamber && m.chamber !== mfilter.chamber) return false;
    if (q && !`${m.first_name} ${m.last_name}`.toLowerCase().includes(q) &&
      !(m.committees || []).some(c => c.toLowerCase().includes(q))) return false;
    return true;
  });
  $("#res-count").textContent = `${list.length} member${list.length === 1 ? "" : "s"}`;
  if (!list.length) {
    const filtered = mfilter.q || mfilter.chamber;
    tb.innerHTML = `<tr><td colspan="5">${filtered
      ? emptyState("No members match these filters.", "Try widening the search.", "Clear filters", "clear")
      : emptyState("No members tracked yet.", "Add members of Congress to build the directory.", "Add member", "add")}</td></tr>`;
    wireEmptyCta(tb, "add", () => openMemberPanel(null));
    wireEmptyCta(tb, "clear", () => $("#mf-clear").click());
    return;
  }
  tb.innerHTML = list.map(m => {
    const staffN = (m.current_staff || []).length;
    const last = lastBy.get(m.id);
    const geo = m.chamber === "house" ? `${esc(m.state)}-${esc(String(m.district ?? ""))}` : esc(m.state);
    return `<tr class="row" data-id="${m.id}">
      <td><div class="mem-id"><span class="party-dot ${esc(m.party || "I")}">${esc((m.party || "I")[0])}</span>
        <span><span class="member-name">${esc(m.first_name)} ${esc(m.last_name)}</span><br><span class="geo">${geo}</span></span></div></td>
      <td>${chamberBadge(m.chamber)}</td>
      <td>${m.committees.length
        ? `<span class="stat-mini">${m.committees.length} <span class="cap">— ${esc(m.committees.slice(0, 2).join(", "))}${m.committees.length > 2 ? "…" : ""}</span></span>`
        : '<span style="color:var(--ink-faint)">—</span>'}</td>
      <td><span class="stat-mini">${staffN}</span></td>
      <td>${last
        ? `<span class="stat-mini">${esc(fmtDate(last))}</span>${quietIds.has(m.id) ? ' <span class="last-quiet">· quiet</span>' : ""}`
        : '<span class="last-quiet">Never</span>'}</td>
    </tr>`;
  }).join("");
  const byId = new Map(list.map(m => [m.id, m]));
  tb.querySelectorAll("tr.row").forEach(tr => tr.addEventListener("click", () =>
    toggleMemberProfile(tr, byId.get(Number(tr.dataset.id)), {
      last: lastBy.get(Number(tr.dataset.id)),
      count: countBy.get(Number(tr.dataset.id)) || 0,
    })));
}

// Legislator profile: tabbed record view (BGOV idiom) — overview, staff, history.
async function toggleMemberProfile(tr, m, stats) {
  const next = tr.nextSibling;
  if (next && next.classList && next.classList.contains("detail")) { next.remove(); return; }
  const el = document.createElement("tr");
  el.className = "detail";
  const geo = m.chamber === "house" ? `${esc(m.state)}-${esc(String(m.district ?? ""))}` : esc(m.state);
  el.innerHTML = `<td colspan="5" class="mem-profile">
    <div class="mem-tabs" role="tablist">
      <button class="on" data-tab="ov">Overview</button>
      <button data-tab="staff">Staff (${(m.current_staff || []).length})</button>
      <button data-tab="hist">History (${stats.count})</button>
    </div>
    <div class="mem-pane on" data-pane="ov"><div class="detail-box">
      <div><div class="lbl">Member</div><div class="val"><span class="member-name">${esc(m.first_name)} ${esc(m.last_name)}</span><br>${chamberBadge(m.chamber)} <span class="geo">${geo}</span></div></div>
      <div><div class="lbl">Engagement</div><div class="val">${stats.count} logged interaction${stats.count === 1 ? "" : "s"}${stats.last ? `<br>Last contact ${esc(fmtDate(stats.last))}` : "<br>Never contacted on record"}</div></div>
      <div class="full"><div class="lbl">Committees</div><div class="val">${m.committees.length ? m.committees.map(committeeChip).join("") : "—"}</div></div>
    </div></div>
    <div class="mem-pane" data-pane="staff"><div class="val">${memberStaffHTML(m)}</div></div>
    <div class="mem-pane" data-pane="hist"><div class="val" id="mem-hist"><span style="color:var(--ink-faint)">Loading…</span></div></div>
    <div class="detail-actions" style="padding:0 18px 16px">
      <button class="btn small primary" data-act="log">Log interaction</button>
      <button class="btn small" data-act="edit">Edit member</button>
      <button class="btn small" data-act="ix">View in log</button>
    </div>
  </td>`;
  tr.after(el);
  el.querySelectorAll(".mem-tabs button").forEach(b => b.onclick = (e) => {
    e.stopPropagation();
    el.querySelectorAll(".mem-tabs button").forEach(x => x.classList.toggle("on", x === b));
    el.querySelectorAll(".mem-pane").forEach(p => p.classList.toggle("on", p.dataset.pane === b.dataset.tab));
  });
  try {
    const h = await api("/api/interactions?" + new URLSearchParams({ member_id: String(m.id) }));
    const box = el.querySelector("#mem-hist");
    if (box && box.isConnected) {
      box.innerHTML = h.length
        ? `<div class="table-wrap"><table class="grid compact"><tbody>` +
          h.slice(0, 12).map(r => `<tr><td style="white-space:nowrap">${esc(fmtDate(r.date))}</td>
            <td>${r.interaction_type ? `<span class="ix-type-badge">${esc(r.interaction_type)}</span>` : "—"}</td>
            <td><span class="trunc">${esc(r.summary)}</span></td><td>${statusPill(r.status)}</td></tr>`).join("") +
          `</tbody></table></div>` +
          (h.length > 12 ? `<div style="margin-top:8px;font-size:12.5px;color:var(--ink-faint)">+ ${h.length - 12} more in the log.</div>` : "")
        : '<span style="color:var(--ink-faint)">No interactions with this member yet.</span>';
    }
  } catch {
    const box = el.querySelector("#mem-hist");
    if (box && box.isConnected) box.innerHTML = '<span style="color:var(--ink-faint)">Could not load history.</span>';
  }
  el.querySelector('[data-act="log"]').onclick = (e) => { e.stopPropagation(); openInteractionPanel(null, { member_id: m.id }); };
  el.querySelector('[data-act="edit"]').onclick = (e) => { e.stopPropagation(); openMemberPanel(m); };
  el.querySelector('[data-act="ix"]').onclick = (e) => { e.stopPropagation(); filterLogToMember(m.last_name); };
}
