// The Explore table search (reference SearchQL, results-area.md §7.6): the
// worked examples, precedence, the trailing-token recovery, matching and
// autocomplete.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  tokenizeSearch, parseSearch, matchSearch, filterRows, fieldName, segmentSearch, suggestSearch,
} from './searchQuery.js'

const row = (label) => ({ key: JSON.stringify([label]), label, labels: [label] })
const ALL = [
  row('service=shipment-service, span_kind=server'),
  row('service=shipment-service, span_kind=client'),
  row('service=order-service, span_kind=server'),
  row('service=payment-service, span_kind=server'),
]
const BY_SERVICE = ['shipment-service', 'order-service', 'payment-service', 'notify-service'].map(row)
const run = (rows, q) => filterRows(rows, q).map(r => r.label)

// ---------- lexer ----------

test('tokens follow the reference lexer, first rule wins', () => {
  const types = (s) => tokenizeSearch(s).filter(t => t.type !== 'ws').map(t => t.type)
  assert.deepEqual(types('label:="x y"'), ['ident', 'colon', 'eq', 'string'])
  assert.deepEqual(types('a and b OR not c'), ['literal', 'and', 'literal', 'or', 'not', 'literal'])
  // Only the exact spellings are keywords.
  assert.deepEqual(types('And'), ['literal'])
  assert.deepEqual(types('label :x'), ['ident', 'colon', 'literal'])
  assert.deepEqual(types('(a)'), ['lparen', 'literal', 'rparen'])
  // A word shaped like an object key is just a word.
  assert.deepEqual(types('constructor'), ['literal'])
})

test('the lexer never throws: unknown characters and open quotes are error tokens', () => {
  assert.deepEqual(tokenizeSearch('a,b').map(t => t.type), ['literal', 'error', 'literal'])
  const open = tokenizeSearch('label:"ship')
  assert.equal(open[open.length - 1].type, 'error')
  assert.equal(open[open.length - 1].value, '"ship')
  const toks = tokenizeSearch('ab  cd')
  assert.deepEqual(toks.map(t => [t.start, t.end]), [[0, 2], [2, 4], [4, 6]])
})

// ---------- parser ----------

test('precedence: or < and (explicit or implicit) < not', () => {
  assert.deepEqual(parseSearch('a or b c'), {
    type: 'or', left: { type: 'term', value: 'a' },
    right: { type: 'and', left: { type: 'term', value: 'b' }, right: { type: 'term', value: 'c' } },
  })
  assert.deepEqual(parseSearch('not a b'), {
    type: 'and', left: { type: 'not', expr: { type: 'term', value: 'a' } }, right: { type: 'term', value: 'b' },
  })
  assert.deepEqual(parseSearch('label:="x"'), { type: 'comparison', field: 'label', operator: '=', value: 'x' })
  assert.deepEqual(parseSearch('label: x'), { type: 'comparison', field: 'label', operator: ':', value: 'x' })
})

test('recovery: trailing tokens are dropped until the rest parses', () => {
  assert.deepEqual(parseSearch('a and'), { type: 'term', value: 'a' })
  assert.deepEqual(parseSearch('a )'), { type: 'term', value: 'a' })
  // A dangling colon goes with its field.
  assert.deepEqual(parseSearch('foo label:'), { type: 'term', value: 'foo' })
  assert.deepEqual(parseSearch('label:x y:'), { type: 'comparison', field: 'label', operator: ':', value: 'x' })
  // Dropping the colon AND the token before it skips `label:x` itself here, so
  // nothing survives — the reference loop does exactly this.
  assert.equal(parseSearch('label:x:'), null)
})

test('inputs with nothing to salvage are no filter at all', () => {
  assert.equal(parseSearch(''), null)
  assert.equal(parseSearch('   '), null)
  assert.equal(parseSearch('label:'), null)
  assert.equal(parseSearch('(a'), null)
  assert.equal(parseSearch('not'), null)
  assert.equal(parseSearch('label:"ship'), null)   // lexer error, as in the reference
  assert.equal(parseSearch('a,b'), null)
})

test('a bare k=v term stops at the "=": only the key is searched (reference quirk)', () => {
  assert.deepEqual(parseSearch('service=order'), { type: 'term', value: 'service' })
})

// ---------- matching: the worked examples ----------

test('a bare term is a case-insensitive substring of the row', () => {
  assert.deepEqual(run(ALL, 'SHIPMENT'), [ALL[0].label, ALL[1].label])
})

test('label:x is a substring of the Label cell; and / not / or combine', () => {
  assert.deepEqual(run(ALL, 'label:shipment and not label:client'), [ALL[0].label])
  assert.deepEqual(run(BY_SERVICE, 'label:order or label:payment'), ['order-service', 'payment-service'])
  assert.deepEqual(run(BY_SERVICE, '(label:ship label:service)'), ['shipment-service'])
})

