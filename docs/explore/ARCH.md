# Explore page — binding decisions and module contracts

Companion to [PLAN.md](PLAN.md). This file is **binding**: where it and a reference note in
`docs/explore/reference/` disagree, this file wins. Where it is silent, follow the reference note —
the point is to keep the playground's user journey and interactions, rendered in our design language.

Rules that apply throughout: status colours are never used for series or syntax (see CLAUDE.md
rule 2); every icon-bearing control carries a visible label or `title` + `aria-label` (rule 4);
the page auto-loads rather than waiting for a button (rule 5); a metric shown alone carries
comparison context (rule 6); all colour comes from `var(--…)` tokens so both themes work.

## Decisions

### D1. Page anatomy

```
PageBar:  CubeAPM / Explore          [↻ Refresh][Auto: Off ▾][🕒 Last 1 hour ▾]
└─ one bordered sub-card (like .logs-main)
   ├─ head     datasource .tabbar [Metrics | Logs | Traces]  ·  mode .seg-toggle
   │           Metrics → [Quick | Advanced | Code];  Logs/Traces → [Builder | Code]
   ├─ editor   the active tab's body; Quick/Advanced/Builder end with a read-only Generated Query
   ├─ ──────   a draggable separator (`.ex-split`)
   └─ lower    one section (`.ex-lower`) holding:
      ├─ actions  [▶ Generate Graph] ··· [Line|Table] Labels▾ Legend value▾ Type▾ Stack Compare▾ [⤓ CSV]
      ├─ error    inline band; previous results stay visible beneath it
      └─ results  Line → chart + right-hand legend;  Table → sortable table
```

The separator is the trace waterfall's control (`.tw-split`), deliberately the same shape: one
product, one way to resize a pane. It drags the **editor's** height, because the editor is the half
that varies — an Advanced query with several operation cards, or a Builder with stats and math pipes,
is tall enough to push the chart off the screen. Everything below it moves as one piece, so the
toolbar is never left behind from its own results. Mouse drag, arrow keys (Shift for a bigger step),
Home/End, Escape or double-click to go back to fitting the content; clamped so neither half can be
dragged shut; hidden below 900px, where the page is already scrolling and sizing a pane gains
nothing.

The Mobile datasource and the env picker are not built. Stack is a labelled toggle, disabled outside
the Line view.

### D2. Auto-run

The reference opens blank and waits for Generate Graph. We auto-run instead (rule 5).

- Sidebar arrival: Metrics › Quick, `calculate: 'rpm'`, `groupBy: ['service']`, committed on mount.
- First visit to Logs or Traces in a session: a default Builder model, committed immediately —
  logs `* | stats by ("host.name") count()`, traces `* | stats by ("service") count()`. The grouping
  field must be one **every** record carries, or the first chart is mostly one unlabelled bucket:
  only about a fifth of log records are application logs with a `log.level`, the rest being k8s and
  browser events. `eventsStore.test.js` asserts the coverage so this cannot regress quietly.
- Returning to a datasource restores its own draft and committed query. Toolbar settings (view,
  legend value, type, stack, compare) are page-global and survive a datasource switch; `legendLabel`
  resets to "all" when the committed datasource changes.
- An incoming payload from another page is committed immediately.
- After a commit, editing marks Generate Graph dirty; it does not silently re-run. Time range,
  refresh, auto-refresh, zoom, Legend value and Compare do re-run. Labels, Type and Stack are
  display-only.

### D3. Tabs and carry-over

Each tab keeps its own query and model. Switching into Code seeds it from the tab you came from, but
only while Code is untouched, with a one-line hint saying so; once edited, Code keeps its own text.
There is no parsing back from Code into a builder. An incoming query without a model opens Code; with
a model it opens that model's tab and rebuilds the query from the model.

### D4. Keys in the code editors

Enter accepts the highlighted suggestion when the menu is open, otherwise runs. Shift+Enter inserts a
newline. Tab accepts. Esc closes. ↑/↓ move, ↓ opens. Cmd/Ctrl+Enter always runs. A footer row of
`kbd` chips states this, as `RawQueryInput` already does.

### D5. Time, refresh and zoom

