// The Web Vitals bands: what thresholdBands hands a chart, what a real
// Recharts chart then draws from it, and the axis top that keeps the bands in
// view. The rendered half matters as much as the element half — Recharts drops
// children it does not recognise and discards a reference element that leaves
// its domain, and both of those fail silently, as a chart with no bands.
//
// Then the alert rules' forms (one threshold, lower is worse), and the risk
// they bring: that adding them moved the Web Vitals charts. Every call the
// Browser page makes is compared with a frozen copy of the original, element
// for element and SVG byte for byte.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server.browser'
import { createElement as h, cloneElement } from 'react'
import { LineChart, Line, YAxis, XAxis, CartesianGrid, ReferenceArea, ReferenceLine } from 'recharts'
import { niceAxis, formatDecimals, fmtLoadTime, fmtCls } from '@/components/charts/chartDefaults'
import { WEB_VITAL_THRESHOLDS } from '@/utils/status'
import { VITALS, vitalThresholdFigure } from '@/components/browser/metricLabels'
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

// ---------- The alert forms (docs/alerts/DESIGN.md D7) ----------
//
// thresholdBands gained a single-threshold form and a lower-is-worse form for
// alert rules' tiers. The Web Vitals charts are its existing callers, and they
// must not move a pixel: every call WebVitalsTab makes (each vital, with and
// without its labelled rules) is checked against a frozen copy of the original
// implementation — the elements, prop for prop, and the SVG a real chart draws
// from them, byte for byte.

// The original two-threshold implementation, exactly as it was before the
// alert forms were added. Frozen here on purpose: it is the fixture the
// current code is compared with, not a second implementation to keep in step.
function legacyThresholdBands({ good, poor, keyPrefix = 'bands', fmt } = {}) {
  const label = v => (fmt ? {
    value: fmt(v), position: 'insideBottomRight', offset: 4, fill: 'var(--text-muted)', fontSize: 10,
  } : undefined)
  const zone = { fillOpacity: 0.08, ifOverflow: 'hidden' }
  const rule = { strokeDasharray: '4 3', strokeOpacity: 0.6, ifOverflow: 'hidden' }
  return [
    h(ReferenceArea, { key: `${keyPrefix}-good`, y1: 0, y2: good, fill: 'var(--healthy)', ...zone }),
    h(ReferenceArea, { key: `${keyPrefix}-warn`, y1: good, y2: poor, fill: 'var(--warning)', ...zone }),
    h(ReferenceArea, { key: `${keyPrefix}-poor`, y1: poor, fill: 'var(--critical)', ...zone }),
    h(ReferenceLine, { key: `${keyPrefix}-good-rule`, y: good, stroke: 'var(--warning)', label: label(good), ...rule }),
    h(ReferenceLine, { key: `${keyPrefix}-poor-rule`, y: poor, stroke: 'var(--critical)', label: label(poor), ...rule }),
  ]
}

// WebVitalsTab's own calls (its bandsFor): every vital, as the full-size
// charts make them (labelled, `chart-` keys) and as the summary cards make
// them (unlabelled, `card-` keys).
const WEB_VITALS_CALLS = VITALS.flatMap(m => [true, false].map(withLabels => ({
  good: WEB_VITAL_THRESHOLDS[m].good,
  poor: WEB_VITAL_THRESHOLDS[m].poor,
  keyPrefix: `${withLabels ? 'chart' : 'card'}-${m}`,
  fmt: withLabels ? v => vitalThresholdFigure(m, v) : undefined,
})))

// An element as data: its type, key and every prop.
const shape = el => ({ type: el.type, key: el.key, props: el.props })
// The colour an element paints in: a zone's fill, a rule's stroke.
const paint = el => (el.type === ReferenceArea ? el.props.fill : el.props.stroke)

test('every Web Vitals call returns the original elements, prop for prop', () => {
  assert.equal(WEB_VITALS_CALLS.length, 6)
  for (const call of WEB_VITALS_CALLS) {
    assert.deepEqual(thresholdBands(call).map(shape), legacyThresholdBands(call).map(shape), call.keyPrefix)
  }
})

// Recharts numbers each chart's clip path from a counter that runs across
// renders (`recharts12-clip`), so two renders of the same chart differ there
// and nowhere else. Every other byte is compared.
const sameClip = html => html.replace(/recharts\d+-clip/g, 'recharts-clip')

test('every Web Vitals call draws the original SVG, byte for byte, at every axis top', () => {
  for (const call of WEB_VITALS_CALLS) {
    // A top that clears the poor zone, one that cuts it off, and the one the
    // page itself asks for.
    for (const top of [call.poor * 0.75, bandAxisTop(0, call.poor), call.poor * 3]) {
      assert.equal(sameClip(render(top, thresholdBands(call))), sameClip(render(top, legacyThresholdBands(call))), `${call.keyPrefix} @ ${top}`)
    }
  }
})

