// CardChart's card, read off the server-rendered markup: the header, the
// legend and the grid span. The plot needs a measured width, which a server
// render does not have, so what it draws is checked in the running page.
//
// It is the Runtime tab's chart moved out of ServiceOverview, so the first test
// pins the markup the Runtime tab has always drawn; the rest cover what the
// Infrastructure pages add to it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server.browser'
import { createElement as h } from 'react'
import { REFERENCE_WINDOW as win } from '@/data/timeWindow'
import { RESOURCE_COLORS } from '@/utils/chartPalette'
import { fmtBytes, fmtPct1, LIMIT_DASH } from '@/components/charts/chartDefaults'
import CardChart from './CardChart.jsx'

const rows = base => win.buckets.map(b => ({ m: b.m, t: b.t, label: b.label, exactTime: b.exactTime, value: b.future ? null : base }))

// The same two server-render warnings LegendLineChart.test.js expects: the
// chart's frame has no size to draw at, and the card menu measures itself in a
// layout effect. Anything else still reaches the console.
const EXPECTED = /width\(\d+\) and height\(\d+\) of chart|useLayoutEffect does nothing on the server/
function render(props) {
  const { warn, error } = console
  const quiet = log => (...args) => { if (!EXPECTED.test(String(args[0]))) log(...args) }
  console.warn = quiet(warn)
  console.error = quiet(error)
  try {
    return renderToStaticMarkup(h(CardChart, { syncId: 's', win, onFocus: () => {}, fmt: fmtPct1, ...props }))
  } finally {
    Object.assign(console, { warn, error })
  }
}

const one = [{ key: 'value', label: 'ip-10-0-142-133', color: RESOURCE_COLORS.used, rows: rows(40) }]
const heap = [
  { key: 'limit', label: 'limit', color: RESOURCE_COLORS.limit, rows: rows(4e9), dash: LIMIT_DASH },
  { key: 'committed', label: 'committed', color: RESOURCE_COLORS.committed, rows: rows(2e9) },
  { key: 'used', label: 'used', color: RESOURCE_COLORS.used, rows: rows(1e9) },
]

const legendOf = html => [...html.matchAll(/<div class="runtime-legend-item"><span class="runtime-legend-swatch" style="background:([^"]+)"><\/span>([^<]*)<\/div>/g)]
  .map(([, color, label]) => ({ color, label }))

test('left at its defaults it draws the Runtime card: a half, the title alone, a ⋮ menu, no legend for one series', () => {
  const html = render({ title: 'CPU Used %', series: one })
  assert.match(html, /^<div class="runtime-chart-card rt-half"><div class="clbl"><span class="clbl-text">CPU Used %<\/span><button type="button" class="card-menu-btn"/)
  assert.match(html, /<div class="chart-host" style="width:100%">/, 'sized by the card class, not inline')
  assert.doesNotMatch(html, /runtime-legend/)
})

test('a chart of several series lists them under the plot, in series order and colour', () => {
  const html = render({ title: 'Heap Memory (bytes)', span: 'third', fmt: fmtBytes, series: heap })
  assert.match(html, /^<div class="runtime-chart-card rt-third">/)
  assert.deepEqual(legendOf(html), heap.map(s => ({ color: s.color, label: s.label })))
})

test('a value sits beside the title, and a full-width card says so', () => {
  const html = render({ title: 'Disk Used %', value: '72.8%', span: 'full', series: one })
  assert.match(html, /^<div class="runtime-chart-card rt-full"><div class="clbl"><span class="clbl-text">Disk Used %<span class="cval">72.8%<\/span><\/span>/)
})

test('a missing reading prints no figure rather than an empty one', () => {
  for (const value of [undefined, null]) {
    assert.doesNotMatch(render({ title: 'Evictions per Minute', value, series: one }), /class="cval"/)
  }
  // Zero is a reading and is printed.
  assert.match(render({ title: 'Connection Errors per Minute', value: 0, series: one }), /<span class="cval">0<\/span>/)
})

test('the card menu is named after the card it acts on', () => {
  const html = render({ title: 'Network Traffic (bytes/s)', area: true, fmt: fmtBytes, series: heap })
  assert.match(html, /<button type="button" class="card-menu-btn" title="Network Traffic \(bytes\/s\) options" aria-label="Network Traffic \(bytes\/s\) options"/)
})
