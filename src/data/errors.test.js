// What the Errors page's numbers promise, and what a sample promises about
// the trace behind it.
//
// Two risks. The counts are generated, so a plausible refactor can quietly
// stop the reference hour reproducing the tables beside it, or let a week
// count the incident twice. And a sample is only worth clicking if the trace
// it opens is the failure it claims to be — the old Error requests panel
// opened somebody else's successful request for months without anyone
// noticing. So the ends of the range are pinned, and every sample of every
// group is followed through to its trace.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BASE_TIME, REFERENCE_WINDOW, INCIDENT_START_MIN, resolveWindow, windowMean } from './timeWindow.js'
import {
  redEndpoints, dbEndpoints, externalEndpoints, services, errorRequests, errorRateProfiles,
  redEndpointsForWindow, externalEndpointsForWindow, dbEndpointsForWindow,
} from './services.js'
import { RUNTIME_HOSTS, livesOf } from './runtimeHosts.js'
import { spanRows, spanRowsForWindow } from './tracesExplorer.js'
import { buildTrace } from './traceDetail.js'
import {
  ERROR_SIDES, errorSeriesForWindow, groupErrorSeries, errorGroupsForWindow, sumErrorSeries,
  previousWindow, errorSamplesFor, errorBreakdownFor, tracesFiltersFor, errorTraceRows,
  errorSpanRowsForWindow,
} from './errors.js'
import { applyChipsToLog } from '@/components/QueryBuilder'
import { getSpanFieldValue } from '@/utils/traceFields'
import { filtersToChips } from '@/utils/tracesHandoff'

// Pinned to a half-hour boundary so the exact-value assertions below read the
// same windows, bucket edges included, on every run. A trailing range runs to
// the current minute whatever the clock says (resolveWindow), so the pin is not
// what keeps a wide range from stopping short of the incident; the unpinned
// test after 'widening the window…' holds that on the real clock.
const OFF_SEC = -new Date(BASE_TIME).getTimezoneOffset() * 60
const BASE_SEC = Math.floor(BASE_TIME.getTime() / 1000)
const nowMs = (BASE_SEC - ((BASE_SEC - OFF_SEC) % 1800)) * 1000
const preset = v => (v === '1h' ? REFERENCE_WINDOW : resolveWindow({ kind: 'preset', value: v }, nowMs))
const quietWindow = () => resolveWindow({
  kind: 'absolute',
  from: BASE_TIME.getTime() - 180 * 60000,
  to: BASE_TIME.getTime() - (INCIDENT_START_MIN + 15) * 60000,
})

const POOL = 'redis.clients.jedis.exceptions.JedisPoolException'
const groupsOf = (win, side) => errorGroupsForWindow(win, { side })
const allGroups = win => ERROR_SIDES.flatMap(side => groupsOf(win, side))
const total = rows => rows.reduce((a, r) => a + r.count, 0)
const published = (rpm, pct) => Math.round(rpm * (pct / 100) * 60)

test('the reference hour reproduces every published error count exactly', () => {
  const server = errorSeriesForWindow(REFERENCE_WINDOW, 'server')
  const client = errorSeriesForWindow(REFERENCE_WINDOW, 'client')

  // payment-service's endpoints: rpm × err% × 60 off the RED table.
  for (const r of redEndpoints) {
    const got = total(server.filter(x => x.service === 'payment-service' && x.endpoint === r.endpoint))
    assert.equal(got, published(r.rpm, r.errPct), `${r.endpoint}: ${got}`)
  }
  assert.deepEqual(
    redEndpoints.map(r => published(r.rpm, r.errPct)), [235, 195, 141, 50, 9],
    'the five figures the page has to land on',
  )

  // Its outgoing calls, the same way, off the DB and External tables.
  for (const r of [...dbEndpoints, ...externalEndpoints]) {
    const got = total(client.filter(x => x.service === 'payment-service' && x.spanName === r.endpoint))
    assert.equal(got, published(r.rpm, r.errPct), `${r.endpoint}: ${got}`)
  }

  // Every other service off its service-level rpm × err%. payment-service is
  // counted per endpoint instead, and its five endpoints carry 275 of its
  // 452.7 rpm — matching the RED table on the same page is the consistency a
  // reader can check, so the rest is not invented as endpoints nobody lists.
  for (const s of services.filter(x => x.id !== 'payment-service')) {
    const got = total(server.filter(x => x.service === s.id))
    assert.equal(got, published(s.rpm, s.errorRatePct), `${s.id}: ${got}`)
  }
  assert.equal(total(server.filter(x => x.service === 'analytics-service' || x.service === 'demo-nodejs-service')), 0)
})

