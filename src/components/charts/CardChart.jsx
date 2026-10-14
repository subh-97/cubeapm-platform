import { useMemo } from 'react'
import { AreaChart, Area, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts'
import { GRID_PROPS, NO_ANIM, AREA_PROPS, LINE_PROPS, valueAxisProps, maxOf } from '@/components/charts/chartDefaults'
import { withX } from '@/components/charts/timeAxis'
import { useSeriesHover } from '@/components/charts/useTimeFocus'
import ChartTooltip from '@/components/charts/ChartTooltip'
import { TimeChart, rowInstant } from '@/components/charts/TimeChart'
import CardMenu from '@/components/CardMenu'

// The service page's Runtime tab chart, moved here out of ServiceOverview
// (RuntimeChart, RuntimeTooltip, runtimeRows) unchanged when the
// Infrastructure pages drew the same charts, so a host's CPU on Infra and a
// JVM's CPU on Runtime are one card rather than two that drift apart.

/**
 * Merge the series one chart draws into a row per bucket.
 *
 * Every series in the card is sampled from the same window, so they share an
 * index — there is no need to join on time.
 */
function cardRows(series, win) {
  const base = series[0]?.rows ?? []
  return withX(base.map((d, i) => {
    const row = { t: d.t, label: d.label, exactTime: d.exactTime }
    for (const s of series) row[s.key] = s.rows[i]?.value
    return row
  }), win)
}

/**
 * Every series the chart drew, in the order its legend lists them.
 *
 * Read off the ROW rather than off `payload`, so a series that is null in this
 * particular bucket still holds its place. A tooltip whose rows appear and
 * disappear as the pointer travels cannot be scanned, and on a used-vs-limit
 * chart the missing row is usually the one being looked for.
 */
function CardTooltip({ active, payload, series, fmt, nowMs, hoverKey, suppressed }) {
  if (!active || !payload?.length) return null
  const row = payload[0]?.payload ?? {}
  const items = series.map(s => ({
    key: s.key,
    label: s.label,
    value: fmt(row[s.key]),
    color: s.color,
  }))
  return (
    <ChartTooltip
      tMs={rowInstant(payload[0])}
      nowMs={nowMs ?? Date.now()}
      items={items}
      hoverKey={hoverKey}
      suppressed={suppressed}
      minWidth={series.length > 1 ? 196 : 160}
    />
  )
}

/**
 * One chart in a card of its own: header, plot, tooltip, legend.
 *
 * A configuration of this rather than a block of chart markup per chart. The
 * Runtime tab's twelve charts and the Infrastructure pages' differ in what they
 * plot and in almost nothing else, and every one of them has to carry the same
 * tick ladder, the same drag-to-focus, the same tooltip and the same crosshair
 * as the rest of its page — which is exactly the kind of agreement that rots
 * when it is retyped per chart.
 *
 * @param {string} title     the header, and the name the card menu acts on
 * @param {Array}  series    [{ key, label, color, rows, dash }] in legend order
 * @param {Function} fmt     value → axis label
 * @param {Function} [tipFmt] value → tooltip value; defaults to `fmt`, and
 *                           differs where a unit is worth the width in a
 *                           tooltip but not on every tick
 * @param {boolean} [area]   filled bands, stacked, instead of lines
 * @param {'half'|'third'|'full'} [span] how much of the grid row the card takes
 *                           (the grid's `rt-*` track rules; Runtime has no full)
 * @param {string} [value]   a figure beside the title, already formatted — an
 *                           Infra card's reading for the window. Left out, the
 *                           header is the title alone, as on Runtime.
 * @param {boolean} [allowDecimals] false for a count, so an axis over 0–10 ticks
 *                           0, 2, 4… rather than at 2.5 steps a whole-number
 *                           formatter would print as 3 and 8
 */
export default function CardChart({ title, value, series, fmt, tipFmt, area = false, span = 'half', allowDecimals = true, syncId, win, onFocus }) {
  const [hoverKey, hoverProps] = useSeriesHover()
  const data = useMemo(() => cardRows(series, win), [series, win])
  const keys = useMemo(() => series.map(s => s.key), [series])
  const dimFor = key => (hoverKey == null || hoverKey === key ? 1 : 0.2)
  const Chart = area ? AreaChart : LineChart

  return (
    <div className={`runtime-chart-card rt-${span}`}>
      <div className="clbl">
        <span className="clbl-text">{title}{value != null && <span className="cval">{value}</span>}</span>
        <CardMenu kind="chart" title={title} />
      </div>
      <TimeChart className="chart-host" win={win} onFocus={onFocus}>
        {(axis, focus) => (
          <Chart data={data} margin={{ top: 6, right: 4, left: 0, bottom: 0 }} syncId={syncId} syncMethod="value" {...focus.chartProps}>
            <CartesianGrid {...GRID_PROPS} />
            <XAxis {...axis.props} />
            <YAxis {...valueAxisProps({ maxValue: maxOf(data, keys), format: fmt, allowDecimals })} />
            {/* Not decoration: Recharts delivers no move events to the wrapper
                without a Tooltip, so the drag-to-focus gesture depends on it. */}
            <Tooltip
              content={p => (
                <CardTooltip
                  {...p}
                  series={series}
                  fmt={tipFmt ?? fmt}
                  nowMs={win.end * 1000}
                  hoverKey={hoverKey}
                  suppressed={!focus.hovered}
                />
              )}
              {...NO_ANIM}
            />
            {series.map(s => (area ? (
              <Area key={s.key} {...AREA_PROPS} dataKey={s.key} stackId="rt"
                stroke={s.color} fill={s.color}
                fillOpacity={0.3 * dimFor(s.key)} strokeOpacity={dimFor(s.key)}
                strokeWidth={1.4} dot={false} activeDot={{ r: 3, strokeWidth: 0 }}
                {...hoverProps(s.key)} />
            ) : (
              <Line key={s.key} {...LINE_PROPS} dataKey={s.key} connectNulls={false}
                stroke={s.color} strokeOpacity={dimFor(s.key)}
                strokeWidth={s.dash ? 1.2 : 1.5} strokeDasharray={s.dash}
                dot={false} activeDot={{ r: 3, strokeWidth: 0 }}
                {...hoverProps(s.key)} />
            )))}
            {focus.overlay}
          </Chart>
        )}
      </TimeChart>
      {series.length > 1 && (
        <div className="runtime-legend">
          {series.map(s => (
            <div key={s.key} className="runtime-legend-item" {...hoverProps(s.key)}>
              <span className="runtime-legend-swatch" style={{ background: s.color }} />
              {s.label}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
