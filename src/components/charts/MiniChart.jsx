import { useMemo } from 'react'
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts'
import { GRID_PROPS, NO_ANIM, AREA_PROPS, valueAxisProps, maxOf, niceAxis } from '@/components/charts/chartDefaults'
import { withX } from '@/components/charts/timeAxis'
import { TimeChart, SvcTooltip } from '@/components/charts/TimeChart'

/**
 * One series as a filled area on the page's window: the small chart in a card.
 * Moved out of ServiceOverview (the External and DB tabs' charts) unchanged, so
 * the Browser page's summary cards draw the same chart rather than a copy.
 *
 * Everything below is optional and, left out, draws exactly what it always has:
 *
 *   - `overlays`: Recharts elements drawn behind the area — thresholdBands'
 *     zones. Elements, never a component: the chart drops children it does not
 *     recognise (see thresholdBands.jsx). They sit after the grid and before
 *     the area, because children order is z-order.
 *   - `yTop`: the least the y axis may top out at, for a chart whose overlays
 *     must stay in view above the data — bandAxisTop(dataMax, poor). The axis
 *     then fixes its own round ticks over [0, max(data, yTop)] instead of
 *     fitting itself to the data, which would scale the thresholds off the top.
 *   - `className` and `height`: `height={null}` draws no inline height, so a
 *     class sizes the chart instead — a card's `.chart-host` the way TrendChart
 *     sizes its own.
 *   - `axisFormat(v, top)`: the y axis's tick formatter, fmtCompact when left
 *     out. A card whose figure is a time in milliseconds would otherwise label
 *     its axis "1.4k" under a headline that reads "1.27 s". It is handed the
 *     axis's top too, so a load-time axis keeps one unit from 0 up
 *     (fmtLoadTimeTick).
 */
export default function MiniChart({ series, color, unit = '', formatVal, height = 182, syncId, win, onFocus, overlays, yTop, className, axisFormat }) {
  const data = useMemo(() => withX(series, win), [series, win])
  // Ticks come from the axis's own formatter (fmtCompact, as without a yTop,
  // or the card's axisFormat), and both print every round step niceAxis can
  // pick, so no precision limit is passed.
  const y = useMemo(() => (yTop == null ? null : niceAxis(Math.max(maxOf(data, 'value') ?? 0, yTop))), [data, yTop])
  const top = y?.top ?? maxOf(data, 'value')
  const tickFmt = useMemo(() => (axisFormat ? v => axisFormat(v, top ?? v) : undefined), [axisFormat, top])
  return (
    <TimeChart win={win} onFocus={onFocus} height={height} className={className}>
      {(axis, focus) => (
        <AreaChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }} syncId={syncId} syncMethod="value" {...focus.chartProps}>
          <CartesianGrid {...GRID_PROPS} />
          {overlays}
          <XAxis {...axis.props} />
          <YAxis {...valueAxisProps({ format: tickFmt, maxValue: top, domain: y ? [0, y.top] : undefined })} ticks={y?.ticks} />
          <Tooltip content={p => <SvcTooltip {...p} color={color} unit={unit} formatVal={formatVal} nowMs={win.end * 1000} suppressed={!focus.hovered} />} {...NO_ANIM} />
          <Area {...AREA_PROPS} dataKey="value" stroke={color} strokeWidth={1.6} fill={color} dot={false} activeDot={{ r: 3 }} />
          {focus.overlay}
        </AreaChart>
      )}
    </TimeChart>
  )
}
