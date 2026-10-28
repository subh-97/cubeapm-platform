export const STATUS = {
  healthy: 'healthy',
  warning: 'warning',
  critical: 'critical',
  info: 'info',
  neutral: 'neutral',
}

export const STATUS_COLORS = {
  healthy: '#22C55E',
  warning: '#F59E0B',
  critical: '#EF4444',
  info: '#60A5FA',
  neutral: '#616C86',
}

export const STATUS_LABELS = {
  healthy: 'Healthy',
  warning: 'Warning',
  critical: 'Critical',
  info: 'Info',
  neutral: 'No Data',
}

/**
 * The server scales every service badge reads. Exported so an alert rule made
 * from a service card defaults to exactly the thresholds that colour the card
 * (docs/alerts/DESIGN.md D13): the rule fires when the badge turns amber or red,
 * not at some figure of its own. Frozen, because a shared table that one caller
 * could nudge would move every badge on the platform with it.
 */
export const THRESHOLDS = Object.freeze({
  latencyP90Ms: Object.freeze({ warn: 150, critical: 300 }),
  errorRatePct: Object.freeze({ warn: 1, critical: 3 }),
})

export function statusForLatency(ms) {
  if (ms == null) return STATUS.neutral
  if (ms >= THRESHOLDS.latencyP90Ms.critical) return STATUS.critical
  if (ms >= THRESHOLDS.latencyP90Ms.warn) return STATUS.warning
  return STATUS.healthy
}

export function statusForErrorRate(pct) {
  if (pct == null) return STATUS.neutral
  if (pct >= THRESHOLDS.errorRatePct.critical) return STATUS.critical
  if (pct >= THRESHOLDS.errorRatePct.warn) return STATUS.warning
  return STATUS.healthy
}

/**
 * Google's Core Web Vitals bands, in the units the Browser page reads them in:
 * LCP and INP in milliseconds, CLS unitless. At or under `good` is good, over
 * `poor` is poor, and the band between is "needs improvement".
 *
 * They get thresholds of their own rather than going through statusForLatency
 * because that one is calibrated on a SERVER's p90 (150 / 300 ms): a 1.2 s page
 * load is a perfectly good page and would read critical there, and every page
 * of the storefront would be red on every range. The chart bands, the summary
 * chip and the table's worst-rating dot all read these same numbers, so the
 * band a line sits in and the colour of its dot cannot disagree.
 */
export const WEB_VITAL_THRESHOLDS = {
  lcp: { good: 2500, poor: 4000 },
  inp: { good: 200, poor: 500 },
  cls: { good: 0.1, poor: 0.25 },
}

/**
 * What each rating is called where a web vital is shown. A web vital is rated
 * rather than alerted on — "Needs improvement" is the standard's own word for
 * the middle band, and "Warning" would claim something it does not.
 */
export const WEB_VITAL_RATINGS = {
  healthy: 'Good',
  warning: 'Needs improvement',
  critical: 'Poor',
}

/**
 * A web vital's rating on the shared status scale. Inclusive at both edges, as
 * the standard writes them: an LCP of exactly 2.5 s is good and one of exactly
 * 4 s still needs improvement. No reading, or a metric this does not know,
 * is 'neutral' — the scale's own "no data" — rather than a guess.
 */
export function statusForWebVital(metric, v) {
  const t = WEB_VITAL_THRESHOLDS[metric]
  if (!t || typeof v !== 'number' || Number.isNaN(v)) return STATUS.neutral
  if (v <= t.good) return STATUS.healthy
  if (v <= t.poor) return STATUS.warning
  return STATUS.critical
}

// Log severity maps onto the shared status scale, so a level badge is coloured
// by the same resolver as every other severity signal rather than by a palette
// of its own. `info` is the informational blue, not healthy green — an info log
// says nothing about health.
export function statusForLogLevel(level) {
  if (level === 'error') return STATUS.critical
  if (level === 'warn') return STATUS.warning
  if (level === 'info') return STATUS.info
  return STATUS.neutral
}

