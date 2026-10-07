import test from 'node:test'
import assert from 'node:assert/strict'

import { parsePromql, evaluateRange, evaluateInstant, PromqlError } from '@/utils/explore/promql'
import { buildQuickQuery } from '@/utils/explore/builders'

// A store standing in for data/explore/metricsStore: the same three methods the
// evaluator calls, over series whose value is a function of time. Counters are
// cumulative, because that is what the real one produces and what `rate` and
// `increase` are written against.
const EPOCH = 1_700_000_000

function makeStore(defs) {
  const series = defs.map((d, i) => ({ ...d, key: `s${i}` }))
  const byKey = new Map(series.map(s => [s.key, s]))

  const matches = (metric, m) => {
    const v = metric[m.label] ?? ''
    if (m.op === '=') return v === m.value
    if (m.op === '!=') return v !== m.value
    const re = new RegExp(`^(?:${m.value})$`)
    return m.op === '=~' ? re.test(v) : !re.test(v)
  }

  return {
    listMetricNames: () => [...new Set(series.map(s => s.metric.__name__))].sort(),
    selectSeries(matchers) {
      return series
        .filter(s => matchers.every(m => matches(s.metric, m)))
        .map(s => ({ metric: { ...s.metric }, key: s.key }))
    },
    sampleSeries(key, timestamps) {
      const s = byKey.get(key)
      return timestamps.map(t => s.at(t))
    },
    labelNames: () => [],
    labelValues: () => [],
  }
}

// 10 requests/second for payment, 4 for order; a tenth of payment's are errors.
const counter = (perSecond) => (t) => perSecond * (t - EPOCH)

const CALLS = [
  { metric: { __name__: 'cube_apm_calls_total', service: 'payment-service', span_kind: 'server', status_code: 'OK', root_name: 'POST /pay' }, at: counter(9) },
  { metric: { __name__: 'cube_apm_calls_total', service: 'payment-service', span_kind: 'server', status_code: 'ERROR', root_name: 'POST /pay' }, at: counter(1) },
  { metric: { __name__: 'cube_apm_calls_total', service: 'order-service', span_kind: 'server', status_code: 'OK', root_name: 'POST /order' }, at: counter(4) },
]

const range = { start: EPOCH + 600, end: EPOCH + 900, step: 60 }

function run(query, store, opts = range) {
  return evaluateRange(parsePromql(query), { ...opts, store })
}

const lastOf = (s) => s.values[s.values.length - 1][1]
const byService = (out) => Object.fromEntries(out.map(s => [s.metric.service, lastOf(s)]))

test('a bare selector returns every matching series with its labels', () => {
  const out = run('cube_apm_calls_total', makeStore(CALLS))
  assert.equal(out.length, 3)
  assert.equal(out[0].metric.__name__, 'cube_apm_calls_total')
  assert.equal(out[0].values.length, 6)
})

test('rate with no window uses the step, so a point covers the interval it is drawn for', () => {
  const out = run('rate(cube_apm_calls_total{status_code="OK", service="order-service"})', makeStore(CALLS))
  assert.equal(Math.round(lastOf(out[0])), 4)
})

test('an explicit window overrides the step', () => {
  const out = run('increase(cube_apm_calls_total{status_code="OK", service="order-service"}[5m])', makeStore(CALLS))
  assert.equal(Math.round(lastOf(out[0])), 4 * 300)
})

test('the RPM query our Quick tab writes returns requests per minute per service', () => {
  const query = buildQuickQuery({ type: 'quick', calculate: 'rpm', value: '90', labelPairs: [], groupBy: ['service'] })
  const out = run(query, makeStore(CALLS))
  const got = byService(out)
  assert.equal(Math.round(got['payment-service']), 600) // 10/s
  assert.equal(Math.round(got['order-service']), 240) // 4/s
})

test('the error-percentage query divides each slice by its own total', () => {
  const query = buildQuickQuery({ type: 'quick', calculate: 'error_percentage', value: '90', labelPairs: [], groupBy: ['service'] })
  const out = run(query, makeStore(CALLS))
  const got = byService(out)
  assert.ok(Math.abs(got['payment-service'] - 10) < 0.01, `payment ≈ 10%, got ${got['payment-service']}`)
  assert.ok(!('order-service' in got) || Number.isNaN(got['order-service']) || got['order-service'] === 0)
})

