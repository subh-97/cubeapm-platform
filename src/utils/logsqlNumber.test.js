// How LogsQL reads a value as a number, shared by Explore's evaluator and the
// Logs/Traces builder's comparison chips.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toNumber, compareValues } from './logsqlNumber.js'

test('numbers and numeric text read as themselves', () => {
  assert.equal(toNumber(500), 500)
  assert.equal(toNumber('500'), 500)
  assert.equal(toNumber(' 8.8 '), 8.8)
  assert.equal(toNumber('-5'), -5)
  assert.equal(toNumber('1e3'), 1000)
})

test('a duration reads as nanoseconds, whatever the unit', () => {
  assert.equal(toNumber('100ns'), 100)
  assert.equal(toNumber('5us'), 5000)
  assert.equal(toNumber('5µs'), 5000)
  assert.equal(toNumber('100ms'), 1e8)
  assert.equal(toNumber('1.2s'), 1.2e9)
  assert.equal(toNumber('2m'), 1.2e11)
  assert.equal(toNumber('1h30m'), 5.4e12)
  assert.equal(toNumber('1d'), 8.64e13)
  assert.equal(toNumber('-1s'), -1e9)
})

test('a duration is a whole number of nanoseconds, so a handed-over bound is exact', () => {
  // The Slow Requests histogram hands these to Traces; the span at exactly the
  // bound has to land on the side the bound says.
  for (const [text, ns] of [['8.799ms', 8799000], ['27.83ms', 27830000], ['0.1s', 1e8], ['1.1ms', 1100000], ['2.675ms', 2675000]]) {
    assert.equal(toNumber(text), ns, text)
    assert.ok(Number.isInteger(toNumber(text)), text)
  }
  assert.equal(toNumber('0.4ns'), 0)
})

test('a size reads as bytes, decimal or binary', () => {
  assert.equal(toNumber('2KB'), 2000)
  assert.equal(toNumber('1KiB'), 1024)
  assert.equal(toNumber('1.5MB'), 1.5e6)
})

test('anything else is not a number', () => {
  for (const v of ['', '   ', 'abc', '8.8 ms', '5xx', 'ms', null, undefined, {}]) {
    assert.ok(Number.isNaN(toNumber(v)), JSON.stringify(v))
  }
})

test('comparisons are numeric when both sides read as numbers', () => {
  // As text, '9' > '10'; as numbers it is not.
  assert.equal(compareValues('gt', '9', '10'), false)
  assert.equal(compareValues('lt', 9, '10'), true)
  // A nanosecond field against a duration.
  assert.equal(compareValues('gte', 8799000, '8.799ms'), true)
  assert.equal(compareValues('gte', 8798999, '8.799ms'), false)
  assert.equal(compareValues('lt', 27829999, '27.83ms'), true)
  assert.equal(compareValues('lt', 27830000, '27.83ms'), false)
  assert.equal(compareValues('lte', 27830000, '27.83ms'), true)
  assert.equal(compareValues('gt', 27830001, '27.83ms'), true)
})

test('field-agnostic: a bare number is taken as written, not as milliseconds', () => {
  assert.equal(compareValues('gt', 6, '5'), true)       // duration_ms:>5
  assert.equal(compareValues('gt', 6e6, '5'), true)     // duration:>5 is 5 ns
  assert.equal(compareValues('gt', 4e6, '5ms'), false)
})

test('comparisons fall back to text when either side is not a number', () => {
  assert.equal(compareValues('gt', 'b', 'a'), true)
  assert.equal(compareValues('lt', 'payment', 'order'), false)
  assert.equal(compareValues('gte', 'a', 'a'), true)
})
