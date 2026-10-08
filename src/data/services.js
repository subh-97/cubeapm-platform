import { statusForLatency, statusForErrorRate, worstStatus } from '@/utils/status'
import {
  REFERENCE_WINDOW, calibratePeak, peakIncidentWeight, pinToReference,
  valueAtWeight, windowMean, windowQuantile, windowSeries, noiseAt,
} from './timeWindow'
import { RUNTIME_HOSTS, hostPresence, DRAW_MIN } from './runtimeHosts'

const RANK = { healthy: 0, warning: 1, critical: 2 }

// `tags` are searchable through the service column that carries them, as
// `service.team:payments` — see SERVICE_FIELDS in utils/tableQuery.
const RAW_SERVICES = [
  { id: 'payment-service', name: 'payment-service', tags: { team: 'payments', tier: 'critical', oncall: 'pay-oncall' }, rpm: 452.7, latencyP90: 612, latencyAvg: 340, errorRatePct: 4.8, language: 'java', note: 'Elevated latency + error rate - Redis connection pool exhaustion (redis.0)' },
  { id: 'order-service', name: 'order-service', tags: { team: 'checkout', tier: 'critical', oncall: 'checkout-oncall' }, rpm: 476.4, latencyP90: 188, latencyAvg: 110, errorRatePct: 0.6, language: 'java', note: 'Secondary latency uptick - downstream call to payment-service' },
  { id: 'shipment-service', name: 'shipment-service', tags: { team: 'fulfilment', tier: 'standard' }, rpm: 477.1, latencyP90: 165, latencyAvg: 89, errorRatePct: 0.4, language: 'java', note: 'Secondary latency uptick - downstream call to payment-service' },
  { id: 'notify-service', name: 'notify-service', tags: { team: 'platform', tier: 'standard' }, rpm: 1900, latencyP90: 80, latencyAvg: 41, errorRatePct: 0.05, language: 'node', note: null },
  { id: 'search-service', name: 'search-service', tags: { team: 'discovery', tier: 'standard' }, rpm: 474.7, latencyP90: 96, latencyAvg: 58, errorRatePct: 0.05, language: 'go', note: null },
  { id: 'analytics-service', name: 'analytics-service', tags: { team: 'data', tier: 'batch' }, rpm: 1810, latencyP90: 27, latencyAvg: 14, errorRatePct: 0, language: 'python', note: null },
  { id: 'demo-nodejs-service', name: 'demo-nodejs-service', tags: { team: 'platform', tier: 'sandbox' }, rpm: 27.1, latencyP90: 13, latencyAvg: 9, errorRatePct: 0, language: 'node', note: null },
]

// What each service was doing when nothing was wrong, and how far the incident
// moved it. The figures in RAW_SERVICES above are not readings — they are what
// the last hour AVERAGES to, which is a different thing and the reason this
// table exists: a quiet p90 of 140 ms and a published p90 of 612 ms describe
// the same service, one before the Redis pool gave out and one across the hour
// that contains both.
//
// `quiet` is the value with the incident absent. `target` is the published
// figure the reference hour has to reproduce; the peak that gets there is
// solved for, never written down, so moving a published number here does not
// mean re-deriving an incident by hand.
//
// Only the three services on the incident path carry one. The rest are flat
// plus the daily traffic wave, which is why widening the range nudges their rpm
// and leaves their latency alone.
const SERVICE_PROFILES = {
  'payment-service': { quiet: { rpm: 452.7, p90: 140, avg: 78, err: 0.05 }, seed: 11 },
  'order-service': { quiet: { rpm: 476.4, p90: 120, avg: 72, err: 0.2 }, seed: 12 },
  'shipment-service': { quiet: { rpm: 477.1, p90: 110, avg: 64, err: 0.15 }, seed: 13 },
  'notify-service': { seed: 14 },
  'search-service': { seed: 15 },
  'analytics-service': { seed: 16 },
  'demo-nodejs-service': { seed: 17 },
}

const NOISE = { rpm: 0.08, p90: 0.1, avg: 0.1, err: 0.15 }

// A metric's profile: quiet value, the peak that makes the reference hour
// average to the published figure, then pinned so it does so exactly.
//
// p90 is pinned against the request-weighted percentile rather than the mean,
// because that is how it is read back. Its peak needs no solving: once a third
// of the window's requests are slow, the 90th percentile IS the slow plateau,
// so the plateau is simply the published figure.
function metricProfile(svc, key, { quantile = false, diurnal = false } = {}) {
  const prof = SERVICE_PROFILES[svc.id]
  const target = key === 'rpm' ? svc.rpm
    : key === 'p90' ? svc.latencyP90
      : key === 'avg' ? svc.latencyAvg : svc.errorRatePct
  const quiet = prof.quiet?.[key] ?? target
  const seed = prof.seed * 10 + { rpm: 1, p90: 2, avg: 3, err: 4 }[key]
  const base = {
    baseline: quiet,
    noise: NOISE[key],
    seed,
    diurnal,
    peak: quantile ? (quiet > 0 ? target / quiet : 1) : calibratePeak(quiet, target),
  }
  if (!(target > 0)) return { ...base, baseline: 0, peak: 1 }
  return quantile
    ? pinToReference(base, (w, pr) => windowQuantile(w, pr, 0.9, rateProfile(svc)), target)
    : pinToReference(base, windowMean, target)
}

// Built first and on its own, because the percentile weights by it.
function rateProfile(svc) {
  return metricProfile(svc, 'rpm', { diurnal: true })
}

const PROFILES = Object.fromEntries(RAW_SERVICES.map(svc => [svc.id, {
  rpm: rateProfile(svc),
  p90: metricProfile(svc, 'p90', { quantile: true }),
  avg: metricProfile(svc, 'avg'),
  err: metricProfile(svc, 'err'),
}]))

export const serviceProfile = id => PROFILES[id]

const round2 = v => Math.round(v * 100) / 100

/**
 * The worst this service got at any instant inside the window.
 *
 * Status is reported from this rather than from the averages, because status is
 * a different question from "what did this window average to". A 22-minute
 * outage is 0.2% of a week, so every average over a week is fine — but the
 * service did go down, and a monitoring product that quietly drops it to green
 * because you widened the chart has hidden the one thing you opened it to see.
 * Alerting works the same way: an alert fires on a breach, not on a weekly mean.
 *
 * So the numbers on screen stay honest window aggregates and the badge stays
 * red, and the two together say the useful thing — "the average is fine, this
 * still broke, narrow the range to see when".
 */
export function peakMetricsForWindow(win, serviceId) {
  const p = PROFILES[serviceId] ?? PROFILES['payment-service']
  // The window's newest instant: how recently it can see.
  const w = peakIncidentWeight((win.nowSec - win.end) / 60)
  return {
    latencyP90: Math.round(valueAtWeight(p.p90, w)),
    errorRatePct: round2(valueAtWeight(p.err, w)),
  }
}

function peakStatus(win, serviceId) {
  const peak = peakMetricsForWindow(win, serviceId)
  return worstStatus(
    statusForLatency(peak.latencyP90),
    statusForErrorRate(peak.errorRatePct),
  )
}

/**
 * Every service as the selected window saw it, worst first.
 *
 * The sort is the point of the page and survives the window: severity order,
 * never alphabetical. Because `status` is the window's worst instant rather
 * than its average, a range that contains the incident keeps payment-service at
 * the top of the list however wide it is — which is what the sort is for.
 *
 * Each row carries both readings. `status` is the breach; `aggregateStatus` is
 * what the figures beside it resolve to on their own, and where the two differ
 * the UI has something worth saying.
 */
export function servicesForWindow(win) {
  return RAW_SERVICES.map(s => {
    const p = PROFILES[s.id]
    const rpm = round2(windowMean(win, p.rpm))
    const latencyP90 = Math.round(windowQuantile(win, p.p90, 0.9, p.rpm))
    const latencyAvg = Math.round(windowMean(win, p.avg))
    const errorRatePct = round2(windowMean(win, p.err))
    const peak = peakMetricsForWindow(win, s.id)
    return {
      ...s,
      rpm, latencyP90, latencyAvg, errorRatePct,
      peakLatencyP90: peak.latencyP90,
      peakErrorRatePct: peak.errorRatePct,
      status: peakStatus(win, s.id),
      aggregateStatus: worstStatus(statusForLatency(latencyP90), statusForErrorRate(errorRatePct)),
    }
  }).sort((a, b) => (RANK[b.status] || 0) - (RANK[a.status] || 0)
    || (RANK[b.aggregateStatus] || 0) - (RANK[a.aggregateStatus] || 0)
    || b.errorRatePct - a.errorRatePct)
}

export function serviceSummaryForWindow(win) {
  const list = servicesForWindow(win)
  return {
    total: list.length,
    critical: list.filter(s => s.status === 'critical').length,
    warning: list.filter(s => s.status === 'warning').length,
    healthy: list.filter(s => s.status === 'healthy').length,
  }
}

/** The reference hour, for the places that read the fleet without a window. */
export const services = servicesForWindow(REFERENCE_WINDOW)
export const serviceSummary = serviceSummaryForWindow(REFERENCE_WINDOW)

