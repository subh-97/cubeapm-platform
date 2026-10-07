// The Explore "backend": the only thing the UI calls for data (ARCH C5).
//
// There is no server behind this repo, so the metrics TSDB, the logs/traces
// store and their query languages run in the browser (../../data/explore,
// ./promql, ./logsql). This module is the seam between them and the page, and
// it behaves like the reference's HTTP layer so the page can be written as if
// against the real thing:
//   - async, with a simulated latency that is deterministic per request, so a
//     loading state is visible and a refresh looks like a refresh;
//   - the reference's client-side macro substitution runs first;
//   - server rules and server error texts, surfaced as ExploreQueryError, whose
//     message the page shows as `Failed to fetch data: ${message}`;
//   - every call honours an AbortSignal, so a superseded run can be dropped.
// Swapping in real endpoints later means rewriting the bodies here, not the page.

import { parsePromql, evaluateRange, evaluateInstant, PromqlError } from '@/utils/explore/promql'
import * as metricsStore from '@/data/explore/metricsStore'
import { parseLogsql, evaluateStatsRange, evaluateStatsInstant, LogsqlError } from '@/utils/explore/logsql'
import {
  eventsFor, getField, LOG_FIELDS, TRACE_FIELDS, LOG_STREAM_FIELDS, TRACE_STREAM_FIELDS,
} from '@/data/explore/eventsStore'
import { reduceValues } from './format.js'
import { stepForSpan } from '@/utils/timeRange.js'

export class ExploreQueryError extends Error {
  constructor(message, { status } = {}) {
    super(message)
    this.name = 'ExploreQueryError'
    this.status = status
  }
}

// ---------- Limits (ARCH C6) ----------

export const MAX_SERIES = 2000
export const MAX_POINTS = 11000

// ---------- Simulated latency ----------

const QUERY_LATENCY = [180, 420]
const META_LATENCY = [60, 140]
let latencyScale = 1

/** Scales every simulated delay (0 turns it off — tests do this). Returns the previous scale. */
export function setSimulatedLatency(scale) {
  const prev = latencyScale
  latencyScale = Math.max(0, Number(scale) || 0)
  return prev
}

// FNV-1a: the same request always takes the same time, so repeated runs of a
// query do not jitter while different queries still feel different.
function hash(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

function latencyFor(key, [lo, hi]) {
  return (lo + (hash(key) % (hi - lo + 1))) * latencyScale
}

function abortError() {
  return new DOMException('The operation was aborted.', 'AbortError')
}

function wait(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortError())
  if (!ms) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(t); reject(abortError()) }
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

// Waits, then computes. Computing after the wait means an aborted run never
// pays for the evaluation it no longer wants.
async function respond(key, range, signal, compute) {
  await wait(latencyFor(key, range), signal)
  if (signal?.aborted) throw abortError()
  return compute()
}

// ---------- Macros (reference Co / ZN, results-area §3.4) ----------

const CUBE_APM_MACRO = /\$__cube_apm_(calls_total|latency_count|latency_sum|latency_total|latency_bucket|errors_total|frontend_pageload_calls_total|frontend_pageload_duration_total|frontend_pageload_duration_sum|frontend_pageload_duration_bucket|frontend_pageload_duration_count|frontend_ajax_calls_total|frontend_ajax_duration_total|frontend_errors_total|frontend_webvitals_inp_sum|frontend_webvitals_inp_bucket|frontend_webvitals_inp_count|frontend_webvitals_lcp_sum|frontend_webvitals_lcp_bucket|frontend_webvitals_lcp_count|frontend_webvitals_cls_sum|frontend_webvitals_cls_bucket|frontend_webvitals_cls_count)/g

