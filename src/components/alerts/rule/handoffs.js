// The rule page's ways out (docs/alerts/DESIGN.md D5, D13 "Out"): pure
// builders for the payloads App's `openLink` takes, one per destination, so
// each can be tested the way the Errors page's links are (tracesHandoff.test).
//
//   service   { view: 'service', serviceId, subTab, endpoint? }
//   traces    { view: 'traces', filters: [{ field, op, value }] }, plus the
//             absolute range to look at (±5 minutes around the anchor)
//   logs      { view: 'logs', chips, pipes }
//   errors    { view: 'errors', service, endpoint? }
//   host      { view: 'infra', source: 'host', resource: <host.name> }
//   explore   { view: 'explore', datasource, query, model? }
//
// Production's ways out are a "Traces ↗"/"Logs ↗" link on an instance, for
// APM-metric and log/trace rules only, and a legend icon for Quick rules only.
// Here every rule offers Explore with its exact query, so a Code-only rule
// still has somewhere to go, and the rest appear wherever the rule names a
// service or a host (or, for a log rule, has a query the Logs page can read).

import { datasourceValue } from '@/utils/alerts/catalog'
import { splitCondition } from '@/utils/alerts/condition'
import { buildQuickQuery, buildAdvancedQuery, buildLogsqlQuery } from '@/utils/explore/builders'
import { parsePromql } from '@/utils/explore/promql'
import { parseLogsql } from '@/utils/explore/logsql'
import { tryParseConditions, splitQuery } from '@/utils/rawQuery'
import { SERVICE_TABS } from '@/utils/route'
import { services } from '@/data/services'
import { infraHosts } from '@/data/observability'

/** How far either side of the anchor an investigation handoff looks: production's ±5 minutes. */
export const HANDOFF_HALF_SPAN_SEC = 5 * 60

/** Why "Open in Explore" is unavailable for a query Explore's parser rejects. */
export const EXPLORE_UNREADABLE = 'Explore can\'t read this query yet'

const KNOWN_SERVICES = new Set(services.map(s => s.id))
const KNOWN_HOSTS = new Set(infraHosts.map(h => h.host))

/** The datasource as production stores it ('prometheus', 'vlogs', …); the view says 'metrics', 'logs'. */
export const storedDatasource = view => view?.rule?.datasource ?? datasourceValue(view?.datasource)

/** The rule's query with its condition taken off: what Explore charts and the Definition shows. */
export const baseQueryOf = view => view?.baseQuery ?? splitCondition(view?.query, storedDatasource(view)).query

// The Quick calculation a rule measures, or what its metric says it is.
function measureOf(view) {
  const calc = view?.model?.type === 'quick' ? view.model.calculate : null
  if (calc === 'error_percentage') return 'errors'
  if (calc === 'latency_percentile' || calc === 'latency_average') return 'latency'
  if (calc === 'rpm') return 'traffic'
  const metric = String(view?.metric ?? '').toLowerCase()
  if (/error/.test(metric)) return 'errors'
  if (view?.unit === 'ms' || view?.unit === 's' || /latency|duration/.test(metric)) return 'latency'
  return 'other'
}

/**
 * The service, endpoint and host a handoff is about: the rule's scope, or —
 * for a rule grouped by service or by host — the instance's own labels. An
 * endpoint is a Quick filter's `root_name`; on the server side a span's name
 * is its endpoint.
 */
export function handoffScope(view, row = null) {
  const labels = row?.labels ?? {}
  const service = view?.scope?.service ?? labels.service ?? null
  const endpoint = view?.scope?.endpoint ?? labels.root_name ?? null
  const host = view?.scope?.host ?? labels['host.name'] ?? null
  return { service, endpoint, host }
}

/**
 * The service page for the rule's service, on the tab that holds its evidence:
 * Errors for an error-rate rule, the endpoint's Detail when the rule names
 * one, RED otherwise. Production's legend link makes the same choice (§5).
 * Null when the rule names no service the app knows.
 */
export function serviceHandoff(view, { row } = {}) {
  const { service, endpoint } = handoffScope(view, row)
  if (!service || !KNOWN_SERVICES.has(service)) return null
  const measure = measureOf(view)
  const subTab = measure === 'errors' ? 'errors' : endpoint ? 'detail' : 'red'
  return {
    view: 'service',
    serviceId: service,
    ...(SERVICE_TABS.includes(subTab) ? { subTab } : null),
    ...(endpoint ? { endpoint } : null),
  }
}

