// Explore time math: presets, the step table, local-time alignment, zoom and
// the From/To inputs (results-area.md §2-§3).
//
// Expectations are built with local-time Date constructors, so they hold in
// whatever zone the tests run in. Every real UTC offset is a whole number of
// 15-minute units, which is what makes "floored in local time" checkable as
// a local wall-clock time for every step up to 900 s.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  TIME_PRESETS, AUTO_REFRESH_OPTIONS, COMPARE_OPTIONS, presetFromLabel, labelFromPreset,
  stepForSpan, resolveRange, shiftRange, compareShift, formatAbsoluteLabel, rangeLabel,
  zoomRange, parseDateTimeInput, formatDateTimeInput, validateCustomRange, autoFillTo, timestamps,
} from './timeRange.js'

const local = (...a) => new Date(...a).getTime()
const sec = (ms) => Math.floor(ms / 1000)
// 2026-10-01 14:37:27 local: not on any step boundary, so every floor shows.
const NOW = local(2026, 9, 1, 14, 37, 27)
const preset = (value) => ({ kind: 'preset', value })

// ---------- presets ----------

test('the preset list is the reference list, in order', () => {
  assert.equal(TIME_PRESETS.length, 14)
  assert.deepEqual(TIME_PRESETS[0], { value: '5m', label: 'Last 5 minutes' })
  assert.deepEqual(TIME_PRESETS[3], { value: '1h', label: 'Last 1 hour' })
  assert.deepEqual(TIME_PRESETS[13], { value: 'todayf', label: 'Today so far' })
  assert.deepEqual(AUTO_REFRESH_OPTIONS.map(o => o.value), [0, 5, 10, 30, 60, 300, 900])
  assert.deepEqual(AUTO_REFRESH_OPTIONS.map(o => o.label), ['Off', '5s', '10s', '30s', '1m', '5m', '15m'])
  assert.deepEqual(COMPARE_OPTIONS.map(o => o.label), ['Off', 'Previous period', '1 day ago', '1 week ago'])
})

test('labels and preset values convert both ways; unknowns fall back', () => {
  assert.equal(presetFromLabel('Last 1 hour'), '1h')
  assert.equal(presetFromLabel('Last 7 days'), '7d')
  assert.equal(presetFromLabel('Today so far'), 'todayf')
  assert.equal(presetFromLabel('Custom (14:02 – 14:10)'), '1h')
  assert.equal(presetFromLabel(undefined), '1h')
  assert.equal(labelFromPreset('3h'), 'Last 3 hours')
  assert.equal(labelFromPreset(''), 'Last 1 hour')
  assert.equal(labelFromPreset('90m'), 'Custom')
})

// ---------- step ----------

test('stepForSpan follows the reference thresholds, floored at minStep', () => {
  assert.equal(stepForSpan(300, 60, 0), 60)
  assert.equal(stepForSpan(1800, 60, 0), 60)
  assert.equal(stepForSpan(3600, 60, 0), 60)
  assert.equal(stepForSpan(21600, 60, 0), 120)
  assert.equal(stepForSpan(43200, 60, 0), 300)
  assert.equal(stepForSpan(86399, 60, 0), 300)   // "Today" is one second short of a day
  assert.equal(stepForSpan(86400, 60, 0), 900)
  assert.equal(stepForSpan(604800, 60, 0), 900)
})

test('stepForSpan: the 6h step depends on whether the zone is a whole half hour', () => {
  assert.equal(stepForSpan(21600, 60, 330), 120)   // IST +5:30
  assert.equal(stepForSpan(21600, 60, 345), 300)   // Nepal +5:45
  assert.equal(stepForSpan(21600, 60, -300), 120)  // US Eastern
})

test('stepForSpan: with a 15 s minimum the short ranges get finer steps', () => {
  assert.equal(stepForSpan(300, 15, 0), 15)
  assert.equal(stepForSpan(900, 15, 0), 15)
  assert.equal(stepForSpan(1800, 15, 0), 30)
  assert.equal(stepForSpan(3600, 15, 0), 60)
})

// ---------- resolveRange ----------

test('Last 1 hour: 60 s step, both ends floored to the minute', () => {
  const r = resolveRange(preset('1h'), NOW)
  assert.equal(r.step, 60)
  assert.equal(r.end, sec(local(2026, 9, 1, 14, 37, 0)))
  assert.equal(r.start, sec(local(2026, 9, 1, 13, 37, 0)))
  assert.equal(r.rawEnd, sec(NOW))
  assert.equal(r.rawStart, sec(NOW) - 3600)
  assert.equal(r.span, 3600)
})

