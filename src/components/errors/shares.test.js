// The drawer's host and version shares: whole percentages that add up to 100,
// checked against every breakdown the data layer hands the drawer.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { REFERENCE_WINDOW, resolveWindow } from '@/data/timeWindow'
import { ERROR_SIDES, errorGroupsForWindow, errorBreakdownFor } from '@/data/errors'
import { largestRemainder } from '@/utils/apportion'
import { sharePercents, shareText } from './shares.js'

const sum = xs => xs.reduce((a, x) => a + x, 0)

test('shares rounded one by one can miss 100; rounded together they never do', () => {
  // The 1h capture group's versions: 62.5% and 37.5% each round up.
  assert.equal(Math.round((145 / 232) * 100) + Math.round((87 / 232) * 100), 101)
  assert.deepEqual(sharePercents([145, 87]), [63, 37])
  // Thirds each round down.
  assert.deepEqual(sharePercents([1, 1, 1]), [34, 33, 33])
  assert.deepEqual(sharePercents([70, 59, 59, 44]), [30, 26, 25, 19])
})

test('the leftover point goes to the largest fraction, then the bigger count', () => {
  assert.deepEqual(sharePercents([2, 1]), [67, 33])
  assert.deepEqual(sharePercents([1, 2]), [33, 67])
  assert.deepEqual(sharePercents([5]), [100])
})

test('nothing counted is all zeros, and odd entries count as nothing', () => {
  assert.deepEqual(sharePercents([]), [])
  assert.deepEqual(sharePercents([0, 0]), [0, 0])
  assert.deepEqual(sharePercents([3, 0, -1, NaN]), [100, 0, 0, 0])
})

test('the same rounding splits any total, not just 100', () => {
  // A sample of 7 split 4/2/1, scaled up to a group of 232.
  assert.deepEqual(largestRemainder([4, 2, 1], 232), [133, 66, 33])
  assert.deepEqual(largestRemainder([1, 1, 1], 2), [1, 1, 0])
  assert.deepEqual(largestRemainder([1, 3], 1), [0, 1])
  assert.deepEqual(largestRemainder([2, 1], 0), [0, 0])
  assert.deepEqual(largestRemainder([0, -2, NaN], 10), [0, 0, 0])
  for (const total of [1, 7, 99, 100, 101, 2350]) {
    assert.equal(sum(largestRemainder([70, 59, 59, 44, 1], total)), total)
  }
  assert.deepEqual(sharePercents([145, 87]), largestRemainder([145, 87], 100))
})

test('a share that rounds to nothing still reads as there', () => {
  const pcts = sharePercents([1000, 1])
  assert.deepEqual(pcts, [100, 0])
  assert.equal(shareText(pcts[1], 1), '<1%')
  assert.equal(shareText(0, 0), '0%')
  assert.equal(shareText(37, 87), '37%')
})

test('every breakdown the drawer is handed shows shares that add up to 100', () => {
  const windows = [REFERENCE_WINDOW, resolveWindow({ kind: 'preset', value: '7d' })]
  let checked = 0
  for (const win of windows) {
    for (const side of ERROR_SIDES) {
      for (const group of errorGroupsForWindow(win, { side })) {
        const b = errorBreakdownFor(group, win)
        for (const rows of [b.host, b.version]) {
          if (!rows.length) continue
          assert.equal(sum(sharePercents(rows.map(r => r.count))), 100)
          checked++
        }
      }
    }
  }
  assert.ok(checked > 100)
})
