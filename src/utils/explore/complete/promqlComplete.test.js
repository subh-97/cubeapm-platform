// What the Metrics Code tab offers, where, and how it writes it back.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { suggestPromql } from './promqlComplete.js'

const METRICS = ['cube_apm_calls_total', 'cube_apm_latency_bucket', 'node_cpu_seconds_total']
const LABELS = ['__name__', 'env', 'service', 'root_name', 'http_code']
const VALUES = {
  service: ['order-service', 'payment-service', 'shipment-service'],
  env: ['prod', 'staging'],
  root_name: ['GET /v1/orders', 'POST /v1/pay'],
}

// Records what each fetcher was asked, so a test can assert the narrowing.
function spy(overrides = {}) {
  const calls = { metricNames: [], labelNames: [], labelValues: [] }
  return {
    calls,
    metricNames: async () => { calls.metricNames.push([]); return overrides.metrics ?? METRICS },
    labelNames: async (match) => { calls.labelNames.push(match); return overrides.labels ?? LABELS },
    labelValues: async (label, match) => {
      calls.labelValues.push([label, match])
      return overrides.values?.[label] ?? VALUES[label] ?? []
    },
  }
}

const at = (text, marker = '|') => {
  const caret = text.indexOf(marker)
  return [text.slice(0, caret) + text.slice(caret + 1), caret]
}

const labels = r => r.items.map(i => i.label)
const kinds = r => [...new Set(r.items.map(i => i.kind))]

const METRIC_DOC =
  'API calls tracked by CubeAPM. Use this to calculate request rates, e.g. RPM, error rate, etc.'

test('an empty editor offers metric names first, then the keyword vocabulary', async () => {
  const r = await suggestPromql('', 0, spy(), { limit: 500 })
  assert.deepEqual(r.items.slice(0, 3).map(i => i.label), METRICS)
  assert.equal(r.items[0].kind, 'metric')
  assert.equal(r.items[0].doc, METRIC_DOC)
  assert.ok(r.items.some(i => i.label === 'sum' && i.kind === 'aggregation'))
  assert.ok(r.items.some(i => i.label === 'rate' && i.kind === 'function'))
  assert.ok(r.items.some(i => i.label === 'avg_over_time' && i.detail === 'rollup'))
  assert.ok(r.items.some(i => i.label === 'default' && i.kind === 'keyword'))
  assert.ok(r.items.some(i => i.label === 'by' && i.detail === 'vector matching'))
  assert.deepEqual([r.from, r.to], [0, 0])
})

test('a half-typed name is ranked prefix-first and replaced whole', async () => {
  const [text, caret] = at('cube_apm_l|atency')
  const r = await suggestPromql(text, caret, spy())
  assert.deepEqual([r.from, r.to], [0, 'cube_apm_latency'.length])
  assert.equal(r.items[0].label, 'cube_apm_latency_bucket')
  assert.equal(r.items[0].insertText, 'cube_apm_latency_bucket')
})

test('a fragment matching only keywords drops the metrics', async () => {
  const [text, caret] = at('histogram_q|')
  const r = await suggestPromql(text, caret, spy())
  assert.deepEqual(labels(r), ['histogram_quantile'])
  assert.equal(r.items[0].detail, 'function')
  assert.match(r.items[0].doc, /^Used to calculate percentiles/)
})

test('inside braces the caret is naming a label, and the metric narrows the list', async () => {
  const [text, caret] = at('cube_apm_calls_total{|}')
  const f = spy()
  const r = await suggestPromql(text, caret, f)
  assert.deepEqual(kinds(r), ['label'])
  assert.deepEqual(labels(r), LABELS)
  assert.deepEqual(f.calls.labelNames, [['cube_apm_calls_total']])
  assert.equal(r.items.find(i => i.label === 'service').doc, 'Name of the micro-service')
})

test('a label name goes in bare; the span is the whole half-typed name', async () => {
  const [text, caret] = at('cube_apm_calls_total{ser|}')
  const r = await suggestPromql(text, caret, spy())
  assert.deepEqual(labels(r), ['service'])
  assert.equal(r.items[0].insertText, 'service')
  assert.equal(text.slice(r.from, r.to), 'ser')
})

test('after a matcher operator the caret is picking a value, and it is quoted on the way in', async () => {
  const [text, caret] = at('cube_apm_calls_total{service=|}')
  const f = spy()
  const r = await suggestPromql(text, caret, f)
  assert.deepEqual(kinds(r), ['value'])
  assert.deepEqual(f.calls.labelValues, [['service', ['cube_apm_calls_total']]])
  assert.equal(r.items[0].label, 'order-service')
  assert.equal(r.items[0].insertText, '"order-service"')
  assert.deepEqual([r.from, r.to], [caret, caret])
})

