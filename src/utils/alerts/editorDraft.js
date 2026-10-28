// The rule editor's state (docs/alerts/DESIGN.md D6–D10): one draft that New,
// Edit and Clone share. It is built from a stored rule or from what an entry
// point hands over, turned back into production's read shape to preview and to
// save, and checked field by field, so a disabled Save can say what is missing
// (reference R22) instead of just greying out.
//
// What the draft holds that a stored rule does not:
//
//   · A query per datasource, in Explore's editor shape, so switching from
//     Metrics to Logs and back loses neither (production keeps a draft per
//     datasource too). Only the showing one is saved.
//   · Thresholds per kind, so switching Static → Anomaly → Static gets the
//     static thresholds back, and loading an anomaly rule never resets its
//     direction (R30).
//   · Thresholds as the text typed, so "0." mid-keystroke is not rounded away.
//
// Everything else is production's field, under our name.

import {
  buildQuickQuery, buildAdvancedQuery, buildLogsqlQuery, defaultAdvancedModel, emptyPair, newStatsAgg,
} from '@/utils/explore/builders'
import { cleanModel, draftQuery, setTab as exploreSetTab } from '@/utils/explore/editorState'
import { tiersOf, expressionsFor } from './condition'
import {
  RULE_DEFAULTS, DEFAULT_GROUP, RESERVED_TAG_KEYS, RECEIVER_TYPES, DEFAULT_STATIC_OPERATOR, DEFAULT_ANOMALY_OPERATOR,
  DEFAULT_ANOMALY_DEVIATIONS,
} from './catalog'
import { labelAction, usesTemplate } from './template'
import { effectiveReceivers, receiverSummary } from './routing'
import { queryProblem, NEEDS_CLOSING_PIPE } from '@/data/alertsEngine'

export const EDITOR_DATASOURCES = ['prometheus', 'vlogs', 'traces']
const LOGS_FAMILY = new Set(['vlogs', 'traces', 'mobile'])
// Labels the tiers and the evaluator own, never shown as tags.
const MANAGED_LABELS = new Set(['group', 'rule_id', 'severity'])
const SEVERITY_TAG = 'Severity comes from the Warning and Critical thresholds, not from a tag.'

const pair = (label, value) => ({ label, operator: '=', values: [String(value)] })

// ---------- The query, per datasource ----------

/** A Logs or Traces rule starts counting: one series, ready to compare (D6). */
export function defaultAlertBuilderModel() {
  return { type: 'builder', streamPairs: [emptyPair()], labelPairs: [emptyPair()], pipes: [{ value: 'stats', by: [], aggs: [newStatsAgg()] }] }
}

/** A blank Metrics rule: the fleet's error rate, a service away from useful. */
export function defaultAlertQuickModel() {
  return { type: 'quick', calculate: 'error_percentage', value: '90', labelPairs: [emptyPair()], groupBy: [] }
}

// Quick queries are generated in production's alert variant: latencies in
// milliseconds (Explore divergence #3), as every stored Quick rule has them.
const quickQuery = model => buildQuickQuery(model, { latencyInMs: true })

function metricsEditor(model, query) {
  const quick = model?.type === 'quick' ? model : defaultAlertQuickModel()
  const advanced = model?.type === 'advanced' ? model : defaultAdvancedModel()
  const tab = model?.type === 'quick' || model?.type === 'advanced' ? model.type : query ? 'code' : 'quick'
  return {
    tab,
    quick: { model: quick, query: quickQuery(quick) },
    advanced: { model: advanced, query: buildAdvancedQuery(advanced) },
    code: { query: tab === 'code' ? query : '', touched: tab === 'code', seededFrom: null },
  }
}

function logsEditor(model, query) {
  const builder = model?.type === 'builder' ? model : defaultAlertBuilderModel()
  const tab = model?.type === 'builder' ? 'builder' : query ? 'code' : 'builder'
  return {
    tab,
    builder: { model: builder, query: buildLogsqlQuery(builder) },
    code: { query: tab === 'code' ? query : '', touched: tab === 'code', seededFrom: null },
  }
}

