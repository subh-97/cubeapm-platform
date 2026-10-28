// The Insights tab's readings (production's Stats; docs/alerts/DESIGN.md D11):
// which rules are noisy, which never do anything, and by how much that changed
// against the previous period. Production lists only rules that fired, sorted
// by incidents, with no definitions and nothing flagged — so its own demo rule,
// firing 98.8% of the week, reads as one more row.

import { csvCell } from '@/utils/explore/csv'

/** What each flag means, in the words its chip and its header tip use. */
export const FLAG_TEXT = {
  alwaysFiring: { label: 'Always firing', help: 'Firing at least half of the range: the threshold sits inside normal behaviour, so the alert says nothing new.' },
  flapping: { label: 'Flapping', help: 'At least 6 short incidents (median under 10 minutes), 4 or more an hour: the value hovers at the threshold.' },
  neverFired: { label: 'Never fired', help: 'Over a day or more, not a single incident and not even a pending stretch: its condition never held. It may be measuring nothing.' },
}

/**
 * The flags a rule's numbers over a span raise. Pure, so their edges can be
 * pinned: Always firing from 50% of the span; Flapping from 6 incidents with a
 * median under 600 s at 4 or more an hour; Never fired over a day or more with
 * no activity at all. A paused rule raises none, nor does one that cannot run.
 */
export function insightFlags({ paused = false, error = false, spanSec, firingPct, incidents, medianSec, active }) {
  if (paused) return { alwaysFiring: false, flapping: false, neverFired: false }
  return {
    alwaysFiring: firingPct >= 50,
    flapping: incidents >= 6 && medianSec != null && medianSec < 600 && incidents / (spanSec / 3600) >= 4,
    neverFired: !error && spanSec >= 86400 && !active,
  }
}

const delta = (now, before) => (before == null || now == null ? null : now - before)

/**
 * Every rule, joined with its numbers over the range and the previous one, in
 * the order the tab shows them: the flagged first (always firing, then
 * flapping), then by incidents, then by time spent firing. A rule with no
 * numbers (paused before the range) is still listed, so "Never fired" and
 * "Paused" can be said at all.
 *
 *   [{ id, name, group, view, paused, incidents, firingSec, firingPct,
 *      medianSec, notifications, failed, flags, deltas: { incidents, firingPct, notifications } | null }]
 */
export function insightRows(views, stats, statsBefore = null) {
  const now = new Map((stats ?? []).map(s => [String(s.ruleId), s]))
  const before = statsBefore ? new Map(statsBefore.map(s => [String(s.ruleId), s])) : null
  const rows = (views ?? []).map((v) => {
    const s = now.get(String(v.id))
    const b = before?.get(String(v.id))
    const paused = v.state === 'paused'
    return {
      id: v.id,
      name: v.name,
      group: v.group,
      view: v,
      paused,
      incidents: s?.incidents ?? 0,
      firingSec: s?.firingSec ?? 0,
      firingPct: s?.firingPct ?? 0,
      medianSec: s?.medianSec ?? null,
      notifications: s?.notifications ?? 0,
      failed: s?.failed ?? 0,
      flags: s?.flags ?? { alwaysFiring: false, flapping: false, neverFired: false },
      deltas: before ? {
        incidents: delta(s?.incidents ?? 0, b?.incidents ?? 0),
        firingPct: delta(s?.firingPct ?? 0, b?.firingPct ?? 0),
        notifications: delta(s?.notifications ?? 0, b?.notifications ?? 0),
      } : null,
    }
  })
  const rank = r => (r.flags.alwaysFiring ? 0 : r.flags.flapping ? 1 : r.paused ? 4 : r.flags.neverFired ? 3 : 2)
  return rows.sort((a, b) => rank(a) - rank(b) || b.incidents - a.incidents || b.firingPct - a.firingPct || a.name.localeCompare(b.name))
}

/** The strip above the table: totals over the range, and their change. */
export function insightsSummary(rows) {
  const sum = key => rows.reduce((a, r) => a + (r[key] ?? 0), 0)
  const sumDelta = key => (rows.every(r => r.deltas) ? rows.reduce((a, r) => a + (r.deltas[key] ?? 0), 0) : null)
  return {
    incidents: sum('incidents'),
    incidentsDelta: sumDelta('incidents'),
    notifications: sum('notifications'),
    notificationsDelta: sumDelta('notifications'),
    failed: sum('failed'),
    flagged: rows.filter(r => r.flags.alwaysFiring || r.flags.flapping || r.flags.neverFired).length,
    alwaysFiring: rows.filter(r => r.flags.alwaysFiring).length,
  }
}

/** The table as CSV, one row per rule, numbers unformatted. */
export function insightsCsv(rows) {
  const head = ['id', 'group', 'name', 'incidents', 'firing_minutes', 'firing_pct', 'median_incident_minutes', 'notifications', 'failed', 'flags']
  const lines = rows.map(r => [
    r.id, r.group, r.name, r.incidents, Math.round(r.firingSec / 60), Math.round(r.firingPct * 10) / 10,
    r.medianSec == null ? '' : Math.round(r.medianSec / 60), r.notifications, r.failed,
    Object.keys(FLAG_TEXT).filter(k => r.flags[k]).map(k => FLAG_TEXT[k].label).join('; '),
  ].map(csvCell).join(','))
  return [head.join(','), ...lines].join('\n')
}
