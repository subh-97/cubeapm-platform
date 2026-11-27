// The one vocabulary the Rules tab filters by (docs/alerts/DESIGN.md D3, as
// revised 2026-11-26): one catalog of filters, each read the same way by the
// chip bar, the rail control beside it, the counts and the URL, so the three
// cannot drift. This supersedes the old split of a facet rail and a separate
// `field:value` search; a rail tick and a typed chip now produce one state.
//
// A filter is one of four `control`s:
//   enum   a set of values with counts — a checkbox / searchable list
//   toggle one of two values (On/Off, Yes/No) — a tri-state toggle
//   text   a substring — a text box (Alert name, Query)
//   tag    the rule's own labels, one section per tag key (`tag.<key>`)
// The selection is `{ [key]: Set(values) }`; a text key holds one substring, a
// tag key is written `tag.<key>`. Matching is OR within a key, AND across keys.

import { RECEIVER_TYPES, DEFAULT_GROUP } from '@/utils/alerts/catalog'
import { displayName } from './adapters'

export const SOURCE_LABELS = {
  metrics: 'Metrics', logs: 'Logs', traces: 'Traces', mobile: 'Mobile', synthetic: 'Synthetic', slo: 'SLO',
}
const RECEIVER_TYPE_LABEL = Object.fromEntries(RECEIVER_TYPES.map(r => [r.type, r.label]))
const RECEIVER_TYPE_ORDER = RECEIVER_TYPES.map(r => r.type)

const mapLabel = m => v => m[v] ?? v
const ON_OFF = { on: 'On', off: 'Off' }
const YES_NO = { yes: 'Yes', no: 'No' }

// Where a rule's data comes from, as the Source filter names it (a managed
// rule by its manager). SLO rules are not listed, so 'slo' is unreachable here.
const sourceOf = v => (v.managedBy?.kind === 'synthetic' ? 'synthetic' : v.managedBy?.kind === 'slo' ? 'slo' : v.datasource)

// State decomposed to the three the spec filters by; a paused, erroring or
// no-data rule is none of them (it is reached through Enabled / Health).
const STATE_VALUE = { firing: 'firing', pending: 'pending', ok: 'normal' }

/**
 * The labels a rule carries: what its alerts add (a key with one value per
 * host keeps them all, space joined), then its own tags. `label.host.name:`
 * finds any of the hosts; a tag section lists each value on its own.
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

/** The rule's name together with its alerts' rendered names, for Alert name. */
export function ruleNameText(view) {
  const names = [displayName(view), ...(view?.instances ?? []).map(i => i?.name).filter(n => n && n !== view?.name)]
  return [...new Set(names)].join(' ')
}

const tagValuesOf = (view, key) => String(ruleLabels(view)[key] ?? '').split(' ').filter(Boolean)

/**
 * The filter catalog, in the rail's top-to-bottom order (the spec's, P0 above).
 * `valuesOf(view)` is a rule's values for an enum/toggle key; `textOf(view)`
 * the haystack for a text key; `valueLabel(v)` how a value reads; `order` fixes
 * a closed set's order (open sets sort by count).
 */