// At a step of 15 minutes or more the macros switch to the 15-minute rollups,
// which is what keeps a 7-day query cheap. Names with a histogram suffix put
// the rollup before it (`cube_apm_latency:increase15m_bucket`).
function rollupName(name) {
  const m = /^(latency|frontend_pageload_duration|frontend_webvitals_(?:inp|lcp|cls))_(count|sum|bucket)$/.exec(name)
  return m ? `cube_apm_${m[1]}:increase15m_${m[2]}` : `cube_apm_${name}:increase15m`
}

/**
 * The reference's client-side substitution, in its order (`$__range_s` before
 * `$__range`). Blind text replacement, inside strings too, and for LogsQL as
 * well as PromQL — as in the reference.
 */
export function substituteMacros(query, { start, end, step }) {
  const hot = step >= 900
  return String(query ?? '')
    .replaceAll('$__range_s', `${end - start}s`)
    .replaceAll('$__range', `${end - start}`)
    .replaceAll('$__step', `${step}`)
    .replaceAll('$__increase', hot ? 'sum_over_time' : 'increase')
    .replaceAll('$__default_0', hot ? '' : 'default 0')
    .replace(CUBE_APM_MACRO, (_, name) => (hot ? rollupName(name) : `cube_apm_${name}`))
}

// ---------- Shared helpers ----------

const isLogs = (ds) => ds === 'vlogs' || ds === 'traces'

function requireQuery(query) {
  if (!query || !String(query).trim()) throw new ExploreQueryError('query cannot be empty', { status: 422 })
}

function checkWindow(start, end, step) {
  if (![start, end, step].every(Number.isFinite) || step <= 0 || end < start) {
    throw new ExploreQueryError(`invalid time range: start=${start}, end=${end}, step=${step}`, { status: 400 })
  }
  const points = Math.floor((end - start) / step) + 1
  if (points > MAX_POINTS) {
    throw new ExploreQueryError(
      `too many points for the given step=${step}s, start=${start} and end=${end}: ${points}; cap on the number of points: ${MAX_POINTS}`,
      { status: 422 },
    )
  }
}

function checkSeriesCount(n) {
  if (n > MAX_SERIES) {
    throw new ExploreQueryError(
      `too many series: the query matches ${n} series, more than the limit of ${MAX_SERIES}; narrow it down with label filters`,
      { status: 422 },
    )
  }
}

const isEngineError = (err, Cls, name) => (typeof Cls === 'function' && err instanceof Cls) || err?.name === name

// A value pair from either engine: PromQL's [tsSec, value] or LogsQL's { x: ms, y }.
function toPoint(v) {
  if (Array.isArray(v)) return { x: v[0] * 1000, y: typeof v[1] === 'number' ? v[1] : parseFloat(v[1]) }
  return { x: v.x, y: typeof v.y === 'number' ? v.y : parseFloat(v.y) }
}

// NaN and ±Inf are dropped, exactly as the reference client does before it
// reduces or draws anything.
function toSeries(result) {
  checkSeriesCount(result.length)
  return result.map(s => ({
    metric: { ...s.metric },
    values: (s.values || []).map(toPoint).filter(p => Number.isFinite(p.y)),
  }))
}

// Highest value first, NaN last. The reference's plain `b - a` leaves NaN
// wherever the sort happens to put it, which reorders rows between runs.
function byValueDesc(a, b) {
  const an = Number.isNaN(a.value)
  const bn = Number.isNaN(b.value)
  if (an || bn) return an === bn ? 0 : an ? 1 : -1
  return a.value === b.value ? 0 : b.value - a.value
}

// Instant results keep NaN — the CSV writes it as "NaN", as the reference does.
function toInstant(result) {
  checkSeriesCount(result.length)
  return result.map(s => {
    const raw = Array.isArray(s.value) ? s.value[1] : s.value
    return { metric: { ...s.metric }, value: typeof raw === 'number' ? raw : parseFloat(raw) }
  }).sort(byValueDesc)
}

// ---------- Metrics ----------

