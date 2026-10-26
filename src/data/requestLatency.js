// One endpoint's requests, one by one: what the service page's Slow Requests
// panel counts into its latency histogram and heatmap, and lists under them.
//
// Nothing else in the mock layer holds requests. The RED table, the p90 chart
// and the Latency Drilldown are aggregates; the Traces stream is a few hundred
// seeded spans named after other routes. So this module models the requests
// themselves, from the endpoint's own calibrated profiles (services.js
// latencyProfiles), and every figure the panel shows is a count of them:
//
//   - Minute by minute. Minute s serves n_s = round(rpm at s) requests, and
//     their latency is log-normal with σ = SIGMA and p90 = the endpoint's p90
//     profile at s — the value the p90 chart above draws for that minute. So a
//     heatmap column's slow end moves exactly when the chart's line does.
//   - As order statistics. Request r of minute s sits at a quantile inside its
//     own stratum, (r + 0.1 … r + 0.9) / n_s, rounded to the microsecond — not
//     at the stratum's middle, or every minute's slowest request would land in
//     the same far-tail bucket and draw it taller than the one before it. The
//     strata do not overlap, so the ranks stay in order, and a band [lo, hi)
//     still holds a run of consecutive ranks, found from the CDF in O(1) and a
//     step or two either side, so a histogram over
//     seven days (10,080 minutes) is counted rather than enumerated — and the
//     list's rows, the bars and the cells are the same integer requests: a bar
//     that holds anything always yields rows.
//   - On the clock, not on a window. A minute is a minute of the clock before
//     BASE_TIME, so two windows that both cover it — the panel's, and Traces
//     opened on the selection's range — hold the very same requests.
//
// A request's trace id carries the request whole (when, whose, which endpoint,
// which rank, how long), so /trace/<id> and the panel's preview rebuild exactly
// the request listed, after a reload too, and a row's duration is its trace's.
//
// What this does not do is agree with the p90 card. The card is the table's
// p90-of-minutes (windowQuantile treats every request in a minute as having that
// minute's p90); the histogram's p90 is over requests. They agree within a few
// percent at 5 minutes and at a day or more, and part at an hour, where the
// incident covers a third of the window: see docs/decisions/slow-requests-
// latency.md, and requestLatency.test.js, which pins the gap.

import { BASE_TIME, minuteInstant, sampleAt, noiseAt, bucketIndexOf } from './timeWindow'
import { latencyProfiles, services } from './services'
import { makeSpan, httpServerTags, dbTags, DOMAIN_TAGS } from './tracesExplorer'
import { RUNTIME_HOSTS } from './runtimeHosts'
import { lognormalFromP90, lognormalQuantile, normalCdf, edgeMs, bucketOf } from '@/utils/latencyBuckets'
import { formatLocal } from '@/utils/timeRange'

/** The spread of one minute's latencies, in natural-log units. */
export const SIGMA = 0.5

const BASE_MS = BASE_TIME.getTime()
const MIN_SEC = 60
const floorMin = sec => Math.floor(sec / MIN_SEC) * MIN_SEC

// The most requests one minute holds. A rank is encoded in three hex digits.
const MAX_PER_MINUTE = 0xfff
// The furthest before BASE_TIME a request can be: its id's nine hex digits of ms.
const MAX_OFFSET_MS = 0xfffffffff

/* ---------- endpoints ---------- */

