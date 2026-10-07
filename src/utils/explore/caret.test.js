// The cursor arithmetic both completers stand on.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  tokenIndexAt, prevSignificant, nextSignificant, lastSignificantBefore,
  wordRange, rankMatches, toValueRows, unquote, isQuoted,
} from './caret.js'

// `sum( rate )` as a lexer would hand it over.
const TOKENS = [
  { type: 'aggregation', value: 'sum', start: 0, end: 3 },
  { type: 'paren', value: '(', start: 3, end: 4 },
  { type: 'whitespace', value: ' ', start: 4, end: 5 },
  { type: 'function', value: 'rate', start: 5, end: 9 },
  { type: 'whitespace', value: ' ', start: 9, end: 10 },
  { type: 'paren', value: ')', start: 10, end: 11 },
]

const WORDY = new Set(['aggregation', 'function'])

test('a caret on a boundary belongs to the token on its left', () => {
  assert.equal(tokenIndexAt(TOKENS, 3), 0)   // end of `sum`
  assert.equal(tokenIndexAt(TOKENS, 4), 1)   // end of `(`
  assert.equal(tokenIndexAt(TOKENS, 7), 3)   // middle of `rate`
})

test('offset 0 is inside nothing', () => {
  assert.equal(tokenIndexAt(TOKENS, 0), -1)
  assert.equal(tokenIndexAt([], 5), -1)
})

test('looking around steps over whitespace', () => {
  assert.equal(prevSignificant(TOKENS, 3), 1)
  assert.equal(prevSignificant(TOKENS, 0), -1)
  assert.equal(nextSignificant(TOKENS, 3), 5)
  assert.equal(nextSignificant(TOKENS, 5), -1)
})

test('lastSignificantBefore ignores a token the offset lands inside', () => {
  // Offset 5 is the start of `rate`, so `(` is what comes before it.
  assert.equal(lastSignificantBefore(TOKENS, 5), 1)
  // Offset 9 is the end of `rate`, which therefore counts.
  assert.equal(lastSignificantBefore(TOKENS, 9), 3)
  assert.equal(lastSignificantBefore(TOKENS, 0), -1)
})

test('a word-like token is replaced whole; the fragment is only what was typed', () => {
  assert.deepEqual(wordRange(TOKENS, 7, WORDY), { index: 3, from: 5, to: 9, fragment: 'ra' })
})

test('anywhere else a completion is an insertion at the caret', () => {
  for (const caret of [0, 4, 10]) {
    assert.deepEqual(wordRange(TOKENS, caret, WORDY), { index: -1, from: caret, to: caret, fragment: '' })
  }
})

test('ranking lifts prefix matches and otherwise keeps catalog order', () => {
  const items = [{ label: 'count_uniq' }, { label: 'avg' }, { label: 'count' }, { label: 'discount' }]
  assert.deepEqual(rankMatches(items, 'coun').map(i => i.label), ['count_uniq', 'count', 'discount'])
  assert.deepEqual(rankMatches(items, '').map(i => i.label), items.map(i => i.label))
  assert.deepEqual(rankMatches(items, 'zzz'), [])
})

test('ranking is case-insensitive and can read any key', () => {
  const items = [{ v: 'Order-Service' }, { v: 'payment' }]
  assert.deepEqual(rankMatches(items, 'ORDER', i => i.v), [{ v: 'Order-Service' }])
})

test('a metadata answer normalises whichever shape it arrived in', () => {
  assert.deepEqual(toValueRows(['a', 'b']), [{ value: 'a', hits: undefined }, { value: 'b', hits: undefined }])
  assert.deepEqual(toValueRows([{ value: 'a', hits: 3 }]), [{ value: 'a', hits: 3 }])
  assert.deepEqual(toValueRows([null, 'a']), [{ value: 'a', hits: undefined }])
  assert.deepEqual(toValueRows(undefined), [])
})

test('unquote undoes a quoted token, half-typed ones included', () => {
  assert.equal(unquote('"log.level"'), 'log.level')
  assert.equal(unquote('"a\\"b"'), 'a"b')
  assert.equal(unquote('`raw\\n`'), 'raw\\n')
  assert.equal(unquote('"half'), 'half')
  assert.equal(unquote('bare'), 'bare')
  assert.equal(unquote('"'), '')
})

test('isQuoted reads the opening character only', () => {
  assert.ok(isQuoted('"half'))
  assert.ok(isQuoted("'x'"))
  assert.ok(isQuoted('`x`'))
  assert.ok(!isQuoted('bare'))
  assert.ok(!isQuoted(''))
})