test('a call that fails its request counts the same on both sides', () => {
  for (const win of [REFERENCE_WINDOW, preset('7d')]) {
    const server = errorSeriesForWindow(win, 'server')
    const client = errorSeriesForWindow(win, 'client')
    const stripe = side => total(side.filter(r => r.exception === 'java.util.concurrent.TimeoutException' && r.service === 'payment-service'
      && (r.spanName === 'POST api.stripe.com/v1/charges' || r.endpoint === r.spanName)
      && r.message.includes('stripe')))
    assert.equal(stripe(client), stripe(server), `${win.label}: stripe timeouts`)
    const downstream = side => total(side.filter(r => r.message === 'Downstream call failed'))
    assert.equal(downstream(client), downstream(server), `${win.label}: downstream failures`)
  }
})

// A request that failed is the Server side's to count, and the RED table's.
// A Client error whose trace fails its request is that same failure seen from
// the call, so per endpoint and exception those can never outnumber the Server
// rows — the Redis pool's calls once failed three requests for every one the
// RED table said had failed.
test('a client error fails its request no more often than the server side counts', () => {
  const key = g => `${g.service} | ${g.endpoint} | ${g.exception}`
  for (const win of [REFERENCE_WINDOW, preset('24h'), preset('7d')]) {
    const server = new Map()
    for (const g of groupsOf(win, 'server')) server.set(key(g), (server.get(key(g)) ?? 0) + g.count)
    const failing = new Map()
    for (const g of groupsOf(win, 'client')) {
      const roots = errorSamplesFor(g, win).map(s => buildTrace(s.traceId).root)
      const failed = roots.filter(r => r.status === 'error').length
      assert.ok(failed === 0 || failed === roots.length, `${win.label} ${g.id}: a row's requests all fail or all survive`)
      if (failed) failing.set(key(g), (failing.get(key(g)) ?? 0) + g.count)
    }
    assert.ok(failing.size > 0, 'the mirrored calls still fail theirs')
    for (const [k, n] of failing) {
      assert.ok(n <= (server.get(k) ?? 0), `${win.label} ${k}: ${n} failed requests on Client, ${server.get(k) ?? 0} on Server`)
    }
  }
})

test('every series and group adds up, bucket by bucket, in whole errors', () => {
  for (const win of ['5m', '15m', '1h', '6h', '24h', '7d', 'today'].map(preset).concat(quietWindow())) {
    for (const side of ERROR_SIDES) {
      const rows = errorSeriesForWindow(win, side)
      for (const r of [...rows, ...groupErrorSeries(rows, win)]) {
        assert.equal(r.series.length, win.buckets.length, `${win.label} ${r.id}: one point per bucket`)
        let sum = 0
        r.series.forEach((p, i) => {
          const b = win.buckets[i]
          assert.equal(p.label, b.label)
          assert.equal(p.t, b.t)
          if (b.future) return assert.equal(p.value, null, `${r.id}: a bucket that has not happened draws nothing`)
          assert.ok(Number.isInteger(p.value) && p.value >= 0, `${r.id}[${i}] = ${p.value}`)
          sum += p.value
        })
        assert.equal(sum, r.count, `${win.label} ${r.id}: Σ series ${sum} ≠ count ${r.count}`)
        assert.ok(r.count > 0)
        assert.ok(Number.isInteger(r.prevCount) && r.prevCount >= 0)
      }
      const volume = sumErrorSeries(rows, win)
      assert.equal(volume.reduce((a, p) => a + (p.value ?? 0), 0), total(rows), `${win.label} ${side}: volume`)
    }
  }
})

