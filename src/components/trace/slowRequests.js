// What the Slow Requests panel says and does, apart from drawing it: the scope
// a selection gives the list, how a selection reads, the Traces link it makes,
// and what the charts count. Pure, so every rule is tested on its own
// (slowRequests.test.js), and the panel only wires it to the screen.
//
// A selection is `{ lat, time }`:
//   lat   [k0, k1] — whole latency buckets, low to high (latencyBuckets.js), or
//         null for none
//   time  [fromMs, toMs) — whole columns of the heatmap, or null for the window
// A drag on the histogram sets `lat` and leaves `time`; a drag on the heatmap
// sets both. With neither, the list's scope is the window's slowest tenth.

import { edgeMs, bucketRangeLabel, fmtEdge } from '@/utils/latencyBuckets'
import { formatAbsoluteLabel } from '@/utils/timeRange'
import { fmtPct1 } from '@/components/charts/chartDefaults'

export const NO_SELECTION = { lat: null, time: null }

/** An edge of bucket k in whole nanoseconds — exact: the edges are 3-digit mantissas. */
export const edgeNs = k => Math.round(edgeMs(k) * 1e6)

export const hasSelection = sel => !!(sel?.lat || sel?.time)

/**
 * The list's scope: a latency band [loNs, hiNs) and a time span [fromMs, toMs).
 * With no latency selected the band is the window's slow tail, from
 * `slowNs` (the request-level p90) up. A time span stops at `nowMs` — the
 * instant tracesRange clips the Traces range to, so the two count the same
 * requests (Today's columns run on past now).
 */
export function selectionScope(sel, slowNs, nowMs = Infinity) {
  const band = sel?.lat
    ? { loNs: edgeNs(sel.lat[0]), hiNs: edgeNs(sel.lat[1] + 1) }
    : { loNs: slowNs ?? 0, hiNs: Infinity }
  return {
    ...band,
    fromMs: sel?.time ? sel.time[0] : -Infinity,
    toMs: sel?.time ? Math.min(sel.time[1], nowMs) : Infinity,
  }
}

/**
 * The selection in words, as the panel's sub-head says it:
 * "Latency: 8.8 ms - 27.83 ms, Time: Oct 26, 12:53:00 - Oct 26, 13:43:00".
 * The time is the app's 24-hour absolute form (formatAbsoluteLabel), where
 * production writes "12:53pm".
 */
export function selectionLabel(sel) {
  const parts = []
  if (sel?.lat) parts.push(`Latency: ${bucketRangeLabel(sel.lat[0], sel.lat[1])}`)
  if (sel?.time) parts.push(`Time: ${formatAbsoluteLabel(sel.time[0], sel.time[1])}`)
  return parts.join(', ')
}

/**
 * A latency as a query literal: milliseconds, as many decimals as it has, no
 * rounding — '8.799ms', '27.83ms', '519.412ms'. Never the label's rounded
 * '8.8 ms': the chip has to admit exactly the requests the panel counted, and
 * a request at 8.7995 ms sits in the 8.8 ms bucket.
 */
export function durationLiteral(ns) {
  return `${+(ns / 1e6).toFixed(6)}ms`
}

/**
 * The Traces page's filter for what the list draws from: the endpoint's server
 * spans on this service, and the latency band as `duration >= lo` and
 * `duration < hi` — half-open, as the buckets are. The time half is not a
 * filter: it rides as the app's range (`tracesRange`), the way every hand-off
 * into Traces carries time.
 */
export function tracesFilters({ serviceId, endpoint, scope }) {
  const filters = [
    { field: 'service', value: serviceId },
    { field: 'span_kind', value: 'server' },
    { field: 'span_name', value: endpoint },
  ]
  if (scope.loNs > 0) filters.push({ field: 'duration', op: 'gte', value: durationLiteral(scope.loNs) })
  if (Number.isFinite(scope.hiNs)) filters.push({ field: 'duration', op: 'lt', value: durationLiteral(scope.hiNs) })
  return filters
}

/**
 * The app range a time selection hands Traces: exactly the selected columns,
 * clipped to now. No five-minute floor: this is a selection the reader made,
 * not a zoom, and Traces opened on a wider span would list requests the panel
 * did not. Null when the selection has no time half (Traces keeps the range).
 */
export function tracesRange(sel, nowMs) {
  if (!sel?.time) return null
  const to = Math.min(sel.time[1], nowMs)
  if (!(to > sel.time[0])) return null
  return { kind: 'absolute', from: sel.time[0], to }
}

/**
 * The buckets the charts span: every bucket that holds a request, widened to
 * any selected bucket, so a selection carried into a window whose requests sit
 * elsewhere still shows as the bars it is (dimmed) rather than off the axis.
 */
export function axisRange(grid, sel) {
  let k0 = grid.total ? grid.k0 : Infinity
  let k1 = grid.total ? grid.k1 : -Infinity
  if (sel?.lat) { k0 = Math.min(k0, sel.lat[0]); k1 = Math.max(k1, sel.lat[1]) }
  return k1 >= k0 ? [k0, k1] : null
}

/**
 * The histogram's bars over an axis [k0, k1]: requests per bucket, over the
 * whole window or — with a time half selected — over just those columns, so
 * the bars always describe what the list is drawn from.
 */
export function histogramCounts(grid, axis, time = null) {
  const [k0, k1] = axis
  const out = new Array(k1 - k0 + 1).fill(0)
  grid.counts.forEach((row, c) => {
    if (time) {
      const ms = grid.cols[c].ms
      if (ms < time[0] || ms >= time[1]) return
    }
    for (let i = 0; i < row.length; i++) {
      const k = grid.k0 + i
      if (k >= k0 && k <= k1) out[k - k0] += row[i]
    }
  })
  return out
}

/** One bar's tooltip: its range, and its share of the requests the bars count. */
export function barReadout(k, count, total) {
  return { heading: bucketRangeLabel(k), share: total ? fmtPct1((count / total) * 100) : fmtPct1(0), count }
}

/** The columns a time span covers, as indices into the window's buckets: [c0, c1]. */
export function columnsOf(win, time) {
  if (!time) return null
  let c0 = -1, c1 = -1
  win.buckets.forEach((b, i) => {
    if (b.ms >= time[0] && b.ms < time[1]) { if (c0 < 0) c0 = i; c1 = i }
  })
  return c0 < 0 ? null : [c0, c1]
}

/** The span a run of columns covers, [fromMs, toMs), its last column whole. */
export function timeOfColumns(win, c0, c1) {
  const lo = Math.min(c0, c1)
  const hi = Math.max(c0, c1)
  return [win.buckets[lo].ms, Math.min(win.end * 1000, win.buckets[hi].ms + win.step * 1000)]
}

/** What an emptied list says: what the selection holds no request of, and where. */
export function emptyListText(sel, win) {
  const where = win?.isAbsolute ? 'this range' : (win?.label ?? 'this range').replace(/^Last /, 'the last ').toLowerCase()
  if (sel?.lat) {
    const [lo, hi] = [fmtEdge(sel.lat[0]), fmtEdge(sel.lat[1] + 1)]
    return sel.time
      ? `No requests between ${lo} and ${hi} in the selected time`
      : `No requests between ${lo} and ${hi} in ${where}`
  }
  return `No requests in ${where}`
}
