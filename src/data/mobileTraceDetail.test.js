// A mobile trace: the one request a phone reported under a trace id, rebuilt
// from the id alone and shown as a trace of one span.
//
// These pin what the trace page promises for `/trace/<id>?datasource=mobile`:
// every request and install the Mobile Traces table links to opens as exactly
// that record — its name, its duration, its outcome — whichever window it was
// opened from or after a reload; a failed request is the span's error; the
// record's attributes come through as it reported them; and an id that is not
// a mobile request is "not found", never a backend trace in its place.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server.browser'
import { createElement } from 'react'
import { resolveWindow } from './timeWindow.js'
import { mobileRowsForWindow, mobileReferenceRows } from './mobileTracesExplorer.js'
import { buildMobileTrace } from './mobileTraceDetail.js'
import { resolveTrace } from './traceResolvers.js'
import { traceSummary } from './traceDetail.js'
import { spanRows } from './tracesExplorer.js'
import TraceDetail from '@/pages/TraceDetail.jsx'

const rows = mobileReferenceRows
const isRequest = r => r.tags.eventType === 'MobileRequest' || r.tags.eventType === 'MobileRequestError'
const requests = rows.filter(isRequest)
const traced = rows.filter(r => r.traceId)

test('every request in the reference hour opens as a one-span trace of that request', () => {
  assert.ok(requests.length > 50, `only ${requests.length} requests`)
  for (const r of requests) {
    const t = resolveTrace(r.traceId, 'mobile')
    assert.ok(t, `${r.traceId} did not resolve`)
    assert.equal(t.traceId, r.traceId)
    assert.equal(t.spans.length, 1)
    const s = t.root
    assert.equal(s, t.spans[0])
    assert.equal(s.parentId, null)
    assert.equal(s.depth, 0)
    assert.equal(s.name, r.spanName)
    assert.equal(s.service, 'Cubedemo Shop')
    assert.equal(s.kind, 'client')
    assert.equal(s.category, 'http')
    assert.equal(s.id, r.spanId)
    assert.equal(s.startTime.getTime(), r.time.getTime())
    assert.equal(s.duration, Number(r.tags.duration) / 1e6)
    assert.equal(t.totalMs, s.duration)
    assert.equal(s.status, r.tags.eventType === 'MobileRequestError' ? 'error' : 'ok')
    assert.equal(t.failed, s.status === 'error')
    // Only a three-digit answer is a code the waterfall can colour.
    assert.equal(s.httpStatus, r.tags.status_code === '0' ? null : r.tags.status_code)
    assert.equal(t.origin, null)
  }
})

test('a failed request is the span\'s error, named by how it failed', () => {
  const failed = requests.filter(r => r.tags.eventType === 'MobileRequestError')
  const network = failed.find(r => r.tags.status_code === '0')
  const http = failed.find(r => r.tags.status_code !== '0')
  assert.ok(network && http, 'the hour lacks a network failure or an HTTP failure')

  const n = buildMobileTrace(network.traceId).root
  assert.deepEqual(n.exception, { type: 'NetworkError', message: network.tags.networkError, stack: '' })
  assert.equal(n.httpStatus, null)

  const h = buildMobileTrace(http.traceId)
  assert.deepEqual(h.root.exception, { type: 'HTTPError', message: `HTTP ${http.tags.status_code}`, stack: '' })
  assert.deepEqual(h.errors, [h.root])

  const ok = requests.find(r => r.tags.eventType === 'MobileRequest')
  assert.equal(buildMobileTrace(ok.traceId).root.exception, null)
  assert.deepEqual(buildMobileTrace(ok.traceId).errors, [])
})

test('the span\'s tags are the record\'s attributes, sorted and not renamed', () => {
  for (const r of traced.slice(0, 40)) {
    const tags = buildMobileTrace(r.traceId).root.tags
    assert.deepEqual(tags, r.tags)
    const keys = Object.keys(tags)
    assert.deepEqual(keys, [...keys].sort((a, b) => a.localeCompare(b)))
    // The waterfall search's example reads these two by name.
    assert.ok(!('otel.status_code' in tags))
  }
  const req = requests[0]
  assert.equal(buildMobileTrace(req.traceId).root.tags.requestDomain, req.tags.requestDomain)
  assert.equal(buildMobileTrace(req.traceId).root.tags.status_code, req.tags.status_code)
})

