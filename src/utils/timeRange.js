// The platform's time model: presets, the step a range queries at, and how
// both ends are aligned. The step decides how many points a query returns and
// where they fall, so every page that draws a time series has to agree on it —
// two charts built on different alignment disagree at every bucket edge.
//
// Everything a query sees is unix SECONDS. Milliseconds appear only where the
// browser hands them over (Date.now(), drag-zoom, the From/To inputs).
//
// One range is owned by App and shared by every page. Both forms are modelled
// here, and a page should never need to care which it was handed:
//   { kind: 'preset', value: '1h' } | { kind: 'absolute', from: ms, to: ms }

export const TIME_PRESETS = [
  { value: '5m', label: 'Last 5 minutes' },
  { value: '15m', label: 'Last 15 minutes' },
  { value: '30m', label: 'Last 30 minutes' },
  { value: '1h', label: 'Last 1 hour' },
  { value: '2h', label: 'Last 2 hours' },
  { value: '3h', label: 'Last 3 hours' },
  { value: '6h', label: 'Last 6 hours' },
  { value: '12h', label: 'Last 12 hours' },
  { value: '24h', label: 'Last 24 hours' },
  { value: '2d', label: 'Last 2 days' },
  { value: '3d', label: 'Last 3 days' },
  { value: '7d', label: 'Last 7 days' },
  { value: 'today', label: 'Today' },
  { value: 'todayf', label: 'Today so far' },
]

export const DEFAULT_PRESET = '1h'

export const AUTO_REFRESH_OPTIONS = [
  { value: 0, label: 'Off' },
  { value: 5, label: '5s' },
  { value: 10, label: '10s' },
  { value: 30, label: '30s' },
  { value: 60, label: '1m' },
  { value: 300, label: '5m' },
  { value: 900, label: '15m' },
]

// Comparison windows (ARCH D6). `vs` is the phrase a delta's title uses.
export const COMPARE_OPTIONS = [
  { value: 'off', label: 'Off', vs: '' },
  { value: 'previous', label: 'Previous period', vs: 'vs previous period' },
  { value: 'day', label: '1 day ago', vs: 'vs 1 day ago' },
  { value: 'week', label: '1 week ago', vs: 'vs 1 week ago' },
]
export const DEFAULT_COMPARE = 'previous'

// Any Nm/Nh/Nd resolves, not just the listed presets — as in the reference.
const RELATIVE = /^[1-9][0-9]*(m|h|d)$/

/** 'Last 1 hour' → '1h'. Anything unrecognised (e.g. a LogsView "Custom…") → the default. */
export function presetFromLabel(label) {
  return TIME_PRESETS.find(p => p.label === label)?.value ?? DEFAULT_PRESET
}

/** '1h' → 'Last 1 hour'. A value outside the list reads "Custom", as in the reference. */
export function labelFromPreset(value) {
  return TIME_PRESETS.find(p => p.value === (value || DEFAULT_PRESET))?.label ?? 'Custom'
}

/**
 * Reference `Ef.step`. The 6h rule depends on the zone: 120 s buckets only
 * tile a local day when the UTC offset is a whole half hour, so zones like
 * Nepal (+5:45) get 300 s instead.
 */
export function stepForSpan(spanSec, minStepSec = 60, tzOffsetMin = -new Date().getTimezoneOffset()) {
  let s = 15
  if (spanSec >= 86400) s = 900
  else if (spanSec >= 43200) s = 300
  else if (spanSec >= 21600) s = tzOffsetMin % 30 ? 300 : 120
  else if (spanSec >= 3600) s = 60
  else if (spanSec >= 1800) s = 30
  return Math.max(s, minStepSec)
}

const unix = (ms) => Math.floor(ms / 1000)

