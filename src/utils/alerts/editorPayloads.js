// What every "Create Alert" in the app hands the rule editor (docs/alerts/
// DESIGN.md D13). Production's entry points pass only `{ model, query,
// datasource }`; ours also pass what the place they came from already knows —
// the thresholds that colour the card, a name, the service — so the editor
// opens on a rule that would fire exactly when the card turns amber or red,
// one Save away. All of it travels in App state (openLink), never in the URL.

import { explorePayloadForCard } from '@/utils/explore/editorState'
import { emptyPair, newOperation } from '@/utils/explore/builders'
import { ADVANCED_OPERATIONS } from '@/utils/explore/catalogs'
import { THRESHOLDS } from '@/utils/status'
import { NEEDS_CLOSING_PIPE, queryProblem } from '@/data/alertsEngine'

// A badge turns amber AT its warn figure and red AT its critical one
// (statusForLatency, statusForErrorRate), so the rule's tiers are inclusive too.
const atOrAbove = (warn, critical) => ({ warning: { op: '>=', threshold: warn }, critical: { op: '>=', threshold: critical } })
const TIERS = {
  error_percentage: atOrAbove(THRESHOLDS.errorRatePct.warn, THRESHOLDS.errorRatePct.critical),
  latency_percentile: atOrAbove(THRESHOLDS.latencyP90Ms.warn, THRESHOLDS.latencyP90Ms.critical),
  latency_average: atOrAbove(THRESHOLDS.latencyP90Ms.warn, THRESHOLDS.latencyP90Ms.critical),
}

const metricWords = model => ({
  rpm: 'throughput',
  error_percentage: 'error rate',
  latency_percentile: `p${model.value ?? '90'} latency`,
  latency_average: 'average latency',
})[model.calculate] ?? 'rate'

/**
 * A card menu's "Create Alert" item → the editor's payload, or null for the
 * menu's other items. The card is read the way its own "Explore" item reads it
 * (explorePayloadForCard), so the two items agree about what the card plots;
 * the alert then watches the card's scope as one series, and takes the
 * card's thresholds. RPM has no thresholds to take, so its rule opens asking
 * for one.
 *
 * @param {{action:string, title?:string, serviceId?:string, endpoint?:string}} args
 */
export function alertPayloadForCard({ action, title = '', serviceId = '', endpoint = '' }) {
  const label = String(action ?? '')
  if (!/^Create Alert\b/.test(label)) return null
  const explore = explorePayloadForCard({ action: label.replace(/^Create Alert/, 'Explore'), title, serviceId, endpoint })
  if (!explore) return null
  const pairs = explore.model.labelPairs.filter(p => p.label)
  const model = { ...explore.model, labelPairs: [...pairs, emptyPair()], groupBy: [] }
  const scope = [serviceId, endpoint].filter(Boolean).join(' ')
  return {
    datasource: 'prometheus',
    model,
    tiers: TIERS[model.calculate] ?? null,
    name: scope ? `${scope} ${metricWords(model)}` : metricWords(model),
    service: serviceId || null,
  }
}

/**
 * A Logs or Traces query bar's "Create alert" → the editor's payload: the
 * page's own query, counted, as production's bars send it. A query that
 * already ends in a stats or math pipe is sent as it is.
 *
 * @param {{datasource:'vlogs'|'traces', query:string}} args  `query` in LogsQL
 */
export function alertPayloadForQuery({ datasource, query }) {
  const q = String(query ?? '').trim() || '*'
  const counted = queryProblem(datasource, q) === NEEDS_CLOSING_PIPE ? `${q} | stats count()` : q
  return { datasource, query: counted }
}

/**
 * Explore's "Create alert" (docs/alerts/PLAN.md 7a): the active tab's own
 * model while the chart still draws what that tab spells, so the rule opens
 * on the same builder, editable; otherwise the committed query, in Code.
 * `editor` is Explore's state for the showing datasource (`page.editors[ds]`),
 * `committed` its `committedQuery(page)` — a `{ datasource, query }` pair, of
 * which only the query is ever compared or sent. Null with nothing committed.
 */