function hashStr(s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

// A service is named in an id by its place in the service list, which is
// static. An endpoint is named by a 16-bit hash of its name, so an endpoint the
// RED table does not list (one a log record's link arrived with) is addressable
// too, as long as this session has modelled it.
const SERVICE_IDS = services.map(s => s.id)
const epHash = name => hashStr(`ep:${name}`) & 0xffff
const ENDPOINTS = new Map()
const MODELS = new Map()
let redRegistered = false
// The RED endpoints decode without having been modelled: a trace link from the
// panel reopened after a reload has to find its endpoint before any page has
// drawn it.
function registerRed() {
  if (redRegistered) return
  redRegistered = true
  for (const e of latencyProfiles('red')) ENDPOINTS.set(epHash(e.endpoint), e.endpoint)
}

/**
 * The model of one endpoint's requests on one service's page.
 *
 * The service page draws payment-service's endpoints whichever service it is
 * on (its tables are not per service), so the model takes the page's service
 * as given: the requests, their traces and the Traces link all carry it, and
 * the three agree on whatever page they were made on.
 *
 * An endpoint the RED table does not list gets a flat profile from the figures
 * the page shows for it (`fallback`: `{ rpm, p90 }`), with its jitter seeded by
 * its name — never through derivedProfile, whose seeds are handed out in build
 * order and would shift every table built after it.
 */
export function endpointModel(serviceId, endpoint, fallback = null) {
  const key = `${serviceId}|${endpoint}`
  if (MODELS.has(key)) return MODELS.get(key)
  const svcIdx = SERVICE_IDS.indexOf(serviceId)
  if (svcIdx < 0) return null
  const red = latencyProfiles('red').find(e => e.endpoint === endpoint)
  let rpm = red?.rpm
  let p90 = red?.p90
  if (!red) {
    if (!(fallback?.rpm > 0) || !(fallback?.p90 > 0)) return null
    const seed = hashStr(`fallback:${endpoint}`) % 100000
    rpm = { baseline: fallback.rpm, peak: 1, noise: 0.06, seed, diurnal: true }
    p90 = { baseline: fallback.p90, peak: 1, noise: 0.06, seed: seed + 1 }
  }
  ENDPOINTS.set(epHash(endpoint), endpoint)
  const model = {
    key, serviceId, endpoint, svcIdx, ep: epHash(endpoint),
    seed: hashStr(key) % 1000003,
    rpm, p90, minutes: new Map(),
  }
  MODELS.set(key, model)
  return model
}

/* ---------- one minute ---------- */

/** Minute `t` (its start, in unix seconds): how many requests, and how slow. */
function minuteOf(model, t) {
  let m = model.minutes.get(t)
  if (!m) {
    const at = minuteInstant(t, BASE_MS)
    const n = Math.min(MAX_PER_MINUTE, Math.max(1, Math.round(sampleAt(model.rpm, at))))
    m = { t, n, seed: model.seed, dist: lognormalFromP90(sampleAt(model.p90, at), SIGMA) }
    model.minutes.set(t, m)
  }
  return m
}

/** Request r's quantile: somewhere in its own stratum of the minute. */
function uAt(m, r) {
  return (r + 0.1 + 0.8 * noiseAt(m.seed ^ 0x5bd1e995, m.t * 4096 + r)) / m.n
}

/** Request r's latency, in whole microseconds expressed as ns. */
function nsAt(m, r) {
  return Math.round(lognormalQuantile(uAt(m, r), m.dist) * 1000) * 1000
}

/**
 * Request r's instant: somewhere in its minute, unrelated to its rank — the
 * slowest request of a minute is not always its last.
 */
function msAt(model, m, r) {
  return m.t * 1000 + Math.floor(noiseAt(model.seed + r * 7919, m.t) * 60000)
}

/**
 * How many of a minute's requests are faster than `ns`: the first rank whose
 * latency is at least `ns`. From the CDF, with the microsecond rounding folded
 * in; checked against the quantiles themselves only when the answer sits within
 * a hair of a rank, where the two approximations could disagree.
 */
function rankAtLeast(m, ns) {
  if (!(ns > 0)) return 0
  if (ns === Infinity) return m.n
  // A latency is whole microseconds, so nsAt(r) >= ns  ⟺  it is at least the
  // microsecond ns rounds up to  ⟺  quantile >= (that − 0.5) µs  ⟺  uAt(r) >= p.
  // Never zero or less, so a bound under half a microsecond (`duration:>0`)
  // admits every request rather than taking the log of a negative.
  const q = (Math.ceil(ns / 1000) - 0.5) / 1000
  const p = normalCdf((Math.log(q) - m.dist.mu) / m.dist.sigma)
  // Every rank below n·p − 0.9 has its quantile under p; the answer is at most
  // two ranks on.
  let r = Math.min(m.n, Math.max(0, Math.floor(m.n * p - 0.9)))
  while (r < m.n && uAt(m, r) < p) r++
  // Where a quantile sits within a hair of p, the CDF and the quantile function
  // (two approximations) could disagree on its side: ask the latency itself.
  if ((r < m.n && uAt(m, r) - p < 1e-6) || (r > 0 && p - uAt(m, r - 1) < 1e-6)) {
    while (r > 0 && nsAt(m, r - 1) >= ns) r--
    while (r < m.n && nsAt(m, r) < ns) r++
  }
  return r
}

/* ---------- a window's minutes ---------- */

/**
 * Every minute that overlaps [fromMs, toMs), newest first, as either a whole
 * minute (every request of it is inside the span and has happened) or the
 * requests of it that are — the minute the window starts or stops in, the
 * minute now falls in, and every minute a sub-minute column splits.
 */
function minutesIn(model, fromMs, toMs, { splitBy = null } = {}) {
  const hi = Math.min(toMs, BASE_MS)
  // No earlier than a trace id can say: its offset is nine hex digits of ms
  // (about 795 days), and a request it cannot name would open someone else's
  // trace.
  const lo = Math.max(fromMs, BASE_MS - MAX_OFFSET_MS)
  const out = []
  if (!(hi > lo)) return out
  for (let t = floorMin(Math.floor((hi - 1) / 1000)); t * 1000 + 60000 > lo; t -= MIN_SEC) {
    const m = minuteOf(model, t)
    const whole = t * 1000 >= lo && t * 1000 + 60000 <= hi && !splitBy?.(t)
    if (whole) {
      out.push({ m, whole: true })
    } else {
      const reqs = []
      for (let r = 0; r < m.n; r++) {
        const ms = msAt(model, m, r)
        if (ms >= lo && ms < hi) reqs.push({ r, ms, ns: nsAt(m, r) })
      }
      out.push({ m, whole: false, reqs })
    }
  }
  return out
}

const winSpan = win => [win.start * 1000, win.end * 1000]

/* ---------- the charts ---------- */

const GRIDS = new WeakMap()

/**
 * The window's requests counted into latency buckets, per column of the
 * window: what the heatmap draws, and — summed over columns — the histogram.
 *
 * Returns `{ k0, k1, cols, counts, colTotals, bucketTotals, total }`:
 *   k0..k1        the buckets that hold any request (every row the list can
 *                 show has a bar)
 *   cols          the window's buckets (the heatmap's columns)
 *   counts[c][i]  requests in column c and bucket k0 + i
 *   colTotals[c], bucketTotals[i], total
 * Memoised per window and model.
 */
export function latencyGrid(model, win) {
  let byModel = GRIDS.get(win)
  if (!byModel) { byModel = new Map(); GRIDS.set(win, byModel) }
  if (byModel.has(model.key)) return byModel.get(model.key)

  const [fromMs, toMs] = winSpan(win)
  const stepMs = win.step * 1000
  const colOf = ms => bucketIndexOf(win, ms)
  // A minute splits when a column boundary falls inside it — every minute of a
  // 15 s window, and a minute straddling an odd absolute start.
  const splitBy = t => colOf(t * 1000) !== colOf(t * 1000 + 59999)
  const minutes = minutesIn(model, fromMs, toMs, { splitBy: stepMs < 60000 ? () => true : splitBy })

  let k0 = Infinity, k1 = -Infinity
  for (const it of minutes) {
    if (it.whole) {
      k0 = Math.min(k0, bucketOf(nsAt(it.m, 0) / 1e6))
      k1 = Math.max(k1, bucketOf(nsAt(it.m, it.m.n - 1) / 1e6))
    } else {
      for (const q of it.reqs) {
        const k = bucketOf(q.ns / 1e6)
        k0 = Math.min(k0, k); k1 = Math.max(k1, k)
      }
    }
  }
  const cols = win.buckets
  if (!(k1 >= k0)) {
    const empty = { k0: 0, k1: -1, cols, counts: cols.map(() => new Int32Array(0)), colTotals: cols.map(() => 0), bucketTotals: new Int32Array(0), total: 0 }
    byModel.set(model.key, empty)
    return empty
  }
  const width = k1 - k0 + 1
  const edgesNs = Array.from({ length: width + 1 }, (_, i) => Math.round(edgeMs(k0 + i) * 1e6))
  const counts = cols.map(() => new Int32Array(width))
  for (const it of minutes) {
    if (it.whole) {
      const row = counts[colOf(it.m.t * 1000)]
      if (!row) continue
      let prev = rankAtLeast(it.m, edgesNs[0])
      for (let i = 0; i < width; i++) {
        const next = rankAtLeast(it.m, edgesNs[i + 1])
        row[i] += next - prev
        prev = next
      }
    } else {
      for (const q of it.reqs) {
        const row = counts[colOf(q.ms)]
        if (row) row[bucketOf(q.ns / 1e6) - k0] += 1
      }
    }
  }
  const colTotals = counts.map(row => row.reduce((a, b) => a + b, 0))
  const bucketTotals = new Int32Array(width)
  for (const row of counts) for (let i = 0; i < width; i++) bucketTotals[i] += row[i]
  const total = colTotals.reduce((a, b) => a + b, 0)
  const grid = { k0, k1, cols, counts, colTotals, bucketTotals, total }
  byModel.set(model.key, grid)
  return grid
}

/**
 * The latency the window's slowest tenth of requests run at or above: the
 * list's scope when nothing is selected ("Slow Requests"). A percentile over
 * the window's requests, exact to the microsecond: the threshold is the latency
 * of the request at the 90% mark, so the scope holds the slowest ⌈N/10⌉
 * requests (a few more on a tie). Null for a window with no requests.
 */
export function slowThresholdNs(model, win) {
  const grid = latencyGrid(model, win)
  if (!grid.total) return null
  const want = grid.total - Math.floor(0.9 * grid.total)
  // The bucket the mark falls in, counting down from the slowest.
  let above = 0
  let i = grid.bucketTotals.length - 1
  for (; i > 0 && above + grid.bucketTotals[i] < want; i--) above += grid.bucketTotals[i]
  const lo = Math.round(edgeMs(grid.k0 + i) * 1e6)
  const hi = Math.round(edgeMs(grid.k0 + i + 1) * 1e6)
  // Within it, the latencies themselves.
  const inBucket = []
  for (const it of minutesIn(model, ...winSpan(win))) {
    if (it.whole) {
      for (let r = rankAtLeast(it.m, lo), end = rankAtLeast(it.m, hi); r < end; r++) inBucket.push(nsAt(it.m, r))
    } else {
      for (const q of it.reqs) if (q.ns >= lo && q.ns < hi) inBucket.push(q.ns)
    }
  }
  inBucket.sort((a, b) => b - a)
  return inBucket[Math.min(inBucket.length - 1, want - above - 1)] ?? lo
}

/* ---------- the list ---------- */

// The radical inverse in base 2: 0, .5, .25, .75, .125 … — a sequence that
// spreads its first N points over [0, 1) and keeps them among its first M for
// any M > N. Picking a list's rows by it means a longer list (or the Traces
// page's merge of 100) always contains a shorter one's rows.
function vdc(j) {
  let x = 0, f = 0.5
  for (let n = j; n > 0; n >>>= 1, f /= 2) if (n & 1) x += f
  return x
}

/**
 * The requests a list shows: up to `limit` of the window's requests in a
 * latency band [loNs, hiNs) and, optionally, a time span [fromMs, toMs) —
 * spread across the span rather than the newest N (browser-page.md: "N results
 * is a sample of the range"), newest first. A longer limit lists a superset of
 * a shorter one's rows.
 *
 * Rows: `{ traceId, endpoint, service, latencyMs, durationNs, timeMs, timestamp }`.
 */
export function requestSample(model, win, { loNs = 0, hiNs = Infinity, fromMs = -Infinity, toMs = Infinity } = {}, limit = 5) {
  const [wFrom, wTo] = winSpan(win)
  const runs = []
  let count = 0
  for (const it of minutesIn(model, Math.max(wFrom, fromMs), Math.min(wTo, toMs))) {
    if (it.whole) {
      const rLo = rankAtLeast(it.m, loNs)
      const n = rankAtLeast(it.m, hiNs) - rLo
      if (n > 0) { runs.push({ m: it.m, start: count, rLo, n }); count += n }
    } else {
      const reqs = it.reqs.filter(q => q.ns >= loNs && q.ns < hiNs)
      if (reqs.length) { runs.push({ m: it.m, start: count, reqs, n: reqs.length }); count += reqs.length }
    }
  }
  if (!count) return []
  const picks = new Set()
  if (count <= limit) {
    for (let i = 0; i < count; i++) picks.add(i)
  } else {
    for (let j = 0; picks.size < limit && j < limit * 64; j++) picks.add(Math.floor(vdc(j) * count))
  }
  const rows = []
  for (const idx of picks) {
    // The run that holds this index: runs are in order of `start`.
    let a = 0, b = runs.length - 1
    while (a < b) {
      const mid = (a + b + 1) >> 1
      if (runs[mid].start <= idx) a = mid
      else b = mid - 1
    }
    const run = runs[a]
    const at = idx - run.start
    const r = run.reqs ? run.reqs[at].r : run.rLo + at
    rows.push(requestRow(model, run.m, r))
  }
  return rows.sort((x, y) => y.timeMs - x.timeMs)
}

function requestRow(model, m, r) {
  const timeMs = msAt(model, m, r)
  const durationNs = nsAt(m, r)
  return {
    traceId: encodeRequestId({ offsetMs: BASE_MS - timeMs, svcIdx: model.svcIdx, ep: model.ep, rank: r, us: durationNs / 1000 }),
    endpoint: model.endpoint,
    service: model.serviceId,
    latencyMs: durationNs / 1e6,
    durationNs,
    timeMs,
    timestamp: formatLocal(timeMs, 'MMM DD, HH:mm:ss'),
  }
}

/* ---------- trace ids ---------- */

const hex = (n, width) => n.toString(16).padStart(width, '0')
const digest = (s, salts, len) => salts.map(k => hex(hashStr(`${k}:${s}`), 8)).join('').slice(0, len)
const xorHex = (a, b) => Array.from(a, (c, i) => (parseInt(c, 16) ^ parseInt(b[i], 16)).toString(16)).join('')

// 32 hex digits: a checksum, then the request masked by it — ms before
// BASE_TIME (9), service (2), endpoint (4), rank (3), latency in µs (7). The
// layout is errors.js's, with this module's own salts, for the same reasons:
// the offset is from BASE_TIME so a link reopened after a reload is the same
// distance from the incident, the mask makes it read as a trace id, and the
// checksum makes any other id decode to nothing. The latency rides in the id
// so a decoded trace never recomputes it: the trace is exactly as slow as the
// row it was opened from.
const PAYLOAD_HEX = 9 + 2 + 4 + 3 + 7
const CHECK_HEX = 32 - PAYLOAD_HEX
const CHECK_SALTS = ['q1', 'q2']
const MASK_SALTS = ['qm1', 'qm2', 'qm3', 'qm4']

export function encodeRequestId({ offsetMs, svcIdx, ep, rank, us }) {
  const payload = hex(offsetMs, 9) + hex(svcIdx, 2) + hex(ep, 4) + hex(rank, 3) + hex(Math.round(us), 7)
  const check = digest(payload, CHECK_SALTS, CHECK_HEX)
  return check + xorHex(payload, digest(check, MASK_SALTS, PAYLOAD_HEX))
}

/**
 * A request id's contents, or null for any id that is not one: `{ timeMs,
 * serviceId, endpoint, rank, durationNs }`. An endpoint this session has never
 * modelled (a link to a log-record endpoint, reopened after a reload) decodes
 * to null too, and its trace is borrowed like any unknown id's.
 */
export function decodeRequestId(id) {
  if (typeof id !== 'string' || !/^[0-9a-f]{32}$/.test(id)) return null
  const check = id.slice(0, CHECK_HEX)
  const payload = xorHex(id.slice(CHECK_HEX), digest(check, MASK_SALTS, PAYLOAD_HEX))
  if (digest(payload, CHECK_SALTS, CHECK_HEX) !== check) return null
  const read = (from, len) => parseInt(payload.slice(from, from + len), 16)
  const serviceId = SERVICE_IDS[read(9, 2)]
  registerRed()
  const endpoint = ENDPOINTS.get(read(11, 4))
  if (!serviceId || !endpoint) return null
  return { timeMs: BASE_MS - read(0, 9), serviceId, endpoint, rank: read(15, 3), durationNs: read(18, 7) * 1000 }
}

/* ---------- a request's trace ---------- */

function rndFrom(seed) {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0
    s = Math.imul(s ^ (s >>> 13), 0x297a2d39) >>> 0
    return ((s ^ (s >>> 16)) >>> 0) / 4294967296
  }
}
const hexOf = (rnd, len) => Array.from({ length: len }, () => Math.floor(rnd() * 16).toString(16)).join('')

