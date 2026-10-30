// A trace id is looked up in the dataset its URL names, and only there. These
// hold the two halves of that: the backend keeps exactly the behaviour it had
// (including borrowing a seeded trace for an id it has no spans for), and an id
// that is not a mobile request never comes back from the mobile datasource as
// somebody else's backend trace. Then the shape every dataset is assembled
// into, and what the trace page renders for each datasource.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server.browser'
import { createElement } from 'react'
import { resolveTrace, traceViewFor, TRACE_VIEWS, TRACE_TABS } from './traceResolvers.js'
import { buildTrace, assembleTrace, traceSummary, traceInRows } from './traceDetail.js'
import { spanRows, spanRowsForWindow } from './tracesExplorer.js'
import { resolveWindow } from './timeWindow.js'
import { endpointModel, requestSample } from './requestLatency.js'
import { parseRoute, routeUrl, traceUrl } from '@/utils/route'
import TraceDetail from '@/pages/TraceDetail.jsx'

const backendIds = [...new Set(spanRows.map(r => r.traceId))]

test('a backend id resolves exactly as buildTrace builds it', () => {
  for (const id of backendIds.slice(0, 12)) {
    assert.deepEqual(resolveTrace(id), buildTrace(id), id)
    assert.deepEqual(resolveTrace(id, 'traces'), buildTrace(id), id)
  }
  // An id with no spans still borrows a seeded trace on the backend.
  assert.ok(resolveTrace('not-a-real-trace'), 'the backend borrows for an unknown id')
  assert.deepEqual(resolveTrace('not-a-real-trace'), buildTrace('not-a-real-trace'))
})

test('no id, or a datasource with no resolver, is not found', () => {
  assert.equal(resolveTrace(''), null)
  assert.equal(resolveTrace(null), null)
  assert.equal(resolveTrace('', 'mobile'), null)
  assert.equal(resolveTrace(backendIds[0], 'bogus'), null)
})

test('the mobile datasource never hands back a backend trace', () => {
  assert.equal(resolveTrace(backendIds[0], 'mobile'), null, 'a backend span id is not a mobile request')
  assert.equal(resolveTrace('not-a-real-trace', 'mobile'), null)
  assert.equal(resolveTrace('undefined', 'mobile'), null, 'what a crash row\'s missing trace_id used to open')
})

test('each datasource names a list the router can reach, and offers Summary', () => {
  for (const [ds, opts] of Object.entries(TRACE_VIEWS)) {
    assert.ok(opts.listLabel, `${ds} has a list label`)
    assert.equal(parseRoute(routeUrl({ view: opts.listView })).view, opts.listView, `${ds} list is routable`)
    assert.ok(opts.tabs.includes('summary'), `${ds} offers Summary`)
    for (const t of opts.tabs) assert.ok(TRACE_TABS.includes(t), `${ds}: ${t} is a real tab`)
    assert.ok(opts.searchPlaceholder, `${ds} has a search example`)
    // The datasource round-trips through the URL under the same name.
    const [path, query = ''] = traceUrl('abc', ds).split('?')
    assert.equal(parseRoute(path, query ? `?${query}` : '').datasource ?? 'traces', ds)
  }
  assert.deepEqual(TRACE_VIEWS.traces.tabs, TRACE_TABS)
  assert.equal(TRACE_VIEWS.traces.checkLogs, true)
  assert.deepEqual(TRACE_VIEWS.mobile.tabs, ['summary', 'errors'])
  assert.equal(TRACE_VIEWS.mobile.checkLogs, false)
  assert.equal(TRACE_VIEWS.mobile.listLabel, 'Mobile Traces')
  assert.equal(TRACE_VIEWS.mobile.listView, 'mtraces')
  assert.equal(traceViewFor('bogus'), TRACE_VIEWS.traces)
  assert.equal(traceViewFor(undefined), TRACE_VIEWS.traces)
})

// A device's request, as a mobile resolver would shape it: one span, no parent.
const startTime = new Date('2026-10-09T10:00:00.000Z')
const oneSpan = {
  id: '0000000000000001', parentId: null, depth: 0,
  name: 'HTTP POST api.cubedemo.com', service: 'Cubedemo Shop', kind: 'client', category: 'http',
  start: 0, startTime, duration: 412.5, status: 'error', httpStatus: '502', db: false,
  exception: { type: 'HTTPError', message: 'HTTP 502', stack: '' },
  childIds: [], tags: { eventType: 'MobileRequestError', status_code: '502' },
}

