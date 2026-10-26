// Alert rules, and what they have done (docs/alerts/DESIGN.md D15).
//
// Three ideas, the same three the rest of the mock layer runs on:
//
//   1. PRODUCTION'S SHAPES. Rules, receiver groups, mute groups, silences,
//      SLOs and the notification log are written exactly as production's API
//      returns them (docs/alerts/reference/production.md §17), so wiring the
//      real backend replaces this module and nothing that reads it. Production's
//      own demo rule (#437), its synthetic-monitor rules and its mute group are
//      here verbatim, ids and all, so a link copied out of production lands on
//      the same rule.
//
//   2. ONE INCIDENT. A rule does not have data of its own: it is bound to the
//      profile its query measures — payment-service's error rate, a host's CPU,
//      the log stream's error rate — the same profiles every chart on the
//      platform samples (timeWindow.js). So an alert fires where the service
//      page's chart breaks, at the minute the Home strip turns red, and a
//      threshold set from a service card fires exactly when the card does.
//
//   3. EVALUATED, NOT PLACED. Nothing here says "this rule is firing". Each rule
//      is evaluated the way an alerting engine does it — every `interval`
//      seconds, pending until its condition has held for `duration`, firing,
//      resolving — over an eight-day horizon ending now. The state now, the
//      timeline, the notification log and the noise report are all read off
//      that one history, so they cannot disagree with each other.
//
// What is ours, not production's, is marked where it is added: `seriesCount` on
// an evaluated rule (production cannot tell "no data" from "OK"), `firingAt` on
// an alert, and `event` / `receiver_group_id` on a log row.

import { BASE_TIME, INCIDENT_START_MIN, incidentWeight, incidentWeightOver, sampleAt } from './timeWindow'
import { services, serviceProfile, redEndpoints } from './services'
import { hostProfile, HOST_NAMES, redisProfile, logRateProfile } from './observability'
import { buildQuickQuery } from '@/utils/explore/builders'
import { tiersOf, expressionsFor, stateIntervals, mergeTierIntervals, holds, holdsAnomaly, suggestThreshold } from '@/utils/alerts/condition'
import { renderTemplate } from '@/utils/alerts/template'
import { effectiveReceivers, sendsResolved, ruleMuteIntervals, ruleSilences, muteStretches } from '@/utils/alerts/routing'
import { engineBinding } from './alertsEngine'
import { insightFlags } from '@/utils/alerts/insights'

const NOW = Math.floor(BASE_TIME.getTime() / 1000)
/** How far back every rule is evaluated: the widest preset is a week, plus a day. */
export const HORIZON_SEC = 8 * 86400
const INCIDENT_FROM = NOW - INCIDENT_START_MIN * 60
const ZERO_TIME = '0001-01-01T00:00:00Z' // production's lastEvaluation for a rule never evaluated
const iso = sec => new Date(sec * 1000).toISOString()
const LOCAL_TZ = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
})()

/** Bumped whenever the seed changes, so saved edits made against an older seed are dropped. */
export const SEED_VERSION = 'alerts-seed-2'

// ---------------------------------------------------------------------------
// The seed
// ---------------------------------------------------------------------------

// Lookups the receiver pickers and summaries read (production fetches these
// from Slack, Opsgenie and Jira through its connect APIs, §7.3).
const SLACK_CHANNELS = [
  { id: 'C04PAYONCALL', name: 'payments-oncall', is_private: false },
  { id: 'C04CHECKOUT', name: 'checkout-alerts', is_private: false },
  { id: 'C04FULFIL', name: 'fulfilment', is_private: false },
  { id: 'C04PLATFORM', name: 'platform-alerts', is_private: false },
  { id: 'C04SRE', name: 'sre', is_private: true },
  { id: 'C04INCIDENTS', name: 'incidents', is_private: false },
]
const OPSGENIE_TEAMS = [
  { team: 'cubedemo-oncall', api_key: 'og-demo-1c7e' },
  { team: 'infra-oncall', api_key: 'og-demo-58aa' },
]
const JIRA_PROJECTS = [
  { key: 'OPS', name: 'Operations', issueTypes: ['Incident', 'Task', 'Bug'] },
  { key: 'PAY', name: 'Payments', issueTypes: ['Bug', 'Task'] },
]
// Production's playground configures no teams or users; custom permissions are
// in v1 (signed off as Q6), so a few stand in.
const TEAMS = [
  { id: 'team-payments', name: 'Payments' },
  { id: 'team-checkout', name: 'Checkout' },
  { id: 'team-platform', name: 'Platform' },
  { id: 'team-sre', name: 'SRE' },
]
const USERS = [
  { id: 'user-asha', first_name: 'Asha', last_name: 'Rao', email: 'asha.rao@cubedemo.example' },
  { id: 'user-diego', first_name: 'Diego', last_name: 'Marín', email: 'diego.marin@cubedemo.example' },
  { id: 'user-mei', first_name: 'Mei', last_name: 'Chen', email: 'mei.chen@cubedemo.example' },
  { id: 'user-sam', first_name: 'Sam', last_name: 'Okafor', email: 'sam.okafor@cubedemo.example' },
]

// Production's synthetic monitors (§14.2), the ones its rules watch.
const MONITORS = [
  { id: 15, group_name: 'CubeAPM Public', name: 'Docs', method: 'GET', url: 'https://docs.cubeapm.com', headers: {}, success_codes_regex: '200', status: 'ACTIVE' },
  { id: 14, group_name: 'CubeAPM Public', name: 'Marketing Site', method: 'GET', url: 'https://cubeapm.com', headers: {}, success_codes_regex: '200', status: 'ACTIVE' },
  { id: 16, group_name: 'CubeAPM Public', name: 'Playground', method: 'GET', url: 'https://playground.cubeapm.com', headers: {}, success_codes_regex: '200', status: 'ACTIVE' },
  { id: 18, group_name: 'External Deps', name: 'Cloudflare', method: 'GET', url: 'https://www.cloudflare.com', headers: {}, success_codes_regex: '2..', status: 'ACTIVE' },
  { id: 19, group_name: 'External Deps', name: 'GitHub Status', method: 'GET', url: 'https://www.githubstatus.com', headers: {}, success_codes_regex: '2..', status: 'ACTIVE' },
]

// The webhook that does not answer. Infra paging's second receiver posts to it,
// so the log has failures to show and a contact point has a broken channel to
// surface (D9) — the way a misconfigured integration looks in practice.
const BROKEN_WEBHOOK = 'https://hooks.internal.cubedemo.example/alerts'
const BROKEN_DETAILS = `Post "${BROKEN_WEBHOOK}": 503 Service Unavailable`