// Where a payment request's time goes, per the Latency Drilldown's layers:
// quiet, and at the incident's worst, as time on the request's critical path.
// Redis is the one that carries the incident — the pool that ran dry — which
// is why a slow request's waterfall is mostly its GET.
const LAYERS = [
  { key: 'redis', quiet: 8, peak: 210 },
  { key: 'mysql', quiet: 22, peak: 35 },
  { key: 'twilio', quiet: 30, peak: 55 },
  { key: 'app', quiet: 18, peak: 40 },
]
const REDIS = { system: 'redis', op: 'GET', name: '0', key: 'payments:session', peer: 'payments-cache.us-east-1.cache.amazonaws.com', port: '6379' }
const MYSQL = { system: 'mysql', op: 'SELECT', name: 'payments', table: 'payments', peer: 'payments-primary.us-east-1.rds.amazonaws.com', port: '3306', user: 'payments' }
const TWILIO = 'POST api.twilio.com/2010-04-01/Messages.json'

/**
 * The span rows of the trace a request id stands for — the same rows every
 * time — or null when the id is not a request's, which leaves it to the rest of
 * buildTrace's lookup.
 *
 * The root is the endpoint's server span, exactly as long as the listed
 * request. Under it the controller, and in it the request's time apportioned
 * by the drilldown's layers at that instant: a Redis GET, a MySQL SELECT and
 * the app's own work in sequence, and the Twilio send dispatched alongside them
 * and awaited before the response, so it overlaps them as the drilldown says.
 * Every child ends inside the root.
 */
