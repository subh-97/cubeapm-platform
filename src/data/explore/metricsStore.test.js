import test from 'node:test'
import assert from 'node:assert/strict'

import { services } from '@/data/services'
import { BASE_TIME } from '@/data/observability'
import {
  METRICS, LATENCY_BUCKETS, listMetricNames, selectSeries, sampleSeries, labelNames, labelValues,
} from '@/data/explore/metricsStore'

const NOW = Math.floor(BASE_TIME.getTime() / 1000)
const HOUR = { start: NOW - 3600, end: NOW, step: 60 }

const marks = ({ start, end, step }) => {
  const out = []
  for (let t = start; t <= end; t += step) out.push(t)
  return out
}

/** Total events a counter accumulated across a window, summed over its series. */
function totalOver(matchers, span = HOUR) {
  const ts = marks(span)
  let total = 0
  for (const s of selectSeries(matchers, span)) {
    const values = sampleSeries(s.key, ts)
    total += values[values.length - 1] - values[0]
  }
  return total
}

const eq = (label, value) => ({ label, op: '=', value })
const re = (label, value) => ({ label, op: '=~', value })
const calls = (...extra) => [eq('__name__', 'cube_apm_calls_total'), re('span_kind', 'server|consumer'), ...extra]

test('the catalogue lists the APM metrics and the rollups a coarse step switches to', () => {
  const names = listMetricNames()
  for (const m of METRICS) assert.ok(names.includes(m.name), `${m.name} is listed`)
  assert.ok(names.includes('cube_apm_calls_total:increase15m'))
  assert.ok(names.includes('cube_apm_latency:increase15m_bucket'))
  assert.deepEqual(names, [...names].sort(), 'names come back sorted')
})

test('sampling is deterministic — the same window twice gives the same numbers', () => {
  const [s] = selectSeries(calls(eq('service', 'payment-service')), HOUR)
  const a = sampleSeries(s.key, marks(HOUR))
  const b = sampleSeries(s.key, marks(HOUR))
  assert.deepEqual(a, b)
})

test('a counter only ever climbs', () => {
  const [s] = selectSeries(calls(eq('service', 'order-service')), HOUR)
  const values = sampleSeries(s.key, marks(HOUR))
  for (let i = 1; i < values.length; i++) {
    assert.ok(values[i] >= values[i - 1], `sample ${i} did not go backwards`)
  }
})

test('a counter is consistent however it is sampled', () => {
  // The same hour read at 60s and at 300s has to have accumulated the same
  // amount, or `rate` would depend on the chart's step.
  const [s] = selectSeries(calls(eq('service', 'search-service')), HOUR)
  const fine = sampleSeries(s.key, marks(HOUR))
  const coarse = sampleSeries(s.key, marks({ ...HOUR, step: 300 }))
  const a = fine[fine.length - 1] - fine[0]
  const b = coarse[coarse.length - 1] - coarse[0]
  assert.ok(Math.abs(a - b) / a < 0.02, `60s gave ${a.toFixed(1)}, 300s gave ${b.toFixed(1)}`)
})

test('requests per minute match what the service list publishes', () => {
  for (const svc of services) {
    const total = totalOver(calls(eq('service', svc.id)))
    const rpm = total / 60
    const drift = Math.abs(rpm - svc.rpm) / svc.rpm
    // Tight on purpose: the default hour must reproduce the published figure at
    // any time of day, which is what the daily wave's normalisation buys.
    assert.ok(drift < 0.04, `${svc.id}: ${rpm.toFixed(0)} rpm vs published ${svc.rpm} (${(drift * 100).toFixed(1)}% off)`)
  }
})

test('the error rate matches what the service list publishes', () => {
  for (const svc of services) {
    const all = totalOver(calls(eq('service', svc.id)))
    const errors = totalOver(calls(eq('service', svc.id), eq('status_code', 'ERROR')))
    const pct = (errors * 100) / all
    if (svc.errorRatePct === 0) {
      assert.equal(errors, 0, `${svc.id} publishes no errors, so it should report none`)
      continue
    }
    const drift = Math.abs(pct - svc.errorRatePct) / svc.errorRatePct
    assert.ok(drift < 0.15, `${svc.id}: ${pct.toFixed(2)}% vs published ${svc.errorRatePct}%`)
  }
})

test('a service that never errors has no error series at all', () => {
  const clean = services.filter(s => s.errorRatePct === 0)
  assert.ok(clean.length, 'the fixture has at least one clean service')
  for (const svc of clean) {
    assert.equal(selectSeries(calls(eq('service', svc.id), eq('status_code', 'ERROR')), HOUR).length, 0)
  }
})

// p90 read back exactly the way histogram_quantile reads it, so the store and
// the query agree about what the buckets mean.
function p90Over(service, span = HOUR) {
  const ts = marks(span)
  const weights = new Map()
  for (const s of selectSeries([eq('__name__', 'cube_apm_latency_bucket'), eq('service', service)], span)) {
    const values = sampleSeries(s.key, ts)
    const count = values[values.length - 1] - values[0]
    weights.set(s.metric.vmrange, (weights.get(s.metric.vmrange) || 0) + count)
  }
  const ordered = LATENCY_BUCKETS.map(b => ({ ...b, count: weights.get(b.vmrange) || 0 }))
  const total = ordered.reduce((a, b) => a + b.count, 0)
  if (total <= 0) return NaN
  const want = 0.9 * total
  let seen = 0
  for (const b of ordered) {
    if (seen + b.count >= want) {
      return b.count > 0 ? b.lo + ((b.hi - b.lo) * (want - seen)) / b.count : b.hi
    }
    seen += b.count
  }
  return ordered[ordered.length - 1].hi
}