/**
 * The Home page's health strip: one block per slice of the window, coloured by
 * the worst that slice got.
 *
 * Worst-instant, like the badge beside it, and for the same reason — a block
 * covering five hours of a seven-day window would average a 22-minute outage
 * down to amber, and the strip exists to answer "when did it break", which is a
 * question about instants. Derived from the same profile as every number on the
 * page rather than from a seeded random, so the red is where the incident was.
 */
export function healthHistoryForWindow(win, serviceId, blocks = 36) {
  const blockSec = win.spanSec / blocks
  const blockMin = blockSec / 60
  const p = PROFILES[serviceId] ?? PROFILES['payment-service']
  return Array.from({ length: blocks }, (_, i) => {
    const t = win.start + i * blockSec
    if (t >= win.nowSec) return 'neutral'
    // The block's newest edge, which is its worst moment.
    const w = peakIncidentWeight((win.nowSec - t) / 60 - blockMin)
    return worstStatus(
      statusForLatency(valueAtWeight(p.p90, w)),
      statusForErrorRate(valueAtWeight(p.err, w)),
    )
  })
}

export const externalDependencies = [
  { id: 'redis.0', name: 'redis.0', type: 'cache', status: 'critical' },
  { id: 'mysql.cubedemo', name: 'mysql.cubedemo', type: 'database', status: 'healthy' },
  { id: 'mongodb.cubedemo', name: 'mongodb.cubedemo', type: 'database', status: 'healthy' },
  { id: 'api.twilio.com', name: 'api.twilio.com', type: 'external-api', status: 'healthy' },
  { id: 'maps.googleapis.com', name: 'maps.googleapis.com', type: 'external-api', status: 'healthy' },
  { id: 'email.ap-south-1.amazonaws.com', name: 'email…amazonaws.com', type: 'external-api', status: 'healthy' },
]

export const serviceEdges = [
  ['order-service', 'payment-service'], ['order-service', 'notify-service'], ['order-service', 'mysql.cubedemo'],
  ['payment-service', 'redis.0'], ['payment-service', 'mysql.cubedemo'], ['payment-service', 'api.twilio.com'],
  ['shipment-service', 'payment-service'], ['shipment-service', 'notify-service'], ['shipment-service', 'maps.googleapis.com'],
  ['notify-service', 'analytics-service'], ['notify-service', 'mongodb.cubedemo'], ['search-service', 'mongodb.cubedemo'],
  ['demo-nodejs-service', 'mysql.cubedemo'], ['demo-nodejs-service', 'email.ap-south-1.amazonaws.com'],
]

// The apdex is the one metric with a ceiling, so it is written out rather than
// calibrated: a satisfaction score cannot be scaled past 1, and there is no
// published hourly figure for it to hit.
const APDEX_PROFILE = { baseline: 0.98, peak: 0.55, noise: 0.02, seed: 44, ceil: 1 }

/**
 * The five charts a service page draws, over whatever window is selected.
 *
 * Same profiles the KPI numbers aggregate, sampled instead of reduced — so the
 * chart and the number above it can never tell different stories, which is the
 * failure mode of keeping a static series next to a static headline figure.
 */
export function seriesForWindow(win, serviceId = 'payment-service') {
  const p = PROFILES[serviceId] ?? PROFILES['payment-service']
  return {
    rpm: windowSeries(win, p.rpm),
    latencyP90: windowSeries(win, p.p90),
    latencyAvg: windowSeries(win, p.avg),
    errorRatePct: windowSeries(win, p.err),
    apdex: windowSeries(win, APDEX_PROFILE, { round: 3 }),
  }
}

export const paymentServiceSeries = seriesForWindow(REFERENCE_WINDOW)

// Deploys roll one version at a time, so in any given bucket a single version is
// serving and the rest are idle. Charted by version, that paints the window in
// bands: the envelope is the metric, the colour is whatever was deployed then.
const ROLLOUT_VERSIONS = [
  'v2.48.21', 'v2.48.22', 'v2.48.23', 'v2.49.0', 'v2.49.1', 'v2.49.2', 'v2.49.3',
  'v2.49.4', 'v2.49.5', 'v2.49.6', 'v2.49.7', 'v2.49.8', 'v2.49.9', 'v2.49.10',
]

// Which version owns each bucket, in runs of three to six. A wider window is
// more buckets, so the same fourteen releases simply cover more of it — the
// rollout is not re-told at a different speed for each range.
function versionAt(points) {
  const out = []
  let s = 7, vi = 0
  const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280 }
  while (out.length < points) {
    const run = 3 + Math.floor(rnd() * 4)
    const v = ROLLOUT_VERSIONS[vi++ % ROLLOUT_VERSIONS.length]
    for (let i = 0; i < run && out.length < points; i++) out.push(v)
  }
  return out
}

// Spread an aggregate across the bands. `idle` is 0 where the chart stacks - the
// band has to reach the axis - and null where it draws lines, so a line stops at
// the end of its deploy instead of diving to zero.
function bandByVersion(series, owner, { idle = null, jitter = 0, seed = 1 } = {}) {
  let s = seed
  const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280 }
  return ROLLOUT_VERSIONS.map(v => ({
    label: v,
    series: series.map((d, i) => ({
      ...d,
      value: owner[i] === v
        ? Math.round(d.value * (1 + (rnd() - 0.5) * jitter) * 1000) / 1000
        : idle,
    })),
  }))
}

export function versionBandsForWindow(win) {
  const series = seriesForWindow(win)
  const n = win.buckets.length
  const owner = versionAt(n)
  // Traffic swells and settles across the window rather than holding flat. The
  // wave is phased to cross zero at the newest sample, so the chart still lands
  // on the rate the KPI card reports for "now".
  const rpmSwell = series.rpm.map((d, i) => {
    const x = i - n + 1
    return { ...d, value: d.value * (1 + 0.45 * Math.sin(x / 6.4) + 0.16 * Math.sin(x / 2.3)) }
  })
  return {
    rpm: bandByVersion(rpmSwell, owner, { idle: 0, jitter: 0.12, seed: 301 }),
    errorRatePct: bandByVersion(series.errorRatePct, owner, { jitter: 0.55, seed: 302 }),
    apdex: bandByVersion(series.apdex, owner, { jitter: 0.04, seed: 303 }),
  }
}

export const versionBands = versionBandsForWindow(REFERENCE_WINDOW)

const FLEET_PROFILES = {
  rpm: { baseline: 5700, noise: 0.05, seed: 101, diurnal: true },
  errorsPerMin: { baseline: 3, peak: 15, noise: 0.2, seed: 102 },
  p90: { baseline: 150, peak: 2.7, noise: 0.08, seed: 103 },
}

export function fleetSeriesForWindow(win) {
  return {
    rpm: windowSeries(win, FLEET_PROFILES.rpm),
    errorsPerMin: windowSeries(win, FLEET_PROFILES.errorsPerMin),
    p90: windowSeries(win, FLEET_PROFILES.p90),
  }
}

export const fleetSeries = fleetSeriesForWindow(REFERENCE_WINDOW)

export const latencyDrilldown = [
  { label: 'DB redis', ms: 210, color: '#EF4444' },
  { label: 'HTTP External (twilio)', ms: 120, color: '#3B82F6' },
  { label: 'DB mysql', ms: 35, color: '#A78BFA' },
  { label: 'App / internal', ms: 40, color: '#34D399' },
]

export const redEndpoints = [
  { endpoint: 'POST /v1/payments/:id/capture', totalReq: '3.9K', timeConsumedPct: 38, rpm: 64.2, p90: 780, avg: 590, errPct: 6.1 },
  { endpoint: 'GET /v1/payments/:id', totalReq: '6.1K', timeConsumedPct: 29, rpm: 101.8, p90: 690, avg: 410, errPct: 3.2 },
  { endpoint: 'POST /v1/payments', totalReq: '2.4K', timeConsumedPct: 21, rpm: 40.6, p90: 640, avg: 380, errPct: 5.8 },
  { endpoint: 'PATCH /v1/payments/:id', totalReq: '1.1K', timeConsumedPct: 8, rpm: 18.9, p90: 520, avg: 290, errPct: 4.4 },
  { endpoint: 'GET /v1/payments/:id/status', totalReq: '3.0K', timeConsumedPct: 4, rpm: 49.8, p90: 150, avg: 80, errPct: 0.3 },
]

export const infraCorrelation = [
  { host: 'ip-10-0-142-133', rpm: 151, latencyP90: 640, errorRatePct: 5.1, cpuUsedPct: 92, memUsedPct: 88 },
  { host: 'ip-10-0-142-2', rpm: 150, latencyP90: 598, errorRatePct: 4.6, cpuUsedPct: 89, memUsedPct: 84 },
  { host: 'ip-10-0-143-40', rpm: 151, latencyP90: 588, errorRatePct: 4.7, cpuUsedPct: 87, memUsedPct: 86 },
]