function metricsError(err, prefix) {
  if (err instanceof ExploreQueryError) return err
  if (isEngineError(err, PromqlError, 'PromqlError')) return new ExploreQueryError(`${prefix}: ${err.message}`, { status: 422 })
  return new ExploreQueryError(`${prefix}: ${err?.message || err}`, { status: 500 })
}

// VictoriaMetrics quotes the query Go-style (%q); JSON quoting is the same
// for everything a query contains.
const quoted = (q) => JSON.stringify(q)

function promRange(q, start, end, step) {
  const prefix = `error when executing query=${quoted(q)} on the time range (start=${start * 1000}, end=${end * 1000}, step=${step * 1000})`
  try {
    const ast = parsePromql(q)
    return toSeries(evaluateRange(ast, { start, end, step, store: metricsStore }))
  } catch (err) {
    throw metricsError(err, prefix)
  }
}

function promInstant(q, time, step) {
  const prefix = `error when executing query=${quoted(q)} for (time=${time * 1000}, step=${step * 1000})`
  try {
    const ast = parsePromql(q)
    return toInstant(evaluateInstant(ast, { time, step, store: metricsStore }))
  } catch (err) {
    throw metricsError(err, prefix)
  }
}

// ---------- Logs / traces (VictoriaLogs stats_query[_range] semantics) ----------

// The parser's pipe objects name themselves; read whichever key it uses.
const pipeName = (p) => String(p?.type ?? p?.name ?? p?.pipe ?? p?.kind ?? '').toLowerCase()
const pipeText = (p, q) => {
  if (typeof p?.text === 'string') return p.text
  if (typeof p?.raw === 'string') return p.raw
  if (Number.isFinite(p?.start) && Number.isFinite(p?.end)) return q.slice(p.start, p.end).replace(/^\s*\|\s*/, '').trim()
  return pipeName(p)
}

// VictoriaLogs prints its time filter at nanosecond precision, end exclusive.
function timeFilter(startSec, endSec) {
  const iso = (ms) => new Date(ms).toISOString().replace(/\.(\d{3})Z$/, '.$1000000Z')
  const endIso = new Date((endSec - 1) * 1000).toISOString().replace(/\.\d{3}Z$/, '.999999999Z')
  return `_time:[${iso(startSec * 1000)},${endIso}]`
}

// Pipes that may reorder, drop or cap rows break the step bucketing when they
// come before `stats`; `limit`/`top` after it would cut buckets, not series.
const BEFORE_STATS_FORBIDDEN = new Set(['sort', 'limit', 'head', 'offset', 'fields', 'top', 'uniq', 'first', 'last'])
const AFTER_STATS_FORBIDDEN = new Set(['limit', 'head', 'top'])

// The server rules a stats query must pass (logs-traces-code-and-execution
// §8.4), with the reference's error texts.
function checkStatsRules(parsed, q, startSec, endSec) {
  const pipes = parsed?.pipes || []
  const statsAt = pipes.findIndex(p => pipeName(p) === 'stats')
  if (statsAt === -1) {
    throw new ExploreQueryError(`missing \`| stats ...\` pipe in the query [${timeFilter(startSec, endSec)} ${q.trim()}]`, { status: 422 })
  }
  const stats = pipeText(pipes[statsAt], q)
  pipes.slice(0, statsAt).forEach(p => {
    if (BEFORE_STATS_FORBIDDEN.has(pipeName(p))) {
      throw new ExploreQueryError(
        `the pipe \`| ${JSON.stringify(pipeText(p, q))}\` cannot be put in front of \`| ${JSON.stringify(stats)}\`, since it may modify or delete \`_time\` field`,
        { status: 422 },
      )
    }
  })
  pipes.slice(statsAt + 1).forEach(p => {
    if (AFTER_STATS_FORBIDDEN.has(pipeName(p))) {
      throw new ExploreQueryError(
        `the ${JSON.stringify(pipeText(p, q))} pipe cannot be put after ${JSON.stringify(stats)} pipe in the query [${timeFilter(startSec, endSec)} ${q.trim()}]`,
        { status: 422 },
      )
    }
  })
}

