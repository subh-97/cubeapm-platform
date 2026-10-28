// What the app's "Create Alert" items hand the editor (editorPayloads.js;
// docs/alerts/DESIGN.md D13). A card's rule fires exactly where the card's
// colour changes; a Logs or Traces bar's rule counts that bar's query; and a
// new rule lands in the folder its service's rules already use.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { statusForLatency, statusForErrorRate } from '@/utils/status'
import { holds } from './condition'
import { buildAdvancedQuery } from '@/utils/explore/builders'
import { alertPayloadForCard, alertPayloadForQuery, groupForService, alertPayloadForHostCpu, alertPayloadForError, alertPayloadForExplore } from './editorPayloads'
import { initialState, committedQuery } from '@/utils/explore/editorState'
import { draftFromPayload, ruleFromDraft } from './editorDraft'
import { ruleMetric } from './model'
import { previewRule } from '@/data/alerts'
import { resolveWindow, INCIDENT_START_MIN } from '@/data/timeWindow'

test('a card\'s Create Alert watches what the card plots and fires where its colour changes', () => {
  const p90 = alertPayloadForCard({ action: 'Create Alert', title: 'p90 Latency', serviceId: 'payment-service' })
  assert.equal(p90.datasource, 'prometheus')
  assert.deepEqual([p90.model.calculate, p90.model.value, p90.model.groupBy], ['latency_percentile', '90', []])
  assert.deepEqual(p90.model.labelPairs[0], { label: 'service', operator: '=', values: ['payment-service'] })
  assert.equal(p90.name, 'payment-service p90 latency')
  assert.equal(p90.service, 'payment-service')
  for (const ms of [149, 150, 299, 300, 301]) {
    const fired = holds(p90.tiers.critical, ms) ? 'critical' : holds(p90.tiers.warning, ms) ? 'warning' : 'healthy'
    assert.equal(fired, statusForLatency(ms), `${ms} ms`)
  }
  const err = alertPayloadForCard({ action: 'Create Alert', title: 'Error %', serviceId: 'payment-service' })
  for (const pct of [0.9, 1, 2.9, 3]) {
    const fired = holds(err.tiers.critical, pct) ? 'critical' : holds(err.tiers.warning, pct) ? 'warning' : 'healthy'
    assert.equal(fired, statusForErrorRate(pct), `${pct}%`)
  }
})

test('a column, an endpoint and a total each read as the card\'s Explore item does', () => {
  const col = alertPayloadForCard({ action: 'Create Alert - Error %', title: 'Endpoints', serviceId: 'order-service', endpoint: 'POST /orders' })
  assert.equal(col.model.calculate, 'error_percentage')
  assert.deepEqual(col.model.labelPairs.filter(p => p.label).map(p => p.label), ['service', 'root_name'])
  assert.equal(col.name, 'order-service POST /orders error rate')
  const rpm = alertPayloadForCard({ action: 'Create Alert (Total)', title: 'Requests / min', serviceId: 'payment-service' })
  assert.equal(rpm.model.calculate, 'rpm')
  assert.equal(rpm.tiers, null, 'RPM has no colour to take a threshold from')
  assert.equal(alertPayloadForCard({ action: 'Explore', title: 'p90 Latency' }), null)
  assert.equal(alertPayloadForCard({ action: 'Download CSV', title: 'p90 Latency' }), null)
})

test('a Logs or Traces bar\'s rule counts that bar\'s query, once', () => {
  assert.deepEqual(alertPayloadForQuery({ datasource: 'vlogs', query: 'service:="payment" log.level:="error"' }),
    { datasource: 'vlogs', query: 'service:="payment" log.level:="error" | stats count()' })
  assert.deepEqual(alertPayloadForQuery({ datasource: 'traces', query: '' }), { datasource: 'traces', query: '* | stats count()' })
  const already = '* | stats by (service) count() as n'
  assert.equal(alertPayloadForQuery({ datasource: 'vlogs', query: already }).query, already)
})

