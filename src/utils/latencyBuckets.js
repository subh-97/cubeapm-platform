// Latency buckets: the log-spaced bins the Slow Requests histogram and heatmap
// count requests into, and the arithmetic of a log-normal request latency.
//
// The edges are VictoriaMetrics' histogram buckets (`vmrange`): eighteen per
// decade, each edge a three-decimal mantissa times a power of ten. They are
// what production's charts are drawn on — its tooltips read "11.36 ms -
// 12.92 ms" and "8.8 ms - 10 ms", its axes "6 ms, 8.8 ms, 12.92 ms, 18.96 ms,
// 27.83 ms, 40.84 ms" — and a geometric step is the only one that suits a
// latency, which spans three decades between a cache hit and a timeout.
//
// A bucket is addressed by one integer k across all decades: bucket k is
// [edgeMs(k), edgeMs(k + 1)), and edgeMs(18 d + j) = MANTISSA[j] × 10^d ms.
//
// Pure, so the edges, the labels and the distribution maths are tested on
// their own (latencyBuckets.test.js).

export const BUCKETS_PER_DECADE = 18

// VictoriaMetrics' mantissas, in thousandths so labels can be rounded in
// integer arithmetic: 5.995 in floating point is 5.99499…, and rounding it
// there prints "5.99 ms" where production (and the value) says "6 ms".
const MANTISSA = [1000, 1136, 1292, 1468, 1668, 1896, 2154, 2448, 2783, 3162, 3594, 4084, 4642, 5275, 5995, 6813, 7743, 8799]

const decadeOf = k => Math.floor(k / BUCKETS_PER_DECADE)
const slotOf = k => k - decadeOf(k) * BUCKETS_PER_DECADE

/**
 * The low edge of bucket k, in ms — the double nearest the exact edge, so it
 * is the same number an integer count of nanoseconds divides down to
 * (129200000 / 1e6 === edgeMs(38)). Scaling 1.292 by 100 instead gives
 * 129.20000000000002, and a request of exactly 129.2 ms would fall below its
 * own edge.
 */
export function edgeMs(k) {
  const e = decadeOf(k) - 3
  const m = MANTISSA[slotOf(k)]
  return e >= 0 ? m * 10 ** e : m / 10 ** -e
}

/** The bucket a latency falls in: edgeMs(k) <= ms < edgeMs(k + 1). */
export function bucketOf(ms) {
  if (!(ms > 0)) return -Infinity
  let k = Math.floor(Math.log10(ms) * BUCKETS_PER_DECADE)
  // The log is only a first guess: the mantissas are rounded, so a value near
  // an edge can land one bucket off. Settle it against the table.
  while (edgeMs(k) > ms) k--
  while (edgeMs(k + 1) <= ms) k++
  return k
}

/** Bucket k's bounds, in ms. */
export const bucketBounds = k => [edgeMs(k), edgeMs(k + 1)]

// An edge as text, from its integer mantissa: two decimals at most, half up,
// and no trailing zeros — "6", "8.8", "12.92", "129.2".
function edgeNumber(n, decimalsPow) {
  // n × 10^decimalsPow is the value in hundredths; round that to an integer.
  const hundredths = decimalsPow >= 0 ? n * 10 ** decimalsPow : Math.round(n / 10 ** -decimalsPow)
  return String(hundredths / 100)
}

/**
 * An edge of bucket k, as the axis and the tooltip print it: "6 ms", "8.8 ms",
 * "12.92 ms", "129.2 ms", "1.29 s". Milliseconds below a second and seconds
 * from one up, as the Browser page's load times switch (fmtLoadTime); two
 * decimals at most either way, which is the precision production labels with.
 */
export function fmtEdge(k) {
  const d = decadeOf(k)
  const n = MANTISSA[slotOf(k)]
  // edge = n × 10^(d - 3) ms. In hundredths of a ms that is n × 10^(d - 1);
  // in hundredths of a second, n × 10^(d - 4).
  if (d >= 3) return `${edgeNumber(n, d - 4)} s`
  return `${edgeNumber(n, d - 1)} ms`
}

/** Bucket k0 to bucket k1 as one range, low edge to high edge: "8.8 ms - 27.83 ms". */
export function bucketRangeLabel(k0, k1 = k0) {
  const lo = Math.min(k0, k1)
  const hi = Math.max(k0, k1)
  return `${fmtEdge(lo)} - ${fmtEdge(hi + 1)}`
}

/**
 * A request's own latency, as a list row prints it: two decimals below a
 * second ("44.32 ms"), seconds with two from one up ("1.27 s"), and nothing
 * for a missing reading.
 */
export function fmtLatency(ms) {
  if (ms == null || Number.isNaN(ms)) return ''
  if (Math.round(ms * 100) / 100 < 1000) return `${(Math.round(ms * 100) / 100).toFixed(2)} ms`
  return `${(ms / 1000).toFixed(2)} s`
}

/**
 * Which edges to label on an axis of buckets k0..k1 with room for `slots`
 * labels: every `stride`-th edge, where the stride is the smallest of 1, 2, 3,
 * 6, 9 and 18 that fits, anchored on the decade so 10 ms, 100 ms and 1 s are
 * labelled whenever they are in range. Returns the edge indices (k of each
 * labelled edge), low to high.
 */
export function edgeTicks(k0, k1, slots) {
  const edges = k1 - k0 + 2
  const room = Math.max(2, Math.floor(slots))
  const stride = [1, 2, 3, 6, 9, 18].find(s => Math.ceil(edges / s) <= room) ?? 18
  const out = []
  for (let k = Math.ceil(k0 / stride) * stride; k <= k1 + 1; k += stride) out.push(k)
  return out
}

// ---------- log-normal latency ----------

// The standard normal CDF, through erf (Abramowitz & Stegun 7.1.26, absolute
// error under 1.5e-7) — far finer than a percentage printed to one decimal.
export function normalCdf(z) {
  const x = Math.abs(z) / Math.SQRT2
  const t = 1 / (1 + 0.3275911 * x)
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x)
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y)
}

// The standard normal quantile (Acklam's rational approximation, relative
// error under 1.2e-9).
export function normalQuantile(p) {
  if (!(p > 0)) return -Infinity
  if (!(p < 1)) return Infinity
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239]
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1]
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416]
  const lo = 0.02425
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p))
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }
  if (p > 1 - lo) {
    const q = Math.sqrt(-2 * Math.log(1 - p))
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }
  const q = p - 0.5
  const r = q * q
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
}

/** z at the 90th percentile: a log-normal's p90 is its median × e^(Z90 σ). */
export const Z90 = normalQuantile(0.9)

/**
 * A log-normal latency, given its p90 and its spread σ (in natural-log units):
 * `{ mu, sigma }` with mu the log of the median.
 */
export function lognormalFromP90(p90Ms, sigma) {
  return { mu: Math.log(p90Ms) - Z90 * sigma, sigma }
}

/** The share of a log-normal's requests at or under `ms`. */
export function lognormalCdf(ms, { mu, sigma }) {
  if (!(ms > 0)) return 0
  return normalCdf((Math.log(ms) - mu) / sigma)
}

/** The latency below which a share `p` of a log-normal's requests fall. */
export function lognormalQuantile(p, { mu, sigma }) {
  return Math.exp(mu + sigma * normalQuantile(p))
}

/** The share of a log-normal's requests that fall in bucket k. */
export function bucketShare(k, dist) {
  return lognormalCdf(edgeMs(k + 1), dist) - lognormalCdf(edgeMs(k), dist)
}
