// The logs/traces half of Explore's mock backend (ARCH C8, decision D12).
//
// There is no VictoriaLogs behind this repo, so the rows a LogsQL query reads
// are synthesised here. The obvious shape — "generate every event in the
// window" — does not survive a 7-day range: that is 40M logs and 23M spans.
// So this store returns a SAMPLE and tells the evaluator how much of reality
// each sampled row stands for, in `_weight`. A stats query that sums weights
// therefore reports the real volume while only ever touching
// `buckets × 24` rows, which is why a 7-day query costs the same as a 1-hour
// one.
//
// Sampling is systematic (low-discrepancy) over the per-bucket mix rather than
// independent per row, so a group's share of the bucket comes out close to its
// true share instead of drifting with the seed, and rare groups stay rare
// instead of being inflated to one-24th of the bucket the moment they appear.
// Sparse series are the live behaviour anyway (live-data.md §2.2: empty
// buckets are omitted), so a group that misses a bucket is right, not a bug.
//
// Everything is a pure function of (datasource, bucket start), anchored on
// BASE_TIME — the same anchor the Logs and Traces pages use — so the payment
// incident at −22 min lines up with the rows those pages already show, and two
// queries over overlapping windows agree on every bucket they share.
//
// The vocabulary is deliberately OUR vocabulary, not the playground's: field
// spellings and value spaces come from QueryBuilder's FIELD_CATALOG,
// observability.js, traceFields' TRACE_FIELD_CATALOG and tracesExplorer.js, so
// a query carried over from the Logs or Traces page by "Open in Explore" still
// matches rows here. Volumes and the per-service/per-level mix come from
// live-data.md, which is the real playground.
//
// Both catalogs below are written out rather than imported: FIELD_CATALOG
// lives in a .jsx component (pulling React into a data module), and
// TRACE_FIELD_CATALOG derives itself from the whole generated span table,
// which would cost more at import than this module costs to run. The spellings
// are what must agree, and they do.

import { BASE_TIME } from '@/data/observability'

// ---------- Field catalogs ----------

/** Log fields this store emits. Spellings match QueryBuilder's FIELD_CATALOG. */
export const LOG_FIELDS = [
  { field: 'service', type: 'string', desc: 'Service name' },
  { field: 'log.level', type: 'string', desc: 'Log severity' },
  { field: 'env', type: 'string', desc: 'Environment' },
  { field: 'endpoint', type: 'string', desc: 'Request endpoint' },
  { field: 'path', type: 'string', desc: 'Request path' },
  { field: 'log.exception.type', type: 'string', desc: 'Exception class' },
  { field: 'http.status', type: 'keyword', desc: 'HTTP status code' },
  { field: 'duration_ms', type: 'keyword', desc: 'Request duration (ms)' },
  { field: 'trace_id', type: 'string', desc: 'Trace identifier', highCard: true },
  { field: 'host.name', type: 'string', desc: 'Host' },
  { field: 'event.domain', type: 'string', desc: 'Record domain (k8s, page action)' },
  { field: 'severity', type: 'string', desc: 'Log severity (OTel spelling)' },
  { field: 'k8s.namespace.name', type: 'string', desc: 'Kubernetes namespace' },
  { field: 'k8s.pod.name', type: 'string', desc: 'Kubernetes pod' },
  { field: 'k8s.node.name', type: 'string', desc: 'Kubernetes node' },
  { field: 'k8s.container.name', type: 'string', desc: 'Container' },
  { field: 'log.iostream', type: 'string', desc: 'Container stream (stdout, stderr)' },
  { field: 'object.type', type: 'string', desc: 'k8s event type (Normal, Warning)' },
  { field: 'object.reason', type: 'string', desc: 'k8s event reason' },
  { field: 'object.regarding.kind', type: 'string', desc: 'k8s object the event is about' },
  { field: 'eventType', type: 'string', desc: 'RUM event type' },
  { field: 'actionName', type: 'string', desc: 'RUM page action' },
  { field: 'browser.device_type', type: 'string', desc: 'RUM device type' },
]