// Deliberately not in the same order by latency and by time: slowest-first and
// newest-first used to agree row for row, which made the panel's sort control
// look like it did nothing. The source order is neither, so "None" is visibly
// its own answer too.
export const slowRequests = [
  { endpoint: 'POST /v1/payments', latencyMs: 690, timestamp: '9m ago', traceId: 'c1e0553f' },
  { endpoint: 'POST /v1/payments/:id/capture', latencyMs: 812, timestamp: '6m ago', traceId: '9f2a1c7e' },
  { endpoint: 'GET /v1/payments/:id/status', latencyMs: 601, timestamp: '12m ago', traceId: '44d7bb10' },
  { endpoint: 'GET /v1/payments/:id', latencyMs: 743, timestamp: '1m ago', traceId: '7bd410aa' },
  { endpoint: 'PATCH /v1/payments/:id', latencyMs: 655, timestamp: '3m ago', traceId: '0a94eef2' },
]

// Requests that failed, not the slowest. Latencies sit around the service's
// baseline because a 500 generally returns fast - the signal is the failure,
// not the duration.
export const errorRequests = [
  { endpoint: 'POST /v1/payments/:id/capture', latencyMs: 70, timestamp: '2m ago', traceId: '469567625', status: 'critical' },
  { endpoint: 'POST /v1/payments/:id/capture', latencyMs: 141, timestamp: '5m ago', traceId: '1734459584', status: 'critical' },
  { endpoint: 'PATCH /v1/payments/:id', latencyMs: 72, timestamp: '5m ago', traceId: '836005139', status: 'critical' },
  { endpoint: 'GET /v1/payments/:id', latencyMs: 70, timestamp: '12m ago', traceId: '1252473574', status: 'critical' },
  { endpoint: 'POST /v1/payments', latencyMs: 73, timestamp: '7m ago', traceId: '1715416823', status: 'critical' },
]

/* ---- derived tables ---- */

// How far each metric sat below its published figure when nothing was wrong.
// Taken from payment-service's own profile, because every row in the tables
// below is a slice of the same traffic and the same incident — an endpoint does
// not have an outage of its own.
const QUIET_RATIO = { rpm: 1, p90: 612 / 140, avg: 340 / 78, err: 4.8 / 0.05, cpu: 1.35, mem: 1.08 }

let profileSeed = 900

/**
 * A calibrated profile from one number: what the last hour publishes. The quiet
 * value comes from the ratio table, the peak is solved for, and the result is
 * pinned so the reference hour still reads exactly what was passed in.
 *
 * A profile must be pinned against the aggregate it will be READ with. Pinning
 * a p90 as a mean and then reading it as a percentile reports the incident
 * plateau as if it were the hour's average, which is roughly 2.6x too high.
 */
function derivedProfile(published, kind, rate) {
  profileSeed += 7
  if (!(published > 0)) return { baseline: 0, peak: 1, seed: profileSeed }
  const quiet = published / (QUIET_RATIO[kind] ?? 1)
  const isQuantile = kind === 'p90'
  const base = {
    baseline: quiet,
    // Once a third of the window's requests are slow, the 90th percentile IS
    // the slow plateau — so for a percentile the plateau is simply the
    // published figure, and there is nothing to solve.
    peak: isQuantile ? published / quiet : calibratePeak(quiet, published),
    noise: 0.06,
    seed: profileSeed,
    diurnal: kind === 'rpm',
  }
  return isQuantile
    ? pinToReference(base, (w, pr) => windowQuantile(w, pr, 0.9, rate), published)
    : pinToReference(base, windowMean, published)
}

// Profiles are built once per published figure, not per render — calibration
// walks the reference window, and these tables are read on every tab switch.
const memo = new WeakMap()
function derivedTable(rows, spec) {
  if (memo.has(rows)) return memo.get(rows)
  const rateKey = Object.keys(spec).find(k => spec[k] === 'rpm')
  const built = rows.map(r => {
    const profiles = {}
    // The rate is built first, because a percentile weights by it.
    const rate = rateKey ? derivedProfile(r[rateKey], 'rpm') : null
    if (rateKey) profiles[rateKey] = rate
    for (const [key, kind] of Object.entries(spec)) {
      if (key === rateKey) continue
      profiles[key] = derivedProfile(r[key], kind, rate)
    }
    return { row: r, profiles }
  })
  memo.set(rows, built)
  return built
}

/**
 * Read a derived profile back with the aggregate it was pinned against. Pin and
 * read have to be the same question or the reference hour stops reproducing
 * what it publishes — the two directions of that mistake read about 2.6x high
 * and about 2.1x low respectively.
 */
function readProfile(win, profile, kind, rate) {
  return kind === 'p90' ? windowQuantile(win, profile, 0.9, rate) : windowMean(win, profile)
}

const round1 = v => Math.round(v * 10) / 10
const compact = v => (v >= 1000 ? `${(v / 1000).toFixed(1)}K` : String(Math.round(v)))

/** Minutes of the window that have actually happened. */
const windowMinutes = win => win.pastMinutes

const RED_SPEC = { rpm: 'rpm', p90: 'p90', avg: 'avg', errPct: 'err' }

export function redEndpointsForWindow(win) {
  const minutes = windowMinutes(win)
  return derivedTable(redEndpoints, RED_SPEC).map(({ row, profiles }) => {
    const rpm = round1(windowMean(win, profiles.rpm))
    return {
      ...row,
      rpm,
      // A percentile, taken the same way the service's own p90 is.
      p90: Math.round(windowQuantile(win, profiles.p90, 0.9, profiles.rpm)),
      avg: Math.round(windowMean(win, profiles.avg)),
      errPct: round1(windowMean(win, profiles.errPct)),
      // The one figure that GROWS with the window: a count, not a rate.
      totalReq: compact(rpm * minutes),
    }
  })
}

const EXT_SPEC = { rpm: 'rpm', p90: 'p90', avg: 'avg', errPct: 'err' }

export function externalEndpointsForWindow(win) {
  return derivedTable(externalEndpoints, EXT_SPEC).map(({ row, profiles }) => ({
    ...row,
    rpm: round1(windowMean(win, profiles.rpm)),
    p90: Math.round(windowQuantile(win, profiles.p90, 0.9, profiles.rpm)),
    avg: Math.round(windowMean(win, profiles.avg)),
    errPct: round1(windowMean(win, profiles.errPct)),
  }))
}

export function dbEndpointsForWindow(win) {
  return derivedTable(dbEndpoints, EXT_SPEC).map(({ row, profiles }) => ({
    ...row,
    rpm: round1(windowMean(win, profiles.rpm)),
    p90: Math.round(windowQuantile(win, profiles.p90, 0.9, profiles.rpm)),
    avg: round1(windowMean(win, profiles.avg)),
    errPct: round1(windowMean(win, profiles.errPct)),
  }))
}

const INFRA_SPEC = {
  rpm: 'rpm', latencyP90: 'p90', errorRatePct: 'err', cpuUsedPct: 'cpu', memUsedPct: 'mem',
}

export function infraCorrelationForWindow(win) {
  return derivedTable(infraCorrelation, INFRA_SPEC).map(({ row, profiles }) => ({
    ...row,
    rpm: Math.round(windowMean(win, profiles.rpm)),
    latencyP90: Math.round(windowQuantile(win, profiles.latencyP90, 0.9, profiles.rpm)),
    errorRatePct: round1(windowMean(win, profiles.errorRatePct)),
    cpuUsedPct: Math.round(windowMean(win, profiles.cpuUsedPct)),
    memUsedPct: Math.round(windowMean(win, profiles.memUsedPct)),
  }))
}

// The table publishes no average latency per host; it reads one off the p90 at
// this ratio, and the chart behind that cell is drawn the same way.
export const INFRA_AVG_OF_P90 = 0.55

/**
 * One host's metric sampled across the window, for the chart a cell of the
 * Infrastructure Correlation table opens on hover.
 *
 * That chart used to invent thirty points around the cell's value, so it drew
 * the last half hour whatever range the figure beside it was taken over.
 * Sampling the profile the figure is reduced from puts the two on one range.
 */
export function infraSeriesForWindow(win, host, key) {
  const entry = derivedTable(infraCorrelation, INFRA_SPEC).find(({ row }) => row.host === host)
  if (!entry) return []
  if (key === 'latencyAvg') {
    return windowSeries(win, entry.profiles.latencyP90).map(d => ({
      ...d,
      value: d.value == null ? null : Math.round(d.value * INFRA_AVG_OF_P90 * 100) / 100,
    }))
  }
  return entry.profiles[key] ? windowSeries(win, entry.profiles[key]) : []
}

// The drilldown's layers are time CONSUMED per request, and they add up to more
// than the latency the caller sees. The Twilio send is dispatched alongside the
// database work and only awaited at the end, so of its 120 ms just 55 ms is on
// the request's critical path; the other 65 ms overlaps redis and mysql. That is
// the gap the chart's info tip describes, and the reason its Total line runs
// below the top of the stack instead of along it.
//
// They are calibrated individually: only the Redis layer carries the incident,
// which is why over a week the stack collapses to the ~113 ms it consumes when
// quiet (78 ms of it on the critical path) and Redis stops being the thing you
// look at first.
const DRILLDOWN_QUIET = { 'DB redis': 8, 'HTTP External (twilio)': 65, 'DB mysql': 22, 'App / internal': 18 }

