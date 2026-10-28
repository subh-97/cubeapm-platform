// The Slow Requests panel's requests: that the charts and the list count the
// same requests, that a request is the same request in every window, that its
// id carries it whole, and how far its p90 sits from the RED table's.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveWindow, REFERENCE_WINDOW, BASE_TIME } from './timeWindow'
import { redEndpointsForWindow } from './services'
import { errorSpanRowsForWindow } from './errors'
import { browserTracesForWindow, BROWSER_APPS } from './browser'
import { spanRows } from './tracesExplorer'
import { buildTrace } from './traceDetail'
import {
  endpointModel, latencyGrid, slowThresholdNs, requestSample, encodeRequestId, decodeRequestId,
  requestTraceRows, requestSpanRows,
} from './requestLatency.js'
import { edgeMs } from '@/utils/latencyBuckets'

const SVC = 'payment-service'
const RED = redEndpointsForWindow(REFERENCE_WINDOW)
const CAPTURE = 'POST /v1/payments/:id/capture'
const preset = v => (v === '1h' ? REFERENCE_WINDOW : resolveWindow({ kind: 'preset', value: v }))
const WINDOWS = ['5m', '15m', '1h', '3h', '24h', '7d'].map(v => [v, preset(v)])
const edgeNs = k => Math.round(edgeMs(k) * 1e6)

test('the grid counts every request once: rows sum to bars, bars to the total', () => {
  for (const [v, win] of WINDOWS) {
    for (const e of RED) {
      const g = latencyGrid(endpointModel(SVC, e.endpoint), win)
      assert.ok(g.total > 0, `${v} ${e.endpoint} has requests`)
      assert.equal(g.counts.length, win.buckets.length, 'one column per window bucket')
      const bars = g.bucketTotals.reduce((a, b) => a + b, 0)
      const cols = g.colTotals.reduce((a, b) => a + b, 0)
      assert.equal(bars, g.total)
      assert.equal(cols, g.total)
      assert.ok(g.bucketTotals[0] > 0 && g.bucketTotals[g.bucketTotals.length - 1] > 0, 'the axis is trimmed to buckets that hold requests')
      win.buckets.forEach((b, c) => { if (b.future) assert.equal(g.colTotals[c], 0, 'nothing in a future bucket') })
    }
  }
})

test('the rate is the RED table\'s: a window holds about rpm × minutes requests', () => {
  for (const e of RED) {
    const g = latencyGrid(endpointModel(SVC, e.endpoint), REFERENCE_WINDOW)
    const expected = e.rpm * REFERENCE_WINDOW.pastMinutes
    assert.ok(Math.abs(g.total - expected) / expected < 0.02, `${e.endpoint}: ${g.total} vs ${expected}`)
  }
})

test('every bar that holds requests lists some, and the list never exceeds what is there', () => {
  for (const [v, win] of WINDOWS.filter(([v]) => ['5m', '1h', '24h'].includes(v))) {
    const model = endpointModel(SVC, CAPTURE)
    const g = latencyGrid(model, win)
    g.bucketTotals.forEach((n, i) => {
      const rows = requestSample(model, win, { loNs: edgeNs(g.k0 + i), hiNs: edgeNs(g.k0 + i + 1) }, 5)
      assert.equal(rows.length, Math.min(5, n), `${v} bucket ${g.k0 + i} (${n} requests)`)
      for (const r of rows) assert.ok(r.durationNs >= edgeNs(g.k0 + i) && r.durationNs < edgeNs(g.k0 + i + 1))
    })
  }
})

// Exactly, not just "some": a bar counts the requests its list draws from, on
// windows whose minutes are all split into 15 s columns (counted one by one)
// as well as whole ones (counted from the CDF), every endpoint.
test('every bar holds exactly the requests its band lists', () => {
  for (const [v, win] of WINDOWS.filter(([v]) => ['5m', '15m', '1h'].includes(v))) {
    for (const e of RED) {
      const model = endpointModel(SVC, e.endpoint)
      const g = latencyGrid(model, win)
      g.bucketTotals.forEach((n, i) => {
        const all = requestSample(model, win, { loNs: edgeNs(g.k0 + i), hiNs: edgeNs(g.k0 + i + 1) }, 1e6)
        assert.equal(all.length, n, `${v} ${e.endpoint} bucket ${g.k0 + i}`)
      })
    }
  }
})

test('a lower bound under a microsecond admits every request', () => {
  const model = endpointModel(SVC, CAPTURE)
  const every = requestSample(model, REFERENCE_WINDOW, {}, 50).map(r => r.traceId)
  for (const loNs of [1, 5, 400]) {
    assert.deepEqual(requestSample(model, REFERENCE_WINDOW, { loNs }, 50).map(r => r.traceId), every, `loNs ${loNs}`)
  }
})

