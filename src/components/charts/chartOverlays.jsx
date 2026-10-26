import { Line, ReferenceArea, ReferenceLine } from 'recharts'

// What an alert rule draws over its query's chart besides the threshold bands
// (thresholdBands.jsx): the stretches it was firing or would have fired, the
// range an anomaly rule expected, the present, and the same query one period
// earlier. docs/alerts/DESIGN.md D5 and D7.
//
// The same two Recharts facts that shape thresholdBands shape these:
//
//   - The chart drops a child it does not recognise, so each helper returns
//     ELEMENTS (an array, or one element) for the chart to take as children
//     directly — LegendLineChart's and MiniChart's `overlays`. Never wrap one
//     in a component of its own: it would render nothing.
//   - A reference element defaults to ifOverflow="discard", which deletes an
//     area the moment any part of it leaves the axis. A firing stretch that
//     began before the window opened always does. Every area and line here is
//     "hidden" instead: clipped to the plot, never stretching an axis.
//
// Colour follows the platform's one rule about severity. A shaded stretch IS a
// severity statement ("critical from 15:18"), so it is painted in the status
// token for its tone, and the tone comes from the caller, resolved through
// status.js (statusForAlertState) — never picked here. The expected range is
// not a severity, only what the rule considered normal, so it is neutral and
// never a status hue. The comparison line is a series, so it takes the colour
// of the series it compares, which the caller draws from the chart palette.

// Every x here is in the chart's own x units. The platform's time charts plot
// milliseconds (timeAxis.js, kind 'time'), so a caller with unix seconds
// multiplies by 1000.

const TONE_FILL = {
  critical: 'var(--critical)',
  warning: 'var(--warning)',
  info: 'var(--info)',
  healthy: 'var(--healthy)',
  neutral: 'var(--neutral)',
}

// A firing stretch is read across the whole plot, over the bands and under the
// lines, so it stays faint; pending (info) fainter still, since it is a
// warning that the stretch may become one rather than a stretch of its own.
const SHADE_OPACITY = 0.12
const SHADE_OPACITY_PENDING = 0.07
// A backtest stretch ("would have fired") is a hypothesis, not a record: a
// lighter fill with a dashed outline, so the two never read as the same thing.
const WOULD_OPACITY = 0.06
const WOULD_DASH = '3 3'

// The expected range: grey, and enough of it to read as a band under a line.
const EXPECTED_FILL = 'var(--text-muted)'
const EXPECTED_OPACITY = 0.16

const NOW_DASH = '2 3'
const COMPARE_DASH = '5 3'

const isNum = v => typeof v === 'number' && Number.isFinite(v)

/**
 * Time stretches shaded across the plot's full height, one per interval.
 *
 * `intervals` are `{ x1, x2, tone }`: where a stretch starts and ends, and its
 * status tone ('critical' | 'warning' | 'info', from statusForAlertState). An
 * `x2` of null is a stretch still open — it runs to the right-hand edge of the
 * plot, however wide the axis is, the way an open firing interval does. An
 * interval with no numeric x1 is skipped.
 *
 * `variant` is 'was' (a stretch the rule spent firing: the default) or
 * 'would' (the editor's backtest: where a draft would have fired), drawn
 * lighter and outlined in dashes.
 */
export function shadedIntervals({ intervals = [], keyPrefix = 'shade', variant = 'was' } = {}) {
  const would = variant === 'would'
  return intervals
    .filter(iv => iv && isNum(iv.x1) && (iv.x2 == null || (isNum(iv.x2) && iv.x2 > iv.x1)))
    .map((iv, i) => {
      const fill = TONE_FILL[iv.tone] ?? TONE_FILL.neutral
      const opacity = would ? WOULD_OPACITY : iv.tone === 'info' ? SHADE_OPACITY_PENDING : SHADE_OPACITY
      return (
        <ReferenceArea
          key={`${keyPrefix}-${i}`}
          x1={iv.x1}
          // No x2: an open stretch runs to the right-hand edge of the plot.
          {...(iv.x2 == null ? null : { x2: iv.x2 })}
          fill={fill}
          fillOpacity={opacity}
          {...(would ? { stroke: fill, strokeOpacity: 0.5, strokeDasharray: WOULD_DASH } : null)}
          ifOverflow="hidden"
        />
      )
    })
}

