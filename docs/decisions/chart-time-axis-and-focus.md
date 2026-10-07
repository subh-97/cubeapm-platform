# The time axis, and drag-to-focus

Two changes to the chart layer, which turned out to be the same change twice:
nothing in it knew what *instant* an x position was. So ticks fell on array
indices, and the two pages that had a drag gesture had to implement it by
matching a label string against a bucket list.

## The axis

`src/components/charts/timeAxis.js`, with property tests beside it.

The old `timeAxisProps` returned a category axis with
`interval: 'preserveStartEnd'`, which thins labels by a fixed stride over bucket
indices. The stride lands where the arithmetic puts it: a seven-day chart ticked
every 33 hours, a different wall-clock time on every tick and never midnight. It
drew the same axis at every scale because it never knew it was showing time.

`buildTimeAxis(win, { width, kind })` instead picks an interval a human already
counts in and puts ticks on the round instants of it:

| Range | Before | After |
|---|---|---|
| 1 hour | `-59m -48m -37m -26m -15m` | `-60m -55m -50m … -5m now` |
| 6 hours | every ~33 min | `18:00 18:30 19:00 … 23:30` |
| 24 hours | every ~2.4 h, unaligned | `Oct 06 02:00 04:00 … 22:00` |
| 7 days | every ~33 h | `Sep 30 Oct 01 … Oct 06` |
| dragged `Oct 01 14:23 → Oct 03 09:47` | arbitrary | `18:00 Oct 02 06:00 12:00 18:00 Oct 03 06:00` |

Four rules, each of which was a bug before it was a rule:

1. **Never tick finer than a bucket.** A label between two samples implies a
   reading nobody took.
2. **Pick the format per candidate interval, not from the span.** The moment the
   interval is a whole minute the labels drop `:ss` and get narrower, which lets
   a denser ladder fit. Choosing from the span is circular and reserves
   seconds-width on an axis that shows no seconds.
3. **Anchor multi-day intervals on the epoch, not on the window's first day.**
   Anchoring on the window makes "Last 7 days" tick Oct 1/3/5 today and Oct
   2/4/6 tomorrow. An axis that moves under you is the opposite of consistent.
4. **Date only the midnight ticks.** A two-day window that dated all eight of
   its six-hourly ticks read `Oct 05 Oct 05 Oct 05 Oct 05 Oct 06 …`. The date
   belongs exactly where it says which day, and nowhere else.

### Terse axis, qualified tooltip

A tick reads `18:00` where the tooltip behind it reads `Oct 01 18:00`. The tick
is fighting its neighbours for pixels and the tooltip is not, so they are
allowed to differ in precision — never in the instant.

### Two scales, one ladder

Area and Line charts plot on a **numeric** instant axis (`x` in ms, bucket
centres, uniform band width). Bar charts — the Logs and Traces volume
histograms — keep the **category** band scale they need. Both get the same
interval and draw the same words.

That last part needed care. A category tick's *value* has to be the bucket's own
label, because a band scale can only tick on values it has — but a bucket label
is written to be unambiguous alone, since it doubles as the tooltip heading:
`Oct 07 00:00:00` where the axis wants `00:00`. Drawn raw, four labels filled a
chart with room for eleven. So the category axis reformats its ticks, from **the
instant each tick was chosen for** rather than from the bucket's opening time.
Formatting from the bucket's open is subtly wrong and occasionally absurd: a
seven-day window buckets at three hours, so every midnight tick sits in a bucket
that opened at 23:00, the date rule never fires, and the axis reads
`23:00 23:00 23:00 23:00`.

## Drag-to-focus

`src/components/charts/useTimeFocus.jsx`. One hook, replacing two hand-rolled
copies, so a drag behaves identically on every chart — which matters because the
range it sets is shared. Drag on one chart and every other chart on the page
redraws.

In scope: every chart whose rows come from the window — all of Service Overview,
the Logs and Traces volume histograms, every Infrastructure chart, and Home's
health strip (36 divs, no Recharts, each already an exact instant range).

Out of scope, deliberately: `HoverChartPopover` and `ErrorSpark` (decorative,
no timestamps), `Sparkline`/`KpiCard` (positions by array index), the trace
Waterfall (a trace's own 0..totalMs, not the page's window), and everything
under `*/explore/` — another session owns it, and `ExploreView` has recorded the
*opposite* policy under ARCH D5: a drag there is the page's own range and
deliberately does not touch the app's.

### Decisions inside the gesture

- **Desktop only, stated.** Recharts routes touch through the mouse handlers
  badly: `handleTouchStart` hands `onMouseDown` a `Touch` object, which has no
  `button` and no `preventDefault`, and it commits through `onMouseUp` rather
  than the document `mouseup` this hook listens on. On a tablet you would get a
  preview and no commit. The `button !== 0` guard makes a touch a clean no-op
  instead. Nothing else in this product supports touch.
- **A floor of five minutes**, the product's own shortest preset. Two successive
  drags otherwise walk down to a one-minute window, which is four fat buckets
  and reads as a rendering fault. A selection under the floor is *grown around
  its centre*, not refused — the reader asked for "around here".
- **Snap to the bucket when buckets are finer than a minute.** `zoomRange` used
  to snap to the minute always; a 5-minute window buckets at 15 seconds, so a
  two-bucket drag handed back twice the span that was selected.
- **No future.** The From/To picker already refuses a future range; the drag
  path would otherwise be allowed to set one, and on `Today` — which includes
  future buckets by design — every chart would go blank with no explanation.
- **Cancel on Escape and on scroll.** `.svc-main` scrolls; without the scroll
  guard the chart slides under a stationary pointer and the selection grows on
  its own.
- A chart needs a `<Tooltip>` child or Recharts never attaches `onMouseMove`
  (`parseEventsOfWrapper`). That is why a chart without one cannot be brushed.

## The infrastructure data rewrite

Drag-to-focus on Infrastructure would have been a gesture that changed nothing:
every series there was a fixed 60-point array that ignored the range. The
builders are now window-aware, following the pattern `services.js` established —
quiet baseline plus a calibrated peak, pinned so the reference hour reproduces
the published figure exactly (ip-10-0-142-133 still reads 92.40 / 88.20 at
Last 1 hour, and dilutes to 82.95 / 83.52 over a day).

One trap worth recording: putting the daily traffic wave on host CPU made a
critical host's CPU read *higher* over seven days than over the last hour,
because `sampleAt` normalises the wave against the reference hour. The rule
`services.js` already follows is the fix — **nothing that carries the incident
also carries the wave**.

## Not fixed here

`src/components/AggregateResults.jsx` still has the original complaint in its
purest form — `interval={Math.ceil(chartData.length / 5) - 1}` — and it never
called `timeAxisProps`, so none of this reaches it. It also buckets
independently of the window (30 buckets beside a 60-bar volume chart on the same
page). It needs its own pass.

`timeAxisProps` in `chartDefaults.js` is deliberately untouched and keeps its old
signature. The untracked `ExploreChart.jsx` still calls `timeAxisProps(length)`;
changing it would break that file at runtime with no compile error and no merge
conflict, because git does not track it. Converted charts simply stopped calling
it.
