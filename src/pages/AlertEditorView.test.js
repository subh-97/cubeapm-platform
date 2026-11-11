// The rule editor's page (docs/alerts/DESIGN.md D6, D13, D18), rendered from
// each way in: a blank rule, an edit, a clone, a card's payload, a template, a
// Logs bar's payload, and the two ways in that cannot edit — a rule that is
// gone, and one its SLO owns. What a click does is checked in the browser;
// this pins what each way in opens on: the head banner, the stepper's open
// step and done steps, and, from a template, how the rule stands against it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server.browser'
import { MemoryRouter } from 'react-router-dom'
import { alertPayloadForCard, alertPayloadForQuery } from '@/utils/alerts/editorPayloads'
import { RULE_TEMPLATES, templatePayload } from '@/utils/alerts/ruleTemplates'
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

// The stepper's steps: title, whether open, done, and its "N to finish".
const steps = html => [...html.matchAll(/<li class="ae-step([^"]*)">[\s\S]*?aria-expanded="(true|false)"[\s\S]*?class="ae-step-title">([^<]+)</g)]
  .map(m => ({ title: m[3].replace(/&amp;/g, '&'), open: m[2] === 'true', done: /is-done/.test(m[1]), current: /is-current/.test(m[1]) }))

test('a new rule opens on the first of four steps, in production\'s order, and says what it still needs', () => {
  const html = page()
  assert.deepEqual(steps(html).map(s => s.title), ['Query & condition', 'Evaluation & details', 'Notifications', 'Mutes & access'])
  assert.deepEqual(steps(html).map(s => s.open), [true, false, false, false], 'one step open at a time')
  assert.ok(steps(html).every(s => !s.done), 'a new rule has done nothing yet')
  assert.match(html, /<button type="button" id="ae-step-1" class="ae-step-toggle" aria-expanded="true" aria-controls="[^"]+" aria-current="step">/)
  assert.equal((html.match(/class="ae-step-body" hidden=""/g) ?? []).length, 3, 'the other three are closed')
  // The open step ends with its way on; the first has no Back.
  const first = html.slice(html.indexOf('id="ae-step-1"'), html.indexOf('id="ae-step-2"'))
  assert.match(first, /class="hbtn primary ae-step-next">Continue<svg/)
  assert.doesNotMatch(first, /ae-step-back/)
  assert.match(html, /class="hbtn primary ae-step-next">Save rule<\/button>/, 'the last step ends with Save')
  // The head is a banner: the sentence, Cancel and Save, and the status it saves with.
  assert.match(html, /<section class="ae-head" aria-label="Rule summary">/)
  assert.match(text(html), /Alert when Error % is anything at all/)
  assert.doesNotMatch(html, /ae-head-eyebrow/, 'the crumb already says New rule; the banner does not repeat it')
  // The name is a blank above the banner, the bell inside it, empty and reading "Rule name" on a new rule.
  assert.match(html, /<label class="ae-head-name-field"><svg[^>]*class="lucide lucide-bell-ring ae-head-name-icon" aria-hidden="true">[\s\S]*?<\/svg><input class="ae-head-name" placeholder="Rule name" aria-label="Rule name" spellcheck="false" autoComplete="off" value=""\/><\/label>/)
  assert.match(html, /<button type="button" class="hbtn ae-cancel">Cancel<\/button><button type="button" class="hbtn primary ae-save"[^>]*>Save rule<\/button>/)
  // The status sits beside Cancel, glyphs alone, each named; a hairline parts them.
  assert.match(html, /<div class="ae-head-actions"><div class="seg-toggle ae-status" role="radiogroup" aria-label="Save the rule as">[\s\S]*?aria-label="Active"[\s\S]*?aria-label="Paused"[\s\S]*?<\/div><span class="ae-head-sep" aria-hidden="true"><\/span><button type="button" class="hbtn ae-cancel">Cancel/)
  assert.doesNotMatch(html, /ae-head-bar|>Active<|>Paused</)
  assert.doesNotMatch(html, /ae-finish|ae-ready|>Save as</, 'no count in the head: Save lists what is missing, and each step says its own')
  assert.doesNotMatch(html, /ae-tpl/, 'no template, no template banner')
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
  assert.match(html, /<input class="ae-head-name"[^>]*value="payment-service p90 latency"\/>/, 'the banner\'s name is the rule\'s')
  assert.ok(['150', '300'].every(v => inputValues(html).includes(v)))
  assert.match(html, />Save changes</)
  // A stored rule has nothing left to see: every step but the open one is done.
  assert.deepEqual(steps(html).map(s => s.done), [false, true, true, true])
})

