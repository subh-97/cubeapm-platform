// The series budget's rules: how many lines a chart draws at a width, how
// "Show 20 more" and "Show all" walk from there, and what the footer offers.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { seriesCapForWidth, budgetView, budgetOffer, nextDrawn, fixesAxis, SERIES_CHUNK, SERIES_CEILING, SERIES_STEP } from './seriesBudget.js'

test('the cap grows with the chart, and an unmeasured chart gets the smallest', () => {
  assert.equal(seriesCapForWidth(0), 8, 'first paint, before the width is known')
  assert.equal(seriesCapForWidth(undefined), 8)
  assert.equal(seriesCapForWidth(360), 8, 'a third-width card')
  assert.equal(seriesCapForWidth(480), 12)
  assert.equal(seriesCapForWidth(620), 12, 'a half-width card')
  assert.equal(seriesCapForWidth(760), 20)
  assert.equal(seriesCapForWidth(1400), 20, 'a full-width chart never goes past twenty')
})

const view = (args) => {
  const { count, status } = budgetView(args)
  return { count, status }
}

// Walk a request the way the hook does, a chunk per frame, and return every
// count drawn on the way.
function walk({ total, cap, want, drawn = cap }) {
  const steps = [budgetView({ total, cap, want, drawn })]
  while (steps.at(-1).status === 'drawing') {
    drawn = nextDrawn(Math.max(cap, drawn), steps.at(-1).target)
    steps.push(budgetView({ total, cap, want, drawn }))
  }
  return steps
}

test('a chart under its cap draws everything and has nothing to say', () => {
  assert.deepEqual(view({ total: 6, cap: 8 }), { count: 6, status: 'all' })
  assert.deepEqual(view({ total: 8, cap: 8 }), { count: 8, status: 'all' })
  assert.deepEqual(view({ total: 0, cap: 8 }), { count: 0, status: 'all' })
})

test('over the cap it draws the first N and holds the rest back', () => {
  assert.deepEqual(view({ total: 64, cap: 8 }), { count: 8, status: 'capped' })
})

test('Show 20 more adds twenty to what is drawn, a chunk at a time, and settles there', () => {
  const steps = walk({ total: 64, cap: 8, want: 8 + SERIES_STEP })
  assert.deepEqual(steps.map(s => s.count), [8, 18, 28])
  assert.equal(steps.at(-1).status, 'capped', 'settled with the rest still held back')
  assert.equal(steps.at(-1).target, 28)
  // A second press builds on the first.
  assert.deepEqual(walk({ total: 64, cap: 8, want: 48, drawn: 28 }).map(s => s.count), [28, 38, 48])
  // The last step stops at the list.
  assert.deepEqual(walk({ total: 64, cap: 8, want: 68, drawn: 48 }).map(s => [s.count, s.status]), [[48, 'drawing'], [58, 'drawing'], [64, 'expanded']])
})

test('Show all starts from what is drawn, walks a chunk at a time, and lands on the total', () => {
  const steps = walk({ total: 64, cap: 8, want: Infinity })
  assert.equal(steps[0].count, 8, 'the first frame of an expansion draws what the capped chart drew')
  assert.deepEqual(steps.map(s => s.count), [8, 18, 28, 38, 48, 58, 64])
  assert.equal(steps.at(-1).status, 'expanded')
  assert.ok(steps.slice(1).every((s, i) => s.count - steps[i].count <= SERIES_CHUNK), 'never more than a chunk per frame')
  // From a chart already twenty past its cap, nothing is redrawn.
  assert.equal(walk({ total: 64, cap: 8, want: Infinity, drawn: 28 })[0].count, 28)
})

test('a reset by the page is the cap again', () => {
  assert.deepEqual(view({ total: 64, cap: 8, want: 0, drawn: 0 }), { count: 8, status: 'capped' })
})

test('a request never draws fewer than the cap, even if the cap grew under it', () => {
  // The card widened mid-expansion: cap went 8 → 12 while drawn was still 8.
  assert.equal(budgetView({ total: 64, cap: 12, want: Infinity, drawn: 8 }).count, 12)
  // Twenty more asked at cap 8, then the card widened to cap 20: 28 holds.
  assert.equal(budgetView({ total: 64, cap: 20, want: 28, drawn: 28 }).count, 28)
  // A request below the new cap is the cap.
  assert.equal(budgetView({ total: 64, cap: 20, want: 12, drawn: 12 }).count, 20)
})

