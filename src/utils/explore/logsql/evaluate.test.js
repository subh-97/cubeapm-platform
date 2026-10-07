// The LogsQL stats evaluator.
//
// Two kinds of test here, and they check different things.
//
// Hand-built rows pin the ARITHMETIC: weights, bucketing, naming, the math
// pipe. Those numbers are the contract — a count that counts rows instead of
// weights is a bug no amount of real data would make obvious.
//
// The store's own rows pin the ACCEPTANCE criterion: every LogsQL string the
// Builder can generate has to parse and evaluate. Those assertions are about
// shape (a series per group, named the way the server names it), never about
// the generator's exact numbers, which are allowed to move.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  parseLogsql, evaluateStatsRange, evaluateStatsInstant, LogsqlError, tokenizeLogsql,
} from '@/utils/explore/logsql'
import { eventsFor } from '@/data/explore/eventsStore'
import { BASE_TIME } from '@/data/observability'
import { buildLogsqlQuery, defaultBuilderModel } from '@/utils/explore/builders'
import { ExploreQueryError, setSimulatedLatency, queryRange } from '@/utils/explore/api'

setSimulatedLatency(0)

// ---------- helpers ----------

// Explore floors both ends of a window to the step (timeRange.resolveRange),
// so an aligned start is what the evaluator is really handed — and the only
// one for which a bucket covers a whole step.
const T0 = Math.floor(1_700_000_000 / 60) * 60
const W = { start: T0, end: T0 + 180, step: 60 }

const row = (sec, fields = {}) => ({ _time: sec * 1000, _weight: 1, _msg: '', ...fields })

const range = (query, rows, win = W) => evaluateStatsRange(parseLogsql(query), rows, win)
const instant = (query, rows, opts) => evaluateStatsInstant(parseLogsql(query), rows, opts)

/** `{ '<__name__>|<group value>': [y, …] }` — the shape every assertion below reads. */
function ys(series, label) {
  return Object.fromEntries(series.map(s => [
    label ? `${s.metric.__name__}|${s.metric[label]}` : s.metric.__name__,
    s.values.map(p => p.y),
  ]))
}

const xs = (series) => series.map(s => s.values.map(p => p.x))

// ---------- weighted maths ----------

test('count is the sum of weights, not the number of sampled rows', () => {
  const rows = [
    row(T0, { service: 'a', _weight: 10 }),
    row(T0 + 1, { service: 'a', _weight: 5 }),
    row(T0 + 2, { service: 'b', _weight: 2 }),
  ]
  const out = range('* | stats by (service) count()', rows, { ...W, end: T0 + 60 })
  assert.deepEqual(ys(out, 'service'), { 'count(*)|a': [15], 'count(*)|b': [2] })
})

test('sum, avg, median and quantile read the weighted distribution', () => {
  const rows = [row(T0, { d: 10, _weight: 1 }), row(T0 + 1, { d: 20, _weight: 3 })]
  const out = range('* | stats sum(d) as s, avg(d) as a, median(d) as m, quantile(0.25, d) as q',
    rows, { ...W, end: T0 + 60 })
  // Σwv = 10 + 60; Σw = 4; the median sits inside the 20s because they weigh 3.
  assert.deepEqual(ys(out), { s: [70], a: [17.5], m: [20], q: [10] })
})

test('count_uniq counts distinct values, and rate is per second of the bucket', () => {
  const rows = [
    row(T0, { trace_id: 'x', _weight: 40 }),
    row(T0 + 1, { trace_id: 'x', _weight: 40 }),
    row(T0 + 2, { trace_id: 'y', _weight: 40 }),
  ]
  const out = range('* | stats count_uniq(trace_id) as traces, rate() as per_sec', rows, { ...W, end: T0 + 60 })
  assert.deepEqual(ys(out), { traces: [2], per_sec: [2] })
})

test('min, max, stddev and sum_len; count(field) only counts rows that have one', () => {
  const rows = [row(T0, { d: 10, s: 'abc' }), row(T0 + 1, { d: 30 }), row(T0 + 2, {})]
  const out = range('* | stats min(d) as lo, max(d) as hi, stddev(d) as sd, sum_len(s) as len, count(d) as n, count_empty(d) as z',
    rows, { ...W, end: T0 + 60 })
  assert.deepEqual(ys(out), { lo: [10], hi: [30], sd: [10], len: [3], n: [2], z: [1] })
})

test('a value with a duration or size suffix compares as a number', () => {
  const rows = [row(T0, { duration: 2e8 }), row(T0 + 1, { duration: 5e7 }), row(T0 + 2, { size: '2KB' })]
  assert.deepEqual(ys(range('duration:>100ms | stats count()', rows, { ...W, end: T0 + 60 })), { 'count(*)': [1] })
  assert.deepEqual(ys(range('size:>=1KB | stats count()', rows, { ...W, end: T0 + 60 })), { 'count(*)': [1] })
})