const DRILLDOWN_PROFILES = latencyDrilldown.map((l, i) => {
  const quiet = DRILLDOWN_QUIET[l.label] ?? l.ms
  return pinToReference(
    { baseline: quiet, peak: calibratePeak(quiet, l.ms), noise: 0.06, seed: 970 + i },
    windowMean, l.ms,
  )
})

export function latencyDrilldownForWindow(win) {
  return latencyDrilldown.map((l, i) => ({ ...l, ms: Math.round(windowMean(win, DRILLDOWN_PROFILES[i])) }))
}

/**
 * The same layers sampled per bucket, for the stacked chart above the list.
 *
 * The chart used to invent its own thirty points with the incident hard-coded
 * at index 18, which meant it drew the same ramp in the same place whatever
 * range was selected. Sampling the layers' own profiles ties it to the window
 * and to the totals underneath it.
 */
export function latencyDrilldownSeriesForWindow(win) {
  return latencyDrilldown.map((l, i) => ({
    label: l.label,
    color: l.color,
    series: windowSeries(win, DRILLDOWN_PROFILES[i]),
  }))
}

/**
 * The drilldown's Total: payment-service's own average latency, as the caller
 * sees it — the same profile the Avg Latency KPI is reduced from, so the two
 * read the same figure. Measured on its own rather than summed from the layers,
 * because the layers overlap and their sum overstates what the caller waited.
 */
export function latencyDrilldownTotalForWindow(win) {
  const avg = PROFILES['payment-service'].avg
  return { ms: Math.round(windowMean(win, avg)), series: windowSeries(win, avg) }
}

/** One endpoint's metric sampled across the window, for the RED graph view. */
export function redEndpointSeriesForWindow(win, key) {
  return derivedTable(redEndpoints, RED_SPEC).map(({ row, profiles }) => ({
    endpoint: row.endpoint,
    series: windowSeries(win, profiles[key]),
  }))
}

/**
 * The calibrated request-rate and error-rate profiles behind one of the derived
 * tables — 'red', 'db' or 'external' — one entry per row, unrounded.
 *
 * For the Errors page, which counts an endpoint's errors as its rate times its
 * error rate, bucket by bucket. It reads the very profiles these tables average
 * rather than calibrating its own beside them, so "6.1% of 64.2 rpm" here and
 * "235 errors" there are the same incident and the same traffic at every range,
 * not two curves that agree at Last 1 hour and drift apart after it. The table
 * outputs themselves are rounded to a decimal — fine for a rate, far too coarse
 * to multiply out over a week.
 *
 * All three are built, in the order the service page builds them, before one
 * is read. A derived profile's jitter seed is handed out in the order tables
 * are first built, so a session that opened the Errors page first and asked
 * for 'db' before 'external' would draw the DB and External tables — and every
 * error count off them — with each other's noise, and a week would read
 * differently depending on which page was opened first.
 */
export function errorRateProfiles(table) {
  // Inside the function: the DB and External rows are declared further down.
  const tables = {
    red: [redEndpoints, RED_SPEC],
    external: [externalEndpoints, EXT_SPEC],
    db: [dbEndpoints, EXT_SPEC],
  }
  if (!tables[table]) return []
  for (const [rows, spec] of Object.values(tables)) derivedTable(rows, spec)
  const [rows, spec] = tables[table]
  return derivedTable(rows, spec).map(({ row, profiles }) => ({
    endpoint: row.endpoint,
    rpm: profiles.rpm,
    err: profiles.errPct,
  }))
}

/**
 * Each external call's / DB operation's metric sampled across the window, for
 * the External and DB tabs' charts, keyed like their tables: 'rpm', 'avg',
 * 'errPct'.
 *
 * Those charts used to rescale the SERVICE's series by the row's figure over
 * the service's quiet value, which multiplied the incident too: a Redis call
 * at 3.2% errors became 64 × the service's 14% incident peak, about 900%. Each
 * row's own profile is the one its table figure is reduced from, so the line
 * and the number agree on every range — and a rate stays a rate.
 */
export function externalEndpointSeriesForWindow(win, key) {
  return derivedTable(externalEndpoints, EXT_SPEC).map(({ row, profiles }) => ({
    endpoint: row.endpoint,
    series: windowSeries(win, profiles[key]),
  }))
}

export function dbEndpointSeriesForWindow(win, key) {
  return derivedTable(dbEndpoints, EXT_SPEC).map(({ row, profiles }) => ({
    endpoint: row.endpoint,
    series: windowSeries(win, profiles[key]),
  }))
}

/** '9m ago' / '4h ago' / '3d ago' — how a sample request is dated. */
function agoLabel(minutes) {
  if (minutes < 60) return `${Math.max(1, Math.round(minutes))}m ago`
  if (minutes < 1440) return `${Math.round(minutes / 60)}h ago`
  return `${Math.round(minutes / 1440)}d ago`
}

// Sample requests are dated within the window and scaled with it. Their offsets
// stretch with the range — the rows sit in the newest fifth of it, because an
// example offered to click into should be a recent one — and the stretch is 1
// at the reference hour, so Last 1 hour still dates them exactly as before.
const SAMPLE_REACH_MIN = 60 / 5

function sampleRequests(win, rows, kind) {
  const stretch = Math.max(1, windowMinutes(win) / 5) / SAMPLE_REACH_MIN
  return derivedTable(rows, { latencyMs: kind }).map(({ row, profiles }) => ({
    ...row,
    latencyMs: Math.round(readProfile(win, profiles.latencyMs, kind)),
    timestamp: agoLabel(parseInt(row.timestamp, 10) * stretch),
  }))
}

export function slowRequestsForWindow(win) {
  return sampleRequests(win, slowRequests, 'p90')
}

// A failing request is fast — the signal is the failure, not the duration — so
// its latency tracks the service's average rather than its percentile.
export function errorRequestsForWindow(win) {
  return sampleRequests(win, errorRequests, 'avg')
}

export const SEARCH_INDEX = [
  { id: 'payment-service', name: 'payment-service', type: 'service', category: 'APM · Services', status: 'critical' },
  { id: 'order-service', name: 'order-service', type: 'service', category: 'APM · Services', status: 'warning' },
  { id: 'shipment-service', name: 'shipment-service', type: 'service', category: 'APM · Services', status: 'healthy' },
  { id: 'notify-service', name: 'notify-service', type: 'service', category: 'APM · Services', status: 'healthy' },
  { id: 'search-service', name: 'search-service', type: 'service', category: 'APM · Services', status: 'healthy' },
  { id: 'analytics-service', name: 'analytics-service', type: 'service', category: 'APM · Services', status: 'healthy' },
  { id: 'demo-nodejs-service', name: 'demo-nodejs-service', type: 'service', category: 'APM · Services', status: 'healthy' },
  { id: 'redis.0', name: 'redis.0', type: 'infra', category: 'Infrastructure · Cache', status: 'critical' },
  { id: 'mysql.cubedemo', name: 'mysql.cubedemo', type: 'infra', category: 'Infrastructure · DB', status: 'healthy' },
  { id: 'mongodb.cubedemo', name: 'mongodb.cubedemo', type: 'infra', category: 'Infrastructure · DB', status: 'healthy' },
  { id: 'traces', name: 'Distributed Traces', type: 'view', category: 'Traces', status: null },
  { id: 'alerts', name: 'Active Alerts - 2 critical', type: 'view', category: 'Alerts', status: 'critical' },
  { id: 'dashboards', name: 'Fleet Overview', type: 'view', category: 'Dashboards', status: null },
  { id: 'slos', name: 'Service Level Objectives', type: 'view', category: 'SLOs', status: null },
  { id: 'synthetic', name: 'Synthetic Monitors', type: 'view', category: 'Synthetic', status: null },
]

export const SEARCH_RECENT = ['payment-service', 'order-service', 'redis.0', 'traces']

export const FILTER_OPTS = {
  category: ['ALL', 'http', 'grpc', 'messaging', 'db'],
  host: ['ALL', 'ip-10-0-12.ap-south-1', 'ip-10-0-14.ap-south-1', 'legacy-host'],
  version: ['ALL', 'v7.12.10', 'v7.12.11', 'v7.13.1', 'v7.13.12', 'v7.13.2', 'v7.13.3', 'v7.13.4'],
}

export const externalEndpoints = [
  { endpoint: 'POST api.twilio.com/2010-04-01/Messages.json', kind: 'http', timeConsumedPct: 62, rpm: 41.2, avg: 214, p90: 380, errPct: 5.7 },
  { endpoint: 'GET api.twilio.com/2010-04-01/Accounts', kind: 'http', timeConsumedPct: 18, rpm: 22.9, avg: 84, p90: 140, errPct: 0.2 },
  { endpoint: 'POST maps.googleapis.com/maps/api/geocode', kind: 'http', timeConsumedPct: 12, rpm: 14.7, avg: 62, p90: 110, errPct: 0.4 },
  { endpoint: 'GET email.ap-south-1.amazonaws.com/v1/send', kind: 'http', timeConsumedPct: 8, rpm: 8.3, avg: 41, p90: 90, errPct: 0 },
]

