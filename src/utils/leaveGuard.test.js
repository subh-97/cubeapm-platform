// The leave guard (leaveGuard.js): with nothing registered, leaving is
// immediate; with a guard, the guard decides; and removing an old guard never
// removes the one registered after it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setLeaveGuard, requestLeave, hasLeaveGuard } from './leaveGuard'

test('with nothing to lose, leaving is immediate', () => {
  let left = 0
  requestLeave(() => { left++ })
  assert.equal(left, 1)
  assert.equal(hasLeaveGuard(), false)
})

test('a registered guard is asked instead, and leaves only if it says so', () => {
  let asked = null
  let left = 0
  const remove = setLeaveGuard((proceed) => { asked = proceed })
  requestLeave(() => { left++ })
  assert.equal(left, 0)
  asked()
  assert.equal(left, 1)
  remove()
  assert.equal(hasLeaveGuard(), false)
})

test('removing an old guard leaves the newer one in place', () => {
  const removeOld = setLeaveGuard(() => {})
  const removeNew = setLeaveGuard(() => {})
  removeOld()
  assert.equal(hasLeaveGuard(), true)
  removeNew()
  assert.equal(hasLeaveGuard(), false)
})
