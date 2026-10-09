// How every chart on the platform draws and labels itself.
//
// Three rules the platform holds to, and the reason for each:
//   - Straight segments between samples. A curve invents readings between two
//     points, and on a latency or error chart the invented part is exactly
//     where an incident looks calmer than it was.
//   - Flat fills, no gradients. A fill that fades says the older part of the
//     window matters less, which is not true of a time series.
//   - No entry animation. A number that is still sliding into place cannot be
//     read, and these charts are read while something is on fire.
//
// Axis formatting lives here too, so that 0.05 and 12400 are written the same
// way on every page rather than per chart, and so do the two rules a legend
// keeps (what its search matches, and how it scrolls a row into view).

export const AXIS_TICK = { fontSize: 10, fill: 'var(--text-muted)' }
export const GRID_PROPS = { strokeDasharray: '3 3', stroke: 'var(--border-subtle)', vertical: false }

// Spread onto every series and every Tooltip.
export const NO_ANIM = { isAnimationActive: false }

// Straight segments, flat fill: spread onto <Area>, and LINE_PROPS onto <Line>.
export const AREA_PROPS = { type: 'linear', fillOpacity: 0.16, isAnimationActive: false }
export const LINE_PROPS = { type: 'linear', isAnimationActive: false }

const trim = n => String(+n.toFixed(1))

// One number, written the way a reader would say it. Large magnitudes compact
// to k/M/G; values below 1 keep enough decimals to stay distinguishable, which
// matters because an error rate axis of 0.00 / 0.00 / 0.00 says nothing.
export function fmtCompact(v) {
  if (v == null || Number.isNaN(v)) return ''
  const a = Math.abs(v)
  if (a >= 1e9) return trim(v / 1e9) + 'G'
  if (a >= 1e6) return trim(v / 1e6) + 'M'
  if (a >= 1000) return trim(v / 1000) + 'k'
  if (a === 0) return '0'
  if (a < 0.01) return String(+v.toFixed(4))
  if (a < 0.1) return String(+v.toFixed(3))
  if (a < 1) return String(+v.toFixed(2))
  if (a < 10) return trim(v)
  return String(Math.round(v))
}

export function fmtCount(v) {
  if (v == null || Number.isNaN(v)) return ''
  return Math.abs(v) >= 1000 ? fmtCompact(v) : String(Math.round(v))
}

export const fmtMs = v => fmtCompact(v)
export const fmtPct = v => fmtCompact(v)

// The APM RED tab's figures: its legend values, axis ticks and tooltip rows.
// Moved here out of ServiceOverview unchanged when the Browser page drew the
// same charts. They are what the service page has always printed, so they keep
// their quirks: RPM rounds to a whole number, and none of them expects a
// missing reading.
export const fmtRedMs = v => `${Math.round(v)} ms`
export const fmtRedRpm = v => v >= 1000 ? `${(v / 1000).toFixed(1)}K` : Math.round(v).toString()
export const fmtRedPct = v => `${v.toFixed(2)}%`

// The Browser page's figures. Each one prints a missing reading as nothing
// rather than as a zero, because a page that has not loaded yet is not a page
// that loaded instantly.

