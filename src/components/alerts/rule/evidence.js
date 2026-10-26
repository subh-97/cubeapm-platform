// What the failed spans threw, for the Traces handoff (handoffs.js).
//
// Kept apart from the pure payload builders because it reads the Errors data:
// a Traces link only lands on failures when it names their exception — the
// Traces page merges in the error samples a query asks for by exception, and
// no others (utils/tracesHandoff.js). So the handoff names every exception the
// service's server side recorded in the window it opens on, busiest first.

import { resolveWindow } from '@/data/timeWindow'
import { errorGroupsForWindow } from '@/data/errors'

/**
 * The exception classes `service` failed with in `range` (an absolute range,
 * as the handoff opens on), on its server side and, when given, on one
 * endpoint; busiest first. Empty when there were none.
 */
export function failingExceptions(range, service, endpoint = null) {
  if (!range || !service) return []
  const win = resolveWindow(range)
  const byException = new Map()
  for (const g of errorGroupsForWindow(win, { side: 'server', service })) {
    if (endpoint && g.endpoint !== endpoint && g.spanName !== endpoint) continue
    byException.set(g.exception, (byException.get(g.exception) ?? 0) + g.count)
  }
  return [...byException.entries()].sort((a, b) => b[1] - a[1]).map(([exception]) => exception)
}
