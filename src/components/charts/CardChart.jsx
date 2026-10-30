import { useMemo, useState } from 'react'
import { AreaChart, Area, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts'
import { GRID_PROPS, NO_ANIM, AREA_PROPS, LINE_PROPS, valueAxisProps, maxOf, niceAxis, formatDecimals } from '@/components/charts/chartDefaults'
import { withX } from '@/components/charts/timeAxis'
import { useSeriesHover } from '@/components/charts/useTimeFocus'
import ChartTooltip from '@/components/charts/ChartTooltip'
import { TimeChart, rowInstant } from '@/components/charts/TimeChart'
import ChartActions from '@/components/charts/ChartActions'
import { useSeriesBudget } from '@/components/charts/useSeriesBudget'
import SeriesBudgetFooter from '@/components/charts/SeriesBudgetFooter'
import { fixesAxis } from '@/components/charts/seriesBudget'

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
function CardTooltip({ active, payload, series, fmt, nowMs, hoverKey, suppressed, limit }) {
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
      limit={limit}
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
 * @param {boolean} [legend] false to leave out the legend under the plot, for a
 *                           card whose series are a list of things the tooltip
 *                           names (a namespace's pods) rather than a reading
 *                           and its limits. Left out, the legend shows as on
 *                           Runtime.
 * @param {number} [tooltipLimit] most series the tooltip lists, in `series`
 *                           order, before it counts the rest (it always keeps
 *                           the one under the pointer): a fleet of 64 hosts.
 *                           Left out, it lists every series, as on Runtime.
 * @param {string} [budgetNoun] puts the card under a series budget, as a legend
 *                           chart is: it draws the first series its width can
 *                           make legible and says under the plot how many it
 *                           holds back ("Showing 8 of 64 hosts · Show 20 more ·
 *                           Show all"), in these words. `series` must then come
 *                           in the order to draw them. Left out, every series
 *                           is drawn, as on Runtime.
 * @param {Function} [forWindow] w → { series, value } — the card over another
 *                           window, by the same derivation that gave `series`
 *                           and `value` for `win`. It is what the card's
 *                           Compare draws ("1 day ago", ChartModal); `value`
 *                           may be left out of what it returns. Left out, the
 *                           card can be expanded but offers no Compare.
 */
export default function CardChart({ title, value, series, fmt, tipFmt, area = false, span = 'half', allowDecimals = true, legend = true, tooltipLimit, budgetNoun, syncId, win, onFocus, forWindow }) {
  const plot = { fmt, tipFmt, area, allowDecimals, legend, tooltipLimit, budgetNoun, syncId, onFocus }
  // The card over any window: its own props for the page's window, the
  // caller's derivation for any other. Each window's figures are worked out
  // once, however often the modal asks for them.
  const view = useMemo(() => {
    const other = new WeakMap()
    const at = w => {
      if (w === win) return { series, value }
      if (!other.has(w)) other.set(w, forWindow(w) ?? {})
      return other.get(w)
    }
    return {
      win,
      comparable: typeof forWindow === 'function',
      value: w => at(w).value,
      render: w => <CardChartBody {...plot} series={at(w).series ?? []} win={w} />,
    }
    // `plot` is rebuilt every render from the props listed here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [win, series, value, forWindow, fmt, tipFmt, area, allowDecimals, legend, tooltipLimit, budgetNoun, syncId, onFocus])

  return (
    <div className={`runtime-chart-card rt-${span}`}>
      <div className="clbl">
        <span className="clbl-text">{title}{value != null && <span className="cval">{value}</span>}</span>
        <ChartActions title={title} view={view} />
      </div>
      <CardChartBody {...plot} series={series} win={win} />
    </div>
  )
}

/**
 * Everything under the card's header: the plot, its legend and its series
 * budget. The card draws it once over the page's window, and its Expand and
 * Compare draw it again in the modal, over whichever window they show.
 */
function CardChartBody({ series, fmt, tipFmt, area, allowDecimals, legend, tooltipLimit, budgetNoun, syncId, win, onFocus }) {
  const [hoverKey, hoverProps] = useSeriesHover()
  // The budget runs on the plot's own width, which only the chart can measure.
  // A card with no budgetNoun never reports one, and draws every series.
  const [plotWidth, setPlotWidth] = useState(0)
  const budget = useSeriesBudget(series.length, plotWidth)
  const drawn = useMemo(
    () => (budgetNoun ? series.slice(0, budget.count) : series),
    [series, budgetNoun, budget.count],
  )
  // Rows carry every series, drawn or not, so the axis can span the held-back
  // ones too: while the budget holds any back, the axis is fixed over all of
  // them, so "Show 20 more" adds lines without rescaling the ones already drawn.
  const data = useMemo(() => cardRows(series, win), [series, win])
  const keys = useMemo(() => drawn.map(s => s.key), [drawn])
  const fixed = useMemo(
    () => (budgetNoun && fixesAxis(budget.status)
      ? niceAxis(maxOf(data, series.map(s => s.key)), 4, { decimals: formatDecimals(fmt) })
      : null),
    [budgetNoun, budget.status, data, series, fmt],
  )
  const dimFor = key => (hoverKey == null || hoverKey === key ? 1 : 0.2)
  const Chart = area ? AreaChart : LineChart

  return (
    <>
      <TimeChart className="chart-host" win={win} onFocus={onFocus} onWidth={budgetNoun ? setPlotWidth : undefined}>
        {(axis, focus) => (
          <Chart data={data} margin={{ top: 6, right: 4, left: 0, bottom: 0 }} syncId={syncId} syncMethod="value" {...focus.chartProps}>
            <CartesianGrid {...GRID_PROPS} />
            <XAxis {...axis.props} />
            <YAxis {...valueAxisProps({ maxValue: fixed?.top ?? maxOf(data, keys), format: fmt, allowDecimals, domain: fixed ? [0, fixed.top] : undefined })} ticks={fixed?.ticks} />
            {/* Not decoration: Recharts delivers no move events to the wrapper
                without a Tooltip, so the drag-to-focus gesture depends on it. */}
            <Tooltip
              content={p => (
                <CardTooltip
                  {...p}
                  series={drawn}
                  fmt={tipFmt ?? fmt}
                  nowMs={win.end * 1000}
                  hoverKey={hoverKey}
                  suppressed={!focus.hovered}
                  limit={tooltipLimit}
                />
              )}
              {...NO_ANIM}
            />
            {drawn.map(s => (area ? (
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
      {legend && drawn.length > 1 && (
        <div className="runtime-legend">
          {drawn.map(s => (
            <div key={s.key} className="runtime-legend-item" {...hoverProps(s.key)}>
              <span className="runtime-legend-swatch" style={{ background: s.color }} />
              {s.label}
            </div>
          ))}
        </div>
      )}
      {budgetNoun && <SeriesBudgetFooter budget={budget} noun={budgetNoun} />}
    </>
  )
}
