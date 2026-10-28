/**
 * A link into Traces: the chips it arrives as, and the rows it lands on.
 *
 * A link is only worth following if the table it opens has something in it.
 * The Errors page and the service page's Errors tab count exceptions off the
 * error profiles, while the span table is a few hundred seeded rows, so a
 * group's filter (`tracesFiltersFor`) would land on nothing for more than nine
 * groups in ten. The data layer therefore keeps one sample span per error group
 * (`errorSpanRowsForWindow`), and the Traces page merges in the ones a query
 * names the exception of (`errorSamplesFor`); every other query reads the
 * seeded spans alone. The pieces are pure and live here, so the promise "every
 * group's link finds a span" can be tested without mounting the page.
 */

import { errorSpanRowsForWindow } from '@/data/errors'
import { endpointModel, requestSample, requestSpanRows } from '@/data/requestLatency'
import { applyChipsToLog } from '@/components/QueryBuilder'
import { flattenLeaves, isGroup } from '@/utils/queryTree'
import { getSpanFieldValue } from '@/utils/traceFields'
import { toNumber } from '@/utils/logsqlNumber'

/**
 * The Traces page's chips for a list of `{ field, op?, value }` filters: every
 * leaf an `eq` unless it says otherwise, AND-ed together. This is the shape
 * TracesView's incoming `{ chips }` payload takes.
 */
export function filtersToChips(filters) {
  return (filters ?? [])
    .filter(f => f?.field && f.value != null && f.value !== '')
    .map((f, i) => ({
      field: f.field,
      op: f.op ?? 'eq',
      // A list stays a list; anything else is the literal as written — a
      // comparison's '8.799ms' must not arrive as a number that reads back
      // as a string of digits.
      value: Array.isArray(f.value) ? f.value : String(f.value),
      ...(i > 0 ? { connector: 'AND' } : {}),
    }))
}

// The fields an error sample records its exception under. errors.js stamps
// both spellings, so a query written with either one names it.
const EXCEPTION_FIELDS = new Set(['exception.type', 'exception'])

// Leaves that select by leaving a value out. `exception.type != X` is a query
// about every other exception, not a request for anyone's samples.
const EXCLUDING_OPS = new Set(['neq', 'not_in', 'nregex', 'empty'])

const NO_SAMPLES = []

/**
 * The window's error samples a query is about: the ones it finds, and whose
 * exception it names in a leaf of its own.
 *
 * The samples (`errorSpanRowsForWindow`, one span per error group) exist so a
 * link from Errors lands on rows. They are not part of the seeded stream the
 * histogram, the facet rail and the unfiltered table describe. Merged into
 * every view, they took the table's ERROR share from about 6% to 16-23% under
 * a chart still drawing the old share, and put hosts and a version on the rail
 * whose every span failed. So a sample joins only a query that asks for its
 * exception. Every Errors link does (`tracesFiltersFor` always ends on
 * `exception.type`), and so does the same query typed by hand. That way a link
 * and its query text find the same rows, and editing any other chip leaves the
 * samples in reach.
 *
 * The naming leaf has to match the sample on its own, not just the query as a
 * whole: `exception.type = X OR service = payment-service` asks for X's
 * samples, not every payment-service one.
 *
 * Returns one shared empty array when nothing is named, so a page with no such
 * query keeps the seeded stream itself and nothing downstream recomputes.
 */
export function errorSamplesFor(win, chips, getValue = getSpanFieldValue) {
  const named = flattenLeaves(chips).filter(c => EXCEPTION_FIELDS.has(c.field) && !EXCLUDING_OPS.has(c.op))
  if (!named.length) return NO_SAMPLES
  return errorSpanRowsForWindow(win).filter(r =>
    applyChipsToLog(r, chips, getValue) && named.some(c => applyChipsToLog(r, [c], getValue)))
}

/**
 * The window's spans with `extra` merged in, newest first, as one new array —
 * or `rows` itself when there is nothing to merge.
 *
 * Neither input is touched: `extra` is usually a memoised array shared with
 * every other reader of the window. The sort is stable, so on a tie the
 * seeded span keeps its place ahead of the merged one.
 */
export function mergeErrorSpans(rows, extra) {
  if (!extra?.length) return rows
  return [...rows, ...extra].sort((a, b) => b.time - a.time)
}