function presetBounds(value, nowMs) {
  const v = RELATIVE.test(value) || value === 'today' || value === 'todayf' ? value : DEFAULT_PRESET
  const now = new Date(nowMs)
  if (v === 'today' || v === 'todayf') {
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    // "Today" ends at 23:59:59 — in the future. The reference does the same,
    // and the chart shows the rest of the day empty rather than a shorter axis.
    const end = v === 'today'
      ? new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).getTime()
      : nowMs
    return [unix(midnight), unix(end)]
  }
  const n = parseInt(v, 10)
  const unit = v[v.length - 1]
  if (unit === 'd') {
    // Calendar days, like dayjs.subtract(n, 'd'): across a DST change "Last
    // 2 days" starts at the same wall-clock time, not exactly 172800 s ago.
    const d = new Date(nowMs)
    d.setDate(d.getDate() - n)
    return [unix(d.getTime()), unix(nowMs)]
  }
  const sec = unit === 'h' ? n * 3600 : n * 60
  return [unix(nowMs) - sec, unix(nowMs)]
}

/**
 * Resolves a range to what a query is sent with (reference `Ef.get`).
 * Relative presets resolve against `nowMs`, so they roll forward on every run.
 * Both ends are FLOORED to a step boundary in local time — the end too, which
 * drops the trailing partial bucket.
 *
 * @param {{kind:'preset', value:string} | {kind:'absolute', from:number, to:number} | null} range
 * @returns {{ start:number, end:number, step:number, rawStart:number, rawEnd:number, span:number }}
 *   unix seconds; `span` = end - start (always a whole number of steps).
 */
export function resolveRange(range, nowMs = Date.now(), minStepSec = 60) {
  let rawStart
  let rawEnd
  if (range?.kind === 'absolute') {
    rawStart = unix(range.from)
    rawEnd = unix(range.to)
  } else {
    [rawStart, rawEnd] = presetBounds(range?.value || DEFAULT_PRESET, nowMs)
  }
  const off = -new Date(nowMs).getTimezoneOffset()
  const step = stepForSpan(rawEnd - rawStart, minStepSec, off)
  const start = rawStart - ((rawStart - off * 60) % step)
  const end = rawEnd - ((rawEnd - off * 60) % step)
  return { start, end, step, rawStart, rawEnd, span: end - start }
}

/** The same window `bySec` earlier, at the same step (the comparison fetch). */
export function shiftRange(resolved, bySec) {
  return {
    ...resolved,
    start: resolved.start - bySec,
    end: resolved.end - bySec,
    rawStart: resolved.rawStart - bySec,
    rawEnd: resolved.rawEnd - bySec,
  }
}

/** Seconds to shift for a Compare choice; 0 means no comparison. */
export function compareShift(compare, resolved) {
  if (compare === 'previous') return resolved?.span || 0
  if (compare === 'day') return 86400
  if (compare === 'week') return 604800
  return 0
}

const ABS_FORMAT = 'MMM DD, HH:mm:ss'

/** 'Oct 01, 14:00:00 - Oct 01, 15:30:00', local time. */
export function formatAbsoluteLabel(fromMs, toMs) {
  return `${formatLocal(fromMs, ABS_FORMAT)} - ${formatLocal(toMs, ABS_FORMAT)}`
}

/** What the time button says for a range. */
export function rangeLabel(range) {
  if (range?.kind === 'absolute') return formatAbsoluteLabel(range.from, range.to)
  return labelFromPreset(range?.value)
}

/**
 * Drag-to-zoom (reference zoom handler): floor the start and ceil the end to
 * the minute, so the new range is whole minutes and a step boundary. A drag
 * with no width is a click, and a click does nothing.
 */
export function zoomRange(minMs, maxMs) {
  if (!Number.isFinite(minMs) || !Number.isFinite(maxMs)) return null
  let lo = Math.min(minMs, maxMs)
  let hi = Math.max(minMs, maxMs)
  if (hi - lo <= 0) return null
  lo -= lo % 60000
  if (hi % 60000) hi += 60000 - (hi % 60000)
  if (hi - lo < 60000) return null
  return { kind: 'absolute', from: lo, to: hi }
}

