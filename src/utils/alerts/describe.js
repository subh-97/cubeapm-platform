// A rule in words (docs/alerts/DESIGN.md D3, D6). Production describes a rule
// by printing its PromQL; the list here says "Error % > 3% critical, > 1%
// warning, for 5m", and the editor and the rule page say the whole rule as one
// sentence. Everything reads a rule VIEW (utils/alerts/model.js `ruleView`):
//
//   { metric, unit, kind, scope: {service, endpoint, host}, tiers: {warning, critical},
//     forSec, intervalSec, repeatSec, contactPoints: [{name}], receivers: [...],
//     state, severity, since, value, thresholdMultiple }
//
// Durations in settings are written production's way ("30s", "5m", "1h30m");
// elapsed time the way people say it ("13m", "2h 5m", "3d 4h").

import { templateDisplay } from './template.js'

/**
 * A rule's name as lists and its page title show it: a templated name with
 * each action replaced by the label it reads ("CPU high on ‹host.name›"),
 * since a rule with several series has no one name. Plain names are unchanged.
 */
export const displayName = view => templateDisplay(view?.name ?? '')

const UNIT_SUFFIX = { '%': '%', ms: ' ms', rpm: ' rpm', MB: ' MB', s: ' s', x: '×', count: '', deviations: 'σ', '/min': '/min' }

/** A number at the precision its size deserves: 612, 14.2, 1.25, 0.3, 0.061. */
export function formatNumber(v) {
  if (v == null || !Number.isFinite(v)) return '—'
  const a = Math.abs(v)
  const digits = a >= 100 ? 0 : a >= 10 ? 1 : a >= 1 ? 2 : a === 0 ? 0 : Math.min(4, 1 - Math.floor(Math.log10(a)))
  return Number(v.toFixed(digits)).toLocaleString('en-US', { maximumFractionDigits: digits })
}

/** A reading in its rule's unit: "14.2%", "612 ms", "452.7 rpm", "1,054 MB". */
export function formatValue(view, v) {
  if (v == null || !Number.isFinite(v)) return '—'
  return `${formatNumber(v)}${UNIT_SUFFIX[view?.unit] ?? ''}`
}

/** A threshold in its rule's unit; anomaly thresholds are deviations ("3σ"). */
export function formatThreshold(view, t) {
  if (t == null || !Number.isFinite(t)) return '—'
  return view?.kind === 'anomaly' ? `${formatNumber(t)}σ` : formatValue(view, t)
}

/** A setting's duration, production's way: "30s", "5m", "1h30m", "24h". */
export function formatDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0))
  if (s === 0) return '0s'
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  return `${h ? `${h}h` : ''}${m ? `${m}m` : ''}${r ? `${r}s` : ''}`
}

/** Elapsed time as people say it: "45s", "13m", "2h 5m", "3d 4h". Two units at most. */
export function formatElapsed(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0))
  if (s < 60) return `${s}s`
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d) return h ? `${d}d ${h}h` : `${d}d`
  if (h) return m ? `${h}h ${m}m` : `${h}h`
  return `${m}m`
}

const UNIT_WORDS = [[86400, 'day'], [3600, 'hour'], [60, 'minute'], [1, 'second']]

/** "5 minutes", "1 hour 30 minutes", "30 seconds". */
export function durationWords(sec) {
  let s = Math.max(0, Math.round(Number(sec) || 0))
  if (s === 0) return '0 seconds'
  const parts = []
  for (const [size, word] of UNIT_WORDS) {
    const n = Math.floor(s / size)
    if (n) parts.push(`${n} ${word}${n === 1 ? '' : 's'}`)
    s -= n * size
  }
  return parts.join(' ')
}

// "every minute", "every 5 minutes": a single whole unit drops its "1".
const everyWords = sec => {
  const w = durationWords(sec)
  return /^1 [a-z]+$/.test(w) ? w.slice(2) : w
}

const SYMBOL = { '>': '>', '<': '<', '>=': '≥', '<=': '≤', '==': '=', '!=': '≠' }
const WORDS = { '>': 'above', '<': 'below', '>=': 'at or above', '<=': 'at or below', '==': 'equal to', '!=': 'not equal to' }
const ANOMALY = { '>': 'above', '<': 'below', '<>': 'outside' }

/**
 * The condition as the list shows it: "Error % > 3% critical, > 1% warning,
 * for 5m", or for an anomaly rule "RPM outside expected by 2σ, 3σ critical,
 * for 10m". A lone warning tier names no severity — the chip beside it does —
 * and a rule that fires at once has no "for".
 */
