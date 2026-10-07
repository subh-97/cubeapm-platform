// Evaluating a MetricsQL AST against the synthetic metrics store.
//
// The shape of this evaluator is set by one fact: the store can answer "what
// was this series worth at these timestamps" for ANY timestamps, because its
// data is a function of time rather than a stored array. So nothing here has to
// hold a window of samples in memory or interpolate — it asks for exactly the
// instants it needs and no more.
//
// Every expression is therefore evaluated AT a list of timestamps, and the one
// recursive entry point carries that list. A rollup (`rate`, `increase`,
// `avg_over_time`, …) widens it: to answer at t it needs the samples inside
// (t-window, t], so it evaluates its own argument over the union of those
// sub-grids and reduces afterwards. That is why the argument of a rollup can be
// a whole expression — `increase(x default 0)` is exactly what our own
// generators write, and the `default 0` has to happen before the reduction, not
// after.
//
// Values are plain numbers with NaN for "no sample". NaN is not an error here:
// a gap is a real answer about a sparse series, and `default` exists to fill it.

import { PromqlError } from './parser.js'

const NAME = '__name__'

/** Samples taken inside one rollup window. Enough to follow a counter, few enough to stay cheap. */
const WINDOW_SAMPLES_MIN = 5
const WINDOW_SAMPLES_MAX = 12

// ---------------------------------------------------------------- entry points

/**
 * Evaluate over a range. Returns the shape api.js expects:
 * `[{ metric, values: [[unixSeconds, number], …] }]`, gaps omitted.
 */
export function evaluateRange(ast, { start, end, step, store }) {
  const ts = []
  for (let t = start; t <= end; t += step) ts.push(t)
  if (!ts.length) ts.push(end)
  const ctx = { store, step, start, end }
  const result = toVector(evalAt(ast, ctx, ts), ts)
  return result
    .map(s => ({
      metric: s.metric,
      values: ts.map((t, i) => [t, s.values[i]]).filter(p => Number.isFinite(p[1])),
    }))
    // A series with nothing left is not a series. This is what makes a filtering
    // comparison (`… > 5`) actually drop the rows that lost, rather than
    // returning them as an empty line the legend would still list.
    .filter(s => s.values.length > 0)
}

/**
 * Evaluate at a single instant. Returns `[{ metric, value }]`; NaN survives,
 * because the CSV writes it out as the reference does.
 */
export function evaluateInstant(ast, { time, step, store }) {
  const ts = [time]
  const ctx = { store, step, start: time - step, end: time }
  return toVector(evalAt(ast, ctx, ts), ts).map(s => ({ metric: s.metric, value: s.values[0] }))
}

// A scalar used where a vector is wanted becomes one unlabelled series, which
// is what makes `vector(1)` and a bare `100` behave in a binary operation.
function toVector(result, ts) {
  if (result.kind === 'vector') return result.series
  return [{ metric: {}, values: ts.map(() => result.value) }]
}

// ---------------------------------------------------------------- dispatch

function evalAt(node, ctx, ts) {
  switch (node.type) {
    case 'number': return { kind: 'scalar', value: node.value }
    case 'string': return { kind: 'scalar', value: NaN }
    case 'unary': return mapValues(evalAt(node.expr, ctx, ts), v => -v)
    case 'selector': return evalSelector(node, ctx, ts)
    case 'call': return evalCall(node, ctx, ts)
    case 'aggregation': return evalAggregation(node, ctx, ts)
    case 'binary': return evalBinary(node, ctx, ts)
    default: throw new PromqlError(`unsupported expression "${node.type}"`, node.pos)
  }
}

function mapValues(result, fn) {
  if (result.kind === 'scalar') return { kind: 'scalar', value: fn(result.value) }
  return {
    kind: 'vector',
    series: result.series.map(s => ({ metric: s.metric, values: s.values.map(fn) })),
  }
}

// ---------------------------------------------------------------- selectors

