/**
 * A trace, assembled for the inspect view.
 *
 * Spans are not generated here any more. The Traces explorer already holds real
 * span trees — parent ids, nested offsets, full attribute sets — and a waterfall
 * that disagreed with the table you clicked through from would be describing a
 * different request. So this reads those spans and shapes them for the view:
 * links parents to children, converts absolute timestamps into offsets into the
 * trace, and renders each span's attributes the way the inspect view spells them.
 *
 * A trace id that has no spans (a deep link from a log record, which carries an
 * id from a different seed) borrows the shape of a seeded trace and takes its
 * root service and operation from the record — so the link still lands on
 * *that record's* request rather than on a stand-in with someone else's name.
 */

import { spanRows } from './tracesExplorer'
import { logRows } from './observability'
import { valueOfConcept } from '@/utils/logFields'

const seedOf = (traceId) => {
  let h = 0
  for (let i = 0; i < traceId.length; i++) h = (h * 31 + traceId.charCodeAt(i)) | 0
  return Math.abs(h) || 7
}

/** The seeded log record that carries this trace id, if there is one. */
export function recordForTrace(traceId) {
  return logRows.find(r => valueOfConcept(r, 'traceId') === traceId) ?? null
}

// Spans grouped by trace, newest trace first — the order the explorer lists them.
const BY_TRACE = (() => {
  const m = new Map()
  for (const r of spanRows) {
    if (!m.has(r.traceId)) m.set(r.traceId, [])
    m.get(r.traceId).push(r)
  }
  return m
})()

const TRACE_IDS = [...BY_TRACE.keys()]

// Structural fields: they say where the span sits, not what happened in it, and
// the view already shows each of them in the meta block above the tag list.
const STRUCTURAL = new Set([
  'trace_id', 'span_id', 'parent_id', 'duration', 'span_name', 'service',
  'root_name', 'event.domain', 'event_name', 'exception.stacktrace',
])

const RESOURCE_PREFIX = '_resource.'

/**
 * A span's attributes as the inspect view spells them.
 *
 * Two differences from the span stream, both matching the product: the SDK's
 * resource block loses its `_resource.` prefix here (in the stream the prefix is
 * what marks it as agent boilerplate; in a single span there is nothing to
 * distinguish it from), and the orchestration attributes are present — an
 * inspect view answers "which pod served this", which the field list does not.
 */
function displayTags(span) {
  const out = {}
  for (const [k, v] of Object.entries(span.tags)) {
    if (v === '' || v == null || STRUCTURAL.has(k)) continue
    if (k === 'span_kind') { out['span.kind'] = v; continue }
    if (k === 'status_code') { out['otel.status_code'] = v; continue }
    out[k.startsWith(RESOURCE_PREFIX) ? k.slice(RESOURCE_PREFIX.length) : k] = String(v)
  }
  out.env = out['cube.environment'] ?? 'UNSET'
  const host = span.tags['host.name']
  if (host) {
    out['k8s.pod.name'] = host
    out['k8s.deployment.name'] = span.service
    out['k8s.namespace.name'] = 'cubedemo'
    out['k8s.node.name'] = 'ip-10-0-12-87.us-west-2.compute.internal'
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)))
}

function categoryOf(span) {
  const c = span.tags.category
  if (c === 'db') return 'db'
  if (c === 'http') return 'http'
  return 'internal'
}

/**
 * Orders spans depth-first from the root, so the list reads top to bottom the
 * way the call actually ran. Siblings go by start time; a span whose parent is
 * missing is attached to the root rather than dropped.
 */
