# Alerts — build plan and status

Living document. **Update the status tables as work lands.** It follows the shape of
`docs/explore/PLAN.md`: phases are cut into small batches so an interruption costs one batch, not
everything.

- **What we are building:** `/alerts`. This means:
  - a triage-first list of alert rules;
  - a page per rule that explains what is wrong and hands off to the evidence;
  - an editor with a live preview that answers "how noisy will this be?" before saving;
  - management of where notifications go (contact points) and when they don't (mute schedules,
    snoozes);
  - a noise report and a notification log.
- **The reference:** [reference/production.md](reference/production.md). It describes what the
  production module at `https://playground.cubeapm.com/alerts` does: every screen, string, URL key
  and API call, its 19 journeys, and 47 numbered defects (R1–R47).
- **The direction:** [DESIGN.md](DESIGN.md). It holds decisions D1–D18, signed off on 2026-10-15
  and binding; its last section records the nine sign-off answers.

## How to work on this

```bash
npm test          # whole suite (node + esbuild; see scripts/run-tests.mjs)
npm run lint      # the repo has a small baseline; add nothing to it
npm run build
```

To look something up in production, see "Looking something up again" at the top of the
reference.

- **Never put `Foo.jsx` and `foo.js` in one folder.** macOS resolves file names case-insensitively,
  so one import silently gets the other file. It broke the build once during P2.
- **Don't let a test assume the hour.** `BASE_TIME` is the wall clock at load, and Quiet hours and
  flapping rules make some states depend on it. Run a new suite under a fake clock across a day
  before trusting it (DESIGN D15, Tests).

## Where today's code stands

What Alerts starts from:

- **The route doesn't exist.** `/alerts` parses to Home: `src/utils/route.js` has no `alerts`
  path. The sidebar item is a disabled stub ("Alerts - later redesign phase"), as are SLO and
  Monitors.
- **The old page is dead code.** `src/pages/AlertsPage.jsx` is imported nowhere.
  `src/data/alerts.js` is a static list that contradicts the incident: it makes order-service the
  critical one and names a host, "node-4", that doesn't exist.
- **Entry points exist but go nowhere.**
  - `CardMenu` offers "Create Alert" on every service, infra and browser card, and each handler
    toasts "not part of this prototype yet".
  - Logs and Traces open `components/explorer/AlertDrawer.jsx`, an uncontrolled mock whose Create
    button just closes it.
- **The pieces the module needs already exist:**
  - Explore's `MetricsEditor` and `LogsEditor`. Production renders the same metrics editor inside
    its alert editor.
  - The PromQL and LogsQL engines; comparison with `bool` is supported.
  - `thresholdBands`.
  - `LegendLineChart` and `MiniChart` with `overlays`.
  - `useTimeFocus`, `SortableTable`, `FacetGroup`, `TableQuerySearch` and `StatusBadge`.
  - The incident banner and summary-strip patterns.
  - The SettingsDrawer dialog mechanics (`trapTab`).
  - `openLink` handoffs and the Errors/Browser URL-dialect method.

## Journeys, and the phase that delivers each

Journeys are numbered as in the reference (§19). "Here" names the DESIGN decision that changes the
journey.

| # | Journey | What changes here | Phase |
|---|---|---|---|
| J1 | What is firing right now? | Firing-now band, severity-first list, paused rules folded (D2, D3) | P2 |
| J19 | Look at recent alert activity | Swimlane timeline replaces the stacked count chart (D4) | P2 |
| J10 | Snooze a firing alert | Labelled Snooze menu; snoozed state visible on the row (D3, D10) | P2 (menu), P5 (list) |
| J11 | Temporarily stop a noisy rule | "Paused" is a state with its own chip, not a green "normal" (D1) | P2 |
| J15 | Delete a rule | Dialog names the consequence; toast confirms (D16) | P2 |
| J2 | Investigate from a notification | Rule page with banner, bands, state strip, instance focus, handoffs (D5) | P3 |
| J3 | Create an error-rate alert from a service chart | Quick model + status thresholds prefilled, never placeholders (D13) | P4 |
| J4 | Create a latency alert from scratch | One page, sticky preview, two named tiers, units (D6, D7) | P4 |
| J5 | Alert on error-log volume from Logs | Builder model + `stats count()`; closing-pipe check (D6, D13) | P4 |
| J14 | Clone a rule for another service | Status visible and changeable; lands on the new rule (D6) | P4 |
| J17 | Anomaly alert | Expected range drawn as a neutral band; operators survive edit (D7, R30) | P4 |
| J18 | Restrict who can edit a rule | Kept, in section 4; in v1 with mock teams and users | P4 |
| J7 | Route rules to Slack via a shared group | Contact points with usage and delivery health (D9) | P5 |
| J8 | Connect PagerDuty while creating a rule | Simulated connect; no second tab with a stale draft (D9) | P5 |
| J9 | Mute a rule every night | Mute schedules drawn as a week grid; "active now" (D10) | P5 |
| J16 | Retire a contact point still in use | Disabled Delete says why and links the rules (D9) | P5 |
| J12 | Debug a failing receiver | Notifications log with event type, failure detail, links (D12) | P6 |
| J13 | Weekly noise review | Insights flags always-firing, flapping, never-fired; Tune (D11) | P6 |
| J6 | Alert when a synthetic monitor goes down | Synthetic rules carry a "From monitor" chip and stay editable here (D18); the Monitors bell waits for the Monitors page | P2 (list), P4 (edit) |
| new | See SLO burn-rate alerts beside other rules | Read-only "From the SLO" rules, fast = Critical, slow = Warning; production doesn't list them (D18) | P1 (data), P2 (list) |

## Phases at a glance

```
P0 Study & direction ─▶ P1 Foundations ─▶ P2 Triage ─▶ P3 Investigate ─▶ P4 Author ─▶ P5 Route & quiet ─▶ P6 Learn ─▶ P7 Weave & harden
                                   └─ after P1, P4–P6 can run in parallel with P2–P3 if two people work on it
```

| Phase | Outcome a user can see | Size |
|---|---|---|
| **P0** Study & direction | Reference, design direction and this plan in `docs/alerts/` | done; signed off 2026-10-15 |
| **P1** Foundations | `/alerts` reachable; data, state model, URL and condition logic tested | L; done 2026-10-16 |
| **P2** Triage | Rules tab: what's firing, how bad, since when; snooze, pause, delete | L; done 2026-10-16 |
| **P3** Investigate | Rule page: why it fires, how it has behaved, where the evidence is | M; done 2026-10-16 |
| **P4** Author | One-page editor with live preview and backtest; every "Create Alert" works | XL; done 2026-10-17 |
| **P5** Route & quiet | Contact points, mute schedules and snoozes managed and visible | M; done 2026-10-21 |
| **P6** Learn | Insights (noise) and Notifications (delivery) | M; done 2026-10-21 |
| **P7** Weave & harden | Alerts reachable from where problems are noticed; verified | M; done 2026-10-21 |

