// Rules to start from: the Rules tab's template drawer (TemplateDrawer.jsx).
// Each is a rule that matters, already set — a query that watches it, the
// thresholds where the platform has them, a hold long enough not to flap —
// and opens the editor the way every "Create alert" in the app does, as a
// payload it reads (editorPayloads.js). Nothing is saved until the editor's
// Save; a template is a starting point, not a rule.
//
// Production's drawer lists a category per Kubernetes object, placeholder
// "Dummy" categories, and a tag that can repeat itself ("Logs · Logs"). Here
// there are five categories by what a rule watches, and a template whose data
// the demo does not produce says which source it needs (`needs`) rather than
// being left out: a cluster without kube-state-metrics still wants to know the
// template is there.
//
// Every query was checked against the demo's own data at every hour of the
// day: those with data fire in the payment incident or stay quiet through it,
// and none flaps (ruleTemplates.test.js). The log counts swing with the time
// of day far more than the incident moves them, so the log templates sit
// clear of the busiest quiet hour and stay quiet here; a real stream sets its
// own floor.

import { emptyPair } from '@/utils/explore/builders'
import { THRESHOLDS } from '@/utils/status'
import { alertPayloadForHostCpu } from './editorPayloads'

/**
 * The drawer's categories, in the order its capsules list them. `icon` names
 * the mark a capsule carries (TemplateDrawer.jsx SourceIcon).
 */
export const TEMPLATE_CATEGORIES = [
  { id: 'services', label: 'Services', icon: 'apm' },
  { id: 'dependencies', label: 'Dependencies', icon: 'database' },
  { id: 'logs', label: 'Logs', icon: 'logs' },
  { id: 'hosts', label: 'Hosts', icon: 'host' },
  { id: 'kubernetes', label: 'Kubernetes', icon: 'k8s' },
]

const above = (warn, critical) => ({
  ...(warn != null ? { warning: { op: '>', threshold: warn } } : {}),
  ...(critical != null ? { critical: { op: '>', threshold: critical } } : {}),
})

// A Quick model over every service, one series each.
const perService = calculate => ({
  type: 'quick', calculate, value: '90', labelPairs: [emptyPair()], groupBy: ['service'],
})

const metrics = (query, rest) => ({ datasource: 'prometheus', query, ...rest })
const logs = (query, rest) => ({ datasource: 'vlogs', query, ...rest })

// The noun a template's alerts are counted in: "one alert per service", "fired
// on 2 of 7 services".
const per = (one, many = `${one}s`) => ({ one, many })

/**
 * `{ id, category, source, title, description, per, needs, keywords, payload() }`,
 * in the order the drawer lists them. `source` is `{ label, icon }`, the
 * card's eyebrow; `needs` names the data source a template waits on, or null;
 * `payload()` is what `openLink({ view: 'alertEditor', ...payload })` takes.
 */
