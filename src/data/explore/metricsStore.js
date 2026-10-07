// The synthetic metrics TSDB behind Explore's Metrics datasource.
//
// Its sibling `eventsStore` does the same job for logs and spans, and the two
// agree on purpose: the same seven services, the same endpoints and hosts, and
// the same incident at the same instant, so a service that is on fire in Logs
// is on fire here too.
//
// Three ideas carry it:
//
//   1. A SERIES IS A FUNCTION OF TIME, not an array. The query engine asks for
//      exact instants — whatever step the range worked out to — so nothing is
//      stored and any window is answerable at any resolution.
//
//   2. COUNTERS ARE INTEGRATED, NOT STORED. `rate` and `increase` read the
//      difference between two points of a cumulative series, so `sampleSeries`
//      integrates the rate across the instants it was asked for. The absolute
//      offset is arbitrary — every consumer takes differences — so accumulation
//      starts at zero at the first instant of each call, which keeps it O(1) in
//      memory however wide the range.
//
//   3. THE PUBLISHED FIGURES ARE THE CALIBRATION POINT. `services.js` says
//      payment-service is at 612 ms and 4.8% errors; those are what the default
//      Last 1 hour window must report. So the incident's severity is not
//      written down, it is SOLVED for: given the baseline and how much of the
//      last hour the incident covers, `solveFor` finds the multiplier that
//      makes the window average land on the published number. Widen the range
//      and the figure falls, as it should.

import { services } from '@/data/services'
import { BASE_TIME } from '@/data/observability'
import { parsePromql } from '@/utils/explore/promql'

const NAME = '__name__'
const ENV = 'UNSET'
const INSTANCE = 'cubeapm-0'

// ---------- Time shape (shared with eventsStore, deliberately identical) ----------

const NOW_MS = BASE_TIME.getTime()
const INCIDENT_START_MS = NOW_MS - 22 * 60_000
const INCIDENT_RAMP_MS = 4 * 60_000

/** 0 before payment-service's Redis pool starts failing, 1 once it fully has. */
function incidentFactor(tMs) {
  if (tMs <= INCIDENT_START_MS) return 0
  return Math.min(1, (tMs - INCIDENT_START_MS) / INCIDENT_RAMP_MS)
}

// ±18% over the day peaking at 14:00 local, ±8% for the weekend — so a 7-day
// range shows yesterday's shape beside today's instead of a flat band.
function dailyWave(tMs) {
  const d = new Date(tMs)
  const hours = d.getHours() + d.getMinutes() / 60
  const day = 1 + 0.18 * Math.cos(((hours - 14) / 24) * 2 * Math.PI)
  const wd = d.getDay()
  return day * (wd === 0 || wd === 6 ? 0.92 : 1.04)
}

// The wave is normalised against the reference hour, the same way
// `timeWindow.js` divides by its own WAVE_REFERENCE. Without this the published
// figures would only be reproduced at the time of day the wave happens to pass
// through 1 — open the page at 23:00 and every service would read 9% light
// against the number the service list, and every other page, is showing.
const WAVE_REFERENCE = (() => {
  let total = 0
  for (let m = 0; m < 60; m++) total += dailyWave(NOW_MS - m * 60_000)
  return total / 60
})()

const shapeOfDay = (tMs) => dailyWave(tMs) / WAVE_REFERENCE

// Jitter as a sum of two incommensurate sines rather than a random draw: a
// counter is an integral, and an integral of noise has to be consistent between
// two different samplings of the same series or `rate` would contradict itself
// depending on the step.
function jitter(seed, tMs) {
  const t = tMs / 1000
  const a = Math.sin(t / 97 + seed * 1.7)
  const b = Math.sin(t / 211 + seed * 0.61)
  return 1 + 0.05 * a + 0.03 * b
}

// The share of the last hour the incident covers, which is what turns a
// published figure into the severity that produces it.
const INCIDENT_SHARE = (() => {
  let total = 0
  for (let m = 0; m < 60; m++) total += incidentFactor(NOW_MS - m * 60_000)
  return total / 60
})()

