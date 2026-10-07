import { extraLogRecords } from './logRecordTypes'
import { isNoiseField } from '@/utils/logFields'
import {
  BASE_TIME, REFERENCE_WINDOW, calibratePeak, incidentWeight, pinToReference,
  sampleAt, sampleCount, spreadTimes, windowCount, windowMean, windowSeries,
} from './timeWindow'

// The anchor now lives with the time model; re-exported because every module
// that reads the mock stream has always imported it from here.
export { BASE_TIME }

const seededRnd = seed => {
  let s = seed
  return () => { s = (s * 9301 + 49297) % 233280; return s / 233280 }
}

/* ============ LOGS ============ */

const LOG_SERVICES = [
  'order', 'payment', 'shipment', 'search', 'auth', 'cart', 'catalog', 'checkout',
  'inventory', 'notification', 'pricing', 'recommendation', 'reviews', 'session',
  'user-profile', 'warehouse',
]

const SVC_ENDPOINT = { order: '/v1/order', payment: '/v1/payment', shipment: '/v1/shipment', search: '/v1/search' }

const STACKTRACE_TMPL = `com.cubedemo.db.ConnectionPool: Connection refused to database host
\tat com.cubedemo.db.ConnectionPool.acquire(ConnectionPool.java:84)
\tat com.cubedemo.service.Repository.findById(Repository.java:112)
\tat com.cubedemo.service.RequestHandler.handle(RequestHandler.java:57)
\tat com.cubedemo.server.HttpServer.dispatch(HttpServer.java:203)`

function makeMessage(level, svc, ts) {
  if (level === 'error') return 'Failed connecting to database'
  if (level === 'warn') return `received HTTP 400 from https://notify.cubedemo.com${SVC_ENDPOINT[svc]}`
  return `processing request {\n  details: {\n    service: {\n      name: ${svc}\n    }\n  }\n  displayMessage: Transaction committed\n  systemMessage: request handled successfully\n  timestamp: ${ts}\n} operation successful`
}

function hexId(rnd, len) {
  return Array.from({ length: len }, () => Math.floor(rnd() * 16).toString(16)).join('')
}

// The level mix is not flat across the window. While the pool is exhausted
// almost a third of what the stream carries is an error; outside the incident
// it is a few percent. Shares are calibrated so the reference hour still reads
// 12% error / 26% warn — the mix this page has always shown — which leaves a
// five-minute window dominated by errors and a seven-day one almost free of
// them, from the same two numbers.
const LEVEL_MIX = {
  error: { baseline: 0.03, target: 0.12 },
  warn: { baseline: 0.17, target: 0.26 },
}
const ERROR_PEAK = calibratePeak(LEVEL_MIX.error.baseline, LEVEL_MIX.error.target)
const WARN_PEAK = calibratePeak(LEVEL_MIX.warn.baseline, LEVEL_MIX.warn.target)

function levelAt(minutesAgo, r) {
  const w = incidentWeight(minutesAgo)
  const error = LEVEL_MIX.error.baseline * (1 + (ERROR_PEAK - 1) * w)
  const warn = LEVEL_MIX.warn.baseline * (1 + (WARN_PEAK - 1) * w)
  if (r < error) return 'error'
  if (r < error + warn) return 'warn'
  return 'info'
}

/**
 * The request-log sample for a window.
 *
 * A sample, not the stream: the volume chart above the table says the window
 * holds hundreds of thousands of records, and the table shows a few hundred of
 * them spread across the same window. Taking the newest few hundred instead
 * would collapse every range wider than an hour onto the same last hour, which
 * is exactly the blindness this work exists to remove.
 */
function generateLogs(win) {
  const n = sampleCount(win, 3)
  const times = spreadTimes(win, n)
  const rnd = seededRnd(17)
  const endMs = win.end * 1000
  const rows = []
  for (let i = 0; i < n; i++) {
    const t = new Date(times[i])
    const minutesAgo = (endMs - times[i]) / 60000
    const svc = LOG_SERVICES[Math.floor(rnd() * LOG_SERVICES.length)]
    const level = levelAt(minutesAgo, rnd())
    const isError = level === 'error'
    const ts = t.toISOString()
    const message = makeMessage(level, svc, ts)
    const traceId = hexId(rnd, 32)
    const httpStatus = isError ? 500 : level === 'warn' ? 400 : 200
    const durationMs = isError
      ? Math.round(800 + rnd() * 2400)
      : level === 'warn'
        ? Math.round(180 + rnd() * 520)
        : Math.round(20 + rnd() * 160)
    const tags = {
      env: 'UNSET',
      'log.level': level,
      service: svc,
      endpoint: SVC_ENDPOINT[svc],
      path: SVC_ENDPOINT[svc],
      'http.status': httpStatus,
      duration_ms: durationMs,
      trace_id: traceId,
      'log.exception.type': isError ? 'ConnectionRefusedException' : '',
      'log.stacktrace': isError ? STACKTRACE_TMPL : '',
    }
    rows.push({
      id: `log_${i}_${Math.floor(rnd() * 100000)}`,
      time: t,
      timeStr: `${t.getHours().toString().padStart(2, '0')}:${t.getMinutes().toString().padStart(2, '0')}:${t.getSeconds().toString().padStart(2, '0')}.${Math.floor(rnd() * 1000).toString().padStart(3, '0')}`,
      dateStr: t.toISOString().slice(0, 10),
      level,
      service: svc,
      message,
      tags,
    })
  }
  return rows
}

