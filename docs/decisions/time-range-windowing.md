# Making the time range mean something

Until this change the range picker was decoration. It set a label string on
`App`, and the only thing downstream of it was a `presetToMinutes` lookup in
`LogsView` and `TracesView` that sliced a fixed hour of mock data. Picking
"Last 7 days" showed the same hour with a different caption, and on Home and
the service pages it showed the same numbers full stop. The custom From/To
fields in the picker were not wired to anything at all.

## What it is now

One range, owned by `App`, in the shape `utils/timeRange` models:

```js
{ kind: 'preset', value: '1h' } | { kind: 'absolute', from: ms, to: ms }
```

`data/timeWindow.resolveWindow(range)` turns it into the window a page reads —
bounds, a step off a ladder of human-readable steps, and the buckets a chart
draws. Everything else is a function of that window.

`utils/timeRange` was written for the in-flight Explore page and has been
promoted out of `utils/explore/` to be the app-wide model; `formatLocal` moved
with it and `utils/explore/format` re-exports it. There is one time model.

## The four decisions worth not re-deriving

**1. One incident, one profile.** The whole product is anchored to a single
event: payment-service's Redis pool starts failing 22 minutes before
`BASE_TIME` and has not recovered. Every series, every window aggregate and
every log and span level mix samples the same `incidentWeight` profile. Nothing
is written down per chart, which is why the Logs histogram, the service list
and the RED charts cannot disagree about when the incident was.

**2. The published figures are one-hour aggregates, and stay exact.** The
numbers in `RAW_SERVICES` (452.7 rpm, 612 ms, 4.8%) are what the product has
always shown, and Last 1 hour still shows them to the digit. They are not
treated as readings: a profile is written as "this is the quiet value, and this
is the figure the last hour must average to", and the peak that gets there is
solved for. `calibratePeak` does it in closed form for means; `pinToReference`
then measures and scales the baseline so the result is exact, which also covers
the percentile, where there is no closed form. Change a published number and
nothing has to be re-derived by hand.

The payoff: payment-service's error rate was ~14% while the pool was out, which
is what a five-minute window reports, and 0.05% the rest of the time, which is
what a week reports. Both come from the same two numbers as the 4.8%.

**3. A percentile is taken over requests, not over buckets.** This is the
reason the feature is worth having. Error rate is a mean, so it fades smoothly
as the window widens. p90 does not: a 22-minute incident is 37% of an hour, so
the slowest 10% of that hour's requests are all incident requests and p90 reads
612 ms — but it is 0.2% of a week, so p90 reads 143 ms and you have to narrow
the range to find the fire. `windowQuantile` weights each bucket by the requests
it served to get this.

One consequence that looks like a bug and is not: **p90 turns over sharply**,
somewhere between two and three hours, where the incident's share of requests
crosses 10%. Just past the turn it does not drop to baseline but lands on the
ramp — the least-slow of the slow requests — because that is where the 90th
percentile actually falls. Exactly where it turns depends on how the buckets sit
against the incident, so the tests pin the ends of the range and not the middle.

**4. Status is the worst INSTANT, not the average.** The first cut reported
status from the aggregates, which meant the whole fleet went green on any range
wider than about six hours. Arithmetically that is right and as a product it is
wrong: the service did go down, and a monitor that drops it to green because you
widened the chart has hidden the one thing you opened it to see. Alerting has
never worked that way either — an alert fires on a breach, not on a weekly mean.

So `peakIncidentWeight` reads the window's newest instant (the incident only
gets better as you go back, so the worst moment in any interval is its newest
one), and the badge, the status dot, the summary counts, the severity sort and
the health strip all come from that. payment-service is critical on every range
that contains the outage, and the list keeps it on top — which is what the
severity sort is for.