const RECEIVER_GROUPS = [
  // Production's own, verbatim: the demo logs its notifications into CubeAPM logs.
  { id: 7, name: 'Payments on-call (demo)', receiver: { webhook_configs: [{ url: 'http://127.0.0.1:3140/api/logs/insert/jsonline?_stream_fields=receiver', headers: {}, body: '', send_resolved: true }] } },
  { id: 11, name: 'Payments on-call', receiver: {
    slack_configs: [{ channel: 'C04PAYONCALL', send_resolved: true, show_query: true, show_sample_log: false }],
    pagerduty_configs: [{ service_name: 'Payments', routing_key: 'pd-demo-3f9a1c', send_resolved: true }],
  } },
  { id: 12, name: 'Checkout on-call', receiver: {
    slack_configs: [{ channel: 'C04CHECKOUT', send_resolved: true, show_query: false, show_sample_log: false }],
    email_configs: [{ to: 'checkout-team@cubedemo.example', send_resolved: false }],
  } },
  { id: 13, name: 'Platform team', receiver: {
    email_configs: [{ to: 'platform@cubedemo.example, sre@cubedemo.example', send_resolved: true }],
    msteamsv2_configs: [{ webhook_url: 'https://cubedemo.webhook.office.com/webhookb2/platform-alerts', send_resolved: true }],
  } },
  { id: 14, name: 'Infra paging', receiver: {
    opsgenie_configs: [{ api_key: 'og-demo-58aa', send_resolved: true }],
    webhook_configs: [{ url: BROKEN_WEBHOOK, headers: { Authorization: 'Bearer ••••' }, body: '', send_resolved: true }],
  } },
  { id: 15, name: 'Ops triage (Jira)', receiver: { jira_configs: [{ project: 'OPS', issue_type: 'Incident', send_resolved: false }] } },
  { id: 16, name: 'Fulfilment on-call', receiver: { slack_configs: [{ channel: 'C04FULFIL', send_resolved: true, show_query: false, show_sample_log: false }] } },
]