function buildTree(rawSpans) {
  const byId = new Map(rawSpans.map(s => [s.spanId, s]))
  const roots = []
  const kids = new Map()
  for (const s of rawSpans) {
    const pid = s.tags.parent_id
    if (pid && byId.has(pid)) {
      if (!kids.has(pid)) kids.set(pid, [])
      kids.get(pid).push(s)
    } else {
      roots.push(s)
    }
  }
  const t0 = Math.min(...rawSpans.map(s => s.time.getTime()))
  const ordered = []
  const walk = (s, depth) => {
    const children = (kids.get(s.spanId) ?? []).sort((a, b) => a.time - b.time)
    const isError = s.statusCode === 'ERROR'
    ordered.push({
      id: s.spanId,
      parentId: s.tags.parent_id || null,
      depth,
      name: s.spanName,
      service: s.service,
      kind: s.spanKind,
      category: categoryOf(s),
      start: s.time.getTime() - t0,
      startTime: s.time,
      duration: s.durationNs / 1e6,
      status: isError ? 'error' : 'ok',
      httpStatus: s.tags['http.status_code'] ?? null,
      db: categoryOf(s) === 'db',
      exception: isError && s.tags['exception.type']
        ? { type: s.tags['exception.type'], message: s.tags['exception.message'] ?? '', stack: s.tags['exception.stacktrace'] ?? '' }
        : null,
      childIds: children.map(c => c.spanId),
      tags: displayTags(s),
    })
    for (const c of children) walk(c, depth + 1)
  }
  roots.sort((a, b) => a.time - b.time).forEach(r => walk(r, 0))
  return { ordered, t0 }
}

export function buildTrace(traceId) {
  if (!traceId) return null

  // Span events are points inside a span, not spans — they have no duration and
  // no place in a waterfall, so the tree is built from spans alone.
  let raw = (BY_TRACE.get(traceId) ?? []).filter(s => s.tags['event.domain'] === 'span')
  const origin = recordForTrace(traceId)
  let rename = null

  if (raw.length === 0) {
    // No spans under this id. Borrow a seeded trace's shape, deterministically,
    // and re-label its entry service so a link from a log record still lands on
    // a request that looks like the one the record came from.
    const borrowed = TRACE_IDS[seedOf(traceId) % TRACE_IDS.length]
    raw = (BY_TRACE.get(borrowed) ?? []).filter(s => s.tags['event.domain'] === 'span')
    if (raw.length === 0) return null
    const entry = raw.find(s => !s.tags.parent_id) ?? raw[0]
    const wantService = origin?.service
    if (wantService && wantService !== entry.service) {
      rename = { from: entry.service, to: wantService }
    }
  }

  if (rename) {
    raw = raw.map(s => s.service === rename.from
      ? { ...s, service: rename.to, tags: { ...s.tags, service: rename.to } }
      : s)
  }

  const { ordered, t0 } = buildTree(raw)
  if (ordered.length === 0) return null

  const root = ordered[0]
  const endMs = Math.max(...ordered.map(s => s.start + s.duration))

  return {
    traceId,
    root,
    spans: ordered,
    byId: Object.fromEntries(ordered.map(s => [s.id, s])),
    totalMs: Math.max(endMs, root.duration),
    failed: ordered.some(s => s.status === 'error'),
    origin,
    startTime: new Date(t0),
    services: [...new Set(ordered.map(s => s.service))],
    errors: ordered.filter(s => s.exception),
  }
}

/**
 * Rolled up by operation, the way the playground's Summary tab does — but keyed
 * on service AND operation, not operation alone.
 *
 * Two services in one trace routinely run the same operation name (every one of
 * them has a `…Controller.create`), and folding those together reports a single
 * row whose duration belongs to neither of them. The service comes off the
 * span's own service attribute rather than being read out of the operation
 * string, which only names a service by accident when the operation happens to
 * be an outbound URL.
 */
export function traceSummary(trace) {
  const byOp = new Map()
  for (const s of trace.spans) {
    if (s === trace.root) continue
    const key = `${s.service}\u0000${s.name}`
    const e = byOp.get(key) ?? { key, service: s.service, name: s.name, count: 0, duration: 0, db: !!s.db, slowestId: null, slowestMs: -1 }
    e.count++; e.duration += s.duration
    // A row can stand for a dozen spans, so clicking it has to pick one. The
    // slowest is the one the row got into the table for.
    if (s.duration > e.slowestMs) { e.slowestMs = s.duration; e.slowestId = s.id }
    byOp.set(key, e)
  }
  return [...byOp.values()]
    .map(e => ({ ...e, pct: trace.totalMs ? (e.duration / trace.totalMs) * 100 : 0 }))
    .sort((a, b) => b.duration - a.duration)
}

/**
 * Database calls rolled up by statement, matching the Database tab: one row per
 * distinct query with its total, average and slowest execution.
 */
