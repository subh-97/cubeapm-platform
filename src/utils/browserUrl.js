import { TIME_PRESETS } from '@/utils/timeRange'
import { encodeValue } from '@/utils/searchParams'

/**
 * The Browser (RUM) page's URL: which app, which tab, Graph or Table, Script
 * or Ajax, the Traces tab's endpoint and error filters and — read on the way
 * in only — the time range.
 *
 *   state = { service, tab, view: 'graph' | 'table', kind: 'server' | 'client',
 *             endpoint, error, time: string | null }
 *
 * It is the production app's own dialect, key for key and value for value, so
 * a link copied out of playground.cubeapm.com/browser lands on the same app,
 * tab and filters here. Only the labels were renamed (kind=server reads
 * "Script", kind=client "Ajax"); renaming a value would break every pasted link.
 *
 * The page keeps no React copy of any of this. It parses `location.search` on
 * every render and changes it by navigating, which is why both directions live
 * here as pure functions: what the page reads and what it writes have to agree
 * to the letter, or the page's normalising write would never settle.
 */

export const BROWSER_PATH = '/browser'

// Production's tab ids, in the order the tab strip shows them. The strip is
// built from this list, so a tab the URL can name is a tab the page has.
export const BROWSER_TABS = ['pageviews', 'ajax-calls', 'web-vitals', 'errors', 'traces']
export const DEFAULT_BROWSER_TAB = 'pageviews'

// Graph is the default (production's), so it comes first and is left out of
// the URL. One value is shared by Page Views, Ajax Calls and Web Vitals.
export const BROWSER_VIEWS = ['graph', 'table']
const DEFAULT_VIEW = BROWSER_VIEWS[0]

// Production's two kinds, by the URL's value and the word the page shows for
// it: an exception thrown by the page's own script ('server', production's
// value — it is the page-load span's kind) and a failed XHR/fetch call
// ('client'). The Errors tab's toggle, the Traces tab's Type filter and its
// empty state all read them from here, so the pairing is written once.
export const BROWSER_KINDS = [
  { id: 'server', label: 'Script' },
  { id: 'client', label: 'Ajax' },
]

// Script errors are production's default side, as Server is on the Errors page.
const DEFAULT_KIND = BROWSER_KINDS[0].id

const PRESETS = new Set(TIME_PRESETS.map(p => p.value))

// A free-text value as the page uses it: edges trimmed, absent as ''. The
// inside is kept as it is, spaces and all ('GET search.cubedemo.com:443/…').
const text = v => String(v ?? '').trim()

/**
 * URL search string (with or without the `?`) → state.
 *
 * `appIds` is the page's apps, most severe first. A service the page does not
 * have — a stale link, a typo, none at all — falls back to the first of them,
 * so the page always opens on a real app, and on the one most likely to need
 * looking at, rather than on production's empty "Select Service" card. Without
 * `appIds` the service is read as written, unchecked, for a caller that only
 * wants to know what the link says.
 *
 * Everything else falls back to its default rather than failing: an unknown
 * tab to Page Views, a view other than table to Graph, a kind other than
 * client to Script. `time` is kept only when it is one of the presets: App
 * owns the range, and only a preset is worth carrying in a shared link.
 *
 * Every other key is read past. A production link carries the other pages'
 * leftovers — `index=cube:error`, `refresh=<ms>`, and `name=POST
 * api.stripe.com/v1/payment_intents`, the Errors page's span name. `name` is
 * not this page's endpoint and must never become the Traces filter, so it is
 * not read at all.
 */
export function parseBrowserSearch(search = '', appIds) {
  const params = new URLSearchParams(String(search ?? '').replace(/^\?/, ''))
  const service = text(params.get('service'))
  const tab = params.get('tab')
  const time = params.get('time')
  const ids = appIds == null ? null : [...appIds]
  return {
    service: ids == null || ids.includes(service) ? service : (ids[0] ?? ''),
    // includes, not a lookup on an object: the value comes from whoever wrote
    // the link, and `tab=constructor` must not find Object.prototype.
    tab: BROWSER_TABS.includes(tab) ? tab : DEFAULT_BROWSER_TAB,
    view: params.get('view') === 'table' ? 'table' : DEFAULT_VIEW,
    kind: params.get('kind') === 'client' ? 'client' : DEFAULT_KIND,
    endpoint: text(params.get('endpoint')),
    error: text(params.get('error')),
    time: PRESETS.has(time) ? time : null,
  }
}

/**
 * State → search string: `?…`, or '' when there is nothing to say (no app
 * named and everything at its default), so the page can compare it with
 * `location.search` directly (through sameSearch, which ignores how the
 * browser re-escaped it).
 *
 * The keys are always written in one order — service, tab, view, kind,
 * endpoint, error — so the same state is always the same URL, and a link that
 * spells it differently (production writes `tab` near the end) is rewritten
 * once and then left alone. `service` is always written: a shared link stays
 * on its app even after the severity order that picked the default changes.
 * The rest are left out at their defaults, as the service page leaves out
 * Overview, and a value the page does not have is written as its default,
 * which reads back the same.
 *
 * `time` is never written. It is App's, read once from a pasted link; written
 * here, it would pin every later link to the range the page was opened with.
 */
export function browserSearch({
  service = '',
  tab = DEFAULT_BROWSER_TAB,
  view = DEFAULT_VIEW,
  kind = DEFAULT_KIND,
  endpoint = '',
  error = '',
} = {}) {
  const parts = []
  // encodeValue keeps a link readable: `endpoint=/account/:userId/wishlist`,
  // `endpoint=GET+search.cubedemo.com:443/v1/search/wealth`. An empty value is
  // "no filter", which the URL says by leaving the key out.
  const put = (key, value) => {
    const v = text(value)
    if (v) parts.push(`${key}=${encodeValue(v)}`)
  }
  put('service', service)
  if (tab !== DEFAULT_BROWSER_TAB && BROWSER_TABS.includes(tab)) put('tab', tab)
  if (view === 'table') put('view', 'table')
  if (kind === 'client') put('kind', 'client')
  put('endpoint', endpoint)
  put('error', error)
  return parts.length ? `?${parts.join('&')}` : ''
}

/** State → the Browser page's one spelling of it, path and all. */
export function browserUrl(state) {
  return BROWSER_PATH + browserSearch(state)
}
