// The Explore mock API end to end: macro substitution, the query calls over
// the in-browser engines, the server rules and error texts, abort handling,
// and the metadata the editors' option lists come from.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ExploreQueryError, substituteMacros, setSimulatedLatency, queryRange, queryInstant, queryReduced,
  metricNames, metricLabelNames, metricLabelValues, logFieldNames, logFieldValues,
  logStreamFieldNames, logStreamFieldValues, MAX_POINTS,
} from './api.js'
import { resolveRange } from '@/utils/timeRange.js'

setSimulatedLatency(0)

const HOUR = resolveRange({ kind: 'preset', value: '1h' }, Date.now())
const DAY = resolveRange({ kind: 'preset', value: '24h' }, Date.now())
const win = (r = HOUR) => ({ start: r.start, end: r.end, step: r.step })
const SERVICES = [
  'analytics-service', 'demo-nodejs-service', 'notify-service', 'order-service',
  'payment-service', 'search-service', 'shipment-service',
]

// ---------- macros ----------

test('macros: range, step, and the step-dependent helpers', () => {
  const w = { start: 1000, end: 4600, step: 60 }
  assert.equal(substituteMacros('x[$__range_s] $__range $__step', w), 'x[3600s] 3600 60')
  assert.equal(substituteMacros('$__increase(x) $__default_0', w), 'increase(x) default 0')
  const big = { start: 0, end: 86400, step: 900 }
  assert.equal(substituteMacros('$__increase(x) $__default_0', big), 'sum_over_time(x) ')
})

test('macros: the worked example over 1h and 24h', () => {
  const q = 'sum($__increase($__cube_apm_calls_total{service="checkout"}[$__range_s]))'
  assert.equal(substituteMacros(q, { start: 0, end: 3600, step: 60 }),
    'sum(increase(cube_apm_calls_total{service="checkout"}[3600s]))')
  assert.equal(substituteMacros(q, { start: 0, end: 86400, step: 900 }),
    'sum(sum_over_time(cube_apm_calls_total:increase15m{service="checkout"}[86400s]))')
})

test('macros: every $__cube_apm_ name maps to the reference rollup table', () => {
  const hot = {
    calls_total: 'cube_apm_calls_total:increase15m',
    latency_count: 'cube_apm_latency:increase15m_count',
    latency_sum: 'cube_apm_latency:increase15m_sum',
    latency_bucket: 'cube_apm_latency:increase15m_bucket',
    errors_total: 'cube_apm_errors_total:increase15m',
    latency_total: 'cube_apm_latency_total:increase15m',
    frontend_pageload_calls_total: 'cube_apm_frontend_pageload_calls_total:increase15m',
    frontend_pageload_duration_total: 'cube_apm_frontend_pageload_duration_total:increase15m',
    frontend_pageload_duration_count: 'cube_apm_frontend_pageload_duration:increase15m_count',
    frontend_pageload_duration_sum: 'cube_apm_frontend_pageload_duration:increase15m_sum',
    frontend_pageload_duration_bucket: 'cube_apm_frontend_pageload_duration:increase15m_bucket',
    frontend_ajax_calls_total: 'cube_apm_frontend_ajax_calls_total:increase15m',
    frontend_ajax_duration_total: 'cube_apm_frontend_ajax_duration_total:increase15m',
    frontend_errors_total: 'cube_apm_frontend_errors_total:increase15m',
    frontend_webvitals_inp_count: 'cube_apm_frontend_webvitals_inp:increase15m_count',
    frontend_webvitals_inp_sum: 'cube_apm_frontend_webvitals_inp:increase15m_sum',
    frontend_webvitals_inp_bucket: 'cube_apm_frontend_webvitals_inp:increase15m_bucket',
    frontend_webvitals_lcp_count: 'cube_apm_frontend_webvitals_lcp:increase15m_count',
    frontend_webvitals_lcp_sum: 'cube_apm_frontend_webvitals_lcp:increase15m_sum',
    frontend_webvitals_lcp_bucket: 'cube_apm_frontend_webvitals_lcp:increase15m_bucket',
    frontend_webvitals_cls_count: 'cube_apm_frontend_webvitals_cls:increase15m_count',
    frontend_webvitals_cls_sum: 'cube_apm_frontend_webvitals_cls:increase15m_sum',
    frontend_webvitals_cls_bucket: 'cube_apm_frontend_webvitals_cls:increase15m_bucket',
  }
  assert.equal(Object.keys(hot).length, 23)
  for (const [name, rollup] of Object.entries(hot)) {
    assert.equal(substituteMacros(`$__cube_apm_${name}`, { start: 0, end: 86400, step: 900 }), rollup, name)
    assert.equal(substituteMacros(`$__cube_apm_${name}`, { start: 0, end: 3600, step: 60 }), `cube_apm_${name}`, name)
  }
})

test('macros apply blindly, inside strings and to LogsQL too', () => {
  assert.equal(substituteMacros('* | stats count() as c | math c / $__step as per_sec', { start: 0, end: 3600, step: 60 }),
    '* | stats count() as c | math c / 60 as per_sec')
  assert.equal(substituteMacros('x{a="$__step"}', { start: 0, end: 60, step: 15 }), 'x{a="15"}')
})