test('a group folds its rows: codes, counts and the fields it is not keyed on', () => {
  const rows = errorSeriesForWindow(REFERENCE_WINDOW, 'server')
  const groups = groupErrorSeries(rows, REFERENCE_WINDOW)
  for (let i = 1; i < groups.length; i++) assert.ok(groups[i - 1].count >= groups[i].count, 'biggest first')
  for (const g of groups) {
    const merged = rows.filter(r => g.seriesIds.includes(r.id))
    assert.equal(g.count, total(merged))
    assert.equal(g.httpCodes.reduce((a, c) => a + c.count, 0), g.count, `${g.id}: every server error has a code`)
    assert.deepEqual(g.httpCodes.map(c => c.code), [...g.httpCodes.map(c => c.code)].sort((a, b) => a - b))
    assert.ok(g.firstSeenMs <= g.lastSeenMs)
    assert.ok(g.lastSeenMs <= REFERENCE_WINDOW.nowSec * 1000)
  }

  const byService = groupErrorSeries(rows, REFERENCE_WINDOW, { by: ['side', 'service'] })
  const pay = byService.find(g => g.service === 'payment-service')
  assert.equal(pay.count, total(rows.filter(r => r.service === 'payment-service')))
  assert.equal(pay.exception, POOL, 'an unkeyed field takes the biggest row\'s value')
  assert.deepEqual(tracesFiltersFor(pay).map(f => f.field), ['service', 'span_kind', 'status_code'],
    'a link from a coarser group does not filter on what the group is not keyed on')

  assert.ok(errorGroupsForWindow(REFERENCE_WINDOW, { service: 'order-service' }).every(g => g.service === 'order-service'))
})

test('sides keep to their own status codes', () => {
  for (const win of [REFERENCE_WINDOW, preset('7d')]) {
    for (const r of errorSeriesForWindow(win, 'server')) {
      assert.equal(r.side, 'server')
      assert.match(r.httpCode, /^5\d\d$/, `${r.id}: a server error is a 5xx`)
      assert.equal(r.spanName, r.endpoint)
    }
    for (const r of errorSeriesForWindow(win, 'client')) {
      assert.equal(r.side, 'client')
      assert.match(r.httpCode, /^([45]\d\d)?$/, `${r.id}`)
      if (r.category === 'db') assert.equal(r.httpCode, '', `${r.id}: a database call has no status code`)
      assert.notEqual(r.spanName, r.endpoint)
    }
  }
})

test('a wider window counts more errors, not the same ones resliced', () => {
  const declines = win => total(errorSeriesForWindow(win, 'client')
    .filter(r => r.exception === 'com.cubedemo.payment.CardDeclinedException'))
  const hour = declines(REFERENCE_WINDOW)
  const day = declines(preset('24h'))
  assert.ok(hour > 0)
  assert.ok(day > hour * 10, `a day of card declines should dwarf an hour: ${day} vs ${hour}`)
})

// The page's version of p90 falling off a cliff: over an hour the pool is the
// story, over a week it is a footnote — and the one hour that holds the whole
// outage and the week that holds it too agree on how many errors it threw.
test('widening the window dilutes the incident without counting it twice', () => {
  const payment = win => errorSeriesForWindow(win, 'server').filter(r => r.service === 'payment-service')
  const poolShare = win => total(payment(win).filter(r => r.exception === POOL)) / total(payment(win))

  assert.ok(poolShare(REFERENCE_WINDOW) >= 0.95, `the hour is the pool: ${poolShare(REFERENCE_WINDOW)}`)
  assert.ok(poolShare(preset('7d')) < 0.5, `the week is mostly something else: ${poolShare(preset('7d'))}`)

  const top = errorGroupsForWindow(preset('7d'), { service: 'payment-service' })[0]
  assert.notEqual(top.exception, POOL, 'over a week the background rises to the top')
  assert.equal(top.isNew, false)

  // Measured against an hour ending at the same pinned now, since the
  // incident moves with "now".
  const poolIn = win => total(payment(win).filter(r => r.exception === POOL))
  const hourPool = poolIn(resolveWindow({ kind: 'preset', value: '1h' }, nowMs))
  for (const v of ['6h', '24h', '7d']) {
    const pool = poolIn(preset(v))
    assert.ok(Math.abs(pool - hourPool) <= Math.max(3, hourPool * 0.03),
      `${v} holds the same outage as the hour: ${pool} vs ${hourPool}`)
  }
})

