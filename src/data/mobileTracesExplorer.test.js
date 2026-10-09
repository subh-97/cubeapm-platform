// The Mobile Traces data: sessions from the Cubedemo Shop app, sampled per
// window, a histogram calibrated to prod's Last 1 hour legend, and trace ids
// that rebuild their request from nothing but the id.
//
// What these guard is the page's promises rather than the generator's
// internals: every facet value prod lists is there to click, the rare records
// (a crash, an ANR, an install, a request that never got an answer, a 4xx and a
// 5xx) are in every window long enough to ask about them, a field a record does
// not have is absent rather than blank, the hour's bars add up to the legend,
// and an id opened from any window — or typed in — resolves to that request or
// to nothing, never to a backend trace.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BASE_TIME, REFERENCE_WINDOW, INCIDENT_START_MIN, resolveWindow } from './timeWindow.js'
import {
  MOBILE_SERVICE, MOBILE_EVENT_TYPES, MOBILE_CATEGORIES, MOBILE_EVENT_DOMAINS, MOBILE_FACET_FIELDS,
  MOBILE_BAND_KEYS, mobileRowsForWindow, mobileVolumeForWindow, buildMobileFacets, mobileReferenceRows,
  mobileRecordForTraceId,
} from './mobileTracesExplorer.js'
import { spanRows } from './tracesExplorer.js'
import { errorSpanRowsForWindow } from './errors.js'

const preset = v => resolveWindow({ kind: 'preset', value: v })
const DAY_MS = 86400000
// A past absolute window, so the generator is tested on a range that does not
// end at now as well as the trailing presets.
const yesterdayAfternoon = resolveWindow({
  kind: 'absolute', from: BASE_TIME.getTime() - DAY_MS - 3 * 3600000, to: BASE_TIME.getTime() - DAY_MS,
})
const WINDOWS = {
  '5m': preset('5m'), '15m': preset('15m'), '30m': preset('30m'), '1h': REFERENCE_WINDOW, '6h': preset('6h'),
  '24h': preset('24h'), '7d': preset('7d'), today: preset('today'), 'yesterday 3h': yesterdayAfternoon,
}
const ROWS = Object.fromEntries(Object.entries(WINDOWS).map(([k, w]) => [k, mobileRowsForWindow(w)]))
const LONG = Object.keys(WINDOWS).filter(k => WINDOWS[k].pastMinutes >= 15)

const hasKey = (row, k) => Object.prototype.hasOwnProperty.call(row.tags, k)
const eventType = r => r.tags.eventType
const isRequest = r => eventType(r) === 'MobileRequest' || eventType(r) === 'MobileRequestError'
const isScreen = r => eventType(r) === 'Mobile' && r.tags.category === 'Interaction'
const isCustom = r => r.tags['event.domain'] === 'nr.mobile.custom'
const isInstall = r => r.spanName === 'Mobile/App/Install'

test('the same window builds the same rows every time', () => {
  for (const k of ['1h', '7d', 'yesterday 3h']) {
    assert.deepEqual(mobileRowsForWindow(WINDOWS[k]), ROWS[k], k)
  }
  assert.deepEqual(mobileRowsForWindow(REFERENCE_WINDOW), mobileReferenceRows)
})

test('rows sit inside the window and before now, newest first', () => {
  for (const [k, win] of Object.entries(WINDOWS)) {
    const lo = win.start * 1000
    const hi = Math.min(win.end, win.nowSec) * 1000
    const rows = ROWS[k]
    // Today is only as long as the day so far, which a run just after
    // midnight makes too short to promise anything in.
    if (win.pastMinutes >= 5) assert.ok(rows.length > 0, `${k} has rows`)
    for (const r of rows) {
      const t = r.time.getTime()
      assert.ok(t >= lo && t < hi, `${k}: ${r.id} at ${r.time.toISOString()} outside the window`)
    }
    for (let i = 1; i < rows.length; i++) {
      assert.ok(rows[i - 1].time >= rows[i].time, `${k}: rows ${i - 1} and ${i} out of order`)
    }
  }
})