test('an install opens as its own untimed span, and Summary still lists it whole', () => {
  const install = traced.find(r => r.spanName === 'Mobile/App/Install')
    ?? mobileRowsForWindow(resolveWindow({ kind: 'preset', value: '24h' })).find(r => r.spanName === 'Mobile/App/Install')
  assert.ok(install, 'no install record to open')
  const t = buildMobileTrace(install.traceId)
  assert.equal(t.spans.length, 1)
  assert.equal(t.root.name, 'Mobile/App/Install')
  assert.equal(t.root.category, 'internal')
  assert.equal(t.root.duration, 0)
  assert.equal(t.root.httpStatus, null)
  assert.equal(t.root.status, 'ok')
  assert.equal(t.root.exception, null)
  const summary = traceSummary(t)
  assert.equal(summary.length, 1)
  assert.equal(summary[0].pct, 100)
})

test('a row opened from any window resolves to the same request', () => {
  for (const v of ['15m', '24h', '7d']) {
    const sample = mobileRowsForWindow(resolveWindow({ kind: 'preset', value: v })).filter(r => r.traceId)
    assert.ok(sample.length > 0, `${v} has no traced rows`)
    for (const r of sample.slice(0, 25)) {
      const t = buildMobileTrace(r.traceId)
      assert.ok(t, `${v}: ${r.traceId}`)
      assert.equal(t.root.name, r.spanName)
      assert.equal(t.root.startTime.getTime(), r.time.getTime())
      assert.equal(t.root.status, r.tags.eventType === 'MobileRequestError' ? 'error' : 'ok')
    }
  }
  // And the same id resolves to the same trace every time.
  assert.deepEqual(buildMobileTrace(requests[0].traceId), buildMobileTrace(requests[0].traceId))
})

test('an id that is not a mobile request is not found', () => {
  const backend = spanRows.find(r => r.traceId)?.traceId
  for (const id of [
    backend, 'undefined', 'not-a-real-trace', '', null, undefined,
    '0123456789abcdef0123456789abcdef', 'ffffffffffffffffffffffffffffffff',
    // A real id with one digit changed fails its checksum.
    requests[0].traceId.replace(/.$/, c => (c === '0' ? '1' : '0')),
  ]) {
    assert.equal(buildMobileTrace(id), null, String(id))
    assert.equal(resolveTrace(id, 'mobile'), null, String(id))
  }
})

test('a mobile id on the backend datasource is not this request', () => {
  // The backend borrows a stand-in for an id it has no spans for; that is its
  // behaviour, and the reason the datasource rides in the URL.
  const t = resolveTrace(requests[0].traceId, 'traces')
  assert.ok(t)
  assert.notEqual(t.root.service, 'Cubedemo Shop')
})

const noop = () => {}
const render = (traceId) => renderToStaticMarkup(createElement(TraceDetail, {
  traceId, datasource: 'mobile', goHome: noop, goTraces: noop, goLogs: noop,
  timeRange: { kind: 'preset', value: '1h' }, setTimeRange: noop, settingsOpen: false, setSettingsOpen: noop,
}))

test('the mobile trace page: its list in the trail, one span, no Database, Profiles or Check Logs', () => {
  const failed = requests.find(r => r.tags.eventType === 'MobileRequestError')
  const html = render(failed.traceId)
  assert.match(html, />Mobile Traces</)
  assert.match(html, /1 span across 1 service/)
  assert.doesNotMatch(html, /1 spans/)
  assert.doesNotMatch(html, /Check Logs/)
  assert.doesNotMatch(html, />Database</)
  assert.doesNotMatch(html, />Profiles</)
  assert.match(html, />Summary</)
  assert.match(html, />Errors</, 'a failed request offers its error')
  assert.ok(html.includes(failed.spanName))
  assert.match(html, /requestDomain:api\.cubedemo\.com AND status_code:502/)

  const ok = render(requests.find(r => r.tags.eventType === 'MobileRequest').traceId)
  assert.doesNotMatch(ok, />Errors</, 'a request that succeeded has no error to show')
})
