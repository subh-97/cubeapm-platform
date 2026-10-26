// Rules no profile describes — a query typed in Code, an Advanced model over
// some other metric, anything built on Logs or Traces — evaluated by the
// engines Explore runs (docs/alerts/DESIGN.md D15).
//
// alerts.js binds the seeded rules and every Quick model to the incident
// profiles, which is what keeps them calibrated to the published figures.
// Anything else has no profile, so it is read the way production reads it: the
// rule's query, run by the query engine at each evaluation. Explore's engines
// are that engine here — the same metrics store and the same sampled log and
// span rows its charts draw — so a rule made from a Logs query fires where the
// Logs page shows the spike.
//
// Every reading comes from one place whichever window asked for it. The engine
// runs over fixed, epoch-aligned chunks on the rule's own schedule, and each
// reading is a pure function of the query and its instant: PromQL evaluates
// every step on its own, and the event store samples per bucket from the
// bucket's start. So the editor's preview, which asks for one window, and the
// saved rule's history, which asks for eight days, read the same number at
// every tick — and the eight days cost little once the preview has run.

import { parsePromql, evaluateRange } from '@/utils/explore/promql'
import * as metricsStore from '@/data/explore/metricsStore'
import { parseLogsql, evaluateStatsRange } from '@/utils/explore/logsql'
import { eventsFor } from '@/data/explore/eventsStore'

const LOGS_FAMILY = new Set(['vlogs', 'traces', 'mobile'])
const CHUNK_SEC = 6 * 3600
const MAX_CHUNKS = 400

// Production's banner text, for a query an APM chart handed over with its
// downsampling placeholders still in it (reference §6.3).
export const UNSUPPORTED_VARIABLES = 'The query contains variables that are not supported in alerts.'
// What a log or span rule needs and production never says (R31).
export const NEEDS_CLOSING_PIPE = 'A Logs or Traces rule needs its query to end in a stats or math pipe, such as | stats count().'

const pipeName = p => String(p?.type ?? p?.name ?? p?.pipe ?? p?.kind ?? '').toLowerCase()

/** The labels a series is told apart by, as alerts.js spells its keys. */
export function seriesKeyOf(labels) {
  return Object.keys(labels).sort().map(k => `${k}=${labels[k]}`).join(',')
}

// A chunk is a whole number of evaluation steps, so every chunk starts on the
// rule's grid and the grid never shifts between one chunk and the next.
const chunkSecFor = every => Math.ceil(CHUNK_SEC / every) * every

/**
 * Why a query cannot be evaluated as written, or null. Parsing errors come
 * back in the engine's own words, the way production shows a rule's
 * `lastError`.
 */
export function queryProblem(datasource, query) {
  const q = String(query ?? '').trim()
  if (!q) return 'The rule has no query.'
  if (q.includes('$__')) return UNSUPPORTED_VARIABLES
  try {
    if (LOGS_FAMILY.has(datasource)) {
      if (datasource === 'mobile') return 'Mobile alerts aren\'t available yet.'
      const pipes = parseLogsql(q)?.pipes ?? []
      if (!pipes.some(p => pipeName(p) === 'stats' || pipeName(p) === 'math')) return NEEDS_CLOSING_PIPE
    } else {
      parsePromql(q)
    }
  } catch (err) {
    return String(err?.message ?? err)
  }
  return null
}

const cache = new Map()

// One chunk of readings: series key → { labels, values: Map(t → value) }.
// A log or span count read at t covers the step that ENDS at t, as an alert
// evaluated at t counts what arrived since the last evaluation.
function chunkOf(datasource, query, every, start) {
  const key = `${datasource}|${every}|${start}|${query}`
  if (cache.has(key)) return cache.get(key)
  const end = start + chunkSecFor(every)
  const out = new Map()
  const put = (metric, t, y) => {
    const v = typeof y === 'number' ? y : parseFloat(y)
    if (!Number.isFinite(v)) return
    const { __name__: _name, ...labels } = metric ?? {}
    const k = seriesKeyOf(labels)
    let s = out.get(k)
    if (!s) out.set(k, (s = { labels, values: new Map() }))
    s.values.set(t, v)
  }
  if (LOGS_FAMILY.has(datasource)) {
    const parsed = parseLogsql(query)
    const from = start - every
    const to = end - every
    const rows = eventsFor(datasource, { start: from, end: to, step: every })
    for (const s of evaluateStatsRange(parsed, rows, { start: from, end: to, step: every })) {
      for (const p of s.values) {
        const at = Array.isArray(p) ? p[0] : p.x / 1000
        put(s.metric, at + every, Array.isArray(p) ? p[1] : p.y)
      }
    }
  } else {
    const ast = parsePromql(query)
    for (const s of evaluateRange(ast, { start, end: end - every, step: every, store: metricsStore })) {
      for (const [t, y] of s.values) put(s.metric, t, y)
    }
  }
  if (cache.size >= MAX_CHUNKS) cache.delete(cache.keys().next().value)
  cache.set(key, out)
  return out
}

/**
 * A rule bound to the engine over [from, to]: `{ series }` in alerts.js's
 * shape — `{ key, labels, valueAt }` — or `{ error }` when the query cannot be
 * evaluated. A series is any label set the engine returns anywhere in the
 * span; `valueAt` reads any instant, inside the span or not, from the same
 * chunks.
 *
 * @param {{datasource:string, query:string, interval?:number}} rule  its base
 *   query (no condition), and its evaluation interval in seconds
 * @param {{from:number, to:number}} span  unix seconds
 */
export function engineBinding({ datasource, query, interval }, { from, to }) {
  const problem = queryProblem(datasource, query)
  if (problem) return { error: problem }
  const every = Math.max(15, Number(interval) || 60)
  const size = chunkSecFor(every)
  const q = String(query).trim()
  const read = t => chunkOf(datasource, q, every, Math.floor(t / size) * size)
  const found = new Map()
  try {
    for (let c = Math.floor(from / size) * size; c <= to; c += size) {
      for (const [k, s] of read(c)) if (!found.has(k)) found.set(k, s.labels)
    }
  } catch (err) {
    return { error: String(err?.message ?? err) }
  }
  return {
    series: [...found].map(([key, labels]) => ({
      key,
      labels,
      valueAt: (t) => {
        const at = Math.floor(t / every) * every
        try {
          return read(at).get(key)?.values.get(at) ?? null
        } catch {
          return null
        }
      },
    })),
  }
}

/** How many chunks have been computed — for tests that hold startup cost down. */
export const engineCacheSize = () => cache.size

/** Forget every computed chunk — for tests that move the clock. */
export function clearEngineCache() {
  cache.clear()
}