test('nothing before what a trace id can name: a range over two years back holds no requests', () => {
  const day = 86400000
  const from = BASE_TIME.getTime() - 900 * day
  const old = resolveWindow({ kind: 'absolute', from, to: from + 3600000 })
  const model = endpointModel(SVC, CAPTURE)
  assert.equal(latencyGrid(model, old).total, 0)
  assert.deepEqual(requestSample(model, old, {}, 5), [])
})

test('a cell lists the requests it counts: latency and time both inside', () => {
  const win = REFERENCE_WINDOW
  const model = endpointModel(SVC, CAPTURE)
  const g = latencyGrid(model, win)
  let checked = 0
  g.counts.forEach((row, c) => row.forEach((n, i) => {
    if (!n || checked > 200) return
    checked++
    const fromMs = win.buckets[c].ms
    const toMs = fromMs + win.step * 1000
    const rows = requestSample(model, win, { loNs: edgeNs(g.k0 + i), hiNs: edgeNs(g.k0 + i + 1), fromMs, toMs }, 100)
    assert.equal(rows.length, Math.min(100, n), `column ${c}, bucket ${g.k0 + i}`)
    for (const r of rows) assert.ok(r.timeMs >= fromMs && r.timeMs < toMs)
  }))
  assert.ok(checked > 50)
})

test('the list is a spread of its scope, newest first, and a longer list contains a shorter one', () => {
  const model = endpointModel(SVC, CAPTURE)
  for (const [v, win] of WINDOWS) {
    const thr = slowThresholdNs(model, win)
    const five = requestSample(model, win, { loNs: thr }, 5)
    const hundred = requestSample(model, win, { loNs: thr }, 100)
    assert.equal(five.length, 5, `${v}: the default list is full`)
    for (const r of hundred) assert.ok(r.durationNs >= thr, 'every row is in scope')
    for (let i = 1; i < hundred.length; i++) assert.ok(hundred[i - 1].timeMs >= hundred[i].timeMs, 'newest first')
    const ids = new Set(hundred.map(r => r.traceId))
    for (const r of five) assert.ok(ids.has(r.traceId), `${v}: ${r.traceId} is among the hundred`)
    // Spread across the scope rather than bunched at its newest end.
    const span = win.pastMinutes * 60000
    assert.ok(hundred[0].timeMs - hundred[hundred.length - 1].timeMs > span * 0.2, `${v}: spread`)
  }
})

test('a request is the same request in every window that covers it', () => {
  const model = endpointModel(SVC, CAPTURE)
  const narrow = preset('15m')
  const wide = REFERENCE_WINDOW
  const rows = requestSample(model, narrow, {}, 50)
  // Last 15 minutes runs on into the current minute; Last 1 hour stops at it.
  const covered = rows.filter(r => r.timeMs < wide.end * 1000)
  assert.ok(covered.length > 30)
  for (const r of covered) {
    // The same latency and time found again, counted in the wider window.
    const again = requestSample(model, wide, { loNs: r.durationNs, hiNs: r.durationNs + 1, fromMs: r.timeMs, toMs: r.timeMs + 1 }, 10)
    assert.ok(again.some(x => x.traceId === r.traceId), `${r.traceId} in Last 1 hour`)
  }
  // And an absolute range over the same minutes holds the same requests.
  const from = narrow.start * 1000
  const abs = resolveWindow({ kind: 'absolute', from, to: narrow.end * 1000 })
  const absRows = requestSample(model, abs, {}, 50)
  assert.deepEqual(absRows.map(r => r.traceId), rows.map(r => r.traceId))
})

test('slow is the window\'s slowest tenth of requests', () => {
  for (const [v, win] of WINDOWS) {
    const model = endpointModel(SVC, CAPTURE)
    const g = latencyGrid(model, win)
    const thr = slowThresholdNs(model, win)
    // Count the scope exactly, through the list: with a limit past the total it
    // lists all of it.
    const all = requestSample(model, win, { loNs: thr }, g.total)
    const want = g.total - Math.floor(0.9 * g.total)
    assert.ok(all.length >= want && all.length <= want + 3, `${v}: ${all.length} slow of ${g.total} (want ${want})`)
  }
})