The range model, step, alignment and custom-range validation all come from `src/utils/timeRange.js`;
Explore adds nothing of its own. Refresh re-runs the committed query. Auto-refresh offers
Off/5s/10s/30s/1m/5m/15m, lives in component state, and pushes no history. Dragging across the chart
sets an absolute range floored and ceiled to the minute, with a Reset zoom affordance. Relative
presets re-resolve against now on every run.

### D6. Comparison context

A Compare control offers Off, Previous period (default), 1 day ago, 1 week ago, using
`COMPARE_OPTIONS` / `compareShift` from `src/utils/timeRange.js`: the same query over a shifted
window, same step, same reducer. Series are matched between windows by their full label set.

Legend rows carry a delta chip (`↑18%`, `↓35%`, `↑4.4×` once the ratio reaches 2, `new`, or `—`),
coloured as neutral information, never as severity. The table gains Previous and Change columns. When
exactly one series is visible, its comparison window is drawn as a dashed line in the same colour.
CSV is unaffected. A failed comparison fetch never blocks the main result.

### D7. Series colour

Use `CHART_PALETTE` from `src/utils/chartPalette.js` minus index 11 (`#F59E0B`, the warning amber) —
locally, without editing the shared palette. Colour is assigned by stable identity: sort a result's
series by their canonical label string and index into the palette, so changing Legend value never
recolours a line. Legend order stays reduce-value descending. The stacked "Others" series is muted
and dashed.

### D8. Chart

Recharts, drawn with `src/components/charts/chartDefaults.js` (straight segments, flat fills, no
animation, shared axis and grid formatting). Values are formatted by `src/utils/explore/format.js`.

Behaviour to match: x-axis spanning the full aligned range; y from 0; a multi-series tooltip at the
hovered timestamp with the nearest series emphasised and the rest dimmed; a dashed crosshair;
drag-select zoom; stacked areas drawn in reverse with an "Others" series; a 20-series limit with a
"Showing 20 of N · Show all" footer; and a "Common: k=v, …" line when Labels is "all". A key counts
as common only when every series carries it with the same value; each legend label uses the varying
keys that series actually has, and an empty label renders as "-".

The right-hand legend has a search box that filters both legend and lines, rows that are buttons
(click isolates, clicking again resets, Ctrl/⌘-click toggles), and reduce values per row. Selection
resets when the committed query or Labels changes.

Loading never blanks the chart: the previous result stays, dimmed, under a spinner. An empty result
says so with a recovery hint. An error shows the inline band and keeps the previous result.

### D9. Table

Label and Value columns (plus Previous and Change when comparing), sticky header, sortable — Label
A→Z by default, first click on Value sorts descending. With Labels "all" the label cell is the full
sorted label set; otherwise it is that label's value. Rows merge on identical label text. A 20-row
limit with "Show all" counts the filtered rows. The search box uses the reference's SearchQL
(`src/utils/explore/searchQuery.js`) with highlighting and suggestions. Hovering a value sourced from
a range query opens a small sparkline of that series.

### D10. Mock data

There is no backend. `src/data/explore/metricsStore.js` and `src/data/explore/eventsStore.js`
generate deterministic, range-aware data sampled from `src/data/timeWindow.js`, so Explore's numbers
agree with the rest of the platform and move with the time picker. Baselines come from
`src/data/services.js`; the vocabulary (services, endpoints, hosts, versions, exceptions, HTTP codes,
log fields, span fields) matches what Logs, Traces and the service pages already show, so a query
carried from those pages returns something.

`src/utils/explore/api.js` is the only thing the UI calls for data. It substitutes the reference's
query macros, simulates latency, honours an `AbortSignal`, and raises server-shaped errors.

### D11. Logs and Traces builder

Rebuild the reference's row-and-card builder — STREAM rows, FIELDS rows, and pipe cards (stats with
group-by and function rows; math with an expression) — rather than reusing the Logs page's chip
builder, and emit the reference's LogsQL. Style the rows exactly like the Metrics editor's so the
page reads as one system.

### D12. Reference bugs

Fix what the reference gets wrong: value-fetch races, the request for `label/undefined/values`, the
first edit clearing the graph, icon-only CSV and refresh buttons, the unlabelled Stack checkbox, the
unfiltered "Showing N of M", history entries pushed on every refresh. Keep the quirks that are part
of the journey, documenting them where they would otherwise look like our bugs.

### D13. Entry points