The figures themselves are NOT floored to match. A row shows the window's real
averages next to a red badge, and each service carries both readings —
`status` for the breach, `aggregateStatus` for what the numbers alone resolve
to, plus `peakLatencyP90` / `peakErrorRatePct`. Where the two disagree the badge
says so on hover, because a red badge beside a healthy-looking p90 otherwise
reads as a bug rather than as the point:

> Breached during this window: p90 reached 602 ms and errors 14.38%. The figures
> in this row are the window's averages, which is why they read healthy —
> narrow the range to see the breach.

A window that genuinely never contained the incident — "three days back", say —
reports healthy, because nothing broke in it.

### Three bugs this shape made easy, and the guards against them

All three were found by probing the numbers, not by reading the code. Each
produced output that looked entirely plausible.

**The incident was measured from the window's end.** Buckets carried
"minutes before the window closed", so *any* window reported an outage in its
own final minutes — including windows that ended before the incident began.
Bucket time is now minutes before `BASE_TIME`, full stop.

**The window's end was floored to the chart step.** Flooring the start is
right; flooring the end too is the obvious symmetry and it is wrong. At a
three-hour step it threw away up to three hours, so "Last 7 days" ended before
the incident and the fleet read healthy at every long range for the wrong
reason. The window now runs to the end the range asked for and the last bucket
is however much of a step is left — which is why buckets carry `durMin` and
every aggregate weights by it.

**A profile pinned with one aggregate and read with another.** `pinToReference`
calibrates against whatever aggregate it is handed, so a p90 pinned as a mean
and read as a percentile reports the incident plateau as the hour's average
(2.6x high), and a slow request pinned as a percentile and read as a mean goes
2.1x low. Both shipped into the derived tables before being caught. `readProfile`
now pairs the two, and a test asserts that the reference hour reproduces every
published figure in every derived table, row by row and field by field.

### The bucket-averaging that makes the turn smooth

`incidentWeightOver` integrates the incident across a bucket rather than
sampling it at the bucket's edge. Sampling at the edge quantises a 22-minute
incident to a whole number of buckets, so at a five-minute step it reads as 15
minutes and at a three-hour step it disappears — and because p90 is a
percentile, losing two points of share flips it from 612 ms to 143 ms with
nothing in between.

## Rows are a sample, spread across the window

A week holds tens of millions of records. The log and span tables show a few
hundred, **spread across the window** rather than taken from its newest end.
Taking the newest few hundred is what a real explorer does and is also what
would make every range wider than an hour look identical to one hour, which is
the blindness this work removes. The histogram above the table carries the real
volume; the table carries a sample of it.

## The health strip is derived, not shuffled

Home's health history used to be a seeded random with "the last eight blocks are
bad" written into it. Each block is now the worst that slice of the window got,
read off the same profile as every number on the page — worst-instant like the
badge beside it, because "when did it break" is a question about instants and a
block covering five hours would average a 22-minute outage down to amber.

Over five minutes the whole strip is red; over an hour it is the last third;
over a week it is a single red block at the right-hand edge. That narrowing is
the strip earning its place — it answers *when*, which is the question the badge
leaves open.

## Drag-to-zoom is a time range

`LogsView` and `TracesView` used to keep a private `zoom` beside the global
range and write a fake `"Custom · -30m → -10m"` string into it. A drag now sets
the app-wide range to an absolute window, and "Reset zoom" restores what it was
dragged from. One concept instead of two, and the range the rest of the product
sees is the one that was dragged.

## What is still static

The Errors tab's exception groups and their sparklines, the slow-query list, and
the per-trace waterfall. The Errors table's "LAST 60 MIN" sparkline column is
hard-coded to that hour and now says so next to a range control that may read
"Last 7 days" — it needs the same treatment or an honest label.

Infrastructure and Trace Detail pass the range through to the picker but do not
read it; their host and span series are still the fixed hour.

The range is not in the URL, so a reload drops back to Last 1 hour. That is the
same gap `query-builder-phase8.md` records for the query builder, and the two
should be done together.
