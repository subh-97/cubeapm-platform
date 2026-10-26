// The Alerts page's query string (docs/alerts/DESIGN.md D14).
//
// Two contracts, as on Errors. A link out of production has to land on the
// same screen here — its own keys honoured, the APM page's leftovers ignored.
// And whatever the hub writes has to read back to the same state.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseAlertsSearch, alertsSearch, ALERTS_TABS, ALERTS_FACET_KEYS } from './alertsUrl.js'

const DEFAULTS = {
  tab: 'alerts', ruleId: null, alertId: null, notifyTime: null, incidentTime: null,
  config: null, time: null, q: '', facets: {},
}

// ---------- Production's links ----------

// The link this module was studied from: the APM page's sticky query string,
// carried into /alerts by production's link helper. Production renders the
// plain rules list on Last 7 days, and so do we.
const STUDY_URL = '/alerts?service=cubedemo-web&index=cube%3Aerror&name=POST+api.stripe.com%2Fv1%2Fpayment_intents&kind=server&time=7d&refresh=1792040553713&view=graph&env=UNSET'

test('the APM page\'s sticky keys are read past: the study link is the plain rules list on 7 days', () => {
  assert.deepEqual(parseAlertsSearch(STUDY_URL), { ...DEFAULTS, time: '7d' })
})

test('a `service` in an Alerts URL is the APM page\'s, never our service filter', () => {
  const s = parseAlertsSearch('?service=payment-service&svc=order-service')
  assert.deepEqual(s.facets, { svc: ['order-service'] })
})

test('the rule row\'s history link opens that rule\'s notifications', () => {
  const s = parseAlertsSearch('/alerts?time=7d&tab=alert-logs&rule_id=437')
  assert.equal(s.tab, 'alert-logs')
  assert.equal(s.ruleId, '437')
  assert.equal(s.time, '7d')
})

test('a notification\'s link keeps its alert, and the times it anchors on', () => {
  const s = parseAlertsSearch('/alerts/437?alert_id=13501299483493697436&notifyTime=1792056582&incidentTime=1792056282')
  assert.equal(s.alertId, '13501299483493697436', 'the id is a string: as a number it would lose digits')
  assert.equal(s.notifyTime, 1792056582)
  assert.equal(s.incidentTime, 1792056282)
})

test('an anchor that is not unix seconds is no anchor', () => {
  for (const v of ['', 'abc', '-5', '0', '1.5', '17920565820000', '2026-10-15', '99999999999']) {
    assert.equal(parseAlertsSearch(`?notifyTime=${encodeURIComponent(v)}`).notifyTime, null, v)
  }
})

test('every tab production names opens; any other value is the rules list', () => {
  for (const tab of ALERTS_TABS) assert.equal(parseAlertsSearch(`?tab=${tab}`).tab, tab)
  for (const tab of ['', 'stats', 'Alerts', 'rules', 'toString']) assert.equal(parseAlertsSearch(`?tab=${tab}`).tab, 'alerts', tab)
})

test('PagerDuty\'s connect return is read as complete name/key pairs, or not at all', () => {
  const ok = JSON.stringify({ integration_keys: [{ name: 'Payments', integration_key: 'abc123' }, { name: 'No key' }] })
  assert.deepEqual(parseAlertsSearch(`?config=${encodeURIComponent(ok)}`).config, { integrationKeys: [{ name: 'Payments', key: 'abc123' }] })
  for (const bad of ['{', '[]', '{"integration_keys":{}}', '{"integration_keys":[{"name":"x"}]}', 'null']) {
    assert.equal(parseAlertsSearch(`?config=${encodeURIComponent(bad)}`).config, null, bad)
  }
})

test('only a preset range is carried; production\'s absolute ISO~ISO is the range App owns', () => {
  assert.equal(parseAlertsSearch('?time=24h').time, '24h')
  assert.equal(parseAlertsSearch('?time=2026-10-15T09:00:00.000Z~2026-10-15T10:00:00.000Z').time, null)
  assert.equal(parseAlertsSearch('?time=42d').time, null)
})

// ---------- Our dialect ----------

test('facets read in our keys, trimmed, deduplicated, empty values dropped', () => {
  const s = parseAlertsSearch('?state=critical&state=warning&state=critical&group=Payments&svc=+payment-service+&notifies=&source=metrics')
  assert.deepEqual(s.facets, {
    state: ['critical', 'warning'],
    group: ['Payments'],
    svc: ['payment-service'],
    source: ['metrics'],
  })
})

