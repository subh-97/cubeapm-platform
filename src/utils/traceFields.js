import { spanRows } from '@/data/tracesExplorer'
import { isIdentityValue } from '@/data/observability'
import { STATUS } from '@/utils/status'

/**
 * The traces half of the query vocabulary.
 *
 * Logs and traces share one query grammar and one builder; what differs is the
 * nouns. This is that list for spans — the fields the bar autocompletes, what
 * type each one is (which decides the operator set offered), and which are
 * identities that must never be handed a value picklist.
 *
 * Curated entries come first because they carry descriptions and typing; every
 * other field a span actually has is appended from the rows, so a new tag is
 * still reachable from the keyboard without anyone editing this file.
 */

// `keyword` here means numeric-ish: the builder offers range operators for it.
const CURATED = [
  { field: 'service',          type: 'string',  desc: 'Service that emitted the span' },
  { field: 'span_name',        type: 'string',  desc: 'Operation name' },
  { field: 'span_kind',        type: 'string',  desc: 'Span kind (server, client, internal)' },
  { field: 'status_code',      type: 'string',  desc: 'Span status (ERROR, UNSET)' },
  { field: 'duration',         type: 'keyword', desc: 'Span duration (nanoseconds)' },
  { field: 'trace_id',         type: 'string',  desc: 'Trace identifier', highCard: true },
  { field: 'span_id',          type: 'string',  desc: 'Span identifier', highCard: true },
  { field: 'parent_id',        type: 'string',  desc: 'Parent span identifier', highCard: true },
  { field: 'root_name',        type: 'string',  desc: 'Name of the trace root span' },
  { field: 'event.domain',     type: 'string',  desc: 'Record domain (span, span_event)' },
  { field: 'event_name',       type: 'string',  desc: 'Span event name (exception, retry)' },
  { field: 'category',         type: 'string',  desc: 'Span category (http, db, internal)' },
  { field: 'error',            type: 'string',  desc: 'Whether the span failed' },
  { field: 'num_events',       type: 'keyword', desc: 'Events recorded on the span' },

  { field: 'http.method',      type: 'string',  desc: 'HTTP method' },
  { field: 'http.route',       type: 'string',  desc: 'Matched route template' },
  { field: 'http.status_code', type: 'keyword', desc: 'HTTP status code' },
  { field: 'http.target',      type: 'string',  desc: 'Request path' },
  { field: 'http.url',         type: 'string',  desc: 'Outbound request URL' },
  { field: 'http.scheme',      type: 'string',  desc: 'URL scheme' },
  { field: 'http.client_ip',   type: 'string',  desc: 'Client IP address' },
  { field: 'http.user_agent',  type: 'string',  desc: 'User agent' },

  { field: 'db.system',        type: 'string',  desc: 'Database engine' },
  { field: 'db.operation',     type: 'string',  desc: 'Database operation' },
  { field: 'db.name',          type: 'string',  desc: 'Database name' },
  { field: 'db.sql.table',     type: 'string',  desc: 'SQL table' },
  { field: 'db.statement',     type: 'string',  desc: 'Database statement', highCard: true },

  { field: 'exception.type',   type: 'string',  desc: 'Exception class' },
  { field: 'exception.message', type: 'string', desc: 'Exception message' },

  { field: 'host.name',        type: 'string',  desc: 'Host' },
  { field: 'net.peer.name',    type: 'string',  desc: 'Remote host' },
  { field: 'net.peer.port',    type: 'keyword', desc: 'Remote port' },
  { field: 'service.version',  type: 'string',  desc: 'Service version' },
  { field: 'otel.library.name', type: 'string', desc: 'Instrumentation library' },
  { field: 'thread.name',      type: 'string',  desc: 'Thread name' },
]

const CURATED_NAMES = new Set(CURATED.map(f => f.field))

// Anything long, opaque and unique per row is an identity: offering a value
// picklist for it would list the rows back at you.
const IDENTITY_FIELDS = new Set([
  'trace_id', 'span_id', 'parent_id', 'db.statement', 'db.connection_string',
  'exception.stacktrace', '_resource.container.id',
])

const NUMERIC_HINT = /(\.port|_length|\.pid|\.id|_ms|\.attempt|\.max|count|duration|num_)$/

const DISCOVERED = [...new Set(spanRows.flatMap(r => Object.keys(r.tags)))]
  .filter(k => !CURATED_NAMES.has(k))
  .sort()
  .map(field => ({
    field,
    type: NUMERIC_HINT.test(field) ? 'keyword' : 'string',
    desc: 'Span attribute',
    highCard: IDENTITY_FIELDS.has(field),
  }))

