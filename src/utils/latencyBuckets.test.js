// The latency buckets: production's edges and labels, the bucket a latency
// falls in, and the log-normal arithmetic the Slow Requests charts count with.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BUCKETS_PER_DECADE, edgeMs, bucketOf, bucketBounds, fmtEdge, bucketRangeLabel, fmtLatency, edgeTicks,
  normalCdf, normalQuantile, Z90, lognormalFromP90, lognormalCdf, lognormalQuantile, bucketShare,
} from './latencyBuckets.js'

test('the edges and their labels are the ones production draws', () => {
  // Every label read off production's Slow Requests axes and tooltips.
  const seen = {
    14: '6 ms', 16: '7.74 ms', 17: '8.8 ms', 18: '10 ms', 19: '11.36 ms', 20: '12.92 ms', 22: '16.68 ms',
    23: '18.96 ms', 24: '21.54 ms', 26: '27.83 ms', 27: '31.62 ms', 28: '35.94 ms', 29: '40.84 ms',
    30: '46.42 ms', 31: '52.75 ms',
  }
  for (const [k, label] of Object.entries(seen)) assert.equal(fmtEdge(Number(k)), label, `edge ${k}`)
  assert.equal(bucketRangeLabel(19), '11.36 ms - 12.92 ms')
  assert.equal(bucketRangeLabel(17), '8.8 ms - 10 ms')
  assert.equal(bucketRangeLabel(27), '31.62 ms - 35.94 ms')
  assert.equal(bucketRangeLabel(17, 25), '8.8 ms - 27.83 ms', 'a range runs from the low edge of the first to the high edge of the last')
  assert.equal(bucketRangeLabel(25, 17), '8.8 ms - 27.83 ms', 'in either order')
})

test('a decade is eighteen buckets, and the labels change unit at a second', () => {
  assert.equal(BUCKETS_PER_DECADE, 18)
  assert.equal(edgeMs(0), 1)
  assert.equal(edgeMs(18), 10)
  assert.equal(edgeMs(36), 100)
  assert.equal(fmtEdge(38), '129.2 ms')
  assert.equal(fmtEdge(54), '1 s')
  assert.equal(fmtEdge(56), '1.29 s')
  assert.equal(fmtEdge(51), '681.3 ms')
  assert.equal(fmtEdge(57), '1.47 s')
  assert.equal(fmtEdge(-2), '0.77 ms')
  // Ratios are geometric: every bucket is about 13.6% wider than the last.
  for (let k = 0; k < 40; k++) {
    const r = edgeMs(k + 1) / edgeMs(k)
    assert.ok(r > 1.12 && r < 1.15, `edge ${k} → ${k + 1}: ${r}`)
  }
})

test('a latency falls in the bucket whose edges hold it, edges included at the bottom', () => {
  assert.equal(bucketOf(8.799), 17)
  assert.equal(bucketOf(8.8), 17)
  assert.equal(bucketOf(10), 18, 'an edge belongs to the bucket above it')
  assert.equal(bucketOf(9.9999), 17)
  assert.equal(bucketOf(1291.9), 55)
  assert.equal(bucketOf(1292), 56)
  for (const ms of [0.4, 3, 44.32, 612, 7500]) {
    const [lo, hi] = bucketBounds(bucketOf(ms))
    assert.ok(lo <= ms && ms < hi, `${ms} in [${lo}, ${hi})`)
  }
  assert.equal(bucketOf(0), -Infinity)
})

// A request's latency is whole nanoseconds, and the list, the duration chips
// and the bars all have to put one that sits exactly on an edge in the same
// bucket: the one above. 129.2 ms is where 1.292 × 100 would have missed.
test('a latency of whole nanoseconds on an edge falls in the bucket above it, at every edge', () => {
  for (let k = -18; k <= 90; k++) {
    const ns = Math.round(edgeMs(k) * 1e6)
    assert.equal(bucketOf(ns / 1e6), k, `edge ${k} (${ns} ns)`)
    if (ns > 1) assert.equal(bucketOf((ns - 1) / 1e6), k - 1, `a nanosecond under edge ${k}`)
  }
  assert.equal(edgeMs(38), 129200000 / 1e6)
})

test('a request reads to two decimals, in ms or s', () => {
  assert.equal(fmtLatency(44.321), '44.32 ms')
  assert.equal(fmtLatency(612), '612.00 ms')
  assert.equal(fmtLatency(999.996), '1.00 s', 'rounding up to a second reads as a second')
  assert.equal(fmtLatency(1270), '1.27 s')
  assert.equal(fmtLatency(null), '')
})

test('axis labels thin out by a stride that keeps the decades', () => {
  assert.deepEqual(edgeTicks(14, 30, 7), [15, 18, 21, 24, 27, 30], 'every third edge, 10 ms among them')
  const wide = edgeTicks(30, 60, 6)
  assert.ok(wide.length <= 6)
  assert.ok(wide.includes(36) && wide.includes(54), '100 ms and 1 s are labelled')
  assert.deepEqual(edgeTicks(18, 20, 40), [18, 19, 20, 21], 'with room, every edge')
})

test('the normal CDF and quantile invert each other', () => {
  for (const p of [0.001, 0.02, 0.1, 0.5, 0.9, 0.975, 0.999]) {
    assert.ok(Math.abs(normalCdf(normalQuantile(p)) - p) < 1e-6, `p=${p}`)
  }
  assert.ok(Math.abs(Z90 - 1.2815515655) < 1e-6)
  assert.equal(normalQuantile(0), -Infinity)
  assert.equal(normalQuantile(1), Infinity)
})

test('a log-normal built from a p90 has that p90, and its buckets sum to one', () => {
  const dist = lognormalFromP90(780, 0.5)
  assert.ok(Math.abs(lognormalQuantile(0.9, dist) - 780) < 1e-6)
  assert.ok(Math.abs(lognormalCdf(780, dist) - 0.9) < 1e-6)
  let sum = 0
  for (let k = -60; k < 120; k++) sum += bucketShare(k, dist)
  assert.ok(Math.abs(sum - 1) < 1e-6, `sum ${sum}`)
})
