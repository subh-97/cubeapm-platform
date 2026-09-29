/**
 * Log records that are not application request logs.
 *
 * Every field name and value shape here was read off a running CubeAPM rather
 * than invented: the k8s events come from the k8sobjects receiver on
 * playground.cubeapm.com, the database spans from its OTel Java agent, and the
 * vendor-alias records from an instance ingesting New Relic and Elastic agents
 * side by side. The point of seeding them is that one instance really does
 * carry three spellings of a trace id, and a record drawer that matches on
 * exact field names only works for whichever agent it was written against.
 */

// Which keys are stream fields is a property of the row, not of the field name:
// k8s.namespace.name is a stream key on a container log and a plain body field
// on a k8s event. Filtering has to read this per record, so it is stored.

const MANAGED_FIELDS =
  '[{"manager":"kube-controller-manager","operation":"Update","apiVersion":"v1",' +
  '"time":"2026-08-31T08:03:38Z","fieldsType":"FieldsV1","fieldsV1":{"f:count":{},' +
  '"f:firstTimestamp":{},"f:involvedObject":{},"f:lastTimestamp":{},"f:message":{},' +
  '"f:reason":{},"f:reportingComponent":{},"f:source":{"f:component":{}},"f:type":{}}}]'

const K8S_EVENTS = [
  {
    type: 'Normal', reason: 'SuccessfulCreate',
    note: 'Created pod: otel-collector-agent-xwcqm',
    kind: 'DaemonSet', name: 'otel-collector-agent', ns: 'default',
    controller: 'daemonset-controller', component: 'daemonset-controller', host: '',
  },
  {
    type: 'Warning', reason: 'BackOff',
    note: 'Back-off restarting failed container checkout in pod checkout-7d9f4b8c6-x2mlq',
    kind: 'Pod', name: 'checkout-7d9f4b8c6-x2mlq', ns: 'default',
    controller: 'kubelet', component: 'kubelet', host: 'minikube',
  },
  {
    type: 'Warning', reason: 'FailedScheduling',
    note: '0/3 nodes are available: 3 Insufficient memory. preemption: 0/3 nodes are available.',
    kind: 'Pod', name: 'search-6c48d9f7b-qq4rt', ns: 'default',
    controller: 'default-scheduler', component: 'default-scheduler', host: '',
  },
  {
    type: 'Normal', reason: 'Killing',
    note: 'Stopping container etcd',
    kind: 'Pod', name: 'etcd-minikube', ns: 'kube-system',
    controller: 'kubelet', component: 'kubelet', host: 'minikube',
  },
]

function k8sEventRow(spec, t, i) {
  const uid = `0645290d-aa3e-43af-84fc-2a945ad3d${(626 + i).toString().padStart(3, '0')}`
  return {
    level: spec.type === 'Warning' ? 'warn' : 'info',
    service: '',
    // Real k8s event rows carry no _msg at all, so the drawer has to build a
    // title out of reason and note. Storing the literal UNSET keeps that honest.
    message: 'UNSET',
    stream: ['env', 'event.domain'],
    tags: {
      env: 'UNSET',
      'cube.environment': 'UNSET',
      'event.domain': 'k8s',
      'event.name': `${spec.name}.18d0d5261eea9f${(78 + i).toString(16)}`,
      'k8s.namespace.name': spec.ns,
      'k8s.resource.name': 'events',
      'object.apiVersion': 'events.k8s.io/v1',
      'object.kind': 'Event',
      'object.type': spec.type,
      'object.reason': spec.reason,
      'object.note': spec.note,
      'object.regarding.kind': spec.kind,
      'object.regarding.name': spec.name,
      'object.regarding.namespace': spec.ns,
      'object.regarding.apiVersion': spec.kind === 'Pod' ? 'v1' : 'apps/v1',
      'object.regarding.uid': uid,
      'object.reportingController': spec.controller,
      'object.reportingInstance': spec.host || spec.controller,
      'object.deprecatedSource.component': spec.component,
      'object.deprecatedSource.host': spec.host,
      'object.deprecatedCount': '1',
      'object.deprecatedFirstTimestamp': t.toISOString().replace(/\.\d+Z$/, 'Z'),
      'object.deprecatedLastTimestamp': t.toISOString().replace(/\.\d+Z$/, 'Z'),
      'object.metadata.name': `${spec.name}.18d0d5261eea9f${(78 + i).toString(16)}`,
      'object.metadata.namespace': spec.ns,
      'object.metadata.uid': uid,
      'object.metadata.creationTimestamp': t.toISOString().replace(/\.\d+Z$/, 'Z'),
      'object.metadata.resourceVersion': String(737 + i),
      'object.metadata.managedFields': MANAGED_FIELDS,
    },
  }
}

