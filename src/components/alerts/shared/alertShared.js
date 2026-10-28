// The pure half of the shared alert controls: what the Snooze and Actions menus
// offer for a given rule, what a custom snooze resolves to, and how a snooze or
// a mute reads on a chip. Kept apart from the components so the rules (an SLO
// rule cannot be paused, a custom snooze needs a duration) are tested without
// rendering anything. Every time here is in unix seconds, as the alert model's
// are (docs/alerts/DESIGN.md D15).

import { formatLocal } from '@/utils/timeRange'
import { SNOOZE_PRESETS as PRESET_MINUTES } from '@/utils/alerts/catalog'
import { durationWords, formatDuration, formatElapsed } from '@/utils/alerts/describe'

/**
 * Production's snooze presets (the catalog's list, verbatim: DESIGN "What
 * stays exactly as production has it"). The menu text is production's spelling,
 * "5m"; the accessible name says the whole thing, because "5m" read aloud is not
 * an instruction.
 */
export const SNOOZE_PRESETS = PRESET_MINUTES.map(min => ({
  id: formatDuration(min * 60),
  minutes: min,
  spoken: durationWords(min * 60),
}))

// A clock time, with the date only when it is not the same day as now: a mute
// that ends at 07:00 tomorrow should say so, one ending this afternoon should not.
function clock(sec, nowSec) {
  const ms = sec * 1000
  const sameDay = new Date(ms).toDateString() === new Date(nowSec * 1000).toDateString()
  return formatLocal(ms, sameDay ? 'HH:mm' : 'MMM DD HH:mm')
}

/**
 * What a suppression chip says, and its fuller hover text. A snooze that has
 * not started yet (production's "pending" silence) is scheduled, not active, so
 * it names when it starts rather than how long is left. Who snoozed it and why
 * travel in the title — production records neither (DESIGN D10).
 */
export function suppressionText(suppression, nowSec) {
  if (!suppression) return null
  if (suppression.kind === 'snooze') {
    const by = suppression.createdBy ? ` by ${suppression.createdBy}` : ''
    const why = suppression.comment ? `: ${suppression.comment}` : ''
    if (suppression.scheduled || suppression.startsAt > nowSec) {
      return {
        text: `Snooze from ${clock(suppression.startsAt, nowSec)}`,
        title: `Snooze scheduled ${clock(suppression.startsAt, nowSec)}–${clock(suppression.endsAt, nowSec)}${by}${why}`,
      }
    }
    return {
      text: `Snoozed · ${formatElapsed(suppression.endsAt - nowSec)} left`,
      title: `Notifications snoozed until ${clock(suppression.endsAt, nowSec)}${by}${why}`,
    }
  }
  if (suppression.kind === 'mute') {
    const name = suppression.name ? `the "${suppression.name}" schedule` : 'a mute schedule'
    if (suppression.until == null) return { text: 'Muted', title: `Notifications muted by ${name}` }
    return {
      text: `Muted until ${clock(suppression.until, nowSec)}`,
      title: `Notifications muted by ${name} until ${clock(suppression.until, nowSec)}`,
    }
  }
  return null
}

/**
 * A custom snooze from the dialog's fields, in the shape the store's
 * `snooze(ruleId, …)` takes, or null while it is not a snooze yet. The start is
 * floored to the minute, as production floors its presets; a start in the past
 * is allowed (production allows it too) and simply ends sooner.
 */
export function customSnoozeSpec({ startSec, hours = 0, minutes = 0, comment = '' }) {
  const h = Number(hours)
  const m = Number(minutes)
  if (!Number.isFinite(startSec) || !Number.isFinite(h) || !Number.isFinite(m)) return null
  if (h < 0 || m < 0) return null
  const durMin = Math.round(h * 60 + m)
  if (durMin <= 0) return null
  const start = Math.floor(startSec / 60) * 60
  return { start, end: start + durMin * 60, comment: String(comment ?? '').trim() }
}

