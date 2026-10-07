// Value formatting for Explore: legend values, axis ticks, tooltips, table
// cells. Faithful to the reference formatters (`Gr` for numbers, `Ko` for
// durations) so a number reads the same here as on the page people compare us
// against — `1.23K`, `<.0001`, `612 ms` — rather than whatever our other pages
// happen to do (`formatNumber` in ../format.js rounds `1234` to `1.2k`).
//
// The CSV never goes through here: it carries raw numbers so a spreadsheet can
// do arithmetic on them.

const TRAILING_ZEROS = /0*$/

// Reference `Ost`: SI suffix up to G (never T), two decimals — four for tiny
// values so 0.004 survives — then trailing zeros stripped. Takes the value's
// string form, exactly as the reference does, because that is where the
// empty-string and sign handling live.
function si(str) {
  if (!str) return ''
  let sign = ''
  let s = str
  if (s[0] === '-') { sign = '-'; s = s.slice(1) }
  let t = parseFloat(s)
  // Non-finite values never reach a chart (the API drops them), but a table
  // cell can still hold one; the reference would throw on `Infinity` here.
  if (!Number.isFinite(t)) return ''
  let suffix = ''
  if (t >= 1e3) { t /= 1e3; suffix = 'K' }
  if (t >= 1e3) { t /= 1e3; suffix = 'M' }
  if (t >= 1e3) { t /= 1e3; suffix = 'G' }
  const decimals = t < 0.005 ? 4 : 2
  const [int, rawDec] = t.toFixed(decimals).split('.')
  const dec = rawDec.replace(TRAILING_ZEROS, '')
  // Something too small for four decimals is still not zero, and saying `0`
  // would claim it is. The sign is dropped here, as in the reference.
  if (int === '0' && dec === '') return t === 0 ? '0' : '<.0001'
  return `${sign}${int}${dec ? `.${dec}` : ''}${suffix}`
}

/** "number" type: `0`, `0.5`, `12.35`, `1.23K`, `1.5M`, `2.5G`, `<.0001`. */
export function formatNumberValue(v) {
  if (v == null) return ''
  return si(typeof v === 'string' ? v : `${v}`)
}

/**
 * "time" type. The value is in SECONDS (what `histogram_quantile` over our
 * latency buckets returns); formatted as nanoseconds with the SI suffix mapped
 * onto a unit: `500 ns`, `12 μs`, `612 ms`, `1.5 s`. Nothing above seconds —
 * an hour reads `3600 s`, as in the reference.
 */
export function formatTimeValue(seconds) {
  if (seconds == null || !Number.isFinite(Number(seconds))) return ''
  const s = si(`${Number(seconds) * 1e9}`)
  if (s.endsWith('K')) return `${s.slice(0, -1)} μs`
  if (s.endsWith('M')) return `${s.slice(0, -1)} ms`
  if (s.endsWith('G')) return `${s.slice(0, -1)} s`
  return `${s} ns`
}

/**
 * The one entry point the UI uses. A missing value (a table row with no
 * sample) reads `-`; NaN (a non-numeric aggregate) reads as nothing, the way
 * the reference table shows it.
 */
export function formatValue(v, unit = 'number') {
  if (v === null || v === undefined) return '-'
  if (typeof v === 'number' && Number.isNaN(v)) return ''
  return unit === 'time' ? formatTimeValue(v) : formatNumberValue(v)
}

/**
 * Reference `I0`: `k=v` pairs sorted by key, joined with `, `. With `keys`,
 * only those the metric actually carries are included — a series without a
 * varying key has it omitted from its legend name, not shown as `k=`.
 */
export function labelsToString(metric, keys) {
  if (!metric) return ''
  const own = keys ? keys.filter(k => Object.prototype.hasOwnProperty.call(metric, k)) : Object.keys(metric)
  return [...own].sort().map(k => `${k}=${metric[k] ?? ''}`).join(', ')
}

// A ratio worth saying as a multiple reads better that way: "↑4.4×" says what
// "↑340%" makes you compute.
function ratioText(r) {
  if (r >= 1000) return `${formatNumberValue(r)}×`
  if (r >= 10) return `${Math.round(r)}×`
  return `${Number(r.toFixed(1))}×`
}

function pctText(p) {
  const a = Math.abs(p)
  return a >= 10 ? `${Math.round(a)}%` : `${Number(a.toFixed(1))}%`
}

/**
 * Comparison context for a value (CLAUDE.md rule 6): current vs the same
 * query over the comparison window.
 *
 * @returns {{ text: string, dir: 'up'|'down'|'flat'|'new'|'none', ratio: number }}
 *   `ratio` is curr / prev (NaN when unknown, Infinity for `new`), for callers
 *   that sort by change.
 */
export function formatDelta(curr, prev) {
  const c = typeof curr === 'number' ? curr : NaN
  const p = typeof prev === 'number' ? prev : NaN
  const cOk = Number.isFinite(c)
  const pOk = Number.isFinite(p) && p !== 0
  if (!cOk) return { text: '—', dir: 'none', ratio: NaN }
  // Nothing to compare against. A series that appeared this window is news;
  // one that is zero both times is not.
  if (!pOk) {
    return c > 0
      ? { text: 'new', dir: 'new', ratio: Infinity }
      : { text: '—', dir: 'none', ratio: NaN }
  }
  const ratio = c / p
  const change = ((c - p) / Math.abs(p)) * 100
  if (Math.abs(change) < 0.05) return { text: '0%', dir: 'flat', ratio }
  if (p > 0 && ratio >= 2) return { text: `↑${ratioText(ratio)}`, dir: 'up', ratio }
  return change > 0
    ? { text: `↑${pctText(change)}`, dir: 'up', ratio }
    : { text: `↓${pctText(change)}`, dir: 'down', ratio }
}

/**
 * Reference `Nln`: reduce a series' points to its Legend value.
 * `avg` divides by the points PRESENT — gaps are skipped, not zero-filled —
 * and `sum` is the sum of step samples, not a time integral.
 */
export function reduceValues(points, formula) {
  const ys = []
  for (const p of points || []) if (Number.isFinite(p?.y)) ys.push(p.y)
  if (formula === 'last') return ys.length ? ys[ys.length - 1] : NaN
  if (formula === 'avg' || formula === 'sum') {
    let t = 0
    for (const y of ys) t += y
    return formula === 'avg' ? t / ys.length : t
  }
  throw new Error('Unsupported formula')
}

// ---------- Local-time timestamps ----------

// `formatLocal` now lives with the time model, which is the only place a
// pattern like 'MMM DD, HH:mm:ss' is composed. Re-exported here so Explore's
// own formatters stay one import.
export { formatLocal } from '@/utils/timeRange.js'
