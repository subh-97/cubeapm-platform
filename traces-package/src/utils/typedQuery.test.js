// Typing query syntax directly into the builder.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  splitField, matchOperator, deriveOp, parseListValue,
  isCommittable, buildChip, interpret, isKnownField,
} from './typedQuery.js'

const FIELDS = ['service', 'log.level', 'env', 'path', 'http.status', 'trace_id', '_msg']
const I = (t) => interpret(t, FIELDS)

// ---------- The safety rule ----------

test('only an exact field name counts', () => {
  assert.equal(isKnownField('service', FIELDS), true)
  assert.equal(isKnownField('servic', FIELDS), false)
  assert.equal(isKnownField('Service', FIELDS), false)
  assert.equal(isKnownField('', FIELDS), false)
})

test('a bare field name is still free text', () => {
  // `service` is a plausible thing to grep the log body for.
  assert.equal(I('service').kind, 'freetext')
  assert.equal(I('service').label, 'free text')
})

test('a colon after a non-field never starts a filter', () => {
  assert.equal(I('GET /v1: timeout').kind, 'freetext')
  assert.equal(I('errors: 500').kind, 'freetext')
  assert.equal(splitField('nonsense:value', FIELDS), null)
})

test('splitField peels a known field off the front', () => {
  assert.deepEqual(splitField('service:=order', FIELDS), { field: 'service', rest: ':=order' })
  assert.deepEqual(splitField('log.level:error', FIELDS), { field: 'log.level', rest: ':error' })
})

// ---------- Operators ----------

test('longest operator symbol wins', () => {
  assert.equal(matchOperator(':=order').op, 'eq')
  assert.equal(matchOperator(':order').op, 'word')
  assert.equal(matchOperator('!=order').op, 'neq')
  assert.equal(matchOperator(':~"^p"').op, 'regex')
  assert.equal(matchOperator('!~"^p"').op, 'nregex')
  assert.equal(matchOperator(':"a b"').op, 'phrase')
  assert.equal(matchOperator(':""').op, 'empty')
  assert.equal(matchOperator(' in ("a")').op, 'in')
  assert.equal(matchOperator(' not_in ("a")').op, 'not_in')
})

test(':* is exists alone but contains with more after it', () => {
  assert.equal(matchOperator(':*').op, 'exists')
  assert.equal(matchOperator(':*pay*').op, 'contains')
})

test('asterisks in the value decide word vs prefix vs contains', () => {
  assert.deepEqual(deriveOp('word', 'order'), { op: 'word', value: 'order' })
  assert.deepEqual(deriveOp('word', 'pay*'), { op: 'prefix', value: 'pay' })
  assert.deepEqual(deriveOp('word', '*pay*'), { op: 'contains', value: 'pay' })
  // A lone star is not a decoration to strip.
  assert.deepEqual(deriveOp('word', '*'), { op: 'word', value: '*' })
})

// ---------- Commit timing ----------

test('a space inside quotes does not commit', () => {
  assert.equal(isCommittable('phrase', '"connection'), false)
  assert.equal(isCommittable('phrase', '"connection refused"'), true)
  assert.equal(isCommittable('regex', '"^/api'), false)
  assert.equal(isCommittable('regex', '"^/api"'), true)
})

test('a space inside an unclosed list does not commit', () => {
  assert.equal(isCommittable('in', '"order",'), false)
  assert.equal(isCommittable('in', '"order", "payment")'), true)
})

test('valueless operators commit immediately', () => {
  assert.equal(isCommittable('exists', ''), true)
  assert.equal(isCommittable('empty', ''), true)
})

test('contains needs its closing star', () => {
  assert.equal(isCommittable('contains', 'pay'), false)
  assert.equal(isCommittable('contains', 'pay*'), true)
})

// ---------- Chip building ----------

test('buildChip produces the same shape the click flow does', () => {
  // Values here are what matchOperator hands back — the operator symbol
  // (including any opening quote) has already been consumed off the front.
  assert.deepEqual(buildChip('eq', 'order'), { op: 'eq', value: 'order' })
  assert.deepEqual(buildChip('word', 'pay*'), { op: 'prefix', value: 'pay' })
  assert.deepEqual(buildChip('contains', 'pay*'), { op: 'contains', value: 'pay' })
  assert.deepEqual(buildChip('phrase', 'connection refused"'), { op: 'phrase', value: 'connection refused' })
  assert.deepEqual(buildChip('regex', '^/api"'), { op: 'regex', value: '^/api' })
  assert.deepEqual(buildChip('exists', ''), { op: 'exists', value: '' })
  assert.deepEqual(buildChip('in', '"order", "payment")'), { op: 'in', value: ['order', 'payment'] })
})