test('a one-span trace assembles into the shape every view reads', () => {
  const t = assembleTrace('mob_abc', [oneSpan])
  assert.equal(t.traceId, 'mob_abc')
  assert.equal(t.root, oneSpan)
  assert.deepEqual(t.spans, [oneSpan])
  assert.deepEqual(Object.keys(t.byId), [oneSpan.id])
  assert.equal(t.totalMs, 412.5)
  assert.equal(t.failed, true)
  assert.equal(t.origin, null)
  assert.equal(t.startTime.getTime(), startTime.getTime())
  assert.deepEqual(t.services, ['Cubedemo Shop'])
  assert.deepEqual(t.errors, [oneSpan])
  assert.equal(assembleTrace('mob_abc', []), null)
  assert.equal(assembleTrace('', [oneSpan]), null)
})

test('Summary lists the root when it is the only span, and leaves it out otherwise', () => {
  const rows = traceSummary(assembleTrace('mob_abc', [oneSpan]))
  assert.equal(rows.length, 1)
  assert.equal(rows[0].slowestId, oneSpan.id)
  assert.equal(rows[0].count, 1)
  assert.equal(rows[0].pct, 100)

  const t = buildTrace(backendIds[0])
  assert.ok(t.spans.length > 1)
  const counted = traceSummary(t).reduce((n, r) => n + r.count, 0)
  assert.equal(counted, t.spans.length - 1, 'every span but the root')
})

const noop = () => {}
const render = (traceId, datasource) => renderToStaticMarkup(createElement(TraceDetail, {
  traceId, datasource, goHome: noop, goTraces: noop, goLogs: noop,
  timeRange: { kind: 'preset', value: '1h' }, setTimeRange: noop, settingsOpen: false, setSettingsOpen: noop,
}))

test('a backend trace keeps its breadcrumb, every tab and Check Logs', () => {
  const t = buildTrace(backendIds[0])
  const html = render(backendIds[0])
  assert.match(html, />Traces</)
  assert.doesNotMatch(html, /Mobile Traces/)
  assert.match(html, /Check Logs/)
  assert.match(html, />Database</)
  assert.match(html, />Profiles</)
  assert.match(html, new RegExp(`${t.spans.length} spans across ${t.services.length} services?`))
})

test('an id the mobile datasource does not hold is a real not-found page', () => {
  const html = render('not-a-mobile-request', 'mobile')
  assert.match(html, /not found/)
  assert.match(html, /not-a-mobile-request/)
  assert.match(html, /Back to Mobile Traces/)
  assert.doesNotMatch(html, /Check Logs/)
  assert.doesNotMatch(html, /Waterfall/)
})

// The Traces explorer draws its rows for the range picked, and a seeded
// trace's id repeats across ranges over different spans, so the id alone
// (buildTrace, read against the reference hour) names another request, or a
// borrowed one, off that hour. traceInRows reads the row's own trace from the
// rows on screen; these hold it to that in every range, and to buildTrace's
// decoding for the ids that carry their request.
test('every explorer row\'s span is in the trace traceInRows reads for it, in every range', () => {
  for (const value of ['5m', '15m', '1h', '3h', '24h', '7d']) {
    const rows = spanRowsForWindow(resolveWindow({ kind: 'preset', value }))
    const cache = new Map()
    let missing = 0
    let offRef = 0
    for (const r of rows) {
      if (!cache.has(r.traceId)) cache.set(r.traceId, traceInRows(r.traceId, rows))
      const t = cache.get(r.traceId)
      const sp = t?.byId[r.spanId]
      if (!sp) { missing++; continue }
      // A span row is its span: same start, same duration, at the row's own time.
      if (r.tags['event.domain'] === 'span') {
        assert.equal(sp.startTime.getTime(), r.time.getTime(), `${value} ${r.id}`)
        assert.equal(sp.duration, r.durationNs / 1e6, `${value} ${r.id}`)
      }
      if (!buildTrace(r.traceId)?.byId[r.spanId]) offRef++
    }
    assert.equal(missing, 0, `${value}: rows whose span is not in their trace`)
    // The case it exists for: off the reference hour, the id alone misses.
    if (value !== '1h') assert.ok(offRef > 0, `${value}: buildTrace alone found every span, so traceInRows is not needed here`)
  }
})

test('an id that carries its request still decodes whole, whatever the rows hold', () => {
  const win = resolveWindow({ kind: 'preset', value: '1h' })
  const [req] = requestSample(endpointModel('payment-service', 'POST /v1/payments'), win, {}, 1)
  assert.ok(req, 'a modelled request')
  const whole = buildTrace(req.traceId)
  assert.ok(whole.spans.length > 1)
  // The stream holds only the sampled span; the trace is still the request.
  const stray = { traceId: req.traceId, spanId: whole.root.id, tags: { 'event.domain': 'span' } }
  assert.deepEqual(traceInRows(req.traceId, [stray]), whole)
  assert.equal(traceInRows('', []), null)
})
