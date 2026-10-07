// PageBar's time panel helpers. These run in node with no DOM, so the tests
// stay on the arithmetic: what the From/To fields open on, which intervals the
// auto-refresh control will accept, and where the panel lands.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { seedCustomRange, normalizeAutoRefresh, autoRefreshLabel, panelPosition } from './timePanel.js'
import { parseDateTimeInput, formatDateTimeInput, resolveRange } from './timeRange.js'

// ---------- seedCustomRange ----------

test('an absolute range seeds the fields with its own ends', () => {
  const from = new Date(2026, 2, 14, 9, 5, 0).getTime()
  const to = new Date(2026, 2, 14, 10, 35, 30).getTime()
  assert.deepEqual(seedCustomRange({ kind: 'absolute', from, to }), {
    from: formatDateTimeInput(from),
    to: formatDateTimeInput(to),
  })
})

test('a preset seeds the fields with the window it resolves to', () => {
  const now = new Date(2026, 2, 14, 10, 35, 30).getTime()
  const seeded = seedCustomRange({ kind: 'preset', value: '6h' }, now)
  const r = resolveRange({ kind: 'preset', value: '6h' }, now)
  assert.equal(parseDateTimeInput(seeded.from), r.start * 1000)
  assert.equal(parseDateTimeInput(seeded.to), r.end * 1000)
})

test('seeded text round-trips through the input parser', () => {
  const now = new Date(2026, 6, 1, 23, 58, 17).getTime()
  for (const value of ['5m', '1h', '24h', '7d', 'today', 'todayf']) {
    const { from, to } = seedCustomRange({ kind: 'preset', value }, now)
    assert.ok(parseDateTimeInput(from) != null, `${value} from`)
    assert.ok(parseDateTimeInput(to) != null, `${value} to`)
  }
})

test('no range at all falls back to the default preset rather than empty fields', () => {
  const now = new Date(2026, 2, 14, 10, 35, 30).getTime()
  assert.deepEqual(seedCustomRange(null, now), seedCustomRange({ kind: 'preset', value: '1h' }, now))
})

// ---------- auto-refresh ----------

test('only the offered intervals survive normalisation', () => {
  for (const sec of [0, 5, 10, 30, 60, 300, 900]) assert.equal(normalizeAutoRefresh(sec), sec)
  // Anything else is Off — the control cannot display a value it does not
  // offer, so it must not tick at one either.
  for (const bad of [45, -30, 7.5, NaN, Infinity, 'soon', null, undefined, {}]) {
    assert.equal(normalizeAutoRefresh(bad), 0, String(bad))
  }
  assert.equal(normalizeAutoRefresh('30'), 30)
})

test('every value the control can hold has a label', () => {
  assert.equal(autoRefreshLabel(0), 'Off')
  assert.equal(autoRefreshLabel(30), '30s')
  assert.equal(autoRefreshLabel(60), '1m')
  assert.equal(autoRefreshLabel(900), '15m')
  assert.equal(autoRefreshLabel(45), 'Off')
})

// ---------- panelPosition ----------

test('the panel hangs under the trigger with the right edges aligned', () => {
  const rect = { right: 900, bottom: 60 }
  assert.deepEqual(panelPosition(rect, 1200, 460), { top: 64, left: 440 })
})

test('the panel is pulled back inside the viewport instead of overflowing it', () => {
  // Trigger near the right edge: aligning right edges would run the panel past
  // the viewport, so it stops a margin short of it.
  assert.deepEqual(panelPosition({ right: 1198, bottom: 40 }, 1200, 460).left, 1200 - 460 - 8)
  // Viewport narrower than the panel: clamp to the left margin rather than
  // producing a negative offset that would clip the custom fields.
  assert.deepEqual(panelPosition({ right: 300, bottom: 40 }, 320, 460).left, 8)
})

test('no trigger box yet means no position', () => {
  assert.equal(panelPosition(null, 1200), null)
})
