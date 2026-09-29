// The saved-query state machine: what can be saved, what a query descends
// from, and which of Save / Saved / Update is on offer.
//
// Written before the logic was lifted out of LogsView, so these assert the
// behaviour that shipped rather than the behaviour of the refactor.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chipsToString } from '@/components/QueryBuilder'
import {
  keyOf, canSave, isComposedButUnrun, findMatch, findOrigin,
  updatableFrom, noteFor, newEntry, applyEdit, removeEntry,
} from './savedQueries.js'

const S = chipsToString
const chip = (field, value, connector) => (
  connector ? { field, op: 'eq', value, connector } : { field, op: 'eq', value }
)

const ERRORS = [chip('service', 'payment'), chip('log.level', 'error', 'AND')]
const entry = (id, name, chips, pipes = []) => ({ id, name, description: '', chips, pipes })

const statsPipe = (overrides = {}) => ({
  id: 'p1', kind: 'stats', groupBy: [], functions: [], ...overrides,
})

// ---------- Identity ----------

test('a saved entry is identified by its query, not its name', () => {
  const a = entry('1', 'Payment errors', ERRORS)
  const b = entry('2', 'Something else entirely', ERRORS)
  assert.equal(keyOf(a, S), keyOf(b, S))
})

test('keyOf survives an entry with no chips or pipes', () => {
  assert.equal(keyOf({}, S), '')
  assert.equal(keyOf(undefined, S), '')
})

test('a group-by with no aggregation still has a key — the implied count is applied', () => {
  const grouped = entry('1', 'By service', [], [statsPipe({ groupBy: ['service'] })])
  // Without withImpliedCount this serializes to nothing and every grouped query
  // would collide with every other one.
  assert.match(keyOf(grouped, S), /stats by \("service"\) count\(\)/)
})

// ---------- What can be saved ----------

test('an empty bar cannot be saved', () => {
  assert.equal(canSave({ queryMode: 'builder', appliedChips: [], effectivePipes: [] }), false)
})

test('chips alone, or pipes alone, are enough to save', () => {
  assert.equal(canSave({ queryMode: 'builder', appliedChips: ERRORS, effectivePipes: [] }), true)
  assert.equal(canSave({ queryMode: 'builder', appliedChips: [], effectivePipes: [statsPipe()] }), true)
})

test('raw mode can never be saved, however full the bar', () => {
  assert.equal(canSave({ queryMode: 'raw', appliedChips: ERRORS, effectivePipes: [statsPipe()] }), false)
})

test('composed-but-unrun is distinguished from empty — they need different advice', () => {
  // Something typed but not yet run: tell them to Run.
  assert.equal(isComposedButUnrun({
    queryMode: 'builder', saveable: false, effectiveChips: ERRORS, livePipes: [],
  }), true)
  // Nothing anywhere: tell them to filter.
  assert.equal(isComposedButUnrun({
    queryMode: 'builder', saveable: false, effectiveChips: [], livePipes: [],
  }), false)
  // Already saveable: neither message applies.
  assert.equal(isComposedButUnrun({
    queryMode: 'builder', saveable: true, effectiveChips: ERRORS, livePipes: [],
  }), false)
})

// ---------- Lineage ----------

test('findMatch finds the entry whose query is on screen', () => {
  const list = [entry('1', 'Other', [chip('service', 'cart')]), entry('2', 'Errors', ERRORS)]
  assert.equal(findMatch(list, keyOf(list[1], S), S)?.id, '2')
  assert.equal(findMatch(list, 'service:nothing', S), null)
})

test('findOrigin is by id, and a null id has no origin', () => {
  const list = [entry('1', 'Errors', ERRORS)]
  assert.equal(findOrigin(list, '1')?.name, 'Errors')
  assert.equal(findOrigin(list, null), null)
  assert.equal(findOrigin(list, 'gone'), null)
})

test('Update is offered only once the query has drifted from its origin', () => {
  const origin = entry('1', 'Errors', ERRORS)
  // Still matching: Saved covers it, nothing to update.
  assert.equal(updatableFrom(origin, origin), null)
  // Edited away: now there is something to update.
  assert.equal(updatableFrom(origin, null)?.id, '1')
  // Never came from anything: nothing to update either.
  assert.equal(updatableFrom(null, null), null)
})

// ---------- The note ----------

test('the note reads the examples too, and the user\'s own saves win', () => {
  const mine = entry('1', 'My name for it', ERRORS)
  const example = { name: 'Built-in name', chips: ERRORS }
  const key = keyOf(mine, S)

  assert.equal(noteFor({ saved: [mine], examples: [example], appliedQuery: key, saveable: true, stringify: S })?.name,
    'My name for it')
  assert.equal(noteFor({ saved: [], examples: [example], appliedQuery: key, saveable: true, stringify: S })?.name,
    'Built-in name')
})

test('an unsaveable query has no note, even if something would match', () => {
  const mine = entry('1', 'Errors', ERRORS)
  assert.equal(noteFor({
    saved: [mine], examples: [], appliedQuery: keyOf(mine, S), saveable: false, stringify: S,
  }), null)
})

// ---------- Writes ----------

test('a new entry carries the query it was saved from', () => {
  const e = newEntry({ name: 'Errors', description: 'why', chips: ERRORS, pipes: [], now: 1000 })
  assert.equal(e.id, 'sq-1000')
  assert.equal(e.savedAt, 1000)
  assert.deepEqual(e.chips, ERRORS)
})

test('editing replaces the query as well as the name, and stamps updatedAt', () => {
  const list = [entry('1', 'Old', [chip('service', 'cart')])]
  const out = applyEdit(list, '1', { name: 'New', description: 'd', chips: ERRORS, pipes: [], now: 2000 })
  assert.equal(out[0].name, 'New')
  assert.deepEqual(out[0].chips, ERRORS)
  assert.equal(out[0].updatedAt, 2000)
  assert.equal(out[0].savedAt, undefined)   // untouched — only the edit is stamped
})

test('editing leaves every other entry alone', () => {
  const list = [entry('1', 'One', ERRORS), entry('2', 'Two', ERRORS)]
  const out = applyEdit(list, '2', { name: 'Renamed', description: '', chips: ERRORS, pipes: [], now: 1 })
  assert.equal(out[0].name, 'One')
  assert.equal(out[1].name, 'Renamed')
})

test('removeEntry drops one and keeps the rest', () => {
  const list = [entry('1', 'One', ERRORS), entry('2', 'Two', ERRORS)]
  assert.deepEqual(removeEntry(list, '1').map(q => q.id), ['2'])
  assert.deepEqual(removeEntry(list, 'missing').map(q => q.id), ['1', '2'])
})
