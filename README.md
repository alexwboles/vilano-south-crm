# Vilano South GR CRM

Bespoke, self-hosted government-relations contact tracker for Full Sail University.
Tracks members of Congress, interactions, events, live projects/tasks, finalized
documents, and an executive one-page summary.
**Highly sensitive — do not publish this repository or expose it publicly.**

Built from brand new per the design guide (`~/workspace/user/files/FS_GR_CRM_Design_0_ilq2.pdf`).
Design references: clean table UIs (interaction-history timeline, Dakota-style shell,
ClickUp-style grouped tasks, Monday-style status pills). No AI features — per the guide,
only what was specified was built.

## What's in it

1. **Auth gate** — email + password sign-in. Only pre-approved (allowlisted) email
   addresses can have accounts. No self-registration. Passwords hashed with scrypt;
   sessions are httpOnly cookies.
2. **Contact Interaction Log** — table of interactions by member of Congress
   (House styled `Rep. Andrew Smith (R-FL-12)`, Senate `Sen. Laura Richards (R-FL)`).
   Manual summary notes, next-step column, committees per member, status pills,
   expandable row detail, filters (search, date range, chamber, status), and a
   "Log interaction" side panel with inline new-member creation.
   - **Interaction types** — optional Meeting / Call / Email / Hallway touch,
     shown as a subtle label on rows and in detail.
   - **Templates** — one-tap type chips drop starter text into the summary;
     next-step suggestion chips fill/append the next-step field.
   - **Follow-up chaining** — "Log follow-up" prefills member + staffer + type,
     links back to the parent, and can mark the parent Done on save.
   - **Quick-log** — floating "+" button and the `L` keyboard shortcut open the
     log panel from anywhere. The panel remembers recent members and offers
     "Log another" to keep member/staffer/type for the next entry.
   - **Dictation** — mic button in the summary field where the browser supports
     speech recognition (needs a secure context; works on localhost, not over
     plain-LAN http).
   - **Outcome shortcuts** — setting an interaction to Done in its detail view
     offers one-tap "New task" (pick the project group, title prefilled from the
     next step) and "New event" (description prefilled, date defaults 7 days out).
   - Committee chips are clickable: they open a **Committee view** listing every
     member on that committee (chamber badges, expandable rows).
3. **Events Log** — simple list (not calendar): date, description, lead person.
   Add / edit / delete. `GET /api/events?upcoming=1` returns upcoming only.
4. **Live Projects / Tasks Dashboard** — tasks nested under main project groups.
   Per task: owner, due date, status, note (max 2 sentences / 300 chars, enforced
   server-side). Up/down reordering for tasks and groups, delete with confirmation.
   Each group has a **One-pager toggle** choosing whether it appears on the
   executive summary.
5. **Finalized Documents Library** — user uploads only. Upload (25 MB per-file
   cap), list (name, size, uploaded by/at), download (served as attachment, never
   rendered inline), delete with confirmation. Files live under `data/uploads/`;
   filenames are sanitized; metadata in SQLite.