export const TRACE_FIELD_CATALOG = [...CURATED, ...DISCOVERED]

/** Value of a field on a span record — everything lives in `tags`. */
export function getSpanFieldValue(span, field) {
  if (field === '_msg' || field === 'message') return span.spanName
  return span.tags?.[field]
}

/**
 * Columns the table always shows, in order. `Time` is rendered separately.
 *
 * `link` marks a value that is a control rather than text: 'trace' opens the
 * trace it names, 'filter' narrows the results to it (with `linkTitle` saying
 * what that does). The explorer renders both the same way, so a dataset only
 * has to say which of its columns lead somewhere.
 */
export const SPAN_COLUMNS = [
  { key: 'service',     label: 'service',     width: 168 },
  { key: 'span_name',   label: 'span_name',   width: 300, grow: true },
  { key: 'span_kind',   label: 'span_kind',   width: 92 },
  { key: 'duration',    label: 'duration',    width: 104, align: 'right' },
  { key: 'status_code', label: 'status_code', width: 108 },
  { key: 'trace_id',    label: 'trace_id',    width: 246, mono: true, link: 'trace' },
  { key: 'span_id',     label: 'span_id',     width: 148, mono: true },
]

// Per-column rendering. Anything not named here is an attribute column and
// gets the default width.
export const SPAN_COLUMN_META = Object.fromEntries(SPAN_COLUMNS.map(c => [c.key, c]))

const DEFAULT_COLUMN_KEYS = SPAN_COLUMNS.map(c => c.key)

/**
 * Every field the picker offers, in the order the table lays them out.
 *
 * The default columns lead, in their fixed order, and every other attribute a
 * span carries follows alphabetically — including the SDK's `_resource.*`
 * block. Those are excluded from FACETS, where a value present identically on
 * every row of its kind narrows nothing, but a column is a different question:
 * the picker's job is to say what this record can show you, and answering it
 * with a shorter list than the record actually has is the picker lying about
 * the data. The drawer still collapses them, because there they compete with
 * fields you came to read.
 */
export const SPAN_ALL_FIELDS = [
  ...DEFAULT_COLUMN_KEYS,
  ...[...new Set(spanRows.flatMap(r => Object.keys(r.tags)))]
    .filter(k => !DEFAULT_COLUMN_KEYS.includes(k))
    .sort(),
].map(key => ({ key, label: key }))

/** Columns shown before anyone touches the picker. */
export const DEFAULT_ACTIVE_FIELDS = new Set(DEFAULT_COLUMN_KEYS)

/**
 * The active fields as ordered columns.
 *
 * Order comes from SPAN_ALL_FIELDS rather than from the order they were ticked,
 * so unticking a column and putting it back returns it to its own slot instead
 * of appending it to the end of the table.
 */
export function columnsFor(activeFields) {
  return SPAN_ALL_FIELDS
    .filter(f => activeFields.has(f.key))
    .map(f => SPAN_COLUMN_META[f.key] ?? { key: f.key, label: f.key, width: 160 })
}

/**
 * Span duration for the table.
 *
 * Spans are recorded in nanoseconds, and a span event has no duration at all —
 * which is a different statement from "took no measurable time". Zero keeps its
 * own unit so the two never read alike.
 */
export function formatSpanDuration(ns) {
  const n = Number(ns)
  if (!Number.isFinite(n)) return ''
  if (n === 0) return '0 ns'
  if (n < 1000) return `${n} ns`
  if (n < 1e6) return `${(n / 1000).toFixed(2)} µs`
  if (n < 1e9) return `${(n / 1e6).toFixed(2)} ms`
  return `${(n / 1e9).toFixed(2)} s`
}

/**
 * The severity a span's status carries.
 *
 * ERROR is a failure. UNSET is OTel for "the span never set a status", which
 * means nothing went wrong — not that nothing is known. A span event has no
 * status of its own, so it resolves to neutral rather than borrowing one.
 */
export function statusForSpan(statusCode) {
  if (statusCode === 'ERROR') return 'critical'
  if (statusCode === 'UNSET') return 'healthy'
  return 'neutral'
}

/**
 * The severity a span row carries — its status, since that is the only part of
 * a span that is a severity rather than an identity.
 */
export function statusForSpanRow(row) {
  return statusForSpan(row.statusCode)
}

/**
 * The drawer's badge for a span. A span event has no status, so it is named for
 * what it is rather than given a severity word it never claimed.
 */