export function traceDatabase(trace) {
  const byKey = new Map()
  for (const s of trace.spans) {
    if (!s.db) continue
    const query = s.tags['db.statement'] ?? s.name
    const system = s.tags['db.system'] ?? ''
    const name = s.tags['db.name'] ?? ''
    // Keyed on the caller as well as the statement, for the same reason the
    // summary is: two services issuing the same query are two different call
    // sites, and folding them together reports a total against whichever
    // service happened to be seen first.
    const key = `${s.service}|${system}|${name}|${query}`
    const e = byKey.get(key) ?? {
      key, query,
      service: s.service,
      database: name ? `${system}.${name}` : system,
      instance: [s.tags['net.peer.name'], s.tags['net.peer.port']].filter(Boolean).join(':'),
      count: 0, total: 0, max: 0, slowestId: null,
    }
    e.count++
    e.total += s.duration
    if (s.duration > e.max) e.slowestId = s.id
    e.max = Math.max(e.max, s.duration)
    byKey.set(key, e)
  }
  return [...byKey.values()]
    .map(e => ({ ...e, avg: e.total / e.count }))
    .sort((a, b) => b.total - a.total)
}

/* ---- profiles ----
 *
 * A continuous profiler samples a process on a fixed period and cuts the
 * samples into windows on a wall-clock boundary. A profile record is therefore
 * a window on a host, not a slice of a trace — the window is tens of seconds
 * wide and a trace is a few hundred milliseconds inside it. That mismatch is
 * the whole reason the tab carries a "narrow to selected span" control.
 *
 * The rollup is by function rather than by record because the question the tab
 * answers is "what was the CPU doing while this ran", and a list of windows
 * does not answer it. Attribution is by SELF time: a parent's wall time is
 * mostly its children's, and charging the parent's frames for it would report
 * the caller as hot every time a callee was.
 *
 * Sampling also means a short span can legitimately come back with nothing.
 * That is reported as an empty result rather than smoothed over with samples
 * borrowed from its neighbours, which would be an invented reading.
 */

const PROFILE_HZ = 100            // async-profiler's usual default: one sample per 10ms
const PROFILE_WINDOW_MS = 10_000  // records are cut on a fixed ten-second boundary

const JVM_FRAMES = [
  'java.net.SocketInputStream.socketRead0',
  'jdk.internal.misc.Unsafe.park',
  'org.postgresql.core.PGStream.receiveChar',
  'com.zaxxer.hikari.pool.HikariPool.getConnection',
  'com.fasterxml.jackson.databind.ObjectMapper.writeValueAsString',
  'java.util.HashMap.resize',
  'java.lang.StringBuilder.append',
  'io.netty.channel.nio.NioEventLoop.processSelectedKeys',
  'org.apache.tomcat.util.net.NioEndpoint$Poller.run',
  'java.util.regex.Pattern$Loop.match',
  'java.util.zip.Inflater.inflateBytes',
  'org.hibernate.engine.internal.StatefulPersistenceContext.getEntity',
]

const NODE_FRAMES = [
  'net.Socket._writeGeneric',
  'JSON.stringify',
  'Buffer.concat',
  'crypto.createHash',
  'async_hooks.emitInitScript',
  'zlib.gzipSync',
  'v8.serialize',
  'Module._compile',
]

/** Samples land in descending order, the way a real top-frames list reads. */
const FRAME_WEIGHTS = [0.31, 0.22, 0.17, 0.13, 0.1, 0.07]

const framesFor = (lang) => (lang === 'nodejs' || lang === 'js' ? NODE_FRAMES : JVM_FRAMES)

const HTTP_METHOD = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+/i
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1)

/**
 * The frame a span's own time would be charged to.
 *
 * Which frame that is depends on what the span was doing, not on how its name
 * is spelled. A client span spends its self time inside a driver or an HTTP
 * client, never in the caller's code, so naming it after the caller's class
 * would put the app at the top of a list it is absent from. Only server and
 * internal spans run the application's own frames.
 */