test('group_left spreads one total across the slices of a grouped numerator', () => {
  // Grouping by a "special" label makes the denominator coarser than the
  // numerator; without group_left this is a one-to-many error.
  const query = buildQuickQuery({
    type: 'quick', calculate: 'error_percentage', value: '90', labelPairs: [], groupBy: ['service', 'http_code'],
  })
  assert.match(query, /group_left/)
  const store = makeStore([
    ...CALLS,
    { metric: { __name__: 'cube_apm_calls_total', service: 'payment-service', span_kind: 'server', status_code: 'ERROR', http_code: '500' }, at: counter(1) },
  ])
  const out = run(query, store)
  assert.ok(out.length >= 1)
  for (const s of out) assert.ok(Number.isFinite(lastOf(s)))
})

test('`default 0` fills a gap without inventing a series', () => {
  const sparse = makeStore([
    { metric: { __name__: 'gaps', service: 'a' }, at: t => ((t - EPOCH) % 120 === 0 ? NaN : 5) },
  ])
  const filled = run('gaps default 0', sparse)
  assert.equal(filled.length, 1)
  assert.equal(filled[0].values.length, 6, 'every point is defined once the gap is filled')
  assert.ok(filled[0].values.some(([, v]) => v === 0))

  const missing = run('nothing_here default 0', sparse)
  assert.equal(missing.length, 0, 'a selector that matches nothing stays empty')
})

test('histogram_quantile reads VictoriaMetrics vmrange buckets', () => {
  // Two buckets: 80 observations in 0.1–0.2 s, 20 in 0.2–0.4 s. p90 lands in
  // the upper bucket, p50 in the lower one.
  const store = makeStore([
    { metric: { __name__: 'cube_apm_latency_bucket', service: 'payment-service', span_kind: 'server', vmrange: '1.000e-01...2.000e-01' }, at: counter(80) },
    { metric: { __name__: 'cube_apm_latency_bucket', service: 'payment-service', span_kind: 'server', vmrange: '2.000e-01...4.000e-01' }, at: counter(20) },
  ])
  const q = (p) => buildQuickQuery({ type: 'quick', calculate: 'latency_percentile', value: String(p), labelPairs: [], groupBy: ['service'] })
  const p90 = lastOf(run(q(90), store)[0])
  const p50 = lastOf(run(q(50), store)[0])
  assert.ok(p90 > 0.2 && p90 <= 0.4, `p90 in the upper bucket, got ${p90}`)
  assert.ok(p50 > 0.1 && p50 <= 0.2, `p50 in the lower bucket, got ${p50}`)
  assert.equal(run(q(90), store)[0].metric.vmrange, undefined, 'the bucket label is not part of the result')
})

test('average latency divides the summed time by the summed count', () => {
  const store = makeStore([
    { metric: { __name__: 'cube_apm_latency_total', service: 'payment-service', span_kind: 'server' }, at: counter(2) },
    { metric: { __name__: 'cube_apm_calls_total', service: 'payment-service', span_kind: 'server' }, at: counter(10) },
  ])
  const query = buildQuickQuery({ type: 'quick', calculate: 'latency_average', value: '90', labelPairs: [], groupBy: ['service'] })
  const out = run(query, store)
  // The generator writes latency in seconds or milliseconds depending on the
  // caller; either way it is 0.2 s per request.
  const expected = query.includes('* 1000') ? 200 : 0.2
  assert.ok(Math.abs(lastOf(out[0]) - expected) < 1e-6, `${expected} per request, got ${lastOf(out[0])}`)
})

test('an aggregation drops the metric name and keeps only its grouping labels', () => {
  const out = run('sum(cube_apm_calls_total) by (service)', makeStore(CALLS))
  assert.deepEqual(Object.keys(out[0].metric), ['service'])
})

test('`without` keeps every label it was not told to drop', () => {
  const out = run('sum(cube_apm_calls_total) without (status_code, root_name)', makeStore(CALLS))
  const labels = Object.keys(out[0].metric).sort()
  assert.deepEqual(labels, ['service', 'span_kind'])
})

test('topk hides the losers and keeps the winners whole', () => {
  const out = run('topk(1, sum(rate(cube_apm_calls_total)) by (service))', makeStore(CALLS))
  const live = out.filter(s => s.values.length)
  assert.equal(live.length, 1)
  assert.equal(live[0].metric.service, 'payment-service')
})

test('quantile and median aggregate across series', () => {
  const store = makeStore(CALLS)
  assert.ok(Number.isFinite(lastOf(run('quantile(0.5, sum(rate(cube_apm_calls_total)) by (service))', store)[0])))
  assert.ok(Number.isFinite(lastOf(run('median(sum(rate(cube_apm_calls_total)) by (service))', store)[0])))
})

