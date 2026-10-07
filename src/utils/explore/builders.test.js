// The Explore query generators, held to the playground's own output. Every
// expected string in the Quick, Advanced and Builder sections is the text the
// reference produces for the same clicks (the worked examples in the specs,
// the Quick ones re-derived by a line-for-line port of its generator), except
// where a test is named FIX — those pin a reference bug we deliberately do not
// copy. The last section pins how a Logs/Traces page query is carried over.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chipsToString } from '@/components/QueryBuilder'
import { composeQuery, newStatsPipe, newStatsFunction, newSortPipe, newLimitPipe } from '@/utils/pipes'
import { ADVANCED_OPERATIONS } from './catalogs.js'
import {
  quoteString, quoteAlternation, emptyPair, changeOperator, changeLabel, labelMatcher,
  applyOperation, newOperation, parsePercentile, buildQuickQuery, quickMatchFor,
  buildAdvancedQuery, advancedMatchFor, quoteFieldName, streamSelector, fieldFilter,
  newStatsAgg, newLogsqlPipe, withStatsFunction, pipeToString, buildLogsqlQuery,
  logsqlValueQueryFor, defaultQuickModel, defaultAdvancedModel, defaultBuilderModel,
  convertLogsQueryForExplore, toExploreLogsQuery,
} from './builders.js'

const P = (label, operator, ...values) => ({ label, operator, values })
const EMPTY = [{ label: '', operator: '=', values: [], options: [] }]

// ---------- Quoting ----------

test('quoteString escapes backslashes and double quotes only', () => {
  assert.equal(quoteString('say "hi"'), '"say \\"hi\\""')
  assert.equal(quoteString('a\\b'), '"a\\\\b"')
  assert.equal(quoteString("it's"), '"it\'s"')
  assert.equal(quoteString(''), '""')
})

test('quoteAlternation regex-escapes each value, joins with |, and doubles the escapes', () => {
  assert.equal(quoteAlternation(['order-service', 'payment-service']), '"order\\\\-service|payment\\\\-service"')
  assert.equal(quoteAlternation(['java.io.IOException', 'TimeoutError']), '"java\\\\.io\\\\.IOException|TimeoutError"')
  assert.equal(quoteAlternation(['GET /api/v1/*']), '"GET /api/v1/\\\\*"')
  assert.equal(quoteAlternation([]), '""')
  // Pick order, not sorted.
  assert.equal(quoteAlternation(['b', 'a']), '"b|a"')
})

// ---------- Filter rows ----------

test('labelMatcher: the reference Gpt table', () => {
  assert.equal(labelMatcher(P('service', '=', 'shipment-service')), 'service="shipment-service"')
  assert.equal(labelMatcher(P('service', '!=', 'a')), 'service!="a"')
  assert.equal(labelMatcher(P('status_code', '=~', 'ERROR')), 'status_code=~"ERROR"')
  assert.equal(labelMatcher(P('service', '=~', 'a', 'b')), 'service=~"a|b"')
  assert.equal(labelMatcher(P('service', '!~', 'a.b', 'c-d')), 'service!~"a\\\\.b|c\\\\-d"')
  assert.equal(labelMatcher(P('root_name', '=', 'GET /x"y')), 'root_name="GET /x\\"y"')
  assert.equal(labelMatcher(P('root_name', '=~', 'x"y')), 'root_name=~"x\\\\\\"y"')
  assert.equal(labelMatcher(P('service', '=')), 'service=""')
  assert.equal(labelMatcher(P('host.name', '=', 'h1')), 'host.name="h1"')
})

test('changeOperator keeps all values for in / not in and only the first for equals', () => {
  const multi = P('service', '=~', 'a', 'b')
  assert.deepEqual(changeOperator(multi, '=').values, ['a'])
  assert.deepEqual(changeOperator(multi, '!~').values, ['a', 'b'])
  assert.deepEqual(changeOperator(P('service', '=', 'a'), '=~').values, ['a'])
  assert.deepEqual(changeOperator(P('service', '='), '!=').values, [])
  assert.equal(changeOperator(multi, '=').operator, '=')
})

test('changeLabel clears values (and fetched options when the row has them)', () => {
  assert.deepEqual(changeLabel(P('service', '=', 'a'), 'env'), { label: 'env', operator: '=', values: [] })
  assert.deepEqual(changeLabel({ ...P('service', '=', 'a'), options: ['a'] }, 'env').options, [])
})

test('emptyPair is a fresh object every time', () => {
  const a = emptyPair()
  a.values.push('x')
  assert.deepEqual(emptyPair(), { label: '', operator: '=', values: [] })
})

// ---------- Percentile validator ----------

test('parsePercentile accepts plain decimals with no range check', () => {
  for (const [text, n] of [['90', 90], ['99.9', 99.9], ['090', 90], ['90.', 90], ['.5', 0.5], ['0', 0],
    ['150', 150], ['-5', -5], ['+50', 50]]) {
    assert.equal(parsePercentile(text), n, text)
  }
  assert.equal(parsePercentile(99), 99)
})

test('parsePercentile rejects exponents, overlong numbers and non-numbers', () => {
  for (const text of ['', '1e2', '1e', '123456789', '1.1234567', 'abc', ' 90', undefined, null]) {
    assert.equal(parsePercentile(text), undefined, String(text))
  }
})

// ---------- Metrics: Quick (spec metrics-quick §7, all 21 examples) ----------

const quick = (calculate, value, labelPairs, groupBy, opts) =>
  buildQuickQuery({ type: 'quick', calculate, value, labelPairs, groupBy }, opts)

