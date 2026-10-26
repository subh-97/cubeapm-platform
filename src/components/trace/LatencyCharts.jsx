import { useCallback, useMemo, useState } from 'react'
import ChartTooltip from '@/components/charts/ChartTooltip'
import { useMeasuredWidth } from '@/components/charts/useTimeFocus'
import { buildTimeAxis, formatTick } from '@/components/charts/timeAxis'
import { useBucketBrush, brushRect, inRect } from '@/components/charts/bucketBrush'
import { niceAxis, formatDecimals, fmtPctTick, fmtPct1 } from '@/components/charts/chartDefaults'
import { edgeTicks, fmtEdge, bucketRangeLabel } from '@/utils/latencyBuckets'

// The Slow Requests panel's two charts of one endpoint's requests: a histogram
// of their latency, and a heatmap of latency against time. Both are plain SVG
// laid out in percent, the AlertTimeline way, so they need no measuring to lay
// out (the width only decides how many axis labels fit), render the same on the
// server, and share one pointer model, one brush, one keyboard cursor and one
// tooltip — where a Recharts bar chart and a hand-drawn grid would have each
// done the hover, the drag and the readout their own way.
//
// What both draw on, and the rules they keep:
//   - The buckets are latencyBuckets.js's (VictoriaMetrics' vmrange edges),
//     the columns the window's own buckets.
//   - Series colour is the brand blue: a share of requests is a magnitude, not
//     a severity, so no status hue appears (rule 2) — production paints its
//     hovered bar red, which here would read as "this latency is critical".
//     A hovered bar keeps its fill, marked only by the column band behind it
//     and the tooltip; a hovered cell, too small for a band, is outlined.
//   - A selection is drawn the way production draws it: by fading what is
//     outside it, never by a band over what is inside. While dragging, the
//     platform's brush band (brand at .14) shows what will be selected.
//   - The tooltip is the platform's (ChartTooltip): a latency range heads a
//     bar's; a cell's is headed by its column's instant, as every time chart's.

const PLOT_H = 220
// How strongly a faded bar or cell still shows: enough that the data outside a
// selection stays legible in both themes rather than vanishing.
const FADE = 0.3

/** A percent, as SVG and CSS want it. */
const pct = v => `${v}%`

/**
 * The pointer, the brush and the keyboard cursor over a grid of `nx` columns
 * (and `ny` rows, for the heatmap). `cellAt(event)` is the chart's: which cell
 * is under the pointer, or null outside the cells.
 *
 * The keyboard cursor appears on the first key press, not on focus — a mouse
 * press does not focus the plot (the press is a drag's start, and focus would
 * leave a stray cursor behind) — and goes on blur. Arrows move it (up is
 * slower), Home and End jump to the ends, Shift with an arrow selects from where
 * it started, Enter (or Space) filters the list to the selection or to the cell
 * under the cursor — the first press, before there is a cursor, only shows it,
 * so a stray Enter never collapses a selection to one bucket — and Escape
 * abandons the drag or the selection being made, or else clears the one in
 * place. Every move is described for a screen reader through `announce`.
 *
 * The cursor, the hover and a keyboard selection's anchor are kept against
 * `origin` — the chart's own coordinates, a latency bucket rather than a place
 * on the axis — so when the axis re-trims (a selection made or cleared, one
 * carried into another window) they stay on the bucket they were on, and a
 * bucket the axis no longer holds drops the hover and pulls the cursor to the
 * nearest end.
 */
