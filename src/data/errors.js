// The Errors page's data: every exception the platform recorded, as a function
// of the selected window.
//
// Three decisions carry it, and each is the time model's own rule applied to a
// count instead of a rate:
//
//   1. A COUNT IS RATE × ERROR RATE, OFF THE PUBLISHED PROFILES. An endpoint's
//      errors in a bucket are its request rate times its error rate times the
//      bucket's minutes, read off the same calibrated profiles the RED, DB and
//      External tables average, and scaled once so Last 1 hour reproduces
//      those tables to the error (capture: 64.2 rpm × 6.1% × 60 = 235). Every
//      other range is then the same traffic and the same incident the tables
//      beside it are reading, not a number written down here. Services without
//      a published endpoint list count off their service-level rpm × err%,
//      split over the routes the explore stores name.
//
//   2. THE INCIDENT THROWS ITS OWN EXCEPTIONS. Every place errors are counted
//      says what it throws while the Redis pool is out and what it throws the
//      rest of the time, and each bucket splits between the two by how much of
//      that bucket's error rate the incident accounts for — the same share
//      `incidentWeightOver` hands every other series. Over an hour the pool's
//      JedisPoolException is nearly all of payment-service's errors; over a
//      week it is a minority and the stripe timeouts that run all week rise to
//      the top. That is this page's version of p90 falling off a cliff: narrow
//      the range to find the fire.
//
//   3. A SAMPLE IS ITS TRACE ID. An occurrence is a pure function of which
//      series it came from and when, and both are packed into its trace id, so
//      `/trace/<id>` reopened after a reload — with no page state at all —
//      rebuilds the failing request the drawer showed. Host, version, duration
//      and span ids are hashed off the id rather than drawn from a sequence, so
//      the drawer, the breakdown and the trace page cannot disagree about one.
//
// A row is one series in the Prometheus sense, one value per field, like
// `sum by (service, root_name, span_name, exception, http_code)`. That is the
// unit the page filters BEFORE it groups, so a facet or a chip never has to
// reach inside a group to decide whether it matches.

import { formatLocal } from '@/utils/timeRange'
import { largestRemainder } from '@/utils/apportion'
import {
  BASE_TIME, REFERENCE_WINDOW, INCIDENT_START_MIN, incidentWeight, incidentWeightOver, noiseAt, sampleAt,
  windowMean,
} from './timeWindow'
import {
  serviceProfile, errorRateProfiles, dbEndpoints, dbEndpointCallers, externalEndpointCallers, errorRequests,
} from './services'
import { RUNTIME_HOSTS, livesOf } from './runtimeHosts'
import { makeSpan, makeSpanEvent, httpServerTags, dbTags, DOMAIN_TAGS } from './tracesExplorer'

export const ERROR_SIDES = ['server', 'client']

const BASE_MS = BASE_TIME.getTime()
const BASE_SEC = Math.floor(BASE_MS / 1000)

/* ---- vocabulary ---- */

// Under the application's own frames every request runs the same stack: the
// reflective call into the handler, Spring's dispatch, the house request
// handler (the two frames the seeded traces' failure already carries) and the
// worker thread. Long enough that a real trace wants a "show all frames".
const JVM_TAIL = [
  'java.base/jdk.internal.reflect.NativeMethodAccessorImpl.invoke0(Native Method)',
  'java.base/jdk.internal.reflect.NativeMethodAccessorImpl.invoke(NativeMethodAccessorImpl.java:77)',
  'java.base/java.lang.reflect.Method.invoke(Method.java:568)',
  'org.springframework.web.method.support.InvocableHandlerMethod.doInvoke(InvocableHandlerMethod.java:205)',
  'org.springframework.web.servlet.DispatcherServlet.doDispatch(DispatcherServlet.java:1072)',
  'com.cubedemo.service.RequestHandler.handle(RequestHandler.java:57)',
  'com.cubedemo.server.HttpServer.dispatch(HttpServer.java:203)',
  'org.apache.tomcat.util.net.NioEndpoint$SocketProcessor.doRun(NioEndpoint.java:1791)',
  'java.base/java.util.concurrent.ThreadPoolExecutor.runWorker(ThreadPoolExecutor.java:1136)',
  'java.base/java.lang.Thread.run(Thread.java:840)',
]

const FUTURE_GET = [
  'java.base/java.util.concurrent.CompletableFuture.timedGet(CompletableFuture.java:1960)',
  'java.base/java.util.concurrent.CompletableFuture.get(CompletableFuture.java:2095)',
]

// A Redis call as `<VERB> redis.<family>:*`. Every key family lives on redis.0
// behind the one pool, so each fails the way the session keys do; what differs
// is the house class that makes the call and the Jedis method it lands in, and
// a stack should name the call that actually failed.
const REDIS_CALL = /^([A-Z]+) redis\.([a-z]+)[:.]/
const redisVerb = c => String(c.call ?? '').match(REDIS_CALL)?.[1] ?? 'GET'
const redisFamily = c => String(c.call ?? '').match(REDIS_CALL)?.[2] ?? 'session'
const REDIS_SITES = {
  session: ['SessionCache', { GET: ['get', 41], SETEX: ['put', 58], DEL: ['evict', 73] }],
  idem: ['IdempotencyStore', { GET: ['find', 36], SET: ['claim', 52] }],
  ratelimit: ['RateLimiter', { INCR: ['acquire', 44], EXPIRE: ['acquire', 47] }],
  token: ['TokenCache', { GET: ['get', 33] }],
  merchant: ['MerchantCache', { HGET: ['get', 29] }],
  lock: ['PaymentLock', { SET: ['tryLock', 61] }],
}
const JEDIS_LINES = { GET: 427, SET: 1265, SETEX: 1803, DEL: 1340, INCR: 1592, EXPIRE: 1650, HGET: 2080 }
const redisSiteFrame = c => {
  const [cls, methods] = REDIS_SITES[redisFamily(c)] ?? REDIS_SITES.session
  const [method, line] = methods[redisVerb(c)] ?? Object.values(methods)[0]
  return `com.cubedemo.${c.pkg}.cache.${cls}.${method}(${cls}.java:${line})`
}
const jedisFrame = c => {
  const verb = redisVerb(c)
  return `redis.clients.jedis.Jedis.${verb.toLowerCase()}(Jedis.java:${JEDIS_LINES[verb] ?? JEDIS_LINES.GET})`
}

/**
 * Every exception the page can show, spelled the way the rest of the mock
 * layer already spells it, so a type picked here filters the Logs and Traces
 * pages to the same thing.
 *
 * `codes` is what a SERVER span answers with when the exception escapes the
 * handler — 5xx only, because a 4xx is the caller's mistake and OTel leaves a
 * server span's status unset for one. `clientCode` is what the outgoing call
 * itself got back, '' when no response arrived at all. `ms` is how long the
 * failing piece of work ran before it threw. `lib` and `site` are the frames
 * above the handler, `cause` an optional `Caused by:` block.
 */
