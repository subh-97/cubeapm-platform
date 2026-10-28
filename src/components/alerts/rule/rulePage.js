// The rule page's own logic (docs/alerts/DESIGN.md D5), kept out of the
// components so it is tested without rendering anything, and so the page file
// exports nothing but the page.
//
// Everything reads a rule VIEW (utils/alerts/model.js) and what the data layer
// hands out for a window (data/alerts.js): timeline stretches, notification log
// rows and the query's series. Every time here is unix seconds; a production
// field that arrives as an ISO string (an alert's activeAt, a log row's
// created_at) goes through `toSec` first.

import { formatValue, formatThreshold, formatElapsed, multipleText } from '@/utils/alerts/describe'
import { RECEIVER_TYPES } from '@/utils/alerts/catalog'
import { receiverSummary } from '@/utils/alerts/routing'
import { statusForAlertState, alertStateKey, ALERT_STATE_LABELS } from '@/utils/status'
import { incidentWeightOver } from '@/data/timeWindow'
import { services } from '@/data/services'
import { formatLocal } from '@/utils/timeRange'

/** Unix seconds from seconds, milliseconds-free ISO text, or a Date; null otherwise. */
export function toSec(v) {
  if (v == null || v === '') return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (v instanceof Date) return Math.floor(v.getTime() / 1000)
  const n = Date.parse(String(v))
  // Production's "never evaluated" stamp is year 1: no time at all.
  return Number.isFinite(n) && n > 0 ? Math.floor(n / 1000) : null
}

/** A clock time for the page: 15:18, with the date when it is not today. */
export function clockText(sec, nowSec) {
  if (sec == null) return ''
  const ms = sec * 1000
  const sameDay = new Date(ms).toDateString() === new Date(nowSec * 1000).toDateString()
  return formatLocal(ms, sameDay ? 'HH:mm' : 'MMM DD HH:mm')
}

/* ---- rules other modules manage (D18) ---- */

/** Why "Edit in SLO" waits, in the words the shared Actions menu uses. */
export const SLO_EDIT_REASON = 'The SLO page comes later'

/** Who manages a rule the editor does not own, in one line; null for the rest. */
export function managedNote(view) {
  const m = view?.managedBy
  if (m?.kind === 'slo') {
    const where = [m.service, m.endpoint].filter(Boolean).join(' ')
    return `From the SLO for ${where || 'this service'}. The SLO configures it, so it is read-only here: snooze it, or read its history.`
  }
  if (m?.kind === 'synthetic') return `From monitor ${m.monitorName}. Changes made here apply to this rule only.`
  return null
}

/* ---- arriving from a notification (D14) ---- */

/** A notification link is old when the range already runs this far past it. */
export const NOTIFY_STALE_SEC = 35 * 60
/** How far either side of the notification the re-centred range reaches. */
export const NOTIFY_HALF_SPAN_SEC = 30 * 60

/**
 * Production's rule for a notification link's `notifyTime` (reference §1.3):
 * when the range in force ends more than 35 minutes after the notification,
 * the link is old, and the range becomes the hour centred on it — an absolute
 * range, ±30 minutes. Otherwise the range is left alone (null). Pure: the page
 * applies the answer once, on arrival.
 */
export function notifyRange(notifyTime, rangeEndSec) {
  if (!Number.isFinite(notifyTime) || !Number.isFinite(rangeEndSec)) return null
  if (!(rangeEndSec > notifyTime + NOTIFY_STALE_SEC)) return null
  return {
    kind: 'absolute',
    from: (notifyTime - NOTIFY_HALF_SPAN_SEC) * 1000,
    to: (notifyTime + NOTIFY_HALF_SPAN_SEC) * 1000,
  }
}

/* ---- the threshold the reading crossed ---- */

/** A tier's number: a static threshold, or an anomaly rule's deviations. */
export const tierNumber = tier => (tier ? (tier.threshold ?? tier.deviations ?? null) : null)

/**
 * The tier the rule's state is about, `{ severity, tier }`: the critical tier
 * when it fires critical, otherwise the warning tier (a pending or warning
 * alert is waiting on, or past, that one), otherwise whichever tier it has.
 */
export function crossedTier(view) {
  const { warning = null, critical = null } = view?.tiers ?? {}
  if (view?.severity === 'critical' && critical) return { severity: 'critical', tier: critical }
  if (warning) return { severity: 'warning', tier: warning }
  if (critical) return { severity: 'critical', tier: critical }
  return null
}

