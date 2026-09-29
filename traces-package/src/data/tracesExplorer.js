import { isNoiseField } from '@/utils/logFields'
import { isIdentityValue, isNumericValue, BASE_TIME } from './observability'

/* ============ TRACES / SPANS ============ */

/**
 * Span rows for the Traces explorer.
 *
 * Logs are a flat stream; spans are not. A span only means anything next to its
 * siblings, so these are generated as whole traces — a server root, the internal
 * work it does, the client calls it makes, and the server spans those land on in
 * the next service — and then flattened into the newest-first stream the table
 * reads. That is what makes a trace_id in the table worth clicking: the rows
 * around it are the rest of the same request.
 *
 * Field spellings follow OpenTelemetry, matching what the CubeAPM playground
 * returns, so the drawer's alias table resolves a span exactly as it resolves a
 * log record — `duration` in nanoseconds, `_resource.*` for agent boilerplate.
 */

const seededRnd = seed => {
  let s = seed
  return () => { s = (s * 9301 + 49297) % 233280; return s / 233280 }
}

const hexId = (rnd, len) =>
  Array.from({ length: len }, () => Math.floor(rnd() * 16).toString(16)).join('')

const pick = (rnd, arr) => arr[Math.floor(rnd() * arr.length)]

export const TRACE_SERVICES = [
  'analytics-service', 'cubedemo-web', 'demo-nodejs-service', 'notify-service',
  'order-service', 'payment-service', 'search-service', 'shipment-service',
]

export const SPAN_KINDS = ['client', 'internal', 'server']

// OTel's own spelling: a span that never set a status carries UNSET, which means
// "nothing went wrong", not "unknown". Only ERROR is a failure.
export const SPAN_STATUS_CODES = ['ERROR', 'UNSET']

const ROUTES = {
  'order-service': '/v1/order',
  'payment-service': '/v1/payment',
  'shipment-service': '/v1/shipment',
  'search-service': '/v1/search',
  'notify-service': '/v1/notify',
  'analytics-service': '/v1/analytics',
  'cubedemo-web': '/checkout',
  'demo-nodejs-service': '/v1/cart',
}

const CONTROLLERS = {
  'order-service': 'order', 'payment-service': 'payment', 'shipment-service': 'shipment',
  'search-service': 'search', 'notify-service': 'notify', 'analytics-service': 'analytics',
  'cubedemo-web': 'checkout', 'demo-nodejs-service': 'cart',
}

const DB_TARGETS = [
  { system: 'mysql', op: 'SELECT', name: 'cubedemo', table: 'orders', peer: 'cubedemo.abcdefgh.us-west-2.rds.amazonaws.com', port: '3306', user: 'cubedemo' },
  { system: 'mysql', op: 'INSERT', name: 'cubedemo', table: 'notify', peer: 'cubedemo.abcdefgh.us-west-2.rds.amazonaws.com', port: '3306', user: 'cubedemo' },
  { system: 'mysql', op: 'UPDATE', name: 'cubedemo', table: 'shipment', peer: 'cubedemo.abcdefgh.us-west-2.rds.amazonaws.com', port: '3306', user: 'cubedemo' },
  { system: 'redis', op: 'GET', name: '0', key: 'cubedemo:cart', peer: 'cubedemo.abcdefgh.us-west-2.cache.amazonaws.com', port: '6379' },
  { system: 'redis', op: 'SET', name: '0', key: 'cubedemo:shipment', peer: 'cubedemo.abcdefgh.us-west-2.cache.amazonaws.com', port: '6379' },
  { system: 'mongodb', op: 'find', name: 'cubedemo', collection: 'search', peer: 'cubedemo.abcdefgh.docdb.amazonaws.com', port: '27017' },
]

const EXTERNALS = [
  { name: 'POST api.twilio.com/v1/sendSMS', method: 'POST', url: 'https://api.twilio.com/v1/sendSMS', peer: 'api.twilio.com' },
  { name: 'GET maps.googleapis.com/v1/', method: 'GET', url: 'https://maps.googleapis.com/v1/', peer: 'maps.googleapis.com' },
  { name: 'POST api.stripe.com/v1/charges', method: 'POST', url: 'https://api.stripe.com/v1/charges', peer: 'api.stripe.com' },
]