const EXC = {
  pool: {
    type: 'redis.clients.jedis.exceptions.JedisPoolException',
    message: 'Could not get a resource from the pool',
    codes: { 500: 0.75, 503: 0.25 },
    clientCode: '',
    // The thread sat in borrowObject until the pool gave up on it.
    ms: [180, 900],
    lib: () => [
      'redis.clients.jedis.util.Pool.getResource(Pool.java:84)',
      'redis.clients.jedis.JedisPool.getResource(JedisPool.java:370)',
    ],
    site: redisSiteFrame,
    cause: [
      'java.util.NoSuchElementException: Timeout waiting for idle object',
      'org.apache.commons.pool2.impl.GenericObjectPool.borrowObject(GenericObjectPool.java:298)',
      'redis.clients.jedis.util.Pool.getResource(Pool.java:75)',
    ],
  },
  redisConn: {
    type: 'redis.clients.jedis.exceptions.JedisConnectionException',
    message: 'Failed connecting to host redis.0:6379',
    codes: { 500: 1 },
    clientCode: '',
    ms: [20, 120],
    lib: c => [
      'redis.clients.jedis.Connection.connect(Connection.java:204)',
      jedisFrame(c),
    ],
    site: redisSiteFrame,
    cause: [
      'java.net.SocketTimeoutException: Connect timed out',
      'java.base/sun.nio.ch.NioSocketImpl.timedFinishConnect(NioSocketImpl.java:546)',
      'java.base/java.net.Socket.connect(Socket.java:633)',
    ],
  },
  stripeTimeout: {
    type: 'java.util.concurrent.TimeoutException',
    message: 'Timed out waiting for stripe after 30000ms',
    codes: { 504: 1 },
    clientCode: '',
    ms: [30001, 30040],
    lib: () => FUTURE_GET,
    site: () => 'com.cubedemo.payment.gateway.StripeGateway.charge(StripeGateway.java:88)',
  },
  mapsTimeout: {
    type: 'java.util.concurrent.TimeoutException',
    message: 'Timed out waiting for maps.googleapis.com after 10000ms',
    codes: { 504: 1 },
    clientCode: '',
    ms: [10001, 10030],
    lib: () => FUTURE_GET,
    site: c => `com.cubedemo.${c.pkg}.geo.GeocodeClient.lookup(GeocodeClient.java:52)`,
  },
  dbFail: {
    type: 'java.lang.RuntimeException',
    message: 'Failed connecting to database',
    codes: { 500: 1 },
    clientCode: '',
    ms: [3, 40],
    lib: () => ['com.cubedemo.db.ConnectionPool.acquire(ConnectionPool.java:84)'],
    site: () => 'com.cubedemo.service.Repository.findById(Repository.java:112)',
    cause: [
      'java.net.ConnectException: Connection refused',
      'java.base/sun.nio.ch.Net.pollConnect(Native Method)',
      'java.base/sun.nio.ch.Net.pollConnectNow(Net.java:672)',
    ],
  },
  hikari: {
    type: 'java.sql.SQLTransientConnectionException',
    // Hikari goes on to say "request timed out after 30000ms"; the stack in
    // logRecordTypes stops here, and so does this, because a span value over
    // 60 characters takes the whole exception.message facet off the Traces
    // rail once these rows are merged into it.
    message: 'HikariPool-1 - Connection is not available',
    codes: { 500: 1 },
    clientCode: '',
    ms: [30001, 30020],
    lib: () => [
      'com.zaxxer.hikari.pool.HikariPool.createTimeoutException(HikariPool.java:696)',
      'com.zaxxer.hikari.pool.HikariPool.getConnection(HikariPool.java:181)',
      'com.zaxxer.hikari.HikariDataSource.getConnection(HikariDataSource.java:100)',
    ],
    site: c => `com.cubedemo.${c.pkg}.${c.entity}Repository.save(${c.entity}Repository.java:88)`,
  },
  downstream: {
    type: 'java.lang.RuntimeException',
    message: 'Downstream call failed',
    // The caller answers 502 for a dependency that failed, or lets a plain 500
    // through when the client library rethrows it untranslated.
    codes: { 502: 0.6, 500: 0.4 },
    clientCode: '500',
    ms: [220, 950],
    lib: () => [],
    site: c => `com.cubedemo.${c.pkg}.client.PaymentClient.charge(PaymentClient.java:64)`,
    cause: [
      'org.springframework.web.client.HttpServerErrorException$InternalServerError: 500 Internal Server Error',
      'org.springframework.web.client.DefaultResponseErrorHandler.handleError(DefaultResponseErrorHandler.java:186)',
      'org.springframework.web.client.RestTemplate.handleResponse(RestTemplate.java:819)',
    ],
  },
  twilio429: {
    type: 'com.twilio.exception.ApiException',
    message: '429 Too Many Requests',
    codes: { 503: 1 },
    clientCode: '429',
    ms: [40, 220],
    lib: () => [
      'com.twilio.http.TwilioRestClient.request(TwilioRestClient.java:94)',
      'com.twilio.rest.api.v2010.account.MessageCreator.create(MessageCreator.java:416)',
    ],
    site: c => `com.cubedemo.${c.pkg}.sms.SmsSender.send(SmsSender.java:39)`,
  },
  cardDeclined: {
    type: 'com.cubedemo.payment.CardDeclinedException',
    message: 'Card declined by issuer: insufficient_funds',
    // Never escapes as a 5xx: the request answers 402, which is the issuer
    // working as intended — so this only ever shows on the Client side.
    codes: {},
    clientCode: '402',
    ms: [240, 820],
    lib: () => [],
    site: () => 'com.cubedemo.payment.gateway.StripeGateway.charge(StripeGateway.java:97)',
  },
}

const shortName = type => type.slice(type.lastIndexOf('.') + 1)

const REDIS = { system: 'redis', name: '0', peer: 'redis.0', port: '6379' }
const PAYMENTS_DB = { system: 'mysql', name: 'payments', table: 'transactions', peer: 'mysql.cubedemo', port: '3306', user: 'payments' }

// Outgoing calls, spelled as the DB / External tables and the span stream
// spell them. `callee` is a call into another service of ours, which the trace
// follows across the process boundary.
const CALLS = {
  'GET redis.session:*': { db: { ...REDIS, op: 'GET' } },
  'SETEX redis.session:*': { db: { ...REDIS, op: 'SETEX' } },
  'UPDATE payments.transactions': { db: { ...PAYMENTS_DB, op: 'UPDATE' }, statement: 'UPDATE transactions SET status = ? WHERE id = ?' },
  'SELECT payments.transactions': { db: { ...PAYMENTS_DB, op: 'SELECT' }, statement: 'SELECT * FROM transactions WHERE id = ?' },
  'find cubedemo.search': { db: { system: 'mongodb', op: 'find', name: 'cubedemo', collection: 'search', peer: 'mongodb.cubedemo', port: '27017' } },
  'POST api.twilio.com/2010-04-01/Messages.json': { url: 'https://api.twilio.com/2010-04-01/Messages.json' },
  'GET api.twilio.com/2010-04-01/Accounts': { url: 'https://api.twilio.com/2010-04-01/Accounts' },
  'POST maps.googleapis.com/maps/api/geocode': { url: 'https://maps.googleapis.com/maps/api/geocode' },
  'POST api.stripe.com/v1/charges': { url: 'https://api.stripe.com/v1/charges' },
  'POST payment.cubedemo.com/v1/payments': {
    url: 'https://payment.cubedemo.com/v1/payments',
    callee: { service: 'payment-service', endpoint: 'POST /v1/payments' },
  },
  'GET maps.googleapis.com/v1/': { url: 'https://maps.googleapis.com/v1/' },
  'POST api.twilio.com/v1/sendSMS': { url: 'https://api.twilio.com/v1/sendSMS' },
}

// A service's own MySQL table, for the successful query a request makes before
// the call that fails — the tracesExplorer spelling.
function callOf(name) {
  if (CALLS[name]) return CALLS[name]
  // The DB tab's other operations, spelled the way it lists them.
  const redis = name.match(REDIS_CALL)
  if (redis) return { db: { ...REDIS, op: redis[1] } }
  const own = name.match(/^([A-Z]+) payments\.(\w+)$/)
  if (own) return { db: { ...PAYMENTS_DB, op: own[1], table: own[2] } }
  const table = name.slice(name.lastIndexOf('.') + 1)
  return { db: { system: 'mysql', op: 'SELECT', name: 'cubedemo', table, peer: 'cubedemo.abcdefgh.us-west-2.rds.amazonaws.com', port: '3306', user: 'cubedemo' } }
}

const categoryOf = name => (callOf(name).db ? 'db' : 'http')

// The repository a payments-table write goes through, named for its table, so
// a failed refund update reads RefundRepository rather than the service's own.
function entityOf(call) {
  if (!call || !call.includes('payments.')) return null
  const { db } = callOf(call)
  const table = db?.system === 'mysql' ? db.table : null
  if (!table) return null
  const singular = table.endsWith('ies') ? `${table.slice(0, -3)}y` : table.replace(/s$/, '')
  return singular.replace(/(^|_)([a-z])/g, (_, __, ch) => ch.toUpperCase())
}

// `hosts` are the infrastructure hosts each service's logs and metrics already
// name, so a host in the breakdown is a link that resolves. payment-service is
// the exception: it runs on the four JVMs the Runtime tab tracks, and a sample
// only lands on one that was up at that instant.
const SERVICES = {
  'payment-service': { pkg: 'payment', ctrlClass: 'PaymentsController', ctrlSpan: 'PaymentsController', dao: 'TransactionDao', entity: 'Transaction', hosts: null },
  'order-service': { pkg: 'order', ctrlClass: 'OrderController', ctrlSpan: 'orderController', dao: 'orderDao', entity: 'Order', hosts: ['ip-10-0-143-40'] },
  'shipment-service': { pkg: 'shipment', ctrlClass: 'ShipmentController', ctrlSpan: 'shipmentController', dao: 'shipmentDao', entity: 'Shipment', hosts: ['ip-10-0-143-40'] },
  'notify-service': { pkg: 'notify', ctrlClass: 'NotifyController', ctrlSpan: 'notifyController', dao: 'notifyDao', entity: 'Notification', hosts: ['ip-10-0-130-150'] },
  'search-service': { pkg: 'search', ctrlClass: 'SearchController', ctrlSpan: 'searchController', dao: 'searchDao', entity: 'Search', hosts: ['ip-10-0-144-12'] },
}

/* ---- the catalog ---- */

// The route mix eventsStore gives every service: POST, GET, PATCH and a
// long-tail batch route.
const routeMix = route => [
  [`POST ${route}`, 0.46], [`GET ${route}`, 0.28], [`PATCH ${route}`, 0.13], [`POST ${route}/bulk-sync`, 0.013],
]

const REDIS_GET = 'GET redis.session:*'
const STRIPE = 'POST api.stripe.com/v1/charges'
const PAYMENT_CALL = 'POST payment.cubedemo.com/v1/payments'

