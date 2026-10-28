# Slow Requests: the latency histogram and heatmap

The service page's Detail tab (APM & Services → a service → Detail, one
endpoint) lists that endpoint's slow requests under a chart of all its
requests. The chart can show a **Histogram** of latency or a **Heatmap** of
latency against time, or none ("Show preview: None") for the list alone.
Drag across either chart and the list shows only the requests in that latency
band, and on the heatmap only those in that time too.
"View in Traces" then opens the same requests on the Traces page. This is
production CubeAPM's panel, built from this repo's pieces.

The Overview tab's Slow Requests and the Detail tab's Requests with Errors are
unchanged.

What follows is what is worth not re-deriving.

## The pieces

| Part | Where | Reused from |
|---|---|---|
| The panel | `components/trace/SlowRequestsPanel.jsx` | — |
| The list, its preview, Sort by | `RequestTraceSplit`, with three new opt-in props: `above`, a section between the head and the split; `headLead`, a control in the head; and `controlsAt="list"`, which moves Sort by and `headExtra` from the head to a bar at the top of the list | The service page's own split |
| "5 results" (5, 10, 20, 50, 100; default 5) | `FilterSelect` in `headExtra`, on the list's bar, inside `.subtab-filters` so it is drawn as the service page's Host and Version filters are. It shows the value alone (`hideLabel`, new and opt-in); its label, "Show", stays in its title and accessible name | The platform's filter dropdown. The counts are the Browser Traces tab's: `LIMITS` and `resultsLabel` moved to `components/trace/requestLimits.js` |
| "Show preview" Histogram \| Heatmap \| None | A `.sort-lbl` label and a `.seg-toggle` radio group of buttons, in the panel's head (`headLead`) | The Sort by label and toggle |
| The charts | `components/trace/LatencyCharts.jsx` (plain SVG) | AlertTimeline's percent layout |
| The drag | `components/charts/bucketBrush.js` | `useTimeFocus`'s gesture, rule for rule |
| Tooltips | `ChartTooltip`, plus a new optional `heading` prop for a tooltip with no instant | Every chart's |
| Clear | `.split-ep-clear` | The endpoint strip |
| What the panel says and does | `components/trace/slowRequests.js` (pure) | — |
| The requests | `data/requestLatency.js` | — |
| Latency buckets and their labels | `utils/latencyBuckets.js` | — |

The preview stays beside a long list (`stickyPreview`), just under the Detail
tab's sticky endpoint strip (`--rts-sticky-top` on `.srq-host`), as on the
Browser Traces tab.

## The requests are modelled one by one

Nothing in the mock layer held requests. The RED table, the p90 chart and the
drilldown are aggregates, and the Traces stream is a few hundred seeded spans
with other routes' names. `data/requestLatency.js` therefore models the
endpoint's requests, and every bar, cell and row is a count of them.

- **Minute by minute.** Minute *s* serves round(rpm at *s*) requests. Their
  latency is log-normal with σ = 0.5, and p90 is the endpoint's p90 profile at
  that minute: the value the p90 chart above draws for it. A heatmap column's
  slow end therefore moves when the chart's line does. The profiles are the RED
  table's own (`latencyProfiles('red')` in `services.js`), read from the
  table's memo. No new `derivedProfile` call is made, because its seeds are
  handed out in build order.
- **As order statistics.** Request *r* of a minute sits at a quantile inside
  its own stratum, (r + 0.1 … r + 0.9) / n, jittered and rounded to the
  microsecond. Without the jitter, every minute's slowest request would sit at
  the same quantile, fall in the same far-tail bucket, and draw that bar
  taller than the one before it. Because the strata do not overlap, a band
  [lo, hi) holds a run of consecutive ranks. The CDF finds that run in O(1),
  then checks a rank or two either side. Seven days (10,080 minutes) are
  counted, not enumerated: 10–30 ms per grid.
