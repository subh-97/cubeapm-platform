// The synthetic logs/traces store (ARCH C8 / D12).
//
// What is worth asserting about a generator is not the numbers it happens to
// produce — those are allowed to move — but the four properties the rest of
// Explore is built on: the same window always reads the same rows, the weights
// add up to a believable volume, the payment incident is visible exactly where
// it is supposed to be, and a field name from our own Logs/Traces vocabulary
// resolves.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BASE_TIME } from '@/data/observability'
import {
  eventsFor, getField, incidentFactor,
  LOG_FIELDS, TRACE_FIELDS, LOG_STREAM_FIELDS, TRACE_STREAM_FIELDS,
} from './eventsStore.js'

// Explore floors both ends of every window to the step (timeRange.resolveRange),
// so an aligned NOW is what the store is actually asked for.
const NOW = Math.floor(BASE_TIME.getTime() / 60_000) * 60
const hour = { start: NOW - 3600, end: NOW, step: 60 }
const WEEK = { start: Math.floor((NOW - 7 * 86400) / 900) * 900, end: Math.floor(NOW / 900) * 900, step: 900 }

const sum = (rows, keep = () => true) =>
  rows.reduce((a, r) => a + (keep(r) ? r._weight : 0), 0)

// ---------- determinism ----------

test('the same window reads the same rows, every time', () => {
  for (const ds of ['vlogs', 'traces']) {
    const a = eventsFor(ds, hour)
    const b = eventsFor(ds, hour)
    assert.ok(a.length > 0, `${ds} produced no rows`)
    assert.deepEqual(a, b)
  }
})

test('two windows agree on the buckets they share', () => {
  const wide = eventsFor('vlogs', { start: NOW - 7200, end: NOW, step: 60 })
  const narrow = eventsFor('vlogs', { start: NOW - 3600, end: NOW, step: 60 })
  const overlap = wide.filter(r => r._time >= (NOW - 3600) * 1000)
  assert.deepEqual(overlap, narrow)
})

test('rows come back oldest first and inside the window', () => {
  const rows = eventsFor('traces', hour)
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i]._time >= rows[i - 1]._time)
  assert.ok(rows[0]._time >= hour.start * 1000)
  assert.ok(rows[rows.length - 1]._time < hour.end * 1000)
})

test('a window with no width, a bad step or junk arguments is no rows, not a throw', () => {
  assert.deepEqual(eventsFor('vlogs', { start: NOW, end: NOW, step: 60 }), [])
  assert.deepEqual(eventsFor('vlogs', { start: NOW - 60, end: NOW, step: 0 }), [])
  assert.deepEqual(eventsFor('vlogs', { start: NaN, end: NOW, step: 60 }), [])
  assert.deepEqual(eventsFor('vlogs'), [])
})

test('an unknown datasource reads as logs; traces is the only other one', () => {
  assert.deepEqual(eventsFor('mobile', hour), eventsFor('vlogs', hour))
  assert.notDeepEqual(eventsFor('traces', hour), eventsFor('vlogs', hour))
})

// ---------- volumes ----------

test('weights add up to a few thousand logs and ~10^5 spans an hour', () => {
  const logs = sum(eventsFor('vlogs', hour))
  const spans = sum(eventsFor('traces', hour))
  assert.ok(logs > 2_000 && logs < 20_000, `logs/hour = ${logs}`)
  assert.ok(spans > 30_000 && spans < 500_000, `spans/hour = ${spans}`)
  // Sampled rows stay bounded no matter how much volume they stand for.
  assert.ok(eventsFor('traces', hour).length <= 61 * 24)
})

test('a 7-day window costs the same per bucket as a 1-hour one, and scales its volume', () => {
  const week = eventsFor('vlogs', WEEK)
  const perHour = sum(week) / (7 * 24)
  assert.ok(perHour > 2_000 && perHour < 20_000, `logs/hour over 7d = ${perHour}`)
  // Rows are bounded by buckets, not by the volume they stand for.
  assert.equal(week.length, (7 * 86400 / 900) * 24)
})

test('server spans alone are tens of thousands an hour', () => {
  const spans = eventsFor('traces', hour)
  const server = sum(spans, r => r.span_kind === 'server')
  assert.ok(server > 10_000 && server < 100_000, `server spans/hour = ${server}`)
})

// ---------- the incident ----------

test('incidentFactor is 0 before −22 min, ramps over 4 min, then holds at 1', () => {
  const t = BASE_TIME.getTime()
  assert.equal(incidentFactor(t - 30 * 60_000), 0)
  assert.equal(incidentFactor(t - 22 * 60_000), 0)
  assert.ok(Math.abs(incidentFactor(t - 20 * 60_000) - 0.5) < 1e-9)
  assert.equal(incidentFactor(t - 18 * 60_000), 1)
  assert.equal(incidentFactor(t), 1)
})

