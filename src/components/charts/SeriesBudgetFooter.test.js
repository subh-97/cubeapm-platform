// The series budget's footer, read off the server-rendered markup: what it
// says and which of "Show 20 more" and "Show all" it offers in
// each state. The rules behind the offer are tested in seriesBudget.test.js.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server.browser'
import { createElement as h } from 'react'
import { budgetView, SERIES_CEILING } from './seriesBudget.js'
import SeriesBudgetFooter from './SeriesBudgetFooter.jsx'

const noop = () => {}
const handlers = { showMore: noop, showAll: noop, showFewer: noop }

function footer({ total, cap = 8, want = 0, drawn = 0 }, extra = handlers) {
  const view = budgetView({ total, cap, want, drawn })
  return renderToStaticMarkup(h(SeriesBudgetFooter, { budget: { ...view, cap, total, ...extra }, noun: 'hosts' }))
}

const buttons = html => [...html.matchAll(/<button type="button" class="series-budget-btn">([^<]*)<\/button>/g)].map(m => m[1])
const said = html => /<span aria-hidden="true">([^<]*)<\/span>/.exec(html)?.[1]

test('nothing held back, nothing said', () => {
  assert.equal(footer({ total: 6 }), '')
})

test('at the cap: the next twenty, or all of them', () => {
  const html = footer({ total: 64 })
  assert.equal(said(html), 'Showing 8 of 64 hosts')
  assert.deepEqual(buttons(html), ['Show 20 more', 'Show all'])
  assert.match(html, /<span class="sr-only" aria-live="polite">Showing 8 of 64 hosts<\/span>/)
})

test('twenty past the cap: twenty more, or all, and no way back', () => {
  const html = footer({ total: 64, want: 28, drawn: 28 })
  assert.equal(said(html), 'Showing 28 of 64 hosts')
  assert.deepEqual(buttons(html), ['Show 20 more', 'Show all'])
  assert.equal((html.match(/class="series-budget-sep"/g) ?? []).length, 1, 'a dot between the two')
})

test('twenty or fewer left: Show all alone stands for them', () => {
  assert.deepEqual(buttons(footer({ total: 64, want: 48, drawn: 48 })), ['Show all'])
})

test('all drawn: it says so and offers nothing', () => {
  const html = footer({ total: 64, want: Infinity, drawn: 64 })
  assert.equal(said(html), 'Showing all 64 hosts')
  assert.deepEqual(buttons(html), [])
  assert.doesNotMatch(html, /series-budget-actions/)
})

test('while a chart fills in it says so and offers nothing', () => {
  const html = footer({ total: 64, want: 28, drawn: 18 })
  assert.equal(said(html), 'Drawing 18 of 64 hosts…')
  assert.deepEqual(buttons(html), [])
  assert.match(html, /aria-live="polite">Drawing 28 of 64 hosts</, 'the announcement names where it is heading')
})

test('past the ceiling it steps up to it, then asks for a narrower query', () => {
  const total = SERIES_CEILING + 100
  assert.deepEqual(buttons(footer({ total })), ['Show 20 more'])
  const atCeiling = footer({ total, want: SERIES_CEILING, drawn: SERIES_CEILING })
  assert.deepEqual(buttons(atCeiling), [])
  assert.match(atCeiling, /Too many to draw at once\. Narrow the query to see the rest\./)
})

test('a collapsible footer offers Show less once more than the cap is shown, and only then', () => {
  const at = (view, extra) => buttons(renderToStaticMarkup(h(SeriesBudgetFooter, {
    budget: { ...budgetView({ total: 16, cap: 5, ...view }), cap: 5, total: 16, step: 5, ...handlers, ...extra },
    noun: 'lanes',
    collapsible: true,
  })))
  assert.deepEqual(at({}), ['Show 5 more', 'Show all'], 'at the cap there is nothing to take back')
  assert.deepEqual(at({ want: 10, drawn: 10 }), ['Show 5 more', 'Show all', 'Show less'])
  assert.deepEqual(at({ want: 15, drawn: 15 }), ['Show all', 'Show less'])
  assert.deepEqual(at({ want: Infinity, drawn: 16 }), ['Show less'], 'all of them, and the way back')
  assert.deepEqual(at({ want: Infinity, drawn: 16 }, { showFewer: undefined }), [], 'no handler, no button')
})

test('a budget offers only the actions it has handlers for', () => {
  // The error groups panel passes Show all, and no step.
  assert.deepEqual(buttons(footer({ total: 64 }, { showAll: noop })), ['Show all'])
  assert.doesNotMatch(footer({ total: 64, want: 28, drawn: 28 }), />Hide all</, 'no chart offers a way back')
})
