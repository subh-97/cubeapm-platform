// A rule's condition: how production stores it, how our two named tiers map
// onto that, and how a condition becomes pending and firing stretches over time
// (docs/alerts/DESIGN.md D7; reference §6.3 "Saved expression format").
//
// Storage is production's, exactly, so a rule saved here reads back there:
//
//   Metrics:               (<query>) <op> <threshold>
//   Logs, Traces, Mobile:  <query> as result | filter result: <op> <threshold>
//
// with `==` written `=` in the LogsQL form. An anomaly rule stores the same
// shapes with `>`, `<` or `<>` and its deviation factor as the number. The
// critical tier is a second expression, `query2`, over the same query.
//
// Our editor shows two tiers instead of "condition + additional condition":
//
//   rows filled      stored as
//   Warning only     query = warning
//   Critical only    query = critical, and the tag severity=critical
//   both             query = warning, query2 = critical
//
// `tiersOf` and `expressionsFor` are that mapping in each direction, and they
// round-trip.

import { STATIC_OPERATORS, ANOMALY_OPERATORS } from './catalog.js'

const LOGS_FAMILY = new Set(['vlogs', 'traces', 'mobile'])
const isLogsFamily = datasource => LOGS_FAMILY.has(datasource)

const NUM = '(-?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?)'
const OP = '(==|!=|>=|<=|<>|=|>|<)'
const METRIC_TAIL = new RegExp(`^([\\s\\S]*?)\\s*${OP}\\s*${NUM}\\s*$`)
const LOGS_TAIL = new RegExp(`^([\\s\\S]*?)\\s+as\\s+result\\s*\\|\\s*filter\\s+result:\\s*${OP}\\s*${NUM}\\s*$`)

// Whether `s` is one parenthesised group from its first character to its last,
// so `(a) / (b)` is not mistaken for `(a / b)` and stripped to `a) / (b`.
function wrappedInOneGroup(s) {
  if (!s.startsWith('(') || !s.endsWith(')')) return false
  let depth = 0
  let quote = null
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') quote = c
    else if (c === '(') depth++
    else if (c === ')' && --depth === 0 && i < s.length - 1) return false
  }
  return depth === 0
}

/**
 * A stored expression → `{ query, op, threshold }`. An expression with no
 * trailing condition comes back whole with a null op, rather than misread.
 */
export function splitCondition(expr, datasource = 'prometheus') {
  const text = String(expr ?? '').trim()
  const m = (isLogsFamily(datasource) ? LOGS_TAIL : METRIC_TAIL).exec(text)
  if (!m) return { query: text, op: null, threshold: null }
  let query = m[1].trim()
  if (!isLogsFamily(datasource) && wrappedInOneGroup(query)) query = query.slice(1, -1).trim()
  const op = m[2] === '=' ? '==' : m[2]
  return { query, op, threshold: Number(m[3]) }
}

/** `{ query, op, threshold }` → the stored expression, in production's format. */
export function joinCondition(query, op, threshold, datasource = 'prometheus') {
  const q = String(query ?? '').trim()
  if (isLogsFamily(datasource)) return `${q} as result | filter result: ${op === '==' ? '=' : op} ${threshold}`
  // A query whose last line is a `#` comment would swallow the closing paren.
  const lastLine = q.split('\n').pop()
  return `(${q}${lastLine.includes('#') ? '\n' : ''}) ${op} ${threshold}`
}

const tierOf = (cond, kind) => (cond.op == null ? null
  : kind === 'anomaly' ? { op: cond.op, deviations: cond.threshold } : { op: cond.op, threshold: cond.threshold })

/**
 * A rule (production's read shape) → its two tiers. `query` is the rule's
 * query without any condition. A tier is `{ op, threshold }`, or for an
 * anomaly rule `{ op, deviations }`, or null when not set.
 */
export function tiersOf(rule) {
  const kind = rule?.kind === 'anomaly' ? 'anomaly' : 'static'
  const datasource = rule?.datasource ?? 'prometheus'
  const base = splitCondition(rule?.query, datasource)
  const second = rule?.query2 ? splitCondition(rule.query2, datasource) : null
  const baseTier = tierOf(base, kind)
  const criticalOnly = !second && rule?.labels?.severity === 'critical'
  return {
    kind,
    query: base.query,
    warning: criticalOnly ? null : baseTier,
    critical: criticalOnly ? baseTier : second ? tierOf(second, kind) : null,
  }
}

const tierNumber = tier => (tier ? (tier.deviations ?? tier.threshold) : null)

/**
 * The editor's tiers → what production stores: `{ query, query2, labels }`.
 * `labels` is the rule's labels with `severity` managed by the tiers: set to
 * critical when the critical tier stands alone, and a stale severity=critical
 * removed otherwise — left on a two-tier rule it would mark its warnings
 * critical too.
 */
