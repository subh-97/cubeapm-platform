// The Rules tab's ways out to the evidence, as App's `openLink` payloads
// (App.jsx). Production keeps "Traces ↗ / Logs ↗" on an expanded rule's
// instance rows and opens them in a new tab; here they open in place, from
// those same rows (docs/alerts/DESIGN.md D3).
//
// TODO: the rule page (P3) builds the full set D5 describes (a duration floor
// for latency rules, Errors, the ±5 minute window); fold these into that module
// once it exists, so the two pages cannot send a reader to different places.

import { datasourceValue } from '@/utils/alerts/catalog'
import { hostHandoff } from '@/components/alerts/rule/handoffs'
import { ruleSource } from './rulesQuery'

/** An error-rate rule: its evidence is failing requests, not every request. */
export function isErrorRule(view) {
  return /error/i.test(view?.metric ?? '') || /error/i.test(view?.name ?? '')
}

// The labels that narrow a rule to one series: an instance's endpoint, when the
// rule is grouped by endpoint, as production's instance links carry it.
function endpointOf(view, instance) {
  return instance?.labels?.root_name ?? instance?.labels?.endpoint ?? view?.scope?.endpoint ?? null
}

/**
 * Traces for the rule's service (and endpoint), failing ones for an error-rate
 * rule. Null when the rule names no service: an unfiltered Traces page is not
 * evidence of anything.
 */
export function tracesLink(view, instance = null) {
  const service = instance?.labels?.service ?? view?.scope?.service
  if (!service) return null
  const filters = [{ field: 'service', op: 'eq', value: service }]
  const endpoint = endpointOf(view, instance)
  if (endpoint) filters.push({ field: 'root_name', op: 'eq', value: endpoint })
  if (isErrorRule(view)) filters.push({ field: 'status_code', op: 'eq', value: 'ERROR' })
  return { view: 'traces', filters }
}

/** The service's error logs. */
export function logsLink(view, instance = null) {
  const service = instance?.labels?.service ?? view?.scope?.service
  if (!service) return null
  const chips = [{ field: 'service', op: 'eq', value: service }]
  if (isErrorRule(view)) chips.push({ field: 'log.level', op: 'eq', value: 'error', connector: 'AND' })
  return { view: 'logs', chips, pipes: [] }
}

/**
 * The alert's host on Infrastructure, for a rule grouped by host (or scoped to
 * one). It is the rule page's builder, so the two pages open the same host.
 */
export const hostLink = (view, instance = null) => hostHandoff(view, { row: instance })

// Explore's editors, by production's datasource value (utils/explore/editorState).
const EXPLORE_SOURCES = new Set(['prometheus', 'vlogs', 'traces'])

/**
 * The rule's query in Explore (D5: always available, so a Code-only rule still
 * has a way out): the query the rule compares, without its comparison, so
 * Explore charts the series rather than only the points over the line. Mobile
 * has no Explore editor yet; that is said rather than the link quietly opening
 * on something else.
 */
export function exploreLink(view) {
  const source = ruleSource(view)
  const dsId = source === 'synthetic' || source === 'slo' ? (view?.datasource ?? 'metrics') : source
  const datasource = datasourceValue(dsId)
  if (!EXPLORE_SOURCES.has(datasource)) return { link: null, reason: 'Explore has no Mobile source yet' }
  const query = view?.baseQuery || view?.query
  if (!query && !view?.model) return { link: null, reason: 'This rule has no query to open' }
  return {
    link: { view: 'explore', datasource, ...(view.model ? { model: view.model } : {}), ...(query ? { query } : {}) },
    reason: null,
  }
}
