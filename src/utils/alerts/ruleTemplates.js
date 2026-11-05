// The template catalogue behind Browse Templates (/alerts/templates,
// AlertTemplatesView.jsx). A template is a rule that matters, already set — a
// query that watches it, the thresholds where the platform has them, a hold
// long enough not to flap — and "Use template" opens the editor on it the way
// every "Create alert" in the app does, as a payload it reads
// (editorPayloads.js). Nothing is saved until the editor's Save; a template is
// a starting point, not a rule.
//
// Two layers (docs/decisions/alerts-page.md): the Domain, the area of the
// stack, then the Sub-domain — the integration, named as the Infrastructure
// page names it (Host, Kubernetes, MySQL, PostgreSQL), or, for our own app,
// the platform module (Services, Errors, Mobile, Browser). There is no third
// layer: the service or host a rule is about is its filter or its split. A
// template has one home, where it is counted and which its card names;
// another parent lists it too, after its own. Hosting (self-managed, AWS, GCP, SaaS) is a
// badge, not a layer. Problem type, data source and urgency are filters.
//
// Every template with data is checked against the demo's data
// (ruleTemplates.test.js): none fires before the payment incident over a day,
// and those whose data moves with the incident catch it. A template whose
// data the demo does not produce says which source it waits on (`needs`)
// rather than being left out; one the platform cannot run yet says why
// (`blocked`) and cannot be used.

import { emptyPair } from '@/utils/explore/builders'
import { THRESHOLDS } from '@/utils/status'
import { datasourceId } from './catalog'
import { alertPayloadForHostCpu } from './editorPayloads'

// ---------- The two layers ----------

/** The Sub-domains, by id: the label the Infrastructure page or the sidebar uses, the mark, and what else people call it. */
export const SUBDOMAINS = {
  services: { label: 'Services', domain: 'apm', icon: 'services', aliases: ['apm', 'service', 'requests', 'endpoints'] },
  errors: { label: 'Errors', domain: 'apm', icon: 'errors', aliases: ['exceptions', 'crashes', 'failures'] },
  mobile: { label: 'Mobile', domain: 'apm', icon: 'mobile', aliases: ['ios', 'android', 'app', 'mobile app'] },
  browser: { label: 'Browser', domain: 'apm', icon: 'browser', aliases: ['rum', 'real user monitoring', 'frontend', 'web'] },
  host: { label: 'Host', domain: 'cloud-hosts', icon: 'host', aliases: ['hosts', 'server', 'vm', 'ec2', 'compute engine', 'machine', 'node'] },
  kubernetes: { label: 'Kubernetes', domain: 'containers', icon: 'k8s', aliases: ['k8s', 'k8', 'eks', 'gke', 'aks', 'pods', 'containers', 'cluster'] },
  mysql: { label: 'MySQL', domain: 'databases', icon: 'mysql', aliases: ['rds', 'aurora', 'mariadb', 'sql'] },
  postgresql: { label: 'PostgreSQL', domain: 'databases', icon: 'postgres', aliases: ['postgres', 'postgress', 'pg', 'rds', 'cloud sql', 'aurora', 'sql'] },
}

/** The Domains, in the order the rail lists them, each with its Sub-domains. */
export const DOMAINS = [
  { id: 'apm', label: 'APM', icon: 'apm', subs: ['services', 'errors', 'mobile', 'browser'] },
  { id: 'cloud-hosts', label: 'Cloud & Hosts', icon: 'cloud', subs: ['host'] },
  { id: 'containers', label: 'Containers & Kubernetes', icon: 'containers', subs: ['kubernetes'] },
  { id: 'databases', label: 'Databases', icon: 'databases', subs: ['mysql', 'postgresql'] },
]

const DOMAIN = new Map(DOMAINS.map(d => [d.id, d]))
export const domainOf = subId => DOMAIN.get(SUBDOMAINS[subId]?.domain) ?? null

/** Problem types, data sources, urgencies and hostings: the filters' and the tags' words. */
export const PROBLEM_TYPES = [
  { id: 'availability', label: 'Availability' },
  { id: 'errors', label: 'Errors' },
  { id: 'latency', label: 'Latency' },
  { id: 'traffic', label: 'Traffic' },
  { id: 'saturation', label: 'Saturation' },
]
export const DATA_SOURCES = [
  { id: 'metrics', label: 'Metrics' },
  { id: 'logs', label: 'Logs' },
  { id: 'traces', label: 'Traces' },
  { id: 'mobile', label: 'Mobile' },
]
export const URGENCIES = [
  { id: 'high', label: 'High', word: 'Wake someone' },
  { id: 'medium', label: 'Medium', word: 'Act today' },
  { id: 'low', label: 'Low', word: 'Review' },
]
export const HOSTINGS = [
  { id: 'self-managed', label: 'Self-managed' },
  { id: 'aws', label: 'AWS' },
  { id: 'gcp', label: 'GCP' },
  { id: 'saas', label: 'SaaS' },
]
const LABEL = list => Object.fromEntries(list.map(x => [x.id, x.label]))
const PROBLEM_LABEL = LABEL(PROBLEM_TYPES)
const SOURCE_LABEL = LABEL(DATA_SOURCES)
const HOSTING_LABEL = LABEL(HOSTINGS)

// ---------- Building blocks ----------

const above = (warn, critical) => ({
  ...(warn != null ? { warning: { op: '>', threshold: warn } } : {}),
  ...(critical != null ? { critical: { op: '>', threshold: critical } } : {}),
})

// A Quick model over every service, one series each: bound to the services'
// own profiles, so it reads what the service pages read.
const perService = (calculate, value = '90') => ({
  type: 'quick', calculate, value, labelPairs: [emptyPair()], groupBy: ['service'],
})

const metrics = (query, rest) => ({ datasource: 'prometheus', query, ...rest })
const logs = (query, rest) => ({ datasource: 'vlogs', query, ...rest })
// Mobile alerts are deferred (docs/alerts/DESIGN.md, Q6): a Mobile template
// keeps the payload a Mobile datasource will take, and is blocked until then.
const mobile = (query, rest) => ({ datasource: 'mobile', query, ...rest })

// The Infrastructure page's own "Create alert" on a host's CPU chart, over
// every host: the same Advanced model, at the host table's 70% and 85%.
const hostCpu = () => {
  const one = alertPayloadForHostCpu('host')
  return { ...one, model: { ...one.model, labelPairs: [emptyPair()] }, forSec: 300, name: undefined, group: undefined }
}

// ---------- The catalogue ----------

