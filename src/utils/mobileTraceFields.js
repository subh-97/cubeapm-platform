import { mobileReferenceRows } from '@/data/mobileTracesExplorer'
import { BASE_TIME } from '@/data/timeWindow'
import { SPAN_COLUMNS } from '@/utils/traceFields'
import { STATUS, statusForHttpStatus, worstStatus } from '@/utils/status'

/**
 * The mobile half of the explorer's vocabulary.
 *
 * Mobile Traces runs the Traces explorer over a different index, so what
 * differs is the nouns: which fields the bar autocompletes and how each is
 * typed, which columns the table opens with, what a record's severity is, and
 * the example and recent queries. This is that list for the Cubedemo Shop app.
 *
 * Types are written out rather than guessed from names. The traces catalogue
 * guesses numeric fields from their spelling, which would type responseTime,
 * bytesSent, cartValue and the rest as text — and a field typed as text is
 * offered no range operators and no avg() in the aggregation picker.
 */

// `keyword` means numeric-ish, as in traceFields: the builder offers range
// operators for it and the aggregation picker offers it to avg/sum/min/max.
const NUMERIC = new Set([
  'duration', 'responseTime', 'bytesSent', 'bytesReceived', 'cartValue', 'discountAmount', 'itemCount',
  'resultCount', 'timeSinceLoad', 'interactionDuration', 'device_memory_usage', 'networkErrorCode',
  'process_id', 'timestamp', 'crash_timestamp', 'count',
])

// Ids and long text: a value picklist for these would list the rows back at
// you, or a JSON blob per line, so the builder offers only eq/prefix/regex/
// exists and no picklist.
const HIGH_CARD = new Set([
  'trace_id', 'span_id', 'session_id', 'sessionId', 'device_id', 'app_exit_id', 'stacktrace',
  'analytics_events', 'thread_dump', 'exception_cause', 'description', 'networkError', 'requestUrl',
  'crash_location',
])

const entry = (field, desc) => ({
  field,
  type: NUMERIC.has(field) ? 'keyword' : 'string',
  desc,
  highCard: HIGH_CARD.has(field),
})

const CURATED = [
  entry('eventType', 'Mobile event type (MobileRequest, MobileCrash, ANR, …)'),
  entry('category', 'Event category (api, cdn, payments, Interaction, Custom, …)'),
  entry('event.domain', 'Record domain (nr.mobile, .crash, .custom, .error)'),
  entry('cube.eventType', 'CubeAPM event type (MobileSession, ANR)'),
  entry('service', 'App the record came from'),
  entry('span_name', 'Record name: screen, request, tap, breadcrumb or event'),
  entry('span_kind', 'Span kind (client: everything here runs on the device)'),
  entry('status_code', 'HTTP response code (0 = no response), or UNSET'),
  entry('duration', 'Request duration (nanoseconds)'),
  entry('responseTime', 'Request response time (milliseconds)'),
  entry('trace_id', 'Trace identifier of a network request'),
  entry('span_id', 'Span identifier of a network request'),

  entry('requestDomain', 'Host the request went to'),
  entry('requestMethod', 'HTTP method'),
  entry('requestPath', 'Request path'),
  entry('requestUrl', 'Full request URL'),
  entry('errorType', 'Why a request failed (HTTPError, NetworkError)'),
  entry('networkError', 'Network failure message'),
  entry('networkErrorCode', 'Network failure code (-1001 = timed out)'),
  entry('bytesSent', 'Request body size (bytes)'),
  entry('bytesReceived', 'Response body size (bytes)'),

  entry('crash_location', 'Source line the app crashed on'),
  entry('exception_name', 'Crash exception (NSRangeException, SIGSEGV, …)'),
  entry('exception_cause', 'Crash reason'),
  entry('stacktrace', 'Crashed thread stack (JSON)'),
  entry('analytics_events', 'Events the session recorded before the crash (JSON)'),
  entry('description', 'ANR description'),
  entry('thread_dump', 'Main thread dump at the ANR'),

  entry('actionType', 'User action (Touch, AppLaunch)'),
  entry('last_interaction', 'Screen on display when the record was made'),
  entry('session_id', 'App session identifier'),
  entry('device_id', 'Device identifier'),
  entry('device_model', 'Device model'),
  entry('device_manufacturer', 'Device manufacturer'),
  entry('platform', 'Platform (ios, android)'),
  entry('os_name', 'Operating system'),
  entry('os_version', 'Operating system version'),
  entry('app_build', 'App build'),
  entry('service.version', 'App version'),
  entry('agent_name', 'Mobile agent (iOSAgent, AndroidAgent)'),
  entry('agent_version', 'Mobile agent version'),
  entry('connectionType', 'Network the device was on (WiFi, 5G, 4G, 3G)'),
  entry('countryCode', 'Country the device was in'),

  entry('step', 'Checkout step (shipping, review, payment)'),
  entry('paymentMethod', 'Payment method chosen at checkout'),
  entry('cartValue', 'Cart value (USD)'),
  entry('itemCount', 'Items in the cart'),
  entry('searchTerm', 'What was searched for'),
  entry('resultCount', 'Search results returned'),
  entry('promoCode', 'Promo code applied'),
  entry('discountAmount', 'Discount the promo gave (USD)'),
]