export const RULE_TEMPLATES = [
  // ---- Services (APM) ----
  {
    id: 'error-rate',
    category: 'services',
    source: { label: 'APM · Services', icon: 'apm' },
    title: 'Service error rate high',
    description: 'Warns when more than 1% of a service\'s requests fail, and goes critical above 3%: where its badge turns amber and red.',
    per: per('service'),
    keywords: ['errors', 'failures', '5xx'],
    payload: () => ({
      datasource: 'prometheus', model: perService('error_percentage'),
      tiers: above(THRESHOLDS.errorRatePct.warn, THRESHOLDS.errorRatePct.critical), forSec: 300,
      name: 'Service error rate high', group: 'Services',
    }),
  },
  {
    id: 'p90-latency',
    category: 'services',
    source: { label: 'APM · Services', icon: 'apm' },
    title: 'Service p90 latency high',
    description: 'Warns when a service\'s slowest 10% of requests take over 150 ms, and goes critical over 300 ms.',
    per: per('service'),
    keywords: ['latency', 'slow', 'response time', 'duration', 'p95', 'p99'],
    payload: () => ({
      datasource: 'prometheus', model: perService('latency_percentile'),
      tiers: above(THRESHOLDS.latencyP90Ms.warn, THRESHOLDS.latencyP90Ms.critical), forSec: 300,
      name: 'Service p90 latency high', group: 'Services',
    }),
  },
  {
    id: 'traffic-anomaly',
    category: 'services',
    source: { label: 'APM · Services', icon: 'apm' },
    title: 'Service traffic unusual',
    description: 'Warns when a service\'s requests a minute stray more than 3σ from what is normal for the time of day, up or down.',
    per: per('service'),
    keywords: ['traffic', 'throughput', 'rpm', 'requests', 'anomaly', 'drop', 'spike'],
    payload: () => ({
      datasource: 'prometheus', model: perService('rpm'), kind: 'anomaly',
      tiers: { warning: { op: '<>', deviations: 3 } }, forSec: 300,
      name: 'Service traffic unusual', group: 'Services',
    }),
  },
  {
    id: 'traffic-stopped',
    category: 'services',
    source: { label: 'APM · Services', icon: 'apm' },
    title: 'Service stopped receiving requests',
    description: 'Critical when a service handles under 1 request a minute for 10 minutes: a crash, a bad deploy or lost instrumentation.',
    per: per('service'),
    keywords: ['traffic', 'throughput', 'rpm', 'down', 'outage', 'dead'],
    payload: () => ({
      datasource: 'prometheus', model: perService('rpm'),
      tiers: { critical: { op: '<', threshold: 1 } }, forSec: 600,
      name: 'Service stopped receiving requests', group: 'Services',
    }),
  },
  {
    id: 'exceptions',
    category: 'services',
    source: { label: 'APM · Errors', icon: 'apm' },
    title: 'Exceptions spiking',
    description: 'Warns when a service throws one exception type more than 10 times a minute, and goes critical above 30.',
    per: per('exception type'),
    keywords: ['errors', 'exception', 'stack trace', 'crash'],
    payload: () => metrics('sum by (service, exception) (rate(cube_apm_errors_total[1m])) * 60', {
      tiers: above(10, 30), forSec: 120, name: 'Exceptions spiking', group: 'Services',
    }),
  },

  // ---- Dependencies ----
  {
    id: 'dependency-surge',
    category: 'dependencies',
    source: { label: 'APM · Dependencies', icon: 'apm' },
    title: 'Calls to a dependency surging',
    description: 'Warns when a service calls a database or API 30% more than an hour ago, critical at 50% more: often retries piling up.',
    per: per('dependency', 'dependencies'),
    keywords: ['database', 'db', 'external', 'api', 'calls', 'retries', 'downstream'],
    payload: () => metrics(
      'sum by (service, group_name) (rate(cube_apm_calls_total{span_kind="client"}[5m])) / sum by (service, group_name) (rate(cube_apm_calls_total{span_kind="client"}[5m] offset 1h)) * 100',
      { tiers: above(130, 150), forSec: 300, name: 'Calls to a dependency surging', group: 'Dependencies' },
    ),
  },
  {
    id: 'redis-clients',
    category: 'dependencies',
    source: { label: 'Redis', icon: 'redis' },
    title: 'Redis connections climbing',
    description: 'Warns above 150 connected clients and goes critical above 200: a connection pool leaking or exhausted.',
    per: per('instance'),
    keywords: ['cache', 'pool', 'connections', 'clients', 'database', 'db'],
    payload: () => metrics('redis_connected_clients', {
      tiers: above(150, 200), forSec: 300, name: 'Redis connections climbing', group: 'Dependencies',
    }),
  },
  {
    id: 'mysql-threads',
    category: 'dependencies',
    source: { label: 'MySQL', icon: 'mysql' },
    title: 'MySQL connections high',
    description: 'Warns above 100 connected threads and goes critical above 150, held for 5 minutes.',
    per: per('instance'),
    keywords: ['database', 'db', 'sql', 'connections', 'threads', 'pool'],
    payload: () => metrics('mysql_threads_connected', {
      tiers: above(100, 150), forSec: 300, name: 'MySQL connections high', group: 'Dependencies',
    }),
  },

  // ---- Logs ----
  {
    id: 'error-logs',
    category: 'logs',
    source: { label: 'Logs', icon: 'logs' },
    title: 'Error logs spiking',
    description: 'Warns when a service writes more than 50 error-level lines in a 5-minute check, and goes critical above 100.',
    per: per('service'),
    keywords: ['errors', 'log level', 'error logs'],
    payload: () => logs('log.level:="error" | stats by (service) count()', {
      tiers: above(50, 100), forSec: 0, intervalSec: 300, name: 'Error logs spiking', group: 'Logs',
    }),
  },
  {
    id: 'slow-request-logs',
    category: 'logs',
    source: { label: 'Logs', icon: 'logs' },
    title: 'Slow requests in logs',
    description: 'Warns when a service logs more than 75 requests over 1 second in a 5-minute check, and goes critical above 150.',
    per: per('service'),
    keywords: ['latency', 'slow', 'duration', 'timeout'],
    payload: () => logs('duration_ms:>1000 | stats by (service) count()', {
      tiers: above(75, 150), forSec: 0, intervalSec: 300, name: 'Slow requests in logs', group: 'Logs',
    }),
  },

  // ---- Hosts ----
  {
    id: 'host-cpu',
    category: 'hosts',
    source: { label: 'Infrastructure · Hosts', icon: 'host' },
    title: 'Host CPU high',
    description: 'Warns above 70% CPU on a host for 5 minutes and goes critical above 85%: the Infrastructure page\'s own lines.',
    per: per('host'),
    keywords: ['cpu', 'infrastructure', 'node', 'machine', 'vm'],
    payload: () => {
      const one = alertPayloadForHostCpu('host')
      return { ...one, model: { ...one.model, labelPairs: [emptyPair()] }, forSec: 300, name: 'Host CPU high' }
    },
  },
  {
    id: 'host-memory',
    category: 'hosts',
    source: { label: 'Infrastructure · Hosts', icon: 'host' },
    title: 'Host memory climbing',
    description: 'Warns when a host uses 15% more memory than an hour ago, critical at 25% more: a leak, caught before the OOM killer.',
    per: per('host'),
    keywords: ['memory', 'ram', 'leak', 'oom', 'infrastructure', 'machine'],
    payload: () => metrics('system_memory_usage_bytes / (system_memory_usage_bytes offset 1h) * 100', {
      tiers: above(115, 125), forSec: 300, name: 'Host memory climbing', group: 'Infrastructure',
    }),
  },

  // ---- Kubernetes ----
  {
    id: 'pod-cpu',
    category: 'kubernetes',
    source: { label: 'Kubernetes · Pods', icon: 'k8s' },
    title: 'Pod CPU high',
    description: 'Warns above 80% pod CPU for 10 minutes and goes critical above 90%, for each namespace on each node.',
    per: per('node'),
    keywords: ['k8s', 'cpu', 'pods', 'containers', 'throttling'],
    payload: () => metrics('k8s_pod_cpu_utilization * 100', {
      tiers: above(80, 90), forSec: 600, name: 'Pod CPU high', group: 'Kubernetes',
    }),
  },
  {
    id: 'crash-loop',
    category: 'kubernetes',
    source: { label: 'Kubernetes · Events', icon: 'k8s' },
    title: 'Pods crash-looping',
    description: 'Warns when a namespace logs more than 35 BackOff events in a 5-minute check, held 10 minutes: containers restarting again and again.',
    per: per('namespace'),
    keywords: ['k8s', 'backoff', 'crashloopbackoff', 'restarts', 'pods', 'events'],
    payload: () => logs('event.domain:="k8s" AND object.reason:="BackOff" | stats by (k8s.namespace.name) count()', {
      tiers: above(35), forSec: 600, intervalSec: 300, name: 'Pods crash-looping', group: 'Kubernetes',
    }),
  },
  {
    id: 'container-restarts',
    category: 'kubernetes',
    source: { label: 'Kubernetes · Pods', icon: 'k8s' },
    title: 'Containers restarting',
    description: 'Warns when a pod\'s containers restart more than once in 15 minutes, and goes critical above 3 restarts.',
    per: per('pod'),
    needs: 'kube-state-metrics',
    keywords: ['k8s', 'restarts', 'oomkilled', 'pods', 'containers'],
    payload: () => metrics('sum by (namespace, pod) (increase(kube_pod_container_status_restarts_total[15m]))', {
      tiers: above(1, 3), forSec: 0, name: 'Containers restarting', group: 'Kubernetes',
    }),
  },
  {
    id: 'node-not-ready',
    category: 'kubernetes',
    source: { label: 'Kubernetes · Nodes', icon: 'k8s' },
    title: 'Node not ready',
    description: 'Critical when a node has not reported Ready for 5 minutes: its pods stop being scheduled there.',
    per: per('node'),
    needs: 'kube-state-metrics',
    keywords: ['k8s', 'nodes', 'ready', 'notready', 'cluster'],
    payload: () => metrics('kube_node_status_condition{condition="Ready", status="true"}', {
      tiers: { critical: { op: '==', threshold: 0 } }, forSec: 300, name: 'Node not ready', group: 'Kubernetes',
    }),
  },
].map(t => ({ needs: null, ...t }))

const words = text => String(text ?? '').toLowerCase().split(/\s+/).filter(Boolean)

/**
 * The templates a search and a category leave, in catalogue order. Every word
 * typed must appear somewhere in a template — its title, description, source,
 * category or keywords — so "redis pool" finds the Redis template and "k8s"
 * finds the Kubernetes ones.
 */
export function filterTemplates(templates, { category = 'all', q = '' } = {}) {
  const want = words(q)
  const label = id => TEMPLATE_CATEGORIES.find(c => c.id === id)?.label ?? ''
  return templates.filter(t => {
    if (category !== 'all' && t.category !== category) return false
    if (!want.length) return true
    const hay = [t.title, t.description, t.source.label, label(t.category), ...t.keywords].join(' ').toLowerCase()
    return want.every(w => hay.includes(w))
  })
}

/** The drawer's capsules: All, then each category, each counting what the search leaves. */
export function templateTabs(templates, q = '') {
  const found = filterTemplates(templates, { q })
  return [
    { id: 'all', label: 'All', count: found.length },
    ...TEMPLATE_CATEGORIES.map(c => ({ id: c.id, label: c.label, icon: c.icon, count: found.filter(t => t.category === c.id).length })),
  ]
}
