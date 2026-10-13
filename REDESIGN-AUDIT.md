# REDESIGN-AUDIT.md — Vilano South GR CRM (redesign 2026-10-13)

Competitors researched (web + screenshots, Oct 13 2026):
- **Quorum** (quorum.us) — dashboard with dark-navy panel headers ("Recent Interactions"),
  KPI stat tiles, trend charts, stakeholder CRM with Outbox/email tools.
- **FiscalNote / PolicyNote** — AI policy dashboard: KPI widgets, "Impact on your org" tabs,
  customizable reports, alert-driven workflow.
- **Bloomberg Government (BGOV)** — left rail (myBGOV, News, Congress, Agencies, State,
  Directories), prominent smart-search bar, tabbed record views, bill-progress pipelines,
  dense directory tables of decision-makers (career, voting, committees, contact).
- **Phone2Action/Capitol Canary** (now Quorum-owned) — grassroots campaign dashboards,
  real-time advocate metrics, stakeholder management.

## Visual gaps (current app vs competitors)

- **V1 — Rounded edges remain.** `chip-btn`/`pager-toggle` use 20px pills; cards, modals,
  login card use 4–6px radii. Violates the no-rounded-edges rule. BGOV/Quorum use sharp
  geometry; true circles only (FAB, mic, nav dots — excepted).
- **V2 — No panel-header hierarchy.** Quorum's signature is the dark-navy section header
  ("Recent Interactions") that turns a list into a briefing. All current cards are flat
  white with the same weight — nothing reads as "the briefing".
- **V3 — Attention strip is under-designed.** Plain white card + brown left border for
  the single most important surface (stale follow-ups, overdue tasks). Competitors give
  this a command-center treatment.
- **V4 — Interaction rows duplicate identity.** "Rep. Andrew Smith (R-FL-12)" followed by
  "HOUSE · FL-12" repeats chamber/geo twice. BGOV rows carry identity once, densely.
- **V5 — FAB is a bare "+"** with no affordance of what it does on desktop (title tooltip
  only). Minor.
- **V6 — Login page fine** (navy field, gold rule, serif). Keep; just de-round.

## Functional / flow gaps (current app vs competitors)

- **F1 — No dashboard / command center.** Quorum, PolicyNote, and BGOV all open on a
  dashboard: KPIs, charts, recent activity, needs-attention. This app opens on a raw
  interaction list. Highest-impact gap.
- **F2 — No member directory.** BGOV's whole product is searchable directories of
  decision-makers. Here members are reachable only via Settings list, staff chips, or
  committee view — there is no browsable legislator directory.
- **F3 — No legislator profile.** BGOV/Quorum profiles consolidate committees, staff,
  contact, and history. Here that data is scattered across committee view, staff view,
  and interaction detail.
- **F4 — No smart search.** BGOV's defining element is the top search bar across
  people/records. Search here is per-view only.
- **F5 — No engagement analytics.** Quorum/FiscalNote surface trend charts
  (activity over time). Nothing comparable exists.
- **F6 — Recent work is buried.** No "recent interactions" shortcut surface; the log
  is one long filterable list.

## What this redesign changes (no behavior/schema changes)

1. **Dashboard home** (new `dashboard` view, default): KPI tiles (90-day interactions,
   members touched, open next steps, upcoming events), 12-month activity chart (inline
   SVG, no deps), smart search (members + interactions), recent interactions (top 6),
   needs-attention panel with dark-navy header. Read-only; reuses existing GET endpoints.
2. **Members directory** (new `members` view): searchable/filterable legislator table
   (name, chamber badge, committees, staff, last contact) + expandable legislator
   profile (committees, current/former staff, interaction history, Log interaction /
   Edit actions). Read-only except existing log/edit flows.
3. **Panel-header hierarchy**: dark-navy section headers (Quorum idiom) for
   dashboard panels and the attention strip.
4. **Zero radius**: all non-circle radii → 0 (V1, V6).
5. **Row density**: interaction rows carry identity once; type becomes a compact badge.

## Explicitly NOT changed

- Auth (password + approved-email allowlist), all CRUD flows, API surface, DB schema,
  one-pager, phone pairing, settings/tunnel, PWA install, auto-update. No new endpoints,
  no new AI features, no schema migrations.