function editorsFor(datasource, model, query) {
  const own = ds => (ds === datasource ? [model, query] : [null, ''])
  return {
    prometheus: metricsEditor(...own('prometheus')),
    vlogs: logsEditor(...own('vlogs')),
    traces: logsEditor(...own('traces')),
  }
}

/** The query the showing datasource's tab spells, without any condition. */
export const queryOf = draft => (EDITOR_DATASOURCES.includes(draft?.datasource) ? draftQuery(draft) : '')

/** The model the showing tab edits, or null for Code (what production stores in `config.model`). */
export function modelOf(draft) {
  const editor = draft?.editors?.[draft?.datasource]
  if (!editor || editor.tab === 'code') return null
  return editor[editor.tab]?.model ?? null
}

// ---------- Thresholds ----------

const emptyTiers = kind => ({
  warning: { op: kind === 'anomaly' ? DEFAULT_ANOMALY_OPERATOR : DEFAULT_STATIC_OPERATOR, value: '' },
  critical: { op: kind === 'anomaly' ? DEFAULT_ANOMALY_OPERATOR : DEFAULT_STATIC_OPERATOR, value: '' },
})

const tierText = tier => (tier ? String(tier.deviations ?? tier.threshold) : '')
const filled = row => String(row?.value ?? '').trim() !== ''
const parseNumber = text => {
  const t = String(text ?? '').trim()
  return /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(t) ? Number(t) : null
}

/** The tiers the draft would save: `{ warning, critical }`, each a stored tier or null. */
export function tiersOfDraft(draft) {
  const rows = draft?.tiers?.[draft?.kind] ?? {}
  const tier = row => {
    if (!filled(row)) return null
    const n = parseNumber(row.value)
    if (n == null) return null
    return draft.kind === 'anomaly' ? { op: row.op, deviations: n } : { op: row.op, threshold: n }
  }
  return { warning: tier(rows.warning), critical: tier(rows.critical) }
}

// ---------- Destinations (one-off receivers) ----------

const CARD_DEFAULTS = {
  email: { to: '' },
  slack: { channel: '', showQuery: false, showSampleLog: false },
  pagerduty: { serviceName: '', routingKey: '' },
  jira: { project: '', issueType: '' },
  opsgenie: { apiKey: '' },
  googlechat: { url: '', showQuery: false, showSampleLog: false },
  msTeamsV2: { webhookUrl: '', showQuery: false },
  webhook: { url: '', headers: [], body: '' },
}

/** An empty destination of `type`, as the card shows it before anything is typed. */
export const newDestination = type => ({ type, sendResolved: true, ...structuredClone(CARD_DEFAULTS[type] ?? {}) })

const cardOf = (type, c) => {
  const base = { type, sendResolved: c.send_resolved !== false }
  if (type === 'email') return { ...base, to: c.to ?? '' }
  if (type === 'slack') return { ...base, channel: c.channel ?? '', showQuery: c.show_query, showSampleLog: c.show_sample_log }
  if (type === 'pagerduty') return { ...base, serviceName: c.service_name ?? '', routingKey: c.routing_key ?? '' }
  if (type === 'jira') return { ...base, project: c.project ?? '', issueType: c.issue_type ?? '' }
  if (type === 'opsgenie') return { ...base, apiKey: c.api_key ?? '' }
  if (type === 'googlechat') return { ...base, url: c.url ?? '', showQuery: c.show_query, showSampleLog: c.show_sample_log }
  if (type === 'msTeamsV2') return { ...base, webhookUrl: c.webhook_url ?? '', showQuery: c.show_query }
  if (type === 'webhook') {
    return { ...base, url: c.url ?? '', body: c.body ?? '', headers: Object.entries(c.headers ?? {}).map(([name, value]) => ({ name, value: String(value) })) }
  }
  return base
}