test('scalar arithmetic, clamping and rounding apply pointwise', () => {
  const store = makeStore(CALLS)
  assert.equal(Math.round(lastOf(run('sum(rate(cube_apm_calls_total{service="order-service"})) * 60', store)[0])), 240)
  assert.equal(lastOf(run('clamp_max(sum(rate(cube_apm_calls_total)), 1)', store)[0]), 1)
  // 14 requests/second across the three series → 1400, already on the 0.1 grid.
  assert.ok(Math.abs(lastOf(run('round(sum(rate(cube_apm_calls_total)) * 100, 0.1)', store)[0]) - 1400) < 1e-6)
  assert.equal(lastOf(run('ceil(sum(rate(cube_apm_calls_total{service="order-service"})))', store)[0]), 4)
})

test('a comparison filters, and `bool` answers 1 or 0 instead', () => {
  const store = makeStore(CALLS)
  const filtered = run('sum(rate(cube_apm_calls_total)) by (service) > 5', store)
  assert.equal(filtered.length, 1)
  assert.equal(filtered[0].metric.service, 'payment-service')
  const asBool = run('sum(rate(cube_apm_calls_total)) by (service) > bool 5', store)
  assert.deepEqual(asBool.map(lastOf).sort(), [0, 1])
})

test('offset shifts the window back', () => {
  const store = makeStore(CALLS)
  const now = lastOf(run('cube_apm_calls_total{service="order-service", status_code="OK"}', store)[0])
  const before = lastOf(run('cube_apm_calls_total{service="order-service", status_code="OK"} offset 5m', store)[0])
  assert.equal(now - before, 4 * 300)
})

test('an instant evaluation returns one value per series, highest first', () => {
  const out = evaluateInstant(parsePromql('sum(rate(cube_apm_calls_total)) by (service)'), {
    time: EPOCH + 900, step: 60, store: makeStore(CALLS),
  })
  assert.equal(out.length, 2)
  assert.equal(Math.round(out[0].value), 10)
  assert.equal(out[0].metric.service, 'payment-service')
})

test('gaps are dropped from a range result rather than drawn as zero', () => {
  const store = makeStore([{ metric: { __name__: 'patchy' }, at: t => ((t - EPOCH) % 120 === 0 ? NaN : 1) }])
  const out = run('patchy', store)
  assert.ok(out[0].values.length < 6)
  assert.ok(out[0].values.every(([, v]) => Number.isFinite(v)))
})

test('an unknown function is reported as a query error, not a crash', () => {
  assert.throws(() => run('nosuchfunc(cube_apm_calls_total)', makeStore(CALLS)), (err) => {
    assert.ok(err instanceof PromqlError)
    assert.match(err.message, /unsupported function "nosuchfunc"/)
    return true
  })
})

test('every query our Quick tab can generate parses and evaluates', () => {
  const store = makeStore([
    ...CALLS,
    { metric: { __name__: 'cube_apm_latency_bucket', service: 'payment-service', span_kind: 'server', vmrange: '1.000e-01...2.000e-01' }, at: counter(50) },
    { metric: { __name__: 'cube_apm_latency_total', service: 'payment-service', span_kind: 'server' }, at: counter(2) },
  ])
  for (const calculate of ['rpm', 'error_percentage', 'latency_percentile', 'latency_average']) {
    for (const groupBy of [[], ['service'], ['service', 'root_name']]) {
      const query = buildQuickQuery({ type: 'quick', calculate, value: '90', labelPairs: [], groupBy })
      assert.doesNotThrow(() => run(query, store), `${calculate} by [${groupBy}] — ${query}`)
    }
  }
})

test('a 1h range over many series evaluates well inside the budget', () => {
  const defs = []
  for (let i = 0; i < 50; i++) {
    defs.push({ metric: { __name__: 'cube_apm_calls_total', service: `svc-${i}`, span_kind: 'server', status_code: 'OK' }, at: counter(1 + i) })
  }
  const store = makeStore(defs)
  const query = buildQuickQuery({ type: 'quick', calculate: 'rpm', value: '90', labelPairs: [], groupBy: ['service'] })
  const started = performance.now()
  const out = run(query, store, { start: EPOCH, end: EPOCH + 3600, step: 60 })
  const elapsed = performance.now() - started
  assert.equal(out.length, 50)
  assert.ok(elapsed < 50, `1h/60s over 50 series took ${elapsed.toFixed(1)}ms`)
})
