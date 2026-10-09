// LegendLineChart's legend, read off the server-rendered markup.
//
// The plot itself needs a measured width, which a server render does not have,
// so these tests cover what decides which rows a chart shows and how: the
// order, the colours, the labels, the series budget and isolation. Rendered at
// width 0, a chart's budget is the smallest cap (8), so a 10-row chart holds
// two rows back — which is what the pinning tests lean on.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server.browser'
import { createElement as h } from 'react'
import { REFERENCE_WINDOW as win } from '@/data/timeWindow'
import { epColor, browserColor } from '@/utils/chartPalette'
import { fmtRedRpm, fmtRpm2 } from '@/components/charts/chartDefaults'
import LegendLineChart from './LegendLineChart.jsx'

const ORIGIN = 'https://shop.cubedemo.com'
// Values deliberately out of order, so a sorted legend differs from data order.
const RPMS = [12.5, 80.25, 3.1, 44, 9.75, 60, 1.5, 27.3, 0.4, 33.33]
const eps = RPMS.map((rpm, i) => ({ endpoint: `${ORIGIN}/route-${i}`, rpm }))
const epSeries = eps.map((e, i) => ({
  endpoint: e.endpoint,
  series: win.buckets.map(b => ({ m: b.m, t: b.t, label: b.label, exactTime: b.exactTime, value: b.future ? null : e.rpm + (i % 3) })),
}))

// Two warnings are this test's premise rather than a failure: the chart's
// frame has no size to draw at on the server, and the card menu measures
// itself in a layout effect, which a server render skips. Anything else still
// reaches the console.
const EXPECTED = /width\(\d+\) and height\(\d+\) of chart|useLayoutEffect does nothing on the server/
function render(props) {
  const { warn, error } = console
  const quiet = log => (...args) => { if (!EXPECTED.test(String(args[0]))) log(...args) }
  console.warn = quiet(warn)
  console.error = quiet(error)
  try {
    return renderToStaticMarkup(h(LegendLineChart, {
      title: 'RPM', eps, epSeries, dataKey: 'rpm', fmtFn: fmtRedRpm, syncId: 's', win, onFocus: () => {}, ...props,
    }))
  } finally {
    Object.assign(console, { warn, error })
  }
}

const unescape = s => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

function legendRows(html) {
  return [...html.matchAll(/<button type="button" class="(drill2-item[^"]*)"([^>]*)>(.*?)<\/button>/g)].map(([, cls, attrs, body]) => ({
    dimmed: cls.includes('dimmed'),
    pressed: /aria-pressed="true"/.test(attrs),
    title: /title="([^"]*)"/.exec(attrs)?.[1] ?? null,
    swatch: /background:([^;"]+)/.exec(body)[1],
    label: unescape(/<span class="drill2-label">(.*?)<\/span>/.exec(body)[1]),
    value: /<span class="drill2-val">(.*?)<\/span>/.exec(body)[1],
  }))
}

test('left at its defaults it draws the RED chart: data order, epColor, full labels', () => {
  const html = render()
  const rows = legendRows(html)
  assert.equal(rows.length, 8, 'the budget lists the first 8 of 10')
  assert.deepEqual(rows.map(r => r.label), eps.slice(0, 8).map(e => e.endpoint))
  assert.deepEqual(rows.map(r => r.swatch), eps.slice(0, 8).map((_, i) => epColor(i)))
  assert.deepEqual(rows.map(r => r.value), RPMS.slice(0, 8).map(fmtRedRpm))
  for (const r of rows) {
    assert.equal(r.pressed, false)
    assert.equal(r.dimmed, false)
    assert.equal(r.title, null, 'no title unless a formatLabel shortens the label')
  }
  assert.match(html, /<div class="red-chart-head"><span>RPM<\/span>/)
  assert.match(html, /<div class="drill2-legend">/)
  assert.match(html, /aria-label="Search endpoints" placeholder="Search endpoints…"/)
  assert.match(html, /Showing 8 of 10 endpoints/)
  // Rows are buttons with a span inside, never a div inside a button.
  assert.doesNotMatch(html, /<button[^>]*class="drill2-item[^"]*"[^>]*><div/)
})

test('valueDesc sorts the legend and the budget, but a row keeps its colour', () => {
  const rows = legendRows(render({ legendSort: 'valueDesc', colorFor: browserColor }))
  const byValue = eps.map((e, i) => ({ ...e, i })).sort((a, b) => b.rpm - a.rpm)
  assert.deepEqual(rows.map(r => r.label), byValue.slice(0, 8).map(e => e.endpoint), 'the 8 largest, largest first')
  assert.deepEqual(rows.map(r => r.swatch), byValue.slice(0, 8).map(e => browserColor(e.i)), 'colour follows the data index')
})

test('formatLabel shortens the legend text and the row keeps the full label as its title', () => {
  const rows = legendRows(render({ formatLabel: l => l.replace(ORIGIN, '') }))
  assert.equal(rows[0].label, '/route-0')
  assert.equal(rows[0].title, `${ORIGIN}/route-0`)
})

test('a shared selection is pinned and drawn even when the budget holds it back', () => {
  // Sorted by value, route-8 (0.4 rpm) is last: past the budget of 8.
  const label = `${ORIGIN}/route-8`
  const rows = legendRows(render({ legendSort: 'valueDesc', selected: label, onSelect: () => {} }))
  assert.equal(rows.length, 9, 'the 8 the budget draws, plus the pinned row')
  assert.equal(rows[0].label, label, 'pinned to the top')
  assert.equal(rows[0].pressed, true)
  assert.equal(rows[0].dimmed, false)
  assert.equal(rows[0].swatch, epColor(8))
  for (const r of rows.slice(1)) {
    assert.equal(r.pressed, false)
    assert.equal(r.dimmed, true)
  }
})

test('a shared selection already in view stays where it is', () => {
  const label = `${ORIGIN}/route-1`
  const rows = legendRows(render({ selected: label, onSelect: () => {} }))
  assert.equal(rows.length, 8)
  assert.equal(rows[1].label, label)
  assert.equal(rows[1].pressed, true)
  assert.equal(rows.filter(r => r.dimmed).length, 7)
})

test('a shared selection this chart does not have isolates nothing', () => {
  const rows = legendRows(render({ selected: 'https://elsewhere.example/', onSelect: () => {} }))
  assert.equal(rows.length, 8)
  for (const r of rows) assert.equal(r.pressed || r.dimmed, false)
})

test('the legend speaks of what it lists, and takes an info node and a scroll', () => {
  const html = render({
    noun: 'routes', fmtFn: fmtRpm2, info: h('button', { type: 'button', className: 'infotip-btn', 'aria-label': 'About RPM' }), legendScroll: true,
  })
  assert.match(html, /aria-label="Search routes" placeholder="Search routes…"/)
  assert.match(html, /Showing 8 of 10 routes/)
  assert.match(html, /<span class="clbl-text">RPM<button type="button" class="infotip-btn" aria-label="About RPM"><\/button><\/span>/)
  assert.match(html, /<div class="drill2-legend is-scroll">/)
  assert.equal(legendRows(html)[0].value, '12.50')
  assert.match(render({ searchPlaceholder: 'Find a page…' }), /placeholder="Find a page…"/)
})