test('Quick RPM (examples 1-7)', () => {
  assert.equal(quick('rpm', '90', EMPTY, []),
    'sum(rate(cube_apm_calls_total{span_kind=~"server|consumer"} default 0)) * 60')
  assert.equal(quick('rpm', '90', [P('service', '=', 'shipment-service')], []),
    'sum(rate(cube_apm_calls_total{service="shipment-service", span_kind=~"server|consumer"} default 0)) * 60')
  assert.equal(quick('rpm', '90', EMPTY, ['root_name']),
    'sum(rate(cube_apm_calls_total{span_kind=~"server|consumer"} default 0)) by (root_name) * 60')
  assert.equal(quick('rpm', '90', [P('env', '=', 'prod'), P('service', '=~', 'order-service', 'payment-service')], ['service', 'root_name']),
    'sum(rate(cube_apm_calls_total{env="prod", service=~"order\\\\-service|payment\\\\-service", span_kind=~"server|consumer"} default 0)) by (service, root_name) * 60')
  assert.equal(quick('rpm', '90', [P('service', '!=', 'x'), P('root_name', '!~', 'GET /api/v1/*')], []),
    'sum(rate(cube_apm_calls_total{service!="x", root_name!~"GET /api/v1/\\\\*", span_kind=~"server|consumer"} default 0)) * 60')
  assert.equal(quick('rpm', '90', [P('service', '=')], []),
    'sum(rate(cube_apm_calls_total{service="", span_kind=~"server|consumer"} default 0)) * 60')
  assert.equal(quick('rpm', '90', [P('service', '=~')], []),
    'sum(rate(cube_apm_calls_total{service=~"", span_kind=~"server|consumer"} default 0)) * 60')
})

test('Quick Error % (examples 8-12): special labels leave the denominator', () => {
  assert.equal(quick('error_percentage', '90', EMPTY, []),
    'sum(increase(cube_apm_calls_total{span_kind=~"server|consumer", status_code="ERROR"} default 0)) * 100 / sum(increase(cube_apm_calls_total{span_kind=~"server|consumer"} default 0))')
  assert.equal(quick('error_percentage', '90', [P('service', '=', 'shipment-service')], ['root_name']),
    'sum(increase(cube_apm_calls_total{service="shipment-service", span_kind=~"server|consumer", status_code="ERROR"} default 0)) by (root_name) * 100 / sum(increase(cube_apm_calls_total{service="shipment-service", span_kind=~"server|consumer"} default 0)) by (root_name)')
  assert.equal(quick('error_percentage', '90', EMPTY, ['exception']),
    'sum(increase(cube_apm_calls_total{span_kind=~"server|consumer", status_code="ERROR"} default 0)) by (exception) * 100 / ignoring (exception) group_left sum(increase(cube_apm_calls_total{span_kind=~"server|consumer"} default 0))')
  assert.equal(quick('error_percentage', '90', EMPTY, ['service', 'http_code', 'exception']),
    'sum(increase(cube_apm_calls_total{span_kind=~"server|consumer", status_code="ERROR"} default 0)) by (service, http_code, exception) * 100 / ignoring (http_code,exception) group_left sum(increase(cube_apm_calls_total{span_kind=~"server|consumer"} default 0)) by (service)')
  assert.equal(quick('error_percentage', '90',
    [P('service', '=', 'shipment-service'), P('http_code', '=', '500'), P('exception', '=~', 'java.io.IOException', 'TimeoutError')], []),
  'sum(increase(cube_apm_calls_total{service="shipment-service", http_code="500", exception=~"java\\\\.io\\\\.IOException|TimeoutError", span_kind=~"server|consumer", status_code="ERROR"} default 0)) * 100 / sum(increase(cube_apm_calls_total{service="shipment-service", span_kind=~"server|consumer"} default 0))')
})

test('Quick %ile Latency (examples 13-18): vmrange always last, quantile not rounded', () => {
  assert.equal(quick('latency_percentile', '90', EMPTY, []),
    'histogram_quantile(0.9, sum(increase(cube_apm_latency_bucket{span_kind=~"server|consumer"} default 0)) by (vmrange))')
  assert.equal(quick('latency_percentile', '99', [P('service', '=', 'shipment-service')], ['root_name']),
    'histogram_quantile(0.99, sum(increase(cube_apm_latency_bucket{service="shipment-service", span_kind=~"server|consumer"} default 0)) by (root_name, vmrange))')
  assert.equal(quick('latency_percentile', '99.9', EMPTY, []),
    'histogram_quantile(0.9990000000000001, sum(increase(cube_apm_latency_bucket{span_kind=~"server|consumer"} default 0)) by (vmrange))')
  assert.equal(quick('latency_percentile', '50', EMPTY, ['service'], { latencyInMs: true }),
    'histogram_quantile(0.5, sum(increase(cube_apm_latency_bucket{span_kind=~"server|consumer"} default 0)) by (service, vmrange)) * 1000')
  assert.equal(quick('latency_percentile', '', EMPTY, []), '')
  assert.equal(quick('latency_percentile', '150', EMPTY, []),
    'histogram_quantile(1.5, sum(increase(cube_apm_latency_bucket{span_kind=~"server|consumer"} default 0)) by (vmrange))')
})