/**
 * An anomaly rule's expected range as a neutral band: mean ± N·σ over the
 * trailing window (D7), one step per bucket.
 *
 * `points` are `{ x1, x2, low, high }` — a bucket's span and the range the
 * rule expected within it. A one-sided rule leaves one side open: `low: null`
 * runs the band to the bottom of the plot ("above by" is only breached
 * upwards), `high: null` to the top ("below by"), as production shades only
 * the side that cannot breach. A point with neither, or with no span (the
 * window's first buckets, before a trailing mean exists), is skipped. Drawn as
 * a step per bucket rather than an interpolated area: the range is computed
 * per bucket, so a smooth band would claim a value between buckets nobody
 * computed — and Recharts draws an <Area> in an AreaChart or ComposedChart
 * only, never in the LineChart a legend chart is.
 *
 * Grey whatever the reading does: the range is what the rule considered
 * normal, which is not a severity, so it never wears a status hue.
 */
export function expectedRangeBand({ points = [], keyPrefix = 'expected' } = {}) {
  const side = v => v == null || isNum(v)
  return points
    .filter(p => p && isNum(p.x1) && isNum(p.x2) && p.x2 > p.x1 && side(p.low) && side(p.high)
      && (isNum(p.low) || isNum(p.high)) && !(isNum(p.low) && isNum(p.high) && p.high < p.low))
    .map((p, i) => (
      <ReferenceArea
        key={`${keyPrefix}-${i}`}
        x1={p.x1}
        x2={p.x2}
        // No y1 or y2: that side runs to the edge of the plot.
        {...(isNum(p.low) ? { y1: p.low } : null)}
        {...(isNum(p.high) ? { y2: p.high } : null)}
        fill={EXPECTED_FILL}
        fillOpacity={EXPECTED_OPACITY}
        ifOverflow="hidden"
      />
    ))
}

/**
 * The present, as a dashed vertical rule labelled "now". For a window that
 * runs past now (Today, or a range centred on a notification), it is where the
 * data stops; at the right-hand edge of a trailing window it says the chart is
 * live. Null when `x` is not a number.
 */
export function nowLine({ x, label = 'now', keyPrefix = 'now' } = {}) {
  if (!isNum(x)) return null
  return (
    <ReferenceLine
      key={`${keyPrefix}-line`}
      x={x}
      stroke="var(--text-muted)"
      strokeDasharray={NOW_DASH}
      strokeOpacity={0.9}
      label={label ? { value: label, position: 'insideTopRight', offset: 4, fill: 'var(--text-muted)', fontSize: 10 } : undefined}
      ifOverflow="hidden"
    />
  )
}

/**
 * The same query one period earlier, as a dashed line in the colour of the
 * series it compares — Explore's ghost line (its Compare). `dataKey` names the
 * row field holding the earlier reading, aligned to the current buckets. It has
 * no dot of its own and no legend entry: it is read against its series, not on
 * its own.
 */
export function compareLine({ dataKey, color, keyPrefix = 'compare' } = {}) {
  if (dataKey == null) return null
  return (
    <Line
      key={`${keyPrefix}-line`}
      type="linear"
      dataKey={dataKey}
      stroke={color}
      strokeWidth={1.2}
      strokeOpacity={0.75}
      strokeDasharray={COMPARE_DASH}
      dot={false}
      activeDot={false}
      legendType="none"
      connectNulls={false}
      isAnimationActive={false}
    />
  )
}