test('longer presets floor to their step in local time', () => {
  const r6 = resolveRange(preset('6h'), NOW)
  const off = -new Date(NOW).getTimezoneOffset()
  if (off % 30 === 0) {
    assert.equal(r6.step, 120)
    assert.equal(r6.end, sec(local(2026, 9, 1, 14, 36, 0)))
  } else {
    assert.equal(r6.step, 300)
    assert.equal(r6.end, sec(local(2026, 9, 1, 14, 35, 0)))
  }
  const r12 = resolveRange(preset('12h'), NOW)
  assert.equal(r12.step, 300)
  assert.equal(r12.end, sec(local(2026, 9, 1, 14, 35, 0)))
  assert.equal(r12.start, sec(local(2026, 9, 1, 2, 35, 0)))
  const r24 = resolveRange(preset('24h'), NOW)
  assert.equal(r24.step, 900)
  assert.equal(r24.end, sec(local(2026, 9, 1, 14, 30, 0)))
  assert.equal(r24.start, sec(local(2026, 8, 30, 14, 30, 0)))
})

test('point counts per preset match the reference step table', () => {
  const count = (v) => timestamps(resolveRange(preset(v), NOW)).length
  assert.equal(count('5m'), 6)
  assert.equal(count('15m'), 16)
  assert.equal(count('30m'), 31)
  assert.equal(count('1h'), 61)
  assert.equal(count('3h'), 181)
  assert.equal(count('12h'), 145)
  assert.equal(count('24h'), 97)
  // Calendar days: a week that crosses a DST change is an hour shorter or
  // longer, and so is its point count — dayjs behaves the same.
  const weekAgo = new Date(NOW)
  weekAgo.setDate(weekAgo.getDate() - 7)
  if (weekAgo.getTimezoneOffset() === new Date(NOW).getTimezoneOffset()) assert.equal(count('7d'), 673)
  const r7 = resolveRange(preset('7d'), NOW)
  assert.equal(count('7d'), r7.span / r7.step + 1)
})

test('Today runs to 23:59:59 (in the future) and Today so far to now', () => {
  const t = resolveRange(preset('today'), NOW)
  assert.equal(t.rawStart, sec(local(2026, 9, 1)))
  assert.equal(t.rawEnd, sec(local(2026, 9, 1, 23, 59, 59)))
  assert.equal(t.step, 300)
  assert.equal(t.end, sec(local(2026, 9, 1, 23, 55, 0)))
  const f = resolveRange(preset('todayf'), NOW)
  assert.equal(f.start, sec(local(2026, 9, 1)))
  assert.equal(f.rawEnd, sec(NOW))
  assert.equal(f.step, 300)   // 14h37m elapsed
  assert.equal(f.end, sec(local(2026, 9, 1, 14, 35, 0)))
})

test('day presets subtract calendar days', () => {
  const r = resolveRange(preset('2d'), NOW)
  assert.equal(r.rawStart, sec(local(2026, 8, 29, 14, 37, 27)))
})

test('any Nm/Nh/Nd resolves; an unknown value falls back to 1h', () => {
  assert.equal(resolveRange(preset('90m'), NOW).rawStart, sec(NOW) - 5400)
  assert.equal(resolveRange(preset('bogus'), NOW).rawStart, sec(NOW) - 3600)
  assert.equal(resolveRange(null, NOW).span, 3600)
})

test('an absolute range: the drag-zoom worked example (14:10 → 14:25, step 60)', () => {
  const r = resolveRange({ kind: 'absolute', from: local(2026, 9, 1, 14, 10), to: local(2026, 9, 1, 14, 25) }, NOW)
  assert.equal(r.step, 60)   // span 900 → 15 → max(15, 60)
  assert.equal(r.start, sec(local(2026, 9, 1, 14, 10)))
  assert.equal(r.end, sec(local(2026, 9, 1, 14, 25)))
  assert.equal(timestamps(r).length, 16)
})

test('relative presets roll forward with now', () => {
  const a = resolveRange(preset('1h'), NOW)
  const b = resolveRange(preset('1h'), NOW + 60000)
  assert.equal(b.end - a.end, 60)
})

// ---------- comparison ----------

test('shiftRange moves the whole window and keeps the step', () => {
  const r = resolveRange(preset('1h'), NOW)
  const p = shiftRange(r, r.span)
  assert.equal(p.end, r.start)
  assert.equal(p.start, r.start - 3600)
  assert.equal(p.step, r.step)
  assert.equal(p.span, r.span)
})

test('compareShift: previous period = span; day and week are fixed', () => {
  const r = resolveRange(preset('6h'), NOW)
  assert.equal(compareShift('previous', r), r.span)
  assert.equal(compareShift('day', r), 86400)
  assert.equal(compareShift('week', r), 604800)
  assert.equal(compareShift('off', r), 0)
})

