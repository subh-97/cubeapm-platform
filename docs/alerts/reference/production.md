# What production's Alerts module does

The reference for [../PLAN.md](../PLAN.md) and [../DESIGN.md](../DESIGN.md). It describes the
production CubeAPM Alerts module as it stood on **2026-10-15** (build `assets/index-BT3XqUYr.js`):
every screen, control, string, URL key and API call, the journeys it supports, and what is wrong
with it. Where DESIGN.md disagrees with this file, DESIGN.md wins; this file records what
production *does*, not what we should build.

**How it was studied.** Three sources, cross-checked:

- **Driving the live module** at `https://playground.cubeapm.com/alerts` in a browser:
  - the Rules tab, a rule page, `?alert_id=` links, and all four editor steps on an existing rule
    and a new one;
  - the Stats, Receiver Groups, Mute Groups and Notification History tabs, with the Snooze menu;
  - the "Create Alert" handoffs from Logs and from a service page chart menu, plus the Monitors
    and SLO pages.
- **The production bundle**, reprinted and read for everything that writes. The live pass never
  pressed Done, Yes, Create or Test, or picked a snooze, so save, delete, snooze, test-notify and
  clone are read from code.
- **The public read API** (GET only).

Statements read only from code and not observed are marked **(inferred)**. Section 21 lists what
the live pass added to the code reading.

**Looking something up again.** The bundle is not committed (7 MB, re-downloadable). Identifiers
are minified and change per build, so this file records behaviour and verbatim strings first and
cites minified names only as a finding aid (Appendix A).

```bash
curl -sS "https://playground.cubeapm.com/alerts" | grep -oE '/assets/index-[A-Za-z0-9_-]+\.js'
curl -sS -o app.js https://playground.cubeapm.com/assets/<that file>
npx prettier@3 --parser babel app.js > app.pretty.js
curl -sS https://playground.cubeapm.com/api/alerts/api/v1/rules | python3 -m json.tool
```

Conventions
- Quoted strings ("...") are exact UI copy from the bundle.
- "(inferred)" marks behaviour deduced but not directly confirmed in code.
- Minified identifiers are given in `code` so engineers can find them again (they change per build).
- antd mapping used throughout: Select, Input, InputNumber, AutoComplete, Radio.Group (button style), Switch, Checkbox, DatePicker, TimePicker, Dropdown, Tooltip, Modal, Drawer, Collapse, Tag, Steps, Tabs (card), Alert (banner), Empty, Spin, `message` toasts.

---

## 0. TL;DR of the studied URL

`/alerts?service=cubedemo-web&index=cube%3Aerror&name=POST+api.stripe.com%2Fv1%2Fpayment_intents&kind=server&time=7d&refresh=1792040553713&view=graph&env=UNSET`

renders exactly the same thing as `/alerts?time=7d`: the Alerts page, **"Alerts" tab** (no `tab` param → default), time picker on **"Last 7 days"**.

| Param | Owner | Meaning | Read by the Alerts module? |
|---|---|---|---|
| `time=7d` | global time picker | preset "Last 7 days" | Yes — drives the "Recent Alerts" chart, the Stats tab and Notification History window |
| `refresh=1792040553713` | global time picker | epoch-ms stamp written every time the range is changed or the refresh button is pressed; used only as a re-fetch trigger | Yes (as a dependency only) |
| `service`, `env`, `kind`, `name`, `index`, `view` | APM service page | `service` = service; `env` = environment (`UNSET` = no env tag); `kind=server` = APM Server/Client toggle; `name` = span name; `index=cube:error` = APM Traces sub-view index (`cube:latency` = "Slow Requests", `cube:error` = "Requests with Errors"); `view=graph` = APM Graph/Table toggle (`graph` / `table`) | **No.** They are leftovers. |

Why they are there: every in-app link is built by a helper (`ta()`) that **copies the current query string** and only strips a fixed delete-list (`flow, config, tab, section, section2..5, query, stream, rule_id, incidentTime, notifyTime, datasource`, plus some profile params). The sidebar "Alerts" item is `at.ALERTING()` → `ta("/alerts", {})`, computed at render time, so clicking "Alerts" while on an APM service page (`/apm?tab=traces&service=…&index=cube:error&name=…&kind=server&view=graph&env=UNSET`) yields the URL above. `index=cube:error` is **not** a create-alert prefill; there is no URL-based prefill anywhere in the Alerts module (prefill uses react-router `location.state`, see §6.1).

---

## 1. Routing, navigation & URL state

### 1.1 Routes

| Path | Component | Purpose |
|---|---|---|
| `/alerts` | `kUn` | Alerts hub with 5 tabs (`?tab=`) |
| `/alerts/new` | `vGe` | Create wizard (also used for Clone and every "Create Alert" deep link) |
| `/alerts/:id` | `aVn` | Rule detail page |
| `/alerts/:id/edit` | `vGe` | Edit wizard |

No breadcrumbs anywhere. The detail page has no back arrow; the editor has a back arrow (browser `history.back()`).

### 1.2 Sidebar entry
Left rail item: icon = bell outline (tabler `bell`), visible caption "Alerts" (9 px), tooltip "Alerts" (placement right). Active when pathname is `/alerts` or starts with `/alerts/`; active item gets an orange 4 px bar on the right edge. Order in rail: Services, Logs, Infra, Browser, Traces, MTraces, Profiles, Errors, Mobile, Dash, Explore, SLO, **Alerts**, Monitors; bottom: Admin (admins only), Settings.

### 1.3 URL parameters read by the module

