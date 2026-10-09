// The Browser (RUM) page's data: what the storefront's and the back office's
// own JavaScript reported from real users' browsers, as a function of the
// selected window.
//
// Four decisions carry it, and each is the time model's own rule applied to a
// browser instead of a server:
//
//   1. PRODUCTION'S FIGURES ARE THE QUIET VALUES. The page this replaces shows
//      a week of cubedemo-web, and a 22-minute incident is 0.2% of a week, so
//      what it shows is a quiet reading. Those numbers are written down below
//      as they appear there (94.08 rpm, 1.18 s, LCP 4.55 s, 4.98%) and Last 1
//      hour reproduces them to the digit on every row the incident does not
//      reach. A row it does reach publishes the quiet value plus whatever the
//      backend it waits on added, so it is never written down twice.
//      Only the hour does: a rate carries the daily wave, pinned at the hour
//      the demo opened, so a week's rates and counts read the wave's mean over
//      that hour's level - 0.72× to 1.6× the published week, by time of day -
//      while latencies and vitals, which carry no wave, match it.
//
//   2. THE INCIDENT REACHES THE BROWSER THROUGH THE BACKEND, NOT A COPY OF IT.
//      payment-service's Redis pool is the platform's one incident, and a
//      browser sees it as the calls it makes into that service getting slower
//      and failing more. So a payment call's error rate rises by exactly the
//      points payment-service's own endpoint rose (read off services.js's
//      calibrated profiles at the same incident weight), its latency by the
//      milliseconds the service added, and the checkout page — which waits on
//      those calls — loads slower and responds to the Pay click slower by the
//      same amount. Both sides sample one incident profile, so they rise in the
//      same minute on every range rather than in two curves that agree at one.
//      Every other call and page is flat plus the daily traffic wave.
//
//   3. ERRORS ARE COUNTED, NOT PLACED. A route's script errors and an ajax
//      call's failed responses are request rate × error rate × minutes, bucket
//      by bucket, in whole errors that add up — the Errors page's rule. While
//      the pool is out a payment call fails with the pool's own codes (500 and
//      503) rather than the 404s and 500s it fails with all week, and every
//      failed create-payment call leaves the checkout page reading
//      `clientSecret` off an undefined response — one TypeError for each, never
//      more. Narrow the range and that TypeError is the checkout's top error;
//      widen it and the background TypeError it shares a row with takes over.
//
//   4. A SAMPLE IS ITS TRACE ID. A trace in the list encodes which outcome it
//      was (route or call, error or not) and when, under salts of its own, so
//      `/trace/<id>` rebuilds the same request after a reload and neither this
//      module nor the Errors page ever decodes the other's ids. Durations,
//      browser, session and page are hashed off the id, so the list, the
//      waterfall and the error modal cannot disagree about one.
//
// Everything is a pure function of the window: no Date.now, no Math.random,
// and every profile seed is a fixed number in this module's own range (5000+).

import {
  BASE_TIME, REFERENCE_WINDOW, INCIDENT_START_MIN, incidentWeight, incidentWeightOver, noiseAt,
  peakIncidentWeight, pinToReference, sampleAt, valueAtWeight, windowMean, windowQuantile, windowSeries,
} from './timeWindow'
import { serviceProfile, errorRateProfiles } from './services'
import { previousWindow, groupErrorSeries } from './errors'
import { RUNTIME_HOSTS, livesOf } from './runtimeHosts'
import { makeSpan, httpServerTags } from './tracesExplorer'
import { statusForErrorRate, statusForWebVital, worstStatus } from '@/utils/status'
import { formatLocal } from '@/utils/timeRange'

const BASE_MS = BASE_TIME.getTime()
const BASE_SEC = Math.floor(BASE_MS / 1000)

/* ---- the apps ---- */

const WEB = 'cubedemo-web'
const ADMIN = 'cubedemo-admin'

/** The browser apps the page lists, in no particular order — see browserAppsForWindow for the sorted list. */
export const BROWSER_APPS = [
  { id: WEB, name: WEB, language: 'web', origin: 'https://shop.cubedemo.com' },
  { id: ADMIN, name: ADMIN, language: 'web', origin: 'https://admin.cubedemo.com' },
]

// What a backend a browser call lands on did during the incident, as the
// services module calibrated it. `['service', id]` is the service's own
// profile; `['red', endpoint]` one of payment-service's RED endpoints, which
// is how POST /v1/payments fails 17% of the time at the plateau while the
// service as a whole fails 15%.
const PAYMENT_LATENCY = ['service', 'payment-service']

// The codes a call answers with. All week a call to anything fails the way
// production's do — a 404 for a stale id, a 500 for a bad deploy. While the
// pool is out a payment call fails with the pool's own codes (errors.js EXC.pool),
// and a call into order- or shipment-service with what those answer when
// their own call into payment-service fails (errors.js EXC.downstream).
const QUIET_CODES = { 404: 0.6, 500: 0.4 }
const POOL_CODES = { 500: 0.75, 503: 0.25 }
const DOWNSTREAM_CODES = { 502: 0.6, 500: 0.4 }