test('a table-sized sample: a few hundred an hour, capped for a week, enough for five minutes', () => {
  assert.ok(ROWS['1h'].length >= 300 && ROWS['1h'].length <= 600, `1h: ${ROWS['1h'].length}`)
  assert.ok(ROWS['5m'].length >= 60, `5m: ${ROWS['5m'].length}`)
  for (const k of ['6h', '24h', '7d']) assert.ok(ROWS[k].length <= 650, `${k}: ${ROWS[k].length}`)
})

test('row ids are unique, deterministic and in their own space', () => {
  for (const [k, rows] of Object.entries(ROWS)) {
    const ids = new Set(rows.map(r => r.id))
    assert.equal(ids.size, rows.length, `${k} has duplicate ids`)
    for (const r of rows) assert.ok(r.id.startsWith('mob_'), r.id)
  }
})

test('the hour holds every eventType, category and event.domain prod lists', () => {
  const rows = mobileReferenceRows
  const values = f => new Set(rows.map(r => r.tags[f]).filter(v => v != null && v !== ''))
  assert.deepEqual([...values('eventType')].sort(), [...MOBILE_EVENT_TYPES].sort())
  assert.deepEqual([...values('category')].sort(), [...MOBILE_CATEGORIES].sort())
  assert.deepEqual([...values('event.domain')].sort(), [...MOBILE_EVENT_DOMAINS].sort())
  assert.deepEqual([...values('service')], [MOBILE_SERVICE])
  assert.deepEqual([...values('span_kind')], ['client'])
  assert.deepEqual([...values('env')], ['UNSET'])
  assert.deepEqual([...values('cube.eventType')].sort(), ['ANR', 'MobileSession'])
})

test('every window of 15 minutes or more shows each rare record', () => {
  for (const k of LONG) {
    const rows = ROWS[k]
    const has = (what, fn) => assert.ok(rows.some(fn), `${k} has ${what}`)
    has('a crash', r => eventType(r) === 'MobileCrash')
    has('an ANR', r => eventType(r) === 'ANR')
    has('an install', isInstall)
    has('a request that never got an answer', r => r.tags.status_code === '0' && r.tags.errorType === 'NetworkError')
    has('a 4xx', r => /^4\d\d$/.test(r.tags.status_code ?? ''))
    has('a 5xx', r => /^5\d\d$/.test(r.tags.status_code ?? ''))
    has('a failed payment-provider request', r => r.tags.category === 'payments' && eventType(r) === 'MobileRequestError')
  }
})

test('a field a record does not have is absent, not blank', () => {
  for (const [k, rows] of Object.entries(ROWS)) {
    for (const r of rows) {
      for (const [key, v] of Object.entries(r.tags)) {
        assert.equal(typeof v, 'string', `${k}: ${r.id} ${key} is ${typeof v}`)
        assert.notEqual(v, '', `${k}: ${r.id} ${key} is blank`)
      }
    }
  }
  const rows = mobileReferenceRows
  const noStatus = rows.filter(r => eventType(r) === 'MobileCrash' || eventType(r) === 'ANR' || isCustom(r))
  assert.ok(noStatus.length > 0)
  for (const r of noStatus) {
    for (const key of ['status_code', 'duration', 'trace_id', 'span_id']) assert.ok(!hasKey(r, key), `${r.spanName} has ${key}`)
    assert.equal(r.statusCode, '')
    assert.equal(r.durationNs, null)
    assert.equal(r.traceId, '')
  }
  const screens = rows.filter(isScreen)
  assert.ok(screens.length > 0)
  for (const r of screens) {
    assert.ok(/^Display \w+(ViewController|Activity)$/.test(r.spanName), r.spanName)
    assert.equal(r.tags.status_code, 'UNSET')
    for (const key of ['duration', 'trace_id', 'span_id']) assert.ok(!hasKey(r, key), `${r.spanName} has ${key}`)
    assert.equal(r.durationNs, null)
  }
})