/**
 * Every record the window holds, request logs and the other shapes together.
 *
 * Request logs keep their own seed so adding another record type never
 * reshuffles them. The rest are merged in and the whole stream re-sorted,
 * because a drawer that only ever sees one record shape is not being tested.
 */
export function logRowsForWindow(win) {
  const extras = extraLogRecords({
    baseTime: BASE_TIME,
    rnd: seededRnd(43),
    // The special records spread across whatever window is being looked at, so
    // a k8s event is not always sitting in the same minute of the same hour.
    spread: n => spreadTimes(win, n),
  })
  return [...generateLogs(win), ...extras].sort((a, b) => b.time - a.time)
}

// Records per minute by level. `info` carries the daily traffic wave; `warn`
// and `error` carry the incident, calibrated to the rates the reference hour
// has always averaged.
const LOG_RATE = {
  info: { baseline: 42.5, noise: 0.55, seed: 29, diurnal: true },
  warn: { baseline: 3.4, target: 5, noise: 0.55, seed: 31 },
  error: { baseline: 0.55, target: 2, noise: 0.6, seed: 37 },
}

/**
 * The stacked histogram over the window. A bar covers its own span in minutes
 * stacks that many minutes of the rate — which is why a seven-day chart reads
 * in hundreds of thousands and an hour's reads in tens.
 */
export function logVolumeForWindow(win) {
  return win.buckets.map(b => {
    const info = b.future ? 0 : Math.round(sampleAt(LOG_RATE.info, b) * b.durMin)
    const warn = b.future ? 0 : Math.round(sampleAt(LOG_RATE.warn, b) * b.durMin)
    const error = b.future ? 0 : Math.round(sampleAt(LOG_RATE.error, b) * b.durMin)
    return {
      m: b.m, t: b.t, label: b.label, exactTime: b.exactTime,
      info, warn, error, total: info + warn + error,
    }
  })
}

/** What the level bands total over a window, without drawing it. */
export function logTotalsForWindow(win) {
  const info = Math.round(windowCount(win, LOG_RATE.info))
  const warn = Math.round(windowCount(win, LOG_RATE.warn))
  const error = Math.round(windowCount(win, LOG_RATE.error))
  return { info, warn, error, total: info + warn + error }
}

// The reference hour, for the modules that want the stream without choosing a
// window: the facet-shape tests, and Explore's own store.
export const logRows = logRowsForWindow(REFERENCE_WINDOW)
export const logVolume = logVolumeForWindow(REFERENCE_WINDOW)

// Facets are derived from the rows rather than listed by hand, so a new tag
// becomes filterable without anyone remembering to add it here.
//
// A field earns a facet only when picking one of its values would actually
// narrow the result set, and only when its values can be listed at all:
//   • more distinct values than this is a search box, not a checkbox list
//   • a value too long to fit a row cannot be read in one
//   • a single value present on every row filters nothing — but a single value
//     present on only some rows does, which is why absence is counted too
const FACET_MAX_DISTINCT = 40
const FACET_MAX_VALUE_LEN = 60

// Severity reads worst-first, matching how services are ordered elsewhere;
// every other facet leads with its most common value.
const FACET_VALUE_ORDER = { 'log.level': ['error', 'warn', 'info'] }

// A field whose every value is an identity - a uuid, a span id, a timestamp, an
// opaque token - is not a filter. Picking one of its values selects the single
// record you already had.
//
// This is a test on the SHAPE of the values, deliberately not on how many there
// are. Counting cannot separate the two cases here: on the seeded rows both
// `object.metadata.uid` and `object.reason` carry four distinct values across
// the four rows that have them, so any ratio strict enough to drop the uuids
// also drops SuccessfulCreate / BackOff, which is one of the more useful facets
// on the page. The absolute cap above already handles the other direction, a
// field with more values than anyone would scroll.
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/
const HEX_RUN = /^[0-9a-f]+$/i

export function isIdentityValue(v) {
  if (ISO_INSTANT.test(v)) return true
  // A long unbroken hex run is a trace or span id.
  if (v.length >= 16 && HEX_RUN.test(v)) return true
  // A uuid, tested by composition rather than by the 8-4-4-4-12 layout: the
  // seeded pod uids run a ten-character final group, and real telemetry carries
  // malformed ids too. Enough hex once the dashes come out is the durable
  // signal; the exact grouping is not.
  const undashed = v.replace(/-/g, '')
  if (undashed.length >= 24 && HEX_RUN.test(undashed)) return true
  // An opaque token: long, unbroken, and drawing on upper, lower and digits at
  // once. Real category names are shorter or carry a separator.
  return v.length >= 24 && /^[A-Za-z0-9+/=_-]+$/.test(v)
    && /[a-z]/.test(v) && /[A-Z]/.test(v) && /\d/.test(v)
}