export function alertPayloadForExplore(editor, committed) {
  if (!committed?.query) return null
  const built = editor?.tab && editor.tab !== 'code' ? editor[editor.tab] : null
  return built?.model && built.query === committed.query
    ? { datasource: committed.datasource, model: built.model }
    : { datasource: committed.datasource, query: committed.query }
}

/**
 * The group a new rule about `service` belongs in: the group most of that
 * service's rules already sit in, else the service's own name. Production
 * defaults every rule to "Default Group", which is how a list ends up with
 * one folder of everything.
 *
 * @param {Array<{scope?:{service?:string}, group?:string}>} views
 */
export function groupForService(views, service) {
  if (!service) return null
  const counts = new Map()
  for (const v of views ?? []) {
    if (v?.scope?.service === service && v.group) counts.set(v.group, (counts.get(v.group) ?? 0) + 1)
  }
  let best = null
  for (const [group, n] of counts) if (!best || n > best[1]) best = [group, n]
  return best ? best[0] : service
}

// The host table's own colours (observability.js): a host goes amber at 70% CPU
// and red at 85%, so a rule made from its CPU chart fires where its row turns.
const HOST_CPU_TIERS = atOrAbove(70, 85)
const MULTIPLY = ADVANCED_OPERATIONS.flatMap(g => g.options).find(o => o.type === 'operator' && o.value === '*')

/**
 * Infrastructure's host CPU chart → the editor's payload: the host's
 * `system_cpu_utilization` as a percentage, an Advanced model over the same
 * metric Explore reads, with the host table's thresholds.
 */
export function alertPayloadForHostCpu(host) {
  if (!host) return null
  const times100 = { ...newOperation(MULTIPLY), args: newOperation(MULTIPLY).args.map(a => ({ ...a, value: '100' })) }
  return {
    datasource: 'prometheus',
    model: {
      type: 'advanced', metric: 'system_cpu_utilization',
      labelPairs: [{ label: 'host.name', operator: '=', values: [host] }, emptyPair()],
      functions: [times100],
    },
    tiers: HOST_CPU_TIERS,
    name: `CPU high on ${host}`,
    group: 'Infrastructure',
  }
}

const operation = value => newOperation(ADVANCED_OPERATIONS.flatMap(g => g.options).find(o => o.value === value && o.type !== 'operator'))

/**
 * The Errors drawer's "Alert on this error" (D13): that exception on that
 * service, in errors a minute — `sum(rate(cube_apm_errors_total{…})) * 60`,
 * an Advanced model, so it opens editable rather than as text. It warns above
 * one a minute held for two minutes: the counter ticks along at a fraction of
 * one in a quiet hour and at dozens in an incident.
 *
 * Not the Traces source the design first named: the span store samples rows
 * per minute, so a count of one exception there is sparse, and over some hours
 * empty, while the drawer beside it counts hundreds (7c). The metric is the
 * same counter the Errors page's figures follow, at every minute.
 *
 * @param {{service:string, exception:string, exceptionShort?:string}} group
 */
export function alertPayloadForError({ service, exception, exceptionShort }) {
  const perMinute = { ...newOperation(MULTIPLY), args: newOperation(MULTIPLY).args.map(a => ({ ...a, value: '60' })) }
  return {
    datasource: 'prometheus',
    model: {
      type: 'advanced', metric: 'cube_apm_errors_total',
      labelPairs: [
        { label: 'service', operator: '=', values: [service] },
        { label: 'exception', operator: '=', values: [exception] },
        emptyPair(),
      ],
      functions: [operation('rate'), operation('sum'), perMinute],
    },
    tiers: { warning: { op: '>', threshold: 1 } },
    forSec: 120,
    name: `${exceptionShort || exception} on ${service}`,
    service,
  }
}