const CURATED_NAMES = new Set(CURATED.map(f => f.field))

// Every other key a mobile record carries, so a new attribute is reachable
// from the keyboard without anyone editing this file.
const DISCOVERED = [...new Set(mobileReferenceRows.flatMap(r => Object.keys(r.tags)))]
  .filter(k => !CURATED_NAMES.has(k))
  .sort()
  .map(field => entry(field, 'Mobile attribute'))

export const MOBILE_FIELD_CATALOG = [...CURATED, ...DISCOVERED]

/** Value of a field on a mobile record — everything lives in `tags`. */
export function getMobileFieldValue(row, field) {
  if (field === '_msg' || field === 'message') return row.spanName
  return row.tags?.[field]
}

/**
 * Columns the table opens with: the span table's, in its order, then the one
 * column prod adds for this index. `link` tells the shared cell how a value
 * leads somewhere — `trace` opens the request's trace, `filter` narrows the
 * results to it (prod links crash_location to the Mobile page's Crashes tab,
 * which this product does not have yet).
 */
export const MOBILE_COLUMNS = [
  ...SPAN_COLUMNS,
  { key: 'crash_location', label: 'crash_location', width: 320, link: 'filter', linkTitle: 'Show every crash at this location' },
]

const MOBILE_COLUMN_META = Object.fromEntries(MOBILE_COLUMNS.map(c => [c.key, c]))
const DEFAULT_COLUMN_KEYS = MOBILE_COLUMNS.map(c => c.key)

/** Every field the picker offers: the default columns in order, then the rest sorted. */
export const MOBILE_ALL_FIELDS = [
  ...DEFAULT_COLUMN_KEYS,
  ...[...new Set(mobileReferenceRows.flatMap(r => Object.keys(r.tags)))]
    .filter(k => !DEFAULT_COLUMN_KEYS.includes(k))
    .sort(),
].map(key => ({ key, label: key }))

/** Columns shown before anyone touches the picker. */
export const MOBILE_DEFAULT_ACTIVE_FIELDS = new Set(DEFAULT_COLUMN_KEYS)

/** The active fields as ordered columns, in the picker's order rather than the order they were ticked. */
export function mobileColumnsFor(activeFields) {
  return MOBILE_ALL_FIELDS
    .filter(f => activeFields.has(f.key))
    .map(f => MOBILE_COLUMN_META[f.key] ?? { key: f.key, label: f.key, width: 160 })
}

/* ---- severity ---- */

const FATAL_EVENT_TYPES = new Set(['MobileCrash', 'ANR'])

/**
 * The severity a mobile record carries.
 *
 * A request's is its HTTP code's: no answer and 5xx are critical, 4xx a
 * warning, the rest healthy. UNSET on a screen, a tap or a session means
 * nothing went wrong. A crash or an ANR has no code at all and is the worst
 * thing the index holds, so it is critical outright; a custom event has no
 * code and says nothing about health, so it stays neutral.
 */
export function statusForMobileRecord(row) {
  const code = row?.tags?.status_code ?? row?.statusCode
  const fatal = FATAL_EVENT_TYPES.has(row?.tags?.eventType)
  return worstStatus(statusForHttpStatus(code), fatal ? STATUS.critical : STATUS.neutral)
}

/** The drawer's badge: the record's severity, labelled by its code, else what it is. */
export function mobileBadgeFor(row) {
  const tags = row?.tags ?? {}
  return {
    status: statusForMobileRecord(row),
    label: tags.status_code || tags.eventType || tags.span_name || row?.spanName || 'Record',
  }
}

/**
 * The histogram's bands, bottom to top. Stacked by severity rather than by raw
 * status code, as prod does: prod draws ten codes in one grey, and ten codes in
 * severity colours would be four reds nobody could tell apart. One colour per
 * band, resolved from `status` through the theme's status variables.
 */
