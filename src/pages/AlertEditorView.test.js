// The rule editor's page (docs/alerts/DESIGN.md D6, D13, D18), rendered from
// each way in: a blank rule, an edit, a clone, a card's payload, a Logs bar's
// payload, and the two ways in that cannot edit — a rule that is gone, and one
// its SLO owns. What a click does is checked in the browser; this pins what
// each way in opens on.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server.browser'
import { MemoryRouter } from 'react-router-dom'
import { alertPayloadForCard, alertPayloadForQuery } from '@/utils/alerts/editorPayloads'
import AlertEditorView from './AlertEditorView.jsx'

const noop = () => {}
const EXPECTED = /width\(\d+\) and height\(\d+\) of chart|useLayoutEffect does nothing on the server/
function page({ path = '/alerts/new', ruleId = null, state, incoming } = {}) {
  const { warn, error } = console
  const quiet = log => (...args) => { if (!EXPECTED.test(String(args[0]))) log(...args) }
  console.warn = quiet(warn)
  console.error = quiet(error)
  try {
    return renderToStaticMarkup(
      <MemoryRouter initialEntries={[{ pathname: path, state }]}>
        <AlertEditorView
          ruleId={ruleId} goHome={noop} timeRange={{ kind: 'preset', value: '1h' }} setTimeRange={noop}
          setToast={noop} onOpenLink={noop} incoming={incoming} onIncomingApplied={noop}
        />
      </MemoryRouter>,
    )
  } finally {
    Object.assign(console, { warn, error })
  }
}
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, '\'').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ')
const inputValues = html => [...html.matchAll(/<input[^>]*value="([^"]*)"/g)].map(m => m[1])

test('a new rule opens on all four sections, in production\'s order, and says what it still needs', () => {
  const html = page()
  assert.deepEqual([...html.matchAll(/class="ae-section-title">([^<]+)</g)].map(m => m[1]),
    ['Query &amp; condition', 'Evaluation &amp; details', 'Notifications', 'Mutes &amp; access'])
  assert.match(text(html), /Alert when Error % is anything at all/)
  assert.match(html, /aria-disabled="true"[^>]*>Save rule</)
  assert.match(text(html), /3 to finish/)
  assert.match(html, /role="tab" aria-selected="false" aria-disabled="true" title="Mobile alerts aren&#x27;t available yet"/, 'Mobile is listed, disabled with its reason')
  assert.doesNotMatch(html, /ae-field-problem/, 'nothing is red before anyone tries to save')
})

test('editing a rule opens it as stored, under its own crumb', () => {
  const html = page({ path: '/alerts/502/edit', ruleId: '502' })
  assert.match(html, /<a href="\/alerts\/502">payment-service p90 latency<\/a>/)
  assert.match(html, /<span class="current">Edit<\/span>/)
  assert.match(text(html), /%ile Latency \(millis\)/, 'an alert reads latency in milliseconds, and says so')
  assert.match(text(html), /above 150 ms \(critical above 300 ms\) for 5 minutes/)
  assert.ok(inputValues(html).includes('payment-service p90 latency'))
  assert.ok(['150', '300'].every(v => inputValues(html).includes(v)))
  assert.match(html, />Save changes</)
})

test('a clone of a paused monitor rule shows the status it will be saved with, and where it came from', () => {
  const html = page({ state: { cloneOf: 427 } })
  assert.match(html, /<span class="current">Clone<\/span>/)
  assert.ok(inputValues(html).includes('Copy of Synthetic down - Marketing Site'))
  // The chosen status is the group's one Tab stop; the arrows move between them (7c).
  assert.match(html, /role="radio" aria-checked="true" class="seg active" tabindex="0"><svg[^>]*>[\s\S]*?<\/svg>Paused/)
  assert.match(text(html), /This rule will be saved paused/)
  assert.match(text(html), /Created from the monitor “Marketing Site”/)
})

test('a rule that is gone, and one its SLO owns, say so instead of opening a form', () => {
  assert.match(text(page({ path: '/alerts/9999/edit', ruleId: '9999' })), /Alert not found/)
  const slo = text(page({ path: '/alerts/9011/edit', ruleId: '9011' }))
  assert.match(slo, /This rule belongs to its SLO/)
  assert.doesNotMatch(slo, /Save changes/)
})

test('a card\'s Create Alert opens on the card\'s query, thresholds, name and folder', () => {
  const html = page({ incoming: { view: 'alertEditor', ...alertPayloadForCard({ action: 'Create Alert', title: 'p90 Latency', serviceId: 'payment-service' }) } })
  assert.match(text(html), /p90 latency of payment-service is at or above 150 ms \(critical at or above 300 ms\)/)
  assert.ok(inputValues(html).includes('payment-service p90 latency'))
  assert.ok(inputValues(html).includes('Payments'), 'the folder payment-service\'s rules already use')
})

test('a Logs bar\'s Create Alert opens on Logs, counting its query', () => {
  const html = page({ incoming: { view: 'alertEditor', ...alertPayloadForQuery({ datasource: 'vlogs', query: 'log.level:="error"' }) } })
  assert.match(html, /role="tab" aria-selected="true" class="tab active">Logs</)
  assert.match(text(html), /log\.level:="error" \| stats count\(\)/)
  assert.doesNotMatch(text(html), /needs its query to end in a stats or math pipe/)
})
