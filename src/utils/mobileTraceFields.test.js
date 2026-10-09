// The Mobile Traces vocabulary: the field catalogue the query bar types
// against, the table's columns, a record's severity and band, and the example
// and recent queries.
//
// The catalogue's types are the part with consequences: a numeric field typed
// as text is offered no range operators and no avg(), and a long or unique one
// without `highCard` gets a picklist of every row's value. The severity is the
// other: the row gutter, the status cell, the drawer badge and the histogram
// band all read it, so a record must land in the same band everywhere.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MOBILE_FIELD_CATALOG, getMobileFieldValue, MOBILE_COLUMNS, MOBILE_ALL_FIELDS, MOBILE_DEFAULT_ACTIVE_FIELDS,
  mobileColumnsFor, statusForMobileRecord, mobileBadgeFor, MOBILE_BANDS, mobileBandOf, MOBILE_EXAMPLE_QUERIES,
  MOBILE_QUERY_HISTORY, MOBILE_INITIAL_RECENTS, MOBILE_PLACEHOLDER, MOBILE_CSV_COLUMNS,
} from './mobileTraceFields.js'
import { SPAN_COLUMNS } from './traceFields.js'
import { splitQuery, tryParseConditions } from './rawQuery.js'
import { applyChipsToLog } from '@/components/QueryBuilder'
import { BASE_TIME } from '@/data/timeWindow'
import { mobileReferenceRows, MOBILE_BAND_KEYS } from '@/data/mobileTracesExplorer'

const rows = mobileReferenceRows
const byField = Object.fromEntries(MOBILE_FIELD_CATALOG.map(f => [f.field, f]))
const first = fn => rows.find(fn)

test('the catalogue types every numeric field as numeric', () => {
  const numeric = [
    'duration', 'responseTime', 'bytesSent', 'bytesReceived', 'cartValue', 'discountAmount', 'itemCount',
    'resultCount', 'timeSinceLoad', 'interactionDuration', 'device_memory_usage', 'networkErrorCode',
    'process_id', 'timestamp', 'crash_timestamp', 'count',
  ]
  for (const f of numeric) assert.equal(byField[f]?.type, 'keyword', f)
  // And the values those fields carry do parse, so avg() over them is a number.
  for (const f of numeric) {
    for (const r of rows) {
      const v = r.tags[f]
      if (v != null) assert.ok(Number.isFinite(Number(v)), `${f}=${v}`)
    }
  }
})

test('ids and long text never get a value picklist', () => {
  const highCard = [
    'trace_id', 'span_id', 'session_id', 'sessionId', 'device_id', 'app_exit_id', 'stacktrace',
    'analytics_events', 'thread_dump', 'exception_cause', 'description', 'networkError', 'requestUrl',
    'crash_location',
  ]
  for (const f of highCard) assert.equal(byField[f]?.highCard, true, f)
  assert.equal(byField.eventType.highCard, false)
  assert.equal(byField.category.highCard, false)
})

test('curated fields lead with descriptions, and every field a record has is reachable', () => {
  const fields = MOBILE_FIELD_CATALOG.map(f => f.field)
  assert.equal(new Set(fields).size, fields.length, 'no duplicates')
  assert.deepEqual(fields.slice(0, 5), ['eventType', 'category', 'event.domain', 'cube.eventType', 'service'])
  for (const f of MOBILE_FIELD_CATALOG) assert.ok(f.desc, f.field)
  for (const r of rows) for (const k of Object.keys(r.tags)) assert.ok(byField[k], `${k} is not in the catalogue`)
})

test('free text reads the record name; every other field reads its tag', () => {
  const r = first(x => x.tags.eventType === 'MobileRequest')
  assert.equal(getMobileFieldValue(r, '_msg'), r.spanName)
  assert.equal(getMobileFieldValue(r, 'message'), r.spanName)
  assert.equal(getMobileFieldValue(r, 'requestDomain'), r.tags.requestDomain)
  assert.equal(getMobileFieldValue(r, 'crash_location'), undefined)
})

test('the table opens on the span table\'s columns plus crash_location', () => {
  assert.deepEqual(MOBILE_COLUMNS.map(c => c.key), [...SPAN_COLUMNS.map(c => c.key), 'crash_location'])
  const trace = MOBILE_COLUMNS.find(c => c.key === 'trace_id')
  assert.equal(trace.link, 'trace')
  const crash = MOBILE_COLUMNS[MOBILE_COLUMNS.length - 1]
  assert.deepEqual(crash, {
    key: 'crash_location', label: 'crash_location', width: 320, link: 'filter', linkTitle: 'Show every crash at this location',
  })
  assert.deepEqual([...MOBILE_DEFAULT_ACTIVE_FIELDS], MOBILE_COLUMNS.map(c => c.key))
  assert.deepEqual(MOBILE_CSV_COLUMNS, ['time', ...MOBILE_COLUMNS.map(c => c.key)])
})

test('the picker lists the defaults in order, then every other field sorted', () => {
  const keys = MOBILE_ALL_FIELDS.map(f => f.key)
  const n = MOBILE_COLUMNS.length
  assert.deepEqual(keys.slice(0, n), MOBILE_COLUMNS.map(c => c.key))
  const rest = keys.slice(n)
  assert.deepEqual(rest, [...rest].sort())
  assert.ok(rest.includes('eventType') && rest.includes('device_model'))
  for (const f of MOBILE_ALL_FIELDS) assert.equal(f.label, f.key)
})