// Which service endpoints originate each external call. Rows roll up the same
// metrics as the external row itself, split by the caller; percentages add to
// 100 within one external endpoint.
export const externalEndpointCallers = {
  'POST api.twilio.com/2010-04-01/Messages.json': [
    { endpoint: 'POST /v1/payments/:id/capture', kind: 'web', timeConsumedPct: 54, rpm: 22.3, avg: 222, errPct: 6.3 },
    { endpoint: 'POST /v1/payments', kind: 'web', timeConsumedPct: 31, rpm: 12.8, avg: 209, errPct: 5.4 },
    { endpoint: 'PATCH /v1/payments/:id', kind: 'web', timeConsumedPct: 15, rpm: 6.1, avg: 197, errPct: 4.1 },
  ],
  'GET api.twilio.com/2010-04-01/Accounts': [
    { endpoint: 'GET /v1/payments/:id', kind: 'web', timeConsumedPct: 71, rpm: 16.3, avg: 85, errPct: 0.2 },
    { endpoint: 'GET /v1/payments/:id/status', kind: 'web', timeConsumedPct: 29, rpm: 6.6, avg: 82, errPct: 0.2 },
  ],
  'POST maps.googleapis.com/maps/api/geocode': [
    { endpoint: 'POST /v1/payments', kind: 'web', timeConsumedPct: 48, rpm: 7.1, avg: 64, errPct: 0.5 },
    { endpoint: 'POST /v1/payments/:id/capture', kind: 'web', timeConsumedPct: 28, rpm: 4.1, avg: 61, errPct: 0.3 },
    { endpoint: 'GET /v1/payments/:id', kind: 'web', timeConsumedPct: 16, rpm: 2.3, avg: 60, errPct: 0.4 },
    { endpoint: 'PATCH /v1/payments/:id', kind: 'web', timeConsumedPct: 8, rpm: 1.2, avg: 58, errPct: 0.3 },
  ],
  'GET email.ap-south-1.amazonaws.com/v1/send': [
    { endpoint: 'POST /v1/payments/:id/capture', kind: 'web', timeConsumedPct: 100, rpm: 8.3, avg: 41, errPct: 0 },
  ],
}

// Every statement payment-service runs against its two stores, heaviest first.
// The first three feed the Detail tab's "Hits per request", so new rows go
// after them. Twenty-four is the long tail a real service has, and it is what
// the DB tab's charts are sized against: they draw the first few operations
// their width allows and hold the rest back (components/charts/seriesBudget.js).
// Redis rows sit on the incident path (the session pool is what failed), MySQL
// rows do not; time-consumed shares add to 100.
export const dbEndpoints = [
  { endpoint: 'SELECT payments.transactions', kind: 'mysql', timeConsumedPct: 38, rpm: 210.4, avg: 38, p90: 65, errPct: 0 },
  { endpoint: 'UPDATE payments.transactions', kind: 'mysql', timeConsumedPct: 15, rpm: 84.7, avg: 22, p90: 42, errPct: 0.1 },
  { endpoint: 'GET redis.session:*', kind: 'redis', timeConsumedPct: 10, rpm: 620.5, avg: 3.6, p90: 210, errPct: 3.2 },
  { endpoint: 'SETEX redis.session:*', kind: 'redis', timeConsumedPct: 6, rpm: 410.9, avg: 2.1, p90: 190, errPct: 2.8 },
  { endpoint: 'INSERT payments.transactions', kind: 'mysql', timeConsumedPct: 4, rpm: 40.6, avg: 18, p90: 34, errPct: 0.1 },
  { endpoint: 'SELECT payments.payment_methods', kind: 'mysql', timeConsumedPct: 3, rpm: 58.2, avg: 9.5, p90: 17, errPct: 0 },
  { endpoint: 'GET redis.idem:*', kind: 'redis', timeConsumedPct: 3, rpm: 142.8, avg: 2.8, p90: 186, errPct: 2.9 },
  { endpoint: 'INSERT payments.ledger_entries', kind: 'mysql', timeConsumedPct: 2, rpm: 64.2, avg: 6.4, p90: 12, errPct: 0 },
  { endpoint: 'SET redis.idem:*', kind: 'redis', timeConsumedPct: 2, rpm: 104.7, avg: 2.4, p90: 178, errPct: 2.6 },
  { endpoint: 'SELECT payments.refunds', kind: 'mysql', timeConsumedPct: 2, rpm: 22.6, avg: 14, p90: 27, errPct: 0 },
  { endpoint: 'INCR redis.ratelimit:*', kind: 'redis', timeConsumedPct: 2, rpm: 452.7, avg: 1.1, p90: 162, errPct: 2.1 },
  { endpoint: 'INSERT payments.audit_log', kind: 'mysql', timeConsumedPct: 1, rpm: 52.3, avg: 8, p90: 14, errPct: 0 },
  { endpoint: 'EXPIRE redis.ratelimit:*', kind: 'redis', timeConsumedPct: 1, rpm: 226.4, avg: 0.9, p90: 158, errPct: 2 },
  { endpoint: 'GET redis.token:*', kind: 'redis', timeConsumedPct: 1, rpm: 88.3, avg: 1.9, p90: 171, errPct: 2.4 },
  { endpoint: 'SELECT payments.idempotency_keys', kind: 'mysql', timeConsumedPct: 1, rpm: 40.6, avg: 5.2, p90: 10, errPct: 0 },
  { endpoint: 'INSERT payments.idempotency_keys', kind: 'mysql', timeConsumedPct: 1, rpm: 40.6, avg: 4.8, p90: 9, errPct: 0 },
  { endpoint: 'UPDATE payments.refunds', kind: 'mysql', timeConsumedPct: 1, rpm: 6.3, avg: 19, p90: 36, errPct: 0.1 },
  { endpoint: 'SELECT payments.ledger_entries', kind: 'mysql', timeConsumedPct: 1, rpm: 18.9, avg: 11.5, p90: 22, errPct: 0 },
  { endpoint: 'HGET redis.merchant:*', kind: 'redis', timeConsumedPct: 1, rpm: 101.8, avg: 1.6, p90: 166, errPct: 2.2 },
  { endpoint: 'SET redis.lock:payment:*', kind: 'redis', timeConsumedPct: 1, rpm: 64.2, avg: 1.4, p90: 152, errPct: 1.8 },
  { endpoint: 'DEL redis.session:*', kind: 'redis', timeConsumedPct: 1, rpm: 12.7, avg: 1.2, p90: 140, errPct: 1.5 },
  { endpoint: 'INSERT payments.webhooks_outbox', kind: 'mysql', timeConsumedPct: 1, rpm: 46.1, avg: 5.9, p90: 11, errPct: 0 },
  { endpoint: 'UPDATE payments.webhooks_outbox', kind: 'mysql', timeConsumedPct: 1, rpm: 44.8, avg: 4.1, p90: 8, errPct: 0 },
  { endpoint: 'DELETE payments.idempotency_keys', kind: 'mysql', timeConsumedPct: 1, rpm: 3.2, avg: 7.5, p90: 13, errPct: 0 },
]

