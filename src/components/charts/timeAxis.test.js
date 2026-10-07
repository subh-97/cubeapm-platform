// What makes a time axis good, asserted as properties rather than as strings.
//
// Exact labels depend on what time the suite happens to run, so almost nothing
// here compares text. What it checks is the things that were WRONG before: that
// ticks land on instants a human counts in, that they never appear between two
// samples, that the same interval picks the same instants whatever day the
// window opens on, and that a narrower chart gets fewer labels rather than
// overlapping ones.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveWindow } from '@/data/timeWindow'
import { buildTimeAxis, pickTickInterval, tickInstants, formatTick } from './timeAxis.js'

const preset = v => resolveWindow({ kind: 'preset', value: v })
const PRESETS = ['5m', '15m', '30m', '1h', '2h', '3h', '6h', '12h', '24h', '2d', '7d', 'today']
const WIDE = 760
const NARROW = 285

const labelsOf = (win, width = WIDE) => {
  const a = buildTimeAxis(win, { width })
  return a.ticks.map(ms => formatTick(ms, a.labelKind, win))
}

test('a tick never falls between two samples', () => {
  for (const v of PRESETS) {
    const win = preset(v)
    for (const width of [WIDE, NARROW]) {
      const { interval } = pickTickInterval(win, width)
      assert.ok(interval >= win.step,
        `${v} @${width}: tick interval ${interval}s is finer than the ${win.step}s bucket`)
    }
  }
})

test('ticks land on round instants, not on bucket indices', () => {
  // The whole complaint: the old axis ticked every Nth bucket, so a tick could
  // be at 14:07 and the next at 16:07. Every clock-mode tick must sit on a
  // multiple of the interval counted from local midnight.
  for (const v of PRESETS) {
    const win = preset(v)
    if (win.relative) continue
    const { interval } = pickTickInterval(win, WIDE)
    if (interval >= 86400) continue // day ladders are checked separately
    for (const ms of tickInstants(win, interval)) {
      const d = new Date(ms)
      const midnight = new Date(ms); midnight.setHours(0, 0, 0, 0)
      const since = (d.getTime() - midnight.getTime()) / 1000
      assert.equal(since % interval, 0,
        `${v}: tick ${d.toTimeString().slice(0, 8)} is not a multiple of ${interval}s from midnight`)
    }
  }
})

test('a day-interval ladder ticks on midnights', () => {
  const win = preset('7d')
  const { interval } = pickTickInterval(win, WIDE)
  assert.ok(interval >= 86400, `a week should tick in days, got ${interval}s`)
  for (const ms of tickInstants(win, interval)) {
    const d = new Date(ms)
    assert.equal(d.getHours(), 0, 'day ticks sit at midnight')
    assert.equal(d.getMinutes(), 0)
  }
})

// Anchoring multi-day intervals on the window's own first day makes the axis
// walk: "Last 7 days" would tick Oct 1/3/5 today and Oct 2/4/6 tomorrow. The
// anchor is the epoch instead, so the ladder is stationary.
test('a multi-day ladder is stationary across windows', () => {
  const day = 86400000
  const mk = (startMs, endMs) => ({
    start: Math.floor(startMs / 1000), end: Math.floor(endMs / 1000),
    step: 10800, nowSec: Math.floor(endMs / 1000), relative: false, crossesDay: true,
    spanSec: (endMs - startMs) / 1000,
  })
  const base = new Date(2026, 9, 6, 12, 0, 0).getTime()
  const a = tickInstants(mk(base - 7 * day, base), 172800).map(ms => new Date(ms).getDate())
  const b = tickInstants(mk(base - 7 * day + day, base + day), 172800).map(ms => new Date(ms).getDate())
  // Shifting the window by a day must shift the tick set by exactly that day —
  // the parity of which days get ticked must not flip.
  const shifted = new Set(b)
  const overlap = a.filter(d => shifted.has(d))
  assert.ok(overlap.length >= a.length - 1,
    `tick days moved rather than scrolled: ${a} vs ${b}`)
})

