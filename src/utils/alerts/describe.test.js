// A rule in words (docs/alerts/DESIGN.md D3, D6). Production prints a rule's
// PromQL and raw values ("0.29535866"); these are the sentences that replace
// them, so what they say has to be exactly what the rule does — the operator,
// the tiers, the wait — and in the units the reader thinks in.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  formatNumber, formatValue, formatThreshold, formatDuration, formatElapsed, durationWords,
  conditionText, ruleSentence, ruleSentenceParts, multipleText, sinceText, displayName,
} from './describe.js'

const paymentErrors = {
  metric: 'Error %', unit: '%', kind: 'static',
  scope: { service: 'payment-service', endpoint: null, host: null },
  tiers: { warning: { op: '>', threshold: 1 }, critical: { op: '>', threshold: 3 } },
  forSec: 300, intervalSec: 60, repeatSec: 3600,
  contactPoints: [{ id: 'cp-pay', name: 'Payments on-call' }], receivers: [],
}

test('numbers come out at the precision their size deserves', () => {
  assert.deepEqual([612.4, 14.2367, 1.254, 0.29535866, 0.0612, 0, 1054.2, -3.14159].map(formatNumber),
    ['612', '14.2', '1.25', '0.3', '0.061', '0', '1,054', '-3.14'])
  assert.equal(formatNumber(null), '—')
  assert.equal(formatNumber(NaN), '—')
})

test('a reading carries its unit: production\'s 0.29535866 is 0.3%', () => {
  assert.equal(formatValue({ unit: '%' }, 0.29535866), '0.3%')
  assert.equal(formatValue({ unit: 'ms' }, 612), '612 ms')
  assert.equal(formatValue({ unit: 'rpm' }, 452.7), '453 rpm')
  assert.equal(formatValue({ unit: 'MB' }, 1054.2), '1,054 MB')
  assert.equal(formatValue({ unit: null }, 12.5), '12.5')
  assert.equal(formatThreshold({ kind: 'anomaly', unit: 'rpm' }, 3), '3σ', 'an anomaly threshold is deviations, whatever the metric')
})

test('settings durations are production\'s spelling; elapsed time is how people say it', () => {
  assert.deepEqual([0, 30, 60, 300, 3600, 5400, 14400, 86400].map(formatDuration), ['0s', '30s', '1m', '5m', '1h', '1h30m', '4h', '24h'])
  assert.deepEqual([12, 780, 7500, 266400, 259200].map(formatElapsed), ['12s', '13m', '2h 5m', '3d 2h', '3d'])
  assert.deepEqual([30, 60, 300, 5400].map(durationWords), ['30 seconds', '1 minute', '5 minutes', '1 hour 30 minutes'])
})

test('the list\'s condition names both tiers, critical first, and the wait', () => {
  assert.equal(conditionText(paymentErrors), 'Error % > 3% critical, > 1% warning, for 5m')
})

test('a lone warning names no severity; a lone critical does; firing at once has no "for"', () => {
  const lone = { ...paymentErrors, tiers: { warning: { op: '>', threshold: 0.1 }, critical: null } }
  assert.equal(conditionText(lone), 'Error % > 0.1%, for 5m')
  const synthetic = { metric: 'Monitor up', unit: null, kind: 'static', forSec: 120, tiers: { warning: null, critical: { op: '==', threshold: 0 } } }
  assert.equal(conditionText(synthetic), 'Monitor up = 0 critical, for 2m')
  assert.equal(conditionText({ ...lone, forSec: 0, metric: 'p90 latency', unit: 'ms', tiers: { warning: { op: '>=', threshold: 99 } } }), 'p90 latency ≥ 99 ms')
})

test('an anomaly rule\'s condition is in deviations from the expected range', () => {
  const rpm = { metric: 'RPM', unit: 'rpm', kind: 'anomaly', forSec: 600, tiers: { warning: { op: '<>', deviations: 3 }, critical: { op: '<>', deviations: 4 } } }
  assert.equal(conditionText(rpm), 'RPM outside expected by 3σ, 4σ critical, for 10m')
  assert.equal(conditionText({ ...rpm, tiers: { warning: { op: '<', deviations: 2 } } }), 'RPM below expected by 2σ, for 10m')
})

test('the whole rule is one sentence a reviewer can read without opening a section', () => {
  assert.equal(ruleSentence(paymentErrors),
    'Alert when Error % of payment-service is above 1% (critical above 3%) for 5 minutes, checked every minute. '
    + 'Notify Payments on-call and remind every hour while it fires.')
})

test('the sentence names an endpoint\'s service, a host, several contact points, and saying nothing when nobody is told', () => {
  const ep = { ...paymentErrors, scope: { service: 'payment-service', endpoint: 'POST /v1/payments' }, tiers: { warning: { op: '>', threshold: 0.1 } },
    contactPoints: [{ name: 'Payments on-call' }, { name: 'Infra paging' }], receivers: [{ oneOff: true }], repeatSec: 14400 }
  assert.equal(ruleSentence(ep),
    'Alert when Error % of POST /v1/payments on payment-service is above 0.1% for 5 minutes, checked every minute. '
    + 'Notify Payments on-call, Infra paging and 1 one-off destination and remind every 4 hours while it fires.')
  const host = { metric: 'CPU', unit: '%', kind: 'static', scope: { host: 'ip-10-0-142-133' }, tiers: { critical: { op: '>', threshold: 85 } }, forSec: 0, intervalSec: 300, contactPoints: [] }
  assert.equal(ruleSentence(host), 'Alert when CPU of ip-10-0-142-133 is above 85% (critical), checked every 5 minutes. No one is notified.')
})

test('every field the editor links is in the sentence parts', () => {
  const fields = ruleSentenceParts(paymentErrors).filter(p => p.field).map(p => p.field)
  assert.deepEqual(fields, ['metric', 'scope', 'condition', 'for', 'interval', 'notify', 'repeat'])
})

test('a reading against its threshold, and how long a rule has been in its state', () => {
  assert.equal(multipleText({ thresholdMultiple: 4.7333 }), '4.7×')
  assert.equal(multipleText({ thresholdMultiple: 3 }), '3×')
  assert.equal(multipleText({ thresholdMultiple: 34.2 }), '34×')
  assert.equal(multipleText({}), null)
  const now = 10_000
  assert.equal(sinceText({ state: 'firing', since: now - 780 }, now), 'Firing 13m')
  assert.equal(sinceText({ state: 'pending', since: now - 120, forSec: 300 }, now), 'Pending 2m · fires in 3m')
  assert.equal(sinceText({ state: 'ok', since: now - 259200 }, now), 'OK for 3d')
  assert.equal(sinceText({ state: 'firing', since: now - 691200, sinceOpen: true }, now), 'Firing 8d+')
  assert.deepEqual(['paused', 'nodata', 'error'].map(state => sinceText({ state }, now)), ['Paused', 'No data', 'Rule error'])
})

test('a rule\'s display name shows a template by the labels it reads', () => {
  assert.equal(displayName({ name: 'CPU high on {{ index .Labels "host.name" }}' }), 'CPU high on ‹host.name›')
  assert.equal(displayName({ name: 'payment-service error rate' }), 'payment-service error rate')
})