// Numbers need the count after all, because shape cannot tell a measurement
// from a code: 200 and 24000000 are both just digits. What separates them is
// that a status code repeats across rows and a duration does not, so a numeric
// field is only rejected once nearly every row carrying it has its own value.
// This is why `http.status` survives (3 values over 193 rows) and `duration`
// does not (4 over 4).
const MEASUREMENT_RATIO = 0.6

export function isNumericValue(v) {
  return /^-?\d+(\.\d+)?$/.test(v)
}

export function buildLogFacets(rows) {
  const out = {}
  // Keys come from every row, not just the first. Records arrive in several
  // shapes now - a k8s event, a database span and a request log carry different
  // tags - so sampling the newest row would hand the panel whichever shape
  // happened to be on top.
  //
  // Agent boilerplate is left out: the SDK's resource block is identical on
  // every row of its kind, so it makes a facet whose only value is already
  // implied by the rows carrying it.
  const keys = new Set()
  for (const row of rows) for (const k of Object.keys(row.tags ?? {})) {
    if (!isNoiseField(k)) keys.add(k)
  }
  for (const key of keys) {
    const counts = new Map()
    let populated = 0
    for (const row of rows) {
      const raw = key === 'log.level' ? row.level : key === 'service' ? row.service : row.tags[key]
      if (raw == null || raw === '') continue
      populated++
      const v = String(raw)
      counts.set(v, (counts.get(v) || 0) + 1)
    }
    const values = [...counts.keys()]
    if (counts.size === 0 || counts.size > FACET_MAX_DISTINCT) continue
    if (values.some(v => v.length > FACET_MAX_VALUE_LEN)) continue
    if (counts.size === 1 && populated === rows.length) continue
    if (values.every(isIdentityValue)) continue
    if (counts.size / populated >= MEASUREMENT_RATIO && values.every(isNumericValue)) continue

    const fixed = FACET_VALUE_ORDER[key]
    out[key] = [...counts.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => fixed
        ? fixed.indexOf(a.value) - fixed.indexOf(b.value)
        : b.count - a.count || a.value.localeCompare(b.value))
  }
  return out
}

export const logFacets = buildLogFacets(logRows)

export const logTotals = {
  total: logVolume.reduce((a, b) => a + b.total, 0),
  error: logVolume.reduce((a, b) => a + b.error, 0),
  warn: logVolume.reduce((a, b) => a + b.warn, 0),
  info: logVolume.reduce((a, b) => a + b.info, 0),
}

/* ============ INFRA ============ */

const AWS_SERVICES = ['ALB', 'AmazonMQ', 'API Gateway', 'Cloud AMQP', 'CloudFront', 'DocumentDB', 'DynamoDB', 'EBS', 'EC2', 'ECS', 'ECS OpenTelemetry', 'EFS', 'ElastiCache', 'OpenSearch', 'Kinesis Data Streams', 'Lambda', 'MSK', 'NLB', 'RDS', 'Redshift', 'Redshift Serverless', 'SQS']
const GCP_SERVICES = ['ALB', 'CloudSQL', 'Compute Engine', 'Memorystore', 'Pub/Sub', 'Run Functions']
const K8S_RESOURCES = ['Cluster', 'CronJob', 'Daemonset', 'Deployment', 'HPA', 'Ingress Controller Nginx', 'Job', 'Node', 'Pod', 'PVC', 'Replicaset', 'Statefulset']

const slugify = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')

export const INFRA_SOURCES = [
  { id: 'aws', label: 'AWS', kind: 'cloud', group: true, children: AWS_SERVICES.map(s => ({ id: `aws-${slugify(s)}`, label: s })) },
  { id: 'gcp', label: 'GCP', kind: 'cloud', group: true, children: GCP_SERVICES.map(s => ({ id: `gcp-${slugify(s)}`, label: s })) },
  { id: 'k8s', label: 'Kubernetes', kind: 'cloud', group: true, children: K8S_RESOURCES.map(s => ({ id: `k8s-${slugify(s)}`, label: s })) },
  { id: 'host', label: 'Host', kind: 'compute', enabled: true, count: 7 },
  { id: 'apache', label: 'Apache httpd', kind: 'runtime', enabled: false },
  { id: 'elastic', label: 'Elasticsearch', kind: 'store', enabled: false },
  { id: 'haproxy', label: 'HAProxy', kind: 'runtime', enabled: false },
  { id: 'iis', label: 'IIS', kind: 'runtime', enabled: false },
  { id: 'kafka', label: 'Kafka', kind: 'queue', enabled: false },
  { id: 'memcached', label: 'Memcached', kind: 'store', enabled: false },
  { id: 'mongo', label: 'MongoDB', kind: 'store', enabled: false },
  { id: 'mysql', label: 'MySQL', kind: 'store', enabled: true, count: 1 },
  { id: 'nginx', label: 'Nginx', kind: 'runtime', enabled: false },
  { id: 'postgres', label: 'PostgreSQL', kind: 'store', enabled: false },
  { id: 'rabbit', label: 'RabbitMQ', kind: 'queue', enabled: false },
  { id: 'redis', label: 'Redis', kind: 'store', enabled: true, count: 1 },
  { id: 'sqlsvr', label: 'SQL Server', kind: 'store', enabled: false },
  { id: 'varnish', label: 'Varnish', kind: 'runtime', enabled: false },
]

