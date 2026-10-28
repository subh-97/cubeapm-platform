# The Alerts module

Three routes in production's own paths: `/alerts` (sidebar → Alerts) with five tabs — Rules,
Insights, Contact points, Mute schedules, Notifications — a page per rule at `/alerts/:id`, and the
editor at `/alerts/new` and `/alerts/:id/edit`. It answers "what is firing, why, and who was told",
and lets a rule be made from wherever a problem is noticed. It keeps production's journey and URL
dialect and renames only labels — the Errors and Browser method.

The study, the plan and the design live in `docs/alerts/`: `reference/production.md` (what the
production module does, its 19 journeys and 47 defects R1–R47), `PLAN.md` (the phases, as built)
and `DESIGN.md` (decisions D1–D18, signed off 2026-10-15, binding). What follows is what is worth
not re-deriving.

## Production's dialect is the state

- **Paths and keys stay production's**: `?tab=` takes `alerts`, `alert-stats`, `receiver-groups`,
  `mute-groups`, `alert-logs`; `rule_id` filters the notification log; `alert_id` names the
  instance a notification links to. `utils/alertsUrl.js` reads and writes them, with the facets
  (`ALERTS_FACET_KEYS`), spaces as `+`. A link from production opens the same view here.
- **Create-from-context travels as app state, not the URL** (sign-off Q8): `openLink({ view:
  'alertEditor', … })` puts the payload in App state with a nonce and navigates to `/alerts/new`;
  the editor reads it once. A URL that carried a query and thresholds would be a second, longer
  dialect for the same thing.
- **No data router**, so there is no `useBlocker`. A dirty editor guards leaving through
  `utils/leaveGuard.js` (App's sidebar, Home and logout ask it), `beforeunload`, and Back (it pushes
  a duplicate entry and steps back over it).

## One store, production-shaped, holding only the viewer's edits

- **The seed is rebuilt on every load**, relative to `BASE_TIME`, so "snoozed 19 minutes ago"
  stays 19 minutes ago. What is saved (`localStorage`, versioned by `SEED_VERSION`, sign-off Q9) is
  only an overlay of edits keyed by id. Saving the whole state would freeze the seed's relative
  times at the moment of the save.
- **Every action returns its own undo** (`utils/alerts/store.js`), or null when it changed
  nothing, which is how a toast never claims a success that didn't happen.
- **One store behind every caller** (`useAlerts`, `useSyncExternalStore`), so an edit on the rule
  page is there on Home and on the service page without a refetch.
- **SLO burn-rate rules are derived, not stored** (`ruleDefsFor` adds them from the SLOs), which is
  why they can be listed and snoozed but not saved (D18).

## One evaluator answers the history, the preview and the charts

- `data/alerts.js` runs Prometheus's state machine (pending → firing, `for`, resolve) over an
  8-day horizon on ticks aligned to the epoch. A rule's checks are `max(15 s, its interval)` apart.
- **A rule's chart reads the evaluator**, at each bucket's close on the rule's own schedule, the
  newest bucket at now, rounded by the same `reading()` as the alert values. A chart drawn from the
  raw series instead disagreed with the chip beside it by a tick.
- **The editor's preview runs the saved rule's evaluator** (`previewRule`), so "would have fired 4
  times" is the answer the rule's page gives once it is saved.
- Two bindings feed it: profiles (the seeded rules and Quick models, calibrated so Last 1 hour
  matches `services.js`), and Explore's engines (`data/alertsEngine.js`, 6-hour chunks aligned to
  the epoch) for any other query typed into the editor.
- **A count of spans is sampled; a counter is not.** The event store keeps 24 rows a bucket, so a
  count of one exception there is sparse — and at some load times empty for a whole hour, while
  the Errors drawer beside it counts hundreds. "Alert on this error" therefore watches the metric
  counter `cube_apm_errors_total` for that service and exception, as errors a minute, which reads
  at every minute and follows the same incident as the Errors page's figures. The design named
  the Traces source; the fake-clock sweep across a day is what showed the gap.

## Colour

- `statusForAlertState()` and `statusForDelivery()` in `status.js` are the only way an alert state
  or a send becomes a colour (rule 1). A firing alert with no severity label is a warning
  (sign-off Q2).
- **States someone may have to act on are solid** (critical, warning, pending, rule error); OK, no
  data and paused recede to a tint. On a solid fill the ink holds 4.5:1: the darkest ink on the
  dark theme's bright red and blue and on amber in either theme; white on the light theme's deeper
  red and blue, and on slate.