/**
 * The Actions menu for one rule. Every item is a word, never only an icon
 * (CLAUDE.md rule 4); an item the rule does not allow stays in the list,
 * disabled, with the reason as its title, rather than vanishing.
 *
 * An SLO burn-rate rule is configured by its SLO, so pausing, editing, cloning
 * or deleting it here would contradict the SLO's own switch: it keeps its
 * history and its link, and "Edit in SLO" waits for that page (DESIGN D18). A
 * read-only rule (production's `readonly`, loaded from a config file) can be
 * read and cloned, not changed.
 */
export function ruleActionItems(rule) {
  if (!rule) return []
  if (rule.managedBy?.kind === 'slo') {
    return [
      { id: 'history', label: 'Notification history', icon: 'history' },
      { id: 'copyLink', label: 'Copy link', icon: 'link' },
      { sep: true },
      { id: 'editInSlo', label: 'Edit in SLO', icon: 'external', disabled: true, title: 'The SLO page comes later' },
    ]
  }
  const locked = rule.readonly ? 'This rule is read-only' : null
  return [
    rule.status === 'PAUSED'
      ? { id: 'resume', label: 'Resume rule', icon: 'play', disabled: !!locked, title: locked }
      : { id: 'pause', label: 'Pause rule', icon: 'pause', disabled: !!locked, title: locked },
    { id: 'edit', label: 'Edit rule', icon: 'edit', disabled: !!locked, title: locked },
    { id: 'clone', label: 'Clone rule', icon: 'copy' },
    { id: 'history', label: 'Notification history', icon: 'history' },
    { id: 'copyLink', label: 'Copy link', icon: 'link' },
    { sep: true },
    { id: 'delete', label: 'Delete rule…', icon: 'trash', danger: true, disabled: !!locked, title: locked },
  ]
}

/**
 * Whether a rule can be snoozed from here. Snooze holds notifications rather
 * than changing the rule, so an SLO rule can be snoozed although it is
 * read-only everywhere else (DESIGN D18): the SLO owns its configuration, not
 * who gets told. Any other read-only rule cannot, and a paused rule has nothing
 * to hold.
 */
export function snoozeBlockedReason(rule) {
  if (!rule) return 'No rule'
  if (rule.status === 'PAUSED') return 'A paused rule sends nothing to snooze'
  if (rule.managedBy?.kind === 'slo') return null
  if (rule.readonly) return 'This rule is read-only'
  return null
}

/** The next enabled item index from `from`, stepping `dir`, wrapping, skipping separators. */
export function nextMenuIndex(items, from, dir) {
  const n = items.length
  if (n === 0) return -1
  for (let k = 1; k <= n; k++) {
    const i = (((from + dir * k) % n) + n) % n
    if (!items[i].sep && !items[i].disabled) return i
  }
  return -1
}

/**
 * The keys of a seg-toggle radio group (the WAI-ARIA radio pattern, 7c): the
 * arrows move to the next option and choose it, Home and End to the ends,
 * skipping an option that is unavailable. Put it on the `role="radiogroup"`
 * element; each `role="radio"` button takes `tabIndex={checked ? 0 : -1}`, so
 * the group is one Tab stop.
 */
export function radioGroupKeyDown(e) {
  const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key]
  if (step == null && e.key !== 'Home' && e.key !== 'End') return
  const radios = [...e.currentTarget.querySelectorAll('[role="radio"]')]
    .filter(r => r.getAttribute('aria-disabled') !== 'true' && !r.disabled)
  const at = radios.indexOf(document.activeElement)
  if (at < 0 || !radios.length) return
  const to = e.key === 'Home' ? 0 : e.key === 'End' ? radios.length - 1 : (at + step + radios.length) % radios.length
  e.preventDefault()
  radios[to].focus()
  if (radios[to].getAttribute('aria-checked') !== 'true') radios[to].click()
}