/**
 * Where server-side errors are counted.
 *
 * payment-service gets one source per RED endpoint, off that endpoint's own
 * profiles. The rest get one per service, off its service profile, split over
 * routes. `incident` is what the source throws while the pool is out, `quiet`
 * what it throws otherwise (a bare name is a share of 1). `calls` names the
 * outgoing call an exception came out of — absent, the failure is the
 * request's own (a connection that could not be had) — and `mirror` lists the
 * ones that also count on the Client side: each such request has a failing
 * call behind it, so the call's errors are the endpoint's, one for one.
 *
 * The pool is every incident error on payment-service, which is what the
 * outage is: the RuntimeException "500 Internal Server Error" rows the old
 * static table carried were the same failures under a vaguer name.
 */
const SERVER_SOURCES = [
  {
    service: 'payment-service', rate: ['red', 'POST /v1/payments/:id/capture'],
    endpoints: [['POST /v1/payments/:id/capture', 1]],
    incident: ['pool'], quiet: ['stripeTimeout'],
    calls: { pool: REDIS_GET, stripeTimeout: STRIPE }, mirror: ['stripeTimeout'],
  },
  {
    service: 'payment-service', rate: ['red', 'GET /v1/payments/:id'],
    endpoints: [['GET /v1/payments/:id', 1]],
    incident: ['pool'], quiet: ['dbFail'],
    calls: { pool: REDIS_GET },
  },
  {
    service: 'payment-service', rate: ['red', 'POST /v1/payments'],
    endpoints: [['POST /v1/payments', 1]],
    incident: ['pool'], quiet: [['stripeTimeout', 0.55], ['dbFail', 0.45]],
    calls: { pool: REDIS_GET, stripeTimeout: STRIPE }, mirror: ['stripeTimeout'],
  },
  {
    // An update writes the session rather than reading it.
    service: 'payment-service', rate: ['red', 'PATCH /v1/payments/:id'],
    endpoints: [['PATCH /v1/payments/:id', 1]],
    incident: ['pool'], quiet: ['hikari'],
    calls: { pool: 'SETEX redis.session:*' },
  },
  {
    service: 'payment-service', rate: ['red', 'GET /v1/payments/:id/status'],
    endpoints: [['GET /v1/payments/:id/status', 1]],
    incident: ['pool'], quiet: ['dbFail'],
    calls: { pool: REDIS_GET },
  },
  {
    // order- and shipment-service sit downstream of payment-service, which is
    // the whole of their incident: the call into it fails.
    service: 'order-service', rate: ['service', 'order-service'],
    endpoints: routeMix('/v1/order'),
    incident: ['downstream'], quiet: ['hikari'],
    calls: { downstream: PAYMENT_CALL }, mirror: ['downstream'],
  },
  {
    service: 'shipment-service', rate: ['service', 'shipment-service'],
    endpoints: routeMix('/v1/shipment'),
    incident: ['downstream'], quiet: ['mapsTimeout'],
    calls: { downstream: PAYMENT_CALL, mapsTimeout: 'GET maps.googleapis.com/v1/' },
    mirror: ['downstream', 'mapsTimeout'],
  },
  {
    // Bulk sends trip Twilio's rate limit far more than single ones do.
    service: 'notify-service', rate: ['service', 'notify-service'],
    endpoints: [['POST /v1/notify', 0.8], ['POST /v1/notify/bulk-sync', 0.2]],
    quiet: ['twilio429'],
    calls: { twilio429: 'POST api.twilio.com/v1/sendSMS' }, mirror: ['twilio429'],
  },
  {
    service: 'search-service', rate: ['service', 'search-service'],
    endpoints: [['GET /v1/search', 0.62], ['POST /v1/search', 0.38]],
    quiet: ['dbFail'],
    calls: { dbFail: 'find cubedemo.search' }, mirror: ['dbFail'],
  },
]

// A card decline is the issuer saying no, which it does at the same rate
// whether Redis is up or not — nine an hour, a fraction of a percent of
// charges. It follows the traffic wave and nothing else, which is what lets it
// climb the table as the window widens past the incident.
const CARD_DECLINES = { baseline: 0.15, noise: 0.3, seed: 1201, diurnal: true }
const ALWAYS = { baseline: 100 }

// Callers weighted by the errors each one contributes to the call, from the
// callers tables. A call whose callers all publish 0% falls back to traffic.
function callersOf(list) {
  const byErr = list.map(c => [c.endpoint, c.rpm * c.errPct])
  const use = byErr.some(([, w]) => w > 0) ? byErr : list.map(c => [c.endpoint, c.rpm])
  return use.filter(([, w]) => w > 0)
}

/**
 * Where client-side errors are counted: payment-service's outgoing calls, off
 * the DB and External tables' own profiles, split over the endpoints that make
 * them. Every one is absorbed — a session read from the database instead, a
 * write retried on a fresh connection, a best-effort SMS — so the trace fails
 * at the call and the request itself still answers 200.
 *
 * The tables say so themselves: /status makes 86.9 Redis calls a minute and
 * 3.3% of them fail, while /status answers 49.8 requests a minute and 0.3% of
 * those do. A call failure that does take its request down is the Server
 * side's to count, where the RED table reads it; it reaches this side only as
 * a mirror of that row (`mirror` above), one for one. A source here letting
 * its own escape would fail about three times as many payment requests as the
 * RED table says failed.
 */
const CLIENT_SOURCES = [
  { call: REDIS_GET, rate: ['db', REDIS_GET], callers: callersOf(dbEndpointCallers[REDIS_GET]), incident: ['pool'], quiet: ['redisConn'] },
  { call: 'SETEX redis.session:*', rate: ['db', 'SETEX redis.session:*'], callers: callersOf(dbEndpointCallers['SETEX redis.session:*']), incident: ['pool'], quiet: ['redisConn'] },
  // Threads parked on the Redis pool hold their database connections, so the
  // Hikari pool starves behind it — the incident's second-order failure.
  { call: 'UPDATE payments.transactions', rate: ['db', 'UPDATE payments.transactions'], callers: callersOf(dbEndpointCallers['UPDATE payments.transactions']), quiet: ['hikari'] },
  ...['POST api.twilio.com/2010-04-01/Messages.json', 'GET api.twilio.com/2010-04-01/Accounts'].map(call => (
    { call, rate: ['external', call], callers: callersOf(externalEndpointCallers[call]), quiet: ['twilio429'] }
  )),
  { call: 'POST maps.googleapis.com/maps/api/geocode', rate: ['external', 'POST maps.googleapis.com/maps/api/geocode'], callers: callersOf(externalEndpointCallers['POST maps.googleapis.com/maps/api/geocode']), quiet: ['mapsTimeout'] },
  { call: STRIPE, rate: ['flat', CARD_DECLINES], callers: [['POST /v1/payments/:id/capture', 0.7], ['POST /v1/payments', 0.3]], quiet: ['cardDeclined'], declined: true },
  // The rest of the DB tab's failing operations. Every Redis key family shares
  // redis.0 and its pool, so it fails as the session keys do; a MySQL write
  // starves behind the pool as the UPDATE does. Appended, never interleaved:
  // a row's index is part of every sample's trace id.
  ...dbEndpoints
    .filter(r => r.errPct > 0 && ![REDIS_GET, 'SETEX redis.session:*', 'UPDATE payments.transactions'].includes(r.endpoint))
    .map(r => (r.kind === 'redis'
      ? { call: r.endpoint, rate: ['db', r.endpoint], callers: callersOf(dbEndpointCallers[r.endpoint]), incident: ['pool'], quiet: ['redisConn'] }
      : { call: r.endpoint, rate: ['db', r.endpoint], callers: callersOf(dbEndpointCallers[r.endpoint]), quiet: ['hikari'] })),
]

// Static: one entry per series row, in a fixed order. A row's index is part of
// every sample's trace id, so this is built once and never reordered.
const ROWS = []
const ROW_INDEX = new Map()
// A source is one rounding unit — its parts' integer series add up to its
// total exactly. Each part is one row with its share of the source.
const SOURCES = []
// Client rows that are server rows seen from the call's side: idx → [server idx].
const COPIES = new Map()

const rowId = s => [s.side, s.service, s.endpoint, s.spanName, EXC[s.exc].type, s.httpCode].join('|')

function addRow(spec) {
  const id = rowId(spec)
  if (ROW_INDEX.has(id)) return ROW_INDEX.get(id)
  const x = EXC[spec.exc]
  const idx = ROWS.length
  ROWS.push({
    ...spec, id, idx,
    exception: x.type, exceptionShort: shortName(x.type), message: x.message,
  })
  ROW_INDEX.set(id, idx)
  return idx
}

function shareMap(list) {
  const pairs = (list ?? []).map(e => (Array.isArray(e) ? e : [e, 1]))
  const sum = pairs.reduce((a, [, s]) => a + s, 0)
  return new Map(pairs.map(([k, s]) => [k, sum > 0 ? s / sum : 0]))
}

// With nothing written for the incident, a source throws the same things
// during it as outside it — only more of them.
function regimes(src) {
  const quiet = shareMap(src.quiet)
  const inc = src.incident ? shareMap(src.incident) : quiet
  return { inc, quiet, excs: [...new Set([...inc.keys(), ...quiet.keys()])] }
}