test('Quick percentile text becomes ${p / 100} verbatim', () => {
  const q = v => quick('latency_percentile', v, EMPTY, []).match(/^histogram_quantile\(([^,]+),/)[1]
  assert.equal(q('99.99'), '0.9998999999999999')
  assert.equal(q('-5'), '-0.05')
  assert.equal(q('.5'), '0.005')
  assert.equal(quick('latency_percentile', '1e2', EMPTY, []), '')
})

test('Quick Avg Latency (examples 19-21): special labels are ordinary here', () => {
  assert.equal(quick('latency_average', '90', EMPTY, []),
    'sum(increase(cube_apm_latency_total{span_kind=~"server|consumer"} default 0)) / sum(increase(cube_apm_calls_total{span_kind=~"server|consumer"} default 0))')
  assert.equal(quick('latency_average', '90', [P('env', '=', 'prod')], ['service'], { latencyInMs: true }),
    'sum(increase(cube_apm_latency_total{env="prod", span_kind=~"server|consumer"} default 0)) by (service) * 1000 / sum(increase(cube_apm_calls_total{env="prod", span_kind=~"server|consumer"} default 0)) by (service)')
  assert.equal(quick('latency_average', '90', [P('http_code', '=~', '500', '503')], ['http_code']),
    'sum(increase(cube_apm_latency_total{http_code=~"500|503", span_kind=~"server|consumer"} default 0)) by (http_code) / sum(increase(cube_apm_calls_total{http_code=~"500|503", span_kind=~"server|consumer"} default 0)) by (http_code)')
})

test('Quick is empty until CALCULATE is picked; rows without a label are skipped', () => {
  assert.equal(buildQuickQuery(undefined), '')
  assert.equal(buildQuickQuery({ type: 'quick', labelPairs: EMPTY, groupBy: [] }), '')
  // A label cleared with the (x) is undefined, not "" — also skipped.
  assert.equal(quick('rpm', '90', [P(undefined, '=', 'x'), P('env', '=', 'prod')], []),
    'sum(rate(cube_apm_calls_total{env="prod", span_kind=~"server|consumer"} default 0)) * 60')
})

test('Quick from the service overview entry point (spec §10.3)', () => {
  const model = { type: 'quick', calculate: 'rpm', value: '0',
    labelPairs: [{ label: 'env', operator: '=', values: ['prod'] }, { label: 'service', operator: '=', values: ['shipment-service'] }],
    groupBy: ['root_name'] }
  assert.equal(buildQuickQuery(model),
    'sum(rate(cube_apm_calls_total{env="prod", service="shipment-service", span_kind=~"server|consumer"} default 0)) by (root_name) * 60')
})

test('FIX: an unknown CALCULATE yields no query instead of throwing', () => {
  assert.equal(quick('throughput', '90', EMPTY, []), '')
})

test('FIX: a latency model with no value reads as the tab default 90; missing arrays read as empty', () => {
  assert.equal(buildQuickQuery({ type: 'quick', calculate: 'latency_percentile' }),
    'histogram_quantile(0.9, sum(increase(cube_apm_latency_bucket{span_kind=~"server|consumer"} default 0)) by (vmrange))')
})

test('quickMatchFor: only rows above narrow the values, always on calls_total', () => {
  const rows = [P('service', '=', 'shipment-service'), P('root_name', '='), P('env', '=', 'prod')]
  assert.deepEqual(quickMatchFor(rows, 0), ['{__name__="cube_apm_calls_total", span_kind=~"server|consumer"}'])
  assert.deepEqual(quickMatchFor(rows, 1),
    ['{__name__="cube_apm_calls_total", span_kind=~"server|consumer", service="shipment-service"}'])
  // A row with a label but no value still constrains the next one.
  assert.deepEqual(quickMatchFor(rows, 2),
    ['{__name__="cube_apm_calls_total", span_kind=~"server|consumer", service="shipment-service", root_name=""}'])
  assert.deepEqual(quickMatchFor([P('', '='), P('service', '=', 'a')], 1),
    ['{__name__="cube_apm_calls_total", span_kind=~"server|consumer"}'])
})

// ---------- Metrics: Advanced (spec metrics-advanced §7) ----------

const OPTIONS = ADVANCED_OPERATIONS.flatMap(g => g.options)
// An operation as the picker appends it, then with its inputs filled in order.
const op = (value, ...inputs) => {
  const o = newOperation(OPTIONS.find(x => x.value === value))
  inputs.forEach((v, i) => { o.args[i].value = v })
  return o
}
const advanced = (metric, labelPairs, functions) =>
  buildAdvancedQuery({ type: 'advanced', metric, labelPairs, functions })
const FILTERED = [P('service', '=', 'shipment-service'), P('status_code', '=~', 'ERROR')]

test('Advanced worked examples 1-4: metric, filters, then each operation wraps', () => {
  assert.equal(advanced('cube_apm_calls_total', EMPTY, []), 'cube_apm_calls_total')
  assert.equal(advanced('cube_apm_calls_total', [P('service', '=', 'shipment-service')], []),
    'cube_apm_calls_total{service="shipment-service"}')
  assert.equal(advanced('cube_apm_calls_total', FILTERED, []),
    'cube_apm_calls_total{service="shipment-service", status_code=~"ERROR"}')
  assert.equal(advanced('cube_apm_calls_total', FILTERED, [op('rate')]),
    'rate(cube_apm_calls_total{service="shipment-service", status_code=~"ERROR"})')
  assert.equal(advanced('cube_apm_calls_total', FILTERED, [op('rate'), op('sum', ['root_name'])]),
    'sum(rate(cube_apm_calls_total{service="shipment-service", status_code=~"ERROR"})) by (root_name)')
  assert.equal(advanced('cube_apm_calls_total', FILTERED, [op('rate'), op('sum', ['root_name']), op('*', '60')]),
    'sum(rate(cube_apm_calls_total{service="shipment-service", status_code=~"ERROR"})) by (root_name) * 60')
})

test('Advanced worked examples 5-8: p95 in ms, topk, rounding, order matters', () => {
  assert.equal(advanced('cube_apm_latency_bucket', [P('service', '=~', 'shipment-service', 'order-service')],
    [op('increase'), op('sum', ['service', 'vmrange']), op('histogram_quantile', '0.95'), op('*', '1000')]),
  'histogram_quantile(0.95, sum(increase(cube_apm_latency_bucket{service=~"shipment\\\\-service|order\\\\-service"})) by (service, vmrange)) * 1000')
  assert.equal(advanced('cube_apm_calls_total', EMPTY, [op('rate'), op('sum', ['root_name']), op('topk', '5', [])]),
    'topk(5, sum(rate(cube_apm_calls_total)) by (root_name))')
  assert.equal(advanced('cube_apm_calls_total', EMPTY, [op('*', '100'), op('round', '0.1')]),
    'round(cube_apm_calls_total * 100, 0.1)')
  assert.equal(advanced('cube_apm_calls_total', EMPTY, [op('sum', []), op('rate')]), 'rate(sum(cube_apm_calls_total))')
  assert.equal(advanced('cube_apm_calls_total', EMPTY, [op('rate'), op('sum', [])]), 'sum(rate(cube_apm_calls_total))')
})

test('Advanced worked examples 9-12: __name__ fallback, empty values, cleared rows, synthetic model', () => {
  assert.equal(advanced('my-metric', EMPTY, []), '{__name__="my-metric"}')
  assert.equal(advanced('my-metric', [P('env', '=', 'prod')], []), '{__name__="my-metric", env="prod"}')
  assert.equal(advanced('http.server.duration', [P('env', '=', 'prod')], []), 'http.server.duration{env="prod"}')
  assert.equal(advanced('_private', EMPTY, []), '{__name__="_private"}')
  assert.equal(advanced('cube_apm_calls_total', [P('service', '=')], []), 'cube_apm_calls_total{service=""}')
  assert.equal(advanced('cube_apm_calls_total', [P(undefined, '=', 'x')], []), 'cube_apm_calls_total')
  // The synthetic-monitor producer's model: no `options`, no `default`s.
  const bdi = { type: 'advanced', metric: 'cube_synthetic_monitor',
    labelPairs: [{ label: 'id', operator: '=', values: ['5'] }],
    functions: [{ value: 'max', label: '', args: [{ type: 'aggregation', value: ['id', 'group', 'name'] }] }] }
  assert.equal(buildAdvancedQuery(bdi), 'max(cube_synthetic_monitor{id="5"}) by (id, group, name)')
})

test('Advanced is empty until FROM is picked', () => {
  assert.equal(advanced('', FILTERED, [op('rate')]), '')
  assert.equal(buildAdvancedQuery(defaultAdvancedModel()), '')
  assert.equal(buildAdvancedQuery(undefined), '')
})

test('applyOperation: the per-operation template table (§7.3)', () => {
  const Q = 'Q'
  assert.equal(applyOperation(Q, op('sum', [])), 'sum(Q)')
  assert.equal(applyOperation(Q, op('sum', ['service', 'root_name'])), 'sum(Q) by (service, root_name)')
  assert.equal(applyOperation(Q, op('topk', '5', [])), 'topk(5, Q)')
  assert.equal(applyOperation(Q, op('topk', '3', ['service'])), 'topk(3, Q) by (service)')
  assert.equal(applyOperation(Q, op('ceil')), 'ceil(Q)')
  assert.equal(applyOperation(Q, op('clamp')), 'clamp(Q, 0, 1)')
  assert.equal(applyOperation(Q, op('clamp_max')), 'clamp_max(Q, 1)')
  assert.equal(applyOperation(Q, op('clamp_min')), 'clamp_min(Q, 0)')
  assert.equal(applyOperation(Q, op('round')), 'round(Q, 1)')
  assert.equal(applyOperation(Q, op('deriv')), 'deriv(Q)')
  assert.equal(applyOperation(Q, op('histogram_quantile')), 'histogram_quantile(0.9, Q)')
  assert.equal(applyOperation(Q, op('*')), 'Q * 1')
  assert.equal(applyOperation(Q, op('/', '1000')), 'Q / 1000')
})

test('applyOperation emits empty inputs verbatim, as the reference does', () => {
  assert.equal(applyOperation('Q', op('*', '')), 'Q * ')
  assert.equal(applyOperation('Q', op('round', '')), 'round(Q, )')
  assert.equal(applyOperation('Q', op('topk', '', [])), 'topk(, Q)')
})

test('applyOperation renders a bare catalog option as the picker would seed it', () => {
  const clamp = OPTIONS.find(o => o.value === 'clamp')
  assert.equal(applyOperation('Q', clamp), 'clamp(Q, 0, 1)')
  assert.equal(applyOperation('Q', OPTIONS.find(o => o.value === 'sum')), 'sum(Q)')
})

test('applyOperation throws on an unknown arg type; buildAdvancedQuery treats it as incomplete', () => {
  const bad = { value: 'sum', args: [{ type: 'duration', value: '5m' }] }
  assert.throws(() => applyOperation('Q', bad), /Unknown arg type: duration/)
  assert.equal(advanced('cube_apm_calls_total', EMPTY, [bad]), '')
})

test('newOperation seeds defaults (strings), 0 without one, [] for group-by — on a mutable copy', () => {
  const topk = op('topk')
  assert.deepEqual(topk.args.map(a => a.value), ['5', []])
  assert.equal(topk.label, '')
  assert.deepEqual(op('clamp').args.map(a => a.value), [0, '1'])
  assert.equal(op('*').type, 'operator')
  topk.args[1].value.push('service')
  assert.deepEqual(op('topk').args[1].value, [])
})

test('advancedMatchFor: the metric plus only the rows above', () => {
  const rows = [P('service', '=', 'shipment-service'), P('root_name', '=', 'x')]
  assert.deepEqual(advancedMatchFor('cube_apm_calls_total', rows, 1),
    ['{__name__="cube_apm_calls_total", service="shipment-service"}'])
  assert.deepEqual(advancedMatchFor('cube_apm_calls_total', rows, 0), ['{__name__="cube_apm_calls_total"}'])
})

// ---------- Logs/Traces: Builder (spec logs-traces-builder §7-§8) ----------

const agg = (fn, args = [''], filter = '', alias = '') => ({ fn, args, filter, alias })
const stats = (by, ...aggs) => ({ value: 'stats', by, aggs: aggs.length ? aggs : [agg('count')] })
const math = (expr, alias = '') => ({ value: 'math', expr, alias })
const builder = (streamPairs, labelPairs, pipes = []) =>
  buildLogsqlQuery({ type: 'builder', streamPairs, labelPairs, pipes })

test('Builder logs L1-L7: stream selector and FIELDS filters', () => {
  assert.equal(builder(EMPTY, EMPTY), '')
  assert.equal(builder([P('service', '=', 'order')], EMPTY), '{"service"="order"}')
  assert.equal(builder([P('service', '=~', 'order', 'payment')], EMPTY), '{"service"=~"order|payment"}')
  assert.equal(builder([P('service', '=~', 'cubedemo-web', 'order')], EMPTY), '{"service"=~"cubedemo\\\\-web|order"}')
  assert.equal(builder([P('service', '=', 'order'), P('log.level', '!=', 'info')], EMPTY),
    '{"service"="order","log.level"!="info"}')
  assert.equal(builder(EMPTY, [P('level', '=', 'error')]), 'level:="error"')
  assert.equal(builder(EMPTY, [P('level', '!~', 'debug', 'info')]), 'NOT level:in("debug","info")')
})

test('Builder logs L8-L12: pipes', () => {
  assert.equal(builder([P('service', '=', 'order')], [P('log.level', '!=', 'info')], [stats(['log.level'])]),
    '{"service"="order"} NOT log.level:="info" | stats by ("log.level") count()')
  assert.equal(builder(EMPTY, EMPTY, [stats([])]), '* | stats count()')
  assert.equal(builder(EMPTY, EMPTY, [stats(['service'], agg('count_uniq', ['trace_id'], '', 'traces'))]),
    '* | stats by ("service") count_uniq(trace_id) as "traces"')
  assert.equal(builder([P('service', '=', 'payment')], EMPTY, [
    stats([], agg('count', [''], 'log.level:=error', 'errors'), agg('count', [''], '', 'total')),
    math('errors / total * 100', 'error_pct'),
  ]), '{"service"="payment"} | stats count() if (log.level:=error) as "errors", count() as "total" | math errors / total * 100 as "error_pct"')
  assert.equal(builder([P('k8s.namespace.name', '=', 'default')], EMPTY, [stats([])]),
    '{"k8s.namespace.name"="default"} | stats count()')
})

test('Builder traces T1-T6', () => {
  assert.equal(builder([P('service', '=', 'shipment-service')], EMPTY, [stats(['span_kind'])]),
    '{"service"="shipment-service"} | stats by ("span_kind") count()')
  assert.equal(builder([P('service', '=', 'shipment-service'), P('span_kind', '=~', 'server', 'consumer')],
    [P('status_code', '!=', 'ERROR')],
    [stats(['span_name'], agg('count', [''], '', 'requests'), agg('quantile', ['0.99', 'duration'], '', 'p99'))]),
  '{"service"="shipment-service","span_kind"=~"server|consumer"} NOT status_code:="ERROR" | stats by ("span_name") count() as "requests", quantile(0.99, duration) as "p99"')
  assert.equal(builder([P('service', '=~', 'payment-service', 'order-service')], [P('span_kind', '!~', 'client', 'internal')],
    [stats(['service'], agg('quantile', ['0.9', 'duration'], '', 'p90'))]),
  '{"service"=~"payment\\\\-service|order\\\\-service"} NOT span_kind:in("client","internal") | stats by ("service") quantile(0.9, duration) as "p90"')
  assert.equal(builder([P('service', '=', 'shipment-service')], EMPTY,
    [stats(['span_kind', 'status_code'], agg('count', [''], 'duration:>100ms', 'slow'))]),
  '{"service"="shipment-service"} | stats by ("span_kind", "status_code") count() if (duration:>100ms) as "slow"')
  assert.equal(builder([P('service', '=', 'shipment-service')], EMPTY, [
    stats([], agg('count', [''], 'status_code:=ERROR', 'errors'), agg('count', [''], '', 'total')),
    math('errors / total * 100', 'rate'),
  ]), '{"service"="shipment-service"} | stats count() if (status_code:=ERROR) as "errors", count() as "total" | math errors / total * 100 as "rate"')
  assert.equal(builder(EMPTY, [P('http.route', '=', '/v1/shipment')]), 'http.route:="/v1/shipment"')
})

test('Builder edge outputs kept from the reference', () => {
  assert.equal(builder([P('service', '=')], EMPTY), '{"service"=""}')
  assert.equal(builder(EMPTY, [P('span_name', '=')]), 'span_name:=""')
  assert.equal(builder(EMPTY, [P('span_kind', '=~')]), 'span_kind:in()')
  assert.equal(builder([P('service', '=~')], EMPTY), '{"service"=~""}')
  assert.equal(builder(EMPTY, EMPTY, [stats([], agg('quantile', ['0.9', '']))]), '* | stats quantile(0.9, )')
  assert.equal(builder(EMPTY, EMPTY, [stats([], agg('quantile', ['', 'duration']))]), '* | stats quantile(, duration)')
  // A cleared field select leaves `undefined` in args; it renders as empty.
  assert.equal(builder(EMPTY, EMPTY, [stats([], agg('avg', [undefined]))]), '* | stats avg()')
  assert.equal(builder(EMPTY, EMPTY, [math('a+b', 'x')]), '* | math a+b as "x"')
  assert.equal(builder(EMPTY, [P('msg', '=', 'say "hi"')]), 'msg:="say \\"hi\\""')
  assert.equal(builder([P('f', '=', 'say "hi"')], EMPTY), '{"f"="say \\"hi\\""}')
  // In-lists in FIELDS are exact values: quoted, never regex-escaped.
  assert.equal(builder(EMPTY, [P('service', '=~', 'a-b', 'c.d')]), 'service:in("a-b","c.d")')
})

test('Builder: changing the function resets its args; changing the operator truncates values', () => {
  const q = withStatsFunction(agg('quantile', ['0.99', 'duration']), 'avg')
  assert.deepEqual(q.args, [''])
  assert.equal(builder(EMPTY, EMPTY, [stats([], q)]), '* | stats avg()')
  assert.deepEqual(withStatsFunction(agg('avg', ['duration']), 'quantile').args, ['0.9', ''])
  const row = changeOperator(P('f', '=~', 'a', 'b'), '=')
  assert.equal(builder(EMPTY, [row]), 'f:="a"')
})

test('FIX B3: an empty math pipe contributes nothing — no stray spaces', () => {
  assert.equal(builder(EMPTY, EMPTY, [math('')]), '')
  assert.equal(builder(EMPTY, EMPTY, [stats([]), math('')]), '* | stats count()')
  assert.equal(builder(EMPTY, EMPTY, [math('   ', 'x')]), '')
})

test('FIX B4: field names that are not plain identifiers are quoted', () => {
  assert.equal(builder(EMPTY, [P('compact-revision', '=', '5')]), '"compact-revision":="5"')
  assert.equal(builder(EMPTY, [P('current db size', '!~', 'a')]), 'NOT "current db size":in("a")')
  assert.equal(builder(EMPTY, EMPTY, [stats([], agg('avg', ['current-db-size-bytes']))]),
    '* | stats avg("current-db-size-bytes")')
  // Plain names are unchanged, dots and leading underscores included.
  assert.equal(quoteFieldName('http.status_code'), 'http.status_code')
  assert.equal(quoteFieldName('_msg'), '_msg')
  assert.equal(quoteFieldName('k8s.namespace.name'), 'k8s.namespace.name')
  assert.equal(quoteFieldName('2xx'), '"2xx"')
  assert.equal(quoteFieldName('or'), '"or"')
  // A quantile's first argument is a number, never quoted.
  assert.equal(builder(EMPTY, EMPTY, [stats([], agg('quantile', ['0.5', 'db-latency']))]),
    '* | stats quantile(0.5, "db-latency")')
})

test('FIX: whitespace-only "if" and "as" inputs are ignored, real ones trimmed', () => {
  assert.equal(builder(EMPTY, EMPTY, [stats([], agg('count', [''], '  ', ' '))]), '* | stats count()')
  assert.equal(builder(EMPTY, EMPTY, [stats([], agg('count', [''], ' level:=error ', ' errors '))]),
    '* | stats count() if (level:=error) as "errors"')
})

test('FIX: a stats pipe with no aggregate counts; an unknown pipe is skipped', () => {
  assert.equal(builder(EMPTY, EMPTY, [{ value: 'stats', by: ['service'], aggs: [] }]), '* | stats by ("service") count()')
  assert.equal(builder(EMPTY, EMPTY, [{ value: 'sort', by: ['x'] }]), '')
  assert.equal(pipeToString(undefined), '')
})

test('Builder helpers: streamSelector / fieldFilter / factories', () => {
  assert.equal(streamSelector([]), '')
  assert.equal(streamSelector([P('', '=', 'x')]), '')
  assert.equal(fieldFilter(P('span_kind', '=~', 'server', 'consumer')), 'span_kind:in("server","consumer")')
  assert.deepEqual(newStatsAgg(), { fn: 'count', args: [''], filter: '', alias: '' })
  assert.deepEqual(newLogsqlPipe('stats'), { value: 'stats', by: [], aggs: [{ fn: 'count', args: [''], filter: '', alias: '' }] })
  assert.deepEqual(newLogsqlPipe('math'), { value: 'math', expr: '', alias: '' })
  const a = newLogsqlPipe('stats')
  a.aggs[0].alias = 'x'
  assert.equal(newLogsqlPipe('stats').aggs[0].alias, '')
})

test('logsqlValueQueryFor: STREAM rows narrow by the stream rows above', () => {
  const model = { streamPairs: [P('service', '=', 'order'), P('log.level', '='), P('env', '=')], labelPairs: EMPTY }
  assert.equal(logsqlValueQueryFor(model, 'stream', 0), '*')
  assert.equal(logsqlValueQueryFor(model, 'stream', 1), '{"service"="order"}')
  // A label with no value still constrains (`"log.level"=""`).
  assert.equal(logsqlValueQueryFor(model, 'stream', 2), '{"service"="order","log.level"=""}')
})

test('logsqlValueQueryFor: FIELDS rows narrow by every stream row and the FIELDS rows above', () => {
  const model = {
    streamPairs: [P('service', '=', 'order')],
    labelPairs: [P('log.level', '!=', 'info'), P('path', '='), P('endpoint', '=')],
  }
  assert.equal(logsqlValueQueryFor(model, 'fields', 0), '{"service"="order"}')
  assert.equal(logsqlValueQueryFor(model, 'fields', 1), '{"service"="order"} NOT log.level:="info"')
  assert.equal(logsqlValueQueryFor(model, 'fields', 2), '{"service"="order"} NOT log.level:="info" path:=""')
})

test('FIX B1: the first FIELDS row with no stream filter asks with *, never " "', () => {
  const model = { streamPairs: EMPTY, labelPairs: [P('span_kind', '='), P('service', '=', 'a')] }
  assert.equal(logsqlValueQueryFor(model, 'fields', 0), '*')
  assert.equal(logsqlValueQueryFor(model, 'fields', 1), 'span_kind:=""')
})

// ---------- Starting models (ARCH D2) ----------

test('defaultQuickModel is RPM by service with one empty row', () => {
  const m = defaultQuickModel()
  assert.deepEqual(m, { type: 'quick', calculate: 'rpm', value: '90', labelPairs: [emptyPair()], groupBy: ['service'] })
  assert.equal(buildQuickQuery(m),
    'sum(rate(cube_apm_calls_total{span_kind=~"server|consumer"} default 0)) by (service) * 60')
  m.groupBy.push('root_name')
  assert.deepEqual(defaultQuickModel().groupBy, ['service'])
})

test('defaultBuilderModel: count by host for logs, by service for traces', () => {
  assert.equal(buildLogsqlQuery(defaultBuilderModel('vlogs')), '* | stats by ("host.name") count()')
  assert.equal(buildLogsqlQuery(defaultBuilderModel('traces')), '* | stats by ("service") count()')
  const m = defaultBuilderModel('vlogs')
  assert.equal(m.type, 'builder')
  assert.deepEqual(m.streamPairs, [emptyPair()])
  assert.deepEqual(m.labelPairs, [emptyPair()])
  m.pipes[0].by.push('service')
  assert.deepEqual(defaultBuilderModel('vlogs').pipes[0].by, ['host.name'])
})

test('defaultAdvancedModel starts with no metric and nothing selected', () => {
  assert.deepEqual(defaultAdvancedModel(), { type: 'advanced', metric: '', labelPairs: [emptyPair()], functions: [] })
})

// ---------- Logs/Traces page → Explore (ARCH D15) ----------

const x = toExploreLogsQuery

test('a query with no stats pipe gets `| stats count()`; an empty one starts from *', () => {
  assert.equal(x(''), '* | stats count()')
  assert.equal(x('   '), '* | stats count()')
  assert.equal(x('*'), '* | stats count()')
  assert.equal(x(undefined), '* | stats count()')
  assert.equal(x('error'), 'error | stats count()')
})

test('FIX E7: a query that already has stats is not given a second one', () => {
  assert.equal(x('* | stats by (level) count()'), '* | stats by (level) count()')
  assert.equal(x('* | stats by ("service") count() | math c * 2 as d'), '* | stats by ("service") count() | math c * 2 as d')
  // `stats_remote` / `running_stats` are not stats.
  assert.equal(x('* | running_stats count()'), '* | running_stats count() | stats count()')
  // A second stats after the first is the user's, and legal after stats.
  assert.equal(x('* | stats count() | stats count()'), '* | stats count() | stats count()')
})

test('stream selector: field names quoted, pieces joined with a bare comma', () => {
  assert.equal(x('{service="payment", env="UNSET"}'), '{"service"="payment","env"="UNSET"} | stats count()')
  assert.equal(x('{service!="payment"}'), '{"service"!="payment"} | stats count()')
  assert.equal(x('{service=payment}'), '{"service"="payment"} | stats count()')
})

test('stream selector: in / not_in become a regex alternation (reference L4)', () => {
  assert.equal(x('{service in ("cubedemo-web", "order")}'), '{"service"=~"cubedemo\\\\-web|order"} | stats count()')
  assert.equal(x('{service not_in ("a", "b")}'), '{"service"!~"a|b"} | stats count()')
  assert.equal(x('{service not in ("a")}'), '{"service"!~"a"} | stats count()')
})

test('stream selector: a raw regex value is escaped into a string literal', () => {
  assert.equal(x('{service=~"pay.*"}'), '{"service"=~"pay.*"} | stats count()')
  assert.equal(x('{service=~"a\\.b"}'), '{"service"=~"a\\\\.b"} | stats count()')
  assert.equal(x('{service!~"x"}'), '{"service"!~"x"} | stats count()')
})

test('exact match: f:=v → f:="v"', () => {
  assert.equal(x('log.level:=error'), 'log.level:="error" | stats count()')
  assert.equal(x('endpoint:=/v1/order'), 'endpoint:="/v1/order" | stats count()')
  assert.equal(x('msg:="a b"'), 'msg:="a b" | stats count()')
})

test('not equals: f!=v → NOT f:="v" (reference L8 end to end)', () => {
  assert.equal(x('{service="order"} log.level!=info | stats by ("log.level") count()'),
    '{"service"="order"} NOT log.level:="info" | stats by ("log.level") count()')
})

test('regex: f:~"re" is kept, f!~"re" → NOT f:~"re"', () => {
  assert.equal(x('path:~"^/v1/.*"'), 'path:~"^/v1/.*" | stats count()')
  assert.equal(x('path!~"a\\d"'), 'NOT path:~"a\\\\d" | stats count()')
})

test('lists: f in (…) → f:in(…), f not_in (…) → NOT f:in(…)', () => {
  assert.equal(x('log.level in ("error", "warn")'), 'log.level:in("error","warn") | stats count()')
  assert.equal(x('endpoint not_in ("/a", "/b")'), 'NOT endpoint:in("/a","/b") | stats count()')
  assert.equal(x('endpoint not in ("/a")'), 'NOT endpoint:in("/a") | stats count()')
  assert.equal(x('span_kind in ()'), 'span_kind:in() | stats count()')
})

test('word, prefix, substring: kept when the value is one word, quoted when not', () => {
  assert.equal(x('service:payment'), 'service:payment | stats count()')
  assert.equal(x('path:/v1/order'), 'path:"/v1/order" | stats count()')
  assert.equal(x('service.name:payment-service'), 'service.name:"payment-service" | stats count()')
  assert.equal(x('http.status:5*'), 'http.status:5* | stats count()')
  assert.equal(x('path:/v1/pay*'), 'path:"/v1/pay"* | stats count()')
  assert.equal(x('path:*payment*'), 'path:*payment* | stats count()')
  assert.equal(x('path:*/v1/*'), 'path:*"/v1/"* | stats count()')
})

test('phrase, empty, exists and comparisons are already reference spelling', () => {
  assert.equal(x('_msg:"connection refused"'), '_msg:"connection refused" | stats count()')
  assert.equal(x('_msg:"say \\"hi\\""'), '_msg:"say \\"hi\\"" | stats count()')
  assert.equal(x('log.exception.type:""'), 'log.exception.type:"" | stats count()')
  assert.equal(x('log.exception.type:*'), 'log.exception.type:* | stats count()')
  assert.equal(x('duration:>100ms'), 'duration:>100ms | stats count()')
})

test('field names that are not plain identifiers are quoted', () => {
  assert.equal(x('compact-revision:=5'), '"compact-revision":="5" | stats count()')
  assert.equal(x('"compact-revision":="5"'), '"compact-revision":="5" | stats count()')
})

test('connectors: kept as written; AND after OR gets the bracket our left-to-right reading implies', () => {
  assert.equal(x('a:=1 AND b:=2'), 'a:="1" AND b:="2" | stats count()')
  assert.equal(x('a:=1 b:=2'), 'a:="1" b:="2" | stats count()')
  assert.equal(x('a:=1 or b:=2'), 'a:="1" OR b:="2" | stats count()')
  assert.equal(x('a:=1 AND b:=2 OR c:=3'), 'a:="1" AND b:="2" OR c:="3" | stats count()')
  assert.equal(x('a:=1 OR b:=2 AND c:=3'), '(a:="1" OR b:="2") AND c:="3" | stats count()')
  assert.equal(x('a:=1 OR b:=2 AND c:=3 OR d:=4 AND e:=5'),
    '((a:="1" OR b:="2") AND c:="3" OR d:="4") AND e:="5" | stats count()')
  // The stream selector is the first operand of that same reading.
  assert.equal(x('{service="a"} x:=1 OR y:=2 AND z:=3'),
    '({"service"="a"} x:="1" OR y:="2") AND z:="3" | stats count()')
})

test('groups are kept; a group of one loses its brackets', () => {
  assert.equal(x('(a:=1 OR b:=2) AND c:=3'), '(a:="1" OR b:="2") AND c:="3" | stats count()')
  assert.equal(x('c:=3 AND (a:=1 OR b:=2)'), 'c:="3" AND (a:="1" OR b:="2") | stats count()')
  assert.equal(x('(a:=1)'), 'a:="1" | stats count()')
})

test('negation: NOT, ! and - all read as NOT; a double negation cancels', () => {
  assert.equal(x('NOT log.level:=info'), 'NOT log.level:="info" | stats count()')
  assert.equal(x('!log.level:=info'), 'NOT log.level:="info" | stats count()')
  assert.equal(x('-error'), 'NOT error | stats count()')
  assert.equal(x('NOT (a:=1 OR b:=2)'), 'NOT (a:="1" OR b:="2") | stats count()')
  assert.equal(x('NOT log.level!=info'), 'log.level:="info" | stats count()')
})

test('a stats if (…) filter is converted like the main filter', () => {
  assert.equal(x('* | stats count() if (log.level:=error) as "errors", count() as "total"'),
    '* | stats count() if (log.level:="error") as "errors", count() as "total"')
  assert.equal(x('* | stats count() if (service in ("a", "b"))'), '* | stats count() if (service:in("a","b"))')
})

test('row-shaping pipes are dropped and reported', () => {
  assert.deepEqual(convertLogsQueryForExplore('log.exception.type:* | sort ("_time") desc | limit 100'),
    { query: 'log.exception.type:* | stats count()', dropped: ['sort ("_time") desc', 'limit 100'], addedCount: true })
  assert.deepEqual(convertLogsQueryForExplore('* | stats by ("service") count() | sort ("count(*)") desc | limit 10'),
    { query: '* | stats by ("service") count()', dropped: ['sort ("count(*)") desc', 'limit 10'], addedCount: false })
  // fields / keep only before stats (they would delete _time), top only after.
  assert.equal(x('* | keep service | stats count()'), '* | stats count()')
  assert.equal(x('* | stats by (service) count() as c | fields c'), '* | stats by (service) count() as c | fields c')
  assert.equal(x('* | stats by (service) count() | top 5 by (service)'), '* | stats by (service) count()')
  // Our math serializer's placeholder for an empty expression.
  assert.deepEqual(convertLogsQueryForExplore('x | math').dropped, ['math'])
  // Other pipes are carried as written.
  assert.equal(x('* | unpack_json | stats count()'), '* | unpack_json | stats count()')
  assert.equal(x('error | | stats count()'), 'error | stats count()')
})

test('reference LogsQL passes through unchanged (every builder example)', () => {
  for (const q of [
    '{"service"="order"} NOT log.level:="info" | stats by ("log.level") count()',
    '* | stats by ("service") count_uniq(trace_id) as "traces"',
    '{"service"="payment"} | stats count() if (log.level:="error") as "errors", count() as "total" | math errors / total * 100 as "error_pct"',
    '{"service"="shipment-service","span_kind"=~"server|consumer"} NOT status_code:="ERROR" | stats by ("span_name") count() as "requests", quantile(0.99, duration) as "p99"',
    '{"service"=~"payment\\\\-service|order\\\\-service"} NOT span_kind:in("client","internal") | stats by ("service") quantile(0.9, duration) as "p90"',
    '{"service"="shipment-service"} | stats by ("span_kind", "status_code") count() if (duration:>100ms) as "slow"',
  ]) assert.equal(x(q), q)
})

test('the conversion is idempotent', () => {
  for (const q of [
    '{service in ("cubedemo-web", "order")} log.level!=info', 'a:=1 OR b:=2 AND c:=3',
    'path:/v1/pay* AND endpoint not_in ("/a")', '{service=~"a\\.b"} -error',
  ]) assert.equal(x(x(q)), x(q), q)
})

test('text the converter does not understand is carried verbatim', () => {
  assert.equal(x('f:i(foo)'), 'f:i(foo) | stats count()')
  assert.equal(x('_time:[a,b) error'), '_time:[a,b) error | stats count()')
  assert.equal(x('service=~"pay.*"'), 'service=~"pay.*" | stats count()')
  assert.equal(x('"unterminated'), '"unterminated | stats count()')
  assert.equal(x('{service='), '{service= | stats count()')
  assert.equal(x(')('), ')( | stats count()')
  assert.equal(x('a:=1 AND'), 'a:=1 AND | stats count()')
  // An empty stream selector selects nothing in particular.
  assert.equal(x('{}'), '* | stats count()')
})

test('end to end from the Logs page: chips and pipes as the page composes them', () => {
  const page = (chips, pipes = []) => x(composeQuery(chipsToString(chips), pipes))
  assert.equal(page([{ field: 'service', op: 'eq', value: 'payment' }, { field: 'log.level', op: 'eq', value: 'error', connector: 'AND' }]),
    '{"service"="payment"} log.level:="error" | stats count()')
  assert.equal(page([{ field: 'service', op: 'in', value: ['payment', 'order'] }]),
    '{"service"=~"payment|order"} | stats count()')
  assert.equal(page([{ field: 'log.level', op: 'neq', value: 'info' }, { field: 'http.status', op: 'prefix', value: '5', connector: 'AND' }]),
    'NOT log.level:="info" AND http.status:5* | stats count()')
  assert.equal(page([], [newStatsPipe({ groupBy: ['log.level'] , functions: [newStatsFunction()] })]),
    '* | stats by ("log.level") count()')
  assert.equal(page([{ field: 'service', op: 'eq', value: 'payment' }],
    [newStatsPipe({ groupBy: ['endpoint'], functions: [newStatsFunction()] }), newSortPipe({ field: 'count(*)' }), newLimitPipe({ n: 10 })]),
  '{"service"="payment"} | stats by ("endpoint") count()')
})

test('end to end from the Traces page', () => {
  const chips = [{ field: 'service', op: 'eq', value: 'payment-service' }, { field: 'status_code', op: 'eq', value: 'ERROR', connector: 'AND' }]
  assert.equal(x(composeQuery(chipsToString(chips), [])), '{"service"="payment-service"} status_code:="ERROR" | stats count()')
})
