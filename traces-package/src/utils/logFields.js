/**
 * What a field means, regardless of which agent spelled it.
 *
 * One CubeAPM instance can hold three spellings of a trace id at once, because
 * the OTel SDK writes trace_id, the New Relic agent writes trace.id and an
 * Elastic agent writes neither. Measured on a live instance: for a single
 * trace, trace_id matched 1 log row, trace.id matched 3, and the pair matched
 * all 4. So the drawer resolves concepts, never field names — otherwise an
 * affordance appears for one agent and silently vanishes for the next.
 *
 * Every spelling below is either documented by its vendor or observed on a
 * running instance. Names that could not be confirmed either way were left out
 * on purpose; a wrong alias is worse than a missing one, because it quietly
 * mislabels a field rather than merely failing to decorate it.
 */

// Order matters: the first spelling present on a record wins, so the most
// canonical name for each concept leads.
export const ALIASES = {
  timestamp: ['_time', '@timestamp', 'timestamp'],
  message: ['_msg', 'message'],
  severity: ['severity', 'log.level', 'level', 'severity_text', 'severity.text', 'status'],
  service: ['service.name', 'service', 'entity.name'],
  serviceVersion: ['service.version', 'version'],
  env: ['deployment.environment.name', 'deployment.environment', 'env', 'service.environment', 'cube.environment'],

  traceId: ['trace_id', 'trace.id', 'dd.trace_id'],
  spanId: ['span_id', 'span.id', 'dd.span_id'],

  host: ['host.name', 'hostname', 'host'],
  pod: ['k8s.pod.name', 'pod_name', 'kubernetes.pod_name'],
  namespace: ['k8s.namespace.name', 'kube_namespace', 'orchestrator.namespace'],
  node: ['k8s.node.name', 'kube_node', 'node_name'],
  container: ['k8s.container.name', 'container.name', 'kube_container_name'],
  cluster: ['k8s.cluster.name', 'kube_cluster_name', 'cluster_name'],

  exceptionType: ['exception.type', 'log.exception.type', 'error.type', 'error.kind', 'error.class'],
  exceptionMessage: ['exception.message', 'error.message'],
  stacktrace: ['exception.stacktrace', 'log.stacktrace', 'error.stack_trace', 'error.stack'],

  logger: ['log.logger', 'logger.name', 'scope.name', 'logger.fqcn'],
  thread: ['thread.name', 'process.thread.name'],

  endpoint: ['endpoint', 'http.route', 'root_name'],
  httpStatus: ['http.status', 'http.response.status_code', 'http.status_code'],
  duration: ['duration_ms', 'duration', 'event.duration'],

  dbSystem: ['db.system.name', 'db.system'],
  dbName: ['db.namespace', 'db.name', 'db.instance'],
  dbStatement: ['db.query.text', 'db.statement'],
  dbOperation: ['db.operation.name', 'db.operation'],
  dbTable: ['db.collection.name', 'db.sql.table', 'redis.key'],
  peerHost: ['net.peer.name', 'server.address', 'network.peer.address'],
  peerPort: ['net.peer.port', 'server.port', 'network.peer.port'],
}

const CONCEPT_BY_FIELD = (() => {
  const out = {}
  for (const [concept, names] of Object.entries(ALIASES)) {
    for (const n of names) if (!(n in out)) out[n] = concept
  }
  return out
})()

export function conceptOf(field) {
  return CONCEPT_BY_FIELD[field] ?? null
}

const tagsOf = (record) => record?.tags ?? {}

/** First spelling of `concept` this record actually carries. */
export function resolveField(record, concept) {
  const tags = tagsOf(record)
  for (const field of ALIASES[concept] ?? []) {
    const value = tags[field]
    if (value != null && value !== '') return { field, value }
  }
  if (concept === 'message' && record?.message) return { field: '_msg', value: record.message }
  return null
}

export function valueOfConcept(record, concept) {
  return resolveField(record, concept)?.value ?? null
}

// Noise is per-shape, not per-field: an OTel SDK stamps the same _resource block
// on every span, and the Kubernetes API returns managedFields on every event.
// Sorted alphabetically both land at the top, which is how a record opens on a
// screen of things nobody came to read.
const NOISE_PREFIXES = ['_resource.', 'object.metadata.managedFields', 'object.deprecated']
const NOISE_EXACT = new Set([
  'object.metadata.resourceVersion',
  'object.apiVersion',
  'object.regarding.resourceVersion',
  'scope.version',
])

export function isNoiseField(field) {
  return NOISE_PREFIXES.some(p => field.startsWith(p)) || NOISE_EXACT.has(field)
}

/**
 * Which shape of record this is. Detection reads the fields that define the
 * shape rather than a stored type, because real records arrive without one.
 */
export function recordType(record) {
  const tags = tagsOf(record)
  if (tags['event.domain'] === 'k8s' || 'object.reason' in tags) return 'k8s-event'
  if (resolveField(record, 'dbSystem')) return 'db-span'
  if (resolveField(record, 'stacktrace') || resolveField(record, 'exceptionType')) return 'exception'
  if (resolveField(record, 'endpoint') || resolveField(record, 'httpStatus')) return 'request'
  if (resolveField(record, 'pod')) return 'k8s-log'
  return 'record'
}

