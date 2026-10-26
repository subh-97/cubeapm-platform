// What each change on the Rules tab does and how it says so (docs/alerts/
// DESIGN.md D16). Production confirms none of them; here every change is
// confirmed in a toast, and the store's actions hand back their own undo, which
// the toast offers. An action that changed nothing returns no undo, and the
// toast then says that rather than claiming a success.

import { formatLocal } from '@/utils/timeRange'
import { displayName, durationWords } from './adapters'

const clock = sec => formatLocal(sec * 1000, 'HH:mm')

/** "for 30 minutes", "until 17:30", "from 15:00 to 17:00": a snooze's span in words. */
export function snoozeSpan(spec, nowSec) {
  if (typeof spec === 'number') return `for ${durationWords(spec * 60)}`
  if (spec?.start > nowSec) return `from ${clock(spec.start)} to ${clock(spec.end)}`
  return `until ${clock(spec?.end)}`
}

/**
 * Runs one change against the store's actions and returns the toast it
 * raises: `{ text, undo }`, `undo` null when there is nothing to take back.
 *
 *   { kind: 'pause' | 'resume' | 'remove' }
 *   { kind: 'snooze', spec }         spec: minutes, or { start, end, comment } in seconds
 *   { kind: 'unsnooze', snooze }     one of the rule's snoozes
 */
export const UNAVAILABLE = 'Rules cannot be changed from here right now; nothing changed.'

export function changeRule(actions, view, change, nowSec) {
  const name = displayName(view)
  const NONE = Symbol('no action')
  const run = (fn, ...args) => (typeof fn === 'function' ? fn(...args) : NONE)
  const result = (undo, done, unchanged) => {
    if (undo === NONE) return { text: UNAVAILABLE, undo: null }
    return typeof undo === 'function' ? { text: done, undo } : { text: unchanged, undo: null }
  }

  switch (change?.kind) {
    case 'pause':
      return result(run(actions?.pause, view.id),
        `Paused ${name}. It stops evaluating until it is resumed.`,
        `${name} was already paused; nothing changed.`)
    case 'resume':
      return result(run(actions?.resume, view.id),
        `Resumed ${name}. It evaluates again from its next check.`,
        `${name} was already running; nothing changed.`)
    case 'snooze':
      return result(run(actions?.snooze, view.id, change.spec),
        `Snoozed ${name} ${snoozeSpan(change.spec, nowSec)}. It keeps evaluating; its notifications are held.`,
        `${name} could not be snoozed; nothing changed.`)
    case 'unsnooze': {
      const s = change.snooze
      const scheduled = s?.scheduled || s?.startsAt > nowSec
      return result(run(actions?.unsnooze, s?.silenceId),
        scheduled ? `Cancelled the snooze planned for ${name}.` : `Unsnoozed ${name}. Its notifications are back on.`,
        'That snooze had already ended; nothing changed.')
    }
    case 'remove':
      return result(run(actions?.remove, view.id),
        `Deleted ${name}. Its notification history is kept.`,
        `${name} could not be deleted here; nothing changed.`)
    default:
      return { text: null, undo: null }
  }
}
