// The Browser page's Errors and Traces tabs, rendered over real data from the
// data layer: what each kind's rows say, the cap and its footer, the hint
// that a row opens its traces, the "N results" control, and the empty list
// that names the filters which emptied it. Clicks (a row's hand-off, a row
// picked, the modal) need a DOM and are checked in the running page.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server.browser'
import { REFERENCE_WINDOW } from '@/data/timeWindow'
import {
  BROWSER_APPS, BROWSER_SOURCE_MAP_SEED, browserErrorGroupsForWindow, browserEndpointOptions, browserTracesForWindow,
} from '@/data/browser'
import { fmtLoadTime } from '@/components/charts/chartDefaults'
import BrowserErrorsTab from './BrowserErrorsTab.jsx'
import BrowserTracesTab from './BrowserTracesTab.jsx'

const noop = () => {}
const html = el => renderToStaticMarkup(el)
const win = REFERENCE_WINDOW
const timeRange = { kind: 'preset', value: '1h' }
const app = BROWSER_APPS.find(a => a.id === 'cubedemo-web')
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#x27;').replace(/"/g, '&quot;')
const count = (s, re) => (s.match(re) ?? []).length

const errorsTab = kind => html(
  <BrowserErrorsTab
    app={app} win={win} timeRange={timeRange} syncId="rum-errors" onFocus={noop}
    kind={kind} onKind={noop} onOpenTraces={noop}
    sourceMaps={BROWSER_SOURCE_MAP_SEED} onOpenSourceMaps={noop}
  />,
)

const tracesTab = props => html(
  <BrowserTracesTab
    app={app} win={win} kind="server" endpoint="" error=""
    onOpenTrace={noop} onClearFilters={noop}
    sourceMaps={BROWSER_SOURCE_MAP_SEED} onOpenSourceMaps={noop}
    {...props}
  />,
)

test('Errors, Script: the first ten groups, class buttons, and the footer offering the rest', () => {
  const groups = browserErrorGroupsForWindow(win, app.id, 'server')
  assert.ok(groups.length > 10)
  const out = errorsTab('server')
  // The toggle reads production's words, Script on.
  assert.match(out, /class="seg active" role="button" tabindex="0" aria-pressed="true">Script</)
  assert.match(out, /class="seg" role="button" tabindex="0" aria-pressed="false">Ajax</)
  assert.match(out, /placeholder="Search pages or errors…"/)
  assert.match(out, /<span class="hint">Click a row to see its traces<\/span>/)
  assert.equal(count(out, /class="err-row is-clickable"/g), 10)
  assert.equal(count(out, /<button type="button" class="err-exc-cls"/g), 10)
  assert.ok(out.includes(`Showing 10 of ${groups.length} error groups`))
  // Rows in the data's order (count desc), each under its route, which is the
  // row's button for the keyboard, named for where it goes.
  for (const g of groups.slice(0, 10)) {
    assert.ok(out.includes(`<div class="err-endpoint" title="${esc(g.endpoint)}"><button type="button" class="err-open" aria-label="${esc(`See traces for ${g.endpoint}, ${g.exception}`)}">`), g.endpoint)
    assert.ok(out.includes(`<span class="err-exc-msg" title="${esc(g.message)}">${esc(g.message)}</span>`), g.message)
  }
  // No hand-off to the Errors page: it has no browser rows.
  assert.doesNotMatch(out, /Open in Errors/)
})

