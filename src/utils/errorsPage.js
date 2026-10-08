/**
 * The Errors page's own logic, kept out of the component so it can be tested
 * and so the page file exports nothing but the page.
 *
 * Everything here works on what src/data/errors.js hands out: ErrorSeriesRows
 * (one value per field, filtered before grouping) and ErrorGroups (table rows).
 */

import { ERROR_FACET_FIELDS, applyErrorFacets, serviceSeverityRank } from '@/utils/errorFields'
import { parseErrorsSearch } from '@/utils/errorsUrl'
import { tryParseConditions, splitQuery } from '@/utils/rawQuery'
import { formatDelta } from '@/utils/explore/format'

/* ---- HTTP status codes ---- */

// The reason phrase a code is spoken with. The original page printed these
// beside each code ("500 Internal Server Error"), and a bare 503 means less to
// someone who does not keep the RFC in their head.
const HTTP_REASONS = {
  400: 'Bad Request',
  401: 'Unauthorized',
  402: 'Payment Required',
  403: 'Forbidden',
  404: 'Not Found',
  408: 'Request Timeout',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
}

/** '503' → 'Service Unavailable'; '' for a code with no phrase on file. */
export function httpReason(code) {
  return HTTP_REASONS[Number(code)] ?? ''
}

// The chip's class family, the same one the trace waterfall uses: a 5xx is the
// server failing, a 4xx the caller being refused. The classes go on index.css's
// .tw-code, which resolves them to the status tokens, never to a colour written here.
export function httpCodeClass(code) {
  const n = Number(code)
  if (n >= 500) return 'is-5xx'
  if (n >= 400) return 'is-4xx'
  return 'is-2xx'
}

/* ---- exception names ---- */

/**
 * 'redis.clients.jedis.exceptions.JedisPoolException' →
 * { pkg: 'redis.clients.jedis.exceptions.', short: 'JedisPoolException' }.
 * The row shows the package muted and lets it give way first, so the class
 * name, which is what a reader recognises, is the part that always shows.
 */
export function exceptionParts(exception) {
  const s = String(exception ?? '')
  const at = s.lastIndexOf('.')
  if (at <= 0 || at === s.length - 1) return { pkg: '', short: s }
  return { pkg: s.slice(0, at + 1), short: s.slice(at + 1) }
}

/* ---- the comparison window ---- */

const UNIT_WORDS = { m: 'minute', h: 'hour', d: 'day' }

/**
 * What a delta is measured against, in words: "the previous hour", "the
 * previous 7 days". `previousWindow` shifts a window back by its own span, so
 * that is literally the comparison. Today spans the whole day, so a day back
 * lands on the same stretch of yesterday. Today so far spans only the hours
 * since midnight, so it is compared with as many hours before midnight — not
 * with yesterday's morning, which is what "the same stretch" would claim.
 */
export function previousPeriodText(range) {
  if (range?.kind === 'preset') {
    if (range.value === 'today') return 'the same stretch of yesterday'
    if (range.value === 'todayf') return 'the same length of time before midnight'
    const m = /^([1-9][0-9]*)(m|h|d)$/.exec(range.value ?? '')
    if (m) {
      const n = Number(m[1])
      const unit = UNIT_WORDS[m[2]]
      return n === 1 ? `the previous ${unit}` : `the previous ${n} ${unit}s`
    }
  }
  return 'the previous period of the same length'
}

/**
 * A count against the same window one span earlier, as the chip shows it and
 * as its tooltip says it (rule 6: "235" alone does not say whether this is the
 * fire or a normal Tuesday). A group with nothing before reads "New", because
 * on this page that is the headline rather than a missing number.
 */
export function deltaChip(count, prevCount, prevText) {
  const d = formatDelta(count, prevCount)
  if (d.dir === 'new') return { ...d, label: 'New', title: `New: none in ${prevText}` }
  if (d.dir === 'none') return { ...d, label: '—', title: `Nothing to compare with in ${prevText}` }
  return { ...d, label: d.text, title: `${d.text} vs ${prevText} (${prevCount.toLocaleString()} then)` }
}

/* ---- sorting ---- */

// The order a column starts in when it is first picked: the busiest errors
// first, and the worst service first. Clicking the active column again flips it.
export const SORT_FIRST_DIR = { count: 'desc', endpoint: 'asc', error: 'asc' }

