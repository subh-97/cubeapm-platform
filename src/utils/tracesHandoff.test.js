// The hand-off into Traces: a group's link, as the Traces page receives it,
// has to land on at least one row of the stream that page actually reads.
//
// The risk is quiet. The link and the stream are built in different modules,
// and a link that lands on an empty table looks exactly like "no traces for
// this error", which is a plausible thing for a demo to say. So every group
// both Errors surfaces can link from is followed through the chips App builds
// (filtersToChips), the evaluator and the field getter the Traces page uses.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BASE_TIME, REFERENCE_WINDOW, resolveWindow } from '@/data/timeWindow'
import { spanRowsForWindow } from '@/data/tracesExplorer'
import { ERROR_SIDES, errorGroupsForWindow, errorSpanRowsForWindow, tracesFiltersFor } from '@/data/errors'
import { applyChipsToLog, chipsToString } from '@/components/QueryBuilder'
import { tryParseConditions } from '@/utils/rawQuery'
import { getSpanFieldValue } from '@/utils/traceFields'
import { filtersToChips, errorSamplesFor, mergeErrorSpans } from './tracesHandoff.js'

// Pinned the way errors.test.js pins it, so a week ends exactly at its own now
// and the groups are the same on every run.
const OFF_SEC = -new Date(BASE_TIME).getTimezoneOffset() * 60
const BASE_SEC = Math.floor(BASE_TIME.getTime() / 1000)
const nowMs = (BASE_SEC - ((BASE_SEC - OFF_SEC) % 1800)) * 1000
const WINDOWS = {
  '1h': REFERENCE_WINDOW,
  '7d': resolveWindow({ kind: 'preset', value: '7d' }, nowMs),
}

// What TracesView reads for an applied query: the seeded spans, plus the error
// samples whose exception the query names. One sample a group is enough for
// every link to land.
const streamFor = (seeded, win, chips) => mergeErrorSpans(seeded, errorSamplesFor(win, chips))

// The service page's Client side folds callers away: one row per call.
const PER_CALL = ['side', 'service', 'spanName', 'exception']

// Every grouping a Traces link is built from: the Errors page's (both sides),
// the service tab's Server rows (the same, one service at a time), and the
// service tab's Client rows, one per call.
function linkedGroups(win) {
  const out = []
  for (const side of ERROR_SIDES) {
    const groups = errorGroupsForWindow(win, { side })
    out.push(...groups)
    for (const service of new Set(groups.map(g => g.service))) {
      out.push(...errorGroupsForWindow(win, { side, service, by: side === 'client' ? PER_CALL : undefined }))
    }
  }
  return out
}

const matches = (stream, chips) => stream.filter(r => applyChipsToLog(r, chips, getSpanFieldValue))

for (const [range, win] of Object.entries(WINDOWS)) {
  test(`every group's Traces link lands on a span of the merged stream (${range})`, () => {
    const seeded = spanRowsForWindow(win)
    const groups = linkedGroups(win)
    for (const side of ERROR_SIDES) assert.ok(groups.some(g => g.side === side), `${range}: no ${side} groups to check`)
    for (const g of groups) {
      const chips = filtersToChips(tracesFiltersFor(g))
      const hits = matches(streamFor(seeded, win, chips), chips)
      assert.ok(hits.length >= 1, `${range} ${g.side} ${g.id}: no span matches ${chipsToString(chips)}`)
      for (const r of hits) {
        assert.equal(r.tags.service, g.service)
        assert.equal(r.tags.span_kind, g.side)
        assert.equal(r.statusCode, 'ERROR')
      }
    }
  })

  test(`a link's chips still land after a round trip through the query text (${range})`, () => {
    // The bar spells the chips out for Copy, Save and Query history; read back,
    // they have to find the same spans, not a near miss — samples included,
    // which the read-back query has to admit by itself.
    const seeded = spanRowsForWindow(win)
    for (const g of linkedGroups(win)) {
      const chips = filtersToChips(tracesFiltersFor(g))
      const text = chipsToString(chips)
      const parsed = tryParseConditions(text)
      assert.ok(parsed.ok, `${text}: ${parsed.error}`)
      assert.deepEqual(
        matches(streamFor(seeded, win, parsed.chips), parsed.chips).map(r => r.id),
        matches(streamFor(seeded, win, chips), chips).map(r => r.id),
        text,
      )
    }
  })
}

test('the merged stream is newest first and keeps every row of both', () => {
  const win = REFERENCE_WINDOW
  const own = spanRowsForWindow(win)
  const extra = errorSpanRowsForWindow(win)
  const extraBefore = [...extra]
  const merged = mergeErrorSpans(own, extra)

  assert.equal(merged.length, own.length + extra.length)
  assert.deepEqual(new Set(merged.map(r => r.id)), new Set([...own, ...extra].map(r => r.id)))
  assert.equal(new Set(merged.map(r => r.id)).size, merged.length, 'no id is shared between the two')
  for (let i = 1; i < merged.length; i++) assert.ok(merged[i - 1].time >= merged[i].time, `row ${i} is out of order`)
  // The error rows are memoised per window and shared; the merge must not
  // reorder them under anyone else's feet.
  assert.deepEqual(extra, extraBefore)
  assert.equal(errorSpanRowsForWindow(win), extra)
  // Every merged row sits inside the window the page asked for.
  for (const r of extra) {
    assert.ok(r.time.getTime() >= win.start * 1000 && r.time.getTime() < Math.min(win.end, win.nowSec) * 1000, r.id)
  }
})

test('a merge with nothing to add hands the rows back as they were', () => {
  const own = spanRowsForWindow(REFERENCE_WINDOW)
  assert.equal(mergeErrorSpans(own, []), own)
  assert.equal(mergeErrorSpans(own, null), own)
})

test('a group\'s link arrives as one AND chain of eq leaves, ready for the bar', () => {
  // TracesView lands `{ chips }` as it is, so the chain has to be in the bar's
  // own shape already: flat leaves, the first with no connector.
  const [g] = errorGroupsForWindow(REFERENCE_WINDOW, { side: 'server', service: 'payment-service' })
  assert.deepEqual(filtersToChips(tracesFiltersFor(g)), [
    { field: 'service', op: 'eq', value: 'payment-service' },
    { field: 'span_kind', op: 'eq', value: 'server', connector: 'AND' },
    { field: 'status_code', op: 'eq', value: 'ERROR', connector: 'AND' },
    { field: 'span_name', op: 'eq', value: g.spanName, connector: 'AND' },
    { field: 'exception.type', op: 'eq', value: g.exception, connector: 'AND' },
  ])
})

test('a blank filter is dropped, an op is kept, and the first leaf has no connector', () => {
  assert.deepEqual(filtersToChips([{ field: 'x', value: '' }, { field: 'y', op: 'neq', value: 'v' }]),
    [{ field: 'y', op: 'neq', value: 'v' }])
  assert.deepEqual(filtersToChips(null), [])
})
