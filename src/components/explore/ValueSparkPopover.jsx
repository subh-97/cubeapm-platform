// The sparkline behind a table value.
//
// A table cell says what a series was worth over the window and nothing about
// how it got there: 612ms steady and 612ms averaged out of a spike read the
// same. Hovering the value shows the shape, which is the cheapest possible
// answer to "is this number a trend or an accident?" — and it only appears for
// values that came from a range query, because a "latest" value has no shape
// to show (ARCH D9).
//
// Inline SVG rather than a chart library: one of these can open and close on
// every row the pointer crosses, and mounting a Recharts tree per hover is a
// lot of work for 200x42 pixels. Straight segments and a flat fill, as
// components/charts/chartDefaults.js requires of every chart here.

import { createPortal } from 'react-dom'
import { formatValue } from '@/utils/explore/format'
import './explore-results.css'

const W = 200
const H = 42
const PAD = 2
const POP_W = 216
const POP_H = 104
const GAP = 8

function geometry(points) {
  const ys = points.map(p => p.y).filter(Number.isFinite)
  if (!ys.length) return null
  const max = Math.max(...ys)
  // From zero, like the chart above it: a sparkline scaled to its own minimum
  // turns a 2% wobble into a cliff, which is the opposite of what it is for.
  const span = max > 0 ? max : 1
  const n = points.length
  const coords = points.map((p, i) => {
    const x = n === 1 ? W / 2 : (i / (n - 1)) * W
    const y = H - PAD - ((Number.isFinite(p.y) ? p.y : 0) / span) * (H - PAD * 2)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
  return { coords, min: Math.min(...ys), max, last: ys[ys.length - 1] }
}

/**
 * @param {Object} props
 * @param {DOMRect|{left:number,top:number,right:number,bottom:number}} props.anchor
 *   the cell being hovered, in viewport coordinates
 * @param {Array<{x:number,y:number}>} props.points
 * @param {string} props.label
 * @param {'number'|'time'} [props.unit]
 * @param {string} [props.colour]
 */
export default function ValueSparkPopover({ anchor, points, label, unit = 'number', colour = 'var(--brand)' }) {
  const g = points?.length ? geometry(points) : null
  if (!anchor || !g) return null

  // Above the cell by default; below it when the row is near the top of the
  // viewport. Clamped horizontally so a long table never pushes it off-screen.
  const above = anchor.top > POP_H + GAP
  const top = above ? anchor.top - POP_H - GAP : anchor.bottom + GAP
  const left = Math.max(GAP, Math.min(window.innerWidth - POP_W - GAP, anchor.left - POP_W / 2 + (anchor.right - anchor.left) / 2))

  return createPortal(
    <div className="ex-spark-pop" style={{ left, top }} role="tooltip">
      <div className="ex-spark-label" title={label}>{label}</div>
      <svg className="ex-spark-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
        <polygon points={`0,${H} ${g.coords} ${W},${H}`} fill={colour} fillOpacity="0.16" />
        <polyline points={g.coords} fill="none" stroke={colour} strokeWidth="1.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="ex-spark-meta">
        <span>min <b>{formatValue(g.min, unit)}</b></span>
        <span>max <b>{formatValue(g.max, unit)}</b></span>
        <span>last <b>{formatValue(g.last, unit)}</b></span>
      </div>
    </div>,
    document.body,
  )
}