test('requests carry a code, a duration and a trace; an install carries its trace', () => {
  const requests = mobileReferenceRows.filter(isRequest)
  assert.ok(requests.length > 100)
  for (const r of requests) {
    assert.ok(/^HTTP (GET|POST) [\w.-]+$/.test(r.spanName), r.spanName)
    assert.ok(/^\d+$/.test(r.tags.status_code), r.tags.status_code)
    assert.equal(r.tags.statusCode, r.tags.status_code)
    assert.equal(r.statusCode, r.tags.status_code)
    assert.ok(Number(r.tags.duration) > 0)
    assert.equal(r.durationNs, Number(r.tags.duration))
    assert.ok(/^[0-9a-f]{32}$/.test(r.traceId) && r.traceId === r.tags.trace_id)
    assert.ok(/^[0-9a-f]{16}$/.test(r.spanId) && r.spanId === r.tags.span_id)
    assert.equal(r.tags.requestUrl, `https://${r.tags.requestDomain}${r.tags.requestPath}`)
    if (eventType(r) === 'MobileRequest') assert.equal(r.tags.status_code, '200')
    else assert.ok(['HTTPError', 'NetworkError'].includes(r.tags.errorType))
    if (r.tags.errorType === 'NetworkError') {
      assert.equal(r.tags.status_code, '0')
      assert.equal(r.tags.bytesReceived, '0')
      assert.ok(r.tags.networkError && /^-\d+$/.test(r.tags.networkErrorCode))
    }
  }
  const installs = mobileReferenceRows.filter(isInstall)
  assert.ok(installs.length > 0)
  for (const r of installs) {
    assert.ok(!hasKey(r, 'eventType') && !hasKey(r, 'category'))
    assert.equal(r.tags['event.domain'], 'nr.mobile')
    assert.equal(r.tags.status_code, 'UNSET')
    assert.ok(/^[0-9a-f]{32}$/.test(r.traceId))
    assert.equal(r.spanId, '0000000000000001')
    assert.equal(r.tags.count, '1')
  }
})

test('no tag that would change how the shared drawer reads a record', () => {
  const banned = [
    'host', 'host.name', 'hostname', 'pod_name', 'db.system', 'endpoint', 'http.route', 'root_name',
    'http.status_code', 'exception.type', 'error.type', 'error.class', 'status',
  ]
  for (const r of mobileReferenceRows) {
    for (const key of Object.keys(r.tags)) {
      assert.ok(!banned.includes(key) && !key.startsWith('k8s.'), `${r.spanName} carries ${key}`)
    }
  }
})

test('every record of a session ran on one device, build, country and connection', () => {
  const SESSION_FIELDS = ['device_id', 'device_model', 'os_name', 'os_version', 'platform', 'app_build', 'countryCode', 'connectionType']
  for (const k of ['1h', '7d']) {
    const bySession = new Map()
    for (const r of ROWS[k]) {
      const key = r.tags.session_id
      assert.ok(key, `${r.id} has a session`)
      if (!bySession.has(key)) bySession.set(key, r)
      const first = bySession.get(key)
      for (const f of SESSION_FIELDS) assert.equal(r.tags[f], first.tags[f], `${k}: ${f} changes within ${key}`)
    }
    assert.ok(bySession.size >= 10, `${k}: ${bySession.size} sessions`)
  }
})

test('a crash carries the trail its session left, and its stack, as JSON strings', () => {
  for (const k of LONG) {
    for (const crash of ROWS[k].filter(r => eventType(r) === 'MobileCrash')) {
      assert.equal(crash.tags.platform, 'ios')
      const trail = JSON.parse(crash.tags.analytics_events)
      assert.ok(Array.isArray(trail) && trail.length > 0 && trail.length <= 8)
      for (const e of trail) assert.ok(e.timestamp < crash.time.getTime(), 'trail entries precede the crash')
      // The request whose failure left the app in the state it crashed in.
      const last = trail[trail.length - 1]
      assert.equal(last.eventType, 'MobileRequestError')
      assert.equal(last.statusCode, 0)
      const stack = JSON.parse(crash.tags.stacktrace)
      assert.equal(stack.crashed, true)
      assert.ok(stack.stack.length > 0 && stack.stack[0].fileName && stack.stack[0].methodName)
      assert.ok(crash.tags.crash_location.startsWith(stack.stack[0].fileName))
    }
    for (const anr of ROWS[k].filter(r => eventType(r) === 'ANR')) {
      assert.equal(anr.tags.platform, 'android')
      assert.ok(anr.tags.thread_dump.includes('"main"'))
    }
  }
})