/**
 * The multiplier that makes a quantity averaging `baseline` off-incident report
 * `target` across the reference hour. Exact for anything linear in the
 * multiplier — a rate, an error share, a mean.
 */
function solveFor(baseline, target) {
  if (!(baseline > 0) || !(target > 0) || INCIDENT_SHARE <= 0) return 1
  return Math.max(1, 1 + (target / baseline - 1) / INCIDENT_SHARE)
}

/** Bisection, for the quantities that are not linear in the multiplier. */
function solveNumerically(evaluate, target, lo = 1, hi = 64) {
  let a = lo
  let b = hi
  for (let i = 0; i < 40; i++) {
    const mid = (a + b) / 2
    if (evaluate(mid) < target) a = mid
    else b = mid
  }
  return (a + b) / 2
}

// ---------- Vocabulary (agrees with eventsStore and the service pages) ----------

const ROUTES = {
  'order-service': '/v1/order',
  'payment-service': '/v1/payment',
  'shipment-service': '/v1/shipment',
  'search-service': '/v1/search',
  'notify-service': '/v1/notify',
  'analytics-service': '/v1/analytics',
  'demo-nodejs-service': '/v1/cart',
}

// The infrastructure hosts `App.openLink` knows how to drill into, so a host
// label in Explore is a link that resolves rather than a dead end.
const HOSTS = {
  'payment-service': ['ip-10-0-142-133', 'ip-10-0-142-2'],
  'order-service': ['ip-10-0-142-133', 'ip-10-0-130-150'],
  'shipment-service': ['ip-10-0-143-40'],
  'notify-service': ['ip-10-0-130-150'],
  'search-service': ['ip-10-0-144-12'],
  'analytics-service': ['ip-10-0-129-151'],
  'demo-nodejs-service': ['minikube'],
}

// payment-service is mid-rollout, which gives the version label something to
// say: the canary is where the Redis pool is exhausted.
const VERSIONS = {
  'payment-service': [['v9.10.1', 0.8], ['v9.11.0', 0.2]],
}
const DEFAULT_VERSION = [['v9.10.1', 1]]

// How much likelier an error is on the canary than on the stable build.
const CANARY_ERROR_SCALE = 2.2

const errorScaleMean = (versions) =>
  versions.reduce((a, [name, share]) => a + share * (name === 'v9.11.0' ? CANARY_ERROR_SCALE : 1), 0) || 1

const EXCEPTIONS = {
  'payment-service': ['redis.clients.jedis.exceptions.JedisPoolException', 'java.lang.RuntimeException'],
  'order-service': ['java.lang.RuntimeException', 'com.twilio.exception.ApiException'],
  'shipment-service': ['java.lang.RuntimeException'],
  'notify-service': ['com.twilio.exception.ApiException'],
  'search-service': ['java.lang.RuntimeException'],
  'analytics-service': ['java.lang.RuntimeException'],
  'demo-nodejs-service': ['TimeoutError'],
}

const ERROR_CODES = ['500', '502', '504']

// What each service calls out to; `group_name` is how the reference labels a
// client span's target.
const DEPENDENCIES = {
  'payment-service': ['redis.0', 'mysql.cubedemo', 'api.twilio.com'],
  'order-service': ['mysql.cubedemo', 'payment-service'],
  'shipment-service': ['maps.googleapis.com', 'payment-service'],
  'notify-service': ['mongodb.cubedemo'],
  'search-service': ['mongodb.cubedemo'],
  'analytics-service': ['mysql.cubedemo'],
  'demo-nodejs-service': ['mysql.cubedemo'],
}

// Three endpoints carry the traffic and one batch job barely runs — the same
// long tail the real install has, and what makes a `root_name` group-by worth
// looking at.
function endpointsFor(service) {
  const route = ROUTES[service] || `/v1/${service}`
  return [
    { name: `POST ${route}`, share: 0.5, latency: 1 },
    { name: `GET ${route}/:id`, share: 0.32, latency: 0.6 },
    { name: `GET ${route}`, share: 0.17, latency: 0.8 },
    { name: `POST ${route}/batch`, share: 0.01, latency: 6 },
  ]
}