/** Span fields this store emits. Spellings match TRACE_FIELD_CATALOG. */
export const TRACE_FIELDS = [
  { field: 'service', type: 'string', desc: 'Service that emitted the span' },
  { field: 'span_name', type: 'string', desc: 'Operation name' },
  { field: 'span_kind', type: 'string', desc: 'Span kind (server, client, internal)' },
  { field: 'status_code', type: 'string', desc: 'Span status (ERROR, UNSET)' },
  { field: 'duration', type: 'keyword', desc: 'Span duration (nanoseconds)' },
  { field: 'root_name', type: 'string', desc: 'Name of the trace root span' },
  { field: 'env', type: 'string', desc: 'Environment' },
  { field: 'category', type: 'string', desc: 'Span category (http, db)' },
  { field: 'error', type: 'string', desc: 'Whether the span failed' },
  { field: 'event.domain', type: 'string', desc: 'Record domain (span)' },
  { field: 'trace_id', type: 'string', desc: 'Trace identifier', highCard: true },
  { field: 'span_id', type: 'string', desc: 'Span identifier', highCard: true },
  { field: 'parent_id', type: 'string', desc: 'Parent span identifier', highCard: true },
  { field: 'service.version', type: 'string', desc: 'Service version' },
  { field: 'host.name', type: 'string', desc: 'Host' },
  { field: 'http.method', type: 'string', desc: 'HTTP method' },
  { field: 'http.route', type: 'string', desc: 'Matched route template' },
  { field: 'http.status_code', type: 'keyword', desc: 'HTTP status code' },
  { field: 'http.target', type: 'string', desc: 'Request path' },
  { field: 'http.url', type: 'string', desc: 'Outbound request URL' },
  { field: 'db.system', type: 'string', desc: 'Database engine' },
  { field: 'db.operation', type: 'string', desc: 'Database operation' },
  { field: 'db.name', type: 'string', desc: 'Database name' },
  { field: 'db.sql.table', type: 'string', desc: 'SQL table' },
  { field: 'db.mongodb.collection', type: 'string', desc: 'Mongo collection' },
  { field: 'net.peer.name', type: 'string', desc: 'Remote host' },
  { field: 'exception.type', type: 'string', desc: 'Exception class' },
  { field: 'exception.message', type: 'string', desc: 'Exception message' },
  { field: 'otel.library.name', type: 'string', desc: 'Instrumentation library' },
]

// The `{…}` selector's vocabulary. A stream field is one the store stamps on
// every row of its kind, which is what makes it cheap to index on — the same
// rule the server applies (D12).
export const LOG_STREAM_FIELDS = [
  { field: 'service', type: 'string', desc: 'Service name' },
  { field: 'env', type: 'string', desc: 'Environment' },
  { field: 'host.name', type: 'string', desc: 'Host' },
  { field: 'k8s.namespace.name', type: 'string', desc: 'Kubernetes namespace' },
]

export const TRACE_STREAM_FIELDS = [
  { field: 'service', type: 'string', desc: 'Service that emitted the span' },
  { field: 'span_kind', type: 'string', desc: 'Span kind (server, client, internal)' },
  { field: 'env', type: 'string', desc: 'Environment' },
]

const LOG_STREAM_KEYS = LOG_STREAM_FIELDS.map(f => f.field)
const TRACE_STREAM_KEYS = TRACE_STREAM_FIELDS.map(f => f.field)

/**
 * A field's value on a row.
 *
 * Rows are flat, so a dotted name is an ordinary key — `host.name` is the key
 * `"host.name"`, never a path into a nested object. The three underscore
 * fields are the server's own: `_msg` is the message (the span name on a
 * span), `_time` is unix milliseconds, `_stream` is the stream as an object.
 */
export function getField(row, field) {
  if (!row || !field) return undefined
  if (field === '_time') return row._time
  if (field === '_msg') return row._msg
  if (field === '_stream') return row._stream
  return row[field]
}

// ---------- Determinism ----------

// The house LCG (observability.js, tracesExplorer.js), but seeded through a
// hash. Seeding it with the bucket start directly would hand adjacent buckets
// seeds 60 apart, and this generator's low-order structure then draws them
// near-parallel streams — every minute would get the same mix in the same
// order, which reads as a repeating pattern on the chart.
function seedFor(key) {
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0) % 233280
}

function rndFor(key) {
  let s = seedFor(key)
  return () => { s = (s * 9301 + 49297) % 233280; return s / 233280 }
}

const pick = (rnd, arr) => arr[Math.floor(rnd() * arr.length) % arr.length]

