// The Rules tab rendered from a URL the way a cold load renders it, over the
// seed (docs/alerts/PLAN.md P2 "Done when": the payment incident is the first
// thing on the page, a snoozed or paused rule is distinguishable from an OK
// one without expanding anything, and no control is icon-only).
//
// What a click or a key does needs a DOM and is checked in the running page;
// the contracts behind them are tested beside the pure modules here.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server.browser'
import { MemoryRouter } from 'react-router-dom'
import { resolveWindow } from '@/data/timeWindow'
import { parseAlertsSearch } from '@/utils/alertsUrl'
import { seededAlerts, quietAlerts, emptyAlerts } from './fixtures.js'
import RulesTab from './RulesTab.jsx'

const noop = () => {}
const hour = resolveWindow({ kind: 'preset', value: '1h' })

// A server render's own warnings (BrowserView.test.js says the same): menus
// and selects settle in layout effects a server render skips.
const EXPECTED = /useLayoutEffect does nothing on the server/
function page(search = '', { alerts = seededAlerts(hour), ...props } = {}) {
  const { warn, error } = console
  const quiet = log => (...args) => { if (!EXPECTED.test(String(args[0]))) log(...args) }
  console.warn = quiet(warn)
  console.error = quiet(error)
  try {
    return renderToStaticMarkup(
      <MemoryRouter initialEntries={[`/alerts${search}`]}>
        <RulesTab
          win={hour} alerts={alerts} url={parseAlertsSearch(search)} onUrlChange={noop}
          onOpenLink={noop} setToast={noop} setTimeRange={noop} {...props}
        />
      </MemoryRouter>,
    )
  } finally {
    Object.assign(console, { warn, error })
  }
}

const rowIds = html => [...html.matchAll(/class="rtab-rule[^"]*" id="[^"]+" data-rule-id="([^"]+)"/g)].map(m => m[1])
const ENTITIES = { '&#x27;': '\'', '&amp;': '&', '&gt;': '>', '&lt;': '<', '&quot;': '"' }
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&amp;|&gt;|&lt;|&quot;/g, e => ENTITIES[e]).replace(/\s+/g, ' ').trim()
const attr = (tag, name) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1] ?? null

test('above the rules: the timeline, with no title, state pills, banner or "Updated" line', () => {
  // The State facet's counts and the first row already say what is
  // firing now, so the band does not say it again; how old the data is sits
  // in the page bar beside Auto (AlertsView.test).
  const html = page()
  const band = html.slice(0, html.indexOf('class="rtab-frame"'))
  assert.match(band, /class="panel rtab-tl is-collapsed"/, 'the timeline is there while something fires, folded to its head')
  assert.match(band, /<button type="button" class="panel-head rtab-tl-head" aria-expanded="false"/)
  for (const gone of [/Firing now/, /summary-pill/, /rtab-banner/, /state as of now/, /Updated /]) assert.doesNotMatch(band, gone)
  assert.equal(rowIds(html)[0], '501', 'the payment incident leads the rules instead')
})

test('rows come worst first, under groups ordered by their worst rule', () => {
  const html = page()
  const ids = rowIds(html)
  assert.equal(ids[0], '501')
  assert.ok(ids.indexOf('501') < ids.indexOf('503'), 'firing before pending')
  assert.ok(ids.indexOf('513') < ids.indexOf('507'), 'a rule error before a snoozed rule that fires')
  assert.ok(ids.indexOf('507') < ids.indexOf('426'), 'which comes before OK')
  const heads = [...html.matchAll(/class="rtab-group-toggle"[^>]*>[\s\S]*?<span>([^<]+)<\/span>/g)].map(m => m[1])
  assert.deepEqual(heads.slice(0, 2), ['Payments', 'Infrastructure'])
})

test('a snoozed rule and a paused one read as such without expanding anything', () => {
  const html = page()
  const row = id => html.slice(html.indexOf(`data-rule-id="${id}"`), html.indexOf('class="rtab-rule-actions"', html.indexOf(`data-rule-id="${id}"`)))
  assert.match(row('507'), /class="alr-chip suppressed"[^>]*>[\s\S]*?Snoozed · \d+m left/)
  assert.match(row('507'), /Warning/, 'snoozed, and still Warning (D10)')
  assert.doesNotMatch(html, /data-rule-id="427"/, 'paused rules are folded away')
  const folds = html.match(/<button type="button" class="rtab-fold" aria-expanded="false">[\s\S]*?<\/button>/g) ?? []
  assert.equal(folds.length, 2, 'one line per group with paused rules')
  assert.ok(folds.every(f => /2 paused rules/.test(text(f))))
})

