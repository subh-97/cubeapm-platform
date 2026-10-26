// The Notifications tab's rows (notificationLog.js; docs/alerts/DESIGN.md
// D12): every row says what it was about and what became of it, a held or
// failed one says why, and production's own link filters to its rule.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveWindow } from '@/data/timeWindow'
import { alertsSeed, ruleDefsFor, notificationLogForWindow } from '@/data/alerts'
import { alertsFor } from './store'
import { logRows, filterLog, logFacets, payloadOf, ONE_OFF } from './notificationLog'

const state = alertsSeed()
const defs = ruleDefsFor(state)
const HOUR = resolveWindow({ kind: 'preset', value: '1h' })
const { rules: views } = alertsFor(state, null)
const rows = logRows(notificationLogForWindow(HOUR, defs, state), { views, receiverGroups: state.receiverGroups, lookups: state })

test('every row says which event and what became of it, and a held or failed one says why', () => {
  assert.ok(rows.length > 10)
  for (const r of rows) {
    assert.ok(['Fired', 'Reminder', 'Resolved'].includes(r.eventLabel), r.id)
    assert.ok(['Sent', 'Failed', 'Muted', 'Snoozed'].includes(r.statusLabel), r.id)
    if (r.status !== 'SUCCESS') assert.ok(r.why.length > 0, `${r.status} row ${r.id} says why`)
  }
  const failed = rows.find(r => r.status === 'ERROR')
  assert.equal(failed.contact.name, 'Infra paging')
  assert.equal(failed.integration.type, 'webhook')
  assert.equal(failed.integration.label, 'Webhook', 'named as the type list names it')
  assert.match(failed.why, /503 Service Unavailable/)
  assert.match(rows.find(r => r.status === 'SNOOZE').why, /^Snoozed by fulfilment-oncall until .*: Downstream of the payment-service incident/)
  assert.match(rows.find(r => r.status === 'MUTE').why, /^Muted by "/)
  for (const r of rows) assert.ok(r.at >= HOUR.start && r.at <= HOUR.end)
})

test('production\'s link to one rule\'s history filters to that rule, and facets combine', () => {
  const only437 = filterLog(rows, { ruleId: '437' })
  assert.ok(only437.length > 0)
  assert.ok(only437.every(r => String(r.ruleId) === '437'))
  const failedWebhooks = filterLog(rows, { facets: { status: new Set(['ERROR']), integration: ['webhook'] } })
  assert.ok(failedWebhooks.length > 0 && failedWebhooks.every(r => r.status === 'ERROR' && r.integration.type === 'webhook'))
  assert.equal(filterLog(rows, { facets: { status: ['ERROR'], integration: ['slack'] } }).length, 0)
})

test('the rail counts every value, and keeps a chosen one at 0', () => {
  const f = logFacets(rows, { status: ['SUCCESS'], contact: ['999'] })
  assert.equal(f.status.reduce((a, v) => a + v.count, 0), rows.length)
  assert.ok(f.event.some(v => v.value === 'fired'))
  assert.deepEqual(f.contact.find(v => v.value === '999'), { value: '999', label: '999', count: 0 })
  const oneOff = logRows([{ ...rows[0].row, receiver_group_id: null }], { views, receiverGroups: state.receiverGroups })
  assert.equal(filterLog(oneOff, { facets: { contact: [ONE_OFF] } }).length, 1)
})

test('an expanded row shows what the message carried', () => {
  const r = rows.find(x => x.event === 'fired')
  const p = payloadOf(r)
  assert.equal(p.status, 'firing')
  assert.equal(p.commonLabels.rule_id, String(r.ruleId))
  assert.equal(p.alerts.length, 1)
})