// A daily deploy window that is open as the demo loads, in the viewer's own
// zone: 40 minutes back, floored to the half hour, for two and a half hours.
// Relative to BASE_TIME the way the incident is, so "Muted until …" always has
// something to say.
const DEPLOY_WINDOW_START = (() => {
  try {
    const [h, m] = new Intl.DateTimeFormat('en-GB', { timeZone: LOCAL_TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .format(new Date((NOW - 40 * 60) * 1000)).split(':').map(Number)
    return `${String(h).padStart(2, '0')}:${m < 30 ? '00' : '30'}`
  } catch {
    return '00:00'
  }
})()

const MUTE_GROUPS = [
  // Production's TestMuteGroup's schedule, under a name that says what it is.
  { id: 2, name: 'Quiet hours', mute: { time_intervals: [{ times: [{ start_time: '21:00', duration_minutes: 600 }], weekdays: [], location: 'Asia/Calcutta' }] } },
  { id: 3, name: 'Daily deploy window', mute: { time_intervals: [{ times: [{ start_time: DEPLOY_WINDOW_START, duration_minutes: 150 }], weekdays: [], location: LOCAL_TZ }] } },
]

const silence = (id, ruleId, start, end, createdBy, comment) => ({
  id,
  matchers: [{ name: 'rule_id', value: String(ruleId), isEqual: true, isRegex: false }],
  startsAt: iso(start),
  endsAt: iso(end),
  createdBy,
  comment,
  status: { state: start > NOW ? 'pending' : end <= NOW ? 'expired' : 'active' },
  updatedAt: iso(start),
})

const SILENCES = [
  // Taken as payment-service went down, before shipment's own alert had even
  // gone pending: its on-call knew it was downstream and followed payment.
  silence('2f1d6c0a-5b44-4c7e-9a3e-71c0d4a1b2c3', 507, NOW - 19 * 60, NOW + 26 * 60, 'fulfilment-oncall', 'Downstream of the payment-service incident; following that one instead.'),
  silence('8c3b91e4-0d2f-4a6b-8f5e-2a9c7d1e0f44', 510, NOW + 20 * 3600, NOW + 22 * 3600, 'discovery-team', 'Search index rebuild window.'),
  silence('d41e7a2b-9c3f-4e18-b6a0-5f2c8e9d1a77', 508, NOW - 2 * 86400 - 3600, NOW - 2 * 86400, 'platform-oncall', 'Provider slowness, tracked in OPS-412.'),
]

const pair = (label, value) => ({ label, operator: '=', values: [value] })
const quick = (calculate, pairs, { groupBy = [], value = '90' } = {}) => ({ type: 'quick', calculate, value, labelPairs: pairs, groupBy })

const BASE_ANNOTATIONS = (name, kind, datasource, interval) => ({
  alertname: name, 'cube.kind': kind, datasource, interval: String(interval), value: '{{ printf "%.2f" .Value }}',
})

// A rule in production's read shape, from the fields an author sets. The query
// of a Quick rule is generated by Explore's own builder in the alert editor's
// millisecond variant, so it is byte-for-byte what production would store.
function rule({
  id, name, group, model = null, query, datasource = 'prometheus', kind = 'static', warning = null, critical = null,
  interval = 60, duration = 300, repeatInterval = 3600, groupingDisable = false,
  contactPoints = [], mutes = [], receiver = {}, mute = { time_intervals: [] },
  status = 'ACTIVE', tags = {}, annotations = {}, readonly = false,
}) {
  const base = query ?? buildQuickQuery(model, { latencyInMs: true })
  const stored = expressionsFor({ datasource, query: base, warning, critical, labels: { group, rule_id: '{{ .GroupID }}', ...tags } })
  return {
    id, name, datasource, kind,
    query: stored.query, query2: stored.query2,
    interval, duration, repeatInterval, groupingDisable,
    labels: stored.labels,
    annotations: { ...BASE_ANNOTATIONS(name, kind, datasource, interval), ...annotations },
    config: { model, receiver_group_ids: contactPoints, mute_group_ids: mutes },
    receiver, mute, status, permission: 'admin', readonly,
  }
}

// Production's demo rule #437, exactly as its API returns it (§18).
const DEMO_QUERY = '(sum(increase((cube_apm_calls_total{env="UNSET",service="payment-service",root_name="POST /v1/payments",span_kind=~"server|consumer",status_code="ERROR"} default 0)[5m])) * 100 / sum(increase((cube_apm_calls_total{env="UNSET",service="payment-service",root_name="POST /v1/payments",span_kind=~"server|consumer"} default 0)[5m]))) > 0.1'

const RUNBOOK = slug => `https://runbooks.cubedemo.example/${slug}`

// Production's synthetic-monitor rules, ids and all (§14.2): an Advanced model
// over the monitor's up metric, critical when it reads 0, emailed inline.
function syntheticRule(id, monitorId, status) {
  const m = MONITORS.find(x => x.id === monitorId)
  const name = `Synthetic down - ${m.name}`
  const r = rule({
    id, name, group: m.group_name, status,
    model: { type: 'advanced', metric: 'cube_synthetic_monitor', labelPairs: [pair('id', String(monitorId))], functions: [{ value: 'max', args: [{ type: 'aggregation', value: ['id', 'group', 'name'] }] }] },
    query: `max(cube_synthetic_monitor{id="${monitorId}"}) by (id, group, name)`,
    critical: { op: '==', threshold: 0 },
    duration: 120,
    receiver: { email_configs: [{ to: 'oncall@cubedemo.example', send_resolved: true }] },
    tags: { kind: 'synthetic' },
    annotations: { summary: `${m.name} is not answering`, description: `${m.method} ${m.url} did not return ${m.success_codes_regex}.` },
  })
  // Stored as production's API returns these, without the parentheses the
  // editor's save would add; both forms read back the same (condition.js).
  return { ...r, query: `max(cube_synthetic_monitor{id="${monitorId}"}) by (id, group, name) == 0` }
}

const SEED_RULES = [
  {
    id: 437, name: 'Payment error rate high (POST /v1/payments)', datasource: 'prometheus', kind: 'static',
    query: DEMO_QUERY, query2: '', interval: 60, duration: 300, repeatInterval: 3600, groupingDisable: false,
    labels: { group: 'Payments', rule_id: '{{ .GroupID }}' },
    annotations: BASE_ANNOTATIONS('Payment error rate high (POST /v1/payments)', 'static', 'prometheus', 60),
    config: { model: null, receiver_group_ids: [7], mute_group_ids: [] },
    receiver: {}, mute: { time_intervals: [] }, status: 'ACTIVE', permission: 'admin', readonly: false,
  },
  rule({
    id: 501, name: 'payment-service error rate', group: 'Payments',
    model: quick('error_percentage', [pair('service', 'payment-service')]),
    warning: { op: '>', threshold: 1 }, critical: { op: '>', threshold: 3 },
    contactPoints: [11],
    annotations: { summary: 'payment-service is failing {{ printf "%.2f" .Value }}% of requests', runbook_url: RUNBOOK('payments/error-rate') },
  }),
  rule({
    id: 502, name: 'payment-service p90 latency', group: 'Payments',
    model: quick('latency_percentile', [pair('service', 'payment-service')]),
    warning: { op: '>', threshold: 150 }, critical: { op: '>', threshold: 300 },
    contactPoints: [11],
    annotations: { summary: 'payment-service p90 is {{ printf "%.0f" .Value }} ms', runbook_url: RUNBOOK('payments/latency') },
  }),
  // Waits half an hour before firing, so twenty-odd minutes into the incident
  // it is still pending: the one rule that shows what "Pending" means.
  rule({
    id: 503, name: 'payment-service sustained errors', group: 'Payments',
    model: quick('error_percentage', [pair('service', 'payment-service')]),
    warning: { op: '>', threshold: 1 }, duration: 1800,
    contactPoints: [11, 15],
    annotations: { summary: 'Errors above 1% for half an hour: open an incident ticket' },
  }),
  // The whole log stream's error records, counted over each five-minute
  // evaluation, in production's LogsQL form (§6.3).
  rule({
    id: 504, name: 'Error log volume', group: 'Platform', datasource: 'vlogs',
    query: '{env="UNSET"} log.level:="error" | stats count()',
    warning: { op: '>', threshold: 10 }, interval: 300, duration: 0,
    contactPoints: [13],
  }),
  // Muted by the deploy window that is open as the demo loads.
  rule({
    id: 505, name: 'order-service p90 latency', group: 'Checkout',
    model: quick('latency_percentile', [pair('service', 'order-service')]),
    warning: { op: '>', threshold: 150 }, critical: { op: '>', threshold: 300 },
    contactPoints: [12], mutes: [3],
  }),
  rule({
    id: 506, name: 'order-service error rate', group: 'Checkout',
    model: quick('error_percentage', [pair('service', 'order-service')]),
    warning: { op: '>', threshold: 1 }, critical: { op: '>', threshold: 3 },
    contactPoints: [12],
  }),
  // Snoozed six minutes ago by its on-call.
  rule({
    id: 507, name: 'shipment-service p90 latency', group: 'Fulfilment',
    model: quick('latency_percentile', [pair('service', 'shipment-service')]),
    warning: { op: '>', threshold: 150 }, critical: { op: '>', threshold: 300 },
    contactPoints: [16],
  }),
  // Set below notify-service's normal p90 (~80 ms), so it fires all the time:
  // the chronic miscalibration Insights exists to catch (D11).
  rule({
    id: 508, name: 'notify-service slow sends', group: 'Platform',
    model: quick('latency_percentile', [pair('service', 'notify-service')]),
    warning: { op: '>', threshold: 60 }, repeatInterval: 14400,
    contactPoints: [13],
  }),
  // Set inside search-service's normal p90 band (about 88–97 ms) with no wait,
  // so it fires and clears all day: a flapping rule. Quiet hours mute it
  // overnight.
  rule({
    id: 509, name: 'search-service p90 latency', group: 'Discovery',
    model: quick('latency_percentile', [pair('service', 'search-service')]),
    warning: { op: '>', threshold: 95 }, duration: 0,
    contactPoints: [13], mutes: [2],
  }),
  rule({
    id: 510, name: 'search-service traffic anomaly', group: 'Discovery', kind: 'anomaly',
    model: quick('rpm', [pair('service', 'search-service')]),
    warning: { op: '<>', deviations: 3 }, critical: { op: '<>', deviations: 4 },
    duration: 600, contactPoints: [13],
  }),
  rule({
    id: 511, name: 'demo-nodejs-service error rate', group: 'Platform',
    model: quick('error_percentage', [pair('service', 'demo-nodejs-service')]),
    warning: { op: '>', threshold: 1 }, critical: { op: '>', threshold: 3 },
    contactPoints: [13],
  }),
  // A service that no longer reports: the query returns nothing.
  rule({
    id: 512, name: 'billing-legacy error rate', group: 'Billing',
    model: quick('error_percentage', [pair('service', 'billing-legacy')]),
    warning: { op: '>', threshold: 1 }, critical: { op: '>', threshold: 3 },
    contactPoints: [13],
  }),
  // A query the engine rejects at evaluation: the many-to-many join an
  // endpoint/service ratio walks into. Its health is not ok.
  rule({
    id: 513, name: 'Endpoint share of service traffic', group: 'Data',
    query: 'sum by (service, root_name) (rate(cube_apm_calls_total[5m])) / on (service) group_left sum by (service, root_name) (rate(cube_apm_calls_total[5m]))',
    warning: { op: '>', threshold: 0.8 }, contactPoints: [13],
  }),
  rule({
    id: 514, name: 'redis.0 memory', group: 'Infrastructure',
    query: 'max(redis_memory_used_bytes{instance="redis.0"}) / 1e6',
    // Quiet tops out near 660 MB; the incident's plateau reads 990–1120 MB.
    warning: { op: '>', threshold: 800 }, critical: { op: '>', threshold: 950 },
    contactPoints: [14],
    annotations: { summary: 'redis.0 is using {{ printf "%.0f" .Value }} MB', runbook_url: RUNBOOK('infra/redis-memory') },
  }),
  // One alert per host, each named for its host, so one notification each.
  rule({
    id: 515, name: 'CPU high on {{ index .Labels "host.name" }}', group: 'Infrastructure',
    query: 'avg by (host.name) (system_cpu_utilization) * 100',
    warning: { op: '>', threshold: 90 }, critical: { op: '>', threshold: 95 },
    groupingDisable: true, contactPoints: [14],
  }),
  syntheticRule(426, 15, 'ACTIVE'),
  syntheticRule(427, 14, 'PAUSED'),
  syntheticRule(428, 16, 'PAUSED'),
  syntheticRule(432, 18, 'PAUSED'),
  syntheticRule(433, 19, 'PAUSED'),
]

// Production's SLO objects (§14.1). The payment endpoint's has its burn-rate
// alerts on; their rules are generated (sloRules) rather than stored.
const SLOS = [
  {
    id: 1, env: 'UNSET', service: 'payment-service', endpoint: 'POST /v1/payments',
    errorEnabled: true, errorBudget: 0.1, slowEnabled: true, slowBudget: 5, slowThreshold: 0.5,
    alertsEnabled: true,
    fastBurnReceiver: { slack_configs: [{ channel: 'C04PAYONCALL', send_resolved: true }], email_configs: [], pagerduty_configs: [], googlechat_configs: [], webhook_configs: [] },
    slowBurnReceiver: { email_configs: [{ to: 'payments-team@cubedemo.example', send_resolved: true }], slack_configs: [], pagerduty_configs: [], googlechat_configs: [], webhook_configs: [] },
  },
  {
    id: 2, env: 'UNSET', service: 'order-service', endpoint: 'GET /v1/orders',
    errorEnabled: true, errorBudget: 0.5, slowEnabled: false, slowBudget: 5, slowThreshold: 0.2,
    alertsEnabled: false,
    fastBurnReceiver: { email_configs: [{ to: 'checkout-team@cubedemo.example', send_resolved: true }] },
    slowBurnReceiver: { email_configs: [{ to: 'checkout-team@cubedemo.example', send_resolved: true }] },
  },
]

const SEED = Object.freeze({
  rules: SEED_RULES,
  receiverGroups: RECEIVER_GROUPS,
  muteGroups: MUTE_GROUPS,
  silences: SILENCES,
  slos: SLOS,
  monitors: MONITORS,
  teams: TEAMS,
  users: USERS,
  jiraProjects: JIRA_PROJECTS,
  slackChannels: SLACK_CHANNELS,
  opsgenieTeams: OPSGENIE_TEAMS,
})

/**
 * Everything the Alerts module starts from, in production's shapes and with no
 * evaluated state: { rules, receiverGroups, muteGroups, silences, slos,
 * monitors, teams, users, jiraProjects, slackChannels, opsgenieTeams }. A fresh
 * copy each call, so a store can hold it without anyone else's edits leaking in.
 */
export const alertsSeed = () => structuredClone(SEED)

// ---------------------------------------------------------------------------
// Rules SLOs generate
// ---------------------------------------------------------------------------

// The multi-window, multi-burn-rate pair production's SLO drawer configures
// (it links the SRE workbook): page fast, ticket slow. The short window is
// what confirms a burn, so the slow rule needs no wait of its own — with one,
// its five-minute evaluation grid decided whether it had fired yet by where
// the minute hand happened to be.
const BURNS = [
  { speed: 'fast', long: 3600, short: 300, factor: 14.4, interval: 60, duration: 120, critical: true, receiver: 'fastBurnReceiver' },
  { speed: 'slow', long: 21600, short: 1800, factor: 6, interval: 300, duration: 0, critical: false, receiver: 'slowBurnReceiver' },
]
const windowWord = sec => (sec % 3600 === 0 ? `${sec / 3600}h` : `${sec / 60}m`)

/** The folder a service's rules sit in. */
const SERVICE_GROUP = {
  'payment-service': 'Payments', 'order-service': 'Checkout', 'shipment-service': 'Fulfilment',
  'notify-service': 'Platform', 'search-service': 'Discovery', 'analytics-service': 'Data', 'demo-nodejs-service': 'Platform',
}

/**
 * The burn-rate rules SLOs with alerts on generate: one fast and one slow per
 * error objective. Read-only here (DESIGN.md D18): they belong to their SLO,
 * and production does not list them at all.
 */
export function sloRules(slos = []) {
  const out = []
  for (const slo of slos) {
    if (!slo.alertsEnabled || !slo.errorEnabled) continue
    for (const b of BURNS) {
      const name = `${slo.service} ${slo.endpoint} error budget burning ${b.speed === 'fast' ? 'fast' : 'slowly'}`
      const tier = { op: '>', threshold: b.factor }
      const r = rule({
        id: 9000 + slo.id * 10 + (b.speed === 'fast' ? 1 : 2),
        name,
        group: SERVICE_GROUP[slo.service] ?? 'Default Group',
        query: `min(slo_error_budget_burn_rate{slo_id="${slo.id}", window=~"${windowWord(b.long)}|${windowWord(b.short)}"})`,
        ...(b.critical ? { critical: tier } : { warning: tier }),
        interval: b.interval, duration: b.duration,
        receiver: slo[b.receiver] ?? {},
        tags: { slo_id: String(slo.id), objective: 'error', speed: b.speed },
        readonly: true,
        annotations: { summary: `${slo.service} ${slo.endpoint} is spending its ${slo.errorBudget}% error budget ${b.factor}× too fast` },
      })
      out.push(r)
    }
  }
  return out
}

/** Every rule the module shows: the stored ones, then the ones SLOs generate. */
export const ruleDefsFor = state => [...(state?.rules ?? []), ...sloRules(state?.slos ?? [])]

// ---------------------------------------------------------------------------
// What a rule measures
// ---------------------------------------------------------------------------

const instant = t => {
  const m = (NOW - t) / 60
  return { t, ms: t * 1000, m, w: incidentWeight(m) }
}

// A series bound to a profile, optionally rescaled (bytes to MB, a service's
// error rate to one endpoint's share of it).
const profileSeries = (key, labels, profile, scale = 1) => ({ key, labels, profile, scale })

const SERVICE_IDS = services.map(s => s.id)
const PUBLISHED = new Map(services.map(s => [s.id, s]))
const QUICK_KEY = { error_percentage: 'err', latency_percentile: 'p90', latency_average: 'avg', rpm: 'rpm' }
const PUBLISHED_KEY = { err: 'errorRatePct', p90: 'latencyP90', avg: 'latencyAvg', rpm: 'rpm' }
const ENDPOINT_KEY = { err: 'errPct', p90: 'p90', avg: 'avg', rpm: 'rpm' }
// A latency distribution's rough shape, relative to its p90, for a Quick rule
// on another percentile: there is one latency profile per service, its p90.
const PERCENTILE_SCALE = { 50: 0.55, 75: 0.8, 90: 1, 95: 1.18, 99: 1.6 }

// An endpoint's figure as a share of its service's. Only payment-service
// publishes per-endpoint figures (services.js redEndpoints); any other endpoint
// reads as its service.
function endpointShare(serviceId, endpoint, key) {
  if (serviceId !== 'payment-service') return 1
  const row = redEndpoints.find(r => r.endpoint === endpoint)
  const svc = PUBLISHED.get(serviceId)
  const a = row?.[ENDPOINT_KEY[key]]
  const b = svc?.[PUBLISHED_KEY[key]]
  return a > 0 && b > 0 ? a / b : 1
}

// The whole fleet as one series: what a Quick rule with no service filter
// measures. Rates add; the rest is a request-weighted mean.
function fleetSeries(key, scale) {
  const profiles = SERVICE_IDS.map(id => serviceProfile(id)).filter(Boolean)
  const read = at => {
    let sum = 0
    let weight = 0
    for (const p of profiles) {
      const rpm = sampleAt(p.rpm, at)
      if (key === 'rpm') sum += rpm
      else { sum += sampleAt(p[key], at) * rpm; weight += rpm }
    }
    return (key === 'rpm' ? sum : weight > 0 ? sum / weight : null) * scale
  }
  return { key: '', labels: {}, valueAt: t => read(instant(t)), noise: 0.06 }
}

function quickBinding(model) {
  const key = QUICK_KEY[model?.calculate]
  if (!key) return { series: [] }
  const eq = label => (model.labelPairs ?? []).find(p => p.label === label && p.operator === '=' && p.values?.length)?.values[0] ?? null
  const service = eq('service')
  const endpoint = eq('root_name')
  const byService = (model.groupBy ?? []).includes('service')
  const scale = key === 'p90' ? PERCENTILE_SCALE[Number(model.value ?? 90)] ?? 1 : 1
  if (!service && !byService) return { series: [fleetSeries(key, scale)] }
  const ids = service ? [service] : SERVICE_IDS
  return {
    series: ids.flatMap(id => {
      const p = serviceProfile(id)?.[key]
      if (!p) return []
      const labels = byService ? { service: id } : {}
      return [profileSeries(byService ? `service=${id}` : '', labels, p, scale * (endpoint ? endpointShare(id, endpoint, key) : 1))]
    }),
  }
}

// An SLO's burn rate, as production's multi-window rule reads it: the error
// rate over the long window and over the short one, each against the budget,
// and the lower of the two — both must be over the factor to fire. Means come
// from a prefix sum over minutes, so a six-hour window costs two lookups.
const burnCache = new Map()
function burnSeries(slo, longSec, shortSec) {
  const p = serviceProfile(slo.service)?.err
  if (!p) return null
  const share = endpointShare(slo.service, slo.endpoint, 'err')
  const key = `${slo.id}`
  if (!burnCache.has(key)) {
    const start = NOW - HORIZON_SEC - 6 * 3600 - 60
    const n = Math.ceil((NOW - start) / 60) + 1
    const prefix = new Float64Array(n + 1)
    for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + sampleAt(p, instant(start + i * 60)) * share
    burnCache.set(key, { start, n, prefix })
  }
  const { start, n, prefix } = burnCache.get(key)
  const idx = t => Math.max(0, Math.min(n, Math.floor((t - start) / 60)))
  const mean = (a, b) => {
    const i = idx(a)
    const j = idx(b)
    return j > i ? (prefix[j] - prefix[i]) / (j - i) : null
  }
  const budget = slo.errorBudget > 0 ? slo.errorBudget : null
  const valueAt = t => {
    const l = mean(t - longSec, t)
    const s = mean(t - shortSec, t)
    return budget && l != null && s != null ? Math.min(l, s) / budget : null
  }
  return { key: '', labels: { slo_id: String(slo.id) }, valueAt }
}

/**
 * What a rule measures: `{ series: [{ key, labels, … }] }`, or `{ error }`
 * when the engine would reject it. A rule whose query is one of the seed's
 * keeps the seed's binding; anything else is read from its Quick model. A
 * query this cannot place returns no series, which is what an engine reports
 * for a metric nobody sends: "No data".
 */
export function bindingFor(rule, ctx = SEED, span = { from: NOW - HORIZON_SEC, to: NOW }) {
  // A seeded query keeps its profile under any id, so a clone or an edit that
  // leaves the query alone reads what the original reads.
  const query = tiersOf(rule).query
  const seedId = SEED_BINDINGS[rule?.id] && tiersOf(SEED_BY_ID.get(rule.id)).query === query ? rule.id : SEED_ID_BY_QUERY.get(query)
  if (seedId != null) return SEED_BINDINGS[seedId](ctx)
  if (rule?.labels?.slo_id) {
    const slo = (ctx.slos ?? []).find(s => String(s.id) === String(rule.labels.slo_id))
    const b = slo && BURNS.find(x => x.speed === rule.labels.speed)
    const s = b && burnSeries(slo, b.long, b.short)
    return { series: s ? [s] : [] }
  }
  const model = rule?.config?.model
  if (rule?.datasource === 'prometheus' && model?.type === 'quick') return quickBinding(model)
  const monitor = /cube_synthetic_monitor\{id="(\d+)"\}/.exec(rule?.query ?? '')
  if (monitor) return monitorBinding(Number(monitor[1]), ctx)
  // Anything else is read the way production reads it: the query, run by the
  // engine (alertsEngine.js).
  return engineBinding({ datasource: rule?.datasource ?? 'prometheus', query, interval: rule?.interval }, span)
}

const UP = { baseline: 1, peak: 1, noise: 0, seed: 1 }
function monitorBinding(id, ctx) {
  const m = (ctx.monitors ?? MONITORS).find(x => x.id === id)
  return { series: m ? [profileSeries(`id=${id}`, { id: String(id), group: m.group_name, name: m.name }, UP)] : [] }
}

const SEED_BY_ID = new Map(SEED_RULES.map(r => [r.id, r]))
const SEED_BINDINGS = {
  // POST /v1/payments' error rate: payment-service's, at the endpoint's
  // published share of it (5.8% against the service's 4.8%).
  437: () => ({ series: [profileSeries('', {}, serviceProfile('payment-service').err, endpointShare('payment-service', 'POST /v1/payments', 'err'))] }),
  // Error records per minute, counted over the five-minute evaluation.
  504: () => ({ series: [profileSeries('', {}, logRateProfile('error'), 5)] }),
  513: () => ({ error: 'execution: many-to-many matching not allowed: matching labels must be unique on one side' }),
  514: () => ({ series: [profileSeries('', { instance: 'redis.0' }, redisProfile('memUsed'), 1e-6)] }),
  515: () => ({ series: HOST_NAMES.map(h => profileSeries(`host.name=${h}`, { 'host.name': h }, hostProfile(h, 'cpu'))).filter(s => s.profile) }),
}
const SEED_ID_BY_QUERY = new Map(Object.keys(SEED_BINDINGS).map(Number).map(id => [tiersOf(SEED_BY_ID.get(id)).query, id]))

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

const valueAt = (s, t) => (s.valueAt ? s.valueAt(t) : sampleAt(s.profile, instant(t)) * s.scale)
// How often a rule is evaluated, in seconds: its own interval, never under the
// fifteen seconds the editor's shortest choice is, a minute when it names none.
const everyOf = rule => Math.max(15, Number(rule.interval) || 60)
// A reading as an alert carries it and as a chart draws it. One rounding for
// both, so the figure a banner prints and the point beside it cannot round
// apart: 15.649 must not be 15.6 in one and 15.65, so 15.7, in the other.
const reading = v => (v == null || !Number.isFinite(v) ? null : Math.round(v * 1e8) / 1e8)
// The expected reading for an anomaly rule: the profile with its jitter and its
// incident taken out — what normally happens at that time of day.
const expectedAt = (s, t) => (s.profile ? sampleAt({ ...s.profile, noise: 0 }, instant(t), 1) * s.scale : null)
const sigmaAt = (s, t) => {
  const e = expectedAt(s, t)
  return e == null ? null : e * ((s.profile?.noise ?? s.noise ?? 0.1) / Math.sqrt(12))
}

// Whether a static tier's answer is fixed while the incident is absent. Away
// from the incident a profile reads its baseline plus jitter (a diurnal one
// also rides the daily wave, which this does not try to bound), so a threshold
// clear of that band answers the same on every quiet tick — and the eight-day
// horizon costs a comparison per tick instead of a sample.
function quietTruth(s, tier) {
  const p = s.profile
  if (!p || p.diurnal || p.floor != null || p.ceil != null || !tier) return undefined
  const n = p.noise ?? 0
  const a = p.baseline * (1 - n / 2) * s.scale
  const b = p.baseline * (1 + n / 2) * s.scale
  const lo = Math.min(a, b)
  const hi = Math.max(a, b)
  const both = [holds(tier, lo), holds(tier, hi)]
  if (tier.op === '==' || tier.op === '!=') return lo === hi ? both[0] : undefined
  return both[0] === both[1] ? both[0] : undefined
}

function seriesHistory(rule, s, tiers, grid) {
  const anomaly = rule.kind === 'anomaly'
  const cache = new Map()
  const read = t => {
    if (!cache.has(t)) {
      const v = valueAt(s, t)
      cache.set(t, anomaly ? { v, e: expectedAt(s, t), sd: sigmaAt(s, t) } : { v })
    }
    return cache.get(t)
  }
  const run = tier => {
    const fixed = anomaly ? undefined : quietTruth(s, tier)
    return stateIntervals({
      ...grid,
      forSec: rule.duration ?? 0,
      holdsAt: t => {
        if (fixed !== undefined && t < INCIDENT_FROM) return fixed
        const r = read(t)
        if (r.v == null || !Number.isFinite(r.v)) return null
        return anomaly ? holdsAnomaly(tier, r.v, r.e, r.sd) : holds(tier, r.v)
      },
    })
  }
  const byTier = {}
  if (tiers.warning) byTier.warning = run(tiers.warning)
  if (tiers.critical) byTier.critical = run(tiers.critical)
  return {
    key: s.key,
    labels: s.labels,
    tiers: byTier,
    intervals: mergeTierIntervals(Object.entries(byTier).map(([name, intervals]) => ({ severity: name === 'critical' ? 'critical' : 'warning', intervals }))),
    value: read(grid.to).v,
  }
}

const histories = new Map()
const historyKey = (rule, ctx) => JSON.stringify([
  rule.id, rule.datasource, rule.kind, rule.query, rule.query2, rule.interval, rule.duration, rule.status,
  rule.labels?.severity ?? null, rule.labels?.slo_id ?? null, rule.labels?.speed ?? null, rule.config?.model ?? null,
  rule.labels?.slo_id ? (ctx.slos ?? []).find(s => String(s.id) === String(rule.labels.slo_id)) ?? null : null,
])

/**
 * One rule's history over the horizon: per series, per tier and merged, plus
 * the rule's own lane (its series merged). Memoised on everything evaluation
 * depends on, so editing a rule's name or receivers does not re-evaluate it.
 *
 *   { error, paused, seriesCount, from, to, every,
 *     series: [{ key, labels, tiers: { warning?, critical? }, intervals, value }],
 *     intervals }
 */
export function ruleHistory(rule, ctx = SEED) {
  const k = historyKey(rule, ctx)
  if (histories.has(k)) return histories.get(k)
  const every = everyOf(rule)
  const grid = { from: Math.ceil((NOW - HORIZON_SEC) / every) * every, to: Math.floor(NOW / every) * every, every }
  const binding = bindingFor(rule, ctx)
  let h
  if (binding.error) {
    h = { error: binding.error, paused: false, seriesCount: 0, ...grid, series: [], intervals: [] }
  } else if (rule.status === 'PAUSED') {
    h = { error: null, paused: true, seriesCount: binding.series.length, ...grid, series: [], intervals: [] }
  } else {
    const tiers = tiersOf(rule)
    const series = binding.series.map(s => seriesHistory(rule, s, tiers, grid))
    h = {
      error: null, paused: false, seriesCount: series.length, ...grid, series,
      intervals: mergeTierIntervals(series.map(s => ({ intervals: s.intervals }))),
    }
  }
  if (histories.size > 500) histories.clear()
  histories.set(k, h)
  return h
}

// A stable 64-bit id, written as production writes alert ids: a decimal string.
function alertId(...parts) {
  let h = 0xcbf29ce484222325n
  for (const ch of parts.join('|')) {
    h ^= BigInt(ch.codePointAt(0))
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return h.toString()
}

/**
 * The rules as production's API returns them now: each with its `state`
 * (inactive / pending / firing), `health`, `lastEvaluation`, `lastError` and
 * `alerts[]` — one alert per series per tier that is pending or firing, the
 * critical tier's carrying severity=critical. Ours: `seriesCount` on the rule,
 * `firingAt` and `openStart` on an alert.
 */
export function evaluateRules(defs = [], ctx = SEED) {
  return defs.map(rule => {
    const h = ruleHistory(rule, ctx)
    if (h.paused) return { ...rule, state: 'inactive', health: 'ok', lastEvaluation: ZERO_TIME, lastError: '', alerts: null, seriesCount: h.seriesCount }
    if (h.error) return { ...rule, state: 'inactive', health: 'err', lastEvaluation: iso(h.to), lastError: h.error, alerts: null, seriesCount: 0 }
    const alerts = []
    for (const s of h.series) {
      const now = reading(s.value)
      for (const [tier, ivs] of Object.entries(s.tiers)) {
        const open = ivs[ivs.length - 1]
        if (!open || open.end != null) continue
        const before = ivs[ivs.length - 2]
        const activation = open.state === 'firing' && before?.state === 'pending' && before.end === open.start ? before : open
        const critical = tier === 'critical'
        const id = alertId(rule.id, s.key, tier)
        const labels = {
          alertname: rule.name,
          group: rule.labels?.group ?? 'Default Group',
          query: critical ? rule.query2 : rule.query,
          rule_id: String(rule.id),
          ...s.labels,
          ...(critical ? { severity: 'critical' } : rule.labels?.severity ? { severity: rule.labels.severity } : null),
        }
        alerts.push({
          state: open.state,
          name: renderTemplate(rule.name, { labels: s.labels, value: s.value }),
          value: now == null ? '' : String(now),
          labels,
          annotations: { ...rule.annotations, value: renderTemplate(rule.annotations?.value ?? '', { value: s.value }), cube_alert_event_time: String(h.to) },
          activeAt: iso(activation.start),
          id,
          rule_id: String(rule.id),
          group_id: String(rule.id),
          expression: critical ? rule.query2 : rule.query,
          source: `/alerts/${rule.id}?alert_id=${id}`,
          restored: false,
          stabilizing: false,
          firingAt: open.state === 'firing' ? open.start : null,
          openStart: !!activation.openStart,
        })
      }
    }
    const state = alerts.some(a => a.state === 'firing') ? 'firing' : alerts.some(a => a.state === 'pending') ? 'pending' : 'inactive'
    return { ...rule, state, health: 'ok', lastEvaluation: iso(h.to), lastError: '', alerts: alerts.length ? alerts : null, seriesCount: h.seriesCount }
  })
}

// ---------------------------------------------------------------------------
// What happened in a window: timeline, notification log, noise report
// ---------------------------------------------------------------------------

const overlaps = (iv, from, to) => iv.start < to && (iv.end ?? Infinity) > from

// One incident is consecutive firing stretches with no gap: a warning that
// escalates to critical and settles back is one incident, not three.
function incidents(intervals) {
  const out = []
  for (const iv of intervals) {
    if (iv.state !== 'firing') continue
    const last = out[out.length - 1]
    if (last && last.end === iv.start) {
      last.end = iv.end
      last.stretches.push(iv)
    } else {
      out.push({ start: iv.start, end: iv.end, openStart: !!iv.openStart, stretches: [iv] })
    }
  }
  return out
}

// The stretches a rule's notifications were held back, between from and to.
function suppressionsOf(rule, ctx, from, to) {
  const out = []
  for (const s of ruleSilences(rule, ctx.silences ?? [], NOW)) {
    if (s.end > from && s.start < to) out.push({ start: s.start, end: s.end, kind: 'snooze', silenceId: s.silence.id, createdBy: s.silence.createdBy, comment: s.silence.comment })
  }
  for (const m of ruleMuteIntervals(rule, ctx.muteGroups ?? [])) {
    for (const st of muteStretches(m.interval, from, to)) out.push({ start: st.start, end: st.end, kind: 'mute', scheduleId: m.scheduleId, name: m.name })
  }
  return out.sort((a, b) => a.start - b.start)
}

// When a rule notifies, and why: every incident's first firing ("fired"), a
// reminder every repeat interval while it fires, an escalation to critical,
// and the resolution. Grouped rules notify once per incident of the rule;
// ungrouped ones once per series (production's Notification Grouping, §6.5).
function notificationEvents(rule, h) {
  const repeat = Math.max(60, Number(rule.repeatInterval) || 14400)
  const lanes = rule.groupingDisable
    ? h.series.map(s => ({ labels: s.labels, intervals: s.intervals }))
    : [{ labels: null, intervals: h.intervals }]
  const out = []
  for (const lane of lanes) {
    for (const inc of incidents(lane.intervals)) {
      const until = inc.end ?? NOW
      if (!inc.openStart) out.push({ t: inc.start, event: 'fired', labels: lane.labels })
      for (const iv of inc.stretches.slice(1)) {
        if (iv.severity === 'critical') out.push({ t: iv.start, event: 'fired', labels: lane.labels, escalated: true })
      }
      for (let t = inc.start + repeat; t < until; t += repeat) out.push({ t, event: 'reminder', labels: lane.labels })
      if (inc.end != null) out.push({ t: inc.end, event: 'resolved', labels: lane.labels })
    }
  }
  return out
}

const isBroken = r => r.type === 'webhook' && r.data?.url === BROKEN_WEBHOOK
const rowId = (...parts) => Number(BigInt.asUintN(53, BigInt(alertId(...parts))))

function activity(win, defs, ctx) {
  const from = win.start
  const to = Math.min(win.end, NOW)
  const timeline = []
  const log = []
  const stats = []
  for (const rule of defs) {
    const h = ruleHistory(rule, ctx)
    const suppressed = suppressionsOf(rule, ctx, from, to)
    const sends = []
    let sent = 0
    let failed = 0
    if (!h.paused && !h.error) {
      const receivers = effectiveReceivers(rule, ctx.receiverGroups ?? [])
      const margin = 2 * 86400
      const held = suppressionsOf(rule, ctx, from - margin, to + 1)
      for (const ev of notificationEvents(rule, h)) {
        if (ev.t < from || ev.t > to) continue
        const snooze = held.find(s => s.kind === 'snooze' && s.start <= ev.t && ev.t < s.end)
        const mute = !snooze && held.find(s => s.kind === 'mute' && s.start <= ev.t && ev.t < s.end)
        receivers.forEach((r, i) => {
          if (ev.event === 'resolved' && !sendsResolved(r)) return
          const status = snooze ? 'SNOOZE' : mute ? 'MUTE' : isBroken(r) ? 'ERROR' : 'SUCCESS'
          const details = snooze ? `Snoozed by ${snooze.createdBy || 'someone'} until ${iso(snooze.end)}${snooze.comment ? `: ${snooze.comment}` : ''}`
            : mute ? `Muted by ${mute.name ? `"${mute.name}"` : 'this rule\'s own mute window'}`
              : status === 'ERROR' ? BROKEN_DETAILS : ''
          log.push({
            id: rowId(rule.id, ev.t, i, ev.event, JSON.stringify(ev.labels ?? {})),
            rule_id: rule.id,
            rule_name: ev.labels ? renderTemplate(rule.name, { labels: ev.labels }) : rule.name,
            receiver_type: r.type,
            receiver_data: r.data,
            status,
            details,
            created_at: iso(ev.t),
            // Ours, not production's (PLAN.md "Needs from the backend").
            event: ev.event,
            receiver_group_id: r.groupId,
            alert_labels: ev.labels ?? null,
          })
          if (status === 'SUCCESS') sent++
          if (status === 'ERROR') failed++
          if (status === 'SUCCESS' || status === 'ERROR') sends.push(ev.t)
        })
      }
    }
    const intervals = h.intervals.filter(iv => overlaps(iv, from, to))
    timeline.push({
      ruleId: rule.id,
      intervals,
      series: h.series.map(s => ({ key: s.key, labels: s.labels, intervals: s.intervals.filter(iv => overlaps(iv, from, to)) })).filter(s => s.intervals.length),
      suppressed: suppressed.map(s => ({ ...s, end: s.end > NOW ? null : s.end, until: s.end })),
      notifications: [...new Set(sends)].sort((a, b) => a - b),
    })
    // Production's Stats (§12): incidents that began in the window, and the
    // time spent firing in it, as minutes and as a share of the window.
    const span = Math.max(1, to - from)
    const inWindow = incidents(h.intervals).filter(inc => overlaps(inc, from, to))
    const firingSec = inWindow.reduce((a, inc) => a + Math.min(inc.end ?? NOW, to) - Math.max(inc.start, from), 0)
    const started = inWindow.filter(inc => inc.start >= from && !inc.openStart).length
    const durations = inWindow.map(inc => (inc.end ?? NOW) - inc.start).sort((a, b) => a - b)
    const median = durations.length ? durations[Math.floor((durations.length - 1) / 2)] : null
    const firingPct = (firingSec / span) * 100
    stats.push({
      ruleId: rule.id,
      incidents: started,
      firingSec,
      firingPct,
      medianSec: median,
      notifications: sent,
      failed,
      // Never fired means nothing at all happened: a rule that went pending is
      // alive, whether or not it went on to fire.
      flags: insightFlags({ paused: h.paused, error: !!h.error, spanSec: span, firingPct, incidents: started, medianSec: median, active: intervals.length > 0 }),
    })
  }
  log.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id)
  return { timeline, log, stats }
}

const activityCache = new WeakMap()
// Memoised per window on the store state (`ctx`) it was asked with: the hook
// passes the same state object until something in it changes, and `defs` is
// always derived from it.
function activityFor(win, defs, ctx) {
  let byWin = activityCache.get(ctx)
  if (!byWin) activityCache.set(ctx, (byWin = new Map()))
  const k = `${win.start}:${win.end}:${defs.length}`
  if (!byWin.has(k)) {
    if (byWin.size > 24) byWin.clear()
    byWin.set(k, activity(win, defs, ctx))
  }
  return byWin.get(k)
}

/**
 * Each rule's lane over the window (D4): `{ ruleId, intervals, series,
 * suppressed, notifications }`. Stretches are the rule's own (start/end in unix
 * seconds, end null while open) that overlap the window; `suppressed` are its
 * snoozes and mute windows there (end null while still in force, `until` its
 * real end); `notifications` the times it sent.
 */
export const ruleTimelineForWindow = (win, defs, ctx = SEED) => activityFor(win, defs, ctx).timeline

/**
 * Each contact point's last delivery per integration, over the whole horizon
 * (D9): `Map(groupId → [{ type, data, at, status, details, ruleName }])`, one
 * entry per integration that has sent, newest send first. What its row shows as
 * "sent 2m ago" or "failed 1h ago", so a broken webhook is seen on its contact
 * point before an incident depends on it. Only sends count — a muted or
 * snoozed notification was never attempted.
 */
export function lastDeliveries(defs, ctx = SEED) {
  const { log } = activityFor({ start: NOW - HORIZON_SEC, end: NOW }, defs, ctx)
  const out = new Map()
  for (const row of log) {
    if (row.receiver_group_id == null || (row.status !== 'SUCCESS' && row.status !== 'ERROR')) continue
    const at = Date.parse(row.created_at) / 1000
    const key = `${row.receiver_type}|${JSON.stringify(row.receiver_data)}`
    let byKey = out.get(row.receiver_group_id)
    if (!byKey) out.set(row.receiver_group_id, (byKey = new Map()))
    const seen = byKey.get(key)
    if (!seen || at > seen.at) {
      byKey.set(key, { type: row.receiver_type, data: row.receiver_data, at, status: row.status, details: row.details, ruleName: row.rule_name })
    }
  }
  return new Map([...out].map(([id, byKey]) => [id, [...byKey.values()].sort((a, b) => b.at - a.at)]))
}

/** The notification log over the window, newest first, in production's row shape plus `event`. */
export const notificationLogForWindow = (win, defs, ctx = SEED) => activityFor(win, defs, ctx).log

/**
 * The noise report over the window (D11): per rule, incidents begun in it,
 * seconds and share spent firing, the median incident, notifications sent and
 * failed, and the flags Insights raises.
 */
export const alertStatsForWindow = (win, defs, ctx = SEED) => activityFor(win, defs, ctx).stats

/**
 * A rule's query over the window, for its charts: one entry per series, each
 * point in windowSeries' shape (`{ m, t, label, exactTime, value }`). An
 * anomaly rule's points also carry `expected` and `sigma`, for its band.
 *
 * Each point is a reading the evaluator took: the rule's query at the bucket's
 * close, on the rule's own schedule, as production's rule graph draws it (the
 * expression evaluated at each step), not the bucket's average. So the line
 * crosses its threshold where the state strip turns, and the newest point of a
 * window that reaches now IS the reading the rule's state was decided on (its
 * alerts' `value`, so `view.value`), at every range. An average could not be:
 * a week's last bucket spreads a 22-minute incident over hours and sits under a
 * threshold the rule is firing over.
 *
 * That is where a rule's chart and the service page's part on a wide range. The
 * service page draws each bucket's aggregate (docs/decisions/
 * time-range-windowing.md), the question "how did this stretch go"; a rule's
 * chart draws its readings, "what did the rule see". Over Last 1 hour they are
 * the same line within the jitter.
 */
export function ruleSeriesForWindow(win, rule, ctx = SEED, b = bindingFor(rule, ctx)) {
  if (b.error) return []
  const anomaly = rule.kind === 'anomaly'
  const every = everyOf(rule)
  const past = win.buckets.filter(bk => !bk.future)
  const newest = past[past.length - 1]
  // The rule's last evaluation at or before the bucket's close. The newest
  // bucket of a window that reaches now closes at now, not at the minute it is
  // labelled with, which would leave a 15-second rule up to three readings
  // behind its own state. A 5-minute rule holds each reading for five minutes,
  // as its evaluator did.
  const readAt = bk => {
    const close = Math.min(NOW, bk.t + Math.round(bk.durMin * 60))
    return Math.floor((bk === newest && NOW - close < win.step ? NOW : close) / every) * every
  }
  return b.series.map(s => ({
    key: s.key,
    labels: s.labels,
    points: win.buckets.map(bk => {
      const pt = { m: bk.m, t: bk.t, label: bk.label, exactTime: bk.exactTime, value: null }
      if (bk.future) return pt
      const at = readAt(bk)
      pt.value = reading(valueAt(s, at))
      if (anomaly && s.profile) {
        pt.expected = reading(expectedAt(s, at))
        pt.sigma = reading(sigmaAt(s, at))
      }
      return pt
    }),
  }))
}

/**
 * A draft rule over the window, for the editor's preview (D6, D7): what its
 * chart draws and where it would have fired, worked out by the evaluator a
 * saved rule's page reads — so saving changes nothing the preview showed.
 *
 *   { error, series, lane, incidents, firingSec, share, suggestion }
 *
 * The evaluation starts a Fire after and a tick before the window, so a
 * condition already holding when the window opens is already firing there, as
 * it would be in the saved rule's history. `lane` is the merged stretches that
 * reach into the window, in the rule page's shape; `share` is how much of the
 * window that has happened was spent firing. `suggestion` is a threshold the
 * window would rarely cross, offered when the draft fires most of the time.
 */
export function previewRule(rule, win, ctx = SEED) {
  const every = everyOf(rule)
  const forSec = Number(rule?.duration) || 0
  const end = Math.min(win.end, NOW)
  const grid = { from: Math.floor((win.start - forSec) / every) * every - every, to: Math.floor(end / every) * every, every }
  const none = { series: [], lane: [], incidents: 0, firingSec: 0, share: 0, suggestion: null }
  const binding = bindingFor(rule, ctx, { from: grid.from, to: grid.to })
  if (binding.error) return { ...none, error: binding.error }
  const tiers = tiersOf(rule)
  const rows = binding.series.map(s => seriesHistory(rule, s, tiers, grid))
  const lane = mergeTierIntervals(rows.map(r => ({ intervals: r.intervals })))
    .filter(iv => iv.end == null || iv.end > win.start)
  let firingSec = 0
  let incidents = 0
  let prevEnd = null
  for (const iv of lane) {
    if (iv.state !== 'firing') continue
    firingSec += Math.max(0, Math.min(iv.end ?? end, end) - Math.max(iv.start, win.start))
    // A warning running straight into a critical stretch is one incident.
    if (prevEnd !== iv.start) incidents++
    prevEnd = iv.end
  }
  const series = ruleSeriesForWindow(win, rule, ctx, binding)
  const share = end > win.start ? firingSec / (end - win.start) : 0
  const lead = tiers.kind === 'anomaly' ? null : tiers.warning ?? tiers.critical
  const suggestion = lead && share > 0.5
    ? suggestThreshold(series.flatMap(x => x.points.map(pt => pt.value)), lead.op)
    : null
  return { error: null, series, lane, incidents, firingSec, share, suggestion }
}

/** The demo's "now", in unix seconds: when every rule was last evaluated. */
export const ALERTS_NOW = NOW

/**
 * The window one span earlier — the "previous period" every comparison on the
 * platform defaults to — as a window whose buckets line up one for one with
 * `win`'s: same count, same order, each moved back by the span. Sampling a
 * rule over it gives the previous period's series on the current axis, for a
 * row's delta and a chart's dashed comparison line.
 */
export function previousWindowOf(win) {
  const shift = win.spanSec
  return {
    ...win,
    start: win.start - shift,
    end: win.end - shift,
    buckets: win.buckets.map(b => {
      const m = b.m + shift / 60
      return { ...b, t: b.t - shift, ms: b.ms - shift * 1000, m, w: incidentWeightOver(m, b.durMin), future: false }
    }),
  }
}