export const ALERT_FILTERS = [
  { key: 'group', label: 'Group', control: 'enum', valuesOf: v => [v.group || DEFAULT_GROUP] },
  { key: 'alert', label: 'Alert name', control: 'text', placeholder: 'name contains…', textOf: ruleNameText },
  { key: 'state', label: 'State', control: 'enum', order: ['firing', 'pending', 'normal'], valueLabel: mapLabel({ firing: 'Firing', pending: 'Pending', normal: 'Normal' }), valuesOf: v => (STATE_VALUE[v.state] ? [STATE_VALUE[v.state]] : []) },
  { key: 'enabled', label: 'Enabled', control: 'toggle', order: ['on', 'off'], valueLabel: mapLabel(ON_OFF), valuesOf: v => [v.status === 'PAUSED' ? 'off' : 'on'] },
  { key: 'health', label: 'Health', control: 'enum', order: ['ok', 'error'], valueLabel: mapLabel({ ok: 'OK', error: 'Error' }), valuesOf: v => [v.health === 'error' ? 'error' : 'ok'] },
  { key: 'source', label: 'Source', control: 'enum', order: Object.keys(SOURCE_LABELS), valueLabel: mapLabel(SOURCE_LABELS), valuesOf: v => [sourceOf(v)] },
  { key: 'tag', label: 'Tags', control: 'tag' },
  { key: 'receiver_group', label: 'Receiver group', control: 'enum', searchable: true, valuesOf: v => (v.contactPoints ?? []).map(c => c.name).filter(Boolean) },
  { key: 'has_receiver', label: 'Has receiver', control: 'toggle', order: ['yes', 'no'], valueLabel: mapLabel(YES_NO), valuesOf: v => [(v.contactPoints ?? []).length ? 'yes' : 'no'] },
  { key: 'muted', label: 'Muted now', control: 'toggle', order: ['yes', 'no'], valueLabel: mapLabel(YES_NO), valuesOf: v => [v.suppression?.kind === 'mute' ? 'yes' : 'no'] },
  { key: 'type', label: 'Type', control: 'enum', order: ['static', 'anomaly'], valueLabel: mapLabel({ static: 'Static', anomaly: 'Anomaly' }), valuesOf: v => [v.kind] },
  { key: 'receiver_type', label: 'Receiver type', control: 'enum', order: RECEIVER_TYPE_ORDER, valueLabel: mapLabel(RECEIVER_TYPE_LABEL), valuesOf: v => [...new Set((v.receivers ?? []).map(r => r.type).filter(Boolean))] },
  { key: 'mute_group', label: 'Mute group', control: 'enum', searchable: true, valuesOf: v => (v.muteSchedules ?? []).map(m => m.name).filter(Boolean) },
  { key: 'grouping', label: 'Notification grouping', control: 'toggle', order: ['on', 'off'], valueLabel: mapLabel(ON_OFF), valuesOf: v => [v.groupingDisable ? 'off' : 'on'] },
  { key: 'query', label: 'Query contains', control: 'text', placeholder: 'PromQL contains…', textOf: v => `${v.query ?? ''} ${v.query2 ?? ''}` },
]

export const FILTER_BY_KEY = new Map(ALERT_FILTERS.map(f => [f.key, f]))
export const TEXT_KEYS = ALERT_FILTERS.filter(f => f.control === 'text').map(f => f.key)

/** A tag key's own filter entry, so `tag.<key>` reads like a catalog filter. */
export function tagFilter(tagKey) {
  return {
    key: `tag.${tagKey}`,
    label: `tag.${tagKey}`,
    control: 'enum',
    tagKey,
    searchable: true,
    valuesOf: v => tagValuesOf(v, tagKey),
  }
}

/** How a value reads under its key (`tag.*` values read as themselves). */
export function filterLabel(key, value) {
  return FILTER_BY_KEY.get(key)?.valueLabel?.(value) ?? value
}

/** How a key reads: a catalog label, or `tag.<key>` for a tag key. */
export function keyLabel(key) {
  return FILTER_BY_KEY.get(key)?.label ?? key
}

/** The distinct tag keys across the rules, sorted — one rail section each. */
export function tagKeysOf(rules) {
  const keys = new Set()
  for (const r of rules ?? []) for (const k of Object.keys(ruleLabels(r))) keys.add(k)
  return [...keys].sort((a, b) => a.localeCompare(b))
}

function matchKey(key, sel, view) {
  if (key.startsWith('tag.')) {
    const have = new Set(tagValuesOf(view, key.slice(4)))
    return [...sel].some(v => have.has(v))
  }
  const f = FILTER_BY_KEY.get(key)
  if (!f) return true // an unknown key (an old link's dropped filter) narrows nothing
  if (f.control === 'text') {
    const q = String([...sel][0] ?? '').trim()
    return !q || f.textOf(view).toLowerCase().includes(q.toLowerCase())
  }
  const vals = f.valuesOf(view).map(String)
  return [...sel].some(v => vals.includes(String(v)))
}