// ---------- Latency distribution ----------

// VictoriaMetrics names a histogram bucket with the interval it covers rather
// than an upper bound. Twelve buckets per decade is coarser than the real
// agent's eighteen; it keeps the series count sane and still resolves a
// percentile to within a few percent once the quantile interpolates inside.
const BUCKET_RATIO = 10 ** (1 / 12)
const BUCKET_LO = 1e-3

const expo = (v) => {
  const e = Math.floor(Math.log10(v))
  return `${(v / 10 ** e).toFixed(3)}e${e < 0 ? '-' : '+'}${String(Math.abs(e)).padStart(2, '0')}`
}

const BUCKETS = (() => {
  const out = []
  let lo = BUCKET_LO
  while (lo < 60) {
    const hi = lo * BUCKET_RATIO
    out.push({ lo, hi, vmrange: `${expo(lo)}...${expo(hi)}` })
    lo = hi
  }
  return out
})()

// Latency is log-normal: p50 and p90 together fix its centre and its spread,
// which is how a service summarised by two numbers comes back with that
// summary's shape.
function lognormal(p50, p90) {
  const sigma = Math.log(Math.max(p90, p50 * 1.05) / p50) / 1.2816
  return { mu: Math.log(p50), sigma }
}

// Φ, good to ~1e-7 — enough to split observations across buckets.
function normalCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z))
  const d = 0.3989423 * Math.exp((-z * z) / 2)
  const p = d * t * (1.330274 * t ** 4 - 1.821256 * t ** 3 + 1.781478 * t * t - 0.356538 * t + 0.3193815)
  return z > 0 ? 1 - p : p
}

const shareInBucket = ({ mu, sigma }, bucket) => {
  const z = (v) => normalCdf((Math.log(v) - mu) / sigma)
  return Math.max(0, z(bucket.hi) - z(bucket.lo))
}

// The p90 a window of buckets reports, read back the same way
// `histogram_quantile` reads it, so calibration and query agree.
function p90OfMixture(weights) {
  const total = weights.reduce((a, b) => a + b, 0)
  if (total <= 0) return NaN
  let seen = 0
  const want = 0.9 * total
  for (let i = 0; i < BUCKETS.length; i++) {
    if (seen + weights[i] >= want) {
      const { lo, hi } = BUCKETS[i]
      return weights[i] > 0 ? lo + ((hi - lo) * (want - seen)) / weights[i] : hi
    }
    seen += weights[i]
  }
  return BUCKETS[BUCKETS.length - 1].hi
}

// ---------- Per-service model ----------

// How much worse the incident makes payment-service, solved from what the
// service list publishes rather than written down.
function modelFor(svc) {
  const incident = svc.id === 'payment-service'
  const errBaseline = incident ? 0.0005 : Math.max(svc.errorRatePct / 100, 0)
  const errPeak = incident ? solveFor(errBaseline, svc.errorRatePct / 100) : 1

  // Pre-incident shape: p50 from the published average, p90 scaled down to
  // where it sat before the pool started failing.
  const p50 = Math.max(0.004, (incident ? 140 : svc.latencyAvg) / 1000)
  const baseP90 = (incident ? 150 : svc.latencyP90) / 1000

  let latencyPeak = 1
  if (incident) {
    // A percentile is not linear in the multiplier, so this one is bisected:
    // find the stretch that makes the whole hour read 612 ms.
    const dist = (mult) => lognormal(p50 * mult, baseP90 * mult)
    latencyPeak = solveNumerically((mult) => {
      const weights = BUCKETS.map(() => 0)
      for (let m = 0; m < 60; m++) {
        const w = incidentFactor(NOW_MS - m * 60_000)
        const d = dist(1 + (mult - 1) * w)
        BUCKETS.forEach((b, i) => { weights[i] += shareInBucket(d, b) })
      }
      return p90OfMixture(weights)
    }, svc.latencyP90 / 1000)
  }

  return { p50, p90: baseP90, errBaseline, errPeak, latencyPeak, incident }
}