test('on the real clock, a wide range holds the whole of the running outage', () => {
  // Unpinned on purpose: a trailing range used to end on its query step, and
  // opened late in a quarter hour Last 7 days counted a quarter of the pool
  // errors Last 1 hour did, and dated the last one minutes back.
  const poolIn = win => total(errorSeriesForWindow(win, 'server').filter(r => r.exception === POOL))
  const hourPool = poolIn(REFERENCE_WINDOW)
  assert.ok(hourPool > 0)
  for (const v of ['6h', '12h', '24h', '7d']) {
    const win = resolveWindow({ kind: 'preset', value: v })
    const pool = poolIn(win)
    assert.ok(Math.abs(pool - hourPool) <= hourPool * 0.01, `${v}: ${pool} pool errors vs the hour's ${hourPool}`)
    if (v === '7d') {
      const g = errorGroupsForWindow(win, { side: 'server' }).find(x => x.exception === POOL)
      assert.ok(win.nowSec * 1000 - g.lastSeenMs <= 60000, `7d: last seen ${(win.nowSec * 1000 - g.lastSeenMs) / 1000}s ago`)
    }
  }
})

// The drawer says "first seen" off this. At a week the outage sits inside one
// three-hour bucket, and reading the bucket's edge would date a 22-minute-old
// failure to hours ago.
test('an outage is first seen when it began, however wide the buckets', () => {
  for (const v of ['24h', '7d']) {
    const win = preset(v)
    const began = (win.nowSec - INCIDENT_START_MIN * 60) * 1000
    const pool = allGroups(win).filter(g => g.exception === POOL)
    assert.ok(pool.length > 0)
    for (const g of pool) {
      assert.equal(g.firstSeenMs, began, `${v} ${g.id}: first seen ${(win.nowSec * 1000 - g.firstSeenMs) / 60000} min ago`)
    }
  }
  // Errors that were there all along keep the edge of their first bucket.
  const week = preset('7d')
  const declines = groupsOf(week, 'client').find(g => g.exception === 'com.cubedemo.payment.CardDeclinedException')
  assert.equal(declines.firstSeenMs, week.buckets.find((b, i) => declines.series[i].value > 0).ms)
})

test('a window that never contained the incident shows none of it', () => {
  const win = quietWindow()
  const groups = allGroups(win)
  assert.ok(groups.length > 0, 'the background never stops')
  assert.equal(groups.filter(g => g.exception === POOL).length, 0, 'no pool exhaustion before the pool failed')
})

test('every count carries the previous period it is compared with', () => {
  for (const g of allGroups(REFERENCE_WINDOW).filter(x => x.exception === POOL)) {
    assert.equal(g.prevCount, 0, `${g.id}: the hour before the outage had no pool errors`)
    assert.equal(g.isNew, true)
  }
  // Five minutes against the five before them: both inside the outage.
  const five = errorSeriesForWindow(preset('5m'), 'server').filter(r => r.service === 'payment-service')
  const ratio = total(five) / five.reduce((a, r) => a + r.prevCount, 0)
  assert.ok(ratio > 0.7 && ratio < 1.4, `inside the incident, period on period is flat: ${ratio}`)

  const prev = previousWindow(REFERENCE_WINDOW)
  assert.equal(prev.buckets.length, REFERENCE_WINDOW.pastBuckets.length)
  assert.equal(prev.pastMinutes, REFERENCE_WINDOW.pastMinutes)
  assert.equal(prev.buckets[0].t, REFERENCE_WINDOW.buckets[0].t - REFERENCE_WINDOW.spanSec)
  assert.ok(prev.buckets.every(b => b.w === 0), 'the hour before the last one never saw the pool fail')
})