test('label:= is exact', () => {
  assert.deepEqual(run(BY_SERVICE, 'label:=shipment-service'), ['shipment-service'])
  assert.deepEqual(run(BY_SERVICE, 'label:=shipment'), [])
  assert.deepEqual(run(ALL, 'label:="service=order-service, span_kind=server"'), [ALL[2].label])
})

test('an unknown field, a tag path or a differently-cased field matches nothing', () => {
  assert.deepEqual(run(BY_SERVICE, 'service:order'), [])
  assert.deepEqual(run(BY_SERVICE, 'label.team:x'), [])
  assert.deepEqual(run(BY_SERVICE, 'Label:order'), [])
})

test('no filter keeps every row', () => {
  assert.equal(filterRows(BY_SERVICE, '').length, 4)
  assert.equal(filterRows(BY_SERVICE, '(').length, 4)
  assert.equal(matchSearch(null, BY_SERVICE[0]), true)
})

test('fieldName is the reference xL', () => {
  assert.equal(fieldName('Label'), 'label')
  assert.equal(fieldName(' Value (avg) '), 'value_avg')
})

// ---------- highlighting ----------

test('segments colour a known field with its colon, operators, strings and errors', () => {
  assert.deepEqual(segmentSearch('label:="a b" and x'), [
    { text: 'label:', type: 'field' },
    { text: '=', type: 'op' },
    { text: '"a b"', type: 'string' },
    { text: ' ', type: 'plain' },
    { text: 'and', type: 'op' },
    { text: ' x', type: 'plain' },
  ])
  assert.deepEqual(segmentSearch('foo:x').map(s => s.type), ['plain'])
  assert.equal(segmentSearch('a,').pop().type, 'error')
  assert.equal(segmentSearch('label:x (y)').map(s => s.text).join(''), 'label:x (y)')
})

// ---------- autocomplete ----------

const VALUES = ['shipment-service', 'order-service', 'payment']
const labels = (r) => r.items.map(i => i.label)

test('an empty box offers the field and every value', () => {
  const r = suggestSearch({ text: '', cursor: 0, values: VALUES })
  assert.deepEqual(labels(r), ['label:', ...VALUES])
  assert.equal(r.from, 0)
})

test('a non-empty box adds the keywords', () => {
  const r = suggestSearch({ text: 'label:x ', cursor: 8, values: VALUES })
  assert.deepEqual(labels(r), ['AND', 'OR', 'NOT', 'label:', ...VALUES])
})

test('after label: only values, quoted unless they are plain words', () => {
  const r = suggestSearch({ text: 'label:', cursor: 6, values: VALUES })
  assert.deepEqual(labels(r), VALUES)
  assert.deepEqual(r.items.map(i => i.insertText), ['"shipment-service"', '"order-service"', 'payment'])
  assert.equal(r.from, 6)
})

test('a value fragment with a hyphen is replaced whole (reference quirk fixed)', () => {
  const r = suggestSearch({ text: 'label:shipment-s', cursor: 16, values: VALUES })
  assert.deepEqual(labels(r), ['shipment-service'])
  assert.equal(r.from, 6)
  assert.equal(r.to, 16)
})

test('inside an open quote values insert raw and close the quote', () => {
  const r = suggestSearch({ text: 'label:"ord', cursor: 10, values: VALUES })
  assert.deepEqual(r.items.map(i => i.insertText), ['order-service"'])
  assert.equal(r.from, 7)
  const bare = suggestSearch({ text: 'x "pay', cursor: 6, values: VALUES })
  assert.deepEqual(bare.items.map(i => i.insertText), ['payment"'])
})

test('after ( and the boolean keywords: field and values', () => {
  assert.deepEqual(labels(suggestSearch({ text: '(', cursor: 1, values: VALUES })), ['label:', ...VALUES])
  assert.deepEqual(labels(suggestSearch({ text: 'label:x and ', cursor: 12, values: VALUES })), ['label:', ...VALUES])
  assert.deepEqual(labels(suggestSearch({ text: 'label:x AND ', cursor: 12, values: VALUES })), ['label:', ...VALUES])
})

test('an unknown field has no values to suggest', () => {
  assert.deepEqual(labels(suggestSearch({ text: 'service:', cursor: 8, values: VALUES })), [])
})

test('the typed fragment filters; a fragment that is already the only match offers nothing', () => {
  assert.deepEqual(labels(suggestSearch({ text: 'lab', cursor: 3, values: VALUES })), ['label:'])
  assert.deepEqual(labels(suggestSearch({ text: 'label:payment', cursor: 13, values: VALUES })), [])
})
