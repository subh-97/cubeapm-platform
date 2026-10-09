// Which page, which service and tab, which trace: this part of App's state
// lives in the URL and nowhere else. App parses it from the location on every
// render and changes it by navigating, so a reload, a pasted link and the back
// button all land where the address bar says. A second copy in React state,
// pushed to the URL from an effect, is what made Back bounce: the effect saw
// the address change, found its copy disagreeing, and pushed the copy back.
//
// The service tab rides in the query string, as the production app does
// (/apm?service=…&tab=red): /service/notify-service?tab=red. Overview is the
// default and is left out, so a bare /service/:id still means Overview.
//
// A trace's dataset rides there too (production: /apm/inspect/<id>?datasource=
// mobile). A trace id alone does not say which store holds it — a device's
// request and a backend span are looked up in different places — so a mobile
// trace is /trace/<id>?datasource=mobile, and the backend, being the default,
// keeps the bare /trace/<id> it has always had.
//
// Errors and Browser own their whole query string instead, in the production
// app's own dialect (errorsUrl.js, browserUrl.js), so this module names only
// their paths. /browser is production's path too, so a link copied out of it
// (/browser?service=cubedemo-web&tab=traces…) lands here as it is.

import { services } from '@/data/services'

// The service page's views, in the order its tab strip shows them. The strip
// is built from this list, so a tab the URL can name is a tab the page has.
export const SERVICE_TABS = ['overview', 'detail', 'red', 'external', 'db', 'errors', 'runtime']
export const DEFAULT_SERVICE_TAB = 'overview'

const VIEW_PATHS = {
  home: '/home',
  logs: '/logs',
  traces: '/traces',
  mtraces: '/mobile-traces',
  explore: '/explore',
  errors: '/errors',
  browser: '/browser',
  infra: '/infrastructure',
}
const VIEW_FOR_PATH = new Map(Object.entries(VIEW_PATHS).map(([view, path]) => [path, view]))

// The first path segment after a prefix, so a trailing slash or a stray extra
// segment still names the same service or trace.
function segmentAfter(pathname, prefix) {
  const raw = pathname.slice(prefix.length).split('/')[0]
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

// The datasources a trace URL can name besides the default backend one. Any
// other value — a typo, or a dataset this build does not have — reads as the
// backend, the same way an unknown tab reads as Overview.
const TRACE_DATASOURCES = new Set(['mobile'])

function traceDatasource(search) {
  const ds = new URLSearchParams(search).get('datasource')
  return TRACE_DATASOURCES.has(ds) ? ds : null
}

// An unknown service falls back to the first one, which is the most severe
// (services are sorted critical-first), an unknown tab falls back to Overview,
// and a trace URL with no id to the list its datasource belongs to. Either way
// the result names something the page can render.
//
// The datasource key is only present on a mobile trace. A backend trace parses
// to exactly the shape it always has, so nothing that compares routes has to
// learn that `datasource: undefined` and no key at all mean the same thing.
export function parseRoute(pathname, search = '') {
  const page = VIEW_FOR_PATH.get(pathname)
  if (page) return { view: page }
  if (pathname.startsWith('/trace/')) {
    const traceId = segmentAfter(pathname, '/trace/')
    const datasource = traceDatasource(search)
    if (!traceId) return { view: datasource === 'mobile' ? 'mtraces' : 'traces' }
    return datasource ? { view: 'trace', traceId, datasource } : { view: 'trace', traceId }
  }
  if (pathname.startsWith('/service/')) {
    const id = segmentAfter(pathname, '/service/')
    const tab = new URLSearchParams(search).get('tab')
    return {
      view: 'service',
      serviceId: services.some(s => s.id === id) ? id : services[0].id,
      serviceSubTab: SERVICE_TABS.includes(tab) ? tab : DEFAULT_SERVICE_TAB,
    }
  }
  return { view: 'home' }
}

export function serviceUrl(serviceId, subTab = DEFAULT_SERVICE_TAB) {
  const path = `/service/${encodeURIComponent(serviceId)}`
  return subTab && subTab !== DEFAULT_SERVICE_TAB ? `${path}?tab=${encodeURIComponent(subTab)}` : path
}

export function traceUrl(traceId, datasource) {
  const path = `/trace/${encodeURIComponent(traceId)}`
  return TRACE_DATASOURCES.has(datasource) ? `${path}?datasource=${datasource}` : path
}

// The one URL a route is spelled as.
export function routeUrl(route) {
  if (route.view === 'service') return serviceUrl(route.serviceId, route.serviceSubTab)
  if (route.view === 'trace') return traceUrl(route.traceId, route.datasource)
  return VIEW_PATHS[route.view] ?? VIEW_PATHS.home
}

// What App corrects the address to. On a service or a trace it owns the whole
// URL — the path and the ?tab= or ?datasource= that routeUrl already prints;
// appending the search on top would spell the datasource twice, and the second
// copy would be read back as part of the first. A trace URL with no id hands
// over to a list, and the ?datasource= that picked which list was the trace
// view's, so it is not carried onto the list either. Anywhere else it owns only
// the path: the query string is the page's (the Errors page keeps its filters
// there), so it is carried across untouched rather than stripped.
export function canonicalUrl(pathname, search = '') {
  const route = parseRoute(pathname, search)
  const url = routeUrl(route)
  const ownsQuery = route.view === 'service' || route.view === 'trace' || pathname.startsWith('/trace/')
  return ownsQuery ? url : url + search
}