// "Today" runs to midnight, so a few minutes past it the bucket holding now is
// a whole half hour with all but those minutes still to come. It counts what
// has been thrown — what "Today so far" counts, and no more than the quarter
// hour that holds it — and is compared with the same minutes of yesterday.
test('today counts only the minutes that have happened', () => {
  const midnight = new Date(nowMs)
  midnight.setHours(0, 0, 0, 0)
  midnight.setDate(midnight.getDate() - 1)
  const at = midnight.getTime() + 5.5 * 60000
  const win = v => resolveWindow({ kind: 'preset', value: v }, at)
  const today = win('today')
  const soFar = win('todayf')
  const quarter = win('15m')
  const count = (w, service) => total(errorSeriesForWindow(w, 'server').filter(r => !service || r.service === service))
  assert.ok(Math.abs(count(today) - count(soFar)) <= Math.max(3, count(soFar) * 0.05),
    `today ${count(today)} vs today so far ${count(soFar)}`)
  for (const s of services.filter(x => count(today, x.id) > 0)) {
    assert.ok(count(today, s.id) <= count(quarter, s.id), `${s.id}: today ${count(today, s.id)} > last 15 minutes ${count(quarter, s.id)}`)
  }
  assert.equal(previousWindow(today).pastMinutes, 5.5, 'yesterday\'s first five and a half minutes, not its first half hour')
})

// Host runs in absolute time, as the Runtime tab draws them.
const LIVES = Object.fromEntries(RUNTIME_HOSTS.map(h => [h.id, livesOf(h, BASE_SEC)]))
const upAt = (host, ms) => LIVES[host].some(l => l.from <= ms / 1000 && (ms / 1000 < l.to || l.running))
const INFRA_HOSTS = new Set(['ip-10-0-143-40', 'ip-10-0-130-150', 'ip-10-0-144-12'])

test('samples are drawn from the errors they stand for', () => {
  for (const win of [REFERENCE_WINDOW, preset('24h'), preset('7d'), preset('5m')]) {
    const endMs = Math.min(win.end, win.nowSec) * 1000
    for (const g of allGroups(win)) {
      const samples = errorSamplesFor(g, win)
      assert.equal(samples.length, Math.min(10, g.count), `${g.id}`)
      const times = samples.map(s => s.timeMs)
      assert.ok(g.firstSeenMs <= Math.min(...times) && Math.max(...times) <= g.lastSeenMs,
        `${g.id}: a sample older than first seen or newer than last seen`)
      // The first is the newest error, in the bucket "last seen" is read off —
      // not a draw from the newest tenth, hours back on a week. Past a
      // thousand errors the picks are a sample of them, and the newest is
      // still placed within one gap between errors of that bucket's end.
      const li = g.series.findLastIndex(p => p.value > 0)
      const last = win.buckets[li]
      const behind = g.lastSeenMs - samples[0].timeMs
      assert.ok(samples[0].timeMs >= last.ms, `${win.label} ${g.id}: newest sample ${behind / 60000} min before last seen`)
      if (g.count > 1000) {
        const gap = (g.lastSeenMs - last.ms) / g.series[li].value
        assert.ok(behind <= gap + 100, `${win.label} ${g.id}: newest sample ${behind / 1000}s before last seen, one gap is ${gap / 1000}s`)
      }
      samples.forEach((s, i) => {
        if (i > 0) assert.ok(samples[i - 1].timeMs >= s.timeMs, `${g.id}: newest first`)
        assert.ok(s.timeMs >= win.start * 1000 && s.timeMs < endMs, `${g.id}: inside the window`)
        const b = win.buckets.findIndex(x => s.timeMs >= x.ms && s.timeMs < x.ms + x.durMin * 60000)
        assert.ok(b >= 0 && g.series[b].value > 0, `${g.id}: in a bucket that has errors`)
        if (g.exception === POOL) {
          assert.ok(s.timeMs >= (win.nowSec - INCIDENT_START_MIN * 60) * 1000, `${g.id}: pool errors only once the pool failed`)
        }
        assert.equal(s.service, g.service)
        assert.equal(s.exception, g.exception)
        assert.equal(s.message, g.message)
        assert.equal(s.time.getTime(), s.timeMs)
        assert.ok(s.stacktrace.startsWith(`${g.exception}: ${g.message}\n\tat `))
        if (g.service === 'payment-service') {
          assert.ok(LIVES[s.host], `${s.host} is a payment-service JVM`)
          assert.ok(upAt(s.host, s.timeMs), `${s.host} was not running ${(BASE_TIME - s.timeMs) / 60000} min ago`)
          assert.match(s.version, /^v9\.(10\.1|11\.0)$/)
        } else {
          assert.ok(INFRA_HOSTS.has(s.host), `${s.host}`)
          assert.equal(s.version, 'v9.10.1')
        }
        assert.equal(s.attributes['host.name'], s.host)
        assert.equal(s.attributes['service.version'], s.version)
        assert.ok(Object.values(s.attributes).every(v => typeof v === 'string'))
      })
    }
  }
})

