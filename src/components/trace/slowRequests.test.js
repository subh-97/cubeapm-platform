// The Slow Requests panel: what a selection scopes the list to and says, the
// Traces link it makes and that the link lands on the very requests the panel
// listed, and the panel's markup in each state (server-rendered, so the states
// are reached through the initial* props rather than by dragging).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server.browser'
import { createElement as h } from 'react'
import { resolveWindow, REFERENCE_WINDOW, BASE_TIME } from '@/data/timeWindow'
import { redEndpointsForWindow } from '@/data/services'
import { spanRowsForWindow } from '@/data/tracesExplorer'
import { endpointModel, latencyGrid, slowThresholdNs, requestSample } from '@/data/requestLatency'
import { filtersToChips, mergeErrorSpans, traceSamplesFor } from '@/utils/tracesHandoff'
import { applyChipsToLog, chipsToString } from '@/components/QueryBuilder'
import { tryParseConditions } from '@/utils/rawQuery'
import { getSpanFieldValue } from '@/utils/traceFields'
import {
  NO_SELECTION, edgeNs, selectionScope, selectionLabel, durationLiteral, tracesFilters, tracesRange, axisRange,
  histogramCounts, columnsOf, timeOfColumns, emptyListText,
} from './slowRequests.js'
import SlowRequestsPanel from './SlowRequestsPanel.jsx'

const SVC = 'payment-service'
const CAPTURE = 'POST /v1/payments/:id/capture'
const NOW = BASE_TIME.getTime()
const win = REFERENCE_WINDOW

test('a latency selection scopes the list to whole buckets, half-open', () => {
  const sel = { lat: [17, 25], time: null }
  assert.deepEqual(selectionScope(sel, 5e8), { loNs: 8799000, hiNs: 27830000, fromMs: -Infinity, toMs: Infinity })
  // Nothing selected: the window's slow tail.
  assert.deepEqual(selectionScope(NO_SELECTION, 5e8), { loNs: 5e8, hiNs: Infinity, fromMs: -Infinity, toMs: Infinity })
  const both = selectionScope({ lat: [17, 25], time: [1000, 2000] }, 5e8)
  assert.equal(both.fromMs, 1000)
  assert.equal(both.toMs, 2000)
})

test('a selection reads the way production\'s does, in the app\'s 24-hour time', () => {
  assert.equal(selectionLabel({ lat: [17, 25], time: null }), 'Latency: 8.8 ms - 27.83 ms')
  const from = new Date(2026, 9, 26, 12, 53).getTime()
  const to = new Date(2026, 9, 26, 13, 43).getTime()
  assert.equal(selectionLabel({ lat: [17, 29], time: [from, to] }), 'Latency: 8.8 ms - 46.42 ms, Time: Oct 26, 12:53:00 - Oct 26, 13:43:00')
  assert.equal(selectionLabel(NO_SELECTION), '')
})

test('the Traces link says the band exactly, never the rounded label', () => {
  assert.equal(durationLiteral(8799000), '8.799ms')
  assert.equal(durationLiteral(27830000), '27.83ms')
  assert.equal(durationLiteral(519412000), '519.412ms')
  const filters = tracesFilters({ serviceId: SVC, endpoint: CAPTURE, scope: { loNs: 8799000, hiNs: 27830000 } })
  assert.deepEqual(filters, [
    { field: 'service', value: SVC },
    { field: 'span_kind', value: 'server' },
    { field: 'span_name', value: CAPTURE },
    { field: 'duration', op: 'gte', value: '8.799ms' },
    { field: 'duration', op: 'lt', value: '27.83ms' },
  ])
  // The slow tail has no upper bound, and nothing at all has no lower one.
  assert.equal(tracesFilters({ serviceId: SVC, endpoint: CAPTURE, scope: { loNs: 5e8, hiNs: Infinity } }).length, 4)
  assert.equal(tracesFilters({ serviceId: SVC, endpoint: CAPTURE, scope: { loNs: 0, hiNs: Infinity } }).length, 3)
})