test('matchOperator and buildChip compose', () => {
  // The contract that actually matters: what matchOperator emits, buildChip eats.
  for (const [text, want] of [
    [':"connection refused"', { op: 'phrase', value: 'connection refused' }],
    [':~"^/api"', { op: 'regex', value: '^/api' }],
    ['!~"^/health"', { op: 'nregex', value: '^/health' }],
    [':*pay*', { op: 'contains', value: 'pay' }],
    [':5*', { op: 'prefix', value: '5' }],
  ]) {
    const m = matchOperator(text)
    assert.deepEqual(buildChip(m.op, m.rest), want, text)
  }
})

test('buildChip refuses an incomplete term', () => {
  assert.equal(buildChip('eq', ''), null)
  assert.equal(buildChip('phrase', 'connection'), null)
  assert.equal(buildChip('in', '"order"'), null)
})

test('list values tolerate loose spacing and bare words', () => {
  assert.deepEqual(parseListValue('"order", "payment"'), ['order', 'payment'])
  assert.deepEqual(parseListValue('order,payment'), ['order', 'payment'])
  assert.deepEqual(parseListValue(''), [])
})

// ---------- End-to-end interpretation ----------

test('interpret walks a term from field to complete', () => {
  assert.equal(I('').kind, 'empty')
  assert.equal(I('serv').kind, 'freetext')        // not a field yet
  assert.equal(I('service').kind, 'freetext')     // bare field is free text
  assert.equal(I('service:').kind, 'partial')     // operator known, no value
  assert.equal(I('service:=').kind, 'partial')
  assert.equal(I('service:=order').kind, 'complete')
})

test('interpret reports the right chip for each operator', () => {
  assert.deepEqual(I('service:=order'), { kind: 'complete', label: 'field filter', field: 'service', op: 'eq', value: 'order' })
  assert.deepEqual(I('path:*pay*'),     { kind: 'complete', label: 'field filter', field: 'path', op: 'contains', value: 'pay' })
  assert.deepEqual(I('http.status:5*'), { kind: 'complete', label: 'field filter', field: 'http.status', op: 'prefix', value: '5' })
  assert.deepEqual(I('path:*'),         { kind: 'complete', label: 'field filter', field: 'path', op: 'exists', value: '' })
  assert.deepEqual(I('path:""'),        { kind: 'complete', label: 'field filter', field: 'path', op: 'empty', value: '' })
  assert.deepEqual(I('log.level:error'),{ kind: 'complete', label: 'field filter', field: 'log.level', op: 'word', value: 'error' })
})

test('interpret labels free text and field filters distinctly', () => {
  assert.equal(I('connection refused').label, 'free text')
  assert.equal(I('service:=order').label, 'field filter')
  assert.equal(I('service:').label, 'field filter')
})

test('a phrase keeps its internal spaces', () => {
  assert.equal(I('_msg:"connection refused"').kind, 'complete')
  assert.equal(I('_msg:"connection refused"').value, 'connection refused')
  // Still open — a space here belongs to the phrase, not to a commit.
  assert.equal(I('_msg:"connection').kind, 'partial')
})

test('in() lists parse once the bracket closes', () => {
  assert.equal(I('service in ("order"').kind, 'partial')
  assert.deepEqual(I('service in ("order", "payment")').value, ['order', 'payment'])
})

// ---------- Operator resolution timing ----------
// The rule: resolve only when no longer operator could still extend the buffer.

import { resolveOperator } from './typedQuery.js'

test('an operator prefix stays pending until it cannot grow', () => {
  // `:` could still become `:=`, `:"`, `:~"`, `:*` or `:""`.
  assert.equal(resolveOperator(':').status, 'pending')
  assert.equal(resolveOperator(':~').status, 'pending')
  assert.equal(resolveOperator(':"').status, 'pending')
  assert.equal(resolveOperator('!').status, 'pending')
  assert.equal(resolveOperator('!~').status, 'pending')
  // Leading space could still become ` in (` or ` not_in (`.
  assert.equal(resolveOperator(' ').status, 'pending')
  assert.equal(resolveOperator(' in').status, 'pending')
})