export const MOBILE_BANDS = [
  {
    key: 'ok', label: '2xx · UNSET', status: STATUS.healthy, opacity: 0.6,
    desc: 'Requests that got an answer below 400, and screens, sessions, taps, breadcrumbs and installs (UNSET)',
  },
  {
    key: 'none', label: 'no status', status: STATUS.neutral, opacity: 0.65,
    desc: 'Custom events (CheckoutStep, CartUpdated, SearchPerformed, PromoApplied), which carry no status_code',
  },
  {
    key: 'warn', label: '4xx', status: STATUS.warning, opacity: 0.8,
    desc: 'Requests the server refused: 400, 404, 429',
  },
  {
    key: 'fail', label: '5xx · 0 · crash', status: STATUS.critical, opacity: 0.85,
    desc: 'Server errors, requests that never got an answer (status 0), crashes and ANRs',
  },
]

const BAND_BY_STATUS = {
  [STATUS.critical]: 'fail', [STATUS.warning]: 'warn', [STATUS.healthy]: 'ok',
}

/** Which band a record stacks in — its severity, so the bars and the row gutters agree. */
export function mobileBandOf(row) {
  return BAND_BY_STATUS[statusForMobileRecord(row)] ?? 'none'
}

/* ---- queries ---- */

// The bar's built-in examples: the four questions people open this page with.
export const MOBILE_EXAMPLE_QUERIES = [
  { id: 'mq1', name: 'Crashes', chips: [{ field: 'eventType', op: 'eq', value: 'MobileCrash' }] },
  { id: 'mq2', name: 'Failed requests', chips: [{ field: 'eventType', op: 'eq', value: 'MobileRequestError' }] },
  { id: 'mq3', name: 'Payment request errors', chips: [
    { field: 'category', op: 'eq', value: 'payments' },
    { field: 'eventType', op: 'eq', value: 'MobileRequestError', connector: 'AND' },
  ] },
  { id: 'mq4', name: 'ANRs', chips: [{ field: 'eventType', op: 'eq', value: 'ANR' }] },
]

// Recent queries in the mobile vocabulary. Kept apart from the Traces page's,
// which are written about fields a phone does not report.
export const MOBILE_QUERY_HISTORY = (() => {
  const now = BASE_TIME.getTime()
  return [
    { id: 1, query: 'eventType:=MobileRequestError AND category:=api', time: new Date(now - 5 * 60000), results: 41 },
    { id: 2, query: 'eventType:=MobileCrash', time: new Date(now - 19 * 60000), results: 3 },
    { id: 3, query: 'requestDomain:=api.stripe.com AND errorType:=NetworkError', time: new Date(now - 44 * 60000), results: 7 },
    { id: 4, query: 'status_code:5*', time: new Date(now - 1.3 * 3600000), results: 96 },
    { id: 5, query: 'eventType:=ANR AND device_model:"Pixel 8"', time: new Date(now - 2.4 * 3600000), results: 2 },
    { id: 6, query: 'category:=payments AND eventType:=MobileRequestError', time: new Date(now - 3.1 * 3600000), results: 12 },
    { id: 7, query: 'span_name:"Display CheckoutViewController"', time: new Date(now - 5 * 3600000), results: 184 },
    { id: 8, query: 'app_build:=4.2.8 AND eventType:=MobileCrash', time: new Date(now - 9 * 3600000), results: 9 },
    { id: 9, query: 'connectionType:=3G AND errorType:=NetworkError', time: new Date(now - 14 * 3600000), results: 22 },
    { id: 10, query: 'eventType:=CheckoutStep AND step:=payment', time: new Date(now - 26 * 3600000), results: 268 },
  ]
})()

/** What the query bar's recents open with. */
export const MOBILE_INITIAL_RECENTS = [
  [{ field: 'eventType', op: 'eq', value: 'MobileCrash' }],
  [{ field: 'eventType', op: 'eq', value: 'MobileRequestError' }],
  [{ field: 'category', op: 'eq', value: 'payments' }],
]

export const MOBILE_PLACEHOLDER = 'Type a field name (e.g. eventType, span_name, crash_location) or free text'
// Free text searches `_msg`, which on a mobile record reads its span_name.
export const MOBILE_FREE_TEXT_NOUN = 'events'
export const MOBILE_FREE_TEXT_META = 'Event name'

/** The CSV's columns: the table's defaults, crash_location included. */
export const MOBILE_CSV_COLUMNS = ['time', ...DEFAULT_COLUMN_KEYS]
