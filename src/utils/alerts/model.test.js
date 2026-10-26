// The view model (docs/alerts/DESIGN.md D1, D3, D18): what every surface says
// about a rule. Read against the real evaluated seed, so what is pinned here is
// what the list will show at Last 1 hour.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { alertsSeed, ruleDefsFor, evaluateRules, ruleHistory, ALERTS_NOW } from '@/data/alerts'
import { ruleView, sortRules, groupRules, countRules, ruleFacets, ruleScope, ruleMetric, ALERT_ORDER } from './model.js'

const state = alertsSeed()
const defs = ruleDefsFor(state)
const evaluated = evaluateRules(defs, state)
const views = evaluated.map(r => ruleView(r, { ...state, history: ruleHistory(defs.find(d => d.id === r.id), state), nowSec: ALERTS_NOW }))
const v = new Map(views.map(x => [x.id, x]))

test('every rule reads the state its evaluation left it in', () => {
  const key = id => v.get(id).stateKey
  assert.deepEqual([501, 502, 514, 515, 9011].map(key), Array(5).fill('critical'))
  assert.deepEqual([437, 504, 505, 506, 507, 508, 9012].map(key), Array(7).fill('warning'))
  assert.equal(key(503), 'pending')
  assert.equal(key(513), 'error')
  assert.equal(key(512), 'nodata')
  assert.deepEqual([510, 511, 426].map(key), ['ok', 'ok', 'ok'])
  assert.deepEqual([427, 428, 432, 433].map(key), Array(4).fill('paused'))
  assert.equal(v.get(501).tone, 'critical')
  assert.equal(v.get(503).tone, 'info')
  assert.equal(v.get(512).tone, 'neutral')
})

test('worst first: firing, then pending, then broken, then the acknowledged, then quiet', () => {
  const order = sortRules(views).map(x => ALERT_ORDER[x.rank])
  for (let i = 1; i < order.length; i++) assert.ok(ALERT_ORDER.indexOf(order[i - 1]) <= ALERT_ORDER.indexOf(order[i]), order.join(','))
  assert.equal(ALERT_ORDER[v.get(505).rank], 'suppressed', 'firing but muted')
  assert.equal(ALERT_ORDER[v.get(507).rank], 'suppressed', 'firing but snoozed')
  assert.equal(v.get(505).stateKey, 'warning', 'suppression changes the order, never the truth')
})

test('what is holding notifications back now, and what only will', () => {
  const snoozed = v.get(507).suppression
  assert.equal(snoozed.kind, 'snooze')
  assert.ok(snoozed.endsAt > ALERTS_NOW && snoozed.createdBy === 'fulfilment-oncall')
  const muted = v.get(505).suppression
  assert.deepEqual([muted.kind, muted.name], ['mute', 'Daily deploy window'])
  assert.ok(muted.until > ALERTS_NOW)
  assert.equal(v.get(510).suppression, null, 'a scheduled snooze holds nothing yet')
  assert.deepEqual(v.get(510).snoozes.map(s => s.scheduled), [true])
  assert.deepEqual(v.get(508).snoozes, [], 'an expired one is history, not a chip')
})

test('scope is derived, from production\'s own query too, though Explore cannot parse it', () => {
  assert.deepEqual(v.get(437).scope, { service: 'payment-service', endpoint: 'POST /v1/payments', host: null })
  assert.deepEqual(v.get(501).scope, { service: 'payment-service', endpoint: null, host: null })
  assert.deepEqual(v.get(9011).scope, { service: 'payment-service', endpoint: 'POST /v1/payments', host: null }, 'from its SLO')
  assert.deepEqual(v.get(515).scope, { service: null, endpoint: null, host: null }, 'grouped by host: no one host')
  assert.deepEqual(ruleScope({ query: '{service="pay"} host.name:="ip-1" | stats count() as result | filter result: > 3', datasource: 'vlogs' }), { service: 'pay', endpoint: null, host: 'ip-1' })
})

test('what a rule measures, and the unit its threshold is in', () => {
  const m = id => { const x = v.get(id); return `${x.metric}|${x.unit}` }
  assert.deepEqual([437, 501, 502, 504, 510, 514, 515, 9011, 426].map(m), [
    'Error %|%', 'Error %|%', 'p90 latency|ms', 'Log count|count', 'RPM|rpm', 'Memory|MB', 'CPU|%', 'Burn rate|x', 'Monitor up|null',
  ])
  assert.deepEqual(ruleMetric({ query: '(sum(x)) > 3', datasource: 'prometheus' }), { metric: 'Value', unit: null })
})

test('rules other modules manage say which, and the SLO\'s cannot be edited here', () => {
  assert.deepEqual(v.get(426).managedBy, { kind: 'synthetic', monitorId: 15, monitorName: 'Docs' })
  assert.equal(v.get(426).readonly, false, 'synthetic rules stay editable (Q6)')
  assert.deepEqual(v.get(9011).managedBy, { kind: 'slo', sloId: 1, service: 'payment-service', endpoint: 'POST /v1/payments', objective: 'error', speed: 'fast' })
  assert.equal(v.get(9011).readonly, true)
  assert.equal(v.get(501).managedBy, null)
})

