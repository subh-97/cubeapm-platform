import { statusForLatency, statusForErrorRate, worstStatus } from '@/utils/status'

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

export const services = RAW_SERVICES.map(s => ({
  ...s,
  status: worstStatus(statusForLatency(s.latencyP90), statusForErrorRate(s.errorRatePct)),
}))

services.sort((a, b) => (RANK[b.status] || 0) - (RANK[a.status] || 0) || b.errorRatePct - a.errorRatePct)

export const serviceSummary = {
  total: services.length,
  critical: services.filter(s => s.status === 'critical').length,
  warning: services.filter(s => s.status === 'warning').length,
  healthy: services.filter(s => s.status === 'healthy').length,
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

function generateSeries({ points = 60, baseline, noise = 0.06, incidentStartMinutesAgo = null, incidentMultiplier = 1, seed = 1 }) {
  const out = []
  let s = seed
  const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280 }
  for (let i = points - 1; i >= 0; i--) {
    const m = i
    let v = baseline * (1 + (rnd() - 0.5) * noise)
    if (incidentStartMinutesAgo !== null && m <= incidentStartMinutesAgo) {
      const into = incidentStartMinutesAgo - m
      const ramp = Math.min(1, into / 4)
      v = baseline * (1 + (incidentMultiplier - 1) * ramp) * (1 + (rnd() - 0.5) * noise)
    }
    out.push({ m, value: Math.round(v * 100) / 100 })
  }
  return out
}

export const paymentServiceSeries = {
  rpm: generateSeries({ baseline: 452, noise: 0.08, seed: 11 }),
  latencyP90: generateSeries({ baseline: 140, incidentStartMinutesAgo: 22, incidentMultiplier: 4.4, noise: 0.1, seed: 22 }),
  latencyAvg: generateSeries({ baseline: 78, incidentStartMinutesAgo: 22, incidentMultiplier: 4.36, noise: 0.1, seed: 55 }),
  errorRatePct: generateSeries({ baseline: 0.05, incidentStartMinutesAgo: 22, incidentMultiplier: 96, noise: 0.15, seed: 33 }),
  apdex: generateSeries({ baseline: 0.98, incidentStartMinutesAgo: 22, incidentMultiplier: 0.55, noise: 0.02, seed: 44 }),
}

// Deploys roll one version at a time, so in any given minute a single version is
// serving and the rest are idle. Charted by version, that paints the window in
// bands: the envelope is the metric, the colour is whatever was deployed then.
const ROLLOUT_VERSIONS = [
  'v2.48.21', 'v2.48.22', 'v2.48.23', 'v2.49.0', 'v2.49.1', 'v2.49.2', 'v2.49.3',
  'v2.49.4', 'v2.49.5', 'v2.49.6', 'v2.49.7', 'v2.49.8', 'v2.49.9', 'v2.49.10',
]

const BAND_POINTS = 60

// Which version owns each minute, in runs of three to six.
const VERSION_AT = (() => {
  const out = []
  let s = 7, vi = 0
  const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280 }
  while (out.length < BAND_POINTS) {
    const run = 3 + Math.floor(rnd() * 4)
    const v = ROLLOUT_VERSIONS[vi++ % ROLLOUT_VERSIONS.length]
    for (let i = 0; i < run && out.length < BAND_POINTS; i++) out.push(v)
  }
  return out
})()

// Traffic swells and settles across the window rather than holding flat. The
// wave is phased to cross zero at the newest sample, so the chart still lands on
// the rate the KPI card reports for "now".
const rpmSwell = paymentServiceSeries.rpm.map((d, i) => {
  const x = i - BAND_POINTS + 1
  return { m: d.m, value: d.value * (1 + 0.45 * Math.sin(x / 6.4) + 0.16 * Math.sin(x / 2.3)) }
})

// Spread an aggregate across the bands. `idle` is 0 where the chart stacks - the
// band has to reach the axis - and null where it draws lines, so a line stops at
// the end of its deploy instead of diving to zero.
function bandByVersion(series, { idle = null, jitter = 0, seed = 1 } = {}) {
  let s = seed
  const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280 }
  return ROLLOUT_VERSIONS.map(v => ({
    label: v,
    series: series.map((d, i) => ({
      m: d.m,
      value: VERSION_AT[i] === v
        ? Math.round(d.value * (1 + (rnd() - 0.5) * jitter) * 1000) / 1000
        : idle,
    })),
  }))
}

export const versionBands = {
  rpm: bandByVersion(rpmSwell, { idle: 0, jitter: 0.12, seed: 301 }),
  errorRatePct: bandByVersion(paymentServiceSeries.errorRatePct, { jitter: 0.55, seed: 302 }),
  apdex: bandByVersion(paymentServiceSeries.apdex, { jitter: 0.04, seed: 303 }),
}

export const fleetSeries = {
  rpm: generateSeries({ baseline: 5700, noise: 0.05, seed: 101 }),
  errorsPerMin: generateSeries({ baseline: 3, incidentStartMinutesAgo: 22, incidentMultiplier: 15, noise: 0.2, seed: 102 }),
  p90: generateSeries({ baseline: 150, incidentStartMinutesAgo: 22, incidentMultiplier: 2.7, noise: 0.08, seed: 103 }),
}

