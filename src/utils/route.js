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

import { services } from '@/data/services'

// The service page's views, in the order its tab strip shows them. The strip
// is built from this list, so a tab the URL can name is a tab the page has.
export const SERVICE_TABS = ['overview', 'detail', 'red', 'external', 'db', 'errors', 'runtime']
export const DEFAULT_SERVICE_TAB = 'overview'

const VIEW_PATHS = {
  home: '/home',
  logs: '/logs',
  traces: '/traces',
  explore: '/explore',
  errors: '/errors',
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

// An unknown service falls back to the first one, which is the most severe
// (services are sorted critical-first), an unknown tab falls back to Overview,
// and a trace URL with no id to the Traces list. Either way the result names
// something the page can render.
export function parseRoute(pathname, search = '') {
  const page = VIEW_FOR_PATH.get(pathname)
  if (page) return { view: page }
  if (pathname.startsWith('/trace/')) {
    const traceId = segmentAfter(pathname, '/trace/')
    return traceId ? { view: 'trace', traceId } : { view: 'traces' }
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

export function traceUrl(traceId) {
  return `/trace/${encodeURIComponent(traceId)}`
}

// The one URL a route is spelled as.
export function routeUrl(route) {
  if (route.view === 'service') return serviceUrl(route.serviceId, route.serviceSubTab)
  if (route.view === 'trace') return traceUrl(route.traceId)
  return VIEW_PATHS[route.view] ?? VIEW_PATHS.home
}

// What App corrects the address to. On a service it owns the whole URL — the
// path and ?tab=. Anywhere else it owns only the path: the query string is
// the page's (the Errors page keeps its filters there), so it is carried
// across untouched rather than stripped.
export function canonicalUrl(pathname, search = '') {
  const route = parseRoute(pathname, search)
  const url = routeUrl(route)
  return route.view === 'service' ? url : url + search
}