export function conditionText(view) {
  const { warning, critical } = view?.tiers ?? {}
  const metric = view?.metric || 'Value'
  let head
  if (view?.kind === 'anomaly') {
    const lead = warning ?? critical
    if (!lead) return metric
    head = `${metric} ${ANOMALY[lead.op] ?? lead.op} expected by ${formatThreshold(view, lead.deviations)}${warning ? '' : ' critical'}`
    if (warning && critical) {
      head += critical.op === warning.op
        ? `, ${formatThreshold(view, critical.deviations)} critical`
        : `, ${ANOMALY[critical.op] ?? critical.op} by ${formatThreshold(view, critical.deviations)} critical`
    }
  } else {
    const short = tier => `${SYMBOL[tier.op] ?? tier.op} ${formatThreshold(view, tier.threshold)}`
    const tiers = [
      critical && `${short(critical)} critical`,
      warning && `${short(warning)}${critical ? ' warning' : ''}`,
    ].filter(Boolean)
    if (!tiers.length) return metric
    head = `${metric} ${tiers.join(', ')}`
  }
  return view.forSec > 0 ? `${head}, for ${formatDuration(view.forSec)}` : head
}

// "payment-service", "POST /v1/payments on payment-service", "ip-10-0-142-133".
function scopeWords(scope = {}) {
  if (scope.service && scope.endpoint) return `${scope.endpoint} on ${scope.service}`
  return scope.service ?? scope.host ?? null
}

function notifyWords(view) {
  const names = (view.contactPoints ?? []).map(c => c.name)
  const oneOff = (view.receivers ?? []).filter(r => r.oneOff).length
  if (oneOff) names.push(`${oneOff} one-off destination${oneOff === 1 ? '' : 's'}`)
  if (!names.length) return null
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/**
 * The whole rule as a sentence, in parts the editor can turn into links to
 * their fields (D6): `[{ text, field? }]`, `field` one of metric, scope,
 * condition, for, interval, notify, repeat.
 */
export function ruleSentenceParts(view) {
  const parts = []
  const add = (text, field) => parts.push(field ? { text, field } : { text })
  const { warning, critical } = view?.tiers ?? {}
  add('Alert when ')
  add(view?.metric || 'the value', 'metric')
  const scope = scopeWords(view?.scope)
  if (scope) { add(' of '); add(scope, 'scope') }
  add(' is ')
  const words = tier => (view.kind === 'anomaly'
    ? `${ANOMALY[tier.op] ?? tier.op} the expected range by ${formatThreshold(view, tier.deviations)}`
    : `${WORDS[tier.op] ?? tier.op} ${formatThreshold(view, tier.threshold)}`)
  if (warning && critical) add(`${words(warning)} (critical ${words(critical)})`, 'condition')
  else if (critical) add(`${words(critical)} (critical)`, 'condition')
  else if (warning) add(words(warning), 'condition')
  else add('anything at all', 'condition')
  if (view.forSec > 0) { add(' for '); add(durationWords(view.forSec), 'for') }
  add(', checked every ')
  add(everyWords(view.intervalSec || 60), 'interval')
  add('.')
  const notify = notifyWords(view)
  if (notify) {
    add(' Notify ')
    add(notify, 'notify')
    add(' and remind every ')
    add(everyWords(view.repeatSec || 14400), 'repeat')
    add(' while it fires.')
  } else {
    add(' No one is notified.', 'notify')
  }
  return parts
}

/** The whole rule as one sentence. */
export const ruleSentence = view => ruleSentenceParts(view).map(p => p.text).join('')

/** "4.7×" — a reading against the threshold it crossed. Null when there is none. */
export function multipleText(view) {
  const m = view?.thresholdMultiple
  if (m == null || !Number.isFinite(m)) return null
  return `${m >= 10 ? Math.round(m) : m.toFixed(1).replace(/\.0$/, '')}×`
}

/**
 * How long the rule has been in its state, as the row shows it: "Firing 13m",
 * "Pending 2m · fires in 3m", "OK for 3d", "Paused". `view.since` is when the
 * state began (unix seconds); an open-started one ("since before we looked")
 * reads "for 8d+" rather than a precise figure it does not have.
 */
export function sinceText(view, nowSec) {
  const elapsed = view?.since != null ? formatElapsed(nowSec - view.since) + (view.sinceOpen ? '+' : '') : null
  switch (view?.state) {
    case 'firing': return elapsed ? `Firing ${elapsed}` : 'Firing'
    case 'pending': {
      const left = view.since != null && view.forSec > 0 ? view.since + view.forSec - nowSec : null
      return [elapsed ? `Pending ${elapsed}` : 'Pending', left > 0 ? `fires in ${formatElapsed(left)}` : null].filter(Boolean).join(' · ')
    }
    case 'ok': return elapsed ? `OK for ${elapsed}` : 'OK'
    case 'paused': return 'Paused'
    case 'nodata': return 'No data'
    case 'error': return 'Rule error'
    default: return ''
  }
}