// "Show query" and "Show sample log" are written when the card holds them, so
// a stored destination that never had them reads back exactly as it was. The
// card shows a missing flag as off, which is what the server takes it to mean.
const shown = d => ({
  ...(typeof d.showQuery === 'boolean' ? { show_query: d.showQuery } : null),
  ...(typeof d.showSampleLog === 'boolean' ? { show_sample_log: d.showSampleLog } : null),
})

const configOf = (d) => {
  const sent = { send_resolved: d.sendResolved !== false }
  if (d.type === 'email') return { to: d.to.trim(), ...sent }
  if (d.type === 'slack') return { channel: d.channel, ...sent, ...shown(d) }
  if (d.type === 'pagerduty') return { service_name: d.serviceName, routing_key: d.routingKey, ...sent }
  if (d.type === 'jira') return { project: d.project, issue_type: d.issueType, ...sent }
  if (d.type === 'opsgenie') return { api_key: d.apiKey, ...sent }
  if (d.type === 'googlechat') return { url: d.url.trim(), ...sent, ...shown(d) }
  if (d.type === 'msTeamsV2') return { webhook_url: d.webhookUrl.trim(), ...sent, ...shown(d) }
  if (d.type === 'webhook') {
    const headers = Object.fromEntries(d.headers.filter(h => h.name.trim()).map(h => [h.name.trim(), h.value]))
    return { url: d.url.trim(), headers, body: d.body, ...sent }
  }
  return sent
}

/** A rule's inline `receiver` → its destination cards, in production's type order. */
export function destinationsOf(receiver) {
  return RECEIVER_TYPES.flatMap(t => (receiver?.[t.configs] ?? []).map(c => cardOf(t.type, c)))
}

/** Destination cards → production's `receiver` object, every `…_configs` key present. */
export function receiverOf(destinations) {
  const out = Object.fromEntries(RECEIVER_TYPES.map(t => [t.configs, []]))
  for (const d of destinations ?? []) {
    const t = RECEIVER_TYPES.find(x => x.type === d.type)
    if (t) out[t.configs].push(configOf(d))
  }
  return out
}

const EMAIL = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/
const URL = /^https?:\/\/\S+$/i

/** What a destination still needs, in words, or null when it can send. */
export function destinationProblem(d) {
  switch (d?.type) {
    case 'email': {
      const list = d.to.split(',').map(a => a.trim()).filter(Boolean)
      if (!list.length) return 'Add at least one email address.'
      const bad = list.find(a => !EMAIL.test(a))
      return bad ? `"${bad}" is not an email address.` : null
    }
    case 'slack': return d.channel ? null : 'Pick a Slack channel.'
    case 'pagerduty': return d.serviceName && d.routingKey ? null : 'Connect a PagerDuty service.'
    case 'jira': return !d.project ? 'Pick a Jira project.' : !d.issueType ? 'Pick an issue type.' : null
    case 'opsgenie': return d.apiKey ? null : 'Pick an Opsgenie team.'
    case 'googlechat': return URL.test(d.url.trim()) ? null : 'Enter the Space\'s webhook URL.'
    case 'msTeamsV2': return URL.test(d.webhookUrl.trim()) ? null : 'Enter the incoming webhook URL.'
    case 'webhook': return URL.test(d.url.trim()) ? null : 'Enter a webhook URL starting with http:// or https://.'
    default: return 'Pick a destination type.'
  }
}

// ---------- One-off mute windows ----------

const browserZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** A new mute window, as production's card opens: no start yet, the viewer's zone. */
export const newMuteWindow = (location = browserZone()) => ({ start: '', hours: 0, minutes: 0, weekdays: [], location })

/** A rule's inline `mute` → its windows. */
export function muteWindowsOf(mute) {
  return (mute?.time_intervals ?? []).flatMap(iv => (iv.times ?? []).map(t => ({
    start: t.start_time ?? '',
    hours: Math.floor((t.duration_minutes ?? 0) / 60),
    minutes: (t.duration_minutes ?? 0) % 60,
    weekdays: [...(iv.weekdays ?? [])],
    location: iv.location ?? 'UTC',
  })))
}