export const INFRA_SOURCE_INDEX = INFRA_SOURCES.reduce((acc, s) => {
  if (s.group) s.children.forEach(c => { acc[c.id] = { ...c, parent: s.label, kind: s.kind } })
  else acc[s.id] = s
  return acc
}, {})

/**
 * Infra used to be the last corner of the mock layer that ignored the time
 * range: every series was a fixed 60-point array of `{ m, value }` built by a
 * `generateHostSeries` that hard-coded the incident at minute 22 of its own
 * private hour. Changing the range relabelled those charts and nothing else.
 *
 * It is now on the same footing as `data/services`: a profile per metric, a
 * builder per table, and the module-level exports defined as the REFERENCE
 * WINDOW's value so nothing that already imports them has to change.
 *
 * Two kinds of number live in these row tables, and they are calibrated
 * differently:
 *
 *   • A PUBLISHED figure — the 92.4 the host table shows for
 *     ip-10-0-142-133 — is what the reference hour AVERAGES to, exactly as
 *     `services.js` treats 612 ms. It is not the quiet value: the quiet
 *     baseline is lower, and `pinToReference` solves for whichever baseline
 *     makes the published figure and the incident peak true together. That is
 *     the whole reason the table and the chart above it can now agree; they
 *     used to read the same literal as a mean and as a baseline at once.
 *
 *   • A series with NO figure beside it — Redis memory, disk I/O, the
 *     allocation floor — keeps its old base as the quiet value and is not
 *     pinned, because there is nothing for the reference hour to reproduce.
 *
 * The incident is the shared one. `generateHostSeries` expressed it as
 * `incident: 1.4`, a multiplier at the worst of the outage over a four-minute
 * ramp — which is precisely `sampleAt`'s `peak`, so those numbers carry across
 * unchanged and the outage still lands on the hosts HOST_ROWS flags critical,
 * with the same force.
 */
const INFRA_NOISE = 0.12

function infraProfile(published, { peak = 1, noise = INFRA_NOISE, seed, diurnal = false, pin = true } = {}) {
  const base = { baseline: published, peak, noise, seed, diurnal }
  // Pinning is a no-op on a zero metric (connection errors, pod restarts), so
  // those fall through with a flat baseline of 0 and no special case.
  return pin ? pinToReference(base, windowMean, published) : base
}

/**
 * The same profile on a different unit. Every term in `sampleAt` is
 * multiplicative, so scaling the baseline scales the whole series and nothing
 * else moves — which is how a host's network row stays in MB while its chart
 * stays in bytes per second, off one calibration.
 */
const atScale = (profile, factor) => (factor === 1 ? profile : { ...profile, baseline: profile.baseline * factor })

/** A series that does not vary: a node count, a container count, a CPU limit. */
const flat = value => ({ baseline: value, peak: 1, noise: 0, seed: 1 })

/**
 * The daily traffic wave goes on throughput the incident does NOT touch, and
 * nowhere else. This is the same split `services.js` makes — the wave is on
 * `rpm`, while `p90` and `err` are flat — and it is not a stylistic choice.
 *
 * `sampleAt` normalises the wave against the reference hour, so a diurnal
 * metric averages to 1x over that hour and to 1/WAVE_REFERENCE over a week.
 * Whether that factor is above or below 1 depends on what time of day the demo
 * is opened: at midnight it is about 1.18. Put the wave on a metric that also
 * carries the incident and the two pull in opposite directions as the range
 * widens — a critical host's CPU came out HIGHER over seven days than over the
 * last hour, by an amount that changed with the wall clock. The incident
 * thinning out is the one thing the range picker exists to show, so nothing
 * that carries a peak also carries the wave.
 *
 * What is left is pod resource use and nothing else: no pod carries the
 * outage, and the pod table's own figures are window aggregates from these
 * same profiles, so the wave cannot drift them away from a static card.
 */
const DIURNAL = true

const round2 = v => Math.round(v * 100) / 100
const round4 = v => Math.round(v * 10000) / 10000

