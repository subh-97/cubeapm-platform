// How a waterfall opens a trace, on the trace page and in the Traces drawer:
// which spans start folded, and which to unfold to show one. Built on
// assembleTrace, so the spans have the shape every dataset is read in.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assembleTrace } from '@/data/traceDetail'
import { autoFolds, revealing, LARGE_TRACE, AUTO_FOLD_DEPTH } from './traceInsights'

// A view-shape span: only what these readings use.
const span = (id, parentId, depth, start, duration, extra = {}) => ({
  id, parentId, depth, start, duration, name: id, service: 'svc', kind: 'internal',
  startTime: new Date(1_700_000_000_000 + start), childIds: [], status: 'ok', ...extra,
})

// Wires childIds from parentIds, in waterfall order.
function trace(spans) {
  for (const s of spans) s.childIds = spans.filter(c => c.parentId === s.id).map(c => c.id)
  return assembleTrace('t1', spans)
}

test('a trace that fits on a screen opens unfolded; a longer one folds below the second level', () => {
  const small = trace([span('r', null, 0, 0, 10), span('a', 'r', 1, 0, 5), span('b', 'a', 2, 0, 2), span('c', 'b', 3, 0, 1)])
  assert.equal(autoFolds(small.spans).size, 0)

  const spans = [span('r', null, 0, 0, 100)]
  for (let i = 0; i < LARGE_TRACE; i++) {
    spans.push(span(`c${i}`, 'r', 1, i, 1))
    spans.push(span(`g${i}`, `c${i}`, 2, i, 1))
    spans.push(span(`l${i}`, `g${i}`, 3, i, 1))
  }
  const big = trace(spans)
  const folds = autoFolds(big.spans)
  // Exactly the parents at AUTO_FOLD_DEPTH and below: the request and its
  // first calls stay open, and a leaf has nothing to fold.
  assert.equal(folds.size, LARGE_TRACE)
  for (const id of folds) {
    assert.ok(big.byId[id].depth >= AUTO_FOLD_DEPTH)
    assert.ok(big.byId[id].childIds.length > 0)
  }
})

test('revealing unfolds every ancestor of a span, and returns the same set when none was folded', () => {
  const t = trace([span('r', null, 0, 0, 10), span('a', 'r', 1, 0, 8), span('b', 'a', 2, 0, 5), span('c', 'b', 3, 0, 2)])
  const folds = new Set(['a', 'b'])
  const next = revealing(folds, t, 'c')
  assert.deepEqual([...next], [])
  assert.deepEqual([...folds], ['a', 'b'], 'never changed in place')
  // A fold below the span, or none at all on its path, leaves the set as it was.
  const below = new Set(['c'])
  assert.equal(revealing(below, t, 'b'), below)
  assert.equal(revealing(below, t, 'nope'), below)
})
