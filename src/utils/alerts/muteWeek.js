// A mute window drawn as a week (docs/alerts/DESIGN.md D10): seven rows of
// twenty-four hours, the window shaded on the days it runs, an overnight one
// wrapping into the next morning. Production says only "Start at 21:00 · Mute
// for 10h · Everyday", which leaves the reader to work out that Saturday
// night runs into Sunday.

import { muteCovering, nextMute } from './routing'
import { muteOf } from './editorDraft'

export const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
export const WEEKDAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const DAY = 1440

/**
 * The stretches a window covers, per weekday row, in minutes of the window's
 * own day: `[{ day: 0..6 (Monday first), from, to }]`. No weekdays means every
 * day, as production's help says; a window longer than a day carries on
 * through the next rows, and nothing runs past a week.
 */
export function weekSegments(w) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(w?.start ?? '')
  const length = Math.min(7 * DAY, (Number(w?.hours) || 0) * 60 + (Number(w?.minutes) || 0))
  if (!m || !(length > 0)) return []
  const start = Number(m[1]) * 60 + Number(m[2])
  const days = w.weekdays?.length ? WEEKDAYS.map((d, i) => (w.weekdays.includes(d) ? i : -1)).filter(i => i >= 0) : WEEKDAYS.map((_, i) => i)
  const out = []
  for (const first of days) {
    let left = length
    let day = first
    let from = start
    while (left > 0) {
      const to = Math.min(DAY, from + left)
      out.push({ day, from, to })
      left -= to - from
      day = (day + 1) % 7
      from = 0
    }
  }
  return out
}

/**
 * Whether the window holds now, and until when, or when it next opens:
 * `{ active: true, end }` or `{ active: false, start }` in unix seconds, or
 * null when it never opens. Read in the window's own timezone, through the
 * same routing maths the notification log uses.
 */
export function muteWindowState(w, nowSec) {
  const interval = muteOf([w]).time_intervals[0]
  const now = muteCovering(interval, nowSec)
  if (now) return { active: true, end: now.end }
  const next = nextMute(interval, nowSec)
  return next ? { active: false, start: next.start } : null
}
