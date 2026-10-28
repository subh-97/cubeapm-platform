// The rule editor's draft (editorDraft.js; docs/alerts/DESIGN.md D6–D10).
// Pinned against the real seed: every rule production's API returns opens in
// the editor and saves back unchanged, so opening Edit and pressing Save on any
// rule is a no-op. Then the decisions the editor makes that production does
// not: tiers that round-trip, a clone that shows its status, kinds that keep
// their thresholds, and a Save that says what it is waiting for.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { alertsSeed } from '@/data/alerts'
import { NEEDS_CLOSING_PIPE } from '@/data/alertsEngine'
import { buildQuickQuery, emptyPair } from '@/utils/explore/builders'
import { tiersOf } from './condition'
import {
  blankDraft, draftFromRule, draftFromPayload, draftFromSuggestion, ruleFromDraft, validateDraft, isDirty,
  setKind, setDatasource, setTab, setTier, insertLabel, needsClosingPipe, queryOf, modelOf,
  destinationsOf, receiverOf, destinationProblem, newDestination, muteWindowsOf, muteOf, muteWindowProblem, newMuteWindow,
} from './editorDraft'

const seed = alertsSeed()
const byId = new Map(seed.rules.map(r => [r.id, r]))
const filledReceivers = receiver => Object.fromEntries(Object.entries(receiver ?? {}).filter(([, v]) => v?.length))
const essentials = r => ({
  name: r.name, datasource: r.datasource, kind: r.kind, status: r.status,
  tiers: tiersOf(r), interval: r.interval, duration: r.duration, repeatInterval: r.repeatInterval,
  groupingDisable: r.groupingDisable,
  labels: Object.fromEntries(Object.entries(r.labels).filter(([k]) => k !== 'rule_id')),
  model: r.config.model ?? null, contactPoints: r.config.receiver_group_ids, mutes: r.config.mute_group_ids,
  receiver: filledReceivers(r.receiver), mute: r.mute?.time_intervals ?? [],
  summary: r.annotations?.summary ?? null, description: r.annotations?.description ?? null, runbook: r.annotations?.runbook_url ?? null,
})
const p90 = { type: 'quick', calculate: 'latency_percentile', value: '90', labelPairs: [{ label: 'service', operator: '=', values: ['payment-service'] }], groupBy: [] }

test('every seeded rule opens in the editor and saves back as it was', () => {
  for (const rule of seed.rules) {
    const saved = ruleFromDraft(draftFromRule(rule))
    assert.deepEqual(essentials(saved), essentials(rule), `${rule.id} ${rule.name}`)
    assert.equal(saved.id, rule.id)
  }
  assert.equal(ruleFromDraft(draftFromRule(byId.get(437))).query, byId.get(437).query, 'production\'s demo rule, byte for byte')
})

test('Warning, Critical or both: the tiers round-trip through what production stores', () => {
  const base = draftFromRule(byId.get(501))
  const only = (w, c) => setTier(setTier(base, 'warning', { value: w }), 'critical', { value: c })
  const warningOnly = ruleFromDraft(only('1', ''))
  assert.deepEqual([tiersOf(warningOnly).warning, tiersOf(warningOnly).critical, warningOnly.labels.severity], [{ op: '>', threshold: 1 }, null, undefined])
  const criticalOnly = ruleFromDraft(only('', '3'))
  assert.equal(criticalOnly.query2, '')
  assert.equal(criticalOnly.labels.severity, 'critical', 'a lone critical tier is the base condition, tagged')
  assert.deepEqual(tiersOf(criticalOnly).critical, { op: '>', threshold: 3 })
  const both = ruleFromDraft(only('1', '3'))
  assert.deepEqual([tiersOf(both).warning.threshold, tiersOf(both).critical.threshold, both.labels.severity], [1, 3, undefined])
})

test('a clone is a new rule called "Copy of …", and keeps the status it will be saved with', () => {
  const paused = byId.get(427)
  const clone = draftFromRule(paused, { clone: true })
  assert.equal(clone.id, null)
  assert.equal(clone.name, `Copy of ${paused.name}`)
  assert.equal(clone.status, 'PAUSED', 'production copies a paused status silently; ours carries it where it can be seen')
  assert.equal(ruleFromDraft(clone).query, ruleFromDraft(draftFromRule(paused)).query)
  const custom = { ...byId.get(501), permissions: [{ entity_type: 'team', entity_id: 'team-payments', permission: 'editor' }] }
  assert.equal(draftFromRule(custom).access.mode, 'custom')
  assert.equal(draftFromRule(custom, { clone: true }).access.mode, 'role', 'permissions are not cloned, as production\'s are not')
})

