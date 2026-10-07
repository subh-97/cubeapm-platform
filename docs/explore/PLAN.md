# Explore page — build plan and status

Living document. **Update the status tables as work lands.** This file exists because an earlier
attempt kept its plan and specs in a scratch directory outside the repo; the directory was cleaned and
~6,000 lines of reverse-engineered reference notes went with it. Anything worth not re-deriving
belongs in `docs/`, not in `/tmp`.

- **What we are building:** `/explore` — a query explorer. Pick a datasource (Metrics / Logs /
  Traces), build a query (Metrics: Quick | Advanced | Code; Logs and Traces: Builder | Code), press
  Generate Graph, read the result as a line chart or a table, export CSV.
- **The reference:** `https://playground.cubeapm.com/explore`. We keep its user journey and
  interactions and render them in our design language. The Mobile datasource is out of scope.
- **Binding decisions and module contracts:** [ARCH.md](ARCH.md). Where ARCH and a reference note
  disagree, ARCH wins.
- **Reference notes:** `docs/explore/reference/` — what the playground actually does, derived from its
  production bundle.

## How to work on this

```bash
npm test          # whole suite
npm run lint      # 0 errors; the repo has a small baseline of warnings
npm run build
```

To run a single test file without the whole suite, bundle it the way `scripts/run-tests.mjs` does
(esbuild with the `@` alias, `.js` as JSX) and run it in node.

The reference bundle is not committed (7 MB, re-downloadable). To look something up:

```bash
curl -sS "https://playground.cubeapm.com/explore" | grep -oE '/assets/index-[A-Za-z0-9_-]+\.js'
curl -sS -o app.js https://playground.cubeapm.com/assets/<that file>
npx prettier@3 --parser babel app.js > app.pretty.js
```

Identifiers are minified and change between builds, so `docs/explore/reference/` records behaviour
and verbatim user-visible strings rather than line numbers alone.

## Status

### Logic layer

| Module | State | Tests |
|---|---|---|
| `src/utils/explore/builders.js` — builder state → PromQL / LogsQL | done | 66 |
| `src/utils/explore/series.js` — legend, datasets, table rows, deltas, stacking | done | 43 |
| `src/utils/explore/searchQuery.js` — the result table's SearchQL | done | 21 |
| `src/utils/explore/format.js` — reference value formatters | done | 18 |
| `src/utils/explore/catalogs.js` — verbatim option lists and help strings | done | 15 |
| `src/utils/explore/csv.js` — CSV shape and filename | done | 8 |
| `src/data/explore/eventsStore.js` — synthetic logs and spans | done | 20 |
| `src/utils/explore/promql/` — MetricsQL lexer, parser, evaluator | done | 21 |
| `src/data/explore/metricsStore.js` — synthetic metrics | done | 17 |
| `src/utils/explore/logsql/` — LogsQL lexer, parser, evaluator | done | 29 |
| `src/utils/explore/api.js` — the mock query API the UI calls | done | 23 |