const USER_AGENTS = ['curl/5.0', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'okhttp/4.11.0']
const HOSTS = ['cubedemo-prod-eks-5b8c9d2e1f-q83rw', 'cubedemo-prod-eks-5b8c9d2e1f-lm42x', 'cubedemo-prod-eks-7a1b3c4d5e-t90kp']

const STACKTRACE = `java.lang.RuntimeException: Downstream call failed
\tat com.cubedemo.service.RequestHandler.handle(RequestHandler.java:57)
\tat com.cubedemo.server.HttpServer.dispatch(HttpServer.java:203)
\tat java.base/java.lang.Thread.run(Thread.java:840)`

// The SDK stamps the same resource block on every span it exports. Kept on the
// record because the drawer's JSON view is the raw span, and collapsed out of
// the field list by isNoiseField — it is identical on every row of its kind.
function resourceTags(service, host) {
  return {
    '_resource.container.id': hexId(seededRnd(service.length * 97 + 13), 64),
    '_resource.cube.environment': 'UNSET',
    '_resource.host.arch': 'amd64',
    '_resource.os.description': 'Linux 5.10.220-209.869.amzn2.x86_64',
    '_resource.os.type': 'linux',
    '_resource.process.command_line': '/usr/lib/jvm/java-17-openjdk:bin/java',
    '_resource.process.executable.name': 'java',
    '_resource.process.executable.path': '/usr/lib/jvm/java-17-openjdk/bin/java',
    '_resource.process.pid': '1',
    '_resource.process.runtime.description': 'Eclipse Adoptium OpenJDK 64-Bit Server VM 17.0.11+9',
    '_resource.process.runtime.name': 'OpenJDK Runtime Environment',
    '_resource.process.runtime.version': '17.0.11+9',
    '_resource.telemetry.auto.version': '1.22.1-alpha',
    '_resource.telemetry.sdk.language': 'java',
    '_resource.telemetry.sdk.name': 'opentelemetry',
    '_resource.telemetry.sdk.version': '1.22.0',
    'host.name': host,
  }
}

function timeParts(t, ms) {
  const p = n => String(n).padStart(2, '0')
  return {
    dateStr: `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`,
    timeStr: `${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}.${String(ms).padStart(3, '0')}`,
  }
}

let rowSeq = 0

function makeSpan({ time, service, spanName, spanKind, durationNs, statusCode, traceId, spanId, parentId, rootName, host, extra }) {
  const isError = statusCode === 'ERROR'
  const tags = {
    ...resourceTags(service, host),
    service,
    span_name: spanName,
    span_kind: spanKind,
    duration: durationNs,
    status_code: statusCode,
    trace_id: traceId,
    span_id: spanId,
    parent_id: parentId ?? '',
    root_name: rootName,
    'event.domain': 'span',
    'service.version': 'v9.10.1',
    ...extra,
  }
  if (isError) {
    // Every span in a failing chain carries ERROR — that is how the status
    // propagates up. But an exception is only RECORDED where the process
    // boundary is: the server span that returned the error and the client call
    // that got one back. The controller in between re-throws without catching,
    // so stamping it too would make the Errors tab list the same failure five
    // times and hide which two calls actually saw it.
    tags.error = 'true'
    if (spanKind !== 'internal') {
      tags.exception = 'java.lang.RuntimeException'
      tags['exception.type'] = 'java.lang.RuntimeException'
      tags['exception.message'] = 'Downstream call failed'
      tags['exception.stacktrace'] = STACKTRACE
    }
  }
  const ms = time.getMilliseconds()
  return {
    id: `span_${rowSeq++}`,
    time,
    ...timeParts(time, ms),
    // Spans have no message; `level` is what the shared drawer colours its
    // badge with, so the span's own status is mapped onto the severity scale.
    level: isError ? 'error' : 'info',
    message: '',
    service,
    spanName,
    spanKind,
    durationNs,
    statusCode,
    traceId,
    spanId,
    tags,
  }
}