test('an operator resolves the moment nothing can extend it', () => {
  assert.deepEqual(resolveOperator(':='),  { status: 'resolved', op: 'eq', rest: '' })
  assert.deepEqual(resolveOperator('!='),  { status: 'resolved', op: 'neq', rest: '' })
  assert.deepEqual(resolveOperator(':""'), { status: 'resolved', op: 'empty', rest: '' })
  assert.deepEqual(resolveOperator(':~"'), { status: 'resolved', op: 'regex', rest: '' })
  assert.deepEqual(resolveOperator('!~"'), { status: 'resolved', op: 'nregex', rest: '' })
  assert.deepEqual(resolveOperator(' in ('), { status: 'resolved', op: 'in', rest: '' })
  assert.deepEqual(resolveOperator(' not_in ('), { status: 'resolved', op: 'not_in', rest: '' })
})

test('a plain character after the colon settles it as word and starts the value', () => {
  assert.deepEqual(resolveOperator(':o'), { status: 'resolved', op: 'word', rest: 'o' })
  assert.deepEqual(resolveOperator(':5'), { status: 'resolved', op: 'word', rest: '5' })
})

test(':* waits, because exists and contains share the prefix', () => {
  assert.equal(resolveOperator(':*').status, 'pending')
  assert.deepEqual(resolveOperator(':*p'), { status: 'resolved', op: 'contains', rest: 'p' })
})

test('a buffer that is no operator at all is free text', () => {
  assert.equal(resolveOperator('x').status, 'none')
  assert.equal(resolveOperator('-foo').status, 'none')
})

// ---------- Connectors ----------

import { matchConnector } from './typedQuery.js'

test('AND and OR are connectors only in uppercase', () => {
  assert.equal(matchConnector('AND'), 'AND')
  assert.equal(matchConnector('OR'), 'OR')
  assert.equal(matchConnector(' OR '), 'OR')
  // Lowercase is ordinary log text — searching for "and" must stay a search.
  assert.equal(matchConnector('and'), null)
  assert.equal(matchConnector('or'), null)
  assert.equal(matchConnector('ANDROID'), null)
  assert.equal(matchConnector(''), null)
})

test('interpret labels a connector distinctly from free text', () => {
  assert.equal(I('AND').kind, 'connector')
  assert.equal(I('AND').connector, 'AND')
  assert.equal(I('OR').label, 'connector')
  assert.equal(I('and').kind, 'freetext')
})

// ---------- Free-text decoration ----------
// Quotes and stars a user types are syntax, not characters to search for.

import { deriveFreeText } from './typedQuery.js'

test('quoted free text is a phrase, not a literal pair of quotes', () => {
  assert.deepEqual(deriveFreeText('"text"'), { op: 'phrase', value: 'text', explicit: true })
  assert.deepEqual(deriveFreeText('"sedr reds"'), { op: 'phrase', value: 'sedr reds', explicit: true })
})

test('stars map to prefix and contains', () => {
  assert.deepEqual(deriveFreeText('text*'), { op: 'prefix', value: 'text', explicit: true })
  assert.deepEqual(deriveFreeText('*text*'), { op: 'contains', value: 'text', explicit: true })
})

test('undecorated text is left for the user to choose', () => {
  assert.deepEqual(deriveFreeText('text'), { op: null, value: 'text', explicit: false })
  assert.deepEqual(deriveFreeText('sedr reds'), { op: null, value: 'sedr reds', explicit: false })
})

test('half-typed decoration is not treated as syntax yet', () => {
  // Mid-keystroke states must not collapse to an empty or nonsense value.
  assert.equal(deriveFreeText('"').explicit, false)
  assert.equal(deriveFreeText('""').explicit, false)
  assert.equal(deriveFreeText('*').explicit, false)
  assert.equal(deriveFreeText('**').explicit, false)
  assert.equal(deriveFreeText('"text').explicit, false)
  // A leading star alone is not valid syntax in this grammar.
  assert.equal(deriveFreeText('*text').explicit, false)
})