// Built from 32-bit chunks rather than a digit at a time: a 7-day query draws
// four ids per span row, and 32 draws each is the difference between this
// store costing 50 ms and costing 400 ms.
function hexId(rnd, chars) {
  let s = ''
  while (s.length < chars) s += Math.floor(rnd() * 0x100000000).toString(16).padStart(8, '0')
  return s.slice(0, chars)
}

// Latency is log-normal; p50 and p90 together fix both its centre and its
// spread, so an operation described by the two numbers the service summary
// reports comes back with that summary's shape.
function sampleDuration(rnd, p50, p90) {
  const sigma = Math.log(Math.max(p90, p50 * 1.05) / p50) / 1.2816
  const z = (rnd() + rnd() + rnd() - 1.5) * 2
  return p50 * Math.exp(sigma * z)
}

// ---------- Time shape ----------

const INCIDENT_START_MS = BASE_TIME.getTime() - 22 * 60_000
const INCIDENT_RAMP_MS = 4 * 60_000

/** 0 before the payment incident, 1 once it is fully ramped (ARCH D11/D12). */
export function incidentFactor(tMs) {
  if (tMs <= INCIDENT_START_MS) return 0
  return Math.min(1, (tMs - INCIDENT_START_MS) / INCIDENT_RAMP_MS)
}

// ±18% over the day peaking at 14:00 local, ±8% for the weekend. Without it a
// 7-day range is a flat band, and the whole point of looking at 7 days is to
// see yesterday's shape next to today's.
function shapeOfDay(tMs) {
  const d = new Date(tMs)
  const hours = d.getHours() + d.getMinutes() / 60
  const day = 1 + 0.18 * Math.cos(((hours - 14) / 24) * 2 * Math.PI)
  const wd = d.getDay()
  return day * (wd === 0 || wd === 6 ? 0.92 : 1.04)
}

// ---------- Logs vocabulary ----------

const ENV = 'UNSET'

// Short names, as the logs half of the app spells them (observability.js).
const LOG_ENDPOINT = { order: '/v1/order', payment: '/v1/payment', shipment: '/v1/shipment', search: '/v1/search' }

// Infra hosts per service (observability.js HOST_ROWS), so a host.name picked
// here resolves in openLink. order-service has no infra host of its own; it
// runs on the node its pod is scheduled to.
const LOG_HOSTS = {
  order: ['ip-10-0-143-40'],
  payment: ['ip-10-0-142-133', 'ip-10-0-142-2'],
  shipment: ['ip-10-0-143-40'],
  search: ['ip-10-0-144-12'],
}

const EXC = {
  db: 'java.lang.RuntimeException',
  redis: 'redis.clients.jedis.exceptions.JedisPoolException',
  card: 'com.cubedemo.payment.CardDeclinedException',
  timeout: 'java.util.concurrent.TimeoutException',
}

// live-data.md §2.1 "top messages", plus the two the incident is made of.
const DB_FAIL = 'Failed connecting to database'
const REDIS_FAIL = 'Redis connection pool exhausted: could not get a resource from the pool'

const ERROR_MESSAGES = {
  base: [[DB_FAIL, EXC.db]],
  payment: [[DB_FAIL, EXC.db], ['Card declined by issuer: insufficient_funds', EXC.card], ['Timed out waiting for stripe after 30000ms', EXC.timeout]],
  incident: [[DB_FAIL, EXC.db], [REDIS_FAIL, EXC.redis]],
}

const PAYMENT_WARNINGS = [
  'card authorization attempt 1/2 declined by issuer: insufficient_funds',
  'stripe payment_intents.confirm attempt 1/3 got no response after 10000ms, retrying',
  'database connection attempt 1/3 to cubedemo.abcdefgh.us-west-2.rds.amazonaws.com:3306 failed, retrying in 250ms',
]

// observability.js makeMessage, verbatim — an info line is a pretty-printed
// body, which is why the Logs table wraps.
function infoMessage(svc, endpoint, iso) {
  return `processing request {\n  details: {\n    service: {\n      name: ${svc}\n    }\n  }\n  displayMessage: Transaction committed\n  systemMessage: request handled successfully\n  timestamp: ${iso}\n} operation successful`
}

// Per service × level, per hour (live-data.md §2.1). payment's error line is
// the one the incident multiplies.
const LOG_APP_VOLUME = [
  ['order', 'error', 89], ['order', 'warn', 98], ['order', 'info', 95],
  ['payment', 'error', 20], ['payment', 'warn', 135], ['payment', 'info', 101],
  ['shipment', 'error', 69], ['shipment', 'warn', 79], ['shipment', 'info', 87],
  ['search', 'error', 69], ['search', 'warn', 59], ['search', 'info', 55],
]