test('every control carries a label: no button, link or menu is icon-only', () => {
  const html = page('?rule_id=501')
  const buttons = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)]
  assert.ok(buttons.length > 40)
  for (const [, attrs, inner] of buttons) {
    const named = text(inner).length > 0 || /aria-label="[^"]+"/.test(attrs)
    assert.ok(named, `unlabelled button: <button${attrs}>${inner.slice(0, 80)}`)
  }
  const toggles = [...html.matchAll(/<button type="button" class="rtab-rule-toggle"[^>]*>/g)].map(m => m[0])
  assert.ok(toggles.every(t => /aria-label="Details for [^"]+"/.test(t) && /aria-expanded="(true|false)"/.test(t)))
  for (const [, attrs, inner] of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)) {
    assert.ok(text(inner).length > 0 || /aria-label="[^"]+"/.test(attrs), `unlabelled link: <a${attrs}>`)
  }
  const menus = html.match(/class="hbtn small alr-menu-btn[^"]*"[\s\S]*?<\/button>/g) ?? []
  assert.ok(menus.some(m => /Snooze/.test(text(m))) && menus.some(m => /Actions/.test(text(m))))
  for (const div of html.match(/<div[^>]*role="button"[^>]*>/g) ?? []) assert.ok(attr(div, 'title'), div)
})