---

## P0 — Study and direction  ✅

- [x] Study the production module: the live walkthrough, the bundle and the read API →
      `reference/production.md`.
- [x] Direction for every surface, with options and costs → `DESIGN.md`.
- [x] This plan.
- [x] **Sign-off, 2026-10-15.** The answers are in DESIGN.md's last section. They agree with the
      proposals except Q5, where rows expand in place rather than opening a drawer. Q6 adds
      custom permissions, Jira, SLO burn-rate rules and editable synthetic rules to v1, and defers
      the Mobile datasource.

## P1 — Foundations  ✅

**Goal:** everything below the UI exists and is tested, and `/alerts` is reachable with its tab
strip, so every later phase builds screens on settled logic.

Built on the branch `alerts-phase-1`, alongside a second session building P2 and P3 in the same
working tree. The file split agreed between the two: P1 owns `src/data/alerts.js`,
`src/utils/alerts/*`, `src/utils/alertsUrl.js`, `status.js`, `route.js`, the sidebar, `App.jsx`,
`ViewTabs`, `PageBar`, `src/hooks/useAlerts.js`, the `AlertsView` and `AlertEditorView` pages and
these docs. P2 and P3 own `src/components/alerts/**`, `AlertRuleView`, and 1g.

**Batches:**

- [x] **1a — Data.** `src/data/alerts.js`, in production's shapes, ids included: production's demo
  rule #437, its synthetic rules 426–433, and its receiver group #7.
  - Each rule is bound to the profile its query measures (`bindingFor`):
    - Quick rules, through their model;
    - the seed's other rules, through a binding of their own;
    - SLO rules, as a multi-window burn rate over a prefix sum.
  - Rules are evaluated the way an engine does it, every `interval` over an eight-day horizon,
    with Prometheus' pending → firing → resolved machine. Quiet stretches cost a comparison per
    tick, not a sample.
  - `evaluateRules`, `ruleHistory`, `ruleTimelineForWindow`, `notificationLogForWindow`,
    `alertStatsForWindow`, `ruleSeriesForWindow` and `previousWindowOf` all read the one history.
    A test holds the timeline, log and stats to agreement.
  - `ruleSeriesForWindow` draws the evaluator's readings, not bucket means. Each point is the
    query at its bucket's close, on the rule's own schedule, so the newest point is the alert's
    `value` (and `view.value`) at every range (DESIGN D15).
    - *Changed after P3 landed:* the first version averaged each bucket, which left the rule
      page's legend 0.2 points off its banner at Last 1 hour. Over a week, the average sat under
      the threshold the rule was firing over.
  - The SLO rules come from `sloRules(slos)`; `ruleDefsFor(state)` is the stored rules plus those.
  - `observability.js` gained read-only profile accessors (`hostProfile`, `HOST_NAMES`,
    `redisProfile`, `logRateProfile`), so an alert fires where those charts break.
- [x] **1b — Model.** `src/utils/alerts/model.js` exports `ruleView`, `sortRules`, `groupRules`,
  `countRules`, `ruleFacets`, `ruleScope`, `ruleMetric`, `ruleManagedBy` and `ALERT_ORDER`.
  - Scope is read by scanning matchers, not by the PromQL parser, which cannot read #437 (see
    Known gaps).
  - The alert order lives here, not in `status.js`: `worstStatus` ranks healthy above info, and
    pending must outrank OK.
  - An instance merges its series' tiers: the worst tier says how bad, and both `activeAt` and
    `firingAt` come from the first tier, the way the rule counts its own "firing for".
    - *Changed after P2 landed:* `firingAt` used to come from the worst tier alone. Whenever the
      warning tier fired a tick before critical (which depends on the clock), an instance read a
      minute less than its rule.
- [x] **1c — Condition and backtest.** `src/utils/alerts/condition.js` holds:
  - production's two storage formats, read and written;
  - the tier mapping in both directions, round-tripping;
  - the state machine and `mergeTierIntervals`, a sweep;
  - `backtest` and `suggestThreshold`.
- [x] **1d — Words.** `describe.js` writes the sentences, units and durations, plus
  `displayName`. `template.js` renders the Go-template subset, with `templateLabels`,
  `labelAction` and `templateDisplay`. `catalog.js` holds production's verbatim lists.
  `routing.js` resolves receivers, contact points, mutes and silences, and does the time-zone
  maths for mute windows.
- [x] **1e — Status.** `statusForAlertState`, `alertStateKey`, `ALERT_STATE_LABELS`, and
  `THRESHOLDS` exported frozen.
  - *Changed from the plan:* no shared `SEVERITY_RANK`. The alert order is not a status rank
    (see 1b).
- [x] **1f — URL.** `src/utils/alertsUrl.js` reads production's keys and ignores the APM page's
  sticky ones; our facet keys include `severity`, and the service facet is `svc`.
- [x] **1g — Chart overlays.** Built by the P3 session in `src/components/charts/chartOverlays.jsx`.
  Web Vitals' bands are pinned byte-identical in `thresholdBands.test.js`.
- [x] **1h — Wiring.**
  - `route.js` has `alerts`, `alertRule` and `alertEditor`, with `alertRuleUrl` and
    `alertEditorUrl`.
  - The sidebar's Alerts item is enabled, and lit on all three views.
  - `AlertsView` is the shell: crumbs, the `ViewTabs` strip, a neutral flex-column panel, and
    reserved notices on the tabs a later phase builds.
  - `AlertEditorView` is a placeholder until P4.
  - `PageBar` gained `showTime`; its default render is pinned identical.
  - App lazy-loads the three pages, so a break inside the module, built in parallel, takes down
    `/alerts` only.
  - The dead `AlertsPage.jsx` is gone.
- [x] **1i — Persistence.** `src/utils/alerts/store.js` and `src/hooks/useAlerts.js`. One
  external store; only the viewer's edits are saved (localStorage, versioned), over a seed
  rebuilt each load, so the seed's relative times never freeze.
  - Every action returns its Undo.
  - Deleting a contact point or schedule still in use is refused.
  - `seriesFor(id)` gives a rule's series with the previous period.
- [x] **1j — Shared `ViewTabs`.** `src/components/shared/ViewTabs.jsx` plus `viewTabIds.js`.
  Service and Browser are moved onto it, byte-identical, and pinned in `sharedUi.test.js`.
  - *Changed from the plan:* the service page does not gain keyboard navigation. Its strip is
    the plain form, unchanged. Passing an `idPrefix` is the one-line follow-up that gives it the
    full pattern.

**What the seed shows at Last 1 hour** (pinned in `data/alerts.test.js` and `model.test.js`):