`src/components/CardMenu.jsx` already offers an **Explore** action per card, dispatched through
`CardActionContext`; `ServiceOverview` currently answers it with a toast. Explore becomes its
destination — extend the menu's payload minimally and backward-compatibly if it does not carry enough
to build a query. Logs and Traces have no card menu, so they get a labelled "Explore" control in their
existing menu and results toolbar.

The payload is `{ datasource, query?, model?, unit?, formula?, legendLabel?, stack? }`, delivered
through App's `openLink` with a nonce so arriving twice re-applies.

### D14. Not in scope

Mobile datasource; saved queries; Create Alert from Explore; URL state sync (kept possible by holding
page state in one serialisable object); the env picker.

## Module contracts

Pure logic lives in `.js` files; `.jsx` files export only components (the react-refresh lint rule).
Tests are `node:test` + `node:assert/strict`, named `*.test.js` beside the module. No new
dependencies.

### Built

| Module | Exports |
|---|---|
| `utils/explore/format.js` | `formatNumberValue`, `formatTimeValue`, `formatValue`, `labelsToString`, `formatDelta`, `reduceValues` |
| `utils/explore/csv.js` | `buildCsv`, `downloadCsv` |
| `utils/explore/searchQuery.js` | parse / match / suggest for the table search |
| `utils/explore/series.js` | `buildChartModel`, `buildTableRows`, sorting, limiting, the legend selection model |
| `utils/explore/catalogs.js` | the verbatim option lists, operation catalogue and help strings |
| `utils/explore/builders.js` | `buildQuickQuery`, `buildAdvancedQuery`, `buildLogsqlQuery`, the cascading `match[]` helpers, `toExploreLogsQuery` |
| `data/explore/eventsStore.js` | `eventsFor`, `getField`, the log and trace field catalogues |
| `utils/explore/api.js` | `queryRange`, `queryInstant`, `queryReduced`, the metric and field metadata calls, `substituteMacros`, `ExploreQueryError` |

Read `api.js` before writing anything it imports: it is the consumer contract, and it already has
seven passing modules built around it.

### To build

| Module | Shape |
|---|---|
| `utils/explore/promql/` | `parsePromql(text)` → AST (throws `PromqlError{message,pos}`); `evaluateRange(ast,{start,end,step,store})`; `evaluateInstant(ast,{time,step,store})`. The lexer never throws — it also drives highlighting. MetricsQL semantics: a range function with no window uses the step; `default` fills gaps; `histogram_quantile` reads `vmrange` buckets; aggregations, functions and arithmetic drop `__name__`. |
| `data/explore/metricsStore.js` | `listMetricNames`, `selectSeries(matchers,{start,end})`, `sampleSeries(key,timestamps)`, `labelNames`, `labelValues`. Deterministic, range-aware, counters cumulative, error series genuinely sparse. |
| `utils/explore/logsql/` | `parseLogsql(text)` (throws `LogsqlError`); `evaluateStatsRange`; `evaluateStatsInstant`. Rows carry `_weight`, so counts are Σw and averages Σwv/Σw. Empty buckets are absent. Server rules — `| stats` required, row-shaping pipes rejected around it — raise the reference's wording. |
| `components/explore/` | Shared controls (`ExSelect`, `FilterRows`, `CodeEditor`, `GeneratedQuery`), the results area (`ResultsToolbar`, `ExploreChart`, `ExploreLegend`, `ExploreTable`, `useExploreResult`), and the two editors. Class names prefixed `ex-`, in their own stylesheet; `src/index.css` is not edited. |
| `pages/ExploreView.jsx` | The page: owns one serialisable state object and the D2/D3/D5/D13 behaviour. |
| `utils/explore/editorState.js` | Initial state, draft query per datasource and tab, tab carry-over, incoming payload, dirty detection. |
| `utils/explore/complete/` | `suggestPromql`, `suggestLogsql` — context-aware completion over the metadata API. |

### Shared files

Additive, backward-compatible changes only, and never a revert or reformat of work in progress:
`App.jsx` (view, URL mapping, incoming payload, render branch), `Sidebar.jsx` (enable the item,
active state, click), `PageBar.jsx` (optional refresh and auto-refresh props), and the entry points in
`ServiceOverview.jsx`, `LogsView.jsx` and `TracesView.jsx`.