/**
 * `{ id, home, alsoIn, title, subtitle, why, summary, hosting, problem,
 * urgency, aliases, needs, blocked, payload }`. `id` is the template's system
 * ID, "<home>.<slug>"; `title` is "Subject + state" (≤ 45 characters); the
 * full alert name adds the Sub-domain ("MySQL: Connections near limit").
 * `subtitle` is the card's line of definition; `why` is not on the card,
 * but becomes the rule's description, and the search reads it. `summary` is what a
 * notification leads with: one firing series in its own labels and value,
 * without the thresholds, which the rule's tiers state and a tune changes.
 * `payload` is what the editor takes, without the name, folder, details and
 * tag, which templatePayload adds.
 */
export const RULE_TEMPLATES = [
  // ---- services ----
  {
    id: 'services.error-rate-high',
    home: 'services', alsoIn: ['errors'],
    title: 'Error rate is high',
    subtitle: 'A service\'s failed requests: warns above 1%, critical above 3%, held 5 minutes',
    why: 'Users are getting errors; past 3% a deploy or a dependency has usually broken',
    summary: '{{ .Labels.service }} is failing {{ printf "%.2f" .Value }}% of requests',
    hosting: [], problem: 'errors', urgency: 'high',
    aliases: ['errors', 'error rate', 'error %', 'failures', 'failed requests', '5xx', 'red metrics', 'apm', 'service health'],
    needs: null, blocked: null,
    payload: { datasource: 'prometheus', model: perService('error_percentage'), tiers: above(THRESHOLDS.errorRatePct.warn, THRESHOLDS.errorRatePct.critical), forSec: 300 },
  },
  {
    id: 'services.p90-latency-high',
    home: 'services', alsoIn: [],
    title: 'p90 latency is high',
    subtitle: 'A service\'s p90 response time: warns over 150 ms, critical over 300 ms, held 5 minutes',
    why: 'One request in ten is slow; callers back up, time out and retry, and the slowdown spreads upstream',
    summary: '{{ .Labels.service }} p90 is {{ printf "%.0f" .Value }} ms',
    hosting: [], problem: 'latency', urgency: 'medium',
    aliases: ['latency', 'slow', 'response time', 'duration', 'p90', 'percentile', 'performance', 'apm'],
    needs: null, blocked: null,
    payload: { datasource: 'prometheus', model: perService('latency_percentile'), tiers: above(THRESHOLDS.latencyP90Ms.warn, THRESHOLDS.latencyP90Ms.critical), forSec: 300 },
  },
  {
    id: 'services.avg-latency-up',
    home: 'services', alsoIn: [],
    title: 'Average latency is up vs an hour ago',
    subtitle: 'Avg latency vs an hour ago, services over 10 rpm: warns above 1.5x, critical above 2x, held 5 minutes',
    why: 'Catches a bad deploy or slow dependency on a fast service that a fixed latency line never reaches',
    summary: '{{ .Labels.service }} average latency is {{ printf "%.0f" .Value }}% of an hour ago\'s',
    hosting: [], problem: 'latency', urgency: 'medium',
    aliases: ['latency', 'average latency', 'mean', 'response time', 'regression', 'slow', 'deploy', 'baseline', 'hour over hour'],
    needs: null, blocked: null,
    payload: metrics('(sum by (service) (rate(cube_apm_latency_sum{span_kind=~"server|consumer"}[5m])) / sum by (service) (rate(cube_apm_latency_count{span_kind=~"server|consumer"}[5m]))) / (sum by (service) (rate(cube_apm_latency_sum{span_kind=~"server|consumer"}[5m] offset 1h)) / sum by (service) (rate(cube_apm_latency_count{span_kind=~"server|consumer"}[5m] offset 1h))) * 100 and on (service) sum by (service) (rate(cube_apm_latency_count{span_kind=~"server|consumer"}[5m])) * 60 > 10 and on (service) sum by (service) (rate(cube_apm_latency_count{span_kind=~"server|consumer"}[5m] offset 1h)) * 60 > 10', { tiers: { warning: { op: '>', threshold: 150 }, critical: { op: '>', threshold: 200 } }, forSec: 300 }),
  },
  {
    id: 'services.endpoint-error-rate-high',
    home: 'services', alsoIn: [],
    title: 'Endpoint error rate is high',
    subtitle: 'Each endpoint over 10 rpm: warns above 1% errors, critical above 3%, held 5 minutes',
    why: 'One broken route, like checkout, hides inside a healthy service average until customers report it',
    summary: '{{ .Labels.service }} {{ .Labels.root_name }} is failing {{ printf "%.2f" .Value }}% of requests',
    hosting: [], problem: 'errors', urgency: 'medium',
    aliases: ['endpoint', 'route', 'api', 'root_name', 'transaction', 'operation', 'errors', 'error rate', '5xx', 'failures'],
    needs: null, blocked: null,
    payload: metrics('sum by (service, root_name) (rate(cube_apm_calls_total{span_kind=~"server|consumer", status_code="ERROR"}[5m])) / sum by (service, root_name) (rate(cube_apm_calls_total{span_kind=~"server|consumer"}[5m])) * 100 and sum by (service, root_name) (rate(cube_apm_calls_total{span_kind=~"server|consumer"}[5m])) * 60 > 10', { tiers: { warning: { op: '>', threshold: 1 }, critical: { op: '>', threshold: 3 } }, forSec: 300 }),
  },
  {
    id: 'services.endpoint-p99-latency-high',
    home: 'services', alsoIn: [],
    title: 'Endpoint p99 latency is high',
    subtitle: 'Each endpoint over 10 rpm, /batch aside: p99 warns above 500 ms, critical above 1 s, held 10 minutes',
    why: 'The slowest 1% hit client timeouts and retries first; tail latency is where overload starts',
    summary: '{{ .Labels.service }} {{ .Labels.root_name }} p99 is {{ printf "%.0f" .Value }} ms',
    hosting: [], problem: 'latency', urgency: 'medium',
    aliases: ['endpoint', 'route', 'api', 'root_name', 'transaction', 'p99', 'tail latency', 'slow', 'timeout', 'percentile'],
    needs: null, blocked: null,
    payload: metrics('histogram_quantile(0.99, sum by (service, root_name, vmrange) (rate(cube_apm_latency_bucket{span_kind=~"server|consumer", root_name!~".*/batch"}[5m]))) * 1000 and on (service, root_name) sum by (service, root_name) (rate(cube_apm_latency_count{span_kind=~"server|consumer", root_name!~".*/batch"}[5m])) * 60 > 10', { tiers: { warning: { op: '>', threshold: 500 }, critical: { op: '>', threshold: 1000 } }, forSec: 600 }),
  },
  {
    id: 'services.traffic-stopped',
    home: 'services', alsoIn: [],
    title: 'Traffic has stopped',
    subtitle: 'Critical when a service seen in the last day handles under 1 request a minute for 5 minutes',
    why: 'A crash, bad deploy or broken route stops traffic silently, and error and latency rules go quiet',
    summary: '{{ .Labels.service }} is handling {{ printf "%.1f" .Value }} requests a minute',
    hosting: [], problem: 'availability', urgency: 'high',
    aliases: ['traffic', 'throughput', 'rpm', 'requests', 'down', 'outage', 'dead', 'no traffic', 'zero requests', 'stopped'],
    needs: null, blocked: null,
    payload: metrics('(sum by (service) (rate(cube_apm_calls_total{span_kind=~"server|consumer"}[5m])) or sum by (service) (increase(cube_apm_calls_total{span_kind=~"server|consumer"}[1d])) * 0) * 60', { tiers: { critical: { op: '<', threshold: 1 } }, forSec: 300 }),
  },
  {
    id: 'services.traffic-anomaly',
    home: 'services', alsoIn: [],
    title: 'Traffic is unusual for the time of day',
    subtitle: 'Requests a minute 3σ above or below normal for the time of day, held 10 minutes',
    why: 'A drop means callers cannot reach it; a spike means retries, a bot or a launch is loading it',
    summary: '{{ .Labels.service }} is handling {{ printf "%.0f" .Value }} requests a minute, unusual for the time of day',
    hosting: [], problem: 'traffic', urgency: 'medium',
    aliases: ['traffic', 'throughput', 'rpm', 'requests', 'anomaly', 'baseline', 'spike', 'drop', 'seasonality', 'unusual'],
    needs: null, blocked: null,
    payload: { datasource: 'prometheus', model: perService('rpm'), kind: 'anomaly', tiers: { warning: { op: '<>', deviations: 3 } }, forSec: 600 },
  },
  {
    id: 'services.version-error-rate-high',
    home: 'services', alsoIn: [],
    title: 'Version error rate is high',
    subtitle: 'Each version over 10 rpm, while two or more run: warns above 1% errors, critical above 3%, held 5 minutes',
    why: 'A failing canary hides in the service average; caught per version, it is rolled back early',
    summary: '{{ .Labels.service }} {{ index .Labels "service.version" }} is failing {{ printf "%.2f" .Value }}% of requests',
    hosting: [], problem: 'errors', urgency: 'high',
    aliases: ['canary', 'version', 'service.version', 'deploy', 'deployment', 'release', 'rollout', 'regression', 'rollback', 'errors'],
    needs: null, blocked: null,
    payload: metrics('(sum by (service, service.version) (rate(cube_apm_calls_total{span_kind=~"server|consumer", status_code="ERROR"}[5m])) / sum by (service, service.version) (rate(cube_apm_calls_total{span_kind=~"server|consumer"}[5m])) * 100 and sum by (service, service.version) (rate(cube_apm_calls_total{span_kind=~"server|consumer"}[5m])) * 60 > 10) and on (service) (count by (service) (count by (service, service.version) (cube_apm_calls_total{span_kind=~"server|consumer"})) > 1)', { tiers: { warning: { op: '>', threshold: 1 }, critical: { op: '>', threshold: 3 } }, forSec: 300 }),
  },
  {
    id: 'services.dependency-calls-surging',
    home: 'services', alsoIn: ['mysql', 'postgresql'],
    title: 'Dependency calls per request are surging',
    subtitle: 'Calls to a dependency per request served, vs an hour ago: warns above 1.5x, critical above 2x, held 5 min',
    why: 'More calls per request than an hour ago is usually retries piling up; the dependency saturates next',
    summary: '{{ .Labels.service }} makes {{ printf "%.0f" .Value }}% of an hour ago\'s calls per request to {{ .Labels.group_name }}',
    hosting: [], problem: 'traffic', urgency: 'medium',
    aliases: ['dependency', 'downstream', 'external', 'database', 'db', 'redis', 'mysql', 'mongodb', 'api', 'calls', 'retries', 'retry storm'],
    needs: null, blocked: null,
    payload: metrics('(sum by (service, group_name) (rate(cube_apm_calls_total{span_kind="client"}[5m])) / on (service) group_left () sum by (service) (rate(cube_apm_calls_total{span_kind=~"server|consumer"}[5m]))) / ((sum by (service, group_name) (rate(cube_apm_calls_total{span_kind="client"}[5m] offset 1h)) > 0.1) / on (service) group_left () sum by (service) (rate(cube_apm_calls_total{span_kind=~"server|consumer"}[5m] offset 1h))) * 100 and on (service) sum by (service) (rate(cube_apm_calls_total{span_kind=~"server|consumer"}[5m])) * 60 > 10', { tiers: { warning: { op: '>', threshold: 150 }, critical: { op: '>', threshold: 200 } }, forSec: 300 }),
  },

  // ---- errors ----
  {
    id: 'errors.exceptions-spiking',
    home: 'errors', alsoIn: [],
    title: 'Exceptions are spiking',
    subtitle: 'A service throws one exception type over 10 times a minute (warning) or 30 (critical), held 2 minutes',
    why: 'One exception class surging is often a bad deploy or a failing dependency, before users report it',
    summary: '{{ .Labels.service }} is throwing {{ .Labels.exception }} {{ printf "%.0f" .Value }} times a minute',
    hosting: [], problem: 'errors', urgency: 'medium',
    aliases: ['exceptions', 'exception spike', 'stack trace', 'errors per minute', 'throwable', 'error count'],
    needs: null, blocked: null,
    payload: metrics('sum by (service, exception) (rate(cube_apm_errors_total[5m])) * 60', { tiers: { warning: { op: '>', threshold: 10 }, critical: { op: '>', threshold: 30 } }, forSec: 120 }),
  },
  {
    id: 'errors.5xx-climbing',
    home: 'errors', alsoIn: [],
    title: '5xx responses are climbing',
    subtitle: 'A service answers with one 5xx code over 10 times a minute (warning) or 30 (critical), held 5 minutes',
    why: 'Each 5xx is a request a user saw fail; 500 points at the app, 502 and 504 at a gateway or timeout',
    summary: '{{ .Labels.service }} answered {{ .Labels.http_code }} {{ printf "%.0f" .Value }} times in a minute',
    hosting: [], problem: 'errors', urgency: 'high',
    aliases: ['5xx', '500', '502', '503', '504', 'server errors', 'http errors', 'bad gateway', 'gateway timeout', 'status code', 'failed requests'],
    needs: null, blocked: null,
    payload: metrics('sum by (service, http_code) (increase(cube_apm_calls_total{span_kind=~"server|consumer", http_code=~"5.."}[1m]))', { tiers: { warning: { op: '>', threshold: 10 }, critical: { op: '>', threshold: 30 } }, forSec: 300 }),
  },
  {
    id: 'errors.host-error-rate',
    home: 'errors', alsoIn: ['host'],
    title: 'Host error rate stands out',
    subtitle: 'A host\'s error % runs over 1 point (warning) or 3 points (critical) above its service\'s, held 5 minutes',
    why: 'One bad host fails a slice of every user\'s requests while the service-wide rate can still look fine',
    summary: '{{ .Labels.service }} on {{ index .Labels "host.name" }} is failing {{ printf "%.2f" .Value }} points more of its requests than the service',
    hosting: [], problem: 'errors', urgency: 'medium',
    aliases: ['host', 'instance', 'node', 'bad host', 'outlier host', 'errors by host', 'error rate per host', 'hotspot', 'noisy neighbour'],
    needs: null, blocked: null,
    payload: metrics('(sum by (service, host.name) (rate(cube_apm_calls_total{span_kind=~"server|consumer", status_code="ERROR"}[5m])) / sum by (service, host.name) (rate(cube_apm_calls_total{span_kind=~"server|consumer"}[5m])) * 100) - on (service) group_left () (sum by (service) (rate(cube_apm_calls_total{span_kind=~"server|consumer", status_code="ERROR"}[5m])) / sum by (service) (rate(cube_apm_calls_total{span_kind=~"server|consumer"}[5m])) * 100) and sum by (service, host.name) (rate(cube_apm_calls_total{span_kind=~"server|consumer"}[5m])) * 60 > 10', { tiers: { warning: { op: '>', threshold: 1 }, critical: { op: '>', threshold: 3 } }, forSec: 300 }),
  },
  {
    id: 'errors.pool-exhausted',
    home: 'errors', alsoIn: [],
    title: 'Connection pool is exhausted',
    subtitle: 'A service logs over 5 \'pool exhausted\' or \'too many connections\' lines in a 5-minute check',
    why: 'With its pool empty a service can\'t reach Redis or its database, so every request needing it fails',
    summary: '{{ .Labels.service }} logged {{ printf "%.0f" .Value }} connection-pool errors in its last check',
    hosting: [], problem: 'saturation', urgency: 'high',
    aliases: ['connection pool', 'pool exhausted', 'pool timeout', 'redis', 'jedis', 'JedisPoolException', 'hikari', 'dbcp', 'too many connections', 'too many clients', 'database connections', 'resource exhausted'],
    needs: null, blocked: null,
    payload: logs('_msg:~"[Pp]ool exhausted|get a resource from the pool|Connection is not available|Timeout waiting for idle object|[Tt]oo many connections|too many clients" | stats by (service) count()', { tiers: { critical: { op: '>', threshold: 5 } }, forSec: 0, intervalSec: 300 }),
  },

  // ---- mobile ----
  {
    id: 'mobile.requests-failing',
    home: 'mobile', alsoIn: [],
    title: 'App requests are failing',
    subtitle: 'The app gets over 50 5xx responses from one domain per 5-minute check, twice running; critical over 150',
    why: 'This is the outage as phones see it, gateways and CDNs included, which server metrics can miss',
    summary: 'The app got {{ printf "%.0f" .Value }} 5xx responses from {{ .Labels.requestDomain }} in its last check',
    hosting: [], problem: 'errors', urgency: 'medium',
    aliases: ['mobile', 'ios', 'android', 'app', 'MobileRequestError', 'network errors', '5xx', 'api errors', 'failed requests', 'requestDomain', 'checkout'],
    needs: null, blocked: 'Mobile alerts aren\'t available yet.',
    payload: mobile('eventType:="MobileRequestError" AND status_code:>=500 | stats by (requestDomain) count()', { tiers: { warning: { op: '>', threshold: 50 }, critical: { op: '>', threshold: 150 } }, forSec: 300, intervalSec: 300 }),
  },
  {
    id: 'mobile.app-crashing',
    home: 'mobile', alsoIn: [],
    title: 'App is crashing',
    subtitle: 'One build on one OS crashes over 25 times in 15 minutes (warning) or 100 times (critical)',
    why: 'A crash ends the user\'s session outright; a burst on one build usually means a release to halt',
    summary: 'Build {{ .Labels.app_build }} on {{ .Labels.os_name }} crashed {{ printf "%.0f" .Value }} times in its last check',
    hosting: [], problem: 'errors', urgency: 'high',
    aliases: ['mobile', 'crash', 'crashes', 'MobileCrash', 'ios', 'android', 'app build', 'release', 'SIGSEGV', 'crash rate'],
    needs: null, blocked: 'Mobile alerts aren\'t available yet.',
    payload: mobile('eventType:="MobileCrash" | stats by (app_build, os_name) count()', { tiers: { warning: { op: '>', threshold: 25 }, critical: { op: '>', threshold: 100 } }, forSec: 0, intervalSec: 900 }),
  },

  // ---- browser ----
  {
    id: 'browser.js-errors-spiking',
    home: 'browser', alsoIn: [],
    title: 'JavaScript errors are spiking',
    subtitle: 'An app logs over 15 script errors per 100 page views (warning) or 30 (critical), held 10 minutes',
    why: 'A script error can leave a page half-working: a dead button, a checkout that won\'t submit',
    summary: '{{ .Labels.service }} is logging {{ printf "%.1f" .Value }} script errors per 100 page views',
    hosting: [], problem: 'errors', urgency: 'medium',
    aliases: ['javascript', 'js errors', 'script errors', 'TypeError', 'uncaught exception', 'frontend errors', 'browser errors', 'rum', 'real user monitoring', 'storefront'],
    needs: 'RUM page views and JavaScript errors', blocked: null,
    payload: logs('eventType:in("PageView", "JavaScriptError") | stats by (service) count() if (eventType:="JavaScriptError") as js_errors, count() if (eventType:="PageView") as page_views | math js_errors / page_views * 100', { tiers: { warning: { op: '>', threshold: 15 }, critical: { op: '>', threshold: 30 } }, forSec: 600, intervalSec: 300 }),
  },
  {
    id: 'browser.lcp-slow',
    home: 'browser', alsoIn: [],
    title: 'Largest Contentful Paint is slow',
    subtitle: 'An app\'s 75th-percentile LCP is over 2.5 s (warning) or 4 s (critical), held 15 minutes',
    why: 'Past 4 s users stare at a half-drawn page and many leave; Google also ranks slow pages lower',
    summary: '{{ .Labels.service }} p75 LCP is {{ printf "%.1f" .Value }} s',
    hosting: [], problem: 'latency', urgency: 'low',
    aliases: ['lcp', 'largest contentful paint', 'core web vitals', 'web vitals', 'page load', 'slow page', 'page speed', 'rum', 'frontend performance'],
    needs: 'RUM page timings', blocked: null,
    payload: logs('eventType:="PageViewTiming" AND timingName:="largestContentfulPaint" | stats by (service) quantile(0.75, largestContentfulPaint)', { tiers: { warning: { op: '>', threshold: 2.5 }, critical: { op: '>', threshold: 4 } }, forSec: 900, intervalSec: 300 }),
  },

  // ---- host ----
  {
    id: 'host.cpu-high',
    home: 'host', alsoIn: ['kubernetes'],
    title: 'CPU usage is high',
    subtitle: 'A host\'s CPU at or above 70% for 5 minutes, critical at 85%: the Infrastructure page\'s own lines',
    why: 'A pegged host queues every request on it: latency climbs for its services, then health checks fail',
    summary: '{{ index .Labels "host.name" }} CPU at {{ printf "%.0f" .Value }}%',
    hosting: ['self-managed', 'aws', 'gcp'], problem: 'saturation', urgency: 'medium',
    aliases: ['cpu', 'processor', 'utilization', 'hot host', 'node', 'vm', 'ec2', 'compute engine', 'server'],
    needs: null, blocked: null,
    payload: hostCpu(),
  },
  {
    id: 'host.memory-climbing',
    home: 'host', alsoIn: [],
    title: 'Memory is climbing',
    subtitle: 'Warns when a host uses over 15% more memory than an hour ago, for 5 minutes; critical over 25% more',
    why: 'Memory up over 15% in an hour with no new load is often a fast leak: a planned restart beats an OOM kill',
    summary: '{{ index .Labels "host.name" }} uses {{ printf "%.0f" .Value }}% of the memory it used an hour ago',
    hosting: ['self-managed', 'aws', 'gcp'], problem: 'saturation', urgency: 'medium',
    aliases: ['memory', 'ram', 'leak', 'memory leak', 'oom', 'growth', 'used memory'],
    needs: null, blocked: null,
    payload: metrics('sum by (host.name) (system_memory_usage_bytes{state=~"used|"}) / sum by (host.name) (system_memory_usage_bytes{state=~"used|"} offset 1h) * 100', { tiers: { warning: { op: '>', threshold: 115 }, critical: { op: '>', threshold: 125 } }, forSec: 300 }),
  },
  {
    id: 'host.memory-high',
    home: 'host', alsoIn: [],
    title: 'Memory usage is high',
    subtitle: 'Warns when a host\'s used memory stays above 85% for 10 minutes; critical above 95%',
    why: 'Out of memory, the kernel\'s OOM killer ends the biggest process on the host, often the one serving',
    summary: '{{ index .Labels "host.name" }} memory at {{ printf "%.0f" .Value }}%',
    hosting: ['self-managed', 'aws', 'gcp'], problem: 'saturation', urgency: 'medium',
    aliases: ['memory', 'ram', 'oom', 'out of memory', 'oom killer', 'utilization', 'used memory'],
    needs: 'host memory states', blocked: null,
    payload: metrics('sum by (host.name) (system_memory_usage_bytes{state="used"}) / sum by (host.name) (system_memory_usage_bytes{state=~"used|free|buffered|cached|inactive"}) * 100', { tiers: { warning: { op: '>', threshold: 85 }, critical: { op: '>', threshold: 95 } }, forSec: 600 }),
  },
  {
    id: 'host.network-dropped',
    home: 'host', alsoIn: [],
    title: 'Network traffic has dropped',
    subtitle: 'Warns when a host gets under 50% of last week\'s traffic at this hour for 10 min; critical under 25%',
    why: 'A host whose inbound traffic collapses has usually dropped out of its load balancer or DNS',
    summary: '{{ index .Labels "host.name" }} receives {{ printf "%.0f" .Value }}% of last week\'s traffic at this hour',
    hosting: ['self-managed', 'aws', 'gcp'], problem: 'traffic', urgency: 'medium',
    aliases: ['network', 'traffic', 'bandwidth', 'throughput', 'nic', 'inbound', 'drop', 'load balancer', 'out of rotation'],
    needs: null, blocked: null,
    payload: metrics('sum by (host.name) (rate(system_network_io_bytes_total{direction="receive", device!="lo"}[5m])) / sum by (host.name) (rate(system_network_io_bytes_total{direction="receive", device!="lo"}[5m] offset 1w)) * 100', { tiers: { warning: { op: '<', threshold: 50 }, critical: { op: '<', threshold: 25 } }, forSec: 600 }),
  },
  {
    id: 'host.disk-filling',
    home: 'host', alsoIn: [],
    title: 'Disk is filling up',
    subtitle: 'Warns when a host\'s filesystem is over 85% full for 5 minutes; critical over 95%',
    why: 'A full disk fails every write: databases stop, logs are lost, services crash on their next write',
    summary: '{{ index .Labels "host.name" }} {{ .Labels.mountpoint }} is {{ printf "%.0f" .Value }}% full',
    hosting: ['self-managed', 'aws', 'gcp'], problem: 'saturation', urgency: 'high',
    aliases: ['disk', 'disk space', 'filesystem', 'storage', 'volume', 'ebs', 'persistent disk', 'full', 'no space left on device'],
    needs: 'host filesystem metrics', blocked: null,
    payload: metrics('sum by (host.name, mountpoint) (system_filesystem_usage_bytes{state="used", type!~"squashfs|tmpfs"}) / sum by (host.name, mountpoint) (system_filesystem_usage_bytes{state=~"used|free", type!~"squashfs|tmpfs"}) * 100', { tiers: { warning: { op: '>', threshold: 85 }, critical: { op: '>', threshold: 95 } }, forSec: 300 }),
  },
  {
    id: 'host.not-reporting',
    home: 'host', alsoIn: [],
    title: 'Metrics have stopped arriving',
    subtitle: 'Critical when a host seen in the last day sends no CPU samples in 5 minutes, held 5 minutes',
    why: 'A host that stops reporting goes silent on every other host rule: it may be down, or its collector is',
    summary: '{{ index .Labels "host.name" }} has sent no CPU samples in 5 minutes',
    hosting: ['self-managed', 'aws', 'gcp'], problem: 'availability', urgency: 'high',
    aliases: ['heartbeat', 'down', 'dead', 'no data', 'missing data', 'stopped reporting', 'silent', 'offline', 'agent', 'collector', 'otel'],
    needs: null, blocked: null,
    payload: metrics('count by (host.name) (count_over_time(system_cpu_utilization[5m])) or count by (host.name) (count_over_time(system_cpu_utilization[1d])) * 0', { tiers: { critical: { op: '<', threshold: 1 } }, forSec: 300 }),
  },

  // ---- kubernetes ----
  {
    id: 'kubernetes.pod-cpu-high',
    home: 'kubernetes', alsoIn: [],
    title: 'Pod CPU is high',
    subtitle: 'Pod CPU for a namespace on a node above 80% for 10 minutes; critical above 90%',
    why: 'A pod short of CPU makes its requests wait: latency climbs before errors show',
    summary: '{{ index .Labels "k8s.namespace.name" }} pods on {{ index .Labels "host.name" }} at {{ printf "%.0f" .Value }}% CPU',
    hosting: ['self-managed', 'aws', 'gcp'], problem: 'saturation', urgency: 'medium',
    aliases: ['k8s', 'kubernetes', 'pod', 'cpu', 'throttling', 'container', 'namespace', 'node', 'eks', 'gke'],
    needs: null, blocked: null,
    payload: metrics('k8s_pod_cpu_utilization * 100', { tiers: { warning: { op: '>', threshold: 80 }, critical: { op: '>', threshold: 90 } }, forSec: 600 }),
  },
  {
    id: 'kubernetes.pods-crash-looping',
    home: 'kubernetes', alsoIn: [],
    title: 'Pods are crash-looping',
    subtitle: 'Warns at over 30 BackOff events in a namespace per 5-minute check, twice running; critical over 90',
    why: 'A crash-looping pod serves nothing; if a rollout\'s pods all fail, the service runs out of replicas',
    summary: '{{ index .Labels "k8s.namespace.name" }} logged {{ printf "%.0f" .Value }} BackOff events in its last check',
    hosting: ['self-managed', 'aws', 'gcp'], problem: 'availability', urgency: 'medium',
    aliases: ['k8s', 'kubernetes', 'crashloopbackoff', 'crash loop', 'backoff', 'pods', 'events', 'eks', 'gke'],
    needs: null, blocked: null,
    payload: logs('event.domain:="k8s" AND object.reason:="BackOff" | stats by (k8s.namespace.name) count()', { tiers: { warning: { op: '>', threshold: 30 }, critical: { op: '>', threshold: 90 } }, forSec: 300, intervalSec: 300 }),
  },
  {
    id: 'kubernetes.warning-events-surging',
    home: 'kubernetes', alsoIn: [],
    title: 'Warning events are surging',
    subtitle: 'Warns at over 50 Warning events in a namespace per 5-minute check, twice running; critical over 150',
    why: 'A burst of Warnings (failed scheduling, mounts, probes, evictions) is a rollout or node going wrong',
    summary: '{{ index .Labels "k8s.namespace.name" }} logged {{ printf "%.0f" .Value }} Warning events in its last check',
    hosting: ['self-managed', 'aws', 'gcp'], problem: 'errors', urgency: 'low',
    aliases: ['k8s', 'kubernetes', 'events', 'warning', 'failedscheduling', 'failedmount', 'unhealthy', 'evicted', 'probe'],
    needs: null, blocked: null,
    payload: logs('event.domain:="k8s" AND object.type:="Warning" | stats by (k8s.namespace.name) count()', { tiers: { warning: { op: '>', threshold: 50 }, critical: { op: '>', threshold: 150 } }, forSec: 300, intervalSec: 300 }),
  },
  {
    id: 'kubernetes.containers-restarting',
    home: 'kubernetes', alsoIn: [],
    title: 'Containers are restarting',
    subtitle: 'Warns when a pod\'s containers restart more than once in 15 minutes; critical above 3 restarts',
    why: 'Each restart drops in-flight requests and empties caches; repeats point to OOM kills or bad config',
    summary: '{{ .Labels.namespace }}/{{ .Labels.pod }} restarted {{ printf "%.0f" .Value }} times in 15 minutes',
    hosting: ['self-managed', 'aws', 'gcp'], problem: 'availability', urgency: 'medium',
    aliases: ['k8s', 'kubernetes', 'restarts', 'oomkilled', 'container', 'pod', 'liveness probe', 'ksm'],
    needs: 'kube-state-metrics', blocked: null,
    payload: metrics('sum by (namespace, pod) (increase(kube_pod_container_status_restarts_total[15m]))', { tiers: { warning: { op: '>', threshold: 1 }, critical: { op: '>', threshold: 3 } }, forSec: 0 }),
  },
  {
    id: 'kubernetes.node-not-ready',
    home: 'kubernetes', alsoIn: [],
    title: 'Node is not ready',
    subtitle: 'Critical when a node has not reported Ready for 5 minutes',
    why: 'A NotReady node takes no new pods, and after 5 minutes Kubernetes evicts the ones it was running',
    summary: '{{ .Labels.node }} is not Ready',
    hosting: ['self-managed', 'aws', 'gcp'], problem: 'availability', urgency: 'high',
    aliases: ['k8s', 'kubernetes', 'node', 'notready', 'kubelet', 'cluster', 'eks', 'gke', 'ksm'],
    needs: 'kube-state-metrics', blocked: null,
    payload: metrics('kube_node_status_condition{condition="Ready", status="true"}', { tiers: { critical: { op: '==', threshold: 0 } }, forSec: 300 }),
  },
  {
    id: 'kubernetes.replicas-unavailable',
    home: 'kubernetes', alsoIn: [],
    title: 'Deployment replicas are unavailable',
    subtitle: 'Warns when a deployment is short a replica for 15 min and not progressing; critical at half or more',
    why: 'The replicas left carry all the load; with half gone, the next traffic spike becomes an outage',
    summary: '{{ .Labels.namespace }}/{{ .Labels.deployment }} is missing {{ printf "%.0f" .Value }}% of its replicas',
    hosting: ['self-managed', 'aws', 'gcp'], problem: 'availability', urgency: 'high',
    aliases: ['k8s', 'kubernetes', 'deployment', 'replicas', 'pending', 'rollout', 'stuck rollout', 'unavailable', 'ksm', 'scaling'],
    needs: 'kube-state-metrics', blocked: null,
    payload: metrics('kube_deployment_status_replicas_unavailable / kube_deployment_spec_replicas * 100 and on (namespace, deployment) changes(kube_deployment_status_replicas_updated[10m]) == 0', { tiers: { warning: { op: '>', threshold: 0 }, critical: { op: '>=', threshold: 50 } }, forSec: 900 }),
  },

  // ---- mysql ----
  {
    id: 'mysql.connections-near-limit',
    home: 'mysql', alsoIn: [],
    title: 'Connections near limit',
    subtitle: 'Warns when MySQL uses over 80% of max_connections, and goes critical over 90%, held 5 minutes',
    why: 'At max_connections MySQL refuses new connections, and every service that uses it starts failing',
    summary: '{{ .Labels.instance }} is using {{ printf "%.0f" .Value }}% of max_connections',
    hosting: ['self-managed', 'aws', 'gcp'], problem: 'saturation', urgency: 'high',
    aliases: ['mysql', 'rds', 'aurora', 'max_connections', 'too many connections', 'threads connected', 'connection pool', 'database', 'db'],
    needs: 'mysqld_exporter', blocked: null,
    payload: metrics('max by (instance) (mysql_global_status_threads_connected) / max by (instance) (mysql_global_variables_max_connections) * 100', { tiers: { warning: { op: '>', threshold: 80 }, critical: { op: '>', threshold: 90 } }, forSec: 300 }),
  },
  {
    id: 'mysql.server-unreachable',
    home: 'mysql', alsoIn: [],
    title: 'Server is unreachable',
    subtitle: 'Critical when the exporter can\'t reach the MySQL server for 2 minutes',
    why: 'Every query fails while it is down, and every service that needs it fails with it',
    summary: 'The exporter can\'t reach MySQL on {{ .Labels.instance }}',
    hosting: ['self-managed', 'aws', 'gcp'], problem: 'availability', urgency: 'high',
    aliases: ['mysql', 'down', 'up', 'unreachable', 'outage', 'connection refused', 'mysql_up', 'rds', 'aurora', 'db'],
    needs: 'mysqld_exporter', blocked: null,
    payload: metrics('mysql_up', { tiers: { critical: { op: '==', threshold: 0 } }, forSec: 120 }),
  },
  {
    id: 'mysql.slow-queries',
    home: 'mysql', alsoIn: [],
    title: 'Slow query rate is high',
    subtitle: 'Warns above 1 query a minute slower than long_query_time, and goes critical above 10, held 5 minutes',
    why: 'Slow queries hold locks and connections, so every request touching those tables slows down too',
    summary: '{{ .Labels.instance }} is running {{ printf "%.1f" .Value }} slow queries a minute',
    hosting: ['self-managed', 'aws', 'gcp'], problem: 'latency', urgency: 'medium',
    aliases: ['mysql', 'slow queries', 'slow log', 'slow_query_log', 'long_query_time', 'query latency', 'rds', 'mysqld_exporter', 'db'],
    needs: 'mysqld_exporter', blocked: null,
    payload: metrics('sum by (instance) (rate(mysql_global_status_slow_queries[5m])) * 60', { tiers: { warning: { op: '>', threshold: 1 }, critical: { op: '>', threshold: 10 } }, forSec: 300 }),
  },
  {
    id: 'mysql.replication-lag',
    home: 'mysql', alsoIn: [],
    title: 'Replication is lagging',
    subtitle: 'Warns when a replica is over 30 s behind, net of SQL_Delay; critical over 5 minutes behind; held 5 minutes',
    why: 'Reads from the replica return stale data, and failing over to it loses the writes it hasn\'t applied',
    summary: '{{ .Labels.instance }} is {{ printf "%.0f" .Value }} s behind its source',
    hosting: ['self-managed', 'aws', 'gcp'], problem: 'latency', urgency: 'medium',
    aliases: ['mysql', 'replica lag', 'replication delay', 'seconds_behind_master', 'seconds_behind_source', 'slave lag', 'read replica', 'binlog', 'sql_delay', 'rds', 'db'],
    needs: 'mysqld_exporter', blocked: null,
    payload: metrics('max by (instance) ((mysql_slave_status_seconds_behind_master - mysql_slave_status_sql_delay) or (mysql_slave_status_seconds_behind_source - mysql_slave_status_sql_delay))', { tiers: { warning: { op: '>', threshold: 30 }, critical: { op: '>', threshold: 300 } }, forSec: 300 }),
  },

  // ---- postgresql ----
  {
    id: 'postgresql.connections-near-limit',
    home: 'postgresql', alsoIn: [],
    title: 'Connections near limit',
    subtitle: 'Warns when PostgreSQL uses over 80% of max_connections, and goes critical over 90%, held 5 minutes',
    why: 'At the limit PostgreSQL refuses new clients, and every service that uses it starts failing',
    summary: '{{ .Labels.instance }} is using {{ printf "%.0f" .Value }}% of max_connections',
    hosting: ['self-managed', 'aws', 'gcp'], problem: 'saturation', urgency: 'high',
    aliases: ['postgres', 'postgresql', 'psql', 'pg', 'max_connections', 'numbackends', 'too many clients', 'connection pool', 'pgbouncer', 'rds', 'cloud sql', 'db'],
    needs: 'PostgreSQL integration', blocked: null,
    payload: metrics('sum by (instance) (pg_stat_database_numbackends) / max by (instance) (pg_settings_max_connections) * 100', { tiers: { warning: { op: '>', threshold: 80 }, critical: { op: '>', threshold: 90 } }, forSec: 300 }),
  },
  {
    id: 'postgresql.replication-lag',
    home: 'postgresql', alsoIn: [],
    title: 'Replication is lagging',
    subtitle: 'Warns when a standby is over 30 s behind, net of apply delay; critical over 5 minutes behind; held 5 minutes',
    why: 'Reads from the standby return stale data, and failing over to it loses the writes it hasn\'t replayed',
    summary: '{{ .Labels.instance }} is {{ printf "%.0f" .Value }} s behind its primary',
    hosting: ['self-managed', 'aws', 'gcp'], problem: 'latency', urgency: 'medium',
    aliases: ['postgres', 'postgresql', 'pg', 'replica lag', 'standby', 'streaming replication', 'wal', 'hot standby', 'read replica', 'recovery_min_apply_delay', 'rds', 'cloud sql', 'db'],
    needs: 'PostgreSQL integration', blocked: null,
    payload: metrics('(max by (instance) (pg_replication_lag_seconds) - max by (instance) (pg_settings_recovery_min_apply_delay_seconds)) or max by (instance) (pg_replication_lag_seconds)', { tiers: { warning: { op: '>', threshold: 30 }, critical: { op: '>', threshold: 300 } }, forSec: 300 }),
  },
  {
    id: 'postgresql.server-unreachable',
    home: 'postgresql', alsoIn: [],
    title: 'Server is unreachable',
    subtitle: 'Critical when the exporter can\'t reach the PostgreSQL server for 2 minutes',
    why: 'Every query fails while it is down, and every service that needs it fails with it',
    summary: 'The exporter can\'t reach PostgreSQL on {{ .Labels.instance }}',
    hosting: ['self-managed', 'aws', 'gcp'], problem: 'availability', urgency: 'high',
    aliases: ['postgres', 'postgresql', 'pg', 'down', 'up', 'unreachable', 'outage', 'connection refused', 'pg_up', 'rds', 'cloud sql', 'db'],
    needs: 'PostgreSQL integration', blocked: null,
    payload: metrics('pg_up', { tiers: { critical: { op: '==', threshold: 0 } }, forSec: 120 }),
  },
  {
    id: 'postgresql.long-transactions',
    home: 'postgresql', alsoIn: [],
    title: 'Transactions are left open',
    subtitle: 'Warns when a transaction sits idle and uncommitted over 5 minutes, critical over 15; held 1 minute',
    why: 'An open transaction holds its locks and stalls vacuum, so writes queue behind it and tables bloat',
    summary: '{{ .Labels.instance }} {{ .Labels.datname }} has a transaction left idle for {{ printf "%.0f" .Value }} s',
    hosting: ['self-managed', 'aws', 'gcp'], problem: 'saturation', urgency: 'medium',
    aliases: ['postgres', 'postgresql', 'pg', 'idle in transaction', 'idle_in_transaction_session_timeout', 'long-running transaction', 'open transaction', 'vacuum', 'autovacuum', 'bloat', 'xmin', 'wraparound', 'locks', 'db'],
    needs: 'PostgreSQL integration', blocked: null,
    payload: metrics('max by (instance, datname) (pg_stat_activity_max_tx_duration{state=~"idle in transaction.*"})', { tiers: { warning: { op: '>', threshold: 300 }, critical: { op: '>', threshold: 900 } }, forSec: 60 }),
  },
]

