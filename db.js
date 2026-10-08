// Data layer: schema, password hashing (scrypt, no native deps), fictional seed data.
// Uses node:sqlite (Node 22+). All queries are parameterized.

import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";

export function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  return db;
}

export function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);

    CREATE TABLE IF NOT EXISTS allowed_emails (
      email TEXT PRIMARY KEY,
      added_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      pw_salt TEXT NOT NULL,
      pw_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chamber TEXT NOT NULL CHECK (chamber IN ('house','senate')),
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      party TEXT NOT NULL CHECK (party IN ('R','D','I')),
      state TEXT NOT NULL,
      district INTEGER,
      is_sample INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS member_committees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      name TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS interactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      summary TEXT NOT NULL,
      next_step TEXT,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','done')),
      interaction_type TEXT,
      parent_id INTEGER REFERENCES interactions(id) ON DELETE SET NULL,
      is_sample INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      description TEXT NOT NULL,
      lead_person TEXT NOT NULL,
      is_sample INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS project_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      is_sample INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL REFERENCES project_groups(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      owner TEXT NOT NULL DEFAULT '',
      due_date TEXT,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','done')),
      note TEXT NOT NULL DEFAULT '',
      position INTEGER NOT NULL DEFAULT 0,
      is_sample INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stored_name TEXT NOT NULL,
      orig_name TEXT NOT NULL,
      size INTEGER NOT NULL,
      uploaded_by TEXT NOT NULL,
      uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
      is_sample INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS staff (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      is_sample INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS staff_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      staff_id INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
      member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      started_on TEXT NOT NULL,
      ended_on TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_staff_assign_current
      ON staff_assignments (staff_id, member_id) WHERE ended_on IS NULL;
  `);
  // Migrations for databases created before these columns/tables existed.
  try { db.exec("ALTER TABLE project_groups ADD COLUMN show_on_pager INTEGER NOT NULL DEFAULT 1"); }
  catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
  try { db.exec("ALTER TABLE interactions ADD COLUMN staff_id INTEGER REFERENCES staff(id) ON DELETE SET NULL"); }
  catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
  try { db.exec("ALTER TABLE interactions ADD COLUMN interaction_type TEXT"); }
  catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
  try { db.exec("ALTER TABLE interactions ADD COLUMN parent_id INTEGER REFERENCES interactions(id) ON DELETE SET NULL"); }
  catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
  try { db.exec("ALTER TABLE members ADD COLUMN is_sample INTEGER NOT NULL DEFAULT 0"); }
  catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
  for (const t of ["interactions", "events", "project_groups", "tasks", "staff", "documents"]) {
    try { db.exec(`ALTER TABLE ${t} ADD COLUMN is_sample INTEGER NOT NULL DEFAULT 0`); }
    catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
  }
}

// ---- passwords (scrypt, constant-time compare; passwords are never logged) ----
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}

export function verifyPassword(password, salt, hash) {
  const derived = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

export function isInitialized(db) {
  const row = db.prepare("SELECT v FROM meta WHERE k = 'initialized'").get();
  return !!row;
}

function markInitialized(db) {
  db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('initialized','1')").run();
}

// ---- allowlist + users ----
export function allowEmail(db, email) {
  const e = String(email).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new Error("invalid-email");
  db.prepare("INSERT OR IGNORE INTO allowed_emails (email) VALUES (?)").run(e);
  return e;
}

export function isAllowed(db, email) {
  const e = String(email).trim().toLowerCase();
  return !!db.prepare("SELECT 1 FROM allowed_emails WHERE email = ?").get(e);
}

export function createUser(db, email, password) {
  const e = String(email).trim().toLowerCase();
  if (!isAllowed(db, e)) throw new Error("not-allowlisted");
  if (typeof password !== "string" || password.length < 8) throw new Error("weak-password");
  const { salt, hash } = hashPassword(password);
  try {
    const r = db.prepare("INSERT INTO users (email, pw_salt, pw_hash) VALUES (?,?,?)").run(e, salt, hash);
    return Number(r.lastInsertRowid);
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) throw new Error("exists");
    throw err;
  }
}

export function findUserByEmail(db, email) {
  return db.prepare("SELECT * FROM users WHERE email = ?").get(String(email).trim().toLowerCase()) || null;
}

export function userCount(db) {
  return db.prepare("SELECT COUNT(*) c FROM users").get().c;
}

export function setUserPassword(db, userId, password) {
  if (typeof password !== "string" || password.length < 8) throw new Error("weak-password");
  const { salt, hash } = hashPassword(password);
  db.prepare("UPDATE users SET pw_salt = ?, pw_hash = ? WHERE id = ?").run(salt, hash, userId);
}

// ---- demo bootstrap (clearly labeled; runs only on a fresh DB) ----
export const DEMO_EMAIL = "demo@vilano.local";
export const DEMO_PASSWORD = "changeme";

export function ensureDemoUser(db) {
  allowEmail(db, DEMO_EMAIL);
  if (!findUserByEmail(db, DEMO_EMAIL)) {
    createUser(db, DEMO_EMAIL, DEMO_PASSWORD);
  }
}

// ---- fictional seed data (DEMO ONLY — all members invented per the design guide) ----
export function seedDemo(db) {
  const addMember = db.prepare(
    "INSERT INTO members (chamber, first_name, last_name, party, state, district) VALUES (?,?,?,?,?,?)"
  );
  const addCommittee = db.prepare("INSERT INTO member_committees (member_id, name) VALUES (?,?)");
  const addInteraction = db.prepare(
    "INSERT INTO interactions (member_id, date, summary, next_step, status, interaction_type) VALUES (?,?,?,?,?,?)"
  );

  const members = [
    { chamber: "house", first_name: "Andrew", last_name: "Smith", party: "R", state: "FL", district: 12,
      committees: ["Appropriations", "Veterans' Affairs"] },
    { chamber: "senate", first_name: "Laura", last_name: "Richards", party: "R", state: "FL", district: null,
      committees: ["Appropriations"] },
    { chamber: "house", first_name: "Daniel", last_name: "Todd", party: "D", state: "FL", district: 9,
      committees: ["Education and Workforce"] },
    { chamber: "senate", first_name: "Marcus", last_name: "Webb", party: "D", state: "VA", district: null,
      committees: ["Commerce, Science, and Transportation"] },
    { chamber: "house", first_name: "Priya", last_name: "Nair", party: "D", state: "CA", district: 32,
      committees: ["Energy and Commerce"] },
    { chamber: "house", first_name: "Thomas", last_name: "Calloway", party: "R", state: "TX", district: 21,
      committees: ["Armed Services"] },
  ];
  const ids = [];
  for (const m of members) {
    const r = addMember.run(m.chamber, m.first_name, m.last_name, m.party, m.state, m.district);
    const id = Number(r.lastInsertRowid);
    ids.push(id);
    for (const c of m.committees) addCommittee.run(id, c);
  }
  const [smith, richards, todd, webb, nair, calloway] = ids;

  const interactions = [
    [smith, "2026-09-28", "Tyler met with the Congressman and urged him to call Appropriations about adding the exemption language.", "Send over the exemption language files we discussed.", "in_progress", "Meeting"],
    [richards, "2026-09-30", "Emailed the Senator's team asking for bill language; Tyler replied with our draft language.", "Wait for their markup, then schedule follow-up call.", "open", "Email"],
    [todd, "2026-09-24", "Zoom introduction with Rep. Todd's education staffer. Walked through workforce program outcomes.", "Send one-pager on program outcomes.", "done", "Call"],
    [smith, "2026-09-15", "Staff-level meeting on veterans' workforce funding. Positive reception to the proposal outline.", "Draft formal request letter.", "done", "Meeting"],
    [webb, "2026-09-18", "Brief hallway conversation after Commerce hearing. Senator asked for a short briefing memo.", "Send two-page briefing memo.", "open", "Hallway touch"],
    [nair, "2026-09-10", "Met with energy staffer about campus efficiency grants. Asked for project list.", "Compile campus project list.", "in_progress", "Meeting"],
    [calloway, "2026-08-27", "Introductory meeting with Armed Services staffer. Discussed veteran hiring pipeline.", "Invite staffer to campus visit.", "done", "Meeting"],
    [richards, "2026-08-20", "Phone call with legislative director on appropriations timeline for next cycle.", "Confirm timeline in writing.", "done", "Call"],
  ];
  const ixIds = [];
  for (const [mid, date, summary, next, status, type] of interactions) {
    ixIds.push(Number(addInteraction.run(mid, date, summary, next, status, type).lastInsertRowid));
  }

  // Staff (aides/assistants): individuals, assignable to multiple members, history kept.
  const addStaff = db.prepare(
    "INSERT INTO staff (first_name, last_name, title, email, phone, notes) VALUES (?,?,?,?,?,?)"
  );
  const addAssign = db.prepare(
    "INSERT INTO staff_assignments (staff_id, member_id, started_on, ended_on) VALUES (?,?,?,?)"
  );
  const emily = Number(addStaff.run("Emily", "Carter", "Legislative Director",
    "emily.carter@example.gov", "202-555-0142", "Lead on appropriations requests.").lastInsertRowid);
  const james = Number(addStaff.run("James", "Park", "Scheduler",
    "james.park@example.gov", "202-555-0119", "").lastInsertRowid);
  const rachel = Number(addStaff.run("Rachel", "Kim", "Staff Assistant",
    "", "", "Moved from Rep. Smith's office to Rep. Nair's in May.").lastInsertRowid);
  addAssign.run(emily, smith, "2025-03-10", null);
  addAssign.run(james, richards, "2025-08-01", null);
  addAssign.run(james, todd, "2026-01-12", null); // multi-boss: serves two members
  addAssign.run(rachel, smith, "2024-06-01", "2026-05-15"); // former assignment: history kept
  addAssign.run(rachel, nair, "2026-05-16", null);

  // Attach staffers to two seeded interactions (interactions stay tied to a member).
  const setIxStaff = db.prepare("UPDATE interactions SET staff_id = ? WHERE id = ?");
  setIxStaff.run(emily, ixIds[0]); // Smith 9/28 meeting — via Emily Carter
  setIxStaff.run(james, ixIds[1]); // Richards 9/30 email thread — via James Park

  const addEvent = db.prepare("INSERT INTO events (date, description, lead_person) VALUES (?,?,?)");
  addEvent.run("2026-12-02", "Fundraiser, Rep. Smith — downtown venue", "T. Boles");
  addEvent.run("2026-10-14", "Zoom meeting, Rep. Todd — workforce programs", "T. Boles");
  addEvent.run("2026-11-05", "Campus visit, Sen. Richards staff", "J. Doe");

  const addGroup = db.prepare("INSERT INTO project_groups (name, position) VALUES (?,?)");
  const addTask = db.prepare(
    "INSERT INTO tasks (group_id, title, owner, due_date, status, note, position) VALUES (?,?,?,?,?,?,?)"
  );
  const g1 = Number(addGroup.run("Appropriations exemption language", 0).lastInsertRowid);
  const g2 = Number(addGroup.run("Campus visit planning", 1).lastInsertRowid);
  addTask.run(g1, "Finalize exemption language draft", "T. Boles", "2026-10-16", "in_progress",
    "Draft is with counsel for review. Expect comments back by Thursday.", 0);
  addTask.run(g1, "Send files to Rep. Smith's office", "T. Boles", "2026-10-09", "open",
    "Waiting on final draft before sending.", 1);
  addTask.run(g2, "Confirm date with Sen. Richards staff", "J. Doe", "2026-10-20", "open",
    "Two date options proposed. Awaiting their pick.", 0);
  addTask.run(g2, "Prepare campus tour route", "J. Doe", "2026-10-28", "open", "", 1);
}

// Demo bootstrap: runs ONLY when explicitly seeded (SEED=1 dev path).
// Installed copies (SEED=0) get an empty users table and the /setup wizard.
export function bootstrapFreshDb(db, { seed = false } = {}) {
  initSchema(db);
  if (isInitialized(db)) return;
  if (seed) {
    ensureDemoUser(db);
    seedDemo(db);
  }
  markInitialized(db);
}

// ---- sample legislator roster (real public data, for demos/meetings) ----
// Loaded on demand via the Settings page and purged the same way. Sample rows
// are flagged is_sample=1 so real records are never touched by the purge.
export function sampleLegislatorCount(db) {
  return db.prepare("SELECT COUNT(*) c FROM members WHERE is_sample = 1").get().c;
}

export function loadSampleLegislators(db, legislators) {
  if (sampleLegislatorCount(db) > 0) return { loaded: 0, skipped: true };
  const add = db.prepare(
    "INSERT INTO members (chamber, first_name, last_name, party, state, district, is_sample) VALUES (?,?,?,?,?,?,1)"
  );
  const addComm = db.prepare(
    "INSERT INTO member_committees (member_id, name) VALUES (?,?)"
  );
  let loaded = 0;
  db.exec("BEGIN");
  try {
    for (const m of legislators) {
      if (!m.first_name || !m.last_name) continue;
      if (m.chamber !== "house" && m.chamber !== "senate") continue;
      if (!["R", "D", "I"].includes(m.party)) continue;
      const r = add.run(m.chamber, m.first_name, m.last_name, m.party, m.state || "", m.district ?? null);
      for (const c of m.committees || []) {
        if (c) addComm.run(Number(r.lastInsertRowid), c);
      }
      loaded++;
    }
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    throw e;
  }
  return { loaded, skipped: false };
}

export function purgeSampleLegislators(db) {
  // ON DELETE CASCADE clears committees/interactions tied to these members.
  const r = db.prepare("DELETE FROM members WHERE is_sample = 1").run();
  return { deleted: Number(r.changes) };
}