function appFrame(service, span) {
  if (span.kind === 'client' || span.kind === 'producer') {
    return span.db
      ? 'org.postgresql.jdbc.PgStatement.executeInternal'
      : 'okhttp3.internal.connection.RealCall.execute'
  }

  const pkg = service.replace(/-service$|^cubedemo-/, '').replace(/[^a-z0-9]/gi, '') || 'app'
  const op = span.name

  const http = op.match(HTTP_METHOD)
  if (http) {
    // The route names the handler: /v1/cart is served by a CartController.
    // Version prefixes and path parameters name nothing, so they are skipped.
    const seg = op.slice(http[0].length)
      .split(/[/?]/)
      .filter(s => s && !s.startsWith('<') && !s.startsWith('{') && !/^v\d+$/i.test(s))
      .pop() || 'root'
    return `com.cubedemo.${pkg}.${cap(seg.replace(/[^a-z0-9]/gi, ''))}Controller.${http[1].toLowerCase()}`
  }

  const dot = op.lastIndexOf('.')
  if (dot > 0) return `com.cubedemo.${pkg}.${cap(op.slice(0, dot))}.${op.slice(dot + 1)}`
  return `com.cubedemo.${pkg}.${op.replace(/[^a-z0-9]/gi, '') || 'handleRequest'}`
}

/**
 * Profile records overlapping the trace, rolled up to the functions that were
 * on CPU. Pass a span id to narrow to that span's own window.
 *
 * Not rendered yet: the Profiles tab shows its empty state because nothing in
 * this build produces profile records. Kept because it is the rollup that tab
 * needs the moment one does.
 */
export function traceProfiles(trace, spanId = null) {
  const focus = spanId ? trace.byId[spanId] : null
  const scope = spanId ? (focus ? [focus] : []) : trace.spans

  const selfMs = (s) => {
    const kids = s.childIds.reduce((t, id) => t + (trace.byId[id]?.duration ?? 0), 0)
    return Math.max(s.duration - kids, 0)
  }

  const byService = new Map()
  for (const s of scope) {
    const ms = selfMs(s)
    if (ms <= 0) continue
    const e = byService.get(s.service) ?? {
      service: s.service,
      host: s.tags['host.name'] ?? 'unknown',
      lang: s.tags['telemetry.sdk.language'] ?? 'java',
      ms: 0, hot: s, hotMs: -1,
    }
    e.ms += ms
    if (ms > e.hotMs) { e.hotMs = ms; e.hot = s }
    byService.set(s.service, e)
  }

  const windowStart = new Date(Math.floor(trace.startTime.getTime() / PROFILE_WINDOW_MS) * PROFILE_WINDOW_MS)
  const windowEnd = new Date(windowStart.getTime() + PROFILE_WINDOW_MS)

  const records = [...byService.values()].map(e => ({
    key: `${e.service}|${e.host}`,
    service: e.service,
    host: e.host,
    type: 'cpu',
  }))

  const frames = []
  for (const e of byService.values()) {
    const pool = framesFor(e.lang)
    const seed = seedOf(`${trace.traceId}${e.service}`)
    const names = [appFrame(e.service, e.hot)]
    for (let i = 0; i < FRAME_WEIGHTS.length - 1; i++) {
      names.push(pool[(seed + i * 5) % pool.length])
    }
    names.forEach((fn, i) => {
      const ms = e.ms * FRAME_WEIGHTS[i]
      const samples = Math.round((ms / 1000) * PROFILE_HZ)
      // A frame the sampler never caught is not a frame that ran for zero
      // milliseconds — it is one this window has nothing to say about.
      if (samples < 1) return
      frames.push({ key: `${e.service}|${fn}`, fn, service: e.service, selfMs: ms, samples })
    })
  }

  // The share is taken from time rather than from the sample count. Over a few
  // hundred milliseconds the counts are single digits, and a percentage off a
  // rounded integer reports four different frames as an identical 25%.
  const totalMs = frames.reduce((t, f) => t + f.selfMs, 0)
  return {
    records,
    windowStart,
    windowEnd,
    windowMs: PROFILE_WINDOW_MS,
    hz: PROFILE_HZ,
    totalSamples: frames.reduce((t, f) => t + f.samples, 0),
    frames: frames
      .map(f => ({ ...f, pct: totalMs ? (f.selfMs / totalMs) * 100 : 0 }))
      .sort((a, b) => b.selfMs - a.selfMs),
  }
}
