// Home's services table is the shared table (components/shared/SortableTable),
// as on the service, Infrastructure and Browser pages: its figure headers
// really sort, nothing in a row marks how bad it is, and each row carries one
// tag — the owning team — rather than every tag the service has. Rows still
// arrive worst first (CLAUDE.md rule 3), which the hint says.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server.browser'
import { MemoryRouter } from 'react-router-dom'
import { servicesForWindow } from '@/data/services'
import { resolveWindow } from '@/data/timeWindow'
import HomePage from './HomePage.jsx'

const RANGE = { kind: 'preset', value: '1h' }
const EXPECTED = /useLayoutEffect does nothing on the server/

function page() {
  const { error } = console
  console.error = (...args) => { if (!EXPECTED.test(String(args[0]))) error(...args) }
  try {
    return renderToStaticMarkup(
      <MemoryRouter><HomePage selectService={() => {}} timeRange={RANGE} setTimeRange={() => {}} /></MemoryRouter>,
    )
  } finally {
    console.error = error
  }
}

const html = page()
const table = html.slice(html.indexOf('<div class="table-scroll">'), html.indexOf('</table>'))
const rows = table.split('<tr').slice(2)
const services = servicesForWindow(resolveWindow(RANGE))

test('the services table is the shared table, its figure headers sorting', () => {
  assert.ok(table.startsWith('<div class="table-scroll"><table>'), 'drawn by SortableTable')
  const heads = [...table.matchAll(/<th(?:\s[^>]*)?>([\s\S]*?)<\/th>/g)].map(m => m[0])
  assert.equal(heads.length, 5)
  assert.match(heads[0], /^<th style="text-align:left">Service<\/th>$/, 'the name column does not reorder the list')
  for (const [i, label] of ['RPM', 'p90 Latency', 'Avg Latency', 'Error %'].entries()) {
    assert.match(heads[i + 1], new RegExp(`class="sortable-th"[\\s\\S]*<button type="button" class="sortable-th-btn">${label}</button>`), label)
  }
})

test('rows come worst first, and nothing in them marks how bad they are', () => {
  const names = rows.map(r => r.match(/<td class="mono"[^>]*><span class="infra-name-cell"><span>([^<]+)<\/span>/)?.[1])
  assert.deepEqual(names, services.map(s => s.name))
  assert.equal(names[0], 'payment-service')
  for (const r of rows) {
    assert.doesNotMatch(r, /status-dot|class="badge|val-critical|val-warning|svc-lang/)
  }
  assert.match(html, /Sorted by severity - critical first/)
})

test('each row carries its team tag only; the other tags stay searchable', () => {
  for (const [i, r] of rows.entries()) {
    const keys = [...r.matchAll(/<span class="svc-tag-k">([^<]+)<\/span>/g)].map(m => m[1])
    assert.deepEqual(keys, services[i].tags?.team ? ['team'] : [], services[i].name)
  }
})
