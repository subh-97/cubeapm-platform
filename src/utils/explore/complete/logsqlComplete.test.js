// What the Logs / Traces Code tab offers, where, and how it writes it back.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { suggestLogsql, logsqlValueLiteral } from './logsqlComplete.js'

const FIELDS = [
  { value: '_msg', hits: 900 },
  { value: 'log.level', hits: 820 },
  { value: 'service', hits: 820 },
  { value: 'compact-revision', hits: 4 },
]
const VALUES = {
  'log.level': [{ value: 'error', hits: 42 }, { value: 'info', hits: 900 }],
  service: [{ value: 'order-service', hits: 11 }, { value: 'payment service', hits: 3 }],
}
const STREAM_FIELDS = ['service', 'env']
const STREAM_VALUES = { service: ['order-service', 'payment-service'] }

function spy(overrides = {}) {
  const calls = { fieldNames: 0, fieldValues: [], streamFieldNames: 0, streamFieldValues: [] }
  return {
    calls,
    fieldNames: async () => { calls.fieldNames++; return overrides.fields ?? FIELDS },
    fieldValues: async (f) => { calls.fieldValues.push(f); return overrides.values?.[f] ?? VALUES[f] ?? [] },
    streamFieldNames: async () => { calls.streamFieldNames++; return overrides.streamFields ?? STREAM_FIELDS },
    streamFieldValues: async (f) => {
      calls.streamFieldValues.push(f)
      return overrides.streamValues?.[f] ?? STREAM_VALUES[f] ?? []
    },
  }
}

// The caret marker cannot be `|`: that is LogsQL's pipe.
const at = (text, marker = '‸') => {
  const caret = text.indexOf(marker)
  return [text.slice(0, caret) + text.slice(caret + 1), caret]
}

const labels = r => r.items.map(i => i.label)
const kinds = r => [...new Set(r.items.map(i => i.kind))]
const inserts = r => r.items.map(i => i.insertText)

test('right after a pipe the caret is naming a pipe', async () => {
  const [text, caret] = at('* |‸')
  const r = await suggestLogsql(text, caret, spy())
  assert.deepEqual(kinds(r), ['pipe'])
  assert.equal(r.items[0].label, 'block_stats')
  assert.equal(r.items[0].doc, 'return per-column storage stats for processed blocks')
})

test('a half-typed pipe name is ranked and replaced whole, unknown though it is so far', async () => {
  const [text, caret] = at('* | sta‸')
  const r = await suggestLogsql(text, caret, spy())
  assert.deepEqual(labels(r), ['stats', 'stats_remote', 'block_stats', 'query_stats',
    'running_stats', 'total_stats'])
  assert.equal(text.slice(r.from, r.to), 'sta')
})

test('a stats pipe offers stats functions, not pipes', async () => {
  const [text, caret] = at('* | stats co‸')
  const r = await suggestLogsql(text, caret, spy())
  assert.deepEqual(kinds(r), ['statsFn'])
  assert.deepEqual(labels(r), ['count', 'count_empty', 'count_uniq', 'count_uniq_hash'])
})

test('another aggregate after a comma is still a stats function', async () => {
  const [text, caret] = at('* | stats count() by (service), ‸')
  const r = await suggestLogsql(text, caret, spy())
  assert.deepEqual(kinds(r), ['statsFn'])
})

test('a stats group-by list offers field names, quoted the way the Builder writes them', async () => {
  const [text, caret] = at('* | stats by (‸) count()')
  const f = spy()
  const r = await suggestLogsql(text, caret, f)
  assert.deepEqual(kinds(r), ['field'])
  assert.equal(f.calls.fieldNames, 1)
  assert.deepEqual(inserts(r), ['"_msg"', '"log.level"', '"service"', '"compact-revision"'])
  assert.equal(r.items[1].detail, '820')
})

test("a stats function's arguments are field names", async () => {
  const [text, caret] = at('* | stats avg(‸)')
  const r = await suggestLogsql(text, caret, spy())
  assert.deepEqual(kinds(r), ['field'])
  // Outside a by-list a plain name goes in bare; one that is not an identifier
  // is quoted, as quoteFieldName has it.
  assert.deepEqual(inserts(r), ['_msg', 'log.level', 'service', '"compact-revision"'])
})

test('a field-list pipe offers field names', async () => {
  const [text, caret] = at('* | fields lo‸')
  const r = await suggestLogsql(text, caret, spy())
  assert.deepEqual(labels(r), ['log.level'])
  assert.equal(text.slice(r.from, r.to), 'lo')
})

test('the filter section offers field names with their colon, then filter functions', async () => {
  const [text, caret] = at('‸')
  const r = await suggestLogsql(text, caret, spy())
  assert.deepEqual(r.items.slice(0, 4).map(i => i.insertText),
    ['_msg:', 'log.level:', 'service:', '"compact-revision":'])
  assert.ok(r.items.some(i => i.kind === 'filterFn' && i.label === 'contains_all'))
})

test("after `field:` the caret is picking that field's values", async () => {
  const [text, caret] = at('log.level:‸')
  const f = spy()
  const r = await suggestLogsql(text, caret, f)
  assert.deepEqual(f.calls.fieldValues, ['log.level'])
  assert.deepEqual(kinds(r), ['value'])
  assert.deepEqual(labels(r), ['error', 'info'])
  assert.deepEqual(inserts(r), ['error', 'info'])
  assert.equal(r.items[0].detail, '42')
})