/** Windows → production's `mute`, one start and duration per interval (§9.2). */
export function muteOf(windows) {
  return {
    time_intervals: (windows ?? []).map(w => ({
      times: [{ start_time: w.start, duration_minutes: Number(w.hours) * 60 + Number(w.minutes) }],
      weekdays: [...w.weekdays],
      location: w.location,
    })),
  }
}

/** What a mute window still needs, in words, or null. */
export function muteWindowProblem(w) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(w?.start ?? '')) return 'Set a start time (HH:MM).'
  const h = Number(w.hours)
  const m = Number(w.minutes)
  if (!(Number.isInteger(h) && h >= 0 && Number.isInteger(m) && m >= 0 && m < 60)) return 'Hours and minutes must be whole numbers.'
  if (h * 60 + m <= 0) return 'Mute for at least a minute.'
  return w.location ? null : 'Pick a timezone.'
}

// ---------- Access ----------

/** Rows as the access table edits them: `entity` is "team:<id>" or "user:<id>". */
function accessOf(permissions) {
  const rows = (permissions ?? []).map(p => ({ entity: `${p.entity_type}:${p.entity_id}`, permission: p.permission === 'editor' ? 'editor' : 'viewer' }))
  return rows.length ? { mode: 'custom', rows } : { mode: 'role', rows: [] }
}

function permissionsOf(access) {
  if (access?.mode !== 'custom') return []
  return access.rows.filter(r => r.entity).map(r => {
    const i = r.entity.indexOf(':')
    return { entity_type: r.entity.slice(0, i), entity_id: r.entity.slice(i + 1), permission: r.permission }
  })
}

// ---------- Building a draft ----------

function base() {
  return {
    id: null,
    status: RULE_DEFAULTS.status,
    kind: 'static',
    datasource: 'prometheus',
    editors: editorsFor('prometheus', null, ''),
    tiers: { static: emptyTiers('static'), anomaly: emptyTiers('anomaly') },
    intervalSec: RULE_DEFAULTS.interval,
    forSec: RULE_DEFAULTS.duration,
    repeatSec: RULE_DEFAULTS.repeatInterval,
    name: '',
    group: DEFAULT_GROUP,
    tags: [],
    summary: '',
    description: '',
    runbook: '',
    receiverGroupIds: [],
    destinations: [],
    groupingDisable: RULE_DEFAULTS.groupingDisable,
    muteGroupIds: [],
    muteWindows: [],
    access: { mode: 'role', rows: [] },
  }
}

/**
 * A new rule, as production defaults it (§6.1), except that nothing is chosen
 * under Notify: production starts with an empty Webhook card, the least
 * common destination there is (R23).
 */
export const blankDraft = () => base()

/**
 * A stored rule (production's read shape) → a draft. `clone` makes it a new
 * rule called "Copy of …"; its status comes across, as production's does, and
 * the editor shows it (R41). Permissions are not cloned, as production's are not.
 */
