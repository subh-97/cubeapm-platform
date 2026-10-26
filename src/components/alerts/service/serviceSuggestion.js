// What a service page offers to watch when asked for a new rule
// (docs/alerts/DESIGN.md D13), kept apart from the components so it is
// tested without rendering.

import { THRESHOLDS } from '@/utils/status'

const tiersAt = ({ warn, critical }) => ({ warning: { op: '>', threshold: warn }, critical: { op: '>', threshold: critical } })

// The rule the editor opens on for a service: its error rate if no rule
// watches that, then its p90 latency, each at the thresholds that colour its
// badge (as the Rules tab's suggestions do), and otherwise its throughput,
// with the threshold left to set. Never a copy of a rule it already has. A
// rule on one of its endpoints does not watch the whole service.
export function suggestionFor(serviceId, rules = []) {
  const watched = rules.filter(r => !r.scope?.endpoint).map(r => r.metric)
  if (!watched.includes('Error %')) {
    return { calculate: 'error_percentage', service: serviceId, tiers: tiersAt(THRESHOLDS.errorRatePct), forSec: 300, name: `${serviceId} error rate` }
  }
  if (!watched.some(m => /^p\d+(\.\d+)? latency$/.test(m ?? ''))) {
    return { calculate: 'latency_percentile', service: serviceId, tiers: tiersAt(THRESHOLDS.latencyP90Ms), forSec: 300, name: `${serviceId} p90 latency` }
  }
  return { calculate: 'rpm', service: serviceId, forSec: 300, name: `${serviceId} throughput` }
}