const K8S_CONTAINERS = [
  ['storage-provisioner', 'storage-provisioner', 3584, 'stderr'],
  ['coredns', 'coredns-66bc5c9577-zkrnm', 770, 'stdout'],
  ['kube-apiserver', 'kube-apiserver-minikube', 104, 'stderr'],
  ['etcd', 'etcd-minikube', 36, 'stderr'],
]

const K8S_LINES = [
  'W0930 18:33:32.223821 1 warnings.go:70] v1 Endpoints is deprecated in v1.33+; use discovery.k8s.io/v1 EndpointSlice',
  'I0930 18:33:35.118904 1 trace.go:236] Trace[1842]: "List(recursive=true) etcd3" key:/pods 412ms',
  'I0930 18:33:41.552013 1 shared_informer.go:311] Waiting for caches to sync for endpoint_slice',
]

const RUM_ACTIONS = ['viewProduct', 'search', 'viewOrder', 'viewOrders', 'removeFromCart', 'viewWishlist', 'addToCart', 'checkoutStep', 'trackShipment']

const K8S_EVENTS = [
  ['Normal', 'SuccessfulCreate', 'ReplicaSet', 'default'],
  ['Normal', 'Scheduled', 'Pod', 'cubedemo'],
  ['Warning', 'BackOff', 'Pod', 'cubedemo'],
]

// A row carries its stream fields twice: once flat, because that is how the
// evaluator and every `field:value` filter read them, and once gathered into
// `_stream`, because that is what a `{…}` selector and the Builder's STREAM
// rows ask for. The server does the same.
function withStream(row, keys) {
  const stream = {}
  for (const k of keys) if (row[k] !== undefined && row[k] !== '') stream[k] = row[k]
  row._stream = stream
  return row
}

function makeAppLog(svc, level, { rnd, tMs, weight, frac, f }) {
  const endpoint = LOG_ENDPOINT[svc]
  const incident = svc === 'payment' && f > 0
  const iso = new Date(tMs).toISOString()
  let msg
  let exception
  if (level === 'error') {
    const pool = incident && frac < f ? ERROR_MESSAGES.incident : svc === 'payment' ? ERROR_MESSAGES.payment : ERROR_MESSAGES.base
    const [m, e] = pick(rnd, pool)
    msg = m
    exception = e
  } else if (level === 'warn') {
    msg = svc === 'payment' && rnd() < 0.45
      ? pick(rnd, PAYMENT_WARNINGS)
      : `received HTTP 400 from https://notify.cubedemo.com${endpoint}`
  } else {
    msg = infoMessage(svc, endpoint, iso)
  }
  const slow = incident ? 1 + 3.4 * f : 1
  const durationMs = level === 'error'
    ? Math.round((800 + rnd() * 2400) * slow)
    : level === 'warn'
      ? Math.round((180 + rnd() * 520) * slow)
      : Math.round((20 + rnd() * 160) * slow)
  const row = {
    _time: tMs,
    _weight: weight,
    _msg: msg,
    env: ENV,
    service: svc,
    'log.level': level,
    endpoint,
    // Most lines log the route; the rest log the concrete path they served,
    // which is what makes `path` the high-cardinality twin of `endpoint`.
    path: rnd() < 0.65 ? endpoint : `${endpoint}/${Math.floor(1_000_000_000 + rnd() * 1_000_000_000)}`,
    'http.status': level === 'error' ? pick(rnd, [500, 502, 504]) : level === 'warn' ? 400 : 200,
    duration_ms: durationMs,
    trace_id: hexId(rnd, 32),
    'host.name': pick(rnd, LOG_HOSTS[svc]),
    'k8s.namespace.name': 'cubedemo',
  }
  if (exception) row['log.exception.type'] = exception
  return withStream(row, LOG_STREAM_KEYS)
}

function makeK8sLog(container, pod, iostream, { rnd, tMs, weight }) {
  return withStream({
    _time: tMs,
    _weight: weight,
    _msg: pick(rnd, K8S_LINES),
    env: ENV,
    severity: 'Unspecified',
    'host.name': 'minikube',
    'k8s.node.name': 'minikube',
    'k8s.namespace.name': 'kube-system',
    'k8s.container.name': container,
    'k8s.pod.name': pod,
    'log.iostream': iostream,
  }, LOG_STREAM_KEYS)
}