export function draftFromRule(rule, { clone = false } = {}) {
  const t = tiersOf(rule)
  const kind = t.kind
  const datasource = EDITOR_DATASOURCES.includes(rule?.datasource) ? rule.datasource : rule?.datasource === 'mobile' ? 'mobile' : 'prometheus'
  const model = cleanModel(rule?.config?.model)
  const tiers = { static: emptyTiers('static'), anomaly: emptyTiers('anomaly') }
  for (const name of ['warning', 'critical']) {
    if (t[name]) tiers[kind][name] = { op: t[name].op, value: tierText(t[name]) }
  }
  const annotations = rule?.annotations ?? {}
  return {
    ...base(),
    id: clone ? null : rule?.id ?? null,
    status: rule?.status === 'PAUSED' ? 'PAUSED' : 'ACTIVE',
    kind,
    datasource,
    editors: editorsFor(datasource, model, t.query),
    tiers,
    intervalSec: Number(rule?.interval) || RULE_DEFAULTS.interval,
    forSec: Number(rule?.duration) || 0,
    repeatSec: Number(rule?.repeatInterval) || RULE_DEFAULTS.repeatInterval,
    name: clone ? `Copy of ${rule?.name ?? ''}` : rule?.name ?? '',
    group: rule?.labels?.group || DEFAULT_GROUP,
    tags: Object.entries(rule?.labels ?? {}).filter(([k]) => !MANAGED_LABELS.has(k)).map(([key, value]) => ({ key, value: String(value) })),
    summary: annotations.summary ?? '',
    description: annotations.description ?? '',
    runbook: annotations.runbook_url ?? '',
    receiverGroupIds: [...(rule?.config?.receiver_group_ids ?? [])],
    destinations: destinationsOf(rule?.receiver),
    groupingDisable: !!rule?.groupingDisable,
    muteGroupIds: [...(rule?.config?.mute_group_ids ?? [])],
    muteWindows: muteWindowsOf(rule?.mute),
    access: clone ? { mode: 'role', rows: [] } : accessOf(rule?.permissions),
  }
}

/**
 * What an entry point hands over (D13) → a draft. Production's entry points
 * pass `{ datasource, model, query }`, and its monitors add `condition` and
 * `threshold`; ours add the tiers that colour the card, a name, a group and a
 * Fire after. Models are cleaned on the way in, which drops the stale option
 * lists production's models carry (Explore divergence #2).
 */
export function draftFromPayload(payload = {}) {
  const draft = base()
  const datasource = EDITOR_DATASOURCES.includes(payload.datasource) ? payload.datasource : 'prometheus'
  const model = cleanModel(payload.model)
  draft.datasource = datasource
  draft.editors = editorsFor(datasource, model, payload.query ? String(payload.query) : '')
  const tiers = payload.tiers ?? (payload.condition != null && payload.threshold != null
    ? { critical: { op: payload.condition, threshold: Number(payload.threshold) } }
    : null)
  for (const name of ['warning', 'critical']) {
    const tier = tiers?.[name]
    if (tier) draft.tiers.static[name] = { op: tier.op, value: tierText(tier) }
  }
  if (payload.name) draft.name = String(payload.name)
  if (payload.group) draft.group = String(payload.group)
  if (Number.isFinite(payload.forSec)) draft.forSec = payload.forSec
  return draft
}

/**
 * The Rules tab's "Start from a service" seed (P2's empty state) → a draft:
 * `{ calculate, service, tiers, forSec, name }`.
 */
export function draftFromSuggestion(s = {}) {
  return draftFromPayload({
    datasource: 'prometheus',
    model: { type: 'quick', calculate: s.calculate, value: '90', labelPairs: s.service ? [pair('service', s.service), emptyPair()] : [emptyPair()], groupBy: [] },
    tiers: s.tiers,
    name: s.name,
    forSec: s.forSec,
  })
}

// ---------- Saving ----------

/**
 * The draft → production's read shape, as the store saves it and the preview
 * evaluates it. A new rule has a null id; the store gives it one.
 */
