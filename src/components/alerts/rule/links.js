// The Alerts module's addresses, as the rule page navigates to them: route.js's
// own builders for the paths, and alertsUrl.js for the hub's query string, so
// every link here is the one App parses back (production's paths and keys,
// docs/alerts/DESIGN.md D14).

import { alertRuleUrl, alertEditorUrl, routeUrl } from '@/utils/route'
import { alertsSearch } from '@/utils/alertsUrl'

export const ALERTS_PATH = routeUrl({ view: 'alerts' })

/** The Alerts hub, on its Rules tab. */
export const alertsHref = () => ALERTS_PATH

/** One rule's page. */
export const ruleHref = id => alertRuleUrl(id)

/** One rule in the editor (P4). */
export const ruleEditHref = id => alertEditorUrl(id)

/** A new rule in the editor (P4), where Clone lands. */
export const newRuleHref = () => alertEditorUrl(null)

/** The hub's Rules tab filtered to one group, for the group's crumb. */
export const groupHref = group => `${ALERTS_PATH}${alertsSearch({ facets: { group: [group] } })}`

/** The hub's Notifications tab filtered to one rule: production's own history link. */
export const ruleNotificationsHref = id => `${ALERTS_PATH}${alertsSearch({ tab: 'alert-logs', ruleId: id })}`

/** The rule id in a `/alerts/<id>` path, for a page reached before App passes one. */
export function ruleIdFromPath(pathname) {
  const m = /^\/alerts\/([^/?#]+)\/?$/.exec(String(pathname ?? ''))
  if (!m || m[1] === 'new') return null
  try {
    return decodeURIComponent(m[1])
  } catch {
    return m[1]
  }
}