function logsError(err) {
  if (err instanceof ExploreQueryError) return err
  if (isEngineError(err, LogsqlError, 'LogsqlError')) return new ExploreQueryError(err.message, { status: 422 })
  return new ExploreQueryError(`${err?.message || err}`, { status: 500 })
}

function logsRange(datasource, q, start, end, step) {
  try {
    const parsed = parseLogsql(q)
    checkStatsRules(parsed, q, start, end)
    const rows = eventsFor(datasource, { start, end, step })
    return toSeries(evaluateStatsRange(parsed, rows, { start, end, step }))
  } catch (err) {
    throw logsError(err)
  }
}

// "latest" for logs is the server's instant stats over the LAST STEP only, so
// a group with no hits in that step is missing — reference behaviour.
function logsInstant(datasource, q, time, step) {
  try {
    const parsed = parseLogsql(q)
    checkStatsRules(parsed, q, time - step, time)
    const rows = eventsFor(datasource, { start: time - step, end: time, step })
    return toInstant(evaluateStatsInstant(parsed, rows, { time, step }))
  } catch (err) {
    throw logsError(err)
  }
}

// ---------- Queries ----------

/**
 * A range query, as the chart runs it.
 *
 * @param {{ datasource:'prometheus'|'vlogs'|'traces', query:string, start:number, end:number, step:number, signal?:AbortSignal }} args
 *   start/end/step in unix seconds, already aligned (timeRange.resolveRange)
 * @returns {Promise<{ series: Array<{ metric:object, values:Array<{x:number,y:number}> }> }>}
 *   x in ms; NaN/±Inf dropped; series in the order the engine returns them
 */
export async function queryRange({ datasource, query, start, end, step, signal }) {
  const key = `range|${datasource}|${query}|${start}|${end}|${step}`
  return respond(key, QUERY_LATENCY, signal, () => {
    requireQuery(query)
    checkWindow(start, end, step)
    const q = substituteMacros(query, { start, end, step })
    const series = isLogs(datasource) ? logsRange(datasource, q, start, end, step) : promRange(q, start, end, step)
    return { series }
  })
}

/**
 * An instant query at `time` (what "latest" uses in the table and CSV).
 * Macros resolve against [start, time] when the page's window start is given
 * — the reference substitutes with the whole window even for its instant
 * call, so `[$__range_s]` means the same thing in the table as on the chart —
 * and against the last step otherwise.
 *
 * @returns {Promise<{ series: Array<{ metric:object, value:number }> }>} highest value first
 */
export async function queryInstant({ datasource, query, time, step, start, signal }) {
  const key = `instant|${datasource}|${query}|${time}|${step}|${start}`
  return respond(key, QUERY_LATENCY, signal, () => {
    requireQuery(query)
    checkWindow(time - step, time, step)
    const from = Number.isFinite(start) && start < time ? start : time - step
    const q = substituteMacros(query, { start: from, end: time, step })
    const series = isLogs(datasource) ? logsInstant(datasource, q, time, step) : promInstant(q, time, step)
    return { series }
  })
}

/**
 * One value per series under a Legend value — reference `ZN`, which the table
 * and CSV both use. "latest" is an instant query at the window's end; average
 * and sum reduce the range query's points.
 *
 * @returns {Promise<{ series: Array<{ metric:object, value:number, values:Array<{x:number,y:number}> }> }>}
 *   highest value first; `values` is empty for "latest"
 */
export async function queryReduced({ datasource, query, start, end, step, formula, signal }) {
  if (formula === 'last') {
    const { series } = await queryInstant({ datasource, query, time: end, step, start, signal })
    return { series: series.map(s => ({ ...s, values: [] })) }
  }
  if (formula !== 'avg' && formula !== 'sum') throw new ExploreQueryError('Unsupported formula', { status: 400 })
  const { series } = await queryRange({ datasource, query, start, end, step, signal })
  return { series: series.map(s => ({ ...s, value: reduceValues(s.values, formula) })).sort(byValueDesc) }
}

