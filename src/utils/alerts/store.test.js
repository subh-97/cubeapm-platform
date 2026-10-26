// The Alerts store (docs/alerts/DESIGN.md D15, D16; signed off as Q9). Risks:
// an edit that does not survive a reload, a reload that freezes the seed's
// relative times, an Undo that restores the wrong thing, and a deletion that
// strands rules (a contact point still in use).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAlertsStore, applyOverlay, alertsFor } from './store.js'
import { alertsSeed, SEED_VERSION, ALERTS_NOW } from '@/data/alerts'
import { resolveWindow } from '@/data/timeWindow'

const memoryStorage = () => {
  const m = new Map()
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), raw: m }
}
const rule = (store, id) => store.getState().rules.find(r => r.id === id)

test('an overlay replaces, removes and adds by id, keeping seed order', () => {
  const seed = { rules: [{ id: 1, n: 'a' }, { id: 2, n: 'b' }, { id: 3, n: 'c' }], receiverGroups: [], muteGroups: [], silences: [] }
  const out = applyOverlay(seed, { rules: { 2: null, 1: { id: 1, n: 'A' }, 9: { id: 9, n: 'new' } } })
  assert.deepEqual(out.rules.map(r => r.n), ['A', 'c', 'new'])
})

test('pause and resume, each with an Undo that puts back exactly what was there', () => {
  const store = createAlertsStore({ storage: memoryStorage() })
  const undo = store.actions.pause(501)
  assert.equal(rule(store, 501).status, 'PAUSED')
  assert.equal(store.actions.pause(501), null, 'pausing a paused rule changes nothing')
  undo()
  assert.equal(rule(store, 501).status, 'ACTIVE')
  assert.equal(store.actions.resume(9011), null, 'an SLO\'s rule is not stored here')
})

test('only edits are saved, so a reload keeps them and rebuilds the seed\'s relative times', () => {
  const storage = memoryStorage()
  const first = createAlertsStore({ storage })
  first.actions.pause(502)
  const saved = JSON.parse(storage.getItem('cubeapm.alerts.edits'))
  assert.equal(saved.version, SEED_VERSION)
  assert.deepEqual(Object.keys(saved.overlay.rules), ['502'])
  assert.deepEqual(saved.overlay.silences, {}, 'the seed\'s snoozes are not frozen into storage')
  const second = createAlertsStore({ storage })
  assert.equal(rule(second, 502).status, 'PAUSED')
  assert.equal(second.getState().silences.length, alertsSeed().silences.length)
})

test('edits made against an older seed are dropped, not mixed in', () => {
  const storage = memoryStorage()
  storage.setItem('cubeapm.alerts.edits', JSON.stringify({ version: 'alerts-seed-0', overlay: { rules: { 501: null } } }))
  assert.ok(rule(createAlertsStore({ storage }), 501))
  storage.setItem('cubeapm.alerts.edits', '{not json')
  assert.ok(rule(createAlertsStore({ storage }), 501), 'and so is garbage')
})

test('storage that throws keeps edits for the session and breaks nothing', () => {
  const throwing = { getItem() { throw new Error('denied') }, setItem() { throw new Error('quota') } }
  const store = createAlertsStore({ storage: throwing })
  store.actions.pause(501)
  assert.equal(rule(store, 501).status, 'PAUSED')
})

test('a preset snooze starts on the minute and lasts what it says; Custom keeps its reason', () => {
  const store = createAlertsStore({ storage: memoryStorage(), now: () => 1_000_030 })
  store.actions.snooze(501, 30)
  const s = store.getState().silences.at(-1)
  assert.equal(Date.parse(s.startsAt) / 1000, 1_000_020, 'floored to the minute, as production does')
  assert.equal(Date.parse(s.endsAt) / 1000, 1_000_020 + 1800)
  assert.deepEqual(s.matchers, [{ name: 'rule_id', value: '501', isEqual: true, isRegex: false }])
  assert.equal(s.createdBy, 'you')
  store.actions.snooze(9011, { start: 1_100_000, end: 1_103_600, comment: 'Planned failover' })
  const later = store.getState().silences.at(-1)
  assert.equal(later.comment, 'Planned failover')
  assert.equal(later.status.state, 'pending', 'a snooze can be scheduled')
  assert.equal(store.actions.snooze(501, { start: 10, end: 5 }), null, 'one that ends before it starts is refused')
})