test('switching kind keeps each kind\'s thresholds, and anomaly reads Metrics only', () => {
  let d = setTier(draftFromRule(byId.get(501)), 'warning', { value: '5' })
  d = setKind(d, 'anomaly')
  assert.deepEqual(d.tiers.anomaly.warning, { op: '<>', value: '2' }, 'production opens anomaly at 2 deviations either side')
  d = setKind(setTier(d, 'warning', { op: '>', value: '3' }), 'static')
  assert.equal(d.tiers.static.warning.value, '5')
  d = setKind(d, 'anomaly')
  assert.deepEqual(d.tiers.anomaly.warning, { op: '>', value: '3' }, 'and its direction survives (R30)')
  assert.equal(setDatasource(d, 'vlogs'), d, 'an anomaly rule cannot move to Logs')
  const logs = setDatasource(blankDraft(), 'vlogs')
  assert.equal(setKind(logs, 'anomaly'), logs)
  const loaded = draftFromRule(byId.get(510))
  assert.equal(loaded.kind, 'anomaly')
  assert.deepEqual(ruleFromDraft(loaded).query, byId.get(510).query, 'loading an anomaly rule does not reset its operator')
})

test('each datasource keeps its own query, and Code starts as a copy of the tab it came from', () => {
  let d = blankDraft()
  const metricsQuery = queryOf(d)
  d = setDatasource(d, 'vlogs')
  assert.equal(queryOf(d), '* | stats count()', 'a Logs rule starts counting')
  assert.equal(needsClosingPipe(d), false)
  d = setDatasource(d, 'prometheus')
  assert.equal(queryOf(d), metricsQuery)
  const code = setTab(d, 'code')
  assert.equal(queryOf(code), metricsQuery)
  assert.equal(modelOf(code), null, 'Code saves no model')
  assert.equal(modelOf(d).calculate, 'error_percentage')
})

test('a Logs query with no closing pipe is caught before Save, in words', () => {
  const d = draftFromPayload({ datasource: 'vlogs', query: 'service:payment level:error' })
  assert.equal(needsClosingPipe(d), true)
  assert.ok(validateDraft(d).some(v => v.field === 'query' && v.message === NEEDS_CLOSING_PIPE))
})

test('a disabled Save lists what is missing, each item naming its field', () => {
  assert.deepEqual(validateDraft(blankDraft()), [
    { field: 'tiers', message: 'Set a Warning or a Critical threshold, or both.' },
    { field: 'name', message: 'Name the rule.' },
    { field: 'notify', message: 'Choose a contact point or add a destination.' },
  ])
  let d = setTier(blankDraft(), 'warning', { value: '1.' })
  assert.ok(validateDraft(d).every(v => v.field !== 'tier-warning'), '"1." is a number in mid-keystroke')
  d = setTier(d, 'critical', { value: 'three' })
  assert.deepEqual(validateDraft(d).find(v => v.field === 'tier-critical'), { field: 'tier-critical', message: 'Critical must be a number.' })
  d = { ...d, tags: [{ key: 'group', value: 'x' }, { key: 'team', value: 'a' }, { key: 'team', value: 'b' }, { key: 'severity', value: 'high' }, { key: '', value: 'orphan' }] }
  assert.deepEqual(validateDraft(d).filter(v => v.field.startsWith('tag-')).map(v => v.field), ['tag-0', 'tag-2', 'tag-3', 'tag-4'])
  d = { ...d, tags: [], name: 'x', receiverGroupIds: [11], access: { mode: 'custom', rows: [{ entity: 'team:team-sre', permission: 'viewer' }] } }
  assert.deepEqual(validateDraft(setTier(d, 'critical', { value: '3' })), [{ field: 'access', message: 'Give at least one team or person Editor access.' }])
  assert.deepEqual(validateDraft(validReady()), [])
})

function validReady() {
  return { ...setTier(blankDraft(), 'critical', { value: '3' }), name: 'fleet errors', receiverGroupIds: [11] }
}

test('destinations: every type stores in production\'s shape and says what it still needs', () => {
  for (const rule of seed.rules) assert.deepEqual(filledReceivers(receiverOf(destinationsOf(rule.receiver))), filledReceivers(rule.receiver), String(rule.id))
  for (const group of seed.receiverGroups) assert.deepEqual(filledReceivers(receiverOf(destinationsOf(group.receiver))), filledReceivers(group.receiver), group.name)
  const needs = type => destinationProblem(newDestination(type))
  assert.deepEqual(
    ['email', 'slack', 'pagerduty', 'jira', 'opsgenie', 'googlechat', 'msTeamsV2', 'webhook'].map(needs),
    ['Add at least one email address.', 'Pick a Slack channel.', 'Connect a PagerDuty service.', 'Pick a Jira project.',
      'Pick an Opsgenie team.', 'Enter the Space\'s webhook URL.', 'Enter the incoming webhook URL.',
      'Enter a webhook URL starting with http:// or https://.'],
  )
  assert.equal(destinationProblem({ ...newDestination('email'), to: 'a@x.io, nope' }), '"nope" is not an email address.')
  assert.equal(destinationProblem({ ...newDestination('jira'), project: 'OPS' }), 'Pick an issue type.')
  assert.equal(destinationProblem({ ...newDestination('webhook'), url: 'https://hooks.example/a' }), null)
})