test('the canary carries more than its share of the outage', () => {
  const canary = groups => {
    let all = 0, canaryCount = 0
    for (const g of groups) {
      for (const v of errorBreakdownFor(g, REFERENCE_WINDOW).version) {
        all += v.count
        if (v.value === 'v9.11.0') canaryCount += v.count
      }
    }
    return canaryCount / all
  }
  const pool = groupsOf(REFERENCE_WINDOW, 'server').filter(g => g.exception === POOL)
  // Each error's version is a draw off its trace id, so the share is a sample
  // of ~600 draws that moves with the clock (σ ≈ 0.02 around 0.35): the bounds
  // sit four of those out, and the lower one is still well clear of the 20%
  // a canary that failed no more often than stable would get.
  const share = canary(pool)
  assert.ok(share > 0.27 && share < 0.43, `20% of traffic, ~35% of pool errors: ${share}`)
})

test('the breakdown adds up to the group and agrees with its samples', () => {
  for (const win of [REFERENCE_WINDOW, preset('7d')]) {
    for (const side of ERROR_SIDES) {
      const rows = errorSeriesForWindow(win, side)
      // The page's groups, and the ones a status-code filter leaves behind:
      // other series, so other picks.
      const codes = [...new Set(rows.map(r => r.httpCode))]
      const groups = [rows, ...codes.map(c => rows.filter(r => r.httpCode === c))].flatMap(rs => groupErrorSeries(rs, win))
      for (const g of groups) {
        const { host, version } = errorBreakdownFor(g, win)
        for (const list of [host, version]) {
          assert.equal(list.reduce((a, x) => a + x.count, 0), g.count, `${g.id}`)
          for (let i = 1; i < list.length; i++) assert.ok(list[i - 1].count >= list[i].count)
        }
        const samples = errorSamplesFor(g, win)
        // Every sample is an error the breakdown counted: the drawer shows the
        // two together, and a sample on a host the breakdown says had no
        // errors is a contradiction on screen.
        for (const s of samples) {
          assert.ok(host.some(h => h.value === s.host), `${win.label} ${g.id} (${g.count}): sample on ${s.host}, breakdown ${host.map(h => h.value)}`)
          assert.ok(version.some(v => v.value === s.version), `${win.label} ${g.id} (${g.count}): sample on ${s.version}, breakdown ${version.map(v => v.value)}`)
        }
        // A small group's breakdown is its samples, error for error.
        if (g.count <= 10) {
          const tally = new Map()
          for (const s of samples) tally.set(s.host, (tally.get(s.host) ?? 0) + 1)
          assert.deepEqual(Object.fromEntries(host.map(h => [h.value, h.count])), Object.fromEntries(tally), `${g.id}`)
        }
      }
    }
  }
})

// Every child starts after its parent and ends before it — a waterfall that
// breaks this draws a request that cannot have happened.
function assertNested(trace) {
  for (const s of trace.spans) {
    if (!s.parentId) continue
    const p = trace.byId[s.parentId]
    assert.ok(p, `${s.name} has a parent`)
    assert.ok(s.start >= p.start && s.start + s.duration <= p.start + p.duration + 1e-9,
      `${s.name} [${s.start}, ${s.start + s.duration}] overruns ${p.name} [${p.start}, ${p.start + p.duration}]`)
  }
}