// ---------- Reading the catalogue ----------

/** "MySQL: Connections near limit": the alert's full name. */
export const fullName = t => `${SUBDOMAINS[t.home]?.label ?? ''}: ${t.title}`

/** metrics | logs | traces | mobile. */
export const templateSource = t => datasourceId(t.payload.datasource)

/** The data sources some template reads: the filter offers no option that finds nothing. */
export const SOURCES_IN_USE = DATA_SOURCES.filter(s => RULE_TEMPLATES.some(t => templateSource(t) === s.id))

/**
 * What "Use template" hands `openLink({ view: 'alertEditor', ... })`: the
 * template's payload with the full name, the Sub-domain as its folder, its
 * per-series summary, why it matters as the description, and a `template`
 * tag with its system ID, which is how a rule made from it is known as one.
 */
export function templatePayload(t) {
  return {
    ...structuredClone(t.payload),
    name: fullName(t),
    group: SUBDOMAINS[t.home]?.label ?? '',
    summary: t.summary,
    description: `Why it matters: ${t.why}`,
    tags: { template: t.id },
    from: 'templates',
  }
}

/** Whether a template sits under a Sub-domain or a Domain: home or Also in. */
function inScope(t, { domain, sub }) {
  const parents = [t.home, ...t.alsoIn]
  if (sub) return parents.includes(sub)
  if (domain) return parents.some(p => SUBDOMAINS[p]?.domain === domain)
  return true
}

