# The Traces drawer: a fixed width and a Waterfall tab

On Traces and Mobile Traces, the record drawer is a fixed 560px wide and has a
third tab, **Waterfall**, after Overview and JSON. It draws the trace the span
ran in, the way the service page's Slow Requests preview draws one:

1. Its duration, span count and service count, beside a **View trace
   details** link. The request itself is not named there: the waterfall's
   first row is its root.
2. An **error summary** when the trace failed.
3. The waterfall, with the span that was opened selected and on screen.

A row's **trace_id** opens that row's drawer on the Waterfall tab rather than
leaving for the trace page, which the tab's link reaches. It carries the
arrow-out-of-a-box after the id. Logs uses the same drawer and is unchanged.

What follows is what is worth not re-deriving.

## The pieces

| Part | Where | Reused from |
|---|---|---|
| The tab strip | `LogRecordDrawer`'s new `tabs` prop: `[{ id, label, render(record) }]` after Overview and JSON. An `initialView` nothing offers reads as Overview. `viewRequest` (`{ view }`) is a page asking for a tab as it opens or re-points the drawer: each new object is applied once, so the reader's own choice of tab, and Newer and Older, stand. The trace_id cell sends one; a plain row click sends none | The drawer's own tabs |
| The fixed width | `LogRecordDrawer`'s new `className` prop. TracesView passes `trace-drawer`, styled in `components/trace/span-trace.css` | `.log-detail.errd`, the Error details drawer's override |
| The tab's body | `components/trace/SpanTraceTab.jsx` | — |
| Head, error summary, waterfall | `TracePreview`, lifted out of `RequestTraceSplit.jsx` with opt-in `linkLabel`, `rowRefs` and `fill` props. The split's preview is byte-identical: a test renders every picked request against a verbatim copy of the JSX it replaced (the older fixture never picks a row) | The Slow Requests preview, `TraceErrorSummary`, `Waterfall` |
| Folding a large trace | `autoFolds` in `components/trace/traceInsights.js`. Over 40 spans, parents from depth 2 open folded. The trace page now reads the rule from there too | The trace page's rule |
| What the tab keeps across records | `components/trace/spanTraceState.js`: `arrive`, `pick` and `toggleFold`, plain transitions the tab runs, so they are tested without a DOM | — |
| Reading a row's trace | `traceInRows(id, rows)` in `data/traceDetail.js` | `buildTree` / `assembleTrace` |
| The stack trace | `SpanExceptionModal`, drawn by TracesView outside the drawer, so its clicks never reach the drawer's handlers | The Browser Traces tab's rule |
| Which store an id is read in | The explorer source's new `traceDatasource` (`'traces'` / `'mobile'`). A source without one offers no tab | `resolveTrace`'s datasources |

## The width

`.log-detail` is `width: 560px; max-width: 68%` of `.logs-main`, the results
pane. On Traces that pane is the grid's `1fr` beside a filter rail that drags
from 232 to 371px. So the drawer followed the window, the rail and the
sidebar's toggle: 421px at a 991px window, 340px at 873. A waterfall needs its
width, and a drawer that resizes moves every row under the reader.

`.log-detail.trace-drawer` holds 560px. It gives way (`max-width: 100%`) only
where the results pane itself is narrower than 560px, where it covers the pane
rather than being cut off by it. With the rail at its narrowest and the sidebar
collapsed, that is a window under about 930px. The timestamp under the title
no longer breaks mid-date.

## The trace is read from the rows on screen

`buildTrace(id)` reads a seeded id against the reference hour's spans. The
explorer draws its rows for whatever range is picked, and a seeded trace's id
repeats across windows over different spans:

- Every window restarts the seed, so trace *i* has the same ids whatever spans
  it holds.
- The wide trace's ids follow however many traces come before it.

Measured: off Last 1 hour, `buildTrace` misses the row's span for 112 of 219
rows at 5m and 15m, 112 of 315 at 30m, and 215 of 616 from 2h to 7d. The spans it does find carry the
reference hour's times. The explorer holds its seeded traces whole, so
`traceInRows` assembles the row's trace from the rows themselves. Every row of
every range then finds its span, at its own time and duration.

An id that carries its request still decodes through `buildTrace`: an Errors
or Slow Requests sample, merged into the stream one span at a time. So does an
id with no spans in the rows. A Browser sample's id is checked too, though
nothing merges one into the stream today. A device's request decodes from its id
in the mobile datasource. Read as a backend id, it would come back as someone
else's borrowed trace.

**Known gap, not fixed here.** The trace details page still resolves by id
alone (`resolveTrace` → `buildTrace`). Off Last 1 hour, the tab's **View
trace details** link can open a different trace from the one the tab drew.
(The table's trace_id did the same before it opened the drawer instead.) The window is not in the URL, so the fix belongs with
the trace page: carry the window in history state, or make seeded ids decode
like the sample ids do.

## The span opened

- **Selection:** the row selected is the record's span. A row clicked in the
  tab stays selected until the record changes. Newer and Older keep the tab,
  and the selection follows them; coming back to a record selects its own
  span again, never one picked on an earlier visit.
- **Folds:** kept per trace, as the split keeps them. Stepping between two spans
  of one trace finds it as it was left.
- **Reveal:** opening or stepping to a span unfolds its ancestors, then and only
  then, so a fold made afterwards stands.
- **Leaving the tab:** Overview or JSON unmounts it. Coming back opens on the
  record's span with the trace folded afresh.
- **Scroll:** the body scrolls to the span itself, not with `scrollIntoView`,
  which would scroll the explorer behind it too. "On screen" means below the
  sticky head; `scroll-padding-top` keeps a row the keyboard focuses clear of
  it as well.
- **Sticky head:** the trace's figures and the link stay in view while the
  waterfall scrolls under them.
- **Narrow drawer:** where the results pane is under 560px wide, a deep row's
  service name shrinks with an ellipsis rather than painting over the duration,
  and the operation keeps a few characters.
- **No trace:** a record with no trace_id (a screen view, a tap, a crash) says so
  in place of a waterfall.

## No slow-request summary

A summary of why a request ran slow (against which requests, and the
operation whose own work took longest) was built above the waterfall and then
taken out at review: only a failed trace gets a callout. Worth knowing before
building one again: with this repo's data no reading of "slow" both held and
said something.

- **The service's published p90:** the seeded spans are drawn at their own
  scale, so almost every trace read as slow.
- **The slowest tenth:** the explorer holds one to seven requests per service
  by range, where a p90 is just the slowest one.
- **Twice the median of a request's peers on screen:** this held, but needed
  five peers, so it never spoke below an hour. It also had to key a device's
  requests by path and leave out the query's merged samples to stay honest.

## Tests

| File | Covers |
|---|---|
| `components/trace/traceInsights.test.js` | Which spans a trace opens folded, and revealing one |
| `components/trace/spanTraceState.test.js` | A pick is dropped when the record changes, and stays dropped coming back; reveal and folds per trace |
| `components/trace/SpanTraceTab.test.js` | The selected span, head and link, the error summary, a deep span in the 114-span trace, no trace, mobile, the drawer's strip and width class |
| `data/traceResolvers.test.js` | `traceInRows` from 5m to 7d, and decoding a Slow Requests id |
| `LogRecordDrawer.test.js` | A page's tab and class are opt-in |
| `RequestTraceSplit.test.js` | Every picked preview is byte-identical to the JSX it replaced; `TracePreview`'s additions are opt-in and in order |
