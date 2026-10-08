// Sample demo content for meetings: interactions, events, project groups/tasks,
// staff (+assignments), and documents. Every row is flagged is_sample=1 so the
// purge removes exactly this content and never touches real records.
// Requires the sample legislator roster to be loaded first (references members).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

function findMember(db, lastName, state) {
  return db
    .prepare("SELECT id FROM members WHERE last_name = ? AND state = ? AND is_sample = 1 LIMIT 1")
    .get(lastName, state)?.id;
}

export function sampleContentLoaded(db) {
  const t = ["interactions", "events", "project_groups", "tasks", "staff", "documents"];
  return t.some((tbl) => db.prepare(`SELECT COUNT(*) c FROM ${tbl} WHERE is_sample = 1`).get().c > 0);
}

// The sample set is "complete" when every section reached its expected size.
// A partial load (e.g. interrupted request) is NOT complete, so a retry stays
// allowed and fills only the missing sections instead of forcing delete+reload.
export function sampleContentComplete(db) {
  const need = { interactions: 10, events: 5, project_groups: 3, tasks: 7, staff: 4, documents: 3 };
  return Object.entries(need).every(
    ([tbl, n]) => db.prepare(`SELECT COUNT(*) c FROM ${tbl} WHERE is_sample = 1`).get().c >= n
  );
}