// ---------- errors and plumbing ----------

test('an empty query is an ExploreQueryError, for every datasource', async () => {
  for (const datasource of ['prometheus', 'vlogs', 'traces']) {
    await assert.rejects(queryRange({ datasource, query: '  ', ...win() }), (err) => {
      assert.ok(err instanceof ExploreQueryError)
      assert.equal(err.message, 'query cannot be empty')
      return true
    })
  }
})

test('too many points per series is refused before evaluating', async () => {
  await assert.rejects(
    queryRange({ datasource: 'prometheus', query: 'vector(1)', start: 0, end: MAX_POINTS * 60, step: 60 }),
    /too many points/,
  )
})

test('an aborted request rejects with AbortError and never resolves', async () => {
  const prev = setSimulatedLatency(1)
  try {
    const ctrl = new AbortController()
    const p = queryRange({ datasource: 'prometheus', query: 'vector(1)', ...win(), signal: ctrl.signal })
    ctrl.abort()
    await assert.rejects(p, { name: 'AbortError' })
    const pre = new AbortController()
    pre.abort()
    await assert.rejects(metricNames({ ...win(), signal: pre.signal }), { name: 'AbortError' })
  } finally {
    setSimulatedLatency(prev)
  }
})

test('simulated latency: a query waits 180-420 ms, deterministically', async () => {
  const prev = setSimulatedLatency(1)
  try {
    const t = Date.now()
    await queryRange({ datasource: 'prometheus', query: 'vector(1)', ...win() })
    const took = Date.now() - t
    assert.ok(took >= 170 && took < 900, `took ${took} ms`)
  } finally {
    setSimulatedLatency(prev)
  }
})

// ---------- metrics ----------

test('rpm by service: one series per service, points on the step grid, ms x values', async () => {
  const { series } = await queryRange({
    datasource: 'prometheus', query: 'sum(rate(cube_apm_calls_total[5m])) by (service) * 60', ...win(),
  })
  assert.deepEqual(series.map(s => s.metric.service).sort(), SERVICES)
  for (const s of series) {
    assert.equal(s.metric.__name__, undefined, 'aggregation drops __name__')
    assert.ok(s.values.length > 50)
    for (const p of s.values) {
      assert.equal((p.x / 1000 - HOUR.start) % HOUR.step, 0)
      assert.ok(Number.isFinite(p.y) && p.y >= 0)
    }
  }
})

test('the Quick-style query with macros runs over 1h and 24h', async () => {
  const q = 'sum($__increase($__cube_apm_calls_total{span_kind=~"server|consumer"}[$__range_s])) by (service)'
  const hour = await queryRange({ datasource: 'prometheus', query: q, ...win() })
  assert.ok(hour.series.length >= 1)
  const day = await queryRange({ datasource: 'prometheus', query: q, ...win(DAY) })
  assert.ok(day.series.length >= 1)
})

test('metrics errors carry the VictoriaMetrics "error when executing" prefix', async () => {
  await assert.rejects(queryRange({ datasource: 'prometheus', query: 'foo_bar_fn(cube_apm_calls_total)', ...win() }), (err) => {
    assert.ok(err instanceof ExploreQueryError)
    assert.match(err.message, /^error when executing query="foo_bar_fn\(cube_apm_calls_total\)" on the time range \(start=\d+, end=\d+, step=60000\): /)
    assert.match(err.message, /unsupported function "foo_bar_fn"/)
    return true
  })
  await assert.rejects(queryRange({ datasource: 'prometheus', query: 'sum by (service', ...win() }), /error when executing query=/)
})

test('instant results are sorted by value, highest first', async () => {
  const { series } = await queryInstant({
    datasource: 'prometheus', query: 'sum(rate(cube_apm_calls_total[5m])) by (service)', time: HOUR.end, step: HOUR.step,
  })
  assert.equal(series.length, 7)
  for (let i = 1; i < series.length; i++) assert.ok(series[i - 1].value >= series[i].value)
  assert.ok(typeof series[0].value === 'number')
})

test('queryReduced: latest is instant, average reduces the range; both highest first', async () => {
  const query = 'sum(rate(cube_apm_calls_total[5m])) by (service)'
  const last = await queryReduced({ datasource: 'prometheus', query, ...win(), formula: 'last' })
  assert.equal(last.series.length, 7)
  assert.deepEqual(last.series[0].values, [])
  const avg = await queryReduced({ datasource: 'prometheus', query, ...win(), formula: 'avg' })
  assert.equal(avg.series.length, 7)
  assert.ok(avg.series[0].values.length > 0)
  for (let i = 1; i < avg.series.length; i++) assert.ok(avg.series[i - 1].value >= avg.series[i].value)
  await assert.rejects(queryReduced({ datasource: 'prometheus', query, ...win(), formula: 'max' }), /Unsupported formula/)
})

