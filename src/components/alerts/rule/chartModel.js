// What the rule's chart draws, worked out before anything renders: the legend
// rows and their series, the axis top that keeps both tiers in view, the tick
// formatter, the stretches to shade, and how far the state strip under the
// chart must be inset to sit on the plot's own time axis.
//
// The chart is LegendLineChart (D5), which owns its own axis. The strip is
// drawn outside it, so it has to know where that axis puts the plot: the
// y axis's gutter is sized from its widest tick label (chartDefaults
// valueAxisProps), and that label is the axis top, which LegendLineChart takes
// from `yTop` through niceAxis. `yTop` here always clears every series, so the
// top — and the gutter — are fixed by this model, whatever is isolated.

import { niceAxis, formatDecimals, valueAxisProps, fmtCompact, fmtPctTick, fmtRateTick, fmtLoadTimeTick } from '@/components/charts/chartDefaults'
import { bandAxisTop } from '@/components/charts/thresholdBands'
import { browserColor } from '@/utils/chartPalette'
import { formatValue } from '@/utils/alerts/describe'
import { statusForAlertState } from '@/utils/status'
import { seriesName, tierNumber } from './rulePage'

/** LegendLineChart's plot margins, which the strip mirrors (left 0, right 8). */
export const PLOT_MARGIN_RIGHT = 8

// Headroom over the highest reading, so a line that tops out on a round number
// is not drawn along the plot's top edge.
const DATA_HEADROOM = 1.08

/**
 * The y axis's tick text for a rule's unit. Load times keep one unit down the
 * whole axis (fmtLoadTimeTick takes the axis top), percentages carry their
 * sign, rates compact past a thousand.
 */
export function axisTickFor(view) {
  switch (view?.unit) {
    case '%': return v => fmtPctTick(v)
    case 'ms': return (v, top) => fmtLoadTimeTick(v, top)
    case 'rpm': return v => fmtRateTick(v)
    case 'MB': return v => (v == null || Number.isNaN(v) ? '' : `${fmtCompact(v)} MB`)
    case 's': return v => (v == null || Number.isNaN(v) ? '' : `${fmtCompact(v)} s`)
    case 'x': return v => (v == null || Number.isNaN(v) ? '' : `${fmtCompact(v)}×`)
    default: return v => fmtCompact(v)
  }
}

const finite = v => typeof v === 'number' && Number.isFinite(v)

/** The highest reading anything on the chart draws. */
function dataMaxOf(series, extra = []) {
  let max = 0
  for (const s of series) for (const p of s.points ?? []) {
    if (finite(p.value)) max = Math.max(max, p.value)
    // An anomaly rule's expected range reaches above its reading.
    if (finite(p.expected) && finite(p.sigma)) max = Math.max(max, p.expected + 4 * p.sigma)
  }
  for (const v of extra) if (finite(v)) max = Math.max(max, v)
  return max
}

/** The static tiers' thresholds, the numbers the axis must keep in view. */
export function tierThresholds(view) {
  if (view?.kind === 'anomaly') return []
  return [view?.tiers?.warning, view?.tiers?.critical].map(tierNumber).filter(finite)
}

/**
 * The chart's model.
 *
 *   view        the rule view
 *   series      ruleSeriesForWindow's entries, in the data's order
 *   compare     the same series over the comparison window, index-aligned, or []
 *   compareLabel  what the dashed line is called in the tooltip ("Previous period")
 *   selected    the isolated series' name, or null
 *
 * Returns:
 *   eps, epSeries   LegendLineChart's rows and series. The comparison rides as
 *                   one extra series past the rows, so it has a key on the
 *                   chart's data (`ep${eps.length}`) without a legend row.
 *   compareKey, compareColor   for compareLine(), or null when nothing compares
 *   colorFor, formatLabel      palette colours (no status hue), and the name
 *                   the tooltip gives the comparison
 *   drawnIndex      the one series drawn alone (isolated, or the only one), or -1
 *   yTop, axisFormat, axisTop, axisWidth   the fixed axis, and its gutter
 *   fmtFn           a reading in the rule's unit ("14.8%")
 */
