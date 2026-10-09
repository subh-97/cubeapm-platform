// niceAxis picks the round ticks a fixed-scale chart draws. The rule worth
// pinning is that it never picks a step the chart's own formatter misprints.
// The figure formatters below it are pinned to what each page prints: the RED
// ones to the service page's long-standing output, the Browser ones to
// production's.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  niceAxis, formatDecimals, fmtRedMs, fmtRedRpm, fmtRedPct, fmtLoadTime, fmtRpm2, fmtCls,
  fmtRateTick, fmtPctTick, fmtPlainTick, fmtLoadTimeTick, labelMatches, scrollTopToReveal,
} from './chartDefaults.js'

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

test('the RED formatters print what the service page always has', () => {
  assert.equal(fmtRedMs(611.6), '612 ms')
  assert.equal(fmtRedRpm(42.4), '42')
  assert.equal(fmtRedRpm(1234), '1.2K')
  assert.equal(fmtRedPct(3.456), '3.46%')
})

test('a load time reads in ms below a second and in seconds from one up', () => {
  assert.equal(fmtLoadTime(981.88), '982 ms')
  assert.equal(fmtLoadTime(1180), '1.18 s')
  assert.equal(fmtLoadTime(0), '0 ms')
  assert.equal(fmtLoadTime(1000), '1.00 s')
  // Switches on the rounded figure: never "1000 ms".
  assert.equal(fmtLoadTime(999.4), '999 ms')
  assert.equal(fmtLoadTime(999.6), '1.00 s')
  assert.equal(fmtLoadTime(4550), '4.55 s')
  assert.equal(fmtLoadTime(null), '')
  assert.equal(fmtLoadTime(NaN), '')
})

test('Browser RPM keeps two decimals and compacts past a thousand', () => {
  assert.equal(fmtRpm2(9.39), '9.39')
  assert.equal(fmtRpm2(110.886), '110.89')
  assert.equal(fmtRpm2(0), '0.00')
  assert.equal(fmtRpm2(1234.5), '1.23K')
  assert.equal(fmtRpm2(null), '')
})

test('CLS prints at the two decimals its thresholds are set at', () => {
  assert.equal(fmtCls(0.034), '0.03')
  assert.equal(fmtCls(0.25), '0.25')
  assert.equal(fmtCls(0.1), '0.10')
  assert.equal(fmtCls(undefined), '')
})

test('a Browser axis tick prints the fewest decimals that say it, in one unit per axis', () => {
  assert.deepEqual([0, 30, 60, 90, 120].map(v => fmtRateTick(v)), ['0', '30', '60', '90', '120'])
  assert.equal(fmtRateTick(2.5), '2.5')
  assert.equal(fmtRateTick(1500), '1.5K')
  assert.deepEqual([0, 6, 12, 18, 24].map(v => fmtPctTick(v)), ['0%', '6%', '12%', '18%', '24%'])
  assert.equal(fmtPctTick(2.5), '2.5%')
  assert.deepEqual([0, 0.1, 0.2, 0.25].map(v => fmtPlainTick(v)), ['0', '0.1', '0.2', '0.25'])
  // One unit for the whole axis, read off its top.
  assert.deepEqual([0, 750, 1500, 2250, 3000].map(v => fmtLoadTimeTick(v, 3000)), ['0 s', '0.75 s', '1.5 s', '2.25 s', '3 s'])
  assert.deepEqual([0, 250, 500, 750].map(v => fmtLoadTimeTick(v, 750)), ['0 ms', '250 ms', '500 ms', '750 ms'])
  // Without a top, the tick's own size decides.
  assert.equal(fmtLoadTimeTick(500), '500 ms')
  assert.equal(fmtLoadTimeTick(2000), '2 s')
  for (const f of [fmtRateTick, fmtPctTick, fmtPlainTick, fmtLoadTimeTick]) {
    assert.equal(f(null), '')
    assert.equal(f(NaN), '')
  }
  // A fixed axis under them still only lands on ticks they print exactly.
  assert.equal(formatDecimals(fmtRateTick), 2)
  assert.equal(formatDecimals(fmtPctTick), 2)
  assert.equal(formatDecimals(fmtLoadTimeTick), 0)
})

test('a fixed axis under each Browser formatter only lands on ticks it prints exactly', () => {
  assert.equal(formatDecimals(fmtLoadTime), 0)
  assert.equal(formatDecimals(fmtRpm2), 2)
  assert.equal(formatDecimals(fmtCls), 2)
  assert.deepEqual(niceAxis(0.3, 4, { decimals: formatDecimals(fmtCls) }).ticks, [0, 0.1, 0.2, 0.3])
})

test('a legend search matches the label as stored or as the chart shows it', () => {
  const row = { endpoint: 'GET payment.cubedemo.com:443/v1/payments', route: '/pay' }
  const noPort = l => l.replace(':443', '')
  // A blank search matches every row.
  assert.equal(labelMatches(row, ''), true)
  assert.equal(labelMatches(row, '   ', noPort), true)
  assert.equal(labelMatches(row, null), true)
  // The stored label, ignoring case and the query's own padding.
  assert.equal(labelMatches(row, '  PAYMENTS '), true)
  // What the legend shows: only the shortened label has 'cubedemo.com/v1'.
  assert.equal(labelMatches(row, 'payment.cubedemo.com/v1'), false, 'without a formatLabel, the stored label alone')
  assert.equal(labelMatches(row, 'payment.cubedemo.com/v1', noPort), true)
  assert.equal(labelMatches(row, 'GET payment.cubedemo.com/v1/payments', noPort), true, 'the legend row, typed exactly')
  // formatLabel gets the row too, and another label key.
  assert.equal(labelMatches(row, '/pay', (full, r) => r.route), true)
  assert.equal(labelMatches({ name: 'checkout' }, 'CHECK', undefined, 'name'), true)
  assert.equal(labelMatches(row, 'orders', noPort), false)
  // A row without the label, or a formatLabel with nothing to say, matches nothing.
  assert.equal(labelMatches({}, 'x'), false)
  assert.equal(labelMatches(row, 'undefined', () => undefined), false)
})

test('a scrolling legend scrolls the least it can to show a row whole', () => {
  // A 280px legend scrolled to the top; rows are 24px tall.
  const at = (top, scrollTop = 0) => scrollTopToReveal({ top, bottom: top + 24, scrollTop, height: 280 })
  assert.equal(at(100), null, 'already in view: no scroll')
  assert.equal(at(248), null, 'in view with the margin to spare')
  // Below the fold: brought up to the bottom edge, 8px clear of it.
  assert.equal(at(363), 363 + 24 + 8 - 280)
  assert.equal(at(250), 250 + 24 + 8 - 280, 'a row cut by the fold counts as hidden')
  // Above the view: brought down to the top edge.
  assert.equal(at(40, 200), 32)
  assert.equal(at(4, 200), 0, 'never past the top of the content')
  // A row taller than the view shows its top.
  assert.equal(scrollTopToReveal({ top: 400, bottom: 800, scrollTop: 0, height: 280 }), 392)
  assert.equal(scrollTopToReveal({ top: 100, bottom: 130, scrollTop: 0, height: 280, edge: 0 }), null)
})
