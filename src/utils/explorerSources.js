/**
 * The datasets the span explorer (`TracesView`) can be pointed at.
 *
 * Traces and Mobile Traces are the same activity performed on different
 * records: the same rail, query bar, pipe toolbar, histogram, table and drawer.
 * What differs is the data and its vocabulary — which rows exist, which fields
 * they carry, how a row's severity is read, which bands the chart stacks by,
 * and the nouns the page speaks in. A source is that list, so the page holds no
 * knowledge of any one dataset and a second dataset is a config rather than a
 * copy of the page that would drift from the first.
 *
 * Contract (every key is read by TracesView):
 *   id                         stable key; the page is mounted with `key={id}`
 *   title                      breadcrumb and page title
 *   noun { one, many }         the count above the table ("513 spans")
 *   emptyText                  the table's empty state
 *   rowsForWindow(win)         the window's rows, newest first
 *   extraRowsFor(win, chips)   rows an applied query pulls in beyond the
 *                              window's own (Traces: the Errors page's samples),
 *                              or null for none
 *   mergeExtraRows(rows, extra) only called when there are extra rows, so
 *                              null beside a null extraRowsFor
 *   volumeForWindow(win)       one entry per `win.buckets`, a count per band
 *   bands [{ key, label, status, opacity, desc? }]
 *                              the histogram's stack, bottom to top; drawn in
 *                              `var(--<status>)`, `desc` titles the legend row
 *   bandOf(row)                the band key a row counts towards
 *   buildFacets(rows), facetFieldsFor(facets)
 *   fieldCatalog, getValue(row, field), allFields, defaultActiveFields,
 *   columnsFor(activeFields)   the query and table vocabulary
 *   formatDuration(raw)        the duration cell ('' reads as no duration)
 *   statusForStatusCode(raw)   the status_code cell's colour
 *   statusForRow(row)          the row's severity bar
 *   badgeFor(row)              the drawer's `{ status, label }` badge
 *   exampleQueries, queryHistory, initialRecents
 *   placeholder, freeTextNoun, freeTextMeta
 *                              the query bar's wording
 *   csvColumns, csvPrefix      the CSV download ('time' is the row's instant)
 *   alertEmptyLabel, alertNamePlaceholder
 *   docsUrl                    "Learn about Querying", or null to leave it out
 *   exploreDatasource          Explore's datasource for this data, or null when
 *                              Explore has none — both entry points then hide,
 *                              because sending the query to another dataset
 *                              would chart the wrong records under its names
 *
 * A `.js` module rather than part of the page so the page file exports only
 * its component (fast refresh), and so the configs can be tested without
 * mounting anything.
 */

import { spanRowsForWindow, spanVolumeForWindow, buildSpanFacets, spanFacetFieldsFor } from '@/data/tracesExplorer'
import { errorSamplesFor, mergeErrorSpans } from '@/utils/tracesHandoff'
import { BASE_TIME } from '@/data/observability'
import { bucketIndexOf } from '@/data/timeWindow'
import {
  TRACE_FIELD_CATALOG, getSpanFieldValue, SPAN_ALL_FIELDS, DEFAULT_ACTIVE_FIELDS,
  columnsFor, formatSpanDuration, statusForSpan, statusForSpanRow, spanBadgeFor,
  SPAN_BANDS, spanBandOf,
} from '@/utils/traceFields'
import {
  mobileRowsForWindow, mobileVolumeForWindow, buildMobileFacets, MOBILE_FACET_FIELDS,
} from '@/data/mobileTracesExplorer'
import {
  MOBILE_FIELD_CATALOG, getMobileFieldValue, MOBILE_ALL_FIELDS, MOBILE_DEFAULT_ACTIVE_FIELDS,
  mobileColumnsFor, statusForMobileRecord, mobileBadgeFor, MOBILE_BANDS, mobileBandOf,
  MOBILE_EXAMPLE_QUERIES, MOBILE_QUERY_HISTORY, MOBILE_INITIAL_RECENTS,
  MOBILE_PLACEHOLDER, MOBILE_FREE_TEXT_NOUN, MOBILE_FREE_TEXT_META, MOBILE_CSV_COLUMNS,
} from '@/utils/mobileTraceFields'
import { statusForHttpStatus } from '@/utils/status'

// Example queries offered in the bar's saved list. Traces get their own set —
// the log examples are written about fields a span does not have.
const TRACE_SAVED_QUERIES = [
  { id: 'tq1', name: 'Failing spans', chips: [{ field: 'status_code', op: 'eq', value: 'ERROR' }] },
  { id: 'tq2', name: 'Failing server spans', chips: [
    { field: 'span_kind', op: 'eq', value: 'server' },
    { field: 'status_code', op: 'eq', value: 'ERROR', connector: 'AND' },
  ] },
  { id: 'tq3', name: 'Database calls', chips: [{ field: 'category', op: 'eq', value: 'db' }] },
  { id: 'tq4', name: 'Span events only', chips: [{ field: 'event.domain', op: 'eq', value: 'span_event' }] },
]