// A span event is a timestamped point inside a span — an exception being
// recorded, a retry being logged. It is a row in the same stream with the same
// ids and no span of its own, which is why span_name, span_kind and status_code
// are blank on it and duration is zero.
function makeSpanEvent({ time, service, traceId, spanId, eventName, rootName, host, extra }) {
  const ms = time.getMilliseconds()
  const tags = {
    ...resourceTags(service, host),
    service,
    span_name: '',
    span_kind: '',
    duration: 0,
    status_code: '',
    trace_id: traceId,
    span_id: spanId,
    root_name: rootName,
    'event.domain': 'span_event',
    event_name: eventName,
    'service.version': 'v9.10.1',
    ...extra,
  }
  return {
    id: `span_${rowSeq++}`,
    time,
    ...timeParts(time, ms),
    level: 'info',
    message: '',
    service,
    spanName: '',
    spanKind: '',
    durationNs: 0,
    statusCode: '',
    traceId,
    spanId,
    tags,
  }
}

function httpServerTags(rnd, { method, route, status, host }) {
  return {
    category: 'http',
    'http.method': method,
    'http.route': route,
    'http.target': route,
    'http.scheme': 'http',
    'http.flavor': '1.1',
    'http.status_code': String(status),
    'http.client_ip': `13.34.${Math.floor(rnd() * 255)}.${Math.floor(rnd() * 255)}`,
    'http.user_agent': pick(rnd, USER_AGENTS),
    'http.request_content_length': String(Math.floor(200 + rnd() * 900)),
    'http.response_content_length': String(Math.floor(2 + rnd() * 4000)),
    'net.host.name': host,
    'net.sock.host.addr': '127.0.0.1',
    'net.sock.host.port': '9090',
    'net.sock.peer.addr': '127.0.0.1',
    'net.sock.peer.port': String(Math.floor(40000 + rnd() * 20000)),
    'net.transport': 'ip_tcp',
    'otel.library.name': 'io.opentelemetry.tomcat-7.0',
    'otel.library.version': '1.22.1-alpha',
    'thread.id': String(Math.floor(30 + rnd() * 40)),
    'thread.name': `http-nio-9090-exec-${Math.floor(1 + rnd() * 12)}`,
  }
}

function dbTags(t) {
  const out = {
    category: 'db',
    'db.system': t.system,
    'db.operation': t.op,
    'db.name': t.name,
    'db.user': t.user ?? '',
    'db.connection_string': `${t.system}://${t.peer}:${t.port}`,
    'net.peer.name': t.peer,
    'net.peer.port': t.port,
    'net.transport': 'ip_tcp',
    'otel.library.name': `io.opentelemetry.${t.system}`,
    'otel.library.version': '1.22.1-alpha',
  }
  if (t.table) {
    out['db.sql.table'] = t.table
    out['db.statement'] = `${t.op} * FROM ${t.table} WHERE id = ?`
  }
  if (t.collection) {
    out['db.mongodb.collection'] = t.collection
    out['db.statement'] = `{"find": "${t.collection}"}`
  }
  // A Redis call IS a cache lookup, so it carries the cache attributes as well
  // as the db ones — which is why a hit/miss is answerable from this table.
  if (t.key) {
    out['redis.key'] = t.key
    out['cache.key'] = t.key
    out['cache.operation'] = t.op === 'GET' ? 'get' : 'set'
    out['cache.hit'] = t.op === 'GET' ? 'true' : 'false'
  }
  if (t.system === 'mysql') {
    out['db.pool.name'] = 'HikariPool-1'
    out['db.pool.max'] = '10'
    out['db.pool.active'] = '3'
    out['db.pool.pending'] = '0'
    out['db.pool.wait_ms'] = '0'
  }
  return out
}

// Business attributes the demo app stamps on its own spans. They are the
// reason a span table beats a log line for this question: "which carrier did
// the failing shipments use" is a column here, not a regex over text.
const DOMAIN_TAGS = {
  'payment-service': (rnd) => ({
    'payment.method': pick(rnd, ['card', 'upi', 'wallet']),
    'payment.processor': pick(rnd, ['stripe', 'adyen', 'razorpay']),
    'payment.auth_code': hexId(rnd, 6).toUpperCase(),
    'payment.value_usd': (5 + rnd() * 400).toFixed(2),
  }),
  'search-service': (rnd) => ({
    'search.index': pick(rnd, ['catalog', 'orders', 'reviews']),
    'search.result_count': String(Math.floor(rnd() * 240)),
    'search.sort_order': pick(rnd, ['relevance', 'price_asc', 'newest']),
    'search.filtered': rnd() < 0.5 ? 'true' : 'false',
  }),
  'shipment-service': (rnd) => ({
    'shipment.carrier': pick(rnd, ['fedex', 'ups', 'bluedart']),
    'shipment.destination': pick(rnd, ['US-CA', 'US-NY', 'IN-KA', 'DE-BE']),
    'shipment.item_count': String(1 + Math.floor(rnd() * 6)),
    'shipment.service_level': pick(rnd, ['standard', 'express', 'overnight']),
  }),
}

