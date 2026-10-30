// What the Waterfall tab keeps, and drops, as the reader steps through records
// with Newer and Older: the span picked in the waterfall belongs to the record
// it was picked on, and the folds belong to the trace. A static render cannot
// click, so the transitions are tested as the plain functions the tab runs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveWindow } from '@/data/timeWindow'
import { traceInRows } from '@/data/traceDetail'
import { TRACES_SOURCE } from '@/utils/explorerSources'
import { INITIAL, arrive, pick, toggleFold } from './spanTraceState'

const rows = TRACES_SOURCE.rowsForWindow(resolveWindow({ kind: 'preset', value: '1h' }))
const wideRow = rows.find(r => r.durationNs > 1.5e9)
const wide = traceInRows(wideRow.traceId, rows)
// Two spans of the 114-span trace, both deep enough to sit in a fold.
const [a, b] = wide.spans.filter(s => s.depth >= 3)
const other = traceInRows(rows.find(r => r.traceId !== wide.traceId).traceId, rows)

test('a span picked in the waterfall is dropped when the record changes, and stays dropped coming back', () => {
  let s = arrive(INITIAL, wide, a.id)
  assert.equal(s.picked, null)
  const x = wide.spans[0]
  s = pick(s, x)
  assert.equal(s.picked, x)
  // Same place again (a re-render): nothing changes, by identity.
  assert.equal(arrive(s, wide, a.id), s)
  s = arrive(s, wide, b.id)                 // Older
  assert.equal(s.picked, null)
  s = arrive(s, wide, a.id)                 // Newer, back to A
  assert.equal(s.picked, null, 'A shows its own span, not the one picked on an earlier visit')
  // Through a record with no trace and back: still A's own span.
  s = pick(s, x)
  s = arrive(arrive(s, null, null), wide, a.id)
  assert.equal(s.picked, null)
})

test('a span and its exception event are two records on one span: a pick on one does not carry to the other', () => {
  // The two share a trace and a span id, so it is the record that tells them apart.
  let s = arrive(INITIAL, wide, a.id, 'row-span')
  s = pick(s, wide.spans[0])
  s = arrive(s, wide, a.id, 'row-event')    // Older: the span's exception event
  assert.equal(s.picked, null)
  s = pick(s, wide.spans[0])
  s = arrive(s, wide, a.id, 'row-span')     // Newer: back on the span
  assert.equal(s.picked, null, 'the span shows itself, not what was picked on its event')
  // The same record re-rendered keeps its pick.
  s = pick(s, wide.spans[0])
  assert.equal(arrive(s, wide, a.id, 'row-span'), s)
})

test('the span opened is unfolded into view; a fold made after that stands; folds are kept per trace', () => {
  let s = arrive(INITIAL, wide, a.id)
  const folds = s.folds.get(wide.traceId)
  assert.ok(folds.size > 0, 'a large trace opens folded')
  for (let n = wide.byId[a.id]; n?.parentId; n = wide.byId[n.parentId]) {
    assert.ok(!folds.has(n.parentId), `ancestor ${n.parentId} of the opened span is open`)
  }
  // Fold A's parent by hand: it stands while A stays on screen.
  s = toggleFold(s, wide.traceId, a.parentId)
  assert.ok(arrive(s, wide, a.id).folds.get(wide.traceId).has(a.parentId))
  // Another trace and back: this trace's folds are as they were left, except
  // what a new arrival at A has to open again to show A.
  s = toggleFold(s, wide.traceId, wide.spans[1].id)
  s = arrive(s, other, other.root.id)
  assert.ok(s.folds.get(wide.traceId).has(wide.spans[1].id))
  s = arrive(s, wide, a.id)
  assert.ok(!s.folds.get(wide.traceId).has(a.parentId), 'arriving at A again opens its parent')
})
