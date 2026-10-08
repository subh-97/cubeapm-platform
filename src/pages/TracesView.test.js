// Which error samples the Traces page merges into its stream (errorSamplesFor).
//
// Two promises pull against each other. A link from Errors has to land on rows,
// and the samples are what it lands on. But the unfiltered table, the facet rail
// and the histogram describe the seeded stream, and samples merged into every
// view multiplied the table's ERROR share and put hosts and a version on the
// rail that only ever failed. So the samples join only a query that names their
// exception: every link does, nothing else does.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BASE_TIME, REFERENCE_WINDOW, resolveWindow } from '@/data/timeWindow'
import { spanRowsForWindow } from '@/data/tracesExplorer'
import { ERROR_SIDES, errorGroupsForWindow, errorSpanRowsForWindow, tracesFiltersFor } from '@/data/errors'
import { applyChipsToLog, chipsToString } from '@/components/QueryBuilder'
import { tryParseConditions } from '@/utils/rawQuery'
import { getSpanFieldValue } from '@/utils/traceFields'
import { newGroup } from '@/utils/queryTree'
import { filtersToChips, errorSamplesFor, mergeErrorSpans } from '@/utils/tracesHandoff'

// Pinned the way errors.test.js pins it, so a week ends exactly at its own now
// and the groups are the same on every run.
const OFF_SEC = -new Date(BASE_TIME).getTimezoneOffset() * 60
const BASE_SEC = Math.floor(BASE_TIME.getTime() / 1000)
const nowMs = (BASE_SEC - ((BASE_SEC - OFF_SEC) % 1800)) * 1000
const WINDOWS = {
  '5m': resolveWindow({ kind: 'preset', value: '5m' }, nowMs),
  '1h': REFERENCE_WINDOW,
  '24h': resolveWindow({ kind: 'preset', value: '24h' }, nowMs),
  '7d': resolveWindow({ kind: 'preset', value: '7d' }, nowMs),
}

// Exactly what TracesView reads for an applied query. The seeded rows come in
// from outside because every read of them mints new rows, and the page reads
// them once a window.
const streamFor = (seeded, win, chips) => mergeErrorSpans(seeded, errorSamplesFor(win, chips))
const matches = (stream, chips) => stream.filter(r => applyChipsToLog(r, chips, getSpanFieldValue))

// The service page's Client side folds callers away: one row per call.
const PER_CALL = ['side', 'service', 'spanName', 'exception']

// Every grouping a Traces link is built from: the Errors page's (both sides),
// the service tab's Server rows, and its Client rows, one per call.
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

for (const [range, win] of Object.entries(WINDOWS)) {
  test(`with no query, and with queries that name no exception, the stream is the seeded one (${range})`, () => {
    const seeded = spanRowsForWindow(win)
    // The page passes its own seeded array through untouched, so the facets,
    // the table and the CSV describe what the histogram draws.
    assert.equal(streamFor(seeded, win, []), seeded)
    const queries = [
      [{ field: 'status_code', op: 'eq', value: 'ERROR' }],
      [{ field: 'service', op: 'eq', value: 'payment-service' }],
      [
        { field: 'service', op: 'eq', value: 'payment-service' },
        { field: 'span_kind', op: 'eq', value: 'server', connector: 'AND' },
        { field: 'status_code', op: 'eq', value: 'ERROR', connector: 'AND' },
      ],
    ]
    for (const chips of queries) assert.equal(streamFor(seeded, win, chips), seeded, chipsToString(chips))
  })

  test(`every group's Traces link lands on a span, and admits only the samples it names (${range})`, () => {
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
      for (const r of errorSamplesFor(win, chips)) assert.equal(r.tags['exception.type'], g.exception, g.id)
    }
  })

  test(`a link's chips admit the same samples after a round trip through the query text (${range})`, () => {
    // Copy, Save and Query history carry the text, not the chips; read back, it
    // has to find the same rows, samples included.
    for (const g of linkedGroups(win)) {
      const chips = filtersToChips(tracesFiltersFor(g))
      const text = chipsToString(chips)
      const parsed = tryParseConditions(text)
      assert.ok(parsed.ok, `${text}: ${parsed.error}`)
      assert.deepEqual(errorSamplesFor(win, parsed.chips).map(r => r.id), errorSamplesFor(win, chips).map(r => r.id), text)
    }
  })
}

test('either spelling of the exception names it, and a query typed by hand behaves like the link', () => {
  const win = REFERENCE_WINDOW
  const [sample] = errorSpanRowsForWindow(win)
  const type = sample.tags['exception.type']
  for (const field of ['exception.type', 'exception']) {
    const got = errorSamplesFor(win, [{ field, op: 'eq', value: type }])
    assert.ok(got.some(r => r.id === sample.id), field)
    for (const r of got) assert.equal(r.tags['exception.type'], type, field)
  }
})

test('a leaf that leaves an exception out asks for no samples', () => {
  const win = REFERENCE_WINDOW
  const [sample] = errorSpanRowsForWindow(win)
  const type = sample.tags['exception.type']
  for (const leaf of [
    { field: 'exception.type', op: 'neq', value: type },
    { field: 'exception.type', op: 'not_in', value: [type] },
    { field: 'exception.type', op: 'nregex', value: 'Jedis' },
    { field: 'exception.type', op: 'empty', value: '' },
  ]) {
    assert.deepEqual(errorSamplesFor(win, [leaf]), [], leaf.op)
  }
})

test('an OR beside the exception does not widen the samples past the one it names', () => {
  // `exception.type = X OR service = S` finds every sample on S as a query, but
  // only X's samples were asked for; the rest of S stays the seeded stream.
  const win = REFERENCE_WINDOW
  const samples = errorSpanRowsForWindow(win)
  const sample = samples.find(r => samples.some(o => o.tags.service === r.tags.service && o.tags['exception.type'] !== r.tags['exception.type']))
  assert.ok(sample, 'no service with two exceptions to tell apart')
  const type = sample.tags['exception.type']
  const chips = [
    { field: 'exception.type', op: 'eq', value: type },
    { field: 'service', op: 'eq', value: sample.tags.service, connector: 'OR' },
  ]
  const got = errorSamplesFor(win, chips)
  assert.ok(got.length >= 1)
  for (const r of got) assert.equal(r.tags['exception.type'], type)

  // The same inside a group, which is how a hand-built OR usually arrives.
  const grouped = [newGroup(chips), { field: 'status_code', op: 'eq', value: 'ERROR', connector: 'AND' }]
  assert.deepEqual(errorSamplesFor(win, grouped).map(r => r.id), got.map(r => r.id))
})
