// A rule as the page shows it (docs/alerts/DESIGN.md D1, D3, D18): production's
// read shape in, a view out. Everything a list row, the expanded panel, the rule
// page and the editor need to say about a rule, derived once here so they all
// say the same thing.
//
// `ruleView(rule, ctx)` reads an EVALUATED rule (data/alerts.js evaluateRules:
// state, health, alerts[], seriesCount) and a context:
//
//   ctx = { receiverGroups, muteGroups, silences, monitors, slos,
//           slackChannels, opsgenieTeams, history, nowSec }
//
// where `history` is that rule's history (data/alerts.js ruleHistory), read for
// how long it has been in its state. Times are unix seconds throughout.

import { alertStateKey, statusForAlertState } from '@/utils/status'
import { tiersOf } from './condition.js'
import { datasourceId, DEFAULT_GROUP, RESERVED_TAG_KEYS } from './catalog.js'
import {
  effectiveReceivers, ruleContactPoints, receiverSummary, sendsResolved,
  ruleMuteIntervals, ruleSilences, muteCovering,
} from './routing.js'

/**
 * The order rules sort in, worst first (D1, CLAUDE.md rule 3). A firing alert
 * whose notifications are snoozed or muted sorts after the unsuppressed firing
 * ones and the rules that cannot evaluate — it is acknowledged, not resolved.
 * Pending outranks OK, which `worstStatus` cannot say (it ranks healthy above
 * info), so the order lives here.
 */
export const ALERT_ORDER = ['critical', 'warning', 'pending', 'error', 'suppressed', 'ok', 'nodata', 'paused']
const RANK = new Map(ALERT_ORDER.map((k, i) => [k, i]))