// ---------- bucketing ----------

test('empty buckets are absent, so the chart draws a gap instead of a zero', () => {
  const rows = [row(T0 + 5), row(T0 + 130)] // the middle bucket gets nothing
  const out = range('* | stats count()', rows)
  assert.equal(out.length, 1)
  assert.deepEqual(out[0].values, [
    { x: T0 * 1000, y: 1 },
    { x: (T0 + 120) * 1000, y: 1 },
  ])
})

test('a group that misses a bucket simply has no point there', () => {
  const rows = [row(T0, { service: 'a' }), row(T0 + 70, { service: 'b' }), row(T0 + 140, { service: 'a' })]
  const out = range('* | stats by (service) count()', rows)
  assert.deepEqual(xs(out), [[T0 * 1000, (T0 + 120) * 1000], [(T0 + 60) * 1000]])
})

test('rows outside the window are not bucketed at all', () => {
  const rows = [row(T0 - 30), row(T0 + 10), row(T0 + 300)]
  assert.deepEqual(ys(range('* | stats count()', rows)), { 'count(*)': [1] })
})

test('a missing group value is the empty string', () => {
  const rows = [row(T0, { service: 'a' }), row(T0 + 1, {})]
  const out = range('* | stats by (service) count()', rows, { ...W, end: T0 + 60 })
  assert.deepEqual(out.map(s => s.metric.service).sort(), ['', 'a'])
})

// ---------- series naming ----------

test('a series is named by its result field: the alias, else the call as written', () => {
  const rows = [row(T0, { duration: 10, trace_id: 't' })]
  const out = range('* | stats count(), quantile(0.9, duration), count_uniq(trace_id) as traces',
    rows, { ...W, end: T0 + 60 })
  assert.deepEqual(out.map(s => s.metric.__name__), ['count(*)', 'quantile(0.9, duration)', 'traces'])
})

test('the group fields ride along in the metric beside __name__', () => {
  const rows = [row(T0, { span_kind: 'server', status_code: 'ERROR' })]
  const out = range('* | stats by (span_kind, status_code) count() as c', rows, { ...W, end: T0 + 60 })
  assert.deepEqual(out[0].metric, { __name__: 'c', span_kind: 'server', status_code: 'ERROR' })
})

// ---------- the math pipe ----------

test('a math pipe adds its own series, computed per group and per bucket', () => {
  const rows = [
    row(T0, { 'log.level': 'error', _weight: 2 }),
    row(T0 + 1, { 'log.level': 'info', _weight: 6 }),
    row(T0 + 70, { 'log.level': 'error', _weight: 1 }),
  ]
  const out = range(
    '* | stats count() if (log.level:="error") as errors, count() as total | math errors / total * 100 as error_pct',
    rows, { ...W, end: T0 + 120 },
  )
  assert.deepEqual(ys(out), { errors: [2, 1], total: [8, 1], error_pct: [25, 100] })
})

test('math entries see the ones before them, and keep the parsed expression as their name', () => {
  const rows = [row(T0, { d: 4 })]
  const out = range('* | stats sum(d) as s | math s * 2 as twice, twice + 1', rows, { ...W, end: T0 + 60 })
  assert.deepEqual(ys(out), { s: [4], twice: [8], 'twice + 1': [9] })
})

// ---------- filters ----------

test('the stream selector, NOT, in() and prefix filters all narrow the rows', () => {
  const rows = [
    row(T0, { service: 'order', 'log.level': 'error', 'http.status': 500, _stream: { service: 'order' } }),
    row(T0 + 1, { service: 'order', 'log.level': 'info', 'http.status': 200, _stream: { service: 'order' } }),
    row(T0 + 2, { service: 'payment', 'log.level': 'error', 'http.status': 502, _stream: { service: 'payment' } }),
  ]
  const win = { ...W, end: T0 + 60 }
  const count = (q) => ys(range(q, rows, win))['count(*)']?.[0] ?? 0
  assert.equal(count('{"service"="order"} | stats count()'), 2)
  assert.equal(count('{"service"=~"order|payment"} | stats count()'), 3)
  assert.equal(count('{"service"="order"} NOT log.level:="info" | stats count()'), 1)
  assert.equal(count('log.level:in("error","warn") | stats count()'), 2)
  assert.equal(count('http.status:5* | stats count()'), 2)
  assert.equal(count('log.level:="error" AND NOT {"service"="payment"} | stats count()'), 1)
})

