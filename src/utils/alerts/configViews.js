// What the Contact points and Mute schedules tabs say about each entry
// (docs/alerts/DESIGN.md D9, D10): who uses it, whether it is delivering or
// muting right now, how it reads in words, and what a drawer still needs
// before it can save. Pure functions over the views and production's shapes,
// so both tabs and their tests read them the same way.

import { formatDuration } from './describe'
import { destinationsOf, destinationProblem, muteWindowsOf, muteWindowProblem } from './editorDraft'
import { muteWindowState, WEEKDAYS, WEEKDAY_SHORT } from './muteWeek'

const byName = (a, b) => a.name.localeCompare(b.name)

/**
 * The rules that use each contact point: `Map(id → [{ id, name }])`, by name.
 * Read off the views, which already resolve a rule's contact points.
 */
export function usageByContactPoint(views) {
  const out = new Map()
  for (const v of views ?? []) {
    for (const c of v.contactPoints ?? []) {
      if (!out.has(c.id)) out.set(c.id, [])
      out.get(c.id).push({ id: v.id, name: v.name })
    }
  }
  for (const list of out.values()) list.sort(byName)
  return out
}

/** The rules each mute schedule mutes: `Map(id → [{ id, name }])`, by name. */
export function usageBySchedule(views) {
  const out = new Map()
  for (const v of views ?? []) {
    for (const m of v.muteSchedules ?? []) {
      if (!out.has(m.id)) out.set(m.id, [])
      out.get(m.id).push({ id: v.id, name: v.name })
    }
  }
  for (const list of out.values()) list.sort(byName)
  return out
}

/**
 * A contact point's delivery health from its integrations' last sends
 * (lastDeliveries): `{ status, at, failing }` — ERROR when any integration's
 * last send failed, SUCCESS when all sent, null when nothing has been sent in
 * the horizon. `at` is the newest send.
 */
export function deliveryHealth(deliveries) {
  const list = deliveries ?? []
  if (!list.length) return { status: null, at: null, failing: [] }
  const failing = list.filter(d => d.status === 'ERROR')
  return { status: failing.length ? 'ERROR' : 'SUCCESS', at: Math.max(...list.map(d => d.at)), failing }
}

/**
 * The order the contact points list in: one whose last send failed first, so a
 * broken destination is seen before it is needed; then those in use, the
 * busiest first; then the rest, by name.
 */
export function sortContactPoints(groups, usage, health) {
  const rank = g => (health.get(g.id)?.status === 'ERROR' ? 0 : (usage.get(g.id)?.length ?? 0) ? 1 : 2)
  return [...groups].sort((a, b) => rank(a) - rank(b)
    || (usage.get(b.id)?.length ?? 0) - (usage.get(a.id)?.length ?? 0)
    || byName(a, b))
}

const dayWords = (weekdays) => {
  if (!weekdays?.length || weekdays.length === 7) return 'every day'
  const idx = WEEKDAYS.map((d, i) => (weekdays.includes(d) ? i : -1)).filter(i => i >= 0)
  if (idx.join() === '0,1,2,3,4') return 'weekdays'
  if (idx.join() === '5,6') return 'weekends'
  return idx.map(i => WEEKDAY_SHORT[i]).join(', ')
}

/**
 * A schedule's windows in words, in its own timezone, one line each: "21:00
 * for 10h, every day". Production shows "Start at 21:00 · Mute for 10h ·
 * Everyday" and leaves the reader to add them up.
 */
export function scheduleWords(group) {
  return muteWindowsOf(group?.mute).map(w => `${w.start} for ${formatDuration((w.hours * 60 + w.minutes) * 60)}, ${dayWords(w.weekdays)}`)
}

/**
 * Whether a schedule is muting at `nowSec` and until when, or when it next
 * starts, across all its windows: `{ active: true, end }`, `{ active: false,
 * start }`, or null when it never opens.
 */
export function scheduleState(group, nowSec) {
  const states = muteWindowsOf(group?.mute).filter(w => !muteWindowProblem(w)).map(w => muteWindowState(w, nowSec)).filter(Boolean)
  const active = states.filter(s => s.active)
  if (active.length) return { active: true, end: Math.max(...active.map(s => s.end)) }
  return states.length ? { active: false, start: Math.min(...states.map(s => s.start)) } : null
}

const nameProblem = (name, taken) => {
  const n = String(name ?? '').trim()
  if (!n) return 'Name it.'
  return taken.some(t => t.trim().toLowerCase() === n.toLowerCase()) ? `Another one is already called "${n}".` : null
}

/**
 * What a contact point's drawer still needs before it can save, each with the
 * field it belongs to, as the rule editor reports them: `[{ field, message }]`.
 * `others` are the names of the other contact points.
 */
export function contactPointIssues({ name, destinations }, others = []) {
  const out = []
  const n = nameProblem(name, others)
  if (n) out.push({ field: 'name', message: n })
  if (!destinations?.length) out.push({ field: 'destinations', message: 'Add at least one integration.' })
  destinations?.forEach((d, i) => {
    const p = destinationProblem(d)
    if (p) out.push({ field: `destination-${i}`, message: p })
  })
  return out
}

/** What a mute schedule's drawer still needs before it can save. */
export function scheduleIssues({ name, windows }, others = []) {
  const out = []
  const n = nameProblem(name, others)
  if (n) out.push({ field: 'name', message: n })
  if (!windows?.length) out.push({ field: 'windows', message: 'Add at least one mute window.' })
  windows?.forEach((w, i) => {
    const p = muteWindowProblem(w)
    if (p) out.push({ field: `mute-${i}`, message: p })
  })
  return out
}

/** A contact point as its drawer edits it. */
export const contactPointDraft = group => ({ name: group?.name ?? '', destinations: destinationsOf(group?.receiver) })

/** A mute schedule as its drawer edits it. */
export const scheduleDraft = group => ({ name: group?.name ?? '', windows: muteWindowsOf(group?.mute) })

/**
 * Every snooze still to come or in force, from the views, as the snooze list
 * shows them: the ones holding notifications now first, soonest to end first,
 * then the scheduled ones, soonest to start first.
 * `[{ rule: { id, name }, view, snooze }]`
 */
export function snoozeRows(views) {
  const rows = []
  for (const v of views ?? []) for (const s of v.snoozes ?? []) rows.push({ rule: { id: v.id, name: v.name }, view: v, snooze: s })
  return rows.sort((a, b) => (a.snooze.scheduled - b.snooze.scheduled)
    || (a.snooze.scheduled ? a.snooze.startsAt - b.snooze.startsAt : a.snooze.endsAt - b.snooze.endsAt))
}

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const dayStart = ms => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime() }
const two = n => String(n).padStart(2, '0')

/**
 * An instant as a person reads it next to now, in their own time: "today
 * 21:00", "tomorrow 07:00", "yesterday 23:40", "Sat 02:15" within the week,
 * and "Oct 24 02:15" beyond it. What "ends …" and "next: …" say.
 */
export function dayClock(sec, nowSec) {
  const d = new Date(sec * 1000)
  const clock = `${two(d.getHours())}:${two(d.getMinutes())}`
  const days = Math.round((dayStart(sec * 1000) - dayStart(nowSec * 1000)) / 86400000)
  if (days === 0) return `today ${clock}`
  if (days === 1) return `tomorrow ${clock}`
  if (days === -1) return `yesterday ${clock}`
  if (days > 1 && days < 7) return `${WEEKDAY[d.getDay()]} ${clock}`
  return `${d.toLocaleString('en-US', { month: 'short' })} ${two(d.getDate())} ${clock}`
}