const HOST_ROWS = [
  { host: 'ip-10-0-129-151', service: 'analytics-service', cpu: 26.21, mem: 38.95, disk: 73.6, netIn: 10.3, netOut: 4.84, cpuUnit: 'K', unit: 'M', status: 'healthy' },
  { host: 'ip-10-0-130-150', service: 'notify-service', cpu: 33.15, mem: 78.05, disk: 71.55, netIn: 3.04, netOut: 1.57, unit: 'M', status: 'warning' },
  { host: 'ip-10-0-142-133', service: 'payment-service', cpu: 92.4, mem: 88.2, disk: 72.8, netIn: 2.89, netOut: 1.76, unit: 'M', status: 'critical' },
  { host: 'ip-10-0-142-2', service: 'payment-service', cpu: 89.1, mem: 84.4, disk: 71.43, netIn: 2.84, netOut: 1.61, unit: 'M', status: 'critical' },
  { host: 'ip-10-0-143-40', service: 'shipment-service', cpu: 87.5, mem: 86.7, disk: 71.87, netIn: 2.79, netOut: 1.52, unit: 'M', status: 'critical' },
  { host: 'ip-10-0-144-12', service: 'search-service', cpu: 30.83, mem: 77.43, disk: 68.4, netIn: 1.9, netOut: 0.88, unit: 'K', status: 'healthy' },
  { host: 'minikube', service: 'demo-nodejs-service', cpu: 26.36, mem: 42.49, disk: 73.6, netIn: 1.9, netOut: 0.88, unit: 'K', status: 'healthy' },
]

// The host charts read bytes per second while the table reads MB or KB, and the
// old code carried that as a literal multiplier on the series base. Kept.
const netScale = h => (h.unit === 'K' ? 100 : 100000)

// None of these carries the daily wave, and that is deliberate — see the note
// on DIURNAL below. They are the metrics the incident moves, so the only thing
// that should move them as the range widens is the incident thinning out.
const HOST_PROFILES = HOST_ROWS.map((h, i) => {
  // The hosts on the incident path are exactly the ones HOST_ROWS flags
  // critical, which is how `generateHostSeries` chose them too.
  const hit = h.status === 'critical'
  return {
    cpu: infraProfile(h.cpu, { peak: hit ? 1.4 : 1, seed: 401 + i }),
    mem: infraProfile(h.mem, { peak: hit ? 1.15 : 1, seed: 501 + i }),
    disk: infraProfile(h.disk, { seed: 601 + i }),
    netIn: infraProfile(h.netIn, { peak: hit ? 1.3 : 1, seed: 701 + i }),
    netOut: infraProfile(h.netOut, { peak: hit ? 1.3 : 1, seed: 801 + i }),
    // No figure is published beside the disk I/O chart, so its old base stays
    // the quiet value and there is nothing to pin it to.
    diskIo: infraProfile(hit ? 34 : 5.5, { peak: hit ? 1.6 : 1, seed: 901 + i, pin: false }),
  }
})

/**
 * Every host as the selected window saw it.
 *
 * `status` is deliberately NOT re-derived from the window. It is the same
 * worst-instant reading `services.js` keeps on a service row: a host that ran
 * its CPU into the ceiling for 22 minutes does not become healthy because you
 * widened the chart to a week, even though every average on the row fades back
 * towards quiet. The numbers tell you what the window held; the dot tells you
 * it broke.
 */
export function infraHostsForWindow(win) {
  return HOST_ROWS.map((h, i) => {
    const p = HOST_PROFILES[i]
    const scale = netScale(h)
    return {
      ...h,
      cpu: round2(windowMean(win, p.cpu)),
      mem: round2(windowMean(win, p.mem)),
      disk: round2(windowMean(win, p.disk)),
      netIn: round2(windowMean(win, p.netIn)),
      netOut: round2(windowMean(win, p.netOut)),
      cpuSeries: windowSeries(win, p.cpu),
      memSeries: windowSeries(win, p.mem),
      diskSeries: windowSeries(win, p.disk),
      netInSeries: windowSeries(win, atScale(p.netIn, scale)),
      netOutSeries: windowSeries(win, atScale(p.netOut, scale)),
      diskIoSeries: windowSeries(win, p.diskIo),
    }
  })
}

export const infraHosts = infraHostsForWindow(REFERENCE_WINDOW)

export const HOST_PROCESSES = [
  { name: 'cube', color: '#F59E0B', cpu: 31.59, mem: 86.27 },
  { name: 'kube-apiserver', color: '#EF4444', cpu: 0.69, mem: 1.56 },
  { name: 'kubelet', color: '#22C55E', cpu: 0.51, mem: 0.88 },
  { name: 'otelcol-contrib', color: '#EAB308', cpu: 0.36, mem: 3.35 },
  { name: 'etcd', color: '#FB7185', cpu: 0.35, mem: 0.62 },
  { name: 'dockerd', color: '#F97316', cpu: 0.25, mem: 1.0 },
  { name: 'pyroscope', color: '#3B82F6', cpu: 0.38, mem: 1.14 },
  { name: 'java', color: '#F472B6', cpu: 0.2, mem: 14.4 },
  { name: 'containerd-shim-runc-v2', color: '#A78BFA', cpu: 0.14, mem: 2.1 },
  { name: 'node /home/ubun', color: '#A78BFA', cpu: 0.12, mem: 0.32 },
  { name: 'nginx', color: '#34D399', cpu: 0.07, mem: 0 },
  { name: 'grafana-agent', color: '#F472B6', cpu: 0.06, mem: 0.21 },
  { name: 'grafana', color: '#60A5FA', cpu: 0.03, mem: 0.46 },
]