export function requestTraceRows(traceId) {
  const ref = decodeRequestId(traceId)
  if (!ref) return null
  const { serviceId, endpoint, durationNs } = ref
  const rnd = rndFrom(hashStr(traceId))
  const tagRnd = rndFrom(hashStr(`tags:${traceId}`))
  const host = RUNTIME_HOSTS[Math.floor(rnd() * RUNTIME_HOSTS.length)].id
  const version = 'v9.10.1'
  let seq = 0
  const nextId = () => `req_${traceId}_${seq++}`
  const newSpanId = () => hexOf(rnd, 16)
  const at = offNs => new Date(ref.timeMs + Math.floor(offNs / 1e6))
  const [method, route] = (() => {
    const i = endpoint.indexOf(' ')
    return i > 0 ? [endpoint.slice(0, i), endpoint.slice(i + 1)] : ['GET', endpoint]
  })()

  // The incident's weight at this request's minute.
  const w = minuteInstant(floorMin(Math.floor(ref.timeMs / 1000)), BASE_MS).w
  const weights = LAYERS.map(l => l.quiet + (l.peak - l.quiet) * w * (0.85 + 0.3 * rnd()))
  const total = weights.reduce((a, b) => a + b, 0)
  // A microsecond of headroom at each end for the dispatch and the response.
  const lead = Math.min(200000, durationNs * 0.02)
  const body = Math.max(1000, durationNs - 2 * lead)
  const share = key => body * weights[LAYERS.findIndex(l => l.key === key)] / total

  const rows = []
  const rootId = newSpanId()
  rows.push(makeSpan({
    id: nextId(), time: at(0), service: serviceId, spanName: endpoint, spanKind: 'server',
    durationNs, statusCode: 'UNSET', traceId, spanId: rootId, parentId: '', rootName: endpoint, host,
    extra: {
      ...httpServerTags(tagRnd, { method, route, status: method === 'POST' ? '201' : '200', host }),
      ...(DOMAIN_TAGS['payment-service']?.(tagRnd) ?? {}),
      'service.version': version,
      num_events: '0',
    },
  }))
  const ctrlId = newSpanId()
  rows.push(makeSpan({
    id: nextId(), time: at(lead / 2), service: serviceId, spanName: `PaymentController.${method.toLowerCase()}`, spanKind: 'internal',
    durationNs: durationNs - lead, statusCode: 'UNSET', traceId, spanId: ctrlId, parentId: rootId, rootName: endpoint, host,
    extra: {
      category: 'internal',
      'code.function': method.toLowerCase(),
      'code.namespace': 'com.cubedemo.payment.PaymentController',
      'otel.library.name': 'io.opentelemetry.spring-webmvc-5.3',
      'otel.library.version': '1.22.1-alpha',
      'service.version': version,
    },
  }))
  let cursor = lead
  const call = (spanName, dur, extra) => {
    rows.push(makeSpan({
      id: nextId(), time: at(cursor), service: serviceId, spanName, spanKind: 'client',
      durationNs: Math.round(dur), statusCode: 'UNSET', traceId, spanId: newSpanId(), parentId: ctrlId, rootName: endpoint, host,
      extra: { ...extra, 'service.version': version },
    }))
    cursor += dur
  }
  // The Twilio send starts with the request and is awaited at the end; of its
  // time, its own share is on the critical path and the rest overlaps the rest.
  const twilioStart = cursor
  call('GET', share('redis'), dbTags(REDIS))
  call('SELECT payments.payments', share('mysql'), dbTags(MYSQL))
  rows.push(makeSpan({
    id: nextId(), time: at(twilioStart), service: serviceId, spanName: TWILIO, spanKind: 'client',
    durationNs: Math.round(Math.min(body, share('twilio') * 1.8 + share('redis') * 0.1)), statusCode: 'UNSET',
    traceId, spanId: newSpanId(), parentId: ctrlId, rootName: endpoint, host,
    extra: {
      category: 'http',
      'http.method': 'POST',
      'http.url': 'https://api.twilio.com/2010-04-01/Messages.json',
      'http.status_code': '201',
      'net.peer.name': 'api.twilio.com',
      'net.peer.port': '443',
      'otel.library.name': 'io.opentelemetry.okhttp-3.0',
      'otel.library.version': '1.22.1-alpha',
      'service.version': version,
    },
  }))
  return rows
}

/**
 * The root span of each listed request, as rows of the Traces stream: what the
 * Traces page merges in when its query names one of this panel's endpoints
 * (tracesHandoff.js requestSamplesFor), so a "View in Traces" link lands on the
 * very requests the panel listed.
 */
export function requestSpanRows(rows) {
  return rows.map(r => requestTraceRows(r.traceId)?.[0]).filter(Boolean)
}
