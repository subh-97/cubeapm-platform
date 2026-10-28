// Where a rule's notifications go, and when they are held back
// (docs/alerts/DESIGN.md D9, D10). Pure functions over production's shapes:
//
//   receiver group  { id, name, receiver: { email_configs: [...], slack_configs: [...], … } }
//   rule            { config: { receiver_group_ids, mute_group_ids }, receiver, mute: { time_intervals } }
//   mute group      { id, name, mute: { time_intervals: [{ times: [{ start_time, duration_minutes }], weekdays, location }] } }
//   silence         { id, matchers: [{ name, value, isEqual, isRegex }], startsAt, endsAt, createdBy, comment }
//
// Shared by the data module (which writes the notification log from them) and
// the view model (which shows them), so both read routing the same way.

import { receiverTypeOf } from './catalog.js'

/**
 * Every destination a rule notifies: its contact points' receivers, then its
 * own one-off ones. Production's "Custom" inline receivers are `oneOff`.
 */
export function effectiveReceivers(rule, receiverGroups = []) {
  const out = []
  const push = (receiver, extra) => {
    for (const [configs, list] of Object.entries(receiver ?? {})) {
      if (!Array.isArray(list)) continue
      for (const data of list) out.push({ type: receiverTypeOf(configs)?.type ?? configs, configs, data, ...extra })
    }
  }
  for (const id of rule?.config?.receiver_group_ids ?? []) {
    const group = receiverGroups.find(g => g.id === id)
    if (group) push(group.receiver, { groupId: group.id, groupName: group.name, oneOff: false })
  }
  push(rule?.receiver, { groupId: null, groupName: null, oneOff: true })
  return out
}

/** The contact points a rule uses, by id and name, in its own order. */
export function ruleContactPoints(rule, receiverGroups = []) {
  return (rule?.config?.receiver_group_ids ?? [])
    .map(id => receiverGroups.find(g => g.id === id))
    .filter(Boolean)
    .map(g => ({ id: g.id, name: g.name }))
}

const hostOf = url => {
  try {
    const u = new URL(url)
    return u.host
  } catch {
    return String(url ?? '')
  }
}

/**
 * One receiver, said briefly: `{ label, target }` — "Slack" / "#payments-oncall",
 * "Email" / "2 recipients", "Webhook" / "hooks.internal.cubedemo.example".
 * `lookups` turns ids into names: Slack channels, Opsgenie teams.
 */
export function receiverSummary(r, lookups = {}) {
  const d = r?.data ?? {}
  const label = receiverTypeOf(r?.configs)?.label ?? r?.type ?? 'Receiver'
  switch (r?.type) {
    case 'email': {
      const to = String(d.to ?? '').split(',').map(s => s.trim()).filter(Boolean)
      return { label, target: to.length === 1 ? to[0] : `${to.length} recipients`, full: to.join(', ') }
    }
    case 'slack': {
      const ch = lookups.slackChannels?.find(c => c.id === d.channel)
      return { label, target: ch ? `#${ch.name}` : String(d.channel ?? ''), full: ch ? `#${ch.name}` : String(d.channel ?? '') }
    }
    case 'pagerduty': return { label, target: d.service_name ?? 'PagerDuty service', full: d.service_name ?? '' }
    case 'jira': return { label, target: [d.project, d.issue_type].filter(Boolean).join(' · '), full: [d.project, d.issue_type].filter(Boolean).join(' · ') }
    case 'opsgenie': {
      const team = lookups.opsgenieTeams?.find(t => t.api_key === d.api_key)
      return { label, target: team?.team ?? 'Opsgenie team', full: team?.team ?? '' }
    }
    case 'googlechat': return { label, target: hostOf(d.url), full: d.url ?? '' }
    case 'msTeamsV2': return { label, target: hostOf(d.webhook_url), full: d.webhook_url ?? '' }
    case 'webhook': return { label, target: hostOf(d.url), full: d.url ?? '' }
    default: return { label, target: '', full: '' }
  }
}

/** Whether a receiver also sends when the alert resolves (production defaults it on). */
export const sendsResolved = r => r?.data?.send_resolved !== false

/**
 * The mute windows that apply to a rule: its mute schedules' intervals, then
 * its own. Each carries where it came from, `{ interval, scheduleId, name }`.
 */
export function ruleMuteIntervals(rule, muteGroups = []) {
  const out = []
  for (const id of rule?.config?.mute_group_ids ?? []) {
    const group = muteGroups.find(g => g.id === id)
    for (const interval of group?.mute?.time_intervals ?? []) out.push({ interval, scheduleId: group.id, name: group.name })
  }
  for (const interval of rule?.mute?.time_intervals ?? []) out.push({ interval, scheduleId: null, name: null })
  return out
}