/* ============ KUBERNETES ============ */

// Total, request and limit are what the cluster was CONFIGURED for, so they are
// flat lines across any window; only `used` is a reading. The old generator
// jittered it by 6% and nothing it draws is published elsewhere, so its base
// stays the quiet value.
const ALLOC_SPECS = {
  cpu: { total: 4, request: 1, limit: 4, usedBase: 0.1, seed: 1901, round: 4 },
  mem: { total: 16_000_000_000, request: 900_000_000, limit: 16_000_000_000, usedBase: 700_000_000, seed: 1902, round: 0 },
}

function allocForWindow(win, { total, request, limit, usedBase, seed, round }) {
  const opts = { round }
  return {
    total: windowSeries(win, flat(total), opts),
    request: windowSeries(win, flat(request), opts),
    limit: windowSeries(win, flat(limit), opts),
    used: windowSeries(win, { baseline: usedBase, peak: 1, noise: 0.06, seed }, opts),
  }
}

export const k8sCpuAllocationForWindow = win => allocForWindow(win, ALLOC_SPECS.cpu)
export const k8sMemAllocationForWindow = win => allocForWindow(win, ALLOC_SPECS.mem)

/** Both allocation charts in one call, for a view that draws them together. */
export function k8sAllocationForWindow(win) {
  return { cpu: k8sCpuAllocationForWindow(win), mem: k8sMemAllocationForWindow(win) }
}

export const k8sCpuAllocation = k8sCpuAllocationForWindow(REFERENCE_WINDOW)
export const k8sMemAllocation = k8sMemAllocationForWindow(REFERENCE_WINDOW)

export function k8sContainersSeriesForWindow(win) {
  return { ready: windowSeries(win, flat(10), { round: 0 }), notReady: windowSeries(win, flat(0), { round: 0 }) }
}

export const k8sContainersSeries = k8sContainersSeriesForWindow(REFERENCE_WINDOW)

export const k8sClusterSummary = {
  nodesTotal: 2, nodesReady: 2,
  podsTotal: 10, podsPending: 0, podsFailed: 0, containersReady: 10,
  daemonSetsTotal: 2, daemonSetsUnhealthy: 0,
  deploymentsTotal: 4, deploymentsUnhealthy: 0,
  hpasTotal: 0,
  statefulSetsTotal: 1, statefulSetsUnhealthy: 0,
  replicaSetsTotal: 4, replicaSetsUnhealthy: 0,
  replControllersTotal: 0, replControllersUnhealthy: 0,
}

export const k8sNamespaceSummary = [
  { namespace: 'default', cpuUsed: 0.09, cpuRequest: 0.5, cpuLimit: 0.5, memUsed: 620_000_000, memRequest: 700_000_000, memLimit: 700_000_000, containers: 6 },
  { namespace: 'kube-system', cpuUsed: 0.06, cpuRequest: 0.75, cpuLimit: null, memUsed: 300_000_000, memRequest: 200_000_000, memLimit: 200_000_000, containers: 4 },
]

export const k8sDeploymentSummary = [
  { namespace: 'default', deployments: 3, podsDesired: 4, podsAvailable: 4 },
  { namespace: 'kube-system', deployments: 1, podsDesired: 1, podsAvailable: 1 },
]

const K8S_NODE_ROWS = [
  { name: 'ip-10-0-142-133', cpu: 92.4, mem: 88.2, disk: 72.8, netIn: 2.89, netOut: 1.76, unit: 'M', pods: 6, status: 'critical' },
  { name: 'ip-10-0-143-40', cpu: 87.5, mem: 86.7, disk: 71.87, netIn: 2.79, netOut: 1.52, unit: 'M', pods: 4, status: 'critical' },
]

// Both nodes are on the incident path — they are where the payment pods sit —
// so neither is conditioned on status, exactly as before.
const NODE_PROFILES = K8S_NODE_ROWS.map((n, i) => ({
  cpu: infraProfile(n.cpu, { peak: 1.15, seed: 2001 + i }),
  mem: infraProfile(n.mem, { peak: 1.1, seed: 2101 + i }),
  disk: infraProfile(n.disk, { seed: 2201 + i }),
  netIn: infraProfile(n.netIn, { peak: 1.2, seed: 2301 + i }),
  netOut: infraProfile(n.netOut, { peak: 1.2, seed: 2401 + i }),
}))