// Every label="value" in a query's selectors, in order. Scans rather than
// parses: production's own demo rule writes `(x default 0)[5m]`, a MetricsQL
// rollup our Explore parser does not read, and a rule's scope must not depend on
// whether its query is one Explore can run. LogsQL's `field:="value"` filters
// are read too.
function matchersIn(query) {
  const out = []
  const q = String(query ?? '')
  for (const [, body] of q.matchAll(/\{([^{}]*)\}/g)) {
    for (const m of body.matchAll(/("?)([A-Za-z_][\w.]*)\1\s*(=~|!~|!=|=)\s*"((?:[^"\\]|\\.)*)"/g)) {
      out.push({ label: m[2], op: m[3], value: m[4] })
    }
  }
  for (const m of q.matchAll(/(?:^|[\s(])([A-Za-z_][\w.]*):=\s*"((?:[^"\\]|\\.)*)"/g)) out.push({ label: m[1], op: '=', value: m[2] })
  return out
}

const eqFrom = (pairs, label) => pairs.find(p => p.label === label && p.op === '=')?.value ?? null

/**
 * What a rule is about: `{ service, endpoint, host }`, any of them null. Read
 * from its Quick model when it has one, else from its query's matchers —
 * derived, never stored (signed off as Q7). A rule that names no service is
 * listed under "No service".
 */
export function ruleScope(rule, slos = []) {
  const sloId = rule?.labels?.slo_id
  if (sloId) {
    const slo = slos.find(s => String(s.id) === String(sloId))
    if (slo) return { service: slo.service, endpoint: slo.endpoint, host: null }
  }
  const model = rule?.config?.model
  if (model?.type === 'quick') {
    const pairs = (model.labelPairs ?? []).map(p => ({ label: p.label, op: p.operator, value: p.values?.[0] }))
    return { service: eqFrom(pairs, 'service'), endpoint: eqFrom(pairs, 'root_name'), host: eqFrom(pairs, 'host.name') }
  }
  const pairs = matchersIn(tiersOf(rule).query)
  return { service: eqFrom(pairs, 'service'), endpoint: eqFrom(pairs, 'root_name'), host: eqFrom(pairs, 'host.name') }
}

const QUICK_METRIC = {
  error_percentage: () => ({ metric: 'Error %', unit: '%' }),
  latency_percentile: m => ({ metric: `p${m.value ?? 90} latency`, unit: 'ms' }),
  latency_average: () => ({ metric: 'Avg latency', unit: 'ms' }),
  rpm: () => ({ metric: 'RPM', unit: 'rpm' }),
}

/**
 * What a rule measures, in words, and the unit its threshold is in: "Error %"
 * and %, "p90 latency" and ms, "CPU" and %, "Log count". From the Quick model
 * when there is one; otherwise recognised in the query; "Value" when neither
 * says.
 */
export function ruleMetric(rule) {
  const model = rule?.config?.model
  if (model?.type === 'quick' && QUICK_METRIC[model.calculate]) return QUICK_METRIC[model.calculate](model)
  const ds = datasourceId(rule?.datasource)
  const q = tiersOf(rule).query
  // A count, grouped or not: "stats count()" and "stats by (service) count()".
  const counted = /stats\s+(?:by\s*\([^)]*\)\s*)?count\(\)/.test(q)
  // Kubernetes events arrive in the log stream, but they are events, not log lines.
  if (ds === 'logs' && /event\.domain:=\s*"k8s"/.test(q)) return { metric: counted ? 'K8s event count' : 'K8s events', unit: 'count' }
  if (ds === 'logs') return { metric: counted ? 'Log count' : 'Logs', unit: 'count' }
  if (ds === 'traces') return { metric: counted ? 'Span count' : 'Spans', unit: 'count' }
  if (ds === 'mobile') return { metric: 'Requests', unit: 'count' }
  const ms = /\*\s*1000\b/.test(q)
  const pq = /histogram_quantile\(\s*([\d.]+)/.exec(q)
  if (/cube_synthetic_monitor\b/.test(q)) return { metric: 'Monitor up', unit: null }
  if (/slo_error_budget_burn_rate\b/.test(q)) return { metric: 'Burn rate', unit: 'x' }
  if (/cube_apm_errors_total\b/.test(q)) {
    // "JedisPoolException rate" when the rule watches one exception class.
    const exception = /exception\s*=\s*"([^"]+)"/.exec(q)?.[1]
    return { metric: exception ? `${exception.split('.').pop()} rate` : 'Error rate', unit: /\*\s*60\b/.test(q) ? '/min' : null }
  }
  if (/status_code\s*=\s*"ERROR"/.test(q) && /\*\s*100\b/.test(q)) return { metric: 'Error %', unit: '%' }
  if (pq) return { metric: `p${Math.round(Number(pq[1]) * 1000) / 10} latency`, unit: ms ? 'ms' : 's' }
  if (/cube_apm_latency_total\b/.test(q)) return { metric: 'Avg latency', unit: ms ? 'ms' : 's' }
  if (/cube_apm_calls_total\b/.test(q) && /\*\s*60\b/.test(q)) return { metric: 'RPM', unit: 'rpm' }
  if (/system_cpu_utilization\b/.test(q)) return { metric: 'CPU', unit: '%' }
  if (/redis_memory_used_bytes\b/.test(q)) return { metric: 'Memory', unit: /\/\s*1e6\b/.test(q) ? 'MB' : null }
  // The templates' own measures (ruleTemplates.js), so a rule made from one
  // reads as what it watches rather than as "Value".
  if (/\boffset\s+1h\b/.test(q) && /system_memory_usage_bytes\b/.test(q)) return { metric: 'Memory vs an hour ago', unit: '%' }
  if (/\boffset\s+1h\b/.test(q) && /cube_apm_calls_total\b/.test(q)) return { metric: 'Calls vs an hour ago', unit: '%' }
  if (/redis_connected_clients\b/.test(q)) return { metric: 'Redis clients', unit: null }
  if (/mysql_threads_connected\b/.test(q)) return { metric: 'MySQL threads', unit: null }
  if (/k8s_pod_cpu_utilization\b/.test(q)) return { metric: 'Pod CPU', unit: '%' }
  if (/kube_pod_container_status_restarts_total\b/.test(q)) return { metric: 'Restarts', unit: null }
  if (/kube_node_status_condition\b/.test(q)) return { metric: 'Node ready', unit: null }
  return { metric: 'Value', unit: null }
}

/**
 * Who manages a rule other than its author (D18): a synthetic monitor or an
 * SLO, or null.
 */
export function ruleManagedBy(rule, { monitors = [], slos = [] } = {}) {
  const l = rule?.labels ?? {}
  if (l.slo_id) {
    const slo = slos.find(s => String(s.id) === String(l.slo_id))
    return { kind: 'slo', sloId: Number(l.slo_id), service: slo?.service ?? null, endpoint: slo?.endpoint ?? null, objective: l.objective ?? 'error', speed: l.speed ?? null }
  }
  if (l.kind === 'synthetic') {
    const id = Number(/cube_synthetic_monitor\{id="(\d+)"\}/.exec(rule?.query ?? '')?.[1])
    const m = monitors.find(x => x.id === id)
    return { kind: 'synthetic', monitorId: Number.isFinite(id) ? id : null, monitorName: m?.name ?? null }
  }
  return null
}

// The labels that tell a rule's series apart: everything an alert carries that
// the rule itself put there, removed.
const RULE_LABELS = new Set(['alertname', 'group', 'query', 'rule_id', 'severity', 'alertgroup'])
const seriesLabels = labels => Object.fromEntries(Object.entries(labels ?? {}).filter(([k]) => !RULE_LABELS.has(k)))
const seriesKey = labels => JSON.stringify(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)))
const secOf = isoText => {
  const t = Date.parse(isoText)
  return Number.isFinite(t) && !String(isoText).startsWith('0001') ? Math.floor(t / 1000) : null
}

