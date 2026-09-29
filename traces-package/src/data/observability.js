import { extraLogRecords } from './logRecordTypes'
import { isNoiseField } from '@/utils/logFields'

export const BASE_TIME = new Date()

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

function generateLogs(n = 180) {
  const rnd = seededRnd(17)
  const now = BASE_TIME.getTime()
  const rows = []
  for (let i = 0; i < n; i++) {
    const offsetSec = i * 20 + rnd() * 8
    const t = new Date(now - offsetSec * 1000)
    const svc = LOG_SERVICES[Math.floor(rnd() * LOG_SERVICES.length)]
    let level
    const r = rnd()
    if (r < 0.12) level = 'error'
    else if (r < 0.38) level = 'warn'
    else level = 'info'
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

// Request logs keep their own seed so adding another record type never
// reshuffles them. The rest are merged in and the whole stream re-sorted,
// because a drawer that only ever sees one record shape is not being tested.
export const logRows = [
  ...generateLogs(180),
  ...extraLogRecords({ baseTime: BASE_TIME, rnd: seededRnd(43) }),
].sort((a, b) => b.time - a.time)

function generateLogVolume(points = 60) {
  const rnd = seededRnd(29)
  const out = []
  for (let i = points - 1; i >= 0; i--) {
    const info = Math.round(30 + rnd() * 25)
    const warn = Math.round(2 + rnd() * 6)
    const error = Math.round(0.5 + rnd() * 3)
    out.push({ m: i, info, warn, error, total: info + warn + error, label: i === 0 ? 'now' : `-${i}m` })
  }
  return out
}
export const logVolume = generateLogVolume(60)

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

function buildLogFacets(rows) {
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

function generateHostSeries({ base, incident, seed }) {
  const rnd = seededRnd(seed)
  const out = []
  for (let i = 59; i >= 0; i--) {
    const jitter = (rnd() - 0.5) * 0.12
    let v = base * (1 + jitter)
    if (incident && i <= 22) {
      const into = 22 - i
      const ramp = Math.min(1, into / 4)
      v = base * (1 + (incident - 1) * ramp) * (1 + jitter)
    }
    out.push({ m: i, value: Math.max(0, Math.round(v * 100) / 100) })
  }
  return out
}

const HOST_ROWS = [
  { host: 'ip-10-0-129-151', service: 'analytics-service', cpu: 26.21, mem: 38.95, disk: 73.6, netIn: 10.3, netOut: 4.84, cpuUnit: 'K', unit: 'M', status: 'healthy' },
  { host: 'ip-10-0-130-150', service: 'notify-service', cpu: 33.15, mem: 78.05, disk: 71.55, netIn: 3.04, netOut: 1.57, unit: 'M', status: 'warning' },
  { host: 'ip-10-0-142-133', service: 'payment-service', cpu: 92.4, mem: 88.2, disk: 72.8, netIn: 2.89, netOut: 1.76, unit: 'M', status: 'critical' },
  { host: 'ip-10-0-142-2', service: 'payment-service', cpu: 89.1, mem: 84.4, disk: 71.43, netIn: 2.84, netOut: 1.61, unit: 'M', status: 'critical' },
  { host: 'ip-10-0-143-40', service: 'shipment-service', cpu: 87.5, mem: 86.7, disk: 71.87, netIn: 2.79, netOut: 1.52, unit: 'M', status: 'critical' },
  { host: 'ip-10-0-144-12', service: 'search-service', cpu: 30.83, mem: 77.43, disk: 68.4, netIn: 1.9, netOut: 0.88, unit: 'K', status: 'healthy' },
  { host: 'minikube', service: 'demo-nodejs-service', cpu: 26.36, mem: 42.49, disk: 73.6, netIn: 1.9, netOut: 0.88, unit: 'K', status: 'healthy' },
]

export const infraHosts = HOST_ROWS.map((h, i) => ({
  ...h,
  cpuSeries: generateHostSeries({ base: h.cpu, incident: h.status === 'critical' ? 1.4 : null, seed: 401 + i }),
  memSeries: generateHostSeries({ base: h.mem, incident: h.status === 'critical' ? 1.15 : null, seed: 501 + i }),
  diskSeries: generateHostSeries({ base: h.disk, incident: null, seed: 601 + i }),
  netInSeries: generateHostSeries({ base: h.netIn * (h.unit === 'K' ? 100 : 100000), incident: h.status === 'critical' ? 1.3 : null, seed: 701 + i }),
  netOutSeries: generateHostSeries({ base: h.netOut * (h.unit === 'K' ? 100 : 100000), incident: h.status === 'critical' ? 1.3 : null, seed: 801 + i }),
  diskIoSeries: generateHostSeries({ base: h.status === 'critical' ? 34 : 5.5, incident: h.status === 'critical' ? 1.6 : null, seed: 901 + i }),
}))

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

function genAllocSeries({ total, request, limit, usedBase, seed }) {
  const rnd = seededRnd(seed)
  const totalArr = [], requestArr = [], limitArr = [], usedArr = []
  for (let i = 59; i >= 0; i--) {
    const jitter = (rnd() - 0.5) * 0.06
    totalArr.push({ m: i, value: total })
    requestArr.push({ m: i, value: request })
    limitArr.push({ m: i, value: limit })
    usedArr.push({ m: i, value: Math.max(0, usedBase * (1 + jitter)) })
  }
  return { total: totalArr, request: requestArr, limit: limitArr, used: usedArr }
}

export const k8sCpuAllocation = genAllocSeries({ total: 4, request: 1, limit: 4, usedBase: 0.1, seed: 1901 })
export const k8sMemAllocation = genAllocSeries({ total: 16_000_000_000, request: 900_000_000, limit: 16_000_000_000, usedBase: 700_000_000, seed: 1902 })

export const k8sContainersSeries = {
  ready: Array.from({ length: 60 }, (_, idx) => ({ m: 59 - idx, value: 10 })),
  notReady: Array.from({ length: 60 }, (_, idx) => ({ m: 59 - idx, value: 0 })),
}

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

export const k8sNodes = K8S_NODE_ROWS.map((n, i) => ({
  ...n,
  cpuSeries: generateHostSeries({ base: n.cpu, incident: 1.15, seed: 2001 + i }),
  memSeries: generateHostSeries({ base: n.mem, incident: 1.1, seed: 2101 + i }),
  diskSeries: generateHostSeries({ base: n.disk, incident: null, seed: 2201 + i }),
  netInSeries: generateHostSeries({ base: n.netIn * 100000, incident: 1.2, seed: 2301 + i }),
  netOutSeries: generateHostSeries({ base: n.netOut * 100000, incident: 1.2, seed: 2401 + i }),
}))

// `labels` are the pod column's tags, searched as `pod.app:redis`.
const K8S_POD_ROWS = [
  { name: 'payment-service-7d8b9c-4vk2q', labels: { app: 'payment', tier: 'backend', team: 'payments' }, namespace: 'default', node: 'ip-10-0-142-133', cpuUsed: 0.09, cpuRequest: 0.25, cpuLimit: 0.25, memUsed: 418_800_000, memRequest: 536_900_000, memLimit: 536_900_000, netIn: 12.4, netOut: 8.9 },
  { name: 'redis-0', labels: { app: 'redis', tier: 'cache', team: 'platform' }, namespace: 'default', node: 'ip-10-0-142-133', cpuUsed: 0.04, cpuRequest: 0.1, cpuLimit: 0.1, memUsed: 210_500_000, memRequest: 256_000_000, memLimit: 256_000_000, netIn: 40.2, netOut: 38.7 },
  { name: 'coredns-66bc5c9577-zkrnm', labels: { app: 'coredns', tier: 'system' }, namespace: 'kube-system', node: 'ip-10-0-142-133', cpuUsed: 0.0012, cpuRequest: 0.1, cpuLimit: 0.1, memUsed: 19_400_000, memRequest: 70_000_000, memLimit: 170_000_000, netIn: 1.1, netOut: 0.9 },
  { name: 'kube-proxy-784j7', labels: { app: 'kube-proxy', tier: 'system' }, namespace: 'kube-system', node: 'ip-10-0-143-40', cpuUsed: 0.0002, cpuRequest: 0, cpuLimit: 0, memUsed: 20_500_000, memRequest: 0, memLimit: 0, netIn: 0.4, netOut: 0.3 },
  { name: 'order-service-6c8f4b-8ct9x', labels: { app: 'order', tier: 'backend', team: 'checkout' }, namespace: 'default', node: 'ip-10-0-143-40', cpuUsed: 0.05, cpuRequest: 0.2, cpuLimit: 0.2, memUsed: 180_200_000, memRequest: 256_000_000, memLimit: 256_000_000, netIn: 9.6, netOut: 7.1 },
  { name: 'storage-provisioner', labels: { app: 'storage', tier: 'system' }, namespace: 'kube-system', node: 'ip-10-0-143-40', cpuUsed: 0.0016, cpuRequest: 0, cpuLimit: 0, memUsed: 13_100_000, memRequest: 0, memLimit: 0, netIn: 0.2, netOut: 0.2 },
]

export const k8sPods = K8S_POD_ROWS.map((p, i) => ({
  ...p,
  containerName: p.name.split('-')[0],
  cpuSeries: generateHostSeries({ base: Math.max(p.cpuUsed, 0.001), incident: null, seed: 2501 + i }),
  memSeries: generateHostSeries({ base: p.memUsed, incident: null, seed: 2601 + i }),
  diskSeries: generateHostSeries({ base: 73.9, incident: null, seed: 2701 + i }),
  restartsSeries: Array.from({ length: 60 }, (_, idx) => ({ m: 59 - idx, value: 0 })),
  netInSeries: generateHostSeries({ base: p.netIn, incident: null, seed: 2801 + i }),
  netOutSeries: generateHostSeries({ base: p.netOut, incident: null, seed: 2901 + i }),
}))

export const K8S_NAMESPACES = ['default', 'kube-system']

/**
 * The namespace rollup behind /infra?tab=k8s-cluster&section=<namespace>.
 *
 * Derived from the pods and the per-namespace allocation rather than stored, so
 * it cannot drift from the pod list the drill-down shows. Node counts are
 * deliberately absent: a node is not namespaced, which is the one real
 * difference between this view and the cluster it sits inside.
 */
export function k8sNamespaceDetail(namespace) {
  const alloc = k8sNamespaceSummary.find(n => n.namespace === namespace)
  if (!alloc) return null
  const pods = k8sPods.filter(p => p.namespace === namespace)
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
export const mysqlSeries = {
  opsPerMin: generateHostSeries({ base: 320, incident: null, seed: 3001 }),
  connErrors: generateHostSeries({ base: 0, incident: null, seed: 3002 }),
  slowQueries: generateHostSeries({ base: 0, incident: null, seed: 3003 }),
}

/* ============ REDIS ============ */

export const redisSummary = {
  host: 'redis.0', connections: 128, connPerMin: 42, cmdPerMin: 640, memUsedBytes: 1_060_000_000, cacheHitPct: 71.2, status: 'critical',
}
export const redisSeries = {
  memUsed: generateHostSeries({ base: 620_000_000, incident: 1.7, seed: 3101 }),
  cmdPerMin: generateHostSeries({ base: 610, incident: 1.05, seed: 3102 }),
  evictionsPerMin: generateHostSeries({ base: 2, incident: 18, seed: 3103 }),
}