export function loadSampleContent(db, uploadsDir) {
  const have = (tbl) => db.prepare(`SELECT COUNT(*) c FROM ${tbl} WHERE is_sample = 1`).get().c > 0;
  // Resumable: each section loads independently, so a retry after a partial
  // load completes the missing sections instead of skipping everything.
  const need = {
    interactions: !have("interactions"),
    events: !have("events"),
    projects: !have("project_groups"), // tasks ride along with their groups
    staff: !have("staff"),
    documents: !have("documents"),
  };
  if (!Object.values(need).some(Boolean)) return { loaded: false, skipped: true };

  const addInteraction = db.prepare(
    "INSERT INTO interactions (member_id, date, summary, next_step, status, interaction_type, is_sample) VALUES (?,?,?,?,?,?,1)"
  );
  const addEvent = db.prepare(
    "INSERT INTO events (date, description, lead_person, is_sample) VALUES (?,?,?,1)"
  );
  const addGroup = db.prepare("INSERT INTO project_groups (name, position, is_sample) VALUES (?,?,1)");
  const addTask = db.prepare(
    "INSERT INTO tasks (group_id, title, owner, due_date, status, note, position, is_sample) VALUES (?,?,?,?,?,?,?,1)"
  );
  const addStaff = db.prepare(
    "INSERT INTO staff (first_name, last_name, title, email, phone, notes, is_sample) VALUES (?,?,?,?,?,?,1)"
  );
  const addAssign = db.prepare(
    "INSERT INTO staff_assignments (staff_id, member_id, started_on, ended_on) VALUES (?,?,?,NULL)"
  );
  const addDoc = db.prepare(
    "INSERT INTO documents (stored_name, orig_name, size, uploaded_by, is_sample) VALUES (?,?,?,?,1)"
  );

  db.exec("BEGIN");
  try {
    if (need.interactions) {
    // ---------- interactions (tied to real sample members) ----------
    const ix = [
      // last, state, date, summary, next_step, status, type
      ["Scott", "FL", "2026-10-06", "Met with Sen. Scott's education LA on workforce development grant priorities for FY27. Strong interest in apprenticeship outcomes.", "Send one-pager on Full Sail graduate outcomes", "in_progress", "meeting"],
      ["Moody", "FL", "2026-10-02", "Call with Sen. Moody's office on veterans education benefits; staff asked about a campus visit this fall.", "Propose two visit dates", "open", "call"],
      ["Dunn", "FL", "2026-09-28", "Rep. Dunn toured the simulation labs; strong interest in defense-adjacent training programs and facility expansion.", "Thank-you note plus program brief", "done", "meeting"],
      ["Bean", "FL", "2026-09-20", "Briefed House Education & Workforce majority staff on career-college accountability metrics and graduation rates.", "Share underlying dataset", "in_progress", "briefing"],
      ["Mills", "FL", "2026-09-15", "Met Rep. Mills at district event; discussed STEM pipeline programs and invited him to the fall showcase.", "Formal showcase invitation", "open", "meeting"],
      ["Thune", "SD", "2026-09-10", "Brief introductory meeting with Majority Leader's floor staff; left overview packet on higher-ed workforce programs.", "Request follow-up with policy team", "open", "meeting"],
      ["Schumer", "NY", "2026-09-08", "Met Minority Leader's education counsel at reception; flagged upcoming reauthorization priorities.", "Send reauthorization memo", "in_progress", "reception"],
      ["Jeffries", "NY", "2026-08-28", "Conversation with Leader Jeffries' district director on Brooklyn youth media programs; possible partnership angle.", "Draft partnership outline", "open", "call"],
      ["Scott", "FL", "2026-08-20", "Follow-up call on FY26 report language; staff confirmed our program was referenced in committee discussion.", "Monitor conference outcome", "done", "call"],
      ["Bean", "FL", "2026-08-12", "Coffee with Rep. Bean's chief of staff; discussed fall legislative calendar and visit scheduling.", "Lock visit date", "done", "meeting"],
      ["Dunn", "FL", "2026-08-05", "Staff-level call on defense workforce provisions; requested technical assistance on bill text.", "Send technical comments", "in_progress", "call"],
      ["Moody", "FL", "2026-07-29", "Introductory meeting with Sen. Moody's state director in Orlando office.", "Add to quarterly update list", "done", "meeting"],
      ["Mills", "FL", "2026-07-22", "Emailed overview of new simulation wing; staff replied with interest in a briefing.", "Schedule briefing", "open", "email"],
      ["Thune", "SD", "2026-07-15", "Dropped off program overview with Senate HELP Committee staff.", "Request staff meeting", "done", "drop-off"],
    ];
    let ixCount = 0;
    for (const [last, state, date, summary, next, status, type] of ix) {
      const mid = findMember(db, last, state);
      if (!mid) continue;
      addInteraction.run(mid, date, summary, next, status, type);
      ixCount++;
    }
    } // need.interactions

    if (need.events) {
    // ---------- events ----------
    const ev = [
      ["2026-10-15", "Campus tour — House Education & Workforce majority staff", "Tyler"],
      ["2026-10-22", "Florida delegation breakfast briefing", "Tyler"],
      ["2026-10-29", "Appropriations staff site visit — simulation wing", "Jordan Ellis"],
      ["2026-11-05", "Workforce development roundtable with regional employers", "Casey Morgan"],
      ["2026-09-30", "Veterans education listening session (completed)", "Tyler"],
    ];
    for (const [date, desc, lead] of ev) addEvent.run(date, desc, lead);
    } // need.events

    if (need.projects) {
    // ---------- projects + tasks ----------
    const g1 = addGroup.run("FY27 Appropriations Requests", 0).lastInsertRowid;
    addTask.run(g1, "Draft program request letters", "Jordan Ellis", "2026-10-18", "done", "Three program areas: simulation, veterans, STEM.", 0);
    addTask.run(g1, "Member meetings — House Appropriations", "Tyler", "2026-11-01", "in_progress", "Target: Dunn, Bean offices first.", 1);
    addTask.run(g1, "Follow up on report language", "Casey Morgan", "2026-11-15", "open", "", 2);
    const g2 = addGroup.run("Campus Visit Program", 1).lastInsertRowid;
    addTask.run(g2, "Schedule fall staff tours", "Riley Chen", "2026-10-20", "in_progress", "Education & Workforce + HELP committee staff.", 0);
    addTask.run(g2, "Prepare briefing packets", "Casey Morgan", "2026-10-25", "open", "Outcomes data, program sheets, bios.", 1);
    const g3 = addGroup.run("Veterans Education Initiative", 2).lastInsertRowid;
    addTask.run(g3, "Compile veteran graduate outcomes", "Jordan Ellis", "2026-11-10", "open", "", 0);
    addTask.run(g3, "Draft coalition support letter", "Tyler", "2026-11-20", "open", "", 1);
    } // need.projects

    if (need.staff) {
    // ---------- staff (fictional, per design guide) + assignments ----------
    const st = [
      ["Jordan", "Ellis", "Director of Government Relations", "jordan.ellis@example.com", "555-014-2201", "Lead on appropriations and member meetings."],
      ["Casey", "Morgan", "Legislative Analyst", "casey.morgan@example.com", "555-014-2202", "Policy research and briefing materials."],
      ["Riley", "Chen", "Events Coordinator", "riley.chen@example.com", "555-014-2203", "Campus tours and delegation events."],
      ["Taylor", "Brooks", "Communications Lead", "taylor.brooks@example.com", "555-014-2204", "Press and digital outreach."],
    ];
    const staffIds = st.map((s) => Number(addStaff.run(...s).lastInsertRowid));
    const assign = [["Scott", "FL"], ["Moody", "FL"], ["Dunn", "FL"], ["Bean", "FL"]];
    staffIds.forEach((sid, i) => {
      const [last, state] = assign[i % assign.length];
      const mid = findMember(db, last, state);
      if (mid) addAssign.run(sid, mid, "2026-01-12");
    });
    } // need.staff

    if (need.documents) {
    // ---------- documents (generated text files) ----------
    const docs = [
      ["Campus Tour Agenda — Fall 2026.txt",
       "FULL SAIL UNIVERSITY — CAMPUS TOUR AGENDA (SAMPLE)\n\n9:00  Welcome & overview\n9:30  Simulation wing walkthrough\n10:30 Roundtable: workforce outcomes\n11:15 Wrap-up and next steps\n"],
      ["FY27 Appropriations Request Summary.txt",
       "FY27 APPROPRIATIONS REQUEST — SUMMARY (SAMPLE)\n\nProgram areas: simulation training, veterans education, STEM pipeline.\nRequest: report language + programmatic support.\nContact: Government Relations office.\n"],
      ["Workforce Outcomes One-Pager Draft.txt",
       "WORKFORCE OUTCOMES — DRAFT (SAMPLE)\n\n- Graduate placement rate: sample figure for demo\n- Employer partners: sample list for demo\n- Programs highlighted: simulation, media, tech\n"],
    ];
    fs.mkdirSync(uploadsDir, { recursive: true });
    for (const [orig, body] of docs) {
      const stored = `sample_${crypto.randomBytes(8).toString("hex")}.txt`;
      const full = path.join(uploadsDir, stored);
      if (!full.startsWith(uploadsDir + path.sep)) continue;
      fs.writeFileSync(full, body);
      addDoc.run(stored, orig, Buffer.byteLength(body), "sample-data");
    }
    } // need.documents

    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    throw e;
  }
  return { loaded: true, skipped: false };
}

export function purgeSampleContent(db, uploadsDir) {
  const counts = {};
  // documents: remove files first
  const docs = db.prepare("SELECT stored_name FROM documents WHERE is_sample = 1").all();
  for (const d of docs) {
    const full = path.join(uploadsDir, d.stored_name);
    if (full.startsWith(uploadsDir + path.sep)) { try { fs.unlinkSync(full); } catch {} }
  }
  for (const t of ["documents", "events", "project_groups", "tasks", "staff"]) {
    counts[t] = Number(db.prepare(`DELETE FROM ${t} WHERE is_sample = 1`).run().changes);
  }
  // interactions + member_committees + staff_assignments cascade from members/staff deletes
  return counts;
}