// A rule's alerts, one per series, each at its worst tier: firing critical over
// firing warning over pending. Production lists one alert per series per tier.
const instanceRank = i => (i.state === 'firing' ? (i.severity === 'critical' ? 0 : 1) : 2)
const earliest = (a, b) => (a == null ? b ?? null : b == null ? a : Math.min(a, b))

function instancesOf(rule) {
  const bySeries = new Map()
  for (const a of rule?.alerts ?? []) {
    const labels = seriesLabels(a.labels)
    const key = seriesKey(labels)
    const severity = a.state === 'firing' ? (a.labels?.severity === 'critical' ? 'critical' : 'warning') : null
    const inst = {
      id: a.id,
      key,
      labels,
      name: a.name,
      state: a.state,
      severity,
      value: a.value === '' || a.value == null ? null : Number(a.value),
      activeAt: secOf(a.activeAt),
      firingAt: a.firingAt ?? null,
      openStart: !!a.openStart,
    }
    const prev = bySeries.get(key)
    // The series became active with its first tier and has fired since its
    // first tier fired, as its rule counts (sinceOf): a warning that escalated
    // counts from the warning. The worst tier says how bad.
    const merged = prev && {
      activeAt: earliest(prev.activeAt, inst.activeAt),
      firingAt: earliest(prev.firingAt, inst.firingAt),
      openStart: prev.openStart || inst.openStart,
    }
    if (!prev || instanceRank(inst) < instanceRank(prev)) bySeries.set(key, prev ? { ...inst, ...merged } : inst)
    else Object.assign(prev, merged)
  }
  return [...bySeries.values()].sort((a, b) => instanceRank(a) - instanceRank(b) || (b.value ?? -Infinity) - (a.value ?? -Infinity))
}

// How far a reading is past the tier it crossed: 14.2% against 3% is 4.7×; a
// "less than" tier reads the other way. Null for anomaly rules, whose
// threshold is not in the reading's unit.
function multipleOf(value, tier, kind) {
  if (kind === 'anomaly' || !tier || value == null || !Number.isFinite(value)) return null
  const t = tier.threshold
  if (!(t > 0) || !(value > 0)) return null
  if (tier.op === '>' || tier.op === '>=') return value / t
  if (tier.op === '<' || tier.op === '<=') return t / value
  return null
}

// When the rule entered its current state, from its lane: the start of the
// incident it is in (a warning that escalated counts from the warning), the
// start of its pending stretch, or the end of its last activity. `open` says
// that start is earlier than the history reaches.
function sinceOf(state, history) {
  const ivs = history?.intervals ?? []
  const last = ivs[ivs.length - 1]
  if (state === 'firing' || state === 'pending') {
    if (!last || last.end != null) return { since: null, open: false }
    let i = ivs.length - 1
    if (state === 'firing') {
      while (i > 0 && ivs[i - 1].state === 'firing' && ivs[i - 1].end === ivs[i].start) i--
    }
    return { since: ivs[i].start, open: !!ivs[i].openStart }
  }
  if (state === 'ok') {
    if (last?.end != null) return { since: last.end, open: false }
    return history ? { since: history.from, open: true } : { since: null, open: false }
  }
  return { since: null, open: false }
}