- **On the clock, not on a window.** A minute is a minute before `BASE_TIME`
  (`minuteInstant`, newly exported from `timeWindow.js`). Two windows that both
  cover it hold the same requests. This is what lets View in Traces land on
  the rows the panel listed.
- **A bar that holds anything yields rows.** The list, the bars and the cells
  are the same integer requests. The empty state appears only where the chart
  is blank.

An endpoint that the RED table does not list, such as one a log record's link
arrived with, gets a flat profile from the figures the page shows for it
(`fallback: { rpm, p90 }`). Its jitter is seeded by its name.

The service page draws payment-service's endpoints on every service's page,
because its tables are not per service. The model takes the page's service as
given, so the requests, their traces and the Traces link all name the same
service on whatever page they were made.

## "Slow" is the window's slowest tenth, not the card's p90

With nothing selected, the list is the window's slow requests: those at or
above the window's **request-level** p90. That is exactly the slowest ⌈N/10⌉
(a few more on a tie). The panel does not print where the cut falls. Its hint
is production's alone: "Drag on the chart to filter by latency" ("… and time"
on the heatmap).

That figure is not the p90 card's, and it cannot be. The card is the table's
p90 of minutes: `windowQuantile` weights each minute's p90 by its rate, as if
every request in a minute ran at that minute's p90. The histogram's p90 is
over the requests themselves. The two agree at a few minutes and at a day or
more. At an hour they diverge, because there the incident covers a third of the
window. Measured on payment-service (request p90 ÷ card p90, every RED
endpoint):

| Range | Ratio | Example (capture) |
|---|---|---|
| 5m | 0.95–1.01 | 770 vs 797 ms |
| 15m | 0.97–1.00 | 770 vs 793 ms |
| 1h | 0.66 | 518 vs 780 ms |
| 3h | 0.60–0.64 | 283 vs 443 ms |
| 24h | 1.02–1.03 | 186 vs 182 ms |
| 7d | 0.98–0.99 | 179 vs 182 ms |

`requestLatency.test.js` pins the bands (5m 0.85–1.15, 1h 0.55–0.8, 24h and 7d
0.88–1.12), so a change that moves either side gets noticed. The bands are
wide because `BASE_TIME` is the moment the suite runs and the jitter is keyed
on the clock. The alternative was to calibrate the minutes so the 1-hour
figures match. That would have put 5 minutes about 40% off, and moved a
number the rest of the product is calibrated against. The panel claims to
agree with p90 only. The Avg card already reads above p90 at 5m and 15m (a
calibration defect in `services.js` that predates this panel), so no
distribution could agree with it.

## The list is a sample of the scope, newest first

"5 results" is a spread across the scope, not the newest five. This is
browser-page.md's rule ("N results is a sample of the range"). The spread uses
the base-2 radical inverse, so **a longer list contains a shorter one's rows**:
20 contains 5, and the Traces merge of 100 contains them all. The rows are
returned newest first, and Sort by orders the N.