for (const src of SERVER_SOURCES) {
  const { inc, quiet, excs } = regimes(src)
  const epTotal = src.endpoints.reduce((a, [, s]) => a + s, 0)
  const parts = []
  for (const [endpoint, share] of src.endpoints) {
    for (const exc of excs) {
      const call = src.calls?.[exc] ?? null
      for (const [code, codeShare] of Object.entries(EXC[exc].codes)) {
        const idx = addRow({ side: 'server', service: src.service, endpoint, spanName: endpoint, category: 'http', exc, httpCode: code, call, root: 'error' })
        parts.push({ idx, scale: share / epTotal, inc: (inc.get(exc) ?? 0) * codeShare, quiet: (quiet.get(exc) ?? 0) * codeShare })
        if (call && src.mirror?.includes(exc)) {
          const copy = addRow({ side: 'client', service: src.service, endpoint, spanName: call, category: categoryOf(call), exc, httpCode: EXC[exc].clientCode, call, root: 'error' })
          COPIES.set(copy, [...(COPIES.get(copy) ?? []), idx])
        }
      }
    }
  }
  SOURCES.push({ rate: src.rate, parts })
}

for (const src of CLIENT_SOURCES) {
  const { inc, quiet, excs } = regimes(src)
  const wTotal = src.callers.reduce((a, [, w]) => a + w, 0)
  const parts = []
  for (const [endpoint, w] of src.callers) {
    for (const exc of excs) {
      const root = src.declined ? 'declined' : 'ok'
      const idx = addRow({ side: 'client', service: 'payment-service', endpoint, spanName: src.call, category: categoryOf(src.call), exc, httpCode: EXC[exc].clientCode, call: src.call, root })
      parts.push({ idx, scale: w / wTotal, inc: inc.get(exc) ?? 0, quiet: quiet.get(exc) ?? 0 })
    }
  }
  SOURCES.push({ rate: src.rate, parts })
}

/* ---- counts over a window ---- */

// Profiles are resolved on first use, not at load: the derived tables build
// theirs lazily too, and building them here at import time would reorder every
// table's seeds behind its back.
let TABLE_PROFILES = null
function profilesOf(src) {
  if (src.resolved) return src.resolved
  const [kind, key] = src.rate
  if (kind === 'service') {
    const p = serviceProfile(key)
    src.resolved = { rate: p.rpm, err: p.err }
  } else if (kind === 'flat') {
    src.resolved = { rate: key, err: ALWAYS }
  } else {
    TABLE_PROFILES ??= Object.fromEntries(['red', 'db', 'external'].map(t => [
      t, Object.fromEntries(errorRateProfiles(t).map(p => [p.endpoint, p])),
    ]))
    const p = TABLE_PROFILES[kind][key]
    src.resolved = { rate: p.rpm, err: p.err }
  }
  return src.resolved
}

const sumOf = seq => seq.reduce((a, v) => a + (v ?? 0), 0)

// Integers whose sum is the rounded sum of the floats. Rounding each bucket on
// its own loses a trickle of 0.3-an-hour errors entirely and leaves Σ series
// disagreeing with the count; carrying the remainder forward keeps both.
function carryRound(seqs) {
  let acc = 0
  let prev = 0
  return seqs.map(seq => seq.map(v => {
    if (v == null) return null
    acc += v
    const r = Math.round(acc)
    const out = r - prev
    prev = r
    return out
  }))
}

// The minutes of a bucket that have happened. "Today" runs to midnight, so the
// bucket holding now is a whole step long with most of it still to come, and
// counting all of it would count errors nobody has thrown yet — a few minutes
// past midnight, more than Last 15 minutes holds. A trailing window's buckets
// have all happened, so the reference hour, and its calibration, are untouched.
const elapsedMin = (win, b) => (b.future ? 0 : Math.min(b.durMin, Math.max(0, win.nowSec - b.t) / 60))

// Errors in each bucket: requests in it times the share that failed.
const bucketErrors = (win, rate, err) => win.buckets.map(b => (
  b.future ? null : (sampleAt(rate, b) * sampleAt(err, b) / 100) * elapsedMin(win, b)
))

/**
 * The one constant that makes a source's reference hour come out at exactly
 * what the tables publish: rpm × err% × 60, the product of the two pinned
 * means.
 *
 * Every other window then counts bucket by bucket, times this. The obvious
 * alternative — the product of the window's two means — is exact at the
 * reference hour too, and wrong everywhere else in a way that shows: the
 * incident runs in whatever hour the demo is opened, which is not the week's
 * average hour, so mean × mean over seven days counted more pool errors than
 * the one hour that holds the whole outage. Counted per bucket, with the
 * incident on the minute grid (incidentErrorsIn), a window holding the outage
 * counts the outage's errors, once.
 */
function calibrationOf(src) {
  if (src.k != null) return src.k
  const { rate, err } = profilesOf(src)
  const ref = REFERENCE_WINDOW
  const target = (windowMean(ref, rate) * windowMean(ref, err) / 100) * ref.pastMinutes
  const counted = sumOf(bucketErrors(ref, rate, err))
  src.k = counted > 0 ? target / counted : 0
  return src.k
}

// The incident's share of an error rate at incident weight w. The profile is
// baseline·(1 + (peak−1)·w), so the incident is (peak−1)·w of every
// 1 + (peak−1)·w — jitter and the daily wave multiply both and cancel.
const incidentShare = (peak, w) => {
  const x = (peak - 1) * w
  return x > 0 ? x / (1 + x) : 0
}

/**
 * The incident's errors inside one bucket, counted a minute at a time.
 *
 * A three-hour bucket samples traffic at its opening edge, which is fine for
 * the steady background and wrong for the outage: the outage ran in the
 * bucket's last 22 minutes, at whatever the traffic was then, and the edge
 * can sit three hours up or down the daily wave from it. Counted on the same
 * minute grid the hour's own buckets use, the incident is the same minutes —
 * same traffic, same jitter — in every window that holds it, so the week and
 * the hour agree on how many errors the pool threw.
 */
function incidentErrorsIn(win, b, rate, err, peak) {
  const startSec = b.t
  const endSec = b.t + Math.round(elapsedMin(win, b) * 60)
  const from = Math.max(startSec, win.nowSec - INCIDENT_START_MIN * 60)
  let sum = 0
  for (let t = from - (((from % 60) + 60) % 60); t < endSec; t += 60) {
    const t0 = Math.max(t, startSec)
    const t1 = Math.min(t + 60, endSec)
    if (t1 <= t0) continue
    const slice = { t: t0, ms: t0 * 1000, m: (win.nowSec - t0) / 60, durMin: (t1 - t0) / 60 }
    slice.w = incidentWeightOver(slice.m, slice.durMin)
    const s = incidentShare(peak, slice.w)
    if (s > 0) sum += (sampleAt(rate, slice) * sampleAt(err, slice) / 100) * s * slice.durMin
  }
  return sum
}

function sourceValues(win, src) {
  const { rate, err } = profilesOf(src)
  const peak = err.peak ?? 1
  const k = calibrationOf(src)
  const raw = bucketErrors(win, rate, err)
  // Each bucket split into the incident's errors and everyone else's. A
  // bucket of a minute or less is already on the grid, which is what keeps
  // the reference hour — and so its calibration — exactly as measured.
  const inc = []
  const quiet = []
  win.buckets.forEach((b, i) => {
    if (raw[i] == null) { inc.push(0); quiet.push(0); return }
    const s = incidentShare(peak, b.w ?? incidentWeightOver(b.m, b.durMin))
    quiet.push(raw[i] * (1 - s))
    inc.push(s > 0 && b.durMin > 1 ? incidentErrorsIn(win, b, rate, err, peak) : raw[i] * s)
  })
  const floats = src.parts.map(p => raw.map((v, i) => (
    v == null ? null : k * p.scale * (inc[i] * p.inc + quiet[i] * p.quiet)
  )))
  return { inc, quiet, ints: carryRound(floats) }
}

function windowState(win) {
  const ints = new Array(ROWS.length).fill(null)
  const meta = new Array(ROWS.length).fill(null)
  for (const src of SOURCES) {
    const { inc, quiet, ints: rounded } = sourceValues(win, src)
    src.parts.forEach((p, j) => {
      ints[p.idx] = rounded[j]
      meta[p.idx] = { incByBucket: inc, quietByBucket: quiet, inc: p.inc, quiet: p.quiet }
    })
  }
  for (const [idx, from] of COPIES) {
    ints[idx] = win.buckets.map((b, i) => (b.future ? null : from.reduce((a, f) => a + ints[f][i], 0)))
    meta[idx] = {
      ...meta[from[0]],
      inc: from.reduce((a, f) => a + meta[f].inc, 0),
      quiet: from.reduce((a, f) => a + meta[f].quiet, 0),
    }
  }
  return { ints, meta }
}

/**
 * The same window one span earlier, bucket for bucket — what a count's delta is
 * measured against.
 *
 * Shifted directly rather than re-resolved: resolving an absolute range floors
 * both ends again, and a previous hour that came back a minute short would read
 * as a drop. Only what has happened is carried — the buckets before now, and
 * of the one holding now only its elapsed minutes — so "Today" is compared
 * with the same stretch of yesterday rather than all of it. Each bucket's
 * incident share is re-measured at its new distance from now, which is the
 * point: the hour before the last one never saw the pool fail.
 */
