// What the Rules tab is filtered to: the facet rail, the search, and the words
// the empty state uses when they leave nothing (docs/alerts/DESIGN.md D3).
//
// A rule's facet values are the model's (`ruleFacets`), keyed by the URL's own
// facet keys (utils/alertsUrl.js), so the rail, the filter and a link all read
// a rule the same way and cannot drift. Counts are over every rule, never
// narrowed by the other facets or the search: the reading Logs, Traces and
// Errors already teach.

import { ALERT_STATE_LABELS, THRESHOLDS } from '@/utils/status'
import { ALERTS_FACET_KEYS } from '@/utils/alertsUrl'
import { DEFAULT_GROUP } from '@/utils/alerts/catalog'
import { parsePodQuery, matchesPod } from '@/utils/tableQuery'
import { ruleFacets, conditionText, displayName } from './adapters'

export const SOURCE_LABELS = {
  metrics: 'Metrics', logs: 'Logs', traces: 'Traces', mobile: 'Mobile', synthetic: 'Synthetic', slo: 'SLO',
}

// The model builds a fresh object per call; a rule is read by every facet.
const facetCache = new WeakMap()
function facetsOf(view) {
  let f = facetCache.get(view)
  if (!f) facetCache.set(view, (f = ruleFacets(view)))
  return f
}

/**
 * Where a rule's data comes from, as the Source facet and the row's chip name
 * it. A rule another module manages is listed by that module (D18).
 */
export const ruleSource = view => facetsOf(view).source[0]

const fromMap = map => value => map[value] ?? value

/**
 * The rail, top to bottom: `title` is what it is called, `label` how a value
 * reads, and `order` fixes the order of a small closed set (open sets sort by
 * count). Only facets whose key the URL can hold are drawn, so no facet can be
 * set that a link could not repeat.
 */
export const RULE_FACETS = [
  { key: 'state', title: 'State', order: ['critical', 'warning', 'pending', 'error', 'ok', 'nodata', 'paused'], label: fromMap(ALERT_STATE_LABELS) },
  { key: 'severity', title: 'Severity', order: ['critical', 'warning'], label: fromMap({ critical: 'Critical', warning: 'Warning' }) },
  { key: 'group', title: 'Group' },
  { key: 'svc', title: 'Service' },
  { key: 'source', title: 'Source', order: Object.keys(SOURCE_LABELS), label: fromMap(SOURCE_LABELS) },
  { key: 'type', title: 'Type', order: ['static', 'anomaly'], label: fromMap({ static: 'Static', anomaly: 'Anomaly' }) },
  { key: 'notifies', title: 'Notifies' },
  { key: 'status', title: 'Status', order: ['active', 'paused'], label: fromMap({ active: 'Active', paused: 'Paused' }) },
  { key: 'suppressed', title: 'Suppressed', order: ['snoozed', 'muted'], label: fromMap({ snoozed: 'Snoozed', muted: 'Muted' }) },
]
  .filter(f => ALERTS_FACET_KEYS.includes(f.key))
  .map(f => ({ ...f, valuesOf: view => facetsOf(view)[f.key] ?? [] }))

const FACET_BY_KEY = new Map(RULE_FACETS.map(f => [f.key, f]))

/** How a facet value reads: "Rule error" for `state=error`, the value itself otherwise. */
export function facetValueLabel(key, value) {
  const f = FACET_BY_KEY.get(key)
  return f?.label ? f.label(value) : value
}

/**
 * The URL's facets (`{ key: [values] }`) as the selection the rail draws,
 * `{ key: Set }`, for the Rules tab's keys only. The hub drops the other tabs'
 * keys on a tab switch, so this guards a hand-edited link, not a click.
 */
export function selectionFromUrl(facets) {
  const out = {}
  for (const f of RULE_FACETS) {
    const values = facets?.[f.key]
    if (values?.length) out[f.key] = new Set(values)
  }
  return out
}

export function hasSelection(selection) {
  return Object.values(selection ?? {}).some(s => s?.size > 0)
}

/**
 * The URL's facets with one value toggled, ready for `onUrlChange({ facets })`.
 * A key left empty is dropped rather than written as an empty list.
 */
export function toggleFacetValue(facets, key, value) {
  const next = { ...(facets ?? {}) }
  const list = next[key] ?? []
  const updated = list.includes(value) ? list.filter(v => v !== value) : [...list, value]
  if (updated.length) next[key] = updated
  else delete next[key]
  return next
}

/** The URL's facets with the Rules tab's own keys cleared. */
export function clearRuleFacets(facets) {
  const next = { ...(facets ?? {}) }
  for (const f of RULE_FACETS) delete next[f.key]
  return next
}

const byOrder = order => (a, b) => {
  const ia = order.indexOf(a.value)
  const ib = order.indexOf(b.value)
  return (ia < 0 ? order.length : ia) - (ib < 0 ? order.length : ib) || a.value.localeCompare(b.value)
}
const byCount = (a, b) => b.count - a.count || a.value.localeCompare(b.value)

/**
 * Each facet's options, `{ key: [{ value, count }] }`. A value a link seeded
 * that no rule carries stays listed, at 0, so the reader can see what emptied
 * the list and uncheck it right there (as on Errors).
 */