test('a terminated string is replaced whole, quotes included', async () => {
  const [text, caret] = at('cube_apm_calls_total{service="pay|"}')
  const r = await suggestPromql(text, caret, spy())
  assert.deepEqual(labels(r), ['payment-service'])
  assert.equal(text.slice(r.from, r.to), '"pay"')
  assert.equal(
    text.slice(0, r.from) + r.items[0].insertText + text.slice(r.to),
    'cube_apm_calls_total{service="payment-service"}'
  )
})

test('inside an unterminated string the replacement stops at the caret, not at the end of input', async () => {
  // The lexer hands an unterminated string everything to the end — including
  // the `}` the person still means to keep.
  const [text, caret] = at('cube_apm_calls_total{service="pay|}')
  const r = await suggestPromql(text, caret, spy())
  assert.deepEqual(labels(r), ['payment-service'])
  assert.equal(r.to, caret)
  assert.equal(text.slice(r.from, r.to), '"pay')
  assert.equal(
    text.slice(0, r.from) + r.items[0].insertText + text.slice(r.to),
    'cube_apm_calls_total{service="payment-service"}'
  )
})

test('a value is escaped when it carries a quote or a backslash', async () => {
  const [text, caret] = at('m{root_name="|"}')
  const r = await suggestPromql(text, caret, spy({ values: { root_name: ['a"b', 'c\\d'] } }))
  assert.deepEqual(r.items.map(i => i.insertText), ['"a\\"b"', '"c\\\\d"'])
})

test('the other complete matchers narrow a value list; the one being edited does not', async () => {
  const [text, caret] = at('cube_apm_calls_total{env="prod", service="|", http_code="500"}')
  const f = spy()
  await suggestPromql(text, caret, f)
  assert.deepEqual(f.calls.labelValues, [
    ['service', ['cube_apm_calls_total{env="prod",http_code="500"}']],
  ])
})

test('a half-written matcher never narrows anything to nothing', async () => {
  const [text, caret] = at('cube_apm_calls_total{env=, service="|"}')
  const f = spy()
  await suggestPromql(text, caret, f)
  assert.deepEqual(f.calls.labelValues, [['service', ['cube_apm_calls_total']]])
})

test('a selector with no metric name and no complete matchers narrows nothing', async () => {
  const [text, caret] = at('{service="|"}')
  const f = spy()
  await suggestPromql(text, caret, f)
  assert.deepEqual(f.calls.labelValues, [['service', []]])
})

test('a grouping list offers label names, unnarrowed', async () => {
  for (const kw of ['by', 'without', 'on', 'ignoring', 'group_left']) {
    const [text, caret] = at(`sum(x) ${kw} (|)`)
    const f = spy()
    const r = await suggestPromql(text, caret, f)
    assert.deepEqual(kinds(r), ['label'], kw)
    assert.deepEqual(f.calls.labelNames, [[]], kw)
  }
})

test('a plain function call is an expression, not a grouping list', async () => {
  const [text, caret] = at('rate(|)')
  const r = await suggestPromql(text, caret, spy())
  assert.ok(r.items.some(i => i.kind === 'metric'))
})

test('the caret inside a number, a duration or a macro has nothing to offer', async () => {
  for (const src of ['rate(x[5m|])', 'x > 42|', 'x[$__interval|]']) {
    const [text, caret] = at(src)
    const r = await suggestPromql(text, caret, spy())
    assert.deepEqual(r.items, [], src)
  }
})

test('a string outside a selector is not a label value', async () => {
  const [text, caret] = at('label_replace(x, "ds|t", "", "", "")')
  const r = await suggestPromql(text, caret, spy())
  assert.deepEqual(r.items, [])
})

test('missing fetchers degrade to the catalogs rather than throwing', async () => {
  const r = await suggestPromql('su', 2, {})
  assert.deepEqual(labels(r), ['sum', 'sum_over_time'])
  const inBraces = await suggestPromql('x{', 2, {})
  assert.deepEqual(inBraces.items, [])
})

test('a fetcher that rejects leaves the offer empty instead of surfacing an error', async () => {
  const r = await suggestPromql('x{', 2, { labelNames: async () => { throw new Error('boom') } })
  assert.deepEqual(r.items, [])
})

test('the caret is clamped into the text', async () => {
  const r = await suggestPromql('sum', 99, spy())
  assert.deepEqual([r.from, r.to], [0, 3])
  const zero = await suggestPromql('sum', -5, spy())
  assert.deepEqual([zero.from, zero.to], [0, 0])
})

test('the list is capped, newest limit honoured', async () => {
  const many = Array.from({ length: 200 }, (_, i) => `metric_${i}`)
  const r = await suggestPromql('metric_', 7, spy({ metrics: many }))
  assert.equal(r.items.length, 50)
  const small = await suggestPromql('metric_', 7, spy({ metrics: many }), { limit: 3 })
  assert.equal(small.items.length, 3)
})
