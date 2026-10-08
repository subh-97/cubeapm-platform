/**
 * The errors half of the query vocabulary, and the facet rail's model.
 *
 * The Errors page filters ErrorSeriesRows (src/data/errors.js) — one row per
 * side, service, endpoint, span name, exception and HTTP code, carrying a count
 * — BEFORE it groups them into table rows. So every field here has exactly one
 * value per row, which is what lets the page reuse the Logs/Traces evaluator
 * (applyChipsToLog) and the facet model unchanged: a table row's list of HTTP
 * codes would have broken both, since `in` and `:=` compare one value.
 *
 * The field names are the ones the original CubeAPM Errors page puts in its
 * URL and facet titles (`exception`, `endpoint`, `http_code`), not the span
 * spellings, because these are what the page shows and what people type.
 */

// How this page reads `field:value`: a case-insensitive contains, as the
// original CubeAPM Errors search does, not LogsQL's word match. The search bar
// (which describes `:` from it) and the page's evaluator (applyChipsToLog) both
// take it from here, so the picker and the results cannot disagree.
export const ERROR_COLON_MATCH = 'contains'

// Order is suggestion order: what an error is, then where it happened.
export const ERROR_FIELD_CATALOG = [
  { field: 'exception', type: 'string',  desc: 'Exception type, e.g. java.util.concurrent.TimeoutException' },
  { field: 'service',   type: 'string',  desc: 'Service that recorded the error' },
  { field: 'endpoint',  type: 'string',  desc: 'API endpoint (root span) the error happened under' },
  { field: 'http_code', type: 'keyword', desc: 'HTTP response code; 5* covers every 5xx' },
  { field: 'span_name', type: 'string',  desc: 'Span that recorded the exception; on Client, the outgoing call' },
  { field: 'message',   type: 'string',  desc: 'Exception message' },
]

// On Client the span name is the outgoing call, which is the thing that
// failed, so it earns a facet of its own and leads the endpoint. On Server it
// IS the endpoint, and a second facet would list every value twice.
export const ERROR_FACET_FIELDS = {
  server: ['service', 'endpoint', 'exception', 'http_code'],
  client: ['service', 'span_name', 'endpoint', 'exception', 'http_code'],
}

const FIELD_PROPS = {
  exception: 'exception',
  service: 'service',
  endpoint: 'endpoint',
  http_code: 'httpCode',
  span_name: 'spanName',
  message: 'message',
  category: 'category',
  // The span spellings of the same fields. The Traces page writes these, so a
  // query copied from there still filters here instead of matching nothing.
  'exception.type': 'exception',
  'exception.message': 'message',
  root_name: 'endpoint',
  'http.status_code': 'httpCode',
  span_kind: 'side',
}

// `JedisPoolException` → `Jedis Pool Exception`; `SQLTransient…` keeps `SQL`.
function splitCapitals(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
}

// What free text searches: what a person reads off an error, not one field.
//
// The phrase and prefix readings match whole words, and the matcher's words
// keep their dots and hyphens — `java.lang.RuntimeException` and
// `payment-service` are each ONE word to it. So the class name is in it three
// ways. As written, so a pasted full name matches; with the dots as spaces, so
// `RuntimeException` matches it as a phrase or a prefix and not only as a
// substring; and the short name split at its capitals, so `Timeout` finds
// TimeoutException and the phrase `"card declined"` finds
// CardDeclinedException. The service is in it as written and with its hyphens
// as spaces, so `payment` finds payment-service, the incident, whichever
// reading it goes in as. And the HTTP code is in it, because a bare term on the
// original page searched the code too: `503` finds what answered 503.
//
// Which reading Enter commits is the search bar's call (buildFreeTextOptions),
// not this function's. On this page one unquoted word goes in as a contains
// (ErrorsQueryBuilder's freeTextLead), as a bare term on the original page was
// a substring match, so `pay` finds payment-service; several go in as one
// contains per word (`card declined` → `_msg:*card* AND _msg:*declined*`).
// Neither needs the spellings above; they are for the phrase and prefix
// readings offered beside it.
function freeTextOf(row) {
  const exception = row.exception ?? ''
  const short = row.exceptionShort || exception.split('.').pop()
  const service = row.service ?? ''
  const parts = [
    exception,
    exception.replaceAll('.', ' '),
    short ? splitCapitals(short) : '',
    row.message,
    row.endpoint,
    row.spanName,
    service,
    service.replaceAll('-', ' '),
    row.httpCode,
  ]
  return [...new Set(parts.filter(Boolean))].join(' ')
}

/** Value of a field on an ErrorSeriesRow; undefined for a field it has no notion of. */
export function getErrorFieldValue(row, field) {
  if (field === '_msg') return freeTextOf(row)
  // Own keys only: a typed or pasted field called `constructor` is a field
  // this row does not have, not Object's.
  return Object.hasOwn(FIELD_PROPS, field) ? row[FIELD_PROPS[field]] : undefined
}

const SEVERITY_RANK = { critical: 0, warning: 1, healthy: 2 }
const OTHER_RANK = 3

/**
 * Where a service sorts by health: critical, warning, healthy, then anything
 * without a status (CLAUDE.md rule 3). The rail's service facet and the
 * table's Endpoint column both order by it, so they cannot disagree.
 */
export function serviceSeverityRank(serviceStatus, service) {
  return SEVERITY_RANK[serviceStatus?.[service]] ?? OTHER_RANK
}