test('Errors, Ajax: a status chip and its reason, nothing to open but the row', () => {
  const groups = browserErrorGroupsForWindow(win, app.id, 'client')
  const out = errorsTab('client')
  assert.match(out, /class="seg active" role="button" tabindex="0" aria-pressed="true">Ajax</)
  assert.match(out, /placeholder="Search endpoints or status codes…"/)
  assert.doesNotMatch(out, /class="err-exc-cls/)
  assert.equal(count(out, /class="err-row is-clickable"/g), Math.min(10, groups.length))
  const top = groups[0]
  const cls = Number(top.exception) >= 500 ? 'is-5xx' : 'is-4xx'
  assert.ok(out.includes(`<span class="tw-code ${cls}">${top.exception}</span>`), top.exception)
  assert.ok(out.includes(`<span class="errp-code-reason">${top.message}</span>`), top.message)
  // The Endpoint column is the call, spelled as the Traces tab's filter lists it.
  const options = browserEndpointOptions(app.id, 'client')
  for (const g of groups.slice(0, 10)) assert.ok(options.includes(g.endpoint), g.endpoint)
  // Drawn with a break after every '/', so a long call wraps between its
  // segments, never inside one; its text is still the call.
  const [first] = groups
  const drawn = new RegExp(`class="err-open"[^>]*>(.*?)</button>`).exec(out)?.[1] ?? ''
  assert.equal(drawn.replace(/<[^>]+>/g, ''), esc(first.endpoint))
  assert.equal(count(drawn, /<wbr\/>/g), count(first.endpoint, /\//g))
})

test('Traces: the newest ten, page loads said as such, the results picker in the head', () => {
  const rows = browserTracesForWindow(win, app.id, { kind: 'server', limit: 10 })
  assert.equal(rows.length, 10)
  const out = tracesTab()
  assert.match(out, /<div class="panel-head-left">Traces<\/div>/)
  // Sort by None (the query's own newest-first order) is the default.
  assert.match(out, /class="seg active" role="button" tabindex="0" aria-pressed="true">None</)
  assert.match(out, /<button type="button" class="title-dropdown brw-limit" aria-label="10 results: how many requests to list" aria-haspopup="listbox" aria-expanded="false"><span>10 results<\/span>/)
  assert.equal(count(out, /class="slowreq-row"/g), 10)
  for (const r of rows) {
    assert.ok(out.includes(`<div class="meta">Page load · ${r.timestamp}</div>`), r.traceId)
    assert.ok(out.includes(`<div class="dur">${fmtLoadTime(r.latencyMs)}</div>`), r.traceId)
  }
  assert.match(out, /Select a request to see its details/)
})

test('Traces: the production links list their rows, a call by its answer (its method is in its name)', () => {
  const ajax = tracesTab({ kind: 'client', endpoint: 'GET search.cubedemo.com:443/v1/search/wealth', error: '404' })
  const ajaxRows = browserTracesForWindow(win, app.id, { kind: 'client', endpoint: 'GET search.cubedemo.com:443/v1/search/wealth', error: '404', limit: 10 })
  assert.ok(ajaxRows.length > 0)
  assert.equal(count(ajax, /class="slowreq-row"/g), ajaxRows.length)
  assert.ok(ajax.includes(`<div class="meta">HTTP 404 · ${ajaxRows[0].timestamp}</div>`))
  assert.doesNotMatch(ajax, /<div class="meta">GET · /)

  const script = tracesTab({ kind: 'server', endpoint: '/account/:userId/wishlist', error: 'TypeError' })
  assert.ok(count(script, /class="slowreq-row"/g) > 0)
  assert.doesNotMatch(script, /errp-empty/)
})

test('Traces: an emptied list names the filters and range, and offers to clear them', () => {
  // A script error on a route that does not throw it: a real filter pair with
  // nothing behind it.
  const out = tracesTab({ kind: 'server', endpoint: '/no/such/route', error: 'TypeError' })
  assert.doesNotMatch(out, /slowreq-split/)
  assert.match(out, /<div class="errp-empty-title">No traces match these filters<\/div>/)
  for (const [k, v] of [['type', 'Script'], ['endpoint', '/no/such/route'], ['error', 'TypeError'], ['range', win.label]]) {
    assert.ok(out.includes(`<span>${k}</span><span class="v">${esc(v)}</span>`), k)
  }
  assert.match(out, /<button type="button" class="search-empty-clear">Clear filters<\/button>/)
  // The head stays, so the sort and the count are still there to change.
  assert.match(out, /title-dropdown brw-limit/)
})

test('Traces: rows that would share a minute say their second, and a place comes back', () => {
  // A hundred samples of an hour are 36 seconds apart: minutes repeat.
  const rows = browserTracesForWindow(win, app.id, { kind: 'server', limit: 100 })
  assert.ok(new Set(rows.map(r => r.timestamp)).size < rows.length, 'the data does repeat minutes')
  const out = tracesTab({ place: { limit: 100, selected: rows[3].traceId } })
  assert.equal(count(out, /class="slowreq-row[^"]*"/g), 100)
  assert.match(out, /<div class="meta">Page load · [A-Z][a-z]{2} \d{2}, \d{2}:\d{2}:\d{2}<\/div>/)
  // The restored count and pick, the pick previewed.
  assert.match(out, /<span>100 results<\/span>/)
  assert.ok(out.includes(`Trace ID · <span class="mono">${rows[3].traceId}</span>`))
  // The preview stays in view beside a long list.
  assert.match(out, /<div class="brw-traces"><div class="panel rts-sticky">/)
  // A place that is not one of the counts on offer falls back to ten.
  assert.match(tracesTab({ place: { limit: 7 } }), /<span>10 results<\/span>/)
})