/** A rule carrying a selected value in every key that has one (OR within, AND across). */
export function matchSelection(view, selection) {
  for (const [key, sel] of Object.entries(selection ?? {})) {
    if (!sel?.size) continue
    if (!matchKey(key, sel, view)) return false
  }
  return true
}

const byOrder = order => (a, b) => {
  const ia = order.indexOf(a.value)
  const ib = order.indexOf(b.value)
  return (ia < 0 ? order.length : ia) - (ib < 0 ? order.length : ib) || a.value.localeCompare(b.value)
}
const byCount = (a, b) => b.count - a.count || a.value.localeCompare(b.value)
function sortValues(entries, order) {
  return entries.map(([value, count]) => ({ value: String(value), count })).sort(order ? byOrder(order) : byCount)
}

function countValues(rules, valuesOf, selectedKey, selection, order) {
  const counts = new Map()
  for (const r of rules ?? []) for (const v of new Set(valuesOf(r))) counts.set(String(v), (counts.get(String(v)) ?? 0) + 1)
  for (const v of selection[selectedKey] ?? []) if (!counts.has(v)) counts.set(v, 0)
  return sortValues([...counts], order)
}

/**
 * Each enum/toggle filter's values with counts, `{ key: [{ value, count }] }`,
 * plus one entry per tag key (`tag.<key>`). Counts are over every rule, never
 * narrowed by the other filters (the reading Logs/Traces/Errors teach); a value
 * a link seeded that no rule carries stays listed at 0 so it can be unticked.
 */
export function buildFilterValues(rules, selection = {}, tagKeys = []) {
  const out = {}
  for (const f of ALERT_FILTERS) {
    if (f.control === 'text' || f.control === 'tag') continue
    out[f.key] = countValues(rules, f.valuesOf, f.key, selection, f.order)
  }
  for (const k of tagKeys) {
    const key = `tag.${k}`
    out[key] = countValues(rules, v => tagValuesOf(v, k), key, selection, null)
  }
  return out
}

/**
 * The quick chips above the list: a one-press preset, active when its values
 * are all selected. Each is a partial selection folded into the live one.
 */
export const QUICK_CHIPS = [
  { id: 'firing', label: 'Firing', sel: { state: ['firing'] } },
  { id: 'off', label: 'Switched off', sel: { enabled: ['off'] } },
  { id: 'no_receiver', label: 'No receiver', sel: { has_receiver: ['no'] } },
  { id: 'muted', label: 'Muted now', sel: { muted: ['yes'] } },
]

// ---------- The shared query builder's vocabulary ----------
//
// The chip bar is the Logs/Traces/Errors `QueryBuilder` (components/QueryBuilder.jsx)
// with the alerts catalog bound in, so the bar, its overlay (fields, recent
// searches, saved queries, value suggestions) and its keyboard model are the
// same product. The builder speaks chips; the rail and the URL speak the
// `{ key: Set }` selection. `selectionToChips`/`chipsToSelection` bridge the two
// so a chip and a rail tick are one state.

/** How `field:value` reads: a case-insensitive contains, as the rest of the alerts UI does. */
export const ALERT_COLON_MATCH = 'contains'

const CATALOG_TYPE = { alert: 'string', query: 'string' } // text fields; the rest are keywords

// The essential filters the bar's overlay suggests by default — the spec's
// purpose, "what is firing, what is switched off, and who gets notified". Every
// other filter (receiver type, mute group, grouping, query, tags…) is still
// typeable in the bar and still on the rail; it just does not crowd the
// empty-input overlay the way all fifteen did.
export const ESSENTIAL_FIELDS = ['group', 'alert', 'state', 'enabled', 'health', 'source', 'receiver_group']

/** The field catalog the builder suggests: the essential filters only. */
export const ALERT_FIELD_CATALOG = ESSENTIAL_FIELDS
  .map(k => FILTER_BY_KEY.get(k))
  .map(f => ({ field: f.key, type: CATALOG_TYPE[f.key] ?? 'keyword', desc: fieldDesc(f.key) }))

