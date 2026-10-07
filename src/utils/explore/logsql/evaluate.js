// Running a parsed LogsQL query over the rows the events store hands back.
//
// Four facts set the shape of everything below.
//
//  1. The rows are a SAMPLE. Each one carries `_weight` — how many real events
//     it stands for (data/explore/eventsStore.js) — so every aggregate is a
//     weighted one: a count is Σw, an average Σwv/Σw, a quantile reads a
//     weighted distribution. Counting rows instead would report two dozen logs
//     an hour no matter how long the window.
//
//  2. A range stats query is the SAME reduction run once per step bucket. So
//     there is one pipeline here, not two: bucket the survivors, then run the
//     pipes over each bucket's rows. An instant query is that pipeline over a
//     single bucket covering the last step. A bucket nobody landed in produces
//     no point at all — the chart draws a gap, which is what a sparse series
//     looks like on the real server.
//
//  3. The server names a series after the RESULT FIELD: the alias when one was
//     given, otherwise the call as it was written (`count(*)`,
//     `quantile(0.9, duration)`). It comes back as `__name__`, beside the
//     `by (…)` fields — so one stats entry per group is one series, and a
//     `math` pipe's outputs are result fields too, hence more series.
//
//  4. The query is run against a window the SERVER chose, not the query: the
//     rows were already cut to [start, end), which is why a `_time:` filter in
//     the text is accepted and ignored rather than fighting with it.
//
// Where a stats or filter function is one the parser accepts but this evaluator
// has no honest answer for, it returns NaN (api.js drops non-finite points, so
// the chart shows nothing) or matches everything (over-counting is a smaller
// lie than silently dropping rows the server would have kept). Both are marked
// where they happen.

import { getField } from '@/data/explore/eventsStore'
import { LogsqlError } from './parser.js'

// ---------- values ----------

const weightOf = (row) => (Number.isFinite(row?._weight) ? row._weight : 1)