function useCellCursor({ nx, ny, origin, cellAt, onCommit, onEscape, announce, describe, start }) {
  const brush = useBucketBrush({ onCommit })
  const ox = origin?.x ?? 0
  const oy = origin?.y ?? 0
  const toAbs = c => c && (ny ? { x: c.x + ox, y: c.y + oy } : { x: c.x + ox })
  const inside = c => c.x >= 0 && c.x < nx && (!ny || (c.y >= 0 && c.y < ny))
  const toCell = (a, clamp) => {
    if (!a || nx <= 0) return null
    const c = ny ? { x: a.x - ox, y: a.y - oy } : { x: a.x - ox }
    if (inside(c)) return c
    if (!clamp) return null
    const x = Math.max(0, Math.min(nx - 1, c.x))
    return ny ? { x, y: Math.max(0, Math.min(ny - 1, c.y)) } : { x }
  }
  const [hoverAt, setHoverAt] = useState(null)
  const [kbdAt, setKbdAt] = useState(null)
  const [anchorAt, setAnchorAt] = useState(null)
  const hover = toCell(hoverAt, false)
  const kbd = toCell(kbdAt, true)
  const anchor = toCell(anchorAt, true)
  const setHover = c => setHoverAt(toAbs(c))
  const setKbd = c => setKbdAt(toAbs(c))
  const setAnchor = c => setAnchorAt(toAbs(c))
  const preview = brush.preview ?? (anchor && kbd ? brushRect(anchor, kbd) : null)

  const onMouseDown = e => {
    if (e.button !== 0) return
    // No text selected across the labels, and no focus taken by a drag's press.
    e.preventDefault()
    setKbd(null)
    setAnchor(null)
    brush.down(cellAt(e), e)
  }
  const onMouseMove = e => {
    const cell = cellAt(e)
    setHover(cell)
    brush.move(cell, e)
  }
  const onKeyDown = e => {
    const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Enter', ' ', 'Escape']
    if (!keys.includes(e.key) || nx <= 0) return
    if (e.key === 'Escape') {
      e.preventDefault()
      // A mouse drag in progress is what Escape abandons; the selection in
      // place stays. (React hears the key before the brush's document
      // listener, so the drag is still on here.)
      if (brush.dragging) brush.cancel()
      else if (anchor) { setAnchor(null); announce?.('Selection abandoned') } else onEscape?.()
      return
    }
    const cur = kbd ?? start()
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      if (!kbd) {
        setKbd(cur)
        announce?.(describe(cur))
        return
      }
      onCommit?.(anchor ? brushRect(anchor, cur) : brushRect(cur, cur))
      setAnchor(null)
      return
    }
    if (!ny && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) return
    e.preventDefault()
    let { x, y } = cur
    if (kbd) {
      if (e.key === 'ArrowLeft') x = Math.max(0, x - 1)
      if (e.key === 'ArrowRight') x = Math.min(nx - 1, x + 1)
      if (e.key === 'Home') x = 0
      if (e.key === 'End') x = nx - 1
      if (ny && e.key === 'ArrowUp') y = Math.min(ny - 1, y + 1)
      if (ny && e.key === 'ArrowDown') y = Math.max(0, y - 1)
    }
    const next = ny ? { x, y } : { x }
    if (e.shiftKey) { if (!anchor) setAnchor(cur) } else if (anchor) setAnchor(null)
    setKbd(next)
    announce?.(describe(next))
  }
  const onBlur = () => { setKbdAt(null); setAnchorAt(null) }

  return {
    cursor: kbd ?? (brush.dragging ? null : hover),
    keyboard: !!kbd,
    preview,
    dragging: brush.dragging,
    handlers: { onMouseDown, onMouseMove, onMouseLeave: () => setHoverAt(null), onKeyDown, onBlur },
  }
}

/** The tooltip, beside the point it reads, turned inward near the plot's right edge. */
function Tip({ leftPct, topPx, children }) {
  const flip = leftPct > 58
  return (
    <div
      className={`lat-tip${flip ? ' is-flipped' : ''}`}
      style={{ left: pct(leftPct), top: Math.max(8, Math.min(PLOT_H - 8, topPx)) }}
    >
      {children}
    </div>
  )
}

/** Labels on the plot's left edge at given heights (0 = bottom, 100 = top). */
function YAxis({ ticks, width }) {
  return (
    <div className="lat-y" style={{ width }} aria-hidden="true">
      {ticks.map(t => (
        <span key={t.key} className="lat-y-tick" style={{ bottom: pct(t.at) }}>{t.label}</span>
      ))}
    </div>
  )
}

/** Labels under the plot at given positions (0 = left edge, 100 = right). */
function XAxis({ ticks, gutter }) {
  return (
    <div className="lat-x-row" style={{ paddingLeft: gutter }} aria-hidden="true">
      <div className="lat-x">
        {ticks.map(t => (
          <span
            key={t.key}
            className={`lat-x-tick${t.at <= 1 ? ' is-first' : t.at >= 99 ? ' is-last' : ''}`}
            style={{ left: pct(t.at) }}
          >
            {t.label}
          </span>
        ))}
      </div>
    </div>
  )
}

// The gutter the widest y label needs: the platform's value axis sizes it the
// same way (chartDefaults valueAxisProps), from the labels it will print.
const gutterFor = labels => Math.min(64, Math.max(30, Math.max(...labels.map(l => String(l).length)) * 6.4 + 10))