| State | Rules |
|---|---|
| Critical | 501 payment-service error rate · 502 payment-service p90 · 514 redis.0 memory · 515 CPU high on ‹host.name› (3 hosts) · 9011 payment SLO fast burn |
| Warning | 437 production's demo rule (unlabelled → Warning, Q2) · 504 Error log volume (Logs) · 505 order-service p90 (muted: Daily deploy window) · 506 order-service errors · 507 shipment-service p90 (snoozed) · 508 notify-service (chronic: "Always firing") · 9012 SLO slow burn |
| Flapping | 509 search-service p90 (muted by Quiet hours overnight) |
| Pending | 503 sustained errors (waits 30m) |
| OK | 510 traffic anomaly · 511 demo-nodejs-service · 426 Synthetic down - Docs |
| No data | 512 billing-legacy |
| Rule error | 513 many-to-many join |
| Paused | 427 · 428 · 432 · 433 synthetic |

The log carries every status: SNOOZE on 507, MUTE on 505 and 509, and ERROR from Infra paging's
webhook, which answers 503.

Some of this depends on the hour, because `BASE_TIME` is the wall clock at load. 509 flaps, and
Quiet hours mute it from 21:00 to 07:00 IST, so at night it can be a third suppressed rule. No test
pins 509's state; the tests read it. Every alert suite (26 files, both sessions') has passed at 54
instants across a day under a fake clock (DESIGN D15, Tests).

**Done when:** `npm test` is green with the new suites ✓. `/alerts` and production's
`/alerts?tab=alert-logs&rule_id=437` route to the right tab ✓ (route and URL tests). The study URL
lands on the plain Rules tab ✓ (`alertsUrl.test.js`, `AlertsView.test.js`).

The browser pass ran on 2026-10-16 ✓. It checked:

- the strip's counts ("Rules 23 · 13 firing", "Contact points 7", "Mute schedules 2");
- production's `tab` values, both on a click and from a pasted link;
- arrows, Home, End and Enter on the strip, and Back after switching tabs;
- no time picker on the configuration tabs;
- the study link opening Rules at Last 7 days;
- `/alerts/437`, `/alerts/new`, `/alerts/437/edit` and their "Back to Alerts";
- the sidebar lit on all three views;
- the service page's and Browser's strips behaving as before;
- no console errors.

## P2 — Triage: the Rules tab  ✅

**Goal:** from the sidebar, a user sees what is firing, how bad, since when and who was told, and
can snooze, pause or open a rule in one click (J1, J10, J11, J15, J19).

**Status:** built by the second session and finished on 2026-10-16, all six batches. It was checked
against the code and in the browser. Clicks, keyboard and drag-zoom were checked by hand, because
the repo has no DOM tests (Known gaps).

**Batches:**

- [x] **2a — Firing-now band** (D2):
  - summary pills (Critical, Warning, Pending, Rule error, Snoozed/muted, Paused) that act as
    filters;
  - an incident banner for the worst firing alert, with handoff buttons;
  - a one-line collapsed form when nothing fires.
  - *Revised 2026-10-21:* the band's title, pills and banner were removed (D2). It keeps
    the stale line, and the timeline or the one-line calm form. "Updated …" moved to the page bar,
    ahead of Auto, and reads "just now" for its first minute (D16).
- [x] **2b — Alert timeline** (D4): swimlanes over the range, with severity bars, hatched pending,
  suppression overlays and notification ticks. Drag zooms through `useTimeFocus`; the series
  budget footer applies. Space is reserved so nothing shifts (R44).
- [x] **2c — Rules table** (D3):
  - the facet rail and `TableQuerySearch`;
  - Group by (Group / Service / Contact point / None) — *removed 2026-10-21* (D3): the list
    always groups by each rule's own group, and New rule is the shared `.run-btn` primary button
    — *moved 2026-10-23* to the "Create a rule from scratch" banner, beside one for templates;
  - grouped rows sorted by severity (R6), with D3's row anatomy;
  - paused rules folded per group (R47);
  - Snooze and Actions as labelled menus (R11);
  - source chips for synthetic and SLO rules, with SLO rules read-only (D18).
- [x] **2d — Inline expansion** (D3, as production):
  - the whole row toggles, as a button with `aria-expanded` (R12), and the name stays a link;
  - the restyled details panel: sentence, evaluation settings, Notifies, mutes and snoozes, tags,
    last evaluated;
  - instance rows with value against threshold and a sparkline, plus the Traces/Logs handoffs
    production keeps in a new tab;
  - a footer with "Open rule", "Notification history" and "Open in Explore";
  - several rows can be open at once, under sticky group headers.
- [x] **2e — States** (D16):
  - skeleton rows;
  - live refresh with "Updated Ns ago";
  - one inline stale-data line instead of toast stacking (R43);
  - empty states for no rules, no matches and nothing firing;
  - toasts with Undo for pause and snooze;
  - the delete dialog's wording.
- [x] **2f — URL sync:** facets, search and group-by are written in our dialect with `replace`.
  `rule_id` expands that rule and scrolls it into view, as production does.

**As built, beyond or apart from the batches:**

- **The pills** came from `countRules` until they were removed on 2026-10-21 (D2). Warning counted
  unsuppressed rules only; a suppressed rule counted once, under Snoozed/muted.
- **The banner** named the worst *unsuppressed* firing rule, until it was removed on 2026-10-21. The
  same rule still opens the timeline, and Home's alert card leads with it.
