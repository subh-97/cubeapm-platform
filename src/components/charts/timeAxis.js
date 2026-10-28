// Where the ticks go on a time axis, and what they say.
//
// The old rule was "let Recharts keep the first and last label and thin the
// rest by a fixed stride". That stride walks over BUCKET INDICES, so the labels
// land wherever the arithmetic puts them: a seven-day chart ticks every 33
// hours, which is a different wall-clock time on every tick and never midnight.
// It is the same axis at every scale because it never knew it was showing time.
//
// A good time axis instead picks an interval a human already counts in — 30
// seconds, 5 minutes, 2 hours, a day — and puts ticks on the round instants of
// that interval. Then "every 2 hours" reads 14:00 16:00 18:00, not 14:07 16:07
// 18:07, and a week reads as days rather than as thirty-three-hour steps.
//
// Three rules the ladder below holds to:
//
//   1. NEVER TICK FINER THAN A BUCKET. A label between two samples implies a
//      reading that was never taken.
//   2. THE FORMAT IS PICKED PER CANDIDATE INTERVAL, not from the span. The
//      moment the interval is a whole minute the labels drop `:ss` and get
//      narrower, which lets a denser ladder fit. Choosing the format from the
//      span instead would be circular and would reserve seconds-width on an
//      axis that shows no seconds.
//   3. MULTI-DAY INTERVALS ANCHOR ON A FIXED EPOCH, not on the window's own
//      first day. Anchoring on the window means "Last 7 days" ticks Oct 1/3/5
//      today and Oct 2/4/6 tomorrow — the axis would not be stationary, which
//      is the one thing "consistent for all ranges" has to mean.
//
// The axis is deliberately TERSER than the tooltip. A tick says `18:00` where
// the tooltip behind it says `Oct 01 18:00`: the tick is fighting for pixels
// against its neighbours and the tooltip is not, so they are allowed to
// disagree in precision. They must never disagree about the instant.
//
// This module is pure — no React, no Recharts — so the ladder can be tested
// directly the way `timeWindow` is.

import { formatLocal } from '@/utils/timeRange'
import { VALUE_AXIS_MAX_WIDTH } from '@/components/charts/chartDefaults'

const SEC = 1000

/** Intervals a reader already counts in, in seconds. */
const TICK_STEPS = [
  1, 2, 5, 10, 15, 30,
  60, 120, 300, 600, 900, 1800,
  3600, 7200, 10800, 21600, 43200,
  86400, 172800, 604800,
]

// The horizontal budget one label needs, by what the label looks like. A dated
// tick is wider than a bare clock, and a clock with seconds is wider again —
// budgeting them all the same is how an axis ends up either crowded or sparse
// depending on which format it happened to choose.
const GAP_PX = { hm: 50, hms: 68, day: 60 }

const AXIS_TICK = { fontSize: 10, fill: 'var(--text-muted)' }

/** Most ticks any axis should carry, however wide it is. */
const MAX_TICKS = 13
const MIN_TICKS = 2

// What one character of a tick label draws as, at AXIS_TICK's 10px in the
// product's font with its tabular digits: `18:50` measures 27.3px, `18:50:30`
// 42.3px and the widest month date 33.4px. Six a character is over all of them,
// so the estimate errs toward dropping a label rather than clipping one.
const CHAR_PX = 6

// How much of the measured width may not be plot. Most charts hand the axis the
// width of the box they draw in, and the plot sits inside it after a value axis
// on the left and a 4-8px margin on the right. The axis does not know which
// chart it is drawing for, so it places labels on the narrowest plot that box
// could hold: a label it keeps clears both edges of every chart, and the price
// is an occasional label dropped that would just have fitted. A caller that has
// already taken the gutters off (the Traces and Errors volume charts) pays that
// price twice, which is a few pixels of a thousand.
const PLOT_INSET_PX = VALUE_AXIS_MAX_WIDTH + 8