function makeK8sEvent({ rnd, tMs, weight }) {
  const [type, reason, kind, ns] = pick(rnd, K8S_EVENTS)
  return withStream({
    _time: tMs,
    _weight: weight,
    _msg: `${reason}: ${kind} in ${ns}`,
    env: ENV,
    'event.domain': 'k8s',
    'host.name': 'minikube',
    'k8s.namespace.name': ns,
    'object.type': type,
    'object.reason': reason,
    'object.regarding.kind': kind,
  }, LOG_STREAM_KEYS)
}

function makeRumLog({ rnd, tMs, weight }) {
  const action = pick(rnd, RUM_ACTIONS)
  return withStream({
    _time: tMs,
    _weight: weight,
    _msg: action,
    env: ENV,
    service: 'cubedemo-web',
    'event.domain': 'nr.browser.page_action',
    eventType: 'PageAction',
    actionName: action,
    'browser.device_type': rnd() < 0.4 ? 'mobile' : 'desktop',
    'host.name': 'minikube',
  }, LOG_STREAM_KEYS)
}

function logShapes() {
  const out = []
  for (const [svc, level, perHour] of LOG_APP_VOLUME) {
    out.push({
      base: perHour,
      // D12: the incident is error logs on payment, ×15.
      incidentMul: svc === 'payment' && level === 'error' ? 15 : 1,
      make: (ctx) => makeAppLog(svc, level, ctx),
    })
  }
  for (const [container, pod, perHour, iostream] of K8S_CONTAINERS) {
    out.push({ base: perHour, incidentMul: 1, make: (ctx) => makeK8sLog(container, pod, iostream, ctx) })
  }
  out.push({ base: 78, incidentMul: 1, make: makeK8sEvent })
  out.push({ base: 104, incidentMul: 1, make: makeRumLog })
  return out
}

// ---------- Traces vocabulary ----------

// tracesExplorer.js TRACE_SERVICES, and its routes/controllers.
const TRACE_ROUTES = {
  'order-service': '/v1/order',
  'payment-service': '/v1/payment',
  'shipment-service': '/v1/shipment',
  'search-service': '/v1/search',
  'notify-service': '/v1/notify',
  'analytics-service': '/v1/analytics',
  'cubedemo-web': '/checkout',
  'demo-nodejs-service': '/v1/cart',
}

const TRACE_CONTROLLERS = {
  'order-service': 'order', 'payment-service': 'payment', 'shipment-service': 'shipment',
  'search-service': 'search', 'notify-service': 'notify', 'analytics-service': 'analytics',
  'cubedemo-web': 'checkout', 'demo-nodejs-service': 'cart',
}

// Span rows per hour per service, in live-data.md §3.1's proportions scaled to
// its event.domain=span total (139,270/h). ledger-service is not one of our
// services, so its share is not generated.
const SPANS_PER_HOUR = {
  'payment-service': 30088, 'notify-service': 23147, 'search-service': 20099,
  'order-service': 19527, 'shipment-service': 19303, 'analytics-service': 18692,
  'cubedemo-web': 6652, 'demo-nodejs-service': 1764,
}

// Server-span p50/p90 in ms (live-data.md §3.1 service summary).
const SERVICE_LATENCY = {
  'analytics-service': [31, 61], 'notify-service': [81, 146], 'cubedemo-web': [950, 1439],
  'payment-service': [221, 358], 'shipment-service': [196, 229], 'search-service': [104, 309],
  'order-service': [190, 284], 'demo-nodejs-service': [12, 19],
}

// Baseline share of spans that carry status_code=ERROR. payment's rises to
// ~45% at the top of the incident.
const SERVICE_ERROR_PCT = {
  'analytics-service': 0.002, 'notify-service': 0.03, 'cubedemo-web': 0.09,
  'payment-service': 0.04, 'shipment-service': 0.03, 'search-service': 0.03,
  'order-service': 0.035, 'demo-nodejs-service': 0.025,
}

const TRACE_HOSTS = ['cubedemo-prod-eks-5b8c9d2e1f-q83rw', 'cubedemo-prod-eks-5b8c9d2e1f-lm42x', 'cubedemo-prod-eks-7a1b3c4d5e-t90kp']

