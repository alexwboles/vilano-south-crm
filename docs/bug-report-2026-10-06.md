# Vilano South GR CRM — End-to-End Bug Hunt Report
**Date:** 2026-10-06 · **Build tested:** 3.7.3 (with staffer support, one-pager nav, committee view, entry-streamlining batch)
**Method:** Live server (Node 24 + Express + node:sqlite) on a scratch seeded DB — the real `data/` was never touched. 130 API assertions via HTTP (auth, CRUD, validation, security), plus 8 headless-Chromium UI suites via CDP against the live server's real data (file:// + fetch stub; Chromium hard-blocks localhost, so UI flows ran stubbed while every server behavior was verified over real HTTP). Zero fixes applied — find-and-report only.

## Totals
| Severity | Count | Fixed |
|---|---|---|
| Critical (data loss / auth bypass / crash / corruption) | **0** | — |
| Major (feature broken or wrong data) | **4** | **4** |
| Minor (cosmetic / edge / UX papercut) | **9** | **9** |

**All 13 fixed and verified 2026-10-06.** Smoke suite: 165/165 (134 original + 31 new regression assertions). UI fixes verified via headless-Chromium CDP against the fixed build.

---

## Major bugs

### M1. Double-submit creates duplicate records — ✅ FIXED
**Fix:** new `guard(btn, fn)` helper in `public/app.js` disables the save button while its async request is in flight and re-enables it on failure. Applied to every save button: Log interaction, Log another, Add/Edit Event, New/Rename project group, Add/Edit task, Add/Edit staffer, Assign staffer, End assignment, outcome "New task"/"New event" forms, and all Settings saves (allowlist add, user create, password change/reset).
**Verified:** CDP double-click on "Log interaction" with a delayed POST fires exactly one request; button is `disabled` while in flight. (`.btn:disabled` styling already existed.)

### M2. "Log follow-up" silently drops the staffer — ✅ FIXED
**Fix:** the follow-up prefill now passes the staffer's name/title (`staff_first_name/last_name/title`), and the "(former)" fallback in `openInteractionPanel` was generalized to cover edit, follow-up prefill, and "Log another" (new `lookupStaffer()` helper searches all members' current + former staff lists when names aren't in the prefill). The staffer is never silently dropped.
**Verified:** CDP follow-up prefill with a non-current staffer keeps them selected with the "(former)" tag.

### M3. Deleting a member cascade-deletes history — ✅ FIXED
**Fix:** `DELETE /api/members/:id` now returns 400 ("Cannot delete: this member has interactions or staff assignments on record.") when interactions or staff assignments reference the member — the same rule as staffer delete. History stays intact.
**Verified:** smoke tests — 400 with interactions, 400 with staff assignment, assignment history preserved after blocked delete, 200 for unreferenced member, 404 for missing.

### M4. No member edit/delete UI — ✅ FIXED
**Fix:** new "Members of Congress" card in Settings listing all members (label + chamber badge) with Edit and Delete actions. Edit opens a panel (name, chamber, party, state, district with house/senate toggle, comma-separated committees) wired to the existing `PUT /api/members/:id`; Delete uses the confirm dialog and surfaces the new block-rule message on failure.
**Verified:** CDP — settings lists members with Edit/Delete, edit panel prefills and saves (list refreshes), blocked delete shows the plain-English error toast.

---

## Major bugs

### M1. Double-submit creates duplicate records — no submit guard on any save button
**Where:** Log Interaction panel, Add/Edit Event, Add/Edit Task, New Project Group, Add/Edit Staffer, outcome "New task"/"New event" forms.
**Repro:**
1. Open the log panel, fill a valid interaction, double-click "Log interaction" quickly (or press Enter twice).
2. Two identical interactions appear in the log.
**Verified live:** two near-simultaneous `POST /api/interactions` → both `201`, rows 13 → 15 (dupes cleaned up after).
**Expected:** first submit disables the button (or otherwise guards) until the request resolves.
**Actual:** every save handler (`doSave`, `#e-save`, `#t-save`, `#g-save`, `#st-save`, `#oc-create`) fires unguarded; nothing is idempotent server-side either.

### M2. "Log follow-up" silently drops the staffer when the staffer isn't the member's current staff
**Where:** Interaction detail → "Log follow-up".
**Repro:**
1. Open an interaction whose staffer is *not* currently assigned to that member (e.g. a former staffer, or a staffer never assigned).
2. Click "Log follow-up" → the Staffer dropdown shows "None" (the staffer isn't in the member's current-staff options).
3. Save → the follow-up is created with `staff_id: null`. The staffer is gone with no warning.
**Expected:** like the *edit* flow (which adds a "(former)" option for the current staffer), the follow-up prefill should keep the parent's staffer selectable.
**Actual:** `syncPanelChamber()` only lists the member's current staff; prefill has no fallback. (When the staffer *is* current staff, prefill works correctly — member, staffer, and type all carry over.)