test('rule_id opens its rule in place, with its settings, snoozes and alerts', () => {
  const html = page('?rule_id=507')
  const toggle = html.match(/<button type="button" class="rtab-rule-toggle"[^>]*aria-label="Details for shipment-service p90 latency"[^>]*>/)?.[0]
  assert.equal(attr(toggle, 'aria-expanded'), 'true')
  const panelId = attr(toggle, 'aria-controls')
  const panel = html.slice(html.indexOf(`id="${panelId}"`))
  assert.match(panel, /role="region" aria-label="shipment-service p90 latency: details"/)
  const words = text(panel.slice(0, panel.indexOf('class="rtab-d-foot"') + 2000))
  for (const w of ['Check every 1m', 'Fire after 5m', 'Unsnooze', 'Last evaluated', '1 alert', 'Traces', 'Logs', 'Open rule', 'Notification history', 'Open in Explore']) {
    assert.ok(words.includes(w), w)
  }
  assert.equal((html.match(/aria-expanded="true" aria-controls="rtab-rule-/g) ?? []).length, 1, 'only that one is open')
})

test('an alert counts "Firing" from when it fired, matching its rule, not from when it began pending', () => {
  // The instance's activeAt is when it went pending; five minutes later it
  // fired. Counting from activeAt made the instance read "Firing 20m" under a
  // rule reading "Firing 15m".
  const html = page('?rule_id=501')
  const toggle = html.match(/<button type="button" class="rtab-rule-toggle"[^>]*aria-label="Details for payment-service error rate"[^>]*>/)?.[0]
  const panelId = attr(toggle, 'aria-controls')
  const at = html.indexOf(`id="${panelId}"`)
  const row = text(html.slice(html.lastIndexOf('class="rtab-rule', html.indexOf(toggle)), at))
  const panel = text(html.slice(at, html.indexOf('class="rtab-d-foot"', at)))
  const ruleSince = row.match(/Firing (\d+[a-z]+(?: \d+[a-z]+)?)/)?.[1]
  const alertSince = panel.match(/Firing (\d+[a-z]+(?: \d+[a-z]+)?)/)?.[1]
  assert.ok(ruleSince, 'the rule says how long it has fired')
  assert.equal(alertSince, ruleSince)
})

test('an alert on a host offers that host, beside the evidence its labels reach', () => {
  const html = page('?rule_id=515')
  const toggle = html.match(/<button type="button" class="rtab-rule-toggle"[^>]*aria-label="Details for CPU high on ‹host\.name›"[^>]*>/)?.[0]
  const at = html.indexOf(`id="${attr(toggle, 'aria-controls')}"`)
  const panel = html.slice(at, html.indexOf('class="rtab-d-foot"', at))
  const alerts = [...panel.matchAll(/<div class="rtab-inst-row">([\s\S]*?)<div class="rtab-inst-links">([\s\S]*?)<\/div>/g)]
  assert.equal(alerts.length, 3, 'one alert per host')
  for (const [, row, links] of alerts) {
    const host = /title="host\.name: ([^"]+)"/.exec(row)?.[1]
    assert.ok(host, 'the alert names its host')
    const ways = [...links.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].map(([, attrs, inner]) => ({ attrs, text: text(inner) }))
    assert.deepEqual(ways.map(w => w.text), ['Host'], 'no service, so no Traces or Logs')
    assert.equal(attr(ways[0].attrs, 'title'), `Open ${host} on Infrastructure`)
  }
})

test('rule_id of a paused rule opens its group\'s fold to show it', () => {
  const html = page('?rule_id=427')
  assert.match(html, /data-rule-id="427"/)
  assert.match(html, /aria-label="Synthetic down - Marketing Site: details"/)
  assert.match(html, /Never evaluated/)
})

test('one stale line however many refreshes failed, and the data stays', () => {
  const html = page('', { stale: { since: hour.nowSec - 300 }, onRetry: noop })
  assert.equal((html.match(/Couldn&#x27;t refresh, showing data from \d\d:\d\d/g) ?? []).length, 1)
  assert.match(html, />Retry<\/button>/)
  assert.ok(rowIds(html).length > 10, 'the last good rows are still listed')
})

test('loading draws skeletons in the rows\' and band\'s own shapes, and nothing else', () => {
  const html = page('', { loading: true })
  assert.ok((html.match(/ovsk-bone/g) ?? []).length > 20)
  assert.equal(rowIds(html).length, 0)
  assert.doesNotMatch(html, /rtab-banner/)
  assert.doesNotMatch(html, /rtab-controls/)
})

test('no rules at all says what goes here and offers a start from a service', () => {
  const html = page('', { alerts: emptyAlerts(hour) })
  assert.match(html, /No alert rules yet/)
  assert.match(html, /Start from a service/)
  assert.match(text(html), /payment-service Error % > 3% critical, > 1% warning, for 5m/)
  assert.match(html, />New rule<\/button>/)
})

test('filters that match nothing name themselves, a seeded value at 0 included, with Clear', () => {
  const html = page('?state=error&svc=no-such-service')
  assert.match(html, /No rules match these filters/)
  const filters = text(html.match(/<ul class="rtab-empty-list" aria-label="Active filters">[\s\S]*?<\/ul>/)?.[0] ?? '')
  assert.equal(filters, 'State Rule error · 1 Service no-such-service · 0')
  assert.match(html, /class="search-empty-clear">Clear filters</)
  assert.match(html, /title="no-such-service">no-such-service<\/span><span class="facet-opt-count">0</, 'the rail keeps the seeded value at 0')
})

test('a calm day is one line, with the timeline closed until asked for', () => {
  const html = page('', { alerts: quietAlerts(hour) })
  assert.match(html, /Nothing firing · no alert fired in the last 1 hour/)
  assert.doesNotMatch(html, /rtab-banner/)
  assert.doesNotMatch(html, /class="panel rtab-tl"/)
})

test('the toolbar is the search alone: a rule starts from the banners above; no Group by', () => {
  const html = page()
  const bar = html.slice(html.indexOf('<div class="rtab-toolbar">'), html.indexOf('<div class="rtab-groups"'))
  assert.doesNotMatch(bar, /<button|New rule/)
  assert.doesNotMatch(bar, /Group by|filter-select/)
  assert.match(html, /<section class="rtab-slot rtab-create is-scratch"[\s\S]*?<\/svg>Create rule<\/button>/)
  // An old link's grouping is read past: the groups are still the rules' own.
  const heads = h => [...h.matchAll(/class="rtab-group-toggle"[^>]*>[\s\S]*?<span>([^<]+)<\/span>/g)].map(m => m[1])
  for (const g of ['service', 'contact', 'none']) assert.deepEqual(heads(page(`?group_by=${g}`)), heads(html), g)
  assert.ok(!heads(html).includes('No service'))
})

test('a link\'s search arrives in the search box and filters the list', () => {
  const html = page('?q=redis')
  assert.match(html, /<input type="text"[^>]*value="redis"/)
  assert.deepEqual(rowIds(html), ['514'])
})

test('nothing sits between the toolbar and the rules, and rows are not selectable', () => {
  const html = page()
  const between = html.slice(html.indexOf('<div class="rtab-toolbar">'), html.indexOf('<div class="rtab-groups"'))
  assert.doesNotMatch(between, /rtab-controls|rules · |Select all/)
  assert.doesNotMatch(html, /data-row-select|type="checkbox" class="rtab-check"/)
})
