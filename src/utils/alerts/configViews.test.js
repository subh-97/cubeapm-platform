// The configuration tabs' readings (configViews.js; docs/alerts/DESIGN.md D9,
// D10), against the real seed: who uses each contact point and schedule, which
// destination is failing, whether a schedule holds at its exact edges and in
// other timezones, and which snoozes the list shows.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { alertsSeed, ruleDefsFor, lastDeliveries, ALERTS_NOW } from '@/data/alerts'
import { alertsFor } from './store'
import {
  usageByContactPoint, usageBySchedule, deliveryHealth, sortContactPoints, scheduleWords, scheduleState,
  contactPointIssues, scheduleIssues, contactPointDraft, scheduleDraft, snoozeRows, dayClock,
} from './configViews'
import { newDestination, newMuteWindow } from './editorDraft'

const state = alertsSeed()
const defs = ruleDefsFor(state)
const { rules: views } = alertsFor(state, null)
const at = (iso) => Date.parse(iso) / 1000

test('usage counts are the rules that name the contact point or schedule, every one of them', () => {
  const contacts = usageByContactPoint(views)
  for (const g of state.receiverGroups) {
    const expected = defs.filter(d => (d.config?.receiver_group_ids ?? []).includes(g.id)).map(d => d.id).sort()
    assert.deepEqual((contacts.get(g.id) ?? []).map(r => r.id).sort(), expected, g.name)
  }
  const schedules = usageBySchedule(views)
  for (const g of state.muteGroups) {
    const expected = defs.filter(d => (d.config?.mute_group_ids ?? []).includes(g.id)).map(d => d.id).sort()
    assert.deepEqual((schedules.get(g.id) ?? []).map(r => r.id).sort(), expected, g.name)
  }
})

test('a broken webhook shows on its contact point before an incident, and its row comes first', () => {
  const deliveries = lastDeliveries(defs, state)
  const infra = deliveryHealth(deliveries.get(14))
  assert.equal(infra.status, 'ERROR')
  assert.deepEqual(infra.failing.map(d => [d.type, d.data.url]), [['webhook', 'https://hooks.internal.cubedemo.example/alerts']])
  assert.match(infra.failing[0].details, /503 Service Unavailable/)
  assert.ok(deliveries.get(14).some(d => d.type === 'opsgenie' && d.status === 'SUCCESS'), 'the other integration still delivers')
  assert.equal(deliveryHealth(deliveries.get(11)).status, 'SUCCESS')
  for (const list of deliveries.values()) for (const d of list) assert.ok(d.at <= ALERTS_NOW)
  assert.deepEqual(deliveryHealth(undefined), { status: null, at: null, failing: [] })
  const health = new Map(state.receiverGroups.map(g => [g.id, deliveryHealth(deliveries.get(g.id))]))
  const order = sortContactPoints(state.receiverGroups, usageByContactPoint(views), health)
  assert.equal(order[0].name, 'Infra paging')
})

test('a schedule reads in words, in its own timezone', () => {
  const quiet = state.muteGroups.find(g => g.name === 'Quiet hours')
  assert.deepEqual(scheduleWords(quiet), ['21:00 for 10h, every day'])
  const weekdays = { mute: { time_intervals: [{ times: [{ start_time: '09:00', duration_minutes: 90 }], weekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'], location: 'UTC' }] } }
  assert.deepEqual(scheduleWords(weekdays), ['09:00 for 1h30m, weekdays'])
})

test('"muting now" holds from the first minute to the last, and across timezones', () => {
  const quiet = state.muteGroups.find(g => g.name === 'Quiet hours')
  // Quiet hours are 21:00 to 07:00 in India.
  assert.deepEqual(scheduleState(quiet, at('2026-10-16T21:00:00+05:30')), { active: true, end: at('2026-10-17T07:00:00+05:30') })
  assert.equal(scheduleState(quiet, at('2026-10-17T06:59:59+05:30')).active, true)
  assert.deepEqual(scheduleState(quiet, at('2026-10-17T07:00:00+05:30')), { active: false, start: at('2026-10-17T21:00:00+05:30') })
  assert.equal(scheduleState(quiet, at('2026-10-16T20:59:59+05:30')).active, false)
  // The same instant, read by a schedule written in New York's time.
  const ny = { mute: { time_intervals: [{ times: [{ start_time: '11:00', duration_minutes: 60 }], weekdays: [], location: 'America/New_York' }] } }
  assert.equal(scheduleState(ny, at('2026-10-16T15:30:00Z')).active, true, '11:30 in New York, on daylight time')
  assert.equal(scheduleState(ny, at('2026-10-16T16:30:00Z')).active, false)
  assert.equal(scheduleState({ mute: { time_intervals: [] } }, ALERTS_NOW), null)
})

test('a drawer says what it still needs, field by field', () => {
  const taken = ['Payments on-call', 'Infra paging']
  assert.deepEqual(contactPointIssues({ name: ' ', destinations: [] }, taken), [
    { field: 'name', message: 'Name it.' },
    { field: 'destinations', message: 'Add at least one integration.' },
  ])
  assert.deepEqual(contactPointIssues({ name: 'payments ON-CALL', destinations: [newDestination('slack')] }, taken), [
    { field: 'name', message: 'Another one is already called "payments ON-CALL".' },
    { field: 'destination-0', message: 'Pick a Slack channel.' },
  ])
  const quiet = state.muteGroups.find(g => g.name === 'Quiet hours')
  assert.deepEqual(contactPointIssues(contactPointDraft(state.receiverGroups[1]), taken.slice(1)), [])
  assert.deepEqual(scheduleIssues(scheduleDraft(quiet), []), [])
  assert.deepEqual(scheduleIssues({ name: 'Nights', windows: [newMuteWindow('UTC')] }, []), [{ field: 'mute-0', message: 'Set a start time (HH:MM).' }])
})

test('the snooze list holds every snooze in force or to come, the ones holding now first', () => {
  const rows = snoozeRows(views)
  assert.deepEqual(rows.map(r => [r.rule.id, r.snooze.scheduled]), [[507, false], [510, true]])
  assert.ok(rows.every(r => r.snooze.silenceId && r.view.id === r.rule.id))
  assert.equal(rows.some(r => r.rule.id === 508), false, 'an ended snooze is history, not listed')
})

test('an instant reads next to now, in the viewer\'s own day', () => {
  const now = new Date(2026, 9, 16, 21, 30).getTime() / 1000
  const local = (d, h, m) => new Date(2026, 9, d, h, m).getTime() / 1000
  assert.equal(dayClock(local(16, 23, 5), now), 'today 23:05')
  assert.equal(dayClock(local(17, 7, 0), now), 'tomorrow 07:00')
  assert.equal(dayClock(local(15, 23, 40), now), 'yesterday 23:40')
  assert.equal(dayClock(local(20, 2, 15), now), 'Tue 02:15')
  assert.equal(dayClock(local(24, 2, 15), now), 'Oct 24 02:15')
})