test('a key the page does not know cannot become a facet, prototype names included', () => {
  const s = parseAlertsSearch('?toString=1&constructor=x&__proto__=y&hasOwnProperty=z&level=critical')
  assert.deepEqual(s.facets, {})
})

test('an old link\'s group_by is read past: the list always groups by each rule\'s own group', () => {
  for (const g of ['service', 'contact', 'none']) assert.deepEqual(parseAlertsSearch(`?group_by=${g}`), DEFAULTS, g)
  assert.equal(alertsSearch(parseAlertsSearch('?group_by=service&q=redis')), '?q=redis')
})

test('the same link reads the same with or without the ?, as a path, or with a fragment', () => {
  const q = 'tab=alert-logs&rule_id=437&status=ERROR'
  const want = parseAlertsSearch(`?${q}`)
  assert.deepEqual(parseAlertsSearch(q), want)
  assert.deepEqual(parseAlertsSearch(`/alerts?${q}`), want)
  assert.deepEqual(parseAlertsSearch(`https://playground.cubeapm.com/alerts?${q}#top`), want)
})

// ---------- Writing ----------

test('nothing to say writes nothing; defaults are left out', () => {
  assert.equal(alertsSearch(), '')
  assert.equal(alertsSearch({ tab: 'alerts', facets: {}, q: '  ' }), '')
})

test('the hub writes in a fixed order, readably', () => {
  const s = alertsSearch({
    tab: 'alert-logs',
    ruleId: 437,
    q: 'payment error',
    facets: { status: new Set(['ERROR', 'MUTE']), svc: ['payment-service'], state: 'critical' },
  })
  assert.equal(s, '?tab=alert-logs&rule_id=437&q=payment+error&state=critical&svc=payment-service&status=ERROR&status=MUTE')
  assert.equal(alertsSearch({ facets: { group: ['Payments'], severity: ['critical'], state: ['ok'] } }), '?state=ok&severity=critical&group=Payments')
})

test('what the page reads from outside is never written back', () => {
  const s = alertsSearch({ ...parseAlertsSearch('?alert_id=9&notifyTime=1792056582&incidentTime=1792056282&time=7d&config=%7B%7D') })
  assert.equal(s, '')
})

test('whatever the hub writes reads back to the same state', () => {
  const states = [
    { tab: 'alerts', facets: { state: ['critical', 'pending'], group: ['Payments', 'Checkout & orders'] }, q: 'p90 > 300ms' },
    { tab: 'receiver-groups', ruleId: 'r-pay-err', facets: {}, q: '' },
    { tab: 'alert-logs', ruleId: '437', facets: { status: ['ERROR'], event: ['resolved'], contact: ['Payments on-call'] }, q: '' },
  ]
  for (const st of states) {
    const back = parseAlertsSearch(alertsSearch(st))
    assert.deepEqual(
      { tab: back.tab, ruleId: back.ruleId, facets: back.facets, q: back.q },
      { ruleId: null, ...st },
      JSON.stringify(st),
    )
  }
  for (const key of ALERTS_FACET_KEYS) {
    assert.deepEqual(parseAlertsSearch(alertsSearch({ facets: { [key]: ['x y', 'a/b:c'] } })).facets, { [key]: ['x y', 'a/b:c'] }, key)
  }
})

test('the Notifications tab\'s filters round-trip, with production\'s status values and rule_id', () => {
  const search = alertsSearch({ tab: 'alert-logs', ruleId: 437, facets: { status: ['ERROR', 'MUTE'], event: ['fired'], contact: ['Infra paging'], integration: ['webhook'] } })
  assert.equal(search, '?tab=alert-logs&rule_id=437&status=ERROR&status=MUTE&event=fired&contact=Infra+paging&integration=webhook')
  const back = parseAlertsSearch(search)
  assert.equal(back.tab, 'alert-logs')
  assert.equal(String(back.ruleId), '437')
  assert.deepEqual([back.facets.status, back.facets.event, back.facets.contact, back.facets.integration].map(v => [...v]), [['ERROR', 'MUTE'], ['fired'], ['Infra paging'], ['webhook']])
})