export function ruleFromDraft(draft) {
  const datasource = draft.datasource
  const query = queryOf(draft)
  const { warning, critical } = tiersOfDraft(draft)
  const tagLabels = Object.fromEntries(draft.tags.filter(t => t.key.trim()).map(t => [t.key.trim(), t.value]))
  const stored = expressionsFor({ datasource, query, warning, critical, labels: { group: draft.group.trim() || DEFAULT_GROUP, ...tagLabels } })
  const annotations = {
    alertname: draft.name.trim(), 'cube.kind': draft.kind, datasource, interval: String(draft.intervalSec), value: '{{ printf "%.2f" .Value }}',
  }
  if (draft.summary.trim()) annotations.summary = draft.summary.trim()
  if (draft.description.trim()) annotations.description = draft.description.trim()
  if (draft.runbook.trim()) annotations.runbook_url = draft.runbook.trim()
  return {
    id: draft.id,
    name: draft.name.trim(),
    datasource,
    kind: draft.kind,
    query: stored.query,
    query2: stored.query2,
    interval: draft.intervalSec,
    duration: draft.forSec,
    repeatInterval: draft.repeatSec,
    groupingDisable: draft.groupingDisable,
    labels: { ...stored.labels, rule_id: '{{ .GroupID }}' },
    annotations,
    config: { model: modelOf(draft), receiver_group_ids: [...draft.receiverGroupIds], mute_group_ids: [...draft.muteGroupIds] },
    receiver: receiverOf(draft.destinations),
    mute: muteOf(draft.muteWindows),
    status: draft.status,
    permission: 'admin',
    readonly: false,
    permissions: permissionsOf(draft.access),
  }
}

/** Whether the draft would save anything different from `initial`. */
export function isDirty(draft, initial) {
  if (!draft || !initial) return false
  return JSON.stringify(ruleFromDraft(draft)) !== JSON.stringify(ruleFromDraft(initial))
}

// ---------- Checking ----------

/**
 * Everything that stops a Save, each with the field it belongs to (R22): a
 * disabled Save lists these, and each item moves focus to its field.
 * `[{ field, message }]`, in the page's order; empty when the rule can save.
 */
export function validateDraft(draft) {
  const out = []
  const add = (field, message) => out.push({ field, message })
  const query = queryOf(draft)
  if (draft.datasource === 'mobile') add('query', 'Mobile alerts aren\'t available yet.')
  else if (!query.trim()) add('query', 'Write the query the rule watches.')
  else {
    const problem = queryProblem(draft.datasource, query)
    if (problem) add('query', problem)
  }
  if (draft.kind === 'anomaly' && draft.datasource !== 'prometheus') add('kind', 'Anomaly rules watch Metrics only.')
  const rows = draft.tiers[draft.kind]
  const named = { warning: 'Warning', critical: 'Critical' }
  for (const name of ['warning', 'critical']) {
    const row = rows[name]
    if (!filled(row)) continue
    const n = parseNumber(row.value)
    if (n == null) add(`tier-${name}`, `${named[name]} must be a number.`)
    else if (draft.kind === 'anomaly' && !(n > 0)) add(`tier-${name}`, `${named[name]} must be more than 0 deviations.`)
  }
  if (!filled(rows.warning) && !filled(rows.critical)) add('tiers', 'Set a Warning or a Critical threshold, or both.')
  if (!draft.name.trim()) add('name', 'Name the rule.')
  const seen = new Set()
  draft.tags.forEach((t, i) => {
    const key = t.key.trim()
    if (!key && !t.value.trim()) return
    if (!key) add(`tag-${i}`, 'A tag needs a key.')
    else if (key === 'severity') add(`tag-${i}`, SEVERITY_TAG)
    else if (RESERVED_TAG_KEYS.includes(key)) add(`tag-${i}`, `"${key}" is reserved: the evaluator sets it.`)
    else if (seen.has(key)) add(`tag-${i}`, `"${key}" is used twice.`)
    seen.add(key)
  })
  if (!draft.receiverGroupIds.length && !draft.destinations.length) add('notify', 'Choose a contact point or add a destination.')
  draft.destinations.forEach((d, i) => {
    const problem = destinationProblem(d)
    if (problem) add(`destination-${i}`, problem)
  })
  draft.muteWindows.forEach((w, i) => {
    const problem = muteWindowProblem(w)
    if (problem) add(`mute-${i}`, problem)
  })
  if (draft.access.mode === 'custom' && !draft.access.rows.some(r => r.entity && r.permission === 'editor')) {
    add('access', 'Give at least one team or person Editor access.')
  }
  return out
}

// ---------- Editing ----------