test('columns come back in the picker\'s order, whatever order they were ticked in', () => {
  const cols = mobileColumnsFor(new Set(['crash_location', 'eventType', 'service']))
  assert.deepEqual(cols.map(c => c.key), ['service', 'crash_location', 'eventType'])
  assert.equal(cols[2].width, 160)
  assert.equal(cols[1].link, 'filter')
})

test('a record\'s severity: no answer, 5xx and crashes critical; 4xx warning; the rest healthy or neutral', () => {
  const cases = [
    [r => r.tags.eventType === 'MobileCrash', 'critical'],
    [r => r.tags.eventType === 'ANR', 'critical'],
    [r => r.tags.status_code === '0', 'critical'],
    [r => /^5\d\d$/.test(r.tags.status_code ?? ''), 'critical'],
    [r => /^4\d\d$/.test(r.tags.status_code ?? ''), 'warning'],
    [r => r.tags.status_code === '200', 'healthy'],
    [r => r.tags.category === 'Interaction', 'healthy'],
    [r => r.spanName === 'Mobile/App/Install', 'healthy'],
    [r => r.tags.category === 'Custom', 'neutral'],
  ]
  for (const [fn, want] of cases) {
    const matching = rows.filter(fn)
    assert.ok(matching.length > 0, want)
    for (const r of matching) assert.equal(statusForMobileRecord(r), want, `${r.spanName} ${r.tags.status_code ?? ''}`)
  }
  // The row's own level, which the drawer falls back to, agrees.
  const LEVEL = { critical: 'error', warning: 'warn' }
  for (const r of rows) assert.equal(r.level, LEVEL[statusForMobileRecord(r)] ?? 'info', r.id)
})

test('the badge is labelled by the code, else by what the record is', () => {
  const req = first(r => r.tags.status_code === '502' || r.tags.status_code === '503')
  assert.deepEqual(mobileBadgeFor(req), { status: 'critical', label: req.tags.status_code })
  const crash = first(r => r.tags.eventType === 'MobileCrash')
  assert.deepEqual(mobileBadgeFor(crash), { status: 'critical', label: 'MobileCrash' })
  const custom = first(r => r.tags.eventType === 'CheckoutStep')
  assert.deepEqual(mobileBadgeFor(custom), { status: 'neutral', label: 'CheckoutStep' })
  const screen = first(r => r.tags.category === 'Interaction')
  assert.deepEqual(mobileBadgeFor(screen), { status: 'healthy', label: 'UNSET' })
})

test('bands stack by severity, bottom to top, one status each', () => {
  assert.deepEqual(MOBILE_BANDS.map(b => b.key), MOBILE_BAND_KEYS)
  assert.deepEqual(MOBILE_BANDS.map(b => b.status), ['healthy', 'neutral', 'warning', 'critical'])
  for (const b of MOBILE_BANDS) {
    assert.ok(b.label && b.desc && b.opacity > 0 && b.opacity <= 1, b.key)
    assert.ok(!/#[0-9a-f]{3,6}/i.test(JSON.stringify(b)), `${b.key} has a raw colour`)
  }
  const BAND = { critical: 'fail', warning: 'warn', healthy: 'ok', neutral: 'none' }
  const seen = new Set()
  for (const r of rows) {
    const band = mobileBandOf(r)
    assert.equal(band, BAND[statusForMobileRecord(r)], r.id)
    seen.add(band)
  }
  assert.deepEqual([...seen].sort(), [...MOBILE_BAND_KEYS].sort(), 'the hour\'s rows fill every band')
})

test('every example query finds something in the hour', () => {
  assert.deepEqual(MOBILE_EXAMPLE_QUERIES.map(q => q.name), ['Crashes', 'Failed requests', 'Payment request errors', 'ANRs'])
  for (const q of MOBILE_EXAMPLE_QUERIES) {
    const hits = rows.filter(r => applyChipsToLog(r, q.chips, getMobileFieldValue))
    assert.ok(hits.length > 0, q.name)
  }
})

test('the history is ten mobile queries that read back into the builder', () => {
  assert.equal(MOBILE_QUERY_HISTORY.length, 10)
  const fields = new Set(MOBILE_FIELD_CATALOG.map(f => f.field))
  for (const h of MOBILE_QUERY_HISTORY) {
    const parsed = tryParseConditions(splitQuery(h.query).conditions)
    assert.ok(parsed.ok, h.query)
    for (const c of parsed.chips) assert.ok(fields.has(c.field), `${h.query}: ${c.field}`)
    assert.ok(h.time.getTime() < BASE_TIME.getTime())
  }
  for (const recent of MOBILE_INITIAL_RECENTS) {
    for (const c of recent) assert.ok(fields.has(c.field), c.field)
    assert.ok(rows.some(r => applyChipsToLog(r, recent, getMobileFieldValue)))
  }
  assert.ok(MOBILE_PLACEHOLDER.includes('crash_location'))
})