// Every range reads as a clock, including the default hour. It used to tick
// "-60m -55m … now"; an axis that changes vocabulary at one particular range
// makes the reader check which range they are on before they can read it.
// Relative time moved to the tooltip, where there is room to say it in words.
test('the default hour reads as a clock, like every other range', () => {
  const labels = labelsOf(preset('1h'))
  for (const l of labels) {
    assert.doesNotMatch(l, /^-\d+m$/, `${l} is axis shorthand, not a clock time`)
    assert.notEqual(l, 'now')
    assert.match(l, /^(\d{2}:\d{2}|[A-Z][a-z]{2} \d{2})$/, `${l} is not a clock time or a date`)
  }
  // And on round boundaries: the minutes of every clock tick divide the interval.
  const mins = labels.filter(l => l.includes(':')).map(l => Number(l.split(':')[1]))
  assert.ok(mins.every(m => m % 5 === 0), `ticks are not on round minutes: ${labels.join(' ')}`)
})

test('no range anywhere falls back to relative shorthand', () => {
  for (const v of PRESETS) {
    for (const width of [WIDE, NARROW]) {
      for (const l of labelsOf(preset(v), width)) {
        assert.doesNotMatch(l, /^-\d+m$/, `${v} @${width} still ticks "${l}"`)
      }
    }
  }
})

test('the date appears only where it carries information', () => {
  // On a window that crosses midnight, exactly the midnight ticks are dated and
  // every other tick is a bare clock time. A two-day window that dated all
  // eight of its six-hourly ticks read "Oct 05 Oct 05 Oct 05 Oct 05 Oct 06..."
  const win = preset('2d')
  const a = buildTimeAxis(win, { width: WIDE })
  let dated = 0
  for (const ms of a.ticks) {
    const label = formatTick(ms, a.labelKind, win)
    const isDated = /^[A-Z][a-z]{2} \d{2}$/.test(label)
    if (isDated) {
      dated++
      const d = new Date(ms)
      assert.equal(d.getHours(), 0, `${label} is dated but is not midnight`)
    }
  }
  assert.ok(dated >= 1, 'a two-day window names at least one day')
  assert.ok(dated < a.ticks.length, 'but it does not date every tick')
})

test('a narrower chart gets fewer labels, never more', () => {
  for (const v of PRESETS) {
    const win = preset(v)
    const wide = buildTimeAxis(win, { width: WIDE }).ticks.length
    const narrow = buildTimeAxis(win, { width: NARROW }).ticks.length
    assert.ok(narrow <= wide, `${v}: ${narrow} labels at ${NARROW}px but ${wide} at ${WIDE}px`)
    assert.ok(narrow >= 2, `${v}: a chart with ${narrow} labels is not an axis`)
  }
})

test('labels fit the width they were budgeted for', () => {
  for (const v of PRESETS) {
    for (const width of [WIDE, NARROW, 160]) {
      const win = preset(v)
      const a = buildTimeAxis(win, { width })
      const labels = a.ticks.map(ms => formatTick(ms, a.labelKind, win))
      const widest = Math.max(...labels.map(l => l.length)) * 7
      assert.ok(a.ticks.length * widest <= width * 1.6,
        `${v} @${width}px: ${a.ticks.length} labels of ~${widest}px will collide`)
    }
  }
})

// On a positioned axis a repeated clock time is correct and conventional —
// "Oct 05 06:00 12:00 18:00 Oct 06 06:00" reads fine, because the dated tick to
// the left of each run establishes which day it belongs to. What must never
// happen is two ADJACENT ticks reading the same thing, which would look like a
// duplicate rather than like a new day.
test('no two neighbouring ticks read the same', () => {
  for (const v of PRESETS) {
    for (const width of [WIDE, NARROW]) {
      const win = preset(v)
      const labels = labelsOf(win, width)
      for (let i = 1; i < labels.length; i++) {
        assert.notEqual(labels[i], labels[i - 1],
          `${v} @${width}: "${labels[i]}" repeats back to back in ${labels.join(' ')}`)
      }
    }
  }
})