// Which service endpoints originate each DB call. Same shape as
// externalEndpointCallers; percentages add to 100 within one DB endpoint.
export const dbEndpointCallers = {
  'SELECT payments.transactions': [
    { endpoint: 'GET /v1/payments/:id', kind: 'web', timeConsumedPct: 46, rpm: 97.0, avg: 39, errPct: 0 },
    { endpoint: 'GET /v1/payments/:id/status', kind: 'web', timeConsumedPct: 24, rpm: 50.6, avg: 36, errPct: 0 },
    { endpoint: 'POST /v1/payments/:id/capture', kind: 'web', timeConsumedPct: 18, rpm: 37.9, avg: 41, errPct: 0.1 },
    { endpoint: 'PATCH /v1/payments/:id', kind: 'web', timeConsumedPct: 12, rpm: 24.9, avg: 35, errPct: 0 },
  ],
  'UPDATE payments.transactions': [
    { endpoint: 'POST /v1/payments/:id/capture', kind: 'web', timeConsumedPct: 58, rpm: 49.1, avg: 23, errPct: 0.1 },
    { endpoint: 'PATCH /v1/payments/:id', kind: 'web', timeConsumedPct: 42, rpm: 35.6, avg: 21, errPct: 0 },
  ],
  'GET redis.session:*': [
    { endpoint: 'GET /v1/payments/:id', kind: 'web', timeConsumedPct: 38, rpm: 235.8, avg: 3.9, errPct: 3.4 },
    { endpoint: 'POST /v1/payments', kind: 'web', timeConsumedPct: 27, rpm: 167.5, avg: 3.5, errPct: 3.1 },
    { endpoint: 'POST /v1/payments/:id/capture', kind: 'web', timeConsumedPct: 21, rpm: 130.3, avg: 3.4, errPct: 3.0 },
    { endpoint: 'GET /v1/payments/:id/status', kind: 'web', timeConsumedPct: 14, rpm: 86.9, avg: 3.6, errPct: 3.3 },
  ],
  'SETEX redis.session:*': [
    { endpoint: 'POST /v1/payments', kind: 'web', timeConsumedPct: 44, rpm: 180.8, avg: 2.2, errPct: 2.9 },
    { endpoint: 'POST /v1/payments/:id/capture', kind: 'web', timeConsumedPct: 36, rpm: 147.9, avg: 2.1, errPct: 2.7 },
    { endpoint: 'PATCH /v1/payments/:id', kind: 'web', timeConsumedPct: 20, rpm: 82.2, avg: 2.0, errPct: 2.6 },
  ],
  'INSERT payments.audit_log': [
    { endpoint: 'POST /v1/payments', kind: 'web', timeConsumedPct: 42, rpm: 22.0, avg: 8, errPct: 0 },
    { endpoint: 'POST /v1/payments/:id/capture', kind: 'web', timeConsumedPct: 33, rpm: 17.3, avg: 8, errPct: 0 },
    { endpoint: 'PATCH /v1/payments/:id', kind: 'web', timeConsumedPct: 25, rpm: 13.0, avg: 7, errPct: 0 },
  ],
  'INSERT payments.transactions': [
    { endpoint: 'POST /v1/payments', kind: 'web', timeConsumedPct: 100, rpm: 40.6, avg: 18, errPct: 0.1 },
  ],
  'SELECT payments.payment_methods': [
    { endpoint: 'POST /v1/payments', kind: 'web', timeConsumedPct: 55, rpm: 32.0, avg: 9.1, errPct: 0 },
    { endpoint: 'POST /v1/payments/:id/capture', kind: 'web', timeConsumedPct: 45, rpm: 26.2, avg: 10.0, errPct: 0 },
  ],
  'GET redis.idem:*': [
    { endpoint: 'POST /v1/payments', kind: 'web', timeConsumedPct: 40, rpm: 57.1, avg: 2.8, errPct: 2.9 },
    { endpoint: 'POST /v1/payments/:id/capture', kind: 'web', timeConsumedPct: 35, rpm: 50.0, avg: 2.9, errPct: 2.9 },
    { endpoint: 'PATCH /v1/payments/:id', kind: 'web', timeConsumedPct: 25, rpm: 35.7, avg: 2.7, errPct: 2.9 },
  ],
  'INSERT payments.ledger_entries': [
    { endpoint: 'POST /v1/payments/:id/capture', kind: 'web', timeConsumedPct: 100, rpm: 64.2, avg: 6.4, errPct: 0 },
  ],
  'SET redis.idem:*': [
    { endpoint: 'POST /v1/payments', kind: 'web', timeConsumedPct: 45, rpm: 47.1, avg: 2.4, errPct: 2.6 },
    { endpoint: 'POST /v1/payments/:id/capture', kind: 'web', timeConsumedPct: 40, rpm: 41.9, avg: 2.5, errPct: 2.6 },
    { endpoint: 'PATCH /v1/payments/:id', kind: 'web', timeConsumedPct: 15, rpm: 15.7, avg: 2.3, errPct: 2.6 },
  ],
  'SELECT payments.refunds': [
    { endpoint: 'GET /v1/payments/:id', kind: 'web', timeConsumedPct: 70, rpm: 15.8, avg: 14, errPct: 0 },
    { endpoint: 'PATCH /v1/payments/:id', kind: 'web', timeConsumedPct: 30, rpm: 6.8, avg: 15, errPct: 0 },
  ],
  'INCR redis.ratelimit:*': [
    { endpoint: 'GET /v1/payments/:id', kind: 'web', timeConsumedPct: 37, rpm: 167.5, avg: 1.1, errPct: 2.1 },
    { endpoint: 'POST /v1/payments/:id/capture', kind: 'web', timeConsumedPct: 23, rpm: 104.1, avg: 1.2, errPct: 2.1 },
    { endpoint: 'GET /v1/payments/:id/status', kind: 'web', timeConsumedPct: 18, rpm: 81.5, avg: 1.0, errPct: 2.1 },
    { endpoint: 'POST /v1/payments', kind: 'web', timeConsumedPct: 15, rpm: 67.9, avg: 1.2, errPct: 2.1 },
    { endpoint: 'PATCH /v1/payments/:id', kind: 'web', timeConsumedPct: 7, rpm: 31.7, avg: 1.1, errPct: 2.1 },
  ],
  'EXPIRE redis.ratelimit:*': [
    { endpoint: 'GET /v1/payments/:id', kind: 'web', timeConsumedPct: 45, rpm: 101.9, avg: 0.9, errPct: 2 },
    { endpoint: 'POST /v1/payments/:id/capture', kind: 'web', timeConsumedPct: 30, rpm: 67.9, avg: 1.0, errPct: 2 },
    { endpoint: 'POST /v1/payments', kind: 'web', timeConsumedPct: 25, rpm: 56.6, avg: 0.8, errPct: 2 },
  ],
  'GET redis.token:*': [
    { endpoint: 'POST /v1/payments/:id/capture', kind: 'web', timeConsumedPct: 60, rpm: 53.0, avg: 1.9, errPct: 2.4 },
    { endpoint: 'POST /v1/payments', kind: 'web', timeConsumedPct: 40, rpm: 35.3, avg: 2.0, errPct: 2.4 },
  ],
  'SELECT payments.idempotency_keys': [
    { endpoint: 'POST /v1/payments', kind: 'web', timeConsumedPct: 100, rpm: 40.6, avg: 5.2, errPct: 0 },
  ],
  'INSERT payments.idempotency_keys': [
    { endpoint: 'POST /v1/payments', kind: 'web', timeConsumedPct: 100, rpm: 40.6, avg: 4.8, errPct: 0 },
  ],
  'UPDATE payments.refunds': [
    { endpoint: 'PATCH /v1/payments/:id', kind: 'web', timeConsumedPct: 100, rpm: 6.3, avg: 19, errPct: 0.1 },
  ],
  'SELECT payments.ledger_entries': [
    { endpoint: 'GET /v1/payments/:id', kind: 'web', timeConsumedPct: 60, rpm: 11.3, avg: 11.1, errPct: 0 },
    { endpoint: 'PATCH /v1/payments/:id', kind: 'web', timeConsumedPct: 40, rpm: 7.6, avg: 12.1, errPct: 0 },
  ],
  'HGET redis.merchant:*': [
    { endpoint: 'GET /v1/payments/:id', kind: 'web', timeConsumedPct: 50, rpm: 50.9, avg: 1.6, errPct: 2.2 },
    { endpoint: 'POST /v1/payments', kind: 'web', timeConsumedPct: 30, rpm: 30.5, avg: 1.7, errPct: 2.2 },
    { endpoint: 'POST /v1/payments/:id/capture', kind: 'web', timeConsumedPct: 20, rpm: 20.4, avg: 1.5, errPct: 2.2 },
  ],
  'SET redis.lock:payment:*': [
    { endpoint: 'POST /v1/payments/:id/capture', kind: 'web', timeConsumedPct: 100, rpm: 64.2, avg: 1.4, errPct: 1.8 },
  ],
  'DEL redis.session:*': [
    { endpoint: 'PATCH /v1/payments/:id', kind: 'web', timeConsumedPct: 100, rpm: 12.7, avg: 1.2, errPct: 1.5 },
  ],
  'INSERT payments.webhooks_outbox': [
    { endpoint: 'POST /v1/payments/:id/capture', kind: 'web', timeConsumedPct: 60, rpm: 27.7, avg: 5.5, errPct: 0 },
    { endpoint: 'PATCH /v1/payments/:id', kind: 'web', timeConsumedPct: 40, rpm: 18.4, avg: 6.5, errPct: 0 },
  ],
  'UPDATE payments.webhooks_outbox': [
    { endpoint: 'POST /v1/payments/:id/capture', kind: 'web', timeConsumedPct: 65, rpm: 29.1, avg: 3.8, errPct: 0 },
    { endpoint: 'PATCH /v1/payments/:id', kind: 'web', timeConsumedPct: 35, rpm: 15.7, avg: 4.7, errPct: 0 },
  ],
  'DELETE payments.idempotency_keys': [
    { endpoint: 'POST /v1/payments', kind: 'web', timeConsumedPct: 100, rpm: 3.2, avg: 7.5, errPct: 0 },
  ],
}

export const slowQueries = [
  { time: 'Jul 15, 22:38pm', query: 'SELECT * FROM `payments`.`transactions` WHERE `id` = ? AND `merchant_id` = ?', duration: 812 },
  { time: 'Jul 15, 22:37pm', query: 'GET redis.session:usr_a92f8b0c34', duration: 743 },
  { time: 'Jul 15, 22:36pm', query: 'UPDATE `payments`.`transactions` SET `status` = ?, `updated_at` = ? WHERE `id` = ?', duration: 690 },
  { time: 'Jul 15, 22:34pm', query: 'SETEX redis.session:usr_1f04b9a EX 900', duration: 655 },
  { time: 'Jul 15, 22:33pm', query: 'SELECT COUNT(*) FROM `payments`.`transactions` WHERE `status` = ?', duration: 601 },
]