test('p90 latency matches what the service list publishes', () => {
  for (const svc of services) {
    const p90 = p90Over(svc.id) * 1000
    const drift = Math.abs(p90 - svc.latencyP90) / svc.latencyP90
    assert.ok(drift < 0.2, `${svc.id}: p90 ${p90.toFixed(0)}ms vs published ${svc.latencyP90}ms`)
  }
})

test('the incident is in the last 22 minutes and not before them', () => {
  const during = p90Over('payment-service', { start: NOW - 15 * 60, end: NOW, step: 60 }) * 1000
  const before = p90Over('payment-service', { start: NOW - 180 * 60, end: NOW - 40 * 60, step: 60 }) * 1000
  assert.ok(during > before * 2, `during ${during.toFixed(0)}ms should dwarf before ${before.toFixed(0)}ms`)
  assert.ok(before < 260, `before the incident p90 sits near its baseline, got ${before.toFixed(0)}ms`)

  const errorsDuring = totalOver(calls(eq('service', 'payment-service'), eq('status_code', 'ERROR')), { start: NOW - 15 * 60, end: NOW, step: 60 })
  const callsDuring = totalOver(calls(eq('service', 'payment-service')), { start: NOW - 15 * 60, end: NOW, step: 60 })
  assert.ok((errorsDuring * 100) / callsDuring > 8, 'errors are well above baseline while the pool is failing')
})

test('only payment-service is in trouble', () => {
  for (const svc of services.filter(s => s.id !== 'payment-service')) {
    const recent = p90Over(svc.id, { start: NOW - 15 * 60, end: NOW, step: 60 }) * 1000
    const earlier = p90Over(svc.id, { start: NOW - 180 * 60, end: NOW - 40 * 60, step: 60 }) * 1000
    assert.ok(recent < earlier * 1.6, `${svc.id} should be steady, ${earlier.toFixed(0)} → ${recent.toFixed(0)}ms`)
  }
})

test('label values narrow to the series the match selects', () => {
  const all = labelValues('service', ['cube_apm_calls_total'], HOUR)
  assert.deepEqual(all, [...services.map(s => s.id)].sort())

  const endpoints = labelValues('root_name', ['cube_apm_calls_total{service="payment-service"}'], HOUR)
  assert.ok(endpoints.length >= 3)
  assert.ok(endpoints.every(e => e.includes('/v1/payment')), `payment's endpoints only: ${endpoints}`)

  const other = labelValues('root_name', ['cube_apm_calls_total{service="search-service"}'], HOUR)
  assert.ok(!other.some(e => e.includes('/v1/payment')))
})

test('label names come from the selected series, __name__ among them', () => {
  const names = labelNames(['cube_apm_calls_total{service="payment-service"}'], HOUR)
  // `__name__` is an ordinary label holding the metric name, and the label
  // pickers offer it as one.
  assert.ok(names.includes('__name__'))
  for (const expected of ['env', 'service', 'root_name', 'span_kind', 'host.name', 'service.version']) {
    assert.ok(names.includes(expected), `${expected} is a label on calls`)
  }
  assert.ok(labelNames(['cube_apm_latency_bucket'], HOUR).includes('vmrange'))
})

test('the version label tells the incident story', () => {
  const versions = labelValues('service.version', ['cube_apm_calls_total{service="payment-service"}'], HOUR)
  assert.deepEqual(versions, ['v9.10.1', 'v9.11.0'], 'payment-service is mid-rollout')
  assert.deepEqual(labelValues('service.version', ['cube_apm_calls_total{service="order-service"}'], HOUR), ['v9.10.1'])
})

test('hosts are ones the app can drill into', () => {
  const hosts = labelValues('host.name', ['cube_apm_calls_total{service="payment-service"}'], HOUR)
  assert.deepEqual(hosts, ['ip-10-0-142-133', 'ip-10-0-142-2'])
})

test('a rollup name answers under the name it was asked for', () => {
  const found = selectSeries([eq('__name__', 'cube_apm_calls_total:increase15m'), eq('service', 'order-service')], HOUR)
  assert.ok(found.length, 'the rollup resolves to the raw series')
  assert.equal(found[0].metric.__name__, 'cube_apm_calls_total:increase15m')
})

test('client spans carry the dependency they called', () => {
  const targets = labelValues('group_name', ['cube_apm_calls_total{service="payment-service", span_kind="client"}'], HOUR)
  assert.ok(targets.includes('redis.0'), `redis.0 is one of payment's dependencies: ${targets}`)
})

test('a seven-day window stays inside its budget', () => {
  const span = { start: NOW - 7 * 86400, end: NOW, step: 900 }
  const started = performance.now()
  const found = selectSeries(calls(), span)
  const ts = marks(span)
  for (const s of found) sampleSeries(s.key, ts)
  const elapsed = performance.now() - started
  assert.ok(found.length > 20, `a 7-day select finds the fleet, got ${found.length}`)
  assert.ok(elapsed < 300, `7d/900s over ${found.length} series took ${elapsed.toFixed(0)}ms`)
})