export function k8sNodesForWindow(win) {
  return K8S_NODE_ROWS.map((n, i) => {
    const p = NODE_PROFILES[i]
    return {
      ...n,
      cpu: round2(windowMean(win, p.cpu)),
      mem: round2(windowMean(win, p.mem)),
      disk: round2(windowMean(win, p.disk)),
      netIn: round2(windowMean(win, p.netIn)),
      netOut: round2(windowMean(win, p.netOut)),
      cpuSeries: windowSeries(win, p.cpu),
      memSeries: windowSeries(win, p.mem),
      diskSeries: windowSeries(win, p.disk),
      netInSeries: windowSeries(win, atScale(p.netIn, 100000)),
      netOutSeries: windowSeries(win, atScale(p.netOut, 100000)),
    }
  })
}

export const k8sNodes = k8sNodesForWindow(REFERENCE_WINDOW)

// `labels` are the pod column's tags, searched as `pod.app:redis`.
const K8S_POD_ROWS = [
  { name: 'payment-service-7d8b9c-4vk2q', labels: { app: 'payment', tier: 'backend', team: 'payments' }, namespace: 'default', node: 'ip-10-0-142-133', cpuUsed: 0.09, cpuRequest: 0.25, cpuLimit: 0.25, memUsed: 418_800_000, memRequest: 536_900_000, memLimit: 536_900_000, netIn: 12.4, netOut: 8.9 },
  { name: 'redis-0', labels: { app: 'redis', tier: 'cache', team: 'platform' }, namespace: 'default', node: 'ip-10-0-142-133', cpuUsed: 0.04, cpuRequest: 0.1, cpuLimit: 0.1, memUsed: 210_500_000, memRequest: 256_000_000, memLimit: 256_000_000, netIn: 40.2, netOut: 38.7 },
  { name: 'coredns-66bc5c9577-zkrnm', labels: { app: 'coredns', tier: 'system' }, namespace: 'kube-system', node: 'ip-10-0-142-133', cpuUsed: 0.0012, cpuRequest: 0.1, cpuLimit: 0.1, memUsed: 19_400_000, memRequest: 70_000_000, memLimit: 170_000_000, netIn: 1.1, netOut: 0.9 },
  { name: 'kube-proxy-784j7', labels: { app: 'kube-proxy', tier: 'system' }, namespace: 'kube-system', node: 'ip-10-0-143-40', cpuUsed: 0.0002, cpuRequest: 0, cpuLimit: 0, memUsed: 20_500_000, memRequest: 0, memLimit: 0, netIn: 0.4, netOut: 0.3 },
  { name: 'order-service-6c8f4b-8ct9x', labels: { app: 'order', tier: 'backend', team: 'checkout' }, namespace: 'default', node: 'ip-10-0-143-40', cpuUsed: 0.05, cpuRequest: 0.2, cpuLimit: 0.2, memUsed: 180_200_000, memRequest: 256_000_000, memLimit: 256_000_000, netIn: 9.6, netOut: 7.1 },
  { name: 'storage-provisioner', labels: { app: 'storage', tier: 'system' }, namespace: 'kube-system', node: 'ip-10-0-143-40', cpuUsed: 0.0016, cpuRequest: 0, cpuLimit: 0, memUsed: 13_100_000, memRequest: 0, memLimit: 0, netIn: 0.2, netOut: 0.2 },
]

// No pod carries the incident: the outage is in the Redis connection POOL, not
// in the pod's own resource use, and the old generator passed `incident: null`
// for every one of them. Their windows move with the daily wave alone.
//
// Requests and limits stay literal — an allocation is configuration, not a
// reading, and does not average over a window.
const POD_PROFILES = K8S_POD_ROWS.map((p, i) => ({
  cpuUsed: infraProfile(p.cpuUsed, { seed: 2501 + i, diurnal: DIURNAL }),
  memUsed: infraProfile(p.memUsed, { seed: 2601 + i }),
  disk: infraProfile(73.9, { seed: 2701 + i, pin: false }),
  netIn: infraProfile(p.netIn, { seed: 2801 + i, diurnal: DIURNAL }),
  netOut: infraProfile(p.netOut, { seed: 2901 + i, diurnal: DIURNAL }),
}))

export function k8sPodsForWindow(win) {
  return K8S_POD_ROWS.map((p, i) => {
    const pr = POD_PROFILES[i]
    return {
      ...p,
      containerName: p.name.split('-')[0],
      cpuUsed: round4(windowMean(win, pr.cpuUsed)),
      memUsed: Math.round(windowMean(win, pr.memUsed)),
      netIn: round2(windowMean(win, pr.netIn)),
      netOut: round2(windowMean(win, pr.netOut)),
      // Pod CPU is in cores, and a system pod sits at 0.0002 of one. The old
      // generator rounded every series to two decimals, which drew those pods
      // as a flat zero line under an axis formatted to three.
      cpuSeries: windowSeries(win, pr.cpuUsed, { round: 5 }),
      memSeries: windowSeries(win, pr.memUsed, { round: 0 }),
      diskSeries: windowSeries(win, pr.disk),
      restartsSeries: windowSeries(win, flat(0), { round: 0 }),
      netInSeries: windowSeries(win, pr.netIn),
      netOutSeries: windowSeries(win, pr.netOut),
    }
  })
}