export const TYPE_LABELS = {
  'k8s-event': 'Kubernetes event',
  'db-span': 'Database call',
  exception: 'Exception',
  request: 'Request',
  'k8s-log': 'Container log',
  record: 'Record',
}

// The concepts each shape leads with. A record opens on the answer to "what is
// this and where did it happen", and that answer is different for a database
// call than for a cluster event.
const TYPE_HIGHLIGHTS = {
  'k8s-event': ['namespace', 'node'],
  'db-span': ['dbSystem', 'dbOperation', 'duration'],
  exception: ['service', 'exceptionType', 'traceId'],
  request: ['service', 'endpoint', 'traceId'],
  'k8s-log': ['pod', 'container', 'namespace'],
  record: ['service', 'host', 'traceId'],
}

/** The fields to pin above the message, resolved through the alias table. */
export function highlightFields(record) {
  return (TYPE_HIGHLIGHTS[recordType(record)] ?? TYPE_HIGHLIGHTS.record)
    .map(c => resolveField(record, c))
    .filter(Boolean)
    .map(({ field, value }) => [field, value])
}

/**
 * A k8s event carries no message at all — the real rows store the literal
 * "UNSET" — so its title has to be built from the two fields a human actually
 * reads. Same for a database call, whose message is the statement.
 */
export function recordTitle(record) {
  const tags = tagsOf(record)
  const type = recordType(record)
  if (type === 'k8s-event') {
    const reason = tags['object.reason']
    const note = tags['object.note']
    if (reason || note) return { title: reason || 'Kubernetes event', detail: note || '' }
  }
  if (type === 'db-span') {
    const op = valueOfConcept(record, 'dbOperation')
    const target = valueOfConcept(record, 'dbTable') || valueOfConcept(record, 'dbName')
    if (op) return { title: [op, target].filter(Boolean).join(' '), detail: valueOfConcept(record, 'dbStatement') || '' }
  }
  const msg = record?.message
  const usable = msg && msg !== 'UNSET' ? msg : ''
  return { title: '', detail: usable }
}

/** Stream keys are a property of the row, not the field name. */
export function isStreamField(record, field) {
  return Array.isArray(record?.stream) && record.stream.includes(field)
}

// Infra destinations that exist, keyed by the concept rather than the spelling,
// so a New Relic pod_name opens the same page as an OTel k8s.pod.name.
const INFRA_TARGETS = {
  pod: { source: 'k8s-pod', label: 'pod' },
  node: { source: 'k8s-node', label: 'node' },
  // The namespace overview is the k8s-cluster tab scoped by section, not the
  // deployment tab - that one lists deployments and merely accepts a namespace.
  // Verified against the product: /infra?tab=k8s-cluster&section=<ns> renders a
  // picker labelled Namespace with the pod and workload rollups.
  namespace: { source: 'k8s-cluster', label: 'namespace' },
  cluster: { source: 'k8s-cluster', label: 'cluster' },
  host: { source: 'host', label: 'host' },
}

const DB_INFRA_SOURCE = { mysql: 'mysql', redis: 'redis', mongodb: 'mongo', postgresql: 'postgres' }

/**
 * Where a field goes when you click it.
 *
 * Two kinds, and the difference is the honest part: `open` means a destination
 * page exists for this value, `filter` means it does not and the best we can do
 * is narrow the stream to records that share it. Returning null means the value
 * is not worth decorating at all.
 *
 * `knownServices` is required for the service link because a log's service is
 * not always an APM service — on a real instance log rows carry `search` while
 * APM knows `search-service`. Linking anyway produces a page that loads, shows
 * nothing, and blames the user.
 */
export function linkFor({ field, value, record, knownServices }) {
  if (value == null || value === '') return null
  const concept = conceptOf(field)
  const str = String(value)

  if (concept === 'traceId') {
    return { kind: 'open', view: 'traces', traceId: str, label: 'Open this trace',
      hint: `Opens trace ${str.slice(0, 8)}… in Traces` }
  }

  if (concept === 'service') {
    const known = knownServices instanceof Set ? knownServices.has(str) : false
    return known
      ? { kind: 'open', view: 'service', serviceId: str, label: `Open ${str} in APM`,
          hint: `Opens the ${str} service page` }
      : { kind: 'filter', field, value: str, label: `Filter to ${str}`,
          hint: `No APM service named ${str} — filters the log stream instead` }
  }

  // An endpoint only means something inside a service, so it links when APM
  // knows the service and falls back to a filter when it does not - the record
  // still knows its endpoint either way.
  if (concept === 'endpoint') {
    const service = valueOfConcept(record, 'service')
    const known = service && knownServices instanceof Set && knownServices.has(String(service))
    return known
      ? { kind: 'open', view: 'service', serviceId: String(service), subTab: 'detail', endpoint: str,
          label: 'Open this endpoint', hint: `Opens ${str} on ${service} in APM` }
      : { kind: 'filter', field, value: str, label: `Filter to ${str}`,
          hint: service ? `No APM service named ${service} - filters the log stream instead`
                        : 'No service on this record - filters the log stream instead' }
  }

  const infra = INFRA_TARGETS[concept]
  if (infra) {
    return { kind: 'open', view: 'infra', source: infra.source, resource: str,
      label: `Open this ${infra.label}`, hint: `Opens ${str} in Infrastructure` }
  }

  if (concept === 'dbSystem') {
    const source = DB_INFRA_SOURCE[str.toLowerCase()]
    const peer = valueOfConcept(record, 'peerHost')
    const port = valueOfConcept(record, 'peerPort')
    const instance = peer && port ? `${peer}:${port}` : peer
    if (source && instance) {
      return { kind: 'open', view: 'infra', source, resource: String(instance),
        label: `Open this ${str} instance`, hint: `Opens ${instance} in Infrastructure` }
    }
  }

  // A span id has no destination: the trace page addresses traces, not spans.
  // Filtering is the whole of what we can offer, and saying so is better than
  // a link that lands on the trace and leaves you to find the span by eye.
  if (concept === 'spanId') {
    return { kind: 'filter', field, value: str, label: 'Filter to this span',
      hint: 'No per-span page exists — filters the stream to this span id' }
  }

  return null
}