/** A field value as text. `_stream` is an object, and prints the way the server's table prints it. */
function cellText(v) {
  if (v === undefined || v === null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

// LogsQL compares durations and sizes numerically, so `duration:>100ms` has to
// mean 1e8 against a nanosecond field and `size:>1KB` 1000 against a byte one.
const DURATION_NS = { ns: 1, us: 1e3, 'µs': 1e3, ms: 1e6, s: 1e9, m: 6e10, h: 3.6e12, d: 8.64e13, w: 6.048e14, y: 3.1536e16 }
const DURATION_TEXT = /^[+-]?(?:\d+(?:\.\d+)?(?:ns|us|µs|ms|s|m|h|d|w|y))+$/
const DURATION_PART = /(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h|d|w|y)/g
const SIZE_TEXT = /^([+-]?\d+(?:\.\d+)?)([kmgt])?(i)?b$/i
const SIZE_EXP = { k: 1, m: 2, g: 3, t: 4 }

function unitNumber(s) {
  if (DURATION_TEXT.test(s)) {
    let ns = 0
    DURATION_PART.lastIndex = 0
    for (let m = DURATION_PART.exec(s); m; m = DURATION_PART.exec(s)) ns += Number(m[1]) * DURATION_NS[m[2]]
    return s[0] === '-' ? -ns : ns
  }
  const size = SIZE_TEXT.exec(s)
  if (!size) return NaN
  return Number(size[1]) * (size[3] ? 1024 : 1000) ** (SIZE_EXP[(size[2] || '').toLowerCase()] || 0)
}

function toNumber(v) {
  if (typeof v === 'number') return v
  const s = cellText(v).trim()
  if (!s) return NaN
  const n = Number(s)
  return Number.isFinite(n) ? n : unitNumber(s)
}

// A regexp the parser let through but JS cannot compile matches nothing. The
// alternative — throwing from inside a per-row loop — would turn one bad
// character in the editor into a failed request with a stack trace in it.
const RE_CACHE = new Map()
function regexFor(src) {
  if (RE_CACHE.has(src)) return RE_CACHE.get(src)
  let re
  try {
    re = new RegExp(src)
  } catch {
    re = null
  }
  RE_CACHE.set(src, re)
  return re
}

// ---------- word matching ----------

const WORD_RE = /[\p{L}\p{N}_]+/gu
const words = (s) => s.match(WORD_RE) || []

// A word or phrase filter matches a CONTIGUOUS run of words, not a substring:
// `endpoint:"/v1/order"` must find `/v1/order/42` and must not find
// `x/v1/ordering`.
function hasRun(hay, needle, prefixLast) {
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let ok = true
    for (let j = 0; j < needle.length; j++) {
      const h = hay[i + j]
      ok = prefixLast && j === needle.length - 1 ? h.startsWith(needle[j]) : h === needle[j]
      if (!ok) break
    }
    if (ok) return true
  }
  return false
}

function phraseMatch(hay, value, fold = false) {
  // `f:""` asks for the rows that have no value there, not for every row.
  if (value === '') return hay === ''
  const h = fold ? hay.toLowerCase() : hay
  const v = fold ? value.toLowerCase() : value
  if (h === v) return true
  const nw = words(v)
  // Nothing but punctuation has no words to line up — fall back to a substring.
  return nw.length ? hasRun(words(h), nw, false) : h.includes(v)
}

function prefixMatch(hay, value) {
  if (value === '') return true
  if (hay.startsWith(value)) return true
  const nw = words(value)
  return nw.length ? hasRun(words(hay), nw, true) : hay.includes(value)
}

function containsInOrder(s, values) {
  let at = 0
  for (const v of values) {
    const i = s.indexOf(v, at)
    if (i === -1) return false
    at = i + v.length
  }
  return true
}

// ---------- filters ----------

function matchFilter(node, row) {
  if (!node) return true
  switch (node.type) {
    case 'and': return node.items.every(n => matchFilter(n, row))
    case 'or': return node.items.some(n => matchFilter(n, row))
    case 'not': return !matchFilter(node.item, row)
    // The window is the server's, and these rows are already inside it.
    case 'all': case 'time': return true
    case 'stream': return node.matchers.every(m => matchStream(m, row))
    case 'term': return matchTerm(node, row)
    default: return true
  }
}

// A `{…}` selector names stream fields, but people put ordinary fields in one.
// Reading the row when `_stream` has no such key answers the question they
// meant; answering "" would make `!=` match every row instead.
function streamValue(row, label) {
  const stream = row?._stream
  if (stream && typeof stream === 'object' && label in stream) return stream[label]
  return getField(row, label)
}

function matchStream(m, row) {
  const s = cellText(streamValue(row, m.label))
  if (m.op === '=' || m.op === '!=') return (s === m.value) === (m.op === '=')
  const re = regexFor(`^(?:${m.value})$`)
  return (!!re && re.test(s)) === (m.op === '=~')
}

function compare(op, left, right) {
  const a = toNumber(left)
  const b = toNumber(right)
  const numeric = Number.isFinite(a) && Number.isFinite(b)
  const x = numeric ? a : cellText(left)
  const y = numeric ? b : cellText(right)
  switch (op) {
    case 'gt': return x > y
    case 'gte': return x >= y
    case 'lt': return x < y
    default: return x <= y
  }
}

function matchTerm(node, row) {
  const raw = getField(row, node.field)
  const s = cellText(raw)
  const values = node.values || []
  switch (node.op) {
    case 'exists': return s !== ''
    case 'exact': return s === node.value
    case 'in': return values.includes(s)
    case 'prefix': return prefixMatch(s, node.value)
    case 'word': case 'phrase': return phraseMatch(s, node.value)
    case 'icase': return phraseMatch(s, node.value, true)
    case 'regex': { const re = regexFor(node.value); return !!re && re.test(s) }
    case 'gt': case 'gte': case 'lt': case 'lte': return compare(node.op, raw, node.value)
    case 'contains_any': return values.some(v => s.includes(v))
    case 'contains_all': return values.every(v => s.includes(v))
    case 'seq': return containsInOrder(s, values)
    case 'range': return compare('gte', raw, values[0]) && compare('lte', raw, values[1])
    case 'len_range': return s.length >= toNumber(values[0]) && s.length <= toNumber(values[1])
    case 'string_range': return s >= cellText(values[0]) && s < cellText(values[1])
    case 'eq_field': return s === cellText(getField(row, node.value))
    case 'le_field': return compare('lte', raw, getField(row, node.value))
    case 'lt_field': return compare('lt', raw, getField(row, node.value))
    // `value_type` and any filter function the parser kept but does not model.
    default: return true
  }
}

// ---------- weighted reductions ----------

const totalWeight = (rows) => rows.reduce((a, r) => a + weightOf(r), 0)

/** The numeric values of `field`, each with its row's weight. Rows without one are not there. */
function numbersOf(rows, field) {
  const out = []
  for (const r of rows) {
    const n = toNumber(getField(r, field))
    if (Number.isFinite(n)) out.push({ v: n, w: weightOf(r) })
  }
  return out
}

const pairWeight = (pairs) => pairs.reduce((a, p) => a + p.w, 0)
const pairSum = (pairs) => pairs.reduce((a, p) => a + p.w * p.v, 0)

// The value at `phi` of the WEIGHTED distribution: a sampled row standing for
// 400 events has to move the median as much as 400 rows would.
function quantileOf(pairs, phi) {
  if (!pairs.length || !Number.isFinite(phi)) return NaN
  const sorted = [...pairs].sort((a, b) => a.v - b.v)
  const target = Math.min(Math.max(phi, 0), 1) * pairWeight(sorted)
  let acc = 0
  for (const p of sorted) {
    acc += p.w
    if (acc >= target) return p.v
  }
  return sorted[sorted.length - 1].v
}

const anyNonEmpty = (row, fields) => fields.some(f => cellText(getField(row, f)) !== '')

/** Distinct value tuples. A count of VALUES, so weights play no part in it. */
function uniqueKeys(rows, fields) {
  const keys = new Set()
  for (const r of rows) {
    const parts = fields.map(f => cellText(getField(r, f)))
    if (parts.every(p => p === '')) continue
    keys.add(parts.join('\u0000'))
  }
  return keys
}

// Numeric when anything in the column is a number, lexicographic otherwise, so
// `max(log.level)` still answers something a person can read.
function extreme(rows, field, dir) {
  const pairs = numbersOf(rows, field)
  if (pairs.length) return pairs.reduce((a, p) => (dir * (p.v - a) > 0 ? p.v : a), pairs[0].v)
  let best = null
  for (const r of rows) {
    const s = cellText(getField(r, field))
    if (s === '') continue
    if (best === null || (dir > 0 ? s > best : s < best)) best = s
  }
  return best === null ? NaN : best
}

/**
 * One stats entry over one group's rows. `spanSec` is how much time the group
 * covers, which is what the per-second functions divide by.
 */
function reduceEntry(entry, rows, spanSec) {
  // `if (…)` narrows this entry only — that is what makes `count() if (error)`
  // and `count()` share a group and become an error rate.
  const sel = entry.filter ? rows.filter(r => matchFilter(entry.filter, r)) : rows
  const fields = entry.args.map(a => a.value)
  const first = fields[0] ?? ''
  switch (entry.fn) {
    case 'count':
      return totalWeight(fields.length ? sel.filter(r => anyNonEmpty(r, fields)) : sel)
    case 'count_empty':
      return totalWeight(fields.length ? sel.filter(r => !anyNonEmpty(r, fields)) : [])
    case 'count_uniq': case 'count_uniq_hash':
      return fields.length ? uniqueKeys(sel, fields).size : NaN
    case 'uniq_values':
      return fields.length ? JSON.stringify([...uniqueKeys(sel, fields)].sort()) : NaN
    case 'sum':
      return pairSum(numbersOf(sel, first))
    case 'avg': {
      const pairs = numbersOf(sel, first)
      const w = pairWeight(pairs)
      return w ? pairSum(pairs) / w : NaN
    }
    case 'min': return extreme(sel, first, -1)
    case 'max': return extreme(sel, first, 1)
    case 'median': return quantileOf(numbersOf(sel, first), 0.5)
    case 'quantile': return quantileOf(numbersOf(sel, fields[1] ?? ''), toNumber(fields[0]))
    case 'stddev': {
      const pairs = numbersOf(sel, first)
      const w = pairWeight(pairs)
      if (!w) return NaN
      const mean = pairSum(pairs) / w
      return Math.sqrt(pairs.reduce((a, p) => a + p.w * (p.v - mean) ** 2, 0) / w)
    }
    case 'sum_len':
      return sel.reduce((a, r) => a + weightOf(r) * cellText(getField(r, first)).length, 0)
    case 'rate':
      return spanSec > 0 ? totalWeight(sel) / spanSec : NaN
    case 'rate_sum':
      return spanSec > 0 ? pairSum(numbersOf(sel, first)) / spanSec : NaN
    case 'any': case 'row_any': {
      const hit = sel.find(r => cellText(getField(r, first)) !== '')
      return hit ? cellText(getField(hit, first)) : NaN
    }
    // `histogram`, `values`, `row_min`/`row_max`, `field_min`/`field_max` and
    // `median_absolute_deviation` parse but have no chartable answer here.
    default: return NaN
  }
}

// ---------- pipes ----------
//
// A pipeline stage is `{ rows, groupFields, valueFields }`: the rows as they
// stand, which of their fields are the group's identity, and which are results.
// Before the first `stats` both lists are empty, which is exactly right — a
// query with nothing to reduce has no series, and `planFor` has already refused
// one.

function applyStats(state, pipe, spanSec) {
  const by = pipe.by || []
  const groups = new Map()
  for (const row of state.rows) {
    const labels = by.map(f => cellText(getField(row, f)))
    const key = labels.join('\u0000')
    let group = groups.get(key)
    if (!group) {
      // `| stats … limit N` caps the number of groups, first seen first kept.
      if (pipe.limit > 0 && groups.size >= pipe.limit) continue
      group = { labels, rows: [] }
      groups.set(key, group)
    }
    group.rows.push(row)
  }
  const valueFields = []
  for (const e of pipe.entries) if (!valueFields.includes(e.name)) valueFields.push(e.name)
  const rows = []
  for (const group of groups.values()) {
    const out = {}
    by.forEach((f, i) => { out[f] = group.labels[i] })
    for (const e of pipe.entries) out[e.name] = reduceEntry(e, group.rows, spanSec)
    rows.push(out)
  }
  return { rows, groupFields: [...by], valueFields }
}

const MATH_CALLS = {
  abs: Math.abs, ceil: Math.ceil, exp: Math.exp, floor: Math.floor, ln: Math.log,
  max: Math.max, min: Math.min,
  round: (x, nearest) => (Number.isFinite(nearest) && nearest > 0 ? Math.round(x / nearest) * nearest : Math.round(x)),
}

function evalMath(node, row) {
  switch (node.type) {
    case 'num': return node.value
    case 'ref': return toNumber(getField(row, node.name))
    case 'neg': return -evalMath(node.expr, row)
    case 'bin': {
      const a = evalMath(node.left, row)
      const b = evalMath(node.right, row)
      switch (node.op) {
        case '+': return a + b
        case '-': return a - b
        case '*': return a * b
        case '/': return a / b
        case '%': return a % b
        default: return a ** b
      }
    }
    case 'call': {
      if (node.fn === 'now') return Date.now() * 1e6
      if (node.fn === 'rand') return Math.random()
      const fn = MATH_CALLS[node.fn]
      return fn ? fn(...node.args.map(a => evalMath(a, row))) : NaN
    }
    default: return NaN
  }
}

function applyMath(state, pipe) {
  const rows = state.rows.map(row => {
    const out = { ...row }
    // Each entry sees the ones before it: `| math a*2 as b, b+1 as c` works.
    for (const e of pipe.entries) out[e.name] = evalMath(e.expr, out)
    return out
  })
  const valueFields = [...state.valueFields]
  for (const e of pipe.entries) {
    if (!valueFields.includes(e.name) && !state.groupFields.includes(e.name)) valueFields.push(e.name)
  }
  return { ...state, rows, valueFields }
}

function keepFields(state, names) {
  const keep = new Set(names || [])
  return {
    rows: state.rows.map(row => {
      const out = {}
      for (const n of keep) if (n in row) out[n] = row[n]
      return out
    }),
    groupFields: state.groupFields.filter(f => keep.has(f)),
    valueFields: state.valueFields.filter(f => keep.has(f)),
  }
}

function dropFields(state, names) {
  const gone = new Set(names || [])
  return {
    rows: state.rows.map(row => {
      const out = { ...row }
      for (const n of gone) delete out[n]
      return out
    }),
    groupFields: state.groupFields.filter(f => !gone.has(f)),
    valueFields: state.valueFields.filter(f => !gone.has(f)),
  }
}

function movedFields(state, pairs, keepSource) {
  const moves = (pairs || []).filter(p => p.to)
  const rename = (list) => list.flatMap(f => {
    const move = moves.find(m => m.from === f)
    if (!move) return [f]
    return keepSource ? [f, move.to] : [move.to]
  })
  return {
    rows: state.rows.map(row => {
      const out = { ...row }
      for (const { from, to } of moves) {
        out[to] = row[from]
        if (!keepSource) delete out[from]
      }
      return out
    }),
    groupFields: rename(state.groupFields),
    valueFields: rename(state.valueFields),
  }
}

function runPipes(rows, pipes, spanSec) {
  let state = { rows, groupFields: [], valueFields: [] }
  for (const pipe of pipes) {
    switch (pipe.name) {
      case 'stats': state = applyStats(state, pipe, spanSec); break
      case 'math': case 'eval': state = applyMath(state, pipe); break
      case 'filter': case 'where':
        state = { ...state, rows: state.rows.filter(r => matchFilter(pipe.filter, r)) }
        break
      case 'fields': case 'keep': state = keepFields(state, pipe.fields); break
      case 'drop': case 'del': case 'delete': case 'rm': state = dropFields(state, pipe.fields); break
      case 'rename': case 'mv': state = movedFields(state, pipe.pairs, false); break
      case 'copy': case 'cp': state = movedFields(state, pipe.pairs, true); break
      // Every other pipe either cannot change a stats answer or is one api.js
      // has already refused around the stats pipe.
      default: break
    }
  }
  return state
}

// ---------- entry points ----------

function planFor(parsed) {
  const pipes = parsed?.pipes || []
  // api.js refuses this first, with the server's full wording; this is the
  // guard for anything calling the engine directly.
  if (!pipes.some(p => p.name === 'stats')) {
    const q = parsed?.query ?? ''
    throw new LogsqlError('missing `| stats ...` pipe', q.length, q)
  }
  return { filter: parsed.filter, pipes }
}

// One stage's rows, keyed by series: `__name__` is the result field, the rest
// of the metric is the group.
function emit(state, visit) {
  for (const row of state.rows) {
    const labels = {}
    for (const f of state.groupFields) labels[f] = cellText(row[f])
    const groupKey = state.groupFields.map(f => labels[f]).join('\u0000')
    for (const name of state.valueFields) visit(`${name}\u0001${groupKey}`, name, labels, row[name])
  }
}

/**
 * A range stats query, bucketed by `step`.
 *
 * @param {object} parsed — from `parseLogsql`
 * @param {Array<object>} rows — weighted sample rows, `_time` in ms
 * @param {{ start:number, end:number, step:number }} window — unix SECONDS
 * @returns {Array<{ metric:object, values:Array<{x:number,y:*}> }>} `x` in ms at
 *   the bucket's start; a bucket with no surviving row has no point at all
 * @throws {LogsqlError} when the query has no `| stats` pipe
 */
export function evaluateStatsRange(parsed, rows, { start, end, step } = {}) {
  const plan = planFor(parsed)
  if (!(step > 0) || !(end > start)) return []

  const buckets = new Map()
  for (const row of rows || []) {
    const t = Number(row?._time) / 1000
    // Bucket boundaries are absolute multiples of the step, the same ones the
    // store filled, so two windows agree on every bucket they share.
    if (!(t >= start) || !(t < end) || !matchFilter(plan.filter, row)) continue
    const at = Math.floor(t / step) * step
    const bucket = buckets.get(at)
    if (bucket) bucket.push(row)
    else buckets.set(at, [row])
  }

  const series = new Map()
  for (const at of [...buckets.keys()].sort((a, b) => a - b)) {
    // A per-second function divides by the time its bucket covers, not by the
    // window: otherwise every point of a 7-day chart would read 1/168 of the
    // rate it is drawn for. A bucket clipped by the window's edge is shorter.
    const span = Math.min(at + step, end) - Math.max(at, start)
    emit(runPipes(buckets.get(at), plan.pipes, span), (key, name, labels, value) => {
      let s = series.get(key)
      if (!s) {
        s = { metric: { __name__: name, ...labels }, values: [] }
        series.set(key, s)
      }
      s.values.push({ x: at * 1000, y: value })
    })
  }
  return [...series.values()]
}

/**
 * An instant stats query: the same reduction over the LAST STEP only, as one
 * bucket. A group with no hits in that step is missing rather than zero, which
 * is what "latest" means on the real server.
 *
 * @returns {Array<{ metric:object, value:* }>}
 * @throws {LogsqlError} when the query has no `| stats` pipe
 */
export function evaluateStatsInstant(parsed, rows, { time, step } = {}) {
  const plan = planFor(parsed)
  if (!(step > 0)) return []
  const start = time - step
  const kept = (rows || []).filter(r => {
    const t = Number(r?._time) / 1000
    return t >= start && t < time && matchFilter(plan.filter, r)
  })
  const out = []
  emit(runPipes(kept, plan.pipes, step), (_key, name, labels, value) => {
    out.push({ metric: { __name__: name, ...labels }, value })
  })
  return out
}