// An HTTP response code on the same scale, for records whose status_code is the
// code itself rather than OTel's ERROR/UNSET — a mobile request reports what the
// server answered. 0 is not a code at all: the request never got an answer
// (timed out, no connection), which for the person holding the phone is as
// broken as a 5xx. A 4xx is the client's own fault, worth seeing but not paging
// on. UNSET is a record that never set a status, which means nothing went wrong
// — the same reading statusForSpan gives it. Anything else, a blank included,
// says nothing about health and stays neutral.
export function statusForHttpStatus(code) {
  if (code == null) return STATUS.neutral
  const s = String(code).trim()
  if (s === 'UNSET') return STATUS.healthy
  if (!/^\d+$/.test(s)) return STATUS.neutral
  const n = Number(s)
  if (n === 0 || (n >= 500 && n <= 599)) return STATUS.critical
  if (n >= 400 && n <= 499) return STATUS.warning
  if (n >= 100 && n <= 399) return STATUS.healthy
  return STATUS.neutral
}

/**
 * What each alert state is called where it is shown. Keyed by `alertStateKey`,
 * which folds a firing alert's severity into its state: production shows every
 * firing alert as one red "firing" tag, and here the tag names the severity
 * instead (docs/alerts/DESIGN.md D1).
 */
export const ALERT_STATE_LABELS = {
  critical: 'Critical',
  warning: 'Warning',
  pending: 'Pending',
  error: 'Rule error',
  ok: 'OK',
  nodata: 'No data',
  paused: 'Paused',
}

// The evaluation states an alert rule can be in, besides firing. `ok` is
// production's `inactive` (shown there as "normal"); `error` is a rule whose
// health is not ok — its query cannot be evaluated.
const ALERT_NONFIRING = new Set(['pending', 'error', 'ok', 'nodata', 'paused'])

/**
 * The label key for an alert state. A firing alert is critical only when it
 * carries severity=critical (its rule's critical tier, or a tag); any other
 * firing alert is a warning, so red keeps meaning "severe" rather than merely
 * "firing" (signed off as Q2). A state this does not know is null, not a guess.
 */
export function alertStateKey(state, severity) {
  if (state === 'firing') return severity === 'critical' ? 'critical' : 'warning'
  return ALERT_NONFIRING.has(state) ? state : null
}

/**
 * An alert state on the shared status scale. Pending is the informational blue —
 * the condition holds but has not held long enough to fire, which is news but
 * not yet severity. No data, a rule that cannot evaluate and a paused rule are
 * all neutral: what tells them apart is the label, not a colour.
 */
export function statusForAlertState(state, severity) {
  const key = alertStateKey(state, severity)
  if (key === 'critical') return STATUS.critical
  if (key === 'warning') return STATUS.warning
  if (key === 'pending') return STATUS.info
  if (key === 'ok') return STATUS.healthy
  return STATUS.neutral
}

/**
 * A notification's delivery on the shared status scale: sent is healthy, failed
 * is critical. A muted or snoozed one was held on purpose, which says nothing
 * about the destination's health, so it is neutral; so is anything this does
 * not know. Production's log statuses, as data: SUCCESS, ERROR, MUTE, SNOOZE.
 */
export function statusForDelivery(status) {
  if (status === 'SUCCESS') return STATUS.healthy
  if (status === 'ERROR') return STATUS.critical
  return STATUS.neutral
}

export function worstStatus(...statuses) {
  const order = [STATUS.critical, STATUS.warning, STATUS.healthy, STATUS.info, STATUS.neutral]
  for (const s of order) {
    if (statuses.includes(s)) return s
  }
  return STATUS.neutral
}

export function statusColor(status) {
  return STATUS_COLORS[status] || STATUS_COLORS.neutral
}
