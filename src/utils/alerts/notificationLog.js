// The Notifications tab's rows (production's Notification History;
// docs/alerts/DESIGN.md D12). Production's record says which rule, which raw
// receiver, a status and an empty "details" — never whether the message was
// about firing or resolving, never which contact point it belonged to. These
// rows say both, and why a message was held or failed.
//
// Two columns where production has one: Event is what the message was about
// (Fired, Reminder, Resolved), Status is what became of it (production's
// SUCCESS / ERROR / MUTE / SNOOZE, named Sent / Failed / Muted / Snoozed). A
// muted resolve is then still a resolve.

import { NOTIFICATION_STATUS_LABELS, RECEIVER_TYPES } from './catalog'
import { receiverSummary } from './routing'

export const EVENT_LABELS = { fired: 'Fired', reminder: 'Reminder', resolved: 'Resolved' }
/** The facets the log is filtered by, in the rail's order, and the URL keys they use. */
export const LOG_FACETS = [
  { key: 'status', title: 'Status' },
  { key: 'event', title: 'Event' },
  { key: 'group', title: 'Group' },
  { key: 'contact', title: 'Contact point' },
  { key: 'integration', title: 'Integration' },
]
export const ONE_OFF = 'one-off'

// The series a row is about, as model.js keys an instance, so a row can link to
// the instance it notified about while that instance is still active.
const instanceKey = labels => JSON.stringify(Object.entries(labels ?? {})
  .filter(([k]) => !['alertname', 'group', 'query', 'rule_id', 'severity', 'alertgroup'].includes(k))
  .sort(([a], [b]) => a.localeCompare(b)))

/**
 * The log (newest first, production's row shape plus `event`,
 * `receiver_group_id`, `alert_labels`) → the rows the tab draws:
 *
 *   { id, at, ruleId, ruleName, group, event, eventLabel, status, statusLabel,
 *     contact: { id, name } | null, integration: { type, label, target, full },
 *     why, labels, instanceId, row }
 *
 * `why` is the reason, in words: the error for a failure, the schedule for a
 * mute, who snoozed and until when; empty for a plain send.
 */
export function logRows(log, { views = [], receiverGroups = [], lookups = {} } = {}) {
  const byRule = new Map(views.map(v => [String(v.id), v]))
  const groups = new Map(receiverGroups.map(g => [g.id, g]))
  return (log ?? []).map((row) => {
    const view = byRule.get(String(row.rule_id))
    const configs = RECEIVER_TYPES.find(t => t.type === row.receiver_type)?.configs ?? null
    const s = receiverSummary({ type: row.receiver_type, configs, data: row.receiver_data }, lookups)
    const contact = row.receiver_group_id != null && groups.has(row.receiver_group_id)
      ? { id: row.receiver_group_id, name: groups.get(row.receiver_group_id).name }
      : null
    const key = instanceKey(row.alert_labels)
    const instance = view?.instances?.find(i => i.key === key)
    return {
      id: String(row.id),
      at: Date.parse(row.created_at) / 1000,
      ruleId: row.rule_id,
      ruleName: row.rule_name,
      group: view?.group ?? null,
      event: row.event ?? null,
      eventLabel: EVENT_LABELS[row.event] ?? 'Notification',
      status: row.status,
      statusLabel: NOTIFICATION_STATUS_LABELS[row.status] ?? row.status,
      contact,
      integration: { type: row.receiver_type, label: s.label, target: s.target, full: s.full },
      why: row.details ?? '',
      labels: row.alert_labels ?? {},
      instanceId: instance?.id ?? null,
      row,
    }
  })
}

// A row's value for a facet key, as the URL spells it.
function valueOf(r, key) {
  if (key === 'status') return r.status
  if (key === 'event') return r.event
  if (key === 'group') return r.group
  if (key === 'contact') return r.contact ? r.contact.name : ONE_OFF
  if (key === 'integration') return r.integration.type
  return null
}

/**
 * The rows that pass `ruleId` (production's `rule_id`, one rule) and every
 * facet with a selection — any of a facet's chosen values, all facets at once.
 */
export function filterLog(rows, { ruleId = null, facets = {} } = {}) {
  return rows.filter(r => (ruleId == null || String(r.ruleId) === String(ruleId))
    && LOG_FACETS.every(({ key }) => {
      const chosen = facets[key]
      const set = chosen instanceof Set ? chosen : new Set(chosen ?? [])
      return set.size === 0 || set.has(valueOf(r, key))
    }))
}

/**
 * Each facet's values over `rows` with their counts, the way the rail lists
 * them: `{ [key]: [{ value, label, count }] }`. A value chosen in the URL
 * that no row has is still listed, at 0, so it can be seen and cleared.
 */
export function logFacets(rows, facets = {}) {
  const out = {}
  for (const { key } of LOG_FACETS) {
    const counts = new Map()
    const labels = new Map()
    for (const r of rows) {
      const v = valueOf(r, key)
      if (v == null) continue
      counts.set(v, (counts.get(v) ?? 0) + 1)
      if (!labels.has(v)) labels.set(v, labelOf(r, key))
    }
    for (const v of facets[key] ?? []) if (!counts.has(v)) { counts.set(v, 0); labels.set(v, v === ONE_OFF ? 'One-off destination' : v) }
    out[key] = [...counts].map(([value, count]) => ({ value, label: labels.get(value), count }))
      .sort((a, b) => b.count - a.count || String(a.label).localeCompare(String(b.label)))
  }
  return out
}

function labelOf(r, key) {
  if (key === 'status') return r.statusLabel
  if (key === 'event') return r.eventLabel
  if (key === 'contact') return r.contact ? r.contact.name : 'One-off destination'
  if (key === 'integration') return r.integration.label
  return r.group
}

/**
 * What the message carried, as an Alertmanager webhook receives it — the
 * expanded row's payload. Built from the row, since the log keeps no body.
 */
export function payloadOf(r) {
  return {
    status: r.event === 'resolved' ? 'resolved' : 'firing',
    receiver: r.contact?.name ?? 'one-off destination',
    commonLabels: { alertname: r.ruleName, rule_id: String(r.ruleId), ...r.labels },
    alerts: [{ status: r.event === 'resolved' ? 'resolved' : 'firing', labels: { alertname: r.ruleName, ...r.labels }, startsAt: r.row.created_at }],
  }
}