### M3. Deleting a member cascade-deletes interactions AND staff assignment history
**Where:** `DELETE /api/members/:id` (no UI delete exists — API only).
**Repro (API):**
1. Create member → assign staffer → log interaction with that staffer.
2. `DELETE /api/members/:id` → 200.
3. The member's interactions are gone (cascade) and the staffer's assignment history for that member is gone too (`GET /api/staff/:id` shows zero assignments, zero interactions).
**Expected:** per the project's "history is kept" principle (assignments are ended, never deleted), deleting a member should at minimum be blocked while history references it — like staffer delete is.
**Actual:** `ON DELETE CASCADE` wipes interactions, `member_committees`, and `staff_assignments` silently.

### M4. No member edit/delete UI exists at all
**Where:** entire app.
**Repro:** look for any way to fix a typo'd member name, change a party/chamber, or remove a member. There is none — members can only be *added* via the log panel's inline "+ New member" form.
**Expected:** a members management surface (or at least edit/delete on member detail), consistent with staff/events/projects/documents all having full CRUD in the UI.
**Actual:** corrections and removals require direct API access.

---

## Minor bugs

### m1. Nonexistent calendar dates accepted — ✅ FIXED
**Fix:** `validDate()` in `server.js` now validates real calendar dates (components must round-trip through `Date`), rejecting `2026-02-30` etc. Applies to interactions, events, task due dates, and assignment start/end dates.
**Verified:** smoke — `2026-02-30` → 400 on interactions/events/assignments; real leap day `2024-02-29` → 201.

### m2. Follow-up cycles possible — ✅ FIXED
**Fix:** new `parentChainHits()` walks the follow-up parent chain on create/update and rejects with 400 ("That would create a follow-up cycle.") if the new parent would close a loop. Self-parent was already blocked; the walk is guarded against pre-existing loops.
**Verified:** smoke — 2-cycle and 3-cycle → 400; acyclic reparent → 200.

### m3. Assignment end date before start date accepted — ✅ FIXED
**Fix:** `POST /api/assignments/:id/end` rejects `ended_on < started_on` with 400.
**Verified:** smoke — end-before-start → 400; end-equal-to-start → 200.

### m4. Self password change doesn't invalidate other sessions — ✅ FIXED
**Fix:** `POST /api/admin/password` now deletes all of the user's sessions except the current one (admin reset still kills all, including current).
**Verified:** smoke — second session → 401 after change, current session → 200, password restored afterward. Settings toast now notes other sessions are signed out.