const DB_PEERS = {
  mysql: 'cubedemo.abcdefgh.us-west-2.rds.amazonaws.com',
  redis: 'cubedemo.abcdefgh.us-west-2.cache.amazonaws.com',
  mongodb: 'cubedemo.abcdefgh.docdb.amazonaws.com',
}

const OTEL_LIB = { mysql: 'io.opentelemetry.jdbc', redis: 'io.opentelemetry.redis', mongodb: 'io.opentelemetry.mongodb' }

// Endpoints per service: the two spellings tracesExplorer already emits (65%
// POST), a third verb, and one long-tail batch route — live-data.md §4 note 5,
// which is what makes a "slowest endpoint" callout have something to find.
// payment-service also carries the RED routes services.js lists for it.
function endpointsFor(service) {
  const route = TRACE_ROUTES[service]
  const eps = [
    { root: `POST ${route}`, share: 0.46 },
    { root: `GET ${route}`, share: 0.28 },
    { root: `PATCH ${route}`, share: 0.13 },
    { root: `POST ${route}/bulk-sync`, share: 0.013, longTail: true },
  ]
  if (service === 'payment-service') {
    eps.push({ root: 'POST /v1/payments', share: 0.07 })
    eps.push({ root: 'GET /v1/payments/:id', share: 0.04 })
    eps.push({ root: 'POST /v1/payments/:id/capture', share: 0.007 })
  }
  return eps
}

function clientOpsFor(service) {
  const ctrl = TRACE_CONTROLLERS[service]
  const ops = [
    { name: `INSERT cubedemo.${ctrl}`, share: 0.25, db: { system: 'mysql', op: 'INSERT', table: ctrl }, p50: 11, p90: 19 },
    { name: `SELECT cubedemo.${ctrl}`, share: 0.14, db: { system: 'mysql', op: 'SELECT', table: ctrl }, p50: 24, p90: 64 },
    { name: `SET cubedemo:${ctrl}`, share: 0.18, db: { system: 'redis', op: 'SET' }, p50: 3, p90: 8 },
    { name: `GET cubedemo:${ctrl}`, share: 0.13, db: { system: 'redis', op: 'GET' }, p50: 2, p90: 3 },
    { name: `db.${ctrl}.insertOne`, share: 0.08, db: { system: 'mongodb', op: 'insertOne', coll: ctrl }, p50: 9, p90: 19 },
    { name: `POST notify.cubedemo.com/v1/${ctrl}`, share: 0.12, http: { method: 'POST', peer: 'notify.cubedemo.com', path: `/v1/${ctrl}` }, p50: 61, p90: 119 },
    { name: 'POST api.twilio.com/v1/sendSMS', share: 0.06, http: { method: 'POST', peer: 'api.twilio.com', path: '/v1/sendSMS' }, p50: 21, p90: 39 },
    { name: 'GET maps.googleapis.com/v1/', share: 0.04, http: { method: 'GET', peer: 'maps.googleapis.com', path: '/v1/' }, p50: 11, p90: 20 },
  ]
  if (service === 'payment-service') {
    ops.push({ name: 'POST api.stripe.com/v1/charges', share: 0.14, http: { method: 'POST', peer: 'api.stripe.com', path: '/v1/charges' }, p50: 88, p90: 180 })
  }
  return ops
}

// live-data.md §3.1: client 53%, internal 26%, server 20% of span rows.
function opsFor(service) {
  const ctrl = TRACE_CONTROLLERS[service]
  const [p50, p90] = SERVICE_LATENCY[service]
  const eps = endpointsFor(service)
  const epTotal = eps.reduce((a, e) => a + e.share, 0)
  const ops = []
  for (const ep of eps) {
    ops.push({
      kind: 'server', name: ep.root, share: 0.20 * (ep.share / epTotal), category: 'http',
      p50: ep.longTail ? 4400 : p50, p90: ep.longTail ? 5100 : p90, longTail: ep.longTail,
      http: { method: ep.root.slice(0, ep.root.indexOf(' ')), route: ep.root.slice(ep.root.indexOf(' ') + 1) },
    })
  }
  ops.push({ kind: 'internal', name: `${ctrl}Controller.create`, share: 0.13, p50: p50 * 0.92, p90: p90 * 0.92 })
  ops.push({ kind: 'internal', name: `${ctrl}Dao.save`, share: 0.07, p50: 4, p90: 7 })
  ops.push({ kind: 'internal', name: 'Transaction.commit', share: 0.06, p50: 3, p90: 5 })
  const clients = clientOpsFor(service)
  const cTotal = clients.reduce((a, c) => a + c.share, 0)
  for (const c of clients) {
    ops.push({ ...c, kind: 'client', share: 0.54 * (c.share / cTotal), category: c.db ? 'db' : 'http' })
  }
  return ops
}