test('a list that comes to fit under the cap drops the footer and the fixed axis, even after Show all', () => {
  // Show all on 10 Redis operations at cap 8, then the window widens to cap 12.
  const v = budgetView({ total: 10, cap: 12, want: Infinity, drawn: 10 })
  assert.deepEqual({ count: v.count, status: v.status }, { count: 10, status: 'all' })
  assert.equal(fixesAxis(v.status), false, 'back to the automatic axis')
  // A search that matches nothing after Show all is not "Showing all 0".
  assert.deepEqual(view({ total: 0, cap: 8, want: Infinity, drawn: 24 }), { count: 0, status: 'all' })
})

test('the ceiling holds whatever was pressed: no chart draws more than it', () => {
  // Show all on 150 search matches, then the search is cleared and 300 remain.
  const v = budgetView({ total: SERIES_CEILING + 100, cap: 20, want: Infinity, drawn: 150 })
  assert.equal(v.target, SERIES_CEILING)
  assert.equal(v.limit, SERIES_CEILING)
  assert.equal(walk({ total: SERIES_CEILING + 100, cap: 20, want: Infinity, drawn: 150 }).at(-1).count, SERIES_CEILING)
  assert.equal(budgetView({ total: SERIES_CEILING, cap: 20, want: Infinity, drawn: SERIES_CEILING }).status, 'expanded', 'exactly at the ceiling still draws')
})

test('the footer offers twenty more, all, and the way back, as each applies', () => {
  const offer = args => {
    const v = budgetView(args)
    const { more, all, fewer } = budgetOffer({ ...v, total: args.total, cap: args.cap })
    return { more, all, fewer }
  }
  // At the cap: the next twenty, or everything.
  assert.deepEqual(offer({ total: 64, cap: 8 }), { more: 20, all: true, fewer: false })
  // Twenty past it: both again, and back to the cap.
  assert.deepEqual(offer({ total: 64, cap: 8, want: 28, drawn: 28 }), { more: 20, all: true, fewer: true })
  // Twenty or fewer left: "Show 16 more" would be "Show all" twice over.
  assert.deepEqual(offer({ total: 64, cap: 8, want: 48, drawn: 48 }), { more: 0, all: true, fewer: true })
  assert.deepEqual(offer({ total: 28, cap: 8 }), { more: 0, all: true, fewer: false })
  // Everything drawn: only the way back.
  assert.deepEqual(offer({ total: 64, cap: 8, want: Infinity, drawn: 64 }), { more: 0, all: false, fewer: true })
  // While a chart is filling in, nothing new is offered.
  assert.deepEqual(offer({ total: 64, cap: 8, want: 28, drawn: 18 }), { more: 0, all: false, fewer: false })
})

test('past the ceiling the footer steps up to it, never offers Show all, and stops there', () => {
  const total = SERIES_CEILING + 100
  const at = (want, drawn) => {
    const v = budgetView({ total, cap: 20, want, drawn })
    return budgetOffer({ ...v, total, cap: 20 })
  }
  assert.deepEqual(at(0, 0), { more: 20, all: false, fewer: false, tooMany: true })
  assert.deepEqual(at(190, 190), { more: 10, all: false, fewer: true, tooMany: true }, 'the last step is what is left below the ceiling')
  assert.deepEqual(at(SERIES_CEILING, SERIES_CEILING), { more: 0, all: false, fewer: true, tooMany: true })
})

test('a list that borrows the footer with no budget behind it is never cut off by the chart ceiling', () => {
  // The error groups panel: no cap of its own and no ceiling, so Show all
  // stays on offer however long the list. It passes no showMore, so the footer
  // draws Show all and not the step.
  assert.deepEqual(budgetOffer({ status: 'capped', count: 10, total: 500 }), { more: 20, all: true, fewer: false, tooMany: false })
  assert.equal(budgetOffer({ status: 'expanded', count: 500, total: 500 }).fewer, true)
})