/* ---- the incident banner ---- */

// services.js notes read "<symptom> - <cause>"; the cause is the half a banner
// says. Built from the same note the service page and Home already explain the
// incident with, so the three cannot tell different stories.
/** The root cause the app already tells for a service, as a phrase, or null. */
export function rootCauseFor(serviceId) {
  const note = services.find(s => s.id === serviceId)?.note
  if (!note) return null
  const at = note.indexOf(' - ')
  const cause = (at === -1 ? note : note.slice(at + 3)).trim()
  return cause ? cause[0].toUpperCase() + cause.slice(1) : null
}

/**
 * The banner's sentence for a firing rule (D5): how long it has fired, the
 * reading against the threshold it crossed, as a multiple, then the root cause
 * when the app knows one. Built from describe.js's own formatters, so it says
 * a number exactly the way the list and the head do.
 *
 *   "Firing for 16m. 14.8% now, 4.9× the 3% threshold. Likely cause: Redis
 *    connection pool exhaustion (redis.0)."
 *
 * Returns `{ lead, reading, cause, text }`, or null for a rule not firing.
 */
export function bannerSentence(view, nowSec, cause = null) {
  if (view?.state !== 'firing') return null
  const elapsed = view.since != null ? `${formatElapsed(nowSec - view.since)}${view.sinceOpen ? '+' : ''}` : null
  const lead = elapsed ? `Firing for ${elapsed}.` : 'Firing.'
  const crossed = crossedTier(view)
  const value = formatValue(view, view.value)
  let reading = null
  if (view.value != null && Number.isFinite(view.value)) {
    if (view.kind === 'anomaly') {
      reading = crossed
        ? `${value} now, outside its expected range by more than ${formatThreshold(view, tierNumber(crossed.tier))}.`
        : `${value} now, outside its expected range.`
    } else if (crossed) {
      const threshold = formatThreshold(view, tierNumber(crossed.tier))
      const multiple = multipleText(view)
      reading = multiple
        ? `${value} now, ${multiple} the ${threshold} threshold.`
        : `${value} now, against the ${threshold} threshold.`
    } else {
      reading = `${value} now.`
    }
  }
  const causeText = cause ? `Likely cause: ${cause.replace(/\.$/, '')}.` : null
  return { lead, reading, cause: causeText, text: [lead, reading, causeText].filter(Boolean).join(' ') }
}

/* ---- series and instances ---- */

// Labels the evaluator writes onto every alert; they say nothing about which
// series an alert is (production hides the same set, reference §3).
const RESERVED_LABELS = new Set(['alertname', 'alertgroup', 'group', 'query', 'rule_id', 'severity'])

/** An alert's own labels: what tells its series apart. */
export function seriesLabelsOf(labels = {}) {
  return Object.fromEntries(Object.entries(labels ?? {}).filter(([k]) => !RESERVED_LABELS.has(k)))
}

/** `service=payment-service, host.name=ip-1` — '' for a series with no labels. */
export function labelText(labels = {}) {
  return Object.entries(labels ?? {}).map(([k, v]) => `${k}=${v}`).join(', ')
}

/** What a rule with one unlabelled series calls it: its scope, or its metric. */
export function scopeName(view) {
  const s = view?.scope ?? {}
  if (s.service && s.endpoint) return `${s.endpoint} on ${s.service}`
  return s.service ?? s.host ?? view?.metric ?? view?.name ?? 'Value'
}

/** A series' name in the legend and the instance rows. */
export function seriesName(series, view) {
  return labelText(series?.labels) || scopeName(view)
}

const SEVERITY_ORDER = { critical: 0, warning: 1, pending: 2, ok: 3, nodata: 4, error: 5, paused: 6 }
const stateRank = (state, severity) => SEVERITY_ORDER[alertStateKey(state, severity)] ?? 9

const lastValue = points => {
  for (let i = (points?.length ?? 0) - 1; i >= 0; i--) {
    const v = points[i]?.value
    if (v != null && Number.isFinite(v)) return v
  }
  return null
}