const HTTP_OK = ['200', '200', '200', '201', '204', '400']
const HTTP_ERR = ['500', '500', '502', '504', '402', '429']

function makeSpan(service, op, endpoints, { rnd, tMs, weight, frac, f }) {
  const incident = service === 'payment-service' ? f : 0
  const errPct = SERVICE_ERROR_PCT[service] + 0.41 * incident
  // The error decision reads the sample's own position inside this shape's
  // slice rather than a fresh draw, so consecutive samples of one operation
  // spread evenly across the slice and the shape's error share comes out at
  // errPct instead of wandering.
  const isError = frac < errPct
  // Redis is what actually gives out under the incident, so its spans slow
  // down harder than the request spans that wait on them.
  const slow = 1 + (op.db?.system === 'redis' ? 5.5 : 3.4) * incident
  const durationNs = Math.round(sampleDuration(rnd, op.p50, op.p90) * slow * 1e6)
  // Every span in a trace carries the root's name, which is what lets a
  // `group by (root_name)` on client spans say which endpoint paid for them.
  let root = op.kind === 'server' ? op.name : endpoints[0].root
  if (op.kind !== 'server') {
    let u = rnd() * endpoints.reduce((a, e) => a + e.share, 0)
    for (const e of endpoints) { u -= e.share; if (u <= 0) { root = e.root; break } }
  }
  const row = {
    _time: tMs,
    _weight: weight,
    _msg: op.name,
    env: ENV,
    service,
    span_name: op.name,
    span_kind: op.kind,
    status_code: isError ? 'ERROR' : 'UNSET',
    duration: durationNs,
    root_name: root,
    'event.domain': 'span',
    trace_id: hexId(rnd, 32),
    span_id: hexId(rnd, 16),
    parent_id: op.kind === 'server' ? '' : hexId(rnd, 16),
    // ARCH D11: payment-service runs a 20% canary, and the incident is worse
    // on it. Everything else is on the one version tracesExplorer stamps.
    'service.version': service === 'payment-service' && rnd() < 0.2 ? 'v9.11.0' : 'v9.10.1',
    'host.name': pick(rnd, TRACE_HOSTS),
  }
  if (op.category) row.category = op.category
  if (op.kind === 'server') {
    row['http.method'] = op.http.method
    row['http.route'] = op.http.route
    row['http.target'] = op.http.route
    row['http.status_code'] = pick(rnd, isError ? HTTP_ERR : HTTP_OK)
    row['otel.library.name'] = 'io.opentelemetry.tomcat-7.0'
  } else if (op.db) {
    row['db.system'] = op.db.system
    row['db.operation'] = op.db.op
    row['db.name'] = op.db.system === 'redis' ? '0' : 'cubedemo'
    row['net.peer.name'] = DB_PEERS[op.db.system]
    row['otel.library.name'] = OTEL_LIB[op.db.system]
    if (op.db.table) row['db.sql.table'] = op.db.table
    if (op.db.coll) row['db.mongodb.collection'] = op.db.coll
  } else if (op.http) {
    row['http.method'] = op.http.method
    row['http.url'] = `https://${op.http.peer}${op.http.path}`
    row['http.status_code'] = pick(rnd, isError ? HTTP_ERR : HTTP_OK)
    row['net.peer.name'] = op.http.peer
    row['otel.library.name'] = 'io.opentelemetry.apache-httpclient-4.0'
  }
  if (isError) {
    row.error = 'true'
    // tracesExplorer's rule: the status propagates up the chain, but the
    // exception is only recorded at the process boundaries that saw it.
    if (op.kind !== 'internal') {
      const redis = incident > 0 && op.db?.system === 'redis'
      row['exception.type'] = redis ? EXC.redis : 'java.lang.RuntimeException'
      row['exception.message'] = redis ? REDIS_FAIL : incident > 0 ? DB_FAIL : 'Downstream call failed'
    }
  }
  return withStream(row, TRACE_STREAM_KEYS)
}

