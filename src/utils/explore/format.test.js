// Explore value formatting: the reference tables (results-area.md §8), the
// label string every legend and table row is built from, deltas, and the
// Legend value reducers.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  formatNumberValue, formatTimeValue, formatValue, labelsToString, formatDelta,
  reduceValues, formatLocal,
} from './format.js'

// ---------- number ----------

test('number type matches the reference table', () => {
  const cases = [
    [0, '0'], [0.5, '0.5'], [0.004, '0.004'], [0.00001, '<.0001'], [12.3456, '12.35'],
    [1234, '1.23K'], [1500000, '1.5M'], [2.5e9, '2.5G'], [3e12, '3000G'], [-1234, '-1.23K'],
  ]
  for (const [v, want] of cases) assert.equal(formatNumberValue(v), want, `${v}`)
})

test('number type: NaN and nothing read as empty, never "NaN"', () => {
  assert.equal(formatNumberValue(NaN), '')
  assert.equal(formatNumberValue(null), '')
  assert.equal(formatNumberValue(''), '')
  // The reference throws on Infinity; a table cell must not take the page down.
  assert.equal(formatNumberValue(Infinity), '')
})

test('number type: strings are formatted as the reference does (it takes the string form)', () => {
  assert.equal(formatNumberValue('1234'), '1.23K')
  assert.equal(formatNumberValue('-0.5'), '-0.5')
  assert.equal(formatNumberValue(1e-7), '<.0001')
  assert.equal(formatNumberValue(999.999), '1000')
  assert.equal(formatNumberValue(12), '12')
  assert.equal(formatNumberValue(1000), '1K')
})

// ---------- time ----------

test('time type: seconds formatted as a duration, per the reference table', () => {
  const cases = [
    [0, '0 ns'], [5e-7, '500 ns'], [0.000012, '12 μs'], [0.612, '612 ms'], [1.5, '1.5 s'], [3600, '3600 s'],
  ]
  for (const [v, want] of cases) assert.equal(formatTimeValue(v), want, `${v}`)
})

test('time type: the incident p90 reads in ms', () => {
  assert.equal(formatTimeValue(0.14), '140 ms')
  assert.equal(formatTimeValue(0.0005), '500 μs')
})

test('time type: a non-number is empty rather than " ns"', () => {
  assert.equal(formatTimeValue(NaN), '')
  assert.equal(formatTimeValue(undefined), '')
})

// ---------- formatValue ----------

test('formatValue: missing is "-", NaN is empty, unit picks the formatter', () => {
  assert.equal(formatValue(undefined), '-')
  assert.equal(formatValue(null, 'time'), '-')
  assert.equal(formatValue(NaN), '')
  assert.equal(formatValue(1234), '1.23K')
  assert.equal(formatValue(0.612, 'time'), '612 ms')
  assert.equal(formatValue(0.612, 'number'), '0.61')
})

// ---------- labelsToString ----------

test('labelsToString sorts keys and joins k=v with ", " (reference I0)', () => {
  assert.equal(labelsToString({ span_kind: 'server', service: 'a', env: 'prod' }), 'env=prod, service=a, span_kind=server')
  assert.equal(labelsToString({}), '')
  assert.equal(labelsToString(null), '')
})

test('labelsToString: __name__ sorts first, with plain code-unit order', () => {
  assert.equal(labelsToString({ service: 'a', __name__: 'count(*)' }), '__name__=count(*), service=a')
})

test('labelsToString with keys: only the keys the metric has are included', () => {
  const m = { service: 'a', span_kind: 'server', env: 'UNSET' }
  assert.equal(labelsToString(m, ['span_kind', 'service']), 'service=a, span_kind=server')
  // A missing key is omitted, not printed as "k=".
  assert.equal(labelsToString(m, ['service', 'root_name']), 'service=a')
  assert.equal(labelsToString(m, []), '')
})

// ---------- formatDelta ----------

test('formatDelta: percentages up and down', () => {
  assert.deepEqual(formatDelta(118, 100), { text: '↑18%', dir: 'up', ratio: 1.18 })
  assert.equal(formatDelta(65, 100).text, '↓35%')
  assert.equal(formatDelta(65, 100).dir, 'down')
  // Under 10% keeps a decimal, so a small move is not rounded into "flat".
  assert.equal(formatDelta(104.4, 100).text, '↑4.4%')
  assert.equal(formatDelta(102, 100).text, '↑2%')
})

test('formatDelta: a ratio of 2 or more reads as a multiple', () => {
  // The incident: payment p90 612 ms against 140 ms.
  assert.equal(formatDelta(0.612, 0.14).text, '↑4.4×')
  assert.equal(formatDelta(200, 100).text, '↑2×')
  assert.equal(formatDelta(1500, 100).text, '↑15×')
  assert.equal(formatDelta(0.612, 0.14).dir, 'up')
})

test('formatDelta: new, unknown and flat', () => {
  assert.equal(formatDelta(5, 0).text, 'new')
  assert.equal(formatDelta(5, NaN).text, 'new')
  assert.equal(formatDelta(5, undefined).dir, 'new')
  assert.equal(formatDelta(5, 0).ratio, Infinity)
  assert.equal(formatDelta(0, 0).text, '—')
  assert.equal(formatDelta(NaN, NaN).dir, 'none')
  assert.equal(formatDelta(NaN, 5).text, '—')
  assert.deepEqual(formatDelta(100, 100), { text: '0%', dir: 'flat', ratio: 1 })
  // Dropping to zero is a real change, not "unknown".
  assert.equal(formatDelta(0, 100).text, '↓100%')
})

// ---------- reduceValues ----------

const pts = (...ys) => ys.map((y, i) => ({ x: i * 60000, y }))

test('reduceValues: last, avg over present points, sum of samples', () => {
  assert.equal(reduceValues(pts(1, 2, 6), 'last'), 6)
  assert.equal(reduceValues(pts(1, 2, 6), 'avg'), 3)
  assert.equal(reduceValues(pts(1, 2, 6), 'sum'), 9)
})

test('reduceValues: gaps and non-finite points are skipped, not zero-filled', () => {
  assert.equal(reduceValues(pts(2, NaN, 4, Infinity), 'avg'), 3)
  assert.equal(reduceValues(pts(2, NaN), 'last'), 2)
})

test('reduceValues: an empty series is NaN for last/avg and 0 for sum', () => {
  assert.ok(Number.isNaN(reduceValues([], 'last')))
  assert.ok(Number.isNaN(reduceValues([], 'avg')))
  assert.equal(reduceValues([], 'sum'), 0)
})

test('reduceValues: any other formula throws "Unsupported formula"', () => {
  assert.throws(() => reduceValues(pts(1), 'max'), { message: 'Unsupported formula' })
})

// ---------- formatLocal ----------

test('formatLocal renders local-time patterns', () => {
  const ms = new Date(2026, 9, 1, 14, 5, 9).getTime()
  assert.equal(formatLocal(ms, 'MMM DD, HH:mm:ss'), 'Oct 01, 14:05:09')
  assert.equal(formatLocal(ms, 'yyyy-MM-dd HH:mm:ss'), '2026-10-01 14:05:09')
  assert.equal(formatLocal(ms, 'yyyyMMdd_HHmmss'), '20261001_140509')
  assert.equal(formatLocal(NaN, 'HH:mm'), '')
})
