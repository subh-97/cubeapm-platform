# Alerts — design direction

Companion to [PLAN.md](PLAN.md) (the phases) and [reference/production.md](reference/production.md)
(what the production module does, studied on 2026-10-15).

**Status: signed off on 2026-10-15** (answers under "Decisions taken at sign-off", at the end).
This file is now binding the way `docs/explore/ARCH.md` is for Explore: where it and the reference
disagree, this file wins; where it is silent, follow the reference.

Each decision says what production does, what we considered, what we chose and what it costs.
Figures in the sketches are illustrative; P1's data tests fix the real ones.

## What stays exactly as production has it

Everything a link, a habit or the backend can see. This is the Errors and Browser method: keep the
journey and the dialect, rename only labels.

- **Paths and keys.** `/alerts`, `/alerts/new`, `/alerts/:id`, `/alerts/:id/edit`; `?tab=` with the
  values `alerts`, `alert-stats`, `receiver-groups`, `mute-groups`, `alert-logs`; `rule_id` (the
  notification log's rule filter); `alert_id` (the instance a notification links to); `time`.
- **The editor's four stages, in order:** Query → Settings → Receivers → Mutes & Permissions, and
  what is inside them: Static / Anomaly; Metrics / Logs / Traces / Mobile; Quick / Advanced / Code
  and Builder / Code; the six static operators and three anomaly operators; the option lists for
  evaluation interval, wait-for and repeat-after; the seven receiver types; the snooze presets
  (5m / 15m / 30m / 1h / Custom); the notification statuses (SUCCESS / ERROR / MUTE / SNOOZE).
- **The object model and its field names** (rule, receiver group, mute group, silence, alert log).
  The prototype's data module returns production-shaped JSON (D15), so wiring the real backend
  swaps a source rather than rewriting a page.

## Rules that apply throughout

CLAUDE.md's six, as they land on this module:

1. **Colour goes through `status.js`.** A new `statusForAlertState()` (D1) is the only way an alert
   state becomes a colour.
2. **No status hues on series.** A query's lines use the chart palette. Severity colour is reserved
   for things that *are* a severity: state chips, threshold bands, timeline bars. Production draws
   the rule's series in green; that goes.
3. **Severity first.** Groups and rows sort firing-critical → firing-warning → pending → rule error →
   suppressed-but-firing → OK → no data → paused. Production sorts groups alphabetically, which
   buries the only firing group last.
4. **Every control has a label.** Production's rows carry seven icon-only controls (a switch and six
   buttons) whose names exist only in hover tooltips. They become a labelled **Snooze** button and a
   labelled **Actions** menu (D3).
5. **Auto-load.** The list, the rule page and the editor's preview load without a click. "Generate
   Graph" becomes automatic on a short debounce, with a manual refresh beside it.
6. **Comparison context.** A value is shown against its threshold ("4.7× the 3% threshold") and
   against the previous period; counts of incidents and firing time carry a delta.

## Vocabulary — one word per idea

