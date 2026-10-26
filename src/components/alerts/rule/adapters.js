// The one seam between the rule page and the Alerts store. The page asks this
// file for a rule and what it did in a window; everything here is a thin read
// of Phase 1's hook (hooks/useAlerts) narrowed to one rule, so a change in the
// store's shape is a change here and nowhere else.

import { useMemo } from 'react'
import { useAlerts } from '@/hooks/useAlerts'
import { shiftedWindow } from './rulePage'

const NO_ROWS = []
const sameRule = id => r => String(r.ruleId ?? r.rule_id) === String(id)

/**
 * Everything the rule page reads for one rule over `win`:
 *
 *   view        the rule view (utils/alerts/model.js), or null: "Alert not found"
 *   series      its query's series over the window
 *   prevSeries  the same series over the previous period, laid onto this
 *               window's buckets: the dashed compare line and "now vs previous"
 *   timeline    its lane: { intervals, series, suppressed, notifications }
 *   log         its notification log rows in the window, newest first
 *   prev        { timeline, log, win } over the window before this one
 *   lookups     Slack channels, Opsgenie teams, Jira projects, teams, users
 *   muteGroups  the mute schedules, for what the rule's are and whether they hold now
 *   actions     the store's; each returns its own undo, or null
 *   updatedAt, stale, refresh
 *
 * The previous period's lane and log come from the same hook over the window
 * one span earlier (rulePage shiftedWindow), so they are the store's own
 * reading of that window rather than a second derivation.
 */
export function useRuleData(win, ruleId) {
  const alerts = useAlerts(win)
  const prevWin = useMemo(() => shiftedWindow(win, win.end - win.start), [win])
  const before = useAlerts(prevWin)
  const view = alerts.byId(ruleId)
  const id = view?.id ?? null

  const series = useMemo(() => (id != null ? alerts.seriesFor(id) : NO_ROWS), [alerts, id])
  // The store lays the previous period onto this window's buckets
  // (`previousPoints`: same length, order and t), so it plots on this axis.
  const prevSeries = useMemo(
    () => series.map(s => ({ key: s.key, labels: s.labels, points: s.previousPoints ?? [], previous: s.previous ?? null })),
    [series],
  )
  const timeline = useMemo(() => (id != null ? alerts.timeline.find(sameRule(id)) ?? null : null), [alerts.timeline, id])
  const log = useMemo(() => (id != null ? alerts.log.filter(sameRule(id)) : NO_ROWS), [alerts.log, id])
  const prev = useMemo(() => ({
    timeline: id != null ? before.timeline.find(sameRule(id)) ?? null : null,
    log: id != null ? before.log.filter(sameRule(id)) : NO_ROWS,
    win: prevWin,
  }), [before, id, prevWin])

  return {
    view, series, prevSeries, timeline, log, prev,
    lookups: alerts.lookups, muteGroups: alerts.muteGroups, actions: alerts.actions,
    updatedAt: alerts.updatedAt, stale: alerts.stale, refresh: alerts.refresh,
  }
}