test('a phrase matches a run of words, not a substring; `_time:` is left to the server', () => {
  const rows = [row(T0, { endpoint: '/v1/order/42' }), row(T0 + 1, { endpoint: '/v1/ordering' })]
  const win = { ...W, end: T0 + 60 }
  assert.deepEqual(ys(range('endpoint:"/v1/order" | stats count()', rows, win)), { 'count(*)': [1] })
  assert.deepEqual(ys(range('_time:1h * | stats count()', rows, win)), { 'count(*)': [2] })
})

test('a filter pipe before stats narrows the same rows the head filter would', () => {
  const rows = [row(T0, { 'log.level': 'error' }), row(T0 + 1, { 'log.level': 'info' })]
  assert.deepEqual(ys(range('* | filter log.level:="error" | stats count()', rows, { ...W, end: T0 + 60 })),
    { 'count(*)': [1] })
})

// ---------- the instant query ----------

test('an instant query reduces the last step as one bucket and returns one value per series', () => {
  const rows = [row(T0 + 10, { service: 'a', _weight: 3 }), row(T0 + 50, { service: 'a' }), row(T0 + 70, { service: 'b' })]
  const out = instant('* | stats by (service) count()', rows, { time: T0 + 60, step: 60 })
  assert.deepEqual(out, [{ metric: { __name__: 'count(*)', service: 'a' }, value: 4 }])
})

test('an instant query over a window with no rows returns nothing, not a zero', () => {
  assert.deepEqual(instant('* | stats count()', [row(T0)], { time: T0 + 600, step: 60 }), [])
})

// ---------- server rules ----------

test('a query with no `| stats` pipe is refused by the engine', () => {
  assert.throws(() => range('{"service"="order"}', [row(T0)]), (err) => {
    assert.ok(err instanceof LogsqlError)
    assert.match(err.message, /missing `\| stats \.\.\.` pipe/)
    return true
  })
  // `running_stats` is not `stats`, which is why the converter appends one.
  assert.throws(() => range('* | running_stats count()', [row(T0)]), LogsqlError)
})