export function previousWindow(win) {
  const by = win.spanSec
  const buckets = win.pastBuckets.map((b, i) => {
    const t = b.t - by
    const m = b.m + by / 60
    const durMin = elapsedMin(win, b)
    const clock = formatLocal(t * 1000, 'MMM DD HH:mm')
    return { ...b, i, t, ms: t * 1000, m, durMin, w: incidentWeightOver(m, durMin), future: false, label: clock, exactTime: clock }
  })
  const last = buckets[buckets.length - 1]
  return {
    ...win,
    start: win.start - by,
    end: last ? last.t + Math.round(last.durMin * 60) : win.start - by,
    relative: false,
    trailing: false,
    buckets,
    pastBuckets: buckets,
    pastMinutes: buckets.reduce((a, b) => a + b.durMin, 0),
    isAbsolute: true,
  }
}

// Built once per window, both sides together — the client side mirrors rows
// of the server side — and the previous window with it, for the deltas.
const SERIES_MEMO = new WeakMap()

function seriesState(win) {
  const hit = SERIES_MEMO.get(win)
  if (hit) return hit
  const cur = windowState(win)
  const prev = windowState(previousWindow(win))
  const bySide = { server: [], client: [] }
  const byId = new Map()
  for (const spec of ROWS) {
    const seq = cur.ints[spec.idx]
    const count = sumOf(seq)
    if (!(count > 0)) continue
    const row = {
      id: spec.id,
      side: spec.side,
      service: spec.service,
      endpoint: spec.endpoint,
      spanName: spec.spanName,
      category: spec.category,
      exception: spec.exception,
      exceptionShort: spec.exceptionShort,
      message: spec.message,
      httpCode: spec.httpCode,
      count,
      prevCount: sumOf(prev.ints[spec.idx]),
      series: win.buckets.map((b, i) => ({ m: b.m, t: b.t, label: b.label, exactTime: b.exactTime, value: seq[i] })),
    }
    bySide[spec.side].push(row)
    byId.set(row.id, { row, idx: spec.idx, meta: cur.meta[spec.idx] })
  }
  const state = { bySide, byId }
  SERIES_MEMO.set(win, state)
  return state
}

/**
 * Every error series the window holds on one side, `count > 0` only. The same
 * array comes back for the same window, so a page can filter it in a memo
 * without rebuilding it.
 */
export function errorSeriesForWindow(win, side = 'server') {
  return seriesState(win).bySide[side] ?? []
}

/** Bucket-wise sum of rows' series; a bucket that has not happened stays null. */
export function sumErrorSeries(rows, win) {
  return win.buckets.map((b, i) => ({
    m: b.m,
    t: b.t,
    label: b.label,
    exactTime: b.exactTime,
    value: b.future ? null : rows.reduce((a, r) => a + (r.series[i]?.value ?? 0), 0),
  }))
}

/* ---- groups ---- */

const DEFAULT_BY = ['side', 'service', 'endpoint', 'spanName', 'exception']
const GROUP_FIELDS = ['side', 'service', 'endpoint', 'spanName', 'category', 'exception', 'exceptionShort', 'message']

/**
 * Rows folded into table rows, biggest first.
 *
 * A group is keyed on the exception TYPE, as the original page's `error=`
 * parameter is, so one exception answering with two status codes is one row
 * with two codes rather than two rows. A field outside `by` takes the value of
 * the largest row folded in. `by` is kept on the group, so a link built from it
 * filters on exactly what the group is.
 */
export function groupErrorSeries(rows, win, { by = DEFAULT_BY } = {}) {
  const buckets = new Map()
  for (const r of rows) {
    const key = by.map(f => r[f]).join('|')
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key).push(r)
  }
  const nowMs = Math.min(win.end, win.nowSec) * 1000
  return [...buckets].map(([id, rs]) => {
    const lead = rs.reduce((a, r) => (r.count > a.count ? r : a))
    const codes = new Map()
    for (const r of rs) if (r.httpCode) codes.set(r.httpCode, (codes.get(r.httpCode) ?? 0) + r.count)
    const series = sumErrorSeries(rs, win)
    const count = rs.reduce((a, r) => a + r.count, 0)
    const prevCount = rs.reduce((a, r) => a + r.prevCount, 0)
    const lit = series.map((p, i) => (p.value > 0 ? i : -1)).filter(i => i >= 0)
    const first = win.buckets[lit[0]]
    const last = win.buckets[lit[lit.length - 1]]
    return {
      id,
      ...Object.fromEntries(GROUP_FIELDS.map(f => [f, lead[f]])),
      httpCodes: [...codes].map(([code, n]) => ({ code, count: n })).sort((a, b) => Number(a.code) - Number(b.code)),
      count,
      prevCount,
      isNew: prevCount === 0 && count > 0,
      series,
      firstSeenMs: first ? firstSeenIn(rs, win, lit[0]) : null,
      lastSeenMs: last ? Math.min(last.ms + last.durMin * 60000, nowMs) : null,
      seriesIds: rs.map(r => r.id),
      by,
    }
  }).sort((a, b) => b.count - a.count || a.exception.localeCompare(b.exception) || a.id.localeCompare(b.id))
}

// When a group's oldest errors were thrown, to the bucket — closer when the
// bucket says more. At a week the first lit bucket is three hours wide, and a
// pool that gave out 22 minutes ago is not "first seen 3h ago": when every
// error the group has in that bucket is the incident's, none of them can be
// older than the incident, which is also where their samples are placed. Rows
// this window did not build fall back to the bucket's opening edge.
function firstSeenIn(rs, win, i) {
  const b = win.buckets[i]
  const incidentStartMs = (win.nowSec - INCIDENT_START_MIN * 60) * 1000
  const state = SERIES_MEMO.get(win)
  if (!state || incidentStartMs <= b.ms) return b.ms
  const allIncident = rs.every(r => {
    const e = state.byId.get(r.id)
    if (!e) return false
    return !(e.row.series[i].value > 0) || incidentFraction(e.meta, i) >= 1
  })
  return allIncident ? incidentStartMs : b.ms
}

/** The table for one side, optionally one service's rows only. */
export function errorGroupsForWindow(win, { side = 'server', service = null, by } = {}) {
  const rows = errorSeriesForWindow(win, side)
  return groupErrorSeries(service ? rows.filter(r => r.service === service) : rows, win, { by })
}

/* ---- sample identity ---- */