test('a clone of a paused monitor rule shows the status it will be saved with, and where it came from', () => {
  const html = page({ state: { cloneOf: 427 } })
  assert.match(html, /<span class="current">Clone<\/span>/)
  assert.ok(inputValues(html).includes('Copy of Synthetic down - Marketing Site'))
  // The chosen status is the group's one Tab stop; the arrows move between them (7c).
  assert.match(html, /role="radio" aria-checked="true" aria-label="Paused" title="Save paused: not evaluated until resumed" class="seg active" tabindex="0"><svg/)
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

test('a template opens with its crumb back to Browse Templates; any other payload does not', () => {
  const crumb = /<a href="\/alerts\/templates">Browse Templates<\/a>/
  const fromTemplates = page({ incoming: { view: 'alertEditor', from: 'templates', datasource: 'prometheus', query: 'redis_connected_clients', name: 'Redis: Clients climbing' } })
  assert.match(fromTemplates, crumb)
  assert.ok(inputValues(fromTemplates).includes('Redis: Clients climbing'))
  assert.doesNotMatch(page({ incoming: { view: 'alertEditor', datasource: 'prometheus', query: 'redis_connected_clients' } }), crumb)
  assert.doesNotMatch(page(), crumb)
})

test('a template\'s rule says where it came from beside its sentence, and shows nothing more while it matches', () => {
  const t = RULE_TEMPLATES.find(x => x.id === 'services.error-rate-high')
  const html = page({ incoming: { view: 'alertEditor', ...templatePayload(t) } })
  // Where it came from, at the right of the sentence's line; the title for a screen reader.
  assert.match(html, /<div class="ae-head-line"><p class="ae-sentence"[\s\S]*?<\/p><p class="ae-head-from" id="ae-tpl-head" tabindex="-1">From template · APM · Services<span class="sr-only">: Error rate is high<\/span><\/p><\/div>/)
  assert.match(html, /<input class="ae-head-name"[^>]*value="Services: Error rate is high"\/>/, 'a template\'s rule arrives named')
  // While it matches, no block: only the live region that will announce moving off.
  assert.doesNotMatch(html, /<section class="ae-tpl"|ae-tpl-restore/, 'nothing to show or restore while it matches')
  assert.match(html, /<div class="sr-only" role="status"><\/div>/)
  const plain = page({ path: '/alerts/502/edit', ruleId: '502' })
  assert.doesNotMatch(plain, /ae-tpl|ae-head-from/, 'a rule from no template says nothing of one')
  // Moved off (here, a warning the template does not set): the block says so, and the head's line steps aside.
  const payload = templatePayload(t)
  const moved = page({ incoming: { view: 'alertEditor', ...payload, tiers: { ...payload.tiers, warning: { op: '>', threshold: 2 } } } })
  assert.match(moved, /<section class="ae-tpl" aria-label="Changed from the template">[\s\S]*?Warning threshold/)
  assert.doesNotMatch(moved, /ae-head-box|ae-sentence|ae-head-from/, 'the sentence box steps aside while the block speaks for the rule')
})

test('a Logs bar\'s Create Alert opens on Logs, counting its query', () => {
  const html = page({ incoming: { view: 'alertEditor', ...alertPayloadForQuery({ datasource: 'vlogs', query: 'log.level:="error"' }) } })
  assert.match(html, /role="tab" aria-selected="true" class="tab active">Logs</)
  assert.match(text(html), /log\.level:="error" \| stats count\(\)/)
  assert.doesNotMatch(text(html), /needs its query to end in a stats or math pipe/)
})