| Param | Read where | Effect |
|---|---|---|
| `tab` | `/alerts` | `alerts` (default) · `alert-stats` · `receiver-groups` · `mute-groups` · `alert-logs`. Changing tab sets `tab` and deletes `section`, `section2` (it does **not** delete `rule_id`). |
| `rule_id` | Alerts tab; Notification History tab | Alerts tab: auto-expands the group that contains this rule and the rule's panel. Notification History: preselects the "Alert" filter. Written by the "Notification History" row action (`/alerts?tab=alert-logs&rule_id=<id>`). Not written back when the user changes the filter. |
| `time`, `refresh` | page header | Global time range (see 1.4). |
| `notifyTime` | `/alerts/:id` | Unix seconds. If present and the current range end is later than notifyTime + 35 min, the range is reset to [notifyTime − 30 min, notifyTime + 30 min] (absolute). Never written by the frontend — comes from notification links (inferred). |
| `incidentTime` | `/alerts/:id` details panel | Unix seconds. Anchors the "Traces ↗ / Logs ↗ / Mobile ↗" investigation links to ±5 min around it (otherwise ±5 min around the instance's `activeAt`). Never written by the frontend (inferred: notification links). |
| `config` | `/alerts/new`, `/alerts/:id/edit`, Receiver Groups drawer | PagerDuty OAuth return: JSON `{"integration_keys":[{"name","integration_key"}]}`; restores wizard state from `sessionStorage` (§7.3). |
| `alert_id` | — | **Ignored.** The backend's `source` link for an alert instance is `/alerts/<rule_id>?alert_id=<instance id>`, but nothing reads `alert_id` (no instance is highlighted). |

### 1.4 Page header (shared `Wa` component)
Row: [optional back arrow] **title** (h1, xl, extra-bold) · `extra` slot · [env picker — not shown on any Alerts page] · time picker button · refresh split-button.

- Time picker button: clock icon + current label (e.g. "Last 7 days", or "MMM DD, HH:mm:ss - MMM DD, HH:mm:ss" for absolute, or "Custom"). Click opens popover titled "Select time range" with close (×) icon:
  - Left: "From" / "To" date-time pickers (`YYYY-MM-DD HH:mm:ss`, future dates disabled, "To" default = From + 24h) and "Apply" (disabled unless From < To).
  - Right: preset list: "Last 5 minutes" (5m), "Last 15 minutes" (15m), "Last 30 minutes" (30m), "Last 1 hour" (1h, **default**), "Last 2 hours", "Last 3 hours", "Last 6 hours", "Last 12 hours", "Last 24 hours", "Last 2 days", "Last 3 days", "Last 7 days" (7d), "Today" (`today`), "Today so far" (`todayf`). Absolute ranges are stored as `time=<ISO>~<ISO>`.
- Refresh split-button: main part = reload icon (sets `refresh=<now ms>`); dropdown part shows the auto-refresh interval label and offers "Off", "5s", "10s", "30s", "1m", "5m", "15m". Auto-refresh is component state (not in URL; resets on navigation).
- Charts support drag-to-zoom on the x-axis, which writes an absolute `time` range.

Titles: "Alerts" (hub), "Alert" (detail page — not the rule name), "New Alert" / "New - <name>" / "Edit - <name>" (wizard; updates live as the name is typed).

### 1.5 Hub tabs (`kUn`)
Rendered in the header's `extra` slot as an antd Radio.Group with button style (looks like a segmented control, right-aligned next to the time picker):

| Label | `tab` value | Component |
|---|---|---|
| "Alerts" | `alerts` | `vUn` (§2) |
| "Stats" | `alert-stats` | `MVn` (§12) |
| "Receiver Groups" | `receiver-groups` | `NUn` (§8) |
| "Mute Groups" | `mute-groups` | `yUn` (§9) |
| "Notification History" | `alert-logs` | `lVn` (§11) |

The time picker is shown on all tabs even where it has no effect (Receiver Groups, Mute Groups, and the rule list itself). An unknown `tab` value (e.g. hand-edited) renders the header with no radio selected and an empty body.

---

## 2. "Alerts" tab — rule list (`vUn`)

### 2.1 Data & refresh
- On mount: `GET /api/alerts/api/v1/rules` + `GET /api/alertmanager/api/v2/silences` in parallel; then **polls every 30 s** (no spinner on polls). Not tied to the time range or refresh button.
- Silences with `status.state === "expired"` are dropped; each remaining silence is attached to the rule whose id equals `matchers[0].value` (assumes the first matcher is `rule_id`) as `rule.snoozes[]`, sorted by `startsAt`.
- Rules are grouped by `labels.group`, falling back to "Default Group". Groups sorted A→Z. Within a group, rules sort **firing → pending → everything else**, then by name.
- If Slack is enabled: `GET /api/alertmanager/api/v1/connect/slack/channels?refresh=false` (to print channel names instead of ids). If Opsgenie is enabled: `GET /api/alertmanager/api/v1/connect/opsgenie/teams` (to print team names instead of API keys). Errors toast "Failed to fetch slack channels: …" / "Failed to fetch opsgenie teams: …".
- Load failure toast: "Failed to fetch alerts: <error>".

### 2.2 Layout (top → bottom)
1. **"Recent Alerts"** collapsible panel (ghost Collapse, collapsed by default, only rendered when at least one group exists). Body (h-60): time-series chart titled "Recent Alerts", stacked, legend on the right (with "Search" box), value formula "last". Query (Metrics):
   `label_join(label_copy(label_set(sum by (alertname,group,rule_id) (max_over_time(ALERTS{alertstate="firing"})) default 0, "folder", "Default Group"), "group", "folder"), "title", " - ", "alertname", "folder")`
   → one 0/1 series per rule, legend "<alert name> - <group>". Chart ⋮ menu: "Compare", divider, "Create Alert", "Explore" (see §15.3 for chart menus).
2. **Toolbar**: search input placeholder "Search alerts" (allow-clear, autofocus) · primary button "New" + plus icon → `/alerts/new` (disabled for viewers).
   - Search is case-insensitive; a group is kept whole if its **name** matches; otherwise rules are kept if the rule **name** matches or any **label key** matches (label values are not searched). Group counts are recomputed for the filtered set.
3. **Table header** (row, not a real table): "Group" (span 18), "# Rules" (span 3, right), "# Firing" (span 3, right). Each header has a circular down-arrow sort icon; clicking toggles asc/desc; active column icon is blue. Default sort: Group A→Z. Numeric columns sort descending first.
4. **Group rows** (Collapse, ghost): header = group name · rule count · firing count. Default-expanded: the group containing `?rule_id`, else the only group if there is exactly one; otherwise all collapsed.
5. **Rule rows** inside a group (nested Collapse; virtualised list with a fixed 24rem scroll area when a group has > 50 rules):
   - Header: **state tag** · rule name (link to `/alerts/:id`) · actions toolbar (§4, with "View").
   - Body (expanded): details panel (§3) with "Query" shown.
   - Default-expanded rule: `?rule_id`.
6. Empty: antd Empty (default "No data" artwork). Loading: large spinner.

### 2.3 State tag
| `rule.state` | Tag text | Tag colour |
|---|---|---|
| `inactive` | "normal" | green |
| `pending` | "pending" | orange |
| `firing` | "firing" | red |
| anything else | raw value | purple |

There is **no** visual indication in the collapsed row that a rule is snoozed, muted or paused, other than the Pause switch position (§4). Health is printed as text in the toolbar ("Health: ok", red when not ok).

---

## 3. Rule details panel (shared `eat`, used in list rows and on the detail page)

Four columns separated by vertical rules; labels are grey (#999), values normal. Text-sm.

**Column 1**
- "Source": `metrics` (datasource `prometheus`), `logs` (`vlogs`), `traces`, `mobile`.
- "Type": `static` | `anomaly` (raw `kind`).
- "Query" (list rows only): the full stored expression **including** the comparison (e.g. `(…) > 0.1`), pre-wrapped; if a critical condition exists, ` (> 0.5 for critical)` is appended (raw operator; anomaly adds " deviations").
- "Condition" (detail page only): human text, e.g. "greater than 0.1"; with critical: "greater than 0.1 (greater than 0.5 for critical)". Anomaly: "above or below by 2 deviations (above or below by 3 deviations for critical)".
  - Static operator words: `==` "equal to", `!=` "not equal to", `>` "greater than", `<` "less than", `>=` "greater than or equal to", `<=` "less than or equal to".
  - Anomaly operator words: `<>` "above or below by", `>` "above by", `<` "below by".

**Column 2**
- "Evaluated every" `interval` (formatted `30s`, `1m`, `1h30m`, …)
- "Wait before firing" `duration`
- "Repeat after" `repeatInterval`
- "Tags": blue chips `key: value` for every label except reserved `alertgroup, alertname, group, rule_id, query`.
- "Group" (detail page only): `labels.group` or "Default Group".

**Column 3**
- "Notification Grouping": "On" / "Off" (`groupingDisable`).
- "Receiver Groups": names (if the rule references groups; fetched via `GET /api/alerts/api/v1/receivergroups`).
- "Receivers": effective receivers (union of the groups' receivers, or the inline receiver), one line per type with chips: "Email: " (each address), "PagerDuty: " (service name), "Slack: " (channel name), "Jira: " (project key), "Opsgenie: " (team name), "Google Chat: " (URL), "Microsoft Teams: " (URL), "Webhook: " (URL).

**Column 4**
- "Snooze": one chip per non-expired silence, text "MMM DD, HH:mm - MMM DD, HH:mm"; red chip = active now, neutral chip = scheduled (pending). Chip has a close (×) for non-viewers → `DELETE /api/alertmanager/api/v2/silence/<id>` (expires it; no confirmation). Error toast "Failed to delete snooze: …".
- "Mute Groups": names (via `GET /api/alerts/api/v1/mutegroups`).
- "Mutes": for each interval: "Start at HH:MM", "Mute for 10h" / "1h 30m" / "45m", "Every Mon, Tue…" (or "Every day" when no weekdays), "Timezone Asia/Calcutta (+05:30)". If no mute groups and no intervals: "Mutes None".
- "View Logs ↗" / "View Traces ↗" / "View Mobile ↗" (opens new tab) — only when the rule is **not** firing **and** its datasource is logs/traces/mobile: opens the explorer with the rule's query minus any `| stats …` tail, time = ±5 min around `incidentTime` (or now).

**Alert instances** (below, only if `rule.alerts` is non-empty): one row per instance: state tag (raw `pending`/`firing`, same colours) · bullet list of the instance labels that are not reserved and not already rule labels (e.g. `service payment-service`) · current value (raw string, e.g. `0.28150713`) · investigation link "Traces ↗" / "Logs ↗" / "Mobile ↗" (new tab):
- Logs/Traces/Mobile rules: the rule query (stats stripped) over ±5 min around `activeAt` (or `incidentTime`).
- Metrics rules: only when the query's first vector selector is a `cube_apm_*` metric: a Traces search built from that selector's label matchers (`service:="payment-service" root_name:="POST /v1/payments" span_kind:~"server|consumer" status_code:="ERROR"`) plus the instance's labels, ±5 min.
- Not shown: `activeAt` (as text), `annotations` (summary/description), `lastEvaluation`, `lastError`, `restored`, `stabilizing`, `value` formatting from `annotations.value`.

### 3.1 Display matrix — how each rule/instance field surfaces

| Field / value | Where | Rendering |
|---|---|---|
| `state: inactive` | rule header (list + detail) | green tag "normal" — **also for PAUSED rules** (paused rules report `inactive`) |
| `state: pending` | rule header; instance rows | orange tag "pending"; sorted after firing, before normal; **not** counted in the group's "# Firing" |
| `state: firing` | rule header; instance rows | red tag "firing"; counted in "# Firing"; sorted first |
| any other state | rule header | purple tag with the raw word |
| `health: ok` | toolbar | "Health: ok" plain text on every row |
| `health` ≠ ok (e.g. `err`) | toolbar | "Health: err" in red; no message, no tooltip, row not otherwise flagged |
| `status: ACTIVE / PAUSED` | toolbar | Pause switch on / off — nothing else |
| `query2` (critical) — static | list "Query" line; detail "Condition" line | "… (> 0.5 for critical)" / "greater than 0.1 (greater than 0.5 for critical)". The detail chart draws **only the primary threshold line** (the critical threshold is not drawn). |
| `query2` — anomaly | same lines; detail chart | "above or below by 2 deviations (above or below by 3 deviations for critical)"; chart shades the expected range in translucent green: inner band (main factor, `#0f08`) and a fainter outer band (critical factor, `#0f04`); for "above by"/"below by" the band extends to the chart's bottom/top edge, so only the breached side is unshaded |
| `kind: anomaly` | "Type" line | "Type anomaly" |
| `severity=critical` (added to instances matching the critical condition) | instance label list | bullet "severity critical" (hidden if the rule itself has a `severity` tag) |
| `snoozes` (active / scheduled silences) | expanded panel, detail page | red / neutral chips; nothing in the collapsed row |
| `mute` / `mute_group_ids` | expanded panel, detail page | "Mute Groups" names, "Mutes" schedule text; nothing in the collapsed row |
| `activeAt` | — | only used to centre the ±5 min investigation link |
| `restored`, `stabilizing`, `lastEvaluation`, `lastError`, `annotations.*` (summary, description, value, cube_alert_event_time), instance `id`, `expression`, `source`, `group_id` | — | never displayed |

---

## 4. Rule actions toolbar (shared `Bot`)

Inline, right side of the rule header. Every control is **icon-only with a hover tooltip** (no visible label). "Editable" below means `!rule.readonly && rule.permission ∈ {editor, admin}`.

| # | Control | Tooltip | Icon | Behaviour | Disabled when |
|---|---|---|---|---|---|
| 0 | Text | — | — | "Health: ok" (red text when `health ≠ ok`, e.g. "Health: err"; the error message is never shown) | — |
| 1 | Switch | "Pause" | — | Checked = `status === "ACTIVE"`. Toggling immediately `PUT /api/alerts/api/v1/rules` with the full rule mapped to the write schema and `status: "ACTIVE" \| "PAUSED"`. No confirmation, no success toast; error toast "Failed to save alert: …". Note tooltip says "Pause" while ON means active. | not editable |
| 2 | Dropdown button | "Snooze" | speaker-with-slash (ionicons volume-mute) | Menu: "5m", "15m", "30m", "1h", "Custom". Preset → silence from now (rounded down to the minute) for N minutes. "Custom" → modal (§10). | not editable |
| 3 | Link button | "View" | eye | → `/alerts/<id>` (list rows only) | never |
| 4 | Link button | "Edit" | pencil | → `/alerts/<id>/edit` | not editable |
| 5 | Button | "Clone" | copy | → `/alerts/new` with router state `{rule: {...rule, readonly:false}}`; the wizard opens prefilled with name "Copy of <name>" and every field copied (receivers, mutes, group, tags, kind, thresholds). | current user is not editor/admin |
| 6 | Link button | "Notification History" | history clock | → `/alerts?tab=alert-logs&rule_id=<id>` (plus carried-over params) | never |
| 7 | Button | "Delete" | trash | Modal title "Delete Alert"; body "Are you sure you want to delete **<name>**?"; footer "Cancel" / "Yes". Yes → `DELETE /api/alerts/api/v1/rules?id=<id>`; list reloads (detail page navigates to `/alerts`). Error toast "Failed to delete alert: …". No success toast. | not editable |

---

## 5. Rule detail page `/alerts/:id` (`aVn`)

Loads `GET /api/alerts/api/v1/rules?id=<id>` and `GET /api/alertmanager/api/v2/silences?filter=rule_id%3D<id>` (non-expired → snoozes). Also Slack channels / Opsgenie teams as in §2.1. No polling (manual refresh only re-renders charts; the rule itself is fetched once).

States: loading → full-height centred spinner. Not found / error → "Alert not found" (4xl bold) + button "Back to Alerts" (back-arrow icon) → `/alerts`; error toast "Failed to fetch alert: …".

Layout:
1. Header: title "Alert" + time picker.
2. Row: state tag ("normal"/"pending"/"firing") + rule name (plain text) · actions toolbar (§4, without "View"). Delete navigates back to `/alerts`.
3. Bordered box: details panel (§3) with "Group" and "Condition" (no "Query" line).
4. "Query" heading + bordered box: the read-only query editor (§6.3) showing the datasource radio (all disabled), and the Quick/Advanced/Code (or Builder/Code) tabs reconstructed from `config.model` — tab switching is disabled in read-only mode.
5. Chart (h-80): the rule query over the selected time range, legend right with value formula "last", **threshold drawn as a thin red horizontal line** (static rules); for anomaly rules, shaded bands from the anomaly service (`POST /api/anomaly/api/v1/query_band`, which returns `prediction` and `deviation` series): band = prediction ± threshold × deviation, second band for the critical factor; the operator decides which side(s) are drawn.
   - Legend action (Quick-model rules only): a small external-link icon "details" on each legend row → APM page for that service/endpoint: Detail tab if an endpoint (`root_name`) is known, RED tab otherwise, Errors tab when the Quick calculation is "Error %".

There is no state-transition timeline, no notification log on this page (it is one click away via the History icon), no instance history, and no annotations/description.

---

## 6. Create / Edit / Clone wizard (`/alerts/new`, `/alerts/:id/edit`; component `vGe`)

### 6.1 Entry, access & prefill
- Viewer role → immediate redirect to `/alerts`. Editing a rule whose `permission` is not editor/admin → redirect to `/alerts/<id>`.
- On mount: `GET /api/alerts/api/v1/rules` (all rules — used for the Group suggestions and to find the rule being edited; there is no `?id=` fetch here). Error toast "Failed to fetch alerts: …"; edited id not found → toast "Alert not found" and an empty wizard stays on screen.
- Edit only: `GET /api/frontend/api/v1/permissions?resource_type=alert&id=<id>` → Permissions step (toast "Failed to fetch permissions: …").
- Prefill comes **only** from react-router `location.state` (never from URL params):

| `state` key | Effect |
|---|---|
| `rule` (Clone) | Every field copied from the rule; name becomes "Copy of <name>"; `id` ignored (POST creates a new rule). Permissions are not copied. The **status is copied too** — cloning a PAUSED rule creates a paused rule, and the wizard has no status control to notice or change it. |
| `datasource` | Selects Metrics/Logs/Traces/Mobile |
| `model` | Rebuilds the Quick / Advanced / Builder UI (query is regenerated from the model) |
| `query` | Used when no `model` (lands in Code tab, or Builder/Code for logs) |
| `condition`, `threshold` | Condition operator and threshold (only Synthetic Monitors uses these: `==` `0`) |

  No entry point prefills the **name**, **group**, **tags**, **receivers** or **mutes** (except Clone).
- Defaults for a new rule: datasource Metrics, kind Static, condition "greater than" (`>`), threshold empty, critical condition `>` empty, Evaluation Interval 1m (60 s), Wait for 5m (300 s), Repeat after 4h (14400 s), Notification Grouping On, Group "Default Group", status ACTIVE, one empty **Webhook** receiver, no mutes, Role Based permissions.

### 6.2 Frame
- Header: back arrow (history back) + title "New Alert" → "New - <typed name>" / "Edit - <name>" (live); time picker (drives the preview chart and label-value lookups).
- Card containing antd **Steps** (non-clickable): "Query" → "Settings" → "Receivers" → "Mutes & Permissions". All steps stay mounted (hidden), so values persist when moving back and forth.
- Footer buttons (left-aligned): "Previous" (steps 2–4) · "Next" (primary, steps 1–3, disabled until the step is valid) · "Done" (primary, visible on steps 3 **and** 4 — i.e. the user can save from "Receivers" without visiting "Mutes & Permissions"; shows a loading spinner while saving).
- No inline field-level validation messages anywhere; invalid steps simply disable "Next"/"Done". The only red hints are the receiver/mute card borders and a few specific warnings (grouping-vs-variables, Google Chat over http, Slack/PagerDuty/Google-Chat URLs typed into a Webhook).
- No unsaved-changes guard (back arrow / sidebar navigation silently discards the wizard).

### 6.3 Step 1 — "Query"

1. **Kind** radio (button style): "Static" | "Anomaly". "Anomaly" is disabled unless datasource is Metrics. Switching to Anomaly sets both operators to "above or below by" and the threshold to "2" if empty; switching back sets both operators to "greater than".
2. **Query editor** (shared component `Cne`, also used read-only on the detail page):
   - Datasource radio (button style): "Metrics" · "Logs" · "Traces" · "Mobile". With kind Anomaly, Logs/Traces/Mobile are disabled. Each datasource keeps its own draft query; switching datasource hides the preview chart.
   - **Metrics** → card tabs "Quick" | "Advanced" | "Code". Initial tab: the model's type; "Quick" for a blank rule; "Code" when only a query exists. Each tab keeps its own draft and **switching tab replaces the alert query with that tab's draft**.
     - **Quick**:
       - "CALCULATE" select (280 px): "RPM" (`rpm`), "Error %" (`error_percentage`), "%ile Latency (millis)" (`latency_percentile`), "Avg Latency (millis)" (`latency_average`). Percentile shows a number input (120 px, suffix "%ile", default "90").
       - Filter rows: first row captioned "WHERE", following rows "AND": label select (280 px, searchable, clearable; options `env`, `service`, `root_name`, `service.version`, `host.name`, `http_code`, `exception`, each with a grey one-line description), operator select (160 px): "equals" `=`, "not equals" `!=`, "in" `=~`, "not in" `!~`, value select (280 px; multi-select for in/not in; values fetched when opened, scoped by the rows above). "Remove" (danger) when > 1 row; "Add more" (primary) on the last row.
       - "GROUP BY" multi-select (280 px) of the same 7 labels.
       - "Generated Query" (read-only PromQL editor).
       - Generated PromQL (always adds `span_kind=~"server|consumer"`, latencies ×1000 → ms):
         - RPM: `sum(rate(cube_apm_calls_total{<where>, span_kind=~"server|consumer"} default 0)) by (<group by>) * 60`
         - Error %: `sum(increase(cube_apm_calls_total{<where>, span_kind=~"server|consumer", status_code="ERROR"} default 0)) by (<gb>) * 100 / [ignoring (<http_code|exception>) group_left] sum(increase(cube_apm_calls_total{<where without http_code/exception>, span_kind=~"server|consumer"} default 0)) by (<gb without them>)`
         - %ile Latency: `histogram_quantile(0.9, sum(increase(cube_apm_latency_bucket{…} default 0)) by (<gb>, vmrange)) * 1000`
         - Avg Latency: `sum(increase(cube_apm_latency_total{…} default 0)) by (<gb>) * 1000 / sum(increase(cube_apm_calls_total{…} default 0)) by (<gb>)`
     - **Advanced**:
       - "FROM" metric select (456 px, searchable) with checkbox "Show all" (off → only `cube_apm_*` metrics). Known metrics carry descriptions, e.g. `cube_apm_calls_total` "API calls tracked by CubeAPM. Use this to calculate request rates, e.g. RPM, error rate, etc."; `cube_apm_ingested_bytes_total`, `cube_apm_latency_bucket` ("…Use this to calculate latency percentiles, e.g., p90 latency."), `cube_apm_latency_count`, `cube_apm_latency_sum`, `cube_apm_latency_total`.
       - "WHERE"/"AND" label rows (labels of the chosen metric; same operators). Label descriptions exist for `__name__`, `env`, `exception`, `group_name`, `host.name`, `http_code`, `instance`, `root_name`, `service`, `service.version`, `span_kind`, `status_code`.
       - "SELECT": a row of function cards (header = function name + info-tooltip description + ×). Arguments: "group by" multi-select (aggregations), number inputs (`k`, `min`, `max`, `to_nearest`, `quantile`, `by`). Add-function select (280 px) with option groups:
         - Aggregation: `avg`, `count`, `max`, `min`, `sum`, `topk` (k = 5)
         - Rounding: `ceil`, `clamp` (min, max = 1), `clamp_max` (max = 1), `clamp_min` (min), `floor`, `round` (to_nearest = 1)
         - Range: `changes`, `delta`, `deriv`, `increase`, `rate`, `resets`
         - Histogram: `histogram_quantile` (quantile = 0.9)
         - Operators: `*` (by = 1), `/` (by = 1)
         Functions are applied in order, wrapping the selector, e.g. `max(cube_synthetic_monitor{id="18"}) by (id, group, name)`.
       - "Generated Query".
     - **Code**: "Query Editor" — Monaco PromQL editor (auto-height, no line numbers, autocompletion of metrics/labels/values, PromQL syntax highlighting).
   - **Logs / Traces / Mobile** → card tabs "Builder" | "Code":
     - **Builder**:
       - "STREAM" rows (then "AND"): stream-label select, operator (equals / not equals / in / not in), values; "Remove"/"Add more".
       - "FIELDS" rows: field select (fields starting with `_` hidden), operator, values; "Remove"/"Add more".
       - "PIPES (docs ↗)" (link to docs.cubeapm.com `/logs/querying`): pipe cards + add-pipe select (280 px) offering `stats` and `math`.
         - `stats` card: "group by" multi-select; one or more aggregation rows: "function" (`avg`, `count`, `count_empty`, `count_uniq`, `max`, `median`, `min`, `quantile`, `sum`), argument ("field" select, or "quantile" number default 0.9 + field), "if" (inline LogsQL editor — conditional aggregation), "as" (alias); "Remove" / "Add function".
         - `math` card: "expression" (placeholder "e.g. errors / requests * 100"), "as".
       - "Generated Query" (read-only LogsQL), shape: `{stream matchers} field:filters | stats by (…) count() if (…) as "x" | math … as "y"`.
     - **Code**: "Query Editor" (LogsQL editor with completion).
3. **Unsupported-variables banner** (warning, full width) when the query contains `$__range`, `$__range_s`, `$__step`, `$__increase`, `$__default_0` or `$__cube_apm_*` (these come from APM charts when downsampling is on — true on the playground): "The query contains variables that are not supported in alerts." + small primary button "Fix query" (rewrites `$__range*`/`$__step` → `1i`, `$__increase` → `increase`, `$__default_0` → `default 0`, `$__cube_apm_x` → `cube_apm_x`).
4. **"Generate Graph"** (primary; disabled with empty query) → shows a 20 rem preview chart of the current query over the header time range, legend right; static threshold drawn as a red line that follows the threshold input live; anomaly → bands. Not auto-generated on prefill; must be clicked again after query edits.
5. **"Condition"** — help "Alerts will fire when query results satisfy this condition". Operator select (≥ 200 px) — Static: "equal to", "not equal to", "greater than", "less than", "greater than or equal to", "less than or equal to"; Anomaly: "above by", "below by", "above or below by". Threshold InputNumber (208 px, string mode, placeholder "Alert threshold", suffix addon "deviations" for anomaly; accepts up to 8 integer and 6 decimal digits).
6. **"Additional Condition (optional)"** — help "Alerts with an additional tag `severity=critical` when query results satisfy this condition" (tag rendered as a chip). Same operator + threshold controls. Saved as `expr2` = same query + this condition; instances matching it carry `severity=critical` (inferred, backend).

"Next" is enabled when the query is non-empty and the threshold parses as a number.

Saved expression format:
- Metrics: `(<query>) <op> <threshold>` (newlines added if the query ends with a `#` comment); anomaly uses the same shape with `>`, `<`, or `<>` and the deviation factor, interpreted server-side.
- Logs/Traces/Mobile: `<query> as result | filter result: <op> <threshold>` (`==` becomes `=`) — requires the query to end in a `stats`/`math` pipe.

### 6.4 Step 2 — "Settings"
| Field | Control | Help text (exact) | Options / default | Validation |
|---|---|---|---|---|
| "Evaluation Interval" | Select (80 px) | "Decides how frequently the alert query is evaluated" | 30s, 1m, 2m, 5m, 10m, 15m, 30m, 1h, 2h, 3h, 4h, 6h, 8h, 12h, 24h (15 options) · default 1m | — |
| "Wait for" | Select (120 px) | "Decides how long to wait before firing alert. Alert will be fired if the alert condition is continuously satisfied for the waiting period." | Immediate, 30s, 1m, 2m, 3m, 5m, 10m, 15m, 30m, 1h, 2h, 3h, 4h, 6h, 8h, 12h, 24h (17) · default 5m | — |
| "Repeat after" | Select (120 px) | "Decides how long to wait before triggering alert notification again, in case the alert is not resolved by then." | 5m, 10m, 15m, 30m, 1h, 2h, 3h, 4h, 6h, 8h, 12h, 24h (12) · default 4h | — |
| "Alert Name" | Input (640 px), placeholder "Enter Alert Name" | "Give a short but descriptive name for your alert. Variables can be used, e.g., `{{ .Labels.service }}` will be replaced with the value of "service" label in alert query result. If the label name contains dot (.) character, e.g., "host.name", then `{{ index .Labels "host.name" }}` should be used instead.The environment is added to notification titles automatically whenever the alert query returns an "env" label, e.g. by adding env under GROUP BY. Do not also use `{{ .Labels.env }}` in the name, or the environment will appear twice." (note the missing space in "instead.The") | — | required |
| "Tags (optional)" | rows of Input "Key" (200 px) + Input "Value" (200 px) + "Remove" (danger); "Add" (primary) | "Add key-value pairs as tags to categorize and filter alerts. Reserved fields (alertgroup, alertname, group, rule_id, query) cannot be used as tag keys." | none | keys non-blank, unique, not reserved (no message — Next just disables) |
| "Group" | AutoComplete (320 px, clearable) | "Alerts with same group name are shown together on the alerts page. You can select one of the existing groups from the suggestions or provide a new name to create a new group." | existing groups + "Default Group" · default "Default Group" | required |

### 6.5 Step 3 — "Receivers"
- "Receivers" heading + help "Choose from pre-defined Receiver Groups or define custom receivers for this alert".
- Selector rows: first row Select (≥ 320 px, searchable) with "Custom" + every receiver group; picking a group adds a row-level "Remove" (if > 1 rows) and an "Add more" button (adds the **first** group in the list — duplicates possible). Picking "Custom" clears the groups and copies the union of the previously selected groups' receivers into editable custom receivers.
- When groups are selected, the channel cards below show the groups' receivers **read-only** ("Test"/"Delete" disabled) and "Add Receiver" is hidden.
- Custom: channel cards (§7) + "Add Receiver" (adds a Webhook card).
- "Notification Grouping" — help "Whether to attempt to group multiple alerts into a single notification. If disabled, each alert will trigger a separate notification." Radio "On" | "Off" (On = `grouping_disable:false`). Red warning when the name contains `{{` and grouping is On: "Notification Grouping should be Off for variables in Alert Name to be replaced properly."
- "Next"/"Done" require at least one receiver group, or ≥ 1 custom receiver with all receivers valid. **An alert cannot be saved without a receiver.**

### 6.6 Step 4 — "Mutes & Permissions"
- **"Mutes"** + help "Choose from pre-defined Mute Groups or define custom mutes for this alert". Same selector pattern ("Custom" + mute groups, "Remove", "Add more"). Group intervals are shown read-only; Custom shows editable interval cards + "Add Mute" (§9.2). A new rule starts with no intervals.
- **"Permissions"** (§13): Radio "Role Based" | "Custom".
- "Done" disabled when receivers invalid, any mute interval invalid, or Custom permissions contain no complete "Editor" row.

### 6.7 Save
`POST /api/alerts/api/v1/rules` (new/clone) or `PUT /api/alerts/api/v1/rules` (edit) with:
```
{ id: <id|0>, name, status: "ACTIVE"|"PAUSED" (kept from the rule), datasource: "prometheus"|"vlogs"|"traces"|"mobile",
  kind: "static"|"anomaly", interval: <s>, expr: <query+condition>, expr2: <query+critical condition | "">,
  for: <s>, labels: {<tags>, group: <group>}, repeat_interval: <s>, grouping_disable: <bool>,
  config: { model: <builder model|undefined>, receiver_group_ids: [..]|undefined, mute_group_ids: [..]|undefined },
  receiver: { email_configs, slack_configs, pagerduty_configs, jira_configs, opsgenie_configs, googlechat_configs, msteamsv2_configs, webhook_configs },
  mute: { time_intervals: [ { times: [{start_time:"HH:MM", duration_minutes:N}], weekdays:[...], location:"Area/City" } ] },
  permissions: [ {entity_type:"team"|"user", entity_id, permission:"viewer"|"editor"} ] }
```
Note the write schema differs from the read schema (`expr`/`query`, `expr2`/`query2`, `for`/`duration`, `repeat_interval`/`repeatInterval`, `grouping_disable`/`groupingDisable`). Success → navigate to `/alerts` (the hub, not the rule) with no toast. Failure → toast "Failed to save alert: <error>". Annotations (summary/description) are not editable anywhere in the UI.

Known code-level issue (inferred, likely bug): the "kind changed" effect also runs when an existing **anomaly** rule is loaded (or cloned), resetting both stored operators to "above or below by"; an "above by"/"below by" rule silently changes direction if saved.

---

## 7. Receivers (contact points) — the channel card (`xUn`, list editor `TY`)

Used in three places with identical UI: wizard step "Receivers" (custom), Receiver Group drawer, SLO drawer (fast/slow burn).

### 7.1 Card frame
Bordered card (red border while invalid). Left column: "Receiver Type" Select (256 px) + type-specific fields. Right column: "Test" button and "Delete" (danger) button.
- Receiver Type options appear only for integrations enabled in server config `alertManagerIntegrations` (playground: Email, Slack, PagerDuty, Opsgenie, Google Chat, Microsoft Teams, Webhook; **Jira disabled**). Order: "Email", "Slack", "PagerDuty", "Jira", "Opsgenie", "Google Chat", "Microsoft Teams", "Webhook".
- Changing the type resets the card to that type's empty defaults (data typed for the previous type is lost).
- "Test": `POST /api/alertmanager/test-notify` with a receiver containing just this card → toast "Test notification sent successfully!" or "Failed to send test notification: <server error>". Disabled while sending, when the card is invalid, or read-only.
- "Delete": removes the card instantly (no confirmation; disabled in read-only).
- "Add Receiver" (below the list) always adds a **Webhook** card.
- Common checkboxes (defaults): "Send notifications for resolved alerts" (on), "Show query in notification" (off), "Show sample log in notification" (off; hidden when server flag `alertmanager.sample-log.disable` is true).

### 7.2 Fields per type
| Type (`type`) | Fields (exact labels / help) | Checkboxes | Valid when | Stored as |
|---|---|---|---|---|
| "Email" (`email`) | "Addresses" — textarea (2 rows); help "You can enter multiple email addresses separated by commas" | resolved | `to` non-blank (no address-format check) | `email_configs[{to:"a@x, b@y", send_resolved}]` |
| "Slack" (`slack`) | "Recipient" — searchable select of channels; help "Select channel to receive alerts. Private channels will only show up where CubeAPM is a member of the channel."; link button "Refresh channels list" | query, sample log, resolved | channel chosen | `slack_configs[{channel:<channel id>, …}]` |
| "PagerDuty" (`pagerduty`) | Not connected: primary button "Connect with Pagerduty Service" + help "The connect flow will open in a new browser tab so that you can simply close that tab if you want to cancel." Connected: "Service Name" (read-only input) and "Integration Key" (read-only input, shown in clear text). Note under the checkbox: "Enabling resolved alerts notifications will also auto-resolve the corresponding incidents on PagerDuty." | resolved | service name + routing key present | `pagerduty_configs[{service_name, routing_key, send_resolved}]` |
| "Jira" (`jira`) | "Project" — searchable select ("<name> (<KEY>)"), help "Select project", link "Refresh projects list"; "Issue Type" — searchable select, help "Select issue type", link "Refresh issue types list". Changing project clears issue type and loads its types. | resolved | project + issue type | `jira_configs[{project:<KEY>, issue_type:<name>}]` |
| "Opsgenie" (`opsgenie`) | "Team" — searchable select of teams | resolved | team chosen | `opsgenie_configs[{api_key:<team key>}]` (the team's API key is the stored value) |
| "Google Chat" (`googlechat`) | "Webhook URL" — textarea; help "Enter Webhook URL of the Space to receive alerts (documentation)"; red warning when CubeAPM itself is served over http: "Google chat translates http links to https, hence links to CubeAPM in alert notifications will be broken, as CubeAPM is running on http (and not https)." | query, sample log, resolved | URL non-blank | `googlechat_configs[{url}]` |
| "Microsoft Teams" (`msTeamsV2`) | "Webhook URL" — textarea; help "Enter Microsoft Teams incoming webhook URL. documentation" | query, resolved (no sample log) | URL non-blank | `msteamsv2_configs[{webhook_url}]` |
| "Webhook" (`webhook`) | "Webhook URL" — textarea; help "Enter Webhook URL to receive alerts (documentation)". Red, non-blocking warnings: PagerDuty events URL → "PagerDuty webhooks are not supported here. Please use PagerDuty from Receiver Type above." (+ "Connect with PagerDuty" docs link if PD is not enabled); `hooks.slack.com` → "Slack webhooks are not supported here. Please use Slack from Receiver Type above." (+ "Connect with Slack" docs link); `chat.googleapis.com` → "Google Chat webhooks are not supported here. Please use Google Chat from Receiver Type above." "Headers": rows Input "name" / Input "value" / "Remove", button "Add". "Payload": monospace textarea (10 rows), no help or variable reference. | resolved | URL non-blank (warnings do not block) | `webhook_configs[{url, headers:{name:value}, body, send_resolved}]` |

"documentation" links go to `https://docs.cubeapm.com/configure/alerting/<connect-with-google-chat | connect-with-microsoft-teams | webhook | connect-with-pagerduty | connect-with-slack>?utm_source=cubeapm&utm_medium=in-app&utm_campaign=alerting-receiver`.

### 7.3 Connect / lookup APIs
| Integration | Call | Notes |
|---|---|---|
| Slack | `GET /api/alertmanager/api/v1/connect/slack/channels?refresh=false\|true` → `[{id, name, is_private, …}]` (Slack conversation objects; playground returns 106) | `refresh=true` on "Refresh channels list" |
| Opsgenie | `GET /api/alertmanager/api/v1/connect/opsgenie/teams` → `[{team, api_key}]` | playground: 1 team "cubedemo-oncall" |
| Jira | `GET /api/alertmanager/api/v1/connect/jira/projects?refresh=` → `[{key,name}]`; `GET …/jira/issue-types?project=<KEY>&refresh=` → `{issueTypes:[{name}]}` | playground: 405 "jira not configured" |
| PagerDuty | browser flow: `https://app.pagerduty.com/install/integration?version=2&app_id=<config pagerduty app id>&redirect_url=<current URL>` opened in a **new tab**; before opening, the whole form is serialised to `sessionStorage` (`cube_alert_state` for the wizard incl. current step, `cube_arg_state` for receiver groups, `cube_slo_state` for SLOs). PagerDuty redirects the new tab back with `?config={"integration_keys":[{name, integration_key}]}`; the page restores the form and replaces the pending PagerDuty card with one card per returned service (inheriting the card's checkbox values); the receiver-group drawer re-opens automatically. | Original tab keeps its own unsaved copy |
| Slack / Jira / Opsgenie connection itself | none in the UI | enabled/configured server-side (`alertManagerIntegrations`, `alertmanager.jira.site-name`, `alertmanager.jira.user-email` flags) |

---

## 8. "Receiver Groups" tab (`NUn`) + drawer (`LUn`)

- Data: rules + `GET /api/alerts/api/v1/receivergroups` (+ Slack channels, Opsgenie teams). Each group's usage = rules whose `config.receiver_group_ids` contain it. Toast "Failed to fetch alert receiver groups: …". No polling.
- Toolbar: "Search" input (searches group name, every address/channel/service/project/team/URL in it, and names of the rules using it) · "New" + plus (disabled for viewers).
- List (Collapse, all collapsed): header = name · "N rule" / "N rules" · icon buttons (non-viewers only): "Edit" (pencil), "Clone" (copy → drawer prefilled with "Copy of <name>"), "Delete" (trash; **disabled while any rule uses the group**, with no tooltip explaining why). Body: receivers summary (same "Email: … / Slack: …" chips as §3) and, if used, "Rules" (bold) with links to each rule.
- Empty: Empty "No data".
- Delete modal: title "Delete Alert Receiver Group", body "Are you sure you want to delete **<name>**?", "Cancel" / "Yes" → `DELETE /api/alerts/api/v1/receivergroups?id=<id>` (toast "Failed to delete alert receiver group: …").
- Drawer (right, large): title "Alert Receiver Groups"; header-right primary "Done" (disabled until name set and ≥ 1 valid receiver; spinner while saving). Body: "Name" + Input placeholder "Enter Name"; "Receivers" list (§7) starting with one Webhook card; "Add Receiver". Save: `POST` (new, response `{id}`) or `PUT /api/alerts/api/v1/receivergroups` with `{id, name, receiver:{…_configs}}`; drawer closes, list updates in place; toast "Failed to save alert receiver group: …". Closing the drawer (×/mask) discards silently.
- Editing a group changes notification routing for every rule that uses it (no warning shown).

---

## 9. "Mute Groups" tab (`yUn`) + drawer (`_Un`) and the mute-interval editor

### 9.1 List
Same pattern as Receiver Groups: "Search" (name only) · "New"; rows: name · "N rule(s)" · "Edit" / "Clone" ("Copy of …") / "Delete" (disabled while used). Body: interval summary ("Start at 21:00", "Mute for 10h", "Every day", "Timezone Asia/Calcutta (+05:30)") and "Rules" links. Delete modal "Delete Alert Mute Group" with the same body copy → `DELETE /api/alerts/api/v1/mutegroups?id=<id>`. Toasts "Failed to fetch alert mute groups: …", "Failed to delete alert mute group: …", "Failed to save alert mute group: …".

Drawer: title "Alert Mute Groups"; "Done" (disabled until name set and ≥ 1 valid interval); "Name" (placeholder "Enter Name"); "Mutes" editor starting with one blank interval; "Add Mute". Save `POST`/`PUT /api/alerts/api/v1/mutegroups` `{id, name, mute:{time_intervals:[…]}}`.

### 9.2 Interval card (`bUn`) — shared by wizard and drawer
| Field | Control | Notes |
|---|---|---|
| "Start at" | TimePicker `HH:mm` (160 px) | required |
| "Mute for" | two number inputs side by side (80 px each) with suffixes "h" and "m" | h ≥ 0, m ≥ 0, h + m > 0 |
| "Every" | help "If no day is selected, then mute will be activated everyday"; checkboxes "Mon" "Tue" "Wed" "Thu" "Fri" "Sat" "Sun" | values `monday`…`sunday` |
| "Timezone" | searchable Select (240 px) of every IANA zone, label with underscores as spaces and a grey UTC offset (e.g. "Asia/Calcutta +05:30") | default = browser zone |
| "Delete" | danger button (right) | — |

Card border turns red when invalid; a freshly added card is invalid until edited. Stored as `{times:[{start_time:"HH:MM", duration_minutes:N}], weekdays:[…], location}` — one start/duration per interval; no month, day-of-month or year rules; a mute that crosses midnight is expressed by duration (e.g. 21:00 + 600 min). What a mute does at send time (inferred): notifications during the window are suppressed and logged as `MUTE` in Notification History; the rule keeps evaluating and changing state.

---

## 10. Snoozes (= Alertmanager v2 silences) — create, show, expire

- Concept naming: the UI says "Snooze"; the API is Alertmanager silences. Distinct from "Pause" (rule status PAUSED — stops evaluation, inferred) and "Mute" (recurring schedule).
- **Create (preset)**: actions toolbar → Snooze menu "5m" / "15m" / "30m" / "1h" → `POST /api/alertmanager/api/v2/silences` with
  `{matchers:[{name:"rule_id", value:"<id>", isEqual:true, isRegex:false}], startsAt:<now, floored to the minute>, endsAt:<start+N min>, createdBy:"", comment:""}`. No confirmation, no success toast; the chip appears immediately in the expanded panel (initially neutral colour because it is stored locally as `pending`, turns red on the next 30 s poll). Error toast "Failed to create snooze: …".
- **Create (custom)**: menu "Custom" → modal "Snooze" (no footer): "Start at" date-time picker (`YYYY-MM-DD HH:mm`, has "Now", not clearable, **empty by default**) and "Snooze for" hours ("h") + minutes ("m") number inputs; buttons "Cancel" / primary "Create" (disabled until a start is picked and the duration is > 0 and non-negative). Allows scheduling a future snooze (shown as a neutral "pending" chip) or a past start.
- Scope: always the **whole rule** (all its instances); no per-instance or per-label silencing, no comment/author captured, no "who snoozed" shown.
- **Show**: only inside the expanded rule panel / detail page ("Snooze" chips "MMM DD, HH:mm - MMM DD, HH:mm"; red = active, neutral = scheduled). The collapsed list row and the group row give no snooze indication.
- **Expire**: × on a chip (non-viewers) → `DELETE /api/alertmanager/api/v2/silence/<id>`, chip removed; no confirmation. Expired silences are filtered out client-side; there is no silences list page and no history of past snoozes.
- Notifications suppressed by a snooze appear in Notification History with status `SNOOZE` (inferred from the status filter).

---

## 11. "Notification History" tab (`lVn`)

- Filters row: "Status" + Select (128 px): "ALL" (default), "SUCCESS", "ERROR", "MUTE", "SNOOZE" · "Alert" + searchable, clearable Select (520 px): "ALL" + every rule name (preselected from `?rule_id`) · "Search" input (autofocus; client-side, matches rule name, receiver type, status or details within the loaded page(s) only).
- Data: `GET /api/alertmanager/api/v1/alert-logs?start=<s>&end=<s>&limit=20[&status=…][&rule_id=…][&id=<last id> for next page]`. Re-queries when status, alert or time range changes. Response rows: `{id, rule_id, rule_name, receiver_type, receiver_data, status, details, created_at}`.
- Columns: "Alert Name" (5/24) · "Receiver" (6/24; receiver rendered like §3, e.g. "Webhook: http://…") · "Status" (2/24; tag green SUCCESS / red ERROR / grey otherwise) · "Details" (8/24; single-line truncated; **click opens a modal**) · "Timestamp" (3/24; local `YYYY-MM-DD HH:mm:ss`). Rows hover-highlight; no sorting; rule name is not a link.
- Details modal: title "<rule name or N/A> - <status>", 90 % wide, 70 vh read-only Monaco viewer (word-wrap) of the raw details text.
- Pagination: red underlined "Load more" link under the list while the last page returned ≥ 20 rows (cursor = last row id).
- Empty: Empty (default). There is no spinner: until the first response arrives the tab shows the Empty state plus the "Load more" link.
- Playground: 186 entries in the last 7 days, all `SUCCESS`, all `webhook`, all for rule 437, `details` always empty.

---

## 12. "Stats" tab (`MVn`)

A generic data table (`Wn`) driven by three PromQL queries over the `ALERTS` series that the rule evaluator writes into the metrics store (one series per firing rule instance, `alertstate="firing"`):

| Column | Query | Evaluation |
|---|---|---|
| "ID" (rule_id, 1/24), "Group", "Alert Name" | label columns | each cell links to `/alerts/<rule_id>` |
| "Incidents" (2/24) | `increases_over_time(max(default_rollup(ALERTS{alertstate="firing"}[30m]) default 0) by (rule_id, group, alertname)[:1m])` | range query (`POST /api/metrics/api/v1/query_range?nocache=true`), values **summed** over the selected range → number of not-firing→firing transitions |
| "Total Time (minutes)" (2/24) | `sum_over_time(max(default_rollup(ALERTS{alertstate="firing"}[30m]) default 0) by (rule_id, group, alertname)[:1m])` | range query, summed → minutes spent firing |
| "Total Time %" (3/24) | `sum_over_time(max(default_rollup(ALERTS{alertstate="firing"}[30m]) default 0) by (rule_id, group, alertname)[$__range:1m]) * 60 / $__range * 100` | instant query at range end (`POST /api/metrics/api/v1/query`) → % of the range spent firing; rendered with a 0–100 progress bar |

- Default sort: "Incidents" descending; every header has the circular sort icon; label columns sort A→Z.
- Search box above the table: a structured "searchql" editor (field:value syntax with completion over the table's label values), not a plain text box.
- ⋮ menu next to the search box: "Create Alert - Incidents", "Explore - Incidents", "Create Alert - Total Time (minutes)", "Explore - Total Time (minutes)", "Create Alert - Total Time %", "Explore - Total Time %", divider, "Download CSV".
- Hovering an "Incidents" or "Total Time (minutes)" cell pops a mini time-series chart of that rule's series over the range (not for "Total Time %", which is an instant query).
- Shows 20 rows, then "Showing 20 out of N results. Show All". Empty → "No data". A red refresh icon appears if a query fails (click retries).
- Only rules that fired at least once in the window appear (no zero rows for healthy rules).

---

## 13. Permissions

- Global roles (config / Admin › Users): "Viewer" (`viewer`), "Editor" (`editor`), "Admin" (`admin`), plus "Default" and "None". `editor`/`admin` may edit. In this build the current-user role helper returns `admin` unconditionally, so global-role gating is effectively off; the per-rule `permission` field returned by the API ("admin" for every playground rule) is what disables controls.
- Per-rule flags returned by the API: `permission` (viewer/editor/admin — the caller's effective right on that rule) and `readonly` (true for rules the UI must not change — inferred: rules loaded from the server-side `alerts.config-file`). Controls requiring edit right: Pause switch, Snooze, Edit, Delete, wizard access. Clone requires the global role, not the rule permission.
- Wizard step 4 "Permissions": Radio "Role Based" | "Custom".
  - Role Based help: "Users with Viewer role can view. Users with Editor role can edit."
  - Custom: rows [Select "Select team or user" (option groups "Teams" and "Users"; users shown "First Last <email>"; already-used entities hidden) · Select (90 px) "Viewer" | "Editor" · "Remove" (danger)] + "Add Permission" (adds a blank team row with Viewer). Save is blocked unless at least one complete row is "Editor". Switching back to Role Based clears all rows.
  - Teams/users lists come from app config (`teams`, `users`; managed in Settings › "Teams" with roles "Member"/"Admin"). The playground config exposes none, so the Custom dropdown is empty there.
  - Loaded via `GET /api/frontend/api/v1/permissions?resource_type=alert&id=<id>` (empty array on the playground); written as `permissions[]` inside the rule payload.
- No sharing UI on the list/detail pages; no indication of who owns or can edit a rule.

---

## 14. SLO alerts & synthetic monitors

### 14.1 SLOs
- Not managed in the Alerts module. Configured per endpoint from the APM service page: Detail tab with an endpoint selected → "Service Level Objectives" section → icon button with tooltip "Configure SLOs" (admins only) → right drawer titled "Service Level Objectives". Budget-burn charts ("Error Budget Burn %", "Latency Budget Burn %", threshold line at 100) render under that section; SLOs are listed on `/slo`.
- Drawer copy: intro "SLOs enable you to set error rate and latency targets for your APIs and measure performance against those targets. You can also configure alerts to get notified when the targets are at risk."; info banner "It can take upto 5 minutes for results to start appearing after configuring SLOs".
  - "Error Rate Objective" + Switch; help "Specify how much error rate is acceptable. For example, if your API should respond successfully more than 99.5% times, then your error budget is 0.5%."; "Budget" (number, suffix "%").
  - "Latency Objective" + Switch; help "Specify how much slow response rate is acceptable. For example, if your API should respond within 0.2s more than 99.5% times, then your slow response budget is 0.5% at the threshold of 0.2s."; "Budget" (%), "Threshold" (s).
  - "Alerts" + Switch; help "A set of multi window multi burn rate alerts will be configured to notify you when the objectives are at risk. (learn more about multi window multi burn rate alerts ↗)" (links to sre.google workbook). When on: "Receivers for Fast Burn alerts" — "Specify where to deliver critical alerts (when budget is being consumed fast)." + the receiver card list (§7, no receiver-group picker); "Receivers for Slow Burn alerts" — "Specify where to deliver non-critical alerts (when budget is being consumed slowly, but will still lead to a breach of the objective)." + receiver card list.
  - "Done" disabled until budgets are 0–100, threshold ≥ 0, and (if Alerts on) at least one objective on and both receiver lists valid.
- Stored via `POST/PUT /api/alerts/api/v1/slos` as `{id, env, service, endpoint, errorEnabled, errorBudget, slowEnabled, slowBudget, slowThreshold, alertsEnabled, fastBurnReceiver, slowBurnReceiver}` — burn-rate receivers are inline receivers, not receiver groups. The burn-rate alert rules themselves are generated server-side; whether they appear in the Alerts list was not observable (no playground SLO has alerts enabled) (inferred: they do not appear — the rule API returns only the 9 user rules).

### 14.2 Synthetic monitors (`/synthetic`, sidebar "Monitors")
- Monitors are separate objects (`/api/synthetic-monitors/api/v1/synthetic-monitors`: id, group_name, name, method, url, headers, success_codes_regex, status). Their health is the metric `cube_synthetic_monitor` (1 up / 0 down) and `cube_synthetic_monitor_error`.
- Alerting on a monitor = an ordinary alert rule whose Advanced model is `max(cube_synthetic_monitor{id="<monitor id>"}) by (id, group, name)` with condition `== 0`. The monitors page links rules to monitors by parsing that model/query.
- Per monitor row: if no rule exists → bell icon button, tooltip "Create Alert" → wizard prefilled (Advanced model, "equal to" 0; name, group, receivers **not** prefilled). If rules exist → bell dropdown listing each rule by name (→ `/alerts/<id>`) + divider + "Create Alert".
- Playground: 8 of the 9 rules are synthetic-down rules (all but #437); they carry extra tags `kind=synthetic`, `severity=critical` and annotations `summary`/`description` that the UI cannot edit (created by API/seed).

---

## 15. Every entry point into the Alerts module

### 15.1 Navigation entries
| From | Control | Target |
|---|---|---|
| Sidebar | "Alerts" (bell) | `/alerts` + current query string minus delete-list |
| Alerts tab | "New" | `/alerts/new` (blank) |
| Rule row / detail page | "View" eye | `/alerts/<id>` |
| | "Edit" pencil | `/alerts/<id>/edit` |
| | "Clone" copy | `/alerts/new` + state `{rule}` |
| | "Notification History" clock | `/alerts?tab=alert-logs&rule_id=<id>` |
| Stats tab | ID / Group / Alert Name cell | `/alerts/<rule_id>` |
| Receiver Groups / Mute Groups tab | "Rules" list item | `/alerts/<id>` |
| Synthetic Monitors | bell dropdown item | `/alerts/<id>` |
| Notification channels (external) | link in Slack/email/etc. | `/alerts/<id>?alert_id=<instance>` (live `source` field); `notifyTime` / `incidentTime` params are understood (inferred to be added by notification templates) |

### 15.2 "Create Alert" deep links (all go to `/alerts/new` with router state; nothing in the URL)
| Where | Menu / control label | Prefill (`state`) |
|---|---|---|
| Any **titled** time-series chart (≈750 usages: APM Overview/RED/Detail/External/DB/Errors/Runtime, every Infra integration page, Browser, Mobile, dashboard panels, Admin stats, Alerts "Recent Alerts", Monitors "Active Monitors"…). Untitled charts have no ⋮ menu: the Explore page chart, the Logs/Traces histogram, the alert detail chart, the wizard preview, table-cell hover charts. | chart ⋮ → "Create Alert" (or "Create Alert - <series title>" for multi-query charts) and "Create Alert (Total)" when the chart has a total line | `{model, query, datasource}` of that query (model only where the chart defines one) |
| Any data table (APM RED Table view, Stats tab, dashboard tables…) | table ⋮ → "Create Alert - <column title>" per numeric column | `{model, query, datasource}` of that column |
| Scorecard / single-stat panels | ⋮ → "Create Alert", and "Create Alert (Secondary)" when the card has a comparison query | `{model, query, datasource}` |
| Dashboard horizontal-bar, pie, treemap panels | ⋮ → "Create Alert" | `{model, query, datasource}` |
| Dashboard logs panel | ⋯ → "Create Alert" | `{datasource: vlogs\|traces\|mobile, query: "<panel query> \| stats count()"}` |
| Logs (`/logs`), Traces (`/traces`), Mobile Traces (`/mobile-traces`) query bar | ⋮ → "Explore", "Create Alert", "Download CSV" | `{datasource: vlogs\|traces\|mobile, query: "{<stream matchers incl. env>} <current filter> \| stats count()"}` |
| Synthetic Monitors | bell "Create Alert" | `{model: Advanced max(cube_synthetic_monitor{id}) by (id, group, name), condition: "==", threshold: "0"}` |
| Rule actions | "Clone" | `{rule}` (everything; name "Copy of …") |

APM charts that carry a **Quick** model (open the Quick tab with filters pre-selected): service Overview "RPM" (env, service; group by `service.version`) and "Error %"; RED tab Graph view "RPM", each latency chart (percentile/average) and "Error %" (env, service; group by `root_name`); endpoint Detail "RPM" (env, service, root_name; group by `service.version`). **Only when metric downsampling is off.** On the playground downsampling is on (`apm.downsampling.use` + `metrics.downsampler.mode=on`), so these charts pass only a raw query containing `$__cube_apm_*`, `$__increase`, `$__default_0` placeholders → the wizard opens on the Code tab with the "The query contains variables that are not supported in alerts." banner and a "Fix query" button.

Never prefilled by any entry point: name, group, tags, condition (except monitors), receivers, mutes. The source page's service/endpoint context is not carried as a name or tag.

Not an entry point: the Explore page (`/explore`) — its chart is untitled and its table hides the menu, so although every chart's ⋮ offers "Explore", Explore itself offers no "Create Alert" (the user must go back to a titled chart, or copy the query into the wizard's Code tab).

Not surfaced anywhere else: no page outside `/alerts` (Home, APM services, Infra, Logs, Traces, dashboards) shows rule state, firing counts or incident banners; the bundle reads `ALERTS{…}` only in the Alerts tab ("Recent Alerts") and the Stats tab. The only alert data shown elsewhere is the Synthetic Monitors bell dropdown (rule names).

### 15.3 Chart/table ⋮ menus (for reference)
- Time-series chart: [page-specific actions], "Compare" (opens a full-width modal: "Compare with" select "1 hour ago" / "1 day ago" / "1 week ago" and the two charts stacked), divider, "Create Alert[ - title]", "Explore[ - title]", optional "(Total)" pair. No CSV export on charts.
- Table: [page actions], divider, per column "Create Alert - X", "Explore - X", divider, "Download CSV".
- When a titled chart's query fails, its header shows the error text (truncated, full text on hover) and a red circular-arrows icon that retries. Untitled charts have no header at all — hence no ⋮ menu (no "Create Alert") and no inline error (toast only).

---

## 16. Micro-interactions & system behaviour

- Toasts (antd `message`): errors for every failed call ("Failed to fetch alerts", "Failed to save alert", "Failed to delete alert", "Failed to create snooze", "Failed to delete snooze", "Failed to fetch alert", "Failed to fetch alert logs", "Failed to fetch rules", "Failed to fetch permissions", "Failed to fetch slack channels", "Failed to fetch opsgenie teams", "Failed to fetch Jira projects", "Failed to fetch Jira issue types", "Failed to fetch alert receiver group(s)", "Failed to save/delete alert receiver group", "Failed to fetch/save/delete alert mute group(s)", "Failed to send test notification", "Alert not found"). The **only** success toast is "Test notification sent successfully!". Save, delete, pause, snooze and expire all succeed silently.
- Confirmation dialogs: delete rule / receiver group / mute group only ("Cancel" / "Yes"). Pause, snooze, expire-snooze, delete receiver card, delete mute interval, remove permission happen instantly with no undo.
- Polling: rule list every 30 s. Detail page, history, groups: no polling. Header auto-refresh (Off/5s/…/15m) only bumps `refresh`, which the rule list ignores.
- Loading: list/detail show spinners; Notification History shows "No data" + "Load more" until the first response.
- Keyboard: no shortcuts; search inputs autofocus on Alerts, Receiver Groups, Mute Groups, Notification History tabs.
- Unsaved-change guards: none (wizard, drawers).
- Import/export: none for rules (no YAML/JSON/Terraform view or download); CSV only on tables. Docs links: only inside receiver help text and the Logs builder "PIPES (docs)".
- The `refresh` URL param is a cache-buster (epoch ms) written by the time picker/refresh button; sharing a URL with it does not freeze the data.
- Pause and snooze are not optimistic: the switch / chip updates only after the request succeeds; on failure only an error toast appears.

---

## 17. API reference (as used by the UI)

| Method & path | Used for | Notes |
|---|---|---|
| GET `/api/alerts/api/v1/rules` | list; editor; history filter; group usage counts; monitors | array of rules (read schema) |
| GET `/api/alerts/api/v1/rules?id=<id>` | detail page | single rule |
| POST / PUT `/api/alerts/api/v1/rules` | create / update (incl. pause) | write schema §6.7 |
| DELETE `/api/alerts/api/v1/rules?id=<id>` | delete | |
| GET / POST / PUT `/api/alerts/api/v1/receivergroups`, DELETE `?id=` | receiver groups | `{id, name, receiver}` |
| GET / POST / PUT `/api/alerts/api/v1/mutegroups`, DELETE `?id=` | mute groups | `{id, name, mute}` |
| GET `/api/alertmanager/api/v2/silences[?filter=rule_id%3D<id>]` | snoozes | Alertmanager v2 silence objects |
| POST `/api/alertmanager/api/v2/silences` | create snooze | returns `{silenceID}` |
| DELETE `/api/alertmanager/api/v2/silence/<id>` | expire snooze | |
| GET `/api/alertmanager/api/v1/alert-logs?start&end&limit=20&status&rule_id&id` | notification history | cursor pagination by `id` |
| POST `/api/alertmanager/test-notify` | "Test" button | body = receiver object |
| GET `/api/alertmanager/api/v1/connect/slack/channels?refresh=` | Slack picker | |
| GET `/api/alertmanager/api/v1/connect/opsgenie/teams` | Opsgenie picker | |
| GET `/api/alertmanager/api/v1/connect/jira/projects?refresh=`, `/jira/issue-types?project=&refresh=` | Jira pickers | |
| GET `/api/frontend/api/v1/permissions?resource_type=alert&id=` | permissions | |
| GET `/api/frontend/api/v1/config` | integrations, flags, teams, users | |
| GET/POST/PUT `/api/alerts/api/v1/slos` | SLO drawer | |
| POST `/api/metrics/api/v1/query_range?nocache=true`, `/api/metrics/api/v1/query` | charts, Stats | form-encoded `query,start,end,step` |
| POST `/api/{logs\|traces\|mobile}/select/logsql/stats_query_range` (`stats_query`) | logs/traces/mobile previews | |
| POST `/api/anomaly/api/v1/query_band` | anomaly bands | returns series labelled `cube.anomaly.type` = `prediction` / `deviation` |
| label APIs (`In`, `Tw` helpers) | label/value pickers | |

Rule read schema (playground): `id, name, state (inactive|pending|firing), health (ok|…), status (ACTIVE|PAUSED), datasource, kind, interval, duration, repeatInterval, groupingDisable, query, query2, labels {group, rule_id:"{{ .GroupID }}", …tags}, annotations {alertname, cube.kind, datasource, interval, value:"{{ printf \"%.2f\" .Value }}", summary?, description?}, config {model, receiver_group_ids, mute_group_ids}, receiver {…_configs}, mute {time_intervals}, permission, readonly, lastEvaluation, alerts[]|null`.
Alert instance: `state, name, value (string), labels {alertname, group, query, rule_id, …series labels}, annotations {…, cube_alert_event_time, value:"0.28"}, activeAt, id, rule_id, group_id, expression, source ("<base>/alerts/<rule>?alert_id=<id>"), restored, stabilizing`.

---

## 18. Live playground data (2026-10-15)

- **Rules: 9.** All `datasource: prometheus`, all `kind: static`, all `health: ok`, all `permission: admin`, `readonly: false`, `query2` empty on all, `interval` 60 s on all.
  - #437 "Payment error rate high (POST /v1/payments)" — group "Payments", **firing**, ACTIVE, `duration` 300 s, `repeatInterval` 3600 s, grouping on, `config.model: null` (Code query with explicit `[5m]` windows: `(sum(increase((cube_apm_calls_total{env="UNSET",service="payment-service",root_name="POST /v1/payments",span_kind=~"server|consumer",status_code="ERROR"} default 0)[5m])) * 100 / sum(increase((…)[5m]))) > 0.1`), routed via receiver group #7, no mutes. One instance: firing since 2026-10-15T02:36Z, value ≈ 0.28 (%), labels = alertname/group/query/rule_id only (no service label because the query aggregates everything away).
  - #426, #427, #428, #429, #430, #431, #432, #433 "Synthetic down - <monitor>" — groups "CubeAPM Public" (Docs, Marketing Site, Playground), "External Deps" (Cloudflare, GitHub Status), "Default Group" (tesr, test, test monitor); Advanced model `max(cube_synthetic_monitor{id="N"}) by (id, group, name) == 0`; `duration` 120 s; `repeatInterval` 3600 s; inline Email receiver `oncall@cubedemo.example`; tags `kind=synthetic`, `severity=critical`; `mute: {}`. Only #426 is ACTIVE (inactive state); the other 7 are PAUSED with `lastEvaluation` = `0001-01-01T00:00:00Z` (never evaluated). Some carry `summary`/`description` annotations (not visible in the UI).
  - Groups present: "Payments", "External Deps", "CubeAPM Public", "Default Group".
  - Not present in data: anomaly rules, logs/traces/mobile rules, pending state, unhealthy rules, critical (`query2`) conditions, inline mutes, mute-group usage, custom permissions.
- **Receiver groups: 1** — #7 "Payments on-call (demo)": one webhook (`http://127.0.0.1:3140/api/logs/insert/jsonline?_stream_fields=receiver`, no headers, empty body, send_resolved) — i.e. the demo logs its own notifications into CubeAPM logs.
- **Mute groups: 1** — #2 "TestMuteGroup": 21:00 for 600 min, every day, Asia/Calcutta; used by no rule.
- **Silences: 0.**
- **Notification history:** 186 rows / 7 days, all SUCCESS, webhook, rule 437, roughly hourly (matches the 1 h repeat).
- **SLOs: 10** (order, payment ×2, notify ×2, shipment ×2, analytics, demo-nodejs, search services). None has alerts enabled (`alertsEnabled` is omitted = false; the API omits false booleans), yet all ten still carry fast/slow-burn receivers (email, Slack or webhook) — receivers survive switching alerts off.
- **Integrations (config):** email, slack (106 channels), pagerduty (app id set), opsgenie (1 team), googlechat, msTeamsV2, webhook enabled; jira disabled. Flags: `alertmanager.charts.disable=false`, `alertmanager.sample-log.disable=false`, `alerts.config-file=""`. Config exposes no `teams`/`users`.

---

## 19. Journeys & micro-journeys (as the original supports them)

Notation: → = click / navigation; [x] = UI state. "Expand" always means clicking the small chevron — every Collapse in this module uses `collapsible:"icon"`, so clicking the header text does not expand (the rule name is a link to the detail page).

**J1 — "What is firing right now?" (triage)**
1. Sidebar "Alerts" → `/alerts` (tab Alerts). [Groups collapsed unless exactly one group exists.]
2. Read "# Firing" per group; optionally click the "# Firing" sort icon (descending).
3. Expand the group → firing rules are listed first (then pending, then the rest), each with a red "firing" tag.
4. Expand the rule → details panel + instance rows (state tag, distinguishing labels, raw value, "Traces ↗").
5. "Traces ↗" → new tab: Traces explorer filtered by the alert's selector labels, ±5 min around the instance's `activeAt`.

**J2 — Investigate a firing alert from a notification**
1. Notification link → `/alerts/437?alert_id=…` (+ `notifyTime`/`incidentTime` when present). [`alert_id` ignored.]
2. Detail page "Alert": state tag + name, actions toolbar, details panel (condition in words, evaluation settings, receivers, snoozes/mutes, instances).
3. If `notifyTime` is present and old, the time range jumps to ±30 min around it; the chart shows the query with the threshold line.
4. Quick-model rules: legend row "details" ↗ → APM page (Detail / RED / Errors tab) for that service/endpoint.
5. Instance "Traces ↗" / "Logs ↗" for raw evidence.
6. History icon → Notification History filtered to this rule (who was notified, when, success/error).
7. Optional: Snooze (J10), Edit (J4 step-wise), or Pause (J11).

**J3 — Create an error-rate alert from a service's endpoint chart**
1. `/apm` → service → "RED" tab, Graph view → "Error %" chart ⋮ → "Create Alert".
2. Wizard step "Query": [downsampling off] Quick tab: CALCULATE "Error %", WHERE env = …, service = …; GROUP BY root_name. [downsampling on — playground] Code tab with the warning banner → "Fix query".
3. (Quick) "Add more" → `root_name` equals the endpoint, or keep GROUP BY to get one alert instance per endpoint.
4. "Generate Graph" → check the series; set Condition "greater than" `1` (percent); optionally Additional Condition "greater than" `5` (adds `severity=critical`).
5. "Next" → Settings: Evaluation Interval 1m, Wait for 5m, Repeat after 4h (defaults); Alert Name e.g. "Error rate high on {{ .Labels.root_name }}"; Tags optional; Group (suggestions or new).
6. "Next" → Receivers: pick a receiver group, or Custom → change the default Webhook card to Slack → Recipient channel → "Test" → [toast "Test notification sent successfully!"]. Set "Notification Grouping" to "Off" (red hint appears because the name uses a variable).
7. "Done" (or "Next" → Mutes & Permissions → "Done") → lands on `/alerts`; new rule appears in its group after load (state "normal" until first evaluation fires).

**J4 — Create a p95 latency alert from scratch**
1. Alerts → "New" → Query: Static, Metrics, Quick.
2. CALCULATE "%ile Latency (millis)", percentile `95`; WHERE service equals X; (optional) root_name equals Y.
3. "Generate Graph"; Condition "greater than" `500` (ms). Next → Settings (name, group) → Receivers → Done.

**J5 — Alert on error-log volume from the Logs explorer**
1. `/logs` → build the filter (e.g. `level:error`) → query-bar ⋮ → "Create Alert".
2. Wizard opens with datasource "Logs", Code tab: `{env="…",…} level:error | stats count()`.
3. "Generate Graph"; Condition "greater than" `100`. Saved expression: `… | stats count() as result | filter result: > 100`.
4. Settings → Receivers → Done. Same flow from `/traces` (datasource Traces) and `/mobile-traces` (Mobile).

**J6 — Alert when a synthetic monitor goes down**
1. Sidebar "Monitors" → expand group → monitor row bell "Create Alert".
2. Wizard: Metrics › Advanced: FROM `cube_synthetic_monitor`, WHERE id = N, SELECT `max` group by id, group, name; Condition "equal to" `0`.
3. Settings (type a name, e.g. "Synthetic down - Docs"; pick group) → Receivers → Done.
4. Back on Monitors the bell becomes a dropdown listing the rule.

**J7 — Route rules to Slack through a shared receiver group**
1. Alerts › "Receiver Groups" → "New" → drawer "Alert Receiver Groups".
2. Name → change the default Webhook card's "Receiver Type" to "Slack" → Recipient (use "Refresh channels list" if a channel is missing; private channels require the CubeAPM app to be a member) → tick "Show query in notification" → "Test" → "Done".
3. For each rule: Edit → "Receivers" step → select the group in the first dropdown (replaces "Custom") → "Done". (No bulk assignment.)

**J8 — Connect PagerDuty while creating a rule**
1. Wizard "Receivers" → Receiver Type "PagerDuty" → "Connect with Pagerduty Service".
2. Wizard state is stashed in sessionStorage; PagerDuty opens in a new tab → user authorises one or more services.
3. PagerDuty redirects that tab to the wizard URL with `?config=…` → wizard restored at the same step, PagerDuty card(s) now show "Service Name" and "Integration Key" (read-only).
4. "Done" in the new tab; close the original tab (still holding the unsaved draft).

**J9 — Mute a rule every night**
1. Option A (reusable): Alerts › "Mute Groups" → "New" → Name → "Start at" 01:00, "Mute for" 2 h 0 m, "Every" (none = every day, or Mon–Fri), "Timezone" → "Done". Then Edit rule → "Mutes & Permissions" → select the mute group → "Done".
2. Option B (inline): Edit rule → step 4 → Mutes "Custom" → "Add Mute" → fill the card → "Done".
3. Verify: expand the rule → "Mute Groups"/"Mutes" lines in the details panel. Suppressed sends appear as `MUTE` in Notification History (inferred).

**J10 — Snooze a firing alert for 2 hours**
1. Rule row → Snooze (speaker icon) → "Custom" (presets stop at "1h").
2. Modal "Snooze": pick "Start at" (Now) → "Snooze for" 2 h 0 m → "Create".
3. Expand the rule → "Snooze" chip "MMM DD, HH:mm - MMM DD, HH:mm" (turns red within 30 s).
4. End early: × on the chip (no confirmation).

**J11 — Temporarily stop a noisy rule**
1. Rule row → switch (tooltip "Pause") → off → status PAUSED, evaluation stops. The tag does not change locally; after the next 30 s poll a paused rule reports `inactive` (as all 7 paused playground rules do) and shows a green "normal" tag — there is no "paused" label anywhere.
2. Turn back on to resume.

**J12 — Check whether a notification was delivered / debug a failing receiver**
1. Rule row → History icon → Notification History filtered to the rule (or the tab → "Alert" select).
2. "Status" → "ERROR" → click the "Details" cell → modal with the raw error.
3. Fix the receiver (rule Edit or Receiver Groups) → "Test".

**J13 — Weekly noise review**
1. Time picker "Last 7 days" → "Stats" tab → sorted by "Incidents".
2. Compare "Total Time (minutes)" and "Total Time %" (bar) → click the alert name → detail page → Edit thresholds / Wait for / Repeat after.
3. ⋮ "Download CSV" to share.

**J14 — Clone a rule for another service**
Rule row → "Clone" → wizard "New - Copy of …" with everything prefilled → change the service filter (Quick/Advanced) or edit the code → rename → "Done".

**J15 — Delete a rule**
Trash → modal "Delete Alert" → "Yes" → row disappears (detail page returns to `/alerts`).

**J16 — Retire a receiver group that is still in use**
Receiver Groups → the trash icon is disabled (no tooltip) → expand the group to see "Rules" → edit each rule to detach → return and delete ("Delete Alert Receiver Group" → "Yes"). Same for mute groups.

**J17 — Anomaly alert**
New → "Anomaly" (Metrics only) → query → "Generate Graph" draws the expected band → Condition "above or below by" `2` deviations; Additional `3` deviations for critical → Settings → Receivers → Done.

**J18 — Restrict who can edit a rule**
Edit → "Mutes & Permissions" → Permissions "Custom" → "Select team or user" → "Editor" (at least one Editor row required) → "Add Permission" for viewers → "Done".

**J19 — Look at recent alert activity**
Alerts tab → expand "Recent Alerts" → stacked 0/1 chart per rule ("<name> - <group>") over the selected range; drag to zoom (rewrites the time range); legend click isolates a series; ⋮ "Compare" with 1 hour/1 day/1 week ago.

**Micro-journeys**
- Change tab → URL `?tab=` updates; `rule_id` persists across tabs (expands that rule on the Alerts tab).
- Search rules → filters live; clearing (×) restores.
- Sort groups → click a column's circular arrow (toggle asc/desc).
- Fix an unsupported APM query → "Fix query" in the banner.
- Switch builder tab → query replaced by that tab's draft (no warning).
- Test a receiver → "Test" (only when the card is valid).
- Refresh Slack channels / Jira projects / issue types → link buttons under the selects.
- Expire a snooze → × on chip.
- Open full notification details → click truncated Details cell.
- Load older notifications → "Load more".
- Open APM context from an alert chart legend → "details" ↗ icon.

---

## 20. Pain points / oddities spotted in the original (input for the redesign)

Cited elsewhere as **R1–R42** in the order below; R43 onwards are in section 21.

**Information architecture & naming**
1. Four unrelated meanings of "group": rule folder ("Group" label), "Receiver Groups", "Mute Groups", and "Notification Grouping".
2. Three overlapping suppression mechanisms with inconsistent vocabulary: "Pause" (switch; rule `status` PAUSED), "Snooze" (one-off; API = Alertmanager *silence*), "Mute" (recurring schedule). They are managed in three different places (row toolbar, wizard step 4, separate tab).
3. Three status-like fields shown three different ways: `state` (tag "normal"/"pending"/"firing"), `status` (switch position only), `health` (plain text "Health: ok" on every row).
4. Label drift between screens: wizard "Evaluation Interval" vs panel "Evaluated every"; "Wait for" vs "Wait before firing"; "Tags" vs API labels; "Type"/"Static"/"Anomaly" vs `kind`; "Source: metrics" vs "Metrics"/"prometheus"; "Receivers" vs contact points; "Notification History" vs `alert-logs`.
5. The detail page title is the generic "Alert", not the rule name.

**Severity & state visibility (contradicts the redesign's rule 3 / finding #1)**
6. Groups are sorted alphabetically and collapsed by default — a firing rule is hidden behind a click unless there is exactly one group. (Rules inside a group do sort firing-first.)
7. A **paused** rule shows a green "normal" tag; snoozed and muted rules look identical to active ones in the collapsed row. You must expand a rule to learn it is snoozed.
8. `health: err` is shown as red text with no error message (`lastError` never displayed); `lastEvaluation` never displayed, so "never evaluated" rules (7 of 9 on the playground) are indistinguishable.
9. No "firing since"/duration, no instance history, no state-transition timeline, no annotations (summary/description) anywhere; instance values are raw (`0.28150713`) with no unit.
10. `alert_id` in notification links is ignored — the specific instance is not highlighted.

**Controls & feedback**
11. Seven icon-only controls per rule row (switch, speaker, eye, pencil, copy, clock, trash) with tooltips only; the speaker-with-slash icon for "Snooze" is non-obvious. The switch's tooltip says "Pause" but ON means active.
12. Expanding any row requires hitting a small chevron (`collapsible:"icon"`).
13. Silent success everywhere (save, delete, pause, snooze, expire) — only "Test" shows a success toast. Delete dialogs use generic "Yes"/"Cancel".
14. A new snooze appears as a neutral "pending" chip until the next 30 s poll even if it is already active.
15. Delete for receiver/mute groups is disabled while in use, with no tooltip saying why or which rules block it (list is inside the collapsed body).
16. Editing a shared receiver/mute group silently changes every rule using it; no impact warning.
17. No bulk actions (pause/snooze/delete/assign receivers), no import/export, no rule history/audit ("created by", "updated at").

**Search, URL & time**
18. Alerts search matches rule name, group name and label **keys** only — label values (e.g. `payment-service`) and query text are not searched.
19. Unrelated APM params (`service`, `index`, `name`, `kind`, `view`, `env`) leak into `/alerts` URLs via the sticky query-string helper; meanwhile search, filters, expanded state and the history "Alert" filter are not in the URL.
20. The time picker and auto-refresh are shown on tabs they don't affect (rule list, Receiver Groups, Mute Groups); the rule list polls on its own 30 s timer instead.
21. Times (snooze chips, Notification History) are local with no timezone label; mute timezones default to the browser's zone.

**Wizard**
22. No field-level validation messages: "Next"/"Done" just disable (reserved/duplicate tag keys, threshold format, receiver validity).
23. Receivers are mandatory, and a new rule starts with an empty **Webhook** card — the least common choice.
24. "Done" appears on both step 3 and step 4; Steps aren't clickable; no unsaved-changes guard; after saving you land on the list, not the new rule.
25. Switching Quick/Advanced/Code (or Builder/Code) silently swaps the query for that tab's draft; switching datasource clears the preview; the preview never refreshes itself ("Generate Graph" must be clicked after each change).
26. "Create Alert" from APM charts on a downsampled install opens a code query full of `$__…` placeholders plus a warning banner; the user has to click "Fix query". Name, group, service tag and a sensible threshold are never prefilled from the source chart.
27. Thresholds have no unit hint (Error % is in percent, Quick latency in **milliseconds** while APM charts display seconds; anomaly "deviations" unexplained).
28. Footgun: Notification Grouping defaults to On, but templated names (`{{ .Labels.x }}`) need it Off — only a red hint on another step warns about it.
29. Copy issues: Alert Name help is a wall of text with a typo ("…should be used instead.The environment…"); "Alerts with an additional tag severity=critical when query results satisfy this condition" is missing a verb; "Connect with Pagerduty Service" capitalisation.
30. Anomaly is silently disabled for Logs/Traces/Mobile; editing an anomaly rule resets its operators to "above or below by" (inferred bug).
31. Logs/Traces/Mobile alerts only work if the query ends in a `stats`/`math` pipe (expression appends `as result | filter result:`) — nothing enforces or explains this.
32. Receiver/mute group "Add more" always adds the first group in the list (duplicates possible).
33. Annotations (summary/description), which the API supports and the playground rules use, cannot be edited in the UI.

**Receivers**
34. Integration availability depends on server config; disabled integrations (e.g. Jira on the playground) simply don't appear — no hint how to enable them.
35. PagerDuty connect continues in a **new tab**, leaving a stale draft in the original; the integration key is shown in clear text; no "reconnect/change service" action.
36. Webhook: payload template has no variable reference or preview; Slack/PagerDuty/Google-Chat URL warnings don't block saving; Email addresses aren't validated.
37. Opsgenie stores the team's API key as the selected value (shown as team name only when the team list loads).

**Notification History & Stats**
38. History search is client-side over loaded pages only; rule names aren't links; "Load more" is styled like an error (red); MUTE/SNOOZE share the same grey tag; the "Alert" filter isn't reflected in the URL; first load flashes "No data" + "Load more".
39. Stats only lists rules that fired in the window; "Incidents" and "Total Time" definitions are unexplained; its search box uses a query language unlike every other tab's plain text search.
40. Errors in untitled charts (wizard preview, detail chart) surface only as a toast — the chart just stays empty.
41. Cloning a paused rule silently produces a paused clone (status is copied; the wizard never shows status).
42. The Quick builder always appends `span_kind=~"server|consumer"` (server-side traffic only) — there is no way to alert on client/outgoing calls from Quick, and nothing says so.

---

## 21. What the live pass added

Driving the module confirmed sections 1–15 as written: the tab values, the row controls and their
tooltips, the expanded panel, the rule page, all four editor steps, the operator and option lists,
the receiver types, the Slack card, the mute card, Stats, Notification History, the Snooze menu, the
history link (`/alerts?time=7d&tab=alert-logs&rule_id=437`) and the Logs "Create Alert" prefill.
It also turned up behaviour the code reading did not.

**Observations:**

- The study URL is the APM page's sticky query string carried into `/alerts`. It renders the
  plain rules list on "Last 7 days". "New" from there opens a blank editor: none of `service`,
  `name`, `kind` or `index` prefills anything.
- The Logs "Create Alert" handoff lands on `/alerts/new?time=1h`: Logs › Code, query
  `{"env"="UNSET"} (*) | stats count()`, Anomaly disabled, no preview until "Generate Graph". The
  prefilled query is not in the URL, so the address cannot be shared or bookmarked.
- The service page (`/apm`) chart ⋮ menu reads "Compare · Create Alert · Explore". Every KPI and
  chart card carries one.
- `/alerts/437?alert_id=…` looks identical to `/alerts/437`, except that the range falls back to
  the app default ("Last 1 hour") when the link carries no `time`.
- Switching an existing Code query to Quick shows an empty Quick builder. The stored query is not
  parsed back, and the Code draft returns only by switching back.
- An empty Tags row disables "Next" with no message. An incomplete mute card turns red and disables
  "Done" with no message.
- Drawers (Receiver Groups, Mute Groups) and the editor close or navigate away without asking,
  discarding input.
- Monitors (`/synthetic`) is the same grouped-list layout as Alerts: "Active Monitors" collapsible,
  "Search monitors", "New", and Group / # Monitors / # Down / # Unhealthy.
- SLO (`/slo`) shows Type, Service and "Last N days" selectors and a "No data" state for
  cubedemo-web.
- The notification log record is `{id, rule_id, rule_name, receiver_type, receiver_data, status,
  details, created_at}`. Nothing in it says whether a send was for a firing or a resolved alert. The
  demo's 186 rows are hourly sends for rule 437, with two of them 7 minutes apart (08:04:42 and
  08:11:42) that the log cannot explain.

**Pain points the live pass adds:**

43. **Background poll failures stack toasts.** During a network outage while this page was open,
    the 30 s rule poll produced nine identical "Failed to fetch alerts: AxiosError: Network Error"
    toasts in a column. There was no inline error and no stale-data indicator, and the list kept
    showing the last good data as if it were current.
44. **The "Recent Alerts" chart shifts the table.** It loads after the table, and expanding it
    pushes the table down by the chart's height. A click aimed at a group row lands on the chart.
45. **The series is drawn in a status hue.** The rule page and editor preview draw the query's
    series in green, with the threshold in red and a legend entry named "-" for the unlabelled
    series. The y-axis has no unit (the demo rule's 0.30 is a percentage).
46. **A chronically firing rule goes unflagged.** Stats shows the demo rule with 18 incidents and
    firing 98.82% of the last 7 days. That is a threshold below the series' normal range (0.1%
    against a series that never drops below ~0.17%), and nothing on Stats, the rule row or the
    rule page says so.
47. **Paused rules take as much room as live ones.** Seven of the nine demo rules are paused, yet
    each renders a full-height row with the same seven controls as the one that fires.

---

## Appendix A — component map (minified names in this build)

| Area | Component | Notes |
|---|---|---|
| Hub page | `kUn` | tabs |
| Alerts tab | `vUn`, loader `Lce` | 30 s poll |
| Rule actions toolbar | `Bot` (+ `Ycn` pause) | |
| Rule details panel | `eat`, receivers summary `d2e`, mutes summary `Jot` | |
| Detail page | `aVn` | |
| Wizard | `vGe` | steps array `Me` |
| Query editor | `Cne` → Metrics `oVn` (Quick `iVn`, Advanced `sVn`, Code `rVn`), Logs/Traces/Mobile `pce` (Builder `Gzn`, Code `Kzn`) | |
| Receivers list / card | `TY` / `xUn`; defaults `qot`; serialise `Fj` / parse `BP` | |
| Mutes list / card | `Yvt` / `bUn`; serialise `Yot` / parse `eG` | |
| Permissions | `Uyt` | |
| Receiver Groups | `NUn`, drawer `LUn` | |
| Mute Groups | `yUn`, drawer `_Un` | |
| Notification History | `lVn`, fetch `cze` | page size 20 |
| Stats | `MVn` (generic table `Wn`, columns `PVn`) | |
| Chart | `Y` → `Aot` (Compare) → `Noe` (menu, threshold/anomaly) | |
| Page header / time | `Wa`, `Gcn`, `Nf` | |
| Link builder | `at.*` / `ta()` (sticky params) | |