// FNV-1a, the hash eventsStore seeds with.
function hashStr(s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

const hex = (n, width) => n.toString(16).padStart(width, '0')
const digest = (s, salts, len) => salts.map(k => hex(hashStr(`${k}:${s}`), 8)).join('').slice(0, len)
const xorHex = (a, b) => Array.from(a, (c, i) => (parseInt(c, 16) ^ parseInt(b[i], 16)).toString(16)).join('')

// 32 hex digits: a checksum, then (ms before BASE_TIME · row index) masked by
// it. The offset is relative to BASE_TIME and not to the epoch because every
// page is: a link reopened after a reload lands at the same distance from now,
// and so still inside the incident it was taken from. The mask is so the ids
// look like trace ids rather than counters, and the checksum is so an id that
// is not one of these — a seeded trace, a log record's — decodes to nothing
// and keeps its own path through buildTrace.
const OFFSET_HEX = 10
const ROW_HEX = 3
const CHECK_HEX = 32 - OFFSET_HEX - ROW_HEX
const CHECK_SALTS = ['c1', 'c2', 'c3']
const MASK_SALTS = ['m1', 'm2']

function encodeTraceId(idx, offsetMs) {
  const payload = hex(offsetMs, OFFSET_HEX) + hex(idx, ROW_HEX)
  const check = digest(payload, CHECK_SALTS, CHECK_HEX)
  return check + xorHex(payload, digest(check, MASK_SALTS, payload.length))
}

// The service page's "Error requests" panel names its rows by short decimal
// ids that predate this module. They decode here too, so the trace each one
// opens is the failing request the row describes rather than a borrowed one
// from another service that succeeded.
const ALIASES = new Map(errorRequests.map(r => [r.traceId, {
  endpoint: r.endpoint, agoMin: parseInt(r.timestamp, 10), durationMs: r.latencyMs,
}]))

function decodeTraceId(id) {
  if (typeof id !== 'string') return null
  const alias = ALIASES.get(id)
  if (alias) {
    const idx = ROW_INDEX.get(rowId({ side: 'server', service: 'payment-service', endpoint: alias.endpoint, spanName: alias.endpoint, exc: 'pool', httpCode: '500' }))
    if (idx == null) return null
    const jitter = Math.floor(noiseAt(hashStr(id), 0) * 30000)
    return { idx, tMs: BASE_MS - alias.agoMin * 60000 - jitter, traceId: id, durationMs: alias.durationMs }
  }
  if (!/^[0-9a-f]{32}$/.test(id)) return null
  const check = id.slice(0, CHECK_HEX)
  const payload = xorHex(id.slice(CHECK_HEX), digest(check, MASK_SALTS, 32 - CHECK_HEX))
  if (digest(payload, CHECK_SALTS, CHECK_HEX) !== check) return null
  const offset = parseInt(payload.slice(0, OFFSET_HEX), 16)
  const idx = parseInt(payload.slice(OFFSET_HEX), 16)
  if (!(idx < ROWS.length)) return null
  return { idx, tMs: BASE_MS - offset, traceId: id }
}

/* ---- where and on what ---- */

const PAYMENT_HOSTS = RUNTIME_HOSTS.map(h => ({ id: h.id, load: h.load, lives: livesOf(h, BASE_SEC) }))

// A payment-service error lands on a JVM that was running at that instant,
// weighted by its load — never on the host added by hand before it was added,
// nor on the one restarting while it was down.
function hostAt(service, tMs, u) {
  const fixed = SERVICES[service]?.hosts
  if (fixed) return fixed[Math.floor(u * fixed.length) % fixed.length]
  const t = tMs / 1000
  const up = PAYMENT_HOSTS.filter(h => h.lives.some(l => l.from <= t && (t < l.to || l.running)))
  const pool = up.length ? up : PAYMENT_HOSTS
  let left = u * pool.reduce((a, h) => a + h.load, 0)
  for (const h of pool) {
    left -= h.load
    if (left < 0) return h.id
  }
  return pool[pool.length - 1].id
}

// payment-service runs a 20% canary that fails 2.2x as often while the pool is
// out (the explore stores' ARCH D11), so it owns 0.2·2.2 / (0.8 + 0.2·2.2) of
// incident errors and its plain 20% of everything else.
const CANARY = 'v9.11.0'
const STABLE = 'v9.10.1'
const CANARY_SHARE = 0.2
const CANARY_ERROR_SCALE = 2.2
const CANARY_IN_INCIDENT = (CANARY_SHARE * CANARY_ERROR_SCALE) / (1 - CANARY_SHARE + CANARY_SHARE * CANARY_ERROR_SCALE)

function versionAt(service, tMs, u) {
  if (service !== 'payment-service') return STABLE
  const w = incidentWeight((BASE_MS - tMs) / 60000)
  return u < CANARY_SHARE + (CANARY_IN_INCIDENT - CANARY_SHARE) * w ? CANARY : STABLE
}

// Everything about one sample that is not its structure, hashed off its id
// with a fixed salt per fact, so adding a draw for one fact never moves another.
function factsOf(ref) {
  const spec = ROWS[ref.idx]
  const seed = hashStr(ref.traceId)
  const draw = salt => noiseAt(seed, salt)
  return {
    seed,
    draw,
    host: hostAt(spec.service, ref.tMs, draw(1)),
    version: versionAt(spec.service, ref.tMs, draw(2)),
  }
}

/* ---- samples ---- */

// How many occurrences the drawer steps through: the original page fetched ten
// traces per group.
const SAMPLE_N = 10
// Past this many errors the breakdown is measured on a stratified sample of
// them and scaled up, rather than placing a week of errors one by one.
const BREAKDOWN_UNITS = 1000

// A sample's time is its trace's start, and on Client the span that recorded
// the exception opens up to ~20 ms later. Placed this far short of the bucket's
// end, that span stays in the bucket — and in the window, when the window
// stops short of now — so the row the Traces page merges in is one it shows.
const SPAN_LEAD_MS = 50

// Which share of a row's errors in bucket i the incident accounts for.
function incidentFraction(meta, i) {
  const a = (meta.incByBucket[i] ?? 0) * meta.inc
  const b = (meta.quietByBucket[i] ?? 0) * meta.quiet
  return a + b > 0 ? a / (a + b) : 0
}

/**
 * `n` errors picked out of a group's series, stratified: the k-th lands in the
 * k-th n-th of the group's errors in time order, so a sample spans the window
 * the way the errors do — never `spreadTimes`, which would happily put a pool
 * exhaustion three days before the pool failed.
 *
 * Inside a bucket an incident error is placed inside the incident's stretch of
 * it: a three-hour bucket that ends now holds the outage in its last 22
 * minutes, not anywhere in it.
 *
 * With fewer picks than errors, the last stratum is the group's newest error
 * rather than a draw from its newest n-th, and sits within one gap between
 * errors of its bucket's end rather than anywhere in it. The drawer opens on
 * it beside "last seen 4 mins ago", and a week's last bucket is three hours
 * wide.
 */
function unitsFor(group, win, n) {
  const state = seriesState(win)
  const entries = (group.seriesIds ?? []).map(id => state.byId.get(id)).filter(Boolean)
  const total = entries.reduce((a, e) => a + e.row.count, 0)
  const m = Math.min(n, total)
  if (!(m > 0)) return []
  const seed = hashStr(group.id ?? '')
  const endMs = Math.min(win.end, win.nowSec) * 1000
  const incidentStartMs = (win.nowSec - INCIDENT_START_MIN * 60) * 1000
  const perBucket = win.buckets.map((_, i) => entries.reduce((a, e) => a + (e.row.series[i].value ?? 0), 0))
  const units = []
  let i = 0
  let cum = 0
  for (let k = 0; k < m; k++) {
    const newest = k === m - 1 && total > m
    const u = newest ? total - 0.5 : ((k + 0.15 + 0.7 * noiseAt(seed, win.start + k)) / m) * total
    while (i < perBucket.length - 1 && cum + perBucket[i] <= u) { cum += perBucket[i]; i++ }
    let r = u - cum
    let pick = null
    for (const e of entries) {
      const v = e.row.series[i].value ?? 0
      if (v > 0) pick = e
      if (r < v) break
      r -= v
    }
    if (!pick) continue
    const b = win.buckets[i]
    const fromIncident = noiseAt(seed + 1, win.start + k) < incidentFraction(pick.meta, i)
    const lo = fromIncident ? Math.max(b.ms, incidentStartMs) : b.ms
    const hi = Math.min(b.ms + b.durMin * 60000, endMs)
    const span = Math.max(0, hi - lo - SPAN_LEAD_MS)
    const draw = noiseAt(seed + 2, win.start + k)
    const off = newest ? span - draw * Math.min(span, (hi - lo) / Math.max(1, perBucket[i])) : draw * span
    units.push({ idx: pick.idx, tMs: Math.floor(lo + off) })
  }
  return units
}

// Newest first, each with its trace id. Two picks of one row in the same
// millisecond would be one trace, so the later is nudged a millisecond back.
function refsFor(group, win, n) {
  const units = unitsFor(group, win, n).sort((a, b) => b.tMs - a.tMs || a.idx - b.idx)
  const seen = new Set()
  const out = []
  for (const u of units) {
    let t = u.tMs
    while (seen.has(`${u.idx}:${t}`)) t -= 1
    seen.add(`${u.idx}:${t}`)
    if (BASE_MS - t < 0) continue
    out.push(refOf(u.idx, t))
  }
  return out
}

// The id is worked out when something first reads it. Encoding is most of
// what a pick costs, and the Traces merge reads one pick of each group's
// thousand.
function refOf(idx, tMs) {
  let id = null
  return { idx, tMs, get traceId() { return (id ??= encodeTraceId(idx, BASE_MS - tMs)) } }
}

// Every pick a group's breakdown counts, newest first: each error outright up
// to BREAKDOWN_UNITS of them, a stratified sample past that. Samples are taken
// from these and nowhere else — stratified picks move with how many are drawn,
// so ten drawn on their own were other errors than the breakdown's thousand,
// on hosts and versions the breakdown said had none. Kept per window, since the
// drawer reads them twice and the Traces merge reads every group's.
const REFS_MEMO = new WeakMap()

function groupRefs(group, win) {
  let byGroup = REFS_MEMO.get(win)
  if (!byGroup) REFS_MEMO.set(win, (byGroup = new Map()))
  const key = [group.id, ...(group.seriesIds ?? [])].join('\n')
  if (!byGroup.has(key)) byGroup.set(key, refsFor(group, win, BREAKDOWN_UNITS))
  return byGroup.get(key)
}

// `n` of them, evenly through the newest-first list: the newest, the oldest
// and the rest between, so they span the window the way the errors do. The
// first is the newest whatever `n` is, which is what lets the Traces merge
// take it as the drawer's first sample.
function sampleRefs(group, win, n) {
  const all = groupRefs(group, win)
  if (all.length <= n) return all
  if (n <= 1) return all.slice(0, Math.max(0, n))
  return Array.from({ length: n }, (_, k) => all[Math.round((k * (all.length - 1)) / (n - 1))])
}

/**
 * Up to `n` occurrences of a group, newest first — min(n, group.count) of
 * them, each one an error the breakdown counted. Each is read back off the
 * trace its id decodes to, so what the drawer shows is what `/trace/<id>` will
 * draw.
 */
export function errorSamplesFor(group, win, n = SAMPLE_N) {
  return sampleRefs(group, win, n).map(ref => buildErrorTrace(ref).sample)
}

// Largest remainder, so the parts add up to `total` exactly. The entries go in
// value order so the helper's earlier-entry tie-break is the value-name one.
function apportion(tally, total) {
  const entries = [...tally].sort(([a], [b]) => String(a).localeCompare(String(b)))
  const counts = largestRemainder(entries.map(([, c]) => c), total)
  return entries
    .map(([value], i) => ({ value, count: counts[i] }))
    .filter(p => p.count > 0)
    .sort((a, b) => b.count - a.count || String(a.value).localeCompare(String(b.value)))
}

/**
 * Where a group's errors happened: by host and by version, each adding up to
 * the group's count. Measured on the picks the samples are taken from — on
 * every error outright when there are few — so a group of three shows the
 * three hosts its three samples name, and no sample of a bigger one names a
 * host or version the breakdown says had no errors.
 */
export function errorBreakdownFor(group, win) {
  const count = group?.count ?? 0
  const refs = count > 0 ? groupRefs(group, win) : []
  const hosts = new Map()
  const versions = new Map()
  for (const ref of refs) {
    const f = factsOf(ref)
    hosts.set(f.host, (hosts.get(f.host) ?? 0) + 1)
    versions.set(f.version, (versions.get(f.version) ?? 0) + 1)
  }
  return { host: apportion(hosts, count), version: apportion(versions, count) }
}

/* ---- traces ---- */

const rndFrom = seed => {
  let i = 0
  return () => noiseAt(seed, i++)
}
const hexOf = (rnd, len) => Array.from({ length: len }, () => Math.floor(rnd() * 16).toString(16)).join('')
const between = ([lo, hi], u) => lo * (hi / lo) ** u

function pickCode(codes, u) {
  const entries = Object.entries(codes)
  let left = u
  for (const [code, share] of entries) {
    left -= share
    if (left < 0) return code
  }
  return entries[entries.length - 1]?.[0] ?? '500'
}

function splitEndpoint(endpoint) {
  const i = endpoint.indexOf(' ')
  return [endpoint.slice(0, i), endpoint.slice(i + 1)]
}

function handlerOf(service, endpoint) {
  const svc = SERVICES[service]
  const [method, route] = splitEndpoint(endpoint)
  const op = route.endsWith('/capture') ? 'capture'
    : route.endsWith('/status') ? 'status'
      : route.endsWith('/bulk-sync') ? 'bulkSync'
        : ({ POST: 'create', GET: 'get', PATCH: 'update' })[method] ?? 'handle'
  const line = 60 + (hashStr(`${service} ${endpoint}`) % 180)
  return {
    op,
    span: `${svc.ctrlSpan}.${op}`,
    ns: `com.cubedemo.${svc.pkg}.${svc.ctrlClass}`,
    frame: `com.cubedemo.${svc.pkg}.${svc.ctrlClass}.${op}(${svc.ctrlClass}.java:${line})`,
  }
}

function stackFor(excKey, ctx) {
  const x = EXC[excKey]
  const lib = x.lib(ctx)
  const frames = [...lib, x.site(ctx), ctx.handlerFrame, ...JVM_TAIL]
  const lines = [`${x.type}: ${x.message}`, ...frames.map(f => `\tat ${f}`)]
  if (x.cause) {
    const [head, ...own] = x.cause
    lines.push(`Caused by: ${head}`, ...own.map(f => `\tat ${f}`), `\t... ${frames.length - lib.length} more`)
  }
  return lines.join('\n')
}

// `GET redis.session:*` → `session:usr_3f9a01c`; the other families get ids
// in the shape their keys hold.
const KEY_IDS = { session: 'usr_', idem: 'key_', ratelimit: 'mch_', token: 'tok_', merchant: 'mch_', lock: 'pay_' }
function redisKey(name, hex) {
  const pattern = name.slice(name.indexOf('redis.') + 'redis.'.length)
  const family = pattern.split(/[:.]/)[0]
  return pattern.replace(/\*$/, `${KEY_IDS[family] ?? ''}${hex}`)
}

function callTags(name, code, rnd) {
  const c = callOf(name)
  if (c.db) {
    const tags = dbTags(c.db)
    if (c.statement) tags['db.statement'] = c.statement
    if (c.db.system === 'redis') {
      // A real key, not the pattern the table aggregates on.
      const key = redisKey(name, hexOf(rnd, 7))
      tags['redis.key'] = key
      tags['cache.key'] = key
      tags['cache.operation'] = c.db.op === 'GET' || c.db.op === 'HGET' ? 'get' : 'set'
      tags['cache.hit'] = 'false'
    }
    return tags
  }
  return {
    category: 'http',
    'http.method': name.slice(0, name.indexOf(' ')),
    'http.url': c.url,
    ...(code ? { 'http.status_code': code } : {}),
    'net.peer.name': c.url.split('/')[2],
    'net.transport': 'ip_tcp',
    'otel.library.name': 'io.opentelemetry.apache-httpclient-4.0',
    'otel.library.version': '1.22.1-alpha',
  }
}

const exceptionOf = (excKey, ctx) => ({ type: EXC[excKey].type, message: EXC[excKey].message, stacktrace: stackFor(excKey, ctx) })

// The successful query a request makes before the call that fails it. Left
// out when the failure IS the database being unreachable.
function siblingOf(spec) {
  if (spec.exc === 'hikari' || spec.exc === 'dbFail') return null
  return spec.service === 'payment-service' ? 'SELECT payments.transactions' : `SELECT cubedemo.${SERVICES[spec.service].pkg}`
}

const ROOT_ATTRS = ['http.method', 'http.route', 'http.target', 'http.status_code']
const CALL_ATTRS = ['db.system', 'db.operation', 'db.statement', 'redis.key', 'http.method', 'http.url', 'http.status_code', 'net.peer.name']
const DOMAIN_ATTRS = ['payment.method', 'payment.processor']

function pickTags(tags, keys) {
  const out = {}
  for (const k of keys) if (tags[k] != null && tags[k] !== '') out[k] = String(tags[k])
  return out
}

/**
 * One sample's whole trace, and the sample read back off it.
 *
 * The shape is the seeded traces' — a server root, the controller, the work it
 * does, the call that failed — out of tracesExplorer's own span builder, so a
 * sample trace is not a lookalike. The exception is recorded where the house
 * rule says: the server span that answered with it and the client call that
 * got it back, never the controller in between. A call into another of our
 * services is followed across the boundary, which is how an order-service
 * error shows the Redis pool behind it.
 */
function buildErrorTrace(ref) {
  const spec = ROWS[ref.idx]
  const svc = SERVICES[spec.service]
  const x = EXC[spec.exc]
  const { seed, draw, host, version } = factsOf(ref)
  const traceId = ref.traceId
  const tagRnd = rndFrom(seed ^ 0x51ed27)
  const idRnd = rndFrom(seed ^ 0x2c1b3c6d)
  const newSpanId = () => hexOf(idRnd, 16)
  const rows = []
  let seq = 0
  const nextId = () => `err_${traceId}_${seq++}`
  const at = offMs => new Date(ref.tMs + offMs)

  const endpoint = spec.endpoint
  const [method, route] = splitEndpoint(endpoint)
  const handler = handlerOf(spec.service, endpoint)
  const ctx = { pkg: svc.pkg, entity: entityOf(spec.call) ?? svc.entity, call: spec.call, handlerFrame: handler.frame }
  const exception = exceptionOf(spec.exc, ctx)

  const rootFails = spec.root === 'error'
  const rootCode = spec.side === 'server' ? spec.httpCode
    : rootFails ? pickCode(x.codes, draw(3))
      : spec.root === 'declined' ? '402' : '200'

  // ---- layout, in whole milliseconds from the start of the trace ----
  const sibling = siblingOf(spec)
  const c0 = 1 + Math.floor(draw(4) * 3)
  const sibMs = sibling ? 2 + Math.floor(draw(5) * 12) : 0
  const post = 1 + Math.floor(draw(6) * 5)
  const f0 = c0 + 1 + (sibling ? sibMs + 1 : 0)
  let failMs = Math.round(between(x.ms, draw(7)))
  let total = f0 + failMs + post + 1
  if (ref.durationMs) {
    total = ref.durationMs
    failMs = Math.max(1, total - f0 - post - 1)
  }
  const thread = `http-nio-9090-exec-${1 + Math.floor(draw(8) * 12)}`

  const withEvent = (span, exc) => {
    rows.push(span)
    if (!exc) return span
    const durMs = Math.round(span.durationNs / 1e6)
    rows.push(makeSpanEvent({
      id: nextId(),
      time: new Date(span.time.getTime() + Math.max(0, durMs - 1)),
      service: span.service, traceId, spanId: span.spanId, eventName: 'exception',
      rootName: endpoint, host: span.tags['host.name'],
      extra: {
        'exception.type': exc.type,
        'exception.message': exc.message,
        'exception.stacktrace': exc.stacktrace,
        'service.version': span.tags['service.version'],
      },
    }))
    return span
  }

  const rootId = newSpanId()
  const root = withEvent(makeSpan({
    id: nextId(), time: at(0), service: spec.service, spanName: endpoint, spanKind: 'server',
    durationNs: total * 1e6, statusCode: rootFails ? 'ERROR' : 'UNSET',
    traceId, spanId: rootId, parentId: '', rootName: endpoint, host, exception,
    extra: {
      ...httpServerTags(tagRnd, { method, route, status: rootCode, host }),
      'thread.name': thread,
      ...(DOMAIN_TAGS[spec.service]?.(tagRnd) ?? {}),
      ...(x === EXC.stripeTimeout || x === EXC.cardDeclined ? { 'payment.processor': 'stripe' } : {}),
      'service.version': version,
      num_events: rootFails ? '1' : '0',
    },
  }), rootFails ? exception : null)

  const ctrlId = newSpanId()
  rows.push(makeSpan({
    id: nextId(), time: at(c0), service: spec.service, spanName: handler.span, spanKind: 'internal',
    durationNs: (total - c0 - 1) * 1e6, statusCode: rootFails ? 'ERROR' : 'UNSET',
    traceId, spanId: ctrlId, parentId: rootId, rootName: endpoint, host,
    extra: {
      category: 'internal',
      'code.function': handler.op,
      'code.namespace': handler.ns,
      'otel.library.name': 'io.opentelemetry.spring-webmvc-5.3',
      'otel.library.version': '1.22.1-alpha',
      'thread.name': thread,
      'service.version': version,
    },
  }))

  if (sibling) {
    rows.push(makeSpan({
      id: nextId(), time: at(c0 + 1), service: spec.service, spanName: sibling, spanKind: 'client',
      durationNs: sibMs * 1e6, statusCode: 'UNSET',
      traceId, spanId: newSpanId(), parentId: ctrlId, rootName: endpoint, host,
      extra: { ...callTags(sibling, '', tagRnd), 'service.version': version },
    }))
  }

  let failing = root
  if (spec.call) {
    const callCode = spec.side === 'client' ? spec.httpCode : x.clientCode
    const callId = newSpanId()
    const call = withEvent(makeSpan({
      id: nextId(), time: at(f0), service: spec.service, spanName: spec.call, spanKind: 'client',
      durationNs: failMs * 1e6, statusCode: 'ERROR',
      traceId, spanId: callId, parentId: ctrlId, rootName: endpoint, host, exception,
      extra: { ...callTags(spec.call, callCode, tagRnd), 'service.version': version, num_events: '1' },
    }), exception)
    if (spec.side === 'client') failing = call

    const callee = callOf(spec.call).callee
    if (callee) {
      // The other side of the call: payment-service answering 500 because its
      // own Redis lookup could not get a connection.
      const cHost = hostAt(callee.service, ref.tMs, draw(9))
      const cVersion = versionAt(callee.service, ref.tMs, draw(10))
      const cHandler = handlerOf(callee.service, callee.endpoint)
      const cExc = exceptionOf('pool', { pkg: SERVICES[callee.service].pkg, call: REDIS_GET, handlerFrame: cHandler.frame })
      const [cMethod, cRoute] = splitEndpoint(callee.endpoint)
      const sRoot = newSpanId()
      withEvent(makeSpan({
        id: nextId(), time: at(f0 + 1), service: callee.service, spanName: callee.endpoint, spanKind: 'server',
        durationNs: Math.max(1, failMs - 2) * 1e6, statusCode: 'ERROR',
        traceId, spanId: sRoot, parentId: callId, rootName: endpoint, host: cHost, exception: cExc,
        extra: {
          ...httpServerTags(tagRnd, { method: cMethod, route: cRoute, status: callCode, host: cHost }),
          ...(DOMAIN_TAGS[callee.service]?.(tagRnd) ?? {}),
          'service.version': cVersion,
          num_events: '1',
        },
      }), cExc)
      const sCtrl = newSpanId()
      rows.push(makeSpan({
        id: nextId(), time: at(f0 + 2), service: callee.service, spanName: cHandler.span, spanKind: 'internal',
        durationNs: Math.max(1, failMs - 4) * 1e6, statusCode: 'ERROR',
        traceId, spanId: sCtrl, parentId: sRoot, rootName: endpoint, host: cHost,
        extra: {
          category: 'internal',
          'code.function': cHandler.op,
          'code.namespace': cHandler.ns,
          'otel.library.name': 'io.opentelemetry.spring-webmvc-5.3',
          'otel.library.version': '1.22.1-alpha',
          'service.version': cVersion,
        },
      }))
      withEvent(makeSpan({
        id: nextId(), time: at(f0 + 3), service: callee.service, spanName: REDIS_GET, spanKind: 'client',
        durationNs: Math.max(1, failMs - 7) * 1e6, statusCode: 'ERROR',
        traceId, spanId: newSpanId(), parentId: sCtrl, rootName: endpoint, host: cHost, exception: cExc,
        extra: { ...callTags(REDIS_GET, '', tagRnd), 'service.version': cVersion, num_events: '1' },
      }), cExc)
    }
  } else {
    // No connection could be had, so no statement ever ran: the failure is the
    // data layer's own, and an internal span carries the status, not the
    // exception.
    const op = spec.exc === 'hikari' ? 'save' : 'find'
    rows.push(makeSpan({
      id: nextId(), time: at(f0), service: spec.service, spanName: `${svc.dao}.${op}`, spanKind: 'internal',
      durationNs: failMs * 1e6, statusCode: 'ERROR',
      traceId, spanId: newSpanId(), parentId: ctrlId, rootName: endpoint, host,
      extra: {
        category: 'internal',
        'code.function': op,
        'code.namespace': `com.cubedemo.${svc.pkg}.${svc.dao.charAt(0).toUpperCase()}${svc.dao.slice(1)}`,
        'otel.library.name': 'io.opentelemetry.spring-data-1.8',
        'otel.library.version': '1.22.1-alpha',
        'service.version': version,
      },
    }))
  }

  const attributes = spec.side === 'server'
    ? {
      ...pickTags(root.tags, ROOT_ATTRS),
      'host.name': host,
      'service.version': version,
      'thread.name': thread,
      ...pickTags(root.tags, DOMAIN_ATTRS),
    }
    : {
      'http.route': route,
      ...pickTags(failing.tags, CALL_ATTRS),
      'host.name': host,
      'service.version': version,
      'thread.name': thread,
    }

  return {
    rows,
    failing,
    sample: {
      traceId,
      spanId: failing.spanId,
      timeMs: ref.tMs,
      time: new Date(ref.tMs),
      host,
      version,
      service: spec.service,
      endpoint,
      spanName: spec.spanName,
      httpCode: spec.httpCode,
      durationMs: total,
      exception: x.type,
      message: x.message,
      stacktrace: exception.stacktrace,
      attributes,
    },
  }
}

/**
 * The span rows of the trace a sample id stands for — the same rows every
 * time — or null when the id is not one of these, which leaves every other id
 * to buildTrace's own lookup.
 */
export function errorTraceRows(traceId) {
  const ref = decodeTraceId(traceId)
  return ref ? buildErrorTrace(ref).rows : null
}

/**
 * The Traces page filter that finds a group's spans: whose, which side of the
 * call, failed, which endpoint, which span, which exception — and nothing the
 * group is not keyed on, so a coarser grouping's link does not drop errors it
 * counted.
 *
 * A Client row keyed on its endpoint links to that endpoint's failures only,
 * as the original's `endpoint=` link does: one Redis call is made by four
 * endpoints, and without it their four rows opened the same query, mostly onto
 * the other three's errors. On Server the span name already is the endpoint,
 * and a server span's root can be another service's request — payment-service
 * answering inside an order — so it is not repeated there.
 */
export function tracesFiltersFor(group) {
  const by = group.by ?? DEFAULT_BY
  const out = [
    { field: 'service', op: 'eq', value: group.service },
    { field: 'span_kind', op: 'eq', value: group.side },
    { field: 'status_code', op: 'eq', value: 'ERROR' },
  ]
  if (group.side === 'client' && by.includes('endpoint')) out.push({ field: 'root_name', op: 'eq', value: group.endpoint })
  if (by.includes('spanName')) out.push({ field: 'span_name', op: 'eq', value: group.spanName })
  if (by.includes('exception')) out.push({ field: 'exception.type', op: 'eq', value: group.exception })
  return out
}

const SPAN_ROWS_MEMO = new WeakMap()

/**
 * The spans the Traces page merges into its stream, so following any group to
 * Traces lands on rows rather than on an empty table: the first `perGroup` of
 * the drawer's samples of every group on both sides, one row each — the span
 * that recorded the exception. The rest of each trace is a click away on the
 * trace page. One a group is enough for every link to land, and already takes
 * a window's ERROR rows from about 6% of the stream to about 16%. That one is
 * the drawer's newest sample, however many samples the drawer asks for.
 */
export function errorSpanRowsForWindow(win, { perGroup = 1 } = {}) {
  let byN = SPAN_ROWS_MEMO.get(win)
  if (!byN) SPAN_ROWS_MEMO.set(win, (byN = new Map()))
  if (byN.has(perGroup)) return byN.get(perGroup)
  const out = []
  for (const side of ERROR_SIDES) {
    for (const group of groupErrorSeries(errorSeriesForWindow(win, side), win)) {
      for (const ref of sampleRefs(group, win, SAMPLE_N).slice(0, perGroup)) out.push(buildErrorTrace(ref).failing)
    }
  }
  out.sort((a, b) => b.time - a.time)
  byN.set(perGroup, out)
  return out
}