const FLAG_KEYS = ['checkout-v2', 'new-pricing', 'fast-shipping']

// Evaluated on the controller span, which is where the application code that
// reads the flag actually runs.
function featureFlagTags(rnd) {
  const key = pick(rnd, FLAG_KEYS)
  return {
    'feature_flag.key': key,
    'feature_flag.provider_name': 'cubedemo-flags',
    'feature_flag.variant': rnd() < 0.5 ? 'control' : 'treatment',
  }
}

const ms = n => Math.round(n * 1e6)

/**
 * One trace, as a properly nested tree.
 *
 * Offsets and durations are laid out so a child always starts after its parent
 * and finishes before it. That is not decoration: the trace view draws each span
 * as a bar positioned by its offset, and a child that overruns its parent draws
 * a waterfall that cannot have happened.
 */
function buildTrace(rnd, startTime, entryService, i) {
  const traceId = hexId(rnd, 32)
  const host = pick(rnd, HOSTS)
  const route = ROUTES[entryService]
  const method = rnd() < 0.65 ? 'POST' : 'GET'
  const rootName = `${method} ${route}`
  const failing = rnd() < 0.16
  const ctrl = CONTROLLERS[entryService]
  const rows = []

  const downstream = TRACE_SERVICES.filter(s => s !== entryService)
  const calleeService = pick(rnd, downstream)
  const calleeRoute = ROUTES[calleeService]
  const calleeCtrl = CONTROLLERS[calleeService]
  const calleeHost = pick(rnd, HOSTS)
  const calleePeer = calleeService.replace('-service', '')

  const at = offMs => new Date(startTime.getTime() + Math.round(offMs))

  // ---- layout, in milliseconds from the start of the trace ----
  const totalMs = 60 + rnd() * 260 + (failing ? 120 : 0)
  const ctrlStart = 2 + rnd() * 3
  const ctrlMs = totalMs * 0.92 - ctrlStart

  const daoStart = ctrlStart + 2 + rnd() * 3
  const daoMs = ctrlMs * (0.14 + rnd() * 0.1)
  const dbStart = daoStart + 1 + rnd()
  const dbMs = daoMs * (0.5 + rnd() * 0.2)
  const txStart = dbStart + dbMs + 0.4
  const txMs = Math.max(0.6, daoMs * 0.18)

  const extStart = daoStart + daoMs + 1 + rnd() * 2
  const extMs = 5 + rnd() * 30

  const callStart = extStart + extMs + 1 + rnd() * 2
  const callMs = Math.max(12, ctrlStart + ctrlMs - callStart - 1)
  const calleeRootStart = callStart + 1 + rnd()
  const calleeRootMs = callMs * 0.9
  const calleeCtrlStart = calleeRootStart + 1 + rnd()
  const calleeCtrlMs = calleeRootMs * 0.82
  const db2Start = calleeCtrlStart + 1 + rnd()
  const db2Ms = calleeCtrlMs * (0.3 + rnd() * 0.25)

  const rootId = hexId(rnd, 16)
  const ctrlId = hexId(rnd, 16)
  const daoId = hexId(rnd, 16)
  const callId = hexId(rnd, 16)
  const calleeRootId = hexId(rnd, 16)
  const calleeCtrlId = hexId(rnd, 16)

  // Root server span — the request as the entry service saw it.
  rows.push(makeSpan({
    time: at(0), service: entryService, spanName: rootName, spanKind: 'server',
    durationNs: ms(totalMs), statusCode: failing ? 'ERROR' : 'UNSET',
    traceId, spanId: rootId, parentId: '', rootName, host,
    extra: {
      ...httpServerTags(rnd, { method, route, status: failing ? 500 : 200, host }),
      ...(DOMAIN_TAGS[entryService]?.(rnd) ?? {}),
      num_events: failing ? '2' : '0',
    },
  }))

  // The controller the router dispatched to.
  rows.push(makeSpan({
    time: at(ctrlStart), service: entryService, spanName: `${ctrl}Controller.create`, spanKind: 'internal',
    durationNs: ms(ctrlMs), statusCode: failing ? 'ERROR' : 'UNSET',
    traceId, spanId: ctrlId, parentId: rootId, rootName, host,
    extra: {
      category: 'internal',
      'code.function': 'create',
      'code.namespace': `com.cubedemo.${ctrl}.Controller`,
      'otel.library.name': 'io.opentelemetry.spring-webmvc-5.3',
      'otel.library.version': '1.22.1-alpha',
      'thread.name': `http-nio-9090-exec-${Math.floor(1 + rnd() * 12)}`,
      ...(i % 3 === 0 ? featureFlagTags(rnd) : {}),
    },
  }))

  // The persistence layer, which is where the database work actually hangs
  // from. Without it every query is a sibling of the HTTP calls and the tree
  // says nothing about which part of the request owns the time.
  rows.push(makeSpan({
    time: at(daoStart), service: entryService, spanName: `${ctrl}Dao.save`, spanKind: 'internal',
    durationNs: ms(daoMs), statusCode: 'UNSET',
    traceId, spanId: daoId, parentId: ctrlId, rootName, host,
    extra: {
      category: 'internal',
      'code.function': 'save',
      'code.namespace': `com.cubedemo.daos.${ctrl}Dao`,
      'otel.library.name': 'io.opentelemetry.spring-data-1.8',
      'otel.library.version': '1.22.1-alpha',
    },
  }))

  // A database call. Cycled rather than drawn at random so every engine — and
  // so the cache attributes that only a Redis call carries — is present in the
  // seeded set instead of being probably present.
  const db = DB_TARGETS[i % DB_TARGETS.length]
  rows.push(makeSpan({
    time: at(dbStart), service: entryService,
    spanName: db.collection ? `${db.op} ${db.name}.${db.collection}` : db.key ? `${db.op} ${db.key}` : `${db.op} ${db.name}.${db.table}`,
    spanKind: 'client', durationNs: ms(dbMs), statusCode: 'UNSET',
    traceId, spanId: hexId(rnd, 16), parentId: daoId, rootName, host,
    extra: dbTags(db),
  }))

  rows.push(makeSpan({
    time: at(txStart), service: entryService, spanName: 'Transaction.commit', spanKind: 'internal',
    durationNs: ms(txMs), statusCode: 'UNSET',
    traceId, spanId: hexId(rnd, 16), parentId: daoId, rootName, host,
    extra: {
      category: 'internal',
      'code.function': 'commit',
      'code.namespace': 'com.cubedemo.db.Transaction',
      'otel.library.name': 'io.opentelemetry.jdbc',
      'otel.library.version': '1.22.1-alpha',
    },
  }))

  // An outbound call to a third party.
  const ext = pick(rnd, EXTERNALS)
  rows.push(makeSpan({
    time: at(extStart), service: entryService, spanName: ext.name, spanKind: 'client',
    durationNs: ms(extMs), statusCode: 'UNSET',
    traceId, spanId: hexId(rnd, 16), parentId: ctrlId, rootName, host,
    extra: {
      category: 'http',
      'http.method': ext.method,
      'http.url': ext.url,
      'http.status_code': '200',
      'net.peer.name': ext.peer,
      'net.transport': 'ip_tcp',
      'otel.library.name': 'io.opentelemetry.apache-httpclient-4.0',
      'otel.library.version': '1.22.1-alpha',
    },
  }))

  // The call into the next service, and that service's own server span — the
  // pair that makes the trace cross a process boundary. The callee's span hangs
  // off the caller's client span, which is what lets the waterfall show one
  // request crossing two processes rather than two unrelated stacks.
  rows.push(makeSpan({
    time: at(callStart), service: entryService,
    spanName: `${method} ${calleePeer}.cubedemo.com${calleeRoute}`,
    spanKind: 'client', durationNs: ms(callMs), statusCode: failing ? 'ERROR' : 'UNSET',
    traceId, spanId: callId, parentId: ctrlId, rootName, host,
    extra: {
      category: 'http',
      'http.method': method,
      'http.url': `https://${calleePeer}.cubedemo.com${calleeRoute}`,
      'http.status_code': failing ? '500' : '200',
      'net.peer.name': `${calleePeer}.cubedemo.com`,
      'net.transport': 'ip_tcp',
      'otel.library.name': 'io.opentelemetry.apache-httpclient-4.0',
      'otel.library.version': '1.22.1-alpha',
    },
  }))

  rows.push(makeSpan({
    time: at(calleeRootStart), service: calleeService, spanName: `${method} ${calleeRoute}`, spanKind: 'server',
    durationNs: ms(calleeRootMs), statusCode: failing ? 'ERROR' : 'UNSET',
    traceId, spanId: calleeRootId, parentId: callId, rootName, host: calleeHost,
    extra: {
      ...httpServerTags(rnd, { method, route: calleeRoute, status: failing ? 500 : 200, host: calleeHost }),
      ...(DOMAIN_TAGS[calleeService]?.(rnd) ?? {}),
      num_events: failing ? '1' : '0',
    },
  }))

  rows.push(makeSpan({
    time: at(calleeCtrlStart), service: calleeService, spanName: `${calleeCtrl}Controller.create`, spanKind: 'internal',
    durationNs: ms(calleeCtrlMs), statusCode: failing ? 'ERROR' : 'UNSET',
    traceId, spanId: calleeCtrlId, parentId: calleeRootId, rootName, host: calleeHost,
    extra: {
      category: 'internal',
      'code.function': 'create',
      'code.namespace': `com.cubedemo.${calleeCtrl}.Controller`,
      'otel.library.name': 'io.opentelemetry.spring-webmvc-5.3',
      'otel.library.version': '1.22.1-alpha',
    },
  }))

  const db2 = DB_TARGETS[(i + 3) % DB_TARGETS.length]
  rows.push(makeSpan({
    time: at(db2Start), service: calleeService,
    spanName: db2.collection ? `${db2.op} ${db2.name}.${db2.collection}` : db2.key ? `${db2.op} ${db2.key}` : `${db2.op} ${db2.name}.${db2.table}`,
    spanKind: 'client', durationNs: ms(db2Ms), statusCode: 'UNSET',
    traceId, spanId: hexId(rnd, 16), parentId: calleeCtrlId, rootName, host: calleeHost,
    extra: dbTags(db2),
  }))

  // Events recorded inside the failing spans.
  if (failing) {
    rows.push(makeSpanEvent({
      time: at(calleeRootStart + calleeRootMs * 0.8), service: calleeService, traceId, spanId: calleeRootId,
      eventName: 'exception', rootName, host: calleeHost,
      extra: {
        'exception.type': 'java.lang.RuntimeException',
        'exception.message': 'Downstream call failed',
        'exception.stacktrace': STACKTRACE,
      },
    }))
    rows.push(makeSpanEvent({
      time: at(totalMs * 0.95), service: entryService, traceId, spanId: rootId,
      eventName: 'exception', rootName, host,
      extra: {
        'exception.type': 'java.lang.RuntimeException',
        'exception.message': 'Downstream call failed',
        'exception.stacktrace': STACKTRACE,
      },
    }))
  } else if (rnd() < 0.35) {
    rows.push(makeSpanEvent({
      time: at(extStart + extMs * 0.5), service: entryService, traceId, spanId: rootId,
      eventName: 'retry', rootName, host,
      extra: {
        'http.retry.attempt': '1',
        'http.retry.max': '3',
        'http.retry.delay_ms': String(Math.floor(50 + rnd() * 200)),
        'http.retry.reason': 'connection reset',
      },
    }))
  }

  return rows
}

