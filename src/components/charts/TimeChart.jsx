import { useMemo, useEffect } from 'react'
import { ResponsiveContainer } from 'recharts'
import { buildTimeAxis } from '@/components/charts/timeAxis'
import { useTimeFocus, useMeasuredWidth } from '@/components/charts/useTimeFocus'
import ChartTooltip from '@/components/charts/ChartTooltip'

// The frame, the single-series tooltip and the instant helper the service
// page's window-derived charts are drawn with. They moved here out of
// ServiceOverview when the Errors page needed the same charts: a second copy
// would be a second drag gesture and a second tick ladder, free to drift from
// the first while the two pages are meant to behave as one product.

// The instant a hovered row was read at, in ms.
//
// It comes off the hovered ROW rather than off Recharts' `label`, because on a
// time axis `label` is the raw x in milliseconds and on a category axis it is a
// bucket string — neither is something a tooltip can date itself from. `t` is
// the bucket's own opening instant; `x` is only a fallback, and it carries the
// half-step the band scale needs, so it is used only when `t` is missing.
//
// Exported because every multi-series tooltip on the service page dates itself
// the same way. A helper exported from a component module only costs Fast
// Refresh — an edit here reloads the page instead of hot-swapping — and a
// three-line helper in a module of its own would cost more than that saves.
// eslint-disable-next-line react-refresh/only-export-components
export const rowInstant = p => {
  const row = p?.payload
  if (row?.t != null) return row.t * 1000
  return row?.x ?? null
}

// `suppressed` runs through every tooltip drawn on a syncId, and it is always
// the same thing: the charts share a syncId, so hovering one makes ALL of them
// active, and without this each one opens its own panel — six overlays
// answering one question. Only the chart the pointer is actually in reads
// `focus.hovered` as true, so only that one renders a panel. Recharts draws the
// tooltip CURSOR independently of this content, so the crosshair still lands on
// every synced chart, which is the part that carries the link.
//
// It defaults to undefined so an unsynced chart (the service page's floating
// HoverChartPopover) passes nothing and keeps its tooltip unconditionally.
export function SvcTooltip({ active, payload, color, unit, formatVal, nowMs, suppressed }) {
  if (!active || !payload?.length) return null
  const raw = payload[0]?.value
  const val = formatVal ? formatVal(raw) : (raw != null ? String(Math.round(raw * 100) / 100) : '')
  return (
    <ChartTooltip
      tMs={rowInstant(payload[0])}
      nowMs={nowMs ?? Date.now()}
      items={[{ key: 'value', label: '', value: `${val}${unit}`, color }]}
      suppressed={suppressed}
      minWidth={150}
    />
  )
}

/**
 * The frame every window-derived chart draws in: it measures itself, builds
 * the tick ladder for the width it actually has, and owns the drag that turns
 * a span of the chart into the page's time range.
 *
 * The chart arrives as a function of `(axis, focus)` rather than as a child
 * element because both of those are only knowable here — the ladder needs the
 * measured width, and the drag needs the window.
 *
 * One frame per chart, mounted and unmounted with it. A frame shared between
 * two charts that swap places (the service page's drilldown stack and p90
 * line) would go on measuring whichever one left, and the ladder would be
 * sized for a chart that is no longer on screen.
 */
export function TimeChart({ win, onFocus, height, className, onWidth, children }) {
  const [wrapRef, width] = useMeasuredWidth()
  // A series budget sizes its cap from the plot it draws into, and only the
  // frame has measured that. Charts that share one budget all report the same
  // width, so the owner settles on one value.
  useEffect(() => { if (width > 0) onWidth?.(width) }, [width, onWidth])
  const axis = useMemo(() => buildTimeAxis(win, { width }), [win, width])
  const focus = useTimeFocus(win, { onFocus })
  return (
    <div ref={wrapRef} className={className} style={{ width: '100%', ...(height == null ? null : { height }) }}>
      <ResponsiveContainer width="100%" height="100%">
        {children(axis, focus)}
      </ResponsiveContainer>
    </div>
  )
}