// A Set, an array, or a lone string, which is one value: spread, it would be a
// selection of its letters and filter every row away.
function selectedValues(selected, field) {
  const given = selected?.[field] ?? []
  return (typeof given === 'string' ? [given] : [...given]).map(String).filter(v => v !== '')
}

const FACETABLE = new Set([...ERROR_FACET_FIELDS.server, ...ERROR_FACET_FIELDS.client])

/**
 * Facet options per field: `{ [field]: [{ value, count }] }`, where a count is
 * errors (Σ row.count), not rows — a row is a whole series. One entry per
 * ERROR_FACET_FIELDS[side], in that order.
 *
 * A selected value with no errors in the data is still listed, at 0. A
 * selection seeded from a link or left over from a wider range otherwise
 * filters the page while being invisible in the rail, with nothing to untick.
 * For the same reason a selection on a field this side has no group for (a
 * link's span name, on Server) gets one after the side's own, holding just the
 * selected values — listing every value there would repeat the endpoints.
 *
 * Services sort by severity first (rule 3: an incident must never be buried
 * under a busier healthy service), then by count. Everything else is by count.
 */
export function buildErrorFacets(rows, { side = 'server', selected = {}, serviceStatus = {} } = {}) {
  const own = ERROR_FACET_FIELDS[side] ?? ERROR_FACET_FIELDS.server
  const stray = Object.keys(selected ?? {})
    .filter(f => FACETABLE.has(f) && !own.includes(f) && selectedValues(selected, f).length)
  const rank = v => serviceSeverityRank(serviceStatus, v)

  const optionsFor = (field, onlySelected) => {
    const picked = selectedValues(selected, field)
    const counts = new Map(onlySelected ? picked.map(v => [v, 0]) : [])
    for (const row of rows ?? []) {
      const v = getErrorFieldValue(row, field)
      if (v == null || v === '') continue
      const key = String(v)
      if (onlySelected && !counts.has(key)) continue
      counts.set(key, (counts.get(key) || 0) + (row.count ?? 0))
    }
    for (const v of picked) if (!counts.has(v)) counts.set(v, 0)
    return [...counts]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => (field === 'service' ? rank(a.value) - rank(b.value) : 0)
        || b.count - a.count
        || a.value.localeCompare(b.value))
  }

  const out = {}
  for (const field of own) out[field] = optionsFor(field, false)
  for (const field of stray) out[field] = optionsFor(field, true)
  return out
}

/**
 * Rows passing the facet selection: `{ [field]: Set | string[] }`. Values of one
 * field are alternatives (OR); fields narrow each other (AND); an empty field
 * selects nothing away — the same reading as the Logs and Traces rails.
 */
export function applyErrorFacets(rows, selected) {
  const active = Object.entries(selected ?? {})
    .map(([field]) => [field, new Set(selectedValues(selected, field))])
    .filter(([, values]) => values.size > 0)
  if (!active.length) return rows
  return rows.filter(row => active.every(([field, values]) => {
    const v = getErrorFieldValue(row, field)
    return v != null && values.has(String(v))
  }))
}

// Shown under Saved Queries in the search bar, in place of the log examples.
// Each is written against what this page's rows actually carry, and the tests
// hold every one to parsing back from its own query text.
export const ERROR_EXAMPLE_QUERIES = [
  { id: 'errors-5xx', name: 'Server 5xx', description: 'Everything answered with a 5xx — the server’s own failures. A 4xx is the caller’s problem.', chips: [
    { field: 'http_code', op: 'prefix', value: '5' },
  ]},
  { id: 'errors-timeouts', name: 'Timeouts', description: 'Anything that gave up waiting, whether the class says Timeout or the message says timed out.', chips: [
    { field: '_msg', op: 'contains', value: 'Timeout' },
    { field: '_msg', op: 'phrase', value: 'timed out', connector: 'OR' },
  ]},
  { id: 'errors-connections', name: 'Connection & pool errors', description: 'A dependency that could not be reached, or had no free connection to lend — Redis, the database pool.', chips: [
    { field: '_msg', op: 'contains', value: 'Connection' },
    { field: '_msg', op: 'contains', value: 'Pool', connector: 'OR' },
  ]},
  { id: 'errors-429', name: 'Rate limited (429)', description: 'Calls a provider refused for going over its rate limit. These are outgoing calls, so they show on Client.', chips: [
    { field: 'http_code', op: 'eq', value: '429' },
  ]},
  { id: 'errors-no-declines', name: 'Exclude card declines', description: 'A declined card is the issuer saying no, not a fault. Drop them to see what is actually broken.', chips: [
    { field: 'exception', op: 'neq', value: 'com.cubedemo.payment.CardDeclinedException' },
  ]},
]

// What the Recent Searches list starts with, so it demonstrates itself on a
// first visit instead of saying it is empty.
export const ERROR_RECENT_SEEDS = [
  [
    { field: 'service', op: 'eq', value: 'payment-service' },
    { field: 'exception', op: 'eq', value: 'redis.clients.jedis.exceptions.JedisPoolException', connector: 'AND' },
  ],
  [
    { field: 'endpoint', op: 'eq', value: 'POST /v1/payments/:id/capture' },
    { field: 'http_code', op: 'eq', value: '503', connector: 'AND' },
  ],
  [
    { field: 'service', op: 'in', value: ['order-service', 'shipment-service'] },
    { field: 'http_code', op: 'prefix', value: '5', connector: 'AND' },
  ],
]