// The reason phrase each code is spoken with — utils/errorsPage httpReason's
// phrases, kept here because that module pulls the query builder (a component)
// in behind it, and traceDetail imports this one.
const REASONS = { 200: 'OK', 404: 'Not Found', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable' }

/**
 * cubedemo-web's pages, as production lists them over seven days. `median`,
 * `avg` and the vitals are milliseconds (CLS is unitless); production prints
 * anything over a second as `1.18s`, which is all it says about those, so
 * that is all that is written down.
 *
 * `scriptErrors7d` is the route's script errors over the same week, all three
 * types together: production shows the top ten rows of its 42, so a route it
 * shows a TypeError count for is that count over the TypeError share, and the
 * rest are sized at the ~9.65% of page views those shown rows run at
 * (`scriptShare` below). Divided by the 10080 minutes in a week, it is the
 * quiet per-minute rate.
 *
 * `incident` marks the one page on the payment path: checkout waits on the
 * payment calls to load and to answer the Pay click, so its load time (median
 * and average) and its INP rise by what payment-service added. Its median
 * still reads the quiet 1.97 s at Last 1 hour — under half of that hour's
 * page loads were slow, so the 50th percentile never reaches them — and jumps
 * once the window is narrow enough that more than half are: p90's cliff, from
 * the other side.
 *
 * Append only: a route's index is part of every one of its samples' trace ids.
 */
const WEB_ROUTES = [
  { route: '/product/:sku', rpm: 94.08, median: 1180, avg: 1180, lcp: 4550, inp: 176.66, cls: 0.28, scriptErrors7d: 91490 },
  { route: '/', rpm: 78.33, median: 981.88, avg: 981.74, lcp: 1840, inp: 108.16, cls: 0.03, scriptErrors7d: 76077 },
  { route: '/search', rpm: 62.71, median: 1470, avg: 1470, lcp: 2210, inp: 162.97, cls: 0.06, scriptErrors7d: 61103 },
  { route: '/cart', rpm: 39.24, median: 883.55, avg: 883.62, lcp: 1600, inp: 149.13, cls: 0.03, scriptErrors7d: 37824 },
  { route: '/orders', rpm: 31.37, median: 1280, avg: 1280, lcp: 1970, inp: 121.82, cls: 0.04, scriptErrors7d: 31220 },
  { route: '/orders/:orderId', rpm: 31.34, median: 1570, avg: 1570, lcp: 2090, inp: 135.43, cls: 0.06 },
  {
    route: '/checkout', rpm: 23.49, median: 1970, avg: 1960, lcp: 2210, inp: 569.73, cls: 0.04,
    incident: { latency: PAYMENT_LATENCY, on: ['median', 'avg', 'inp'] },
  },
  { route: '/account/:userId/wishlist', rpm: 15.74, median: 1380, avg: 1370, lcp: 2210, inp: 149.58, cls: 0.07 },
  { route: '/shipments/:trackingId/track', rpm: 15.65, median: 1770, avg: 1770, lcp: 2340, inp: 163.19, cls: 0.08 },
  { route: '/category/home', rpm: 9.45, median: 1080, avg: 1080, lcp: 2100, inp: 135.99, cls: 0.07 },
  { route: '/category/apparel', rpm: 9.44, median: 1080, avg: 1080, lcp: 2090, inp: 135.59, cls: 0.07 },
  { route: '/category/grocery', rpm: 9.4, median: 1080, avg: 1080, lcp: 2090, inp: 136.22, cls: 0.07 },
  { route: '/category/footwear', rpm: 9.39, median: 1080, avg: 1080, lcp: 2080, inp: 136.01, cls: 0.07 },
  { route: '/category/audio', rpm: 9.39, median: 1080, avg: 1080, lcp: 2090, inp: 135.8, cls: 0.07 },
]

/**
 * The calls cubedemo-web makes, as production lists them: `METHOD host:port/path`
 * with production's rpm, average response time (ms) and error %.
 *
 * `calls` is the backend endpoint the request lands on, spelled the way that
 * service's own spans spell it (order-service routes are singular), mapped by
 * hand rather than string-matched. `follows` names the backend profiles whose
 * incident the call inherits: latency from the service, errors from the RED
 * endpoint where payment-service publishes one and from the service where it
 * does not (the list call has no RED row). `incident` is what it answers with
 * while the pool is out. `page` is the route that makes the call, for the
 * sample's page URL.
 *
 * Append only, for the same reason as the routes.
 */
const WEB_AJAX = [
  {
    endpoint: 'GET order.cubedemo.com:443/v1/orders', rpm: 66.48, avg: 229.76, errPct: 5, page: '/orders',
    calls: { service: 'order-service', endpoint: 'GET /v1/order' },
    follows: { avg: ['service', 'order-service'], err: ['service', 'order-service'] }, incident: DOWNSTREAM_CODES,
  },
  {
    endpoint: 'GET order.cubedemo.com:443/v1/orders/:orderId', rpm: 38.52, avg: 228.97, errPct: 4.98, page: '/orders/:orderId',
    calls: { service: 'order-service', endpoint: 'GET /v1/order' },
    follows: { avg: ['service', 'order-service'], err: ['service', 'order-service'] }, incident: DOWNSTREAM_CODES,
  },
  {
    endpoint: 'GET payment.cubedemo.com:443/v1/payments', rpm: 87.12, avg: 229.43, errPct: 5.02, page: '/orders/:orderId',
    calls: { service: 'payment-service', endpoint: 'GET /v1/payments' },
    follows: { avg: PAYMENT_LATENCY, err: ['service', 'payment-service'] }, incident: POOL_CODES,
  },
  {
    endpoint: 'GET payment.cubedemo.com:443/v1/payments/:paymentId', rpm: 28.27, avg: 228.9, errPct: 5.06, page: '/checkout',
    calls: { service: 'payment-service', endpoint: 'GET /v1/payments/:id' },
    follows: { avg: PAYMENT_LATENCY, err: ['red', 'GET /v1/payments/:id'] }, incident: POOL_CODES,
  },
  { endpoint: 'GET search.cubedemo.com:443/v1/search/fame', rpm: 110.89, avg: 229.37, errPct: 5.03, page: '/search', calls: { service: 'search-service', endpoint: 'GET /v1/search' } },
  { endpoint: 'GET search.cubedemo.com:443/v1/search/happiness', rpm: 110.53, avg: 229.46, errPct: 5.03, page: '/search', calls: { service: 'search-service', endpoint: 'GET /v1/search' } },
  { endpoint: 'GET search.cubedemo.com:443/v1/search/success', rpm: 110.69, avg: 229.57, errPct: 4.98, page: '/search', calls: { service: 'search-service', endpoint: 'GET /v1/search' } },
  { endpoint: 'GET search.cubedemo.com:443/v1/search/wealth', rpm: 110.55, avg: 229.51, errPct: 4.98, page: '/search', calls: { service: 'search-service', endpoint: 'GET /v1/search' } },
  {
    endpoint: 'GET shipment.cubedemo.com:443/v1/shipments/:trackingId/tracking', rpm: 62.05, avg: 229.93, errPct: 4.95, page: '/shipments/:trackingId/track',
    calls: { service: 'shipment-service', endpoint: 'GET /v1/shipment' },
    follows: { avg: ['service', 'shipment-service'], err: ['service', 'shipment-service'] }, incident: DOWNSTREAM_CODES,
  },
  {
    endpoint: 'POST order.cubedemo.com:443/v1/orders', rpm: 28.24, avg: 229.74, errPct: 4.96, page: '/checkout',
    calls: { service: 'order-service', endpoint: 'POST /v1/order' },
    follows: { avg: ['service', 'order-service'], err: ['service', 'order-service'] }, incident: DOWNSTREAM_CODES,
  },
  {
    endpoint: 'POST payment.cubedemo.com:443/v1/payments', rpm: 28.29, avg: 229.38, errPct: 4.92, page: '/checkout',
    calls: { service: 'payment-service', endpoint: 'POST /v1/payments' },
    follows: { avg: PAYMENT_LATENCY, err: ['red', 'POST /v1/payments'] }, incident: POOL_CODES,
  },
]

/**
 * cubedemo-admin, the back office: a handful of staff, fast pages, almost no
 * errors, and no payment calls of its own. It is here so the app list has
 * something to sort — production has one browser app, and a severity sort of
 * one proves nothing — and so the incident has a second, smaller reach: its
 * order lookups go through order-service, which fails 1.2 points more while
 * payment-service is down, and that takes this app to warning and no further.
 */
const ADMIN_ROUTES = [
  { route: '/dashboard', rpm: 4.2, median: 1240, avg: 1310, lcp: 1720, inp: 96.4, cls: 0.02 },
  { route: '/orders', rpm: 3.6, median: 1120, avg: 1180, lcp: 1580, inp: 112.3, cls: 0.03 },
  { route: '/orders/:orderId', rpm: 2.9, median: 980, avg: 1040, lcp: 1450, inp: 104.7, cls: 0.02 },
  { route: '/refunds', rpm: 0.8, median: 1060, avg: 1110, lcp: 1510, inp: 118.2, cls: 0.04 },
  { route: '/customers/:customerId', rpm: 1.4, median: 940, avg: 990, lcp: 1390, inp: 92.8, cls: 0.01 },
  { route: '/reports/sales', rpm: 0.6, median: 1890, avg: 2030, lcp: 2240, inp: 168.5, cls: 0.05 },
]

const ADMIN_AJAX = [
  {
    endpoint: 'GET order.cubedemo.com:443/v1/orders', rpm: 6.2, avg: 212.4, errPct: 0.31, page: '/orders',
    calls: { service: 'order-service', endpoint: 'GET /v1/order' },
    follows: { avg: ['service', 'order-service'], err: ['service', 'order-service'] }, incident: DOWNSTREAM_CODES,
  },
  {
    endpoint: 'GET order.cubedemo.com:443/v1/orders/:orderId', rpm: 4.1, avg: 198.7, errPct: 0.27, page: '/orders/:orderId',
    calls: { service: 'order-service', endpoint: 'GET /v1/order' },
    follows: { avg: ['service', 'order-service'], err: ['service', 'order-service'] }, incident: DOWNSTREAM_CODES,
  },
  { endpoint: 'GET analytics.cubedemo.com:443/v1/reports/sales', rpm: 1.8, avg: 342.6, errPct: 0.12, page: '/reports/sales', calls: { service: 'analytics-service', endpoint: 'GET /v1/reports/sales' } },
  { endpoint: 'POST notify.cubedemo.com:443/v1/notify', rpm: 0.9, avg: 156.3, errPct: 0.4, page: '/customers/:customerId', calls: { service: 'notify-service', endpoint: 'POST /v1/notify' } },
]

/**
 * Where each route's code lives, for the stacks its exceptions carry. A
 * TypeError is the component reading a field off data that did not arrive; a
 * RangeError is one of the formatting helpers it calls (`range` names which
 * one); a NetworkError comes out of the shared fetch wrapper, awaited by the
 * route's loader. /cart's frame is the one production's own modal shows.
 */
const WEB_UI = {
  '/product/:sku': { component: 'ProductGallery', file: 'src/components/product/ProductGallery.jsx', loader: 'loadProduct', prop: 'images', range: 'digits' },
  '/': { component: 'HeroCarousel', file: 'src/components/home/HeroCarousel.jsx', loader: 'loadHome', prop: 'slides', range: 'recursion' },
  '/search': { component: 'SearchResults', file: 'src/components/search/SearchResults.jsx', loader: 'runSearch', prop: 'results', nullish: true, range: 'array' },
  '/cart': { component: 'CartSummary', file: 'src/components/cart.js', line: 118, col: 22, loader: 'loadCart', prop: 'total', range: 'currency' },
  '/orders': { component: 'OrderList', file: 'src/components/orders/OrderList.jsx', loader: 'loadOrders', prop: 'status', range: 'date' },
  '/orders/:orderId': { component: 'OrderTimeline', file: 'src/components/orders/OrderTimeline.jsx', loader: 'loadOrder', prop: 'events', range: 'date' },
  '/checkout': { component: 'CheckoutForm', file: 'src/components/checkout/CheckoutForm.jsx', loader: 'loadCheckout', prop: 'shippingAddress', range: 'currency' },
  '/account/:userId/wishlist': { component: 'WishlistGrid', file: 'src/components/account/WishlistGrid.jsx', loader: 'loadWishlist', prop: 'items', range: 'array' },
  '/shipments/:trackingId/track': { component: 'TrackingMap', file: 'src/components/shipments/TrackingMap.jsx', loader: 'loadTracking', prop: 'coordinates', nullish: true, range: 'date' },
  category: { component: 'CategoryGrid', file: 'src/components/category/CategoryGrid.jsx', loader: 'loadCategory', prop: 'price', range: 'currency' },
}

const ADMIN_UI = {
  '/dashboard': { component: 'RevenueTiles', file: 'src/views/dashboard/RevenueTiles.jsx', prop: 'revenue', chunk: [412, '3be1f0c2'] },
  '/orders': { component: 'OrdersTable', file: 'src/views/orders/OrdersTable.jsx', prop: 'rows', chunk: [318, '9a0c71de'] },
  '/orders/:orderId': { component: 'OrderDetail', file: 'src/views/orders/OrderDetail.jsx', prop: 'lineItems', chunk: [977, '51e8ab04'] },
  '/refunds': { component: 'RefundQueue', file: 'src/views/refunds/RefundQueue.jsx', prop: 'amount', chunk: [254, 'c7f3920a'] },
  '/customers/:customerId': { component: 'CustomerProfile', file: 'src/views/customers/CustomerProfile.jsx', prop: 'email', nullish: true, chunk: [641, '0d6be5f9'] },
  '/reports/sales': { component: 'SalesReport', file: 'src/views/reports/SalesReport.jsx', prop: 'series', chunk: [783, 'e42a1b67'] },
}

const APPS = {
  [WEB]: {
    ...BROWSER_APPS[0],
    release: '2026.10.07-4f2a9c',
    bundle: 'https://shop.cubedemo.com/assets/index-4f2a9c.js',
    vendor: 'https://shop.cubedemo.com/assets/vendor-react-1b7e3d.js',
    routes: WEB_ROUTES,
    ajax: WEB_AJAX,
    ui: route => WEB_UI[route] ?? WEB_UI.category,
    // Production's split of a route's script errors.
    scriptMix: [['TypeError', 0.5], ['NetworkError', 0.25], ['RangeError', 0.25]],
    scriptShare: 0.0965,
    // Every failed create-payment call leaves the checkout reading
    // `clientSecret` off a response that is not there.
    mirrors: [{ route: '/checkout', from: 'POST payment.cubedemo.com:443/v1/payments', exception: 'TypeError', variant: 'clientSecret' }],
    clients: 'consumer',
  },
  [ADMIN]: {
    ...BROWSER_APPS[1],
    release: '2026.09.30-9d0e7b',
    // A webpack build: one main bundle carries the app and React both, and the
    // routes split into chunks — which is where a ChunkLoadError comes from.
    bundle: 'https://admin.cubedemo.com/static/js/main.9d0e7b31.js',
    vendor: 'https://admin.cubedemo.com/static/js/main.9d0e7b31.js',
    routes: ADMIN_ROUTES,
    ajax: ADMIN_AJAX,
    ui: route => ADMIN_UI[route],
    scriptMix: [['TypeError', 0.7], ['ChunkLoadError', 0.3]],
    scriptShare: 0.012,
    mirrors: [],
    clients: 'staff',
  },
}

const APP_IDS = BROWSER_APPS.map(a => a.id)

/**
 * The source maps Settings › Source Maps starts with: one for each app's main
 * bundle, the file every exception's top frame points into, so the
 * un-minified stack works out of the box and deleting the map is what shows
 * the page without one.
 */
export const BROWSER_SOURCE_MAP_SEED = [
  {
    id: 'sm-cubedemo-web-index',
    appId: WEB,
    sourceFile: APPS[WEB].bundle,
    sourceMap: `${APPS[WEB].bundle}.map`,
    description: `Storefront release ${APPS[WEB].release}: main bundle`,
  },
  {
    id: 'sm-cubedemo-admin-main',
    appId: ADMIN,
    sourceFile: APPS[ADMIN].bundle,
    sourceMap: `${APPS[ADMIN].bundle}.map`,
    description: `Back office release ${APPS[ADMIN].release}: main bundle`,
  },
]

/* ---- small helpers ---- */

const round = (v, d) => {
  const f = 10 ** d
  return Math.round(v * f) / f
}
const sumOf = seq => seq.reduce((a, v) => a + (v ?? 0), 0)
const axis = b => ({ m: b.m, t: b.t, label: b.label, exactTime: b.exactTime })

// FNV-1a, the hash eventsStore and errors.js seed with.
function hashStr(s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

const hex = (n, width) => n.toString(16).padStart(width, '0')
const rndFrom = seed => {
  let i = 0
  return () => noiseAt(seed, i++)
}
const hexOf = (rnd, len) => Array.from({ length: len }, () => Math.floor(rnd() * 16).toString(16)).join('')
const between = ([lo, hi], u) => lo * (hi / lo) ** u

// The index `u` (in [0, 1)) lands on when each entry owns its weight's share.
function pickWeighted(weights, u) {
  const total = weights.reduce((a, w) => a + w, 0)
  if (!(total > 0)) return 0
  let left = u * total
  for (let i = 0; i < weights.length; i++) {
    left -= weights[i]
    if (left < 0) return i
  }
  return weights.length - 1
}

function splitEndpoint(endpoint) {
  const i = endpoint.indexOf(' ')
  return [endpoint.slice(0, i), endpoint.slice(i + 1)]
}

// 'GET search.cubedemo.com:443/v1/search/wealth' → its method, host, port and path.
function parseCall(endpoint) {
  const [method, rest] = splitEndpoint(endpoint)
  const slash = rest.indexOf('/')
  const [host, port] = rest.slice(0, slash).split(':')
  return { method, host, port: port ?? '443', path: rest.slice(slash) }
}

// A window-keyed memo: everything here is a pure function of the window object
// a page resolves once per range, so a page that reads one table three times
// builds it once.
const MEMO = new WeakMap()
function memo(win, key, build) {
  let m = MEMO.get(win)
  if (!m) MEMO.set(win, (m = new Map()))
  if (!m.has(key)) m.set(key, build())
  return m.get(key)
}

const prevOf = win => memo(win, 'prev', () => previousWindow(win))

/* ---- profiles ---- */

const NOISE = { rpm: 0.08, load: 0.08, ajax: 0.08, err: 0.12, vital: 0.06 }
// Static seeds in this module's own range, by app, table and row — never a
// counter, so building one table first cannot redraw another's jitter.
const seedOf = (app, table, row) => 5000 + app * 1000 + table * 200 + row * 10

// Pin and read with the same aggregate (services.js readProfile): a median
// pinned as a mean reads the incident plateau as if it were the hour.
function read(win, profile, how, rate) {
  return how === 'median' ? windowQuantile(win, profile, 0.5, rate) : windowMean(win, profile)
}

function pinned(base, target, how = 'mean', rate = null) {
  return pinToReference(base, (w, p) => read(w, p, how, rate), target)
}

function backendOf([kind, key], metric) {
  if (kind === 'service') return serviceProfile(key)[metric]
  // Read lazily and in the services module's canonical order: building the
  // derived tables at import, or one before another, redraws every APM
  // table's wide-range jitter (errors.test 'reading the error profiles…').
  // errorRateProfiles carries rpm and err only, which is all a RED row lends.
  return errorRateProfiles('red').find(p => p.endpoint === key)[metric]
}

// How far a backend profile moves between quiet and the incident's plateau.
const deltaOf = backend => valueAtWeight(backend, 1) - valueAtWeight(backend, 0)

/**
 * A browser metric that rises by exactly what its backend rose: the quiet
 * value production shows, and a peak set so that at any incident weight w the
 * browser reads `quiet + Δbackend(w)`. Not pinned — its Last 1 hour is not a
 * published figure but whatever the quiet value plus the backend's hour comes
 * to, and pinning would scale the backend's delta along with the baseline.
 */
function follow(quiet, backend, noise, seed) {
  return { baseline: quiet, peak: 1 + deltaOf(backend) / quiet, noise, seed }
}

function routeProfiles(app, r, s) {
  const rpm = pinned({ baseline: r.rpm, noise: NOISE.rpm, seed: s + 1, diurnal: true }, r.rpm)
  const inc = r.incident
  const backend = inc ? backendOf(inc.latency, 'avg') : null
  const follows = key => backend && inc.on.includes(key)
  const mean = (key, noise, slot) => (follows(key)
    ? follow(r[key], backend, noise, s + slot)
    : pinned({ baseline: r[key], noise, seed: s + slot }, r[key]))

  let median = follows('median')
    ? follow(r.median, backend, NOISE.load, s + 2)
    : { baseline: r.median, noise: NOISE.load, seed: s + 2 }
  median = pinned(median, r.median, 'median', rpm)
  if (follows('median')) {
    // Pinning scaled the baseline, and the delta with it. Put the delta back
    // and pin once more: the hour's median is a quiet request either way, so
    // the second pin moves the baseline by a rounding error and lands exact.
    median = pinned({ ...median, peak: 1 + deltaOf(backend) / median.baseline }, r.median, 'median', rpm)
  }

  const perMin = r.scriptErrors7d != null ? r.scriptErrors7d / 10080 : r.rpm * app.scriptShare
  const jsPct = (perMin / r.rpm) * 100
  return {
    rpm,
    median,
    avg: mean('avg', NOISE.load, 3),
    lcp: mean('lcp', NOISE.vital, 4),
    inp: mean('inp', NOISE.vital, 5),
    cls: mean('cls', NOISE.vital, 6),
    // Script errors per page view, %. Flat: a script error is the page's own
    // bug, and the incident's reaches the page as the mirrored TypeError.
    jsErr: pinned({ baseline: jsPct, noise: NOISE.err, seed: s + 7 }, jsPct),
  }
}

function ajaxProfiles(c, s) {
  const rpm = pinned({ baseline: c.rpm, noise: NOISE.rpm, seed: s + 1, diurnal: true }, c.rpm)
  const avg = c.follows?.avg
    ? follow(c.avg, backendOf(c.follows.avg, 'avg'), NOISE.ajax, s + 2)
    : pinned({ baseline: c.avg, noise: NOISE.ajax, seed: s + 2 }, c.avg)
  const err = c.follows?.err
    ? follow(c.errPct, backendOf(c.follows.err, 'err'), NOISE.err, s + 3)
    : pinned({ baseline: c.errPct, noise: NOISE.err, seed: s + 3 }, c.errPct)
  return { rpm, avg, err }
}

// Built on first use, not at import: traceDetail imports this module, and the
// backend profiles it reads build derived tables whose seeds go in build order.
let PROFILES = null
function profiles() {
  if (PROFILES) return PROFILES
  const out = {}
  APP_IDS.forEach((id, a) => {
    const app = APPS[id]
    out[id] = {
      routes: app.routes.map((r, i) => routeProfiles(app, r, seedOf(a, 0, i))),
      ajax: app.ajax.map((c, i) => ajaxProfiles(c, seedOf(a, 1, i))),
    }
  })
  PROFILES = out
  return out
}

/**
 * The calibrated profiles behind one app's tables, row for row in the tables'
 * order: `routes` carry rpm, median, avg, lcp, inp, cls and jsErr (script
 * errors per page view, %), `ajax` carry rpm, avg and err. Read-only — for the
 * cross-module tests that hold the browser's incident to the backend's, and
 * for anything that needs a reading at one instant (valueAtWeight).
 */
export function browserProfiles(appId) {
  const app = APPS[appId]
  if (!app) return null
  const p = profiles()[appId]
  return {
    routes: app.routes.map((r, i) => ({ endpoint: r.route, ...p.routes[i] })),
    ajax: app.ajax.map((c, i) => ({ endpoint: c.endpoint, service: c.calls.service, calls: c.calls, follows: c.follows ?? null, ...p.ajax[i] })),
  }
}

/* ---- pooled aggregates ---- */

// An app-wide figure is its rows' figures weighted by how many requests each
// served, bucket by bucket — a page-view-weighted mean, which is what
// production's overall vitals and load times turn out to be.
function weightedAt(b, pairs) {
  let num = 0
  let den = 0
  for (const { rate, value } of pairs) {
    const r = Math.max(0, sampleAt(rate, b))
    num += r * sampleAt(value, b)
    den += r
  }
  return den > 0 ? num / den : null
}

function pooledMean(win, pairs) {
  let num = 0
  let den = 0
  for (const b of win.pastBuckets) {
    for (const { rate, value } of pairs) {
      const r = Math.max(0, sampleAt(rate, b)) * b.durMin
      num += r * sampleAt(value, b)
      den += r
    }
  }
  return den > 0 ? num / den : 0
}

function weightedQuantile(points, q) {
  points.sort((a, b) => a.v - b.v)
  const total = points.reduce((a, p) => a + p.w, 0)
  if (!(total > 0)) return points[points.length - 1]?.v ?? 0
  let acc = 0
  for (const p of points) {
    acc += p.w
    if (acc >= total * q) return p.v
  }
  return points[points.length - 1].v
}

// A median over every page load the window served, whichever route it was.
function pooledQuantile(win, pairs, q) {
  const points = []
  for (const b of win.pastBuckets) {
    for (const { rate, value } of pairs) points.push({ v: sampleAt(value, b), w: Math.max(0, sampleAt(rate, b)) * b.durMin })
  }
  return weightedQuantile(points, q)
}

function pooledSeries(win, pairs, digits, at) {
  return win.buckets.map(b => ({ ...axis(b), value: b.future ? null : round(at(b, pairs), digits) }))
}

// Only the rates: the app's calls (or page views) a minute, every row's together.
const sumAt = (b, pairs) => pairs.reduce((a, { rate }) => a + sampleAt(rate, b), 0)
const quantileAt = q => (b, pairs) => weightedQuantile(pairs.map(({ rate, value }) => ({ v: sampleAt(value, b), w: Math.max(0, sampleAt(rate, b)) })), q)

/* ---- page views ---- */

const EMPTY_SERIES = keys => Object.fromEntries(keys.map(k => [k, []]))

// A window none of whose time has happened yet: a custom range set after the
// demo was opened (the picker checks against the clock, the data against
// BASE_TIME). Nothing was measured in it, and the aggregates would say
// otherwise — windowMean falls back to the baseline, a pooled mean to 0, and
// statusForWebVital rates a 0 ms LCP "Good". So every reader below answers
// such a window as it would an app with nothing to show: no rows (the tables
// say "No page views in this time range") and no summary (no cards, rather
// than a green chip over no data).
const nothingMeasured = win => !(win?.pastBuckets?.length > 0)

/**
 * Page loads per route: page views a minute, and load time as a median and as
 * a mean. Rows and every series list come in one canonical order, index for
 * index, so a chart and a table built from them name the same route by the
 * same position; the page sorts its own copy.
 */
export function pageViewsForWindow(win, appId) {
  const app = APPS[appId]
  if (!app || nothingMeasured(win)) return { rows: [], series: EMPTY_SERIES(['rpm', 'median', 'avg']) }
  return memo(win, `pv|${appId}`, () => {
    const P = profiles()[appId].routes
    const rows = app.routes.map((r, i) => ({
      endpoint: r.route,
      rpm: round(windowMean(win, P[i].rpm), 2),
      median: round(windowQuantile(win, P[i].median, 0.5, P[i].rpm), 2),
      avg: round(windowMean(win, P[i].avg), 2),
    }))
    const seriesOf = key => app.routes.map((r, i) => ({ endpoint: r.route, series: windowSeries(win, P[i][key]) }))
    return { rows, series: { rpm: seriesOf('rpm'), median: seriesOf('median'), avg: seriesOf('avg') } }
  })
}

function pageSummary(win, appId) {
  const P = profiles()[appId].routes
  const rates = P.map(p => ({ rate: p.rpm }))
  const pairs = key => P.map(p => ({ rate: p.rpm, value: p[key] }))
  return {
    rpm: round(P.reduce((a, p) => a + windowMean(win, p.rpm), 0), 2),
    median: round(pooledQuantile(win, pairs('median'), 0.5), 2),
    avg: round(pooledMean(win, pairs('avg')), 2),
    rates,
    pairs,
  }
}

/**
 * The app as a whole: page views a minute (every route's together), and the
 * load time of every page load the window served — the median over all of
 * them, and their mean. `prev` is the same over the window before, for the
 * delta chip; `series` the same figures bucket by bucket.
 */
export function pageViewsSummaryForWindow(win, appId) {
  if (!APPS[appId] || nothingMeasured(win)) return null
  return memo(win, `pvs|${appId}`, () => {
    const cur = pageSummary(win, appId)
    const prev = pageSummary(prevOf(win), appId)
    return {
      rpm: cur.rpm,
      median: cur.median,
      avg: cur.avg,
      prev: { rpm: prev.rpm, median: prev.median, avg: prev.avg },
      series: {
        rpm: pooledSeries(win, cur.rates, 2, sumAt),
        median: pooledSeries(win, cur.pairs('median'), 2, quantileAt(0.5)),
        avg: pooledSeries(win, cur.pairs('avg'), 2, weightedAt),
      },
    }
  })
}

/* ---- ajax calls ---- */

/**
 * The XHR / fetch calls the app makes: calls a minute, average response time
 * as the browser waited it (network included, which is why a 58 ms search
 * reads 229 ms here), and the share that came back 4xx or 5xx. `service` is
 * the backend the call lands on.
 */
export function ajaxCallsForWindow(win, appId) {
  const app = APPS[appId]
  if (!app || nothingMeasured(win)) return { rows: [], series: EMPTY_SERIES(['rpm', 'avg', 'errPct']) }
  return memo(win, `ajax|${appId}`, () => {
    const P = profiles()[appId].ajax
    const rows = app.ajax.map((c, i) => ({
      endpoint: c.endpoint,
      rpm: round(windowMean(win, P[i].rpm), 2),
      avg: round(windowMean(win, P[i].avg), 2),
      errPct: round(windowMean(win, P[i].err), 2),
      service: c.calls.service,
    }))
    const seriesOf = key => app.ajax.map((c, i) => ({ endpoint: c.endpoint, series: windowSeries(win, P[i][key]) }))
    return { rows, series: { rpm: seriesOf('rpm'), avg: seriesOf('avg'), errPct: seriesOf('err') } }
  })
}

function ajaxSummary(win, appId) {
  const P = profiles()[appId].ajax
  const pairs = key => P.map(p => ({ rate: p.rpm, value: p[key] }))
  return {
    rpm: round(P.reduce((a, p) => a + windowMean(win, p.rpm), 0), 2),
    avg: round(pooledMean(win, pairs('avg')), 2),
    // Failed calls over all calls, not a mean of the rows' percentages.
    errPct: round(pooledMean(win, pairs('err')), 2),
    pairs,
  }
}

/** Every call the app made, together: calls a minute, call-weighted average and error %. */
export function ajaxSummaryForWindow(win, appId) {
  if (!APPS[appId] || nothingMeasured(win)) return null
  return memo(win, `ajaxs|${appId}`, () => {
    const cur = ajaxSummary(win, appId)
    const prev = ajaxSummary(prevOf(win), appId)
    return {
      rpm: cur.rpm,
      avg: cur.avg,
      errPct: cur.errPct,
      prev: { rpm: prev.rpm, avg: prev.avg, errPct: prev.errPct },
      series: {
        rpm: pooledSeries(win, cur.pairs('rpm'), 2, sumAt),
        avg: pooledSeries(win, cur.pairs('avg'), 2, weightedAt),
        errPct: pooledSeries(win, cur.pairs('err'), 2, weightedAt),
      },
    }
  })
}

/* ---- web vitals ---- */

const VITALS = ['lcp', 'inp', 'cls']
const VITAL_DIGITS = { lcp: 2, inp: 2, cls: 3 }
// A CLS of 0.07 drawn to two decimals is a staircase.
const VITAL_SERIES_DIGITS = { lcp: 2, inp: 2, cls: 4 }

const pageUrl = (app, route) => `${app.origin}${route}`

function ratings(v) {
  const s = Object.fromEntries(VITALS.map(k => [k, statusForWebVital(k, v[k])]))
  return { ...s, worst: worstStatus(s.lcp, s.inp, s.cls) }
}

/**
 * Core Web Vitals per page URL: the window's page-view mean of each, as
 * production reports them (its figures recompute as means, not p75s — so the
 * page must not label them p75). `status` rates each figure through
 * statusForWebVital, plus the worst of the three for the row's one dot. A
 * rating describes the figure beside it, so it is read off the figure rather
 * than the window's worst instant: a vital is graded, not alerted on.
 */
export function webVitalsForWindow(win, appId) {
  const app = APPS[appId]
  if (!app || nothingMeasured(win)) return { rows: [], series: EMPTY_SERIES(VITALS) }
  return memo(win, `vitals|${appId}`, () => {
    const P = profiles()[appId].routes
    const rows = app.routes.map((r, i) => {
      const v = Object.fromEntries(VITALS.map(k => [k, round(windowMean(win, P[i][k]), VITAL_DIGITS[k])]))
      return { endpoint: pageUrl(app, r.route), route: r.route, ...v, status: ratings(v) }
    })
    const seriesOf = key => app.routes.map((r, i) => ({
      endpoint: pageUrl(app, r.route),
      series: windowSeries(win, P[i][key], { round: VITAL_SERIES_DIGITS[key] }),
    }))
    return { rows, series: Object.fromEntries(VITALS.map(k => [k, seriesOf(k)])) }
  })
}

function vitalsSummary(win, appId) {
  const P = profiles()[appId].routes
  const pairs = key => P.map(p => ({ rate: p.rpm, value: p[key] }))
  return { ...Object.fromEntries(VITALS.map(k => [k, round(pooledMean(win, pairs(k)), VITAL_DIGITS[k])])), pairs }
}

/** The app's vitals, every page view weighted alike: the three headline cards. */
export function webVitalsSummaryForWindow(win, appId) {
  if (!APPS[appId] || nothingMeasured(win)) return null
  return memo(win, `vitalss|${appId}`, () => {
    const cur = vitalsSummary(win, appId)
    const prev = vitalsSummary(prevOf(win), appId)
    const v = Object.fromEntries(VITALS.map(k => [k, cur[k]]))
    return {
      ...v,
      prev: Object.fromEntries(VITALS.map(k => [k, prev[k]])),
      status: Object.fromEntries(VITALS.map(k => [k, statusForWebVital(k, v[k])])),
      series: Object.fromEntries(VITALS.map(k => [k, pooledSeries(win, cur.pairs(k), VITAL_SERIES_DIGITS[k], weightedAt)])),
    }
  })
}

/* ---- the apps, by severity ---- */

const RANK = { healthy: 0, warning: 1, critical: 2 }

// Every row's figure through its resolver: ajax error % on the error-rate
// scale, every page's vitals on theirs. Load times and response times are not
// rated — statusForLatency is a server p90 scale, and every page would be red.
function rowStatuses(read) {
  return worstStatus(
    ...read.ajax.map(e => statusForErrorRate(e)),
    ...read.vitals.flatMap(v => VITALS.map(k => statusForWebVital(k, v[k]))),
  )
}

/**
 * The browser apps as the window saw them, worst first.
 *
 * `status` is the worst INSTANT, as a service's is: every call's error rate
 * and every page's vitals at the window's newest moment, through the same
 * resolvers. So the back office is warning on every range that holds the
 * incident — its order lookups failed 1.5% of the time while it ran — and
 * healthy on one that does not. `aggregateStatus` is what the window's own
 * figures resolve to, which for the back office is healthy at any range wider
 * than a few minutes; where the two differ the page has something to say.
 *
 * The storefront is critical either way, and that is production's data, not
 * the incident: its calls fail ~5% of the time all week and its product page
 * takes 4.55 s to paint.
 */
export function browserAppsForWindow(win) {
  return memo(win, 'apps', () => {
    const w = peakIncidentWeight((win.nowSec - win.end) / 60)
    const apps = APP_IDS.map(id => {
      const P = profiles()[id]
      const peak = {
        ajax: P.ajax.map(p => valueAtWeight(p.err, w)),
        vitals: P.routes.map(p => Object.fromEntries(VITALS.map(k => [k, valueAtWeight(p[k], w)]))),
      }
      const figures = {
        ajax: ajaxCallsForWindow(win, id).rows.map(r => r.errPct),
        vitals: webVitalsForWindow(win, id).rows,
      }
      const { id: appId, name, language, origin } = APPS[id]
      return {
        id: appId, name, language, origin,
        status: rowStatuses(peak),
        aggregateStatus: rowStatuses(figures),
        peakErrPct: round(Math.max(...peak.ajax), 2),
      }
    })
    // Array sort is stable, so apps that tie on everything keep catalog order.
    return apps.sort((a, b) => (RANK[b.status] ?? 0) - (RANK[a.status] ?? 0)
      || (RANK[b.aggregateStatus] ?? 0) - (RANK[a.aggregateStatus] ?? 0)
      || b.peakErrPct - a.peakErrPct)
  })
}

/* ---- the error catalog ---- */

// Static: one entry per outcome a sample can have — a route loading cleanly
// or throwing one of its script errors, a call answering 200 or one of its
// failure codes in one regime — in a fixed order. A row's index is part of
// every sample's trace id, so rows are appended, never reordered.
const ROWS = []
const ROW_INDEX = new Map()
// Per app: each route's and each call's rows, for the counting and sampling.
const ROUTE_ROWS = {}
const AJAX_ROWS = {}
// Rows that are another row's errors seen from somewhere else: idx → [idx].
const MIRRORS = []

const rowId = s => [s.app, s.side, s.endpoint, s.exception ?? 'ok', s.regime, s.variant ?? ''].join('|')

function addRow(spec) {
  const id = rowId(spec)
  if (ROW_INDEX.has(id)) return ROW_INDEX.get(id)
  const idx = ROWS.length
  ROWS.push({ ...spec, id, idx })
  ROW_INDEX.set(id, idx)
  return idx
}

for (const id of APP_IDS) {
  const app = APPS[id]
  ROUTE_ROWS[id] = app.routes.map((r, i) => ({
    ok: addRow({ app: id, side: 'server', endpoint: r.route, regime: 'ok', ref: i }),
    errors: app.scriptMix.map(([type, share]) => ({
      idx: addRow({ app: id, side: 'server', endpoint: r.route, exception: type, regime: 'quiet', ref: i }),
      share,
    })),
  }))
  AJAX_ROWS[id] = app.ajax.map((c, i) => {
    const codes = (regime, map) => Object.entries(map ?? {}).map(([code, share]) => ({
      idx: addRow({ app: id, side: 'client', endpoint: c.endpoint, exception: code, code, regime, ref: i }),
      share,
      code,
    }))
    return {
      ok: addRow({ app: id, side: 'client', endpoint: c.endpoint, code: '200', regime: 'ok', ref: i }),
      quiet: codes('quiet', QUIET_CODES),
      incident: codes('incident', c.incident),
    }
  })
  for (const m of app.mirrors) {
    const route = app.routes.findIndex(r => r.route === m.route)
    const call = app.ajax.findIndex(c => c.endpoint === m.from)
    const from = AJAX_ROWS[id][call].incident.filter(x => Number(x.code) >= 500)
    const idx = addRow({ app: id, side: 'server', endpoint: m.route, exception: m.exception, regime: 'incident', variant: m.variant, ref: route, mirrorOf: call })
    MIRRORS.push({ idx, from: from.map(x => x.idx), codes: from.map(x => [x.code, x.share]) })
  }
}

/* ---- counting ---- */

// Integers whose running sum is the rounded running sum of the floats, across
// every part of a source in turn (errors.js carryRound): rounding each bucket
// alone loses a trickle of 0.3-an-hour errors and leaves Σ series ≠ count.
function carryRound(seqs) {
  let acc = 0
  let prev = 0
  return seqs.map(seq => seq.map(v => {
    if (v == null) return null
    acc += v
    const r = Math.round(acc)
    const out = r - prev
    prev = r
    return out
  }))
}

// The minutes of a bucket that have happened: "Today"'s bucket holding now is
// a whole step long with most of it still to come.
const elapsedMin = (win, b) => (b.future ? 0 : Math.min(b.durMin, Math.max(0, win.nowSec - b.t) / 60))

const bucketErrors = (win, rate, err) => win.buckets.map(b => (
  b.future ? null : (sampleAt(rate, b) * sampleAt(err, b) / 100) * elapsedMin(win, b)
))

// The incident's share of an error rate at weight w: the profile is
// baseline·(1 + (peak−1)·w), so the incident is (peak−1)·w of every
// 1 + (peak−1)·w.
const incidentShare = (peak, w) => {
  const x = (peak - 1) * w
  return x > 0 ? x / (1 + x) : 0
}

// The one constant that makes a source's reference hour count exactly the
// table's rpm × err% × 60 (errors.js calibrationOf).
function calibrationOf(src) {
  if (src.k != null) return src.k
  const ref = REFERENCE_WINDOW
  const target = (windowMean(ref, src.rate) * windowMean(ref, src.err) / 100) * ref.pastMinutes
  const counted = sumOf(bucketErrors(ref, src.rate, src.err))
  src.k = counted > 0 ? target / counted : 0
  return src.k
}

// The incident's errors inside one wide bucket, a minute at a time, so the
// week and the hour agree on how many errors the outage threw (errors.js
// incidentErrorsIn).
function incidentErrorsIn(win, b, rate, err, peak) {
  const startSec = b.t
  const endSec = b.t + Math.round(elapsedMin(win, b) * 60)
  const from = Math.max(startSec, win.nowSec - INCIDENT_START_MIN * 60)
  let sum = 0
  for (let t = from - (((from % 60) + 60) % 60); t < endSec; t += 60) {
    const t0 = Math.max(t, startSec)
    const t1 = Math.min(t + 60, endSec)
    if (t1 <= t0) continue
    const slice = { t: t0, ms: t0 * 1000, m: (win.nowSec - t0) / 60, durMin: (t1 - t0) / 60 }
    slice.w = incidentWeightOver(slice.m, slice.durMin)
    const s = incidentShare(peak, slice.w)
    if (s > 0) sum += (sampleAt(rate, slice) * sampleAt(err, slice) / 100) * s * slice.durMin
  }
  return sum
}

// A source is one rounding unit: a route's script errors, or one call's
// failures. Its parts are the rows it splits into — `inc` the row's share of
// the incident's errors, `quiet` its share of everyone else's.
let SOURCES = null
function sources() {
  if (SOURCES) return SOURCES
  SOURCES = []
  for (const id of APP_IDS) {
    const P = profiles()[id]
    ROUTE_ROWS[id].forEach((r, i) => {
      // No incident regime: a page's own script errors do not change with the
      // backend, so they throw the same things during it as outside it.
      SOURCES.push({ rate: P.routes[i].rpm, err: P.routes[i].jsErr, parts: r.errors.map(e => ({ idx: e.idx, inc: e.share, quiet: e.share })) })
    })
    AJAX_ROWS[id].forEach((c, i) => {
      const hasIncident = c.incident.length > 0
      SOURCES.push({
        rate: P.ajax[i].rpm,
        err: P.ajax[i].err,
        parts: [
          ...c.quiet.map(e => ({ idx: e.idx, inc: hasIncident ? 0 : e.share, quiet: e.share })),
          ...c.incident.map(e => ({ idx: e.idx, inc: e.share, quiet: 0 })),
        ],
      })
    })
  }
  return SOURCES
}

function sourceInts(win, src) {
  const peak = src.err.peak ?? 1
  const k = calibrationOf(src)
  const raw = bucketErrors(win, src.rate, src.err)
  const inc = []
  const quiet = []
  win.buckets.forEach((b, i) => {
    if (raw[i] == null) { inc.push(0); quiet.push(0); return }
    const s = incidentShare(peak, b.w ?? incidentWeightOver(b.m, b.durMin))
    quiet.push(raw[i] * (1 - s))
    inc.push(s > 0 && b.durMin > 1 ? incidentErrorsIn(win, b, src.rate, src.err, peak) : raw[i] * s)
  })
  return carryRound(src.parts.map(p => raw.map((v, i) => (v == null ? null : k * (inc[i] * p.inc + quiet[i] * p.quiet)))))
}

function windowInts(win) {
  const ints = new Array(ROWS.length).fill(null)
  for (const src of sources()) {
    const rounded = sourceInts(win, src)
    src.parts.forEach((p, j) => { ints[p.idx] = rounded[j] })
  }
  // A mirror is its source rows added up, bucket for bucket — one checkout
  // TypeError for every create-payment call the pool failed, never more.
  for (const m of MIRRORS) {
    ints[m.idx] = win.buckets.map((b, i) => (b.future ? null : m.from.reduce((a, f) => a + (ints[f][i] ?? 0), 0)))
  }
  return ints
}

/* ---- the JavaScript exceptions ---- */

// V8 keeps ten frames of a stack (Error.stackTraceLimit), so a render error
// shows the component and nine frames of React under it.
const STACK_LIMIT = 10
const REACT_DOM = 'node_modules/react-dom/cjs/react-dom.production.js'
const SCHEDULER = 'node_modules/scheduler/cjs/scheduler.production.js'
const REACT_RENDER = [
  { fn: 'renderWithHooks', file: REACT_DOM, line: 14985, col: 18 },
  { fn: 'updateFunctionComponent', file: REACT_DOM, line: 17356, col: 20 },
  { fn: 'beginWork', file: REACT_DOM, line: 19063, col: 16 },
  { fn: 'performUnitOfWork', file: REACT_DOM, line: 22776, col: 12 },
  { fn: 'workLoopSync', file: REACT_DOM, line: 22707, col: 5 },
  { fn: 'renderRootSync', file: REACT_DOM, line: 22670, col: 7 },
  { fn: 'performConcurrentWorkOnRoot', file: REACT_DOM, line: 21933, col: 20 },
  { fn: 'workLoop', file: SCHEDULER, line: 266, col: 34 },
  { fn: 'flushWork', file: SCHEDULER, line: 239, col: 14 },
  { fn: 'MessagePort.performWorkUntilDeadline', file: SCHEDULER, line: 533, col: 21 },
]

// The formatting helper each RangeError comes out of, and the built-in that
// actually throws it.
const RANGE_ERRORS = {
  currency: { message: 'Invalid currency code : undefined', native: 'new NumberFormat', helper: { fn: 'formatPrice', file: 'src/lib/money.js', line: 12, col: 10 } },
  date: { message: 'Invalid time value', native: 'Date.toISOString', helper: { fn: 'formatDate', file: 'src/lib/dates.js', line: 18, col: 24 } },
  array: { message: 'Invalid array length', native: 'new Array', helper: { fn: 'paginate', file: 'src/lib/paginate.js', line: 9, col: 17 } },
  digits: { message: 'toFixed() digits argument must be between 0 and 100', native: 'Number.toFixed', helper: { fn: 'formatRating', file: 'src/lib/format.js', line: 22, col: 30 } },
  recursion: { message: 'Maximum call stack size exceeded' },
}

// A component's own line, stable per file, so every exception it throws points
// at the same place in it.
const lineIn = (file, salt) => 20 + (hashStr(`${file}:${salt}`) % 200)
const colIn = (file, salt) => 9 + (hashStr(`${salt}:${file}`) % 30)
const componentFrame = ui => ({ fn: ui.component, file: ui.file, line: ui.line ?? lineIn(ui.file, 'render'), col: ui.col ?? colIn(ui.file, 'render') })

// What a script error row throws: its type, message and frames, innermost first.
function jsSpecOf(row) {
  const app = APPS[row.app]
  const ui = app.ui(row.endpoint)
  const type = row.exception
  if (row.variant === 'clientSecret') {
    return {
      type,
      message: "Cannot read properties of undefined (reading 'clientSecret')",
      frames: [
        { fn: 'confirmPayment', file: 'src/checkout/payment.js', line: 57, col: 38 },
        { fn: 'handleSubmit', file: 'src/components/checkout/PaymentStep.jsx', line: 84, col: 7, async: true },
      ],
    }
  }
  if (type === 'TypeError') {
    return {
      type,
      message: `Cannot read properties of ${ui.nullish ? 'null' : 'undefined'} (reading '${ui.prop}')`,
      frames: [componentFrame(ui), ...REACT_RENDER],
    }
  }
  if (type === 'NetworkError') {
    return {
      type,
      message: 'NetworkError when attempting to fetch resource.',
      frames: [
        { fn: 'apiFetch', file: 'src/lib/api.js', line: 41, col: 11 },
        { fn: ui.loader, file: ui.file, line: lineIn(ui.file, 'load'), col: colIn(ui.file, 'load'), async: true },
      ],
    }
  }
  if (type === 'RangeError') {
    const r = RANGE_ERRORS[ui.range]
    if (!r.helper) {
      // A self-recursive helper: V8 keeps the ten innermost of its frames,
      // which are all the same frame.
      const self = { fn: 'flattenSlides', file: ui.file, line: lineIn(ui.file, 'flatten'), col: 12 }
      return { type, message: r.message, frames: Array.from({ length: STACK_LIMIT }, () => self) }
    }
    return { type, message: r.message, frames: [{ fn: r.native, native: true }, r.helper, componentFrame(ui), ...REACT_RENDER] }
  }
  // ChunkLoadError: webpack's runtime gave up fetching the route's chunk.
  const [chunk, hash] = ui.chunk
  return {
    type,
    message: `Loading chunk ${chunk} failed. (error: ${app.origin}/static/js/${chunk}.${hash}.chunk.js)`,
    frames: [
      { fn: '__webpack_require__.f.j', file: 'webpack/runtime/jsonp chunk loading', line: 27, col: 18 },
      { fn: 'Array.reduce', native: true },
      { fn: '__webpack_require__.e', file: 'webpack/runtime/ensure chunk', line: 6, col: 25 },
      { fn: 'lazyRoute', file: 'src/routes/lazyRoute.js', line: 8, col: 14 },
      ...REACT_RENDER,
    ],
  }
}

const MIN_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
// A minifier's name for a function: one or two letters, stable per function.
function mangle(fn) {
  const h = hashStr(fn)
  const a = MIN_ALPHABET[h % MIN_ALPHABET.length]
  return (h >>> 8) % 3 === 0 ? a : a + MIN_ALPHABET[(h >>> 16) % MIN_ALPHABET.length]
}

const frameLine = (f, fn, loc) => `    at ${f.async ? 'async ' : ''}${fn} (${loc})`

// Source-mapped: the names and files the developer wrote.
function unminifiedLine(f) {
  if (f.native) return `    at ${f.fn} (<anonymous>)`
  return frameLine(f, f.fn, `${f.file}:${f.line}:${f.col}`)
}

// As the browser reported it: a mangled name in a hashed bundle at
// line:column. The app's own code is in the main bundle, packages in the
// vendor one; a built-in keeps its name, and a method keeps its receiver.
function minifiedLine(f, app) {
  if (f.native) return `    at ${f.fn} (<anonymous>)`
  const dot = f.fn.lastIndexOf('.')
  const receiver = dot > 0 && /^[A-Z]/.test(f.fn) ? f.fn.slice(0, dot + 1) : ''
  const lib = f.file.startsWith('node_modules/')
  const bundle = lib ? app.vendor : app.bundle
  const col = 1000 + (hashStr(`${f.file}:${f.line}:${f.col}`) % 300000)
  return frameLine(f, `${receiver}${mangle(f.fn)}`, `${bundle}:${lib ? 1 : 2}:${col}`)
}

const JS_MEMO = new Map()
function jsExceptionOf(row) {
  if (JS_MEMO.has(row.idx)) return JS_MEMO.get(row.idx)
  const app = APPS[row.app]
  const spec = jsSpecOf(row)
  const frames = spec.frames.slice(0, STACK_LIMIT)
  const head = `${spec.type}: ${spec.message}`
  const out = {
    type: spec.type,
    message: spec.message,
    stack: [head, ...frames.map(f => minifiedLine(f, app))].join('\n'),
    unminified: [head, ...frames.map(unminifiedLine)].join('\n'),
    // The file the top frame points into: what a source map has to be
    // uploaded for before the un-minified stack can be read.
    bundle: app.bundle,
  }
  JS_MEMO.set(row.idx, out)
  return out
}

const messageOf = row => (row.side === 'client' ? REASONS[row.code] ?? '' : jsExceptionOf(row).message)

/* ---- error series and groups ---- */

/**
 * Every error series the window holds for one app and kind — 'server' for
 * script errors, 'client' for ajax — `count > 0` only, in the errors.js
 * ErrorSeriesRow shape. One row per outcome and regime: a payment call's 500s
 * while the pool was out and its 500s the rest of the week are two rows that
 * group into one, which is what lets a sample of the first be placed inside
 * the incident.
 */
export function browserErrorSeriesForWindow(win, appId, kind = 'server') {
  return seriesState(win).rows[`${appId}|${kind}`] ?? []
}

function seriesState(win) {
  return memo(win, 'series', () => {
    const cur = windowInts(win)
    const prev = windowInts(prevOf(win))
    const rows = {}
    const byId = new Map()
    for (const spec of ROWS) {
      if (spec.regime === 'ok') continue
      const seq = cur[spec.idx]
      const count = sumOf(seq)
      if (!(count > 0)) continue
      const row = {
        id: spec.id,
        side: spec.side,
        service: spec.app,
        endpoint: spec.endpoint,
        spanName: spec.endpoint,
        category: spec.side === 'client' ? 'ajax' : 'script',
        exception: spec.exception,
        exceptionShort: spec.exception,
        message: messageOf(spec),
        httpCode: spec.code ?? '',
        count,
        prevCount: sumOf(prev[spec.idx]),
        series: win.buckets.map((b, i) => ({ ...axis(b), value: seq[i] })),
      }
      const key = `${spec.app}|${spec.side}`
      ;(rows[key] ??= []).push(row)
      byId.set(row.id, { row, idx: spec.idx, incident: spec.regime === 'incident' })
    }
    return { rows, byId }
  })
}

// When a group's oldest errors were thrown, to the bucket — and inside it when
// every error the group has there is the incident's, which cannot be older
// than the incident. groupErrorSeries reads errors.js's own memo for this and
// falls back to the bucket's opening edge for rows it did not build.
function firstSeen(g, win, state) {
  const i = g.series.findIndex(p => p.value > 0)
  if (i < 0) return null
  const b = win.buckets[i]
  const incidentStartMs = (win.nowSec - INCIDENT_START_MIN * 60) * 1000
  if (incidentStartMs <= b.ms) return b.ms
  const allIncident = g.seriesIds.every(id => {
    const e = state.byId.get(id)
    return e && (!(e.row.series[i].value > 0) || e.incident)
  })
  return allIncident ? incidentStartMs : b.ms
}

/**
 * The Errors tab's rows for one app: 'server' (Script) — a page route and the
 * JavaScript exception class it threw — or 'client' (Ajax) — a call and the
 * HTTP status it got back, as a string, with its reason phrase as the
 * message. errors.js's ErrorGroup shape and grouping (keyed on the exception,
 * as production's `error=` is), biggest first, with counts against the window
 * before for the delta chip.
 */
export function browserErrorGroupsForWindow(win, appId, kind = 'server') {
  return memo(win, `groups|${appId}|${kind}`, () => {
    const state = seriesState(win)
    return groupErrorSeries(state.rows[`${appId}|${kind}`] ?? [], win)
      .map(g => ({ ...g, firstSeenMs: firstSeen(g, win, state) }))
  })
}

/** The Traces tab's Endpoint options: the app's routes (Script) or its calls (Ajax), in catalog order. */
export function browserEndpointOptions(appId, kind = 'server') {
  const app = APPS[appId]
  if (!app) return []
  return kind === 'client' ? app.ajax.map(c => c.endpoint) : app.routes.map(r => r.route)
}

/**
 * The Error filter's options: the errors the window actually holds for that
 * kind (and endpoint, when one is picked), most frequent first — never one
 * that would answer "No results".
 */
export function browserErrorOptions(win, appId, kind = 'server', endpoint = null) {
  const tally = new Map()
  for (const g of browserErrorGroupsForWindow(win, appId, kind)) {
    if (endpoint && g.endpoint !== endpoint) continue
    tally.set(g.exception, (tally.get(g.exception) ?? 0) + g.count)
  }
  return [...tally].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([e]) => e)
}

/* ---- trace ids ---- */

// 32 hex digits: a checksum, then (ms before BASE_TIME · row index) masked by
// it — errors.js's scheme under salts of this module's own, so neither ever
// decodes the other's ids, nor a seeded trace's.
const OFFSET_HEX = 10
const ROW_HEX = 3
const CHECK_HEX = 32 - OFFSET_HEX - ROW_HEX
const CHECK_SALTS = ['b1', 'b2', 'b3']
const MASK_SALTS = ['bm1', 'bm2']

const digest = (s, salts, len) => salts.map(k => hex(hashStr(`${k}:${s}`), 8)).join('').slice(0, len)
const xorHex = (a, b) => Array.from(a, (c, i) => (parseInt(c, 16) ^ parseInt(b[i], 16)).toString(16)).join('')

function encodeTraceId(idx, offsetMs) {
  const payload = hex(offsetMs, OFFSET_HEX) + hex(idx, ROW_HEX)
  const check = digest(payload, CHECK_SALTS, CHECK_HEX)
  return check + xorHex(payload, digest(check, MASK_SALTS, payload.length))
}

function decodeTraceId(id) {
  if (typeof id !== 'string' || !/^[0-9a-f]{32}$/.test(id)) return null
  const check = id.slice(0, CHECK_HEX)
  const payload = xorHex(id.slice(CHECK_HEX), digest(check, MASK_SALTS, 32 - CHECK_HEX))
  if (digest(payload, CHECK_SALTS, CHECK_HEX) !== check) return null
  const offset = parseInt(payload.slice(0, OFFSET_HEX), 16)
  const idx = parseInt(payload.slice(OFFSET_HEX), 16)
  if (!(idx < ROWS.length)) return null
  return { idx, tMs: BASE_MS - offset, traceId: id }
}

// The id is worked out when something first reads it.
function refOf(idx, tMs) {
  let id = null
  return { idx, tMs, get traceId() { return (id ??= encodeTraceId(idx, BASE_MS - tMs)) } }
}

// Newest first, one trace per row and millisecond, nothing past BASE_TIME.
function toRefs(units) {
  const seen = new Set()
  const out = []
  for (const u of [...units].sort((a, b) => b.tMs - a.tMs || a.idx - b.idx)) {
    let t = u.tMs
    while (seen.has(`${u.idx}:${t}`)) t -= 1
    seen.add(`${u.idx}:${t}`)
    if (BASE_MS - t < 0) continue
    out.push(refOf(u.idx, t))
  }
  return out
}

/* ---- samples ---- */

// The most a list asks for (the N-results select tops out at 100). Each list
// is an even pick from this many, newest first, so the first row of ten is
// the first row of a hundred and the Errors tab's sample is the Traces tab's
// first row for the same filter (except for a group that holds two messages;
// see browserGroupSampleTrace).
const POOL_N = 100
// A sample's spans run a few ms past its start; placed this far short of its
// bucket's end, the trace stays in the bucket.
const SPAN_LEAD_MS = 50

/**
 * `n` errors picked out of rows' series, stratified (errors.js unitsFor): the
 * k-th lands in the k-th n-th of the errors in time order, so samples span the
 * window the way the errors do, an incident row's samples sit inside the
 * incident's stretch of their bucket, and the last pick is the newest error.
 */
function unitsFor(entries, win, n, seed) {
  const total = entries.reduce((a, e) => a + e.row.count, 0)
  const m = Math.min(n, total)
  if (!(m > 0)) return []
  const endMs = Math.min(win.end, win.nowSec) * 1000
  const incidentStartMs = (win.nowSec - INCIDENT_START_MIN * 60) * 1000
  const perBucket = win.buckets.map((_, i) => entries.reduce((a, e) => a + (e.row.series[i].value ?? 0), 0))
  const units = []
  let i = 0
  let cum = 0
  for (let k = 0; k < m; k++) {
    const newest = k === m - 1 && total > m
    const u = newest ? total - 0.5 : ((k + 0.15 + 0.7 * noiseAt(seed, win.start + k)) / m) * total
    while (i < perBucket.length - 1 && cum + perBucket[i] <= u) { cum += perBucket[i]; i++ }
    let r = u - cum
    let pick = null
    for (const e of entries) {
      const v = e.row.series[i].value ?? 0
      if (v > 0) pick = e
      if (r < v) break
      r -= v
    }
    if (!pick) continue
    const b = win.buckets[i]
    const hi = Math.min(b.ms + b.durMin * 60000, endMs)
    const lo = pick.incident && incidentStartMs < hi ? Math.max(b.ms, incidentStartMs) : b.ms
    const span = Math.max(0, hi - lo - SPAN_LEAD_MS)
    const draw = noiseAt(seed + 2, win.start + k)
    const off = newest ? span - draw * Math.min(span, (hi - lo) / Math.max(1, perBucket[i])) : draw * span
    units.push({ idx: pick.idx, tMs: Math.floor(lo + off) })
  }
  return units
}

// An instant, in the shape sampleAt reads, measured from the window's own now.
function instant(nowSec, tMs) {
  const t = Math.floor(tMs / 1000)
  const m = (nowSec - t) / 60
  return { t, ms: tMs, m, durMin: 0, w: incidentWeight(m) }
}

// What each outcome of one route or call was running at, per minute, at an
// instant: the clean ones and every error row, in the counts' own split.
function outcomesAt(appId, kind, i, at) {
  const P = profiles()[appId]
  if (kind === 'client') {
    const p = P.ajax[i]
    const rows = AJAX_ROWS[appId][i]
    const rate = Math.max(0, sampleAt(p.rpm, at))
    const failing = rate * sampleAt(p.err, at) / 100
    const s = rows.incident.length ? incidentShare(p.err.peak ?? 1, at.w) : 0
    return [
      { idx: rows.ok, rate: Math.max(0, rate - failing) },
      ...rows.quiet.map(e => ({ idx: e.idx, rate: failing * (1 - s) * e.share })),
      ...rows.incident.map(e => ({ idx: e.idx, rate: failing * s * e.share })),
    ]
  }
  const p = P.routes[i]
  const rows = ROUTE_ROWS[appId][i]
  const rate = Math.max(0, sampleAt(p.rpm, at))
  const failing = rate * sampleAt(p.jsErr, at) / 100
  const mirrored = MIRRORS.filter(m => ROWS[m.idx].app === appId && ROWS[m.idx].ref === i).map(m => {
    const call = ROWS[m.from[0]].ref
    const c = P.ajax[call]
    const s = incidentShare(c.err.peak ?? 1, at.w)
    const share = m.codes.reduce((a, [, sh]) => a + sh, 0)
    return { idx: m.idx, rate: Math.max(0, sampleAt(c.rpm, at)) * sampleAt(c.err, at) / 100 * s * share }
  })
  const scripted = failing + mirrored.reduce((a, x) => a + x.rate, 0)
  return [
    { idx: rows.ok, rate: Math.max(0, rate - scripted) },
    ...rows.errors.map(e => ({ idx: e.idx, rate: failing * e.share })),
    ...mirrored,
  ]
}

// spreadTimes with a seed of this module's own: the explorer's seed would put
// the browser's samples on the very instants its traces sit on.
function spreadTimes(win, n) {
  if (n <= 0) return []
  const startMs = win.start * 1000
  const spanMs = Math.max(0, Math.min(win.end, win.nowSec) * 1000 - startMs)
  const gap = spanMs / n
  return Array.from({ length: n }, (_, i) => {
    const slot = n - 1 - i
    const jitter = noiseAt(5903, win.start + slot) * gap * 0.8
    return startMs + slot * gap + jitter
  })
}

// Requests of any outcome, spread across the window: which route or call by
// its traffic at that instant, then clean or failing by its error rate there,
// so an unfiltered list is mostly clean requests and an incident code only
// ever turns up while the incident ran.
function spreadUnits(win, appId, kind, endpoint) {
  const app = APPS[appId]
  const list = kind === 'client' ? app.ajax.map(c => c.endpoint) : app.routes.map(r => r.route)
  const cands = list.map((e, i) => i).filter(i => !endpoint || list[i] === endpoint)
  if (!cands.length) return []
  const P = profiles()[appId]
  const seed = hashStr(`spread|${appId}|${kind}|${endpoint ?? '*'}`)
  return spreadTimes(win, POOL_N).map((tMs, k) => {
    const at = instant(win.nowSec, tMs)
    const rates = cands.map(i => Math.max(0, sampleAt((kind === 'client' ? P.ajax[i] : P.routes[i]).rpm, at)))
    const i = cands[pickWeighted(rates, noiseAt(seed, win.start + k))]
    const outcomes = outcomesAt(appId, kind, i, at)
    const o = outcomes[pickWeighted(outcomes.map(x => x.rate), noiseAt(seed + 1, win.start + k))]
    return { idx: o.idx, tMs: Math.floor(tMs) }
  })
}

function refPool(win, appId, kind, endpoint, error) {
  return memo(win, `pool|${appId}|${kind}|${endpoint ?? ''}|${error ?? ''}`, () => {
    if (!error) return toRefs(spreadUnits(win, appId, kind, endpoint))
    const state = seriesState(win)
    const entries = (state.rows[`${appId}|${kind}`] ?? [])
      .filter(r => r.exception === error && (!endpoint || r.endpoint === endpoint))
      .map(r => state.byId.get(r.id))
    return toRefs(unitsFor(entries, win, POOL_N, hashStr(`errors|${appId}|${kind}|${endpoint ?? '*'}|${error}`)))
  })
}

// `n` of a pool, evenly through it: the newest, the oldest and the rest
// between, so ten span the window the way a hundred do.
function pickEvenly(all, n) {
  if (all.length <= n) return all
  if (n <= 1) return all.slice(0, Math.max(0, n))
  return Array.from({ length: n }, (_, k) => all[Math.round((k * (all.length - 1)) / (n - 1))])
}

/* ---- one sample ---- */

// Who was on the other end. The storefront's shoppers are mostly on phones;
// the back office's staff are on their desks.
const CLIENTS = {
  consumer: [
    { share: 0.34, browser: 'Chrome', version: '129.0.6668.89', os: 'Windows', device: 'desktop', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36' },
    { share: 0.2, browser: 'Chrome', version: '129.0.6668.81', os: 'Android', device: 'mobile', ua: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36' },
    { share: 0.18, browser: 'Safari', version: '17.6', os: 'iOS', device: 'mobile', ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1' },
    { share: 0.1, browser: 'Safari', version: '17.6', os: 'macOS', device: 'desktop', ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15' },
    { share: 0.08, browser: 'Edge', version: '129.0.2792.65', os: 'Windows', device: 'desktop', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0' },
    { share: 0.06, browser: 'Firefox', version: '131.0', os: 'Windows', device: 'desktop', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0' },
    { share: 0.04, browser: 'Safari', version: '17.6', os: 'iPadOS', device: 'tablet', ua: 'Mozilla/5.0 (iPad; CPU OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1' },
  ],
  staff: [
    { share: 0.55, browser: 'Chrome', version: '129.0.6668.89', os: 'Windows', device: 'desktop', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36' },
    { share: 0.25, browser: 'Chrome', version: '129.0.6668.89', os: 'macOS', device: 'desktop', ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36' },
    { share: 0.2, browser: 'Edge', version: '129.0.2792.65', os: 'Windows', device: 'desktop', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0' },
  ],
}

// The resource block makeSpan stamps is a JVM's. A browser span keeps the SDK
// lines that are true of it and blanks the rest — blank, because traceDetail
// drops '' values, so no `process.executable.name: java` on a page load.
const BROWSER_RESOURCE = {
  '_resource.container.id': '',
  '_resource.host.arch': '',
  '_resource.os.description': '',
  '_resource.os.type': '',
  '_resource.process.command_line': '',
  '_resource.process.executable.name': '',
  '_resource.process.executable.path': '',
  '_resource.process.pid': '',
  '_resource.process.runtime.description': '',
  '_resource.process.runtime.name': '',
  '_resource.process.runtime.version': '',
  '_resource.telemetry.auto.version': '',
  '_resource.telemetry.sdk.language': 'webjs',
  '_resource.telemetry.sdk.name': 'opentelemetry',
  '_resource.telemetry.sdk.version': '1.26.0',
}

// The hosts each backend's spans already name elsewhere, so a host in a
// browser trace is one the Infra page has. payment-service runs on the JVMs
// the Runtime tab tracks, and a request only lands on one that was up.
const BACKEND_HOSTS = {
  'order-service': ['ip-10-0-143-40'],
  'shipment-service': ['ip-10-0-143-40'],
  'search-service': ['ip-10-0-144-12'],
  'notify-service': ['ip-10-0-130-150'],
  'analytics-service': ['ip-10-0-129-151'],
}
const PAYMENT_HOSTS = RUNTIME_HOSTS.map(h => ({ id: h.id, load: h.load, lives: livesOf(h, BASE_SEC) }))

function backendHost(service, tMs, u) {
  const fixed = BACKEND_HOSTS[service]
  if (fixed) return fixed[Math.floor(u * fixed.length) % fixed.length]
  const t = tMs / 1000
  const up = PAYMENT_HOSTS.filter(h => h.lives.some(l => l.from <= t && (t < l.to || l.running)))
  const pool = up.length ? up : PAYMENT_HOSTS
  return pool[pickWeighted(pool.map(h => h.load), u)].id
}

const JVM_TAIL = [
  'com.cubedemo.service.RequestHandler.handle(RequestHandler.java:57)',
  'com.cubedemo.server.HttpServer.dispatch(HttpServer.java:203)',
  'java.base/java.lang.Thread.run(Thread.java:840)',
]
const jvmStack = (type, message, frames, cause) => [
  `${type}: ${message}`,
  ...[...frames, ...JVM_TAIL].map(f => `\tat ${f}`),
  ...(cause ? [`Caused by: ${cause[0]}`, ...cause.slice(1).map(f => `\tat ${f}`), `\t... ${frames.length + JVM_TAIL.length} more`] : []),
].join('\n')

// What a backend answering 5xx recorded, by service and regime — the same
// failures errors.js counts for those services, in brief.
function backendException(service, incident) {
  const pkg = service.replace(/-service$/, '')
  if (service === 'payment-service' && incident) {
    return {
      type: 'redis.clients.jedis.exceptions.JedisPoolException',
      message: 'Could not get a resource from the pool',
      stacktrace: jvmStack('redis.clients.jedis.exceptions.JedisPoolException', 'Could not get a resource from the pool', [
        'redis.clients.jedis.util.Pool.getResource(Pool.java:84)',
        'redis.clients.jedis.JedisPool.getResource(JedisPool.java:370)',
        'com.cubedemo.payment.cache.SessionCache.get(SessionCache.java:41)',
      ], [
        'java.util.NoSuchElementException: Timeout waiting for idle object',
        'org.apache.commons.pool2.impl.GenericObjectPool.borrowObject(GenericObjectPool.java:298)',
      ]),
    }
  }
  if (incident) {
    return {
      type: 'java.lang.RuntimeException',
      message: 'Downstream call failed',
      stacktrace: jvmStack('java.lang.RuntimeException', 'Downstream call failed', [
        `com.cubedemo.${pkg}.client.PaymentClient.charge(PaymentClient.java:64)`,
      ], [
        'org.springframework.web.client.HttpServerErrorException$InternalServerError: 500 Internal Server Error',
        'org.springframework.web.client.RestTemplate.handleResponse(RestTemplate.java:819)',
      ]),
    }
  }
  if (service === 'order-service') {
    return {
      type: 'java.sql.SQLTransientConnectionException',
      message: 'HikariPool-1 - Connection is not available',
      stacktrace: jvmStack('java.sql.SQLTransientConnectionException', 'HikariPool-1 - Connection is not available', [
        'com.zaxxer.hikari.pool.HikariPool.getConnection(HikariPool.java:181)',
        'com.cubedemo.order.OrderRepository.findById(OrderRepository.java:88)',
      ]),
    }
  }
  if (service === 'analytics-service') {
    return {
      type: 'psycopg2.OperationalError',
      message: 'server closed the connection unexpectedly',
      stacktrace: [
        'Traceback (most recent call last):',
        '  File "/app/analytics/reports.py", line 64, in sales_report',
        '    rows = cursor.execute(SALES_SQL, params)',
        'psycopg2.OperationalError: server closed the connection unexpectedly',
      ].join('\n'),
    }
  }
  if (service === 'notify-service') {
    return {
      type: 'Error',
      message: 'connect ECONNREFUSED 10.0.130.150:6379',
      stacktrace: [
        'Error: connect ECONNREFUSED 10.0.130.150:6379',
        '    at TCPConnectWrap.afterConnectMultiple [as oncomplete] (node:net:1607:16)',
      ].join('\n'),
    }
  }
  return {
    type: 'java.lang.RuntimeException',
    message: 'Failed connecting to database',
    stacktrace: jvmStack('java.lang.RuntimeException', 'Failed connecting to database', [
      'com.cubedemo.db.ConnectionPool.acquire(ConnectionPool.java:84)',
      `com.cubedemo.service.Repository.findById(Repository.java:112)`,
    ]),
  }
}

// makeSpan records an exception on any ERROR span that is not internal, and
// defaults to a Java one. A failed fetch is an error with no exception, so it
// passes blanks, which buildTrace reads as no exception and drops from tags.
const NO_EXCEPTION = { type: '', message: '', stacktrace: '' }

// Concrete values for a route's parameters, one set per sample, so the page
// URL and the call it made name the same order.
function paramsFor(rnd) {
  return {
    sku: `SKU-${10000 + Math.floor(rnd() * 90000)}`,
    userId: `usr_${hexOf(rnd, 6)}`,
    orderId: `ord_${hexOf(rnd, 8)}`,
    trackingId: `1Z${hexOf(rnd, 16).toUpperCase()}`,
    paymentId: `pay_${hexOf(rnd, 12)}`,
    customerId: `cus_${hexOf(rnd, 8)}`,
  }
}
const fill = (path, params) => path.replace(/:([A-Za-z]+)/g, (_, k) => params[k] ?? `:${k}`)

/**
 * Everything about one sample that is not its outcome, hashed off its id with
 * one fixed salt per fact, so adding a draw never moves another: how long it
 * took (the profile's value at that instant, spread), who loaded it, which
 * session, which order. The list, the spans and the error modal all read this.
 */
function factsOf(ref) {
  const row = ROWS[ref.idx]
  const app = APPS[row.app]
  const P = profiles()[row.app]
  const seed = hashStr(ref.traceId)
  const draw = salt => noiseAt(seed, salt)
  const at = instant(BASE_SEC, ref.tMs)
  const clients = CLIENTS[app.clients]
  const client = clients[pickWeighted(clients.map(c => c.share), draw(2))]
  const params = paramsFor(rndFrom(seed ^ 0x7a3d))
  const session = hexOf(rndFrom(seed ^ 0x5e55), 32)

  // One call: how long the browser waited, and the backend's share of it.
  const callFacts = (ci, code, salt) => {
    const c = app.ajax[ci]
    const { method, host, path } = parseCall(c.endpoint)
    const fast = Number(code) >= 400 && Number(code) < 500 ? 0.75 : 1
    const ms = Math.max(20, Math.round(sampleAt(P.ajax[ci].avg, at) * between([0.6, 1.5], draw(salt)) * fast))
    const svcAvg = sampleAt(serviceProfile(c.calls.service).avg, at)
    const backendMs = Math.max(1, Math.min(ms - 6, Math.round(svcAvg * between([0.5, 1.6], draw(salt + 1)) * fast)))
    const offset = Math.max(1, Math.floor((ms - backendMs) * (0.3 + 0.4 * draw(salt + 2))))
    return {
      call: c, method, host, path, code, ms, backendMs, offset,
      url: `https://${host}${fill(path, params)}`,
      backendHost: backendHost(c.calls.service, ref.tMs, draw(salt + 3)),
    }
  }

  const base = {
    row, app, seed, client, session, params,
    pageUrl: pageUrl(app, fill(row.side === 'client' ? app.ajax[row.ref].page : row.endpoint, params)),
  }
  if (row.side === 'client') {
    const call = callFacts(row.ref, row.code, 6)
    return { ...base, call, totalMs: call.ms }
  }
  const load = Math.max(120, Math.round(sampleAt(P.routes[row.ref].avg, at) * between([0.55, 1.6], draw(1))))
  const mirror = MIRRORS.find(m => m.idx === row.idx)
  if (!mirror) return { ...base, loadMs: load, totalMs: load }
  // The Pay click: the page had loaded, the create-payment call failed, and
  // reading its result threw.
  const code = mirror.codes[pickWeighted(mirror.codes.map(([, s]) => s), draw(5))][0]
  const call = callFacts(ROWS[mirror.from[0]].ref, code, 6)
  const gap = 400 + Math.floor(draw(10) * 4000)
  return { ...base, loadMs: load, call, callAt: load + gap, totalMs: load + gap + call.ms + 2 }
}

const isFailure = row => row.regime !== 'ok'

function browserTags(f) {
  return {
    ...BROWSER_RESOURCE,
    'service.version': f.app.release,
    'app.release': f.app.release,
    'browser.name': f.client.browser,
    'browser.version': f.client.version,
    'os.name': f.client.os,
    'device.type': f.client.device,
    'user_agent.original': f.client.ua,
    'session.id': f.session,
    'page.url': f.pageUrl,
  }
}

/**
 * The span rows of the trace a browser sample's id stands for — the same rows
 * every time, from the id alone — or null for an id this module did not mint,
 * which leaves it to buildTrace's other lookups.
 *
 * A page load is one 'server' span named by its route, as production draws
 * it; a script error is recorded on it. A call is a 'client' span named
 * `METHOD host:port/path` with its status code, and — the call landing on one
 * of our services — the backend's own server span under it, failing with the
 * service's own exception when it answered 5xx. The checkout's clientSecret
 * TypeError carries the failed create-payment call (and payment-service's
 * pool exception under that) that caused it. Row ids are explicit, so
 * decoding never moves the span stream's counter.
 */
export function browserTraceRows(traceId) {
  const ref = decodeTraceId(traceId)
  if (!ref) return null
  const f = factsOf(ref)
  const { row, app } = f
  const idRnd = rndFrom(f.seed ^ 0x2c1b3c6d)
  const tagRnd = rndFrom(f.seed ^ 0x51ed27)
  const newSpanId = () => hexOf(idRnd, 16)
  const rows = []
  let seq = 0
  const nextId = () => `brw_${traceId}_${seq++}`
  const at = offMs => new Date(ref.tMs + offMs)
  const tags = browserTags(f)

  // A call and, behind it, the backend that answered it.
  const callSpans = (call, startMs, parentId, rootName) => {
    const code = Number(call.code)
    const callId = newSpanId()
    rows.push(makeSpan({
      id: nextId(), time: at(startMs), service: app.id, spanName: call.call.endpoint, spanKind: 'client',
      durationNs: call.ms * 1e6, statusCode: code >= 400 ? 'ERROR' : 'UNSET',
      traceId, spanId: callId, parentId, rootName, host: '', exception: NO_EXCEPTION,
      extra: {
        ...tags,
        category: 'http',
        'http.method': call.method,
        'http.url': call.url,
        'http.status_code': String(call.code),
        'net.peer.name': call.host,
        'net.peer.port': '443',
        'otel.library.name': '@opentelemetry/instrumentation-fetch',
        'otel.library.version': '0.53.0',
        'rum.kind': 'ajax',
      },
    }))
    const failed = code >= 500
    const incident = failed && (row.regime === 'incident' || row.variant === 'clientSecret')
    const [method, route] = splitEndpoint(call.call.calls.endpoint)
    rows.push(makeSpan({
      id: nextId(), time: at(startMs + call.offset), service: call.call.calls.service, spanName: call.call.calls.endpoint, spanKind: 'server',
      durationNs: call.backendMs * 1e6, statusCode: failed ? 'ERROR' : 'UNSET',
      traceId, spanId: newSpanId(), parentId: callId, rootName, host: call.backendHost,
      exception: failed ? backendException(call.call.calls.service, incident) : NO_EXCEPTION,
      extra: {
        ...httpServerTags(tagRnd, { method, route, status: call.code, host: call.backendHost }),
        'http.user_agent': f.client.ua,
        num_events: failed ? '1' : '0',
      },
    }))
  }

  if (row.side === 'client') {
    callSpans(f.call, 0, '', row.endpoint)
    return rows
  }

  const failed = isFailure(row)
  const js = failed ? jsExceptionOf(row) : null
  const rootId = newSpanId()
  rows.push(makeSpan({
    id: nextId(), time: at(0), service: app.id, spanName: row.endpoint, spanKind: 'server',
    durationNs: f.totalMs * 1e6, statusCode: failed ? 'ERROR' : 'UNSET',
    traceId, spanId: rootId, parentId: '', rootName: row.endpoint, host: '',
    exception: js ? { type: js.type, message: js.message, stacktrace: js.stack } : NO_EXCEPTION,
    extra: {
      ...tags,
      category: 'http',
      'http.route': row.endpoint,
      'http.url': f.pageUrl,
      'otel.library.name': '@opentelemetry/instrumentation-document-load',
      'otel.library.version': '0.40.0',
      'rum.kind': 'page_load',
      ...(js ? { 'exception.stacktrace.unminified': js.unminified, num_events: '1' } : { num_events: '0' }),
    },
  }))
  if (f.call) callSpans(f.call, f.callAt, rootId, row.endpoint)
  return rows
}

/**
 * The JavaScript exception a script-error sample threw, for the error modal:
 * its class and message, the stack as the browser reported it (`stack`,
 * minified bundle frames), the same stack source-mapped (`unminified` — only
 * readable once a source map for `bundle` is uploaded), the app whose bundle
 * it is (`appId`), and the attributes the RUM agent recorded with it. Null for
 * any other id, including a call's — a failed fetch is a status code, not an
 * exception.
 */
export function browserExceptionFor(traceId) {
  const ref = decodeTraceId(traceId)
  if (!ref) return null
  const row = ROWS[ref.idx]
  if (row.side !== 'server' || !isFailure(row)) return null
  const js = jsExceptionOf(row)
  const f = factsOf(ref)
  return {
    type: js.type,
    message: js.message,
    stack: js.stack,
    unminified: js.unminified,
    bundle: js.bundle,
    // Whose bundle it is: a source map is uploaded for one app's file, so the
    // gate on the un-minified stack asks for this app's map of this bundle.
    appId: row.app,
    // The span event's own tags first, in the order production's Attributes
    // tab lists them — the event, then the exception as the agent recorded
    // it, the stack as sent (minified) included — then what the RUM agent
    // knew about the page and the browser.
    attributes: {
      event: 'exception',
      'exception.type': js.type,
      'exception.message': js.message,
      'exception.stacktrace': js.stack,
      'page.url': f.pageUrl,
      'browser.name': f.client.browser,
      'browser.version': f.client.version,
      'os.name': f.client.os,
      'device.type': f.client.device,
      'session.id': f.session,
      'app.release': f.app.release,
    },
  }
}

function listRow(ref) {
  const f = factsOf(ref)
  const row = f.row
  const failed = isFailure(row)
  return {
    traceId: ref.traceId,
    endpoint: row.endpoint,
    method: row.side === 'client' ? f.call.method : null,
    latencyMs: f.totalMs,
    timeMs: ref.tMs,
    timestamp: formatLocal(ref.tMs, 'MMM DD, HH:mm'),
    status: failed ? 'error' : 'ok',
    httpStatus: row.side === 'client' ? String(row.code) : null,
    exception: row.side === 'server' && failed ? row.exception : null,
  }
}

/**
 * The Traces tab's list: up to `limit` sampled requests of one kind — page
 * loads ('server', Script) or calls ('client', Ajax) — newest first.
 *
 * With an `error`, every sample is one of that error's occurrences, picked out
 * of the error's own counts, so samples fall where the errors are: a 503 the
 * pool threw never predates the pool failing. Without one, requests of any
 * outcome spread across the window, clean or failing by the error rate at
 * their instant. Same arguments, same rows.
 *
 * Spread, not the newest `limit`, which is what production lists: at hundreds
 * of requests a minute its latest ten are seconds apart whatever range is
 * picked, while these let the range shape the list (docs/decisions/
 * browser-page.md). The first row is still the window's newest.
 */
export function browserTracesForWindow(win, appId, { kind = 'server', endpoint = null, error = null, limit = 10 } = {}) {
  if (!APPS[appId]) return []
  return memo(win, `traces|${appId}|${kind}|${endpoint ?? ''}|${error ?? ''}|${limit}`, () => (
    pickEvenly(refPool(win, appId, kind, endpoint || null, error || null), limit).map(listRow)
  ))
}

/**
 * The newest occurrence of an Errors-tab group that says what the row says, as
 * a trace id — the sample its exception button opens. Null when the group has
 * none in the window.
 *
 * For a group whose series all carry one message, which is nearly every
 * group, that is simply the group's newest error: the first row the Traces tab
 * lists for the same kind, endpoint and error. /checkout's TypeError is the
 * exception. A group is keyed on the exception class, as production's `error=`
 * is, so it holds both the page's own 'shippingAddress' slip and, while the
 * pool is out, the 'clientSecret' one each failed payment call throws. The row
 * reads the bigger series' message (groupErrorSeries), and from two hours up
 * that is the quiet one. But the newest error of the two is nearly always the
 * incident's, so a sample taken from the whole group would open a stack for a
 * message the row never showed. The sample is therefore drawn only from the
 * series that carry the row's message, in the same way as the Traces tab's
 * pool, so it is still that message's newest error. The Traces tab, filtered
 * by class, keeps listing both.
 */
export function browserGroupSampleTrace(win, appId, group) {
  if (!group) return null
  const state = seriesState(win)
  const rows = (state.rows[`${appId}|${group.side}`] ?? [])
    .filter(r => r.exception === group.exception && r.endpoint === group.endpoint)
  const saying = group.message == null ? rows : rows.filter(r => r.message === group.message)
  // A message no series carries (a group from some other window) has no
  // newest error of its own; the group's newest is the next best thing.
  const pool = saying.length === rows.length || saying.length === 0
    ? refPool(win, appId, group.side, group.endpoint, group.exception)
    : memo(win, `sample|${appId}|${group.side}|${group.endpoint}|${group.exception}|${group.message}`, () => {
      const seed = hashStr(`sample|${appId}|${group.side}|${group.endpoint}|${group.exception}|${group.message}`)
      return toRefs(unitsFor(saying.map(r => state.byId.get(r.id)), win, POOL_N, seed))
    })
  return pool[0]?.traceId ?? null
}