// The resource block an OTel SDK stamps on every span. It is identical across
// thousands of rows and, sorted alphabetically, it is the entire first screen
// of the record — which is the reason the drawer collapses it.
const JVM_RESOURCE = {
  '_resource.container.id': '6ed3447c9e665be063de6c194566eacd39f573e8a77b04b1ca6a8cf395080556',
  '_resource.cube.environment': 'UNSET',
  '_resource.host.arch': 'amd64',
  '_resource.os.description': 'Linux 5.4.209-116.367.amzn2.x86_64',
  '_resource.os.type': 'linux',
  '_resource.process.command_line':
    '/usr/local/openjdk-11/bin/java -javaagent:opentelemetry-javaagent.jar -Duser.timezone=UTC',
  '_resource.process.executable.path': '/usr/local/openjdk-11/bin/java',
  '_resource.process.pid': '1',
  '_resource.process.runtime.description': 'Oracle Corporation OpenJDK 64-Bit Server VM 11.0.16+8',
  '_resource.process.runtime.name': 'OpenJDK Runtime Environment',
  '_resource.process.runtime.version': '11.0.16+8',
  '_resource.telemetry.auto.version': '1.22.1',
  '_resource.telemetry.sdk.language': 'java',
  '_resource.telemetry.sdk.name': 'opentelemetry',
  '_resource.telemetry.sdk.version': '1.22.0',
}

const DB_SPANS = [
  {
    system: 'mysql', service: 'notify-service', op: 'INSERT', table: 'notify',
    statement: 'insert into `notify` (`created_at`, `updated_at`, `service`, `data`) values (?, ?, ?, ?)',
    name: 'cubedemo', user: 'notify', port: '3306',
    peer: 'cubedemo.abcdefgh.us-west-2.rds.amazonaws.com',
    conn: 'mysql://cubedemo.abcdefgh.us-west-2.rds.amazonaws.com:3306',
    lib: 'io.opentelemetry.jdbc', root: 'POST /v1/shipment', durMs: 24,
  },
  {
    system: 'mysql', service: 'order-service', op: 'SELECT', table: 'orders',
    statement: 'select * from `orders` where `user_id` = ? order by `created_at` desc limit ?',
    name: 'cubedemo', user: 'order', port: '3306',
    peer: 'cubedemo.abcdefgh.us-west-2.rds.amazonaws.com',
    conn: 'mysql://cubedemo.abcdefgh.us-west-2.rds.amazonaws.com:3306',
    lib: 'io.opentelemetry.jdbc', root: 'GET /v1/order', durMs: 1840,
  },
  {
    system: 'redis', service: 'search-service', op: 'SET', key: 'cubedemo:search',
    statement: 'SET cubedemo:search <value>',
    name: '0', port: '6379',
    peer: 'cubedemo.abcdefgh.us-west-2.cache.amazonaws.com',
    lib: 'io.opentelemetry.redis', root: 'GET /v1/search/fame', durMs: 8,
  },
  {
    system: 'redis', service: 'cart-service', op: 'GET', key: 'cubedemo:cart:1049',
    statement: 'GET cubedemo:cart:1049',
    name: '0', port: '6379',
    peer: 'cubedemo.abcdefgh.us-west-2.cache.amazonaws.com',
    lib: 'io.opentelemetry.redis', root: 'GET /v1/cart', durMs: 3,
  },
]