test('a new rule goes in the folder its service\'s rules use, else one named for the service', () => {
  const views = [
    { scope: { service: 'payment-service' }, group: 'Payments' },
    { scope: { service: 'payment-service' }, group: 'Payments' },
    { scope: { service: 'payment-service' }, group: 'Platform' },
    { scope: { service: 'order-service' }, group: 'Checkout' },
  ]
  assert.equal(groupForService(views, 'payment-service'), 'Payments')
  assert.equal(groupForService(views, 'cart-service'), 'cart-service')
  assert.equal(groupForService(views, null), null)
})

test('a host\'s CPU chart becomes a percentage rule over the metric Explore reads, at the host table\'s colours', () => {
  const p = alertPayloadForHostCpu('ip-10-0-142-133')
  assert.equal(buildAdvancedQuery(p.model), 'system_cpu_utilization{host.name="ip-10-0-142-133"} * 100')
  assert.deepEqual([p.tiers.warning, p.tiers.critical], [{ op: '>=', threshold: 70 }, { op: '>=', threshold: 85 }])
  assert.deepEqual([p.name, p.group], ['CPU high on ip-10-0-142-133', 'Infrastructure'])
  assert.equal(alertPayloadForHostCpu(null), null)
})

test('an error\'s alert watches that exception on that service, a minute at a time, and fires in the incident only', () => {
  const p = alertPayloadForError({ service: 'payment-service', exception: 'redis.clients.jedis.exceptions.JedisPoolException', exceptionShort: 'JedisPoolException' })
  assert.equal(p.datasource, 'prometheus')
  assert.equal(buildAdvancedQuery(p.model), 'sum(rate(cube_apm_errors_total{service="payment-service", exception="redis.clients.jedis.exceptions.JedisPoolException"})) * 60')
  assert.equal(p.name, 'JedisPoolException on payment-service')
  assert.deepEqual([p.tiers.warning, p.forSec], [{ op: '>', threshold: 1 }, 120])
  const rule = ruleFromDraft({ ...draftFromPayload(p), receiverGroupIds: [11] })
  assert.deepEqual(ruleMetric(rule), { metric: 'JedisPoolException rate', unit: '/min' })
  // The counter reads at every minute, whatever the hour the page loaded (the
  // span store it replaced was empty over some hours, 7c).
  const hour = resolveWindow({ kind: 'preset', value: '1h' })
  const preview = previewRule(rule, hour)
  assert.equal(preview.error, null)
  assert.equal(preview.series.length, 1)
  assert.ok(preview.series[0].points.every(pt => pt.value != null), 'a reading every minute')
  const firing = preview.lane.filter(iv => iv.state === 'firing')
  assert.ok(firing.length > 0, 'it fires in the Redis incident')
  const incidentFrom = hour.nowSec - INCIDENT_START_MIN * 60
  assert.ok(firing.every(iv => iv.start >= incidentFrom), 'and not before it: a quiet hour stays under one a minute')
})

test('Explore\'s Create alert opens its builder while the chart draws it, its query in Code otherwise', () => {
  const page = initialState()
  const committed = committedQuery(page)
  assert.equal(typeof committed.query, 'string', 'the committed pair, not a query')
  const built = alertPayloadForExplore(page.editors.prometheus, committed)
  assert.deepEqual(Object.keys(built).sort(), ['datasource', 'model'])
  assert.equal(built.model.type, 'quick')
  const draft = draftFromPayload(built)
  assert.equal(ruleFromDraft(draft).datasource, 'prometheus')
  assert.equal(draft.editors.prometheus.quick.query, committed.query, 'the editor spells what the chart drew')

  // Edited past what the chart draws: the drawn query goes, as code.
  const ahead = { ...page.editors.prometheus, quick: { ...page.editors.prometheus.quick, query: 'something else' } }
  assert.deepEqual(alertPayloadForExplore(ahead, committed), { datasource: 'prometheus', query: committed.query })
  const logs = committedQuery({ ...page, datasource: 'vlogs' })
  const onCode = alertPayloadForExplore({ ...page.editors.vlogs, tab: 'code' }, logs)
  assert.deepEqual(onCode, { datasource: 'vlogs', query: logs.query })
  assert.equal(draftFromPayload(onCode).editors.vlogs.code.query, logs.query)
  assert.equal(alertPayloadForExplore(page.editors.prometheus, null), null)
})
