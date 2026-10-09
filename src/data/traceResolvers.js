/**
 * Which store a trace id is looked up in, and how the trace view presents what
 * comes back.
 *
 * A trace id does not say where it came from. The Traces explorer's ids name
 * backend span trees; the Mobile Traces explorer's name a device's HTTP request,
 * which is a trace of one span. The URL carries the datasource beside the id
 * (`/trace/<id>?datasource=mobile`, see utils/route) and this is where it is
 * read: one resolver per datasource, each returning the shape `assembleTrace`
 * builds, or null when the id names nothing in that store.
 *
 * The view options live here, beside the resolvers, rather than as props App
 * picks one by one, so a datasource is added in one place: what it resolves
 * with and how its trace page differs.
 */

import { buildTrace } from './traceDetail'
import { buildMobileTrace } from './mobileTraceDetail'

// One resolver per datasource. `traces` keeps buildTrace's own behaviour —
// including borrowing a seeded trace for an id it has no spans for, which is
// what keeps a log record's trace link from landing on nothing. `mobile`
// decodes the request out of the id itself, and an id that does not decode is
// not found.
const RESOLVERS = {
  traces: buildTrace,
  mobile: buildMobileTrace,
}

/**
 * The trace for an id in the given datasource, or null.
 *
 * A datasource with no resolver is null — "not found" — rather than a fallback
 * to the backend: a device's request id looked up among backend spans would
 * come back as someone else's borrowed trace, which reads as an answer.
 */
export function resolveTrace(traceId, datasource = 'traces') {
  if (!traceId) return null
  const resolve = RESOLVERS[datasource]
  return resolve ? resolve(traceId) ?? null : null
}

/** Every tab the trace view has, in its strip order. */
export const TRACE_TABS = ['summary', 'database', 'errors', 'profiles']

/**
 * How the trace view differs by datasource.
 *
 * - `listLabel` / `listView`: the list a trace was opened from — the breadcrumb
 *   names it and goes back to it, and the sidebar keeps it lit.
 * - `tabs`: which of TRACE_TABS the view may offer. Errors still only appears
 *   when a span failed. A device's request has no database spans and no
 *   profiler behind it, so mobile offers neither tab rather than two that are
 *   empty by construction.
 * - `checkLogs`: whether "Check Logs" is offered. No log record carries a
 *   device's trace id, so for mobile the button could only land on an empty
 *   Logs page.
 * - `searchPlaceholder`: the waterfall search's example, in the attributes
 *   that dataset's spans actually carry.
 */
export const TRACE_VIEWS = {
  traces: {
    listLabel: 'Traces',
    listView: 'traces',
    tabs: TRACE_TABS,
    checkLogs: true,
    searchPlaceholder: 'Search spans ( eg. service:payment-service AND http.status_code:500 )',
  },
  mobile: {
    listLabel: 'Mobile Traces',
    listView: 'mtraces',
    tabs: ['summary', 'errors'],
    checkLogs: false,
    searchPlaceholder: 'Search spans ( eg. requestDomain:api.cubedemo.com AND status_code:502 )',
  },
}

/** The view options for a datasource; anything unknown reads as the backend. */
export function traceViewFor(datasource) {
  return TRACE_VIEWS[datasource] ?? TRACE_VIEWS.traces
}