function dbSpanRow(spec, t, hex) {
  const tags = {
    ...JVM_RESOURCE,
    env: 'UNSET',
    'event.domain': 'span',
    service: spec.service,
    'service.version': 'v8.31.9',
    'host.name': 'ip-10-0-129-151',
    category: 'db',
    span_kind: 'client',
    status_code: 'UNSET',
    span_name: spec.system === 'redis' ? `${spec.op} ${spec.key}` : `${spec.op} ${spec.name}.${spec.table}`,
    root_name: spec.root,
    span_id: hex(16),
    parent_id: hex(16),
    trace_id: hex(32),
    duration: String(spec.durMs * 1_000_000),
    'db.system': spec.system,
    'db.name': spec.name,
    'db.operation': spec.op,
    'db.statement': spec.statement,
    'net.peer.name': spec.peer,
    'net.peer.port': spec.port,
    'otel.library.name': spec.lib,
    'otel.library.version': '1.22.1-alpha',
  }
  if (spec.table) tags['db.sql.table'] = spec.table
  if (spec.user) tags['db.user'] = spec.user
  if (spec.conn) tags['db.connection_string'] = spec.conn
  if (spec.key) tags['redis.key'] = spec.key
  return {
    level: spec.durMs > 1000 ? 'warn' : 'info',
    service: spec.service,
    message: 'UNSET',
    stream: ['env', 'event.domain', 'service', 'span_kind', 'status_code'],
    tags,
  }
}

const K8S_PODS = [
  { pod: 'etcd-minikube', container: 'etcd', ns: 'kube-system', owner: 'k8s.statefulset.name', ownerName: 'etcd' },
  { pod: 'coredns-66bc5c9577-lmh6b', container: 'coredns', ns: 'kube-system', owner: 'k8s.deployment.name', ownerName: 'coredns' },
  { pod: 'kube-apiserver-minikube', container: 'kube-apiserver', ns: 'kube-system', owner: '', ownerName: '' },
]

function k8sPodLogRow(spec, t, i) {
  const tags = {
    env: 'UNSET',
    'cube.environment': 'UNSET',
    severity: 'info',
    'host.name': 'minikube',
    'k8s.namespace.name': spec.ns,
    'k8s.pod.name': spec.pod,
    'k8s.pod.uid': `9f2c1d4e-77aa-4b31-9c0e-3a51bd${(400 + i).toString().padStart(4, '0')}`,
    'k8s.pod.start_time': '2026-08-31T08:03:12Z',
    'k8s.node.name': 'minikube',
    'k8s.container.name': spec.container,
    'k8s.container.restart_count': '0',
    'log.file.path': `/var/log/pods/${spec.ns}_${spec.pod}/${spec.container}/0.log`,
    'log.iostream': 'stderr',
    'os.type': 'linux',
    'scope.name': 'otelcol/filelogreceiver',
    'scope.version': '0.126.0',
    caller: 'mvcc/kvstore_compaction.go:68',
    took: '1.28675ms',
    revision: String(20140 + i),
  }
  const stream = ['env', 'k8s.namespace.name']
  if (spec.owner) { tags[spec.owner] = spec.ownerName; stream.push(spec.owner) }
  return {
    level: 'info',
    service: '',
    message: `finished scheduled compaction compact-revision=${20140 + i} took=1.28675ms`,
    stream,
    tags,
  }
}