/**
 * Groups in table order.
 *
 *   count     errors in the window (the default, biggest first)
 *   endpoint  by service SEVERITY, then service, then endpoint — never plain
 *             alphabetical, which is what buried the incident on the original
 *             page (CLAUDE.md rule 3); 'desc' turns the whole order round
 *   error     by exception class name, package ignored
 *
 * Ties always fall back to count desc and then the group id, so rows with the
 * same key do not swap places between renders.
 */
export function sortErrorGroups(groups, sort = { key: 'count', dir: 'desc' }, serviceStatus = {}) {
  const key = sort?.key ?? 'count'
  const sign = sort?.dir === 'asc' ? 1 : -1
  const byCount = (a, b) => b.count - a.count || String(a.id).localeCompare(String(b.id))
  const primary = {
    count: (a, b) => (a.count - b.count) * sign,
    endpoint: (a, b) => sign * (
      serviceSeverityRank(serviceStatus, a.service) - serviceSeverityRank(serviceStatus, b.service)
      || a.service.localeCompare(b.service)
      || a.endpoint.localeCompare(b.endpoint)
    ),
    error: (a, b) => sign * (
      exceptionParts(a.exception).short.localeCompare(exceptionParts(b.exception).short)
      || a.exception.localeCompare(b.exception)
    ),
  }[key] ?? (() => 0)
  return [...groups].sort((a, b) => primary(a, b) || byCount(a, b))
}

/* ---- facet selection ---- */

/** A facet value ticked or unticked: `{ [field]: Set }`, never mutated. */
export function toggleFacetValue(facets, field, value) {
  const next = { ...facets }
  const set = new Set(next[field] ?? [])
  if (set.has(value)) set.delete(value); else set.add(value)
  if (set.size) next[field] = set
  else delete next[field]
  return next
}

export function hasFacetSelection(facets) {
  return Object.values(facets ?? {}).some(s => (s?.size ?? s?.length ?? 0) > 0)
}

/**
 * The selection carried across a Server/Client switch. A field the new side has
 * no facet for is dropped, because nothing would show it — it would filter the
 * page while being nowhere in the rail. (A link can still seed one; that is the
 * one time it is kept, so the reader sees what the link asked for.)
 */
export function facetsForKind(facets, kind) {
  const own = ERROR_FACET_FIELDS[kind] ?? ERROR_FACET_FIELDS.server
  return Object.fromEntries(Object.entries(facets ?? {}).filter(([field]) => own.includes(field)))
}

/** URL/link facet lists (`{ [field]: string[] }`) as the page holds them. */
export function facetSets(lists) {
  const out = {}
  for (const [field, values] of Object.entries(lists ?? {})) {
    const set = new Set((values ?? []).map(String).filter(Boolean))
    if (set.size) out[field] = set
  }
  return out
}

/**
 * What another page's `openLink({ view: 'errors', … })` asks this one to show.
 * Each key it names becomes a ticked facet, so the reader can see — and untick —
 * exactly what the link scoped them to.
 */
export function errorsStateFromLink(link) {
  const lists = {}
  if (link?.service) lists.service = [link.service]
  if (link?.endpoint) lists.endpoint = [link.endpoint]
  if (link?.spanName) lists.span_name = [link.spanName]
  if (link?.exception) lists.exception = [link.exception]
  return { kind: link?.kind === 'client' ? 'client' : 'server', facets: facetSets(lists) }
}

/* ---- the address bar ---- */

export const ERRORS_PATH = '/errors'

/**
 * What the page opens on: `{ kind, facets, chips, time, lostQuery }`.
 *
 * A link from another page wins over the URL: it is the newer request, and the
 * address bar in front of it still belongs to the page it came from. Without
 * one, the URL is read — ours or the original CubeAPM page's — but only when it
 * is the Errors address. Arriving from the sidebar, the bar still shows the
 * page being left, and a `?service=…` or `?time=7d` written there was never
 * addressed to this one.
 *
 * `lostQuery` says the URL's search text could not be read back into chips, so
 * the page can say it left it out rather than open silently unfiltered.
 */
export function initialErrorsState({ incoming = null, pathname = '', search = '' } = {}) {
  if (incoming) return { ...errorsStateFromLink(incoming), chips: [], time: null, lostQuery: false }
  const url = parseErrorsSearch(pathname === ERRORS_PATH ? search : '')
  const parsed = url.q ? tryParseConditions(url.q) : { ok: true, chips: [] }
  return {
    kind: url.kind,
    facets: facetSets(url.facets),
    chips: parsed.ok ? parsed.chips : [],
    time: url.time,
    lostQuery: !!url.q && !parsed.ok,
  }
}