/**
 * The view of one evaluated rule. See the header for `ctx`.
 */
export function ruleView(rule, ctx = {}) {
  const nowSec = ctx.nowSec ?? Math.floor(Date.now() / 1000)
  const tiers = tiersOf(rule)
  const instances = instancesOf(rule)
  const firing = instances.filter(i => i.state === 'firing')

  let state
  if (rule.status === 'PAUSED') state = 'paused'
  else if (rule.health && rule.health !== 'ok') state = 'error'
  else if (rule.seriesCount === 0) state = 'nodata'
  else if (firing.length) state = 'firing'
  else if (instances.length) state = 'pending'
  else state = 'ok'
  const severity = state === 'firing' ? (firing.some(i => i.severity === 'critical') ? 'critical' : 'warning') : null

  // What is holding notifications back now: an active snooze first, then a
  // mute window. A scheduled snooze is listed but does not hold anything yet.
  const snoozes = ruleSilences(rule, ctx.silences ?? [], nowSec)
    .filter(s => s.state !== 'expired')
    .map(s => ({ silenceId: s.silence.id, startsAt: s.start, endsAt: s.end, scheduled: s.state === 'pending', comment: s.silence.comment ?? '', createdBy: s.silence.createdBy ?? '' }))
  const activeSnooze = snoozes.find(s => !s.scheduled)
  const mutes = ruleMuteIntervals(rule, ctx.muteGroups ?? [])
  const covering = mutes.map(m => ({ m, w: muteCovering(m.interval, nowSec) })).find(x => x.w)
  const suppression = activeSnooze
    ? { kind: 'snooze', ...activeSnooze }
    : covering
      ? { kind: 'mute', scheduleId: covering.m.scheduleId, name: covering.m.name, until: covering.w.end }
      : null

  const stateKey = alertStateKey(state, severity)
  const rankKey = state === 'firing' && suppression ? 'suppressed' : stateKey
  const managedBy = ruleManagedBy(rule, ctx)
  const { metric, unit } = ruleMetric(rule)
  const lookups = { slackChannels: ctx.slackChannels, opsgenieTeams: ctx.opsgenieTeams }
  const receivers = effectiveReceivers(rule, ctx.receiverGroups ?? []).map(r => ({
    type: r.type,
    configs: r.configs,
    ...receiverSummary(r, lookups),
    oneOff: r.oneOff,
    groupId: r.groupId,
    groupName: r.groupName,
    sendResolved: sendsResolved(r),
  }))
  const primary = instances[0] ?? null
  const crossed = primary?.severity === 'critical' ? tiers.critical : tiers.warning ?? tiers.critical
  const { since, open } = sinceOf(state, ctx.history)

  return {
    id: rule.id,
    name: rule.name,
    group: rule.labels?.group || DEFAULT_GROUP,
    datasource: datasourceId(rule.datasource),
    kind: rule.kind === 'anomaly' ? 'anomaly' : 'static',
    status: rule.status === 'PAUSED' ? 'PAUSED' : 'ACTIVE',
    state,
    severity,
    stateKey,
    tone: statusForAlertState(state, severity),
    rank: RANK.get(rankKey) ?? RANK.get('nodata'),
    suppression,
    snoozes,
    managedBy,
    // Not editable here: an SLO's rules, and production's config-file rules.
    // Never a reason to refuse a snooze, which holds notifications by rule_id
    // and changes nothing the owner set (D18).
    readonly: !!rule.readonly || managedBy?.kind === 'slo',
    permission: rule.permission ?? 'admin',
    scope: ruleScope(rule, ctx.slos ?? []),
    metric,
    unit,
    tiers: { warning: tiers.warning, critical: tiers.critical },
    // The highest tier the rule defines, whatever its state (the Severity facet).
    definedSeverity: tiers.critical ? 'critical' : 'warning',
    intervalSec: Number(rule.interval) || 60,
    forSec: Number(rule.duration) || 0,
    repeatSec: Number(rule.repeatInterval) || 14400,
    groupingDisable: !!rule.groupingDisable,
    receivers,
    contactPoints: ruleContactPoints(rule, ctx.receiverGroups ?? []),
    muteSchedules: (rule.config?.mute_group_ids ?? []).map(id => (ctx.muteGroups ?? []).find(g => g.id === id)).filter(Boolean).map(g => ({ id: g.id, name: g.name })),
    inlineMutes: rule.mute?.time_intervals ?? [],
    tags: Object.fromEntries(Object.entries(rule.labels ?? {}).filter(([k]) => !RESERVED_TAG_KEYS.includes(k) && k !== 'severity')),
    annotations: {
      summary: rule.annotations?.summary ?? null,
      description: rule.annotations?.description ?? null,
      runbook_url: rule.annotations?.runbook_url ?? null,
    },
    instances,
    value: primary?.value ?? null,
    thresholdMultiple: primary ? multipleOf(primary.value, crossed, rule.kind) : null,
    since,
    sinceOpen: open,
    lastEvaluation: secOf(rule.lastEvaluation),
    lastError: rule.lastError || null,
    query: rule.query,
    query2: rule.query2 ?? '',
    baseQuery: tiers.query,
    model: rule.config?.model ?? null,
    rule,
  }
}