const INPUT = /^\s*(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?\s*$/

/**
 * 'YYYY-MM-DD HH:mm:ss' (seconds optional; a 'T' separator, as a
 * datetime-local input produces, is accepted too) → local ms, or null. A
 * date that does not exist (Feb 30, 24:00) is null rather than silently
 * rolled into the next month.
 */
export function parseDateTimeInput(text) {
  const m = INPUT.exec(text ?? '')
  if (!m) return null
  const [y, mo, d, h, mi, s] = m.slice(1).map(x => (x === undefined ? 0 : Number(x)))
  const date = new Date(y, mo - 1, d, h, mi, s)
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d
    || date.getHours() !== h || date.getMinutes() !== mi || date.getSeconds() !== s) return null
  return date.getTime()
}

/** Local ms → 'YYYY-MM-DD HH:mm:ss' ('' for nothing). */
export function formatDateTimeInput(ms) {
  if (ms == null || !Number.isFinite(ms)) return ''
  return formatLocal(ms, 'YYYY-MM-DD HH:mm:ss')
}

/**
 * What To becomes when From is set while To is still empty (reference picker:
 * From + 24h). The reference lets that land in the future, where Apply then
 * refuses it; clamping to now keeps the filled-in range one click from applied.
 */
export function autoFillTo(fromMs, nowMs = Date.now()) {
  if (fromMs == null || !Number.isFinite(fromMs)) return null
  return Math.min(fromMs + 86400000, nowMs)
}

/**
 * The From/To rules (ARCH D5, reference picker): Apply needs both ends valid
 * and From before To, and neither end may be in the future. `reason` is the
 * sentence a disabled Apply carries in its title.
 *
 * @returns {{ from:number|null, to:number|null, canApply:boolean, reason:string }}
 */
export function validateCustomRange(fromText, toText, nowMs = Date.now()) {
  const from = parseDateTimeInput(fromText)
  const to = parseDateTimeInput(toText)
  const bad = (which, text) => (String(text ?? '').trim()
    ? `${which} is not a valid date (YYYY-MM-DD HH:mm:ss)`
    : `Enter ${which === 'From' ? 'a start' : 'an end'} time`)
  let reason = ''
  if (from == null) reason = bad('From', fromText)
  else if (to == null) reason = bad('To', toText)
  else if (from > nowMs) reason = 'From is in the future'
  else if (to > nowMs) reason = 'To is in the future'
  else if (from >= to) reason = 'From must be before To'
  return { from, to, canApply: !reason, reason }
}

/** Every step from start to end inclusive — the chart's x labels (seconds). */
export function timestamps(resolved) {
  const out = []
  if (!resolved || !(resolved.step > 0)) return out
  for (let t = resolved.start; t <= resolved.end; t += resolved.step) out.push(t)
  return out
}

// ---------- Local-time timestamps ----------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const pad = (n, w = 2) => String(n).padStart(w, '0')

/**
 * Formats a ms timestamp in the browser's local zone — the only zone the
 * product has. Tokens: `yyyy`/`YYYY`, `MMM` (Oct), `MM`, `dd`/`DD`, `HH`,
 * `mm`, `ss`; anything else is copied through.
 */
export function formatLocal(ms, pattern) {
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return ''
  const parts = {
    yyyy: String(d.getFullYear()), YYYY: String(d.getFullYear()),
    MMM: MONTHS[d.getMonth()], MM: pad(d.getMonth() + 1),
    dd: pad(d.getDate()), DD: pad(d.getDate()),
    HH: pad(d.getHours()), mm: pad(d.getMinutes()), ss: pad(d.getSeconds()),
  }
  return pattern.replace(/yyyy|YYYY|MMM|MM|dd|DD|HH|mm|ss/g, t => parts[t])
}