/**
 * Whether a template is listed in a scope from a home outside it: under a
 * Sub-domain, homed in another; under a Domain, homed in another Domain's
 * Sub-domain. Such a card says where it is from, and sorts after the scope's own.
 */
export function visitingIn(t, { domain, sub } = {}) {
  if (sub) return t.home !== sub
  if (domain) return SUBDOMAINS[t.home]?.domain !== domain
  return false
}

const words = text => String(text ?? '').toLowerCase().split(/\s+/).filter(Boolean)

/** Everything a search reads in a template: its words, its parents' names and aliases, its tags. */
function haystack(t) {
  const parents = [t.home, ...t.alsoIn]
  return [
    t.id, t.title, fullName(t), t.subtitle, t.why, ...t.aliases,
    ...parents.flatMap(p => [SUBDOMAINS[p]?.label, ...(SUBDOMAINS[p]?.aliases ?? []), domainOf(p)?.label]),
    PROBLEM_LABEL[t.problem], SOURCE_LABEL[templateSource(t)], ...t.hosting.map(h => HOSTING_LABEL[h]),
    t.needs ?? '',
  ].join(' ').toLowerCase()
}

const URGENCY_RANK = { high: 0, medium: 1, low: 2 }

/**
 * The templates a view shows, best first: a scope's own before those listed
 * there from another home, then those that can be used before those waiting
 * on data before those that cannot be used yet, then by urgency, then in
 * catalogue order. `scope` is `{ domain?, sub? }`; `filters` is
 * `{ q?, problem?, source?, urgency? }`. Every word of `q` must appear
 * somewhere in a template, so "aws postgres" finds the PostgreSQL ones on AWS.
 */