test('row level follows the record severity', () => {
  for (const r of mobileReferenceRows) {
    const code = r.tags.status_code ?? ''
    const fatal = eventType(r) === 'MobileCrash' || eventType(r) === 'ANR'
    const want = fatal || code === '0' || /^5\d\d$/.test(code) ? 'error' : /^4\d\d$/.test(code) ? 'warn' : 'info'
    assert.equal(r.level, want, `${r.spanName} ${code}`)
    assert.equal(r.message, 'UNSET')
    assert.equal(r.spanKind, 'client')
    assert.equal(r.service, MOBILE_SERVICE)
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(r.dateStr) && /^\d{2}:\d{2}:\d{2}\.\d{3}$/.test(r.timeStr))
  }
})

test('the outage reaches the phone: payment calls fail inside the incident', () => {
  const nowMs = REFERENCE_WINDOW.nowSec * 1000
  const inIncident = r => (nowMs - r.time.getTime()) / 60000 < INCIDENT_START_MIN
  const failedPayments = mobileReferenceRows.filter(r =>
    r.tags.requestDomain === 'api.cubedemo.com' && r.tags.requestPath === '/v1/payments' && /^5\d\d$/.test(r.tags.status_code ?? ''))
  assert.ok(failedPayments.some(inIncident), 'a 5xx on POST /v1/payments during the incident')
  assert.ok(failedPayments.every(r => r.tags.category === 'api'))
})

/* ---- volume ---- */

const sum = (vol, k) => vol.reduce((a, b) => a + b[k], 0)

test('one volume entry per bucket, labelled as the axis is, future buckets empty', () => {
  for (const k of ['5m', '1h', '7d', 'today']) {
    const win = WINDOWS[k]
    const vol = mobileVolumeForWindow(win)
    assert.equal(vol.length, win.buckets.length)
    vol.forEach((e, i) => {
      const b = win.buckets[i]
      assert.equal(e.label, b.label)
      assert.equal(e.t, b.t)
      assert.equal(e.m, b.m)
      assert.equal(e.exactTime, b.exactTime)
      assert.equal(e.total, MOBILE_BAND_KEYS.reduce((a, key) => a + e[key], 0))
      if (b.future) for (const key of [...MOBILE_BAND_KEYS, 'total']) assert.equal(e[key], 0)
    })
  }
  // Today's 30-minute bars have all begun by 23:30, so read it at noon, where
  // the afternoon is still to come and has to be drawn empty.
  const noon = new Date(BASE_TIME)
  noon.setHours(12, 0, 0, 0)
  const todayAtNoon = resolveWindow({ kind: 'preset', value: 'today' }, noon.getTime())
  const future = mobileVolumeForWindow(todayAtNoon).filter((e, i) => todayAtNoon.buckets[i].future)
  assert.ok(future.length > 0, 'no bucket of today is still to come at noon')
  for (const e of future) assert.equal(e.total, 0)
})

test('Last 1 hour adds up to prod\'s legend, band by band', () => {
  const vol = mobileVolumeForWindow(REFERENCE_WINDOW)
  const targets = { ok: 86200, none: 9790, warn: 692, fail: 1570 }
  for (const [k, want] of Object.entries(targets)) {
    const got = sum(vol, k)
    assert.ok(Math.abs(got - want) / want <= 0.02, `${k}: ${got} vs ${want}`)
  }
  const total = sum(vol, 'total')
  assert.ok(Math.abs(total - 98270) / 98270 <= 0.02, `total ${total}`)
})

test('the failing band carries the incident: high inside it, diluted by a wider window', () => {
  const vol = mobileVolumeForWindow(REFERENCE_WINDOW)
  const inside = vol.filter((e, i) => REFERENCE_WINDOW.buckets[i].w >= 1)
  const before = vol.filter((e, i) => REFERENCE_WINDOW.buckets[i].w === 0)
  const rate = es => sum(es, 'fail') / es.length
  assert.ok(rate(inside) > 2.5 * rate(before), `${rate(inside)} vs ${rate(before)}`)

  const perMin = k => sum(mobileVolumeForWindow(WINDOWS[k]), 'fail') / WINDOWS[k].pastMinutes
  const share = k => { const v = mobileVolumeForWindow(WINDOWS[k]); return sum(v, 'fail') / sum(v, 'total') }
  // Against the hour, not 7d against 24h: both are far enough out that the
  // incident is under 2% of either, and the bucket noise is wider than that.
  assert.ok(perMin('24h') < 0.75 * perMin('1h') && perMin('7d') < 0.75 * perMin('1h'))
  assert.ok(share('24h') < share('1h') && share('7d') < share('1h'))
  assert.ok(share('15m') > share('1h'), 'a window inside the incident reads worse than the hour')
})

