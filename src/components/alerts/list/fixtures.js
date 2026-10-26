// The Rules tab's data, for this folder's tests, in exactly the shape the page
// shell hands the tab: `useAlerts(win)`'s `{ rules, byId, seriesFor, timeline,
// updatedAt, stale, refresh, actions }`.
//
// The seeded world is the real one, built the way the hook builds it
// (utils/alerts/store.js `alertsFor` over a store with no browser storage), so
// the tests read the same incident the page shows. payment-service's Redis
// pool began failing INCIDENT_START_MIN minutes before now, and at Last 1 hour
// the seed has (Phase 1's stable ids):
//
//   Critical    501 payment-service error rate (~15% against 3%), 502 its p90
//               (612 ms against 300), 514 redis.0 memory, 515 CPU on three
//               hosts, 9011 the payment SLO's fast burn
//   Warning     437 production's demo rule, 504 error logs, 506 order-service
//               errors, 508 notify-service (chronic), 509, 9012 the slow burn
//   Suppressed  505 order-service p90 (muted), 507 shipment-service p90 (snoozed)
//   Pending 503 · Rule error 513 · No data 512 · OK 426, 510, 511
//   Paused      427, 428, 432, 433 (synthetic monitors)
//
// Two worlds the seed cannot be are made by hand: a calm day, and a workspace
// with no rules at all.

import { createAlertsStore, alertsFor } from '@/utils/alerts/store'
import { statusForAlertState } from '@/utils/status'
import { ALERT_ORDER, sortRules } from './adapters'

const HOUR = 3600
const MIN = 60

/** Storage held in memory: edits last as long as the store, and touch no browser. */
export function memoryStorage() {
  const m = new Map()
  return { getItem: k => m.get(k) ?? null, setItem: (k, v) => { m.set(k, String(v)) }, removeItem: k => { m.delete(k) } }
}

/** A store of the seed, for a test that changes something and reads it back. */
export const seededStore = () => createAlertsStore({ storage: memoryStorage() })

/**
 * The seeded world over a window, as the hook hands it over. Pass a `store` to
 * see the effect of its actions: read it again after one.
 */
export function seededAlerts(win, store = seededStore()) {
  return { ...alertsFor(store.getState(), win), refresh: store.refresh, actions: store.actions }
}

// A view with its rule at rest: evaluating, under its thresholds, nobody told.
function calm(view, nowSec) {
  return {
    ...view,
    state: 'ok',
    severity: null,
    stateKey: 'ok',
    tone: statusForAlertState('ok'),
    rank: ALERT_ORDER.indexOf('ok'),
    suppression: null,
    snoozes: [],
    instances: [],
    value: null,
    thresholdMultiple: null,
    since: nowSec - 3 * HOUR,
    sinceOpen: false,
    lastError: null,
  }
}

/**
 * A calm day: every rule that is not paused is OK, and the range's one alert,
 * payment-service's error rate, resolved three hours ago, after twenty
 * minutes of firing. Only a range of more than three hours can see it.
 */
export function quietAlerts(win) {
  const seeded = seededAlerts(win)
  const nowSec = win.nowSec
  const rules = sortRules(seeded.rules.map(v => (v.state === 'paused' ? v : calm(v, nowSec))))
  const index = new Map(rules.map(v => [String(v.id), v]))
  const end = nowSec - 3 * HOUR
  const intervals = [
    { state: 'pending', severity: null, start: end - 25 * MIN, end: end - 20 * MIN },
    { state: 'firing', severity: 'warning', start: end - 20 * MIN, end },
  ]
  const timeline = [{
    ruleId: 501,
    intervals,
    series: [{ key: '', labels: {}, intervals }],
    suppressed: [],
    notifications: [end - 20 * MIN],
  }]
    .map(e => ({ ...e, intervals: e.intervals.filter(i => i.end > win.start && i.start < win.end) }))
    .filter(e => e.intervals.length)
  return { ...seeded, rules, byId: id => index.get(String(id)) ?? null, timeline }
}

/** A workspace that has no rules yet. */
export function emptyAlerts(win) {
  const seeded = seededAlerts(win)
  return { ...seeded, rules: [], byId: () => null, seriesFor: () => [], timeline: [] }
}