// Groups are written as concept names where a concept exists and literal field
// names where one does not. A concept expands to every spelling it knows, and
// absent spellings drop out, so one group definition serves every agent.
const TYPE_GROUPS = {
  'k8s-event': [
    ['object.type', 'object.reason', 'object.note'],
    ['object.regarding.kind', 'object.regarding.name', 'object.regarding.namespace',
      'namespace', 'node', 'object.reportingController', 'object.deprecatedSource.component',
      'object.deprecatedSource.host', 'event.name', 'k8s.resource.name'],
  ],
  'db-span': [
    ['dbSystem', 'dbOperation', 'dbStatement', 'dbTable', 'dbName', 'db.user'],
    ['peerHost', 'peerPort', 'duration', 'service', 'spanId', 'traceId', 'endpoint', 'host'],
  ],
  exception: [
    ['exceptionType', 'exceptionMessage', 'stacktrace'],
    ['env', 'severity', 'service', 'endpoint', 'traceId', 'spanId', 'logger', 'thread', 'host'],
  ],
  request: [
    ['exceptionType', 'stacktrace'],
    ['env', 'severity', 'service', 'endpoint', 'traceId', 'path', 'httpStatus', 'duration'],
  ],
  'k8s-log': [
    ['pod', 'container', 'namespace', 'node', 'cluster'],
    ['env', 'severity', 'host', 'log.file.path', 'log.iostream',
      'k8s.pod.uid', 'k8s.container.restart_count', 'k8s.pod.start_time'],
  ],
  record: [
    ['env', 'severity', 'service', 'host', 'traceId', 'spanId'],
  ],
}

const expand = (token) => ALIASES[token] ?? [token]

/**
 * The record's fields, grouped by the question they answer, with everything
 * unnamed following in a group of its own so a new field shows up without a
 * code change here. Noise trails at the end, flagged, for the caller to fold
 * away — it is part of the record, just never the reason anyone opened it.
 */
export function fieldGroupsFor(record, { isHidden = () => false } = {}) {
  const tags = tagsOf(record)
  const spec = TYPE_GROUPS[recordType(record)] ?? TYPE_GROUPS.record
  const taken = new Set()
  const groups = []

  for (const tokens of spec) {
    const rows = []
    for (const token of tokens) {
      for (const field of expand(token)) {
        if (taken.has(field) || !(field in tags)) continue
        taken.add(field)
        if (!isHidden(field, tags[field])) rows.push([field, tags[field]])
      }
    }
    if (rows.length) groups.push({ fields: rows, noise: false })
  }

  const rest = []
  const noise = []
  for (const [field, value] of Object.entries(tags)) {
    if (taken.has(field) || isHidden(field, value)) continue
    ;(isNoiseField(field) ? noise : rest).push([field, value])
  }
  if (rest.length) groups.push({ fields: rest, noise: false })
  if (noise.length) groups.push({ fields: noise, noise: true })
  return groups
}

// Duration is the field most likely to be read wrong. OTel spans record
// nanoseconds, Datadog asks you to rescale into nanoseconds, ECS event.duration
// is nanoseconds, and an agent's own duration_ms is milliseconds - so the same
// number means a thousandfold different thing depending on the spelling.
// The raw value stays; this is the gloss beside it.
const NANOSECOND_FIELDS = new Set(['duration', 'event.duration'])

export function durationGloss(field, value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return null
  if (NANOSECOND_FIELDS.has(field)) return msLabel(n / 1e6)
  if (field === 'duration_ms') return null   // already legible in its own unit
  return null
}

function msLabel(ms) {
  if (ms < 1) return `${Math.round(ms * 1000)} µs`
  if (ms < 1000) return `${ms < 10 ? ms.toFixed(2).replace(/\.?0+$/, '') : Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(2).replace(/\.?0+$/, '')} s`
}
