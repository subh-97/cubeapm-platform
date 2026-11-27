// What the Rules tab is filtered to: the one selection the chip bar and the
// rail controls share (docs/alerts/DESIGN.md D3, as revised 2026-11-26). The
// vocabulary is the filter catalog (alertFilters.js); this file turns the URL
// into a selection (`{ key: Set }`) and back, filters the rules through it, and
// keeps old links working.
//
// Counts are over every rule, never narrowed by the other filters or the chips
// — the reading Logs, Traces and Errors already teach.

import { THRESHOLDS } from '@/utils/status'
import { parsePodQuery } from '@/utils/tableQuery'
import { ruleFacets, conditionText } from './adapters'
import {
  ALERT_FILTERS, FILTER_BY_KEY, TEXT_KEYS, SOURCE_LABELS, QUICK_CHIPS,
  filterLabel, keyLabel, tagKeysOf, matchSelection, buildFilterValues,
  selectionToChips, chipsToSelection,
} from './alertFilters'

export {
  ALERT_FILTERS, QUICK_CHIPS, SOURCE_LABELS, filterLabel, keyLabel, tagKeysOf, buildFilterValues,
  selectionToChips, chipsToSelection,
}

// The model builds a fresh object per call; a rule's source chip is read often.
const facetCache = new WeakMap()
function facetsOf(view) {
  let f = facetCache.get(view)
  if (!f) facetCache.set(view, (f = ruleFacets(view)))
  return f
}

/**
 * Where a rule's data comes from, as the Source filter and the row's chip name
 * it. A rule another module manages is listed by that module (D18).
 */
export const ruleSource = view => facetsOf(view).source[0]

// ---------- selection ↔ URL ----------

// Old facet keys the new catalog folds elsewhere, mapped on read so a link from
// before 2026-11-26 still filters. `svc` (service) and `severity` have no new
// home (State covers severity) and are read past.
const STATE_MIGRATE = { critical: 'firing', warning: 'firing', firing: 'firing', pending: 'pending', ok: 'normal', normal: 'normal' }
const MIGRATED_KEYS = new Set(['state', 'status', 'suppressed', 'notifies', 'svc', 'severity'])

// Old `q` search (name:/group:/service:/label: + free text) as the fields it
// used, so its name and label terms land on the new Alert name and tag filters.
const OLD_SEARCH_FIELDS = [
  { name: 'name', key: 'name' },
  { name: 'group', key: 'group' },
  { name: 'service', key: 'service' },
  { name: 'label', key: 'labelText', tags: 'labels' },
]

function migrateOldQuery(q, add) {
  const parsed = parsePodQuery(q ?? '', OLD_SEARCH_FIELDS)
  if (!parsed.ok || !parsed.node) return
  const words = []
  const walk = (n) => {
    if (!n) return
    if (n.kind === 'and' || n.kind === 'or') { n.parts.forEach(walk); return }
    if (n.kind === 'free') { words.push(n.value); return }
    if (n.kind === 'field' || n.kind === 'union') {
      const vals = n.values ?? [n.value]
      if (n.field === 'name') words.push(...vals)
      else if (n.field === 'label' && n.tag) for (const v of vals) add(`tag.${n.tag}`, v)
      // group:/service: were substring; they have no clean new home and are read past.
    }
  }
  walk(parsed.node)
  if (words.length) add('alert', words.join(' '))
}

/** The URL (`{ facets, q }`) as the live selection, `{ key: Set }`, old links included. */
export function selectionFromUrl(url) {
  const facets = url?.facets ?? {}
  const sel = {}
  const add = (key, value) => {
    if (value == null || value === '') return
    ;(sel[key] ??= new Set()).add(String(value))
  }
  for (const [key, values] of Object.entries(facets)) {
    if (MIGRATED_KEYS.has(key)) continue
    if ((FILTER_BY_KEY.has(key) && key !== 'tag') || key.startsWith('tag.')) for (const v of values ?? []) add(key, v)
  }
  for (const v of facets.state ?? []) {
    if (STATE_MIGRATE[v]) add('state', STATE_MIGRATE[v])
    else if (v === 'error') add('health', 'error')
    else if (v === 'paused') add('enabled', 'off')
  }
  for (const v of facets.status ?? []) add('enabled', v === 'paused' ? 'off' : 'on')
  for (const v of facets.suppressed ?? []) if (v === 'muted') add('muted', 'yes')
  for (const v of facets.notifies ?? []) add('receiver_group', v)
  migrateOldQuery(url?.q, add)
  return sel
}

/** A selection as an `onUrlChange` patch: every key to `facets`, and the old `q` dropped. */
export function selectionToPatch(selection) {
  const facets = {}
  for (const [key, set] of Object.entries(selection ?? {})) if (set?.size) facets[key] = [...set]
  return { facets, q: '' }
}

export function hasSelection(selection) {
  return Object.values(selection ?? {}).some(s => s?.size > 0)
}

/** One enum/tag value toggled in the selection. */
export function toggleFilterValue(selection, key, value) {
  const next = { ...selection }
  const set = new Set(next[key] ?? [])
  if (set.has(value)) set.delete(value)
  else set.add(value)
  if (set.size) next[key] = set
  else delete next[key]
  return next
}

/** A text filter (Alert name, Query) set to one substring, or cleared when empty. */
export function setTextFilter(selection, key, value) {
  const next = { ...selection }
  const v = String(value ?? '').trim()
  if (v) next[key] = new Set([v])
  else delete next[key]
  return next
}

export const clearSelection = () => ({})

/** A quick chip is active when all its values are selected; toggling adds or removes them. */
export function quickChipActive(selection, chip) {
  return Object.entries(chip.sel).every(([k, vals]) => vals.every(v => selection[k]?.has(v)))
}
export function toggleQuickChip(selection, chip) {
  const on = quickChipActive(selection, chip)
  let next = selection
  for (const [k, vals] of Object.entries(chip.sel)) {
    // A boolean key holds one value, never both: setting it (not OR-ing the
    // preset in) keeps "Switched off" from landing beside a rail "Enabled: On"
    // and matching every rule.
    if (!on && FILTER_BY_KEY.get(k)?.control === 'toggle') {
      next = { ...next, [k]: new Set(vals) }
      continue
    }
    for (const v of vals) {
      const has = next[k]?.has(v)
      if (on ? has : !has) next = toggleFilterValue(next, k, v)
    }
  }
  return next
}

// ---------- filtering ----------

/** Rules the selection keeps, in their original order (so the severity sort survives). */
export function filterRules(rules, selection) {
  if (!hasSelection(selection)) return rules ?? []
  return (rules ?? []).filter(r => matchSelection(r, selection))
}

/**
 * What emptied the list, for the empty state: every selected value with how
 * many rules carry it (a seeded value at 0 is the usual culprit), text filters
 * included.
 */
export function explainNoMatches(rules, selection) {
  const values = buildFilterValues(rules, selection, tagKeysOf(rules))
  const filters = []
  for (const [key, set] of Object.entries(selection ?? {})) {
    const title = key.startsWith('tag.') ? key : keyLabel(key)
    const isText = TEXT_KEYS.includes(key)
    for (const v of set ?? []) {
      const count = isText ? null : values[key]?.find(o => o.value === v)?.count ?? 0
      filters.push({ key, title, value: v, label: isText ? v : filterLabel(key, v), count })
    }
  }
  return { filters }
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