test('through api.js: no stats, a row-shaping pipe around stats, and a syntax error carry the server wording', async () => {
  const win = { start: T0, end: T0 + 3600, step: 60 }
  await assert.rejects(queryRange({ datasource: 'vlogs', query: '{service="order"}', ...win }), (err) => {
    assert.ok(err instanceof ExploreQueryError)
    assert.match(err.message, /^missing `\| stats \.\.\.` pipe in the query \[_time:\[/)
    return true
  })
  await assert.rejects(queryRange({ datasource: 'vlogs', query: '* | sort by (_time) | stats count()', ...win }),
    /cannot be put in front of/)
  await assert.rejects(queryRange({ datasource: 'vlogs', query: '* | stats count() as c | limit 2', ...win }),
    /cannot be put after/)
  await assert.rejects(queryRange({ datasource: 'vlogs', query: '* | stats by (', ...win }), /cannot parse/)
})

// ---------- every query the Builder can generate ----------

const EMPTY = [{ label: '', operator: '=', values: [] }]
const P = (label, operator, ...values) => ({ label, operator, values })
const agg = (fn, args = [''], filter = '', alias = '') => ({ fn, args, filter, alias })
const stats = (by, ...aggs) => ({ value: 'stats', by, aggs: aggs.length ? aggs : [agg('count')] })
const math = (expr, alias = '') => ({ value: 'math', expr, alias })
const builder = (streamPairs, labelPairs, pipes = []) =>
  buildLogsqlQuery({ type: 'builder', streamPairs, labelPairs, pipes })

// The Builder cases from builders.test.js, generated rather than transcribed:
// what has to evaluate is whatever the generator actually writes today.
const BUILDER_QUERIES = {
  vlogs: [
    buildLogsqlQuery(defaultBuilderModel('vlogs')),
    builder([P('service', '=', 'order')], [P('log.level', '!=', 'info')], [stats(['log.level'])]),
    builder(EMPTY, EMPTY, [stats([])]),
    builder(EMPTY, EMPTY, [stats(['service'], agg('count_uniq', ['trace_id'], '', 'traces'))]),
    builder([P('service', '=', 'payment')], EMPTY, [
      stats([], agg('count', [''], 'log.level:=error', 'errors'), agg('count', [''], '', 'total')),
      math('errors / total * 100', 'error_pct'),
    ]),
    builder([P('k8s.namespace.name', '=', 'cubedemo')], EMPTY, [stats([])]),
    builder(EMPTY, [P('log.level', '=', 'error')], [stats(['service'], agg('avg', ['duration_ms'], '', 'avg_ms'))]),
    // The quirks the generator is allowed to emit: an empty argument, no field.
    builder(EMPTY, EMPTY, [stats([], agg('quantile', ['0.9', '']))]),
    builder(EMPTY, EMPTY, [stats([], agg('quantile', ['', 'duration_ms']))]),
    builder(EMPTY, EMPTY, [stats([], agg('avg', [undefined]))]),
    builder(EMPTY, EMPTY, [stats([], agg('avg', ['current-db-size-bytes']))]),
    builder(EMPTY, EMPTY, [math('a+b', 'x'), stats([])]),
  ],
  traces: [
    buildLogsqlQuery(defaultBuilderModel('traces')),
    builder([P('service', '=', 'shipment-service')], EMPTY, [stats(['span_kind'])]),
    builder([P('service', '=', 'shipment-service'), P('span_kind', '=~', 'server', 'consumer')],
      [P('status_code', '!=', 'ERROR')],
      [stats(['span_name'], agg('count', [''], '', 'requests'), agg('quantile', ['0.99', 'duration'], '', 'p99'))]),
    builder([P('service', '=~', 'payment-service', 'order-service')], [P('span_kind', '!~', 'client', 'internal')],
      [stats(['service'], agg('quantile', ['0.9', 'duration'], '', 'p90'))]),
    builder([P('service', '=', 'shipment-service')], EMPTY,
      [stats(['span_kind', 'status_code'], agg('count', [''], 'duration:>100ms', 'slow'))]),
    builder([P('service', '=', 'shipment-service')], EMPTY, [
      stats([], agg('count', [''], 'status_code:=ERROR', 'errors'), agg('count', [''], '', 'total')),
      math('errors / total * 100', 'rate'),
    ]),
  ],
}

// Both ends of an Explore window are floored to the step, so this is what the
// store is really asked for (timeRange.resolveRange).
const NOW = Math.floor(BASE_TIME.getTime() / 60_000) * 60
const HOUR = { start: NOW - 3600, end: NOW, step: 60 }

test('every query the Builder generates parses and evaluates over the store rows', () => {
  for (const [datasource, queries] of Object.entries(BUILDER_QUERIES)) {
    const rows = eventsFor(datasource, HOUR)
    for (const query of queries) {
      const out = evaluateStatsRange(parseLogsql(query), rows, HOUR)
      assert.ok(Array.isArray(out), query)
      for (const s of out) {
        assert.equal(typeof s.metric.__name__, 'string', query)
        assert.ok(s.metric.__name__.length > 0, query)
        for (const p of s.values) {
          assert.ok(p.x >= HOUR.start * 1000 && p.x < HOUR.end * 1000, `${query} @ ${p.x}`)
          assert.equal(p.x % (HOUR.step * 1000), 0, query)
        }
      }
    }
  }
})

test('the Logs default query counts every host, with volumes the store can account for', () => {
  const rows = eventsFor('vlogs', HOUR)
  const out = evaluateStatsRange(parseLogsql(buildLogsqlQuery(defaultBuilderModel('vlogs'))), rows, HOUR)
  // Every series is a named host. The default groups by `host.name` precisely
  // so that none of them is the empty group: a field only a fifth of records
  // carry would put most of the volume in one unlabelled series.
  assert.ok(out.length >= 3, `${out.length} hosts`)
  for (const s of out) {
    assert.ok(s.metric['host.name'], `a series grouped under the empty host: ${JSON.stringify(s.metric)}`)
  }
  assert.ok(out.every(s => s.metric.__name__ === 'count(*)'))
  // Every row lands in exactly one group of one bucket, so the whole chart adds
  // up to the window's real volume — and to more than the rows it was read from.
  const counted = out.reduce((a, s) => a + s.values.reduce((b, p) => b + p.y, 0), 0)
  const volume = rows.reduce((a, r) => a + r._weight, 0)
  assert.ok(Math.abs(counted - volume) < 1e-6, `counted ${counted}, volume ${volume}`)
  assert.ok(counted > rows.length, `counted ${counted} from ${rows.length} rows`)
})

test('an error-rate query over real spans lands between 0 and 100', () => {
  const rows = eventsFor('traces', HOUR)
  const query = builder([P('service', '=', 'payment-service')], EMPTY, [
    stats([], agg('count', [''], 'status_code:=ERROR', 'errors'), agg('count', [''], '', 'total')),
    math('errors / total * 100', 'error_pct'),
  ])
  const pct = evaluateStatsRange(parseLogsql(query), rows, HOUR).find(s => s.metric.__name__ === 'error_pct')
  assert.ok(pct, 'no error_pct series')
  for (const p of pct.values) assert.ok(p.y >= 0 && p.y <= 100, `error_pct ${p.y}`)
})

test('the index re-exports the tokenizer the editor paints with', () => {
  const types = tokenizeLogsql('* | stats count()').filter(t => t.type !== 'whitespace').map(t => t.type)
  assert.deepEqual(types, ['star', 'pipe', 'pipeName', 'statsFn', 'paren', 'paren'])
})
