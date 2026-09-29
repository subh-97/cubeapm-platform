// Grouped-query evaluation. The point of parentheses is that they change the
// result — these tests pin the cases where a grouped tree and the equivalent
// flat chip list disagree.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyChipsToLog, chipsToString } from './QueryBuilder.jsx'
import { newGroup } from '../utils/queryTree.js'

const log = (service, level) => ({ service, level, message: '', tags: {} })

const lvl = (v, connector) => (
  connector ? { field: 'log.level', op: 'eq', value: v, connector } : { field: 'log.level', op: 'eq', value: v }
)
const svc = (v, connector) => (
  connector ? { field: 'service', op: 'eq', value: v, connector } : { field: 'service', op: 'eq', value: v }
)

// (service:order OR service:payment) AND (log.level:error OR log.level:warn)
const GROUPED = [
  newGroup([svc('order'), svc('payment', 'OR')]),
  newGroup([lvl('error'), lvl('warn', 'OR')], 'AND'),
]

// The same four chips laid out flat — what the builder could express before.
const FLAT = [svc('order'), svc('payment', 'OR'), lvl('error', 'AND'), lvl('warn', 'OR')]

test('grouped query matches only the intended combinations', () => {
  assert.equal(applyChipsToLog(log('order', 'error'), GROUPED), true)
  assert.equal(applyChipsToLog(log('payment', 'warn'), GROUPED), true)
  assert.equal(applyChipsToLog(log('order', 'info'), GROUPED), false)
  assert.equal(applyChipsToLog(log('cart', 'error'), GROUPED), false)
})

test('the flat form leaks — which is the bug grouping fixes', () => {
  // Flat evaluates ((order OR payment) AND error) OR warn, so a warn from a
  // service the user never listed still matches.
  const stray = log('cart', 'warn')
  assert.equal(applyChipsToLog(stray, FLAT), true)
  assert.equal(applyChipsToLog(stray, GROUPED), false)
})

test('empty groups and empty lists are neutral', () => {
  assert.equal(applyChipsToLog(log('order', 'error'), []), true)
  assert.equal(applyChipsToLog(log('order', 'error'), [newGroup([])]), true)
})

test('nesting evaluates innermost first', () => {
  // ((error OR warn) AND service:order) OR service:payment
  const nodes = [
    newGroup([
      newGroup([lvl('error'), lvl('warn', 'OR')]),
      svc('order', 'AND'),
    ]),
    svc('payment', 'OR'),
  ]
  assert.equal(applyChipsToLog(log('order', 'error'), nodes), true)
  assert.equal(applyChipsToLog(log('payment', 'info'), nodes), true)
  assert.equal(applyChipsToLog(log('order', 'info'), nodes), false)
  assert.equal(applyChipsToLog(log('cart', 'error'), nodes), false)
})

test('serialization brackets groups and keeps stream promotion for leading chips', () => {
  // `service` is stream-eligible, so the leading group must NOT be promoted
  // into a {} block — only bare leading chips can be.
  assert.equal(
    chipsToString(GROUPED),
    '(service:=order OR service:=payment) AND (log.level:=error OR log.level:=warn)',
  )
  // A bare leading service chip still promotes, with the group left alone.
  assert.equal(
    chipsToString([svc('order'), newGroup([lvl('error'), lvl('warn', 'OR')], 'AND')]),
    '{service="order"} (log.level:=error OR log.level:=warn)',
  )
})

// The three free-text readings are a narrowness ladder: exact phrase, then
// starting-with, then anywhere. These pin the rungs apart — the reported bug
// was that the narrowest one matched everything the widest one did.
const msg = (message) => ({ service: 'x', level: 'info', message, tags: {} })
const ft = (op, value) => [{ field: '_msg', op, value }]

test('a phrase matches whole words, not fragments of them', () => {
  assert.equal(applyChipsToLog(msg('proces failed'), ft('phrase', 'proces')), true)
  // The bug: "processing" contains "proces", but it is not the word "proces".
  assert.equal(applyChipsToLog(msg('processing order'), ft('phrase', 'proces')), false)
  assert.equal(applyChipsToLog(msg('PROCES failed'), ft('phrase', 'proces')), true)
})

test('a multi-word phrase needs the words consecutive and in order', () => {
  const q = ft('phrase', 'connection refused')
  assert.equal(applyChipsToLog(msg('got connection refused here'), q), true)
  assert.equal(applyChipsToLog(msg('refused connection'), q), false)
  assert.equal(applyChipsToLog(msg('connection was refused'), q), false)
})

test('starting-with matches a word prefix anywhere in the message', () => {
  assert.equal(applyChipsToLog(msg('order processing failed'), ft('prefix', 'proces')), true)
  assert.equal(applyChipsToLog(msg('order reprocessing failed'), ft('prefix', 'proces')), false)
})

test('starting-with still anchors a single-token field value', () => {
  const status = { service: 'x', level: 'info', message: '', tags: { 'http.status': '503' } }
  assert.equal(applyChipsToLog(status, [{ field: 'http.status', op: 'prefix', value: '5' }]), true)
  assert.equal(applyChipsToLog(status, [{ field: 'http.status', op: 'prefix', value: '4' }]), false)
})

test('containing still matches inside a word — that is what it is for', () => {
  assert.equal(applyChipsToLog(msg('processing order'), ft('contains', 'proces')), true)
  assert.equal(applyChipsToLog(msg('reprocessing'), ft('contains', 'process')), true)
})
