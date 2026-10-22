// How long a toast is given, and the countdown that holds while the pointer or
// focus is on it. There is no DOM and no waiting here: the countdown runs on a
// fake clock, whose tick() moves time on and fires whatever falls due, in
// order. Toast.jsx only turns enter/leave and focus/blur into hold/release.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ACTION_MS, NOTICE_MS, countdown, toastDuration } from './toastTimer.js'

function fakeClock() {
  let at = 0
  let nextId = 1
  const due = new Map()
  return {
    now: () => at,
    set: (fn, ms) => { due.set(nextId, { fn, when: at + ms }); return nextId++ },
    clear: id => { due.delete(id) },
    tick(ms) {
      const end = at + ms
      for (;;) {
        const [id, t] = [...due].sort((a, b) => a[1].when - b[1].when)[0] ?? []
        if (!t || t.when > end) break
        due.delete(id)
        at = t.when
        t.fn()
      }
      at = end
    },
    pending: () => due.size,
  }
}

// A countdown on its own fake clock, counting how often it has gone off.
function started(ms) {
  const clock = fakeClock()
  const fired = { count: 0 }
  const c = countdown(ms, () => { fired.count++ }, clock)
  return { c, clock, fired }
}

test('a plain notice is up 4.5s, and one carrying a control 10s', () => {
  assert.equal(NOTICE_MS, 4500)
  assert.equal(ACTION_MS, 10000)
  assert.equal(toastDuration(), NOTICE_MS)
  assert.equal(toastDuration({ interactive: false }), NOTICE_MS)
  assert.equal(toastDuration({ interactive: true }), ACTION_MS)
})

test('a caller\'s own duration wins, whatever the message carries', () => {
  assert.equal(toastDuration({ duration: 8000 }), 8000)
  assert.equal(toastDuration({ duration: 3000, interactive: true }), 3000)
  // 0 and null are how a caller keeps the toast until it is closed.
  assert.equal(toastDuration({ duration: 0, interactive: true }), 0)
  assert.equal(toastDuration({ duration: null }), null)
})

test('left alone, the countdown goes off once, when its time is up', () => {
  const { clock, fired } = started(NOTICE_MS)
  clock.tick(NOTICE_MS - 1)
  assert.equal(fired.count, 0)
  clock.tick(1)
  assert.equal(fired.count, 1)
  clock.tick(60_000)
  assert.equal(fired.count, 1)
})

test('a hold stops the clock, and releasing it resumes with what was left', () => {
  const { c, clock, fired } = started(ACTION_MS)
  clock.tick(3000)
  c.hold('pointer')
  clock.tick(60_000)
  assert.equal(fired.count, 0, 'went off while held')
  c.release('pointer')
  clock.tick(6999)
  assert.equal(fired.count, 0, 'the release started the whole 10s over, or less')
  clock.tick(1)
  assert.equal(fired.count, 1)
})

test('holds are kept by reason: the pointer leaving does not release a toast focus is still in', () => {
  const { c, clock, fired } = started(ACTION_MS)
  c.hold('pointer')
  c.hold('focus')
  c.release('pointer')
  clock.tick(60_000)
  assert.equal(fired.count, 0)
  c.release('focus')
  clock.tick(ACTION_MS - 1)
  assert.equal(fired.count, 0)
  clock.tick(1)
  assert.equal(fired.count, 1)
})

test('the same hold twice is one hold, and a release with nothing held changes nothing', () => {
  // Focus moving between the toast's own controls holds again on each move.
  const a = started(NOTICE_MS)
  a.clock.tick(1000)
  a.c.hold('focus')
  a.c.hold('focus')
  a.c.release('focus')
  a.clock.tick(NOTICE_MS - 1001)
  assert.equal(a.fired.count, 0)
  a.clock.tick(1)
  assert.equal(a.fired.count, 1)

  // A leave without an enter (the toast appeared under a resting pointer)
  // neither restarts the time nor sets a second timer going.
  const b = started(NOTICE_MS)
  b.clock.tick(2000)
  b.c.release('pointer')
  assert.equal(b.clock.pending(), 1)
  b.clock.tick(NOTICE_MS - 2000)
  assert.equal(b.fired.count, 1)
  b.clock.tick(60_000)
  assert.equal(b.fired.count, 1)
})

test('held from the start, it spends nothing until released', () => {
  const { c, clock, fired } = started(NOTICE_MS)
  c.hold('pointer')
  clock.tick(60_000)
  assert.equal(fired.count, 0)
  c.release('pointer')
  clock.tick(NOTICE_MS - 1)
  assert.equal(fired.count, 0)
  clock.tick(1)
  assert.equal(fired.count, 1)
})

test('many short holds neither lose time nor gain it', () => {
  const { c, clock, fired } = started(ACTION_MS)
  for (let i = 0; i < 5; i++) {
    clock.tick(1000)
    c.hold('pointer')
    clock.tick(5000)
    c.release('pointer')
  }
  // 5s of the 10s has run, in five pieces.
  clock.tick(4999)
  assert.equal(fired.count, 0)
  clock.tick(1)
  assert.equal(fired.count, 1)
})

test('cancelled, it never goes off, not even when a hold is released after', () => {
  const running = started(NOTICE_MS)
  running.clock.tick(1000)
  running.c.cancel()
  running.clock.tick(60_000)
  assert.equal(running.fired.count, 0)
  assert.equal(running.clock.pending(), 0)

  // Closed or replaced while the pointer was on it; the leave comes after.
  const held = started(NOTICE_MS)
  held.c.hold('pointer')
  held.c.cancel()
  held.c.release('pointer')
  held.clock.tick(60_000)
  assert.equal(held.fired.count, 0)
  assert.equal(held.clock.pending(), 0)
})

test('once it has gone off, nothing starts it again', () => {
  const { c, clock, fired } = started(NOTICE_MS)
  clock.tick(NOTICE_MS)
  assert.equal(fired.count, 1)
  c.hold('pointer')
  c.release('pointer')
  clock.tick(60_000)
  assert.equal(fired.count, 1)
  assert.equal(clock.pending(), 0)
})

test('without a positive time there is no countdown: the toast stays until closed', () => {
  for (const ms of [0, null, undefined, -1, NaN, Infinity]) {
    const { c, clock, fired } = started(ms)
    assert.equal(clock.pending(), 0, `${ms} set a timer`)
    c.hold('pointer')
    c.release('pointer')
    clock.tick(1e9)
    assert.equal(fired.count, 0, `${ms} went off`)
    assert.equal(clock.pending(), 0)
  }
})