export function expressionsFor({ datasource = 'prometheus', query, warning, critical, labels = {} }) {
  const next = { ...labels }
  if (next.severity === 'critical') delete next.severity
  const join = tier => joinCondition(query, tier.op, tierNumber(tier), datasource)
  if (warning && critical) return { query: join(warning), query2: join(critical), labels: next }
  if (critical) return { query: join(critical), query2: '', labels: { ...next, severity: 'critical' } }
  if (warning) return { query: join(warning), query2: '', labels: next }
  return { query: String(query ?? '').trim(), query2: '', labels: next }
}

const STATIC_TEST = {
  '>': (v, t) => v > t,
  '<': (v, t) => v < t,
  '>=': (v, t) => v >= t,
  '<=': (v, t) => v <= t,
  '==': (v, t) => v === t,
  '!=': (v, t) => v !== t,
}

/** Whether `value` satisfies a static tier. No reading satisfies nothing. */
export function holds(tier, value) {
  if (!tier || value == null || !Number.isFinite(value)) return false
  return STATIC_TEST[tier.op]?.(value, tier.threshold) ?? false
}

/**
 * Whether `value` is outside the expected range by an anomaly tier's
 * deviations: above `expected + k·σ`, below `expected − k·σ`, or either.
 */
export function holdsAnomaly(tier, value, expected, sigma) {
  if (!tier || [value, expected, sigma].some(x => x == null || !Number.isFinite(x))) return false
  const k = tier.deviations
  const above = value > expected + k * sigma
  const below = value < expected - k * sigma
  return tier.op === '>' ? above : tier.op === '<' ? below : above || below
}

/** Every operator a tier can hold, for validation. */
export const TIER_OPERATORS = {
  static: STATIC_OPERATORS.map(o => o.op),
  anomaly: ANOMALY_OPERATORS.map(o => o.op),
}

/**
 * Prometheus' alerting state machine, run over evaluation ticks.
 *
 * Every `every` seconds from `from` to `to` (both on that grid), the condition
 * is asked once. The first tick it holds, an alert becomes pending; once it has
 * held for `forSec` it fires — at once if `forSec` is 0. The first tick it does
 * not hold, the alert resolves. `holdsAt(t)` returning null (no data) resolves
 * it too: an alert cannot stay firing on a series that stopped reporting.
 *
 * Returns the stretches in time order, `{ state: 'pending'|'firing', start,
 * end }`, in unix seconds. `end` is null for a stretch still open at `to`.
 * `openStart` marks a stretch already active at `from` — its true start is
 * earlier than this run looked.
 */
export function stateIntervals({ from, to, every, forSec = 0, holdsAt }) {
  const out = []
  let activeAt = null
  let firingAt = null
  const close = t => {
    if (activeAt == null) return
    if (firingAt == null) out.push({ state: 'pending', start: activeAt, end: t })
    else {
      if (firingAt > activeAt) out.push({ state: 'pending', start: activeAt, end: firingAt })
      out.push({ state: 'firing', start: firingAt, end: t })
    }
    activeAt = null
    firingAt = null
  }
  for (let t = from; t <= to; t += every) {
    if (holdsAt(t) === true) {
      if (activeAt == null) activeAt = t
      if (firingAt == null && t - activeAt >= forSec) firingAt = t
    } else {
      close(t)
    }
  }
  close(null)
  if (out.length && out[0].start === from) out[0].openStart = true
  // A firing stretch that follows its own pending stretch began at the same
  // activation; it is open-started only if that pending one was.
  if (out.length > 1 && out[0].openStart && out[0].state === 'pending' && out[1].start === out[0].end && out[1].state === 'firing') out[1].openStart = true
  return out
}

/**
 * Several tiers' stretches merged into one: at every moment the worst of what
 * is active — firing critical over firing warning over pending. Each input
 * carries the severity its tier fires at; a stretch that carries its own (an
 * already-merged series, when a rule's series are merged into its lane) keeps
 * it. A change of tier mid-incident starts a new stretch at that instant;
 * nothing in between is lost or doubled.
 *
 * A sweep over the edges, so a flapping rule's thousands of stretches cost
 * their sort and nothing more; one tier is passed straight through.
 */
