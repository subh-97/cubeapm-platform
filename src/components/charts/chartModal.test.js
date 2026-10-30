// A chart card's Expand and Compare: the window the earlier chart is drawn
// over (shiftWindow), what the modal draws for each mode, and the corner every
// chart card's header now carries (ChartActions).
//
// Server-rendered, like every component test here: the modal is given its mode
// directly, and a server render has no document, so it draws in place rather
// than in a portal. Focus and the keyboard are checked in the running page.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server.browser'
import { createElement as h, useContext } from 'react'
import { resolveWindow, shiftWindow, REFERENCE_WINDOW } from '@/data/timeWindow'
import { CHART_COMPARE_OPTIONS, DEFAULT_CHART_COMPARE, chartCompareOption, ChartFrameContext } from './chartView'
import ChartModal from './ChartModal.jsx'
import ChartActions from './ChartActions.jsx'
import CardChart from './CardChart.jsx'
import { fmtPct1 } from './chartDefaults'

const DAY = 86400
const PRESETS = ['5m', '15m', '30m', '1h', '3h', '6h', '12h', '1d', '2d', '7d', 'today', 'todayf']

/* ---- the earlier window ---- */

test('an earlier window keeps the current one\'s shape, bucket for bucket, for every preset and shift', () => {
  for (const value of PRESETS) {
    const win = resolveWindow({ kind: 'preset', value })
    for (const { sec } of CHART_COMPARE_OPTIONS) {
      const w = shiftWindow(win, sec)
      assert.equal(w.buckets.length, win.buckets.length, `${value} − ${sec}s: bucket count`)
      assert.equal(w.step, win.step)
      assert.equal(w.spanSec, win.spanSec)
      assert.equal(w.start, win.start - sec)
      assert.equal(w.end, win.end - sec)
      // The data's now does not move: it is what every bucket is measured from.
      assert.equal(w.nowSec, win.nowSec)
      w.buckets.forEach((b, i) => {
        assert.equal(b.i, win.buckets[i].i)
        assert.equal(b.t, win.buckets[i].t - sec)
        assert.equal(b.durMin, win.buckets[i].durMin)
      })
    }
  }
})

test('the incident is not in a window a day back: every bucket is re-measured from now', () => {
  const hour = REFERENCE_WINDOW
  assert.ok(hour.buckets.some(b => b.w > 0), 'the last hour holds the incident')
  const dayAgo = shiftWindow(hour, DAY)
  assert.ok(dayAgo.buckets.every(b => b.w === 0), 'a day back it never happened')
  assert.ok(dayAgo.buckets.every(b => !b.future))
})

test('yesterday\'s evening has happened, though today\'s has not', () => {
  const today = resolveWindow({ kind: 'preset', value: 'today' })
  const yesterday = shiftWindow(today, DAY)
  // Unless the demo was opened in the last minute of the day, part of Today
  // is still to come.
  if (today.buckets.some(b => b.future)) {
    assert.ok(yesterday.buckets.every(b => !b.future))
    assert.equal(yesterday.pastBuckets.length, yesterday.buckets.length)
    assert.ok(yesterday.pastMinutes > today.pastMinutes)
  }
})

test('an earlier window labels itself by the clock, with its date', () => {
  const w = shiftWindow(REFERENCE_WINDOW, DAY)
  assert.equal(w.trailing, false)
  assert.equal(w.relative, false)
  assert.equal(w.isAbsolute, true)
  assert.match(w.buckets[0].label, /^[A-Z][a-z]{2} \d{2} \d{2}:\d{2}$/)
  assert.match(w.label, /^[A-Z][a-z]{2} \d{2}, \d{2}:\d{2}:\d{2} - /)
  assert.deepEqual(w.exactMs, [w.start * 1000, w.end * 1000])
  // Below a minute's step the label keeps its seconds, as the current
  // window's clock labels do.
  const fiveMin = shiftWindow(resolveWindow({ kind: 'preset', value: '5m' }), 3600)
  assert.match(fiveMin.buckets[1].label, /:\d{2}:\d{2}$/)
})

test('one earlier window per window and shift, so data cached on the window object is built once', () => {
  assert.equal(shiftWindow(REFERENCE_WINDOW, DAY), shiftWindow(REFERENCE_WINDOW, DAY))
  assert.notEqual(shiftWindow(REFERENCE_WINDOW, DAY), shiftWindow(REFERENCE_WINDOW, 7 * DAY))
  assert.equal(shiftWindow(REFERENCE_WINDOW, 0), REFERENCE_WINDOW, 'no shift is the window itself')
})

test('Compare offers production\'s three distances and opens on a day', () => {
  assert.deepEqual(CHART_COMPARE_OPTIONS.map(o => o.label), ['1 hour ago', '1 day ago', '1 week ago'])
  assert.equal(chartCompareOption(DEFAULT_CHART_COMPARE).label, '1 day ago')
  assert.equal(chartCompareOption('nonsense').value, DEFAULT_CHART_COMPARE)
})

