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
// way on every page rather than per chart.

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
