// Client-side aggregation over an in-memory log stream. Given the current
// pipes and the filtered log rows, produces a shape the renderer can plot
// without knowing anything about pipe semantics: time-bucketed series +
// summary totals + a table of group rows.
//
// This is the mock counterpart to what the CubeAPM backend does when a
// stats/math query is submitted from Explore. Kept intentionally faithful
// to the docs so swapping to a real API surface is a one-liner.

// ---------- Stats function implementations ----------

function toNumber(v) {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function computeFn(fn, logs, getFieldValue) {
  const field = fn.field
  const raw = field ? logs.map(l => getFieldValue(l, field)) : []
  const nonEmpty = raw.filter(v => v != null && v !== '')
  const numbers = nonEmpty.map(toNumber).filter(n => n != null)
  switch (fn.fn) {
    case 'count':       return field ? nonEmpty.length : logs.length
    case 'count_empty': return field ? (logs.length - nonEmpty.length) : 0
    case 'count_uniq':  return new Set(nonEmpty.map(String)).size
    case 'avg':         return numbers.length ? numbers.reduce((a, b) => a + b, 0) / numbers.length : null
    case 'sum':         return numbers.length ? numbers.reduce((a, b) => a + b, 0) : null
    case 'min':         return numbers.length ? Math.min(...numbers) : null
    case 'max':         return numbers.length ? Math.max(...numbers) : null
    case 'median': {
      if (!numbers.length) return null
      const s = [...numbers].sort((a, b) => a - b)
      const m = Math.floor(s.length / 2)
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
    }
    case 'quantile': {
      if (!numbers.length) return null
      const p = Math.min(1, Math.max(0, Number(fn.p ?? 0.9)))
      const s = [...numbers].sort((a, b) => a - b)
      const idx = Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))
      return s[idx]
    }
    default: return null
  }
}

// Same policy the serializer uses for pill chip display, so labels
// stay in sync everywhere.
export function labelFn(fn) {
  if (fn.as) return fn.as
  if (fn.fn === 'quantile') return `q${Math.round((Number(fn.p) || 0.9) * 100)}(${fn.field || '·'})`
  if (fn.field) return `${fn.fn}(${fn.field})`
  return `${fn.fn}()`
}

// ---------- Safe expression evaluator for math pipes ----------

const SAFE_EXPR_RE = /^[\s\w+\-*/%.(){}]*$/

function evalMath(expression, vars) {
  const expr = (expression || '').trim()
  if (!expr) return null
  if (!SAFE_EXPR_RE.test(expr)) return null
  // Replace each identifier with either its variable value (as a number literal)
  // or leave numeric-like tokens alone. Unknown identifiers → NaN so the
  // series shows gaps but the expression still parses.
  const replaced = expr.replace(/\b([a-zA-Z_]\w*)\b/g, (m) => {
    if (Object.prototype.hasOwnProperty.call(vars, m)) {
      const v = vars[m]
      return v == null || !Number.isFinite(v) ? 'NaN' : String(v)
    }
    return 'NaN'
  })
  try {
    // eslint-disable-next-line no-new-func
    const val = Function('"use strict"; return (' + replaced + ')')()
    return Number.isFinite(val) ? val : null
  } catch {
    return null
  }
}

// ---------- Main aggregator ----------