// ---------- Metrics metadata ----------

function metaCall(fn) {
  try {
    return fn()
  } catch (err) {
    if (err instanceof ExploreQueryError) throw err
    throw new ExploreQueryError(`${err?.message || err}`, { status: isEngineError(err, PromqlError, 'PromqlError') ? 400 : 500 })
  }
}

/** Every metric name (the FROM list and Code autocomplete). */
export async function metricNames({ start, end, signal } = {}) {
  return respond(`names|${start}|${end}`, META_LATENCY, signal, () => metaCall(() => metricsStore.listMetricNames()))
}

/** Label names of the series `match` selects (all series when empty), `__name__` included. */
export async function metricLabelNames({ match = [], start, end, signal } = {}) {
  return respond(`labels|${match.join(',')}|${start}|${end}`, META_LATENCY, signal,
    () => metaCall(() => metricsStore.labelNames(match, { start, end })))
}

/** Distinct values of `label` over the series `match` selects. No label, no values. */
export async function metricLabelValues({ label, match = [], start, end, signal } = {}) {
  return respond(`values|${label}|${match.join(',')}|${start}|${end}`, META_LATENCY, signal, () => {
    // The reference sends `label/undefined/values` here; there is nothing to ask.
    if (!label) return []
    return metaCall(() => metricsStore.labelValues(label, match, { start, end }))
  })
}

// ---------- Logs / traces metadata ----------
//
// Derived from the same rows a query would read (ARCH C9), over the requested
// window and narrowed by `query` — a filter such as `{"service"="order"}
// log.level:="error"`, the way the Builder narrows each row's options by the
// rows above it.

const CHUNK = 1000
const ROW_KEY = '__ex_row'

// Rows a filter query keeps. The filter is evaluated by the LogsQL engine
// itself — as a stats query grouped by a per-row key — so a narrowed option
// list can never disagree with what running the query would count. Chunked
// to stay clear of any per-result series cap.
function matchingRows(datasource, query, start, end) {
  // Sampled at the step a chart of this window would use: the store samples
  // a fixed number of rows per bucket, so one window-wide bucket would leave
  // too few rows to list the rarer values.
  const rows = eventsFor(datasource, { start, end, step: stepForSpan(end - start) })
  const q = String(query ?? '').trim()
  if (!q || q === '*') return rows
  let parsed
  try {
    parsed = parseLogsql(`${q} | stats by (${ROW_KEY}) count() as hits`)
  } catch (err) {
    throw logsError(err)
  }
  const keep = new Set()
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK).map((r, j) => ({ ...r, [ROW_KEY]: String(i + j) }))
    let result
    try {
      result = evaluateStatsRange(parsed, chunk, { start, end: Math.max(end, start + 1), step: Math.max(end - start, 1) })
    } catch (err) {
      throw logsError(err)
    }
    for (const s of result) {
      const idx = Number(s.metric?.[ROW_KEY])
      if (s.metric?.[ROW_KEY] !== '' && Number.isInteger(idx)) keep.add(idx)
    }
  }
  return rows.filter((_, i) => keep.has(i))
}

const weightOf = (row) => (Number.isFinite(row?._weight) ? row._weight : 1)
const isEmpty = (v) => v === undefined || v === null || v === ''
const cellText = (v) => (isEmpty(v) ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v))

function catalogFor(datasource) {
  return datasource === 'traces'
    ? { fields: TRACE_FIELDS, stream: TRACE_STREAM_FIELDS }
    : { fields: LOG_FIELDS, stream: LOG_STREAM_FIELDS }
}

const fieldKey = (f) => (typeof f === 'string' ? f : f?.field)