const MODELS = new Map(services.map(s => [s.id, modelFor(s)]))

const latencyAt = (svc, tMs, endpointScale) => {
  const m = MODELS.get(svc.id)
  const mult = 1 + (m.latencyPeak - 1) * incidentFactor(tMs)
  return lognormal(m.p50 * mult * endpointScale, m.p90 * mult * endpointScale)
}

const errorShareAt = (svc, tMs) => {
  const m = MODELS.get(svc.id)
  return Math.min(0.95, m.errBaseline * (1 + (m.errPeak - 1) * incidentFactor(tMs)))
}

// Calls per second for one slice of a service's traffic.
function callRateAt(svc, tMs, share, seed) {
  const perSecond = (svc.rpm / 60) * share
  return perSecond * shapeOfDay(tMs) * jitter(seed, tMs)
}

// ---------- Series catalogue ----------

export const METRICS = [
  { name: 'cube_apm_calls_total', type: 'counter', apm: true, help: 'API calls tracked by CubeAPM. Use this to calculate request rates, e.g. RPM, error rate, etc.' },
  { name: 'cube_apm_latency_bucket', type: 'counter', apm: true, help: 'Latencies of API calls tracked by CubeAPM, segmented into buckets. Use this to calculate latency percentiles, e.g., p90 latency.' },
  { name: 'cube_apm_latency_count', type: 'counter', apm: true, help: 'Count of API calls tracked by CubeAPM. Use this to calculate estimates over sampled data.' },
  { name: 'cube_apm_latency_sum', type: 'counter', apm: true, help: 'Latencies of API calls tracked by CubeAPM. Use this to calculate estimates over sampled data.' },
  { name: 'cube_apm_latency_total', type: 'counter', apm: true, help: 'Latencies of API calls tracked by CubeAPM. Use this to calculate average latency.' },
  { name: 'cube_apm_errors_total', type: 'counter', apm: true, help: 'Errored API calls tracked by CubeAPM.' },
  { name: 'cube_apm_ingested_bytes_total', type: 'counter', apm: true, help: 'Amount of data ingested by CubeAPM. Use this to calculate data ingestion rate/cost.' },
  { name: 'system_cpu_utilization', type: 'gauge', apm: false, help: 'CPU in use on the host, 0-1.' },
  { name: 'system_memory_usage_bytes', type: 'gauge', apm: false, help: 'Memory in use on the host.' },
  { name: 'system_network_io_bytes_total', type: 'counter', apm: false, help: 'Bytes moved over the host network interfaces.' },
  { name: 'redis_connected_clients', type: 'gauge', apm: false, help: 'Clients connected to the Redis instance.' },
  { name: 'redis_commands_total', type: 'counter', apm: false, help: 'Commands processed by Redis.' },
  { name: 'mysql_threads_connected', type: 'gauge', apm: false, help: 'Threads connected to MySQL.' },
  { name: 'jvm_memory_used_bytes', type: 'gauge', apm: false, help: 'JVM heap in use.' },
  { name: 'k8s_pod_cpu_utilization', type: 'gauge', apm: false, help: 'CPU in use by the pod, 0-1.' },
]

// The rollups the `$__cube_apm_*` macros switch to once the step is coarse
// enough that raw samples would be read fifteen at a time.
const ROLLUP_SUFFIX = ':increase15m'
const ROLLUP_OF = {
  [`cube_apm_calls_total${ROLLUP_SUFFIX}`]: 'cube_apm_calls_total',
  'cube_apm_latency:increase15m_bucket': 'cube_apm_latency_bucket',
  'cube_apm_latency:increase15m_count': 'cube_apm_latency_count',
  'cube_apm_latency:increase15m_sum': 'cube_apm_latency_sum',
  'cube_apm_latency:increase15m_total': 'cube_apm_latency_total',
}

