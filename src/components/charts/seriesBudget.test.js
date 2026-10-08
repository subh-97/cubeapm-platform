// The series budget's rules: how many lines a chart draws at a width, and how
// "Show all" walks from there to everything.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { seriesCapForWidth, budgetView, nextDrawn, fixesAxis, SERIES_CHUNK, SERIES_CEILING } from './seriesBudget.js'

test('the cap grows with the chart, and an unmeasured chart gets the smallest', () => {
  assert.equal(seriesCapForWidth(0), 8, 'first paint, before the width is known')
  assert.equal(seriesCapForWidth(undefined), 8)
  assert.equal(seriesCapForWidth(360), 8, 'a third-width card')
  assert.equal(seriesCapForWidth(480), 12)
  assert.equal(seriesCapForWidth(620), 12, 'a half-width card')
  assert.equal(seriesCapForWidth(760), 20)
  assert.equal(seriesCapForWidth(1400), 20, 'a full-width chart never goes past twenty')
})

test('a chart under its cap draws everything and has nothing to say', () => {
  assert.deepEqual(budgetView({ total: 6, cap: 8 }), { count: 6, status: 'all' })
  assert.deepEqual(budgetView({ total: 8, cap: 8 }), { count: 8, status: 'all' })
  assert.deepEqual(budgetView({ total: 0, cap: 8 }), { count: 0, status: 'all' })
})

test('over the cap it draws the first N and holds the rest back', () => {
  assert.deepEqual(budgetView({ total: 64, cap: 8 }), { count: 8, status: 'capped' })
})

test('Show all starts from the cap, walks a chunk at a time, and lands on the total', () => {
  const total = 64
  const cap = 8
  let drawn = cap
  const steps = [budgetView({ total, cap, expanded: true, drawn })]
  while (steps.at(-1).status === 'drawing') {
    drawn = nextDrawn(drawn, total)
    steps.push(budgetView({ total, cap, expanded: true, drawn }))
  }
  assert.equal(steps[0].count, cap, 'the first frame of an expansion draws what the capped chart drew')
  assert.deepEqual(steps.map(s => s.count), [8, 18, 28, 38, 48, 58, 64])
  assert.equal(steps.at(-1).status, 'expanded')
  assert.ok(steps.slice(1).every((s, i) => s.count - steps[i].count <= SERIES_CHUNK), 'never more than a chunk per frame')
})

test('an expansion never draws fewer than the cap, even if the cap grew under it', () => {
  // The card widened mid-expansion: cap went 8 → 12 while drawn was still 8.
  assert.equal(budgetView({ total: 64, cap: 12, expanded: true, drawn: 8 }).count, 12)
})

test('a list that comes to fit under the cap drops the footer and the fixed axis, even after Show all', () => {
  // Show all on 10 Redis operations at cap 8, then the window widens to cap 12.
  const v = budgetView({ total: 10, cap: 12, expanded: true, drawn: 10 })
  assert.deepEqual(v, { count: 10, status: 'all' })
  assert.equal(fixesAxis(v.status), false, 'back to the automatic axis')
  // A search that matches nothing after Show all is not "Showing all 0".
  assert.deepEqual(budgetView({ total: 0, cap: 8, expanded: true, drawn: 24 }), { count: 0, status: 'all' })
})

test('the ceiling holds after Show all: a list that grows past it falls back to the cap', () => {
  // Show all on 150 search matches, then the search is cleared and 300 remain.
  assert.deepEqual(budgetView({ total: SERIES_CEILING + 100, cap: 20, expanded: true, drawn: 150 }), { count: 20, status: 'capped' })
  assert.equal(budgetView({ total: SERIES_CEILING, cap: 20, expanded: true, drawn: SERIES_CEILING }).status, 'expanded', 'exactly at the ceiling still draws')
})