test('payment error logs jump in the last 22 minutes and not before', () => {
  const rows = eventsFor('vlogs', { start: NOW - 3 * 3600, end: NOW, step: 60 })
  const cut = (NOW - 22 * 60) * 1000
  const isPaymentError = r => r.service === 'payment' && r['log.level'] === 'error'
  const during = sum(rows, r => isPaymentError(r) && r._time >= cut) / 22
  const before = sum(rows, r => isPaymentError(r) && r._time < cut) / (3 * 60 - 22)
  assert.ok(before > 0, 'no payment errors before the incident at all')
  assert.ok(during / before > 4, `payment errors/min ${before} → ${during}`)
})

test('the incident messages are the connection and Redis-pool ones, and only during it', () => {
  const rows = eventsFor('vlogs', { start: NOW - 3 * 3600, end: NOW, step: 60 })
  const cut = (NOW - 22 * 60) * 1000
  const redis = r => r._msg.startsWith('Redis connection pool exhausted')
  assert.ok(sum(rows, r => redis(r) && r._time >= cut) > 0, 'no Redis-pool errors during the incident')
  assert.equal(sum(rows, r => redis(r) && r._time < cut), 0)
  const db = rows.filter(r => r._msg === 'Failed connecting to database' && r._time >= cut)
  assert.ok(db.length > 0)
  assert.equal(db[0]['log.exception.type'], 'java.lang.RuntimeException')
})

test('payment spans go slow and go red in the last 22 minutes', () => {
  const rows = eventsFor('traces', { start: NOW - 3 * 3600, end: NOW, step: 60 })
  const cut = (NOW - 22 * 60) * 1000
  const payment = rows.filter(r => r.service === 'payment-service' && r.span_kind === 'server')
  const errPct = (list) => sum(list, r => r.status_code === 'ERROR') / sum(list)
  const during = payment.filter(r => r._time >= cut)
  const before = payment.filter(r => r._time < cut)
  assert.ok(errPct(during) > 0.2, `error share during = ${errPct(during)}`)
  assert.ok(errPct(before) < 0.15, `error share before = ${errPct(before)}`)

  const median = (list) => {
    const d = list.map(r => r.duration).sort((a, b) => a - b)
    return d[Math.floor(d.length / 2)]
  }
  assert.ok(median(during) > 2 * median(before), `p50 ns ${median(before)} → ${median(during)}`)
})

test('nothing else is pulled into the incident', () => {
  const rows = eventsFor('traces', { start: NOW - 3 * 3600, end: NOW, step: 60 })
  const cut = (NOW - 22 * 60) * 1000
  const order = rows.filter(r => r.service === 'order-service')
  const errPct = (list) => sum(list, r => r.status_code === 'ERROR') / sum(list)
  assert.ok(Math.abs(errPct(order.filter(r => r._time >= cut)) - errPct(order.filter(r => r._time < cut))) < 0.1)
})

// ---------- the field accessor ----------

test('getField reads the server fields, dotted names and missing fields', () => {
  const row = eventsFor('vlogs', hour).find(r => r.service === 'payment')
  assert.ok(row, 'no payment log in the hour')
  assert.equal(getField(row, '_msg'), row._msg)
  assert.equal(getField(row, '_time'), row._time)
  assert.deepEqual(getField(row, '_stream'), row._stream)
  assert.equal(getField(row, 'service'), 'payment')
  assert.equal(getField(row, 'host.name'), row['host.name'])
  assert.equal(getField(row, 'log.level'), row['log.level'])
  assert.equal(getField(row, 'no.such.field'), undefined)
  assert.equal(getField(null, 'service'), undefined)
  assert.equal(getField(row, ''), undefined)
})

test('a span row answers to the trace spellings, with duration in nanoseconds', () => {
  const row = eventsFor('traces', hour).find(r => r.span_kind === 'server')
  assert.equal(getField(row, '_msg'), row.span_name)
  assert.equal(getField(row, 'event.domain'), 'span')
  assert.equal(getField(row, 'service.version').startsWith('v9.'), true)
  assert.equal(typeof getField(row, 'duration'), 'number')
  // A server span is milliseconds, so in ns it is at least seven digits.
  assert.ok(getField(row, 'duration') > 1e6, `duration = ${row.duration}`)
  assert.equal(typeof getField(row, 'http.status_code'), 'string')
})

// ---------- vocabulary ----------

test('stream fields are on the row twice: flat, and gathered into _stream', () => {
  for (const [ds, fields] of [['vlogs', LOG_STREAM_FIELDS], ['traces', TRACE_STREAM_FIELDS]]) {
    for (const row of eventsFor(ds, hour).slice(0, 50)) {
      assert.equal(typeof row._stream, 'object')
      for (const [k, v] of Object.entries(row._stream)) {
        assert.ok(fields.some(f => f.field === k), `${ds}: ${k} is not a stream field`)
        assert.equal(row[k], v)
      }
      assert.equal(row._stream.env, 'UNSET')
    }
  }
})

