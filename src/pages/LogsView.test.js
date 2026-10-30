// The Logs page's Expand graph: which graph the results toolbar offers to
// expand, and the volume strip drawn a second time inside the chart modal.
//
// Server-rendered, like every component test here. A server render has no
// state to toggle and no effects, so the page is read in its first state (the
// graph shown, the histogram drawn) and the rest of the choice through
// `expandableGraph`, the function the toolbar asks.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server.browser'
import { createElement as h } from 'react'
import { REFERENCE_WINDOW } from '@/data/timeWindow'
import { logRowsForWindow, logVolumeForWindow } from '@/data/observability'
import { aggregate } from '@/utils/aggregator'
import { newStatsPipe, newStatsFunction, newMathPipe } from '@/utils/pipes'
import { getFieldValue } from '@/components/QueryBuilder'
import ChartModal from '@/components/charts/ChartModal'
import { ChartFrameContext, EXPAND_PLOT_HEIGHT } from '@/components/charts/chartView'
import LogsView, { LogVolumeStrip, expandableGraph } from './LogsView.jsx'

const EXPECTED = /width\(\d+\) and height\(\d+\) of chart|useLayoutEffect does nothing on the server/
function quietly(fn) {
  const { warn, error } = console
  const quiet = log => (...args) => { if (!EXPECTED.test(String(args[0]))) log(...args) }
  console.warn = quiet(warn)
  console.error = quiet(error)
  try { return fn() } finally { Object.assign(console, { warn, error }) }
}

const win = REFERENCE_WINDOW
const rows = logRowsForWindow(win)

// A run of the page's aggregator over the hour's records, as the results
// panel runs it.
const resultOf = pipes => aggregate({
  pipes,
  logs: rows,
  getFieldValue,
  now: win.end * 1000,
  timeRange: win.spanSec * 1000,
  bucketCount: Math.min(30, win.buckets.length),
})

function stripProps(over = {}) {
  const volume = logVolumeForWindow(win)
  const sum = k => volume.reduce((a, b) => a + b[k], 0)
  return {
    win,
    volume,
    max: volume.reduce((m, d) => Math.max(m, d.total), 0),
    totals: { total: sum('total'), error: sum('error'), warn: sum('warn'), info: sum('info') },
    onFocus() {},
    zoomed: false,
    onResetZoom() {},
    ...over,
  }
}

/* ---- the toolbar ---- */

test('the results toolbar offers Expand graph right after Hide graph while the histogram is drawn', () => {
  const html = quietly(() => renderToStaticMarkup(h(LogsView, {
    goHome() {}, timeRange: { kind: 'preset', value: '1h' }, setTimeRange() {}, setToast() {}, onOpenLink() {},
  })))
  assert.match(
    html,
    /Hide graph<\/button><button type="button" class="hbtn small" title="Expand Log volume" aria-haspopup="dialog"><svg[^>]*aria-hidden="true">.*?<\/svg>Expand graph<\/button>/,
  )
  // A labelled button names itself by its text, not by an aria-label.
  assert.doesNotMatch(html, /aria-label="Expand Log volume"/)
  // On the page there is no frame: the plot keeps the height its CSS gives it.
  assert.match(html, /<div class="logs-volume"><div class="logs-volume-chart"><div class="volume-brush-hint">/)
})

test('Expand graph is offered for the graph the results panel draws, and for no other', () => {
  const grouped = resultOf([newStatsPipe({ groupBy: ['service'] })])
  const kpi = resultOf([newStatsPipe()])
  const empty = resultOf([])

  assert.deepEqual(expandableGraph({ graphVisible: true, showsVolume: true, result: empty }), { kind: 'volume', title: 'Log volume' })
  assert.deepEqual(expandableGraph({ graphVisible: true, showsVolume: false, result: grouped }), { kind: 'stats', title: 'count() by service' })

  // Hidden, there is no graph to expand, whichever one it would be.
  assert.equal(expandableGraph({ graphVisible: false, showsVolume: true, result: empty }), null)
  assert.equal(expandableGraph({ graphVisible: false, showsVolume: false, result: grouped }), null)

  // One number is a KPI and its sparkline; a result with nothing in it draws
  // nothing.
  assert.equal(expandableGraph({ graphVisible: true, showsVolume: false, result: kpi }), null)
  assert.equal(expandableGraph({ graphVisible: true, showsVolume: false, result: empty }), null)
})

test('a stats result is named for what it plots, as the query spells it', () => {
  const two = resultOf([newStatsPipe({
    groupBy: ['service', 'log.level'],
    functions: [newStatsFunction(), newStatsFunction({ fn: 'count', as: 'errors' })],
  })])
  assert.equal(expandableGraph({ graphVisible: true, showsVolume: false, result: two }).title, 'count(), errors by service, log.level')

  const withMath = resultOf([
    newStatsPipe({ functions: [newStatsFunction({ as: 'hits' })] }),
    newMathPipe({ expression: 'hits / 60', as: 'per_min' }),
  ])
  assert.equal(expandableGraph({ graphVisible: true, showsVolume: false, result: withMath }).title, 'hits, per_min')
})

/* ---- the strip, expanded ---- */

test('the volume strip takes the modal frame\'s height, and keeps its legend and zoom hint', () => {
  const props = stripProps()
  const html = quietly(() => renderToStaticMarkup(h(ChartModal, {
    mode: 'expand', onMode() {}, onClose() {}, menu: false,
    title: 'Log volume',
    view: { win, render: () => h(LogVolumeStrip, props), value: () => '2.93K logs' },
  })))
  assert.match(html, /Log volume<span class="cval">2\.93K logs<\/span>/)
  assert.doesNotMatch(html, /card-menu-btn/, 'no ⋮: the histogram has no card menu to carry in')
  assert.ok(
    html.includes(`<div class="logs-volume-chart" style="height:${EXPAND_PLOT_HEIGHT}">`),
    'the plot is as tall as the modal makes it',
  )
  assert.match(html, /class="volume-brush-hint"/)
  assert.match(html, /<span class="lvl-key">Total<\/span>/)
  for (const level of ['error', 'warn', 'info']) assert.match(html, new RegExp(`<span class="lvl-key">${level}</span>`))
})

test('a frame\'s height in pixels is a pixel height, and a zoomed strip offers Reset in place of the hint', () => {
  const frame = { syncId: 'chart-modal-test', syncMethod: 'index', height: 300, brush: true, nowMs: win.end * 1000 }
  const html = quietly(() => renderToStaticMarkup(
    h(ChartFrameContext.Provider, { value: frame }, h(LogVolumeStrip, stripProps({ zoomed: true }))),
  ))
  assert.match(html, /<div class="logs-volume-chart" style="height:300px">/)
  assert.match(html, /class="volume-reset-btn"[^>]*>.*?Reset zoom<\/button>/)
  assert.doesNotMatch(html, /volume-brush-hint/)
})