// A page load or an ajax call. Milliseconds up to a second and seconds past
// it, with a space before the unit as the service page writes "612 ms". The
// switch is on the ROUNDED value, so 999.6 reads "1.00 s" rather than the
// "1000 ms" a test on the raw number would print.
export function fmtLoadTime(ms) {
  if (ms == null || Number.isNaN(ms)) return ''
  return Math.round(ms) < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`
}

// Requests per minute to two decimals. Browser traffic is per page, so most
// routes run at single or low double digits a minute, and fmtRedRpm's whole
// numbers would print five quiet category pages as the same "9".
export function fmtRpm2(v) {
  if (v == null || Number.isNaN(v)) return ''
  return v >= 1000 ? `${(v / 1000).toFixed(2)}K` : v.toFixed(2)
}

// Cumulative Layout Shift is a unitless score whose thresholds sit at 0.1 and
// 0.25, so two decimals are the precision it is judged at.
export function fmtCls(v) {
  if (v == null || Number.isNaN(v)) return ''
  return v.toFixed(2)
}

// The Browser page's AXIS ticks. A legend value or a tooltip is one reading,
// and its two decimals are the reading's precision ("110.89"); a tick is a
// round step on a scale, and the same two decimals only add noise down the
// axis ("0.00, 30.00, 60.00"). So a tick prints the fewest decimals that still
// say it (up to two, the steps niceAxis picks for these charts), as the
// service page's RED axes print "0, 30, 60".
const tickNumber = v => String(+v.toFixed(2))

/** A rate tick: '0', '30', '2.5', and '1.5K' past a thousand. */
export function fmtRateTick(v) {
  if (v == null || Number.isNaN(v)) return ''
  return Math.abs(v) >= 1000 ? `${tickNumber(v / 1000)}K` : tickNumber(v)
}

/** A percentage tick: '0%', '2.5%', '24%'. */
export function fmtPctTick(v) {
  if (v == null || Number.isNaN(v)) return ''
  return `${tickNumber(v)}%`
}

/** A unitless tick (a CLS score): '0', '0.1', '0.25'. */
export function fmtPlainTick(v) {
  if (v == null || Number.isNaN(v)) return ''
  return tickNumber(v)
}

/**
 * A load-time tick, in ONE unit for the whole axis: seconds when the axis tops
 * out at a second or more ('0 s, 0.75 s, 1.5 s, 3 s'), milliseconds otherwise
 * ('0 ms, 250 ms, 500 ms'). fmtLoadTime switches unit per value, which down an
 * axis reads '750 ms' under '1.50 s'. The chart passes its axis top as the
 * second argument; without one the tick's own size decides, as fmtLoadTime's.
 */
export function fmtLoadTimeTick(v, top = v) {
  if (v == null || Number.isNaN(v)) return ''
  return Math.abs(top) >= 1000 ? `${tickNumber(v / 1000)} s` : `${Math.round(v)} ms`
}

export function fmtBytes(v) {
  if (v == null || Number.isNaN(v)) return ''
  const a = Math.abs(v)
  // A round value keeps its round label: 100K, not 100.0K.
  if (a >= 1e9) return trim(v / 1e9) + 'G'
  if (a >= 1e6) return trim(v / 1e6) + 'M'
  if (a >= 1000) return trim(v / 1000) + 'K'
  return String(Math.round(v))
}

// Time axis. A fixed tick count cannot work: the same component renders at 600px
// on a service page and at 110px in a runtime card, and five labels that read
// well at one width collide into "-59m47m35m" at the other. So the axis asks
// Recharts to keep the first and last label and drop whatever will not fit,
// which makes the label count a function of the width actually available.
export function timeAxisProps(length, { minTickGap = 44 } = {}) {
  const n = Number.isFinite(length) ? length : 0
  const base = {
    dataKey: 'label',
    tick: AXIS_TICK,
    tickLine: false,
    axisLine: { stroke: 'var(--border-subtle)' },
  }
  // A handful of buckets - a zoomed-in histogram - can show every label.
  if (n > 0 && n <= 6) return { ...base, interval: 0, minTickGap: 8 }
  return { ...base, interval: 'preserveStartEnd', minTickGap }
}

// Value axis. The gutter is sized from the widest label the data can actually
// produce rather than from a guess, so "1.2M" is not clipped and a 0-1 apdex
// axis does not reserve room for thousands.
//
// `domain` is for scales that are bounded by definition - an apdex is 0 to 1,
// and a flat-zero series needs a scale to be flat against. A percentage is not
// one of them: CPU on a multi-core host passes 100%, and an axis pinned there
// would draw the busiest host as merely full.
export function valueAxisProps({ format = fmtCompact, domain, allowDecimals = true, maxValue } = {}) {
  const widest = maxValue == null ? 4 : Math.max(String(format(maxValue)).length, 1)
  return {
    tick: AXIS_TICK,
    tickLine: false,
    axisLine: false,
    width: Math.min(56, Math.max(26, widest * 7 + 8)),
    tickFormatter: format,
    allowDecimals,
    ...(domain ? { domain } : null),
  }
}

// Tick steps that read as round numbers at every magnitude.
const NICE_STEPS = [1, 2, 2.5, 5, 10]

/**
 * How many decimals a tick formatter prints, read off a value that has many.
 * `v => Math.round(v)` and `v => \`${Math.round(v)} ms\`` print 0; `toFixed(2)`
 * prints 2.
 */
export function formatDecimals(format) {
  const m = String(format(0.123456)).match(/\d\.(\d+)/)
  return m ? m[1].length : 0
}

/**
 * A y domain of [0, top] with about `count` ticks, both ending on a round
 * number. For a chart that fixes its own scale rather than letting Recharts
 * fit it to what is drawn — Explore inverts pointer pixels against it, and a
 * chart under a series budget sizes it from series it is not drawing yet.
 *
 * `decimals` is what the chart's tick formatter can print (formatDecimals).
 * A step it cannot print exactly is skipped: a 2.5 step under a formatter that
 * rounds to whole numbers labels its gridlines 0, 3, 5, 8, 10 — two of those
 * five labels then sit on lines that are not at the value they name.
 */
export function niceAxis(max, count = 4, { decimals = Infinity } = {}) {
  if (!(max > 0)) return decimals === 0 ? { top: 1, ticks: [0, 1] } : { top: 1, ticks: [0, 0.25, 0.5, 0.75, 1] }
  const raw = max / count
  const scale = 10 ** Math.min(decimals, 12)
  const printable = s => !Number.isFinite(decimals) || Math.abs(Math.round(s * scale) - s * scale) < 1e-6
  let mag = 10 ** Math.floor(Math.log10(raw))
  let step = null
  // Walk up a magnitude at a time: at a whole-number formatter a raw step of
  // 0.3 skips 0.5 and lands on 1.
  for (let tries = 0; step == null && tries < 4; tries++, mag *= 10) {
    step = NICE_STEPS.map(n => n * mag).find(s => s >= raw && printable(s)) ?? null
  }
  step ??= 10 * mag
  const top = Math.ceil(max / step) * step
  const ticks = []
  for (let t = 0; t <= top + step / 2; t += step) ticks.push(Number(t.toPrecision(12)))
  return { top, ticks }
}

// ---- legends ----

/**
 * Whether a row answers a search: its label contains the query, either as
 * stored (`row[labelKey]`) or as the chart shows it (`formatLabel(full, row)`),
 * ignoring case. An empty or blank query matches every row.
 *
 * One test, used by a chart's legend search (LegendLineChart) and by the table
 * search of the page the chart sits on (the Browser tabs' filterByLabel), so the
 * two can never disagree on a query. They did once: an Ajax legend row reads
 * 'GET payment.cubedemo.com/v1/payments' (the label without its ':443'), the
 * legend search only tried the stored label, and typing what was on screen
 * found the row in the table but not in the chart beside it.
 */
export function labelMatches(row, query, formatLabel, labelKey = 'endpoint') {
  const q = String(query ?? '').trim().toLowerCase()
  if (!q) return true
  const full = String(row?.[labelKey] ?? '')
  if (full.toLowerCase().includes(q)) return true
  return formatLabel ? String(formatLabel(full, row) ?? '').toLowerCase().includes(q) : false
}

/**
 * Where a scrolling legend must scroll to so one of its rows shows whole, or
 * null when it already does. `top` and `bottom` are the row's edges measured
 * in the legend's scrolled content (0 at the top of the content, not of the
 * viewport); `scrollTop` and `height` are the legend's scroll position and
 * visible height. `edge` keeps the row that far off the rim, so it does not
 * sit flush against the fold where it reads as cut off.
 *
 * It moves the least it can: a row above the view comes to the top, a row
 * below it to the bottom, and a row taller than the view shows its top. A
 * legend that scrolls to the row's top every time would jump a row that was
 * already in view by a pixel too few.
 */
export function scrollTopToReveal({ top, bottom, scrollTop, height, edge = 8 }) {
  if (top - edge < scrollTop) return Math.max(0, top - edge)
  if (bottom + edge > scrollTop + height) return Math.max(0, Math.min(top - edge, bottom + edge - height))
  return null
}

// Largest value a series (or a set of stacked keys) reaches, for the gutter.
export function maxOf(data, keys) {
  if (!Array.isArray(data) || data.length === 0) return undefined
  const ks = Array.isArray(keys) ? keys : [keys ?? 'value']
  let max = 0
  for (const row of data) {
    for (const k of ks) {
      const v = Number(row?.[k])
      if (Number.isFinite(v) && v > max) max = v
    }
  }
  return max
}