// Two records that say the same thing in two vendors' spellings. They exist so
// the drawer can be checked against the case it will actually meet in the
// field: one CubeAPM instance holding trace_id, trace.id and span.id at once.
function newRelicRow(t, hex) {
  return {
    level: 'error',
    service: 'checkout',
    message: 'Failed connecting to database',
    stream: ['env', 'level', 'service.name'],
    tags: {
      env: 'UNSET',
      'cube.environment': 'UNSET',
      level: 'error',
      'service.name': 'checkout',
      hostname: 'ip-10-0-143-40',
      'host.name': 'ip-10-0-143-40',
      'entity.guid': 'MzQ1Njc4OXxBUE18QVBQTElDQVRJT058MTIzNDU2',
      'entity.name': 'checkout',
      'entity.type': 'SERVICE',
      'trace.id': hex(32),
      'span.id': hex(16),
      'process.pid': '1',
      'logger.name': 'com.cubedemo.checkout.OrderController',
      'thread.name': 'http-nio-8080-exec-7',
      'error.class': 'java.sql.SQLTransientConnectionException',
      'error.message': 'HikariPool-1 - Connection is not available, request timed out after 30000ms',
      'error.stack':
        'java.sql.SQLTransientConnectionException: HikariPool-1 - Connection is not available\n' +
        '\tat com.zaxxer.hikari.pool.HikariPool.createTimeoutException(HikariPool.java:696)\n' +
        '\tat com.cubedemo.checkout.OrderRepository.save(OrderRepository.java:88)\n' +
        '\tat com.cubedemo.checkout.OrderController.submit(OrderController.java:142)',
    },
  }
}

function elasticRow(t, hex) {
  return {
    level: 'warn',
    service: 'inventory',
    message: 'Stock reservation retried after lock contention on sku=SKU-88213',
    stream: ['env', 'level', 'service.name'],
    tags: {
      env: 'UNSET',
      '@timestamp': t.toISOString(),
      'ecs.version': '8.11.0',
      'event.dataset': 'inventory.log',
      'log.level': 'warn',
      'log.logger': 'com.cubedemo.inventory.StockService',
      'process.thread.name': 'reservation-worker-2',
      service: 'inventory',
      'service.version': '4.2.0',
      'service.environment': 'production',
      'host.name': 'ip-10-0-143-41',
      'transaction.id': hex(16),
      'trace.id': hex(32),
      'error.type': 'OptimisticLockException',
      'error.stack_trace':
        'javax.persistence.OptimisticLockException: Row was updated by another transaction\n' +
        '\tat com.cubedemo.inventory.StockService.reserve(StockService.java:204)\n' +
        '\tat com.cubedemo.inventory.ReservationWorker.run(ReservationWorker.java:61)',
    },
  }
}

/**
 * Builds the non-request records and stamps them onto the same timeline as the
 * generated request logs, so they interleave in the stream rather than sitting
 * in a block at one end of it.
 */
export function extraLogRecords({ baseTime, rnd }) {
  const hex = (len) => Array.from({ length: len }, () => Math.floor(rnd() * 16).toString(16)).join('')
  const now = baseTime.getTime()
  const specs = [
    ...K8S_EVENTS.map((s, i) => (t) => k8sEventRow(s, t, i)),
    ...DB_SPANS.map(s => (t) => dbSpanRow(s, t, hex)),
    ...K8S_PODS.map((s, i) => (t) => k8sPodLogRow(s, t, i)),
    (t) => newRelicRow(t, hex),
    (t) => elasticRow(t, hex),
  ]
  return specs.map((make, i) => {
    // Spread across the same window the request logs occupy (180 rows, 20s apart).
    const t = new Date(now - ((i * 13 + 7) * 20 + rnd() * 8) * 1000)
    const row = make(t)
    return {
      ...row,
      id: `log_x${i}_${Math.floor(rnd() * 100000)}`,
      time: t,
      timeStr: `${t.getHours().toString().padStart(2, '0')}:${t.getMinutes().toString().padStart(2, '0')}:${t.getSeconds().toString().padStart(2, '0')}.${Math.floor(rnd() * 1000).toString().padStart(3, '0')}`,
      dateStr: t.toISOString().slice(0, 10),
    }
  })
}
