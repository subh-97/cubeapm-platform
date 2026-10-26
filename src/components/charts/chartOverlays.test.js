// The overlays an alert rule draws over its query's chart (docs/alerts/DESIGN.md
// D5, D7): firing stretches, the anomaly expected range, the "now" rule and the
// previous period's dashed line. The risks are the quiet ones thresholdBands
// has — Recharts drops children it does not know and discards a reference
// element that leaves its domain, both silently — plus the colour rule: a
// stretch is a severity and wears its status token, while the expected range
// is not one and must never wear a status hue.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server.browser'
import { createElement as h } from 'react'
import { LineChart, Line, YAxis, XAxis, CartesianGrid, ReferenceArea, ReferenceLine } from 'recharts'
import { shadedIntervals, expectedRangeBand, nowLine, compareLine } from './chartOverlays.jsx'

// A ten-minute numeric time axis in ms, as the platform's time charts plot.
const T0 = 1_760_000_000_000
const MIN = 60_000
const data = Array.from({ length: 11 }, (_, i) => ({ x: T0 + i * MIN, v: 2 + i, prev: 1 + (i % 3) }))

function render(overlays, { domain = [T0, T0 + 10 * MIN], extra = [] } = {}) {
  return renderToStaticMarkup(h(LineChart, { width: 420, height: 200, data, margin: { top: 8, right: 8, left: 0, bottom: 0 } },
    h(CartesianGrid, { strokeDasharray: '3 3' }),
    overlays,
    h(XAxis, { dataKey: 'x', type: 'number', scale: 'linear', domain, allowDataOverflow: true }),
    h(YAxis, { domain: [0, 16] }),
    h(Line, { dataKey: 'v', isAnimationActive: false, stroke: '#3B82F6' }),
    ...extra,
  ))
}

const areas = html => [...html.matchAll(/<path[^>]*class="recharts-rectangle recharts-reference-area-rect"[^>]*>/g)].map(m => m[0])
const refLines = html => [...html.matchAll(/<line[^>]*class="recharts-reference-line-line"[^>]*>/g)].map(m => m[0])
const curves = html => [...html.matchAll(/<path[^>]*class="recharts-curve recharts-line-curve"[^>]*>/g)].map(m => m[0])
const attr = (tag, name) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1]
const STATUS_TOKEN = /var\(--(critical|warning|healthy|info)\)/

test('a firing stretch is one area per interval, in its tone\'s status token, clipped rather than discarded', () => {
  const els = shadedIntervals({
    keyPrefix: 'fire',
    intervals: [
      { x1: T0 + 2 * MIN, x2: T0 + 4 * MIN, tone: 'info' },
      { x1: T0 + 4 * MIN, x2: null, tone: 'critical' },
      { x1: T0 + 5 * MIN, x2: T0 + 6 * MIN, tone: 'warning' },
    ],
  })
  assert.deepEqual(els.map(e => e.type), [ReferenceArea, ReferenceArea, ReferenceArea])
  assert.deepEqual(els.map(e => e.props.fill), ['var(--info)', 'var(--critical)', 'var(--warning)'])
  for (const e of els) assert.equal(e.props.ifOverflow, 'hidden', e.key)
  assert.equal(new Set(els.map(e => e.key)).size, 3)
  for (const e of els) assert.ok(e.key.startsWith('fire-'), e.key)
  // A stretch is a span of time: it covers the plot's whole height.
  for (const e of els) assert.equal(e.props.y1 ?? e.props.y2, undefined)
  // Pending is fainter than firing; both stay faint enough to read lines through.
  assert.ok(els[0].props.fillOpacity < els[1].props.fillOpacity)
  for (const e of els) assert.ok(e.props.fillOpacity > 0 && e.props.fillOpacity <= 0.15)
})

test('an open stretch runs to the right-hand edge; a malformed one is skipped', () => {
  const [open] = shadedIntervals({ intervals: [{ x1: T0 + 4 * MIN, x2: null, tone: 'critical' }] })
  assert.equal('x2' in open.props, false, 'no x2, so Recharts runs it to the edge of the plot')
  const html = render(shadedIntervals({ intervals: [{ x1: T0 + 4 * MIN, x2: null, tone: 'critical' }] }))
  const [rect] = areas(html)
  // From 4 of 10 minutes in to the plot's right edge (420 − 8 margin).
  const x = Number(attr(rect, 'x'))
  const w = Number(attr(rect, 'width'))
  assert.ok(Math.abs(x + w - 412) < 0.5, `ends at the edge: ${x} + ${w}`)
  assert.deepEqual(shadedIntervals({ intervals: [null, { x1: 'a', tone: 'critical' }, { x1: 5, x2: 3, tone: 'warning' }] }), [])
})