test('every sample opens the failing request it describes', () => {
  for (const win of [REFERENCE_WINDOW, preset('7d')]) {
    for (const g of allGroups(win)) {
      const codes = g.httpCodes.map(c => c.code)
      for (const s of errorSamplesFor(g, win)) {
        const t = buildTrace(s.traceId)
        assert.ok(t, `${g.id}: ${s.traceId} resolves`)
        assert.equal(t.traceId, s.traceId)
        assert.equal(t.root.service, g.service, `${g.id}: root service`)
        if (g.side === 'server') assert.equal(t.root.name, g.endpoint)
        else assert.ok(t.spans.some(x => x.kind === 'client' && x.name === g.spanName), `${g.id}: has the call`)
        assert.equal(t.failed, true)
        const hit = t.errors.find(x => x.exception.type === g.exception && x.exception.message === g.message
          && x.id === s.spanId)
        assert.ok(hit, `${g.id}: the span that recorded the exception is the sample's`)
        if (codes.length) assert.ok(codes.includes(hit.httpStatus), `${g.id}: ${hit.httpStatus} not in ${codes}`)
        else assert.equal(hit.httpStatus, null, `${g.id}: no status on a call that got none`)
        assert.ok(Math.abs(t.startTime.getTime() - s.timeMs) <= 1000)
        assert.equal(t.root.duration, s.durationMs)
        assert.equal(t.root.tags['host.name'], s.host)
        assertNested(t)
      }
    }
  }
})

test('a trace decodes from its id alone, the same every time', () => {
  const g = groupsOf(REFERENCE_WINDOW, 'client').find(x => x.service === 'order-service')
  const [s] = errorSamplesFor(g, REFERENCE_WINDOW)
  assert.deepEqual(errorTraceRows(s.traceId), errorTraceRows(s.traceId))
  assert.deepEqual(buildTrace(s.traceId), buildTrace(s.traceId))
  // The call into payment-service is followed across the boundary, to the pool.
  const t = buildTrace(s.traceId)
  assert.ok(t.services.includes('payment-service'))
  assert.ok(t.errors.some(x => x.service === 'payment-service' && x.exception.type === POOL))

  assert.deepEqual(errorSamplesFor(g, REFERENCE_WINDOW), errorSamplesFor(g, REFERENCE_WINDOW))
  assert.equal(errorSeriesForWindow(REFERENCE_WINDOW), errorSeriesForWindow(REFERENCE_WINDOW), 'memoised per window')
  const again = resolveWindow({ kind: 'preset', value: '7d' }, nowMs)
  assert.deepEqual(errorSeriesForWindow(again, 'client'), errorSeriesForWindow(preset('7d'), 'client'))
})

// `/trace/<id>` is often the first thing a reload opens, with no window built
// and the span stream's counter wherever it happens to be. Nothing the page
// did before may change what the id decodes to.
test('a sample\'s trace does not depend on what else has been opened', () => {
  const g = groupsOf(REFERENCE_WINDOW, 'server')[0]
  const ids = errorSamplesFor(g, REFERENCE_WINDOW).map(s => s.traceId)
  const decoded = () => ids.map(id => JSON.stringify(errorTraceRows(id)))
  const before = decoded()
  for (const v of ['5m', '6h', 'today']) {
    const win = resolveWindow({ kind: 'preset', value: v })
    errorSpanRowsForWindow(win)
    for (const x of allGroups(win)) errorBreakdownFor(x, win)
    spanRowsForWindow(win)
  }
  assert.deepEqual(decoded(), before)
})

// A derived profile's jitter seed is handed out in the order the tables are
// first built, and the service page builds them RED, External, DB. The
// Errors page reading them in another order would redraw the DB and External
// tables' week — and its own counts — depending on which page was opened first.
test('reading the error profiles seeds the tables as the service page does', () => {
  errorSeriesForWindow(REFERENCE_WINDOW)
  const seed = table => errorRateProfiles(table)[0].rpm.seed
  assert.ok(seed('red') < seed('external') && seed('external') < seed('db'),
    `red ${seed('red')}, external ${seed('external')}, db ${seed('db')}`)
})