function buildSeries() {
  const out = []
  const add = (metric, kind, rate) => out.push({ metric, kind, rate, key: `k${out.length}` })

  for (const svc of services) {
    const model = MODELS.get(svc.id)
    const hosts = HOSTS[svc.id] || ['minikube']
    const versions = VERSIONS[svc.id] || DEFAULT_VERSION
    const exceptions = EXCEPTIONS[svc.id] || ['java.lang.RuntimeException']
    const endpoints = endpointsFor(svc.id)

    for (const ep of endpoints) {
      for (const host of hosts) {
        for (const [version, versionShare] of versions) {
          const share = (ep.share / hosts.length) * versionShare
          const seed = out.length + 1
          const base = { [NAME]: 'cube_apm_calls_total', env: ENV, service: svc.id, root_name: ep.name, span_kind: 'server', 'host.name': host, 'service.version': version, instance: INSTANCE }

          // The canary carries the failing pool, so the version label explains
          // the incident rather than merely labelling it. Normalised by the
          // traffic each version takes, so splitting the blame between versions
          // does not change what the service as a whole reports.
          const canary = svc.id === 'payment-service' && version === 'v9.11.0'
          const errScale = (canary ? CANARY_ERROR_SCALE : 1) / errorScaleMean(versions)

          add({ ...base, status_code: 'OK', http_code: '200' }, 'counter',
            (t) => callRateAt(svc, t, share, seed) * (1 - Math.min(0.95, errorShareAt(svc, t) * errScale)))

          if (model.errBaseline > 0) {
            // The shares have to add up to one, or the service would report
            // fewer errors than its own error rate says it has.
            const slices = exceptions.length === 1
              ? [1]
              : exceptions.map((_, i) => (i === 0 ? 0.7 : 0.3 / (exceptions.length - 1)))
            exceptions.forEach((exception, ei) => {
              const code = ERROR_CODES[ei % ERROR_CODES.length]
              const slice = slices[ei]
              add({ ...base, status_code: 'ERROR', http_code: code, exception }, 'counter',
                (t) => callRateAt(svc, t, share, seed) * Math.min(0.95, errorShareAt(svc, t) * errScale) * slice)
              add({ [NAME]: 'cube_apm_errors_total', env: ENV, service: svc.id, root_name: ep.name, exception, 'host.name': host }, 'counter',
                (t) => callRateAt(svc, t, share, seed) * Math.min(0.95, errorShareAt(svc, t) * errScale) * slice)
            })
          }

          // 4xx is a client's problem, not the service's, so it is traffic
          // rather than an error — the reference counts it the same way.
          add({ ...base, status_code: 'OK', http_code: '400' }, 'counter',
            (t) => callRateAt(svc, t, share, seed) * 0.012)
        }
      }

      // Latency carries fewer labels than calls do, which is also true of the
      // real agent: a histogram per host per version would be mostly empty.
      const epSeed = out.length + 1
      const epShare = ep.share
      const latencyBase = { env: ENV, service: svc.id, root_name: ep.name, span_kind: 'server' }
      const totalRate = (t) => callRateAt(svc, t, epShare, epSeed)

      for (const bucket of BUCKETS) {
        add({ ...latencyBase, [NAME]: 'cube_apm_latency_bucket', vmrange: bucket.vmrange }, 'counter',
          (t) => {
            const d = latencyAt(svc, t, ep.latency)
            const share = shareInBucket(d, bucket)
            return share > 1e-6 ? totalRate(t) * share : 0
          })
      }
      add({ ...latencyBase, [NAME]: 'cube_apm_latency_count' }, 'counter', totalRate)
      add({ ...latencyBase, [NAME]: 'cube_apm_latency_sum' }, 'counter',
        (t) => totalRate(t) * meanOf(latencyAt(svc, t, ep.latency)))
      add({ ...latencyBase, [NAME]: 'cube_apm_latency_total' }, 'counter',
        (t) => totalRate(t) * meanOf(latencyAt(svc, t, ep.latency)))
    }

    // Outgoing calls, which is what `group_name` is for.
    for (const target of DEPENDENCIES[svc.id] || []) {
      const seed = out.length + 1
      const slow = svc.id === 'payment-service' && target === 'redis.0'
      add({ [NAME]: 'cube_apm_calls_total', env: ENV, service: svc.id, span_kind: 'client', group_name: target, status_code: 'OK', 'host.name': hosts[0], instance: INSTANCE }, 'counter',
        (t) => callRateAt(svc, t, 0.4, seed) * (slow ? 1 + 0.6 * incidentFactor(t) : 1))
    }

    add({ [NAME]: 'cube_apm_ingested_bytes_total', env: ENV, service: svc.id, instance: INSTANCE }, 'counter',
      (t) => callRateAt(svc, t, 1, 7) * 1800)

    add({ [NAME]: 'jvm_memory_used_bytes', service: svc.id, instance: INSTANCE }, 'gauge',
      (t) => 5.2e8 * (1 + 0.1 * Math.sin(t / 900_000)) * jitter(3, t))
  }

  // Infrastructure, so the Advanced tab's "show all" has something real in it
  // and the Redis pool that caused all this is visible as a metric too.
  const allHosts = [...new Set(Object.values(HOSTS).flat())]
  allHosts.forEach((host, i) => {
    const critical = host === 'ip-10-0-142-133' || host === 'ip-10-0-142-2'
    add({ [NAME]: 'system_cpu_utilization', 'host.name': host, instance: INSTANCE }, 'gauge',
      (t) => Math.min(0.99, 0.32 * jitter(i + 11, t) * shapeOfDay(t) * (critical ? 1 + 1.4 * incidentFactor(t) : 1)))
    add({ [NAME]: 'system_memory_usage_bytes', 'host.name': host, instance: INSTANCE }, 'gauge',
      (t) => 7.4e9 * jitter(i + 23, t) * (critical ? 1 + 0.25 * incidentFactor(t) : 1))
    add({ [NAME]: 'system_network_io_bytes_total', 'host.name': host, instance: INSTANCE, direction: 'receive' }, 'counter',
      (t) => 1.6e6 * jitter(i + 31, t) * shapeOfDay(t))
    add({ [NAME]: 'k8s_pod_cpu_utilization', 'host.name': host, 'k8s.namespace.name': 'cubedemo' }, 'gauge',
      (t) => Math.min(0.99, 0.28 * jitter(i + 41, t) * (critical ? 1 + 1.2 * incidentFactor(t) : 1)))
  })

  add({ [NAME]: 'redis_connected_clients', instance: 'redis.0' }, 'gauge',
    (t) => Math.round(48 * jitter(5, t) * (1 + 3.4 * incidentFactor(t))))
  add({ [NAME]: 'redis_commands_total', instance: 'redis.0' }, 'counter',
    (t) => 2400 * jitter(6, t) * shapeOfDay(t))
  add({ [NAME]: 'mysql_threads_connected', instance: 'mysql.cubedemo' }, 'gauge',
    (t) => Math.round(32 * jitter(9, t) * shapeOfDay(t)))

  return out
}