**The logic layer is complete.** `npm test` passes, `npm run build` succeeds, and
`npx eslint src/utils/explore src/data/explore` is clean. (`npm run lint` reports 5 errors across
`AggregateResults.jsx`, `InfraView.jsx` and `ServiceOverview.jsx` — none of them Explore's.)

Two things the metrics store settles, worth not re-deriving:

- **Counters are integrated, not stored.** `sampleSeries` accumulates the rate across the instants it
  is asked for, starting from zero each call. Every consumer of a counter takes a difference, so the
  absolute offset is free, and a 7-day range costs no more memory than an hour.
- **The published figures are solved for, not written down.** `services.js` says payment-service is at
  612 ms and 4.8%; the incident's severity is whatever makes the default hour report exactly that,
  bisected at module load for the percentile. Widen the range and the number falls, as it should.

### UI layer

Nothing built yet. Explore is still a disabled stub in the sidebar (`Sidebar.jsx`), so the page is
not reachable and no Explore code is wired into the app.

## Batches

Work proceeds in small batches so an interruption costs one batch, not everything.

- [x] **0 — Plan in the repo.** This file and `ARCH.md`.
- [x] **1 — Reference notes for the editors.** Done: `reference/metrics-editor.md` and
      `reference/logs-traces-editor.md`, re-derived from the current playground build. Both end with
      a divergence list checked against `builders.js` and `catalogs.js`: **the generated queries and
      every option list still match the reference exactly**, so the older build our code came from
      has not moved under us. What differs is deliberate (see below).
- [x] **2 — Finish the logic layer.** Done: the MetricsQL engine, the metrics store, the LogsQL
      evaluator and a green `api.js`, with calibration asserted against `src/data/services.js`.
- [x] **3 — UI core.** Done: `src/components/explore/` holds `ExSelect`, `FilterRows`, `CodeEditor`,
      `GeneratedQuery`, `ResultsToolbar`, `ExploreChart`, `ExploreLegend`, `ExploreTable`,
      `ValueSparkPopover` and `useExploreResult`, with the PromQL and LogsQL completers in
      `src/utils/explore/complete/`. `PageBar` gained optional `onRefresh` / `refreshing` /
      `autoRefresh` / `onAutoRefreshChange`; with none of them passed every existing page behaves
      exactly as before. Its helpers live in `src/utils/timePanel.js` and `page-bar.css`, beside the
      bar rather than inside the Explore feature.
      **Gap:** the results components carry no automated tests — they were checked by hand in a
      browser. Worth covering `useExploreResult`'s abort/stale behaviour at least.
- [x] **4 — Editors and page.** Done: `MetricsEditor` (Quick / Advanced / Code), `LogsEditor`
      (Builder / Code) with its stats and math pipe cards, `ExploreView`, the pure `editorState.js`
      (27 tests), and the wiring — `/explore` reachable, the sidebar item live, and the **Explore**
      action on `CardMenu` now navigating instead of toasting.
- [x] **5 — Verification.** Driven in the browser end to end (see below). Two bugs found and fixed.
- [ ] **6 — Remaining polish.** The open items below.

## How this sits on the platform

Explore is late to a codebase that already solved several of its problems. It must use these rather
than grow its own:

| Platform module | What Explore takes from it |
|---|---|
| `src/utils/timeRange.js` | The range model `{kind:'preset'\|'absolute'}`, `resolveRange`, step and alignment, `timestamps`, compare options, the custom-range validation. Explore adds nothing of its own here. |
| `src/data/timeWindow.js` | The incident profile and window calibration. `metricsStore` samples this, so Explore's numbers move with the time picker the same way every other page's do. |
| `src/components/layout/PageBar.jsx` | The page bar and time picker, already range-object aware. Explore adds refresh and auto-refresh (batch 3) as optional props, without changing how other pages behave. |
| `src/components/charts/chartDefaults.js` | How charts draw: straight segments, flat fills, no animation, shared axis and grid formatting. |
| `src/components/CardMenu.jsx` | Already offers an **Explore** action per card. Explore becomes its destination; today `ServiceOverview`'s handler answers with a "not part of this prototype yet" toast. |
| `src/utils/chartPalette.js` | Series identity colours. Index 11 is the warning amber, so Explore skips it (see ARCH D7). |

## What the browser pass confirmed, and the two bugs it found

Driven at `localhost` against the running app: sidebar arrival auto-runs RPM by service; CALCULATE →
%ile Latency regenerates the query and marks Generate Graph dirty; Type=Time formats durations;
Legend value Latest/Average/Sum; Table view with Previous and Change and Stack correctly disabled;
Logs and Traces both auto-run their default stats query; the Code tab shows the seeding hint, syntax
colouring, the keyboard footer and a working pipe autocomplete; a bad query shows a live parse error,
an error band with Try again, **and keeps the previous result underneath**; and the p90 card's
**Explore** action lands on Quick with `service="payment-service"` grouped by `root_name`, which is
the whole point of the feature — from "p90 is 612 ms" to which endpoint, in one click.

Two bugs found and fixed:

1. **The daily wave was not normalised** (`metricsStore`), so every service read ~9% light against
   the figures the rest of the app shows — at 23:00 the wave sits at 0.90 and nothing divided it out.
   `timeWindow.js` already solves this with `WAVE_REFERENCE`; the store now does the same, and the
   calibration test's tolerance is 4% so it cannot drift back unnoticed.
2. **The stats `if` placeholder taught the wrong vocabulary on Traces** — it suggested
   `level:="error"`, and a span has no `level`. It is now per-datasource.

## Carried forward from the reference re-read

Two things the divergence lists turned up that the remaining batches must honour:

- **Any model loader must tolerate and strip an incoming `options` key.** The reference's filter rows
  are `{label, operator, values, options}` and it emits the model with the fetched value lists still
  attached, so a model arriving from a playground-built panel carries stale options. Ours is
  `{label, operator, values}`; strip on the way in, as the reference itself does.
- **The minified identifiers cited in `builders.js` and `catalogs.js` comments are from the older
  build** and no longer resolve. The behaviour they describe is still accurate. Worth one pass to
  re-point them, or to drop them in favour of the reference notes.

## Open items

- **The results components have no automated tests.** Chart, legend, table and `useExploreResult`
  were verified by hand. `useExploreResult`'s abort-and-stale behaviour is the piece most worth
  covering, since a superseded run is easy to get subtly wrong.
- ~~The Logs default query is honest but unflattering.~~ **Fixed:** it groups by `host.name` (on 100%
  of records) rather than `log.level` (on 18%). `eventsStore.test.js` now asserts that the field each
  default groups by is present on every record and takes at least a few values.
- **`src/data/timeWindow.test.js` has a time-of-day flake.** "Today starts at local midnight and
  leaves the rest of the day empty" fails late in the evening, when almost none of the day is left to
  be empty. Not Explore's, but it makes `npm test` red depending on when it runs.

## Open questions

- `src/data/timeWindow.test.js` has one failing assertion (9 pass, 1 fails). Not Explore's, but
  Explore's metrics store will sample that module, so it is worth settling first.
- Whether Explore writes its query to the URL. The reference does not, and URL state sync is still
  the outstanding platform item (`docs/decisions/query-builder-phase8.md`). ARCH keeps Explore's
  state in one serialisable object so this can be added later without a rewrite.