test('a bare filter value is quoted only when it has to be', async () => {
  const [text, caret] = at('service:‸')
  const r = await suggestLogsql(text, caret, spy())
  assert.deepEqual(inserts(r), ['order-service', '"payment service"'])
})

test('a half-typed value is ranked and replaced whole', async () => {
  const [text, caret] = at('log.level:er‸')
  const r = await suggestLogsql(text, caret, spy())
  assert.deepEqual(labels(r), ['error'])
  assert.equal(text.slice(r.from, r.to), 'er')
})

test('the `:=` form is a value position too', async () => {
  const [text, caret] = at('log.level:=‸')
  const f = spy()
  await suggestLogsql(text, caret, f)
  assert.deepEqual(f.calls.fieldValues, ['log.level'])
})

test('inside a quoted value the whole literal is replaced and the insert brings its own quotes', async () => {
  const [text, caret] = at('log.level:"er‸"')
  const r = await suggestLogsql(text, caret, spy())
  assert.deepEqual(labels(r), ['error'])
  assert.equal(text.slice(r.from, r.to), '"er"')
  assert.equal(r.items[0].insertText, '"error"')
})

test('an unterminated value stops its replacement at the caret', async () => {
  const [text, caret] = at('log.level:"er‸ | stats count()')
  const r = await suggestLogsql(text, caret, spy())
  assert.equal(r.to, caret)
  assert.equal(text.slice(r.from, r.to), '"er')
  assert.equal(
    text.slice(0, r.from) + r.items[0].insertText + text.slice(r.to),
    'log.level:"error" | stats count()'
  )
})

test('an in-list offers the same field\'s values, quoted as fieldFilter writes them', async () => {
  const [text, caret] = at('log.level:in(‸)')
  const f = spy()
  const r = await suggestLogsql(text, caret, f)
  assert.deepEqual(f.calls.fieldValues, ['log.level'])
  assert.deepEqual(inserts(r), ['"error"', '"info"'])
})

test('a second value in an in-list still knows which field it belongs to', async () => {
  const [text, caret] = at('log.level:in("error",‸)')
  const f = spy()
  await suggestLogsql(text, caret, f)
  assert.deepEqual(f.calls.fieldValues, ['log.level'])
})

test('a stream selector offers stream field names, always quoted', async () => {
  const [text, caret] = at('{‸}')
  const f = spy()
  const r = await suggestLogsql(text, caret, f)
  assert.equal(f.calls.streamFieldNames, 1)
  assert.equal(f.calls.fieldNames, 0)
  assert.deepEqual(inserts(r), ['"service"', '"env"'])
})

test('a stream value is asked for by the unquoted field name', async () => {
  const [text, caret] = at('{"service"="ord‸"}')
  const f = spy()
  const r = await suggestLogsql(text, caret, f)
  assert.deepEqual(f.calls.streamFieldValues, ['service'])
  assert.deepEqual(inserts(r), ['"order-service"'])
})

test('a filter inside `if (…)` is a filter again, pipe or no pipe', async () => {
  const [text, caret] = at('* | stats count() if (‸) as errors')
  const r = await suggestLogsql(text, caret, spy())
  assert.ok(r.items.some(i => i.kind === 'field' && i.insertText === 'log.level:'))
  assert.ok(r.items.some(i => i.kind === 'filterFn'))
})

test('a filter pipe is a filter section', async () => {
  const [text, caret] = at('* | filter ‸')
  const r = await suggestLogsql(text, caret, spy())
  assert.ok(r.items.some(i => i.insertText === 'log.level:'))
})

test('missing fetchers leave the catalog-only lists working', async () => {
  const [text, caret] = at('* | sta‸')
  const r = await suggestLogsql(text, caret, {})
  assert.ok(r.items.length > 0)
  const values = await suggestLogsql(...at('log.level:‸'), {})
  assert.deepEqual(values.items, [])
})

test('a fetcher that rejects leaves the offer empty', async () => {
  const [text, caret] = at('log.level:‸')
  const r = await suggestLogsql(text, caret, { fieldValues: async () => { throw new Error('boom') } })
  assert.deepEqual(r.items, [])
})

test('an operator with no field on its left asks nothing', async () => {
  const [text, caret] = at('* | stats count() | filter :‸')
  const r = await suggestLogsql(text, caret, spy())
  assert.deepEqual(r.items, [])
})

test('the list is capped', async () => {
  const many = Array.from({ length: 200 }, (_, i) => `f_${i}`)
  const [text, caret] = at('f_‸')
  const r = await suggestLogsql(text, caret, spy({ fields: many }))
  assert.equal(r.items.length, 50)
  const small = await suggestLogsql(text, caret, spy({ fields: many }), { limit: 4 })
  assert.equal(small.items.length, 4)
})

test('logsqlValueLiteral quotes what LogsQL would not read as one bare token', () => {
  assert.equal(logsqlValueLiteral('error'), 'error')
  assert.equal(logsqlValueLiteral('order-service'), 'order-service')
  assert.equal(logsqlValueLiteral('/v1/orders'), '"/v1/orders"')
  assert.equal(logsqlValueLiteral('200'), '200')
  assert.equal(logsqlValueLiteral('payment service'), '"payment service"')
  assert.equal(logsqlValueLiteral(''), '""')
  assert.equal(logsqlValueLiteral('-5'), '"-5"')
  assert.equal(logsqlValueLiteral('and'), '"and"')
  assert.equal(logsqlValueLiteral('a"b'), '"a\\"b"')
})