export const tracesList = [
  { id: '97ce4645fe10f574e053bf91729f4750', endpoint: 'POST /v1/payments/:id/capture', durationMs: 812, time: 'Jul 15, 22:40pm', status: 'critical', service: 'payment-service' },
  { id: '5a1c2e08b4f36e7d0a19c8f572e13b04', endpoint: 'GET /v1/payments/:id', durationMs: 743, time: 'Jul 15, 22:39pm', status: 'critical', service: 'payment-service' },
  { id: 'c1e0553fbd11d2a7409e4571f8a3d90c', endpoint: 'POST /v1/payments', durationMs: 690, time: 'Jul 15, 22:37pm', status: 'warning', service: 'payment-service' },
  { id: '0a94eef2ba55f31c8079e12a7c6b91d4', endpoint: 'PATCH /v1/payments/:id', durationMs: 655, time: 'Jul 15, 22:35pm', status: 'warning', service: 'payment-service' },
  { id: '44d7bb10e8c93a2f1b6d478fa20c94ed', endpoint: 'GET /v1/payments/:id/status', durationMs: 220, time: 'Jul 15, 22:33pm', status: 'healthy', service: 'payment-service' },
  { id: '31f9c74a05b28e6d19aef732c04b8a5f', endpoint: 'POST /v1/payments/:id/capture', durationMs: 198, time: 'Jul 15, 22:31pm', status: 'healthy', service: 'payment-service' },
  { id: '8a2b5d1c9e7f30462a4d8091f5c73b26', endpoint: 'GET /v1/payments', durationMs: 176, time: 'Jul 15, 22:28pm', status: 'healthy', service: 'payment-service' },
]

export const traceDetail = {
  id: '97ce4645fe10f574e053bf91729f4750',
  service: 'payment-service',
  endpoint: 'POST /v1/payments/:id/capture',
  startTime: '2026-07-15 22:40:20.290',
  durationMs: 812,
  parentId: '2ac731453f4db3a5',
  spanId: 'be5ae0a07c69dcc',
  spans: [
    { level: 0, name: 'payment-service · POST /v1/payments/:id/capture (server)', durationMs: 812, offsetPct: 0, widthPct: 100, statusCode: 500, color: '#EF4444' },
    { level: 1, name: 'payment-service · PaymentsController.capture (internal)', durationMs: 806, offsetPct: 1, widthPct: 98, color: '#F59E0B' },
    { level: 2, name: 'redis · GET session:usr_1f04b9a (client)', durationMs: 512, offsetPct: 3, widthPct: 62, color: '#EF4444' },
    { level: 2, name: 'mysql · SELECT payments.transactions (client)', durationMs: 128, offsetPct: 67, widthPct: 16, color: '#3B82F6' },
    { level: 2, name: 'twilio · POST /Messages.json (client)', durationMs: 138, offsetPct: 84, widthPct: 15, color: '#A78BFA' },
  ],
  tags: [
    { k: 'http.method', v: 'POST' },
    { k: 'http.route', v: '/v1/payments/:id/capture' },
    { k: 'http.status_code', v: '500' },
    { k: 'http.target', v: '/v1/payments/tx_9f2a1c7e/capture' },
    { k: 'http.user_agent', v: 'curl/8.4' },
    { k: 'host.name', v: 'ip-10-0-142-133' },
    { k: 'host.arch', v: 'amd64' },
    { k: 'env', v: 'production' },
    { k: 'cube.environment', v: 'prod-ap-south-1' },
    { k: 'exception.type', v: 'redis.clients.jedis.exceptions.JedisPoolException' },
    { k: 'exception.message', v: 'Could not get a resource from the pool' },
  ],
}

// The hosts, their runs and how a window clips them live in runtimeHosts.js.
export { RUNTIME_HOSTS as runtimeHosts } from './runtimeHosts'

/* ---- JVM runtime ---- */

// Everything below is in BYTES, not megabytes. The panel's headers say
// "(bytes)" and a chart cannot talk its way out of its own axis: the previous
// set stored megabytes, the chart that read them printed a hardcoded unit, and
// a 470 MB heap came out as "used = 470 ms". Store the unit the header claims
// and the formatter has nothing to guess.
const MIB = 1024 * 1024

/**
 * The JVM's own view of itself, as the runtime panel draws it.
 *
 * Three kinds of series live here and they behave differently on purpose:
 *
 *   A LIMIT is configuration. `-Xmx` does not move because Redis is down, so a
 *   limit is flat across every window with only enough noise to prove it is
 *   sampled rather than drawn. It never carries the incident.
 *
 *   COMMITTED is what the JVM has taken from the OS. It moves, slowly, and only
 *   a little under pressure — the heap grows toward its limit over minutes, not
 *   within a bucket.
 *
 *   USED is the live metric, and it is the one that carries the incident. When
 *   payment-service's Redis pool gives out, threads block holding their request
 *   state: CPU climbs, the thread count climbs, old-gen occupancy climbs and the
 *   collector starts working for its living. That is the same event every other
 *   series on the platform samples — see INCIDENT_START_MIN in timeWindow.
 *
 * No profile here is `diurnal`, and that is a decision rather than an omission.
 * The daily wave is normalised against the REFERENCE hour, so a demo opened at
 * the quiet end of the day scales a week-wide window up to ~2.2x — fine for a
 * request rate, fatal for a metric that has to stay under its own `limit` line.
 * A used-vs-committed chart where used crosses committed is a chart that is
 * lying, so these stay bounded and the wave stays with the traffic metrics.
 *
 * `round` is read by the builder below, not by `sampleAt`: bytes, threads and
 * loaded classes are whole numbers, and two decimal places on a heap is eleven
 * characters of noise in a tooltip.
 */
const RUNTIME_PROFILES = {
  // A JVM on a multi-core host, idling around a quarter of its cores and
  // burning through them while requests pile up against the pool.
  cpuPct: { baseline: 24, peak: 1.8, noise: 0.1, seed: 201 },
  // Process RSS: the heap plus metaspace, code cache, thread stacks and the
  // JVM itself, so comfortably larger than anything in the heap charts.
  memUsedBytes: { baseline: 1150 * MIB, peak: 1.08, noise: 0.02, seed: 202, round: 0 },
  // Blocked threads are the shape of this incident, not a side effect of it.
  threadCount: { baseline: 50, peak: 1.5, noise: 0.06, seed: 203, round: 0 },
  classCount: {
    count: { baseline: 20400, noise: 0.008, seed: 204, round: 0 },
    // Near zero and staying there, like the reference. A long-lived JVM has
    // nothing left to unload; the series exists so that the day it is NOT zero
    // somebody notices.
    unloaded: { baseline: 0.8, noise: 1.5, seed: 205, round: 0 },
  },
  heap: {
    limit: { baseline: 1134 * MIB, noise: 0.002, seed: 206, round: 0 },
    committed: { baseline: 960 * MIB, noise: 0.01, seed: 207, round: 0 },
    // `used` is not written here — a heap is its generations, so it is summed
    // from them in the builder below.
  },
  // Metaspace, code cache and compressed class space. Grows with what the
  // application has loaded, which the incident does not change.
  nonHeapPoolUsed: { baseline: 182 * MIB, peak: 1.04, noise: 0.04, seed: 208, round: 0 },
  // Milliseconds of CPU the collector spent inside each bucket. Young
  // collections are constant and cheap; an old-generation collection is rare
  // and expensive, which is why this chart is drawn as two filled bands and why
  // the old-gen band only really appears once the incident is under way.
  gcCpuTime: {
    g1Old: { baseline: 1.1, peak: 4.5, noise: 1.4, seed: 209 },
    g1Young: { baseline: 6, peak: 2.6, noise: 1.0, seed: 210 },
  },
  g1OldGenHeap: {
    // Old gen may grow into the whole heap, so it shares the heap's limit.
    limit: { baseline: 1134 * MIB, noise: 0.002, seed: 211, round: 0 },
    committed: { baseline: 592 * MIB, noise: 0.012, seed: 212, round: 0 },
    // Objects that survived long enough to be promoted. Request state held by
    // threads waiting on a dead Redis pool is exactly that, which is the
    // incident's fingerprint on the heap.
    used: { baseline: 455 * MIB, peak: 1.14, noise: 0.045, seed: 213, round: 0 },
  },
  g1EdenHeap: {
    committed: { baseline: 336 * MIB, noise: 0.01, seed: 214, round: 0 },
    // Sampled flat here and given its sawtooth in the builder.
    used: { baseline: 190 * MIB, peak: 1.12, noise: 0.03, seed: 215, round: 0 },
  },
  g1SurvivorHeap: {
    committed: { baseline: 34 * MIB, noise: 0.015, seed: 216, round: 0 },
    used: { baseline: 20 * MIB, peak: 1.15, noise: 0.1, seed: 217, round: 0 },
  },
  // NIO buffers. Both pools sit just under their ceiling, which is the whole
  // point of charting them: the interesting day is the one where used meets
  // limit and allocation starts throwing.
  bufferDirect: {
    limit: { baseline: 10 * MIB, noise: 0.002, seed: 218, round: 0 },
    used: { baseline: 9.2 * MIB, peak: 1.02, noise: 0.03, seed: 219, round: 0 },
  },
  bufferMapped: {
    limit: { baseline: 2.5 * MIB, noise: 0.002, seed: 220, round: 0 },
    used: { baseline: 2.38 * MIB, noise: 0.02, seed: 221, round: 0 },
  },
}