function selectorMatchers(node) {
  const matchers = node.matchers.map(m => ({ ...m }))
  if (node.name) matchers.unshift({ label: NAME, op: '=', value: node.name })
  return matchers
}

function evalSelector(node, ctx, ts) {
  const offset = node.offset || 0
  const at = offset ? ts.map(t => t - offset) : ts
  const matchers = selectorMatchers(node)
  const span = { start: at[0] - ctx.step, end: at[at.length - 1] }
  const found = ctx.store.selectSeries(matchers, span) || []
  return {
    kind: 'vector',
    series: found.map(s => ({
      metric: { ...s.metric },
      values: Array.from(ctx.store.sampleSeries(s.key, at)),
    })),
  }
}

// ---------------------------------------------------------------- rollups

// How a range function reduces the samples inside its window. `counter: true`
// marks the ones that read a cumulative series, where only the rises count —
// that is what keeps a deploy's counter reset from reading as a huge negative
// rate.
const ROLLUPS = {
  rate: { counter: true, reduce: (vals, w) => increaseOf(vals) / w },
  irate: { counter: true, reduce: (vals, w, stepSec) => lastDelta(vals) / stepSec },
  increase: { counter: true, reduce: vals => increaseOf(vals) },
  delta: { reduce: vals => edgeDelta(vals) },
  idelta: { reduce: vals => lastDelta(vals) },
  deriv: { reduce: (vals, w) => edgeDelta(vals) / w },
  changes: { reduce: vals => countChanges(vals) },
  resets: { reduce: vals => countResets(vals) },
  sum_over_time: { reduce: vals => defined(vals).reduce((a, b) => a + b, 0) },
  avg_over_time: { reduce: vals => mean(defined(vals)) },
  min_over_time: { reduce: vals => reduceOr(defined(vals), Math.min) },
  max_over_time: { reduce: vals => reduceOr(defined(vals), Math.max) },
  count_over_time: { reduce: vals => defined(vals).length || NaN },
  last_over_time: { reduce: vals => { const d = defined(vals); return d.length ? d[d.length - 1] : NaN } },
  present_over_time: { reduce: vals => (defined(vals).length ? 1 : NaN) },
  stddev_over_time: { reduce: vals => Math.sqrt(variance(defined(vals))) },
  stdvar_over_time: { reduce: vals => variance(defined(vals)) },
  absent_over_time: { reduce: vals => (defined(vals).length ? NaN : 1) },
  quantile_over_time: { reduce: (vals, _w, _s, q) => quantileOf(defined(vals).sort((a, b) => a - b), q) },
}

const defined = vals => vals.filter(Number.isFinite)
const mean = vals => (vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : NaN)
const reduceOr = (vals, fn) => (vals.length ? vals.reduce((a, b) => fn(a, b)) : NaN)

function variance(vals) {
  if (!vals.length) return NaN
  const m = mean(vals)
  return vals.reduce((a, v) => a + (v - m) ** 2, 0) / vals.length
}

// Counter-aware: sum the rises and ignore the falls, so a reset contributes the
// value it climbed back to rather than a negative spike.
function increaseOf(vals) {
  const d = defined(vals)
  if (d.length < 2) return d.length ? 0 : NaN
  let total = 0
  for (let i = 1; i < d.length; i++) {
    const delta = d[i] - d[i - 1]
    total += delta >= 0 ? delta : d[i]
  }
  return total
}

function edgeDelta(vals) {
  const d = defined(vals)
  return d.length < 2 ? NaN : d[d.length - 1] - d[0]
}

function lastDelta(vals) {
  const d = defined(vals)
  return d.length < 2 ? NaN : d[d.length - 1] - d[d.length - 2]
}

function countChanges(vals) {
  const d = defined(vals)
  let n = 0
  for (let i = 1; i < d.length; i++) if (d[i] !== d[i - 1]) n++
  return d.length ? n : NaN
}

function countResets(vals) {
  const d = defined(vals)
  let n = 0
  for (let i = 1; i < d.length; i++) if (d[i] < d[i - 1]) n++
  return d.length ? n : NaN
}