### m5. No `hashchange` listener — ✅ FIXED
**Fix:** `window.addEventListener("hashchange", …)` in `public/app.js` switches views for in-app `#view` links (no-ops when the hash already matches; `replaceState` in `go()` doesn't re-trigger it, so no loops).
**Verified:** CDP — setting `location.hash` to `#events`/`#staff` switches views without reload.

### m6. No rate limiting on `/api/login` — ✅ FIXED
**Fix:** in-memory rate limit — 10 attempts per 15 minutes per IP, 429 with `Retry-After` beyond that; a successful login resets the counter.
**Verified:** smoke — 11th consecutive failure → 429 (test notes its ordering dependency on the success-reset).

### m7. Login timing oracle — ✅ FIXED
**Fix:** the login handler always runs the scrypt comparison — against a startup-generated dummy salt/hash for unknown emails — so failure time no longer reveals whether an email is registered. Same 401 shape as before.
**Verified:** smoke — unknown-email login takes ≥10ms (scrypt time) instead of failing fast.

### m8. `LIKE` wildcards not escaped in search — ✅ FIXED
**Fix:** new `escapeLike()` escapes `\`, `%`, `_` in user search input; both LIKE query sites (interactions, staff) now use `ESCAPE '\'`.
**Verified:** smoke — `q=%` matches only literal-`%` rows, `q=_` matches only literal-`_` rows.

### m9. Duplicate committee names allowed per member — ✅ FIXED
**Fix:** new `dedupeCommittees()` (case-insensitive, trimmed) applied on member create and update.
**Verified:** smoke — `["Appropriations", " appropriations ", "APPROPRIATIONS", "Finance", ""]` stores 2; PUT with `["Finance", "finance"]` stores 1.

---

## Tested and clean
- **Auth:** every `/api/*` route → 401 unauthenticated; `/one-pager`, `/index.html`, `/app.js`, `/one-pager.js` redirect to login; `/health`, `/login.html`, icons, manifest, CSS public by design. Wrong password / unknown email / allowlisted-but-no-user all → identical 401 shape. Cookie is `HttpOnly` + `SameSite=Lax`. Logout deletes the session server-side (old token → 401). Forged tokens rejected.
- **XSS:** `<script>` / `<img onerror>` payloads in interaction summaries, member names, staffer notes, event descriptions, document filenames, committee names (including quotes) — all rendered escaped; zero raw tags or `<img>` elements in table, detail, staff, events, documents views.
- **SQLi:** `' OR 1=1 --` in search boxes, IDs, and staff query → parameterized, returns nothing / 404.
- **Documents:** `../../evil.txt` → stored as `evil.txt`; 200-char names truncated to 100; `test.pdf.exe` kept but always served as `attachment` + `application/octet-stream`; invalid base64 and empty files → 400; 26 MB → 413; download returns exact bytes; delete removes file and row; missing download → 404.
- **Validation (all 400 correctly):** member chamber/party/state/district/name; interaction summary/date/status/type/staff/parent; staff name/email; assignment member/date/duplicate-current; event fields; task title + 300-char/2-sentence note rule (live counter in UI); group name; allowlist email; weak/duplicate/non-allowlisted users; self-delete blocked; allowlist removal blocked while a user exists.
- **Staff lifecycle:** multi-boss assignments, duplicate-current blocked, re-assign after end, end-keeps-history shown as Former, delete blocked with message when referenced, staffer detail (contact, assignments, interaction history), member detail staff section (current + former), directory search + filter-by-member.
- **Follow-ups:** chain create, follow-ups endpoint, "Follow-up to" parent link, lazy follow-ups list, optional mark-previous-Done (unchecked by default), type/member/staffer prefill (when staffer is current staff).
- **Outcomes:** Done reveals "New task" (group dropdown, title prefilled from next step) and "New event" (date defaults +7 days, lead-person field); created records verified.
- **Entry streamlining:** template chips (type + starter, toggle-off, no overwrite of typed text), next-step suggestion chips (fill then `; `-append), smart defaults (today, recent-5 members first, "Log another" keeps member+type), `L` shortcut (opens from body, ignored in inputs/textareas/selects, doesn't stack), quick-log FAB (full-width panel on mobile).
- **Committee view:** chips are real keyboard-accessible buttons everywhere; correct members listed; member expand shows staff; hash reflects view; back button returns; quoted/HTML-ish names round-trip correctly.
- **One-pager:** sidebar nav (desktop) / top bar (mobile) with One-Pager active; `/#view` links; all four quads render live data incl. `via` lines; empty states per quad; print CSS hides nav; **CDP `printToPDF` (landscape) = exactly 1 page.**
- **Settings:** all three cards render; allowlist add/remove; user create → login works; admin reset → old sessions invalidated, new password works; deleted user → 401; cannot remove own account.
- **Empty states (fresh `SEED=0` DB):** guided empty states + working CTAs on interactions, events, projects, documents, staff, and all one-pager quads.
- **Mobile 390px:** no horizontal scroll on interaction log, full-width log panel, staff directory, staffer detail, committee view, one-pager; 44px+ touch targets preserved.
- **Filters:** search, chamber, status, from/to, Clear — all correct, including filtered-to-zero guided state.
- **Login page:** branded, demo-credential note, error state on failure.
- **Stability:** zero JS exceptions across all UI suites; `npm test` 134/134 green after testing.

## Design observations (not bugs)
- Flat trust model: every authenticated user can manage the allowlist, users, and passwords (no roles). Fine if intentional for a 2-person operation.
- No CSRF tokens; `SameSite=Lax` + JSON-only POSTs mitigate.
- Phone dictation requires a secure context (works on localhost; needs HTTPS for LAN phones) — already known.
- Session TTL 7 days, lazy expiry cleanup — code-inspected, fine.

## Could not test
- **Real login UI flow against the live server:** bundled Chromium hard-blocks localhost *and* LAN IPs, so the browser never reaches the server. Mitigated: login page rendering + error states via file://, and the full login/session lifecycle via HTTP (all green).
- **`Vilano CRM.bat`:** can't execute batch on Linux (already caveated; out of scope).
- **Actual phone-on-Wi-Fi access and "Add to Home screen":** no phone on the test network.
- **7-day session expiry:** would require waiting; code path inspected (expired tokens are deleted on next request).
- **Windows rendering of the `.ico` / desktop shortcut.**

## Test artifacts
- API harness: `/tmp/bughunt/api.mjs` (130 assertions, all passing)
- UI suites: `/tmp/bughunt/ui{2,3,4,5,6,7,8}.mjs` + live-data stubs `/tmp/bughunt/ui-app/stub.js`, `/tmp/bughunt/ui-app/stub-empty.js`
- Screenshots: `/tmp/bughunt/shots/` (xss-detail, panel, outcomes, documents, staff-detail, onepager, mobile 390px set, login, empty-staff, onepager.pdf)
- Scratch DBs/servers used `/tmp/vtest` and `/tmp/vtest0`; the real `~/workspace/vilano-south-crm/data/` was never touched (verified).