/**
 * Infrastructure, on the host the alert is about: the rule's `host.name`
 * matcher, or — for a rule grouped by host, as "CPU high on ‹host.name›" is —
 * the instance's own. The box itself is the evidence there: its CPU beside its
 * memory, disk and processes, over the range already on screen. App's
 * `openLink` drills into a host the Hosts source knows and lands on the list
 * for any other name, so a host it does not know gets no handoff rather than
 * one that opens somewhere else. Null when there is no such host.
 */
export function hostHandoff(view, { row } = {}) {
  const { host } = handoffScope(view, row)
  if (!host || !KNOWN_HOSTS.has(host)) return null
  return { view: 'infra', source: 'host', resource: host }
}

/**
 * The range an investigation handoff opens on: ±5 minutes around the anchor
 * (the link's incidentTime, or when the alert became active), never past now —
 * the picker refuses a range that ends in the future. Null without an anchor.
 */
export function handoffRange(anchorSec, nowSec) {
  if (!Number.isFinite(anchorSec)) return null
  const to = Math.min(anchorSec + HANDOFF_HALF_SPAN_SEC, Number.isFinite(nowSec) ? nowSec : Infinity)
  const from = Math.min(anchorSec - HANDOFF_HALF_SPAN_SEC, to - 2 * HANDOFF_HALF_SPAN_SEC)
  return { kind: 'absolute', from: from * 1000, to: to * 1000 }
}

// A log or trace rule's query, its stats and math pipes taken off, as the
// chips the Logs and Traces pages filter with — production's "View Logs ↗"
// opens the rule's query "minus any `| stats …` tail" (reference §3). Null
// when the page's own parser cannot read it.
function queryChips(view) {
  if (view?.datasource !== 'logs' && view?.datasource !== 'traces') return null
  const { conditions } = splitQuery(baseQueryOf(view))
  const parsed = tryParseConditions(conditions)
  return parsed.ok && parsed.chips.length ? parsed.chips : null
}

/**
 * Traces, filtered to the rule's evidence (D5): the service's server spans,
 * the endpoint's when the rule names one, and for an error-rate rule only the
 * failed ones (status_code ERROR). A trace rule opens its own query.
 *
 * `exceptions` names what the failed spans threw in the handoff's window
 * (evidence.js reads it off the Errors data). Named, the Traces page merges in
 * the error samples that make every Errors link land (tracesHandoff.js); the
 * seeded span stream alone holds almost no failures of any one service in ten
 * minutes. A latency rule carries no duration floor. The Traces search can say
 * one now (`duration:>=8.8ms`, the range comparisons), but this hand-off has
 * not been taught to: it lands on the service's spans for the reader to sort
 * by duration, as it did when the grammar had no comparison to offer.
 *
 * Returns `{ link, range }`, or null when there is nothing to filter on.
 */
export function tracesHandoff(view, { row, anchorSec, nowSec, exceptions = [] } = {}) {
  const range = handoffRange(anchorSec, nowSec)
  if (view?.datasource === 'traces') {
    const chips = queryChips(view)
    return chips ? { link: { view: 'traces', filters: chips }, range } : null
  }
  const { service, endpoint } = handoffScope(view, row)
  if (!service) return null
  const filters = [
    { field: 'service', op: 'eq', value: service },
    { field: 'span_kind', op: 'eq', value: 'server' },
  ]
  if (endpoint) filters.push({ field: 'span_name', op: 'eq', value: endpoint })
  if (measureOf(view) === 'errors') {
    filters.push({ field: 'status_code', op: 'eq', value: 'ERROR' })
    const named = [...new Set(exceptions.filter(Boolean))]
    if (named.length === 1) filters.push({ field: 'exception.type', op: 'eq', value: named[0] })
    else if (named.length > 1) filters.push({ field: 'exception.type', op: 'in', value: named })
  }
  return { link: { view: 'traces', filters }, range }
}

/**
 * Logs (D5). A log rule opens its own query, stats tail removed, at ±5
 * minutes around the anchor, as production's "View Logs ↗" does. Any other
 * rule that names a service opens that service's records at level error, in
 * the Logs page's own fields (`service`, `log.level`), over the current range.
 * Returns `{ link, range }` (range null when the range stays), or null.
 */
export function logsHandoff(view, { row, anchorSec, nowSec } = {}) {
  if (view?.datasource === 'logs') {
    const chips = queryChips(view)
    return chips ? { link: { view: 'logs', chips, pipes: [] }, range: handoffRange(anchorSec, nowSec) } : null
  }
  const { service } = handoffScope(view, row)
  if (!service) return null
  return {
    link: {
      view: 'logs',
      chips: [
        { field: 'service', op: 'eq', value: service },
        { field: 'log.level', op: 'eq', value: 'error', connector: 'AND' },
      ],
      pipes: [],
    },
    range: null,
  }
}