export const latencyDrilldown = [
  { label: 'DB redis', ms: 210, color: '#EF4444' },
  { label: 'HTTP External (twilio)', ms: 55, color: '#3B82F6' },
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
    { endpoint: 'POST /v1/payments/:id/capture', kind: 'web', timeConsumedPct: 54, rpm: 22.3, avg: 221, errPct: 6.3 },
    { endpoint: 'POST /v1/payments', kind: 'web', timeConsumedPct: 31, rpm: 12.8, avg: 208, errPct: 5.4 },
    { endpoint: 'PATCH /v1/payments/:id', kind: 'web', timeConsumedPct: 15, rpm: 6.1, avg: 196, errPct: 4.1 },
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

export const dbEndpoints = [
  { endpoint: 'SELECT payments.transactions', kind: 'mysql', timeConsumedPct: 54, rpm: 210.4, avg: 38, p90: 65, errPct: 0 },
  { endpoint: 'UPDATE payments.transactions', kind: 'mysql', timeConsumedPct: 22, rpm: 84.7, avg: 22, p90: 42, errPct: 0.1 },
  { endpoint: 'GET redis.session:*', kind: 'redis', timeConsumedPct: 14, rpm: 620.5, avg: 3.6, p90: 210, errPct: 3.2 },
  { endpoint: 'SETEX redis.session:*', kind: 'redis', timeConsumedPct: 8, rpm: 410.9, avg: 2.1, p90: 190, errPct: 2.8 },
  { endpoint: 'INSERT payments.audit_log', kind: 'mysql', timeConsumedPct: 2, rpm: 52.3, avg: 8, p90: 14, errPct: 0 },
]

export const slowQueries = [
  { time: 'Jul 15, 22:38pm', query: 'SELECT * FROM `payments`.`transactions` WHERE `id` = ? AND `merchant_id` = ?', duration: 812 },
  { time: 'Jul 15, 22:37pm', query: 'GET redis.session:usr_a92f8b0c34', duration: 743 },
  { time: 'Jul 15, 22:36pm', query: 'UPDATE `payments`.`transactions` SET `status` = ?, `updated_at` = ? WHERE `id` = ?', duration: 690 },
  { time: 'Jul 15, 22:34pm', query: 'SETEX redis.session:usr_1f04b9a EX 900', duration: 655 },
  { time: 'Jul 15, 22:33pm', query: 'SELECT COUNT(*) FROM `payments`.`transactions` WHERE `status` = ?', duration: 601 },
]

export const errorGroups = {
  server: [
    { endpoint: 'PATCH /v1/payments/:id', exception: 'java.lang.RuntimeException', message: '500 Internal Server Error', count: 8 },
    { endpoint: 'POST /v1/payments', exception: 'java.lang.RuntimeException', message: '500 Internal Server Error', count: 3 },
    { endpoint: 'GET /v1/payments', exception: 'redis.clients.jedis.exceptions.JedisPoolException', message: 'Could not get a resource from the pool', count: 2 },
    { endpoint: 'GET /v1/payments/:id', exception: 'java.lang.RuntimeException', message: '500 Internal Server Error', count: 1 },
  ],
  client: [
    { endpoint: 'POST redis.set', exception: 'redis.clients.jedis.exceptions.JedisConnectionException', message: 'Failed connecting to host redis.0:6379', count: 14 },
    { endpoint: 'POST twilio.messages.send', exception: 'com.twilio.exception.ApiException', message: '429 Too Many Requests', count: 3 },
  ],
}

function generateErrorSpark(count, seed) {
  let s = seed
  const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280 }
  return Array.from({ length: 30 }, (_, i) => ({
    m: 29 - i,
    value: i > 21 ? Math.max(0, Math.round(count / 3 * rnd())) : (rnd() < 0.08 ? 1 : 0),
  }))
}
errorGroups.server = errorGroups.server.map((e, i) => ({ ...e, series: generateErrorSpark(e.count, 71 + i * 7) }))
errorGroups.client = errorGroups.client.map((e, i) => ({ ...e, series: generateErrorSpark(e.count, 91 + i * 7) }))

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

export const runtimeHosts = [
  { id: 'ip-10-0-142-133', name: 'ip-10-0-142-133', status: 'critical' },
  { id: 'ip-10-0-142-2', name: 'ip-10-0-142-2', status: 'critical' },
  { id: 'ip-10-0-143-40', name: 'ip-10-0-143-40', status: 'warning' },
  { id: 'ip-10-0-130-150', name: 'ip-10-0-130-150', status: 'healthy' },
]

export const runtimeMetrics = {
  cpuPct: generateSeries({ baseline: 68, incidentStartMinutesAgo: 22, incidentMultiplier: 1.35, noise: 0.08, seed: 201 }),
  heapUsedMB: generateSeries({ baseline: 480, incidentStartMinutesAgo: 22, incidentMultiplier: 1.28, noise: 0.06, seed: 202 }),
  heapLimitMB: generateSeries({ baseline: 640, noise: 0.005, seed: 203 }),
  threads: generateSeries({ baseline: 220, incidentStartMinutesAgo: 22, incidentMultiplier: 1.4, noise: 0.05, seed: 204 }),
  gcMinorMs: generateSeries({ baseline: 8, incidentStartMinutesAgo: 22, incidentMultiplier: 2.4, noise: 0.25, seed: 205 }),
  gcMajorMs: generateSeries({ baseline: 3, incidentStartMinutesAgo: 22, incidentMultiplier: 3.2, noise: 0.3, seed: 206 }),
}