/**
 * Eden fills and is emptied, over and over — the one shape in this panel that
 * is not a level but a cycle, and the reason a heap chart looks like a saw.
 *
 * The ramp is keyed on the BUCKET INDEX rather than on the clock. A young
 * collection runs seconds apart, so keyed on wall time the cycle would alias
 * into noise the moment a bucket covered half an hour, and the seven-day chart
 * would claim eden sits flat at its mean — which it never does at any instant.
 * Keyed on the index, the chart says "this is what eden does" at every width,
 * which is the true statement of the two.
 */
const EDEN_PERIOD = 6
const EDEN_LOW = 0.5
const EDEN_HIGH = 1.25

function edenSawtooth(series) {
  const span = EDEN_HIGH - EDEN_LOW
  return series.map((d, i) => ({
    ...d,
    value: d.value == null
      ? null
      : Math.round(d.value * (EDEN_LOW + span * ((i % EDEN_PERIOD) / (EDEN_PERIOD - 1)))),
  }))
}

/** Elementwise sum, null-preserving: a bucket that has not happened stays empty. */
function sumSeries(...parts) {
  return parts[0].map((d, i) => {
    let total = 0
    for (const p of parts) {
      const v = p[i].value
      if (v == null) return { ...d, value: null }
      total += v
    }
    return { ...d, value: Math.round(total) }
  })
}

// Walks the profile tree, sampling every leaf and keeping the nesting, so a
// chart reads `runtime.heap.used` and gets the same `{ m, t, label, exactTime,
// value }` rows every other series on the platform is drawn from.
function runtimeSeries(win, node) {
  if (node.baseline != null) return windowSeries(win, node, { round: node.round ?? 2 })
  return Object.fromEntries(
    Object.entries(node).map(([k, child]) => [k, runtimeSeries(win, child)]),
  )
}

/**
 * Every host together: the average per JVM across the hosts reporting in each
 * bucket. This is the calibrated series the panel has always drawn, untouched —
 * per-host series below are derived FROM it, not the other way round, so the
 * default view cannot drift when a host's story changes.
 *
 * An average and never a sum: every runtime metric is per JVM, and summing
 * would multiply each `-Xmx` limit line by the host count and turn "used vs
 * limit" into something no JVM is actually close to.
 */
function fleetRuntime(win) {
  const out = runtimeSeries(win, RUNTIME_PROFILES)
  out.g1EdenHeap.used = edenSawtooth(out.g1EdenHeap.used)
  // Heap used is its generations added up rather than a seventh profile that
  // happens to look about right. It costs nothing and it buys the one invariant
  // a reader can actually catch you breaking: the heap can never hold less than
  // the regions inside it, whichever window is selected.
  out.heap.used = sumSeries(out.g1OldGenHeap.used, out.g1EdenHeap.used, out.g1SurvivorHeap.used)
  return out
}

/**
 * How one host differs from the fleet, per bucket.
 *
 * Two families. LOAD (CPU, threads, GC time) follows how much traffic the JVM
 * takes; HEAP (generations, non-heap, RSS, classes) follows it at half the
 * amplitude, because a heap fills toward the same steady state whatever the
 * load. Both dip after a JVM starts and climb back: a load balancer's slow
 * start, and a fresh heap's old gen and metaspace filling. That warm-up is what
 * makes the restarted and the hand-added host visibly climb straight back into
 * the incident.
 *
 * The raw factors are normalised over the hosts drawn in each bucket, so the
 * plain mean of the per-host values is the fleet value — "All hosts" is
 * literally the average of what the rows show.
 */
const HOST_FAMILIES = {
  load: { base: h => h.load, depth: 0.35, tauMin: 2, salt: 1 },
  heap: { base: h => 1 + (h.load - 1) * 0.5, depth: 0.25, tauMin: 4, salt: 2 },
}

// Mean of 1 - depth·e^(-age/tau) over the seconds of [t0, t1] a host reported,
// in closed form, so a three-hour bucket averages the warm-up instead of
// sampling a dip at its edge.
function warmOver(lives, t0, t1, { depth, tauMin }) {
  let covered = 0
  let area = 0
  for (const l of lives) {
    const s = Math.max(t0, l.from)
    const e = Math.min(t1, l.to)
    if (e <= s) continue
    const mins = (e - s) / 60
    covered += mins
    if (!Number.isFinite(l.from)) { area += mins; continue }
    const a0 = (s - l.from) / 60
    const a1 = (e - l.from) / 60
    area += mins - depth * tauMin * (Math.exp(-a0 / tauMin) - Math.exp(-a1 / tauMin))
  }
  return covered > 0 ? area / covered : 1
}

function hostFactors(win, k) {
  const presence = RUNTIME_HOSTS.map(h => hostPresence(h, win))
  const drawn = (j, i) => (presence[j].bucketCoverage[i] ?? 0) >= DRAW_MIN
  const out = { config: win.buckets.map((_, i) => (drawn(k, i) ? 1 : null)) }
  for (const [fam, spec] of Object.entries(HOST_FAMILIES)) {
    out[fam] = win.buckets.map((b, i) => {
      if (!drawn(k, i)) return null
      const t1 = Math.min(b.t + b.durMin * 60, win.nowSec)
      const raw = j => {
        const h = RUNTIME_HOSTS[j]
        const jitter = 1 + (noiseAt(h.seed * 10 + spec.salt, b.t) - 0.5) * 0.04
        return spec.base(h) * warmOver(presence[j].lives, b.t, t1, spec) * jitter
      }
      let sum = 0
      let n = 0
      RUNTIME_HOSTS.forEach((_, j) => { if (drawn(j, i)) { sum += raw(j); n += 1 } })
      return raw(k) / (sum / n)
    })
  }
  return out
}

// Limits are configuration and identical on every host; so are the NIO pools,
// which sit at their caps everywhere, and the unloaded-class trickle.
function familyOf(path) {
  const [head] = path
  const key = path[path.length - 1]
  if (key === 'limit' || head === 'bufferDirect' || head === 'bufferMapped') return 'config'
  if (head === 'classCount' && key === 'unloaded') return 'config'
  if (head === 'cpuPct' || head === 'threadCount' || head === 'gcCpuTime') return 'load'
  return 'heap'
}

// Same walk as runtimeSeries, over sampled rows instead of profiles. Rows keep
// every key but `value` — the axis plots `t`, the tooltip reads it — and a
// null stays null, both for "has not happened" and "this host was not running".
function scopeTree(node, profile, path, factors) {
  if (Array.isArray(node)) {
    const f = factors[familyOf(path)]
    const p = 10 ** (profile?.round ?? 2)
    return node.map((row, i) => ({
      ...row,
      value: row.value == null || f[i] == null ? null : Math.round(row.value * f[i] * p) / p,
    }))
  }
  return Object.fromEntries(
    Object.entries(node).map(([k, child]) => [k, scopeTree(child, profile?.[k], [...path, k], factors)]),
  )
}

// used ≤ committed ≤ limit, bucket by bucket. The factors are shallow enough
// that this never fires today; it is here so retuning a host cannot draw a JVM
// holding more than it has taken from the OS.
function clampPools(node) {
  if (!node || Array.isArray(node) || typeof node !== 'object') return
  const cap = (series, ceiling) => series.map((r, i) => (
    r.value == null || ceiling[i]?.value == null ? r : { ...r, value: Math.min(r.value, ceiling[i].value) }
  ))
  if (node.committed && node.limit) node.committed = cap(node.committed, node.limit)
  const ceiling = node.committed ?? node.limit
  if (node.used && ceiling) node.used = cap(node.used, ceiling)
  Object.values(node).forEach(clampPools)
}

/**
 * @param {object} win
 * @param {string|null} [hostId] one of `runtimeHosts`. Anything else — null,
 *   undefined, an id that does not exist — is every host, averaged per JVM.
 */
export function runtimeMetricsForWindow(win, hostId = null) {
  const fleet = fleetRuntime(win)
  const k = RUNTIME_HOSTS.findIndex(h => h.id === hostId)
  if (k < 0) return fleet
  const out = scopeTree(fleet, RUNTIME_PROFILES, [], hostFactors(win, k))
  clampPools(out)
  out.heap.used = sumSeries(out.g1OldGenHeap.used, out.g1EdenHeap.used, out.g1SurvivorHeap.used)
  return out
}

export const runtimeMetrics = runtimeMetricsForWindow(REFERENCE_WINDOW)