/** A silence's bounds in unix seconds. */
export const silenceBounds = s => ({ start: Math.floor(Date.parse(s.startsAt) / 1000), end: Math.floor(Date.parse(s.endsAt) / 1000) })

/**
 * Whether a silence snoozes this rule. Production's snooze is one matcher,
 * `rule_id = <id>`; any equality matcher on rule_id counts.
 */
export const silenceMatchesRule = (s, rule) => (s?.matchers ?? [])
  .some(m => m.name === 'rule_id' && m.isEqual !== false && !m.isRegex && String(m.value) === String(rule?.id))

/** The silences on a rule, oldest first, with bounds and their state at `nowSec`. */
export function ruleSilences(rule, silences = [], nowSec) {
  return silences
    .filter(s => silenceMatchesRule(s, rule))
    .map(s => {
      const { start, end } = silenceBounds(s)
      return { silence: s, start, end, state: end <= nowSec ? 'expired' : start > nowSec ? 'pending' : 'active' }
    })
    .sort((a, b) => a.start - b.start)
}

// ---------- mute windows in their own time zone ----------

const formatters = new Map()
function zoneFormatter(tz) {
  if (!formatters.has(tz)) {
    let f = null
    try {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hourCycle: 'h23',
        year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
      })
    } catch {
      f = null // an unknown zone falls back to UTC rather than throwing mid-render
    }
    formatters.set(tz, f)
  }
  return formatters.get(tz) ?? formatters.get('UTC') ?? zoneFormatter('UTC')
}

// The wall-clock reading of instant `t` in `tz`, written as if it were UTC —
// so its difference from `t` is the zone's offset at that instant.
function wallClock(t, tz) {
  const p = {}
  for (const part of zoneFormatter(tz).formatToParts(new Date(t * 1000))) p[part.type] = part.value
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second)) / 1000
}

// The instant a wall-clock time in `tz` names. Two passes, so a window that
// opens just after a daylight-saving change lands on the right side of it.
function instantOf(wall, tz) {
  const first = wall - (wallClock(wall, tz) - wall)
  return wall - (wallClock(first, tz) - first)
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

function mergeStretches(list) {
  const sorted = [...list].sort((a, b) => a.start - b.start)
  const out = []
  for (const s of sorted) {
    const last = out[out.length - 1]
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end)
    else out.push({ ...s })
  }
  return out
}

/**
 * The stretches one mute interval covers between `from` and `to` (unix
 * seconds): every `start_time` for `duration_minutes`, on the listed weekdays
 * (none listed is every day), read in the interval's own `location`. A window
 * that crosses midnight belongs to the day it opened on, as production's
 * "Start at 21:00 · Mute for 10h" does.
 */
export function muteStretches(interval, from, to) {
  const tz = interval?.location || 'UTC'
  const times = (interval?.times ?? []).filter(t => t.duration_minutes > 0 && /^\d{1,2}:\d{2}$/.test(String(t.start_time)))
  if (!times.length || !(to > from)) return []
  const longest = Math.max(...times.map(t => t.duration_minutes))
  const firstWall = wallClock(from - longest * 60 - 86400, tz)
  const lastWall = wallClock(to, tz)
  const out = []
  for (let day = firstWall - (((firstWall % 86400) + 86400) % 86400); day <= lastWall; day += 86400) {
    const weekday = WEEKDAYS[new Date(day * 1000).getUTCDay()]
    if (interval.weekdays?.length && !interval.weekdays.includes(weekday)) continue
    for (const { start_time, duration_minutes } of times) {
      const [h, m] = String(start_time).split(':').map(Number)
      const start = instantOf(day + h * 3600 + m * 60, tz)
      const end = start + duration_minutes * 60
      if (end > from && start < to) out.push({ start, end })
    }
  }
  return mergeStretches(out)
}

/**
 * Whether a mute interval is holding notifications back at `t`, and until
 * when: `{ start, end }` of the window covering `t`, or null.
 */
export function muteCovering(interval, t) {
  return muteStretches(interval, t, t + 1).find(s => s.start <= t && t < s.end) ?? null
}

/**
 * The next window to open after `t`, within a week: `{ start, end }` or null.
 * What a schedule's "Next: today 21:00" reads.
 */
export function nextMute(interval, t) {
  return muteStretches(interval, t, t + 8 * 86400).find(s => s.start > t) ?? null
}
