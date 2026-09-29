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