/* ---- the modal ---- */

const EXPECTED = /width\(\d+\) and height\(\d+\) of chart|useLayoutEffect does nothing on the server/
function quietly(fn) {
  const { warn, error } = console
  const quiet = log => (...args) => { if (!EXPECTED.test(String(args[0]))) log(...args) }
  console.warn = quiet(warn)
  console.error = quiet(error)
  try { return fn() } finally { Object.assign(console, { warn, error }) }
}

// A view that records every window it is asked to draw and the frame it was
// drawn under.
function recordingView(win) {
  const drawn = []
  function Probe({ w }) {
    const frame = useContext(ChartFrameContext)
    drawn.push({ w, frame })
    return h('div', { className: 'probe' }, w.label)
  }
  return {
    drawn,
    view: { win, comparable: true, value: w => (w === win ? '612 ms' : '140 ms'), render: w => h(Probe, { w }) },
  }
}

test('Expand draws the card\'s chart once, over the page\'s window, in a dialog of its own', () => {
  const { drawn, view } = recordingView(REFERENCE_WINDOW)
  const html = quietly(() => renderToStaticMarkup(h(ChartModal, { mode: 'expand', onMode() {}, onClose() {}, title: 'p90 Latency', view })))
  assert.match(html, /role="dialog" aria-modal="true"/)
  assert.match(html, /p90 Latency<span class="cval">612 ms<\/span><span class="chart-modal-range">Last 1 hour<\/span>/)
  assert.match(html, /aria-label="Close"/)
  assert.match(html, /class="card-menu-btn"/, 'the expanded chart keeps its ⋮')
  assert.doesNotMatch(html, /Compare with/)
  assert.equal(drawn.length, 1)
  assert.equal(drawn[0].w, REFERENCE_WINDOW)
  // The modal's own crosshair group, by index, and a drag that zooms.
  assert.match(drawn[0].frame.syncId, /^chart-modal/)
  assert.equal(drawn[0].frame.syncMethod, 'index')
  assert.equal(drawn[0].frame.brush, true)
})

test('Compare draws the chart over the page\'s window and over the same span a day back, the earlier one undraggable', () => {
  const { drawn, view } = recordingView(REFERENCE_WINDOW)
  const html = quietly(() => renderToStaticMarkup(h(ChartModal, { mode: 'compare', onMode() {}, onClose() {}, title: 'Error %', view })))
  assert.match(html, /Compare with/)
  assert.match(html, /1 day ago/)
  assert.equal(drawn.length, 2)
  const [now, then] = drawn
  assert.equal(now.w, REFERENCE_WINDOW)
  assert.equal(then.w, shiftWindow(REFERENCE_WINDOW, DAY))
  assert.equal(now.frame.syncId, then.frame.syncId, 'one crosshair across both')
  assert.equal(now.frame.brush, true)
  assert.equal(then.frame.brush, false)
  // Both count back from the page's now, so the earlier chart reads "1 day ago".
  assert.equal(then.frame.nowMs, REFERENCE_WINDOW.end * 1000)
  // Each panel carries its window's figure; only the page's carries a ⋮.
  assert.match(html, /Error %<span class="cval">612 ms<\/span>/)
  assert.match(html, /1 day ago<span class="cval">140 ms<\/span>/)
  assert.equal((html.match(/class="card-menu-btn"/g) ?? []).length, 1)
})

/* ---- the corner ---- */

test('a skeleton\'s corner holds the header\'s shape: Expand drawn but disabled, the ⋮ as it was', () => {
  const html = quietly(() => renderToStaticMarkup(h(ChartActions, { title: 'RPM' })))
  assert.match(html, /^<span class="card-actions"><button type="button" class="card-expand-btn" title="Expand RPM" aria-label="Expand RPM" aria-haspopup="dialog" disabled=""/)
  assert.match(html, /<button type="button" class="card-menu-btn" title="RPM options"/)
})

test('inside a modal a card draws no corner of its own', () => {
  const frame = { syncId: 'm', syncMethod: 'index', height: 300, brush: true, nowMs: 0 }
  const rows = REFERENCE_WINDOW.buckets.map(b => ({ t: b.t, label: b.label, exactTime: b.exactTime, value: 40 }))
  const html = quietly(() => renderToStaticMarkup(h(ChartFrameContext.Provider, { value: frame },
    h(CardChart, { title: 'CPU Used %', fmt: fmtPct1, win: REFERENCE_WINDOW, syncId: 's', series: [{ key: 'v', label: 'v', color: '#3B82F6', rows }] }))))
  assert.doesNotMatch(html, /card-actions|card-menu-btn/)
  // The modal's height outranks the card's class.
  assert.match(html, /<div class="chart-host" style="width:100%;height:300px">/)
})
