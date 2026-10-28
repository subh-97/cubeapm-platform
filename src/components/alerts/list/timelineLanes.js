// The alert timeline's lanes, without drawing them (docs/alerts/DESIGN.md D4).
// Production stacks a 0/1 count per rule into an area chart, which says how
// many but not which, when, or together with what. Here every rule that fired
// or pended in the range gets a lane, and a rule firing on several series gets
// one per series.
//
// Every time is unix seconds, as the alert model's are; positions are
// fractions of the window, so the drawing needs no measurement to lay out.

import { ALERT_STATE_LABELS, alertStateKey } from '@/utils/status'
import { formatLocal } from '@/utils/timeRange'
import { formatValue, formatElapsed, displayName } from './adapters'

/** Lanes shown before "Show N more": a lane is a rule, and five keep the rules list in view. */
export const LANE_CAP = 5

/**
 * Intervals cut to the window. An ongoing one (`end: null`) runs to now, or to
 * the window's end if that comes first, and keeps saying it is ongoing.
 */
export function clipIntervals(intervals, win) {
  const until = Math.min(win.end, win.nowSec ?? win.end)
  const out = []
  for (const i of intervals ?? []) {
    const start = Math.max(i.start, win.start)
    const end = Math.min(i.end ?? until, win.end)
    if (end > start) out.push({ ...i, start, end, ongoing: i.end == null || i.end > win.end })
  }
  return out
}

/** Where an instant sits across the window, 0 to 100. */
export function xPct(sec, win) {
  const span = win.end - win.start
  if (!(span > 0)) return 0
  return Math.max(0, Math.min(100, ((sec - win.start) / span) * 100))
}

/** The instant at a fraction (0–1) of the way across the window. */
export function secAt(fraction, win) {
  return win.start + Math.max(0, Math.min(1, fraction)) * (win.end - win.start)
}

// A bar's severity rank: firing critical, firing warning, then pending.
const barRank = bar => (bar.state === 'firing' ? (bar.severity === 'critical' ? 0 : 1) : 2)
const LANE_WORST = ['critical', 'warning', 'pending']

// Production's reserved labels name the rule, not the series.
const RESERVED = new Set(['alertname', 'alertgroup', 'group', 'rule_id', 'query', 'severity'])

/** "POST /v1/orders" or "service=a · host=b": what tells one series lane from its siblings. */
export function seriesLabelText(labels) {
  const entries = Object.entries(labels ?? {}).filter(([k]) => !RESERVED.has(k))
  if (entries.length === 1) return String(entries[0][1])
  return entries.map(([k, v]) => `${k}=${v}`).join(' · ')
}

// Two label sets that name the same series.
function sameLabels(a, b) {
  const ka = Object.keys(a ?? {}).filter(k => !RESERVED.has(k))
  const kb = Object.keys(b ?? {}).filter(k => !RESERVED.has(k))
  return ka.length === kb.length && ka.every(k => String(a[k]) === String(b?.[k]))
}

// The alert a lane is about, as a notification's `alert_id` names it: the
// instance with the lane's labels, or a rule's only instance.
function alertIdFor(rule, labels, single) {
  const instances = rule?.instances ?? []
  const hit = labels ? instances.find(i => sameLabels(i.labels, labels)) : null
  if (hit) return hit.id ?? null
  return single && instances.length === 1 ? instances[0].id ?? null : null
}

// A lane's readings, for the peak its bars report: the rule's series with the
// lane's labels, or its only one.
function pointsFor(seriesFor, rule, labels) {
  const all = typeof seriesFor === 'function' && rule ? seriesFor(rule.id) ?? [] : []
  const s = (labels && all.find(x => sameLabels(x.labels, labels))) ?? (all.length === 1 ? all[0] : null)
  return s?.points ?? []
}

/**
 * The lanes, worst first: by the worst bar in the range (firing critical, then
 * warning, then only ever pending), then by when they started, then by name.
 *
 * `[{ key, ruleId, alertId, name, sub, rule, points, bars, suppressed,
 * notifications, worst, firstStart }]`. `rule` is the rule view (null when the
 * rule has gone), `alertId` the alert a click on the lane names, and `points`
 * the readings its bars' peaks come from (`seriesFor`, when given).
 */
