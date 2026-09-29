# CubeAPM Traces — integration package

The span explorer and the trace detail view. One query grammar shared with Logs, a facet rail over
66 span attributes, a volume histogram you can zoom by dragging, and a detail page that reads a
trace four ways with a waterfall under it.

Three things travel together:

| | |
|---|---|
| **Live prototype** | https://cubeapm-platform.vercel.app/traces — sign in with any email and password, the gate checks nothing |
| **Handoff document** | https://claude.ai/artifact/C8GvqC7cZwtUQ9bYRYAMPt |
| **This package** | the code, its tests, and its tokens |

A trace opens from any `trace_id` in the table, or directly:
`https://cubeapm-platform.vercel.app/trace/b1d8ea6f7c9a04a96fe6e4af4972ae83`

---

## Verified before packaging

- **299 tests pass from inside this folder**, using only the files here.
- **Every `@/` and relative import resolves within the package** — checked mechanically across all
  51 source files. Zero unresolved.
- **Every copy is byte-identical to its source.** The one exception is `src/examples/`, written for
  this package and labelled as such.
- External packages: `react`, `react-dom`, `lucide-react`, `recharts`, `clsx`.

```bash
npm install
npm test
```

> **Read this before you plan the work.** All 299 tests belong to the *shared* infrastructure — the
> query grammar, the pipes, the saved queries, the table search. **The traces-specific modules have
> no tests at all**: `traceFields.js`, `tracesExplorer.js`, `traceDetail.js`, and both pages. See
> [Open gaps](#open-gaps) for what to pin first.

---

## The one thing to understand first

**Traces are not a log stream with different columns.**

A log record means something on its own. A span does not — it only means anything next to its
siblings, which is why the mock data is generated as whole traces (a server root, the internal work
it does, the client calls it makes, and the server spans those land on in the next service) and only
then flattened into the newest-first stream the table reads.

That is the reason a `trace_id` in the table is worth clicking: the rows around it are the rest of
the same request. Everything else in this package follows from it.

What Traces *does* share with Logs is the **grammar** — one query language, one builder, one facet
component, one column picker. What differs is the **vocabulary**: the fields, their types, their
descriptions, and which of them are identities that must never be offered a value picklist. That
list is `traceFields.js`, and it is the file to read first.

---

## What's here

Paths mirror the original repo, so the `@/` alias resolves unchanged. 56 files, of which these
eleven are the traces build:

| Path | Lines | Role |
|---|---:|---|
| `src/pages/TracesView.jsx` | 1225 | **The explorer** — bar, facet rail, histogram, table, drawer |
| `src/pages/TraceDetail.jsx` | 970 | **The detail view** — four tabs over a resizable waterfall |
| `src/data/tracesExplorer.js` | 764 | 480 span rows across 35 traces. **Seed data, replace it.** |
| `src/data/traceDetail.js` | 414 | Builds one trace, and the three tables that read it |
| `src/utils/traceFields.js` | 265 | **The traces vocabulary.** Start here. |
| `src/components/explorer/FacetGroup.jsx` | 98 | One collapsible facet. Shared with Logs. |
| `src/examples/TracesRoute.jsx` | 75 | **Written for this package** — how the two pages connect |
| `src/components/explorer/AlertDrawer.jsx` | 72 | Alert from the current query. Shared with Logs. |
| `src/components/explorer/FieldsDropdown.jsx` | 65 | Column picker. Shared with Logs. |
| `src/components/explorer/QueryHistoryDrawer.jsx` | 62 | Recent queries. Shared shell, per-dataset entries. |
| `src/index.css` | | Full stylesheet — the classes below |

The other 40 source files are the shared query stack the explorer stands on: the builder, the pipe
popovers, the aggregator, the raw-query parser, the saved-query hook, the record drawer, and the
table-search language the waterfall search uses.

### It overlaps every other handoff package

| Package | Overlap |
|---|---|
| `log-record-drawer-package` | **all 11 files** — fully contained here |
| `save-query-package` | **all 14 files** — fully contained here |
| `query-bar-package` | 23 of 25 — all but `LogsView.jsx` and `Toast.jsx` |
| `table-search-package` | 5 of 7 — all but `TableSearch.jsx` and its demo |

**If you are integrating more than one of these, take one copy.** They are the same files, verified
byte-identical in each package.

### The classes this surface owns

| Prefix | What |
|---|---|
| `.tw-*` | the waterfall — rows, bars, service colours, the modal |
| `.tw-side-*` | the resizable split and its separator |
| `.logs-*` | **shared with Logs** — the explorer shell, filter rail, query note, table chrome |
| `.facet-*` | a facet group |
| `.fields-drop-*` | the column picker |
| `.qh-*`, `.alert-drawer-*` | the history and alert drawers |
| `.span-*`, `.lvl-*` | span status and level pills |

The `.logs-` family is load-bearing for **both** pages. Renaming it to something dataset-neutral is
reasonable and safe, but it is not a Logs-only change.

---

## Wiring it

`src/examples/TracesRoute.jsx` is the whole contract in 75 lines. The two props most easily lost:

```jsx
<TraceDetail key={traceId} traceId={traceId} … />
```

**The `key` is load-bearing.** Collapsed rows, the selected span, the active tab and the pane split
are component state. Without a remount on trace id, opening a second trace inherits the first one's
— a span selection belonging to a trace you have left.

```jsx
<TracesView incomingChip={chip} onIncomingChipApplied={() => setChip(null)} … />
```

A filter handed in from another page ("show me this service's spans"). It **replaces** rather than
appends and runs itself: arriving with someone else's filters still applied is not what the link
promised, and a filter that lands unapplied looks like nothing happened. The callback clears it so
it is not re-applied on every later render.

`onOpenLink` receives `{ view, traceId | serviceId | resource, … }` and is deliberately not handled
inside the explorer — a record can point at a trace, a service or an infrastructure resource, and
only the router knows how to reach all three.

---

## Twelve rules worth keeping

### The explorer

1. **The page auto-loads.** Results state is seeded from the default query, so Traces opens with
   spans on screen rather than a blank "click Search" panel. This is the redesign's rule 5.
2. **The bar's state and the results' state are separate.** Re-filtering on every chip edit means
   one request per chip against a real backend, and a half-built query is rarely the one wanted.
3. **The histogram ignores the time window.** It is built from rows matching the chips and facets
   but *not* the zoom, so dragging a range narrows the table while the chart keeps its shape — the
   context you are zooming within stays visible.
4. **Span status is a severity, not an identity**, so the bars use the red/green the rest of the
   product reserves for severity. Span events get the neutral tone: they are rows in this table too,
   so leaving them out would make the chart disagree with the row count under it, but they carry no
   status of their own to colour.
5. **The field catalog is curated, then discovered.** 35 curated fields carry a type and a
   description; every other attribute the rows actually have is appended automatically, for a
   catalog of 97. A new tag is reachable from the keyboard without anyone editing `traceFields.js`.
6. **Identities never get a value picklist.** `trace_id`, `span_id`, `db.statement` and friends
   would list the rows back at you. The test that carries the weight is the *shape* of the values,
   not how many there are.
7. **Saved queries and history are per-dataset.** A log query offered on Traces is a query that
   cannot run. The panels are shared; the entries are props.

### The detail view

8. **A large trace opens folded.** Above 40 spans, everything below depth 2 starts collapsed — a
   fan-out trace fully expanded is a hundred leaf queries with the shape of the request buried in
   them, and the shape is what a waterfall is for. Collapsing hides the whole subtree, not just the
   direct children.
9. **The Errors tab is hidden when empty.** An always-present tab that usually says "nothing
   failed" trains you to skip it — which is the one tab you want read on the day it has something.
10. **Neither pane can be dragged shut.** The split is one number (the tables' height); the clamp
    leaves a couple of table rows above and a few waterfall rows below. A pane dragged closed looks
    like a bug, and there is no affordance left to drag it back open by. The separator is keyboard-
    movable, because it decides how much of the screen each half gets.
11. **Search sits beside the waterfall, not inside a tab**, so it behaves the same whichever table
    is on screen above it. It is `TableQuerySearch` from the table-search package, over a field set
    derived from the trace's own spans — which is why only four core fields take part in plain-text
    search: letting a bare word search all fifty would make "500" match a container id.
12. **A table row finds its span**: select it, unfold whatever hides it, scroll to it. A row
    standing for several spans hands over the slowest — the one it earned its place in the table
    with.

---

## Open gaps

### Blocking — the traces logic has no tests

Every one of the 299 tests belongs to the shared infrastructure. Nothing pins `traceFields.js`,
which is where the vocabulary, the duration formatting, the status mapping, the column ordering and
the value-suggestion rules all live. Four properties are worth pinning before anyone edits it:

- **`columnsFor` orders by the catalog, not by tick order** — unticking a column and putting it back
  must return it to its own slot, not append it to the end.
- **`formatSpanDuration(0)` is `"0 ns"`, not `"0 ms"`** — a span event has no duration, which is a
  different statement from "took no measurable time".
- **`statusForSpan('UNSET')` is healthy, not unknown.** UNSET is OTel for "nothing went wrong".
- **`spanValueIndex` drops identity fields whatever their count** — the shape test, not the size
  cap, is what keeps ids out of the picklist.

### Blocking — nothing is persisted or shared by URL

The explorer's query, facets, active columns and zoom are React state. `/traces` and `/trace/:id`
are the only two addresses; a filtered explorer cannot be linked to a colleague. The query is
already a plain string and the facets are plain sets, so this is a serialisation away.

### Needs a decision — the data is generated, not fetched

`tracesExplorer.js` builds 480 spans across 35 traces from a seeded RNG, and `traceDetail.js`
rebuilds one trace on demand. Both are shaped to match what the CubeAPM playground returns —
OTel field spellings, nanosecond durations, `_resource.*` for agent boilerplate — so the swap is a
fetch, not a reshape. Decide early whether the detail view refetches per trace or is handed the
spans it already has in the table.

### Needs a decision — no async or failure states

Filtering, zooming and opening a trace are all synchronous. Against an endpoint each can be slow or
fail, and the explorer currently has nowhere to say so. The query bar's existing async states are a
working reference for the treatment.

---

Packaged from the traces build at PR #44. Where this README and the code disagree, the code is right.
