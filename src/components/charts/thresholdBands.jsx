import { ReferenceArea, ReferenceLine } from 'recharts'
import { niceAxis } from '@/components/charts/chartDefaults'

// Good / needs-improvement / poor, painted behind a chart's lines.
//
// A Web Vital is judged against two fixed thresholds (LCP 2.5 s and 4 s, INP
// 200 ms and 500 ms, CLS 0.1 and 0.25), so a line's height already says how it
// rates — but only to a reader who remembers the thresholds. The bands put them
// on the chart: three faint zones in the status tokens and a dashed rule at
// each boundary, so "the checkout page crossed into poor at 14:05" is read off
// the chart rather than worked out from the axis.
//
// The colours are the status tokens themselves (var(--healthy) and friends),
// never a hex: the zones ARE a severity statement, and the tokens re-theme for
// light mode on their own. That is also why a chart drawn over bands takes its
// line colours from BROWSER_COLORS, which holds no status hue.
//
// Two things about Recharts 2.15 decide the shape of this module:
//
//   - The chart drops any child it does not recognise as one of its own. A
//     <ThresholdBands/> component would render nothing at all, so this returns
//     the ReferenceArea and ReferenceLine ELEMENTS, as an array, for the chart
//     to take as children directly — the way a chart takes focus.overlay. They
//     go after the CartesianGrid and before the lines: children order is
//     z-order, and the lines must be drawn over the zones.
//   - A reference element defaults to ifOverflow="discard", which deletes a
//     zone the moment any part of it leaves the y domain — the poor zone
//     always does, since it runs to the top. Every element here is "hidden"
//     instead (clipped to the plot), and none of them is allowed to stretch
//     the domain. So the chart must make room for the thresholds itself: give
//     it an axis top of bandAxisTop(...) (the `yTop` prop of LegendLineChart
//     and MiniChart), or a chart whose data sits well inside "good" scales the
//     poor threshold off the top and shows one green zone.

// Faint enough that gridlines and the lines drawn over the zones stay the
// thing being read; strong enough to tell the three apart on either theme.
const ZONE_OPACITY = 0.08
const RULE_DASH = '4 3'
const RULE_OPACITY = 0.6

// Room above the poor threshold, as a multiple of it, so the poor zone shows
// as a band of its own rather than a hairline at the top of the plot.
const POOR_HEADROOM = 1.2

/**
 * The zone and rule elements for one chart, in drawing order.
 *
 * `good` and `poor` are the thresholds in the chart's own units (a value at or
 * below `good` rates good; above `poor` rates poor). `keyPrefix` keeps the
 * keys apart when one chart draws two sets. `fmt`, when given, labels each
 * rule with its threshold ("2.50 s") at the right-hand end, above the line, in
 * muted text. Pair it with an axis top from bandAxisTop: a label is not
 * clipped with its rule, so a threshold scaled off the plot would leave its
 * label floating above it.
 *
 * Returns an array of Recharts elements — never wrap it in a component.
 */
export function thresholdBands({ good, poor, keyPrefix = 'bands', fmt } = {}) {
  const label = v => (fmt ? {
    value: fmt(v), position: 'insideBottomRight', offset: 4, fill: 'var(--text-muted)', fontSize: 10,
  } : undefined)
  const zone = { fillOpacity: ZONE_OPACITY, ifOverflow: 'hidden' }
  const rule = { strokeDasharray: RULE_DASH, strokeOpacity: RULE_OPACITY, ifOverflow: 'hidden' }
  return [
    <ReferenceArea key={`${keyPrefix}-good`} y1={0} y2={good} fill="var(--healthy)" {...zone} />,
    <ReferenceArea key={`${keyPrefix}-warn`} y1={good} y2={poor} fill="var(--warning)" {...zone} />,
    // No y2: the zone runs to the top of the plot, however tall the axis is.
    <ReferenceArea key={`${keyPrefix}-poor`} y1={poor} fill="var(--critical)" {...zone} />,
    // Each rule takes the colour of the zone it opens: cross the amber one and
    // the reading needs improvement, cross the red one and it is poor.
    <ReferenceLine key={`${keyPrefix}-good-rule`} y={good} stroke="var(--warning)" label={label(good)} {...rule} />,
    <ReferenceLine key={`${keyPrefix}-poor-rule`} y={poor} stroke="var(--critical)" label={label(poor)} {...rule} />,
  ]
}

/**
 * A y-axis top for a chart drawn over bands: high enough for the data, and
 * always above the poor threshold with room for the poor zone to show.
 *
 * Rounded the way the chart's own axis rounds (niceAxis), and to twelve
 * significant digits, so a chart that runs this through niceAxis again lands on
 * the same top — 0.1 × 3 is 0.30000000000000004 in floating point, and a top
 * a hair past 0.3 would be rounded up to a whole extra step.
 */
export function bandAxisTop(dataMax, poor) {
  const data = Number.isFinite(dataMax) && dataMax > 0 ? dataMax : 0
  const floor = Number.isFinite(poor) && poor > 0 ? poor * POOR_HEADROOM : 0
  return Number(niceAxis(Math.max(data, floor)).top.toPrecision(12))
}