export const k8sPods = k8sPodsForWindow(REFERENCE_WINDOW)

export const K8S_NAMESPACES = ['default', 'kube-system']

/**
 * The namespace rollup behind /infra?tab=k8s-cluster&section=<namespace>.
 *
 * Derived from the pods and the per-namespace allocation rather than stored, so
 * it cannot drift from the pod list the drill-down shows. Node counts are
 * deliberately absent: a node is not namespaced, which is the one real
 * difference between this view and the cluster it sits inside.
 */
export function k8sNamespaceDetailForWindow(win, namespace) {
  return namespaceDetail(k8sPodsForWindow(win), namespace)
}

export function k8sNamespaceDetail(namespace) {
  return namespaceDetail(k8sPods, namespace)
}

function namespaceDetail(allPods, namespace) {
  const alloc = k8sNamespaceSummary.find(n => n.namespace === namespace)
  if (!alloc) return null
  const pods = allPods.filter(p => p.namespace === namespace)
  const deploy = k8sDeploymentSummary.find(d => d.namespace === namespace)
  const isSystem = namespace === 'kube-system'
  return {
    namespace,
    alloc,
    pods,
    podsTotal: pods.length,
    podsPending: 0,
    podsFailed: 0,
    containersReady: alloc.containers,
    containersTotal: alloc.containers,
    daemonSetsTotal: isSystem ? 2 : 0,
    daemonSetsUnhealthy: 0,
    deploymentsTotal: deploy?.deployments ?? 0,
    deploymentsUnhealthy: 0,
    hpasTotal: 0,
    statefulSetsTotal: isSystem ? 0 : 1,
    statefulSetsUnhealthy: 0,
    replicaSetsTotal: deploy?.deployments ?? 0,
    replicaSetsUnhealthy: 0,
    replControllersTotal: 0,
    replControllersUnhealthy: 0,
  }
}

/* ============ MYSQL ============ */

export const mysqlSummary = {
  host: 'database-2.cgo30ygoem6z.ap-south-1.rds.amazonaws.com:3306',
  connections: 13.84, opsPerMin: 321.54, connErrPerMin: 0, slowQueriesPerMin: 0, replicationLag: null, dbSizeBytes: 474_660_000,
}
// MySQL is not on the incident path — it is Redis that gave out — so these keep
// their old bases as quiet values and carry no peak. No daily wave either:
// `mysqlSummary.opsPerMin` is a static card sitting beside this chart, and the
// wave would walk the chart away from it by up to 18% depending on the hour.
const MYSQL_PROFILES = {
  opsPerMin: { baseline: 320, peak: 1, noise: INFRA_NOISE, seed: 3001 },
  connErrors: { baseline: 0, peak: 1, noise: INFRA_NOISE, seed: 3002 },
  slowQueries: { baseline: 0, peak: 1, noise: INFRA_NOISE, seed: 3003 },
}

export function mysqlSeriesForWindow(win) {
  return {
    opsPerMin: windowSeries(win, MYSQL_PROFILES.opsPerMin),
    connErrors: windowSeries(win, MYSQL_PROFILES.connErrors),
    slowQueries: windowSeries(win, MYSQL_PROFILES.slowQueries),
  }
}

export const mysqlSeries = mysqlSeriesForWindow(REFERENCE_WINDOW)

/* ============ REDIS ============ */

export const redisSummary = {
  host: 'redis.0', connections: 128, connPerMin: 42, cmdPerMin: 640, memUsedBytes: 1_060_000_000, cacheHitPct: 71.2, status: 'critical',
}
// Redis IS the incident, and `redisSummary` reads the plateau rather than an
// hourly mean — 620 MB quiet times the 1.7 peak is the 1.06 GB the card shows,
// and 610 commands times 1.05 is its 640. So these bases are quiet values and
// are not pinned: pinning them to the summary would double-count the outage.
const REDIS_PROFILES = {
  memUsed: { baseline: 620_000_000, peak: 1.7, noise: INFRA_NOISE, seed: 3101 },
  cmdPerMin: { baseline: 610, peak: 1.05, noise: INFRA_NOISE, seed: 3102 },
  evictionsPerMin: { baseline: 2, peak: 18, noise: INFRA_NOISE, seed: 3103 },
}

export function redisSeriesForWindow(win) {
  return {
    memUsed: windowSeries(win, REDIS_PROFILES.memUsed, { round: 0 }),
    cmdPerMin: windowSeries(win, REDIS_PROFILES.cmdPerMin),
    evictionsPerMin: windowSeries(win, REDIS_PROFILES.evictionsPerMin),
  }
}

export const redisSeries = redisSeriesForWindow(REFERENCE_WINDOW)