/** Errors, scoped to the service and endpoint (D5); the page's facets take it from here. */
export function errorsHandoff(view, { row } = {}) {
  const { service, endpoint } = handoffScope(view, row)
  if (!service) return null
  return { view: 'errors', service, ...(endpoint ? { endpoint } : null) }
}

// The query a model regenerates to in Explore, which builds Quick latency in
// seconds where the alert editor builds it in milliseconds (`latencyInMs`).
function exploreRebuild(model) {
  if (model?.type === 'quick') return buildQuickQuery(model)
  if (model?.type === 'advanced') return buildAdvancedQuery(model)
  if (model?.type === 'builder') return buildLogsqlQuery(model)
  return null
}

/**
 * Whether Explore can open the rule's query: Explore's own parser reads it
 * (PromQL for a metrics rule, LogsQL for a log or trace rule), and Explore has
 * the datasource at all (it has no Mobile). Production's demo rule #437 is the
 * case in point: its `(x default 0)[5m]` rollup is MetricsQL our parser does
 * not read yet.
 */
export function exploreCanRead(view) {
  const ds = storedDatasource(view)
  const query = baseQueryOf(view)
  if (!query || !String(query).trim()) return false
  try {
    if (ds === 'prometheus') parsePromql(query)
    else if (ds === 'vlogs' || ds === 'traces') parseLogsql(query)
    else return false
    return true
  } catch {
    return false
  }
}

/**
 * Explore, on the rule's exact query — the condition taken off, since Explore
 * charts the query and the bands belong to the rule (D5). The rule's builder
 * model rides along only when Explore would rebuild exactly this query from
 * it, so the Quick or Builder tab opens filled in; otherwise (a Code rule, or
 * Quick latency, which the alert stores in milliseconds) the text goes to
 * Code untouched, because "the exact query" is the promise.
 */
export function exploreHandoff(view) {
  const datasource = storedDatasource(view)
  const query = baseQueryOf(view)
  const model = view?.model ?? null
  const rebuilt = model ? exploreRebuild(model) : null
  return {
    view: 'explore',
    datasource,
    query,
    ...(rebuilt && rebuilt === query ? { model } : null),
  }
}

/**
 * Every way out for the page's banner, in the order D5 lists them, each
 * `{ id, label, title, link, range, disabled? }`; the host comes beside the
 * service, since both are the thing itself before its evidence. A destination
 * the rule cannot reach at all (no service, no host) is left out; Explore is
 * always listed, and when its parser cannot read the query it is listed
 * disabled with the reason, as every unavailable action is (DESIGN rule 4),
 * never as a dead end.
 *
 * `ctx` is `{ row, anchorSec, nowSec, exceptions }`.
 */
export function handoffsFor(view, ctx = {}) {
  const { service } = handoffScope(view, ctx.row)
  const out = []
  const svc = serviceHandoff(view, ctx)
  if (svc) out.push({ id: 'service', label: `Open ${svc.serviceId}`, title: `The ${svc.serviceId} service page`, link: svc, range: null })
  const host = hostHandoff(view, ctx)
  if (host) out.push({ id: 'host', label: `Open ${host.resource}`, title: `The ${host.resource} host on Infrastructure`, link: host, range: null })
  const traces = tracesHandoff(view, ctx)
  if (traces) {
    const errors = measureOf(view) === 'errors'
    out.push({
      id: 'traces',
      label: errors ? 'Failing traces' : 'Traces',
      title: `${errors ? 'Failed spans' : 'Spans'}${service ? ` of ${service}` : ''}${traces.range ? ', 5 minutes either side of when this alert became active' : ''}`,
      link: traces.link,
      range: traces.range,
    })
  }
  const logs = logsHandoff(view, ctx)
  if (logs) {
    out.push({
      id: 'logs',
      label: view.datasource === 'logs' ? 'Matching logs' : 'Error logs',
      title: view.datasource === 'logs' ? 'This rule\'s query on the Logs page, without its stats' : `${service}'s logs at level error`,
      link: logs.link,
      range: logs.range,
    })
  }
  const errs = errorsHandoff(view, ctx)
  if (errs) out.push({ id: 'errors', label: 'Errors', title: `${service}'s exceptions on the Errors page`, link: errs, range: null })
  const readable = exploreCanRead(view)
  out.push({
    id: 'explore',
    label: 'Open in Explore',
    title: readable ? 'This rule\'s query, exactly, in Explore' : EXPLORE_UNREADABLE,
    link: exploreHandoff(view),
    range: null,
    ...(readable ? null : { disabled: true }),
  })
  return out
}
