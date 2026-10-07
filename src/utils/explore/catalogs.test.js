// The Explore vocabularies. The strings are the reference's own documentation,
// so the spot checks below compare against the playground text word for word;
// the structural checks pin the shapes the editors and the generators rely on.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  METRIC_DOCS, LABEL_DOCS, FUNCTION_DOCS, ADVANCED_OPERATIONS, QUICK_CALCULATE, QUICK_LABELS,
  MATCH_OPERATORS, LOGS_STATS_FUNCTIONS, LOGSQL_PIPES, LOGSQL_STATS_FUNCTIONS,
  LOGSQL_FILTER_FUNCTIONS, PROMQL_KEYWORDS, PROMQL_KEYWORD_GROUPS,
} from './catalogs.js'

const names = list => list.map(e => e.name)

// ---------- Metrics descriptions ----------

test('METRIC_DOCS covers the six CubeAPM metrics, verbatim', () => {
  assert.deepEqual(Object.keys(METRIC_DOCS), [
    'cube_apm_calls_total', 'cube_apm_ingested_bytes_total', 'cube_apm_latency_bucket',
    'cube_apm_latency_count', 'cube_apm_latency_sum', 'cube_apm_latency_total',
  ])
  assert.equal(METRIC_DOCS.cube_apm_latency_bucket,
    'Latencies of API calls tracked by CubeAPM, segmented into buckets. Use this to calculate latency percentiles, e.g., p90 latency.')
})

test('LABEL_DOCS covers the twelve documented labels, verbatim', () => {
  assert.equal(Object.keys(LABEL_DOCS).length, 12)
  assert.equal(LABEL_DOCS.status_code,
    'Status of operation - OK means completed successfully, ERROR means resulted in error, UNSET means not set')
  assert.equal(LABEL_DOCS['host.name'], 'Name of the host where the micro-service is running')
})

test('FUNCTION_DOCS documents every Advanced operation except the two operators', () => {
  const ops = ADVANCED_OPERATIONS.flatMap(g => g.options)
  for (const o of ops) {
    if (o.type === 'operator') assert.equal(FUNCTION_DOCS[o.value], undefined, o.value)
    else assert.equal(typeof FUNCTION_DOCS[o.value], 'string', o.value)
  }
  assert.equal(Object.keys(FUNCTION_DOCS).length, 19)
  assert.equal(FUNCTION_DOCS.round, 'Round to nearest multiple of to_nearest. to_nearest can also be a fraction.')
})

// ---------- Advanced operations ----------

test('ADVANCED_OPERATIONS: five groups, 21 operations, in picker order', () => {
  assert.deepEqual(ADVANCED_OPERATIONS.map(g => g.label), ['Aggregation', 'Rounding', 'Range', 'Histogram', 'Operators'])
  assert.deepEqual(ADVANCED_OPERATIONS.map(g => g.options.map(o => o.value)), [
    ['avg', 'count', 'max', 'min', 'sum', 'topk'],
    ['ceil', 'clamp', 'clamp_max', 'clamp_min', 'floor', 'round'],
    ['changes', 'delta', 'deriv', 'increase', 'rate', 'resets'],
    ['histogram_quantile'],
    ['*', '/'],
  ])
})

test('ADVANCED_OPERATIONS: arg specs as the reference ships them', () => {
  const byValue = Object.fromEntries(ADVANCED_OPERATIONS.flatMap(g => g.options).map(o => [o.value, o]))
  assert.deepEqual(byValue.sum.args, [{ type: 'aggregation' }])
  assert.deepEqual(byValue.topk.args, [
    { label: 'k', type: 'number', default: '5', position: 'before' },
    { type: 'aggregation' },
  ])
  // clamp's min has no default — the picker seeds it with the number 0.
  assert.deepEqual(byValue.clamp.args, [{ label: 'min', type: 'number' }, { label: 'max', type: 'number', default: '1' }])
  assert.deepEqual(byValue.histogram_quantile.args, [{ label: 'quantile', type: 'number', default: '0.9', position: 'before' }])
  assert.deepEqual(byValue['*'], { type: 'operator', value: '*', args: [{ label: 'by', type: 'number', default: '1' }] })
  assert.deepEqual(byValue.rate.args, [])
})

// ---------- Quick ----------

test('QUICK_CALCULATE: the four options and their Explore labels', () => {
  assert.deepEqual(QUICK_CALCULATE, [
    { value: 'rpm', label: 'RPM' },
    { value: 'error_percentage', label: 'Error %' },
    { value: 'latency_percentile', label: '%ile Latency' },
    { value: 'latency_average', label: 'Avg Latency' },
  ])
})

test('QUICK_LABELS: seven fixed labels, only http_code and exception special, all documented', () => {
  assert.deepEqual(QUICK_LABELS.map(l => l.label), ['env', 'service', 'root_name', 'service.version', 'host.name', 'http_code', 'exception'])
  assert.deepEqual(QUICK_LABELS.filter(l => l.isSpecial).map(l => l.label), ['http_code', 'exception'])
  for (const { label } of QUICK_LABELS) assert.equal(typeof LABEL_DOCS[label], 'string', label)
})

test('MATCH_OPERATORS: equals, not equals, in, not in', () => {
  assert.deepEqual(MATCH_OPERATORS, [
    { value: '=', label: 'equals' },
    { value: '!=', label: 'not equals' },
    { value: '=~', label: 'in' },
    { value: '!~', label: 'not in' },
  ])
})

// ---------- Logs/Traces ----------