// The category axis is the exception: there a tick IS a bucket label, used as a
// lookup key, so collisions would silently tick the wrong bucket.
test('every category tick is a distinct bucket label', () => {
  for (const v of PRESETS) {
    for (const width of [WIDE, NARROW]) {
      const win = preset(v)
      const { ticks } = buildTimeAxis(win, { width, kind: 'category' })
      assert.equal(new Set(ticks).size, ticks.length,
        `${v} @${width}: duplicate category ticks ${ticks.join(' ')}`)
    }
  }
})

// A dragged range is never a round preset. It is the case the old axis handled
// worst and the one a drag-to-focus feature produces every single time.
test('an arbitrary absolute range still ticks on round instants', () => {
  const from = new Date(2026, 9, 1, 14, 23, 11).getTime()
  const to = new Date(2026, 9, 3, 9, 47, 2).getTime()
  const win = resolveWindow({ kind: 'absolute', from, to })
  const a = buildTimeAxis(win, { width: WIDE })
  assert.ok(a.ticks.length >= 2)
  for (const ms of a.ticks) {
    const d = new Date(ms)
    assert.equal(d.getMinutes(), 0, 'ticks on a multi-hour ladder sit on the hour')
    assert.equal(d.getSeconds(), 0)
  }
  const labels = a.ticks.map(ms => formatTick(ms, a.labelKind, win))
  for (let i = 1; i < labels.length; i++) assert.notEqual(labels[i], labels[i - 1])
  // The day changes are named, the hours inside each day are not.
  assert.ok(labels.some(l => /^[A-Z][a-z]{2} \d{2}$/.test(l)), 'a multi-day range names its days')
})

// The two kinds share a ladder table and a set of round instants, but NOT an
// interval. A category tick draws the bucket's own label — which doubles as the
// tooltip heading and so carries the date and the seconds — where the numeric
// axis draws a terse `23:48` for the same instant. Budgeting them identically
// is what made a dragged window render its labels on top of each other.
test('both kinds of axis draw the same ladder in the same words', () => {
  for (const v of ['5m', '1h', '6h', '24h', '7d']) {
    const win = preset(v)
    const cat = buildTimeAxis(win, { width: WIDE, kind: 'category' })
    const num = buildTimeAxis(win, { width: WIDE, kind: 'time' })
    assert.equal(cat.interval, num.interval,
      `${v}: a bar chart and a line chart on one page must tick alike`)
    assert.ok(cat.ticks.length > 0, `${v}: category axis drew no ticks`)
    // The tick VALUE is a bucket label, because that is all a band scale can
    // tick on; the tick TEXT is the terse form, same as the numeric axis.
    const known = new Set(win.buckets.map(b => b.label))
    const drawn = cat.ticks.map(t => {
      assert.ok(known.has(t), `${v}: tick "${t}" is not a bucket label`)
      return cat.props.tickFormatter ? cat.props.tickFormatter(t) : t
    })
    const numDrawn = num.ticks.map(ms => formatTick(ms, num.labelKind, win))
    assert.deepEqual(drawn, numDrawn, `${v}: the two axes read differently`)
  }
})

// The empty-tick-set case: at a width where nothing in the table fits, the
// ladder must still land on something. It used to fall through to a weekly
// interval, which ticks on no instant at all inside a short window — and that
// is exactly the state of every chart on its first paint, before the width has
// been measured.
test('a chart too narrow for any ladder still gets an axis', () => {
  for (const v of PRESETS) {
    for (const width of [0, 40, 120]) {
      const win = preset(v)
      const a = buildTimeAxis(win, { width })
      assert.ok(a.ticks.length >= 2, `${v} @${width}px drew ${a.ticks.length} ticks`)
    }
  }
})