function traceShapes() {
  const out = []
  for (const service of Object.keys(SPANS_PER_HOUR)) {
    const perHour = SPANS_PER_HOUR[service]
    const endpoints = endpointsFor(service)
    for (const op of opsFor(service)) {
      out.push({
        base: perHour * op.share,
        // ARCH D11: throughput dips ~8% on the service that is failing.
        incidentMul: service === 'payment-service' ? 0.92 : 1,
        make: (ctx) => makeSpan(service, op, endpoints, ctx),
      })
    }
  }
  return out
}

const SHAPES = { vlogs: logShapes(), traces: traceShapes() }

// ---------- Sampling ----------

const SAMPLES_PER_BUCKET = 24

// A query that asks for more buckets than this has already been rejected by
// the API's point cap (api.js MAX_POINTS). The guard is here so a direct
// caller cannot hang the tab either.
const MAX_BUCKETS = 12000

function fillBucket(out, ds, bucketStart, fromSec, toSec) {
  const shapes = SHAPES[ds]
  const rnd = rndFor(`${ds}|${bucketStart}`)
  const spanSec = toSec - fromSec
  const midMs = (fromSec + spanSec / 2) * 1000
  const f = incidentFactor(midMs)

  const w = new Array(shapes.length)
  let total = 0
  for (let i = 0; i < shapes.length; i++) {
    const s = shapes[i]
    w[i] = s.base * (s.incidentMul === 1 ? 1 : 1 + (s.incidentMul - 1) * f)
    total += w[i]
  }
  if (total <= 0) return

  // `base` is events per hour, so this is the real number of events in the
  // bucket — the number the sampled rows' weights have to add up to.
  const events = total * (spanSec / 3600) * shapeOfDay(midMs) * (0.95 + rnd() * 0.1)
  if (!(events > 0)) return

  // Systematic sampling: one sweep through the cumulative mix at a fixed
  // stride with a per-bucket offset. Every group whose share is at least 1/K
  // is hit every bucket, and anything rarer is hit at exactly its own rate.
  const K = SAMPLES_PER_BUCKET
  const u0 = rnd()
  const picks = new Array(K)
  const fracs = new Array(K)
  let idx = 0
  let acc = w[0]
  for (let j = 0; j < K; j++) {
    const u = ((j + u0) / K) * total
    while (u >= acc && idx < shapes.length - 1) { idx++; acc += w[idx] }
    picks[j] = idx
    fracs[j] = w[idx] > 0 ? (u - (acc - w[idx])) / w[idx] : 0
  }

  // Every sampled row carries the same weight, and that is the unbiased one: a
  // group holding share p of the mix gets about K·p of the K samples, so K·p
  // rows × events/K adds up to its real share of the bucket. A group rarer
  // than 1/K is sampled in that same fraction of buckets instead, which is
  // where the sparse, gappy series the real server returns come from.
  const weight = events / K

  const rows = []
  for (let j = 0; j < K; j++) {
    const i = picks[j]
    // The golden-ratio stride decorrelates a row's position in the bucket from
    // its position in the mix; placing them in sample order would put every
    // row of one group at the same instant.
    const tMs = (fromSec + spanSec * ((j * 0.6180339887498949 + u0) % 1)) * 1000
    rows.push(shapes[i].make({ rnd, tMs, weight, frac: fracs[j], f }))
  }
  rows.sort((a, b) => a._time - b._time)
  for (const r of rows) out.push(r)
}

/**
 * The rows a query over [start, end] reads, sampled per step bucket.
 *
 * @param {'vlogs'|'traces'} datasource — anything else is read as logs
 * @param {{ start:number, end:number, step:number }} window — unix SECONDS
 * @returns {Array<object>} rows `{ _time: ms, _weight, _msg, _stream:{…}, …fields }`,
 *   oldest first. `_weight` is how many real events the row stands for, so a
 *   count is `Σ _weight`, not `rows.length`.
 */
export function eventsFor(datasource, { start, end, step } = {}) {
  const ds = datasource === 'traces' ? 'traces' : 'vlogs'
  if (![start, end, step].every(Number.isFinite) || step <= 0 || end <= start) return []
  const out = []
  const first = Math.floor(start / step) * step
  let n = 0
  for (let b = first; b < end && n < MAX_BUCKETS; b += step, n++) {
    const from = Math.max(b, start)
    const to = Math.min(b + step, end)
    if (to > from) fillBucket(out, ds, b, from, to)
  }
  return out
}