export function spanBadgeFor(row) {
  return { status: statusForSpan(row.statusCode), label: row.statusCode || 'Span event' }
}

/**
 * The bands the span histogram stacks by, bottom to top.
 *
 * Span status is the one dimension of a span that is a severity rather than an
 * identity, so the bars use the same red/green the rest of the product reserves
 * for severity — named by status here, and drawn from that status's token by
 * the page, so no band carries a colour of its own. Span events get the neutral
 * tone: they are rows in this table too — leaving them out would make the chart
 * disagree with the row count under it — but they carry no status of their own
 * to colour. The keys are the ones `spanVolumeForWindow` writes.
 */
export const SPAN_BANDS = [
  { key: 'unset', label: 'UNSET',      status: STATUS.healthy,  opacity: 0.6 },
  { key: 'event', label: 'span_event', status: STATUS.neutral,  opacity: 0.65 },
  { key: 'error', label: 'ERROR',      status: STATUS.critical, opacity: 0.85 },
]

/** Which of SPAN_BANDS a span row is counted in. */
export function spanBandOf(row) {
  if (row.tags?.['event.domain'] === 'span_event') return 'event'
  return row.statusCode === 'ERROR' ? 'error' : 'unset'
}

/* ---- waterfall search ---- */

/**
 * The fields the waterfall can be searched over, in the shape the shared table
 * query language takes.
 *
 * Four properties of the span itself, then every attribute the trace's spans
 * carry. Searching a span is searching a record, not a two-column table, so the
 * field set is derived from the data rather than written out — and the overlay
 * lists it, because fifty names cannot be taught by a placeholder.
 *
 * Only the four core fields take part in plain-text search. Letting a bare word
 * search all fifty would mean "500" matching a span whose container id happens
 * to contain it, which is a worse answer than none.
 */
export function spanSearchFields(spans = []) {
  const core = [
    { name: 'span', key: 'span' },
    { name: 'service', key: 'service' },
    { name: 'kind', key: 'kind' },
    { name: 'id', key: 'id' },
  ]
  const coreNames = new Set(core.map(f => f.name))
  const attrs = [...new Set(spans.flatMap(sp => Object.keys(sp.tags ?? {})))]
    .filter(k => !coreNames.has(k))
    .sort()
    .map(name => ({ name, key: name, free: false }))
  return [...core, ...attrs]
}

/**
 * A span as a flat row the query can read.
 *
 * The grammar addresses `row[key]`, and a span keeps its attributes one level
 * down in `tags`. Flattening here rather than teaching the grammar about nesting
 * keeps `http.status_code:500` an ordinary field term instead of a special case.
 */
export function spanSearchRow(span) {
  return {
    ...span.tags,
    span: span.name,
    service: span.service,
    kind: span.kind,
    id: span.id,
  }
}

// A value list is only an answer where the values are readable ones. The test
// that carries the weight is their SHAPE: a field whose every value is a
// distinct id has nothing to suggest, however few there are, and that is what
// isIdentityValue settles.
//
// The count is a backstop against an unbounded set rather than a judgement
// about readability, so it is loose. The overlay shows eight at a time and
// narrows as you type, which means a longer underlying list costs nothing —
// and a tight cap silently dropped operation names, thirty of them on a
// fan-out trace, which is exactly the field worth completing.
const VALUE_MAX_DISTINCT = 60
const VALUE_MAX_LEN = 48

/**
 * Suggestable values per field, most common first.
 *
 * Returns a lookup rather than a flat map so the caller can ask per field as
 * the caret reaches one, and fields that fail the test simply have no entry.
 */
export function spanValueIndex(spans = []) {
  const counts = new Map()
  const add = (field, raw) => {
    if (raw == null || raw === '') return
    const v = String(raw)
    if (v.length > VALUE_MAX_LEN) return
    if (!counts.has(field)) counts.set(field, new Map())
    const m = counts.get(field)
    m.set(v, (m.get(v) || 0) + 1)
  }

  for (const sp of spans) {
    add('span', sp.name)
    add('service', sp.service)
    add('kind', sp.kind)
    for (const [k, v] of Object.entries(sp.tags ?? {})) add(k, v)
  }

  const out = {}
  for (const [field, m] of counts) {
    if (m.size > VALUE_MAX_DISTINCT) continue
    const values = [...m.keys()]
    if (values.every(isIdentityValue)) continue
    out[field] = [...m.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([v]) => v)
  }
  return out
}
