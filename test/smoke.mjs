// Smoke tests for Vilano South GR CRM (3.7.3).
// Boots the app on an ephemeral port against a temp DB (no users, no seed)
// and asserts the first-run setup wizard, auth gating, allowlist enforcement,
// and CRUD incl. reorder/delete + note caps.

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb, initSchema, bootstrapFreshDb } from "../db.js";
import { createApp, pickUpdateAsset } from "../server.js";

const ADMIN_EMAIL = "admin@example.com";
const ADMIN_PW = "s3cure-admin-pass";

const dir = mkdtempSync(path.join(tmpdir(), "vilano-smoke-"));
const db = openDb(path.join(dir, "test.db"));
bootstrapFreshDb(db, { seed: false });

const app = createApp(db, { uploadsDir: path.join(dir, "uploads") });
const server = await new Promise((resolve) => {
  const s = app.listen(0, "127.0.0.1", () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;

let pass = 0, fail = 0;
function ok(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}

let cookie = "";
async function req(method, p, body, { auth = true, raw = false } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (auth && cookie) headers["Cookie"] = cookie;
  const r = await fetch(base + p, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  const setC = r.headers.get("set-cookie");
  if (setC) {
    const m = setC.match(/vs_session=([^;]*)/);
    cookie = m && m[1] ? `vs_session=${m[1]}` : "";
  }
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text, location: r.headers.get("location") };
}

console.log("first-run setup wizard");
{
  let r = await req("GET", "/", undefined, { auth: false });
  ok("empty users: / -> 302 /setup", r.status === 302 && /\/setup$/.test(r.location || ""), `got ${r.status} ${r.location}`);
  r = await req("GET", "/setup", undefined, { auth: false });
  ok("GET /setup -> 200 wizard page", r.status === 200 && /Set up GR CRM/.test(r.text), `got ${r.status}`);
  r = await req("GET", "/setup.js", undefined, { auth: false });
  ok("GET /setup.js -> 200", r.status === 200 && /setup-form/.test(r.text), `got ${r.status}`);
  r = await req("GET", "/login.html", undefined, { auth: false });
  ok("empty users: /login.html -> 302 /setup", r.status === 302 && /\/setup$/.test(r.location || ""), `got ${r.status} ${r.location}`);
  r = await req("POST", "/api/setup", { email: "not-an-email", password: "longenough123" });
  ok("setup with bad email -> 400", r.status === 400, `got ${r.status}`);
  r = await req("POST", "/api/setup", { email: ADMIN_EMAIL, password: "short" });
  ok("setup with weak password -> 400", r.status === 400, `got ${r.status}`);
  r = await req("POST", "/api/setup", { email: "bad-email", password: "longenough123", allowlist: ["alsobad"] });
  ok("setup with bad allowlist email -> 400", r.status === 400, `got ${r.status}`);
  r = await req("POST", "/api/setup", { email: ADMIN_EMAIL, password: ADMIN_PW, allowlist: ["colleague@example.com"] });
  ok("setup with admin + allowlist -> 201", r.status === 201 && r.json?.ok, `got ${r.status} ${JSON.stringify(r.json)}`);
  r = await req("POST", "/api/setup", { email: "second@example.com", password: "another-long-pass" });
  ok("second setup attempt -> 409", r.status === 409, `got ${r.status}`);
  r = await req("GET", "/api/demo-available", undefined, { auth: false });
  ok("demo account absent -> {demo:false}", r.status === 200 && r.json?.demo === false, JSON.stringify(r.json));
  r = await req("GET", "/login.html", undefined, { auth: false });
  ok("after setup: /login.html -> 200", r.status === 200 && /Sign in/.test(r.text), `got ${r.status}`);
  r = await req("GET", "/setup", undefined, { auth: false });
  ok("after setup: /setup -> 302 login", r.status === 302 && /login\.html/.test(r.location || ""), `got ${r.status} ${r.location}`);
  r = await req("GET", "/", undefined, { auth: false });
  ok("after setup: / -> 302 login", r.status === 302 && /login\.html/.test(r.location || ""), `got ${r.status} ${r.location}`);
}

console.log("auth gating");
{
  let r = await req("GET", "/health", undefined, { auth: false });
  ok("public /health -> 200 {ok:true}", r.status === 200 && r.json?.ok === true, `got ${r.status}`);
  r = await req("GET", "/api/me", undefined, { auth: false });
  ok("unauthenticated /api/me -> 401", r.status === 401, `got ${r.status}`);
  r = await req("GET", "/api/members", undefined, { auth: false });
  ok("unauthenticated /api/members -> 401", r.status === 401, `got ${r.status}`);
  r = await req("GET", "/phone", undefined, { auth: false });
  ok("unauthenticated /phone -> 302 login", r.status === 302, `got ${r.status}`);
  r = await req("GET", "/api/phone-url", undefined, { auth: false });
  ok("unauthenticated /api/phone-url -> 401", r.status === 401, `got ${r.status}`);
  r = await req("GET", "/api/phone-qr.png", undefined, { auth: false });
  ok("unauthenticated /api/phone-qr.png -> 401", r.status === 401, `got ${r.status}`);
  r = await req("GET", "/api/phone-qr-remote.png", undefined, { auth: false });
  ok("unauthenticated /api/phone-qr-remote.png -> 401", r.status === 401, `got ${r.status}`);
  r = await req("GET", "/index.html", undefined, { auth: false });
  ok("unauthenticated /index.html -> 302 login", r.status === 302, `got ${r.status}`);
  r = await req("POST", "/api/login", { email: "intruder@evil.com", password: "whatever123" });
  ok("non-allowlisted email cannot login -> 401", r.status === 401, `got ${r.status}`);
  r = await req("POST", "/api/login", { email: ADMIN_EMAIL, password: "wrongpassword" });
  ok("wrong password -> 401", r.status === 401, `got ${r.status}`);
}

console.log("admin login");
{
  const r = await req("POST", "/api/login", { email: ADMIN_EMAIL, password: ADMIN_PW });
  ok("admin login works -> 200", r.status === 200 && r.json?.ok, `got ${r.status}`);
  ok("session cookie set", cookie.startsWith("vs_session="));
  const me = await req("GET", "/api/me");
  ok("/api/me returns admin email", me.status === 200 && me.json?.email === ADMIN_EMAIL, JSON.stringify(me.json));
  const idx = await req("GET", "/index.html");
  ok("authenticated /index.html -> 200", idx.status === 200, `got ${idx.status}`);
}

console.log("phone pairing page");
{
  let r = await req("GET", "/phone");
  ok("authenticated /phone -> 200", r.status === 200 && /Connect your phone/.test(r.text), `got ${r.status}`);
  r = await req("GET", "/api/phone-url");
  ok("/api/phone-url returns an http URL", r.status === 200 && /^http:\/\//.test(r.json?.url || ""), JSON.stringify(r.json));
  ok("/api/phone-url includes remoteUrl", r.status === 200 && "remoteUrl" in (r.json || {}), JSON.stringify(r.json));
  ok("/api/phone-url remoteUrl is null or an http URL",
    r.json && (r.json.remoteUrl === null || /^http:\/\//.test(r.json.remoteUrl)), JSON.stringify(r.json));
  const qr = await fetch(base + "/api/phone-qr.png", { headers: { Cookie: cookie }, redirect: "manual" });
  const buf = Buffer.from(await qr.arrayBuffer());
  ok("phone QR PNG -> 200 image/png, non-empty",
    qr.status === 200 && qr.headers.get("content-type") === "image/png" && buf.length > 500,
    `got ${qr.status} ${qr.headers.get("content-type")} ${buf.length}b`);
  ok("phone QR is a real PNG", buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47, buf.subarray(0, 4).toString("hex"));
  // No overlay network on the test machine -> 404 with an error; on a machine with
  // Tailscale or NetBird running it must be a real PNG instead.
  const tqr = await fetch(base + "/api/phone-qr-remote.png", { headers: { Cookie: cookie }, redirect: "manual" });
  const tbuf = Buffer.from(await tqr.arrayBuffer());
  const tPng = tqr.status === 200 && tqr.headers.get("content-type") === "image/png" && tbuf.length > 500
    && tbuf[0] === 0x89 && tbuf[1] === 0x50 && tbuf[2] === 0x4e && tbuf[3] === 0x47;
  ok("remote-network QR -> 404 without overlay network, or a real PNG with it",
    tqr.status === 404 || tPng, `got ${tqr.status} ${tbuf.length}b`);
}

console.log("members CRUD");
let memberId;
{
  let r = await req("POST", "/api/members", { chamber: "house", first_name: "Test", last_name: "Member", party: "R", state: "FL", district: 7, committees: ["Appropriations"] });
  ok("create member -> 201", r.status === 201 && r.json?.id, `got ${r.status} ${JSON.stringify(r.json)}`);
  memberId = r.json.id;
  ok("committees stored", r.json.committees?.includes("Appropriations"));
  r = await req("GET", "/api/members");
  ok("member listed", r.json.some(m => m.id === memberId));
  r = await req("POST", "/api/members", { chamber: "house", first_name: "No", last_name: "District", party: "D", state: "FL", committees: [] });
  ok("house member without district -> 400", r.status === 400, `got ${r.status}`);
  r = await req("PUT", `/api/members/${memberId}`, { chamber: "senate", first_name: "Test", last_name: "Member", party: "R", state: "FL", district: null, committees: ["Finance"] });
  ok("update member chamber -> 200", r.status === 200 && r.json.chamber === "senate", `got ${r.status}`);
}

console.log("interactions CRUD + filters");
let ixId;
{
  let r = await req("POST", "/api/interactions", { member_id: 99999, date: "2026-10-01", summary: "x" });
  ok("interaction with bad member -> 400", r.status === 400, `got ${r.status}`);
  r = await req("POST", "/api/interactions", { member_id: memberId, date: "2026-10-01", summary: "Met to discuss funding.", next_step: "Send summary.", status: "open" });
  ok("create interaction -> 201", r.status === 201 && r.json?.id, `got ${r.status}`);
  ixId = r.json.id;
  r = await req("GET", "/api/interactions?q=funding");
  ok("search filter finds it", r.json.length === 1 && r.json[0].id === ixId);
  r = await req("GET", "/api/interactions?q=zzz-no-match");
  ok("search filter excludes", r.json.length === 0);
  r = await req("GET", "/api/interactions?chamber=house");
  ok("chamber filter excludes senate member", r.json.every(x => x.chamber === "house"));
  r = await req("GET", "/api/interactions?status=open");
  ok("status filter", r.json.every(x => x.status === "open"));
  r = await req("PUT", `/api/interactions/${ixId}`, { member_id: memberId, date: "2026-10-02", summary: "Updated summary.", next_step: "", status: "done" });
  ok("update interaction -> 200", r.status === 200, `got ${r.status}`);
  r = await req("DELETE", `/api/interactions/${ixId}`);
  ok("delete interaction -> 200", r.status === 200, `got ${r.status}`);
  r = await req("DELETE", `/api/interactions/${ixId}`);
  ok("delete missing interaction -> 404", r.status === 404, `got ${r.status}`);
}

console.log("events CRUD");
let evId;
{
  let r = await req("POST", "/api/events", { date: "2026-12-02", description: "Fundraiser", lead_person: "T. Boles" });
  ok("create event -> 201", r.status === 201 && r.json?.id, `got ${r.status}`);
  evId = r.json.id;
  r = await req("POST", "/api/events", { date: "not-a-date", description: "x", lead_person: "y" });
  ok("bad date -> 400", r.status === 400, `got ${r.status}`);
  r = await req("PUT", `/api/events/${evId}`, { date: "2026-12-03", description: "Fundraiser (moved)", lead_person: "T. Boles" });
  ok("update event -> 200", r.status === 200, `got ${r.status}`);
  r = await req("GET", "/api/events");
  ok("event updated in list", r.json.some(e => e.id === evId && e.description === "Fundraiser (moved)"));
  r = await req("DELETE", `/api/events/${evId}`);
  ok("delete event -> 200", r.status === 200, `got ${r.status}`);
}

console.log("projects/tasks CRUD + reorder + note cap");
let gid, t1, t2;
{
  let r = await req("POST", "/api/projects/groups", { name: "Test Group" });
  ok("create group -> 201", r.status === 201 && r.json?.id, `got ${r.status}`);
  gid = r.json.id;
  const mk = (title, note) => req("POST", `/api/projects/groups/${gid}/tasks`, { title, owner: "T. Boles", note });
  r = await mk("First task", "One sentence only.");
  ok("create task 1 -> 201", r.status === 201, `got ${r.status} ${JSON.stringify(r.json)}`);
  t1 = r.json.id;
  r = await mk("Second task", "");
  ok("create task 2 -> 201", r.status === 201, `got ${r.status}`);
  t2 = r.json.id;
  r = await mk("Bad task", "One. Two. Three sentences here.");
  ok("3-sentence note -> 400", r.status === 400, `got ${r.status}`);
  r = await mk("Bad task 2", "x".repeat(301));
  ok("301-char note -> 400", r.status === 400, `got ${r.status}`);
  const order = async () => (await req("GET", "/api/projects")).json.find(g => g.id === gid).tasks.map(t => t.id);
  ok("initial order [t1, t2]", JSON.stringify(await order()) === JSON.stringify([t1, t2]));
  r = await req("POST", `/api/tasks/${t2}/move`, { direction: "up" });
  ok("move t2 up -> moved", r.json?.moved === true, JSON.stringify(r.json));
  ok("order now [t2, t1]", JSON.stringify(await order()) === JSON.stringify([t2, t1]));
  r = await req("POST", `/api/tasks/${t2}/move`, { direction: "up" });
  ok("move top task up -> not moved", r.json?.moved === false);
  r = await req("PUT", `/api/tasks/${t1}`, { title: "First task (renamed)", owner: "J. Doe", status: "done", note: "Done deal. All good." });
  ok("update task -> 200", r.status === 200, `got ${r.status}`);
  r = await req("DELETE", `/api/tasks/${t1}`);
  ok("delete task -> 200", r.status === 200, `got ${r.status}`);
  r = await req("DELETE", `/api/projects/groups/${gid}`);
  ok("delete group -> 200", r.status === 200, `got ${r.status}`);
}

console.log("admin: allowlist + users");
{
  let r = await req("POST", "/api/admin/users", { email: "nobody@notallowed.com", password: "password123" });
  ok("create user for non-allowlisted email -> 400", r.status === 400, `got ${r.status}`);
  r = await req("POST", "/api/admin/allowed", { email: "staffer@example.com" });
  ok("approve email -> 201", r.status === 201, `got ${r.status}`);
  r = await req("POST", "/api/admin/allowed", { email: "not-an-email" });
  ok("approve invalid email -> 400", r.status === 400, `got ${r.status}`);
  r = await req("POST", "/api/admin/users", { email: "staffer@example.com", password: "short" });
  ok("weak password -> 400", r.status === 400, `got ${r.status}`);
  r = await req("POST", "/api/admin/users", { email: "staffer@example.com", password: "s3cure-pass" });
  ok("create user for allowlisted email -> 201", r.status === 201, `got ${r.status}`);
  // new user can log in
  cookie = "";
  r = await req("POST", "/api/login", { email: "staffer@example.com", password: "s3cure-pass" }, { auth: false });
  ok("new user login works", r.status === 200, `got ${r.status}`);
  // log back in as demo for logout test
  cookie = "";
  await req("POST", "/api/login", { email: ADMIN_EMAIL, password: ADMIN_PW }, { auth: false });
}

console.log("documents: upload/list/download/delete + auth");
{
  let r = await req("GET", "/api/documents", undefined, { auth: false });
  ok("unauthenticated /api/documents -> 401", r.status === 401, `got ${r.status}`);
  r = await req("POST", "/api/documents", { name: "x.txt", data: "eA==" }, { auth: false });
  ok("unauthenticated upload -> 401", r.status === 401, `got ${r.status}`);
  r = await req("GET", "/api/documents/1/download", undefined, { auth: false });
  ok("unauthenticated download -> 401", r.status === 401, `got ${r.status}`);

  const payload = Buffer.from("finalized memo contents").toString("base64");
  r = await req("POST", "/api/documents", { name: "../../sneaky.txt", data: payload });
  ok("upload -> 201", r.status === 201 && r.json?.id, `got ${r.status} ${JSON.stringify(r.json)}`);
  const docId = r.json.id;
  ok("filename sanitized (no path)", r.json.name === "sneaky.txt", `got ${r.json.name}`);
  r = await req("GET", "/api/documents");
  ok("document listed with metadata", r.json.some(d => d.id === docId && d.size === 23 && d.uploaded_by === ADMIN_EMAIL), JSON.stringify(r.json));
  r = await req("GET", `/api/documents/${docId}/download`);
  ok("download listed ok", r.status === 200, `got ${r.status}`);
  // verify bytes + headers via a raw fetch (helper reads text, which can mangle binary)
  const dl = await fetch(base + `/api/documents/${docId}/download`, { headers: { Cookie: cookie }, redirect: "manual" });
  const dlBuf = Buffer.from(await dl.arrayBuffer());
  ok("download bytes match upload", dlBuf.toString() === "finalized memo contents", `got ${dlBuf.length} bytes`);
  ok("content-disposition is attachment", /attachment/.test(dl.headers.get("content-disposition") || ""), dl.headers.get("content-disposition"));
  ok("content-type is octet-stream (never inline)", dl.headers.get("content-type") === "application/octet-stream", dl.headers.get("content-type"));
  r = await req("DELETE", `/api/documents/${docId}`);
  ok("delete document -> 200", r.status === 200, `got ${r.status}`);
  r = await req("GET", `/api/documents/${docId}/download`);
  ok("download after delete -> 404", r.status === 404, `got ${r.status}`);
  r = await req("DELETE", `/api/documents/${docId}`);
  ok("delete missing document -> 404", r.status === 404, `got ${r.status}`);

  const big = Buffer.alloc(26 * 1024 * 1024, 7).toString("base64");
  r = await req("POST", "/api/documents", { name: "huge.bin", data: big });
  ok("26MB upload rejected -> 413", r.status === 413, `got ${r.status}`);
  r = await req("POST", "/api/documents", { name: "empty.txt", data: "" });
  ok("empty upload -> 400", r.status === 400, `got ${r.status}`);
}

console.log("events upcoming scope");
{
  const today = new Date();
  const iso = (off) => { const d = new Date(today); d.setDate(d.getDate() + off); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }; // local-date math, matching server todayStr()
  let r = await req("POST", "/api/events", { date: iso(-3), description: "Past event", lead_person: "T. Boles" });
  const pastId = r.json.id;
  r = await req("POST", "/api/events", { date: iso(5), description: "Future event", lead_person: "J. Doe" });
  const futId = r.json.id;
  r = await req("GET", "/api/events?upcoming=1");
  ok("upcoming=1 excludes past events", r.json.every(e => e.date >= iso(0)) && r.json.some(e => e.id === futId), `got ${r.json.length} rows`);
  r = await req("GET", "/api/events");
  ok("plain list still includes past events", r.json.some(e => e.id === pastId));
  await req("DELETE", `/api/events/${pastId}`);
  await req("DELETE", `/api/events/${futId}`);
}

console.log("one-pager: auth + live data");
{
  let r = await req("GET", "/one-pager", undefined, { auth: false });
  ok("unauthenticated /one-pager -> 302 login", r.status === 302 && /login\.html/.test(r.location || ""), `got ${r.status} ${r.location}`);
  r = await req("GET", "/api/one-pager", undefined, { auth: false });
  ok("unauthenticated /api/one-pager -> 401", r.status === 401, `got ${r.status}`);
  r = await req("GET", "/one-pager");
  ok("authenticated /one-pager -> 200", r.status === 200 && /Executive Summary/.test(r.text), `got ${r.status}`);

  const today = new Date();
  const iso = (off) => { const d = new Date(today); d.setDate(d.getDate() + off); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }; // local-date math, matching server todayStr()

  // project group toggle: on -> in Quad 1, off -> gone
  r = await req("POST", "/api/projects/groups", { name: "Pager Test Group" });
  const pgid = r.json.id;
  r = await req("GET", "/api/one-pager");
  ok("toggled-on group appears in Quad 1", r.json.projects.some(p => p.name === "Pager Test Group"), JSON.stringify(r.json.projects));
  r = await req("PUT", `/api/projects/groups/${pgid}`, { name: "Pager Test Group", show_on_pager: false });
  ok("toggle off -> 200", r.status === 200, `got ${r.status}`);
  r = await req("GET", "/api/one-pager");
  ok("toggled-off group absent from Quad 1", !r.json.projects.some(p => p.name === "Pager Test Group"));
  await req("DELETE", `/api/projects/groups/${pgid}`);

  // next action = most urgent open task
  r = await req("POST", "/api/projects/groups", { name: "Action Group" });
  const agid = r.json.id;
  await req("POST", `/api/projects/groups/${agid}/tasks`, { title: "Later task", owner: "T. Boles", due_date: iso(9), status: "open" });
  await req("POST", `/api/projects/groups/${agid}/tasks`, { title: "Urgent task", owner: "J. Doe", due_date: iso(1), status: "open" });
  r = await req("GET", "/api/one-pager");
  const proj = r.json.projects.find(p => p.name === "Action Group");
  ok("Quad 1 next action = most urgent open task", proj?.next_action === "Urgent task" && proj?.status === "open", JSON.stringify(proj));
  await req("DELETE", `/api/projects/groups/${agid}`);

  // Quad 2: future event in, past event out
  r = await req("POST", "/api/events", { date: iso(6), description: "Pager future event", lead_person: "T. Boles" });
  const fev = r.json.id;
  r = await req("POST", "/api/events", { date: iso(-2), description: "Pager past event", lead_person: "T. Boles" });
  const pev = r.json.id;
  r = await req("GET", "/api/one-pager");
  ok("Quad 2 includes future event", r.json.events.some(e => e.id === fev));
  ok("Quad 2 excludes past event", !r.json.events.some(e => e.id === pev));
  await req("DELETE", `/api/events/${fev}`);
  await req("DELETE", `/api/events/${pev}`);

  // Quad 3: recent interaction in, 8-day-old out, capped at 2 sentences
  r = await req("POST", "/api/members", { chamber: "house", first_name: "Pager", last_name: "Tester", party: "R", state: "FL", district: 3, committees: [] });
  const pmid = r.json.id;
  const longSummary = "First sentence here. Second sentence here. Third sentence should be cut.";
  r = await req("POST", "/api/interactions", { member_id: pmid, date: iso(-2), summary: longSummary, status: "open" });
  const recentIx = r.json.id;
  r = await req("POST", "/api/interactions", { member_id: pmid, date: iso(-8), summary: "Too old to show.", status: "open" });
  const oldIx = r.json.id;
  r = await req("GET", "/api/one-pager");
  const ix = r.json.interactions.find(i => i.id === recentIx);
  ok("Quad 3 includes recent interaction", !!ix, JSON.stringify(r.json.interactions));
  ok("Quad 3 brief capped at 2 sentences", ix && !/Third sentence/.test(ix.brief), JSON.stringify(ix?.brief));
  ok("Quad 3 member styled per guide", ix?.member === "Rep. Tester (R-FL-3)", JSON.stringify(ix?.member));
  ok("Quad 3 excludes 8-day-old interaction", !r.json.interactions.some(i => i.id === oldIx));
  await req("DELETE", `/api/interactions/${recentIx}`);
  await req("DELETE", `/api/interactions/${oldIx}`);

  // Quad 4: open tasks listed, done tasks excluded
  r = await req("POST", "/api/projects/groups", { name: "Quad4 Group" });
  const q4g = r.json.id;
  r = await req("POST", `/api/projects/groups/${q4g}/tasks`, { title: "Quad4 open task", owner: "T. Boles", status: "open" });
  const q4open = r.json.id;
  r = await req("POST", `/api/projects/groups/${q4g}/tasks`, { title: "Quad4 done task", owner: "T. Boles", status: "done" });
  const q4done = r.json.id;
  r = await req("GET", "/api/one-pager");
  ok("Quad 4 includes open task with owner", r.json.tasks.some(t => t.id === q4open && t.owner === "T. Boles"));
  ok("Quad 4 excludes done tasks", !r.json.tasks.some(t => t.id === q4done));
  await req("DELETE", `/api/projects/groups/${q4g}`);
}

console.log("staff CRUD + assignments + interaction staffer");
let stafferId, assignId1, assignId2, memberId2;
{
  let r = await req("GET", "/api/staff", undefined, { auth: false });
  ok("unauthenticated /api/staff -> 401", r.status === 401, `got ${r.status}`);

  r = await req("POST", "/api/staff", { first_name: "Test", last_name: "Staffer", title: "Legislative Director", email: "t.staffer@example.gov", phone: "202-555-0100", notes: "Test notes." });
  ok("create staffer -> 201", r.status === 201 && r.json?.id, `got ${r.status} ${JSON.stringify(r.json)}`);
  stafferId = r.json.id;
  ok("staffer fields round-trip", r.json.title === "Legislative Director" && r.json.email === "t.staffer@example.gov");
  ok("new staffer has no current members", Array.isArray(r.json.current_members) && r.json.current_members.length === 0);

  r = await req("POST", "/api/staff", { first_name: "", last_name: "NoFirst" });
  ok("staffer without first name -> 400", r.status === 400, `got ${r.status}`);
  r = await req("POST", "/api/staff", { first_name: "Bad", last_name: "Email", email: "not-an-email" });
  ok("staffer with bad email -> 400", r.status === 400, `got ${r.status}`);

  r = await req("PUT", `/api/staff/${stafferId}`, { first_name: "Test", last_name: "Staffer", title: "Chief of Staff", email: "", phone: "", notes: "" });
  ok("update staffer -> 200", r.status === 200 && r.json.title === "Chief of Staff", `got ${r.status}`);
  r = await req("PUT", "/api/staff/99999", { first_name: "x", last_name: "y" });
  ok("update missing staffer -> 404", r.status === 404, `got ${r.status}`);

  r = await req("GET", "/api/staff");
  ok("staffer listed", r.json.some(s => s.id === stafferId));
  r = await req("GET", "/api/staff?q=chief");
  ok("staff search finds by title", r.json.some(s => s.id === stafferId));
  r = await req("GET", "/api/staff?q=zzz-no-match");
  ok("staff search excludes", r.json.every(s => s.id !== stafferId));

  // assignments: multi-boss + history
  r = await req("POST", `/api/staff/${stafferId}/assignments`, { member_id: memberId, started_on: "2026-01-05" });
  ok("assign staffer to member -> 201", r.status === 201 && r.json?.id, `got ${r.status}`);
  assignId1 = r.json.id;
  r = await req("POST", `/api/staff/${stafferId}/assignments`, { member_id: memberId, started_on: "2026-02-01" });
  ok("duplicate current assignment -> 400", r.status === 400, `got ${r.status}`);
  r = await req("POST", `/api/staff/${stafferId}/assignments`, { member_id: 99999 });
  ok("assign to missing member -> 400", r.status === 400, `got ${r.status}`);

  r = await req("POST", "/api/members", { chamber: "house", first_name: "Multi", last_name: "Boss", party: "D", state: "VA", district: 8, committees: [] });
  memberId2 = r.json.id;
  r = await req("POST", `/api/staff/${stafferId}/assignments`, { member_id: memberId2 });
  ok("same staffer, second member -> 201 (multi-boss)", r.status === 201, `got ${r.status}`);
  assignId2 = r.json.id;

  r = await req("GET", "/api/staff?member_id=" + memberId2);
  ok("staff member filter finds assigned staffer", r.json.some(s => s.id === stafferId));
  r = await req("GET", "/api/staff?member_id=99999");
  ok("staff member filter excludes others", r.json.every(s => s.id !== stafferId));

  r = await req("GET", `/api/staff/${stafferId}`);
  ok("staffer detail: 2 current assignments", r.json.assignments.filter(a => a.current).length === 2, JSON.stringify(r.json.assignments));
  ok("assignments carry member labels", r.json.assignments.every(a => /^(Rep|Sen)\./.test(a.label)));
  r = await req("GET", "/api/staff/99999");
  ok("missing staffer detail -> 404", r.status === 404, `got ${r.status}`);

  r = await req("POST", `/api/assignments/${assignId1}/end`, { ended_on: "2026-09-01" });
  ok("end assignment -> 200", r.status === 200, `got ${r.status}`);
  r = await req("POST", `/api/assignments/${assignId1}/end`, { ended_on: "2026-09-02" });
  ok("end already-ended assignment -> 400", r.status === 400, `got ${r.status}`);
  r = await req("POST", "/api/assignments/99999/end", {});
  ok("end missing assignment -> 404", r.status === 404, `got ${r.status}`);

  r = await req("GET", `/api/staff/${stafferId}`);
  const former = r.json.assignments.filter(a => !a.current);
  ok("former assignment kept in history", former.length === 1 && former[0].ended_on === "2026-09-01", JSON.stringify(former));

  // member payloads carry staff
  r = await req("GET", "/api/members");
  const m1 = r.json.find(m => m.id === memberId);
  ok("member payload: former staff listed", m1.former_staff.some(s => s.id === stafferId && s.title === "Chief of Staff"));
  ok("member payload: current staff excludes ended", m1.current_staff.every(s => s.id !== stafferId));
  const m2 = r.json.find(m => m.id === memberId2);
  ok("member payload: current staff listed", m2.current_staff.some(s => s.id === stafferId));

  // interactions: staffer optional, always tied to a member
  r = await req("POST", "/api/interactions", { member_id: memberId2, date: "2026-10-03", summary: "Met with staffer present.", staff_id: 99999 });
  ok("interaction with bad staff_id -> 400", r.status === 400, `got ${r.status}`);
  r = await req("POST", "/api/interactions", { member_id: memberId2, date: "2026-10-03", summary: "Met with staffer present.", staff_id: stafferId });
  ok("interaction with staffer -> 201", r.status === 201 && r.json?.id, `got ${r.status}`);
  const sixId = r.json.id;
  r = await req("GET", "/api/interactions?member_id=" + memberId2);
  const sixRow = r.json.find(x => x.id === sixId);
  ok("interaction row carries staffer name/title", sixRow?.staff_first_name === "Test" && sixRow?.staff_title === "Chief of Staff", JSON.stringify(sixRow));
  r = await req("GET", `/api/staff/${stafferId}`);
  ok("staffer detail includes interaction with member label", r.json.interactions.some(x => x.id === sixId && x.member_label === "Rep. Multi Boss (D-VA-8)"), JSON.stringify(r.json.interactions));
  r = await req("PUT", `/api/interactions/${sixId}`, { member_id: memberId2, date: "2026-10-03", summary: "Met with staffer present.", staff_id: null });
  ok("interaction update clears staffer -> 200", r.status === 200, `got ${r.status}`);
  r = await req("GET", "/api/interactions?member_id=" + memberId2);
  ok("staffer cleared on row", r.json.find(x => x.id === sixId)?.staff_first_name == null);
  await req("DELETE", `/api/interactions/${sixId}`);

  // one-pager Quad 3 via attribution
  const iso = (off) => { const d = new Date(); d.setDate(d.getDate() + off); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  r = await req("POST", "/api/interactions", { member_id: memberId2, date: iso(-1), summary: "Quick check-in call. All good.", staff_id: stafferId });
  const pagerIx = r.json.id;
  r = await req("GET", "/api/one-pager");
  const pix = r.json.interactions.find(i => i.id === pagerIx);
  ok("one-pager interaction carries via", pix?.via === "Test Staffer, Chief of Staff", JSON.stringify(pix));
  await req("DELETE", `/api/interactions/${pagerIx}`);

  // delete blocked while referenced
  r = await req("DELETE", `/api/staff/${stafferId}`);
  ok("delete staffer with assignments/interactions -> 400", r.status === 400, `got ${r.status}`);
  r = await req("POST", "/api/staff", { first_name: "Lone", last_name: "Wolf" });
  const loneId = r.json.id;
  r = await req("DELETE", `/api/staff/${loneId}`);
  ok("delete unreferenced staffer -> 200", r.status === 200, `got ${r.status}`);
  r = await req("DELETE", "/api/staff/99999");
  ok("delete missing staffer -> 404", r.status === 404, `got ${r.status}`);
}

console.log("interaction type + follow-up chain + status endpoint");
{
  let r = await req("POST", "/api/interactions", { member_id: memberId2, date: "2026-10-04", summary: "Type test.", interaction_type: "Bogus" });
  ok("invalid interaction type -> 400", r.status === 400, `got ${r.status}`);
  r = await req("POST", "/api/interactions", { member_id: memberId2, date: "2026-10-04", summary: "Parent meeting.", interaction_type: "Meeting" });
  ok("create with type -> 201", r.status === 201 && r.json?.id, `got ${r.status}`);
  const parentIx = r.json.id;
  r = await req("GET", "/api/interactions?member_id=" + memberId2);
  ok("row carries interaction_type", r.json.find(x => x.id === parentIx)?.interaction_type === "Meeting");

  r = await req("POST", "/api/interactions", { member_id: memberId2, date: "2026-10-05", summary: "Child follow-up.", parent_id: 99999 });
  ok("follow-up with bad parent -> 400", r.status === 400, `got ${r.status}`);
  r = await req("POST", "/api/interactions", { member_id: memberId2, date: "2026-10-05", summary: "Child follow-up.", parent_id: parentIx, interaction_type: "Call" });
  ok("create follow-up -> 201", r.status === 201 && r.json?.id, `got ${r.status}`);
  const childIx = r.json.id;
  r = await req("GET", "/api/interactions?member_id=" + memberId2);
  const childRow = r.json.find(x => x.id === childIx);
  ok("child row has parent_label", childRow?.parent_id === parentIx && /Rep\. Multi Boss/.test(childRow?.parent_label || ""), JSON.stringify(childRow));
  r = await req("GET", `/api/interactions/${parentIx}/followups`);
  ok("followups endpoint lists child", r.status === 200 && r.json.some(x => x.id === childIx && x.member_label === "Rep. Multi Boss (D-VA-8)"), JSON.stringify(r.json));
  r = await req("GET", "/api/interactions/99999/followups");
  ok("followups for missing interaction -> 404", r.status === 404, `got ${r.status}`);
  r = await req("PUT", `/api/interactions/${childIx}`, { member_id: memberId2, date: "2026-10-05", summary: "Child follow-up.", parent_id: childIx });
  ok("self-parent on update -> 400", r.status === 400, `got ${r.status}`);

  r = await req("POST", `/api/interactions/${parentIx}/status`, { status: "bogus" });
  ok("status endpoint rejects bad status -> 400", r.status === 400, `got ${r.status}`);
  r = await req("POST", "/api/interactions/99999/status", { status: "done" });
  ok("status endpoint for missing interaction -> 404", r.status === 404, `got ${r.status}`);
  r = await req("POST", `/api/interactions/${parentIx}/status`, { status: "done" });
  ok("status endpoint sets done -> 200", r.status === 200, `got ${r.status}`);
  r = await req("GET", "/api/interactions?member_id=" + memberId2);
  ok("status persisted", r.json.find(x => x.id === parentIx)?.status === "done");

  await req("DELETE", `/api/interactions/${childIx}`);
  await req("DELETE", `/api/interactions/${parentIx}`);
}

console.log("one-pager nav");
{
  const r = await req("GET", "/one-pager");
  ok("one-pager page contains nav links", r.status === 200 && r.text.includes('href="/#staff"') && r.text.includes('href="/#interactions"'), `got ${r.status}`);
  ok("one-pager marks One-Pager active", /href="\/one-pager" class="active"/.test(r.text));
}

console.log("bugfix regressions: member delete block, dates, cycles, assignment dates, LIKE escape, committee dedupe");
{
  // M3: member delete blocked while history references the member
  let r = await req("POST", "/api/members", { chamber: "house", first_name: "Del", last_name: "Block", party: "R", state: "FL", district: 1, committees: [] });
  const mid = r.json.id;
  r = await req("POST", "/api/interactions", { member_id: mid, date: "2026-10-01", summary: "history row" });
  const ixid = r.json.id;
  r = await req("DELETE", `/api/members/${mid}`);
  ok("delete member with interactions -> 400", r.status === 400 && /interactions/.test(r.json?.error || ""), `got ${r.status} ${JSON.stringify(r.json)}`);
  r = await req("GET", "/api/interactions?member_id=" + mid);
  ok("interaction history preserved after blocked delete", r.json.length === 1 && r.json[0].id === ixid);
  await req("DELETE", `/api/interactions/${ixid}`);

  r = await req("POST", "/api/staff", { first_name: "Ref", last_name: "Erenced" });
  const sid = r.json.id;
  await req("POST", `/api/staff/${sid}/assignments`, { member_id: mid });
  r = await req("DELETE", `/api/members/${mid}`);
  ok("delete member with staff assignment -> 400", r.status === 400, `got ${r.status}`);
  r = await req("GET", `/api/staff/${sid}`);
  ok("assignment history preserved after blocked delete", r.json.assignments.length === 1, JSON.stringify(r.json.assignments));

  r = await req("POST", "/api/members", { chamber: "senate", first_name: "Lone", last_name: "Member", party: "I", state: "TX", committees: [] });
  const loneMid = r.json.id;
  r = await req("DELETE", `/api/members/${loneMid}`);
  ok("delete unreferenced member -> 200", r.status === 200, `got ${r.status}`);
  r = await req("DELETE", "/api/members/99999");
  ok("delete missing member -> 404", r.status === 404, `got ${r.status}`);

  // m1: impossible calendar dates rejected everywhere
  r = await req("POST", "/api/interactions", { member_id: memberId, date: "2026-02-30", summary: "x" });
  ok("interaction 2026-02-30 -> 400", r.status === 400, `got ${r.status}`);
  r = await req("POST", "/api/interactions", { member_id: memberId, date: "2024-02-29", summary: "leap day" });
  ok("real leap day 2024-02-29 -> 201", r.status === 201, `got ${r.status}`);
  await req("DELETE", `/api/interactions/${r.json.id}`);
  r = await req("POST", "/api/events", { date: "2026-02-30", description: "x", lead_person: "y" });
  ok("event 2026-02-30 -> 400", r.status === 400, `got ${r.status}`);
  r = await req("POST", "/api/staff", { first_name: "Date", last_name: "Tester" });
  const dsid = r.json.id;
  r = await req("POST", `/api/staff/${dsid}/assignments`, { member_id: memberId, started_on: "2026-13-40" });
  ok("assignment impossible start date -> 400", r.status === 400, `got ${r.status}`);
  await req("DELETE", `/api/staff/${dsid}`);

  // m2: follow-up cycles rejected
  r = await req("POST", "/api/interactions", { member_id: memberId, date: "2026-10-01", summary: "A" });
  const cycA = r.json.id;
  r = await req("POST", "/api/interactions", { member_id: memberId, date: "2026-10-02", summary: "B", parent_id: cycA });
  const cycB = r.json.id;
  r = await req("POST", "/api/interactions", { member_id: memberId, date: "2026-10-03", summary: "C", parent_id: cycB });
  const cycC = r.json.id;
  r = await req("PUT", `/api/interactions/${cycA}`, { member_id: memberId, date: "2026-10-01", summary: "A", parent_id: cycC });
  ok("3-cycle A->C->B->A -> 400", r.status === 400 && /cycle/.test(r.json?.error || ""), `got ${r.status} ${JSON.stringify(r.json)}`);
  r = await req("PUT", `/api/interactions/${cycA}`, { member_id: memberId, date: "2026-10-01", summary: "A", parent_id: cycB });
  ok("2-cycle A->B->A -> 400", r.status === 400, `got ${r.status}`);
  r = await req("PUT", `/api/interactions/${cycC}`, { member_id: memberId, date: "2026-10-03", summary: "C", parent_id: cycA });
  ok("acyclic reparent C->A -> 200", r.status === 200, `got ${r.status}`);
  await req("DELETE", `/api/interactions/${cycC}`);
  await req("DELETE", `/api/interactions/${cycB}`);
  await req("DELETE", `/api/interactions/${cycA}`);

  // m3: assignment end date cannot precede start date
  r = await req("POST", "/api/staff", { first_name: "Chrono", last_name: "Logical" });
  const csid = r.json.id;
  r = await req("POST", `/api/staff/${csid}/assignments`, { member_id: memberId, started_on: "2026-06-01" });
  const caid = r.json.id;
  r = await req("POST", `/api/assignments/${caid}/end`, { ended_on: "2026-05-31" });
  ok("end date before start date -> 400", r.status === 400, `got ${r.status}`);
  r = await req("POST", `/api/assignments/${caid}/end`, { ended_on: "2026-06-01" });
  ok("end date equal to start date -> 200", r.status === 200, `got ${r.status}`);

  // m8: LIKE wildcards treated literally
  r = await req("POST", "/api/interactions", { member_id: memberId, date: "2026-10-01", summary: "100% certain about funding" });
  const wid = r.json.id;
  r = await req("POST", "/api/interactions", { member_id: memberId, date: "2026-10-02", summary: "plain funding note" });
  const pid = r.json.id;
  r = await req("GET", "/api/interactions?q=" + encodeURIComponent("%"));
  ok("q=% matches only literal-% rows", r.json.length === 1 && r.json[0].id === wid, `got ${r.json.length}`);
  r = await req("GET", "/api/interactions?q=" + encodeURIComponent("100%"));
  ok("q=100% finds the row", r.json.some(x => x.id === wid), `got ${r.json.length}`);
  r = await req("GET", "/api/interactions?q=" + encodeURIComponent("_"));
  ok("q=_ matches only literal-_ rows", r.json.length === 0, `got ${r.json.length}`);
  await req("DELETE", `/api/interactions/${wid}`);
  await req("DELETE", `/api/interactions/${pid}`);

  // m9: duplicate committee names deduped per member
  r = await req("POST", "/api/members", { chamber: "house", first_name: "Dup", last_name: "Comm", party: "R", state: "FL", district: 2, committees: ["Appropriations", " appropriations ", "APPROPRIATIONS", "Finance", ""] });
  ok("committees deduped case-insensitively on create", r.status === 201 && r.json.committees.length === 2, JSON.stringify(r.json?.committees));
  const dupMid = r.json.id;
  r = await req("PUT", `/api/members/${dupMid}`, { chamber: "house", first_name: "Dup", last_name: "Comm", party: "R", state: "FL", district: 2, committees: ["Finance", "finance"] });
  ok("committees deduped on update", r.json.committees.length === 1, JSON.stringify(r.json?.committees));
  await req("DELETE", `/api/members/${dupMid}`);

  // M1 + m5: submit guard and hashchange listener shipped in app.js
  r = await req("GET", "/app.js");
  ok("app.js served", r.status === 200, `got ${r.status}`);
  ok("submit guard disables save buttons", /btn\.disabled\s*=\s*true/.test(r.text));
  ok("hashchange listener present", /addEventListener\(['"]hashchange['"]/.test(r.text));

  // PWA install: service worker served publicly, manifest linked, banner wired
  r = await req("GET", "/sw.js");
  ok("sw.js served publicly", r.status === 200, `got ${r.status}`);
  ok("sw.js has fetch handler", /addEventListener\(["']fetch["']/.test(r.text));
  r = await req("GET", "/login.html");
  ok("login page links manifest", /rel="manifest"/.test(r.text));
  r = await req("GET", "/");
  // index.html requires auth; check the file directly for banner markup instead
  const idxHtml = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  ok("install banner markup present", /id="install-banner"/.test(idxHtml));
  ok("beforeinstallprompt handler present", /beforeinstallprompt/.test(idxHtml) || /beforeinstallprompt/.test((await req("GET", "/app.js")).text));

  // phone pairing: secure URL gracefully absent without Tailscale
  r = await req("GET", "/api/phone-url");
  ok("phone-url includes secureUrl field", r.status === 200 && "secureUrl" in (r.json || {}), `got ${r.status}`);
  ok("secureUrl null without Tailscale", r.json?.secureUrl === null, `got ${r.json?.secureUrl}`);
  r = await req("GET", "/api/phone-qr-secure.png");
  ok("secure QR 404s without Tailscale", r.status === 404, `got ${r.status}`);
  // public link (Cloudflare Tunnel): null without cloudflared on non-Windows
  r = await req("GET", "/api/phone-url");
  ok("phone-url includes publicUrl field", "publicUrl" in (r.json || {}), `got ${JSON.stringify(r.json)}`);
  r = await req("GET", "/api/phone-qr-public.png");
  ok("public QR 404s when tunnel not running", r.status === 404, `got ${r.status}`);
  // named tunnel config (Cloudflare account linking)
  r = await req("GET", "/api/admin/tunnel");
  ok("tunnel GET returns linked=false initially", r.json?.linked === false, `got ${JSON.stringify(r.json)}`);
  r = await req("POST", "/api/admin/tunnel", { token: "tok123", hostname: "https://crm.example.com/" });
  ok("tunnel POST normalizes hostname", true, "");
  r = await req("GET", "/api/admin/tunnel");
  ok("tunnel hostname stored without scheme/slash", r.json?.hostname === "crm.example.com", `got ${r.json?.hostname}`);
  ok("tunnel linked=true with token+hostname", r.json?.linked === true, `got ${r.json?.linked}`);
  ok("tunnel token never returned", !("token" in (r.json || {})), `got ${JSON.stringify(r.json)}`);
  r = await req("POST", "/api/admin/tunnel", { token: "", hostname: "" });
  r = await req("GET", "/api/admin/tunnel");
  ok("tunnel clear unlinks", r.json?.linked === false, `got ${r.json?.linked}`);
  // auto-update status endpoint
  r = await req("GET", "/api/update-status");
  ok("update-status returns current version", typeof r.json?.current === "string" && r.json.current.length > 0, `got ${JSON.stringify(r.json)}`);
  ok("update-status not ready initially", r.json?.ready === false, `got ${r.json?.ready}`);
  r = await req("POST", "/api/update-install");
  ok("update-install 400s with nothing downloaded", r.status === 400, `got ${r.status}`);
}

console.log("bugfix: self password change invalidates other sessions");
{
  const mainCookie = cookie;
  let r = await req("POST", "/api/login", { email: ADMIN_EMAIL, password: ADMIN_PW }, { auth: false });
  ok("second login for session test", r.status === 200, `got ${r.status}`);
  const secondCookie = cookie;
  cookie = mainCookie;
  r = await req("POST", "/api/admin/password", { password: "temp-new-pass-12" });
  ok("password change -> 200", r.status === 200, `got ${r.status}`);
  cookie = secondCookie;
  r = await req("GET", "/api/me");
  ok("other session invalidated -> 401", r.status === 401, `got ${r.status}`);
  cookie = mainCookie;
  r = await req("GET", "/api/me");
  ok("current session survives -> 200", r.status === 200, `got ${r.status}`);
  r = await req("POST", "/api/admin/password", { password: ADMIN_PW });
  ok("password restored", r.status === 200, `got ${r.status}`);
}

console.log("sample dataset: full load / purge");
{
  const fileLegs = JSON.parse(readFileSync(new URL("../legislators.json", import.meta.url), "utf8"));
  ok("legislators.json has 500+ rows", fileLegs.length > 500, `got ${fileLegs.length}`);
  ok("legislators.json has committee data", fileLegs.some(m => (m.committees || []).length > 0), "no committees found");
  let r = await req("GET", "/api/admin/sample-legislators");
  ok("sample count starts at 0", r.json?.count === 0, `got ${JSON.stringify(r.json)}`);
  // real records must survive the purge
  r = await req("POST", "/api/members", { chamber: "senate", first_name: "Real", last_name: "Person", party: "R", state: "FL", committees: [] });
  ok("real member created", r.status === 201, `got ${r.status}`);
  r = await req("POST", "/api/events", { date: "2026-11-01", description: "Real event", lead_person: "Alex" });
  ok("real event created", r.status === 201, `got ${r.status}`);
  r = await req("GET", "/api/members");
  const beforeCount = r.json?.length ?? 0;
  r = await req("POST", "/api/admin/sample-legislators");
  ok("sample load -> 200", r.status === 200, `got ${r.status}`);
  ok("legislators loaded", r.json?.legislators?.loaded === fileLegs.length, `got ${r.json?.legislators?.loaded}`);
  ok("content loaded", r.json?.content?.loaded === true, `got ${JSON.stringify(r.json?.content)}`);
  r = await req("POST", "/api/admin/sample-legislators");
  ok("sample reload is idempotent", r.json?.legislators?.skipped === true && r.json?.content?.skipped === true, `got ${JSON.stringify(r.json)}`);
  // every page has demo data
  r = await req("GET", "/api/interactions");
  ok("sample interactions present", r.json?.length >= 10, `got ${r.json?.length}`);
  r = await req("GET", "/api/events");
  ok("sample events present", r.json?.length >= 5, `got ${r.json?.length}`);
  r = await req("GET", "/api/projects");
  ok("sample project groups present", Array.isArray(r.json) && r.json.length >= 3, `got ${r.json?.length}`);
  ok("sample tasks present", (r.json || []).reduce((a, g) => a + (g.tasks || []).length, 0) >= 7, "task count");
  r = await req("GET", "/api/staff");
  ok("sample staff present", r.json?.length >= 4, `got ${r.json?.length}`);
  r = await req("GET", "/api/documents");
  ok("sample documents present", r.json?.length >= 3, `got ${r.json?.length}`);
  r = await req("GET", "/api/members");
  ok("member list includes samples", r.json?.length === beforeCount + fileLegs.length, `got ${r.json?.length}`);
  r = await req("GET", "/api/admin/sample-legislators");
  ok("sample set reports full after load", r.json?.full === true, `got ${JSON.stringify(r.json)}`);
  // partial load: drop one section's samples -> set is not full, retry refills
  // only the missing section without duplicating anything
  db.prepare("DELETE FROM events WHERE is_sample = 1").run();
  db.prepare("DELETE FROM documents WHERE is_sample = 1").run();
  r = await req("GET", "/api/admin/sample-legislators");
  ok("partial load reports full=false", r.json?.full === false, `got ${JSON.stringify(r.json)}`);
  r = await req("POST", "/api/admin/sample-legislators");
  ok("retry after partial load -> 200", r.status === 200, `got ${r.status}`);
  ok("retry reports content loaded (not skipped)", r.json?.content?.loaded === true, `got ${JSON.stringify(r.json?.content)}`);
  r = await req("GET", "/api/events");
  ok("missing sample events refilled", r.json?.length >= 5, `got ${r.json?.length}`);
  r = await req("GET", "/api/documents");
  ok("missing sample documents refilled", r.json?.length >= 3, `got ${r.json?.length}`);
  r = await req("GET", "/api/members");
  ok("retry did not duplicate legislators", r.json?.length === beforeCount + fileLegs.length, `got ${r.json?.length}`);
  r = await req("GET", "/api/interactions");
  ok("retry did not duplicate interactions", r.json?.length >= 10 && r.json?.length <= 20, `got ${r.json?.length}`);
  r = await req("GET", "/api/admin/sample-legislators");
  ok("sample set full again after retry", r.json?.full === true, `got ${JSON.stringify(r.json)}`);
  // purge removes everything sample, files included
  r = await req("GET", "/api/documents");
  const sampleDoc = r.json?.find((d) => d.orig_name?.includes("SAMPLE") || d.orig_name?.includes("Sample"));
  r = await req("DELETE", "/api/admin/sample-legislators");
  ok("sample purge -> 200", r.status === 200, `got ${r.status}`);
  ok("purge deleted legislators", r.json?.legislators?.deleted === fileLegs.length, `got ${r.json?.legislators?.deleted}`);
  r = await req("GET", "/api/admin/sample-legislators");
  ok("sample count back to 0", r.json?.count === 0 && r.json?.content === false, `got ${JSON.stringify(r.json)}`);
  ok("sample set not full after purge", r.json?.full === false, `got ${JSON.stringify(r.json)}`);
  r = await req("GET", "/api/interactions");
  ok("sample interactions purged", (r.json || []).length === 0, `got ${r.json?.length}`);
  r = await req("GET", "/api/events");
  ok("only real event remains", r.json?.length === 1 && r.json[0]?.description === "Real event", `got ${JSON.stringify(r.json)}`);
  r = await req("GET", "/api/members");
  ok("real member survives purge", r.json?.some((m) => m.last_name === "Person"), `got ${r.json?.length} members`);
}

console.log("update asset picker (auto-update)");
{
  const A = (name) => ({ name, browser_download_url: `https://x/${name}` });
  ok("prefers conventional setup.exe name",
    pickUpdateAsset([A("VilanoCRM-Setup.8.exe"), A("VilanoCRM-Setup.exe")])?.name === "VilanoCRM-Setup.exe");
  ok("falls back to a renamed .exe upload",
    pickUpdateAsset([A("VilanoCRM-Setup.8.exe")])?.name === "VilanoCRM-Setup.8.exe");
  ok("renamed upload is found case-insensitively",
    pickUpdateAsset([A("vilanocrm-setup-378.EXE")])?.name === "vilanocrm-setup-378.EXE");
  ok("ignores non-exe assets", pickUpdateAsset([A("notes.txt"), A("checksums.sha256")]) === null);
  ok("empty asset list -> null", pickUpdateAsset([]) === null);
  ok("missing asset list -> null", pickUpdateAsset(undefined) === null);
}

console.log("seeded dev path (SEED=1): demo user + fictional data");
{
  const dir2 = mkdtempSync(path.join(tmpdir(), "vilano-smoke-seed-"));
  const db2 = openDb(path.join(dir2, "test.db"));
  bootstrapFreshDb(db2, { seed: true });
  const app2 = createApp(db2, { uploadsDir: path.join(dir2, "uploads") });
  const server2 = await new Promise((resolve) => {
    const s2 = app2.listen(0, "127.0.0.1", () => resolve(s2));
  });
  const base2 = `http://127.0.0.1:${server2.address().port}`;
  const demoAvail = await (await fetch(base2 + "/api/demo-available")).json();
  ok("seeded: demo account exists -> {demo:true}", demoAvail.demo === true, JSON.stringify(demoAvail));
  const lr = await fetch(base2 + "/api/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "demo@vilano.local", password: "changeme" }),
  });
  ok("seeded: demo login works", lr.status === 200, `got ${lr.status}`);
  const demoCookie = (lr.headers.get("set-cookie") || "").match(/vs_session=([^;]*)/)?.[1] || "";
  const members = await (await fetch(base2 + "/api/members", { headers: { Cookie: `vs_session=${demoCookie}` } })).json();
  ok("seeded: fictional members present", Array.isArray(members) && members.length === 6, `got ${members?.length}`);
  const setupPage = await fetch(base2 + "/setup", { redirect: "manual" });
  ok("seeded: /setup redirects away when users exist", setupPage.status === 302, `got ${setupPage.status}`);
  server2.close();
  db2.close();
}


console.log("bugfix: login timing oracle + rate limiting");
{
  const t0 = Date.now();
  let r = await req("POST", "/api/login", { email: "nobody-xyz-123@example.com", password: "wrongpassword" }, { auth: false });
  const dt = Date.now() - t0;
  ok("unknown email -> 401", r.status === 401, `got ${r.status}`);
  ok("unknown-email login still runs scrypt (>=10ms)", dt >= 10, `got ${dt}ms`);

  // NOTE: ordering-sensitive — the successful logins above reset the per-IP
  // counter, so these consecutive failures trip the 10-per-15min limit.
  const statuses = [];
  for (let i = 0; i < 12 && !statuses.includes(429); i++) {
    r = await req("POST", "/api/login", { email: "ratelimit@example.com", password: "nope" }, { auth: false });
    statuses.push(r.status);
  }
  ok("login rate limit trips -> 429", statuses[statuses.length - 1] === 429 && statuses.filter(s => s === 401).length >= 8, JSON.stringify(statuses));
}

console.log("logout");
{
  const r = await req("POST", "/api/logout");
  ok("logout -> 200", r.status === 200, `got ${r.status}`);
  const me = await req("GET", "/api/me");
  ok("after logout /api/me -> 401", me.status === 401, `got ${me.status}`);
}

server.close();
db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