test('LOGS_STATS_FUNCTIONS: the nine Builder functions; only quantile has a number arg', () => {
  assert.deepEqual(LOGS_STATS_FUNCTIONS.map(f => f.value),
    ['avg', 'count', 'count_empty', 'count_uniq', 'max', 'median', 'min', 'quantile', 'sum'])
  for (const f of LOGS_STATS_FUNCTIONS) {
    if (f.value === 'quantile') {
      assert.deepEqual(f.args, [{ type: 'number', label: 'quantile', default: '0.9' }, { type: 'field', label: 'field' }])
    } else {
      assert.deepEqual(f.args, [{ type: 'field', label: 'field' }], f.value)
    }
  }
})

test('LOGSQL_PIPES: 60 pipes, alphabetical, aliases share their detail', () => {
  assert.equal(LOGSQL_PIPES.length, 60)
  assert.equal(new Set(names(LOGSQL_PIPES)).size, 60)
  assert.deepEqual(names(LOGSQL_PIPES), [...names(LOGSQL_PIPES)].sort())
  assert.equal(LOGSQL_PIPES[0].name, 'block_stats')
  assert.equal(LOGSQL_PIPES.at(-1).name, 'where')
  const detail = Object.fromEntries(LOGSQL_PIPES.map(p => [p.name, p.detail]))
  assert.equal(detail.stats, 'calculate stats over rows, optionally grouped by fields')
  assert.equal(detail.join, "join rows with another query's results on the given fields")
  for (const [a, b] of [['copy', 'cp'], ['delete', 'rm'], ['fields', 'keep'], ['filter', 'where'], ['limit', 'head'], ['sort', 'order'], ['rename', 'mv'], ['offset', 'skip']]) {
    assert.equal(detail[a], detail[b], `${a} / ${b}`)
  }
  for (const p of LOGSQL_PIPES) assert.ok(p.detail, p.name)
})

test('LOGSQL_STATS_FUNCTIONS: 25 functions, a superset of the Builder list', () => {
  assert.equal(LOGSQL_STATS_FUNCTIONS.length, 25)
  assert.deepEqual(names(LOGSQL_STATS_FUNCTIONS), [...names(LOGSQL_STATS_FUNCTIONS)].sort())
  for (const f of LOGS_STATS_FUNCTIONS) assert.ok(names(LOGSQL_STATS_FUNCTIONS).includes(f.value), f.value)
  assert.equal(LOGSQL_STATS_FUNCTIONS.find(f => f.name === 'rate').detail, 'per-second rate of matching rows')
})

test('LOGSQL_FILTER_FUNCTIONS: 23 functions', () => {
  assert.equal(LOGSQL_FILTER_FUNCTIONS.length, 23)
  assert.equal(LOGSQL_FILTER_FUNCTIONS[0].name, 'contains_all')
  assert.equal(LOGSQL_FILTER_FUNCTIONS.at(-1).name, 'value_type')
  assert.equal(LOGSQL_FILTER_FUNCTIONS.find(f => f.name === 'string_range').detail, 'matches string values in [minValue, maxValue)')
})

// ---------- PromQL keywords ----------

test('PROMQL_KEYWORDS: aggregations, functions, rollups, matching, modifiers — no duplicates', () => {
  assert.equal(new Set(PROMQL_KEYWORDS).size, PROMQL_KEYWORDS.length)
  const groups = Object.values(PROMQL_KEYWORD_GROUPS).flat()
  assert.deepEqual(new Set(PROMQL_KEYWORDS), new Set(groups))
  for (const k of ['sum', 'topk', 'rate', 'increase', 'histogram_quantile', 'label_replace', 'by', 'without',
    'ignoring', 'group_left', 'offset']) {
    assert.ok(PROMQL_KEYWORDS.includes(k), k)
  }
})

test('PROMQL_KEYWORDS fixes the reference list: real rollups only, plus clamp and MetricsQL default', () => {
  for (const bogus of ['topk_over_time', 'bottomk_over_time', 'count_values_over_time', 'group_over_time']) {
    assert.ok(!PROMQL_KEYWORDS.includes(bogus), bogus)
  }
  for (const k of ['last_over_time', 'present_over_time', 'sum_over_time', 'quantile_over_time', 'clamp', 'default', 'bool']) {
    assert.ok(PROMQL_KEYWORDS.includes(k), k)
  }
  // Every function the Advanced tab can emit is one the Code tab can complete.
  for (const o of ADVANCED_OPERATIONS.flatMap(g => g.options)) {
    if (o.type !== 'operator') assert.ok(PROMQL_KEYWORDS.includes(o.value), o.value)
  }
})

// ---------- Immutability ----------

test('every catalog is deeply frozen', () => {
  for (const c of [METRIC_DOCS, LABEL_DOCS, FUNCTION_DOCS, ADVANCED_OPERATIONS, QUICK_CALCULATE, QUICK_LABELS,
    MATCH_OPERATORS, LOGS_STATS_FUNCTIONS, LOGSQL_PIPES, LOGSQL_STATS_FUNCTIONS, LOGSQL_FILTER_FUNCTIONS,
    PROMQL_KEYWORDS, PROMQL_KEYWORD_GROUPS]) {
    assert.ok(Object.isFrozen(c))
  }
  assert.ok(Object.isFrozen(ADVANCED_OPERATIONS[0].options[5].args[0]))
  assert.ok(Object.isFrozen(PROMQL_KEYWORD_GROUPS.functions))
  assert.throws(() => { ADVANCED_OPERATIONS[0].options.push({ value: 'x', args: [] }) }, TypeError)
  assert.throws(() => { LOGS_STATS_FUNCTIONS[7].args[0].default = '0.5' }, TypeError)
})