/** Worst first (ALERT_ORDER), then by name. */
export function sortRules(views) {
  return [...views].sort((a, b) => a.rank - b.rank || String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' }))
}

const NO_SERVICE = 'No service'

/**
 * Views grouped for the list (D3) by their group: the folder a person put the
 * rule in (production's grouping), never one derived from its service or its
 * contact points. Groups sort by their worst rule, then by how many fire, then
 * by name — never alphabetically first (CLAUDE.md rule 3); rules within a
 * group sort the same way. Each group: `{ key, label, rules, firing, worst, counts }`.
 */
export function groupRules(views) {
  const groups = new Map()
  const add = (key, label, view) => {
    if (!groups.has(key)) groups.set(key, { key, label, rules: [] })
    groups.get(key).rules.push(view)
  }
  for (const v of views) add(v.group, v.group, v)
  return [...groups.values()]
    .map(g => {
      const rules = sortRules(g.rules)
      return { ...g, rules, firing: rules.filter(r => r.state === 'firing').length, worst: ALERT_ORDER[rules[0]?.rank] ?? 'ok', counts: countRules(rules) }
    })
    .sort((a, b) => RANK.get(a.worst) - RANK.get(b.worst) || b.firing - a.firing || a.label.localeCompare(b.label))
}

/**
 * The summary strip's counts (D2). Snoozed or muted rules that are firing count
 * once, as suppressed, not under their severity as well.
 */
export function countRules(views) {
  const c = { critical: 0, warning: 0, pending: 0, error: 0, suppressed: 0, ok: 0, nodata: 0, paused: 0, firing: 0, total: views.length }
  for (const v of views) {
    const key = ALERT_ORDER[v.rank] ?? 'nodata'
    c[key]++
    if (v.state === 'firing') c.firing++
  }
  return c
}

/**
 * A view's values for every facet key the URL knows (utils/alertsUrl.js), so
 * the rail, the filter and the link all read a rule the same way.
 */
export function ruleFacets(v) {
  const notifies = v.contactPoints.map(c => c.name)
  if (v.receivers.some(r => r.oneOff)) notifies.push('One-off destinations')
  return {
    state: [v.stateKey].filter(Boolean),
    severity: [v.definedSeverity],
    group: [v.group],
    svc: [v.scope?.service ?? NO_SERVICE],
    source: [v.managedBy?.kind === 'synthetic' ? 'synthetic' : v.managedBy?.kind === 'slo' ? 'slo' : v.datasource],
    type: [v.kind],
    notifies: notifies.length ? notifies : ['Nobody notified'],
    suppressed: v.suppression ? [v.suppression.kind === 'snooze' ? 'snoozed' : 'muted'] : [],
    status: [v.status === 'PAUSED' ? 'paused' : 'active'],
  }
}