export function filterTemplates(templates, scope = {}, filters = {}) {
  const want = words(filters.q)
  const order = new Map(templates.map((t, i) => [t, i]))
  const ready = t => (t.blocked ? 2 : t.needs ? 1 : 0)
  return templates
    .filter(t => inScope(t, scope))
    .filter(t => !filters.problem || t.problem === filters.problem)
    .filter(t => !filters.source || templateSource(t) === filters.source)
    .filter(t => !filters.urgency || t.urgency === filters.urgency)
    .filter(t => !want.length || want.every(w => haystack(t).includes(w)))
    .sort((a, b) => visitingIn(a, scope) - visitingIn(b, scope) || ready(a) - ready(b) || URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency] || order.get(a) - order.get(b))
}

/**
 * The rail's counts under a search and the filters: each template counted
 * once, at its home. `{ all, domains: { [id]: n }, subs: { [id]: n } }`.
 */
export function templateCounts(templates, filters = {}) {
  const found = filterTemplates(templates, {}, filters)
  const subs = Object.fromEntries(Object.keys(SUBDOMAINS).map(id => [id, 0]))
  const domains = Object.fromEntries(DOMAINS.map(d => [d.id, 0]))
  for (const t of found) {
    subs[t.home]++
    domains[SUBDOMAINS[t.home].domain]++
  }
  return { all: found.length, domains, subs }
}

/**
 * The rules a template is already in use by: those carrying its tag, or
 * running its query unchanged. `views` are the rule list's views.
 */
export function rulesUsing(t, views, baseQuery) {
  const source = templateSource(t)
  return (views ?? []).filter(v => v?.tags?.template === t.id || (baseQuery && v?.baseQuery === baseQuery && v?.datasource === source))
}