// How many of an endpoint's requests one query merges in: enough for any list
// the service page draws (its "N results" goes to 100), few enough beside a
// seeded stream of a few hundred spans that the table, the facets and the ERROR
// share still describe that stream.
const REQUEST_SAMPLES = 100

// The leaves that bound a duration, and how each moves the band [lo, hi).
const LOWER = { gte: 0, gt: 1 }
const UPPER = { lt: 0, lte: 1 }

/**
 * The leaves every match of a query must satisfy. Chips evaluate left to
 * right with OR and AND at one precedence, so those are the nodes after the
 * last OR at the top level (all of them when there is none), and inside a
 * group in that run, its own such nodes. A bound anywhere else holds for some
 * matches only, so it cannot narrow what is pulled in.
 */
function requiredLeaves(nodes) {
  let from = 0
  nodes.forEach((n, i) => { if (i > 0 && n.connector === 'OR') from = i + 1 })
  return nodes.slice(from).flatMap(n => (isGroup(n) ? requiredLeaves(n.children ?? []) : [n]))
}

// The values an eq or in leaf names.
const namedBy = (leaves, field) => [...new Set(leaves
  .filter(c => c.field === field && (c.op === 'eq' || c.op === 'in'))
  .flatMap(c => (Array.isArray(c.value) ? c.value : [c.value])))]

/**
 * The requests of a service-page endpoint a query is about: what the Slow
 * Requests panel's "View in Traces" lands on, so it lands on the very requests
 * the panel listed (data/requestLatency.js).
 *
 * The seeded stream holds no span named after the service page's endpoints, so
 * — as with errorSamplesFor — a query that names one in a `span_name` leaf of
 * its own (`span_name:="POST /v1/payments/:id/capture"`) has that endpoint's
 * requests merged in: a spread of at most REQUEST_SAMPLES of them, newest
 * first — the same spread the panel lists from, so its N rows are always among
 * these — drawn from:
 *   - the duration band the query sets on every match (`duration:>=8.799ms`,
 *     `duration:<27.83ms`; a bound under an OR narrows nothing),
 *   - the span an absolute range asked for (`win.exactMs`), not the window's
 *     floored start, which is where the panel's time selection began,
 *   - each service a `service` leaf names, or payment-service, the owner of
 *     the table, without one.
 * Each merged span must still pass the whole query, so any chip the reader
 * adds keeps deciding.
 *
 * An alert rule's latency hand-off names the endpoint the same way, and now
 * lands on its requests too. Returns one shared empty array when nothing is
 * named.
 */
export function requestSamplesFor(win, chips, getValue = getSpanFieldValue) {
  const leaves = flattenLeaves(chips)
  const endpoints = namedBy(leaves, 'span_name')
  if (!endpoints.length) return NO_SAMPLES
  const named = namedBy(leaves, 'service')
  const services = named.length ? named : ['payment-service']
  let loNs = 0
  let hiNs = Infinity
  for (const c of requiredLeaves(chips)) {
    if (c.field !== 'duration') continue
    const ns = toNumber(c.value)
    if (!Number.isFinite(ns)) continue
    if (c.op in LOWER) loNs = Math.max(loNs, ns + LOWER[c.op])
    if (c.op in UPPER) hiNs = Math.min(hiNs, ns + UPPER[c.op])
  }
  const [fromMs, toMs] = win.exactMs ?? [-Infinity, Infinity]
  const out = []
  for (const service of services) {
    for (const endpoint of endpoints) {
      const model = endpointModel(service, endpoint)
      if (!model) continue
      const rows = requestSpanRows(requestSample(model, win, { loNs, hiNs, fromMs, toMs }, REQUEST_SAMPLES))
      for (const r of rows) if (applyChipsToLog(r, chips, getValue)) out.push(r)
    }
  }
  return out.length ? out : NO_SAMPLES
}

/**
 * Every row a Traces query pulls in beyond the seeded stream: the Errors
 * page's samples (errorSamplesFor) and the service page's requests
 * (requestSamplesFor). The Traces source's `extraRowsFor`.
 */
export function traceSamplesFor(win, chips, getValue = getSpanFieldValue) {
  const errors = errorSamplesFor(win, chips, getValue)
  const requests = requestSamplesFor(win, chips, getValue)
  if (!requests.length) return errors
  if (!errors.length) return requests
  return [...errors, ...requests]
}
