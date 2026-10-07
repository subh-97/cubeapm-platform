// How a tooltip says when.
//
// The heading has to be unambiguous read cold, a month later, pasted into a
// query — so it carries the year and the seconds. The line under it is the same
// instant in words, because "-27m" is axis shorthand that only reads correctly
// when it is one of twelve neighbours teaching you the convention.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import ChartTooltip, { fullInstant, timeAgo } from './ChartTooltip.jsx'

const at = (...a) => new Date(...a).getTime()

test('the heading is a full instant, with the year and the seconds', () => {
  assert.equal(fullInstant(at(2026, 9, 6, 23, 57, 0)), '2026-10-06 23:57:00')
  assert.equal(fullInstant(at(2026, 0, 1, 0, 0, 7)), '2026-01-01 00:00:07')
  // Midnight keeps its zeros rather than collapsing to a date.
  assert.equal(fullInstant(at(2026, 11, 31, 0, 0, 0)), '2026-12-31 00:00:00')
})

test('the second line is how long ago, in words', () => {
  const now = at(2026, 9, 6, 12, 0, 0)
  const ago = (ms) => timeAgo(ms, now)

  assert.equal(ago(now), 'just now')
  assert.equal(ago(now - 20 * 1000), 'just now')
  assert.equal(ago(now - 60 * 1000), '1 min ago')
  assert.equal(ago(now - 23 * 60 * 1000), '23 mins ago')
  assert.equal(ago(now - 27 * 60 * 1000), '27 mins ago')
  assert.equal(ago(now - 59 * 60 * 1000), '59 mins ago')
  assert.equal(ago(now - 60 * 60 * 1000), '1 hour ago')
  assert.equal(ago(now - 6 * 60 * 60 * 1000), '6 hours ago')
  assert.equal(ago(now - 47 * 60 * 60 * 1000), '47 hours ago')
  assert.equal(ago(now - 72 * 60 * 60 * 1000), '3 days ago')
  assert.equal(ago(now - 7 * 24 * 60 * 60 * 1000), '7 days ago')
})

test('singular and plural are both spelled correctly', () => {
  const now = at(2026, 9, 6, 12, 0, 0)
  for (const [ms, want] of [
    [60 * 1000, '1 min ago'],
    [120 * 1000, '2 mins ago'],
    [3600 * 1000, '1 hour ago'],
    [7200 * 1000, '2 hours ago'],
    [24 * 3600 * 1000 * 2, '2 days ago'],
  ]) {
    assert.equal(timeAgo(now - ms, now), want)
  }
})

// A window that stops short of the present must not describe its newest reading
// as current — the tooltip measures against the window's own right-hand edge,
// which is the same edge the axis labels "now".
test('a reading is dated against the window edge, not the wall clock', () => {
  const windowEnd = at(2026, 9, 6, 12, 0, 0)
  const reading = at(2026, 9, 6, 11, 53, 0)
  assert.equal(timeAgo(reading, windowEnd), '7 mins ago')
})

test('a reading at or past the edge never reads as negative', () => {
  const now = at(2026, 9, 6, 12, 0, 0)
  assert.equal(timeAgo(now + 5 * 60 * 1000, now), 'just now')
})

// The platform rule for any page with more than one chart: charts that share a
// syncId all go active together, and only the one the pointer is actually in
// opens a panel. `suppressed` is the switch every tooltip on every page routes
// that decision through, so it is the one thing here that must not drift.
//
// Called as a plain function rather than rendered: the component returns null
// or an element, and that is the whole contract. Recharts draws the cursor line
// independently of this content, so a suppressed tooltip still leaves the
// crosshair on its chart - which is the part that carries the link.
const props = {
  tMs: at(2026, 9, 6, 23, 57, 0),
  nowMs: at(2026, 9, 7, 0, 0, 0),
  items: [{ key: 'value', label: 'p90', value: '612 ms', color: '#F472B6' }],
}

test('a suppressed tooltip renders nothing at all', () => {
  assert.equal(ChartTooltip({ ...props, suppressed: true }), null)
})

test('the chart the pointer is in still renders its panel', () => {
  assert.notEqual(ChartTooltip({ ...props, suppressed: false }), null)
  // An unsynced chart passes no `suppressed` at all, and must be unaffected.
  assert.notEqual(ChartTooltip(props), null)
})
