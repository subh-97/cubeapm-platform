// The Web Vitals bands: what thresholdBands hands a chart, what a real
// Recharts chart then draws from it, and the axis top that keeps the bands in
// view. The rendered half matters as much as the element half — Recharts drops
// children it does not recognise and discards a reference element that leaves
// its domain, and both of those fail silently, as a chart with no bands.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server.browser'
import { createElement as h, cloneElement } from 'react'
import { LineChart, Line, YAxis, XAxis, CartesianGrid, ReferenceArea, ReferenceLine } from 'recharts'
import { niceAxis, formatDecimals, fmtLoadTime, fmtCls } from '@/components/charts/chartDefaults'
import { thresholdBands, bandAxisTop } from './thresholdBands.jsx'

const LCP = { good: 2500, poor: 4000 }

test('three zones and two dashed rules, every one clipped rather than discarded', () => {
  const els = thresholdBands({ ...LCP, keyPrefix: 'lcp' })
  assert.equal(els.length, 5)
  assert.deepEqual(els.map(e => e.type), [ReferenceArea, ReferenceArea, ReferenceArea, ReferenceLine, ReferenceLine])
  for (const e of els) assert.equal(e.props.ifOverflow, 'hidden', `${e.key} must be ifOverflow="hidden"`)
  // Keys are unique and carry the prefix, so two sets can share a chart.
  assert.equal(new Set(els.map(e => e.key)).size, 5)
  for (const e of els) assert.ok(e.key.startsWith('lcp-'), e.key)
})

test('the zones cover 0 → good → poor → the top of the plot, in the status tokens', () => {
  const [good, warn, poor, goodRule, poorRule] = thresholdBands(LCP)
  assert.deepEqual([good.props.y1, good.props.y2], [0, 2500])
  assert.deepEqual([warn.props.y1, warn.props.y2], [2500, 4000])
  // No y2: the poor zone runs to the top however tall the axis is.
  assert.equal(poor.props.y1, 4000)
  assert.equal(poor.props.y2, undefined)
  assert.deepEqual([good, warn, poor].map(e => e.props.fill), ['var(--healthy)', 'var(--warning)', 'var(--critical)'])
  for (const z of [good, warn, poor]) assert.ok(z.props.fillOpacity > 0 && z.props.fillOpacity <= 0.12, 'faint')
  // A zone is a horizontal band: it spans the whole x range.
  for (const z of [good, warn, poor]) assert.equal(z.props.x1 ?? z.props.x2, undefined)
  assert.equal(goodRule.props.y, 2500)
  assert.equal(poorRule.props.y, 4000)
  for (const r of [goodRule, poorRule]) assert.equal(r.props.strokeDasharray, '4 3')
  for (const r of [goodRule, poorRule]) assert.match(r.props.stroke, /^var\(--(warning|critical)\)$/)
})

test('a rule is labelled with its threshold only when given a formatter', () => {
  const plain = thresholdBands(LCP)
  assert.equal(plain[3].props.label, undefined)
  const labelled = thresholdBands({ ...LCP, fmt: fmtLoadTime })
  assert.equal(labelled[3].props.label.value, '2.50 s')
  assert.equal(labelled[4].props.label.value, '4.00 s')
  assert.equal(labelled[4].props.label.fill, 'var(--text-muted)')
})

// A chart at a fixed size renders on the server, so this is the SVG a browser
// would get. Children go in the order LegendLineChart and MiniChart use: grid,
// bands, axes, lines.
function render(top, bands = thresholdBands(LCP)) {
  const data = [0, 1, 2, 3].map(i => ({ x: i, v: 1800 + i * 400 }))
  return renderToStaticMarkup(h(LineChart, { width: 400, height: 200, data, margin: { top: 8, right: 8, left: 0, bottom: 0 } },
    h(CartesianGrid, { strokeDasharray: '3 3' }),
    bands,
    h(XAxis, { dataKey: 'x' }),
    h(YAxis, { domain: [0, top] }),
    h(Line, { dataKey: 'v', isAnimationActive: false }),
  ))
}

const rects = html => [...html.matchAll(/<path[^>]*class="recharts-rectangle recharts-reference-area-rect"[^>]*>/g)].map(m => m[0])
const rules = html => [...html.matchAll(/<line[^>]*class="recharts-reference-line-line"[^>]*>/g)].map(m => m[0])
const attr = (tag, name) => new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1]

test('a real chart draws every zone and rule, clipped to the plot, under the lines', () => {
  const html = render(6000)
  const zs = rects(html)
  assert.equal(zs.length, 3)
  assert.deepEqual(zs.map(z => attr(z, 'fill')), ['var(--healthy)', 'var(--warning)', 'var(--critical)'])
  for (const z of zs) assert.match(attr(z, 'clip-path'), /^url\(#.+\)$/)
  const rs = rules(html)
  assert.equal(rs.length, 2)
  for (const r of rs) assert.equal(attr(r, 'stroke-dasharray'), '4 3')
  for (const r of rs) assert.match(attr(r, 'clip-path'), /^url\(#.+\)$/)
  // Children order is z-order: the zones come before the line in the SVG.
  assert.ok(html.indexOf('recharts-reference-area') < html.indexOf('recharts-line-curve'))
})

test('a threshold above the axis is clipped, not dropped with its whole zone', () => {
  // At a top of 3000 the poor threshold is off the plot. The default
  // ifOverflow="discard" would delete the warning zone too (one of its edges
  // is out of range); "hidden" keeps it and lets the clip trim it.
  const html = render(3000)
  assert.equal(rects(html).length, 3)
  const discard = thresholdBands(LCP).map(e => (e.type === ReferenceArea ? cloneElement(e, { ifOverflow: 'discard' }) : e))
  assert.ok(rects(render(3000, discard)).length < 3, 'the default would have discarded a zone')
})

test('bandAxisTop always clears the poor threshold with room for the poor zone', () => {
  assert.equal(bandAxisTop(1200, 4000), 6000)
  assert.equal(bandAxisTop(300, 500), 600)
  assert.equal(bandAxisTop(0.03, 0.25), 0.3)
  for (const [d, poor] of [[0, 4000], [3999, 4000], [100, 500], [0.01, 0.25], [0.24, 0.25]]) {
    assert.ok(bandAxisTop(d, poor) >= poor * 1.2, `${d}, ${poor} → ${bandAxisTop(d, poor)}`)
  }
})

test('bandAxisTop follows data that is already past poor, and tolerates no data', () => {
  assert.ok(bandAxisTop(9000, 4000) >= 9000)
  assert.equal(bandAxisTop(9000, 4000), niceAxis(9000).top)
  assert.equal(bandAxisTop(undefined, 500), 600)
  assert.equal(bandAxisTop(NaN, 500), 600)
  assert.equal(bandAxisTop(-5, 500), 600)
})

test('a chart that rounds bandAxisTop through its own niceAxis keeps the same top', () => {
  // LegendLineChart and MiniChart run yTop through niceAxis again, with the
  // precision of their own formatter; a top that drifted a step there would
  // leave the bands smaller than the caller asked for.
  for (const [d, poor, fmt] of [[1200, 4000, fmtLoadTime], [300, 500, fmtLoadTime], [0.03, 0.25, fmtCls], [7100, 4000, fmtLoadTime]]) {
    const top = bandAxisTop(d, poor)
    const again = niceAxis(top, 4, { decimals: formatDecimals(fmt) }).top
    assert.ok(Math.abs(again - top) < 1e-9, `${d}/${poor}: ${top} → ${again}`)
  }
})