// Recent queries, in the traces vocabulary. A log query offered here would be
// one that cannot run against spans, so the two pages keep separate histories.
const TRACE_QUERY_HISTORY = (() => {
  const now = BASE_TIME.getTime()
  return [
    { id: 1, query: 'status_code:=ERROR AND span_kind:=server', time: new Date(now - 6 * 60000), results: 142 },
    { id: 2, query: 'service:=payment-service AND category:=db', time: new Date(now - 21 * 60000), results: 318 },
    { id: 3, query: 'http.status_code:5*', time: new Date(now - 48 * 60000), results: 96 },
    { id: 4, query: 'db.system:=redis AND cache.hit:=false', time: new Date(now - 1.4 * 3600000), results: 57 },
    { id: 5, query: 'event.domain:=span_event AND event_name:=exception', time: new Date(now - 2.2 * 3600000), results: 74 },
    { id: 6, query: 'span_name:"POST /v1/shipment"', time: new Date(now - 3.5 * 3600000), results: 210 },
    { id: 7, query: 'exception.type:=java.lang.RuntimeException', time: new Date(now - 5 * 3600000), results: 61 },
    { id: 8, query: 'shipment.carrier:=fedex AND status_code:=ERROR', time: new Date(now - 9 * 3600000), results: 18 },
    { id: 9, query: 'net.peer.name:=api.twilio.com', time: new Date(now - 14 * 3600000), results: 133 },
    { id: 10, query: 'span_kind:=client AND category:=http', time: new Date(now - 26 * 3600000), results: 402 },
  ]
})()

// What the bar's recent list opens with before anything has been run here.
const TRACE_INITIAL_RECENTS = [
  [{ field: 'status_code', op: 'eq', value: 'ERROR' }],
  [{ field: 'span_kind', op: 'eq', value: 'server' }],
  [{ field: 'service', op: 'eq', value: 'payment-service' }],
]

export const TRACES_SOURCE = {
  id: 'traces',
  title: 'Traces',
  noun: { one: 'span', many: 'spans' },
  emptyText: 'No spans match this filter',

  rowsForWindow: spanRowsForWindow,
  // A link from the Errors page names an exception, and the window's seeded
  // spans may not hold one of it — see `errorSamplesFor`.
  extraRowsFor: errorSamplesFor,
  mergeExtraRows: mergeErrorSpans,

  volumeForWindow: spanVolumeForWindow,
  bands: SPAN_BANDS,
  bandOf: spanBandOf,

  buildFacets: buildSpanFacets,
  facetFieldsFor: spanFacetFieldsFor,

  fieldCatalog: TRACE_FIELD_CATALOG,
  getValue: getSpanFieldValue,
  allFields: SPAN_ALL_FIELDS,
  defaultActiveFields: DEFAULT_ACTIVE_FIELDS,
  columnsFor,

  formatDuration: formatSpanDuration,
  statusForStatusCode: statusForSpan,
  statusForRow: statusForSpanRow,
  badgeFor: spanBadgeFor,

  exampleQueries: TRACE_SAVED_QUERIES,
  queryHistory: TRACE_QUERY_HISTORY,
  initialRecents: TRACE_INITIAL_RECENTS,

  placeholder: 'Type a field name (e.g. service, span_name, duration) or free text',
  // Free text becomes a `_msg` chip, which a span answers with its name
  // (`getSpanFieldValue`) — so that is what the rows say they search, rather
  // than the builder's default wording about log messages.
  freeTextNoun: 'spans',
  freeTextMeta: 'Span name',

  csvColumns: ['time', 'service', 'span_name', 'span_kind', 'duration', 'status_code', 'trace_id', 'span_id'],
  csvPrefix: 'traces',

  alertEmptyLabel: 'All spans',
  alertNamePlaceholder: 'e.g. Error spans on payment-service',

  docsUrl: 'https://docs.cubeapm.com/traces/querying',
  exploreDatasource: 'traces',
}

/**
 * Mobile Traces: what the Cubedemo Shop app reported from the phones it runs
 * on — screens, taps, requests, custom events, crashes and ANRs — read through
 * the same explorer. See docs/decisions/mobile-traces-page.md for every way it
 * departs from production's page and why.
 */
