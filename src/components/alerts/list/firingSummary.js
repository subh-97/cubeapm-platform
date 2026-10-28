// The words above the rules (docs/alerts/DESIGN.md D2): the worst rule firing
// (Home's alert card leads with it, and the Rules tab opens its timeline for
// it), the one line the band collapses to when nothing fires, and how old the
// list is. Pure, so the sentences are tested as sentences.

import { formatLocal } from '@/utils/timeRange'
import {
  isSuppressed, formatValue, formatThreshold, formatElapsed, multipleText,
} from './adapters'

/**
 * The incident to lead with: of the firing rules nobody has snoozed or muted,
 * the worst state first (ALERT_ORDER), then the one furthest past its
 * threshold. A suppressed rule is somebody's already, and leading with it
 * would spend the space on old news; among equal states, how far past the line
 * is how bad (payment-service's 5× its error threshold over a host's 1.2× of
 * its CPU), where the list's own tie-break is the name. Null when nothing
 * unsilenced fires.
 */
export function worstFiring(rules) {
  let best = null
  for (const r of rules ?? []) {
    if (r.state !== 'firing' || isSuppressed(r)) continue
    const m = Number.isFinite(r.thresholdMultiple) ? r.thresholdMultiple : -1
    if (!best || r.rank < best.r.rank || (r.rank === best.r.rank && m > best.m)) best = { r, m }
  }
  return best?.r ?? null
}

/** The tier a firing rule crossed: the critical one when it fires critical. */
export function crossedTier(view) {
  const tiers = view?.tiers ?? {}
  if (view?.severity === 'critical' && tiers.critical) return { name: 'critical', tier: tiers.critical }
  if (tiers.warning) return { name: 'warning', tier: tiers.warning }
  if (tiers.critical) return { name: 'critical', tier: tiers.critical }
  return null
}

/**
 * The headline after a firing rule's name: "14.2% now, 4.7× its 3% critical
 * threshold, firing for 16m". The value against its threshold and how long,
 * which is what "612 ms" alone never says (CLAUDE.md rule 6).
 */
export function bannerFacts(view, nowSec) {
  const { value, threshold, firingFor } = bannerFactParts(view, nowSec)
  return [value, threshold, firingFor && `firing for ${firingFor}`].filter(Boolean).join(', ')
}

/**
 * The same facts apart, for a layout that sets them on their own line:
 * `{ value: "14.2% now", threshold: "4.7× its 3% critical threshold",
 * firingFor: "16m" }`, each null when the rule has none.
 */
export function bannerFactParts(view, nowSec) {
  const value = Number.isFinite(view?.value) ? `${formatValue(view, view.value)} now` : null
  let threshold = null
  const crossed = crossedTier(view)
  if (crossed) {
    const t = crossed.tier
    const line = formatThreshold(view, view.kind === 'anomaly' ? t.deviations : t.threshold)
    const multiple = view.kind === 'anomaly' ? null : multipleText(view)
    threshold = multiple
      ? `${multiple} its ${line} ${crossed.name} threshold`
      : `past its ${line} ${crossed.name} threshold`
  }
  const firingFor = view?.since != null ? `${formatElapsed(nowSec - view.since)}${view.sinceOpen ? '+' : ''}` : null
  return { value, threshold, firingFor }
}

/** When the last firing stretch in the range ended, in unix seconds, or null. */
export function lastResolvedAt(timeline) {
  let last = null
  for (const entry of timeline ?? []) {
    for (const i of entry.intervals ?? []) {
      if (i.state === 'firing' && i.end != null && (last == null || i.end > last)) last = i.end
    }
  }
  return last
}

// "the last 1 hour", "today", "the selected range": the range in the middle of a sentence.
function rangeWords(win) {
  if (!win || win.isAbsolute || !win.label) return 'the selected range'
  if (/^Last /.test(win.label)) return `the ${win.label.toLowerCase()}`
  return win.label.toLowerCase()
}

/**
 * The band's one line when nothing is firing (D2): "Nothing firing · last
 * alert resolved 3h ago". It still owns up to rules that fire under a snooze
 * or a mute, since nobody is being told about those.
 */
export function quietLine({ rules, timeline, win }) {
  const nowSec = win?.nowSec ?? Math.floor(Date.now() / 1000)
  const parts = ['Nothing firing']
  const held = (rules ?? []).filter(r => r.state === 'firing' && isSuppressed(r)).length
  if (held) parts.push(`${held} more firing under a snooze or mute`)
  const last = lastResolvedAt(timeline)
  if (last != null) {
    const ago = nowSec - last
    parts.push(ago < 60 ? 'last alert resolved just now' : `last alert resolved ${formatElapsed(ago)} ago`)
  } else {
    parts.push(`no alert fired in ${rangeWords(win)}`)
  }
  return parts.join(' · ')
}

/**
 * How old the alerts are: "Updated just now" for the whole first minute, then
 * "Updated 3m ago". Seconds would only count up under a refresh that is due.
 */
export function updatedText(updatedAtSec, nowMs = Date.now()) {
  if (!Number.isFinite(updatedAtSec)) return null
  const ago = Math.max(0, Math.round(nowMs / 1000 - updatedAtSec))
  return ago < 60 ? 'Updated just now' : `Updated ${formatElapsed(ago)} ago`
}

/**
 * The one line a failed refresh shows (R43): "Couldn't refresh, showing data
 * from 15:02". One line however many polls fail, and the last good data stays.
 */
export function staleText(stale) {
  if (!stale) return null
  const at = Number.isFinite(stale.since) ? formatLocal(stale.since * 1000, 'HH:mm') : null
  return at ? `Couldn't refresh, showing data from ${at}` : 'Couldn\'t refresh, showing the last data received'
}
