import { useMemo, useSyncExternalStore } from 'react'
import { alertsStore, alertsFor } from '@/utils/alerts/store'

/**
 * The Alerts module's data for a window (docs/alerts/DESIGN.md D15):
 *
 *   { rules, byId, seriesFor, timeline, log, stats, receiverGroups,
 *     muteGroups, silences, slos, monitors, lookups, updatedAt, stale,
 *     refresh, actions }
 *
 * One store behind every caller, so an edit anywhere is seen everywhere; the
 * derivation is memoised on the store's state and the window, and the data
 * module memoises evaluation per rule beneath that. `win` is optional — a
 * page that shows no history can leave it out.
 */
export function useAlerts(win) {
  const store = alertsStore()
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState)
  return useMemo(() => ({
    ...alertsFor(state, win),
    refresh: store.refresh,
    actions: store.actions,
  }), [state, win, store])
}