const meanOf = ({ mu, sigma }) => Math.exp(mu + (sigma * sigma) / 2)

let SERIES = null
let BY_KEY = null

function allSeries() {
  if (!SERIES) {
    SERIES = buildSeries()
    BY_KEY = new Map(SERIES.map(s => [s.key, s]))
  }
  return SERIES
}

// ---------- Query surface ----------

/** Every metric name a query can select, rollups included. */
export function listMetricNames() {
  const names = new Set(allSeries().map(s => s.metric[NAME]))
  Object.keys(ROLLUP_OF).forEach(n => names.add(n))
  return Array.from(names).sort()
}

function matches(metric, m) {
  const value = metric[m.label] ?? ''
  if (m.op === '=') return value === m.value
  if (m.op === '!=') return value !== m.value
  let re
  try {
    re = new RegExp(`^(?:${m.value})$`)
  } catch {
    return false
  }
  return m.op === '=~' ? re.test(value) : !re.test(value)
}

/**
 * The series a set of matchers selects.
 *
 * A rollup name resolves to the raw series it summarises: the macro that
 * rewrote the name did so because the step got coarse, not because a different
 * thing is being measured.
 */
export function selectSeries(matchers = [], { start, end } = {}) {
  const resolved = matchers.map(m => (
    m.label === NAME && ROLLUP_OF[m.value] ? { ...m, value: ROLLUP_OF[m.value] } : m
  ))
  const asked = matchers.find(m => m.label === NAME && m.op === '=')?.value

  return allSeries()
    .filter(s => resolved.every(m => matches(s.metric, m)))
    .filter(s => hasDataIn(s, start, end))
    .map(s => ({
      // Answer under the name that was asked for, so `__name__` in the result
      // matches the query that produced it.
      metric: asked && ROLLUP_OF[asked] ? { ...s.metric, [NAME]: asked } : { ...s.metric },
      key: s.key,
    }))
}