export function aggregate({
  pipes,
  logs,               // pre-filtered rows (chips already applied)
  getFieldValue,      // (log, field) => value
  timeRange = 60 * 60 * 1000,   // window covered by the buckets, ms
  now = Date.now(),
  bucketCount = 30,
}) {
  const statsPipe = (pipes || []).find(p => p.kind === 'stats')
  if (!statsPipe || !statsPipe.functions?.length) {
    return { kind: 'empty', reason: 'no-stats', series: [], groups: [], buckets: [], filteredCount: logs.length }
  }
  const mathPipes = (pipes || []).filter(p => p.kind === 'math')
  const sortPipe = (pipes || []).find(p => p.kind === 'sort')
  const limitPipe = (pipes || []).find(p => p.kind === 'limit')

  const startMs = now - timeRange
  const bucketSize = timeRange / bucketCount
  const buckets = Array.from({ length: bucketCount }, (_, i) => startMs + i * bucketSize + bucketSize / 2)

  // Bucket + group logs
  const grouped = new Map()   // key: `${groupKey}|${bucketIdx}` → { groupValues, bucketIdx, logs }
  for (const log of logs) {
    const t = (log.time instanceof Date) ? log.time.getTime() : Number(log.time)
    if (!Number.isFinite(t) || t < startMs || t > now) continue
    const bucketIdx = Math.min(bucketCount - 1, Math.max(0, Math.floor((t - startMs) / bucketSize)))
    const groupValues = statsPipe.groupBy.map(f => {
      const v = getFieldValue(log, f)
      return v == null || v === '' ? '(unset)' : String(v)
    })
    const key = `${groupValues.join('\x00')}\x00\x00${bucketIdx}`
    if (!grouped.has(key)) grouped.set(key, { groupValues, bucketIdx, logs: [] })
    grouped.get(key).logs.push(log)
  }

  // Identify distinct group tuples (across all buckets)
  const groupTupleKey = (gv) => gv.join('\x00')
  const groupTuples = new Map()   // key: groupKey → groupValues
  for (const { groupValues } of grouped.values()) {
    const k = groupTupleKey(groupValues)
    if (!groupTuples.has(k)) groupTuples.set(k, groupValues)
  }
  const groupList = statsPipe.groupBy.length === 0
    ? [{ key: '__all__', values: [] }]
    : Array.from(groupTuples.entries()).map(([k, v]) => ({ key: k, values: v }))

  // Compute series: one per group-tuple × function (× math derived)
  const series = []
  for (const group of groupList) {
    // Per bucket, compute each function
    const bucketValuesByFn = {}   // fn.id → array of length bucketCount, values or null
    for (const fn of statsPipe.functions) {
      bucketValuesByFn[fn.id] = Array(bucketCount).fill(null)
    }
    for (let b = 0; b < bucketCount; b++) {
      const key = `${group.key === '__all__' ? '' : group.values.join('\x00')}\x00\x00${b}`
      const bucket = grouped.get(key)
      if (!bucket) continue
      for (const fn of statsPipe.functions) {
        bucketValuesByFn[fn.id][b] = computeFn(fn, bucket.logs, getFieldValue)
      }
    }
    // Emit one series per function
    for (const fn of statsPipe.functions) {
      series.push({
        key: `${group.key}::${fn.id}`,
        groupValues: group.values,
        groupLabel: group.values.length > 0 ? group.values.join(' · ') : null,
        fnKey: fn.id,
        fnLabel: labelFn(fn),
        alias: fn.as || null,
        kind: 'stats',
        data: buckets.map((t, i) => ({ t, v: bucketValuesByFn[fn.id][i] })),
      })
    }
    // Apply math pipes (evaluate against this group's per-bucket vars)
    for (const mp of mathPipes) {
      const vars = {}
      const points = []
      for (let b = 0; b < bucketCount; b++) {
        // Build a var scope from stats aliases + prior math series
        for (const fn of statsPipe.functions) {
          if (fn.as) vars[fn.as] = bucketValuesByFn[fn.id][b]
        }
        // Also include prior math results by name
        for (const priorMp of mathPipes) {
          if (priorMp === mp) break
          if (priorMp.as) {
            // Find the prior series for this group and read its bucket value
            const prior = series.find(s => s.groupValues.join('\x00') === group.values.join('\x00') && s.alias === priorMp.as)
            vars[priorMp.as] = prior?.data[b]?.v ?? null
          }
        }
        const v = evalMath(mp.expression, vars)
        points.push({ t: buckets[b], v })
      }
      series.push({
        key: `${group.key}::math::${mp.id}`,
        groupValues: group.values,
        groupLabel: group.values.length > 0 ? group.values.join(' · ') : null,
        fnKey: `math::${mp.id}`,
        fnLabel: mp.as || mp.expression || 'math',
        alias: mp.as || null,
        kind: 'math',
        data: points,
      })
    }
  }

  // Compute total per series (used for sort/limit/table ordering)
  const seriesWithTotal = series.map(s => {
    const nums = s.data.map(d => d.v).filter(v => v != null && Number.isFinite(v))
    const total = nums.reduce((a, b) => a + b, 0)
    const peak = nums.length ? Math.max(...nums) : 0
    const last = [...s.data].reverse().find(d => d.v != null && Number.isFinite(d.v))?.v ?? null
    return { ...s, total, peak, last }
  })

  // Sort: if a sort pipe references an alias, sort GROUPS by that alias's
   // total across the series list; else keep insertion order.
  let ordered = seriesWithTotal
  if (sortPipe && sortPipe.field) {
    const targetAlias = sortPipe.field
    const groupScore = new Map()
    for (const s of seriesWithTotal) {
      if (s.alias === targetAlias) {
        groupScore.set(s.groupValues.join('\x00'), s.total)
      }
    }
    const dir = sortPipe.dir === 'asc' ? 1 : -1
    ordered = [...seriesWithTotal].sort((a, b) => {
      const sa = groupScore.get(a.groupValues.join('\x00')) ?? 0
      const sb = groupScore.get(b.groupValues.join('\x00')) ?? 0
      return (sa - sb) * dir
    })
  }

  // Limit: cap the DISTINCT groups (not series) shown, keeping every function
   // for the kept groups so the chart stays meaningful.
  if (limitPipe && Number.isFinite(limitPipe.n) && groupList.length > limitPipe.n) {
    const seenGroups = new Set()
    const keptGroups = new Set()
    for (const s of ordered) {
      const k = s.groupValues.join('\x00')
      if (!keptGroups.has(k)) {
        if (keptGroups.size < limitPipe.n) keptGroups.add(k)
      }
      seenGroups.add(k)
    }
    ordered = ordered.filter(s => keptGroups.has(s.groupValues.join('\x00')))
  }

  return {
    kind: ordered.length ? 'ok' : 'empty',
    reason: ordered.length ? null : 'no-data',
    series: ordered,
    groups: groupList,
    buckets,
    filteredCount: logs.length,
    statsPipe,
    sortPipe,
    limitPipe,
    mathPipes,
  }
}