function fieldDesc(key) {
  return {
    group: 'The folder the rule sits in', alert: "The rule's name", state: 'Firing / Pending / Normal',
    enabled: 'Switched on or off', health: 'Whether the last check ran (ok / error)',
    source: 'The data the rule watches (metrics, logs, traces…)', receiver_group: 'The receiver group it notifies',
    has_receiver: 'Whether it notifies anyone (yes / no)', muted: 'A mute is active right now (yes / no)',
    type: 'How the threshold works (static / anomaly)', receiver_type: 'The kind of receiver (Webhook, Email…)',
    mute_group: 'A mute schedule linked to the rule', grouping: 'Notification grouping (on / off)',
    query: "Words in the rule's query",
  }[key] ?? key
}

/** A rule's value for a field, for the builder (space-joined for a multi-value field). */
export function getAlertFieldValue(view, field) {
  if (field === '_msg') return ruleNameText(view)
  if (field?.startsWith('tag.')) return ruleLabels(view)[field.slice(4)] ?? ''
  const f = FILTER_BY_KEY.get(field)
  if (!f) return ''
  if (f.control === 'text') return f.textOf(view)
  return f.valuesOf(view).map(String).join(' ')
}

const chipFor = (field, values) => (values.length === 1
  ? { field, op: 'eq', value: String(values[0]) }
  : { field, op: 'in', value: values.map(String) })

/** The selection as the builder's chip array (enum/tag → eq or in, text → contains). */
export function selectionToChips(selection) {
  const chips = []
  for (const f of ALERT_FILTERS) {
    if (f.control === 'tag' || !selection[f.key]?.size) continue
    chips.push(f.control === 'text'
      ? { field: f.key, op: 'contains', value: String([...selection[f.key]][0]) }
      : chipFor(f.key, [...selection[f.key]]))
  }
  for (const key of Object.keys(selection).filter(k => k.startsWith('tag.')).sort()) {
    if (selection[key]?.size) chips.push(chipFor(key, [...selection[key]]))
  }
  return chips
}

const eqChip = (field, value) => ({ field, op: 'eq', value })

/** Saved searches shown in the builder's overlay (the "example queries" section). */
export const ALERT_EXAMPLE_QUERIES = [
  { name: 'Firing, no receiver', description: 'Firing rules that notify nobody', chips: [eqChip('state', 'firing'), eqChip('has_receiver', 'no')] },
  { name: 'Switched off', description: 'Paused rules', chips: [eqChip('enabled', 'off')] },
  { name: 'Muted now', description: 'Rules a mute is silencing right now', chips: [eqChip('muted', 'yes')] },
  { name: "Can't evaluate", description: 'Rules whose last check errored', chips: [eqChip('health', 'error')] },
]

/** What the recent-searches overlay starts with before the viewer runs any. */
export const ALERT_RECENT_SEEDS = [
  [eqChip('state', 'firing')],
  [eqChip('enabled', 'off')],
]

/**
 * A chip array as the selection, for the rail, the counts and the filter. Walks
 * groups; a negation (`!=`, `not_in`) or an `is empty` has no rail equivalent
 * and is dropped, as are the operators the alerts fields never need.
 */
export function chipsToSelection(chips) {
  const sel = {}
  const add = (key, v) => { if (v != null && v !== '') (sel[key] ??= new Set()).add(String(v)) }
  const walk = (nodes) => {
    for (const n of nodes ?? []) {
      if (n?.kind === 'group') { walk(n.children); continue }
      const { field, op, value } = n
      if (op === 'neq' || op === 'not_in' || op === 'empty' || op === 'nregex') continue
      const key = field === '_msg' ? 'alert' : field
      if (op === 'in') for (const v of value ?? []) add(key, v)
      else add(key, Array.isArray(value) ? value.join(' ') : value)
    }
  }
  walk(chips)
  return sel
}