/**
 * Whether two search strings say the same thing. The browser re-escapes what
 * it is handed — an apostrophe in the search text comes back from the address
 * bar as %27 — so comparing the raw strings would write the URL a second time
 * after every change for a difference only the encoding makes.
 */
export function sameSearch(a, b) {
  const canonical = s => new URLSearchParams(String(s ?? '').replace(/^\?/, '')).toString()
  return canonical(a) === canonical(b)
}

// Separates "a malformed query worth explaining" from "a plain value that
// happens not to parse" on paste — the same test Logs and Traces use.
const LOOKS_LIKE_QUERY = /[:(]|!=|!~|\s(?:AND|OR|in|not_in)\s/i

/**
 * A pasted query, as the search bar's `parsePastedQuery` reads it. This page
 * has no pipe stages, so a query with any is refused whole rather than quietly
 * applied without them. Text that is not a query at all (error: null) is left
 * for the bar to type in as it is.
 */
export function parsePastedErrorsQuery(raw) {
  const { conditions, pipes } = splitQuery(raw)
  if (pipes.length) {
    return { ok: false, error: 'Errors has no pipe stages. Paste only the filter part, before the first “|”.' }
  }
  const parsed = tryParseConditions(conditions)
  if (!parsed.ok) return { ok: false, error: LOOKS_LIKE_QUERY.test(raw) ? parsed.error : null }
  if (!parsed.chips.length) return { ok: false, error: null }
  return { ok: true, chips: parsed.chips, pipes: null, notice: null }
}

/* ---- empty states ---- */

const SIDE_LABEL = { server: 'Server', client: 'Client' }
const sumCounts = rows => rows.reduce((a, r) => a + (r.count ?? 0), 0)
// 'service', 'service and exception', 'service, endpoint and exception'.
const andList = names => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names.join(''))

/**
 * Why the table is empty, in the words the page shows.
 *
 * Two different statements. With no errors at all on this side, the empty
 * table is good news and says so. With errors that the filters exclude, it is
 * the filters talking, and the reader needs to know which of them to drop —
 * above all when a ticked value never occurs in this range, which is how a link
 * from elsewhere (an exception name this platform never recorded, a client call
 * ticked on Server) lands on nothing.
 *
 * The verdict is per FIELD, because that is how the rail filters: values of one
 * field are alternatives, fields narrow each other. A field empties the table
 * only when none of its ticked values occurs. A value at 0 beside a sibling
 * that has errors empties nothing — unticking it leaves the table exactly as it
 * is — so it is mentioned after the cause, never as the cause.
 *
 * @param {object}   p
 * @param {Array}    p.rows         this side's rows for the window, unfiltered
 * @param {Array}    p.otherRows    the other side's rows, to say "only on Client"
 * @param {object}   p.facets       { [field]: Set } — the ticked values
 * @param {Function} [p.matchesSearch] row → boolean for the committed chips; absent when there are none
 * @param {string}   [p.searchText] those chips as text
 * @param {string}   p.side         'server' | 'client'
 * @param {string}   p.rangeText    e.g. 'Last 7 days'
 * @returns {{ kind: 'quiet', title, sub }
 *         | { kind: 'filtered', title, filters: [{ field, value, count }], search, notes: string[], switchTo: string|null }}
 */