/**
 * One row per label set (D5 "Instances"), worst first. A series can hold two
 * alerts — its warning tier's and its critical tier's — and they are one row,
 * carrying both alert ids, so a notification about either lands on it. A
 * series with no alert open is listed too, as OK: the table is every label set
 * the query returns, not only the ones in trouble.
 *
 *   { key, labels, name, state, severity, tone, value, activeAt, firingAt,
 *     ids: [alert ids], points }
 */
export function instanceRows(view, series = []) {
  const rows = new Map()
  for (const inst of view?.instances ?? []) {
    const labels = seriesLabelsOf(inst.labels)
    const key = labelText(labels)
    const state = inst.state === 'inactive' ? 'ok' : inst.state
    const severity = state === 'firing' ? (inst.severity ?? (inst.labels?.severity === 'critical' ? 'critical' : 'warning')) : null
    const prev = rows.get(key)
    const value = inst.value == null || inst.value === '' ? null : Number(inst.value)
    const next = {
      key, labels, name: key || scopeName(view), state, severity,
      value: Number.isFinite(value) ? value : null,
      activeAt: toSec(inst.activeAt),
      firingAt: toSec(inst.firingAt),
      ids: [String(inst.id)],
    }
    if (!prev) rows.set(key, next)
    else {
      const worse = stateRank(next.state, next.severity) < stateRank(prev.state, prev.severity) ? next : prev
      rows.set(key, {
        ...worse,
        ids: [...prev.ids, ...next.ids],
        // The row became active when its first tier did.
        activeAt: [prev.activeAt, next.activeAt].filter(t => t != null).reduce((a, b) => Math.min(a, b), Infinity),
      })
    }
  }
  for (const r of rows.values()) if (r.activeAt === Infinity) r.activeAt = null
  // The view keeps one alert per series, its worst tier's. A notification can
  // name the other tier's alert, so every raw alert's id joins its series' row.
  for (const a of view?.rule?.alerts ?? []) {
    const row = rows.get(labelText(seriesLabelsOf(a.labels)))
    if (row && !row.ids.includes(String(a.id))) row.ids.push(String(a.id))
  }
  for (const s of series) {
    const key = labelText(s.labels)
    const row = rows.get(key) ?? (key === '' && rows.size === 1 && series.length === 1 ? [...rows.values()][0] : null)
    if (row) {
      row.points = s.points
      if (row.value == null) row.value = lastValue(s.points)
    } else {
      rows.set(key, {
        key, labels: s.labels ?? {}, name: key || scopeName(view), state: 'ok', severity: null,
        value: lastValue(s.points), activeAt: null, firingAt: null, ids: [], points: s.points,
      })
    }
  }
  return [...rows.values()]
    .map(r => ({ ...r, tone: statusForAlertState(r.state, r.severity), points: r.points ?? [] }))
    .sort((a, b) => stateRank(a.state, a.severity) - stateRank(b.state, b.severity)
      || (b.value ?? -Infinity) - (a.value ?? -Infinity)
      || a.name.localeCompare(b.name))
}

/** The row a notification's `alert_id` names, or null. */
export function rowForAlertId(rows, alertId) {
  if (alertId == null || alertId === '') return null
  const id = String(alertId)
  return rows.find(r => r.ids.includes(id)) ?? null
}

/* ---- the state strip ---- */

/**
 * The rule's state across the window, as segments on the chart's own time
 * axis: OK where no stretch is open, then each pending and firing stretch,
 * clipped to the window. Past now (Today runs to midnight) nothing is known,
 * which is drawn as its own 'future' segment rather than as OK. A paused rule,
 * one that cannot evaluate, and one whose query returns nothing have no
 * stretches to draw, so they are one segment saying so.
 *
 *   [{ from, to, key, tone, label, leftPct, widthPct, severity, state }]
 *
 * `key` is ALERT_STATE_LABELS' key (critical, warning, pending, ok, …) or
 * 'future'; `tone` is statusForAlertState's, never a colour.
 */