test('the catalogs are { field, type, desc } and cover what the rows carry', () => {
  for (const cat of [LOG_FIELDS, TRACE_FIELDS, LOG_STREAM_FIELDS, TRACE_STREAM_FIELDS]) {
    assert.ok(cat.length > 0)
    for (const f of cat) {
      assert.equal(typeof f.field, 'string')
      assert.ok(['string', 'keyword'].includes(f.type))
      assert.equal(typeof f.desc, 'string')
    }
  }
  const named = (cat) => new Set(cat.map(f => f.field))
  const logNames = named(LOG_FIELDS)
  const traceNames = named(TRACE_FIELDS)
  const internal = new Set(['_time', '_weight', '_msg', '_stream'])
  for (const [rows, names] of [[eventsFor('vlogs', hour), logNames], [eventsFor('traces', hour), traceNames]]) {
    for (const r of rows.slice(0, 200)) {
      for (const k of Object.keys(r)) {
        if (!internal.has(k)) assert.ok(names.has(k), `${k} is on a row but not in the catalog`)
      }
    }
  }
})

test('the value spaces are the ones our Logs and Traces pages already use', () => {
  const logs = eventsFor('vlogs', hour)
  const services = new Set(logs.map(r => r.service).filter(Boolean))
  // Short names, as observability.js spells them — never `payment-service`.
  assert.ok(['order', 'payment', 'shipment', 'search'].every(s => services.has(s)))
  assert.ok(![...services].some(s => s.endsWith('-service')))
  const levels = new Set(logs.map(r => r['log.level']).filter(Boolean))
  assert.deepEqual([...levels].sort(), ['error', 'info', 'warn'])
  assert.ok(logs.every(r => r.env === 'UNSET'))
  // `endpoint` is the route the Logs page filters on; `path` is its concrete twin.
  assert.ok(logs.filter(r => r.endpoint).every(r => r.endpoint.startsWith('/v1/')))

  const spans = eventsFor('traces', hour)
  const kinds = new Set(spans.map(r => r.span_kind))
  assert.deepEqual([...kinds].sort(), ['client', 'internal', 'server'])
  assert.deepEqual([...new Set(spans.map(r => r.status_code))].sort(), ['ERROR', 'UNSET'])
  const spanServices = new Set(spans.map(r => r.service))
  assert.ok(['payment-service', 'order-service', 'shipment-service', 'cubedemo-web'].every(s => spanServices.has(s)))
  assert.ok(spans.every(r => typeof r.root_name === 'string' && r.root_name.includes(' /')))
  assert.ok(spans.some(r => r['host.name'].startsWith('cubedemo-prod-eks-')))
})

test('an error span records the exception only where the process boundary is', () => {
  const spans = eventsFor('traces', { start: NOW - 3 * 3600, end: NOW, step: 60 })
  const errors = spans.filter(r => r.status_code === 'ERROR')
  assert.ok(errors.length > 0)
  for (const r of errors) {
    assert.equal(r.error, 'true')
    if (r.span_kind === 'internal') assert.equal(r['exception.type'], undefined)
    else assert.ok(r['exception.type'])
  }
  assert.ok(spans.filter(r => r.status_code === 'UNSET').every(r => r.error === undefined))
})

// ---------- performance (ARCH C8) ----------

test('1h at 60s is under 30 ms and 7d at 900s under 250 ms', () => {
  // The first call pays for module warm-up, so measure a second one.
  eventsFor('vlogs', hour)
  eventsFor('traces', hour)

  for (const ds of ['vlogs', 'traces']) {
    let t = performance.now()
    eventsFor(ds, hour)
    const fast = performance.now() - t
    assert.ok(fast < 30, `${ds} 1h/60s took ${fast.toFixed(1)} ms`)

    t = performance.now()
    eventsFor(ds, WEEK)
    const slow = performance.now() - t
    assert.ok(slow < 250, `${ds} 7d/900s took ${slow.toFixed(1)} ms`)
  }
})

// ---------- the default query's grouping field ----------

// Explore opens each datasource on a chart rather than an empty builder, which
// only works if the field it groups by is one every record carries. Grouping
// logs by `log.level` looked like the obvious default and was the wrong one:
// only application logs have a level, so four fifths of the volume collapsed
// into a single unlabelled bucket that dwarfed every real series.
test('the field the default query groups by is on every record', () => {
  for (const [datasource, field] of [['vlogs', 'host.name'], ['traces', 'service']]) {
    const rows = eventsFor(datasource, hour)
    const total = rows.reduce((a, r) => a + (r._weight || 1), 0)
    const covered = rows.reduce((a, r) => {
      const v = getField(r, field)
      return a + (v === undefined || v === '' ? 0 : (r._weight || 1))
    }, 0)
    assert.equal(covered, total, `${datasource}: every record has ${field}`)

    // And it has to say something: one value for everything is a chart with a
    // single line, which is no more use than no grouping at all.
    const values = new Set(rows.map(r => getField(r, field)))
    assert.ok(values.size >= 3, `${datasource}: ${field} takes ${values.size} values, wanted a few`)
  }
})