/**
 * What a tick at this interval has to say.
 *
 * Every window reads as a clock, including the default hour. It used to tick
 * "-60m -55m … now", which was the look this product shipped with, but an axis
 * that changes vocabulary at one particular range is the opposite of the
 * consistency the rest of this ladder is for: the reader has to notice which
 * range they are on before they can read the axis at all. Relative time is
 * still the FIRST thing the tooltip says, where there is room to say it in
 * words — see ChartTooltip's "27 mins ago".
 */
function formatKind(win, intervalSec) {
  if (intervalSec % 86400 === 0) return 'day'
  if (intervalSec % 60 !== 0) return 'hms'
  // A window that crosses midnight has at least one dated tick in it, and every
  // tick has to be budgeted for the widest label the axis will draw.
  return win.crossesDay ? 'day' : 'hm'
}

const dayStart = (ms) => {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * The instants a tick lands on, in ms.
 *
 * Relative windows count back from the right-hand edge, because the thing being
 * located is "how long ago" and the anchor is now. Clock windows count forward
 * from a round boundary, because the thing being located is "when".
 *
 * Hour and day steps advance through the calendar rather than by adding
 * milliseconds, so a DST transition inside a 24-hour or 7-day window does not
 * walk every later tick off the hour.
 */
export function tickInstants(win, intervalSec) {
  const startMs = win.start * SEC
  const endMs = win.end * SEC
  const out = []

  if (intervalSec >= 86400) {
    // Anchored on the epoch, so the same interval picks the same days whatever
    // day the window happens to begin on.
    const days = intervalSec / 86400
    const originDay = Math.floor(dayStart(startMs) / 86400000 / days) * days
    for (let d = originDay; ; d += days) {
      const t = dayStart(d * 86400000 + 43200000) // noon, then floored: DST-safe
      if (t > endMs) break
      if (t >= startMs) out.push(t)
      if (out.length > 400) break
    }
    return out
  }

  if (intervalSec >= 3600) {
    const hours = intervalSec / 3600
    const d = new Date(dayStart(startMs))
    while (d.getTime() <= endMs) {
      const t = d.getTime()
      if (t >= startMs) out.push(t)
      d.setHours(d.getHours() + hours)
      if (out.length > 400) break
    }
    return out
  }

  // Sub-hour: multiples of the interval counted from local midnight.
  const origin = dayStart(startMs)
  const stepMs = intervalSec * SEC
  let t = origin + Math.ceil((startMs - origin) / stepMs) * stepMs
  for (; t <= endMs; t += stepMs) {
    out.push(t)
    if (out.length > 400) break
  }
  return out
}

/**
 * The widest ladder that still fits. Walks from fine to coarse and takes the
 * first interval whose labels have room, which is what makes the axis get
 * denser on a wide chart and sparser on a narrow one without either of them
 * changing what the ticks MEAN.
 *
 * The budget counts every instant an interval lands on, including any whose
 * label insidePlot will drop at an edge: the count stands in for the spacing
 * between neighbours, and dropping an end label does not widen that. But an
 * interval only fits if two of its labels survive the edges, or a ladder of
 * three twelve-hourly ticks, two of them on the edges, would win on a narrow
 * chart and draw a single label.
 */
export function pickTickInterval(win, plotWidth, gapPx) {
  const width = Math.max(0, plotWidth || 0)
  const steps = TICK_STEPS.filter(s => s >= win.step)
  const drawsAnAxis = (instants, kind) => insidePlot(win, instants, width, kind).length >= MIN_TICKS
  for (const interval of steps) {
    const kind = formatKind(win, interval)
    const instants = tickInstants(win, interval)
    const n = instants.length
    if (n < MIN_TICKS) continue
    if (n <= MAX_TICKS && n * (gapPx ?? GAP_PX[kind]) <= width && drawsAnAxis(instants, kind)) {
      return { interval, kind }
    }
  }
  // Nothing fits. Fall back to the coarsest ladder that still draws two labels
  // inside the plot, and failing that to the coarsest that LANDS ON two
  // instants at all, not to the coarsest step in the table: a weekly interval
  // inside a thirty-minute window ticks on no instant, and the axis then draws
  // zero labels. That second fallback is what a chart gets on its very first
  // paint, before the width has been measured and there is no inside to keep
  // labels in. Two crowded labels are an axis; none is not.
  const coarseFirst = [...steps].reverse()
  for (const interval of coarseFirst) {
    const kind = formatKind(win, interval)
    if (drawsAnAxis(tickInstants(win, interval), kind)) return { interval, kind }
  }
  for (const interval of coarseFirst) {
    if (tickInstants(win, interval).length >= MIN_TICKS) {
      return { interval, kind: formatKind(win, interval) }
    }
  }
  const interval = Math.max(win.step, TICK_STEPS[0])
  return { interval, kind: formatKind(win, interval) }
}

/** What one tick says. */
export function formatTick(ms, kind) {
  if (kind === 'hms') return formatLocal(ms, 'HH:mm:ss')
  const d = new Date(ms)
  // Inside a window that crosses days, the midnight tick is the one that says
  // WHICH day; every other tick stays a clock time, so the date appears exactly
  // where it carries information and nowhere else. On a day-interval ladder
  // every tick IS midnight, so that ladder dates itself without a special case.
  if (kind === 'day' && d.getHours() === 0 && d.getMinutes() === 0) return formatLocal(ms, 'MMM DD')
  return formatLocal(ms, 'HH:mm')
}

/**
 * Where a tick at this instant can be drawn, as fractions of the plot from its
 * left edge (0) to its right (1). A numeric axis draws the instant at its own
 * place; a band scale draws it at the centre of the bucket that holds it. The
 * edge test asks both, so a bar chart and a line chart over one window keep the
 * same ladder rather than each trimming its own ends.
 */
function tickFractions(win, ms) {
  const sec = ms / SEC
  const out = [(sec - win.start) / (win.end - win.start)]
  const n = win.buckets?.length
  if (n) {
    const i = Math.max(0, Math.min(n - 1, Math.floor((sec - win.start) / win.step)))
    out.push((i + 0.5) / n)
  }
  return out
}

/**
 * The ticks whose labels stay inside the plot.
 *
 * The ladder puts ticks on round instants without asking where those land, so a
 * window that ends a few seconds past a round mark has its last tick on the
 * plot's right edge. Centred there, half the label hangs off the end of the SVG
 * and is clipped to "19:2". Shifting it inward instead, which is what Recharts'
 * own `preserveEnd` does, would keep the text but move it off its instant: the
 * axis draws no tick lines, so nothing would mark where 19:20 really is, and the
 * label would sit over 19:18. The axis may be terser than the tooltip but never
 * wrong about the instant, so a label that cannot sit on its instant is not
 * drawn. The left edge is held to the same rule; a label hanging under the
 * value axis reads as one of its labels.
 */
function insidePlot(win, instants, width, labelKind) {
  const plot = width - PLOT_INSET_PX
  return instants.filter(ms => {
    const half = (formatTick(ms, labelKind).length * CHAR_PX) / 2
    return tickFractions(win, ms).every(f => f * plot >= half && (1 - f) * plot >= half)
  })
}

/**
 * The full axis description for a window at a measured pixel width.
 *
 * `kind` is how the chart plots x:
 *   'time'     — a numeric instant axis (Area and Line charts). Rows must carry
 *                `t` in unix seconds; the axis reads `x` in ms.
 *   'category' — the label axis Recharts band-scales for bars. The ticks are the
 *                same instants, resolved to the bucket labels that sit on them,
 *                so a bar chart and a line chart on the same page carry the same
 *                ladder while the bars keep the band scale they need.
 */
export function buildTimeAxis(win, { width = 0, kind = 'time' } = {}) {
  const { interval, kind: labelKind } = pickTickInterval(win, width)
  const all = tickInstants(win, interval)
  const inside = insidePlot(win, all, width, labelKind)
  // Fewer than two inside only when the picker found no interval that keeps
  // two clear of the edges: the chart has not been measured yet, or is too
  // narrow for any ladder. Then the whole ladder is drawn, crowded, rather
  // than one label or none.
  const instants = inside.length >= MIN_TICKS ? inside : all

  if (kind === 'category') {
    // Snap each instant to the bucket that contains it, then take that bucket's
    // own label — the category axis can only tick on values it actually has.
    // Each tick keeps the INSTANT it was chosen for. Formatting the bucket's
    // own opening time instead would be subtly wrong and occasionally absurd: a
    // seven-day window buckets at three hours, so every midnight tick lands in
    // a bucket that opened at 23:00, the date rule never fires, and the whole
    // axis reads "23:00 23:00 23:00".
    const tickMs = new Map()
    const ticks = []
    for (const ms of instants) {
      const i = Math.floor((ms / SEC - win.start) / win.step)
      const b = win.buckets[Math.max(0, Math.min(win.buckets.length - 1, i))]
      if (b && !tickMs.has(b.label)) { tickMs.set(b.label, ms); ticks.push(b.label) }
    }
    // A category tick's VALUE has to be the bucket's own label — that is the
    // only thing the band scale can tick on — but its TEXT does not. The bucket
    // label is written to be unambiguous on its own, because it is also the
    // tooltip's heading: `Oct 07 00:00:00` where this axis wants `00:00`. Drawn
    // raw it is 76px of tick on a chart that has room for five, so the ladder
    // is reformatted back to the terse form the numeric axis uses. Same ticks,
    // same words, whichever scale the chart happens to need.
    return {
      interval,
      labelKind,
      ticks,
      props: {
        dataKey: 'label',
        ticks,
        // `interval: 0` draws exactly the ticks given and nothing else; without
        // it Recharts re-thins the ladder that was just computed to fit.
        interval: 0,
        tickFormatter: label => {
          const ms = tickMs.get(label)
          return ms == null ? label : formatTick(ms, labelKind)
        },
        tick: AXIS_TICK,
        tickLine: false,
        axisLine: { stroke: 'var(--border-subtle)' },
      },
    }
  }

  return {
    interval,
    labelKind,
    ticks: instants,
    props: {
      dataKey: 'x',
      type: 'number',
      scale: 'linear',
      domain: [win.start * SEC, win.end * SEC],
      // Required for Recharts to treat the domain as author-specified; without
      // it the selection overlay's own ReferenceArea can stretch the axis
      // underneath the drag that is drawing it.
      allowDataOverflow: true,
      ticks: instants,
      interval: 0,
      // A formatter is not optional on a numeric axis: the overlap measurement
      // sizes the raw tick value, so without one every tick is budgeted at the
      // width of a 13-digit epoch number.
      tickFormatter: ms => formatTick(ms, labelKind),
      tick: AXIS_TICK,
      tickLine: false,
      axisLine: { stroke: 'var(--border-subtle)' },
      minTickGap: 0,
    },
  }
}


/**
 * The x a numeric-axis row plots at: the bucket's CENTRE, uniformly one step
 * wide.
 *
 * Centres, because a bar on a non-category axis is drawn around its coordinate
 * rather than from it. Uniformly, because Recharts sizes every band from the
 * SMALLEST gap between adjacent coordinates — and the last bucket of a window
 * is usually a short one, so centring it honestly would shrink every bar in the
 * chart to match that final stub.
 */
export function xOf(row, win) {
  return row.t * SEC + win.step * (SEC / 2)
}

/** Adds the numeric x a time axis reads, leaving every other key alone. */
export function withX(rows, win) {
  return rows.map(r => (r.t == null ? r : { ...r, x: xOf(r, win) }))
}