/** Static ↔ Anomaly. Anomaly reads Metrics only, and opens at 2 deviations either side, as production does. */
export function setKind(draft, kind) {
  if (kind === draft.kind || (kind === 'anomaly' && draft.datasource !== 'prometheus')) return draft
  const next = { ...draft, kind }
  if (kind === 'anomaly' && !filled(draft.tiers.anomaly.warning) && !filled(draft.tiers.anomaly.critical)) {
    next.tiers = { ...draft.tiers, anomaly: { ...draft.tiers.anomaly, warning: { op: DEFAULT_ANOMALY_OPERATOR, value: String(DEFAULT_ANOMALY_DEVIATIONS) } } }
  }
  return next
}

/** Switch datasource; each keeps its own query. Mobile is listed, never chosen (deferred). */
export function setDatasource(draft, datasource) {
  if (datasource === draft.datasource || !EDITOR_DATASOURCES.includes(datasource)) return draft
  if (draft.kind === 'anomaly' && datasource !== 'prometheus') return draft
  return { ...draft, datasource }
}

/** Quick / Advanced / Code or Builder / Code, with Explore's carry-over into Code (its ARCH D3). */
export function setTab(draft, tab) {
  const next = exploreSetTab(draft, tab)
  if (next === draft) return draft
  return { ...draft, editors: next.editors }
}

/** The showing datasource's editor, replaced by what the editor component reported. */
export function setEditor(draft, editor) {
  if (!editor) return draft
  let next = editor
  // Explore's Quick tab writes Explore's seconds; an alert stores milliseconds.
  if (next.quick?.model) next = { ...next, quick: { ...next.quick, query: quickQuery(next.quick.model) } }
  return { ...draft, editors: { ...draft.editors, [draft.datasource]: next } }
}

/** One threshold row's operator or text. */
export function setTier(draft, name, patch) {
  const rows = draft.tiers[draft.kind]
  return { ...draft, tiers: { ...draft.tiers, [draft.kind]: { ...rows, [name]: { ...rows[name], ...patch } } } }
}

/**
 * Insert a label into the name (D8). A name that varies per series only reads
 * right when each series is notified on its own, so this also switches Send to
 * one notification per series (R28) — `switched` says it did.
 */
export function insertLabel(draft, key) {
  const token = labelAction(key)
  const name = draft.name && !/\s$/.test(draft.name) ? `${draft.name} ${token}` : `${draft.name}${token}`
  const switched = !draft.groupingDisable
  return { draft: { ...draft, name, groupingDisable: true }, switched }
}

/** Whether the name would be rendered per series, so grouping matters. */
export const nameIsTemplated = draft => usesTemplate(draft?.name)

/** Whether a Logs or Traces query is missing the closing pipe its rule needs (R31). */
export function needsClosingPipe(draft) {
  if (!LOGS_FAMILY.has(draft?.datasource)) return false
  const query = queryOf(draft)
  return !!query.trim() && queryProblem(draft.datasource, query) === NEEDS_CLOSING_PIPE
}

/**
 * Production's "Fix query" (reference §6.3): an APM chart on a downsampled
 * install hands over `$__…` placeholders alerts cannot evaluate, and this
 * rewrites them the way production's button does.
 */
export function fixUnsupportedVariables(query) {
  return String(query ?? '')
    .replace(/\$__range(?:_s|_ms)?\b/g, '1i')
    .replace(/\$__step\b/g, '1i')
    .replace(/\$__increase\b/g, 'increase')
    .replace(/\$__default_0\b/g, 'default 0')
    .replace(/\$__(cube_apm_\w+)/g, '$1')
}

/** "Slack #payments-oncall · Email oncall@x.io": where a contact point sends, for its option in Notify. */
export function contactPointText(group, lookups) {
  return effectiveReceivers({ config: { receiver_group_ids: [group.id] } }, [group])
    .map(r => { const s = receiverSummary(r, lookups); return [s.label, s.target].filter(Boolean).join(' ') })
    .join(' · ')
}