/**
 * Requests by latency: one bar per bucket, as a share of the requests counted
 * (the window's, or the selected time's). Drag across bars to select a latency
 * range — whole buckets, low edge of the first to high edge of the last.
 *
 *   axis           [k0, k1], the buckets to draw
 *   counts         requests per bucket over the axis
 *   selected       [k0, k1] of the selection's latency half, or null
 *   onSelect([k0, k1])
 *   onClear        Escape with nothing being dragged
 *   announce(text) the panel's live region
 *   plotRef        the focusable plot, so Clear can put focus back on it
 */
export function LatencyHistogram({ axis, counts, selected, onSelect, onClear, announce, plotRef, label }) {
  const [k0, k1] = axis
  const n = k1 - k0 + 1
  const total = counts.reduce((a, b) => a + b, 0)
  const [measureRef, width] = useMeasuredWidth()

  const y = useMemo(() => {
    const top = Math.max(...counts) / Math.max(1, total) * 100
    return niceAxis(top, 4, { decimals: formatDecimals(fmtPctTick) })
  }, [counts, total])
  const yTicks = y.ticks.map(v => ({ key: v, at: (v / y.top) * 100, label: fmtPctTick(v) }))
  const gutter = gutterFor(yTicks.map(t => t.label))
  const xTicks = edgeTicks(k0, k1, Math.max(2, (width - gutter) / 56)).map(k => ({ key: k, at: ((k - k0) / n) * 100, label: fmtEdge(k) }))

  const describe = useCallback(({ x }) => {
    const c = counts[x] ?? 0
    return `${bucketRangeLabel(k0 + x)}: ${fmtPct1(total ? (c / total) * 100 : 0)} of requests, ${c.toLocaleString()}`
  }, [counts, total, k0])

  const cellAt = e => {
    const r = e.currentTarget.getBoundingClientRect()
    const fx = (e.clientX - r.left) / r.width
    const fy = (e.clientY - r.top) / r.height
    if (!(fx >= 0 && fx < 1 && fy >= 0 && fy <= 1)) return null
    return { x: Math.min(n - 1, Math.floor(fx * n)) }
  }
  const sel = selected ? { x0: selected[0] - k0, x1: selected[1] - k0 } : null
  const ui = useCellCursor({
    nx: n,
    origin: { x: k0 },
    cellAt,
    describe,
    announce,
    onCommit: rect => onSelect?.([k0 + rect.x0, k0 + rect.x1]),
    onEscape: onClear,
    start: () => ({ x: sel ? sel.x0 : counts.indexOf(Math.max(...counts)) }),
  })
  // What is lit: the drag being made, or else the selection in place.
  const lit = ui.preview ?? sel

  const slot = 100 / n
  const cur = ui.cursor
  return (
    <div className="lat-chart" ref={measureRef}>
      <div className="lat-row">
        <YAxis ticks={yTicks} width={gutter} />
        <div
          ref={plotRef}
          className={`lat-plot${ui.dragging ? ' is-dragging' : ''}`}
          style={{ height: PLOT_H }}
          tabIndex={0}
          role="application"
          aria-roledescription="chart"
          aria-label={label}
          {...ui.handlers}
        >
          <svg className="lat-svg" width="100%" height={PLOT_H} aria-hidden="true">
            {yTicks.map(t => (
              <line key={t.key} className="lat-grid" x1="0" x2="100%" y1={pct(100 - t.at)} y2={pct(100 - t.at)} />
            ))}
            {cur && <rect className="lat-cursor" x={pct(cur.x * slot)} y="0" width={pct(slot)} height="100%" />}
            {counts.map((c, i) => {
              const h = total ? (c / total) * 100 / y.top * 100 : 0
              if (!(h > 0)) return null
              const faded = lit && !inRect(lit, i)
              return (
                <rect
                  key={k0 + i}
                  className="lat-bar"
                  data-k={k0 + i}
                  x={pct(i * slot + slot * 0.08)}
                  y={pct(100 - h)}
                  width={pct(slot * 0.84)}
                  height={pct(h)}
                  fillOpacity={faded ? FADE : 1}
                />
              )
            })}
            {ui.preview && (
              <rect className="lat-brush" x={pct(ui.preview.x0 * slot)} y="0" width={pct((ui.preview.x1 - ui.preview.x0 + 1) * slot)} height="100%" />
            )}
          </svg>
          {cur && (
            <Tip leftPct={(cur.x + 0.5) * slot} topPx={PLOT_H * (1 - (total ? counts[cur.x] / total * 100 / y.top : 0))}>
              <ChartTooltip
                heading={bucketRangeLabel(k0 + cur.x)}
                minWidth={150}
                items={[
                  { key: 'share', label: 'Requests', value: fmtPct1(total ? (counts[cur.x] / total) * 100 : 0), color: 'var(--brand)' },
                  { key: 'count', label: 'Count', value: (counts[cur.x] ?? 0).toLocaleString(), color: 'transparent' },
                ]}
              />
            </Tip>
          )}
        </div>
      </div>
      <XAxis ticks={xTicks} gutter={gutter} />
    </div>
  )
}