- Series use the chart palette (rule 2). Selection uses the brand tint, never a status hue.

## The Rules tab

- **What is firing comes first**: the timeline above the list, there while an unsilenced rule
  fires, headed "Recent Timeline" with the range in short and its lanes counted ("Last 1 hr · 7
  critical · 8 warning") and a chevron; the whole line is the button that folds the timeline to
  it. It arrives folded (2026-10-24; open only when a quiet day's "Show timeline" brought it), and
  the fold is not remembered. "Drag across to zoom" moved to that line's title. The list is
  sorted by severity (rule 3), so the worst rule is the first row. The list folds each
  group's paused rules into one line, and rows expand in place as production's do (sign-off Q5);
  the name stays a link. The band's state pills and worst-incident banner were removed on
  2026-10-21, as was the Rules tab's "23 · 12 firing" count: the State facet and the first row
  already said the same.
- **Two labelled menus per row**, Snooze and Actions, replace production's seven icon-only
  controls (R11). An item a rule does not allow stays, disabled, with the reason as its title.
- **Two ways to make a rule open the tab**, side by side above the timeline: "Create a rule from a
  template" (white; it opens the template drawer, below) and "Create a rule from scratch" (the
  brand's blue; a blank editor). They replace the toolbar's
  New rule button, removed on review (2026-10-23): the toolbar is the search alone. With no rules
  at all, the empty state still offers New rule, and `n` still starts one.
- **The template drawer** (`TemplateDrawer.jsx`, 2026-10-26) is production's "Alert templates"
  drawer in our language, built on the config drawer, the `.svc-search` box, `EmptyState` and a
  new shared `FilterChips` (capsules: All, then each category with its mark). Sixteen templates
  (`utils/alerts/ruleTemplates.js`) in five categories by what a rule watches — Services 5,
  Dependencies 3, Logs 2, Hosts 2, Kubernetes 4 — where production lists a category per Kubernetes
  object and placeholder "Dummy" ones. The capsules count what the search leaves, and a search
  that empties one offers the matches in the others. A card gives its source (the vendor's mark
  for infrastructure, the sidebar's glyph for APM and Logs), what it does in one sentence, and the
  condition in the rule list's own words ("Error % > 3% critical, > 1% warning, for 5m · one alert
  per service"); a template whose query a rule already runs is marked In use. The card is the
  button: its primary "Use template" has an `::after` that covers the card, as the banners' CTAs
  do. Each card first also previewed what the template would have done over the page's range (a
  strip and "Would have fired once in the last 1 hr, on 2 of 7 services"); that came out on
  review the same day, and the editor's preview, one click on, says it. Every query was still
  checked against the demo's data at every hour: nine catch the payment incident, five stay quiet,
  none fires outside the incident, and the two that need kube-state-metrics are kept rather than
  left out (`needs` in the catalogue; the editor's preview shows they have no data here). The log counts swing with the time of day more
  than the incident moves them, so the log templates sit above the busiest quiet hour. Templates
  set what payloads could not before: an anomaly rule (`kind`) and a check interval
  (`intervalSec`); and the rule list names their measures ("Redis clients", "Calls vs an hour
  ago", "K8s event count") instead of "Value".
- **No row selection, no bulk changes.** 7b built them — a select box per row and a bar that
  paused, snoozed, moved, re-routed or deleted the selection as one change with one Undo — and on
  review (2026-10-23) they came out, with the count line above the rules. A rule is changed from
  its own menus, or its editor. Nothing sits between the toolbar and the rules.

## The rule page and the editor

- **The rule page explains before it asks**: a banner with the condition and the value against
  it, threshold bands on the chart, the state strip, the instances, and handoffs (traces, logs,
  errors, the service, Explore) that all go through `openLink`, as Errors' do.
- **The editor is one page** with production's four stages as sections and a preview that stays in
  view (stacked below 1280 px). It reuses Explore's `MetricsEditor` and `LogsEditor` and their
  models, so every entry point's payload is an Explore-shaped model the editor already reads.
- **Save always answers**: with something missing it lists what, each item moving focus to its
  field; saved, it lands on the rule's page.
- Insights' Tune opens the editor with focus on the thresholds, where the preview already offers
  one for the same range.

## Entry points in

Each builds its payload in `utils/alerts/editorPayloads.js`, beside the others:

| From | What opens | Why so |
|---|---|---|
| A service card's ⋮ → Create Alert | Quick model of the card's metric, at the `status.js` thresholds that colour it, `>=`; named and filed with the service's other rules | The rule fires exactly when the card turns amber or red; a model, never a raw query, so production's `$__…` placeholder trap cannot happen |
| An Infrastructure host's CPU chart | Advanced `system_cpu_utilization × 100` at the host table's 70 % / 85 % | The metric Explore reads |
| Logs and Traces bars | The bar's LogsQL, plus `\| stats count()` when it has no pipe | What production does |
| Errors drawer → Alert on this error | `sum(rate(cube_apm_errors_total{service, exception})) * 60` as an Advanced model, above 1/min for 2 minutes, read as "JedisPoolException rate" | A quiet hour ticks at a fraction of one a minute, the incident at dozens; see "A count of spans is sampled" |
| Explore → Create alert | The active tab's model while the chart still draws it, else the committed query in Code | `committedQuery()` is a `{ datasource, query }` pair; only its query is compared or sent |
| Home | A nudge about the worst firing rule — its name, its value against its threshold and for how long, Open rule; nothing while nothing fires | A firing incident was a module away. A quiet tinted card, not a red bar: the table below already leads with the incident. An alerts pill, a coverage line and Home's summary strip came out on review |
| Service settings drawer | The drawer's mock Alerts tab is now the service's rules plus Create | Create offers what the service lacks — error rate, then p90 latency, then throughput — never a copy. A "6 rules · 5 firing" header link came out on review |

Mobile Traces lists the item disabled ("Mobile alerts aren't available yet"; deferred at
sign-off), and Browser cards say browser metrics come later.

## Keyboard and focus

- `/` searches, `n` starts a rule, ↑/↓ move between rows, Enter and Space expand, Esc closes.
- **Focus never drops to the page when its control leaves**: a row paused into its fold or deleted
  hands focus to the row that took its place, a deleted contact point or schedule to the next one
  (`shared/useFocusHandoff.js`), and PagerDuty's connect swap to the new state. A destination card just added takes focus at its
  first field, and a Save that can't go through — in the editor or either config drawer — moves
  focus to the first thing left to finish.
- **⌘Z (Ctrl+Z) undoes** while an Undo toast is up and focus is not in a field. The toast sits
  after the whole page in tab order, so its button cannot be reached in the 4.5 s it shows.
- Seg-toggle radio groups are one Tab stop with arrows between options (`radioGroupKeyDown`).
- **Narrow windows**: the tab strip tightens below 1100 px and drops its icons below 860 px; the
  Insights' table fits its card and wraps rule names, so Tune stays in
  view.

## Loading

The three pages load as their own chunk — about 240 kB (78 kB gzipped) that no other page needs —
behind `AlertsPageSkeleton` in each page's shape. The data module itself is in the main bundle,
because Home and the service page read `useAlerts`.

## Where it deliberately differs from the original

Labels, not paths: Rules / Insights / Contact points / Mute schedules / Notifications. Severity
order instead of alphabetical; firing first; paused folded. Every control labelled. SLO burn-rate
rules listed (read-only) beside user rules. Every change confirms in a toast, the reversible ones
with Undo; deletes say what they do. A contact point in use says why it can't be deleted and
lists the rules that still send there. Insights flags always-firing, flapping and never-fired rules,
with Tune. The notification log says which event each send was and why a held or failed one was.
The editor is one page with a live preview. Create-from-context prefills thresholds, name and
group; production prefills none. A template says whether a rule already uses it. Nothing waits
for a Search click (rule 5).

## Known gaps

- **Explore can't read #437's query**: `(x default 0)[5m]` doesn't parse in Explore's PromQL
  worker.
- **One extra Back step after the leave guard**, until the app has a data router.
- **The mock rewrites delivery history from today's routing**, so fixing a broken webhook reads
  "Sent" at once.
- **A mute schedule has no Rules filter**; its "Used by" lists the rules as links.
- **A week's Insights have no comparison**: the previous week is past the 8-day horizon.
- **The log's payload is reconstructed** from the row, and the log scrolls sideways below about
  1,000 px rather than drop its Why column.
- **The mock's now is fixed at load**; a reload re-anchors it and draws new jitter.
- **A contact point in use can't be retired in one step**: Delete waits until no rule sends
  there, and moving the rules means editing each (bulk changes were built and removed on review).
- **App-wide, not Alerts'**: focus lands on the page after a route change and there is no skip
  link; a facet group's header collapses on click only; the toast's 4.5 s does not pause on hover.
- **Waiting on other pages**: the Monitors page's bell, "Edit in SLO", and the Mobile datasource.