A row is `{ traceId, endpoint, service, latencyMs, durationNs, timeMs,
timestamp }`. Its meta line is `Oct 26, 14:34:06 · trace 77358ae3` (24-hour,
the app's form).

## A request's trace id is the request

There are 32 hex digits. A checksum comes first. The request follows, masked by
the checksum: ms before `BASE_TIME` (9), service index (2), a 16-bit hash of
the endpoint name (4), rank in its minute (3), and latency in µs (7). This is
errors.js's layout, with its own salts (`q1`, `q2` / `qm1`–`qm4`), for the
same reasons:

- The offset is from `BASE_TIME`, so a link reopened after a reload is the same
  distance from the incident.
- Any other id fails the checksum and decodes to nothing.
- The latency rides in the id, so a decoded trace never recomputes it. The
  trace is exactly as slow as the row it came from.

The RED endpoints decode before any page has modelled them. An unlisted
endpoint decodes only in the session that modelled it. After a reload its
trace is borrowed, like any unknown id's. Nine hex digits of ms reach about
795 days back, so the model holds no request older than that. A range further
back shows as empty rather than listing rows whose ids could not be decoded.

`requestTraceRows(id)` is a new step in `buildTrace`'s lookup, after the
Browser's and before the borrow. It returns a fixed set of spans:

- **Root:** the endpoint's server span.
- **Under the root:** the controller.
- **In sequence:** a Redis GET, then a MySQL SELECT, with the controller's own
  work as the time left around them. All are sized by the Latency Drilldown's
  layers at that instant (Redis carries the incident).
- **Alongside them:** a Twilio send, awaited before the response.

Every child ends inside the root. Ids are `req_<traceId>_<seq>`, and the random
stream is seeded from the id, never the explorer's.

## The charts

**Buckets are VictoriaMetrics' `vmrange`.** There are 18 per decade, with
integer mantissas 1000, 1136, 1292 … 8799. The edges are 4 significant
figures, which is what production's labels show: `6 ms`, `8.8 ms`, `12.92 ms`,
`27.83 ms`. The plain 10^(k/18) would print 5.99 ms and 681.29 ms. A bucket is
half-open, [lo, hi). `edgeMs` divides the integer mantissa by a power of ten,
never scales 1.292 by 100. It is then the same double that a whole number of
nanoseconds divides down to, so a request exactly on an edge falls in the same
bucket for the bars, the list and the duration chips. 1.292 × 100 is
129.20000000000002, which put a 129.2 ms request in the bucket below on the
chart and the bucket above in the list. Axis labels sit at bucket edges (`edgeTicks`, as many as
fit the width), not at bar centres, because they name edges. Edges print with
up to two decimals, trailing zeros dropped, in seconds from 1000 ms: `146.8
ms`, `1 s`, `1.47 s`. The axis spans every bucket that holds a request,
widened to any selected bucket. A selection carried into a window whose
requests sit elsewhere therefore still shows, as dimmed bars.

**Plain SVG, not Recharts.** Both charts are SVG laid out in percent, the
AlertTimeline way. They need no measuring to lay out (the width only decides
how many labels fit), and they render the same on the server, which the panel
tests use. They share one pointer model, one brush, one keyboard cursor and
one tooltip. A Recharts bar chart beside a hand-drawn grid would have done
hover, drag and readout two ways.

**Histogram.** Each bar is a bucket's share of the requests the bars count (y
axis in %). The tooltip is headed by the range (`146.8 ms - 166.8 ms`), with
rows for Requests % and Count. When the selection has a time half, the bars
are recomputed over just those columns, so they always describe what the list
is drawn from. The plot is 220 px tall.

**Heatmap.** The columns are the window's own buckets: 15 s at 5m, 1 min at
1h, 30 min at 24h, 3 h at 7d. Future columns draw nothing.