test('ending a snooze in force expires it now, keeping its history; ending a scheduled one removes it', () => {
  const store = createAlertsStore({ storage: memoryStorage(), now: () => ALERTS_NOW })
  const active = store.getState().silences.find(s => s.matchers[0].value === '507')
  const undo = store.actions.unsnooze(active.id)
  const after = store.getState().silences.find(s => s.id === active.id)
  assert.equal(Date.parse(after.endsAt) / 1000, ALERTS_NOW)
  assert.equal(after.status.state, 'expired')
  undo()
  assert.equal(store.getState().silences.find(s => s.id === active.id).endsAt, active.endsAt)
  const scheduled = store.getState().silences.find(s => s.matchers[0].value === '510')
  store.actions.unsnooze(scheduled.id)
  assert.equal(store.getState().silences.find(s => s.id === scheduled.id), undefined)
  const expired = store.getState().silences.find(s => s.matchers[0].value === '508')
  assert.equal(store.actions.unsnooze(expired.id), null, 'nothing to end')
})

test('a deleted rule comes back with Undo; a saved new rule gets the next id and no evaluated state', () => {
  const store = createAlertsStore({ storage: memoryStorage() })
  const undo = store.actions.remove(509)
  assert.equal(rule(store, 509), undefined)
  undo()
  assert.ok(rule(store, 509))
  const { rule: made } = store.actions.saveRule({ ...rule(store, 501), id: null, name: 'Copy of payment-service error rate', state: 'firing', alerts: [], seriesCount: 1 })
  assert.equal(made.id, 1001)
  assert.ok(!('state' in made) && !('alerts' in made) && !('seriesCount' in made))
  assert.equal(rule(store, 1001).name, 'Copy of payment-service error rate')
  const { rule: edited } = store.actions.saveRule({ ...rule(store, 501), name: 'renamed' })
  assert.equal(edited.id, 501)
  assert.equal(rule(store, 501).name, 'renamed')
})

test('a contact point or mute schedule still in use cannot be deleted', () => {
  const store = createAlertsStore({ storage: memoryStorage() })
  assert.equal(store.actions.removeReceiverGroup(7), null, 'rule 437 sends to it')
  store.actions.remove(437)
  assert.ok(store.actions.removeReceiverGroup(7))
  assert.equal(store.actions.removeMuteGroup(2), null, 'rule 509 is muted by it')
  const { group } = store.actions.saveMuteGroup({ id: null, name: 'Weekends', mute: { time_intervals: [] } })
  assert.ok(group.id > 100)
  assert.ok(store.actions.removeMuteGroup(group.id))
})

test('subscribers hear every change, and the state is the same object until one happens', () => {
  const store = createAlertsStore({ storage: memoryStorage() })
  let heard = 0
  const off = store.subscribe(() => heard++)
  const before = store.getState()
  assert.equal(store.getState(), before)
  store.actions.pause(501)
  assert.notEqual(store.getState(), before)
  store.refresh()
  assert.equal(heard, 2)
  off()
  store.actions.resume(501)
  assert.equal(heard, 2)
})

test('reset forgets every edit', () => {
  const storage = memoryStorage()
  const store = createAlertsStore({ storage })
  store.actions.pause(501)
  store.actions.reset()
  assert.equal(rule(store, 501).status, 'ACTIVE')
  assert.deepEqual(JSON.parse(storage.getItem('cubeapm.alerts.edits')).overlay.rules, {})
})

test('what the pages read: views worst first, by id, and the window\'s history only when there is a window', () => {
  const store = createAlertsStore({ storage: memoryStorage() })
  const win = resolveWindow({ kind: 'preset', value: '1h' })
  const a = alertsFor(store.getState(), win)
  assert.equal(a.rules[0].stateKey, 'critical')
  assert.equal(a.byId(501).name, 'payment-service error rate')
  assert.equal(a.byId('501').id, 501, 'an id from the URL is a string')
  assert.equal(a.byId(424242), null)
  assert.ok(a.timeline.length && a.log.length && a.stats.length)
  assert.equal(a.updatedAt, ALERTS_NOW)
  const series = a.seriesFor('502')
  assert.equal(series.length, 1)
  assert.equal(series[0].points.length, win.buckets.length)
  assert.equal(a.seriesFor(502), series, 'memoised per rule')
  const [s502] = series
  assert.equal(s502.previousPoints.length, s502.points.length, 'the previous period on the same buckets')
  assert.deepEqual(s502.previousPoints.map(p => p.t), s502.points.map(p => p.t))
  assert.ok(s502.previous > 100 && s502.previous < 160, `an hour ago, before the incident: ${s502.previous} ms`)
  assert.ok(s502.points.at(-1).value > 450, 'now, in it')
  assert.deepEqual(a.seriesFor(424242), [])
  const b = alertsFor(store.getState())
  assert.deepEqual([b.timeline, b.log, b.stats, b.seriesFor(502)], [[], [], [], []])
  assert.ok(b.lookups.slackChannels.length && b.lookups.jiraProjects.length)
})