export function mergeTierIntervals(byTier) {
  const tiers = byTier.filter(t => t.intervals.length)
  const sevOf = (iv, severity) => (iv.state === 'firing' ? iv.severity ?? severity ?? 'warning' : null)
  const tag = (iv, severity) => ({
    state: iv.state,
    severity: sevOf(iv, severity),
    start: iv.start,
    end: iv.end,
    ...(iv.openStart ? { openStart: true } : null),
  })
  if (tiers.length === 0) return []
  if (tiers.length === 1) return tiers[0].intervals.map(iv => tag(iv, tiers[0].severity))

  const events = []
  for (const { severity, intervals } of tiers) {
    for (const iv of intervals) {
      const cat = iv.state === 'pending' ? 'pending' : sevOf(iv, severity) === 'critical' ? 'critical' : 'warning'
      events.push({ t: iv.start, d: 1, cat, openStart: !!iv.openStart })
      if (iv.end != null) events.push({ t: iv.end, d: -1, cat })
    }
  }
  events.sort((a, b) => a.t - b.t)

  const active = { pending: 0, warning: 0, critical: 0 }
  const out = []
  for (let i = 0; i < events.length;) {
    const t = events[i].t
    let openStart = false
    // Every edge at one instant is applied before the state there is read, so
    // a warning ending as a critical starts is one hand-over, not a gap.
    for (; i < events.length && events[i].t === t; i++) {
      active[events[i].cat] += events[i].d
      if (events[i].d > 0 && events[i].openStart) openStart = true
    }
    const now = active.critical > 0 ? { state: 'firing', severity: 'critical' }
      : active.warning > 0 ? { state: 'firing', severity: 'warning' }
        : active.pending > 0 ? { state: 'pending', severity: null } : null
    const prev = out[out.length - 1]
    const prevOpen = prev && prev.end == null
    if (prevOpen && now && prev.state === now.state && prev.severity === now.severity) continue
    if (prevOpen) prev.end = t
    if (now) out.push({ ...now, start: t, end: null, ...(openStart ? { openStart: true } : null) })
  }
  return out
}

/**
 * The editor's backtest (D7): where a condition would have fired over a
 * series, honouring Fire after, and how much of the range that is.
 *
 * `points` are `{ t, value }` in time order on the evaluation grid; `tiers`
 * are static tiers. Returns the merged stretches, the number of incidents
 * (distinct firing stretches), the seconds spent firing, and that as a share
 * of the span the points cover.
 */
export function backtest(points, { warning = null, critical = null, forSec = 0 } = {}) {
  const pts = points.filter(p => p && Number.isFinite(p.t))
  if (pts.length === 0) return { intervals: [], incidents: 0, firingSec: 0, share: 0 }
  const every = pts.length > 1 ? pts[1].t - pts[0].t : 60
  const valueAt = new Map(pts.map(p => [p.t, p.value]))
  const from = pts[0].t
  const to = pts[pts.length - 1].t
  const run = tier => stateIntervals({ from, to, every, forSec, holdsAt: t => (valueAt.get(t) == null ? null : holds(tier, valueAt.get(t))) })
  const byTier = [
    ...(warning ? [{ severity: 'warning', intervals: run(warning) }] : []),
    ...(critical ? [{ severity: 'critical', intervals: run(critical) }] : []),
  ]
  const intervals = mergeTierIntervals(byTier)
  const end = to + every
  let firingSec = 0
  let incidents = 0
  let prevFiringEnd = null
  for (const iv of intervals) {
    if (iv.state !== 'firing') continue
    firingSec += (iv.end ?? end) - iv.start
    // A warning stretch running straight into a critical one is one incident.
    if (prevFiringEnd !== iv.start) incidents++
    prevFiringEnd = iv.end
  }
  return { intervals, incidents, firingSec, share: firingSec / (end - from) }
}

// 1, 2, 2.5 or 5 times a power of ten: a threshold someone would write.
function niceUp(x) {
  if (!(x > 0)) return x
  const p = 10 ** Math.floor(Math.log10(x))
  return [1, 2, 2.5, 5, 10].map(m => m * p).find(v => v >= x * 0.9999)
}

/**
 * A threshold the series would rarely cross: its 95th percentile for an
 * upper bound, its 5th for a lower one, rounded to a figure someone would type.
 * What the editor offers when a draft threshold would fire most of the time.
 * Null for equality operators, and for a series with nothing in it.
 */
export function suggestThreshold(values, op = '>') {
  const v = values.filter(x => x != null && Number.isFinite(x)).sort((a, b) => a - b)
  if (!v.length || op === '==' || op === '!=') return null
  const upper = op === '>' || op === '>='
  const q = v[Math.min(v.length - 1, Math.max(0, Math.round((upper ? 0.95 : 0.05) * (v.length - 1))))]
  if (!upper) {
    const p = q > 0 ? 10 ** Math.floor(Math.log10(q)) : 1
    return Math.floor(q / p * 2) / 2 * p
  }
  return niceUp(q)
}
