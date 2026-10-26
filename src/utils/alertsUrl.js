import { TIME_PRESETS } from '@/utils/timeRange'
import { encodeValue } from '@/utils/searchParams'

/**
 * The Alerts page's query string (docs/alerts/DESIGN.md D14). The paths
 * (/alerts, /alerts/new, /alerts/:id, /alerts/:id/edit) are route.js's; this is
 * everything after the `?`.
 *
 *   state = {
 *     tab,            which of the five tabs (production's own values)
 *     ruleId,         production's rule_id: the rule a link is about
 *     alertId,        production's alert_id: the alert instance a notification links to
 *     notifyTime,     production's notifyTime / incidentTime: unix seconds a
 *     incidentTime,     notification link anchors the range and the handoffs on
 *     config,         production's PagerDuty connect return, { integrationKeys }
 *     time,           a preset, read on a cold load only (the range is App's)
 *     q,              the search text
 *     facets,         { [key]: string[] } in our own keys, below
 *   }
 *
 * Production's keys keep production's names and values, so a link copied out of
 * it lands on the same screen here: `?tab=alert-logs&rule_id=437` is that
 * rule's notifications, and a notification's `/alerts/437?alert_id=…` is that
 * alert. What production writes besides them is read past on purpose. The APM
 * page's query string (service, env, kind, name, index, view, …) rides into
 * every module there, and the Alerts page ignores it; the link that started this
 * module (`/alerts?service=cubedemo-web&index=cube:error&…&view=graph`) is the
 * plain rules list, here as there. That is also why our own service filter is
 * `svc`: a `service` arriving in an Alerts URL is the APM page's, not a filter.
 */

/** The five tabs, in strip order, by production's own `tab` values. */
export const ALERTS_TABS = ['alerts', 'alert-stats', 'receiver-groups', 'mute-groups', 'alert-logs']
export const DEFAULT_ALERTS_TAB = 'alerts'


/**
 * Our facet keys, in the order they are written, so the same state is always
 * the same URL. Rules-tab facets first, then the Notifications tab's. A key is
 * read on the tab it belongs to: `status` is a rule's Active / Paused on Rules
 * and a send's SUCCESS / ERROR / MUTE / SNOOZE on Notifications, and the hub
 * drops the other tab's keys when the tab changes. `severity` is the highest
 * tier a rule defines (critical when it has a critical threshold), not its
 * state: a critical rule that is OK right now still has severity=critical.
 */
export const ALERTS_FACET_KEYS = [
  'state', 'severity', 'group', 'svc', 'source', 'type', 'notifies', 'suppressed',
  'status', 'event', 'contact', 'integration',
]
// A Set, not an object: the keys come from whoever wrote the link, and looked
// up on a plain object `?toString=1` would find Object.prototype.toString.
const FACET_KEYS = new Set(ALERTS_FACET_KEYS)

const PRESETS = new Set(TIME_PRESETS.map(p => p.value))

// The query string out of whatever was passed. A raw `#` always starts the
// fragment. A path or a whole URL is cut at its first `?`; a bare query string
// is taken whole, since a `?` inside one of its values is not where it starts.
function queryPart(raw) {
  const s = raw.split('#', 1)[0]
  const at = s.indexOf('?')
  return at === -1 || /[=&]/.test(s.slice(0, at)) ? s : s.slice(at + 1)
}

// Unix seconds, as notification links write them. Anything else — a date, a
// negative, a fraction, a millisecond stamp mistaken for seconds — is no anchor
// at all rather than a wrong one: a range centred on the year 57000 helps nobody.
const MAX_SECONDS = 4_102_444_800 // 2100-01-01
function unixSeconds(text) {
  const s = String(text ?? '').trim()
  if (!/^\d{1,10}$/.test(s)) return null
  const n = Number(s)
  return n > 0 && n < MAX_SECONDS ? n : null
}

// What PagerDuty's connect flow sends back: {"integration_keys":[{name, integration_key}]}.
// Only complete pairs are kept; a malformed payload is no payload.
function pagerDutyConfig(text) {
  if (text == null) return null
  try {
    const obj = JSON.parse(text)
    const list = obj && typeof obj === 'object' && !Array.isArray(obj) ? obj.integration_keys : null
    if (!Array.isArray(list)) return null
    const integrationKeys = list
      .filter(k => k && typeof k.name === 'string' && typeof k.integration_key === 'string' && k.integration_key)
      .map(k => ({ name: k.name, key: k.integration_key }))
    return integrationKeys.length ? { integrationKeys } : null
  } catch {
    return null
  }
}

/** URL search string (with or without the `?`, or a whole path) → state. */
export function parseAlertsSearch(search) {
  const params = new URLSearchParams(queryPart(String(search ?? '')))

  const facets = {}
  for (const [key, value] of params) {
    if (!FACET_KEYS.has(key)) continue
    const v = String(value ?? '').trim()
    if (!v) continue
    const list = facets[key] ?? (facets[key] = [])
    if (!list.includes(v)) list.push(v)
  }

  const tab = params.get('tab')
  const time = params.get('time')
  const text = key => {
    const v = params.get(key)?.trim()
    return v ? v : null
  }
  return {
    // An unknown tab is the rules list. Production renders a header with no tab
    // selected and an empty body, which is a dead end with nothing to say.
    tab: ALERTS_TABS.includes(tab) ? tab : DEFAULT_ALERTS_TAB,
    ruleId: text('rule_id'),
    alertId: text('alert_id'),
    notifyTime: unixSeconds(params.get('notifyTime')),
    incidentTime: unixSeconds(params.get('incidentTime')),
    config: pagerDutyConfig(params.get('config')),
    // Production writes absolute ranges as `ISO~ISO`; the range belongs to App,
    // and only a preset is worth carrying in a shared link (as on Errors).
    time: PRESETS.has(time) ? time : null,
    q: (params.get('q') ?? '').trim(),
    facets,
  }
}

/**
 * The hub's state → search string: `?…`, or '' when there is nothing to say,
 * so the page can compare it with `location.search` directly.
 *
 * Writes only what the hub owns, in a fixed order: the tab (left out at its
 * default), the rule a link is about, the search and the facets. The list is
 * always grouped by each rule's own group, so an old link's `group_by` is read
 * past. The time range is App's, and alert_id, notifyTime,
 * incidentTime and config are arrivals from outside — a notification, an OAuth
 * redirect — that the page reads once and never writes back.
 */
export function alertsSearch({ tab = DEFAULT_ALERTS_TAB, ruleId = null, q = '', facets = {} } = {}) {
  const parts = []
  const put = (key, value) => parts.push(`${key}=${encodeValue(value)}`)
  if (ALERTS_TABS.includes(tab) && tab !== DEFAULT_ALERTS_TAB) put('tab', tab)
  if (ruleId != null && String(ruleId).trim()) put('rule_id', String(ruleId).trim())
  if (q?.trim()) put('q', q.trim())
  for (const key of ALERTS_FACET_KEYS) {
    // A Set (the page's own state) or an array (what parseAlertsSearch returns).
    // A lone string is one value: iterated, it would be written a letter at a
    // time. Repeats are dropped, as reading the link back would drop them.
    const given = facets?.[key] ?? []
    const values = new Set(typeof given === 'string' ? [given] : [...given].map(String))
    for (const v of values) if (v.trim() !== '') put(key, v.trim())
  }
  return parts.length ? `?${parts.join('&')}` : ''
}
