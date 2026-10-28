// The Rules tab's changes and the toasts they raise (docs/alerts/DESIGN.md
// D10, D16), run against a real store over the seed and read back the way the
// tab reads it.
//
// The risks: a toast claiming a success that did not happen (production is
// silent either way, and its failures stack as toasts, R43), and an Undo that
// does not restore exactly what was changed.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveWindow } from '@/data/timeWindow'
import { seededStore, seededAlerts } from './fixtures.js'
import { changeRule, snoozeSpan, UNAVAILABLE } from './ruleActions.js'

const hour = resolveWindow({ kind: 'preset', value: '1h' })
const now = hour.nowSec

function world() {
  const store = seededStore()
  const read = () => seededAlerts(hour, store)
  return { store, read, actions: store.actions }
}

test('pausing says what it means and hands back an undo that resumes it', () => {
  const { read, actions } = world()
  const view = read().byId(501)
  const done = changeRule(actions, view, { kind: 'pause' }, now)
  assert.equal(done.text, 'Paused payment-service error rate. It stops evaluating until it is resumed.')
  assert.equal(read().byId(501).state, 'paused')
  done.undo()
  assert.equal(read().byId(501).state, 'firing')
})

test('a change that changes nothing says so, and offers no Undo', () => {
  const { read, actions } = world()
  const paused = read().byId(427)
  const again = changeRule(actions, paused, { kind: 'pause' }, now)
  assert.equal(again.undo, null)
  assert.equal(again.text, 'Synthetic down - Marketing Site was already paused; nothing changed.')
  const slo = read().byId(9011)
  assert.equal(changeRule(actions, slo, { kind: 'remove' }, now).undo, null, 'an SLO\'s rule is the SLO\'s to remove')
})

test('a snooze holds notifications for its span, and its undo takes it away again', () => {
  const { read, actions } = world()
  const view = read().byId(501)
  const done = changeRule(actions, view, { kind: 'snooze', spec: 30 }, now)
  assert.equal(done.text, 'Snoozed payment-service error rate for 30 minutes. It keeps evaluating; its notifications are held.')
  const after = read()
  const snoozed = after.byId(501)
  assert.equal(snoozed.suppression?.kind, 'snooze')
  assert.equal(snoozed.state, 'firing', 'a snooze holds notifications, not state (D10)')
  assert.ok(after.rules.indexOf(snoozed) > after.rules.findIndex(r => r.state === 'error'), 'and it now sorts below the unsuppressed rules')
  done.undo()
  assert.equal(read().byId(501).suppression, null)
})

test('unsnoozing ends the snooze now, and undo puts it back', () => {
  const { read, actions } = world()
  const view = read().byId(507)
  const snooze = view.snoozes[0]
  const done = changeRule(actions, view, { kind: 'unsnooze', snooze }, now)
  assert.equal(done.text, 'Unsnoozed shipment-service p90 latency. Its notifications are back on.')
  assert.equal(read().byId(507).suppression, null)
  done.undo()
  assert.equal(read().byId(507).suppression?.kind, 'snooze')
})

test('deleting says its history is kept, and can be undone', () => {
  const { read, actions } = world()
  const view = read().byId(502)
  const done = changeRule(actions, view, { kind: 'remove' }, now)
  assert.equal(done.text, 'Deleted payment-service p90 latency. Its notification history is kept.')
  assert.equal(read().byId(502), null)
  done.undo()
  assert.ok(read().byId(502))
})

test('a snooze\'s span in words: a preset, a custom end, a later start', () => {
  assert.equal(snoozeSpan(5, now), 'for 5 minutes')
  assert.equal(snoozeSpan(60, now), 'for 1 hour')
  assert.match(snoozeSpan({ start: now, end: now + 7200 }, now), /^until \d\d:\d\d$/)
  assert.match(snoozeSpan({ start: now + 600, end: now + 7200 }, now), /^from \d\d:\d\d to \d\d:\d\d$/)
})

test('with no actions to run, nothing is claimed', () => {
  const view = seededAlerts(hour).byId(501)
  assert.deepEqual(changeRule(undefined, view, { kind: 'pause' }, now), { text: UNAVAILABLE, undo: null })
})