test('a time selection hands Traces exactly its columns, clipped to now', () => {
  assert.equal(tracesRange({ lat: [1, 2], time: null }, NOW), null)
  assert.deepEqual(tracesRange({ lat: null, time: [NOW - 120000, NOW - 60000] }, NOW), { kind: 'absolute', from: NOW - 120000, to: NOW - 60000 })
  assert.deepEqual(tracesRange({ lat: null, time: [NOW - 60000, NOW + 60000] }, NOW), { kind: 'absolute', from: NOW - 60000, to: NOW })
  assert.equal(tracesRange({ lat: null, time: [NOW + 1, NOW + 60000] }, NOW), null)
})

test('the axis spans every bucket that holds a request, and any bucket selected', () => {
  const grid = latencyGrid(endpointModel(SVC, CAPTURE), win)
  assert.deepEqual(axisRange(grid, NO_SELECTION), [grid.k0, grid.k1])
  assert.deepEqual(axisRange(grid, { lat: [grid.k1 + 2, grid.k1 + 4], time: null }), [grid.k0, grid.k1 + 4])
  assert.equal(axisRange({ ...grid, total: 0 }, NO_SELECTION), null)
})

test('the bars count the window, or just the selected time', () => {
  const grid = latencyGrid(endpointModel(SVC, CAPTURE), win)
  const axis = axisRange(grid, NO_SELECTION)
  const all = histogramCounts(grid, axis)
  assert.deepEqual(all, Array.from(grid.bucketTotals))
  const cols = [win.buckets.length - 10, win.buckets.length - 1]
  const time = timeOfColumns(win, ...cols)
  assert.deepEqual(columnsOf(win, time), cols, 'columns and time round-trip')
  const slice = histogramCounts(grid, axis, time)
  const want = new Array(all.length).fill(0)
  for (let c = cols[0]; c <= cols[1]; c++) grid.counts[c].forEach((v, i) => { want[i] += v })
  assert.deepEqual(slice, want)
})

test('an emptied list says what it holds none of, and where', () => {
  assert.equal(emptyListText({ lat: [17, 25], time: null }, win), 'No requests between 8.8 ms and 27.83 ms in the last 1 hour')
  assert.equal(emptyListText({ lat: [17, 25], time: [1, 2] }, win), 'No requests between 8.8 ms and 27.83 ms in the selected time')
  assert.equal(emptyListText(NO_SELECTION, win), 'No requests in the last 1 hour')
})

// The promise "View in Traces lands on the requests the panel listed", followed
// all the way: the link's filters through App's chips, through the query text
// (Copy, recents, a pasted query), into the Traces stream for the window the
// link opens on, filtered as the page filters.
function assertLands(w, endpoint, sel) {
  const model = endpointModel(SVC, endpoint)
  const now = w.nowSec * 1000
  const scope = selectionScope(sel, slowThresholdNs(model, w), now)
  const chips = filtersToChips(tracesFilters({ serviceId: SVC, endpoint, scope }))
  const back = tryParseConditions(chipsToString(chips))
  assert.ok(back?.chips, `the query text parses: ${chipsToString(chips)}`)
  const range = tracesRange(sel, now)
  const tw = range ? resolveWindow(range) : w
  const stream = mergeErrorSpans(spanRowsForWindow(tw), traceSamplesFor(tw, back.chips))
  const landed = stream.filter(r => applyChipsToLog(r, back.chips, getSpanFieldValue))
  const ids = new Set(landed.map(r => r.traceId))
  const what = `${w.label} ${endpoint} ${JSON.stringify(sel)}`
  for (const limit of [5, 100]) {
    for (const row of requestSample(model, w, scope, limit)) {
      assert.ok(ids.has(row.traceId), `${what}: ${row.traceId} (${row.latencyMs} ms, ${row.timestamp}) landed`)
    }
  }
  for (const r of landed) {
    assert.equal(r.tags.span_name, endpoint)
    assert.ok(r.durationNs >= scope.loNs && r.durationNs < scope.hiNs, `${what}: inside the band`)
    if (range) assert.ok(r.time.getTime() >= range.from && r.time.getTime() < range.to, `${what}: inside the selected time`)
  }
}

const pastCols = w => w.buckets.filter(b => !b.future).length