export function stripSegments(intervals = [], win, nowSec, ruleState = null) {
  const start = win.start
  const end = win.end
  const span = Math.max(1, end - start)
  const known = Math.max(start, Math.min(end, nowSec))
  const out = []
  const push = (from, to, state, severity) => {
    if (!(to > from)) return
    const key = state === 'future' ? 'future' : alertStateKey(state, severity) ?? 'ok'
    const last = out[out.length - 1]
    if (last && last.key === key && last.to === from) { last.to = to; return }
    out.push({
      from, to, state, severity: severity ?? null, key,
      tone: state === 'future' ? 'neutral' : statusForAlertState(state, severity),
      label: state === 'future' ? 'Not yet' : ALERT_STATE_LABELS[key] ?? key,
    })
  }
  if (ruleState === 'paused' || ruleState === 'error' || ruleState === 'nodata') {
    push(start, known, ruleState, null)
  } else {
    let cursor = start
    const sorted = [...intervals].filter(iv => iv && iv.start != null).sort((a, b) => a.start - b.start)
    for (const iv of sorted) {
      const from = Math.max(start, iv.start)
      const to = Math.min(known, iv.end ?? known)
      if (to <= start || from >= known) continue
      push(cursor, from, 'ok', null)
      push(Math.max(cursor, from), to, iv.state, iv.severity)
      cursor = Math.max(cursor, to)
    }
    push(cursor, known, 'ok', null)
  }
  push(known, end, 'future', null)
  return out.map(s => ({ ...s, leftPct: ((s.from - start) / span) * 100, widthPct: ((s.to - s.from) / span) * 100 }))
}

/* ---- counts with a comparison ---- */

/**
 * Incidents begun in [from, to): consecutive firing stretches are one
 * incident (a warning that escalates is one), and a stretch already open
 * before anyone looked (`openStart`) did not begin here. The same reading as
 * the data layer's Stats, so the KPI and Insights agree.
 */
export function incidentsStarted(intervals = [], from, to) {
  let n = 0
  let prevEnd
  for (const iv of [...intervals].sort((a, b) => a.start - b.start)) {
    if (iv.state !== 'firing') { prevEnd = undefined; continue }
    const continues = prevEnd !== undefined && prevEnd === iv.start
    prevEnd = iv.end
    if (continues || iv.openStart) continue
    if (iv.start >= from && iv.start < to) n++
  }
  return n
}

/** What a rule's notifications did in [from, to]: sent, failed, muted, snoozed. */
export function sendCounts(log = [], from, to) {
  const out = { sent: 0, failed: 0, muted: 0, snoozed: 0 }
  for (const row of log) {
    const t = toSec(row.created_at)
    if (t == null || t < from || t > to) continue
    if (row.status === 'SUCCESS') out.sent++
    else if (row.status === 'ERROR') out.failed++
    else if (row.status === 'MUTE') out.muted++
    else if (row.status === 'SNOOZE') out.snoozed++
  }
  return out
}

/* ---- notifications, in words ---- */

const CONFIGS_FOR = new Map(RECEIVER_TYPES.map(r => [r.type, r.configs]))

/**
 * A log row's destination: `{ contactPoint, integration, target, full }` —
 * "Payments on-call", "Slack", "#payments-oncall". The contact point comes
 * from the row's receiver_group_id; a one-off destination has none.
 */
export function rowDestination(row, view, lookups = {}) {
  const summary = receiverSummary({ type: row.receiver_type, configs: CONFIGS_FOR.get(row.receiver_type), data: row.receiver_data }, lookups)
  const cp = (view?.contactPoints ?? []).find(c => String(c.id) === String(row.receiver_group_id))
  return {
    contactPoint: cp?.name ?? (row.receiver_group_id == null ? 'One-off destination' : `Contact point ${row.receiver_group_id}`),
    integration: summary.label,
    type: row.receiver_type,
    target: summary.target,
    full: summary.full || summary.target,
  }
}

const EVENT_WORDS = { fired: 'Fired', resolved: 'Resolved', reminder: 'Reminder', muted: 'Muted', snoozed: 'Snoozed', failed: 'Failed' }

/** What a log row was about: production's rows say only the status; ours add the event. */
export function eventWord(row) {
  if (row.status === 'ERROR') return 'Failed'
  if (row.status === 'MUTE') return 'Muted'
  if (row.status === 'SNOOZE') return 'Snoozed'
  return EVENT_WORDS[row.event] ?? 'Sent'
}

/* ---- recent events ---- */

const ORDER_AT_SAME_TIME = { resolved: 0, fired: 1, escalated: 1, eased: 1, pending: 2, notified: 3, failed: 3, muted: 3, snoozed: 3 }