- **A calm day** is one line, and the timeline stays closed until asked for.
- **Timeline lanes are per series**, so a multi-host rule such as 515 gets one lane per host.
  - Every bar is a link to `/alerts/:id?alert_id=…`, named in words: "Status: Critical ·
    21:18–now · 15m · peak 15.8%".
  - A click focuses the range on its bar, unless the bar already covers 80% of it.
  - Five lanes show (eight until 2026-10-21), then "Show 5 more" and "Show all"; once more than
    five show, "Show less" takes the timeline back to five (the footer's `collapsible`).
- **The rail** also has Status and Suppressed.
- **Search** takes `name:`, `group:`, `service:` and `label:`, plus free text over label values.
- **The row toggles on a click** anywhere but its links, buttons and menus. The chevron button is
  the keyboard toggle (`aria-expanded`, `aria-controls`); ↑, ↓, Home and End move between rows.
- **No rules at all** shows suggested rules for the services, an early piece of "Suggested rules"
  from Beyond production.
- **Keys:** `/` searches and `n` starts a new rule.
- **Undo** is wired to each action's returned undo: pause, resume, snooze, unsnooze and delete.
- **What is expanded or folded** lives in component state, deliberately, not in the URL.
- **Fixes since the batches:**
  - menus are portalled to the body and take focus only once positioned, without scrolling;
  - Snooze and Actions are labelled per rule ("Snooze <rule>", "Actions for <rule>");
  - an instance's "Firing Nm" counts from `firingAt`, regression-tested.

**Reuses:** ErrorsView's frame classes, `FacetGroup`, `TableQuerySearch`, `StatusBadge`, Home's
`SummaryStrip` and health-block logic (extract it from `HomePage.jsx` if the timeline shares it),
`IncidentBanner`, `CardMenu`'s menu mechanics, `Toast`, `useSortedRows`, the series budget.

**New:** `src/pages/AlertsView.jsx`, and `src/components/alerts/` (`FiringNow`, `AlertTimeline`,
`RulesTable`, `RuleRow`, `RuleDetails`, `SnoozeMenu`, `RuleActionsMenu`) with their CSS.

**Tests:**

- The list renders severity-sorted at Last 1 hour.
- Paused rules fold.
- A row toggles from anywhere on it except its menus and link.
- `rule_id` expands its rule.
- Every row control carries a label.
- Facets keep a seeded value at 0.
- The URL round-trips.
- Snooze and pause update the overlay and show Undo.
- `renderToStaticMarkup` checks for the band and timeline.

**Done when:** the payment incident is the first thing on the page; a snoozed or paused rule is
distinguishable from an OK one without expanding anything; no control is icon-only.

**Demo:** sidebar → Alerts. The payment-service error rate is the first rule, with its value against
the 3% threshold and how long it has fired since the incident's ramp. The timeline shows payment
and order-service firing together. Snooze 30m on the payment rule moves it below the unsuppressed
rows with a "Snoozed · 30m left" chip.

## P3 — Investigate: the rule page  ✅

**Goal:** from a notification link or a row, a user understands why the rule fires, how it has
behaved over the range, and reaches the service, traces, logs or query in one click (J2).

**Status:** built by the second session and finished on 2026-10-16, with 1g. Where it
differs from the plan is in DESIGN D5 ("As built") and under Known gaps below. The rule head's title
now uses `displayName`. Definition's Summary and Description go through `templateDisplay` ("…failing
‹value›% of requests"), with the stored text in the hover title.

**Batches:**

- [x] **3a — Frame:**
  - crumbs CubeAPM / Alerts / <group> / <rule>;
  - a head with the state chip, name, sentence and actions (R5);
  - an incident banner with the root-cause sentence from the incident profile;
  - a "Not found" state with "Back to Alerts".
- [x] **3b — Overview:**
  - a chart with palette series (R45) over both tiers' bands, the firing stretches shaded and a
    "now" line;
  - Compare previous period (*as built:* Off or Previous period only);
  - a state strip on the same axis;
  - KPIs with deltas: now vs threshold, firing for, incidents, notifications;
  - recent events;
  - last evaluated (R8).
- [x] **3c — Instances:** one row per label set, with value against threshold, since and last
  notified. `?alert_id=` selects and isolates its series (R10). `notifyTime` re-centres an old link.
- [x] **3d — Notifications and Definition:**
  - Notifications is the P6 component filtered to the rule; until P6, an interim list from the data
    layer.
  - Definition is the editor read-only, with tabs that still click (Explore reference R3), and an
    Edit button.
  - *Changed from the plan:* Definition is a read-only `GeneratedQuery` with a summary of the
    model, under tabs that click. Explore's editors are untouched.
- [x] **3e — Handoffs out** (D5), each tested like Errors':
  - the service page;
  - Traces (error or slow filters, ±5 min around `incidentTime` or the alert's start);
  - Logs;
  - Errors;
  - Explore (the exact query).
  - *As built:* Traces and a log rule's Logs set App's range to ±5 minutes first, because
    `openLink` cannot carry a range. Clone goes to `/alerts/new` with `state.cloneOf`, for P4 to
    read. Gaps are listed under Known gaps.

**Reuses:** `LegendLineChart`/`MiniChart` overlays, P1's overlay helpers, the health strip,
`openLink`, `tracesFiltersFor`/`filtersToChips`, `explorePayloadForCard`'s shape, and
`MetricsEditor`/`LogsEditor` in read-only mode.

**Tests:**

- Each handoff lands on rows.
- `alert_id` focuses its instance.
- The bands match the stored tiers.
- The banner sentence matches `describe.js`.

**Done when:** opening `/alerts/<payment rule>?alert_id=<instance>` answers what, how bad and since
when without scrolling, and every handoff lands on matching evidence.

## P4 — Author: the rule editor and every way into it  ✅

**Goal:** create, edit and clone a rule on one page whose preview shows, before saving, where the
rule would have fired over the range. Every "Create Alert" in the app opens it prefilled (J3–J5,
J14, J17, J18).

**Status:** built on 2026-10-17, in this session, on the branch `alerts-phase-1`. The P2/P3 session
added the rule chart's `preview` mode for it. What was built beyond or apart from each batch is
listed after the batches; the new gaps are under Known gaps.

**Batches:**

- [x] **4a — Page skeleton** (D6):
  - the sentence header with Save and Cancel;
  - four numbered sections in production's order, with collapsed summaries;
  - a sticky preview rail, falling back to a stacked layout below ~1280px;
  - a validation list on a disabled Save (R22);
  - the unsaved-changes guard (R24);
  - status visible on Clone (R41).
- [x] **4b — Query:**
  - Static / Anomaly and Metrics / Logs / Traces / Mobile;
  - `MetricsEditor` with `latencyInMs` threaded and "(millis)" labels (Explore divergence #3),
    and incoming models stripped of `options` (divergence #2);
  - `LogsEditor` for Logs and Traces, with the closing-pipe check (R31);
  - Mobile shown disabled with its reason (deferred from v1).
- [x] **4c — Condition and preview** (D7):
  - two named tiers with verbatim operators and unit suffixes (R27);
  - anomaly deviations, kept across edits (R30);
  - the preview runs automatically on a debounce, with no "Generate Graph" (R25);
  - the bands, shaded backtest intervals and summary;
  - the suggested-threshold chip.
- [x] **4d — Evaluation and details** (D8):
  - Check every, Fire after and Re-notify every, with production's option lists (15/17/12) and
    defaults (1m / 5m / 4h);
  - the name with a live template preview and Insert label, coupled to grouping (R28);
  - the group combobox;
  - tags with inline reserved-key errors;
  - description and runbook (backend-gated).
- [x] **4e — Notifications:**
  - a contact-point multi-select plus a one-off destination card;
  - at least one destination required, with none chosen at start (R23);
  - "Send one notification for all series / per series";
  - Test, simulated in the prototype.
- [x] **4f — Mutes and access:**
  - a schedule multi-select plus a one-off window with a week-grid preview;
  - role-based or custom permissions over mock teams and users, with production's rule of at least
    one complete Editor row.
- [x] **4g — Save, Edit, Clone:** writes to the P1 overlay, toasts, then the rule page. A missing
  rule shows "Alert not found" with a way back.
- [x] **4h — Entry points in** (D13):
  - `alertPayloadForCard()` for `CardMenu` on Service, Infra and Browser: a Quick model, status
    thresholds, and a suggested name and group.
  - Logs and Traces query bars, replacing and deleting `AlertDrawer.jsx`. Mobile Traces shows the
    item disabled ("Mobile alerts aren't available yet") until the Mobile datasource lands.
  - An `openLink({view: 'alerts', …, nonce})` branch carrying the payload in App state, as
    Explore's handoffs do. It is not encoded in the URL.

**As built:**

- **Where it lives.**
  - `src/pages/AlertEditorView.jsx`, and its sections in `src/components/alerts/editor/`.
  - The draft is `src/utils/alerts/editorDraft.js`: one draft for New, Edit and Clone; every
    conversion to and from production's shape; validation as `{ field, message }`.
  - The entry payloads are `editorPayloads.js`; the week grid's maths is `muteWeek.js`; the guard
    is `src/utils/leaveGuard.js`.
- **The preview is the saved rule's evaluator.** `previewRule` in `data/alerts.js` evaluates the
  draft over the window with the same machinery as a saved rule's history, so the preview and the
  rule page agree after saving. This is pinned for eight seeded rules, at an hour and a week.
  - *Changed from the plan:* D7 had the preview run Explore's PromQL with `bool`. Instead, a query
    no profile describes (Code, Advanced, anything on Logs or Traces) is bound to Explore's
    engines by the new `data/alertsEngine.js`. It reads 6-hour chunks aligned to the epoch on
    the rule's own schedule, cached, so a reading at an instant is the same whichever window
    asked for it.
  - Seeded queries now bind by query as well as by id, so a clone reads what its original reads.
- **The guard (R24).** The app's plain `BrowserRouter` has no blocker, so the editor registers a
  guard. App's sidebar, Home and sign-out, the crumbs and Cancel ask it first. The page itself
  covers Back (with a copy of its history entry) and closing the tab (`beforeunload`).
- **Save is never a dead button (R22).**
  - The head shows "N to finish". Pressing Save lists what is missing, each item a link to its
    field.
  - Inline messages wait for the first Save, except for what was typed wrong.
- **Status is a control in the head** (R41). A clone of a paused rule opens "Paused" and says what
  that means.
- **Explore's Quick builder gained `latencyInMs`.** It is an optional prop on `MetricsEditor` and
  `QuickBuilder`, giving the "(millis)" labels and millisecond queries (Explore divergence #3).
  Explore leaves it off and is unchanged.
- **Thresholds from a card are inclusive (`>=`).** The badges turn amber at their warn figure and
  red at their critical one, and the rule fires on the same readings.
- **Entry points.**
  - Service cards open the editor; so do Infrastructure's host "CPU Used %" chart
    (`system_cpu_utilization × 100`, at the host table's 70/85%) and the Logs and Traces bars.
  - Mobile Traces lists the item, disabled with its reason. `AlertDrawer.jsx` is deleted.
  - Browser cards are not wired: there are no browser metrics to alert on yet (Known gaps).
- **A seed fix.** The synthetic rules' Advanced model used an argument type `labels` that
  Explore's builder (verified against production's) spells `aggregation`, so their model
  regenerated nothing. Fixed, and `SEED_VERSION` is now `alerts-seed-2`, which discards edits
  saved over the old seed.

**Reuses:** Explore's editors, `editorState.js`, `builders.js` (including the tested `latencyInMs`
variant), `api.js` (`queryRange`, `setSimulatedLatency(0)` in tests), `GeneratedQuery`,
`FilterRows`, P1's condition, describe and template modules, and SettingsDrawer form classes.

**Tests:**

- Each production prefill (Clone, Logs, card menus) yields the expected model and query.
- Tier mapping round-trips through save.
- The backtest matches `condition.js` on the seeded incident.
- The guard fires on a dirty form.
- Every validation message renders.
- The `AlertDrawer` import is gone from Logs and Traces.

**Done when:**

- The p90 card's "Create Alert" on payment-service opens the editor with the Quick model, 150/300
  ms tiers and a preview showing the incident shaded. ✓ (browser, 2026-10-17)
- Saving lands on the new rule. ✓ (browser: a new rule, an edit with Undo, a clone)
- Production's demo threshold of 0.1% previews as "would have fired 98% of the range" with a
  suggestion.
  - *Changed:* in our data #437's endpoint sits at 0.06% outside the incident, so 0.1% fires only
    in it, about a quarter of the hour.
  - The suggestion shows on the chronic rule instead: 508 fires 100% of the week, and "Use 100 ms"
    applies the range's 95th percentile. ✓ (browser)

## P5 — Route and quiet: contact points, mute schedules, snoozes  ✅

**Goal:** where notifications go and when they are held back is configured and visible without
leaving Alerts (J7–J10, J16).

**Status:** built on 2026-10-21, in this session. The P2/P3 session had ended by then; its custom
snooze dialog and snooze chips (P2, P3) already covered half of 5d.

**Batches:**

- [x] **5a — Contact points list:** integrations as icon + label + target, "Used by N rules"
  linking to filtered Rules, and last delivery result from the log.
- [x] **5b — Contact point drawer** (SettingsDrawer dialog mechanics):
  - the name;
  - integrations from a labelled type grid: Email, Slack, PagerDuty, Jira, Opsgenie, Google Chat,
    Microsoft Teams and Webhook, in production's order;
  - Jira's Project and Issue Type pickers over mock data, with their refresh links (D9);
  - per-type fields with production's labels and help text;
  - masked secrets;
  - a webhook payload variable reference;
  - Send test;
  - Save that says how many rules it re-routes;
  - Delete guarded with the reason (R15, R16).
- [x] **5c — Mute schedules:** list and drawer with the week grid, "Active now · ends HH:MM" /
  "Next: …", timezone beside the viewer's own, and "Used by".
- [x] **5d — Snoozes:**
  - active and scheduled snoozes listed, with remaining time and Unsnooze with Undo;
  - the Custom snooze dialog (start, duration, reason);
  - snooze chips on rows, the expanded panel and the rule page.
- [x] **5e — PagerDuty connect, simulated** in place, without production's second tab and stale
  draft (R35).

**As built:**

- **Where it lives.**
  - `src/components/alerts/config/`: the two tabs, their drawers and the snooze list.
  - `src/utils/alerts/configViews.js`: usage, delivery health, the order, words, state and
    drawer checks.
  - `lastDeliveries` in `data/alerts.js` reads the whole horizon's log, behind the store's
    lazy `deliveries()`.
  - `statusForDelivery` in `status.js`.
- **One card, two places.** The contact point drawer's integrations are the rule editor's
  destination cards, and the schedule drawer's windows are its window cards. The week grid is
  now its own component (`editor/WeekGrid.jsx`).
- **A failing contact point heads the list,** with a red edge, the error and when it failed. The
  rest follow by usage. Each integration says how its last send went over the 8-day horizon.
- **The card gained** refresh links for Slack's and Jira's lists (the prototype's lists are fixed,
  so they say "Up to date"), masked secret headers with Reveal, and a payload variable reference
  with a rendered preview (`renderWebhookPreview`).
- **The drawers** use the settings drawer's mechanics. A dirty drawer asks before Escape or the
  backdrop discards it. Dialogs open beside the drawer, in a layer above it.
- **Every save, delete and unsnooze confirms in a toast with Undo.** Unsnooze goes through the
  Rules tab's `changeRule`, so its wording is the same everywhere.
- **Kept from production:** the Receiver Groups search box, over names, targets and rule names.

**Tests:**

- Usage counts match the rules.
- Delete is disabled with its reason while the contact point is in use.
- The week grid wraps overnight windows correctly.
- "Active now" holds at a schedule's edges and across timezones.
- Snoozes appear wherever their rule does.

**Done when:** a broken webhook is visible on its contact point before an incident; the quiet-hours
schedule says whether it is muting right now; every snooze can be seen and ended from one place.
✓ All three, in the browser on 2026-10-21: Infra paging heads the list with "Failed … 503 Service
Unavailable"; Quiet hours reads "Next: today 21:00" by day and "Muting now · ends …" at night;
Unsnooze from the list ends a snooze, and Undo restores it.

## P6 — Learn: Insights and Notifications  ✅

**Goal:** a user can answer "which rules are noisy?" and "did we, or why didn't we, get paged?"
from Alerts alone (J12, J13).

**Status:** built on 2026-10-21, in this session. Every Alerts tab is now built; none says
"reserved".

**Batches:**

- [x] **6a — Insights:**
  - production's columns plus median duration, notifications sent and deltas vs the previous
    period;
  - every rule listed, so "Never fired" can be said;
  - flags: Always firing ≥ 50%, Flapping, Never fired;
  - header `InfoTip` definitions;
  - Tune → the editor at the same range with the suggestion;
  - CSV.
- [x] **6b — Notifications log:**
  - the event column (Fired, Resolved, Reminder, Muted, Snoozed, Failed);
  - the contact point and integration as icon + label;
  - Details that say why;
  - links to the rule and instance;
  - facets;
  - "Show 20 more · Show all";
  - rows that expand in place with the payload, the full target and any error text;
  - production's `rule_id` and status values in the URL.
- [x] **6c — Embeds:** the log on the rule page (P3d) and delivery health on contact points (P5a)
  use this component and data.

**As built:**

- **Where it lives.**
  - `src/components/alerts/insights/` and `src/components/alerts/notifications/`, each with its
    own stylesheet.
  - `src/utils/alerts/insights.js` (flags, rows, totals, CSV) and `notificationLog.js` (rows,
    facets, filter, payload).
  - The store's lazy `statsBefore()` for the previous period.
- **The flags are one pure function** (`insightFlags`), which the data module and the tests both
  use, so their edges are pinned.
  - *Changed:* "Never fired" now needs no activity at all. A rule that went pending is alive; 503,
    pending in the incident, was flagged before.
- **Comparisons** are against the previous period. Over Last 7 days there are none, because the
  previous week lies past the 8-day evaluated history, and the tab says so instead of showing
  zeros.
- **Tune** opens the rule's editor focused on its thresholds, where the preview already offers
  one (D7). For an SLO's rule it is disabled, with the reason.
- **Event and Status are two columns, not one** (*changed* from D12's single list). Event is
  Fired, Reminder or Resolved; Status is Sent, Failed, Muted or Snoozed, with production's value
  in its title. A muted resolve is still a resolve.
- **The log is one component in two places** (6c): the Notifications tab, and the rule page's
  Notifications tab in compact form, without the Rule column.
  - The rule page's interim list (`rule/RuleNotifications.jsx`, the P3 session's, which had
    ended) now renders it.
  - Contact points' delivery health (P5) reads the same log, through `lastDeliveries`.
- **The URL** keeps production's `rule_id` and status values. The Integration facet was added to
  the URL's keys (`integration`), and Contact point values are names, as the Rules tab's Notifies
  facet uses.

**Tests:**

- Insights counts equal the timeline's intervals over the same range.
- The flags trip at their edges.
- The log's events reconcile with intervals, repeat interval, schedules and snoozes.
- Production's `?tab=alert-logs&rule_id=437` link filters to that rule.
- Our status facet round-trips through the URL using production's values.

**Done when:** production's chronically firing demo rule shows "Always firing" with Tune, and every
SUCCESS, ERROR, MUTE or SNOOZE row says which event and why.
✓ In the browser on 2026-10-21, with one change: in our data the chronic rule is 508, not #437
(see P4). 508 leads Insights as "Always firing", and its Tune opens the editor on its thresholds
with "Use 100 ms" offered. Every row names its event and status, and every held or failed one says
why (pinned in `notificationLog.test.js`).

## P7 — Weave and harden  ✅

**Goal:** Alerts is reachable from wherever a user notices a problem, and the module is verified
end to end and documented.

**Batches:**

- [x] **7a — Platform integration:**
  - Home: firing alerts in the summary strip and incident banner linking to the rule, plus
    "Alert coverage" in onboarding.
  - Service page: "N rules · M firing" in the header, and the settings drawer's mock Alerts tab
    replaced by the service's real rules plus Create.
  - Errors drawer: "Alert on this error".
  - Explore toolbar: "Create alert".
- [x] **7b — Bulk actions:** select rows → Pause / Resume / Snooze / Delete / Move to group /
  Attach contact point (R17).
- [x] **7c — Verification pass** in the browser, like Explore's batch 5: every journey J1–J19,
  keyboard-only, light theme, narrow widths. Fix what it finds.
- [x] **7d — Docs:**
  - `docs/decisions/alerts-page.md` in the decision-doc format (what is worth not re-deriving,
    handoffs, "where it deliberately differs from the original", known gaps);
  - the style guide extended with the alert components (it says to extend it rather than start a
    parallel guide);
  - CLAUDE.md's route and decisions lists;
  - this file's status tables.

**As built:**

- **7a.** Home shows a quiet nudge about the worst firing rule — its name, its value
  against its threshold and for how long, and Open rule — and nothing while nothing fires
  (`components/alerts/home/HomeAlerts.jsx`). The service settings drawer's Alerts tab is the
  service's rules plus Create, seeded with what the service lacks (`service/`). Revised on review
  (2026-10-23): Home's "Alerts firing" pill, its coverage line ("Alert rules watch 6 of 7
  services…") and Home's summary strip came out, the red banner became the nudge, and the service
  header's "6 rules · 5 firing" link came out. The Errors
  drawer's "Alert on this error" and Explore's "Create alert" build their payloads beside the
  others in `editorPayloads.js` (DESIGN D13, as built). The error alert watches the metric counter
  `cube_apm_errors_total`, not the Traces source D13 named: the span store samples, and over some
  hours held none of the exception while the drawer counted hundreds.
- **7b.** Built — a select box per row, and a bar that paused, resumed, snoozed, moved, re-routed
  (a tri-state contact point checklist) or deleted the selection as one change with one Undo — and
  removed on review (2026-10-23), with its store `batch`. A rule changes from its own menus.
- **7c.** Every journey J1–J19 was walked in the browser with real key presses, at 768, 1024 and
  1600 px, and audited for unnamed and mouse-only controls. It found, and P7 fixed: focus falling
  to the page when a paused or deleted row, a deleted contact point or schedule, or PagerDuty's
  connect button left; a new integration's card appearing above the button that added it, past
  the keyboard; a failed Save in the config drawers leaving focus on Save, where the editor's moves
  to the first thing to finish; a toast Undo out of keyboard reach (⌘Z / Ctrl+Z now); radio groups with no
  arrow keys and a Tab stop per option; white text under 4.5:1 on amber chips, and on the dark
  theme's red and blue; the Notifications tab
  clipped at 768 px; a three-row bulk bar; Insights' Tune off-screen at 1024 px; the Explore
  payload sending `[object Object]` as the query; "Create a rule" on a service proposing a copy of
  its error-rate rule; the error alert above. The empty `aria-busy` box the lazy pages loaded
  behind is now a skeleton in each page's shape (the split stays: about 240 kB that no other page
  needs). Three findings belong to the app, not Alerts, and are left as tasks: focus after a route
  change and a skip link, the facet rail's mouse-only group headers, the toast's fixed 4.5 s.
- **7d.** `docs/decisions/alerts-page.md`; the style guide's "Alerts components"; CLAUDE.md's
  routes and decisions; these tables.

**Done when:** every journey in the table above runs in the browser without a dead end, and the
decision doc exists.
✓ On 2026-10-21: every journey ran in the browser by keyboard, and the decision doc exists.

---

## Known gaps

Open, each with where its fix belongs.

- **Explore can't read #437's query.** `(x default 0)[5m]` doesn't parse in Explore's PromQL
  parser, so "Open in Explore" is disabled on #437 with the reason in its title. Scope is read by
  scanning matchers (1b) for the same reason. *Fix:* Explore's parser.
- **Host CPU reads over 100%.** The payment hosts' CPU profile multiplies an ~80% baseline by 1.4
  in the incident, so rule 515 reads 112–121% and its axis runs to 150%. The Infrastructure page
  draws the same profile. A cap needs a recalibration, because `pinToReference` won't pin a profile
  with a ceiling. *Fix:* `observability.js`'s host profiles, as a task of its own. Rule 515's 90/95
  tiers must be checked afterwards.
- **Traces for a latency rule has no duration floor.** The Traces search had no numeric
  comparison. It has one now (`duration:>=8.8ms`; `docs/decisions/query-builder-phase8.md`), so
  the grammar half is closed. *Fix:* `tracesHandoff` in `components/alerts/rule/handoffs.js`
  adds a `duration` `gte` chip at the rule's threshold.
- **Logs for a service rule lands empty.** The Logs mock names the service `payment` and holds no
  payment error records (e.g. 501). A log-source rule (504) lands. *Fix:* the Logs mock, or a
  service-name map.
- **No DOM tests.** The repo has no jsdom, so clicks, keys and focus (expand, `rule_id`, snooze
  then Undo, every focus hand-off) were checked by hand in the browser, last in 7c.
  Markup and logic are tested. *Fix:* a DOM environment for the suite.
- **Two handoff modules.** `components/alerts/list/handoffs.js` overlaps `rule/handoffs.js`.
  *Fix:* merge them into one.
- **Undo rides inside the toast's message**, because `Toast` has no action slot. *Fix:* an action
  slot on `Toast`, when another page needs one too.
- **Browser cards can't make a rule.** Their "Create Alert" says why: the metrics store has no
  browser metrics, and a rule on the app's raw RUM events would not watch what the card shows.
  *Fix:* browser metrics in the store, then a payload like the service cards'.
- **An anomaly rule needs a profile.** Its expected range comes from the incident profiles, so an
  anomaly rule on a Code or Advanced query has no band and never fires. *Fix:* a trailing mean ±
  σ from the series itself, in `alertsEngine.js`.
- **A wide engine preview blocks briefly.** The first 7-day preview of a Code, Logs or Traces
  query costs about 0.8 s on the main thread; the cached chunks make later ones cheap. *Fix:* a
  worker, if it matters with real data.
- **One extra Back step after the guard.** Leaving a dirty editor any way other than Back leaves
  the guard's copy of the entry behind, so Back from the next page passes through the editor's URL
  once. *Fix:* a data router and `useBlocker`, when the app moves to one.
- **The mock rewrites delivery history from the current routing.** Fix the broken webhook's URL and
  its last delivery reads "Sent" at once, because the log is regenerated from today's settings. A
  real backend keeps the failure until the next send. *Fix:* none until real data.
- **A mute schedule has no Rules filter.** Its "Used by" lists the rules as links; a contact point's
  also opens Rules filtered by it. *Fix:* a schedule facet, if wanted.
- **A week's Insights have no comparison.** The previous week lies past the 8-day evaluated
  history. *Fix:* a longer horizon, or real data.
- **The log's payload is reconstructed.** The log keeps no message body, so the expanded row shows
  what Alertmanager would have received, built from the row. *Fix:* a stored body, if the
  backend keeps one.
- **The log scrolls sideways below about 1,000 px** rather than drop its Why column.
- **The mock's now is fixed at load.** Evaluation, the incident and every relative time hang off
  `BASE_TIME`, so leaving the page open advances nothing, and Refresh re-reads without
  re-evaluating. A reload re-anchors the clock and draws new jitter: "15.6% now" can read 13.9%
  after one. *Fix:* none until real data replaces the mock.
- **A contact point in use can't be retired in one step.** Delete is refused until no rule sends
  there, and moving rules means editing each. P7's bulk changes fixed this and were removed on
  review. *Fix:* bulk re-routing, if wanted again.
- **On a tablet-width window** Insights' table and the notification log scroll sideways.
- **The app's, found by 7c:** focus stays on the page after a route change, and there is no skip
  link; a facet group's header collapses on click only; the toast's 4.5 s does not pause on hover
  or focus. *Fix:* the app shell, `FacetGroup` and `Toast` (each raised as its own task).

## Needs from the backend

Discovered while studying production. None blocks the prototype, which simulates them; each blocks
integration in the phase shown.

| Need | Why | Production today | Phase |
|---|---|---|---|
| Event type on alert-log rows: fired / resolved / reminder | D12's Event column; reconciling the log with state | Rows carry only `status` (SUCCESS / ERROR / MUTE / SNOOZE) | P6 |
| `receiver_group_id` on alert-log rows | A contact point's delivery health | Rows carry type and raw target only, so matching by target is fragile | P5 |
| Annotations (`summary`, `description`, `runbook_url`) on the write schema | D8's description and runbook | Readable on rules, never written by the UI | P4 |
| Pending history | Hatched pending stretches on the timeline | The `ALERTS{alertstate="pending"}` series likely exists; confirm | P2 |
| Display only, no backend change | `lastError` for Rule error, `lastEvaluation` for "last evaluated" | Returned, never displayed (R8) | P2–P3 |
| SLO burn-rate rules, listed or derivable | D18 shows them read-only beside user rules | Generated server-side from `/slos`; the rules API doesn't return them (inferred) | P2 |
| Snooze author and reason | D10's Reason note; who snoozed | Silences take `createdBy` and `comment`; the UI sends empty strings | P5 |
| Series count per rule | D1's **No data**: a rule whose query returns no series is not OK | The rules API answers `inactive` for both; the mock adds `seriesCount` | P2 |

## Risks

- **The editor is the largest piece.** Mitigation: reuse Explore's editors rather than rebuild,
  and land P4 in its batches; 4a–4c alone make a usable editor.
- **`status.js` is load-bearing** (CLAUDE.md). Mitigation: additive changes only, each with tests.
  Existing resolvers are untouched.
- **Calibration drift.** Alerts must agree with the figures `services.js` publishes at Last 1 hour.
  Mitigation: P1's tests pin them, the way Explore's metrics store is pinned.
- **Vocabulary churn** for people who know production (new tab labels, Q1). Mitigation: labels
  only; URLs and API names stay.
- **Prototype edits outliving their seed** (`localStorage`, Q9). Mitigation: a versioned overlay
  that discards itself on mismatch.
- **Moving two live pages onto `ViewTabs`** (1j). Mitigation: a markup-identity test before and
  after, as `sharedUi.test.js` does for `SortableTable`.

## Beyond production — ideas held for later

Not in any phase above. Recorded so they are not re-invented, and so P1's data shapes don't rule
them out.

- **Coverage matrix:** services × golden signals (Error %, p90 latency, RPM drop), showing where a
  rule exists, with "Create" in each empty cell, defaulting to `status.js` thresholds. It answers
  the benchmark's "set an alert rule (2 of 7 services)".
- **Suggested rules** on an empty Rules tab or a service with no coverage: "payment-service has no
  error-rate rule. Add Error % > 3% critical, > 1% warning, for 5m."
- **Correlated firing:** rules whose bars start within a few minutes of each other on the timeline
  are marked as likely one incident ("payment-service error rate and p90 latency started together
  at 15:13").
- **Per-series snooze** from an instance row, using silence matchers.
- **Rule change history:** who changed what and when.
- **Rules as code:** export and import as YAML.

## Status

### Logic layer (P1)

| Module | State | Tests |
|---|---|---|
| `src/data/alerts.js` — production-shaped seed, evaluation, timeline, log, stats, chart series | done | `data/alerts.test.js` 19 |
| `src/utils/alerts/model.js` — API → view model | done | `model.test.js` 13 |
| `src/utils/alerts/condition.js` — tiers, evaluation, backtest | done | `condition.test.js` 23 |
| `src/utils/alerts/describe.js` / `template.js` / `catalog.js` — sentence, units, names, lists | done | `describe.test.js` 11 · `template.test.js` 7 |
| `src/utils/alerts/routing.js` — receivers, mutes, silences, time zones | done | `routing.test.js` 7 |
| `src/utils/alerts/store.js` / `src/hooks/useAlerts.js` — overlay store, actions with Undo | done | `store.test.js` 12 |
| `src/utils/status.js` — `statusForAlertState`, labels, exports | done | `status.test.js` 14 |
| `src/utils/alertsUrl.js` — production dialect | done | `alertsUrl.test.js` 16 |
| `src/components/charts/` — threshold and interval overlays (P3 session) | done | `chartOverlays.test.js` 8 · `thresholdBands.test.js` 13 |
| routing, sidebar, App branch, `PageBar`'s `showTime` | done | `route.test.js` 19 · `AlertsView.test.js` 6 · `PageBar.test.js` 2 |
| `src/data/alertsEngine.js` — rules bound to Explore's engines (P4) | done | `alertsEngine.test.js` 3 · `data/alerts.test.js` +4 |
| `src/utils/alerts/editorDraft.js` / `editorPayloads.js` / `muteWeek.js`, `src/utils/leaveGuard.js` (P4) | done | 12 · 5 · 3 · 3 |
| `src/utils/alerts/configViews.js`, `lastDeliveries`, `statusForDelivery`, `renderWebhookPreview` (P5) | done | `configViews.test.js` 7 · `status.test.js` +1 · `template.test.js` +1 |
| `alertPayloadForExplore` and the error alert on the counter, `service/serviceSuggestion.js`, `shared/useFocusHandoff.js`, `radioGroupKeyDown` (P7) | done | `editorPayloads.test.js` +2 · `platformAlerts.test.js` 4 · `alertShared.test.js` +1 |

### UI layer

| Surface | Phase | State |
|---|---|---|
| Shared `ViewTabs` (service page and Browser moved onto it) | P1 | done; identity pinned in `sharedUi.test.js` |
| Alerts shell and editor placeholder | P1 | done; browser-verified 2026-10-16 |
| Rules tab (band, timeline, table, inline details) | P2 | done (second session); see P2 |
| Rule page | P3 | done (second session); see P3 |
| Rule editor and entry points | P4 | done; `AlertEditorView.test.js` 6 · `alertEntryPoints.test.js` 2; browser-verified 2026-10-17 |
| Contact points, mute schedules, snoozes | P5 | done; `configTabs.test.js` 5 · `configViews.test.js` 7; browser-verified 2026-10-21 |
| Insights, Notifications | P6 | done; `learnTabs.test.js` 3 · `insights.test.js` 3 · `notificationLog.test.js` 4; browser-verified 2026-10-21 |
| Platform integration, verification, docs (bulk actions built, then removed on review) | P7 | done; `platformAlerts.test.js` 4 · `alertEntryPoints.test.js` 3; every journey walked by keyboard in the browser 2026-10-21 |

The whole suite on 2026-10-21, after P7: 107 files, 1,535 tests, all passing. One test outside the alerts work, `eventsStore.test.js` "payment spans go slow and go red", fails at some load times and passes at others; it is flagged as its own task. Every alert suite passes at 54 instants across a day (38 files, 2,052 runs). Lint and the build are clean.