/**
 * One deliberately large trace: a fan-out request that calls many downstreams,
 * each of which does its own work.
 *
 * Every other seeded trace is about ten spans, which is a size at which any
 * waterfall looks fine. Real traces are not reliably that size — a fan-out or a
 * retry loop produces hundreds — and a view that has only ever been seen at ten
 * rows has not been tested. This is the case that tests it.
 */
function buildWideTrace(rnd, startTime) {
  const entryService = 'order-service'
  const traceId = hexId(rnd, 32)
  const host = pick(rnd, HOSTS)
  const route = ROUTES[entryService]
  const rootName = `POST ${route}`
  const rows = []
  const at = offMs => new Date(startTime.getTime() + Math.round(offMs))

  const FANOUT = 14          // downstream calls
  const PER_CALLEE = 8       // spans each downstream contributes
  const totalMs = 1850

  const rootId = hexId(rnd, 16)
  rows.push(makeSpan({
    time: at(0), service: entryService, spanName: rootName, spanKind: 'server',
    durationNs: ms(totalMs), statusCode: 'UNSET',
    traceId, spanId: rootId, parentId: '', rootName, host,
    extra: { ...httpServerTags(rnd, { method: 'POST', route, status: 200, host }), num_events: '0' },
  }))

  const ctrlId = hexId(rnd, 16)
  rows.push(makeSpan({
    time: at(3), service: entryService, spanName: 'orderController.create', spanKind: 'internal',
    durationNs: ms(totalMs - 8), statusCode: 'UNSET',
    traceId, spanId: ctrlId, parentId: rootId, rootName, host,
    extra: {
      category: 'internal', 'code.function': 'create',
      'code.namespace': 'com.cubedemo.order.Controller',
      'otel.library.name': 'io.opentelemetry.spring-webmvc-5.3',
      'otel.library.version': '1.22.1-alpha',
    },
  }))

  const slice = (totalMs - 20) / FANOUT
  for (let i = 0; i < FANOUT; i++) {
    const callee = TRACE_SERVICES[(i + 1) % TRACE_SERVICES.length]
    const calleeRoute = ROUTES[callee]
    const calleeCtrl = CONTROLLERS[callee]
    const peer = callee.replace('-service', '')
    const calleeHost = pick(rnd, HOSTS)
    const base = 8 + i * slice
    const callMs = slice * 0.92

    const callId = hexId(rnd, 16)
    rows.push(makeSpan({
      time: at(base), service: entryService,
      spanName: `POST ${peer}.cubedemo.com${calleeRoute}`, spanKind: 'client',
      durationNs: ms(callMs), statusCode: 'UNSET',
      traceId, spanId: callId, parentId: ctrlId, rootName, host,
      extra: {
        category: 'http', 'http.method': 'POST',
        'http.url': `https://${peer}.cubedemo.com${calleeRoute}`,
        'http.status_code': '200', 'net.peer.name': `${peer}.cubedemo.com`,
        'net.transport': 'ip_tcp',
        'otel.library.name': 'io.opentelemetry.apache-httpclient-4.0',
        'otel.library.version': '1.22.1-alpha',
      },
    }))

    const srvId = hexId(rnd, 16)
    rows.push(makeSpan({
      time: at(base + 1), service: callee, spanName: `POST ${calleeRoute}`, spanKind: 'server',
      durationNs: ms(callMs * 0.9), statusCode: 'UNSET',
      traceId, spanId: srvId, parentId: callId, rootName, host: calleeHost,
      extra: {
        ...httpServerTags(rnd, { method: 'POST', route: calleeRoute, status: 200, host: calleeHost }),
        ...(DOMAIN_TAGS[callee]?.(rnd) ?? {}),
        num_events: '0',
      },
    }))

    const cCtrlId = hexId(rnd, 16)
    rows.push(makeSpan({
      time: at(base + 2), service: callee, spanName: `${calleeCtrl}Controller.create`, spanKind: 'internal',
      durationNs: ms(callMs * 0.82), statusCode: 'UNSET',
      traceId, spanId: cCtrlId, parentId: srvId, rootName, host: calleeHost,
      extra: {
        category: 'internal', 'code.function': 'create',
        'code.namespace': `com.cubedemo.${calleeCtrl}.Controller`,
        'otel.library.name': 'io.opentelemetry.spring-webmvc-5.3',
        'otel.library.version': '1.22.1-alpha',
      },
    }))

    // A batch of queries under each downstream — the shape that actually makes
    // a trace long: not depth, but the same call repeated per item.
    for (let q = 0; q < PER_CALLEE - 3; q++) {
      const db = DB_TARGETS[(i + q) % DB_TARGETS.length]
      rows.push(makeSpan({
        time: at(base + 4 + q * (callMs * 0.1)), service: callee,
        spanName: db.collection ? `${db.op} ${db.name}.${db.collection}` : db.key ? `${db.op} ${db.key}` : `${db.op} ${db.name}.${db.table}`,
        spanKind: 'client', durationNs: ms(callMs * 0.08), statusCode: 'UNSET',
        traceId, spanId: hexId(rnd, 16), parentId: cCtrlId, rootName, host: calleeHost,
        extra: dbTags(db),
      }))
    }
  }

  return rows
}