- **Colour:** the brand blue at six opacity steps (0.16 to 0.95), stepped by
  √(count ÷ the grid's largest cell). Busy columns therefore read darker.
- **Tooltip:** headed by the column's instant and "16 mins ago", as on every
  time chart. Its rows are the cell's share **of its column** (`113.6 ms -
  129.2 ms 1.6%`) and the cell's request count. A share of the whole window
  would read 0.0–0.3% on nearly every cell. The count keeps a 40% cell of
  three requests apart from a 40% cell of nine hundred.
- **Hover:** a dashed crosshair (`--border-strong`) through the column and row.

**No status hue on a series (rule 2).** Production paints the hovered bar or
cell red, which here would read as "this latency is critical". Here both keep
their fill. A hovered bar is marked only by the faint column band behind it
(`--overlay-hover`) and its tooltip, with no border. A hovered cell is too
small for a band, so it is outlined in `--text-primary`. A selection is drawn
the way production draws it, by fading what is outside it (0.3, with a 0.06
floor on the heatmap so faded data stays visible in both themes), never by a
band over what is inside. The brand brush band (.14) shows only while dragging.

## Selecting

A selection is `{ lat: [k0, k1] | null, time: [fromMs, toMs) | null }` in whole
buckets and whole columns.

- **A histogram drag** sets the latency half and keeps any time half.
- **A heatmap drag** sets both halves.
- **Switching views** keeps the selection. A histogram band shows on the
  heatmap as a full-width band of rows.
- **Show preview: None** hides the chart and its hint. A selection in force
  still filters the list, so its line stays alone (what it is, Clear, View in
  Traces); the list is never narrowed by something the reader cannot see.
  With nothing selected, nothing sits between the head and the list. Clear
  then puts focus on the checked preview choice, since there is no chart to
  return it to.
- **Another endpoint or service** starts clear. The view, the count and the
  sort stay.
- **A new window** keeps the latency half, which still means something, and
  drops the time half.
- **What is dropped stays dropped.** Going back to the earlier window or
  endpoint does not bring it back. The panel adjusts its state during render,
  React's pattern for state that follows a prop.
- **A click without a drag** (under the 3 px slop) selects nothing. Clear is
  the way out.

The line above the chart reads `Latency: 113.6 ms - 527.5 ms, Time: Oct 26,
14:11:00 - Oct 26, 14:24:00`, then Clear and "View in Traces ›". Times are the
app's 24-hour absolute form (`formatAbsoluteLabel`); production writes
`12:53pm`.

**A drag here filters; it does not zoom.** This is a deliberate exception to
chart-time-axis-and-focus.md, where a drag on any chart of the window sets the
page's range. This chart's x axis is latency, or a time the selection only
narrows the list to. Setting the app-wide range from it would redraw every
chart above for a question asked about one list. For the same reason the drag
has no five-minute floor: a single 15-second column is a valid selection.

**Keyboard and screen readers.** The plot is focusable, with
`role="application"` (`aria-roledescription="chart"`). With `role="group"`, a
Windows screen reader in browse mode would take the arrow keys for itself and
the plot would never hear them. "Show preview" is a radio group (labelled by
its visible "Show preview"), not tabs, because one of its choices, None, shows
nothing. It has one stop in the tab order, and the arrows, Home and End move
the choice.

- **Moving:** arrows move a cursor over bars or cells, with the tooltip
  following. Home and End jump to the ends.
- **Selecting:** Shift with an arrow selects from where the cursor started.
  Enter (or Space) lists the selection, or the cell under the cursor.
- **The first Enter only shows the cursor.** Pressed before any cursor is
  shown, it shows the cursor rather than committing. A stray Enter on a
  focused plot never collapses a selection to one bucket.
- **Escape** first abandons a mouse drag in progress. Otherwise it abandons
  the keyboard selection being made, or else clears the one in place. Only
  one of these happens per press.
- **When the cursor shows:** only after a key press. A mouse press does not
  focus the plot, so a drag leaves no stray cursor.
- **When the axis re-trims,** the cursor stays on its bucket. This happens
  when a selection is made or cleared, or carried into another window. The
  cursor is kept as a bucket, not as a place on the axis. A bucket the axis no
  longer holds pulls the cursor to the nearest end.
- **Announcements:** one `role="status"` region per panel announces each
  cursor move ("244.8 ms - 278.3 ms: 3.4% of requests, 130"), each selection
  and each clear.
- **Focus after Clear:** Clear moves focus to the plot, because the button
  removes itself.

No other chart in the product is keyboard-operable yet.

## View in Traces lands on the panel's requests

The link carries the endpoint's server spans on this service and the latency
band:

```
service = payment-service
span_kind = server
span_name = POST /v1/payments/:id/capture
duration >= 113.6ms
duration < 527.5ms
```

- **Exact literals, half-open.** The bounds are the bucket edges in
  milliseconds with every decimal they have (`durationLiteral`: '8.799ms', not
  the label's '8.8 ms'). They use `>=` and `<`, as the buckets are half-open.
  A request at 8.7995 ms is in the 8.8 ms bucket, and a request exactly at the
  upper edge is in the next one. With nothing selected the band is the slow
  tail: `duration >=` the cut, and no upper bound.
- **Time is the app's range, with no floor.** A time half becomes
  `setTimeRange({ kind: 'absolute', from, to })` of exactly the selected
  columns, clipped to now. There is no five-minute floor, because Traces opened
  on a wider span would list requests the panel did not. The range is
  app-wide, so returning to the service page shows that range too.
- **Both sides count the same span.** The panel's list stops at the same
  "now" the link clips to (`win.nowSec`). Today's columns run past now, and
  the panel used to count to the millisecond while the link stopped at the
  second. On Traces, an absolute range now ends exactly where it was told to
  (time-range-windowing.md). Its window's start is still floored to the chart
  step, so the merge reads the range's own bounds (`win.exactMs`). Without
  this, a selection that ran up to now, or a long 7-day one that started on a
  3-hour column the Traces step does not align to, opened Traces on a
  slightly different span. A different request count moves every pick of the
  spread, so none of the panel's rows landed.
- **The Traces page merges the requests in.** The seeded span stream holds no
  span named after the service page's endpoints. As with the Errors page's
  `errorSamplesFor`, a query that names an endpoint in a `span_name` leaf
  merges that endpoint's requests in (`requestSamplesFor` in
  `tracesHandoff.js`, via `traceSamplesFor`, the Traces source's
  `extraRowsFor`). The merged requests are the window's (the range's exact
  span when it is absolute). They fall within the duration bounds that every
  match must meet; a bound on one side of an OR narrows nothing. They come
  from each service a `service` leaf names, or payment-service when none is
  named. They use the panel's own spread, **capped at 100** per service and
  endpoint. Because
  the spread nests, the panel's N rows are always among them. Each merged span
  must still pass the whole query, so a chip the reader adds keeps deciding.
- **Tested end to end.** `slowRequests.test.js` follows the link across 5m, 1h
  and 24h, every endpoint, and no / latency / latency-and-time selections. The
  chips go through `chipsToString` and `tryParseConditions`, then the Traces
  stream. The panel's rows at 5 and at 100 must all be in the landed rows, and
  every landed row must be inside the band and the selected time. A second
  test covers the spans that once broke it: the newest column, the last 13 and
  the whole window on 12h, 24h, 7d and Today, plus 40-column 7-day selections
  that start on either parity of column.
- **Alert hand-offs benefit too.** An alert rule's latency hand-off
  (`alerts/rule/handoffs.js`) names its endpoint in `span_name` too. It now
  lands on that endpoint's requests as well, though it still carries no
  duration floor.
- **The Traces volume chart will not match the panel's counts.** It is the
  seeded stream's baseline, scaled by the share of sample rows the query keeps
  (`filterVolume`), with the merged requests counted among the rows. Its shape
  follows where they fall in time, but its numbers are not the endpoint's
  request counts. Merged error samples already worked this way.

## The duration filter it needs

The Logs/Traces grammar had no numeric comparison, so the band could not travel
as chips. It now has LogsQL's range filters: `field:>v`, `:>=`, `:<`, `:<=`
(chip ops `gt`, `gte`, `lt`, `lte`), offered on `keyword` fields in a Range
category. What matters for this panel:

- **The value is kept as written.** It stays '8.799ms', never a number. It is
  matched through `utils/logsqlNumber.js`, which Explore's evaluator also uses:
  a duration is integer nanoseconds, a size is bytes, a bare number is itself.
  A span's `duration` tag is ns, so `duration:>=8.799ms` compares ns to ns,
  and `duration:>5` is five nanoseconds.
- **Integer-ns rounding.** Each part is rounded after the unit multiply, so
  '8.799ms' is exactly 8799000 and '27.83ms' exactly 27830000. A span exactly
  at a bound lands on the side the operator says. A band built as [lo, hi)
  therefore partitions spans, with no double count.
- **What now reads differently.** `f:>v` used to parse as a word chip on `>v`,
  which matched nothing. It is a comparison now. The writer quotes a word that
  opens with `<` or `>` (`message:">5"`), so no chip the builder writes changes
  meaning on the way back.
- **The typed bar.** `:>` waits one key, in case it is `:>=`. `8.8 ms` closes
  up to `8.8ms`. A value that is no number, duration or size is refused at
  commit; a bare number with a leading space is refused too, rather than
  committing as nanoseconds.

query-builder-phase8.md has the grammar in full.

## Differences from production

- **Hover:** a column band behind the bar (an outline on a heatmap cell), not
  red (rule 2).
- **Where the controls sit, and what they are.** "Show preview" (Histogram
  | Heatmap | None) is in the panel's head. Production has no None; its
  switch is unlabelled and sits on its own row under the head, left of the
  hint. Sort by and "5 results" are on a bar at the top of the list,
  under the chart, over the rows they order and count. Production puts them
  in the head and draws the count as "5 results ▾". Here the count is the
  platform's filter dropdown (`FilterSelect`), which also gives its menu a
  search box, as every FilterSelect has. The menu is portalled to the page,
  so the panel never clips it, however few rows a selection leaves. Requests
  with Errors, below, keeps its controls in its head, because it has no chart
  between its head and its list.
- **Times:** 24-hour, `Oct 26, 14:11:00`, not `12:53pm`. The heatmap tooltip
  says "16 mins ago", not "about 1 hour ago".
- **Heatmap tooltip:** share of the column plus the request count. Production
  shows a share alone; whether it is of the column was read off screenshots and
  is unverified.
- **Rows:** a sample spread across the scope, not the latest N. The meta line
  is `time · trace <id>`. Production repeats the endpoint as the second line
  and puts the time under the duration.
- **Requests with Errors**, directly below, is left service-wide with no
  "N results" picker. Production gives it the same head. Scoping it to the
  endpoint needs an errors-by-endpoint request model this panel does not
  build.
- **Back from a trace** (or from Traces) starts the panel clear. The
  selection, view and count are component state and are not in the URL. This
  is the gap query-builder-phase8.md records for queries and
  time-range-windowing.md records for the range.
- **Every service's Detail tab** lists payment-service's endpoints. This was
  true before the panel; the panel's requests carry the page's service, so
  the link and the trace agree with the page.

## Tests

| File | What it pins |
|---|---|
| `utils/latencyBuckets.test.js` | Edges and labels against production's (`6 ms`, `8.8 ms`, `12.92 ms`, `681.3 ms`, `1.47 s`), bucket membership (a whole-ns latency on any edge in the bucket above), log-normal helpers |
| `data/requestLatency.test.js` | Grid sums, rate × minutes, every bar holds exactly what its band lists, every non-empty cell yields rows, nested spread, the same request in two windows, slow = slowest tenth, the p90 gap, a sub-µs bound admits everything, nothing older than an id can name, id round trip and foreign ids, trace root = row latency with children inside, unlisted endpoints |
| `utils/tracesHandoff.test.js` | A duration under an OR narrows nothing, `duration:>0` admits every request, and every named service is asked |
| `data/timeWindow.test.js` | An absolute range ends at its raw end and carries `exactMs` |
| `components/trace/slowRequests.test.js` | The pure model, the Traces landing above, and the panel's markup in five states: on mount, a latency selection, the heatmap with a selection, Show preview None (alone, and under a selection's line), and an empty range |
| `components/trace/RequestTraceSplit.test.js` | The `above` slot sits between the head and the split and stays when the list empties. The old markup is unchanged |
| `components/charts/ChartTooltip.test.js` | The `heading` prop |