test('a mute window stores as production\'s interval, and an overnight one by its length', () => {
  const quiet = seed.muteGroups.find(g => g.name === 'Quiet hours')
  const windows = muteWindowsOf(quiet.mute)
  assert.deepEqual(windows[0], { start: '21:00', hours: 10, minutes: 0, weekdays: [], location: 'Asia/Calcutta' })
  assert.deepEqual(muteOf(windows), quiet.mute)
  assert.equal(muteWindowProblem(newMuteWindow('UTC')), 'Set a start time (HH:MM).')
  assert.equal(muteWindowProblem({ ...newMuteWindow('UTC'), start: '09:00' }), 'Mute for at least a minute.')
  assert.equal(muteWindowProblem({ ...newMuteWindow('UTC'), start: '09:00', minutes: 30 }), null)
})

test('inserting a label into the name switches Send to one notification per series', () => {
  const { draft, switched } = insertLabel({ ...blankDraft(), name: 'CPU high on' }, 'host.name')
  assert.equal(draft.name, 'CPU high on {{ index .Labels "host.name" }}')
  assert.equal(draft.groupingDisable, true)
  assert.equal(switched, true)
  assert.equal(insertLabel(draft, 'service').switched, false, 'already per series')
})

test('an entry point\'s payload opens prefilled, and an incoming model loses its stale options', () => {
  const withOptions = { ...p90, labelPairs: [{ ...p90.labelPairs[0], options: ['a', 'b'] }] }
  const d = draftFromPayload({
    datasource: 'prometheus', model: withOptions, name: 'payment-service p90 latency', group: 'Payments',
    tiers: { warning: { op: '>', threshold: 150 }, critical: { op: '>', threshold: 300 } },
  })
  const saved = ruleFromDraft(d)
  assert.equal(tiersOf(saved).query, buildQuickQuery(p90, { latencyInMs: true }), 'a Quick latency alert is in milliseconds')
  assert.deepEqual(saved.config.model.labelPairs[0], p90.labelPairs[0])
  assert.deepEqual([tiersOf(saved).warning.threshold, tiersOf(saved).critical.threshold], [150, 300])
  assert.deepEqual([saved.name, saved.labels.group], ['payment-service p90 latency', 'Payments'])
  const monitor = ruleFromDraft(draftFromPayload({
    datasource: 'prometheus', condition: '==', threshold: '0',
    model: { type: 'advanced', metric: 'cube_synthetic_monitor', labelPairs: [{ label: 'id', operator: '=', values: ['15'] }], functions: [{ value: 'max', args: [{ type: 'aggregation', value: ['id', 'group', 'name'] }] }] },
  }))
  assert.deepEqual(tiersOf(monitor).critical, { op: '==', threshold: 0 })
  const suggested = ruleFromDraft(draftFromSuggestion({ calculate: 'error_percentage', service: 'cart-service', tiers: { warning: { op: '>', threshold: 1 }, critical: { op: '>', threshold: 3 } }, forSec: 300, name: 'cart-service error rate' }))
  assert.match(tiersOf(suggested).query, /service="cart-service"/)
  assert.equal(suggested.duration, 300)
})

test('a payload can ask for an anomaly rule and its own check interval; anything else is ignored', () => {
  const quickRpm = { type: 'quick', calculate: 'rpm', value: '90', labelPairs: [emptyPair()], groupBy: ['service'] }
  const anomaly = draftFromPayload({ datasource: 'prometheus', model: quickRpm, kind: 'anomaly', tiers: { warning: { op: '<>', deviations: 3 } }, intervalSec: 300 })
  assert.equal(anomaly.kind, 'anomaly')
  assert.deepEqual(anomaly.tiers.anomaly.warning, { op: '<>', value: '3' })
  assert.equal(anomaly.intervalSec, 300)
  const saved = ruleFromDraft(anomaly)
  assert.equal(saved.kind, 'anomaly')
  assert.equal(saved.interval, 300)
  const logs = draftFromPayload({ datasource: 'vlogs', query: '* | stats count()', kind: 'anomaly', intervalSec: 7 })
  assert.equal(logs.kind, 'static', 'anomaly reads Metrics only')
  assert.equal(logs.intervalSec, 60, 'an interval the editor does not offer is not taken')
})

test('a draft is dirty when it would save something different, and only then', () => {
  const opened = draftFromRule(byId.get(502))
  assert.equal(isDirty(opened, opened), false)
  assert.equal(isDirty({ ...opened }, opened), false)
  assert.equal(isDirty(setTier(opened, 'critical', { value: '400' }), opened), true)
  assert.equal(isDirty({ ...opened, name: `${opened.name} ` }, opened), false, 'trailing space trims away')
})