function generateSpans(traceCount = 34) {
  const rnd = seededRnd(61)
  const now = BASE_TIME.getTime()
  const out = []
  for (let i = 0; i < traceCount; i++) {
    const start = new Date(now - (i * 95 + rnd() * 40) * 1000)
    // Cycled, not sampled: with eight services and a random draw, the seeded
    // set can easily miss one entirely, and a missing service is a missing
    // facet value and a missing column of business attributes.
    out.push(...buildTrace(rnd, start, TRACE_SERVICES[i % TRACE_SERVICES.length], i))
  }
  out.push(...buildWideTrace(rnd, new Date(now - 47 * 1000)))
  return out.sort((a, b) => b.time - a.time)
}

export const spanRows = generateSpans()

/* ---- volume ---- */

// Stacked by status_code, which is the one dimension of a span that is a
// severity rather than an identity — so red here means the same thing it means
// everywhere else in the product. Span events stack as their own band because
// they are rows in this table too, and leaving them out would make the bars
// disagree with the row count underneath them.
function generateSpanVolume(points = 60) {
  const rnd = seededRnd(77)
  const out = []
  for (let i = points - 1; i >= 0; i--) {
    const unset = Math.round(1500 + rnd() * 1400)
    const event = Math.round(320 + rnd() * 460)
    const error = Math.round(45 + rnd() * 175)
    out.push({ m: i, unset, event, error, total: unset + event + error, label: i === 0 ? 'now' : `-${i}m` })
  }
  return out
}

