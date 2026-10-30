# Chart Compare and Expand

Every chart card's corner now carries two controls: **Expand** (⤢), which opens the card's
chart on its own, larger, and the **⋮** menu, whose **Compare** opens it against an earlier
window. Both open the same modal (`src/components/charts/ChartModal.jsx`).

## What production does, and what we copy

Production's chart ⋮ menu is "Compare", a divider, "Create Alert", "Explore"
(`docs/alerts/reference/production.md` §15.3). Compare opens a full-width modal:

- a centred **"Compare with [1 day ago ▾]"** select offering 1 hour ago, 1 day ago and
  1 week ago;
- the chart over the page's window, titled with the chart's name and with its ⋮;
- under it, the same chart over the same span shifted back, titled with the choice
  ("1 day ago");
- one crosshair across both, with the tooltip only on the chart under the pointer.

We copy all of that, including the divider after Compare. Production has no Expand. Ours
is the same modal holding the one chart, larger, with its ⋮ and nothing to compare.

## The contract: a card hands its corner a view

A chart card no longer renders a bare `<CardMenu kind="chart">`. In its place it renders
**`<ChartActions title total view>`** (`src/components/charts/ChartActions.jsx`): the
Expand button, then the ⋮. It is one element, so a header laid out as "title … menu" keeps
both ends.

`view` is the card's chart as a function of the window:

```js
view = {
  win,                 // the window the card draws now (the page's)
  render: w => node,   // the card's chart — plot and legend, NOT its header — over window w
  value: w => string,  // optional: the figure the header prints beside the title, for w
  comparable: true,    // false: the card can only draw `win`, and its ⋮ offers no Compare
}
```

`render(w)` must draw the chart over `w` by **the same derivation** that gave the card its
data for the page's window. The data-for-window functions (`seriesForWindow(w)`,
`infraHostsForWindow(w)`, `pageViewsForWindow(w)`, …) are pure in the window, so this
means calling them with `w` and re-applying whatever the card does to their output (pick
the selected host by name, compose rows, colour by index). `render(win)` must draw exactly
what the card draws. Selection state (an isolated row, a chosen tab, a picked host) is
read from the card's current state, never recomputed.

The generic cards do this for their callers. A caller adds **`forWindow`**:

| Card | `forWindow(w)` returns |
|---|---|
| `CardChart` (and `InfraCard`, which passes props through) | `{ series, value? }` |
| `LegendLineChart` | `{ eps, epSeries }`, plus anything else that moves with the window (`yTop`, `overlays`) |
| `SummaryCard` (Browser) | `{ value, series }`, plus `yTop`, `overlays` if they move |