export function buildLanes(timeline, byId, win, seriesFor = null) {
  const lanes = []
  for (const entry of timeline ?? []) {
    const rule = (typeof byId === 'function' ? byId(entry.ruleId) : null) ?? null
    const name = rule ? displayName(rule) : entry.name ?? String(entry.ruleId)
    const series = entry.series ?? []
    const sources = series.length > 1
      ? series.map(s => ({ key: `${entry.ruleId}::${s.key}`, labels: s.labels, sub: seriesLabelText(s.labels), intervals: s.intervals }))
      : [{ key: String(entry.ruleId), labels: series[0]?.labels ?? null, sub: '', intervals: entry.intervals }]
    // Suppression and notifications belong to the rule, so a series lane
    // carries its rule's: a snooze holds every series alike.
    const suppressed = clipIntervals(entry.suppressed, win)
    const notifications = (entry.notifications ?? []).filter(t => t >= win.start && t <= win.end)
    for (const src of sources) {
      const bars = clipIntervals(src.intervals, win).filter(b => b.state === 'firing' || b.state === 'pending')
      if (!bars.length) continue
      const worst = LANE_WORST[Math.min(...bars.map(barRank))]
      lanes.push({
        key: src.key,
        ruleId: entry.ruleId,
        alertId: alertIdFor(rule, src.labels, sources.length === 1),
        name,
        sub: src.sub,
        rule,
        points: pointsFor(seriesFor, rule, src.labels),
        bars,
        suppressed,
        notifications,
        worst,
        firstStart: Math.min(...bars.map(b => b.start)),
      })
    }
  }
  return lanes.sort((a, b) => LANE_WORST.indexOf(a.worst) - LANE_WORST.indexOf(b.worst)
    || a.firstStart - b.firstStart
    || a.name.localeCompare(b.name)
    || a.sub.localeCompare(b.sub))
}

/**
 * The timeline head's summary: the range in short ("Last 1 hr", "Last 15
 * min"; days, Today and an absolute range as they are), then how many lanes
 * reached critical and how many warning at worst. A lane that only pended
 * counts in neither.
 */
export function timelineSummary(lanes, win) {
  const range = String(win?.label ?? '')
    .replace(/\b(\d+) hours?\b/, '$1 hr')
    .replace(/\b(\d+) minutes?\b/, '$1 min')
  const critical = lanes.filter(l => l.worst === 'critical').length
  const warning = lanes.filter(l => l.worst === 'warning').length
  return `${range} · ${critical} critical · ${warning} warning`
}

/** A bar's state word: "Critical", "Warning", "Pending". */
export function barLabel(bar) {
  return ALERT_STATE_LABELS[alertStateKey(bar.state, bar.severity)] ?? bar.state
}

/** The highest reading a rule's series reached inside a stretch, or null. */
export function peakIn(series, start, end) {
  let peak = null
  for (const p of series ?? []) {
    if (p?.t == null || p.t < start || p.t > end || !Number.isFinite(p.value)) continue
    if (peak == null || p.value > peak) peak = p.value
  }
  return peak
}

/** A clock time on the window's terms: with the date when the window crosses one. */
export function clockAt(sec, win) {
  return formatLocal(sec * 1000, win?.crossesDay || win?.isAbsolute ? 'MMM DD HH:mm' : 'HH:mm')
}

/**
 * What a bar says on hover and to a screen reader, its word first
 * ("Status: Critical", D17): "Status: Critical · 15:18–now · 16m · peak 14.2%".
 */
export function barTitle(bar, lane, win) {
  const end = bar.ongoing ? 'now' : clockAt(bar.end, win)
  const peak = lane?.rule ? peakIn(lane.points, bar.start, bar.end) : null
  return [
    `Status: ${barLabel(bar)}`,
    `${clockAt(bar.start, win)}–${end}`,
    formatElapsed(bar.end - bar.start),
    peak != null ? `peak ${formatValue(lane.rule, peak)}` : null,
  ].filter(Boolean).join(' · ')
}

/** What a suppressed stretch says: "Snoozed 15:20–now". */
export function suppressedTitle(stretch, win) {
  const word = stretch.kind === 'mute' ? 'Muted' : 'Snoozed'
  return `${word} ${clockAt(stretch.start, win)}–${stretch.ongoing ? 'now' : clockAt(stretch.end, win)}: notifications held`
}

/**
 * The range a bar's click focuses on: the bar, with a little either side. Null
 * when that is most of the window already: focusing would only swap a live
 * "Last 1 hour" for a fixed range that no longer moves.
 */
export function focusRangeFor(bar, win) {
  const pad = Math.max(60, Math.round((bar.end - bar.start) * 0.25))
  const start = Math.max(win.start, bar.start - pad)
  const end = Math.min(win.nowSec ?? win.end, bar.end + pad)
  return end - start >= (win.end - win.start) * 0.8 ? null : { start, end }
}