test('one threshold: only good is good below and needs improvement above; only poor is good below and poor above', () => {
  const warnOnly = thresholdBands({ good: 1, keyPrefix: 'w' })
  assert.deepEqual(warnOnly.map(e => e.type), [ReferenceArea, ReferenceArea, ReferenceLine])
  assert.deepEqual(warnOnly.map(paint), ['var(--healthy)', 'var(--warning)', 'var(--warning)'])
  assert.deepEqual([warnOnly[0].props.y1, warnOnly[0].props.y2, warnOnly[1].props.y1, warnOnly[1].props.y2, warnOnly[2].props.y], [0, 1, 1, undefined, 1])

  const critOnly = thresholdBands({ poor: 3, keyPrefix: 'c', fmt: v => `${v}%` })
  assert.deepEqual(critOnly.map(e => e.type), [ReferenceArea, ReferenceArea, ReferenceLine])
  assert.deepEqual(critOnly.map(paint), ['var(--healthy)', 'var(--critical)', 'var(--critical)'])
  assert.deepEqual([critOnly[0].props.y2, critOnly[1].props.y1, critOnly[1].props.y2], [3, 3, undefined])
  assert.equal(critOnly[2].props.label.value, '3%')

  for (const e of [...warnOnly, ...critOnly]) assert.equal(e.props.ifOverflow, 'hidden', e.key)
  // Nothing in between: a lone tier has one line to cross, not two.
  assert.equal(warnOnly.filter(e => paint(e) === 'var(--critical)').length, 0)
  assert.equal(critOnly.filter(e => paint(e) === 'var(--warning)').length, 0)
  assert.deepEqual(thresholdBands({ keyPrefix: 'none' }), [])
})

test('lower is worse: poor from 0, needs improvement up to good, good to the top', () => {
  const both = thresholdBands({ good: 0.85, poor: 0.7, direction: 'lower', keyPrefix: 'apdex' })
  assert.deepEqual(both.map(e => e.type), [ReferenceArea, ReferenceArea, ReferenceArea, ReferenceLine, ReferenceLine])
  const [poor, warn, good, goodRule, poorRule] = both
  assert.deepEqual([poor.props.y1, poor.props.y2, poor.props.fill], [0, 0.7, 'var(--critical)'])
  assert.deepEqual([warn.props.y1, warn.props.y2, warn.props.fill], [0.7, 0.85, 'var(--warning)'])
  // No y2: the good zone runs to the top, as the poor zone does the other way up.
  assert.deepEqual([good.props.y1, good.props.y2, good.props.fill], [0.85, undefined, 'var(--healthy)'])
  assert.deepEqual([goodRule.props.y, goodRule.props.stroke], [0.85, 'var(--warning)'])
  assert.deepEqual([poorRule.props.y, poorRule.props.stroke], [0.7, 'var(--critical)'])
  assert.equal(new Set(both.map(e => e.key)).size, 5)
  for (const e of both) assert.equal(e.props.ifOverflow, 'hidden', e.key)

  // An RPM drop with only a critical floor: poor below it, good above.
  const floor = thresholdBands({ poor: 100, direction: 'lower' })
  assert.deepEqual(floor.map(e => [e.props.y1, e.props.y2 ?? null, paint(e)]),
    [[0, 100, 'var(--critical)'], [100, null, 'var(--healthy)'], [undefined, null, 'var(--critical)']])
  const warnFloor = thresholdBands({ good: 200, direction: 'lower' })
  assert.deepEqual(warnFloor.map(e => [e.props.y1, e.props.y2 ?? null, paint(e)]),
    [[0, 200, 'var(--warning)'], [200, null, 'var(--healthy)'], [undefined, null, 'var(--warning)']])
})

test('a real chart draws the alert forms clipped to the plot, under the line', () => {
  for (const bands of [
    thresholdBands({ poor: 4000 }),
    thresholdBands({ good: 2500 }),
    thresholdBands({ good: 2500, poor: 1000, direction: 'lower' }),
  ]) {
    const html = render(6000, bands)
    const zones = bands.filter(e => e.type === ReferenceArea).length
    assert.equal(rects(html).length, zones)
    for (const z of rects(html)) assert.match(attr(z, 'clip-path'), /^url\(#.+\)$/)
    for (const r of rules(html)) assert.match(attr(r, 'clip-path'), /^url\(#.+\)$/)
    assert.ok(html.indexOf('recharts-reference-area') < html.indexOf('recharts-line-curve'))
  }
})
