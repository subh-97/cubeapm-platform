// How a rule's parts read in its row and its expanded panel (docs/alerts/
// DESIGN.md D3): who it tells, its value against its threshold and against
// the start of the range, its scope, and who manages it. Pure, so the words
// are tested as words.

import { Mail, MessageSquare, MessagesSquare, Send, Siren, Slack, Ticket, Users, Webhook } from 'lucide-react'
import { statusForAlertState, STATUS } from '@/utils/status'
import { RECEIVER_TYPES } from '@/utils/alerts/catalog'
import { formatDelta } from '@/utils/explore/format'
import { alertsSearch } from '@/utils/alertsUrl'
import { formatValue, formatThreshold, formatElapsed, multipleText } from './adapters'

/** An integration's icon, so a contact point reads as icon + name (D3, D9). */
export const INTEGRATION_ICONS = {
  email: Mail, slack: Slack, pagerduty: Siren, jira: Ticket, opsgenie: Users,
  googlechat: MessageSquare, msTeamsV2: MessagesSquare, webhook: Webhook,
}
export const integrationIcon = type => INTEGRATION_ICONS[type] ?? Send

const RECEIVER_LABEL = Object.fromEntries(RECEIVER_TYPES.map(r => [r.type, r.label]))
const receiverLabel = r => r?.label ?? RECEIVER_LABEL[r?.type] ?? r?.type ?? 'Destination'

/** "Slack #payments-oncall", "Email oncall@cubedemo.example": one destination. */
export function receiverText(r) {
  if (!r) return ''
  return r.target ? `${receiverLabel(r)} ${r.target}` : receiverLabel(r)
}

/** A contact point's destinations: the rule's receivers that came from it. */
export const receiversOf = (view, cp) => (view?.receivers ?? []).filter(r => r.groupId != null && String(r.groupId) === String(cp?.id))

/** The destinations a rule sends to directly rather than through a contact point. */
export const oneOffReceivers = view => (view?.receivers ?? []).filter(r => r.oneOff)

/**
 * Who a rule tells, for the row: the first destination's icon and the contact
 * points by name, or a one-off destination by its integration. `title` spells
 * out every destination, which the row has no room for.
 */
export function notifiesSummary(view) {
  const cps = (view?.contactPoints ?? []).filter(c => c?.name)
  const oneOff = oneOffReceivers(view)
  const names = [...cps.map(c => c.name), ...oneOff.map(receiverText)]
  if (!names.length) return { type: null, text: 'Nobody', title: 'This rule notifies nobody', none: true }
  const first = (cps[0] && receiversOf(view, cps[0])[0]) ?? oneOff[0] ?? view?.receivers?.[0]
  const detail = [
    ...cps.map(c => `${c.name} (${receiversOf(view, c).map(receiverText).join(', ') || 'no destinations'})`),
    ...oneOff.map(r => `${receiverText(r)} (one-off)`),
  ]
  const text = names.length > 1 ? `${names[0]} +${names.length - 1}` : names[0]
  return { type: first?.type ?? null, text, title: `Notifies ${detail.join('; ')}`, none: false }
}

/** The tier a severity names: the critical tier for critical, the warning tier otherwise. */
export function tierFor(view, severity) {
  const tiers = view?.tiers ?? {}
  if (severity === 'critical' && tiers.critical) return { name: 'critical', tier: tiers.critical }
  if (tiers.warning) return { name: 'warning', tier: tiers.warning }
  if (tiers.critical) return { name: 'critical', tier: tiers.critical }
  return null
}

const SYMBOL = { '>': '>', '<': '<', '>=': '≥', '<=': '≤', '==': '=', '!=': '≠', '<>': 'outside' }

/** "> 3%", "outside 3σ": a tier's condition in the rule's unit. */
export function tierCondition(view, entry) {
  if (!entry) return null
  const t = entry.tier
  const amount = formatThreshold(view, view.kind === 'anomaly' ? t.deviations : t.threshold)
  return `${SYMBOL[t.op] ?? t.op} ${amount}`
}

/** Whether a tier fires on a low reading: its multiple then reads as "under". */
export const lowerIsWorse = tier => tier?.op === '<' || tier?.op === '<='

/** The tone a value is drawn in: a firing or pending rule's state; anything else plain. */
export function valueTone(state, severity) {
  const tone = statusForAlertState(state, severity)
  return tone === STATUS.critical || tone === STATUS.warning || tone === STATUS.info ? tone : ''
}

/**
 * The value against its threshold, for a rule past one (firing or pending):
 * `{ text: '4.8×', title: '4.8× the 3% critical threshold' }`. A rule that is
 * not past a threshold has no multiple worth showing.
 */
export function multipleFor(view) {
  if (view?.state !== 'firing' && view?.state !== 'pending') return null
  const text = multipleText(view)
  if (!text) return null
  const entry = tierFor(view, view.severity ?? view.instances?.[0]?.severity)
  if (!entry || view.kind === 'anomaly') return { text, title: `${text} its threshold` }
  const threshold = formatThreshold(view, entry.tier.threshold)
  return { text, title: `${text} ${lowerIsWorse(entry.tier) ? 'under' : 'over'} the ${threshold} ${entry.name} threshold` }
}

