// Rules to start from (the Rules tab's "Start from a template"): the common
// ones, already set — a query that watches what matters, and thresholds where
// the platform has them — each opening the editor the way every "Create alert"
// in the app does, as a payload it reads (editorPayloads.js). Nothing is saved
// until the editor's Save; a template is a starting point, not a rule.

import { emptyPair } from '@/utils/explore/builders'
import { THRESHOLDS } from '@/utils/status'
import { alertPayloadForHostCpu } from './editorPayloads'

// Above the warn and critical figures that colour a service's badge, so a
// template rule fires where the service page turns amber and red.
const above = ({ warn, critical }) => ({ warning: { op: '>', threshold: warn }, critical: { op: '>', threshold: critical } })

// A Quick model over every service, one series each.
const perService = calculate => ({
  type: 'quick', calculate, value: '90', labelPairs: [emptyPair()], groupBy: ['service'],
})

/**
 * `{ id, title, description, payload() }`, in the order the picker lists them.
 * `payload()` is what `openLink({ view: 'alertEditor', ...payload })` takes.
 */
export const RULE_TEMPLATES = [
  {
    id: 'error-rate',
    title: 'Error rate per service',
    description: 'Error % above 1% (warning) or 3% (critical) for 5 minutes, an alert for each service.',
    payload: () => ({
      datasource: 'prometheus', model: perService('error_percentage'),
      tiers: above(THRESHOLDS.errorRatePct), forSec: 300, name: 'Error rate by service',
    }),
  },
  {
    id: 'p90-latency',
    title: 'p90 latency per service',
    description: 'p90 latency above 150 ms (warning) or 300 ms (critical) for 5 minutes, an alert for each service.',
    payload: () => ({
      datasource: 'prometheus', model: perService('latency_percentile'),
      tiers: above(THRESHOLDS.latencyP90Ms), forSec: 300, name: 'p90 latency by service',
    }),
  },
  {
    id: 'throughput',
    title: 'Throughput per service',
    description: 'Requests a minute for each service. You set the floor or ceiling that matters.',
    payload: () => ({
      datasource: 'prometheus', model: perService('rpm'), forSec: 300, name: 'Throughput by service',
    }),
  },
  {
    id: 'host-cpu',
    title: 'Host CPU',
    description: 'CPU above 70% (warning) or 85% (critical) on any host, the Infrastructure page\'s own lines.',
    payload: () => {
      const one = alertPayloadForHostCpu('host')
      return { ...one, model: { ...one.model, labelPairs: [emptyPair()] }, forSec: 300, name: 'High CPU by host' }
    },
  },
  {
    id: 'error-logs',
    title: 'Error log volume',
    description: 'More than 10 error records in the log stream over a five-minute check.',
    payload: () => ({
      datasource: 'vlogs', query: 'log.level:="error" | stats count()',
      tiers: { warning: { op: '>', threshold: 10 } }, forSec: 0, name: 'Error log volume',
    }),
  },
]
