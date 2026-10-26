// Alerts where problems are noticed (docs/alerts/PLAN.md 7a; DESIGN D13):
// Home's firing-alert nudge and the service settings drawer's Alerts tab,
// rendered over the seed the Rules tab shows. What a click does is checked in
// the browser.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server.browser'
import { MemoryRouter } from 'react-router-dom'
import { alertsStore, alertsFor } from '@/utils/alerts/store'
import HomeAlerts from './HomeAlerts.jsx'
import { ServiceAlertsPanel } from '@/components/alerts/service/ServiceAlerts.jsx'
import { suggestionFor } from '@/components/alerts/service/serviceSuggestion.js'

const render = el => renderToStaticMarkup(<MemoryRouter>{el}</MemoryRouter>)
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, '\'').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()
const rules = alertsFor(alertsStore().getState()).rules
const onService = id => rules.filter(r => r.scope?.service === id)

test('Home: a nudge names the worst firing rule, says how bad and how long, and opens it', () => {
  const html = render(<HomeAlerts />)
  assert.match(html, /^<aside class="home-nudge critical" aria-label="Firing alert">/)
  assert.match(text(html), /^payment-service error rate is firing for \d+m [\d.]+% now [\d.]+× its 3% critical threshold Open rule$/)
  assert.match(html, /<p class="home-nudge-meta"><span>[\d.]+% now<\/span><span>[\d.]+× its 3% critical threshold<\/span><\/p>/, 'the value and the line it crossed, each on its own')
  assert.match(html, /<a class="hbtn home-nudge-action" href="\/alerts\/501">Open rule/)
  assert.equal((html.match(/<a /g) ?? []).length, 1, 'one way in: the rule')
})

test('Service: the settings tab lists its rules worst first, each linked, with Create', () => {
  const html = render(<ServiceAlertsPanel serviceId="payment-service" />)
  const links = [...html.matchAll(/<a href="\/alerts\/(\d+)">/g)].map(m => Number(m[1]))
  assert.deepEqual(links, onService('payment-service').map(r => r.id))
  assert.equal(links[0], 501)
  assert.match(text(html), /Create a rule/)
  assert.match(html, /href="\/alerts\?svc=payment-service">Open them in Alerts</)
})

test('Create offers what the service lacks: error rate, then p90 latency, then throughput', () => {
  assert.equal(suggestionFor('analytics-service', onService('analytics-service')).calculate, 'error_percentage')
  const demo = onService('demo-nodejs-service')
  assert.deepEqual(demo.map(r => r.metric), ['Error %'], 'the seed watches only its error rate')
  const next = suggestionFor('demo-nodejs-service', demo)
  assert.equal(next.calculate, 'latency_percentile')
  assert.deepEqual(next.tiers, { warning: { op: '>', threshold: 150 }, critical: { op: '>', threshold: 300 } })
  const pay = suggestionFor('payment-service', onService('payment-service'))
  assert.equal(pay.calculate, 'rpm')
  assert.equal(pay.tiers, undefined, 'its threshold is left to set')
  // An endpoint's rule does not watch the whole service.
  assert.equal(suggestionFor('x', [{ metric: 'Error %', scope: { service: 'x', endpoint: 'GET /' } }]).calculate, 'error_percentage')
})

test('the Alerts pages load behind their own shapes, busy, with nothing from the split code', async () => {
  const { default: AlertsPageSkeleton } = await import('@/components/alerts/AlertsPageSkeleton.jsx')
  for (const kind of ['list', 'rule', 'editor']) {
    const html = render(<AlertsPageSkeleton kind={kind} />)
    assert.match(html, /^<div class="skeleton-shell" aria-busy="true" aria-label="Loading Alerts">/, kind)
    assert.ok((html.match(/class="ovsk-bone"/g) ?? []).length >= 4, kind)
  }
})