// Two label sets naming the same series.
function sameLabels(a, b) {
  const ka = Object.keys(a ?? {})
  const kb = Object.keys(b ?? {})
  return ka.length === kb.length && ka.every(k => String(a[k]) === String(b?.[k]))
}

const firstValue = points => points.find(p => Number.isFinite(p?.value))?.value ?? null
const lastValue = points => {
  for (let i = points.length - 1; i >= 0; i--) if (Number.isFinite(points[i]?.value)) return points[i].value
  return null
}

/**
 * One series of a rule over the range: the one with `labels`, or the rule's
 * worst alert's, or its only one. `{ points, previous, last }`: the readings,
 * the reading one window-length back (the model's `previous` when it carries
 * one, else the window's first reading, which is that same instant), and the
 * latest reading.
 */
export function seriesTrend(view, seriesFor, labels = null) {
  const all = (typeof seriesFor === 'function' ? seriesFor(view?.id) : null) ?? view?.series ?? []
  // A fixture may hand a bare list of points rather than series.
  if (all.length && all[0]?.points == null && 't' in all[0]) {
    return { points: all, previous: view?.previousValue ?? firstValue(all), last: lastValue(all) }
  }
  const want = labels ?? view?.instances?.[0]?.labels ?? null
  const s = (want && all.find(x => sameLabels(x.labels, want))) ?? (all.length === 1 ? all[0] : null) ?? all[0] ?? null
  const points = (s?.points ?? []).filter(p => p && p.value != null)
  return {
    points,
    previous: Number.isFinite(s?.previous) ? s.previous : firstValue(points),
    last: lastValue(points),
  }
}

/** "an hour ago", "7d ago": how far back the start of a window is. */
export function windowAgo(win) {
  const span = win?.spanSec ?? 0
  if (span === 3600) return 'an hour ago'
  return `${formatElapsed(span)} ago`
}

/**
 * The comparison chip (CLAUDE.md rule 6): the value now against the same
 * reading one window-length back. `{ label, dir, title }`, or null with
 * nothing to compare.
 */
export function deltaFor(view, value, previous, agoText) {
  if (!Number.isFinite(value) || !Number.isFinite(previous)) return null
  const d = formatDelta(value, previous)
  if (d.dir === 'none') return null
  const label = d.dir === 'new' ? 'New' : d.text
  return { label, dir: d.dir, title: `${formatValue(view, value)} now vs ${formatValue(view, previous)} ${agoText}` }
}

/** The service, endpoint and host a rule is about, as chips. */
export function scopeChips(view) {
  const s = view?.scope ?? {}
  return [
    s.service && { key: 'service', label: 'Service', value: s.service },
    s.endpoint && { key: 'endpoint', label: 'Endpoint', value: s.endpoint },
    s.host && { key: 'host', label: 'Host', value: s.host },
  ].filter(Boolean)
}

/**
 * Who else owns a rule (D18): "From monitor Docs", "From the SLO for
 * payment-service POST /v1/payments". Null for an ordinary rule.
 */
export function managedText(view) {
  const m = view?.managedBy
  if (!m) return null
  if (m.kind === 'synthetic') return m.monitorName || m.monitorId != null ? `From monitor ${m.monitorName ?? m.monitorId}` : 'From a synthetic monitor'
  if (m.kind === 'slo') {
    const what = [m.service, m.endpoint].filter(Boolean).join(' ')
    return what ? `From the SLO for ${what}` : 'From an SLO'
  }
  return null
}

// Production's reserved labels name the rule, not the series.
const RESERVED = new Set(['alertname', 'alertgroup', 'group', 'rule_id', 'query'])

/**
 * The labels that tell an alert apart: not the reserved ones, not the rule's
 * own tags, and not a `severity` the rule already says (production's rule, §3).
 */
export function instanceLabels(view, instance) {
  const tags = view?.tags ?? {}
  return Object.entries(instance?.labels ?? {})
    .filter(([k, v]) => v != null && v !== '' && !RESERVED.has(k) && tags[k] !== v && !(k === 'severity' && tags.severity))
    .map(([k, v]) => ({ key: k, value: String(v) }))
}

/** The Notifications tab filtered to a rule, as production's history link writes it. */
export const historyHref = ruleId => `/alerts${alertsSearch({ tab: 'alert-logs', ruleId })}`

/** "12s ago", or that it never has been. */
export function lastEvaluatedText(view, nowSec) {
  if (!Number.isFinite(view?.lastEvaluation)) return 'Never evaluated'
  const ago = Math.max(0, nowSec - view.lastEvaluation)
  return ago < 5 ? 'Just now' : `${formatElapsed(ago)} ago`
}

/**
 * Every snooze on a rule, active and scheduled, each with its own chip and
 * Unsnooze (D10): the model's `snoozes`, or the one in force.
 */
export function snoozesOf(view) {
  if (Array.isArray(view?.snoozes)) return view.snoozes.map(s => ({ kind: 'snooze', ...s }))
  return view?.suppression?.kind === 'snooze' ? [view.suppression] : []
}