// A cell's strength, in six steps of the brand colour by the square root of its
// count against the densest cell's, so a column of a few requests still shows
// beside the incident's thousands. Six steps rather than a continuous ramp: a
// reader compares cells by eye, and six levels are what the eye tells apart.
const STEPS = [0.16, 0.28, 0.42, 0.58, 0.76, 0.95]
const stepOf = f => STEPS[Math.min(STEPS.length - 1, Math.floor(Math.sqrt(f) * STEPS.length))]

/**
 * Requests by latency and time: a column per bucket of the window, a row per
 * latency bucket (slower up), each cell as strong as the requests in it. Drag a
 * rectangle to select a latency range and a time span together; a latency-only
 * selection (made on the histogram) fades the rows outside it across the whole
 * window.
 *
 *   grid           data/requestLatency latencyGrid
 *   axis           [k0, k1]
 *   win            the window (its buckets are the columns)
 *   selected       { lat: [k0, k1] | null, cols: [c0, c1] | null }
 *   onSelect({ lat: [k0, k1], cols: [c0, c1] })
 *   onClear, announce, plotRef, label   as the histogram's
 */
export function LatencyHeatmap({ grid, axis, win, selected, onSelect, onClear, announce, plotRef, label }) {
  const [k0, k1] = axis
  const ny = k1 - k0 + 1
  // Only the columns that have happened: "Today" runs to midnight.
  const cols = win.buckets.filter(b => !b.future)
  const nx = cols.length
  const span = win.end - win.start
  const xOf = t => ((t - win.start) / span) * 100
  const wOf = b => ((b.durMin * 60) / span) * 100
  const [measureRef, width] = useMeasuredWidth()

  const countAt = (c, k) => {
    const i = k - grid.k0
    return i >= 0 && i < (grid.counts[c]?.length ?? 0) ? grid.counts[c][i] : 0
  }
  const maxCount = useMemo(() => {
    let m = 0
    for (const row of grid.counts) for (const v of row) if (v > m) m = v
    return m
  }, [grid])

  const yTicks = edgeTicks(k0, k1, Math.max(2, PLOT_H / 22)).map(k => ({ key: k, at: ((k - k0) / ny) * 100, label: fmtEdge(k) }))
  const gutter = gutterFor(yTicks.map(t => t.label))
  const timeAxis = useMemo(() => buildTimeAxis(win, { width: Math.max(0, width - gutter), kind: 'time' }), [win, width, gutter])
  const xTicks = timeAxis.ticks.map(ms => ({ key: ms, at: xOf(ms / 1000), label: formatTick(ms, timeAxis.labelKind) }))

  const describe = useCallback(({ x, y }) => {
    const c = countAt(x, k0 + y)
    const colTotal = grid.colTotals[x] ?? 0
    return `${formatTick(cols[x].ms, timeAxis.labelKind)}, ${bucketRangeLabel(k0 + y)}: ${fmtPct1(colTotal ? (c / colTotal) * 100 : 0)} of that column's requests, ${c.toLocaleString()}`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grid, k0, cols, timeAxis])

  const cellAt = e => {
    const r = e.currentTarget.getBoundingClientRect()
    const fx = (e.clientX - r.left) / r.width
    const fy = (e.clientY - r.top) / r.height
    if (!(fx >= 0 && fx < 1 && fy >= 0 && fy <= 1)) return null
    const t = win.start + fx * span
    const x = cols.findIndex((b, i) => t >= b.t && (i === cols.length - 1 || t < cols[i + 1].t))
    if (x < 0) return null
    return { x, y: Math.min(ny - 1, Math.floor((1 - fy) * ny)) }
  }

  const sel = selected && (selected.lat || selected.cols)
    ? {
      x0: selected.cols ? selected.cols[0] : 0,
      x1: selected.cols ? Math.min(nx - 1, selected.cols[1]) : nx - 1,
      y0: selected.lat ? selected.lat[0] - k0 : 0,
      y1: selected.lat ? selected.lat[1] - k0 : ny - 1,
    }
    : null
  const ui = useCellCursor({
    nx,
    ny,
    origin: { y: k0 },
    cellAt,
    describe,
    announce,
    onCommit: rect => onSelect?.({ lat: [k0 + rect.y0, k0 + rect.y1], cols: [rect.x0, rect.x1] }),
    onEscape: onClear,
    start: () => (sel ? { x: sel.x1, y: sel.y1 } : { x: nx - 1, y: Math.floor(ny / 2) }),
  })
  const lit = ui.preview ?? sel
  const rowH = 100 / ny
  const cur = ui.cursor
  const curCol = cur ? cols[cur.x] : null

  return (
    <div className="lat-chart" ref={measureRef}>
      <div className="lat-row">
        <YAxis ticks={yTicks} width={gutter} />
        <div
          ref={plotRef}
          className={`lat-plot is-heatmap${ui.dragging ? ' is-dragging' : ''}`}
          style={{ height: PLOT_H }}
          tabIndex={0}
          role="application"
          aria-roledescription="chart"
          aria-label={label}
          {...ui.handlers}
        >
          <svg className="lat-svg" width="100%" height={PLOT_H} aria-hidden="true">
            {cols.map((b, c) => {
              const x = xOf(b.t)
              const w = wOf(b)
              return Array.from({ length: ny }, (_, r) => {
                const v = countAt(c, k0 + r)
                if (!v) return null
                const faded = lit && !inRect(lit, c, r)
                const base = stepOf(v / maxCount)
                return (
                  <rect
                    key={`${c}-${r}`}
                    className="lat-cell"
                    x={pct(x)}
                    y={pct(100 - (r + 1) * rowH)}
                    width={pct(w)}
                    height={pct(rowH)}
                    fillOpacity={faded ? Math.max(0.06, base * FADE) : base}
                  />
                )
              })
            })}
            {curCol && (
              <>
                <line className="lat-cross" x1={pct(xOf(curCol.t) + wOf(curCol) / 2)} x2={pct(xOf(curCol.t) + wOf(curCol) / 2)} y1="0" y2="100%" />
                <line className="lat-cross" x1="0" x2="100%" y1={pct(100 - (cur.y + 0.5) * rowH)} y2={pct(100 - (cur.y + 0.5) * rowH)} />
                <rect className="lat-outline" x={pct(xOf(curCol.t))} y={pct(100 - (cur.y + 1) * rowH)} width={pct(wOf(curCol))} height={pct(rowH)} />
              </>
            )}
            {ui.preview && (
              <rect
                className="lat-brush"
                x={pct(xOf(cols[ui.preview.x0].t))}
                y={pct(100 - (ui.preview.y1 + 1) * rowH)}
                width={pct(xOf(cols[ui.preview.x1].t) + wOf(cols[ui.preview.x1]) - xOf(cols[ui.preview.x0].t))}
                height={pct((ui.preview.y1 - ui.preview.y0 + 1) * rowH)}
              />
            )}
          </svg>
          {curCol && (
            <Tip leftPct={xOf(curCol.t) + wOf(curCol) / 2} topPx={PLOT_H * (1 - (cur.y + 0.5) / ny)}>
              <ChartTooltip
                tMs={curCol.ms}
                nowMs={win.end * 1000}
                minWidth={190}
                items={[
                  {
                    key: 'share',
                    label: bucketRangeLabel(k0 + cur.y),
                    value: fmtPct1(grid.colTotals[cur.x] ? (countAt(cur.x, k0 + cur.y) / grid.colTotals[cur.x]) * 100 : 0),
                    color: 'var(--brand)',
                  },
                  { key: 'count', label: 'Requests', value: countAt(cur.x, k0 + cur.y).toLocaleString(), color: 'transparent' },
                ]}
              />
            </Tip>
          )}
        </div>
      </div>
      <XAxis ticks={xTicks} gutter={gutter} />
    </div>
  )
}