// A series exists while it has something to report. An error series for a
// service that never errors is not empty — it is absent, which is why
// `default 0` has to be written by hand to get a zero line.
function hasDataIn(s, start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return true
  const mid = ((start + end) / 2) * 1000
  for (const t of [start * 1000, mid, end * 1000]) {
    const v = s.rate(t)
    if (Number.isFinite(v) && v > 0) return true
  }
  return false
}

/**
 * Sample a series at the given unix-second instants.
 *
 * A gauge reads directly. A counter is accumulated across the instants asked
 * for, by the midpoint rule — the series is the integral of its rate, and every
 * consumer of a counter takes a difference, so starting the accumulation at
 * zero on the first instant loses nothing and costs no memory.
 */
export function sampleSeries(key, timestamps) {
  allSeries()
  const s = BY_KEY.get(key)
  const out = new Array(timestamps.length)
  if (!s) return out.fill(NaN)

  if (s.kind === 'gauge') {
    for (let i = 0; i < timestamps.length; i++) out[i] = s.rate(timestamps[i] * 1000)
    return out
  }

  let total = 0
  out[0] = 0
  for (let i = 1; i < timestamps.length; i++) {
    const dt = timestamps[i] - timestamps[i - 1]
    if (dt > 0) {
      const midMs = ((timestamps[i] + timestamps[i - 1]) / 2) * 1000
      total += s.rate(midMs) * dt
    }
    out[i] = total
  }
  return out
}

// `match[]` arrives as selector text, the way Prometheus takes it on a metadata
// call; the query parser already knows how to read one.
function matchersOf(selectors) {
  const out = []
  for (const text of [].concat(selectors || [])) {
    if (!text) continue
    try {
      const ast = parsePromql(text)
      if (ast.type === 'selector') {
        const ms = ast.matchers.map(m => ({ ...m }))
        if (ast.name) ms.unshift({ label: NAME, op: '=', value: ast.name })
        out.push(ms)
      }
    } catch {
      // An unreadable match[] narrows nothing, which is what the server does.
    }
  }
  return out
}

function seriesMatching(selectors, span) {
  const sets = matchersOf(selectors)
  if (!sets.length) return allSeries().filter(s => hasDataIn(s, span?.start, span?.end))
  const seen = new Set()
  const out = []
  for (const set of sets) {
    for (const s of selectSeries(set, span || {})) {
      if (seen.has(s.key)) continue
      seen.add(s.key)
      out.push(s)
    }
  }
  return out
}

/**
 * The label names carried by the series `match[]` selects.
 *
 * `__name__` is one of them: it is an ordinary label that happens to hold the
 * metric name, the query language treats it as one, and the reference offers it
 * in the label pickers alongside the rest.
 */
export function labelNames(match = [], span = {}) {
  const names = new Set()
  for (const s of seriesMatching(match, span)) {
    Object.keys(s.metric).forEach(k => names.add(k))
  }
  return Array.from(names).sort()
}

/** The values one label takes across the series `match[]` selects. */
export function labelValues(label, match = [], span = {}) {
  if (!label) return []
  const values = new Set()
  for (const s of seriesMatching(match, span)) {
    const v = s.metric[label]
    if (v !== undefined && v !== '') values.add(v)
  }
  return Array.from(values).sort()
}

/** Exposed for tests and for anything that needs the bucket edges. */
export const LATENCY_BUCKETS = BUCKETS