test('every View in Traces link lands on the panel\'s own requests, and only in its band', () => {
  const windows = ['5m', '1h', '24h'].map(v => (v === '1h' ? REFERENCE_WINDOW : resolveWindow({ kind: 'preset', value: v })))
  for (const w of windows) {
    for (const e of redEndpointsForWindow(w)) {
      const grid = latencyGrid(endpointModel(SVC, e.endpoint), w)
      const mid = grid.k0 + Math.floor((grid.k1 - grid.k0) / 2)
      const n = pastCols(w)
      const selections = [
        NO_SELECTION,
        { lat: [mid - 1, mid + 1], time: null },
        { lat: [grid.k0, mid], time: timeOfColumns(w, n - 6, n - 2) },
      ]
      for (const sel of selections) assertLands(w, e.endpoint, sel)
    }
  }
})

// The spans Traces would otherwise open on a different span of: a selection
// that runs up to now (the query step would floor the range's end), a long
// one starting on a column the Traces chart step does not align to (its start
// floors earlier), and Today, whose columns run past now.
test('a wide or odd time selection lands too: up to now, off the chart step, and on Today', () => {
  const at = v => resolveWindow({ kind: 'preset', value: v })
  const cases = []
  for (const v of ['12h', '24h', '7d', 'today']) {
    const w = at(v)
    const n = pastCols(w)
    cases.push([w, [n - 1, n - 1]], [w, [Math.max(0, n - 13), n - 1]], [w, [0, n - 1]])
  }
  const week = at('7d')
  for (const c0 of [15, 16]) cases.push([week, [c0, c0 + 39]])
  for (const [w, [c0, c1]] of cases) {
    const grid = latencyGrid(endpointModel(SVC, CAPTURE), w)
    const time = timeOfColumns(w, c0, c1)
    assertLands(w, CAPTURE, { lat: null, time })
    assertLands(w, CAPTURE, { lat: [grid.k0 + 2, grid.k1], time })
  }
})

test('a query naming no service-page endpoint pulls in none of its requests', () => {
  for (const chips of [
    [{ field: 'service', op: 'eq', value: SVC }],
    [{ field: 'span_name', op: 'neq', value: CAPTURE }],
    [{ field: 'span_name', op: 'eq', value: 'POST /v1/payment' }],
  ]) {
    assert.ok(traceSamplesFor(win, chips).every(r => !r.id?.startsWith('req_')), JSON.stringify(chips))
  }
})

// ---- the panel ----

const EXPECTED = /useLayoutEffect does nothing on the server/
function panel(props) {
  const { warn, error } = console
  const quiet = log => (...args) => { if (!EXPECTED.test(String(args[0]))) log(...args) }
  console.warn = quiet(warn)
  console.error = quiet(error)
  try {
    return renderToStaticMarkup(h(SlowRequestsPanel, { serviceId: SVC, endpoint: CAPTURE, win, ...props }))
  } finally {
    Object.assign(console, { warn, error })
  }
}
const rowsOf = html => [...html.matchAll(/<div class="dur">([^<]*)<\/div>/g)].map(m => m[1])
const count = (html, needle) => html.split(needle).length - 1

test('on mount: the histogram, the slowest tenth listed, five of them, and a hint', () => {
  const html = panel()
  assert.match(html, /<div class="panel-head-left">Slow Requests<\/div>/)
  // "5 results", in the platform's filter dropdown: the value alone, the
  // label kept for its title and its name.
  assert.match(html, /class="subtab-filters srq-limit"><div class="filter-select"[^>]*title="Show: 5 results" aria-label="Show: 5 results"[^>]*><span class="filter-value"><span>5 results<\/span>/)
  assert.doesNotMatch(html, /class="filter-label"/)
  // "Show preview", labelled as Sort by is, and a radio group of three.
  assert.match(html, /<span class="sort-lbl" id="([^"]+)">Show preview<\/span><div class="seg-toggle srq-views" role="radiogroup" aria-labelledby="\1">/)
  assert.deepEqual([...html.matchAll(/role="radio" data-view="(\w+)"/g)].map(m => m[1]), ['histogram', 'heatmap', 'none'])
  // The preview choice is in the head; Sort by and "Show 5 results" are on
  // the list's bar, under the chart and over the rows they order and count.
  const views = html.indexOf('role="radiogroup"')
  assert.ok(html.indexOf('class="panel-head-right"') < views && views < html.indexOf('class="srq"'), 'Show preview in the head')
  const bar = html.indexOf('class="rts-list-bar"')
  assert.ok(html.indexOf('class="srq"') < bar && bar < html.indexOf('>Sort by<'), 'Sort by on the list bar')
  assert.ok(bar < html.indexOf('srq-limit') && html.indexOf('srq-limit') < html.indexOf('class="slowreq-row'), '"5 results" on the bar, before the rows')
  assert.match(html, /aria-checked="true" tabindex="0" class="seg active">Histogram<\/button>/)
  assert.match(html, /<span class="srq-hint">Drag on the chart to filter by latency(<!-- -->)?<\/span>/, 'production\'s hint, and only it')
  assert.doesNotMatch(html, /Listing the slowest/)
  assert.doesNotMatch(html, /srq-sel/)
  const grid = latencyGrid(endpointModel(SVC, CAPTURE), win)
  assert.equal(count(html, 'class="lat-bar"'), grid.bucketTotals.filter(v => v > 0).length)
  assert.equal(rowsOf(html).length, 5)
  // The chart sits between the head and the list.
  assert.ok(html.indexOf('class="srq"') > html.indexOf('panel-head') && html.indexOf('class="srq"') < html.indexOf('slowreq-split'))
})