export function explainEmpty({ rows, otherRows = [], facets = {}, matchesSearch = null, searchText = '', side, rangeText }) {
  if (!rows.length) {
    return {
      kind: 'quiet',
      title: `No ${side} errors in ${rangeText}`,
      sub: `Every ${side === 'client' ? 'outgoing call' : 'request'} in this range completed without an exception.`,
    }
  }

  const other = side === 'client' ? 'server' : 'client'
  const countOf = (list, field, values) => sumCounts(applyErrorFacets(list, { [field]: values }))
  const filters = []
  // Each ticked field with its whole selection's count here.
  const fields = []
  for (const [field, values] of Object.entries(facets ?? {})) {
    const picked = [...(values ?? [])]
    if (!picked.length) continue
    for (const value of picked) {
      filters.push({ field, value, count: countOf(rows, field, [value]), elsewhere: countOf(otherRows, field, [value]) })
    }
    fields.push({ field, count: countOf(rows, field, picked) })
  }

  // The other side is offered only when it has errors for the WHOLE selection
  // and search. Each ticked value turning up there on its own is not enough:
  // service=notify-service with a Redis call ticked finds both on Client, but
  // never together, and a button that lands on a second empty table is worse
  // than none.
  const elsewhere = sumCounts(applyErrorFacets(otherRows, facets).filter(r => !matchesSearch || matchesSearch(r)))
  const switchTo = elsewhere > 0 ? other : null

  const notes = []
  // Whether a note already says what the other side has, so the switch
  // button never appears without a reason beside it.
  let pointed = false
  const blocking = new Set(fields.filter(f => f.count === 0).map(f => f.field))
  const zeros = filters.filter(f => f.count === 0)
  // Every value of a blocking field is at 0 here, so each is named: which of
  // them only occurs on the other side is what the reader can act on.
  for (const f of zeros.filter(z => blocking.has(z.field))) {
    if (f.elsewhere > 0) pointed = true
    notes.push(f.elsewhere > 0
      ? `${f.value} has no ${side} errors in ${rangeText}. It has ${f.elsewhere.toLocaleString()} on ${SIDE_LABEL[other]}.`
      : `${f.value} has no occurrences in ${rangeText}.`)
  }
  if (!blocking.size) {
    const facetRows = applyErrorFacets(rows, facets)
    if (fields.length && !facetRows.length) {
      // One field with errors would fill the table by itself, so two or more
      // are ticked here, and it is the fields — not their values — that clash.
      const names = fields.map(f => f.field)
      notes.push(`${andList(names)} each match errors on their own, but no error matches ${names.length > 2 ? 'all of them' : 'both'} at once.`)
    } else if (matchesSearch) {
      const searched = sumCounts(rows.filter(matchesSearch))
      // A search alone that finds nothing here often finds its errors on the
      // other side — a card decline is a Client error, not a Server one.
      const searchedElsewhere = filters.length ? 0 : sumCounts(otherRows.filter(matchesSearch))
      if (searched) {
        notes.push(`The ticked filters match ${sumCounts(facetRows).toLocaleString()} errors, and the search excludes all of them.`)
      } else if (searchedElsewhere) {
        pointed = true
        notes.push(`The search matches no ${side} errors in ${rangeText}. It matches ${searchedElsewhere.toLocaleString()} on ${SIDE_LABEL[other]}.`)
      } else {
        notes.push(`The search matches no ${side} errors in ${rangeText}.`)
      }
    }
  }
  if (switchTo && !pointed) {
    notes.push(`On ${SIDE_LABEL[other]}, these filters match ${elsewhere.toLocaleString()} errors.`)
  }
  // Its '· 0' in the list still asks why, so it is answered — last, and in
  // words that say it is not what emptied the table.
  for (const f of zeros.filter(z => !blocking.has(z.field))) {
    notes.push(`${f.value} has no ${f.elsewhere > 0 ? `${side} errors` : 'occurrences'} in ${rangeText}, but another ${f.field} value ticked with it does.`)
  }

  return {
    kind: 'filtered',
    title: 'No errors match these filters',
    filters: filters.map(({ field, value, count }) => ({ field, value, count })),
    search: searchText || null,
    notes,
    switchTo,
  }
}

/* ---- CSV ---- */

const CSV_COLUMNS = [
  'side', 'service', 'endpoint', 'span_name', 'category', 'exception', 'message',
  'http_codes', 'count', 'previous_count', 'first_seen', 'last_seen',
]

const csvCell = v => `"${String(v ?? '').replace(/"/g, '""')}"`
const isoOrBlank = ms => (ms == null ? '' : new Date(ms).toISOString())

/**
 * The groups on screen, one line each, in the order shown. Numbers stay raw
 * so a spreadsheet can add them up; codes read `500:174 503:58`, which keeps
 * the per-code counts a single cell can hold.
 */
export function errorGroupsCsv(groups) {
  const lines = [CSV_COLUMNS.map(csvCell).join(',')]
  for (const g of groups ?? []) {
    const values = {
      side: g.side,
      service: g.service,
      endpoint: g.endpoint,
      span_name: g.spanName,
      category: g.category,
      exception: g.exception,
      message: g.message,
      http_codes: (g.httpCodes ?? []).map(c => `${c.code}:${c.count}`).join(' '),
      count: g.count,
      previous_count: g.prevCount,
      first_seen: isoOrBlank(g.firstSeenMs),
      last_seen: isoOrBlank(g.lastSeenMs),
    }
    lines.push(CSV_COLUMNS.map(c => csvCell(values[c])).join(','))
  }
  return lines.join('\n')
}