export function buildRuleFacets(rules, selection = {}) {
  const out = {}
  for (const f of RULE_FACETS) {
    const counts = new Map()
    for (const r of rules ?? []) {
      for (const v of new Set(f.valuesOf(r))) counts.set(v, (counts.get(v) ?? 0) + 1)
    }
    for (const v of selection[f.key] ?? []) if (!counts.has(v)) counts.set(v, 0)
    out[f.key] = [...counts].map(([value, count]) => ({ value: String(value), count })).sort(f.order ? byOrder(f.order) : byCount)
  }
  return out
}

/** Rules carrying a selected value in every facet that has one (OR within a facet). */
export function applyRuleFacets(rules, selection = {}) {
  const active = RULE_FACETS.filter(f => selection[f.key]?.size)
  if (!active.length) return rules ?? []
  return (rules ?? []).filter(r => active.every(f => f.valuesOf(r).some(v => selection[f.key].has(String(v)))))
}

// ---------- Search ----------

/**
 * `name:`, `group:`, `service:` and `label:`, plus free text: the field:value
 * language of Home's and Infra's tables (D3). One label is `label.team:alpha`,
 * any label `label:alpha`; free text reads label values too, which production's
 * search never did (R18).
 */
export const RULE_SEARCH_FIELDS = [
  { name: 'name', key: 'name' },
  { name: 'group', key: 'group' },
  { name: 'service', key: 'service' },
  { name: 'label', key: 'labelText', tags: 'labels' },
]

/**
 * The labels a rule carries: what its alerts add, then its own tags. A key its
 * alerts carry with several values (one host each) keeps all of them, space
 * separated, so `label.host.name:` finds any of the hosts.
 */
export function ruleLabels(view) {
  const values = new Map()
  for (const inst of view?.instances ?? []) {
    for (const [k, v] of Object.entries(inst?.labels ?? {})) {
      if (v == null || v === '') continue
      if (!values.has(k)) values.set(k, new Set())
      values.get(k).add(String(v))
    }
  }
  const labels = Object.fromEntries([...values].map(([k, set]) => [k, [...set].join(' ')]))
  for (const [k, v] of Object.entries(view?.tags ?? {})) labels[k] = String(v)
  return labels
}

/** A rule as the search reads it. Its alerts' rendered names are searched with its own. */
export function searchRow(view) {
  const labels = ruleLabels(view)
  const names = [displayName(view), ...(view?.instances ?? []).map(i => i?.name).filter(n => n && n !== view?.name)]
  return {
    name: [...new Set(names)].join(' '),
    group: view?.group || DEFAULT_GROUP,
    service: view?.scope?.service ?? '',
    labelText: Object.entries(labels).flatMap(([k, v]) => v.split(' ').map(one => `${k}=${one}`)).join(' '),
    labels,
  }
}

/**
 * The URL's search text as a query, or null when there is nothing to apply. A
 * hand-edited query that does not parse filters nothing; the search box shows
 * what is wrong with it.
 */
export function parseRuleSearch(q) {
  const parsed = parsePodQuery(q ?? '', RULE_SEARCH_FIELDS)
  return parsed.ok ? parsed.node : null
}

export function matchesRuleSearch(node, view) {
  return !node || matchesPod(node, searchRow(view), RULE_SEARCH_FIELDS)
}

/** Facets, then search. Order is kept, so the severity sort survives filtering. */
export function filterRules(rules, selection, searchNode) {
  const byFacet = applyRuleFacets(rules, selection)
  return searchNode ? byFacet.filter(r => matchesRuleSearch(searchNode, r)) : byFacet
}

/** Values a search field suggests after its colon: the open sets only. */
export function searchValuesFor(rules, field) {
  const pick = { name: displayName, group: r => r.group || DEFAULT_GROUP, service: r => r.scope?.service }[field]
  if (!pick) return []
  return [...new Set((rules ?? []).map(pick).filter(Boolean))].sort((a, b) => a.localeCompare(b))
}

/**
 * What emptied the list, for the empty state: every selected value with how
 * many rules carry it (a seeded value at 0 is the usual culprit), and the
 * search text.
 */
export function explainNoMatches(rules, selection, q) {
  const facets = buildRuleFacets(rules, selection)
  const filters = []
  for (const f of RULE_FACETS) {
    for (const value of selection?.[f.key] ?? []) {
      const count = facets[f.key].find(o => o.value === value)?.count ?? 0
      filters.push({ key: f.key, title: f.title, value, label: facetValueLabel(f.key, value), count })
    }
  }
  return { filters, search: (q ?? '').trim() }
}

/**
 * What an empty workspace could start with (D16): an error-rate rule for each
 * service nothing watches yet, worst service first, at the thresholds that
 * already turn its card amber and red (THRESHOLDS, D13).
 */
export function suggestedRules(services, rules, limit = 4) {
  const covered = new Set((rules ?? []).map(r => r.scope?.service).filter(Boolean))
  const { warn, critical } = THRESHOLDS.errorRatePct
  const tiers = { warning: { op: '>', threshold: warn }, critical: { op: '>', threshold: critical } }
  const sentence = conditionText({ metric: 'Error %', unit: '%', kind: 'static', tiers, forSec: 300 })
  return (services ?? [])
    .filter(s => s?.id && !covered.has(s.id))
    .slice(0, limit)
    .map(s => ({
      service: s.id,
      sentence,
      spec: { calculate: 'error_percentage', service: s.id, tiers, forSec: 300, name: `${s.id} error rate` },
    }))
}
