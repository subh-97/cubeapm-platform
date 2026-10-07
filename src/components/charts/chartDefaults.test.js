// niceAxis picks the round ticks a fixed-scale chart draws. The rule worth
// pinning is that it never picks a step the chart's own formatter misprints.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { niceAxis, formatDecimals } from './chartDefaults.js'

test('formatDecimals reads how many decimals a tick formatter prints', () => {
  assert.equal(formatDecimals(v => Math.round(v)), 0)
  assert.equal(formatDecimals(v => `${Math.round(v)} ms`), 0)
  assert.equal(formatDecimals(v => v.toFixed(2)), 2)
  assert.equal(formatDecimals(v => `${v.toFixed(2)}%`), 2)
  assert.equal(formatDecimals(v => (v >= 1000 ? `${(v / 1000).toFixed(1)}K` : Math.round(v).toString())), 0)
})

test('a whole-number formatter never gets a step it would print wrong', () => {
  for (const max of [0.3, 2.1, 9.6, 23, 77, 122, 640, 9.6e3]) {
    const { ticks, top } = niceAxis(max, 4, { decimals: 0 })
    assert.ok(top >= max, `top ${top} covers ${max}`)
    for (const t of ticks) assert.equal(t, Math.round(t), `max ${max}: tick ${t} is not a whole number`)
    assert.equal(new Set(ticks.map(Math.round)).size, ticks.length, `max ${max}: two ticks print the same label`)
  }
  assert.deepEqual(niceAxis(9.6, 4, { decimals: 0 }).ticks, [0, 5, 10], 'not 0, 2.5, 5, 7.5, 10')
})

test('without a precision it keeps the steps Explore has always drawn', () => {
  assert.deepEqual(niceAxis(9.6).ticks, [0, 2.5, 5, 7.5, 10])
  assert.deepEqual(niceAxis(1729).ticks, [0, 500, 1000, 1500, 2000])
  assert.deepEqual(niceAxis(0).ticks, [0, 0.25, 0.5, 0.75, 1])
})