function quantileOf(sorted, q) {
  if (!sorted.length || !Number.isFinite(q)) return NaN
  if (q <= 0) return sorted[0]
  if (q >= 1) return sorted[sorted.length - 1]
  const pos = q * (sorted.length - 1)
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

// The window a rollup reads. MetricsQL lets the brackets be left off entirely —
// every query our Quick tab writes does — and then the window is the step, so
// each point summarises exactly the interval it is drawn for.
function windowOf(node, ctx) {
  const ranged = findRanged(node)
  const w = ranged?.range?.window
  return Number.isFinite(w) && w > 0 ? w : ctx.step
}

function findRanged(node) {
  if (!node || typeof node !== 'object') return null
  if (node.type === 'selector' && node.range) return node
  for (const key of ['expr', 'lhs', 'rhs']) {
    const found = findRanged(node[key])
    if (found) return found
  }
  if (Array.isArray(node.args)) {
    for (const arg of node.args) {
      const found = findRanged(arg)
      if (found) return found
    }
  }
  return null
}

function evalRollup(name, node, ctx, ts, extraArg) {
  const spec = ROLLUPS[name]
  const window = windowOf(node, ctx)
  const inner = node.args[name === 'quantile_over_time' ? 1 : 0]
  if (!inner) throw new PromqlError(`${name}() needs a range vector argument`, node.pos)

  // One sub-grid per output point, then a single pass over their union, so a
  // series is sampled once however many windows overlap it.
  const perWindow = Math.min(
    WINDOW_SAMPLES_MAX,
    Math.max(WINDOW_SAMPLES_MIN, Math.round(window / Math.max(1, ctx.step)) + 1),
  )
  const offsets = []
  for (let i = perWindow - 1; i >= 0; i--) offsets.push(Math.round((window * i) / (perWindow - 1)))

  const union = new Set()
  for (const t of ts) for (const off of offsets) union.add(t - off)
  const grid = Array.from(union).sort((a, b) => a - b)
  const indexOf = new Map(grid.map((t, i) => [t, i]))

  const source = toVector(evalAt(inner, ctx, grid), grid)
  const series = source.map(s => {
    const values = ts.map(t => {
      const window_ = offsets.map(off => s.values[indexOf.get(t - off)])
      return spec.reduce(window_, window, ctx.step, extraArg)
    })
    return { metric: dropName(s.metric), values }
  })
  return { kind: 'vector', series }
}

// ---------------------------------------------------------------- functions

const MATH = {
  abs: Math.abs,
  ceil: Math.ceil,
  floor: Math.floor,
  sqrt: Math.sqrt,
  exp: Math.exp,
  ln: Math.log,
  log2: Math.log2,
  log10: Math.log10,
  sgn: Math.sign,
}

function evalCall(node, ctx, ts) {
  const { func } = node

  if (ROLLUPS[func]) {
    const q = func === 'quantile_over_time' ? scalarArg(node, ctx, ts, 0) : undefined
    return evalRollup(func, node, ctx, ts, q)
  }
  if (MATH[func]) return keepOrDropName(node, mapValues(argVector(node, ctx, ts, 0), MATH[func]))

  switch (func) {
    case 'histogram_quantile': return histogramQuantile(node, ctx, ts)
    case 'clamp': {
      const min = scalarArg(node, ctx, ts, 1)
      const max = scalarArg(node, ctx, ts, 2)
      return mapValues(argVector(node, ctx, ts, 0), v => Math.min(Math.max(v, min), max))
    }
    case 'clamp_min': {
      const min = scalarArg(node, ctx, ts, 1)
      return mapValues(argVector(node, ctx, ts, 0), v => Math.max(v, min))
    }
    case 'clamp_max': {
      const max = scalarArg(node, ctx, ts, 1)
      return mapValues(argVector(node, ctx, ts, 0), v => Math.min(v, max))
    }
    case 'round': {
      const to = node.args.length > 1 ? scalarArg(node, ctx, ts, 1) : 1
      const nearest = Number.isFinite(to) && to > 0 ? to : 1
      return mapValues(argVector(node, ctx, ts, 0), v => Math.round(v / nearest) * nearest)
    }
    case 'vector': return { kind: 'vector', series: [{ metric: {}, values: ts.map(() => scalarArg(node, ctx, ts, 0)) }] }
    case 'scalar': {
      const series = toVector(evalAt(node.args[0], ctx, ts), ts)
      return { kind: 'vector', series: [{ metric: {}, values: ts.map((_, i) => (series.length === 1 ? series[0].values[i] : NaN)) }] }
    }
    case 'time': return { kind: 'vector', series: [{ metric: {}, values: ts.slice() }] }
    case 'timestamp': return mapValues(argVector(node, ctx, ts, 0), (v, i) => (Number.isFinite(v) ? ts[i] : NaN))
    case 'sort': return sortSeries(argVector(node, ctx, ts, 0), 1)
    case 'sort_desc': return sortSeries(argVector(node, ctx, ts, 0), -1)
    case 'absent': {
      const vec = argVector(node, ctx, ts, 0)
      const present = vec.series.some(s => s.values.some(Number.isFinite))
      return { kind: 'vector', series: present ? [] : [{ metric: {}, values: ts.map(() => 1) }] }
    }
    case 'label_replace': return labelReplace(node, ctx, ts)
    case 'alias': {
      const vec = argVector(node, ctx, ts, 0)
      const alias = literalString(node.args[1])
      return { kind: 'vector', series: vec.series.map(s => ({ metric: { ...s.metric, [NAME]: alias }, values: s.values })) }
    }
    default:
      throw new PromqlError(`unsupported function ${JSON.stringify(func)}`, node.pos)
  }
}

function argVector(node, ctx, ts, i) {
  const arg = node.args[i]
  if (!arg) throw new PromqlError(`${node.func}() is missing an argument`, node.pos)
  const res = evalAt(arg, ctx, ts)
  return { kind: 'vector', series: toVector(res, ts) }
}

function scalarArg(node, ctx, ts, i) {
  const arg = node.args[i]
  if (!arg) return NaN
  const res = evalAt(arg, ctx, ts)
  if (res.kind === 'scalar') return res.value
  return res.series.length ? res.series[0].values[0] : NaN
}

function literalString(node) {
  return node && node.type === 'string' ? node.value : ''
}

// A function drops `__name__` unless the query asked to keep it, because the
// result is no longer that metric — it is something computed from it.
function keepOrDropName(node, result) {
  if (node.keepMetricNames) return result
  return { kind: result.kind, series: result.series.map(s => ({ metric: dropName(s.metric), values: s.values })) }
}

function sortSeries(vec, dir) {
  const lastDefined = s => {
    for (let i = s.values.length - 1; i >= 0; i--) if (Number.isFinite(s.values[i])) return s.values[i]
    return NaN
  }
  return { kind: 'vector', series: vec.series.slice().sort((a, b) => dir * (lastDefined(a) - lastDefined(b))) }
}

function labelReplace(node, ctx, ts) {
  const vec = argVector(node, ctx, ts, 0)
  const dst = literalString(node.args[1])
  const repl = literalString(node.args[2])
  const src = literalString(node.args[3])
  let re
  try {
    re = new RegExp(`^(?:${literalString(node.args[4])})$`)
  } catch {
    throw new PromqlError('label_replace() got an invalid regular expression', node.pos)
  }
  return {
    kind: 'vector',
    series: vec.series.map(s => {
      const match = re.exec(s.metric[src] ?? '')
      if (!match) return s
      const value = repl.replace(/\$(\d+)/g, (_, g) => match[Number(g)] ?? '')
      const metric = { ...s.metric }
      if (value === '') delete metric[dst]
      else metric[dst] = value
      return { metric, values: s.values }
    }),
  }
}

// ---------------------------------------------------------------- histograms

// VictoriaMetrics labels a bucket with the interval it covers rather than an
// upper bound: `vmrange="1.000e-03...1.136e-03"`. Prometheus `le` buckets are
// accepted too, so a hand-written query still works.
function parseBucket(metric) {
  const vmrange = metric.vmrange
  if (typeof vmrange === 'string' && vmrange.includes('...')) {
    const [lo, hi] = vmrange.split('...').map(Number)
    if (Number.isFinite(lo) && Number.isFinite(hi)) return { lo, hi }
  }
  const le = metric.le
  if (le !== undefined) {
    const hi = le === '+Inf' ? Infinity : Number(le)
    if (Number.isFinite(hi) || hi === Infinity) return { lo: 0, hi, cumulative: true }
  }
  return null
}

function histogramQuantile(node, ctx, ts) {
  const q = scalarArg(node, ctx, ts, 0)
  const vec = argVector(node, ctx, ts, 1)

  // Everything but the bucket label identifies the histogram the bucket is in.
  const groups = new Map()
  for (const s of vec.series) {
    const bucket = parseBucket(s.metric)
    if (!bucket) continue
    const metric = dropName(s.metric)
    delete metric.vmrange
    delete metric.le
    const key = labelKey(metric)
    if (!groups.has(key)) groups.set(key, { metric, buckets: [] })
    groups.get(key).buckets.push({ ...bucket, values: s.values })
  }

  const series = []
  for (const group of groups.values()) {
    const buckets = group.buckets.slice().sort((a, b) => a.hi - b.hi)
    const values = ts.map((_, i) => quantileFromBuckets(buckets, i, q))
    series.push({ metric: group.metric, values })
  }
  return { kind: 'vector', series }
}

function quantileFromBuckets(buckets, i, q) {
  if (!Number.isFinite(q)) return NaN
  const counts = buckets.map(b => {
    const v = b.values[i]
    return Number.isFinite(v) ? Math.max(0, v) : 0
  })
  // `le` buckets arrive cumulative; vmrange buckets do not.
  const perBucket = buckets[0]?.cumulative
    ? counts.map((c, k) => Math.max(0, c - (counts[k - 1] ?? 0)))
    : counts

  const total = perBucket.reduce((a, b) => a + b, 0)
  if (total <= 0) return NaN
  if (q <= 0) return buckets[0].lo
  if (q >= 1) return lastFiniteEdge(buckets)

  const want = q * total
  let seen = 0
  for (let k = 0; k < buckets.length; k++) {
    const c = perBucket[k]
    if (seen + c >= want) {
      const { lo, hi } = buckets[k]
      if (!Number.isFinite(hi)) return Number.isFinite(lo) ? lo : NaN
      if (c <= 0) return hi
      // Spread the bucket's observations evenly across the interval it covers.
      return lo + ((hi - lo) * (want - seen)) / c
    }
    seen += c
  }
  return lastFiniteEdge(buckets)
}

function lastFiniteEdge(buckets) {
  for (let k = buckets.length - 1; k >= 0; k--) {
    if (Number.isFinite(buckets[k].hi)) return buckets[k].hi
    if (Number.isFinite(buckets[k].lo)) return buckets[k].lo
  }
  return NaN
}

// ---------------------------------------------------------------- aggregations

const AGGREGATORS = {
  sum: vals => vals.reduce((a, b) => a + b, 0),
  min: vals => reduceOr(vals, Math.min),
  max: vals => reduceOr(vals, Math.max),
  avg: vals => mean(vals),
  count: vals => vals.length,
  group: vals => (vals.length ? 1 : NaN),
  stddev: vals => Math.sqrt(variance(vals)),
  stdvar: vals => variance(vals),
  median: vals => quantileOf(vals.slice().sort((a, b) => a - b), 0.5),
}

const SELECTORS = new Set(['topk', 'bottomk'])

function evalAggregation(node, ctx, ts) {
  const { op, modifier } = node
  // `topk(5, x)` and `quantile(0.9, x)` put their parameter first.
  const takesParam = SELECTORS.has(op) || op === 'quantile' || op === 'count_values'
  const param = takesParam ? node.args[0] : null
  const sourceNode = takesParam ? node.args[1] : node.args[0]
  if (!sourceNode) throw new PromqlError(`${op}() is missing its argument`, node.pos)

  const vec = toVector(evalAt(sourceNode, ctx, ts), ts)
  const paramValue = takesParam
    ? (evalAt(param, ctx, ts).value ?? NaN)
    : NaN

  const grouped = groupSeries(vec, modifier)

  // topk/bottomk keep the original series; they only hide the ones that lose.
  if (SELECTORS.has(op)) {
    const k = Math.max(0, Math.floor(paramValue));
    const keep = vec.map(s => ({ metric: dropName(s.metric), values: s.values.slice() }))
    for (let i = 0; i < ts.length; i++) {
      for (const members of grouped.values()) {
        const ranked = members
          .map(idx => ({ idx, v: keep[idx].values[i] }))
          .filter(r => Number.isFinite(r.v))
          .sort((a, b) => (op === 'topk' ? b.v - a.v : a.v - b.v))
        ranked.slice(k).forEach(r => { keep[r.idx].values[i] = NaN })
      }
    }
    return { kind: 'vector', series: keep }
  }

  if (op === 'count_values') {
    const label = literalString(param) || 'value'
    return countValues(vec, grouped, ts, label, modifier)
  }

  const reduce = op === 'quantile'
    ? vals => quantileOf(vals.slice().sort((a, b) => a - b), paramValue)
    : AGGREGATORS[op]
  if (!reduce) throw new PromqlError(`unsupported aggregation ${JSON.stringify(op)}`, node.pos)

  const series = []
  for (const [, members] of grouped) {
    const metric = groupLabels(vec[members[0]].metric, modifier)
    const values = ts.map((_, i) => {
      const vals = members.map(idx => vec[idx].values[i]).filter(Number.isFinite)
      // An empty group is a gap, not a zero — otherwise a sparse error series
      // would draw a flat zero line through the minutes it never reported.
      return vals.length ? reduce(vals) : NaN
    })
    series.push({ metric, values })
  }
  return { kind: 'vector', series }
}

function countValues(vec, grouped, ts, label, modifier) {
  const out = new Map()
  for (const [, members] of grouped) {
    for (let i = 0; i < ts.length; i++) {
      for (const idx of members) {
        const v = vec[idx].values[i]
        if (!Number.isFinite(v)) continue
        const metric = { ...groupLabels(vec[idx].metric, modifier), [label]: String(v) }
        const key = labelKey(metric)
        if (!out.has(key)) out.set(key, { metric, values: ts.map(() => NaN) })
        const row = out.get(key)
        row.values[i] = (Number.isFinite(row.values[i]) ? row.values[i] : 0) + 1
      }
    }
  }
  return { kind: 'vector', series: Array.from(out.values()) }
}

function groupSeries(series, modifier) {
  const groups = new Map()
  series.forEach((s, idx) => {
    const key = labelKey(groupLabels(s.metric, modifier))
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(idx)
  })
  return groups
}

function groupLabels(metric, modifier) {
  const out = {}
  if (!modifier) return out
  if (modifier.kind === 'by') {
    for (const l of modifier.labels) if (metric[l] !== undefined) out[l] = metric[l]
    return out
  }
  const drop = new Set([...modifier.labels, NAME])
  for (const [k, v] of Object.entries(metric)) if (!drop.has(k)) out[k] = v
  return out
}

// ---------------------------------------------------------------- binary ops

const ARITH = {
  '+': (a, b) => a + b,
  '-': (a, b) => a - b,
  '*': (a, b) => a * b,
  '/': (a, b) => (b === 0 ? NaN : a / b),
  '%': (a, b) => (b === 0 ? NaN : a % b),
  '^': (a, b) => a ** b,
  atan2: Math.atan2,
}

const COMPARE = {
  '==': (a, b) => a === b,
  '!=': (a, b) => a !== b,
  '<': (a, b) => a < b,
  '>': (a, b) => a > b,
  '<=': (a, b) => a <= b,
  '>=': (a, b) => a >= b,
}

const SET_OPS = new Set(['and', 'or', 'unless'])

function evalBinary(node, ctx, ts) {
  const { op } = node

  // `default` is MetricsQL's gap filler and the reason it exists in our
  // queries: a series that reported nothing in a bucket should read as zero
  // there, without inventing a series that never existed.
  if (op === 'default') {
    const lhs = evalAt(node.lhs, ctx, ts)
    const rhs = evalAt(node.rhs, ctx, ts)
    const fill = rhs.kind === 'scalar' ? () => rhs.value : null
    const filler = fill || sampler(toVector(rhs, ts))
    return {
      kind: 'vector',
      series: toVector(lhs, ts).map(s => ({
        metric: s.metric,
        values: s.values.map((v, i) => (Number.isFinite(v) ? v : filler(s.metric, i))),
      })),
    }
  }

  if (op === 'if' || op === 'ifnot') {
    const lhs = toVector(evalAt(node.lhs, ctx, ts), ts)
    const rhs = toVector(evalAt(node.rhs, ctx, ts), ts)
    const probe = sampler(rhs)
    return {
      kind: 'vector',
      series: lhs.map(s => ({
        metric: s.metric,
        values: s.values.map((v, i) => {
          const present = Number.isFinite(probe(s.metric, i))
          return (op === 'if') === present ? v : NaN
        }),
      })),
    }
  }

  if (SET_OPS.has(op)) return evalSetOp(node, ctx, ts)

  const lhsRes = evalAt(node.lhs, ctx, ts)
  const rhsRes = evalAt(node.rhs, ctx, ts)
  const fn = ARITH[op] || null
  const cmp = COMPARE[op] || null
  if (!fn && !cmp) throw new PromqlError(`unsupported operator ${JSON.stringify(op)}`, node.pos)

  const apply = (a, b) => {
    if (!Number.isFinite(a) || !Number.isFinite(b)) return NaN
    if (fn) return fn(a, b)
    const kept = cmp(a, b)
    // Without `bool` a comparison filters; with it, it answers 1 or 0.
    return node.bool ? (kept ? 1 : 0) : (kept ? a : NaN)
  }

  // scalar ⊕ vector keeps the vector's labels, minus the metric name: the
  // result is derived, so it is no longer `cube_apm_calls_total`.
  if (lhsRes.kind === 'scalar' && rhsRes.kind === 'vector') {
    return { kind: 'vector', series: rhsRes.series.map(s => ({ metric: dropName(s.metric), values: s.values.map(v => apply(lhsRes.value, v)) })) }
  }
  if (lhsRes.kind === 'vector' && rhsRes.kind === 'scalar') {
    return { kind: 'vector', series: lhsRes.series.map(s => ({ metric: dropName(s.metric), values: s.values.map(v => apply(v, rhsRes.value)) })) }
  }
  if (lhsRes.kind === 'scalar' && rhsRes.kind === 'scalar') {
    return { kind: 'scalar', value: apply(lhsRes.value, rhsRes.value) }
  }
  return matchVectors(lhsRes.series, rhsRes.series, node, ts, apply)
}

// Looks up "the other side's value for this series at this point", honouring
// the vector-matching clause. This is what makes `… by (service, http_code)
// / ignoring (http_code) group_left …` divide each sliced series by its
// service total.
function sampler(series) {
  const byKey = new Map()
  for (const s of series) byKey.set(labelKey(dropName(s.metric)), s)
  const single = series.length === 1 ? series[0] : null
  return (metric, i) => {
    const hit = byKey.get(labelKey(dropName(metric)))
    if (hit) return hit.values[i]
    return single ? single.values[i] : NaN
  }
}

function matchingKey(metric, matching) {
  if (!matching) return labelKey(dropName(metric))
  if (matching.on) {
    const out = {}
    for (const l of matching.labels) if (metric[l] !== undefined) out[l] = metric[l]
    return labelKey(out)
  }
  const drop = new Set([...matching.labels, NAME])
  const out = {}
  for (const [k, v] of Object.entries(metric)) if (!drop.has(k)) out[k] = v
  return labelKey(out)
}

function matchVectors(lhs, rhs, node, ts, apply) {
  const { matching } = node
  const card = matching?.card || null

  // `group_right` makes the right side the many side; otherwise the left side
  // is, and a plain operation is one-to-one. Either way the "one" side is the
  // one we index and look partners up in.
  const manySide = card === 'right' ? rhs : lhs
  const oneSide = card === 'right' ? lhs : rhs

  const index = new Map()
  for (const s of oneSide) {
    const key = matchingKey(s.metric, matching)
    if (!index.has(key)) index.set(key, s)
  }

  const series = []
  for (const s of manySide) {
    const partner = index.get(matchingKey(s.metric, matching))
    // No partner means no result: an error-rate query stays silent for a
    // service that reported no errors, rather than claiming zero.
    if (!partner) continue

    const metric = resultMetric(s.metric, partner.metric, matching, card)
    const values = ts.map((_, i) => {
      const a = card === 'right' ? partner.values[i] : s.values[i]
      const b = card === 'right' ? s.values[i] : partner.values[i]
      return apply(a, b)
    })
    series.push({ metric, values })
  }
  return { kind: 'vector', series }
}

function resultMetric(manyMetric, oneMetric, matching, card) {
  if (!card) {
    // 1:1 keeps only the labels the match was made on.
    const out = {}
    const keep = matching?.on ? new Set(matching.labels) : null
    for (const [k, v] of Object.entries(dropName(manyMetric))) {
      if (!keep || keep.has(k)) {
        if (!matching?.on && matching?.labels?.includes(k)) continue
        out[k] = v
      }
    }
    return out
  }
  // group_left/right keeps the many side whole, plus any labels it asked to
  // carry over from the one side.
  const out = dropName(manyMetric)
  for (const l of matching?.include || []) {
    if (oneMetric[l] !== undefined) out[l] = oneMetric[l]
  }
  return out
}

function evalSetOp(node, ctx, ts) {
  const { op, matching } = node
  const lhs = toVector(evalAt(node.lhs, ctx, ts), ts)
  const rhs = toVector(evalAt(node.rhs, ctx, ts), ts)
  const rhsKeys = new Map()
  for (const s of rhs) rhsKeys.set(matchingKey(s.metric, matching), s)

  if (op === 'and' || op === 'unless') {
    const wantMatch = op === 'and'
    const series = []
    for (const s of lhs) {
      const other = rhsKeys.get(matchingKey(s.metric, matching))
      if (!other) {
        if (wantMatch) continue
        series.push({ metric: dropName(s.metric), values: s.values.slice() })
        continue
      }
      const values = s.values.map((v, i) => {
        const present = Number.isFinite(other.values[i])
        return present === wantMatch ? v : NaN
      })
      series.push({ metric: dropName(s.metric), values })
    }
    return { kind: 'vector', series }
  }

  // `or` takes the left side, then any right-hand series the left never covered.
  const series = lhs.map(s => ({ metric: dropName(s.metric), values: s.values.slice() }))
  const seen = new Set(lhs.map(s => matchingKey(s.metric, matching)))
  for (const s of rhs) {
    if (!seen.has(matchingKey(s.metric, matching))) {
      series.push({ metric: dropName(s.metric), values: s.values.slice() })
    }
  }
  return { kind: 'vector', series }
}

// ---------------------------------------------------------------- labels

function dropName(metric) {
  const out = { ...metric }
  delete out[NAME]
  return out
}

function labelKey(metric) {
  return Object.keys(metric)
    .sort()
    .map(k => `${k}=${metric[k]}`)
    .join(',')
}