// The RED table's p90 is a p90 of minutes (windowQuantile weights each minute's
// p90 by its rate); the panel's is over requests. Pinned so a change that moves
// either one is noticed — see docs/decisions/slow-requests-latency.md.
test('the request-level p90 against the p90 card: close at 5 minutes and a day or more, apart at an hour', () => {
  const ratio = v => {
    const win = preset(v)
    return redEndpointsForWindow(win).map(e => (slowThresholdNs(endpointModel(SVC, e.endpoint), win) / 1e6) / e.p90)
  }
  // BASE_TIME is when the suite runs, and the jitter is keyed on the clock, so
  // each run reads a few percent either way: the bands allow for it and still
  // tell "close" from "a third apart".
  for (const r of ratio('5m')) assert.ok(r > 0.85 && r < 1.15, `5m ${r}`)
  for (const r of ratio('1h')) assert.ok(r > 0.55 && r < 0.8, `1h ${r}`)
  for (const r of ratio('24h')) assert.ok(r > 0.88 && r < 1.12, `24h ${r}`)
  for (const r of ratio('7d')) assert.ok(r > 0.88 && r < 1.12, `7d ${r}`)
})

test('an id carries its request whole, and decodes to nothing else', () => {
  const ref = { offsetMs: 123456, svcIdx: 0, ep: endpointModel(SVC, CAPTURE).ep, rank: 42, us: 612345 }
  const id = encodeRequestId(ref)
  assert.match(id, /^[0-9a-f]{32}$/)
  const back = decodeRequestId(id)
  assert.equal(back.timeMs, BASE_TIME.getTime() - 123456)
  assert.equal(back.endpoint, CAPTURE)
  assert.equal(back.rank, 42)
  assert.equal(back.durationNs, 612345000)
  // Nobody else's ids: the Errors page's samples, the Browser page's, the seeded
  // Traces stream's, the legacy short ids, and noise.
  const foreign = [
    ...errorSpanRowsForWindow(REFERENCE_WINDOW).slice(0, 40).map(r => r.traceId),
    ...BROWSER_APPS.flatMap(a => browserTracesForWindow(REFERENCE_WINDOW, a.id, { limit: 20 }).map(r => r.traceId)),
    ...spanRows.slice(0, 60).map(r => r.traceId),
    '9f2a1c7e', '469567625', 'not-a-real-trace', 'f'.repeat(32), '0'.repeat(32),
  ]
  for (const f of foreign) assert.equal(decodeRequestId(f), null, f)
  // And a request id is nobody else's either: buildTrace finds it as a request.
  const row = requestSample(endpointModel(SVC, CAPTURE), REFERENCE_WINDOW, {}, 1)[0]
  const trace = buildTrace(row.traceId)
  assert.ok(trace, 'it opens')
})

test('a request\'s trace is that request: its endpoint, its service, exactly as long', () => {
  const model = endpointModel(SVC, CAPTURE)
  for (const row of requestSample(model, REFERENCE_WINDOW, {}, 20)) {
    const rows = requestTraceRows(row.traceId)
    const root = rows[0]
    assert.equal(root.spanName, CAPTURE)
    assert.equal(root.service, SVC)
    assert.equal(root.spanKind, 'server')
    assert.equal(root.durationNs, row.durationNs)
    assert.equal(root.time.getTime(), row.timeMs)
    const end = row.timeMs + row.durationNs / 1e6
    for (const s of rows) {
      assert.equal(s.traceId, row.traceId)
      assert.ok(s.time.getTime() + s.durationNs / 1e6 <= end + 1, `${s.spanName} ends inside the root`)
    }
    assert.deepEqual(requestTraceRows(row.traceId).map(s => s.id), rows.map(s => s.id), 'the same rows every time')
    const trace = buildTrace(row.traceId)
    assert.ok(Math.abs(trace.totalMs - row.durationNs / 1e6) < 1, 'the waterfall is as long as the row')
    assert.deepEqual(requestSpanRows([row]).map(s => s.spanId), [root.spanId])
  }
})

test('the page\'s service is the requests\' service, and an endpoint the table does not list still draws', () => {
  const order = endpointModel('order-service', CAPTURE)
  const row = requestSample(order, REFERENCE_WINDOW, {}, 1)[0]
  assert.equal(row.service, 'order-service')
  assert.equal(requestTraceRows(row.traceId)[0].service, 'order-service')
  assert.equal(endpointModel('payment-service', 'GET /v1/never-heard-of-it'), null, 'no profile, no figures: nothing to model')
  const odd = endpointModel(SVC, 'GET /v1/never-heard-of-it', { rpm: 30, p90: 220 })
  const g = latencyGrid(odd, REFERENCE_WINDOW)
  assert.ok(Math.abs(g.total - 30 * 60) < 120)
  const oddRow = requestSample(odd, REFERENCE_WINDOW, {}, 1)[0]
  assert.equal(decodeRequestId(oddRow.traceId).endpoint, 'GET /v1/never-heard-of-it')
})
