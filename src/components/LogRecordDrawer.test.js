// Renders the drawer for every seeded record shape, on both tabs.
//
// This exists because a prop rename left the JSON view passing the old shape
// to LinkMarker, which threw and blanked the drawer. Every code path here was
// reachable by clicking; none was reachable by reading the Overview tab alone.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server.browser'
import { createElement } from 'react'
import { LogRecordDrawer } from '@/components/LogRecordDrawer'
import { logRows } from '@/data/observability'
import { recordType } from '@/utils/logFields'

const noop = () => {}
const SHAPES = ['k8s-event', 'db-span', 'exception', 'request', 'k8s-log']

const render = (record, extra = {}) => renderToStaticMarkup(createElement(LogRecordDrawer, {
  record,
  onClose: noop,
  searchTerms: [],
  onAddChip: noop,
  onDistribution: noop,
  onCopy: noop,
  index: 1,
  total: logRows.length,
  onNavigate: noop,
  pinned: [],
  onTogglePin: noop,
  ...extra,
}))

// The drawer keeps its tab in local state, so the JSON view is reached by
// rendering every row of it directly rather than by simulating a click.
test('every seeded shape renders on the Overview tab', () => {
  for (const shape of SHAPES) {
    const record = logRows.find(r => recordType(r) === shape)
    assert.ok(record, `no seeded record of shape ${shape}`)
    const html = render(record)
    assert.match(html, /log-detail/, `${shape} produced no drawer markup`)
  }
})

test('every single seeded record renders without throwing', () => {
  for (const record of logRows) {
    assert.doesNotThrow(() => render(record), `record ${record.id} threw`)
  }
})

test('a pinned field renders on every shape', () => {
  for (const shape of SHAPES) {
    const record = logRows.find(r => recordType(r) === shape)
    const key = Object.keys(record.tags)[0]
    assert.doesNotThrow(() => render(record, { pinned: [key] }), `${shape} threw with a pin`)
  }
})

// The JSON tab is where the prop rename actually broke. It sits behind local
// state, so the drawer takes an initial view and the test opens on it - a
// suite that only ever renders the default tab is how the bug shipped.
test('every seeded shape renders on the JSON tab', () => {
  for (const shape of SHAPES) {
    const record = logRows.find(r => recordType(r) === shape)
    const html = render(record, { initialView: 'json' })
    assert.match(html, /log-json/, `${shape} produced no JSON markup`)
  }
})

test('every single seeded record renders on the JSON tab without throwing', () => {
  for (const record of logRows) {
    assert.doesNotThrow(() => render(record, { initialView: 'json' }), `record ${record.id} threw`)
  }
})

test('the JSON tab decorates linkable values, and only those', () => {
  const record = logRows.find(r => recordType(r) === 'db-span')
  const html = render(record, { initialView: 'json' })
  assert.match(html, /log-link-hint/, 'no link markers in the JSON view')
  // A span id filters and a trace id opens, so both kinds must appear.
  assert.match(html, /log-link-hint is-filter/, 'filter markers missing from the JSON view')
})

// A page's own tabs come after Overview and JSON, render the body themselves,
// and only exist where the page offers them: Logs offers none, so its drawer is
// unchanged, and a view no page offers reads as Overview.
test('a page\'s tab sits after JSON, draws its own body, and is absent where not offered', () => {
  const record = logRows[0]
  const seen = []
  const tabs = [{ id: 'extra', label: 'Extra', render: rec => { seen.push(rec); return createElement('div', { className: 'extra-body' }, 'extra body') } }]
  const strip = html => [...html.matchAll(/role="tab" aria-selected="(true|false)"[^>]*>([^<]+)</g)].map(m => `${m[2]}${m[1] === 'true' ? '*' : ''}`)

  const onExtra = render(record, { tabs, initialView: 'extra' })
  assert.deepEqual(strip(onExtra), ['Overview', 'JSON', 'Extra*'])
  assert.match(onExtra, /class="extra-body"/)
  assert.equal(seen[0], record, 'the tab is handed the record on screen')
  assert.doesNotMatch(onExtra, /log-detail-search|Copy JSON/, 'Overview\'s search and JSON\'s copy stay on their own tabs')

  assert.deepEqual(strip(render(record, { tabs })), ['Overview*', 'JSON', 'Extra'])
  // Without the tab on offer, asking for it opens Overview.
  const plain = render(record, { initialView: 'extra' })
  assert.deepEqual(strip(plain), ['Overview*', 'JSON'])
  assert.doesNotMatch(plain, /extra body/)
})

test('a page can size its drawer with a class beside log-detail; without one it is log-detail alone', () => {
  assert.match(render(logRows[0], { className: 'trace-drawer' }), /<aside class="log-detail trace-drawer">/)
  assert.match(render(logRows[0]), /<aside class="log-detail">/)
})

// A page can ask for a tab as it opens the drawer: Traces opens a row's
// trace_id on the Waterfall. A request no tab answers, or none, opens Overview.
test('a page\'s request for a tab opens the drawer on it', () => {
  const record = logRows[0]
  const tabs = [{ id: 'extra', label: 'Extra', render: () => createElement('div', { className: 'extra-body' }) }]
  const strip = html => [...html.matchAll(/role="tab" aria-selected="(true|false)"[^>]*>([^<]+)</g)].map(m => `${m[2]}${m[1] === 'true' ? '*' : ''}`)
  assert.deepEqual(strip(render(record, { tabs, viewRequest: { view: 'extra' } })), ['Overview', 'JSON', 'Extra*'])
  assert.deepEqual(strip(render(record, { tabs, viewRequest: null })), ['Overview*', 'JSON', 'Extra'])
  assert.deepEqual(strip(render(record, { viewRequest: { view: 'extra' } })), ['Overview*', 'JSON'])
})