// ---------- labels ----------

test('absolute labels use "MMM DD, HH:mm:ss - MMM DD, HH:mm:ss"', () => {
  const from = local(2026, 9, 1, 14, 0, 0)
  const to = local(2026, 9, 1, 15, 30, 0)
  assert.equal(formatAbsoluteLabel(from, to), 'Oct 01, 14:00:00 - Oct 01, 15:30:00')
  assert.equal(rangeLabel({ kind: 'absolute', from, to }), 'Oct 01, 14:00:00 - Oct 01, 15:30:00')
  assert.equal(rangeLabel(preset('24h')), 'Last 24 hours')
  assert.equal(rangeLabel(null), 'Last 1 hour')
})

// ---------- zoom ----------

test('zoomRange floors the start and ceils the end to the minute', () => {
  const z = zoomRange(local(2026, 9, 1, 14, 10, 20), local(2026, 9, 1, 14, 25, 40))
  assert.deepEqual(z, { kind: 'absolute', from: local(2026, 9, 1, 14, 10), to: local(2026, 9, 1, 14, 26) })
})

test('zoomRange: a right-to-left drag works; a click (no width) is nothing', () => {
  const z = zoomRange(local(2026, 9, 1, 14, 25), local(2026, 9, 1, 14, 10))
  assert.equal(z.from, local(2026, 9, 1, 14, 10))
  assert.equal(z.to, local(2026, 9, 1, 14, 25))
  assert.equal(zoomRange(NOW, NOW), null)
  assert.equal(zoomRange(NaN, NOW), null)
  // A sliver still zooms to a whole minute.
  const tiny = zoomRange(local(2026, 9, 1, 14, 10, 5), local(2026, 9, 1, 14, 10, 9))
  assert.equal(tiny.to - tiny.from, 60000)
})

// ---------- From / To inputs ----------

test('parseDateTimeInput reads local "YYYY-MM-DD HH:mm:ss", seconds optional', () => {
  assert.equal(parseDateTimeInput('2026-10-01 14:05:09'), local(2026, 9, 1, 14, 5, 9))
  assert.equal(parseDateTimeInput('2026-10-01 14:05'), local(2026, 9, 1, 14, 5, 0))
  assert.equal(parseDateTimeInput(' 2026-10-01T14:05:09 '), local(2026, 9, 1, 14, 5, 9))
})

test('parseDateTimeInput rejects malformed and impossible dates', () => {
  for (const bad of ['', '2026-10-01', '2026/10/01 14:05', '2026-02-30 10:00:00', '2026-10-01 24:00:00', '2026-13-01 10:00', 'now', null]) {
    assert.equal(parseDateTimeInput(bad), null, String(bad))
  }
})

test('formatDateTimeInput is the inverse of parse', () => {
  const ms = local(2026, 9, 1, 9, 3, 7)
  assert.equal(formatDateTimeInput(ms), '2026-10-01 09:03:07')
  assert.equal(parseDateTimeInput(formatDateTimeInput(ms)), ms)
  assert.equal(formatDateTimeInput(null), '')
})

test('validateCustomRange: Apply needs both ends, From before To, nothing in the future', () => {
  const ok = validateCustomRange('2026-10-01 10:00:00', '2026-10-01 12:00:00', NOW)
  assert.equal(ok.canApply, true)
  assert.equal(ok.from, local(2026, 9, 1, 10))
  assert.equal(ok.to, local(2026, 9, 1, 12))
  assert.equal(validateCustomRange('', '', NOW).reason, 'Enter a start time')
  assert.equal(validateCustomRange('2026-10-01 10:00:00', '', NOW).reason, 'Enter an end time')
  assert.equal(validateCustomRange('2026-10-01 12:00:00', '2026-10-01 10:00:00', NOW).reason, 'From must be before To')
  assert.equal(validateCustomRange('2026-10-01 10:00:00', '2026-10-01 10:00:00', NOW).canApply, false)
  assert.equal(validateCustomRange('2026-10-02 10:00:00', '2026-10-02 12:00:00', NOW).reason, 'From is in the future')
  assert.equal(validateCustomRange('2026-10-01 10:00:00', '2026-10-01 18:00:00', NOW).reason, 'To is in the future')
  assert.match(validateCustomRange('yesterday', '2026-10-01 12:00:00', NOW).reason, /From is not a valid date/)
})

test('autoFillTo: From + 24h, clamped to now', () => {
  const from = local(2026, 8, 20, 10)
  assert.equal(autoFillTo(from, NOW), from + 86400000)
  assert.equal(autoFillTo(local(2026, 9, 1, 10), NOW), NOW)
  assert.equal(autoFillTo(null, NOW), null)
})
