import { useMemo } from 'react'
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts'
import { GRID_PROPS, NO_ANIM, AREA_PROPS, valueAxisProps, maxOf, fmtCompact } from '@/components/charts/chartDefaults'
import { withX } from '@/components/charts/timeAxis'
import { TimeChart, SvcTooltip } from '@/components/charts/TimeChart'

// The colour an error-count series is drawn in.
//
// Red in a chart normally breaks the platform rule that a series colour says
// WHICH thing a line is, never how bad it is. A single error-count series is
// the exception, for the same reason the log-level bands on the Logs page are:
// the series IS a severity class — every point on it is a count of failures —
// so painting it red tells the reader nothing false. That holds only while the
// chart has one series. The moment a chart shows several error series side by
// side (per endpoint, per exception, per service), the colour has to say which
// one is which, and those take the identity palette like any other chart.
//
// A token rather than a hex so it re-themes with every other status colour.
export const ERROR_SERIES_COLOR = 'var(--critical)'

// The errors-over-time chart beside each error group: a full mini time chart
// with axes, not a bare sparkline, so a spike can be dated and dragged into the
// page's range from the row it belongs to.
export default function ErrorSpark({ series, win, onFocus, syncId, height = 132, color = ERROR_SERIES_COLOR }) {
  const data = useMemo(() => withX(series, win), [series, win])
  return (
    <TimeChart win={win} onFocus={onFocus} height={height}>
      {(axis, focus) => (
        <AreaChart data={data} margin={{ top: 6, right: 4, left: 0, bottom: 0 }} syncId={syncId} syncMethod="value" {...focus.chartProps}>
          <CartesianGrid {...GRID_PROPS} />
          <XAxis {...axis.props} />
          {/* Error counts are whole numbers; a quiet group peaking at 3 would
              otherwise read 0.75 / 1.5 / 2.25 down the axis. */}
          <YAxis {...valueAxisProps({ maxValue: maxOf(data, 'value'), format: fmtCompact, allowDecimals: false })} />
          {/* One spark per error row, all on one syncId — so hovering one
              made every other row's spark open a panel too. Same rule as the
              full-size charts: the hovered spark reads, the rest just line up. */}
          <Tooltip content={p => <SvcTooltip {...p} color={color} unit="" formatVal={fmtCompact} nowMs={win.end * 1000} suppressed={!focus.hovered} />} {...NO_ANIM} />
          <Area {...AREA_PROPS} dataKey="value" stroke={color} strokeWidth={1.4} fill={color} dot={false} activeDot={{ r: 3 }} />
          {focus.overlay}
        </AreaChart>
      )}
    </TimeChart>
  )
}