export function ruleChartModel({ view, series = [], compare = [], compareLabel = 'Previous period', selected = null }) {
  const eps = series.map(s => {
    const pts = s.points ?? []
    let last = null
    for (let i = pts.length - 1; i >= 0 && last == null; i--) if (finite(pts[i].value)) last = pts[i].value
    return { label: seriesName(s, view), key: s.key, value: last }
  })
  const selectedIndex = selected == null ? -1 : eps.findIndex(e => e.label === selected)
  const drawnIndex = selectedIndex >= 0 ? selectedIndex : eps.length === 1 ? 0 : -1
  const cmp = drawnIndex >= 0 ? compare[drawnIndex] : null
  const hasCompare = !!cmp?.points?.some(p => finite(p.value))
  const epSeries = series.map(s => ({ series: s.points ?? [] }))
  if (hasCompare) epSeries.push({ series: cmp.points })
  const compareIndex = hasCompare ? eps.length : -1

  const colorFor = i => (i === compareIndex ? browserColor(drawnIndex) : browserColor(i))
  // The tooltip names a row by formatLabel(label, row); the comparison has no
  // row, so it is named for what it is.
  const formatLabel = (full, row) => (row ? full : compareLabel)

  const thresholds = tierThresholds(view)
  const dataMax = dataMaxOf(series, hasCompare ? cmp.points.map(p => p.value) : [])
  const yTop = bandAxisTop(dataMax * DATA_HEADROOM, thresholds.length ? Math.max(...thresholds) : 0)

  const tick = axisTickFor(view)
  const fmtFn = v => formatValue(view, v)
  // Exactly LegendLineChart's arithmetic: niceAxis over max(data, yTop) at the
  // tick formatter's precision, then the gutter from the top's label.
  const decimals = formatDecimals(tick)
  const axisTop = niceAxis(Math.max(dataMax, yTop), 4, { decimals }).top
  const axisWidth = valueAxisProps({ format: v => tick(v, axisTop), maxValue: axisTop }).width

  return {
    eps, epSeries, drawnIndex,
    compareKey: hasCompare ? `ep${compareIndex}` : null,
    compareColor: hasCompare ? browserColor(drawnIndex) : null,
    colorFor, formatLabel, yTop, axisFormat: tick, axisTop, axisWidth, fmtFn,
  }
}

/**
 * The stretches to shade on the chart: where the rule (or the isolated series)
 * was firing, each in its severity's tone via statusForAlertState. Pending is
 * left to the strip below, so the chart's shading only ever says "firing".
 * An open stretch runs to now. Times in the chart's ms.
 */
export function firingShades(intervals = [], nowSec) {
  return intervals
    .filter(iv => iv?.state === 'firing' && iv.start != null)
    .map(iv => ({ x1: iv.start * 1000, x2: (iv.end ?? nowSec) * 1000, tone: statusForAlertState('firing', iv.severity) }))
    .filter(s => s.x2 > s.x1)
}

/**
 * An anomaly rule's expected range per bucket (D7): the reading's expected
 * value ± N·σ, N being the tier it would fire on (the warning tier's, else the
 * critical tier's). Buckets as wide as the window's step.
 */
export function expectedRange(view, points = [], stepSec) {
  if (view?.kind !== 'anomaly') return []
  const tier = view.tiers?.warning ?? view.tiers?.critical
  const k = tier?.deviations
  if (!finite(k)) return []
  return points
    .filter(p => finite(p.expected) && finite(p.sigma))
    .map(p => ({
      x1: p.t * 1000,
      x2: (p.t + stepSec) * 1000,
      // A one-sided rule shades only the side it cannot breach on, to the
      // plot's edge (production's band does the same, reference §3.1).
      low: tier.op === '>' ? null : Math.max(0, p.expected - k * p.sigma),
      high: tier.op === '<' ? null : p.expected + k * p.sigma,
    }))
}