6. **Staff directory** — aides and assistants as individuals: name, title, email,
   phone, notes. Staff can serve multiple members; assignments keep history
   (ending an assignment marks it "Former", never deletes). Filterable by member.
   Staffer detail shows current/former assignments and their interaction history.
   Interactions stay tied to a member with an optional staffer ("via Jane Doe,
   Legislative Director"). The log panel offers the member's current staff.
7. **Executive One-Page Dashboard** — auto-updated summary at `/one-pager`
   (auth-gated, with the same sidebar nav as the app). Four quadrants, all read
   live from the database:
   - **Live Projects** — 3-column table (Main Project Description, Next Action,
     Status); only the 3–4 groups toggled on. Next Action = the group's most
     urgent open task.
   - **Upcoming Events** — abbreviated bullets (date ≥ today, ascending).
   - **Last Week's Interactions** — up to 3 briefs from the past 7 days, most
     recent first, 2 sentences max each.
   - **Tasks To Do** — open tasks across groups (task, status, owner).
   The **Download / Print PDF** button opens the browser print flow; the print
   stylesheet forces a clean 1-page landscape layout for emailing to executives.

## Run it

### Windows installer (recommended)

1. Run **`VilanoCRM-Setup.exe`** and follow the wizard (no admin needed —
   it installs to your local app folder).
2. On the last page, keep **"Launch Vilano CRM"** checked. The installer
   creates Desktop + Start Menu shortcuts and the CRM opens in your browser.
3. **First run only:** a setup page asks you to create the administrator
   account and the approved-email list. There are no demo credentials on an
   installed copy — sign-in is allowlist-only from the start.

From then on the CRM just runs: a small tray icon (bottom-right, by the
clock) shows green when it's running. Right-click it for **Open CRM**,
**Connect phone**, **Restart server**, **View logs**, and **Quit**. It starts
automatically when you sign in to Windows.

**Phone access (same Wi-Fi):** right-click the tray icon → **Connect phone**,
then scan the QR code with your phone's camera. Or open the **"Add to Home
screen"** option in your phone's browser to install GR CRM as a standalone
app icon.

**Updating:** run a newer `VilanoCRM-Setup.exe` over the existing install.
App files are replaced; your data (interactions, staff, documents) is never
touched. Uninstalling asks before removing your data.

**Dev fallback:** `Vilano CRM.bat` in the repo still works for developers
(Node 22+, portable-Node bootstrap, Desktop shortcut). It is not the
recommended install path anymore.

### Manual (Node 22+ already installed)

Requires Node 22+ (uses built-in `node:sqlite` — no native modules).

```bash
cd vilano-south-crm
npm install
npm start
# → http://127.0.0.1:3000
```

Environment:

| Variable  | Default                | Purpose                              |
|-----------|------------------------|--------------------------------------|
| `PORT`    | `3000`                 | Listen port                          |
| `HOST`    | `0.0.0.0`              | Bind address (`127.0.0.1` = this PC only) |
| `DB_PATH` | `./data/vilano.db`     | SQLite file                          |
| `SEED`    | unset (= off)          | `SEED=1` creates the demo account + fictional data (dev only) |
| `SEED`    | `1`                    | `0` = skip fictional demo data       |
| `UPLOADS_DIR` | `<db-dir>/uploads` | Where uploaded documents are stored  |

The server binds to **0.0.0.0 by default** so phones on the same Wi-Fi can
reach it (the auth gate still applies — sign-in is required from any device).
Set `HOST=127.0.0.1` to restrict it to the local PC. For real use with
sensitive data, run it behind your own HTTPS reverse proxy (required before
any sensitive data goes in) and set a strong `Secure` cookie via the proxy.

## First-run accounts

On a fresh database the app seeds one clearly-labeled demo account:

- Email: `demo@vilano.local`
- Password: `changeme`

**Change or delete this account before real use** (Settings → Users).

Fictional demo data (6 invented members, 8 interactions, 3 events, 2 project
groups) is also seeded on first run so the review is clickable. To start empty:

```bash
rm -f data/vilano.db
SEED=0 npm start
```

To wipe everything later, stop the server and delete the `data/vilano.db` file.

## Managing access (for the owner)

1. Sign in, open **Settings**.
2. Under **Approved emails**, add each person's email address.
3. Under **Users**, create an account for an approved email with a temporary
   password (8+ characters). Share it out-of-band; they should change it via
   "Change my password".
4. To revoke: remove the user, then remove the email from the approved list.

There is no self-registration endpoint — accounts can only be created for
approved emails by someone already signed in.

## Tests

```bash
npm test   # boots the app on an ephemeral port + temp DB; 82 assertions
```

Covers: public `/health` → 200 `{ok:true}`, unauthenticated routes → 401/redirect, non-allowlisted login rejected,
demo login, full CRUD on members/interactions/events/projects/tasks, task
reorder, delete, the 2-sentence/300-char note cap, weak-password rejection,
allowlist enforcement, documents upload/list/download/delete (auth gating,
25 MB cap, filename sanitization, attachment-only serving), the events
`?upcoming=1` scope, the one-pager project toggle, one-pager live-data
quadrants (past events and >7-day-old interactions excluded), and logout.

## Security notes

- All SQL is parameterized; passwords are never logged.
- Session cookie is `HttpOnly`, `SameSite=Lax`, 7-day expiry; `Secure` is set
  automatically when served over HTTPS.
- Resetting a user's password invalidates their existing sessions.
- This build has no CSRF tokens — acceptable for single-user/low-user internal
  use behind HTTPS, but add them if the user base grows.

## Project layout

```
server.js          Express app + JSON API (also exports createApp for tests)
Vilano CRM.bat     Dev fallback launcher (the installer above is the recommended path)
installer/         Production installer: NSIS script, Go tray app source, build.sh
tray/              VilanoTray.exe source (Go, cross-compiled for Windows)
db.js              schema, scrypt password hashing, fictional seed data
public/            login.html/js, index.html, app.js, styles.css,
                   one-pager.html/js (executive summary print view)
test/smoke.mjs     82-assertion smoke suite (node test/smoke.mjs)
data/vilano.db     SQLite database (created on first run; gitignored)
data/uploads/      uploaded documents (gitignored)
```