export const spanVolume = generateSpanVolume(60)

export const spanTotals = {
  total: spanVolume.reduce((a, b) => a + b.total, 0),
  unset: spanVolume.reduce((a, b) => a + b.unset, 0),
  event: spanVolume.reduce((a, b) => a + b.event, 0),
  error: spanVolume.reduce((a, b) => a + b.error, 0),
}

/* ---- facets ---- */

const FACET_MAX_DISTINCT = 40
const FACET_MAX_VALUE_LEN = 60
const MEASUREMENT_RATIO = 0.6

// status_code reads worst-first so the failing value is the one under the
// cursor, matching how severity is ordered everywhere else.
const FACET_VALUE_ORDER = {
  status_code: ['ERROR', 'UNSET'],
  span_kind: ['server', 'client', 'internal'],
}

// Same admission rules as the log facets: a field earns a facet only when
// picking one of its values would narrow the result set, and only when its
// values can be listed at all. The tests are on the SHAPE of the values, not on
// how many there are — a span id and a span kind can carry the same number of
// distinct values across the rows that have them.
function buildSpanFacets(rows) {
  const out = {}
  const keys = new Set()
  for (const row of rows) for (const k of Object.keys(row.tags ?? {})) {
    if (!isNoiseField(k)) keys.add(k)
  }
  for (const key of keys) {
    const counts = new Map()
    let populated = 0
    for (const row of rows) {
      const raw = row.tags[key]
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

export const spanFacets = buildSpanFacets(spanRows)

// The order the filter rail leads with. The playground opens on these four, and
// they are the four that actually cut a span stream down: what kind of record,
// whose it is, where in the call it sits, and whether it failed.
export const PRIMARY_FACETS = ['event.domain', 'service', 'span_kind', 'status_code']

export const spanFacetFields = [
  ...PRIMARY_FACETS.filter(f => spanFacets[f]),
  ...Object.keys(spanFacets).filter(f => !PRIMARY_FACETS.includes(f)).sort(),
]