// The row's stream as an object — `_stream` itself when the store keeps one,
// otherwise the stream fields read off the row.
function streamOf(row, streamFields) {
  if (row?._stream && typeof row._stream === 'object') return row._stream
  const out = {}
  for (const f of streamFields || []) {
    const k = fieldKey(f)
    const v = getField(row, k)
    if (!isEmpty(v)) out[k] = v
  }
  return out
}

function tally(entries, limit) {
  const sorted = [...entries].map(([value, hits]) => ({ value, hits: Math.round(hits) }))
    .sort((a, b) => b.hits - a.hits || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0))
  return limit > 0 ? sorted.slice(0, limit) : sorted
}

function byName(entries) {
  return [...entries].filter(([, hits]) => hits > 0).map(([value, hits]) => ({ value, hits: Math.round(hits) }))
    .sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0))
}

// Internal row bookkeeping, never a field anyone can query.
const INTERNAL = new Set(['_weight', ROW_KEY])

/** Field names with hits (sorted by name). `_msg`, `_stream`, `_time` included, as the server lists them. */
export async function logFieldNames({ datasource, query = '*', start, end, signal } = {}) {
  return respond(`fnames|${datasource}|${query}|${start}|${end}`, META_LATENCY, signal, () => {
    const rows = matchingRows(datasource, query, start, end)
    const { fields } = catalogFor(datasource)
    const names = new Set(['_msg', '_stream', '_time', ...(fields || []).map(fieldKey)])
    // Flat keys the catalog does not list are still fields of the row.
    for (const r of rows) for (const k of Object.keys(r)) if (!INTERNAL.has(k) && typeof r[k] !== 'object') names.add(k)
    const hits = new Map()
    for (const r of rows) {
      const w = weightOf(r)
      for (const n of names) {
        if (INTERNAL.has(n)) continue
        const v = n === '_stream' ? r._stream : getField(r, n)
        if (!isEmpty(v)) hits.set(n, (hits.get(n) || 0) + w)
      }
    }
    return byName(hits)
  })
}

/** Values of `field` by hits, highest first. "" counts the rows that lack the field, as the server reports. */
export async function logFieldValues({ datasource, field, query = '*', start, end, limit = 100, signal } = {}) {
  return respond(`fvalues|${datasource}|${field}|${query}|${start}|${end}|${limit}`, META_LATENCY, signal, () => {
    if (!field) return []
    const rows = matchingRows(datasource, query, start, end)
    const hits = new Map()
    for (const r of rows) {
      const v = cellText(field === '_stream' ? r._stream : getField(r, field))
      hits.set(v, (hits.get(v) || 0) + weightOf(r))
    }
    return tally(hits, limit)
  })
}

/** Stream field names with hits (sorted by name). */
export async function logStreamFieldNames({ datasource, query = '*', start, end, signal } = {}) {
  return respond(`snames|${datasource}|${query}|${start}|${end}`, META_LATENCY, signal, () => {
    const rows = matchingRows(datasource, query, start, end)
    const { stream } = catalogFor(datasource)
    const hits = new Map()
    for (const r of rows) {
      const w = weightOf(r)
      for (const [k, v] of Object.entries(streamOf(r, stream))) if (!isEmpty(v)) hits.set(k, (hits.get(k) || 0) + w)
    }
    return byName(hits)
  })
}

/** Values of stream field `field` by hits, highest first. */
export async function logStreamFieldValues({ datasource, field, query = '*', start, end, limit = 100, signal } = {}) {
  return respond(`svalues|${datasource}|${field}|${query}|${start}|${end}|${limit}`, META_LATENCY, signal, () => {
    if (!field) return []
    const rows = matchingRows(datasource, query, start, end)
    const { stream } = catalogFor(datasource)
    const hits = new Map()
    for (const r of rows) {
      const v = streamOf(r, stream)[field]
      if (!isEmpty(v)) hits.set(cellText(v), (hits.get(cellText(v)) || 0) + weightOf(r))
    }
    return tally(hits, limit)
  })
}