/**
 * What happened to the rule, newest first (D5's "Recent events"): it went
 * pending, fired, escalated, resolved — from its stretches — and who was told,
 * from its notification log, one line per send. Only events inside [from, to].
 *
 *   [{ t, kind, text, tone, detail? }]
 *
 * `tone` is a status key for the dot beside the line; notification lines are
 * neutral unless they failed.
 */
export function recentEvents({ intervals = [], log = [], view, from, to, limit = 8, lookups } = {}) {
  const out = []
  const inRange = t => t != null && t >= from && t <= to
  const sorted = [...intervals].filter(iv => iv && iv.start != null).sort((a, b) => a.start - b.start)
  sorted.forEach((iv, i) => {
    const prev = sorted[i - 1]
    const joined = prev && prev.end === iv.start
    if (iv.state === 'pending') {
      if (!iv.openStart && inRange(iv.start)) {
        out.push({ t: iv.start, kind: 'pending', tone: 'info', text: 'Pending', detail: view?.forSec ? `condition met, firing after ${formatElapsed(view.forSec)}` : 'condition met' })
      }
    } else if (iv.state === 'firing' && inRange(iv.start) && !iv.openStart) {
      const sev = iv.severity === 'critical' ? 'Critical' : 'Warning'
      if (joined && prev.state === 'firing') {
        const up = iv.severity === 'critical'
        out.push({ t: iv.start, kind: up ? 'escalated' : 'eased', tone: statusForAlertState('firing', iv.severity), text: up ? 'Escalated to Critical' : 'Eased to Warning' })
      } else {
        out.push({ t: iv.start, kind: 'fired', tone: statusForAlertState('firing', iv.severity), text: `Fired · ${sev}` })
      }
    }
    // An incident resolves where its last firing stretch ends without another
    // one starting at that instant.
    const next = sorted[i + 1]
    if (iv.state === 'firing' && iv.end != null && !(next && next.start === iv.end && next.state === 'firing') && inRange(iv.end)) {
      out.push({ t: iv.end, kind: 'resolved', tone: 'healthy', text: 'Resolved' })
    }
  })

  // One line per send: a contact point with two integrations is two rows in
  // the log, and two lines here, because either can fail on its own.
  for (const row of log) {
    const t = toSec(row.created_at)
    if (!inRange(t)) continue
    const dest = rowDestination(row, view, lookups)
    const where = `${dest.contactPoint} · ${dest.integration}`
    const what = row.event === 'resolved' ? 'resolved' : row.event === 'reminder' ? 'reminder' : 'alert'
    if (row.status === 'ERROR') out.push({ t, kind: 'failed', tone: 'critical', text: `Couldn't notify ${where}`, detail: row.details || undefined })
    else if (row.status === 'MUTE') out.push({ t, kind: 'muted', tone: 'neutral', text: `Held for ${where}`, detail: row.details || 'muted by a schedule' })
    else if (row.status === 'SNOOZE') out.push({ t, kind: 'snoozed', tone: 'neutral', text: `Held for ${where}`, detail: row.details || 'snoozed' })
    else out.push({ t, kind: 'notified', tone: 'neutral', text: `Sent ${what} to ${where}`, detail: dest.target || undefined })
  }

  return out
    .sort((a, b) => b.t - a.t || (ORDER_AT_SAME_TIME[a.kind] ?? 9) - (ORDER_AT_SAME_TIME[b.kind] ?? 9))
    .slice(0, limit)
}

/* ---- comparison windows ---- */

/**
 * The same window `bySec` earlier, bucket for bucket: every bucket keeps its
 * index (so a series read over it lines up with today's on the chart) and its
 * length, and its incident share is re-measured at its new distance from now —
 * the hour before the last one never saw the pool fail. `nowSec` stays the
 * data's now. The method of data/errors.js `previousWindow`, for any shift.
 */
export function shiftedWindow(win, bySec) {
  const by = Math.max(0, Number(bySec) || 0)
  const buckets = win.buckets.map(b => {
    const t = b.t - by
    const m = b.m + by / 60
    const clock = formatLocal(t * 1000, 'MMM DD HH:mm')
    return { ...b, t, ms: t * 1000, m, w: incidentWeightOver(m, b.durMin), label: clock, exactTime: clock }
  })
  return {
    ...win,
    start: win.start - by,
    end: win.end - by,
    relative: false,
    trailing: false,
    buckets,
    pastBuckets: buckets.filter(b => !b.future),
    isAbsolute: true,
  }
}
