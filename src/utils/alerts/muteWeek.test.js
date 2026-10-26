// A mute window as a week (muteWeek.js; docs/alerts/DESIGN.md D10).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { weekSegments, muteWindowState } from './muteWeek'

test('quiet hours run every night and wrap into the morning', () => {
  const segs = weekSegments({ start: '21:00', hours: 10, minutes: 0, weekdays: [] })
  assert.equal(segs.length, 14)
  assert.deepEqual(segs.slice(0, 2), [{ day: 0, from: 1260, to: 1440 }, { day: 1, from: 0, to: 420 }])
  assert.deepEqual(segs.at(-1), { day: 0, from: 0, to: 420 }, 'Sunday night runs into Monday morning')
})

test('chosen weekdays only, a long window runs on, and nothing runs past a week', () => {
  assert.deepEqual(weekSegments({ start: '09:30', hours: 1, minutes: 15, weekdays: ['friday'] }), [{ day: 4, from: 570, to: 645 }])
  assert.deepEqual(weekSegments({ start: '22:00', hours: 50, minutes: 0, weekdays: ['saturday'] }).map(s => s.day), [5, 6, 0], 'Saturday 22:00 for 50 hours ends at Monday\'s midnight')
  assert.equal(weekSegments({ start: '00:00', hours: 500, minutes: 0, weekdays: ['monday'] }).length, 7)
  assert.deepEqual(weekSegments({ start: '', hours: 1, minutes: 0, weekdays: [] }), [])
})

test('a window says whether it holds now, and until when, or when it opens next', () => {
  const at = Date.UTC(2026, 9, 16, 22, 0) / 1000
  const night = { start: '21:00', hours: 10, minutes: 0, weekdays: [], location: 'UTC' }
  assert.deepEqual(muteWindowState(night, at), { active: true, end: Date.UTC(2026, 9, 17, 7, 0) / 1000 })
  const morning = { start: '09:00', hours: 1, minutes: 0, weekdays: [], location: 'UTC' }
  assert.deepEqual(muteWindowState(morning, at), { active: false, start: Date.UTC(2026, 9, 17, 9, 0) / 1000 })
})
