// How LogsQL reads a value as a number, and compares two of them.
//
// One definition, two readers. Explore's evaluator (explore/logsql/evaluate.js)
// runs `duration:>100ms` over its sampled rows; the Logs and Traces query
// builder (components/QueryBuilder.jsx) matches a `duration:>=8.8ms` chip
// against a span. The two must agree on what `8.8ms` is, or the same text would
// filter differently on two pages. This module imports nothing — QueryBuilder
// cannot import the evaluator, which pulls in the events store — so either side
// can take it without dragging the other's data along.
//
// Field-agnostic, the way LogsQL is: nothing here knows what a field holds. A
// span's `duration` tag is a number of nanoseconds, so `duration:>=8.799ms`
// compares nanoseconds to nanoseconds, and `duration_ms:>5` compares a number to
// a number. A bare number is taken as written: `duration:>5` is five
// nanoseconds, not five milliseconds, because that is what the field holds.

// A duration reads as nanoseconds, so `duration:>100ms` means 1e8 against a
// nanosecond field. Several parts add up: `1h30m`, `1s500ms`.
const DURATION_NS = { ns: 1, us: 1e3, 'µs': 1e3, ms: 1e6, s: 1e9, m: 6e10, h: 3.6e12, d: 8.64e13, w: 6.048e14, y: 3.1536e16 }
const DURATION_TEXT = /^[+-]?(?:\d+(?:\.\d+)?(?:ns|us|µs|ms|s|m|h|d|w|y))+$/
const DURATION_PART = /(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h|d|w|y)/g
// A size reads as bytes: `1KB` is 1000, `1KiB` 1024.
const SIZE_TEXT = /^([+-]?\d+(?:\.\d+)?)([kmgt])?(i)?b$/i
const SIZE_EXP = { k: 1, m: 2, g: 3, t: 4 }

// A field value as text. An object (`_stream`) prints the way the server's
// table prints it, so a string comparison against one reads what the user sees.
function valueText(v) {
  if (v === undefined || v === null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

// Each part is rounded to a whole nanosecond after its unit multiply. The
// server holds a duration as an integer count of nanoseconds, and a float
// product is not always one: without the round, a boundary handed over as
// `8.799ms` could land a hair off 8799000 and a span of exactly that length
// would fall on the wrong side of `>=`.
function unitNumber(s) {
  if (DURATION_TEXT.test(s)) {
    let ns = 0
    DURATION_PART.lastIndex = 0
    for (let m = DURATION_PART.exec(s); m; m = DURATION_PART.exec(s)) ns += Math.round(Number(m[1]) * DURATION_NS[m[2]])
    return s[0] === '-' ? -ns : ns
  }
  const size = SIZE_TEXT.exec(s)
  if (!size) return NaN
  return Number(size[1]) * (size[3] ? 1024 : 1000) ** (SIZE_EXP[(size[2] || '').toLowerCase()] || 0)
}

/**
 * A value as LogsQL's comparisons read it: a number as itself, numeric text as
 * its number, a duration as integer nanoseconds, a size as bytes. NaN for
 * anything else, including empty text.
 */
export function toNumber(v) {
  if (typeof v === 'number') return v
  const s = valueText(v).trim()
  if (!s) return NaN
  const n = Number(s)
  return Number.isFinite(n) ? n : unitNumber(s)
}

/**
 * `left <op> right` for op 'gt' | 'gte' | 'lt' | 'lte'. Numerically when both
 * sides read as numbers (toNumber), as text otherwise — the order LogsQL falls
 * back to, so `service:>m` still answers rather than matching nothing.
 */
export function compareValues(op, left, right) {
  const a = toNumber(left)
  const b = toNumber(right)
  const numeric = Number.isFinite(a) && Number.isFinite(b)
  const x = numeric ? a : valueText(left)
  const y = numeric ? b : valueText(right)
  switch (op) {
    case 'gt': return x > y
    case 'gte': return x >= y
    case 'lt': return x < y
    default: return x <= y
  }
}