test('a stretch that began before the window is clipped, not dropped', () => {
  // Starting 5 minutes before the axis does: "discard" would delete it whole.
  const html = render(shadedIntervals({ intervals: [{ x1: T0 - 5 * MIN, x2: T0 + 3 * MIN, tone: 'critical' }] }))
  const [rect] = areas(html)
  assert.ok(rect, 'drawn')
  assert.match(attr(rect, 'clip-path'), /^url\(#.+\)$/)
  assert.equal(attr(rect, 'fill'), 'var(--critical)')
  assert.ok(html.indexOf('recharts-reference-area') < html.indexOf('recharts-line-curve'), 'under the line')
})

test('a backtest stretch is lighter and outlined, so it never reads as one the rule spent firing', () => {
  const [was] = shadedIntervals({ intervals: [{ x1: T0, x2: T0 + MIN, tone: 'critical' }] })
  const [would] = shadedIntervals({ variant: 'would', intervals: [{ x1: T0, x2: T0 + MIN, tone: 'critical' }] })
  assert.ok(would.props.fillOpacity < was.props.fillOpacity)
  assert.equal(would.props.strokeDasharray, '3 3')
  assert.equal(would.props.stroke, 'var(--critical)')
  assert.equal(was.props.strokeDasharray, undefined)
})

test('the expected range is a neutral step per bucket, never a status hue', () => {
  const points = Array.from({ length: 10 }, (_, i) => ({ x1: T0 + i * MIN, x2: T0 + (i + 1) * MIN, low: 1 + i * 0.2, high: 6 + i * 0.2 }))
  const els = expectedRangeBand({ points: [{ x1: T0, x2: T0 + MIN, low: null, high: null }, { x1: T0, x2: T0, low: 1, high: 3 }, ...points] })
  assert.equal(els.length, 10, 'a bucket with no range, or no span, is skipped')
  for (const e of els) {
    assert.equal(e.type, ReferenceArea)
    assert.doesNotMatch(e.props.fill, STATUS_TOKEN)
    assert.equal(e.props.ifOverflow, 'hidden')
  }
  assert.deepEqual([els[0].props.y1, els[0].props.y2], [1, 6])
  const html = render(els)
  const rects = areas(html)
  assert.equal(rects.length, 10)
  for (const r of rects) assert.doesNotMatch(attr(r, 'fill'), STATUS_TOKEN)
  // Steps abut: each bucket starts where the last one ended.
  const xs = rects.map(r => [Number(attr(r, 'x')), Number(attr(r, 'width'))])
  for (let i = 1; i < xs.length; i++) assert.ok(Math.abs(xs[i][0] - (xs[i - 1][0] + xs[i - 1][1])) < 0.01)
})

test('a one-sided anomaly band runs to the plot\'s edge on its open side', () => {
  const above = expectedRangeBand({ points: [{ x1: T0, x2: T0 + MIN, low: null, high: 6 }] })
  assert.equal('y1' in above[0].props, false, 'above-by: open to the bottom')
  assert.equal(above[0].props.y2, 6)
  const below = expectedRangeBand({ points: [{ x1: T0, x2: T0 + MIN, low: 2, high: null }] })
  assert.equal(below[0].props.y1, 2)
  assert.equal('y2' in below[0].props, false, 'below-by: open to the top')
  const html = render([...above, ...below])
  const [a, b] = areas(html).map(r => [Number(attr(r, 'y')), Number(attr(r, 'height'))])
  // The plot runs from y=8 to y=170 (200 − 30 axis): above-by reaches the
  // bottom edge, below-by the top one.
  assert.ok(Math.abs(a[0] + a[1] - 170) < 0.5, `bottom edge: ${a}`)
  assert.ok(Math.abs(b[0] - 8) < 0.5, `top edge: ${b}`)
})

test('"now" is a dashed, labelled vertical rule in a neutral token', () => {
  const el = nowLine({ x: T0 + 7 * MIN })
  assert.equal(el.type, ReferenceLine)
  assert.equal(el.props.x, T0 + 7 * MIN)
  assert.doesNotMatch(el.props.stroke, STATUS_TOKEN)
  assert.equal(el.props.ifOverflow, 'hidden')
  assert.equal(nowLine({ x: undefined }), null)
  const html = render([el])
  const [line] = refLines(html)
  assert.ok(line, 'drawn')
  assert.equal(attr(line, 'stroke-dasharray'), '2 3')
  assert.equal(attr(line, 'x1'), attr(line, 'x2'), 'vertical')
  assert.match(html, />now</)
})

test('the previous period is a dashed line in its series\' colour, drawn as a second curve', () => {
  const el = compareLine({ dataKey: 'prev', color: '#3B82F6' })
  assert.equal(el.type, Line)
  assert.equal(el.props.strokeDasharray, '5 3')
  assert.equal(el.props.stroke, '#3B82F6')
  assert.equal(el.props.dot, false)
  assert.equal(el.props.activeDot, false)
  assert.equal(compareLine({ color: '#000' }), null)
  const html = render([el])
  const cs = curves(html)
  assert.equal(cs.length, 2)
  assert.ok(cs.some(c => attr(c, 'stroke-dasharray') === '5 3' && attr(c, 'stroke') === '#3B82F6'))
})
