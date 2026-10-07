// The Explore line chart.
//
// Thin on purpose: every rule about naming, colour, ordering, limiting,
// stacking and comparison is already decided in utils/explore/series.js and
// arrives here as a model. This file turns that model into Recharts elements
// and handles the two things only a rendered chart can know — where the
// pointer is, and where a drag started and ended.
//
// It draws the way every chart on this platform draws (components/charts/
// chartDefaults.js): straight segments, flat fills, no animation, shared axis
// and grid formatting. The reasons are in that file and are not re-litigated
// here.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { clsx } from 'clsx'
import {
  Area, AreaChart, CartesianGrid, Line, LineChart, ReferenceArea,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import {
  AREA_PROPS, GRID_PROPS, LINE_PROPS, NO_ANIM, timeAxisProps, valueAxisProps, niceAxis,
} from '@/components/charts/chartDefaults'
import { buildChartRows, nearestAt, tooltipAt, xAxisFor, GHOST_KEY } from '@/utils/explore/series'
import { formatValue } from '@/utils/explore/format'
import './explore-results.css'

const MARGIN = { top: 8, right: 16, bottom: 0, left: 0 }
const X_AXIS_H = 24

// Which line is the pointer nearest? Recharts reports the pointer in container
// pixels and never hands back its y scale, so the mapping has to be inverted
// here. It hands the tooltip its plot rectangle as `viewBox`, which is where
// the two numbers below come from — and the inversion is exact rather than
// estimated because this chart always sets an explicit [0, top] y domain.
function valueAtPixel(chartY, viewBox, yTop) {
  const height = viewBox?.height
  if (!Number.isFinite(chartY) || !(height > 0)) return NaN
  return (yTop * (viewBox.y + height - chartY)) / height
}

/** The largest value the plot has to fit: per series, or per x once stacked. */
function plotMax(model, stack) {
  let max = 0
  if (stack) {
    const sums = new Map()
    for (const d of model.drawn) {
      for (const p of d.data) {
        const next = (sums.get(p.x) || 0) + (Number.isFinite(p.y) ? p.y : 0)
        sums.set(p.x, next)
        if (next > max) max = next
      }
    }
    return max
  }
  for (const d of model.drawn) for (const p of d.data) if (p.y > max) max = p.y
  return max
}

/**
 * @param {Object} props
 * @param {import('@/utils/explore/series').ChartModel} props.model  buildChartModel(...)
 * @param {{start:number,end:number,step:number}} props.resolved  the run's own window
 * @param {'number'|'time'} [props.unit]
 * @param {boolean} [props.stack]
 * @param {number} [props.height]
 * @param {(minMs:number, maxMs:number) => void} [props.onZoom]  drag-select zoom
 * @param {string|null} [props.hoverKey]  dataKey the legend is hovering, emphasised here
 * @param {'idle'|'loading'|'ready'|'empty'|'error'} [props.status]
 * @param {boolean} [props.stale]  the series on screen are not from the current inputs
 * @param {string} [props.emptyHint]
 */
export default function ExploreChart({
  model, resolved, unit = 'number', stack = false, height = 300,
  onZoom, hoverKey = null, status = 'ready', stale = false, emptyHint,
}) {
  const [hover, setHover] = useState(null)
  const [drag, setDrag] = useState(null)
  // Live values for the document-level mouseup, which must not re-subscribe on
  // every pointer move.
  const dragRef = useRef(null)
  const zoomRef = useRef(onZoom)
  const stepRef = useRef(0)

  const { xs, domain, ticks } = useMemo(() => xAxisFor(resolved), [resolved])
  const rows = useMemo(() => buildChartRows(model, xs, { stack }), [model, xs, stack])
  const { top: yTop, ticks: yTicks } = useMemo(() => niceAxis(plotMax(model, stack)), [model, stack])

  const stepMs = (resolved?.step || 60) * 1000
  zoomRef.current = onZoom
  stepRef.current = stepMs

  const tickLabel = useMemo(() => {
    const byValue = new Map(ticks.map(t => [t.value, t.label]))
    return (v) => byValue.get(v) ?? ''
  }, [ticks])
  const tickValues = useMemo(() => ticks.map(t => t.value), [ticks])
  const fmt = useCallback((v) => formatValue(v, unit), [unit])

  const dragging = drag != null

  // A drag that ends anywhere — including outside the plot, which is how a
  // selection running off the right edge ends — applies the zoom.
  useEffect(() => {
    if (!dragging) return undefined
    const onUp = () => {
      const d = dragRef.current
      dragRef.current = null
      setDrag(null)
      if (!d || d.from === d.to) return
      const lo = Math.min(d.from, d.to)
      // The later bucket contributes its whole step, or a one-bucket drag
      // would select an instant rather than a window.
      const hi = Math.max(d.from, d.to) + stepRef.current
      zoomRef.current?.(lo, hi)
    }
    document.addEventListener('mouseup', onUp)
    return () => document.removeEventListener('mouseup', onUp)
  }, [dragging])

  const handleDown = useCallback((st) => {
    const x = st?.activeLabel
    if (!Number.isFinite(x) || !zoomRef.current) return
    dragRef.current = { from: x, to: x }
    setDrag({ from: x, to: x })
  }, [])

  const handleMove = useCallback((st) => {
    const x = st?.activeLabel
    if (!Number.isFinite(x)) return
    if (dragRef.current) {
      const next = { from: dragRef.current.from, to: x }
      dragRef.current = next
      setDrag(cur => (cur && cur.to === x ? cur : next))
    }
    const chartY = st.chartY
    setHover(cur => (cur && cur.x === x && cur.chartY === chartY ? cur : { x, chartY }))
  }, [])

  const handleLeave = useCallback(() => setHover(null), [])

  // The tooltip lists every drawn series at the hovered timestamp, highest
  // first, with the one the pointer is nearest emphasised and the rest dimmed
  // — otherwise a 20-line chart answers "which of these am I pointing at?"
  // with twenty equally loud rows.
  const renderTooltip = useCallback((props) => {
    if (!props?.active) return null
    const x = props.label
    if (!Number.isFinite(x)) return null
    const nearestKey = hover ? nearestAt(model, x, valueAtPixel(hover.chartY, props.viewBox, yTop), { stack }) : null
    const tip = tooltipAt(model, x, { nearestKey })
    if (!tip.items.length) return null
    const hasNearest = tip.items.some(it => it.nearest)
    return (
      <div className="ex-tip">
        <div className="ex-tip-t">{tip.title}</div>
        {tip.items.map(it => (
          <div
            key={it.dataKey}
            className={clsx('ex-tip-row', { 'is-near': it.nearest, 'is-dim': hasNearest && !it.nearest })}
          >
            <span className="ex-tip-swatch" style={{ background: it.colour }} />
            <span className="ex-tip-name" title={it.label}>{it.label}</span>
            <span className="ex-tip-val">{formatValue(it.value, unit)}</span>
            {it.prev !== undefined && (
              <span className="ex-tip-prev">previous {formatValue(it.prev, unit)}</span>
            )}
          </div>
        ))}
        {tip.more > 0 && <div className="ex-tip-more">+{tip.more} more</div>}
      </div>
    )
  }, [model, hover, unit, stack, yTop])

  const busy = status === 'loading'
  const nothing = model.datasets.length === 0

  if (nothing && !busy) {
    return (
      <div className="ex-chart" style={{ height }}>
        <div className="ex-empty">
          <div className="ex-empty-title">
            {status === 'idle' ? 'Nothing to show yet' : 'The query returned no series'}
          </div>
          <div className="ex-empty-hint">
            {emptyHint ?? (status === 'idle'
              ? 'Build a query above and press Generate Graph.'
              : 'Nothing matched in this window. Widen the time range, drop a filter, or check the metric name.')}
          </div>
        </div>
      </div>
    )
  }

  const Chart = stack ? AreaChart : LineChart
  const emphasis = hoverKey

  return (
    <div
      className={clsx('ex-chart', { 'is-stale': stale })}
      style={{ height }}
      aria-busy={busy}
      role="img"
      aria-label={`Time series chart, ${model.drawn.length} of ${model.total} series. Drag across it to zoom; the time picker sets the same range.`}
    >
      <div className="ex-chart-plot">
        <ResponsiveContainer width="100%" height="100%">
          <Chart
            data={rows}
            margin={MARGIN}
            className={clsx('ex-chart-surface', { 'is-dragging': dragging })}
            onMouseDown={handleDown}
            onMouseMove={handleMove}
            onMouseLeave={handleLeave}
          >
            <CartesianGrid {...GRID_PROPS} />
            {/* The axis spans the whole aligned window, not just the part with
                data, so an empty tail reads as "nothing happened" rather than
                as a shorter query. */}
            <XAxis
              {...timeAxisProps(tickValues.length)}
              dataKey="x"
              type="number"
              domain={domain}
              ticks={tickValues}
              tickFormatter={tickLabel}
              allowDataOverflow
              height={X_AXIS_H}
            />
            {/* From zero always: a time series auto-scaled to its own minimum
                turns a 2% wobble into a cliff. */}
            <YAxis
              {...valueAxisProps({ format: fmt, domain: [0, yTop], maxValue: yTop })}
              ticks={yTicks}
            />
            <Tooltip
              {...NO_ANIM}
              content={renderTooltip}
              cursor={{ stroke: 'var(--border-strong)', strokeDasharray: '4 4' }}
              wrapperStyle={{ outline: 'none', zIndex: 20 }}
            />

            {model.drawOrder.map(d => (stack ? (
              <Area
                key={d.dataKey}
                {...AREA_PROPS}
                dataKey={d.dataKey}
                name={d.label}
                stackId="ex"
                stroke={d.colour}
                strokeWidth={emphasis === d.dataKey ? 2 : 1}
                strokeDasharray={d.dashed ? '5 3' : undefined}
                fill={d.fill}
                /* The palette fill already carries its own alpha (series.js),
                   so AREA_PROPS' 0.16 on top of it would leave a stack of
                   bands nobody can tell apart. */
                fillOpacity={emphasis && emphasis !== d.dataKey ? 0.35 : 1}
                dot={false}
                activeDot={false}
              />
            ) : (
              <Line
                key={d.dataKey}
                {...LINE_PROPS}
                dataKey={d.dataKey}
                name={d.label}
                stroke={d.colour}
                strokeWidth={emphasis === d.dataKey ? 2.4 : 1.6}
                strokeOpacity={emphasis && emphasis !== d.dataKey ? 0.22 : 1}
                strokeDasharray={d.dashed ? '5 3' : undefined}
                dot={false}
                activeDot={{ r: 2.5, strokeWidth: 0 }}
                connectNulls
              />
            )))}

            {/* The comparison window, drawn only while exactly one series is
                visible — more than one and the dashed twins stop being
                readable (ARCH D6). */}
            {model.ghost && (
              <Line
                {...LINE_PROPS}
                dataKey={GHOST_KEY}
                name={`${model.ghost.label} (previous)`}
                stroke={model.ghost.colour}
                strokeWidth={1.4}
                strokeDasharray="4 4"
                strokeOpacity={0.55}
                dot={false}
                activeDot={false}
                connectNulls
              />
            )}

            {drag && drag.from !== drag.to && (
              <ReferenceArea
                x1={Math.min(drag.from, drag.to)}
                x2={Math.max(drag.from, drag.to)}
                stroke="var(--brand)"
                strokeOpacity={0.6}
                fill="var(--brand)"
                fillOpacity={0.14}
              />
            )}
          </Chart>
        </ResponsiveContainer>
      </div>

      {busy && (
        <div className="ex-chart-busy">
          <span className="ex-chart-busy-dot" />
          <span className="sr-only">Running query</span>
        </div>
      )}
    </div>
  )
}