test('one instance per series, at its worst tier, against the threshold it crossed', () => {
  const cpu = v.get(515)
  assert.equal(cpu.instances.length, 3)
  assert.ok(cpu.instances.every(i => i.severity === 'critical' && i.labels['host.name']))
  const pay = v.get(501)
  assert.equal(pay.instances.length, 1, 'two tiers firing on one series is one instance')
  assert.equal(pay.instances[0].severity, 'critical')
  assert.ok(pay.thresholdMultiple > 3, `${pay.thresholdMultiple}× the 3% critical threshold`)
  assert.equal(pay.thresholdMultiple, pay.value / 3)
  assert.equal(v.get(510).thresholdMultiple, null, 'an anomaly threshold is not in the reading\'s unit')
})

test('firing counts from the incident\'s start, not from its escalation', () => {
  // A warning that fired at 1300 and escalated to critical at 1800 has been
  // firing since 1300.
  const at = t => new Date(t * 1000).toISOString()
  const escalated = ruleView({
    id: 1, name: 'x', status: 'ACTIVE', health: 'ok', seriesCount: 1, kind: 'static', datasource: 'prometheus',
    query: '(q) > 1', query2: '(q) > 3', labels: {}, config: {},
    alerts: [
      { state: 'firing', labels: {}, value: '5', activeAt: at(1000), id: 'w', firingAt: 1300 },
      { state: 'firing', labels: { severity: 'critical' }, value: '5', activeAt: at(1500), id: 'c', firingAt: 1800 },
    ],
  }, {
    nowSec: 2000,
    history: { from: 0, intervals: [
      { state: 'pending', severity: null, start: 1000, end: 1300 },
      { state: 'firing', severity: 'warning', start: 1300, end: 1800 },
      { state: 'firing', severity: 'critical', start: 1800, end: null },
    ] },
  })
  assert.equal(escalated.severity, 'critical')
  assert.equal(escalated.since, 1300)
  assert.equal(escalated.instances.length, 1)
  assert.equal(escalated.instances[0].activeAt, 1000, 'the series became active with its first tier')
  assert.equal(escalated.instances[0].firingAt, escalated.since, 'and an instance has fired as long as its rule says')

  const pay = v.get(501)
  const critical = evaluated.find(r => r.id === 501).alerts.find(a => a.labels.severity === 'critical')
  assert.ok(pay.since <= critical.firingAt, 'never later than the critical tier fired')
  assert.ok(ALERTS_NOW - pay.since < 22 * 60, 'and inside the incident')
  assert.equal(v.get(508).sinceOpen, true, 'the chronic rule has fired since before the horizon')
  assert.equal(v.get(511).sinceOpen, true, 'and the quiet one has been OK as long')
  assert.equal(v.get(427).since, null)
})

test('tags leave out what the evaluator and the tiers own', () => {
  assert.deepEqual(v.get(426).tags, { kind: 'synthetic' }, 'severity belongs to the tiers; group and rule_id are reserved')
  assert.deepEqual(v.get(501).tags, {})
  assert.equal(v.get(501).annotations.runbook_url, 'https://runbooks.cubedemo.example/payments/error-rate')
})

test('groups sort by their worst rule, then by how many fire — never alphabetically first', () => {
  const groups = groupRules(views)
  assert.equal(groups[0].worst, 'critical')
  for (let i = 1; i < groups.length; i++) assert.ok(ALERT_ORDER.indexOf(groups[i - 1].worst) <= ALERT_ORDER.indexOf(groups[i].worst))
  const payments = groups.find(g => g.key === 'Payments')
  assert.deepEqual(payments.rules.slice(0, 2).map(r => r.stateKey), ['critical', 'critical'])
  assert.ok(payments.firing >= 4)
  assert.equal(groups[groups.length - 1].worst, 'paused', 'all-paused folders sink to the bottom')
})

test('the summary counts each rule once', () => {
  const c = countRules(views)
  assert.equal(c.total, views.length)
  assert.equal(ALERT_ORDER.reduce((a, k) => a + c[k], 0), c.total)
  // 505's deploy window and 507's snooze hold at any hour. 509 flaps over its
  // threshold and Quiet hours mute it from 21:00 to 07:00 IST, so at night it
  // is a third whenever the evaluation catches it firing. Which it is depends
  // on the minute the suite loads, so it is read, not assumed.
  const nightly = v.get(509).state === 'firing' && !!v.get(509).suppression
  const suppressed = views.filter(x => ALERT_ORDER[x.rank] === 'suppressed').map(x => x.id).sort((a, b) => a - b)
  assert.deepEqual(suppressed, nightly ? [505, 507, 509] : [505, 507])
  assert.equal(c.suppressed, suppressed.length)
  assert.equal(c.critical, 5)
  assert.ok(c.firing >= c.critical + c.warning + c.suppressed)
})

test('facets read a rule the way the URL keys name them', () => {
  assert.deepEqual(ruleFacets(v.get(505)), {
    state: ['warning'], severity: ['critical'], group: ['Checkout'], svc: ['order-service'], source: ['metrics'],
    type: ['static'], notifies: ['Checkout on-call'], suppressed: ['muted'], status: ['active'],
  })
  assert.deepEqual(ruleFacets(v.get(426)).source, ['synthetic'])
  assert.deepEqual(ruleFacets(v.get(9012)).source, ['slo'])
  assert.deepEqual(ruleFacets(v.get(504)).svc, ['No service'])
})