test('a latency selection: its summary, Clear and View in Traces, and the bars outside it faded', () => {
  const grid = latencyGrid(endpointModel(SVC, CAPTURE), win)
  const lat = [grid.k0 + 3, grid.k0 + 8]
  const html = panel({ initialSelection: { lat, time: null } })
  assert.match(html, new RegExp(`<span class="srq-sel" title="${selectionLabel({ lat, time: null })}">`))
  assert.match(html, />Clear<\/button>/)
  assert.match(html, /View in Traces/)
  assert.ok(count(html, 'fill-opacity="0.3"') > 0, 'bars outside are faded')
  for (const d of rowsOf(html)) {
    const ms = parseFloat(d)
    assert.ok(ms * 1e6 >= edgeNs(lat[0]) && ms * 1e6 < edgeNs(lat[1] + 1), d)
  }
})

test('the heatmap with a latency-and-time selection says both', () => {
  const grid = latencyGrid(endpointModel(SVC, CAPTURE), win)
  const time = timeOfColumns(win, 40, 55)
  const html = panel({ initialView: 'heatmap', initialSelection: { lat: [grid.k0, grid.k1], time } })
  assert.match(html, /aria-checked="true" tabindex="0" class="seg active">Heatmap<\/button>/)
  assert.match(html, /Latency: [^,]+, Time: /)
  assert.ok(count(html, 'class="lat-cell"') > 100)
})

test('Show preview None: no chart and no hint — only the list, under a selection\'s line if one is in force', () => {
  const plain = panel({ initialView: 'none' })
  assert.match(plain, /aria-checked="true" tabindex="0" class="seg active">None<\/button>/)
  assert.doesNotMatch(plain, /lat-plot|srq-hint|srq-sub/)
  assert.match(plain, /class="srq is-hidden"><div class="sr-only" role="status"/, 'the live region stays, alone')
  assert.equal(rowsOf(plain).length, 5)
  const grid = latencyGrid(endpointModel(SVC, CAPTURE), win)
  const lat = [grid.k0 + 3, grid.k0 + 8]
  const selected = panel({ initialView: 'none', initialSelection: { lat, time: null } })
  assert.doesNotMatch(selected, /lat-plot/)
  assert.match(selected, /class="srq is-bare">/)
  assert.match(selected, new RegExp(`<span class="srq-sel" title="${selectionLabel({ lat, time: null })}">`))
  assert.match(selected, />Clear<\/button>/)
  assert.match(selected, /View in Traces/)
  for (const d of rowsOf(selected)) {
    const ms = parseFloat(d)
    assert.ok(ms * 1e6 >= edgeNs(lat[0]) && ms * 1e6 < edgeNs(lat[1] + 1), `${d}: the hidden chart's selection still filters`)
  }
})

test('a range with no requests says so, in the chart and in the list', () => {
  const later = resolveWindow({ kind: 'absolute', from: NOW + 3600000, to: NOW + 7200000 })
  const html = panel({ win: later })
  assert.match(html, /class="srq-nochart">No requests in this range/)
  assert.match(html, /class="srq-empty"><span>No requests in this range<\/span>/)
})
