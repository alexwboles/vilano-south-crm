/* Executive one-pager — renders live data from /api/one-pager. No dependencies. */

const $ = (sel) => document.querySelector(sel);

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

const STATUS_LABEL = { open: "Open", in_progress: "In progress", done: "Done" };

const MONTHS = ["Jan.", "Feb.", "Mar.", "Apr.", "May", "Jun.", "Jul.", "Aug.", "Sep.", "Oct.", "Nov.", "Dec."];
function fmtShort(iso) { // "Dec. 2"
  if (!iso) return "—";
  const [, m, d] = iso.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}`;
}
function fmtMD(iso) { // "9/28"
  if (!iso) return "";
  const [, m, d] = iso.split("-").map(Number);
  return `${m}/${d}`;
}

async function boot() {
  const r = await fetch("/api/one-pager");
  if (r.status === 401) { location.href = "/login.html"; return; }
  const d = await r.json();

  const gen = new Date(d.generated_at);
  $("#gen-date").textContent = "Generated " + gen.toLocaleDateString("en-US", {
    month: "long", day: "numeric", year: "numeric",
  });

  // Quad 1 — Live Projects
  $("#q-projects").innerHTML = d.projects.length ? d.projects.map(p => `<tr>
    <td>${esc(p.name)}</td>
    <td>${esc(p.next_action)}</td>
    <td><span class="pill ${esc(p.status)}">${esc(STATUS_LABEL[p.status] || p.status)}</span></td>
  </tr>`).join("") : `<tr><td colspan="3" class="empty">No projects selected for the one-pager.</td></tr>`;

  // Quad 2 — Upcoming Events
  $("#q-events").innerHTML = d.events.length ? d.events.map(e =>
    `<li><strong>${esc(fmtShort(e.date))}</strong> — ${esc(e.description)} · ${esc(e.lead_person)}</li>`
  ).join("") : `<li class="empty">No upcoming events.</li>`;

  // Quad 3 — Last week's interactions
  $("#q-interactions").innerHTML = d.interactions.length ? d.interactions.map(i =>
    `<li><strong>${esc(fmtMD(i.date))}:</strong> ${esc(i.member)} — ${esc(i.brief)}${i.via ? ` <span class="via">via ${esc(i.via)}</span>` : ""}</li>`
  ).join("") : `<li class="empty">No interactions in the past week.</li>`;

  // Quad 4 — Tasks to do
  $("#q-tasks").innerHTML = d.tasks.length ? d.tasks.map(t => `<tr>
    <td>${esc(t.title)}</td>
    <td>${esc(STATUS_LABEL[t.status] || t.status)}</td>
    <td>${esc(t.owner || "—")}</td>
  </tr>`).join("") : `<tr><td colspan="3" class="empty">No open tasks.</td></tr>`;
}

$("#print-btn").onclick = () => window.print();
boot().catch(() => { document.body.innerHTML = "<p style='padding:40px'>Could not load the executive summary. Please sign in and try again.</p>"; });