export const MOBILE_TRACES_SOURCE = {
  id: 'mtraces',
  title: 'Mobile Traces',
  // A screen view, a tap or a crash is not a span to the person reading the
  // page, so the count and the empty state speak of events.
  noun: { one: 'event', many: 'events' },
  emptyText: 'No events match this filter',

  rowsForWindow: mobileRowsForWindow,
  // Nothing links into this page with rows the window lacks — the Errors
  // page's samples are backend spans, and merging them here would put a server
  // exception in a phone's stream.
  extraRowsFor: null,
  mergeExtraRows: null,

  // Stacked by severity band rather than prod's raw status code: prod draws
  // ten codes in one grey, and ten codes in severity colours would be four
  // reds nobody could tell apart.
  volumeForWindow: mobileVolumeForWindow,
  bands: MOBILE_BANDS,
  bandOf: mobileBandOf,

  // Prod's rail is the index's stream labels, so the list is pinned rather
  // than admitted by value shape — `service` has one value and would fail the
  // span test, while device model, OS and the rest would pass it.
  buildFacets: buildMobileFacets,
  facetFieldsFor: (facets) => MOBILE_FACET_FIELDS.filter(f => facets[f]?.length),

  fieldCatalog: MOBILE_FIELD_CATALOG,
  getValue: getMobileFieldValue,
  allFields: MOBILE_ALL_FIELDS,
  defaultActiveFields: MOBILE_DEFAULT_ACTIVE_FIELDS,
  columnsFor: mobileColumnsFor,

  // A request's duration is in nanoseconds, as a span's is. Every other record
  // has none, and the cell reads that as a blank rather than prod's "0 ns".
  formatDuration: formatSpanDuration,
  // status_code here is the HTTP answer (0 = none), not OTel's ERROR/UNSET.
  statusForStatusCode: statusForHttpStatus,
  statusForRow: statusForMobileRecord,
  badgeFor: mobileBadgeFor,

  exampleQueries: MOBILE_EXAMPLE_QUERIES,
  queryHistory: MOBILE_QUERY_HISTORY,
  initialRecents: MOBILE_INITIAL_RECENTS,

  placeholder: MOBILE_PLACEHOLDER,
  freeTextNoun: MOBILE_FREE_TEXT_NOUN,
  freeTextMeta: MOBILE_FREE_TEXT_META,

  csvColumns: MOBILE_CSV_COLUMNS,
  csvPrefix: 'mobile-traces',

  alertEmptyLabel: 'All mobile events',
  alertNamePlaceholder: 'e.g. Crashes on Cubedemo Shop 4.2.8',

  // No published guide for querying this index; a link to the Traces one
  // would teach fields a phone does not report.
  docsUrl: null,
  // Explore has no mobile datasource yet. Sending 'traces' would chart
  // backend spans under mobile field names, so both entry points hide.
  exploreDatasource: null,
}

/**
 * The histogram under a filter.
 *
 * The chart's counts are production-shaped volumes, while the rows are a few
 * hundred samples of them, so a filter cannot be counted off the chart — it is
 * scaled onto it. Within a bucket, each band is scaled by the share of that
 * bucket's sample rows of the band the filter kept, so the chart keeps a
 * realistic silhouette while still agreeing with the filter.
 *
 * A bucket with no sample row of a band says nothing about that band there:
 * the band is rare, not absent. Scaling it to 0 made every rare band vanish
 * under any filter at all — even one that kept every row. Such a bucket is
 * scaled by the band's share across the whole window instead, which is the
 * best estimate the samples can give. A short window can hold no sample of a
 * band at all — five minutes of mobile traffic rarely includes a 4xx — and
 * then even that says nothing, so the band follows the share of all rows the
 * filter kept.
 *
 * `bands` and `bandOf` come from the source; a row whose band is not listed is
 * not counted. Every input is left as it was.
 */
export function filterVolume({ volume, bands, bandOf, win, allRows, filteredRows }) {
  const keys = bands.map(b => b.key)
  const zero = () => Object.fromEntries(keys.map(k => [k, 0]))

  const tally = (rows) => {
    const perBucket = []
    const whole = zero()
    for (const r of rows) {
      const k = bandOf(r)
      if (!(k in whole)) continue
      const i = bucketIndexOf(win, r.time.getTime())
      if (i < 0) continue
      if (!perBucket[i]) perBucket[i] = zero()
      perBucket[i][k]++
      whole[k]++
    }
    return { perBucket, whole }
  }
  const all = tally(allRows)
  const filt = tally(filteredRows)

  const keptShare = allRows.length > 0 ? filteredRows.length / allRows.length : 0
  const windowShare = Object.fromEntries(keys.map(k => [
    k, all.whole[k] > 0 ? filt.whole[k] / all.whole[k] : keptShare,
  ]))

  return volume.map((d, i) => {
    const a = all.perBucket[i]
    const f = filt.perBucket[i]
    const out = { ...d }
    let total = 0
    for (const k of keys) {
      const v = a?.[k] > 0
        ? Math.round(d[k] * (f?.[k] ?? 0) / a[k])
        : Math.round(d[k] * windowShare[k])
      out[k] = v
      total += v
    }
    out.total = total
    return out
  })
}