/* ---- trace ids ---- */

test('every row\'s trace id rebuilds that row, from any window', () => {
  for (const k of ['15m', '1h', '7d', 'yesterday 3h']) {
    const withTrace = ROWS[k].filter(r => r.traceId)
    assert.ok(withTrace.length > 0)
    for (const r of withTrace) {
      const back = mobileRecordForTraceId(r.traceId)
      assert.ok(back, `${k}: ${r.traceId} does not resolve`)
      assert.equal(back.id, r.id)
      assert.equal(back.spanName, r.spanName)
      assert.equal(back.time.getTime(), r.time.getTime())
      assert.equal(back.statusCode, r.statusCode)
      assert.deepEqual(back.tags, r.tags)
    }
  }
})

test('only requests and installs carry a trace id', () => {
  for (const r of mobileReferenceRows) {
    assert.equal(Boolean(r.traceId), isRequest(r) || isInstall(r), `${r.spanName}`)
  }
})

test('an id that is not a mobile trace is not found', () => {
  assert.equal(mobileRecordForTraceId('0123456789abcdef0123456789abcdef'), null)
  assert.equal(mobileRecordForTraceId('f'.repeat(32)), null)
  assert.equal(mobileRecordForTraceId(''), null)
  assert.equal(mobileRecordForTraceId(null), null)
  assert.equal(mobileRecordForTraceId(undefined), null)
  assert.equal(mobileRecordForTraceId('not-a-trace'), null)
  assert.equal(mobileRecordForTraceId(mobileReferenceRows.find(r => r.traceId).traceId.toUpperCase()), null)
  // A backend span's id and an Errors-page sample's id are other datasources'
  // traces, and must not decode here into a request that never happened.
  assert.equal(mobileRecordForTraceId(spanRows[0].traceId), null)
  const sample = errorSpanRowsForWindow(REFERENCE_WINDOW)[0]
  assert.ok(sample?.traceId)
  assert.equal(mobileRecordForTraceId(sample.traceId), null)
  // One flipped digit fails the checksum.
  const real = mobileReferenceRows.find(r => r.traceId).traceId
  const flipped = real.slice(0, 31) + (real[31] === '0' ? '1' : '0')
  assert.equal(mobileRecordForTraceId(flipped), null)
})

/* ---- facets ---- */

test('the rail is pinned to prod\'s stream labels, in prod\'s order', () => {
  const facets = buildMobileFacets(mobileReferenceRows)
  assert.deepEqual(Object.keys(facets), MOBILE_FACET_FIELDS)
  assert.deepEqual(MOBILE_FACET_FIELDS, ['category', 'cube.eventType', 'event.domain', 'eventType', 'service'])
  assert.deepEqual(facets.service, [{ value: MOBILE_SERVICE, count: mobileReferenceRows.length }])
  for (const [field, values] of Object.entries(facets)) {
    for (let i = 1; i < values.length; i++) {
      const a = values[i - 1], b = values[i]
      assert.ok(a.count > b.count || (a.count === b.count && a.value.localeCompare(b.value) < 0), `${field} order`)
    }
    const counted = mobileReferenceRows.filter(r => r.tags[field] != null && r.tags[field] !== '').length
    assert.equal(values.reduce((a, v) => a + v.count, 0), counted, field)
  }
})

test('facets skip blanks and leave out a field no row carries', () => {
  const rows = [
    { tags: { service: MOBILE_SERVICE, eventType: 'MobileRequest', category: 'api', 'event.domain': 'nr.mobile' } },
    { tags: { service: MOBILE_SERVICE, eventType: '', category: 'api', 'event.domain': 'nr.mobile' } },
    { tags: { service: MOBILE_SERVICE, category: 'cdn', 'event.domain': 'nr.mobile' } },
  ]
  const facets = buildMobileFacets(rows)
  assert.deepEqual(Object.keys(facets), ['category', 'event.domain', 'eventType', 'service'])
  assert.deepEqual(facets.eventType, [{ value: 'MobileRequest', count: 1 }])
  assert.deepEqual(facets.category, [{ value: 'api', count: 2 }, { value: 'cdn', count: 1 }])
})