Production uses three words for suppression (Snooze, Mute, Silence), two for the same delay ("Wait
for", "Wait before firing") and calls a rule page "Alert". Labels change; URL values and API names
do not.

| Production | Here | Why |
|---|---|---|
| Alerts (tab) | **Rules** | The tab lists rules. An *alert* is what a rule raises. |
| Stats | **Insights** | It answers "which rules are noisy"; flags say what to do (D11). |
| Receiver Groups | **Contact points** | A named set of destinations, in plain words. "Receiver" is Alertmanager's term. |
| Mute Groups | **Mute schedules** | They are recurring windows, not groups of anything. |
| Notification History | **Notifications** | Same content, shorter tab. |
| normal (API `inactive`) | **OK** | One word for "condition not met". |
| firing | **Critical** or **Warning** | The state chip names the severity (D1). |
| Wait for / Wait before firing | **Fire after** | One phrase that says what it does. |
| Repeat after | **Re-notify every** | Says what repeats. |
| Notification Grouping On / Off | **One notification for all series / One per series** | Says what each choice sends. |
| Additional Condition (optional) + tag `severity=critical` | **Critical threshold** | It is a second tier, not an afterthought (D7). |
| Health: ok / err | hidden / **Rule error** | Health only matters when it fails. |
| Alert (rule page title) | the rule's name | |

After the renames "group" means one thing, a rule's folder. In production it means four: the rule's
Group, Receiver Groups, Mute Groups and Notification Grouping.

**Durations** are written three ways, one function each, in `utils/alerts/describe.js`:

- A setting reads as production's selects write it: "30s", "5m", "1h30m", "24h", with no spaces
  (`formatDuration`). The chips, the details and the editor's summaries all show settings this way.
- Elapsed time reads as people say it, two units at most: "45s", "13m", "2h 5m", "3d 4h"
  (`formatElapsed`). "Firing for", "since" and a bar's length use this form.
- Inside a sentence a duration is spelled out: "for 5 minutes", "every 1 hour 30 minutes"
  (`durationWords`).

The renames were adopted at sign-off (Q1).

**The tab strip is the service page's.** Alerts uses the same `.card-tab-strip` with icon + label
`.view-tab` buttons that APM & Services and Browser use, not the pill `TabBar` or production's
segmented radio. Before P1 that strip was markup copied into two pages:

- **Browser's** was the complete copy: roving `tabIndex`, arrow keys, `aria-controls` and a
  `role="tabpanel"` body.
- **The service page's** had none of that.

So the strip is extracted once, from Browser's version, into a shared `ViewTabs` component
(`components/shared/ViewTabs.jsx`, with its id helpers in `viewTabIds.js`). It takes
`{tabs: [{id, label, Icon, count?}], active, onSelect, ariaLabel, idPrefix?, tabRefs?, className?}`
and adds an optional count after the label for "Rules 23 · 13 firing". Alerts uses it, and both
existing pages moved onto it, rendering the same markup they did before, pinned in
`sharedUi.test.js`.

**Keyboard navigation comes with `idPrefix`.** With one, the strip is Browser's full tablist: tab
ids, one Tab stop, arrows plus Home and End to move, Enter or Space to open. Arrows only move focus,
because opening a tab is a new screen. Without one, it is the service page's plain strip, unchanged.
Browser (`brw-tab`) and Alerts (`alr-tab`) pass one. The service page does not yet, so its markup
stays identical; giving it the full pattern is a one-line follow-up. The method is the one
browser-page.md calls "Shared pieces extracted for it".

Suggested icons, all from Lucide:

| Tab | Icon |
|---|---|
| Rules | `BellRing` |
| Insights | `ChartColumn` |
| Contact points | `Send` |
| Mute schedules | `CalendarClock` |
| Notifications | `History` |

## D1. The state model, and its colours

Production has one state field (`firing`, `inactive`, `pending`), a separate `status`
(`ACTIVE` / `PAUSED`), a `health` (`ok` / `err`), and suppression that lives elsewhere (silences
and mute windows). It shows only "normal" and "firing", and every firing alert is red.

We read two dimensions, because suppression changes who gets told, not what is true:

- **Evaluation state:** Critical, Warning, Pending, OK, No data, Rule error, Paused.
- **Suppression overlay:** Snoozed (until a time) or Muted (by a schedule, until a time).

| State | From | Status (via `status.js`) | Label |
|---|---|---|---|
| Firing, `severity=critical` | `alerts[].state = firing` | critical | Critical |
| Firing, any other severity | `alerts[].state = firing` | warning | Warning |
| Pending | `state = pending` | info | Pending |
| OK | `state = inactive` | healthy | OK |
| No data | query returns no series | neutral | No data |
| Rule error | `health = err` | neutral, with an icon and the error text | Rule error |
| Paused | `status = PAUSED` | neutral | Paused |
| + Snoozed / Muted | silence or mute window | neutral secondary chip | Snoozed · 23m left / Muted until 07:00 |

- **Additive to `status.js`.** `statusForAlertState()` and `ALERT_STATE_LABELS` are added and
  tested like `statusForWebVital` and `WEB_VITAL_RATINGS`. The relabelling follows the same
  precedent. `THRESHOLDS` gets exported, so a rule created from a service card defaults to exactly
  the thresholds that turn that card amber or red.
- **Roll-up uses the alert order, not `worstStatus`.** Instances roll up to their rule, and rules
  roll up to their group, in rule 3's order. `worstStatus` ranks healthy above info, so a rule
  with one pending and one OK instance would read OK. For alerts, pending outranks OK. The order
  lives with the alerts model (`utils/alerts/model.js`), not in `status.js`.
- **A rule error sorts above OK.** A rule that cannot evaluate is a silent hole in coverage. The
  summary strip counts it separately ("1 rule can't evaluate").
- **A firing alert with no severity label reads Warning.** "Everything firing is red" is the
  inverse of the review's finding #2: when every alert has the same colour, the colour carries no
  severity. The cost is that production's demo rule shows amber here and red there. Accepted at
  sign-off (Q2).

## D2. The landing: what is firing comes first

Production lands on rules grouped by `group`.

- **Groups sort A→Z and start collapsed**, unless there is exactly one. Inside a group, rules do
  sort firing-first.
- **Firing shows only** as a count per group and a red badge per rule.
- **"Recent Alerts" starts collapsed**, and when its chart arrives late it pushes the table down.
- **Background polls fail loudly but nowhere useful.** The list polls every 30 s on its own timer,
  ignoring the auto-refresh setting beside it, and each failed poll adds a toast.

- **(a) Restyle the grouped table.** Parity, but the triage problem stays.
- **(b) A separate "Firing" tab as the default.** A clean split, but it adds a tab no production
  link knows, and it separates a rule from its state.
- **(c) A "Firing now" band above the rules list.** **Chosen** (Q3).

```
CubeAPM / Alerts                                        [↻ Refresh] [Auto: Off ▾] [Last 1 hour ▾]
[Rules 14 · 4 firing] [Insights] [Contact points 3] [Mute schedules 2] [Notifications]
┌ Firing now ───────────────────────────────────────────────────────────────────────────────┐
│ [2 Critical] [2 Warning] [1 Pending] [1 Rule error] [1 Snoozed/muted] [7 Paused]  ← filters │
│ ▌payment-service error rate — 14.2% now, 4.7× its 3% critical threshold, firing for 13m     │
│ ▌Payments · notified Payments on-call twice   [Open rule] [Failing traces] [payment-service]│
│ Timeline   15:40 ───────────────────────────────────────────────────────────────── now      │
│ payment-service error rate   ·································▒▒██████████████████            │
│ payment-service p90 latency  ··································▒▒█████████████████            │
│ order-service p90 latency    ········▒▒███████··········▒▒█████████████████████            │
└────────────────────────────────────────────────────────────────────────────────────────────┘
┌ Filters ─────┐ ┌ Search rules  name: group: service: label:      Group by [Group ▾] [+ New rule] ┐
│ State        │ │ ▾ Payments                                          3 rules · 2 firing           │
│ Severity     │ │   [Critical] payment-service error rate                                        │
│ Group        │ │              Error % > 3% critical, > 1% warning, for 5m · payment-service      │
│ Service      │ │              14.2%  4.7× ↑ vs 0.4% · firing 13m · Payments on-call               │
│ Source       │ │                                                       [Snooze ▾] [Actions ▾]    │
│ Notifies     │ │   ‖ 1 paused rule ▸                                                              │
│ Status       │ │ ▾ Checkout …                                                                     │
└──────────────┘ └──────────────────────────────────────────────────────────────────────────────────┘
```

- **Summary counts** use the SummaryStrip pattern from Home (`.summary-pill.*`). Each pill is a
  filter shortcut.
- **One incident banner** (`IncidentBanner`, the style guide's "surface an active-problem
  explanation" pattern) shows the worst firing alert as a sentence: its value against its
  threshold, how long it has been firing, and one-click handoffs.
- **When nothing fires**, the band collapses to one line: "Nothing firing · last alert resolved 3h
  ago." The timeline then opens only on request.
- **Time scope is labelled.** State is always *now*; the timeline, sparklines and incident counts
  cover the picked range. Production's header time picker silently applies to some panels and not
  others.
- **Revised 2026-10-21: no title, pills or banner.** On review, the band's "Firing now" title,
  its summary pills and its incident banner came out. The State facet's counts and the first row,
  sorted worst first, already say what is firing now. The Rules tab's own count ("23 · 12 firing")
  went the same day; the configuration tabs keep theirs. The band is now the stale
  line, and then either the timeline (open while an unsilenced rule fires) or, when nothing fires,
  the one line above. "Updated …" moved to the page bar (D16). With no state left in the band, its "state as of now" label
  went too; the timeline's head names its range. The sketch above predates this. Home's alert card
  still leads with the worst firing rule (`worstFiring`, `bannerFacts`).

## D3. The rules list

**Frame.** The explorer frame from ErrorsView: a facet rail, a search bar and results. The
benchmark's complaint was that "every offering re-teaches its own filter pattern", and this is the
pattern Logs, Traces and Errors already teach. Rows expand in place, as production's do (Q5).

**Facets.** State, Severity, Group, Service, Source (Metrics / Logs / Traces / Synthetic / SLO;
D18), Type (Static / Anomaly), Notifies (contact point or integration), Status (Active / Paused) and
Suppressed. Facets carry counts and keep values at 0 when a link seeds them, as on Errors.

**Search.** `TableQuerySearch` with `name:`, `group:`, `service:`, `label:` and free text, the same
`field:value` language as Home and Infra.

**Group by.** Group (the default, as production) | Service | Contact point | None. "Service" is read
from the query's `service` matcher using our PromQL and LogsQL parsers. A Code-only rule without one
lands under "No service". Decided at sign-off (Q7): derived only, no service field in the editor.

*Revised 2026-10-21: no Group by.* The control is gone. Grouping is a classification people make,
the group they put a rule in, not one derived from its service or its contact points, so the list
always groups by each rule's own group. The Service facet and the `service:` search still narrow by
service (Q7 stands for those), and an old link's `group_by` is read past. "New rule" is the app's
primary action button, `.hbtn.primary.run-btn`, as Run is on Logs and Traces. *Revised 2026-10-23:*
New rule left the toolbar for two banners above the timeline, "Create a rule from a template" and
"Create a rule from scratch"; the toolbar is the search alone.

**Row anatomy:**

| Element | Content | Replaces |
|---|---|---|
| State chip | `StatusBadge` with D1's label, plus a suppression chip when one applies | "normal" / "firing" badge |
| Name | A link to the rule page; the group is muted beside it | plain text |
| Sentence | `Error % > 3% critical, > 1% warning, for 5m`, from `describe.js` | raw PromQL in the expanded row |
| Scope | Service · endpoint · host chips | (none) |
| Value | `14.2%` coloured by state, `4.7×` threshold, a sparkline over the range, and a delta vs the previous period | `0.29535866` |
| Since | "Firing 13m" / "OK for 3d" / "Last fired 2h ago" | (none) |
| Notifies | Contact points as icon + name | (in the expanded row) |
| Snooze | A labelled menu: 5m / 15m / 30m / 1h / Custom… (firing and pending rows) | icon-only "Snooze" |
| Actions | A labelled menu: Pause/Resume, Edit, Clone, Notification history, Copy link, Delete… | the switch and five icons |

- **Paused rules fold away.** Each group shows "‖ N paused rules ▸" as one line. Seven of
  production's nine demo rules are paused; listing each at full height is the noise that hides the
  one that fires.
- **"Health: ok" disappears.** It appeared on every row in production. Only a failing health
  shows, as the Rule error state.
- **Rows expand in place** (decided at sign-off, Q5; production's behaviour). The drawer we
  proposed was set aside: expansion keeps the rule beside its neighbours, and it is what current
  users expect.
  - **The whole row toggles**, not only the chevron. Production's Collapse is `collapsible: "icon"`,
    so only a small chevron expands it (R12). The row is a button with `aria-expanded`; Enter or
    Space toggles it. The name stays a real link to the rule page, so ⌘-click opens it in a new tab.
    The Snooze and Actions menus don't toggle the row.
  - **The expanded panel is production's details panel, restyled**, with D3's sentence in place of
    raw PromQL:
    - source and type;
    - Check every / Fire after / Re-notify every;
    - Notifies, with contact points as icon + name;
    - mutes and snoozes, with the time left on each;
    - tags;
    - "last evaluated" (R8).
  - **Instances follow**, one row per label set: state chip, distinguishing labels, value against
    threshold with a sparkline, since. Production's "Traces ↗ / Logs ↗" handoffs move onto these
    rows, opening in place rather than a new tab.
  - **The panel's footer** has "Open rule", "Notification history" and "Open in Explore".
  - **More than one row can be open at once.** `rule_id` in the URL expands that rule and scrolls
    it into view, as production does.
  - **The cost:** a long panel pushes the rows below it down. The list keeps its group headers
    sticky, so position is never lost.

## D4. The alert timeline, which replaces "Recent Alerts"

Production stacks the count of firing alerts per rule into an area chart, with a searchable legend.
It answers "how many" but not "which, when, and together with what". Its y-axis is a count
labelled 0.2, 0.4…

**Here it becomes swimlanes:**

- **Lanes and bars.** One lane per rule that fired or pended in the range; a rule with several
  firing series expands into one lane per series. Bars mark firing intervals in the severity
  colour, pending stretches are hatched info, suppressed stretches carry a neutral overlay, and
  small ticks mark notifications sent.
- **Reading a bar.** Hover shows start, end, duration and peak value. A click opens the rule page
  with `alert_id` set and the range focused on that bar.
- **Shared mechanics.** Drag zooms through `useTimeFocus`, as every chart does. Lanes sort by
  severity, then start time. Five lanes show (eight until 2026-10-21), then "Show N more" from the
  series budget, and "Show less" back to five.
- **Severity colour is legitimate here.** The bars are states, not series identities: the same
  reasoning as Home's health strip.

The cost is a new component, plus firing intervals from the data layer. The Insights table and the
notification log are built from those same intervals, so the three can never disagree (D15).

## D5. The rule page

Production's rule page has:

- the title "Alert", not the rule's name;
- the expanded-row summary, now with "Condition: greater than 0.1";
- a read-only query panel whose tabs cannot be clicked;
- a chart with the series in green, only the primary threshold drawn in red and a legend entry
  named "-";
- a "Common:" line.

Its ways out are small and conditional:

- a "Traces ↗" or "Logs ↗" link on an instance row, which opens a new tab at ±5 minutes around
  the alert, for APM-metric and log/trace rules only;
- a "details ↗" icon in the legend, for Quick-model rules only.

It shows no firing history, no notifications, no "firing since" and no last-evaluated time. A
notification's `?alert_id=` link does not highlight the instance it was about; production reads
`notifyTime` and `incidentTime` from such links but ignores `alert_id`.

```
CubeAPM / Alerts / Payments / payment-service error rate          [↻] [Auto: Off ▾] [Last 1 hour ▾]
[Critical] payment-service error rate                    [Snooze ▾] [Pause] [Edit] [Actions ▾]
Error % of payment-service > 3% critical, > 1% warning, for 5m · every 1m · Payments · Payments on-call
▌Firing for 13m. 14.2% now, 4.7× the 3% threshold. payment-service's Redis pool is failing.
▌[Open payment-service] [Failing traces] [Error logs] [Open in Explore]
[Overview] [Instances 1] [Notifications 2] [Definition]
┌ Error % ─────────────────────────────────────────────────── Compare [Previous period ▾] ┐
│ series in palette colours over warning/critical bands; firing stretch shaded; "now" line │
│ state strip ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▒▒███████████  (OK · pending · firing)          │
└──────────────────────────────────────────────────────────────────────────────────────────┘
[Now 14.2% · ↑ vs 0.4%]  [Firing for 13m]  [Incidents 1 · 0 previous]  [Notifications 2]
Recent events: 15:18 Fired · 15:18 Sent to Payments on-call ✓ · 15:13 Pending · …
```

**Tabs:**

- **Overview.** The chart via `LegendLineChart` or `MiniChart` with `overlays` and `yTop`, since
  both already take them. A state strip sits on the same time axis, there are KPIs with deltas, and
  recent events.
- **Instances.** One row per label set: state, value against threshold, since, last notified.
  `?alert_id=` selects and scrolls to its row and isolates its series in the chart.
- **Notifications.** The Notifications tab's component, filtered to this rule.
- **Definition.** The editor in read-only mode, with clickable tabs (this fixes reference bug R3 in
  `docs/explore/reference/metrics-editor.md`), plus the settings, receivers, mutes and access, and
  an Edit button.

**Handoffs out**, each tested the way Errors' are:

- **Service page:** the scope's service.
- **Traces:** filtered by service + endpoint, plus `status_code=ERROR` for an error-rate rule or a
  duration floor for a latency rule.
- **Logs:** the service, at level error.
- **Errors:** the service and endpoint.
- **Explore:** the exact query. This one is always available, so a Code-only rule still has a way
  out.

The banner's root-cause sentence comes from the incident profile the rest of the app already
explains.

**As built (P3), where it differs from the above:**

- **Definition** is a read-only `GeneratedQuery` with a summary of the model, under Quick / Advanced
  / Code (or Builder / Code) tabs that click. Explore's editors are untouched; read-only modes for
  them were not needed.
- **Explore is not always available.** #437's query, `(x default 0)[5m]`, does not parse in
  Explore's PromQL parser. Its "Open in Explore" button is disabled with the title "Explore can't
  read this query yet" instead of opening Explore on a parse error. Every other seeded query
  opens. The fix belongs in Explore's parser.
- **Traces for a latency rule** has no duration floor, because the Traces search has no numeric
  comparison. It lands on the service and endpoint's spans around the alert.
- **Logs for a service rule** lands empty, because the Logs mock names the service `payment` and
  holds no payment error records. A log-source rule (504) lands on its records.
- **Compare** offers Off or Previous period.

## D6. The editor: one page, production's four stages as sections, a preview that stays in view

Production's editor is a four-step wizard:

- the preview draws only on **Generate Graph**;
- the threshold is typed beneath the graph;
- name, receivers and mutes come on later steps, out of sight of the data.

It also has no unsaved-changes guard. Empty rows silently disable **Next** behind a red border.
Switching Code → Quick throws the query away. Dropdowns stay open on Escape, sometimes three at
once. The back arrow is `history.back()`.

- **(a) Restyle the wizard.** Parity, but every problem above remains.
- **(b) One page, Explore's vertical layout:** editor, preview, then the rest. The preview scrolls
  away exactly when `for` and the name, which depend on it, are being set.
- **(c) One page with numbered sections and a sticky preview rail.** **Chosen** (Q4).

```
CubeAPM / Alerts / New rule                                                       [Last 1 hour ▾]
┌ Alert when Error % of payment-service is above 1% (critical above 3%) for 5 minutes, checked ┐
│ every minute. Notify Payments on-call and remind every hour while it fires.  [Cancel][Save rule]│
└──────────────────────────────────────────────────────────────────────────────────────────────┘
┌ 1 Query & condition ───────────────────────────┐ ┌ Preview ─────────────────────────────────┐
│ Type   [Static | Anomaly]                       │ │ series (palette) over warning/critical    │
│ Source [Metrics | Logs | Traces | Mobile]       │ │ bands; where this rule would have fired,  │
│ [Quick | Advanced | Code]                       │ │ shaded                                     │
│ CALCULATE [Error % ▾]  WHERE service = payment… │ │ Would have fired once in this range,      │
│ GROUP BY  [—]          Generated query ▸        │ │ for 13m (22% of it).                       │
│ Warning  when [above ▾] [1 ] %                  │ │ Series · Common: service=payment-service  │
│ Critical when [above ▾] [3 ] %       Remove     │ │ Notification preview ▸                    │
├ 2 Evaluation & details ────────────────────────┤ └───────────────────────────────────────────┘
│ Check every [1m ▾] · fire after [5m ▾] · re-notify every [1h ▾]
│ Name  [{{ .Labels.service }} error rate] [Insert label ▾] → "payment-service error rate"
│ Group [Payments ▾]     Tags [team = alpha ×] [+ Add tag]
├ 3 Notifications ───────────────────────────────┤
│ Notify [Payments on-call ×] [+ Contact point] [+ One-off destination]
│ Send   [One notification for all series ▾]
├ 4 Mutes & access ──────────────────────────────┤
│ Mute during [Quiet hours ×] [+ One-off window]     Access (•) By role  ( ) Specific people
└────────────────────────────────────────────────┘
```

- **The sentence at the top is the rule.** It is generated by `describe.js`. Each bold token jumps
  to its field, so a reviewer can read a whole rule without opening a section.
- **Sections keep production's order and content**, as in "What stays exactly as production has
  it". A completed section can collapse to its one-line summary.
- **Query editing reuses Explore's editors.**
  - Metrics uses `MetricsEditor` (Quick / Advanced / Code). Production renders the same editor
    inside its alert editor (`metrics-editor.md`, "The same `Cne` appears… the alert rule
    editor"). It needs `latencyInMs` threaded through and the "(millis)" labels (divergence #3);
    any incoming model must be stripped of `options` (divergence #2).
  - Logs and Traces use `LogsEditor` (Builder / Code).
  - Mobile is deferred from v1 (Q6). Its button stays in the datasource bar, disabled, with
    `title="Mobile alerts aren't available yet"`, so the four-source layout matches production.
- **Datasource rules hold.** Anomaly accepts Metrics only. The other sources are disabled with a
  `title` that says why, rather than silently greyed out.
- **Log, trace and mobile rules need a closing pipe.** Production saves them as `<query> as result
  | filter result: <op> <threshold>`, which works only if the query ends in a `stats` or `math`
  pipe, and nothing says so. The Builder starts with `stats count()` and the Code tab says when the
  closing pipe is missing.
- **Validation speaks.** A disabled Save lists what is missing, and each item links to its field.
  Leaving with unsaved changes asks first, on both route changes and `beforeunload`.
- **Access (section 4) includes custom permissions in v1** (Q6). These are production's "Role
  Based" / "Custom" choice, and rows of team or user plus Viewer / Editor. Production's rule holds:
  at least one complete Editor row before saving. The playground configures no teams or users, so
  the prototype seeds a few mock ones.
- **One page serves three uses.** New, Edit and Clone share it. Clone prefills "Copy of …" with no
  id.
  - Production's clone also copies a PAUSED status the editor never shows. Ours shows status at
    the top ("This rule will be saved paused") and lets you change it.
- **Saving** returns to the new rule's page with a toast. Production returns to the list,
  silently.

The cost is a wider layout. Below roughly 1280px the preview drops under section 1, Explore-style.

**As built (P4):**

- **The guard needs no data router.** The app runs on a plain `BrowserRouter`, where
  react-router's `useBlocker` is unavailable. A dirty editor registers a guard
  (`utils/leaveGuard.js`) that App's own ways out ask first: the sidebar, Home and sign-out. The
  page covers the rest itself: its crumbs and Cancel, Back (with a copy of its history entry to
  step back onto) and closing the tab (`beforeunload`).
- **What is missing waits for the first Save.** A new rule does not open covered in red. Before
  Save is pressed, only what was typed wrong shows inline: a query that won't run, a threshold
  that isn't a number, a reserved tag. The head always says "N to finish".
- **Status is a two-way control in the head**, Active / Paused, rather than a line that appears
  only for a paused clone.

## D7. Conditions drawn on the chart, and checked against the range before saving

**Static:**

- **Two named tiers.** Production stores the base condition plus an optional "additional
  condition" that tags `severity=critical`. We show them as named tiers ("Warning when…",
  "Critical when…"); at least one is required. The mapping round-trips:

  | Rows filled | Stored as |
  |---|---|
  | Only Warning | base condition |
  | Only Critical | base condition + tag `severity=critical` |
  | Both | base = warning, additional = critical |

- **The six operators stay verbatim**, as words in the select. The sentence shows the symbol.
- **Thresholds carry their unit.** The suffix follows the CALCULATE choice: `%` for Error %, `ms`
  for latency (Quick latency is in milliseconds while the APM charts show seconds), `req/min` for
  RPM, "deviations" with a one-line explanation for anomaly. Production shows no unit at all.
- **The preview draws tiers as bands** with `thresholdBands`. That helper covers two thresholds,
  higher-is-worse. It gains a single-threshold form and a lower-is-worse form, for an RPM drop or
  Apdex, both tested the way `thresholdBands.test.js` tests the current one.

**Anomaly:** "above by / below by / above or below by **N** deviations". The preview draws the
expected range as a neutral band. That range is mean ± N·σ over the trailing window, and it is not
a severity, so it is never a status hue. Breaches are marked.

**Backtest:** "will this be noisy?" is answered before saving.

- **What it does.** The preview evaluates the condition per bucket over the picked range. Our
  PromQL engine already supports comparison with `bool`. It applies Fire after and Check every,
  then shades the stretches where the rule would have fired: "Would have fired 18 times in the last
  7 days, firing 98.8% of the time".
- **The suggestion.** If that share passes 50%, a hint offers the range's p95 as a threshold, and
  one click applies it.
- **Why it matters.** Production's own demo rule fires 98.8% of the week (its Stats tab), which is
  exactly the chronic miscalibration the New Relic benchmark asked us to flag on SLOs.

**As built (P4): the preview is the evaluator.** Running the draft's query through Explore's
engine and backtesting per bucket would have been a second evaluator beside the one that writes
the rule's history, and the two would disagree about where the rule fired. So the preview calls
`previewRule` (data/alerts.js), which evaluates the draft over the window with the same state
machine, the same ticks and the same readings as a saved rule, starting a Fire after early so a
condition already holding is already firing.

- **Bindings.** A seeded query, a Quick model, a monitor or an SLO reads the incident profiles, as
  before. Anything else is bound to Explore's engines (`data/alertsEngine.js`): the query runs in
  epoch-aligned 6-hour chunks on the rule's own schedule, cached. A reading at an instant is
  therefore the same whichever window asked, and the 8-day history of a saved rule reuses what its
  preview computed.
- **What it reports.** It runs 350 ms after the draft stops changing (at once the first time),
  dims rather than blanks while it works, and says: "Would have fired N times, for X (Y% of it)",
  whether it would be firing now, and, above 50%, a threshold at the range's 95th percentile.
- **The anomaly band needs a profile**, so an anomaly draft on a Code query shows no band (PLAN
  Known gaps).

## D8. Names, tags and groups

- **Name.**
  - Production explains Go templating in a paragraph (`{{ .Labels.service }}`, and
    `{{ index .Labels "host.name" }}` for dotted keys).
  - Here, an **Insert label** menu lists the labels the preview's series actually carry and
    inserts the right syntax. The rendered name shows beneath the field for the first few series.
  - The note "env is added to notification titles automatically" stays, as a hint.
- **The name and grouping are one decision.** In production a templated name needs Notification
  Grouping set to Off, and the only warning is a red hint on a different step. Here, inserting a
  label switches **Send** to "One notification per series" and says why beside the field.
- **Group.** A combobox of existing groups, with "Create 'X'".
- **Tags.** Key/value rows. Reserved keys (alertgroup, alertname, group, rule_id, query) are
  rejected inline with the reason, not by a disabled Next.
- **Description and runbook.** These are new: a summary line and a runbook link, which the rule
  page and the notification preview show.
  - The API already carries `annotations.summary` and `.description`; the demo's synthetic rules
    use them. Production cannot edit them.
  - Whether the write schema accepts them is in PLAN.md's "Needs from the backend".

## D9. Notifications: contact points

**List.** Each contact point shows:

- its name and its integrations as icon + label + target summary (`Slack #payments-oncall`,
  `Email · 2 recipients`, `Webhook api.example.com`);
- "Used by N rules", which links to Rules filtered by it;
- **its last delivery result from the notification log** (✓ 2m ago, or ✗ failed 1h ago). This is
  new, and it makes a broken webhook visible before an incident does.

**Drawer.** The editor is a right drawer built on App's `SettingsDrawer` dialog: role=dialog, focus
trap, Esc, restored focus. It holds:

- the name;
- integrations added from a labelled type grid (the seven types);
- per-type fields;
- **Send test**, with the result inline;
- per-integration "Notify when resolved".

**Delete.** While the contact point is in use, Delete is disabled with the reason and a link to the
rules. Production disables it silently.

**Editing a shared contact point says what it touches.** Save reads "Save · changes routing for 3
rules". Production re-routes every rule that uses the group without a word.

**Integration types:**

- A type the server has not enabled is listed, disabled, with "Not enabled on this server", rather
  than missing, as production does by hiding it.
- **Jira is in v1** (Q6). It has production's "Project" and "Issue Type" pickers with their
  refresh links, over mock projects: changing the project clears the issue type and loads that
  project's types. On the playground Jira is off and simply absent.
- Secrets such as the PagerDuty integration key are masked, with Reveal.
- The webhook payload gets a variable reference and a rendered preview.

**In the rule editor**, "Notify" is a multi-select of contact points plus "One-off destination", an
inline integration card.

- **At least one destination is required**, as in production, but the editor starts with none
  chosen and says so. Production starts with an empty **Webhook** card, the least common choice.
- **Production's inline form misleads.** It shows a chosen group's receivers as disabled inputs,
  which look editable and aren't, and its "Add more" always adds the first group in the list, so
  duplicates appear.

**As built (P5):**

- **The order is health first.** A contact point whose last send failed heads the list, with a red
  edge, the error and when it failed; then the busiest. Each integration shows its own last send
  over the 8-day horizon, so a contact point with one broken integration out of two says which.
- **The drawer's integrations are the rule editor's destination cards,** so a one-off destination
  and a contact point's integration cannot drift apart.
  - Refresh links are simulated, because the lists are fixed.
  - Headers that carry a credential are masked with Reveal.
- **"Used by N rules"** opens to the rules, as links, and to the Rules tab filtered by the contact
  point (`?notifies=`).

**As built (P7), then revised:** P7 made retiring a contact point in use one change — its rules
opened in Rules all selected, and the bulk bar's Contact points… moved them at once. Bulk changes
came out on review (2026-10-23), so the link is "Show them in Rules" again and the refusal reads
"Used by 3 rules: move them to another contact point first."

## D10. Suppression: Snooze, Mute schedules and Pause, each defined once

| | What it is | Where it is set | How it shows |
|---|---|---|---|
| **Snooze** | Stop notifications for this rule from now until a time (an Alertmanager silence) | Row, expanded panel and rule page: 5m / 15m / 30m / 1h / Custom… | "Snoozed · 23m left" chip, Unsnooze action, SNOOZE rows in Notifications |
| **Mute schedule** | Recurring quiet windows (time, duration, weekdays, timezone) | Mute schedules tab; per rule in section 4 | "Muted until 07:00" chip while active; MUTE rows in Notifications |
| **Pause** | Stop evaluating the rule | Actions menu | Paused state; folded at the bottom of its group |

- **State and notifications stay separate.** Snooze and mute silence notifications, not state. A
  snoozed rule that is firing still reads Critical, with the overlay chip, and sorts below the
  unsuppressed firing rules.
- **A mute schedule is drawn as a week grid:** seven rows of 24 hours, with its windows shaded.
  Overnight windows wrap, and the timezone shows beside the viewer's own. It also says "Active now,
  ends 07:00" or "Next: today 21:00". Production says only "Start at 21:00 · Mute for 10h ·
  Everyday".
- **Active and scheduled snoozes are listed** on the Mute schedules tab, each with its remaining
  time and Unsnooze. Production shows a snooze only as a chip inside an expanded rule. It has no
  list, and its "×" ends a snooze at once with no confirmation and no undo. Here Unsnooze offers
  Undo.
- **Custom snooze keeps production's fields:** a start time (now, or later, which makes it a
  scheduled snooze) and a duration. It adds a "Reason" note, which the notification log shows.
  Production records no author or comment.
- **As built (P5):** each schedule shows its windows in words and as a compact week, "Muting now ·
  ends today 15:00" or "Next: today 21:00" in the viewer's time, and its zone beside the
  viewer's. The snooze list holds the snoozes in force (soonest to end first), then the scheduled
  ones, each with its reason and author. Unsnooze there makes the Rules tab's change, so it says
  the same and offers the same Undo.
- **Scope stays the whole rule**, as in production.
  - Later idea: "Snooze this series only" from an instance row. Alertmanager silences take label
    matchers, so the backend already allows it.

## D11. Insights (production's Stats)

**Production.** ID, Group, Alert Name, Incidents, Total Time (minutes), and Total Time % with a bar,
sorted by incidents.

- **The demo's one row is a symptom nobody flags.** The rule fired 18 times and was firing 98.82%
  of the week.
- **Its source is the `ALERTS` series** the evaluator writes, read with three PromQL queries, so a
  rule that never fired has no row.
- **The definitions are never explained.** An incident is a transition into firing; total time is
  minutes spent firing.

Every cell links to the rule.

**Here:**

- **Columns.** The same, plus:
  - median incident duration;
  - notifications sent;
  - a delta vs the previous period on Incidents and Total time (rule 6).
- **Flags.**
  - **Always firing** (≥ 50% of the range): miscalibrated.
  - **Flapping** (many short incidents).
  - **Never fired** across a long range: possibly dead.
- **Each row offers Tune.** It opens the editor with the preview set to the same range and the
  suggested threshold showing (D7).
- **Every rule appears**, joined from the rules list, so "Never fired" can be said at all.
- **Column definitions** sit in `InfoTip`s on the headers.
- **A summary strip on top:** incidents, firing time, failed notifications.

**As built (P6):** the flags are `insightFlags` (utils/alerts/insights.js), one pure function that
the data module and the tests share.

- **Always firing:** 50% of the range or more.
- **Flapping:** 6 or more incidents, a median under 10 minutes, and at least 4 an hour.
- **Never fired:** over a day or more, no incident and no pending stretch either. A rule that went
  pending is alive.
- **Order and comparison.** Rows lead with the flagged, then sort by incidents. Changes are shown
  as neutral arrows, never a status hue. Over a week there is no comparison: the previous week is
  past the evaluated history.

## D12. Notifications (production's Notification History)

**Production.** Alert Name, Receiver (the full webhook URL), Status, Details (empty) and Timestamp,
filtered by Status (ALL / SUCCESS / ERROR / MUTE / SNOOZE) and Alert.

- **Fired or resolved is never said.** The API record (`id, rule_id, rule_name, receiver_type,
  receiver_data, status, details, created_at`) has no such field; see PLAN.md, "Needs from the
  backend".
- **Pagination** is 20 rows with a red "Load more", and search runs only over the loaded pages.
- **MUTE and SNOOZE** share one grey tag.
- **Details** open in a modal of raw text.

**Here:**

- **A log with an Event column:** Fired, Resolved, Reminder, Muted, Snoozed, Failed.
- **The receiver as icon + contact point + integration.** The full target sits in `title` and in
  the expanded row.
- **Details** that say *why*: the error text for a failure, the schedule for a mute, who snoozed
  and until when.
- **Links** to the rule and the instance.
- **Facets:** Status, Event, Rule, Group, Contact point, Integration.
- **The URL** reads production's `rule_id`, so the rule row's history link lands where production's
  does. Production writes no other filter to the URL; ours writes its facets in our own dialect,
  using production's status values (SUCCESS / ERROR / MUTE / SNOOZE).
- **Paging** uses the platform's "Show 20 more · Show all".
- **Rows expand in place**, matching the rules list (Q5). This replaces production's raw-text
  Details modal. The expansion shows the payload, the full target and, for a failure, the error
  text in a scrollable mono block.

**As built (P6):**

- **Event and Status are two columns.** Event is what the message was about (Fired, Reminder,
  Resolved); Status is what became of it (Sent, Failed, Muted, Snoozed). A muted resolve then
  still reads as a resolve, which one combined column could not say.
- **One component in two places.** The same log serves the Notifications tab and the rule page,
  where it drops the Rule column.
- **Integration** joined the URL's facet keys.

## D13. Entry points in, and handoffs out

**Production's entry points.**

- **Where they live.** The ⋮ menu of every *titled* chart (about 750 of them), every table (one
  item per column), scorecards and dashboard panels. Also the Logs / Traces / Mobile Traces query
  bars, the Synthetic Monitors bell, and Clone.
- **What they carry.** All pass only `{model, query, datasource}` in router state. Name, group,
  tags, receivers and a threshold are never prefilled.
- **The downsampling trap.** On an install with metric downsampling on, the playground among
  them, APM charts pass a raw query full of `$__…` placeholders. The editor then opens on Code
  under a "The query contains variables that are not supported in alerts." banner with a "Fix
  query" button.
- **Explore offers none**, because its chart has no title and so no menu.

**In:**

- **Service, Infra and Browser cards.** `CardMenu` already offers "Create Alert", "Create Alert
  (<total>)" and "Create Alert - <column>"; today those toast "not part of this prototype yet".
  - An `alertPayloadForCard()` modelled on `explorePayloadForCard()` builds the Quick model:
    calculate, service, endpoint and `latencyInMs`. Because it sends a model and never a raw
    query, the placeholder banner cannot happen.
  - It defaults the tiers to the `status.js` thresholds that colour that card, so the new rule
    fires exactly when the card turns amber or red.
  - It suggests a name and group from the card ("payment-service p90 latency", group =
    service). Production prefills neither.
- **Logs and Traces.** "Create alert" opens the editor with the current query as a Builder model
  plus `stats count()`, which is what production does. This retires the mock
  `components/explorer/AlertDrawer.jsx`.
- **Mobile Traces** keeps the menu item, disabled with "Mobile alerts aren't available yet", until
  the Mobile datasource lands. It was deferred at sign-off.
- **Errors drawer.** "Alert on this error": a count of that exception, from the Traces source.
- **Explore results toolbar.** "Create alert" from the committed query (ARCH D14 deferred this from
  Explore itself).
- **Home.** The summary strip gains firing alerts, and the incident banner links to the rule. The
  benchmark's onboarding item "set an alert rule (2 of 7 services)" reads coverage from this module.
- **Service page.** The header gains "2 rules · 1 firing", linking to Rules filtered by the
  service. The settings drawer's mock Alerts tab (Alert channel, Suppression window, Auto-resolve
  after) becomes that service's real rules plus a Create button.

**Out:** the rule page's handoffs (D5). All of them go through `openLink`, the way Errors' do.

**As built (P4):**

- **Service cards.** `alertPayloadForCard` reads the card exactly as its Explore item does and
  watches the card's scope as one series. Its tiers are inclusive (`>=`), because a badge turns
  amber at its warn figure. It names the rule ("payment-service p90 latency") and files it where
  that service's rules already are.
- **Infrastructure.** A host's "CPU Used %" chart is an Advanced rule over
  `system_cpu_utilization × 100`, the metric Explore reads, at the host table's own 70% / 85%.
  The other Infrastructure charts keep their toast until their metrics reach the store.
- **Logs and Traces.** The bar's query goes through `toExploreLogsQuery`, the same LogsQL
  Explore gets, with `| stats count()` when it has no pipe of its own.
  - Mobile Traces lists the item, disabled, with "Mobile alerts aren't available yet".
- **Browser cards** say alerts on browser metrics come later and point to Logs, since the store
  has no browser metrics to watch.
- **Deferred to P7 (7a):** the Errors drawer, Explore's toolbar and the service header.

**As built (P7):**

- **Errors drawer.** "Alert on this error" watches the metric counter, not the Traces source above:
  `sum(rate(cube_apm_errors_total{service, exception})) * 60`, an Advanced model read as
  "JedisPoolException rate" in errors a minute, warning above 1/min held for 2 minutes. The span
  store samples rows, so a count of one exception there was sparse, and over some hours empty
  while the drawer counted hundreds; the counter reads at every minute.
- **Explore's toolbar.** "Create alert" sends the active tab's model while the chart still draws
  what it spells, so the rule opens on the same builder; otherwise the committed query, in Code
  (`alertPayloadForExplore`).
- **Home.** A nudge about the worst firing rule: a card filled with the panel tint, no outline or shadow, the
  severity in a tinted icon and the facts' own words rather than a red bar, the rule's name, its value
  against its threshold and for how long on a line of their own, and Open rule. Nothing while
  nothing fires. *Revised 2026-10-23:* the "Alerts firing" pill and the coverage line ("Alert rules
  watch 6 of 7 services", with the missing service's rule) came out on review, Home's summary strip
  with them, and the red banner became this nudge.
- **Service page.** The settings drawer's Alerts tab lists the service's rules worst first and
  offers Create, seeded with what the service lacks: error rate, then p90 latency, then throughput —
  never a copy of a rule it has. *Revised 2026-10-23:* the header's "6 rules · 5 firing" link came
  out on review.

## D14. The URL

`utils/alertsUrl.js` reads production's dialect and ours, the way `errorsUrl.js` does:

- **Production's dialect, kept.**
  - `tab`.
  - `rule_id`: on Rules it expands that rule and scrolls it into view, as production does; on
    Notifications it is the rule filter.
  - `alert_id`, the instance a notification links to. Production ignores it; we select that
    instance.
  - `notifyTime`, which centres the range on ±30 min when the link is old, as production does.
  - `incidentTime`, which anchors the investigation handoffs, as production does.
  - `config`, the PagerDuty connect return.
- **`time`** is read once on a cold load and never written; App owns the range. Production's
  `refresh` is a cache-buster, and is ignored.
- **Ignored on purpose:** `service`, `index`, `name`, `kind`, `view`, `env`, `refresh`, `category`,
  `host`, `sv`.
  - These are the APM page's sticky keys, and production carries them into every module. The study
    link (`/alerts?service=cubedemo-web&index=cube:error&name=…&view=graph`) lands on the plain
    rules list there, so it must here.
  - It follows that **our own service filter cannot be called `service`**.
- **Our own keys** (facets, search; group-by until 2026-10-21, D3) are written in a fixed order with `replace`, while
  the path is `/alerts`.
- **The create-from-context payload** rides in App state with a nonce, as Explore's handoffs do
  (decided at sign-off, Q8).
  - As in production, the prefilled editor's address (`/alerts/new`) can't be shared, and a
    reload returns a blank editor. The unsaved-changes guard (D6) warns before that reload.
  - If URL state sync lands platform-wide (`docs/decisions/query-builder-phase8.md`), this is one
    of its consumers.

## D15. Data: production-shaped, a function of the window, one source for every view

- **Shape.** `src/data/alerts.js` returns the backend's JSON shapes: rules with `alerts[]`, receiver
  groups, mute groups, silences and alert logs. `utils/alerts/model.js` maps them to view models:
  state, severity, scope, sentence. Integration replaces the data module with fetches and nothing
  else.
- **Time.** Following `time-range-windowing.md`, alert state is evaluated **per instant** from the
  shared incident profile, as `healthHistoryForWindow` does, and never from a window mean.
  - The payment rules cross their thresholds on the incident's 4-minute ramp, 22 minutes ago, then
    turn Pending, then fire after their `for`.
  - order-service and shipment-service fire Warning on p90 (188 ms and 165 ms against 150).
  - Thresholds come from the exported `THRESHOLDS`.
  - A quiet window fires nothing.
- **One evaluator, two bindings.** A rule reads the incident profiles when one describes it (seeded
  queries, Quick models, monitors, SLOs) and Explore's engines when none does
  (`data/alertsEngine.js`). Either way the same state machine reads it, and the editor's preview
  reads it too (D7).
- **One source of truth.** Firing intervals are computed once. The timeline, the rule-page strip,
  Insights' counts and the notification log are all derived from them: a notification every
  `repeatInterval` while firing, plus Resolved, MUTE inside a schedule, SNOOZE inside a silence, and
  one ERROR from a deliberately broken webhook. They cannot disagree.
- **A rule's chart is what its evaluator read.** Each point is the rule's query at its bucket's
  close, on the rule's own schedule, not the bucket's mean. A 5-minute rule holds each reading for
  five minutes. This is what production's rule graph draws: the expression at each step.
  - The line crosses its threshold where the state strip turns.
  - The newest point is the reading the state was decided on, so the banner, the Now KPI, the
    legend and the alert's `value` are one number at every range, under one rounding.
  - A bucket mean could not do that. Over Last 7 days the last bucket spreads the 22-minute
    incident over hours and sits under the threshold the rule is firing over.
  - This is where a rule's chart and the service page's differ on a wide range. The service page
    draws aggregates (how the stretch went); a rule's chart draws readings (what the rule saw).
    Over Last 1 hour they are the same line within the jitter.
  - Set on 2026-10-16, after the P3 session found the legend and the banner a reading apart
    (15.8% against 15.6%).
- **Every state, at least once.** The seed covers critical, warning, pending, OK, no data, rule
  error, paused, snoozed and muted. Each source and type appears: metrics, logs, traces, anomaly,
  and synthetic-managed rules (production's "Synthetic down - …").
- **One alternative was considered and set aside.** We could emit the `ALERTS` series into
  `metricsStore` and run production's Recent Alerts and Stats queries unchanged, the way Explore
  runs production's builders byte-exact.
  - The cost is engine support for `increases_over_time`, `default_rollup` and `label_join` /
    `label_copy` / `label_set`.
  - Instead we compute intervals in JS and keep production's queries in the reference, ready for
    the backend.
- **Edits.** Rules, contact points, schedules and snoozes created in the prototype live in an
  overlay over the seed. The repo has both precedents:
  - Saved queries keep theirs in React state, for the session only.
  - Theme and the Errors rail width persist in `localStorage`, inside try/catch.
  - Decided at sign-off (Q9): `localStorage`, inside try/catch, under a versioned key, so a
    demo survives a reload. A seed change bumps the version and discards stale edits rather
    than mixing them in.
- **Tests** pin three points, as the other data modules do: Last 1 hour (which rules fire and since
  when), a quiet absolute window, and the ends of a wide window.
  - None of them assumes the hour. `BASE_TIME` is the wall clock at load. Quiet hours mute 509 from
    21:00 to 07:00 IST, and 509 flaps, so its state is read rather than pinned.
  - Every alert suite has passed at 54 instants across one day, run under a fake clock (a preload
    that moves `Date`, `FAKE_NOW_MS=… node --import <preload> <bundle>`). Run that again after
    seeding anything that depends on the hour.

## D16. Live data, loading, empty and failure states

- **Live without the setting.** The rules list refreshes on its own, because alerts are live, and
  shows "Updated 12s ago". PageBar's auto-refresh still governs the charts. *Revised 2026-10-21:*
  the line sits in the page bar ahead of Auto, on every tab, and reads "Updated just now" for the
  whole first minute, then "Updated 3m ago".
- **One quiet failure line instead of a toast per poll.** During this study's network outage,
  production stacked nine "Failed to fetch alerts: AxiosError: Network Error" toasts, one per
  background poll. Here a failed refresh shows one inline line, "Couldn't refresh, showing data
  from 15:02 · Retry", and the last good data stays visible.
- **Loading** uses skeleton rows (the HomeSkeleton precedent). Space for the timeline is reserved,
  so nothing jumps when it arrives.
- **Every change confirms itself.** In production only "Test" ever shows a success toast; save,
  delete, pause, snooze and unsnooze all succeed silently.
  - Here each confirms in a toast.
  - The reversible ones (pause, snooze, unsnooze, delete of a snooze) offer **Undo**.
- **Deleting says what it does:** "Delete rule" — "It stops evaluating and notifying. Its
  notification history is kept." — [Cancel] [Delete rule]. Production's dialog ends in a generic
  "Yes".
- **As built (P7): bulk changes, then removed.** P7 built them (R17; production has none): a
  select box per row and a bar that changed the selection as one change with one Undo. On review
  (2026-10-23) they came out, with the count line above the rules; a rule changes from its own
  menus. ⌘Z / Ctrl+Z undoes while an Undo toast is up, since the toast is beyond keyboard reach
  in the 4.5 s it shows.
- **The time picker shows only where the range applies:** Rules (its timeline), Insights,
  Notifications and the rule page.
  - Production shows it on Receiver Groups and Mute Groups, where it does nothing.
  - PageBar gains a way to omit it; other pages are unchanged.
- **Empty states** answer the UX review's three questions (§2.6): what goes here, why it is empty
  now, what fills it.
  - No rules yet: "Start from a service" lists services without coverage, each with a suggested
    rule.
  - No matches: the filter that emptied the list, with a clear button.
  - Nothing firing: the last resolution time.

## D17. Accessibility and keyboard

- **Labels.** Every icon-bearing control has visible text or `title` + `aria-label` (rule 4).
- **Menus** use CardMenu's roving focus. Drawers and dialogs use SettingsDrawer's (`trapTab`, Esc,
  restored focus).
- **Colour is never alone.** Every state chip and timeline bar carries its word, as text or `title`
  ("Status: Critical").
- **Shortcuts:**
  - `/` search and `n` new rule.
  - `↑/↓` move between rule rows; Enter or Space expands or collapses one.
  - `Esc` closes menus and dialogs.
  - Each appears where it applies, as `kbd` hints, the way `RawQueryInput` does.
- **Tabs** use the shared `ViewTabs`: roving focus, ←/→ between tabs, and a labelled tab panel.
- **Both themes:** colours come only from `var(--…)` tokens.

**As built (P7, the verification pass):**

- **Focus never falls to the page when its control leaves.** A row paused into its fold or deleted
  hands focus to the row that took its place; a deleted contact point or schedule to the next one;
  PagerDuty's connect swap to the new state. A
  destination card just added takes focus at its first field; a failed Save in either config
  drawer moves focus to the first thing to finish, as the editor's does.
- **Seg-toggle radio groups** (Static / Anomaly, Active / Paused, access mode, Insights' filter)
  are one Tab stop with the arrows between options.
- **Solid chips hold 4.5:1**: the dark theme's bright red and blue, and amber in either theme, take
  the darkest ink; the light theme's deeper fills keep white.
- **Narrow windows**: the tab strip tightens below 1100 px and drops its icons below 860 px instead
  of clipping Notifications; Insights' table fits its card so Tune
  stays in view.
- **Left for the app**: focus after a route change and a skip link, the facet rail's mouse-only
  group headers, and the toast's fixed 4.5 s.

## D18. Rules that other modules manage

Two kinds of rule are created outside the editor. Both are in v1 (decided at sign-off, Q6).

**Synthetic-monitor rules.**

- **What they are.** Production's "Synthetic down – <monitor>" rules: Advanced model
  `max(cube_synthetic_monitor{id="N"}) by (id, group, name)`, condition `== 0`, tags
  `kind=synthetic` and `severity=critical`.
- **In the list** they carry a "Synthetic" source chip and "From monitor <name>".
- **They can be edited here, as in production.** The editor opens with a one-line note: "Created
  from the monitor 'Docs'. Changes apply to this rule only."
- **Waits for Monitors.** The monitor-side entry point, the bell that lists a monitor's rules,
  arrives with the Monitors page, which is not built yet.

**SLO burn-rate rules.**

- **Production hides them.** The SLO drawer's "Alerts" switch creates multi-window, multi-burn-rate
  rules with "Receivers for Fast Burn alerts" and "Receivers for Slow Burn alerts", but production
  does not list them in Alerts, so a firing burn alert has no home there.
- **Here they appear in Rules, read-only:**
  - an "SLO" source chip and "From the SLO for <service> <endpoint>";
  - one rule per objective and speed, error or latency × fast or slow;
  - fast burn reads Critical and slow burn reads Warning, following production's own copy ("deliver
    critical alerts (when budget is being consumed fast)", "non-critical alerts (when … slowly)").
- **What you can do with them.** Snooze, because it holds notifications, not configuration.
  Notification history. "Edit in SLO", disabled with "The SLO page comes later" until that page
  exists. No Pause, Edit, Clone or Delete, because those would contradict the SLO's own switch.
- **Data.** The prototype derives them from seeded SLO configs in production's `/slos` shape, so
  payment-service's SLO burns fast during the incident and its rule fires beside the others.
  Integration needs the backend to expose them; see PLAN.md, "Needs from the backend".

## Decisions taken at sign-off (2026-10-15)

| # | Question | Decision |
|---|---|---|
| Q1 | Tab labels | **Rules / Insights / Contact points / Mute schedules / Notifications.** The strip uses the service page's `.view-tabs` pattern through a shared `ViewTabs`, extracted from Browser's accessible copy; both existing pages move onto it unchanged. |
| Q2 | Severity of a firing alert with no label | **Warning (amber).** Critical needs the critical tier or `severity=critical`. |
| Q3 | Landing | **"Firing now" band** above the rules: summary pills, incident banner, timeline. *Revised 2026-10-21: the title, pills and banner removed; the band keeps the timeline (D2).* |
| Q4 | Editor layout | **One page with a sticky preview**; stacked below ~1280px. |
| Q5 | Rule row click | **Expand in place, as production** (not the proposed drawer). The whole row toggles; the name stays a link. Notification rows follow suit. |
| Q6 | v1 scope | **In:** per-rule custom permissions, Jira, SLO burn-rate rules in the list (read-only), editing synthetic-managed rules. **Deferred:** the Mobile datasource (shown disabled). |
| Q7 | Service of a rule | **Derived from the query's matchers**; "No service" otherwise. No editor field. |
| Q8 | Create-from-context prefill | **App state with a nonce**, like Explore's handoffs; not encoded in the URL. |
| Q9 | Prototype edits | **`localStorage`, versioned.** |