Without `forWindow` those cards still get Expand, but their ⋮ drops Compare.
`LegendLineChart` also takes `compare={false}` for a chart that owns a comparison of its
own (the alert rule's chart).

A bespoke card (the service page's TrendChart, Latency Drilldown, the External and DB
split charts, Infra's ProcessChartPanel) builds its own `view` and renders
`<ChartActions title view />`. Its chart body has to be renderable over any window, which
usually means factoring the plot and legend out of the component that also draws the
header.

## What the modal tells the chart: the frame

Inside the modal every chart reads `ChartFrameContext` (`src/components/charts/chartView.js`)
through `TimeChart` and `ChartTooltip`. A chart therefore does not need to be told it is in
a modal:

- **Crosshair.** The frame's `syncId`/`syncMethod: 'index'` ride on `focus.chartProps`. Every
  chart spreads those after its own `syncId`/`syncMethod`, so they win.
  - The modal never joins the page's sync group. Doing so would drive the charts behind
    the overlay.
  - The modal syncs by index, not value. An earlier window shares no x value with the
    current one, but it has the same bucket count (`shiftWindow`).
- **Height.** The frame's height outranks the card's `height` prop and its CSS class.
- **Drag.** `brush: false` on the earlier chart keeps hover and tooltip but takes away the
  drag-to-zoom, which would otherwise move the page into the past. The page's chart in the
  modal still zooms the page, and because the modal renders from the card's live view, both
  panels follow.
- **"… ago".** `nowMs` is the page's window end, so a point on the "1 day ago" chart reads
  "1 day ago".

What a reader has done to a card's legend is the card's state, not the frame's.
`LegendLineChart` holds its isolated row (by label) and its search for every drawing of
it, and the Latency Drilldown panel does the same, so:

- Expand and Compare open on the legend as the card shows it;
- both charts of a Compare isolate and filter together;
- isolating a row in the modal isolates it on the card.

Hover and the series budget stay with each drawing.

A chart that does **not** spread `focus.chartProps` after `syncId`/`syncMethod`, or that
dates its tooltip without `ChartTooltip`, does not get the frame's crosshair, height,
drag setting or "now". Such a chart must be fixed when it gets a view.

A Compare's earlier legend chart lists and draws **the page's rows in the page's order**,
each with its own window's figure (`rankLabels`). Ranked by its own window, it would trade
the rows at the edge of its series budget for others, and the two charts would draw
different routes under one title. Infra's fleet cards keep the page's order for the same
reason.

## Keyboard

The modal is a dialog for the keyboard as well as the eye:

- **Focus.**
  - On open, focus moves to Close. On close, it goes back to whatever opened the modal:
    the Expand button, or the ⋮.
  - Turning an expanded chart into a Compare (through its ⋮), or picking a window with the
    pointer, puts focus on the "Compare with" select.
  - If focus still ends up on `<body>`, Tab brings it back into the dialog.
- **Escape.** It closes the modal from anywhere. A key that something inside has already
  answered is left to that thing:
  - an open ⋮ menu;
  - the select's list;
  - a drag in progress, which `useTimeFocus` cancels in the capture phase and marks as
    handled.

  One press undoes one thing.
- **Backdrop.** Only a press that starts on the backdrop closes the modal. A drag let go
  over the backdrop does not.

## The earlier window

`shiftWindow(win, bySec)` (`src/data/timeWindow.js`) shifts the window bucket for bucket
rather than re-resolving it. Re-resolving a shifted 2-hour range picks a coarser step
(25 buckets against 61), and a trailing window gains a bucket.

- **Kept:** the bucket count, step and lengths, and `nowSec`.
- **Re-measured:** each bucket's incident share, whether it is still to come, and its
  label (clock with a date).
- **Rebuilt:** `pastBuckets`, `pastMinutes`, `crossesDay`, `label` and `exactMs`.
- **Memoised:** per (window, shift). Data modules cache rows in a WeakMap keyed on the
  window object, so this keeps the earlier window's rows to one build.

The incident sits 22 minutes before now, so every earlier window shows the quiet
baseline. That contrast is what Compare is for.

## Rules every card keeps

- Series colours are the card's own palette colours in both copies. The earlier copy is
  never tinted (CLAUDE.md rules 1–2).
- A modal copy gets its own series budget and its own hover state. Never hand it a page
  budget's `onWidth`: a wider modal would change the page's cap.
- The earlier copy carries no ⋮. Its Create Alert and Explore would act on the page's
  window, not on the one drawn.
- Loading skeletons render `<ChartActions title>` with no view. Expand is drawn disabled so
  the header does not shift at reveal, and the ⋮ keeps its old behaviour.
- Charts without a ⋮ get neither control: the Logs, Traces and Errors volume strips, stats
  results, Explore, error sparks, Infra's no-data charts, and the Slow Requests latency
  distribution (a list panel, not a time series).

## Where we differ from production, and the gaps we left

- **Expand** is ours; production has no Expand.
- **Each chart of a Compare fits its own y axis**, as production's do (its screenshot tops
  one chart at 0.25 and the other at 0.5). The earlier, quiet window can therefore look as
  busy as the incident. A shared top across the pair would show the contrast better. Every
  chart component would need to read it from the frame; that is not built.
- **A fleet card's earlier copy keeps the page's busiest-first order** rather than
  re-ranking by the earlier window. Re-ranking would trade hosts at the edge of the series
  budget, so the two charts would draw different hosts under one title.
- **Figures beside a title** are recomputed for the earlier window where the card derives
  them from the window. A static summary figure (MySQL's and Redis's) is left off the
  earlier panel rather than repeated over another day's line.
- **A Runtime host that sent nothing in the earlier window** (one added minutes ago) draws
  an empty earlier chart. The page's notice explaining why is not in the modal.
- **A loading skeleton's Compare** says the chart is still loading.