// The counts multiply these out bucket by bucket, so they have to be the very
// profiles the RED, DB and External tables average — at every range, not only
// at the hour both are calibrated on.
test('the error profiles are the ones the tables beside them read', () => {
  const round1 = v => Math.round(v * 10) / 10
  const tables = { red: redEndpointsForWindow, external: externalEndpointsForWindow, db: dbEndpointsForWindow }
  for (const win of [REFERENCE_WINDOW, preset('7d')]) {
    for (const [name, read] of Object.entries(tables)) {
      const rows = read(win)
      const profiles = errorRateProfiles(name)
      assert.deepEqual(profiles.map(p => p.endpoint), rows.map(r => r.endpoint))
      profiles.forEach((p, i) => {
        assert.equal(round1(windowMean(win, p.rpm)), rows[i].rpm, `${win.label} ${p.endpoint} rpm`)
        assert.equal(round1(windowMean(win, p.err)), rows[i].errPct, `${win.label} ${p.endpoint} err%`)
      })
    }
  }
  assert.deepEqual(errorRateProfiles('infra'), [])
})

test('sample ids are trace ids, unique, and never anybody else\'s', () => {
  const seeded = new Set(spanRows.map(r => r.traceId))
  for (const r of spanRowsForWindow(preset('7d'))) seeded.add(r.traceId)
  const seen = new Set()
  for (const win of [REFERENCE_WINDOW, preset('7d')]) {
    for (const g of allGroups(win)) {
      for (const s of errorSamplesFor(g, win)) {
        assert.match(s.traceId, /^[0-9a-f]{32}$/)
        assert.match(s.spanId, /^[0-9a-f]{16}$/)
        assert.ok(!seeded.has(s.traceId), `${s.traceId} collides with a seeded trace`)
        if (win === REFERENCE_WINDOW) {
          assert.ok(!seen.has(s.traceId), `${s.traceId} drawn twice`)
          seen.add(s.traceId)
        }
      }
    }
  }
  // Ids that are not samples keep their own path through buildTrace.
  for (const id of seeded) assert.equal(errorTraceRows(id), null)
  let x = 12345
  for (let i = 0; i < 200; i++) {
    let id = ''
    while (id.length < 32) { x = (x * 1103515245 + 12345) >>> 0; id += x.toString(16).padStart(8, '0') }
    assert.equal(errorTraceRows(id.slice(0, 32)), null)
  }
  assert.equal(errorTraceRows('not-a-trace'), null)
  assert.equal(errorTraceRows(null), null)
})

test('the service page\'s error requests open failing payment requests', () => {
  for (const r of errorRequests) {
    const t = buildTrace(r.traceId)
    assert.equal(t.root.service, 'payment-service')
    assert.equal(t.root.name, r.endpoint)
    assert.equal(t.root.duration, r.latencyMs)
    assert.equal(t.failed, true)
    assert.ok(t.errors.some(x => x.exception.type === POOL))
  }
})

// Landing every link through the chips TracesView builds is tracesHandoff's
// test. This one holds what the rows are: the drawer's newest sample of each
// group, so the span a link lands on is the occurrence the drawer opened on,
// and ids that can never be mistaken for a seeded span's.
test('the spans merged into Traces are each group\'s newest sample', () => {
  const ids = new Set(spanRows.map(r => r.id))
  for (const win of [REFERENCE_WINDOW, preset('7d')]) {
    const added = errorSpanRowsForWindow(win)
    const groups = allGroups(win)
    assert.equal(added.length, groups.length, 'one span a group')
    for (const g of groups) {
      // Three, not the drawer's ten: the first is the newest however many.
      const [s] = errorSamplesFor(g, win, 3)
      const r = added.find(x => x.traceId === s.traceId)
      assert.ok(r, `${g.id}: its newest sample is not in the merge`)
      assert.equal(r.spanId, s.spanId, `${g.id}: the span that recorded the exception`)
      const hits = added.filter(x => applyChipsToLog(x, filtersToChips(tracesFiltersFor(g)), getSpanFieldValue))
      assert.ok(hits.includes(r), `${g.id}: its own link does not find it`)
      if (g.side === 'client') assert.ok(hits.every(x => x.tags.root_name === g.endpoint), `${g.id}: its link finds other endpoints' calls`)
    }
    for (const r of added) {
      assert.ok(r.id.startsWith('err_') && !ids.has(r.id), `${r.id}`)
      assert.ok(r.time.getTime() >= win.start * 1000 && r.time.getTime() < Math.min(win.end, win.nowSec) * 1000)
      assert.equal(r.statusCode, 'ERROR')
    }
    assert.equal(errorSpanRowsForWindow(win), added, 'memoised per window')
  }
})