test('the payment incident shows in p90 latency', async () => {
  const q = 'histogram_quantile(0.9, sum(rate(cube_apm_latency_bucket{service="payment-service"}[5m])) by (vmrange))'
  const { series } = await queryRange({ datasource: 'prometheus', query: q, ...win() })
  assert.equal(series.length, 1)
  const ys = series[0].values.map(p => p.y)
  // Seconds: ~140 ms before the incident, ~600 ms at the end of the hour.
  assert.ok(ys[0] < 0.3, `early p90 ${ys[0]}`)
  assert.ok(ys[ys.length - 1] > 0.4, `late p90 ${ys[ys.length - 1]}`)
})

test('metric metadata: names, label names, label values', async () => {
  const names = await metricNames(win())
  assert.ok(names.includes('cube_apm_calls_total'))
  assert.deepEqual([...names].sort(), names)
  const labels = await metricLabelNames({ match: ['cube_apm_calls_total'], ...win() })
  for (const l of ['__name__', 'service', 'span_kind', 'status_code', 'root_name']) assert.ok(labels.includes(l), l)
  const services = await metricLabelValues({ label: 'service', match: ['cube_apm_calls_total'], ...win() })
  assert.deepEqual(services, SERVICES)
  // A value fetch without a label asks nothing (reference sent label/undefined/values).
  assert.deepEqual(await metricLabelValues({ label: undefined, ...win() }), [])
})

// ---------- logs / traces ----------

test('logs: the Logs default query returns count(*) per level', async () => {
  const { series } = await queryRange({ datasource: 'vlogs', query: '* | stats by ("log.level") count()', ...win() })
  const levels = series.map(s => s.metric['log.level']).sort()
  assert.ok(levels.includes('error') && levels.includes('info'))
  for (const s of series) {
    assert.equal(s.metric.__name__, 'count(*)')
    for (const p of s.values) assert.ok(p.x >= HOUR.start * 1000 && p.x < HOUR.end * 1000)
  }
})

test('traces: the Traces default query returns count(*) per service', async () => {
  const { series } = await queryRange({ datasource: 'traces', query: '* | stats by ("service") count()', ...win() })
  assert.ok(series.length >= 5)
  assert.ok(series.every(s => s.metric.__name__ === 'count(*)'))
})

test('logs: a query without | stats is refused with the server text', async () => {
  await assert.rejects(queryRange({ datasource: 'vlogs', query: '{service="order"}', ...win() }), (err) => {
    assert.ok(err instanceof ExploreQueryError)
    assert.match(err.message, /^missing `\| stats \.\.\.` pipe in the query \[_time:\[\S+Z,\S+\.999999999Z\] \{service="order"\}\]$/)
    return true
  })
})

test('logs: sort before stats and limit after stats are refused', async () => {
  await assert.rejects(queryRange({ datasource: 'vlogs', query: '* | sort by (_time) | stats count()', ...win() }),
    /cannot be put in front of/)
  await assert.rejects(queryRange({ datasource: 'vlogs', query: '* | stats by (service) count() as c | limit 2', ...win() }),
    /cannot be put after/)
})

test('logs: a syntax error surfaces the parser\'s message', async () => {
  await assert.rejects(queryRange({ datasource: 'vlogs', query: '* | stats by (', ...win() }), (err) => {
    assert.ok(err instanceof ExploreQueryError)
    assert.match(err.message, /cannot parse/)
    return true
  })
})

test('logs: an instant stats query covers the last step only', async () => {
  const { series } = await queryInstant({ datasource: 'vlogs', query: '* | stats by (service) count()', time: HOUR.end, step: HOUR.step })
  assert.ok(series.length >= 1)
  for (let i = 1; i < series.length; i++) assert.ok(series[i - 1].value >= series[i].value)
})

test('log field metadata: names with hits; values by hits, narrowed by the query', async () => {
  const names = await logFieldNames({ datasource: 'vlogs', ...win() })
  const byName = Object.fromEntries(names.map(n => [n.value, n.hits]))
  for (const f of ['_msg', 'service', 'log.level']) assert.ok(byName[f] > 0, f)
  const levels = await logFieldValues({ datasource: 'vlogs', field: 'log.level', ...win() })
  for (let i = 1; i < levels.length; i++) assert.ok(levels[i - 1].hits >= levels[i].hits)
  const all = levels.reduce((n, v) => n + v.hits, 0)
  const narrowed = await logFieldValues({ datasource: 'vlogs', field: 'log.level', query: 'log.level:="error"', ...win() })
  assert.deepEqual(narrowed.map(v => v.value), ['error'])
  assert.ok(narrowed[0].hits < all)
  const limited = await logFieldValues({ datasource: 'vlogs', field: 'service', limit: 2, ...win() })
  assert.equal(limited.length, 2)
})

test('stream field metadata comes from the rows\' streams', async () => {
  const names = await logStreamFieldNames({ datasource: 'traces', ...win() })
  assert.ok(names.some(n => n.value === 'service'))
  const values = await logStreamFieldValues({ datasource: 'traces', field: 'service', ...win() })
  assert.ok(values.length >= 5)
  assert.deepEqual(await logStreamFieldValues({ datasource: 'traces', field: '', ...win() }), [])
})
