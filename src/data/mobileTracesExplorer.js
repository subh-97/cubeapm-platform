// The Mobile Traces page's data: what the Cubedemo Shop app reported from the
// phones it runs on, as a function of the selected window.
//
// Production keeps this in its own index (`/api/mobile`), beside the span index
// and in the same query dialect, so the page reuses the Traces explorer whole
// and only the records differ. Three decisions carry them:
//
//   1. RECORDS COME FROM SESSIONS. A phone does not emit a random mix of event
//      types; it opens the app, lands on a screen, loads a catalogue, taps, pays
//      and sometimes crashes, and every record of that run shares one device,
//      one OS, one build, one country and one connection. So a window's rows are
//      built as whole sessions and flattened, the way the span rows are built as
//      whole traces — and a crash can carry the trail of what that same session
//      did just before it, which is what prod's `analytics_events` is.
//
//   2. A SESSION IS A PURE FUNCTION OF ITS IDENTITY. Its content is seeded by
//      one 16-bit word and placed in time by one offset from BASE_TIME, and
//      nothing else. A request's trace id packs both plus the record's index, so
//      `/trace/<id>?datasource=mobile` reopened after a reload — from any window,
//      or none — regenerates exactly the request the row showed. An id that does
//      not decode is not found; it never borrows a backend trace.
//
//   3. THE INCIDENT REACHES THE PHONE. The backend's payment pool failure is
//      what a checkout on the device runs into: a request to api.cubedemo.com's
//      payment paths fails with the same incident weight every other series
//      samples, so the mobile page shows the outage from the user's side — and,
//      like everything else, a week dilutes it.

import {
  BASE_TIME, REFERENCE_WINDOW, calibratePeak, incidentWeight, pinToReference, sampleAt, sampleCount,
  spreadTimes, windowMean,
} from './timeWindow'
import { statusForHttpStatus } from '@/utils/status'

const BASE_MS = BASE_TIME.getTime()
// What every window calls "now", to the second (`resolveWindow`'s nowSec). The
// incident is sampled against this rather than against the window passed in,
// so a record regenerated from its trace id alone fails or succeeds exactly as
// it did in the table it was opened from.
const NOW_MS = Math.floor(BASE_MS / 1000) * 1000

export const MOBILE_SERVICE = 'Cubedemo Shop'

/** Every eventType the index holds, as prod's facet lists them. */
export const MOBILE_EVENT_TYPES = [
  'ANR', 'CartUpdated', 'CheckoutStep', 'Mobile', 'MobileBreadcrumb', 'MobileCrash', 'MobileRequest',
  'MobileRequestError', 'MobileUserAction', 'PromoApplied', 'SearchPerformed',
]

/** Every category, as prod's facet lists them. */
export const MOBILE_CATEGORIES = [
  'Custom', 'Interaction', 'Session', 'analytics', 'api', 'attribution', 'captcha', 'cdn', 'maps',
  'payments', 'push',
]

export const MOBILE_EVENT_DOMAINS = ['nr.mobile', 'nr.mobile.crash', 'nr.mobile.custom', 'nr.mobile.error']

/* ---- small deterministic helpers (private copies, like observability.js keeps) ---- */

const seededRnd = seed => {
  let s = seed
  return () => { s = (s * 9301 + 49297) % 233280; return s / 233280 }
}

const hexId = (rnd, len) =>
  Array.from({ length: len }, () => Math.floor(rnd() * 16).toString(16)).join('')

const pick = (rnd, arr) => arr[Math.floor(rnd() * arr.length)]

// Local date and time, the format the span rows use, so the shared table and
// drawer read both pages' rows the same way.
function timeParts(t, ms) {
  const p = n => String(n).padStart(2, '0')
  return {
    dateStr: `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`,
    timeStr: `${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}.${String(ms).padStart(3, '0')}`,
  }
}

// FNV-1a, as errors.js and eventsStore hash with.
function hashStr(s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

const hex = (n, width) => n.toString(16).padStart(width, '0')
const digest = (s, salts, len) => salts.map(k => hex(hashStr(`${k}:${s}`), 8)).join('').slice(0, len)
const xorHex = (a, b) => Array.from(a, (c, i) => (parseInt(c, 16) ^ parseInt(b[i], 16)).toString(16)).join('')

function uuid(rnd) {
  return `${hexId(rnd, 8)}-${hexId(rnd, 4)}-4${hexId(rnd, 3)}-${pick(rnd, ['8', '9', 'a', 'b'])}${hexId(rnd, 3)}-${hexId(rnd, 12)}`
}

/* ---- trace ids ---- */

// 32 hex digits, built the way errors.js builds its sample ids: a checksum,
// then the payload masked by it. The payload is the session's start as ms
// before BASE_TIME, the session's identity word and the record's index in it —
// everything needed to rebuild that one record. The salts are this module's
// own, so an Errors-page sample id, a seeded backend trace id or a random one
// fails the checksum here and is "not found" rather than decoding to a stranger.
const OFFSET_HEX = 11
const WORD_HEX = 4
const INDEX_HEX = 2
const PAYLOAD_HEX = OFFSET_HEX + WORD_HEX + INDEX_HEX
const CHECK_HEX = 32 - PAYLOAD_HEX
const CHECK_SALTS = ['mob-c1', 'mob-c2']
const MASK_SALTS = ['mob-m1', 'mob-m2', 'mob-m3']
const MAX_OFFSET = 16 ** OFFSET_HEX
const MAX_INDEX = 16 ** INDEX_HEX

function encodeTraceId(offset, word, idx) {
  const payload = hex(offset, OFFSET_HEX) + hex(word, WORD_HEX) + hex(idx, INDEX_HEX)
  const check = digest(payload, CHECK_SALTS, CHECK_HEX)
  return check + xorHex(payload, digest(check, MASK_SALTS, PAYLOAD_HEX))
}

function decodeTraceId(id) {
  if (typeof id !== 'string' || !/^[0-9a-f]{32}$/.test(id)) return null
  const check = id.slice(0, CHECK_HEX)
  const payload = xorHex(id.slice(CHECK_HEX), digest(check, MASK_SALTS, PAYLOAD_HEX))
  if (digest(payload, CHECK_SALTS, CHECK_HEX) !== check) return null
  return {
    offset: parseInt(payload.slice(0, OFFSET_HEX), 16),
    word: parseInt(payload.slice(OFFSET_HEX, OFFSET_HEX + WORD_HEX), 16),
    idx: parseInt(payload.slice(OFFSET_HEX + WORD_HEX), 16),
  }
}

/* ---- vocabulary ---- */

const PLATFORMS = {
  ios: {
    platform: 'ios', os_name: 'iOS', agent_name: 'iOSAgent', agent_version: '7.5.3', manufacturer: 'Apple',
    osVersions: ['17.6', '18.0'], models: ['iPhone 15 Pro', 'iPhone 16', 'iPad Air'], screenSuffix: 'ViewController',
  },
  android: {
    platform: 'android', os_name: 'Android', agent_name: 'AndroidAgent', agent_version: '7.6.0', manufacturer: 'Google',
    osVersions: ['14'], models: ['Pixel 7a', 'Pixel 8'], screenSuffix: 'Activity',
  },
}

const OS_BUILDS = { '17.6': '21G80', '18.0': '22A3354', 14: 'AP2A.240905.003' }
const RESOLUTIONS = {
  'iPhone 15 Pro': '1179x2556', 'iPhone 16': '1179x2556', 'iPad Air': '1640x2360',
  'Pixel 7a': '1080x2400', 'Pixel 8': '1080x2400',
}

// Newest build most common: a store rollout takes a week to reach most phones.
const APP_BUILDS = ['4.2.8', '4.2.8', '4.2.8', '4.2.1', '4.2.1', '4.2.0']
const CONNECTIONS = ['WiFi', 'WiFi', 'WiFi', '5G', '4G', '4G', '3G']
const COUNTRIES = ['US', 'US', 'US', 'GB', 'DE', 'IN', 'IN', 'CA']

const SKUS = [
  { sku: 'AUD-61299', price: 129.0 }, { sku: 'SHO-20417', price: 84.5 }, { sku: 'KIT-55810', price: 39.99 },
  { sku: 'APP-30942', price: 59.0 }, { sku: 'WAT-77125', price: 219.0 },
]
const SEARCH_TERMS = ['running shoes', 'wireless earbuds', 'yoga mat', 'smart watch', 'travel backpack']
const SORT_ORDERS = ['relevance', 'price_asc', 'rating']
const PAYMENT_METHODS = ['card', 'card', 'upi', 'wallet', 'cod']
const PROMO_CODES = [{ code: 'SPRING25', pct: 0.25 }, { code: 'FREESHIP', flat: 6.99 }]

// Every outbound call the app makes, by what prod files it under. The
// `incident` flag marks the two calls that land on payment-service, which is
// what the backend outage takes down.
const TARGETS = {
  appConfig: { category: 'cdn', method: 'GET', domain: 'cdn.cubedemo.com', path: '/assets/app-config.json', ms: [18, 90], sent: [280, 520], recv: [1800, 4200] },
  productImage: { category: 'cdn', method: 'GET', domain: 'cdn.cubedemo.com', path: '/img/product/:sku/large.webp', ms: [25, 160], sent: [280, 520], recv: [38000, 220000] },
  products: { category: 'api', method: 'GET', domain: 'api.cubedemo.com', path: '/v1/products', ms: [70, 260], sent: [420, 760], recv: [6000, 24000] },
  product: { category: 'api', method: 'GET', domain: 'api.cubedemo.com', path: '/v1/products/:sku', ms: [45, 180], sent: [420, 760], recv: [2400, 7800] },
  search: { category: 'api', method: 'GET', domain: 'api.cubedemo.com', path: '/v1/search', ms: [90, 340], sent: [440, 820], recv: [5200, 21000] },
  wishlist: { category: 'api', method: 'GET', domain: 'api.cubedemo.com', path: '/account/:userId/wishlist', ms: [50, 190], sent: [420, 760], recv: [900, 4800] },
  cartGet: { category: 'api', method: 'GET', domain: 'api.cubedemo.com', path: '/v1/cart', ms: [40, 150], sent: [420, 760], recv: [700, 3200] },
  cartAdd: { category: 'api', method: 'POST', domain: 'api.cubedemo.com', path: '/v1/cart', ms: [60, 220], sent: [640, 1100], recv: [700, 3200] },
  cartPromo: { category: 'api', method: 'POST', domain: 'api.cubedemo.com', path: '/v1/cart/promo', ms: [60, 200], sent: [520, 900], recv: [600, 2400] },
  payment: { category: 'api', method: 'POST', domain: 'api.cubedemo.com', path: '/v1/payments', ms: [180, 520], sent: [900, 1600], recv: [500, 1400], incident: true },
  order: { category: 'api', method: 'POST', domain: 'api.cubedemo.com', path: '/v1/orders', ms: [150, 460], sent: [1100, 2200], recv: [800, 2600], incident: true },
  shipments: { category: 'api', method: 'GET', domain: 'api.cubedemo.com', path: '/v1/shipments', ms: [50, 190], sent: [420, 760], recv: [600, 2800] },
  analytics: { category: 'analytics', method: 'POST', domain: 'app-measurement.com', path: '/a', ms: [40, 210], sent: [1400, 5200], recv: [0, 0] },
  branchOpen: { category: 'attribution', method: 'POST', domain: 'api2.branch.io', path: '/v1/open', ms: [60, 280], sent: [900, 1800], recv: [400, 1600] },
  branchInstall: { category: 'attribution', method: 'POST', domain: 'api2.branch.io', path: '/v1/install', ms: [80, 320], sent: [1100, 2100], recv: [400, 1600] },
  fbActivities: { category: 'attribution', method: 'POST', domain: 'graph.facebook.com', path: '/v18.0/1099231/activities', ms: [90, 360], sent: [1200, 2600], recv: [40, 120] },
  autocomplete: { category: 'maps', method: 'GET', domain: 'maps.googleapis.com', path: '/maps/api/place/autocomplete/json', ms: [60, 240], sent: [380, 640], recv: [1800, 6400] },
  geocode: { category: 'maps', method: 'GET', domain: 'maps.googleapis.com', path: '/maps/api/geocode/json', ms: [70, 260], sent: [380, 640], recv: [1500, 5200] },
  captcha: { category: 'captcha', method: 'POST', domain: 'www.recaptcha.net', path: '/recaptcha/api2/reload', ms: [110, 420], sent: [2400, 6200], recv: [8000, 26000] },
  stripeTokens: { category: 'payments', method: 'POST', domain: 'api.stripe.com', path: '/v1/tokens', ms: [260, 780], sent: [700, 1300], recv: [900, 1800] },
  stripeConfirm: { category: 'payments', method: 'POST', domain: 'api.stripe.com', path: '/v1/payment_intents/:id/confirm', ms: [420, 1300], sent: [800, 1500], recv: [1800, 4200] },
  razorpayPrefs: { category: 'payments', method: 'POST', domain: 'api.razorpay.com', path: '/v1/checkout/preferences', ms: [300, 900], sent: [700, 1300], recv: [1200, 3400] },
  pushRegister: { category: 'push', method: 'POST', domain: 'fcmregistrations.googleapis.com', path: '/v1/projects/cubedemo-shop/registrations', ms: [80, 300], sent: [600, 1100], recv: [300, 700] },
}

// How often a call fails when nothing is wrong, by category — from the 7-day
// stream counts (errors over requests), rounded down, since that week includes
// the incident's tail.
const QUIET_FAILURE = {
  api: 0.025, attribution: 0.05, maps: 0.035, analytics: 0.02, captcha: 0.045, cdn: 0.01, payments: 0.03, push: 0.04,
}
// What the incident adds at its peak: most payment and order calls fail, and
// the rest of api.cubedemo.com feels it a little through shared gateways.
const INCIDENT_FAILURE = { payment: 0.6, api: 0.04 }
// A third of prod's failed requests never got an answer at all (status 0).
const NETWORK_SHARE = 0.34

const HTTP_CODES = {
  api: ['500', '502', '503', '404'], attribution: ['429', '503'], maps: ['429', '400'], analytics: ['503', '429'],
  captcha: ['400', '429'], cdn: ['404', '503'], payments: ['400', '500', '502'], push: ['500', '400'],
}
// The gateway in front of payment-service answers for it while its pool is out.
const INCIDENT_CODES = ['502', '503', '503', '502', '500']

const NETWORK_ERRORS = {
  ios: [
    { message: 'NSURLErrorTimedOut: The request timed out.', code: '-1001', ms: [30000, 60000] },
    { message: 'NSURLErrorNetworkConnectionLost: The network connection was lost.', code: '-1005', ms: [300, 3000] },
    { message: 'NSURLErrorNotConnectedToInternet: The Internet connection appears to be offline.', code: '-1009', ms: [3, 40] },
  ],
  android: [
    { message: 'java.net.SocketTimeoutException: timeout', code: '-1001', ms: [30000, 60000] },
    { message: 'java.net.UnknownHostException: Unable to resolve host', code: '-1003', ms: [20, 400] },
    { message: 'javax.net.ssl.SSLException: Connection reset', code: '-1005', ms: [300, 3000] },
  ],
}

// The three crashes prod's index carries, each with the request whose failure
// left the app in the state it crashed on, and the journey that reaches it.
const CRASHES = [
  {
    journey: 'checkout', trigger: 'stripeConfirm', nth: 1, network: 0,
    location: 'CheckoutViewController.swift line 96 in Cubedemo.CheckoutViewController.submitOrder',
    name: 'NSInvalidArgumentException',
    cause: '-[NSNull length]: unrecognized selector sent to instance 0x1f2a4c8f0',
    frames: [
      { className: 'CheckoutViewController', fileName: 'CheckoutViewController.swift', lineNumber: 96, methodName: 'submitOrder', symbolInfo: 'Cubedemo.CheckoutViewController.submitOrder() -> ()' },
      { className: 'PaymentCoordinator', fileName: 'PaymentCoordinator.swift', lineNumber: 211, methodName: 'didFinishConfirm(result:)', symbolInfo: 'Cubedemo.PaymentCoordinator.didFinishConfirm(result:)' },
      { className: 'URLSessionTask', fileName: '', lineNumber: 0, methodName: 'completionHandler', symbolInfo: 'CFNetwork' },
      { className: 'UIApplication', fileName: '', lineNumber: 0, methodName: 'sendEvent:', symbolInfo: 'UIKitCore' },
    ],
  },
  {
    journey: 'cart', trigger: 'productImage', nth: 3, network: 1,
    location: 'ImageCache.swift line 133 in Cubedemo.ImageCache.evict',
    name: 'SIGSEGV',
    cause: 'Attempted to dereference garbage pointer 0x0',
    frames: [
      { className: 'ImageCache', fileName: 'ImageCache.swift', lineNumber: 133, methodName: 'evict(_:)', symbolInfo: 'Cubedemo.ImageCache.evict(_:)' },
      { className: 'ImageCache', fileName: 'ImageCache.swift', lineNumber: 88, methodName: 'store(_:for:)', symbolInfo: 'Cubedemo.ImageCache.store(_:for:)' },
      { className: 'ProductImageLoader', fileName: 'ProductImageLoader.swift', lineNumber: 54, methodName: 'didFail(with:)', symbolInfo: 'Cubedemo.ProductImageLoader.didFail(with:)' },
      { className: 'DispatchQueue', fileName: '', lineNumber: 0, methodName: '_dispatch_call_block_and_release', symbolInfo: 'libdispatch.dylib' },
    ],
  },
  {
    journey: 'search', trigger: 'search', nth: 1, network: 0,
    location: 'CatalogDataSource.swift line 58 in Cubedemo.CatalogDataSource.item',
    name: 'NSRangeException',
    cause: '*** -[__NSArrayM objectAtIndex:]: index 9 beyond bounds [0 .. 5]',
    frames: [
      { className: 'CatalogDataSource', fileName: 'CatalogDataSource.swift', lineNumber: 58, methodName: 'item(at:)', symbolInfo: 'Cubedemo.CatalogDataSource.item(at:)' },
      { className: 'SearchViewController', fileName: 'SearchViewController.swift', lineNumber: 142, methodName: 'collectionView(_:cellForItemAt:)', symbolInfo: 'Cubedemo.SearchViewController.collectionView(_:cellForItemAt:)' },
      { className: 'UICollectionView', fileName: '', lineNumber: 0, methodName: '_createPreparedCellForItemAtIndexPath:', symbolInfo: 'UIKitCore' },
      { className: 'CALayer', fileName: '', lineNumber: 0, methodName: 'layoutSublayers', symbolInfo: 'QuartzCore' },
    ],
  },
]

const ANR_THREAD_DUMP = `"main" prio=5 tid=1 Blocked
  | group="main" sCount=1 ucsCount=0 flags=1 obj=0x72f1c4a8 self=0xb400007a1c2e7be0
  at com.cubedemo.shop.checkout.PaymentRepository.awaitPreferences(PaymentRepository.kt:88)
  - waiting to lock <0x0c3f2a91> (a java.lang.Object) held by thread 23
  at com.cubedemo.shop.checkout.CheckoutViewModel.onPlaceOrder(CheckoutViewModel.kt:142)
  at com.cubedemo.shop.checkout.CheckoutActivity.onPlaceOrderClicked(CheckoutActivity.kt:211)
  at android.view.View.performClick(View.java:7659)
  at android.os.Handler.handleCallback(Handler.java:958)
  at android.os.Looper.loop(Looper.java:294)
  at android.app.ActivityThread.main(ActivityThread.java:8177)`

/* ---- sessions ---- */

// What a session is, beyond the device it ran on. The low twelve bits of the
// identity word are the session's slot (which also cycles its journey, so a
// small window still has every journey and every event type they emit); the
// top four say whether it was forced to show a rare record.
const SCENARIO = { natural: 0, crash: 1, anr: 2, install: 3, paymentOutage: 4 }
const JOURNEYS = ['browse', 'search', 'cart', 'checkout', 'promo']

const wordOf = (scenario, slot) => ((scenario & 0xf) << 12) | (slot & 0xfff)

function sessionContext(word, startMs) {
  // Content is seeded by the word alone, so where a session sits in time moves
  // nothing but its clock and the incident it meets; ids are hashed off the
  // start too, so two windows' sessions in the same slot are different visits.
  const rnd = seededRnd(hashStr(`mob:${word}`) % 233280)
  const idRnd = seededRnd(hashStr(`mob:${word}:${BASE_MS - startMs}`) % 233280)
  const forced = word >> 12
  const slot = word & 0xfff

  // Always drawn, whatever the word says, so a forced session's later draws
  // line up with a natural one's.
  const r = rnd()
  const scenario = forced !== SCENARIO.natural ? forced
    : r < 0.035 ? SCENARIO.crash
      : r < 0.045 ? SCENARIO.anr
        : r < 0.075 ? SCENARIO.install
          : SCENARIO.natural

  const rp = rnd()
  const platform = scenario === SCENARIO.crash ? 'ios'
    : scenario === SCENARIO.anr ? 'android'
      : rp < 0.58 ? 'ios' : 'android'
  const P = PLATFORMS[platform]
  const crash = scenario === SCENARIO.crash ? CRASHES[Math.floor(rnd() * CRASHES.length)] : (rnd(), null)
  const journey = crash ? crash.journey
    : scenario === SCENARIO.anr || scenario === SCENARIO.paymentOutage ? 'checkout'
      : JOURNEYS[slot % JOURNEYS.length]
  const model = pick(rnd, P.models)
  const osVersion = pick(rnd, P.osVersions)
  const appBuild = pick(rnd, APP_BUILDS)
  const country = pick(rnd, COUNTRIES)
  const connection = pick(rnd, CONNECTIONS)

  // Sixteen hex digits, as the agents report them; only the app exit id of an
  // ANR is a UUID.
  const sessionId = hexId(idRnd, 16)
  const deviceId = hexId(idRnd, 16)

  return {
    word, slot, startMs, offset: BASE_MS - startMs, scenario, crash, journey, platform, P, rnd,
    sessionId,
    exitId: uuid(idRnd),
    processId: String(4000 + Math.floor(idRnd() * 28000)),
    // What every record of the session carries, in the order the drawer lists
    // it after the record's own fields.
    common: {
      session_id: sessionId,
      device_id: deviceId,
      device_manufacturer: P.manufacturer,
      device_model: model,
      device_name: P.manufacturer,
      os_name: P.os_name,
      os_version: osVersion,
      os_major_version: osVersion.split('.')[0],
      platform,
      platform_version: P.agent_version,
      agent_name: P.agent_name,
      agent_platform: 'Native',
      agent_version: P.agent_version,
      app_build: appBuild,
      'service.version': appBuild,
      connectionType: connection,
      countryCode: country,
      country_code: country,
      env: 'UNSET',
    },
    model,
    osVersion,
    appBuild,
    country,
  }
}

const between = (u, [lo, hi]) => lo + u * (hi - lo)

/**
 * A session's events, in order, each with its offset from the session's start.
 *
 * The clock only ever advances by gaps drawn from the session's own seed — a
 * request's duration and whether it failed never move the next event — so the
 * timeline is the same wherever the session is placed, up to the one branch
 * the incident decides: a payment the outage failed ends the visit there. Every
 * forced record comes before that branch, which is what lets a forced session
 * be slid back from "now" until its record is inside the window without the
 * record moving within the session.
 */
function buildSession(word, startMs) {
  const s = sessionContext(word, startMs)
  const { rnd, P } = s
  const events = []
  let at = 0
  let screen = `Display Home${P.screenSuffix}`
  let ended = false
  const cart = { items: 0, value: 0 }

  const push = (ev, gap) => {
    at += Math.max(1, Math.round(gap))
    if (!ended) events.push({ ...ev, at, lastInteraction: screen })
  }

  // A request draws the same six numbers whatever happens to it, so the
  // sequence below it does not shift with the incident.
  const request = (key, gap, force) => {
    const u = rnd(), v = rnd(), x = rnd(), d = rnd(), sb = rnd(), rb = rnd()
    at += Math.max(1, Math.round(gap))
    if (ended) return null
    const target = TARGETS[key]
    const tMs = s.startMs + at
    const w = incidentWeight((NOW_MS - tMs) / 60000)
    const quiet = QUIET_FAILURE[target.category]
    const surge = (target.incident ? INCIDENT_FAILURE.payment : target.category === 'api' ? INCIDENT_FAILURE.api : 0) * w
    let outcome = { code: '200' }
    if (force) outcome = force(v, x)
    else if (u < quiet) {
      outcome = x < NETWORK_SHARE
        ? { network: NETWORK_ERRORS[s.platform][Math.floor(v * 3)] }
        : { code: HTTP_CODES[target.category][Math.floor(v * HTTP_CODES[target.category].length)] }
    } else if (u < quiet + surge) {
      outcome = { code: INCIDENT_CODES[Math.floor(v * INCIDENT_CODES.length)], incident: true }
    }
    const failed = !!outcome.network || outcome.code !== '200'
    // A timeout runs to the client's limit and a gateway answering for a dead
    // pool takes seconds; anything else is the call's own spread.
    const durMs = outcome.network
      ? between(d, outcome.network.ms)
      : outcome.incident
        ? 1500 + d * 3000
        : between(d, target.ms) * (failed ? 1.2 : 1)
    const ev = {
      kind: 'request', key, target, failed,
      code: outcome.network ? '0' : outcome.code,
      network: outcome.network ?? null,
      durMs,
      sent: Math.round(target.sent[0] + sb * (target.sent[1] - target.sent[0])),
      recv: outcome.network ? 0
        : failed ? Math.round(120 + rb * 480)
          : Math.round(target.recv[0] + rb * (target.recv[1] - target.recv[0])),
      at,
      lastInteraction: screen,
    }
    events.push(ev)
    return ev
  }

  const show = (name, gap) => {
    const next = `Display ${name}${P.screenSuffix}`
    const interactionDuration = (0.12 + rnd() * 0.9).toFixed(3)
    at += Math.max(1, Math.round(gap))
    if (ended) return
    screen = next
    events.push({ kind: 'screen', name: next, interactionDuration, at, lastInteraction: screen })
  }
  const tap = (target, gap) => push({ kind: 'tap', name: `Tap ${target}`, actionType: 'Touch' }, gap)
  const crumb = (name, gap) => push({ kind: 'breadcrumb', name }, gap)
  const custom = (type, attrs, gap) => push({ kind: 'custom', type, attrs }, gap)
  const dwell = () => 2000 + rnd() * 9000
  const quick = () => 20 + rnd() * 230

  // A crash ends the session where its trigger request failed: the request
  // never got an answer, the app read the missing answer, and the process died.
  const calls = {}
  const crashFail = () => ({ network: NETWORK_ERRORS.ios[s.crash.network] })
  const call = (key, gap) => {
    calls[key] = (calls[key] ?? 0) + 1
    if (s.crash && s.crash.trigger === key && s.crash.nth === calls[key] && !ended) {
      request(key, gap, crashFail)
      push({ kind: 'crash', crash: s.crash, memoryMb: Math.round(280 + rnd() * 520), orientation: rnd() < 0.85 ? 'Portrait' : 'Landscape' }, 40 + rnd() * 400)
      ended = true
      return null
    }
    return request(key, gap)
  }

  /* opening the app */
  if (s.scenario === SCENARIO.install) push({ kind: 'install' }, 0)
  push({ kind: 'session', timeSinceLoad: (0.6 + rnd() * 1.8).toFixed(3) }, s.scenario === SCENARIO.install ? 40 + rnd() * 200 : 0)
  push({ kind: 'launch', name: 'MobileUserAction', actionType: 'AppLaunch' }, 5 + rnd() * 35)
  call('appConfig', 50 + rnd() * 100)
  call(s.scenario === SCENARIO.install ? 'branchInstall' : 'branchOpen', quick())
  if (s.scenario === SCENARIO.install || rnd() < 0.3) call('pushRegister', quick())

  /* home */
  show('Home', 200 + rnd() * 700)
  call('products', quick())
  call('productImage', quick())
  call('productImage', quick())
  crumb('catalog.loaded', 5 + rnd() * 80)
  call('analytics', quick())

  const productDetail = () => {
    const item = pick(rnd, SKUS)
    if (s.journey === 'search') {
      tap('ProductCell', dwell())
    }
    show('ProductDetail', s.journey === 'search' ? 200 + rnd() * 500 : dwell())
    call('product', quick())
    call('productImage', quick())
    if (rnd() < 0.4) call('wishlist', quick())
    if (rnd() < 0.3) call('fbActivities', quick())
    return item
  }

  const addToCart = (item) => {
    tap('AddToCartButton', dwell())
    call('cartAdd', quick())
    cart.items += 1
    cart.value = Math.round((cart.value + item.price) * 100) / 100
    custom('CartUpdated', {
      addedSku: item.sku, cartValue: cart.value.toFixed(2), currency: 'USD', itemCount: String(cart.items),
    }, 10 + rnd() * 60)
    call('analytics', quick())
  }

  const checkout = (promo) => {
    show('Cart', dwell())
    call('cartGet', quick())
    tap('CheckoutButton', dwell())
    show('Checkout', 200 + rnd() * 500)
    const method = s.country === 'IN' ? pick(rnd, ['upi', 'card', 'cod']) : pick(rnd, PAYMENT_METHODS)
    custom('CheckoutStep', { step: 'shipping', paymentMethod: method, cartValue: cart.value.toFixed(2), itemCount: String(cart.items) }, 10 + rnd() * 60)
    call('autocomplete', dwell() * 0.6)
    call('geocode', 900 + rnd() * 2500)
    custom('CheckoutStep', { step: 'review', paymentMethod: method, cartValue: cart.value.toFixed(2), itemCount: String(cart.items) }, dwell())
    if (promo) {
      const p = pick(rnd, PROMO_CODES)
      const discount = p.pct ? Math.round(cart.value * p.pct * 100) / 100 : p.flat
      tap('ApplyPromoButton', dwell())
      call('cartPromo', quick())
      cart.value = Math.max(0, Math.round((cart.value - discount) * 100) / 100)
      custom('PromoApplied', { promoCode: p.code, discountAmount: discount.toFixed(2), cartValue: cart.value.toFixed(2) }, 10 + rnd() * 60)
    }
    custom('CheckoutStep', { step: 'payment', paymentMethod: method, cartValue: cart.value.toFixed(2), itemCount: String(cart.items) }, dwell())
    call('captcha', quick())

    // Android in India pays through Razorpay, everyone else through Stripe.
    const provider = s.platform === 'android' && s.country === 'IN' ? 'razorpayPrefs' : 'stripeTokens'
    if (s.scenario === SCENARIO.anr) {
      // The provider refuses the request, the activity blocks on a retry that
      // holds the payment lock, and the next tap is never dispatched.
      request(provider, 600 + rnd() * 1800, (v) => ({ code: v < 0.5 ? '400' : '429' }))
      tap('PlaceOrderButton', dwell())
      push({ kind: 'anr', waitedMs: 5000 + Math.floor(rnd() * 400) }, 5000 + rnd() * 400)
      ended = true
      return
    }
    call(provider, 600 + rnd() * 1800)
    tap('PlaceOrderButton', dwell())
    crumb('payment.submitted', 5 + rnd() * 60)
    // Razorpay's checkout call already settled it; a Stripe card still has to
    // confirm its payment intent.
    if (provider === 'stripeTokens') call('stripeConfirm', quick())
    const paid = s.scenario === SCENARIO.paymentOutage
      ? request('payment', quick(), (v) => ({ code: v < 0.5 ? '502' : '503', incident: true }))
      : call('payment', quick())
    if (ended) return
    if (paid?.failed) {
      crumb('payment.failed', 5 + rnd() * 60)
      show('Checkout', 300 + rnd() * 900)
      ended = true
      return
    }
    call('order', quick())
    show('OrderConfirmation', 300 + rnd() * 900)
    crumb('order.confirmed', 5 + rnd() * 60)
    call('shipments', quick())
    call('analytics', quick())
  }

  if (s.journey === 'browse') {
    productDetail()
    if (rnd() < 0.5) productDetail()
  } else if (s.journey === 'search' || s.journey === 'promo') {
    tap('SearchButton', dwell())
    show('Search', 200 + rnd() * 500)
    const term = pick(rnd, SEARCH_TERMS)
    call('search', 800 + rnd() * 2400)
    custom('SearchPerformed', {
      searchTerm: term, resultCount: String(4 + Math.floor(rnd() * 180)), sortOrder: pick(rnd, SORT_ORDERS),
    }, 10 + rnd() * 60)
    call('productImage', quick())
    const item = productDetail()
    if (s.journey === 'promo') {
      addToCart(item)
      checkout(true)
    }
  } else {
    const item = productDetail()
    addToCart(item)
    if (s.journey === 'checkout') checkout(false)
    else if (rnd() < 0.5) addToCart(productDetail())
  }

  s.events = events
  return s
}

/* ---- records ---- */

// Severity of a record: the HTTP code where there is one, and a crash or an
// ANR is critical however it got there. Mirrors statusForMobileRecord in
// utils/mobileTraceFields — that module imports this one, so the row's `level`
// is worked out here rather than through it.
function levelOf(tags) {
  const fatal = tags.eventType === 'MobileCrash' || tags.eventType === 'ANR'
  const s = statusForHttpStatus(tags.status_code)
  if (fatal || s === 'critical') return 'error'
  if (s === 'warning') return 'warn'
  return 'info'
}

const screenSpan = (s, name) => `Display ${name}${s.P.screenSuffix}`

// The trail a crash report carries: what the session did just before it died,
// as prod's agent writes it — the newest last.
function analyticsTrail(s, idx) {
  return s.events.slice(Math.max(0, idx - 8), idx).map(ev => {
    const t = s.startMs + ev.at
    const base = { timeSinceLoad: Number((ev.at / 1000).toFixed(3)), timestamp: t }
    switch (ev.kind) {
      case 'request':
        return {
          eventType: ev.failed ? 'MobileRequestError' : 'MobileRequest',
          requestMethod: ev.target.method,
          requestUrl: `https://${ev.target.domain}${ev.target.path}`,
          statusCode: Number(ev.code),
          responseTime: Number(ev.durMs.toFixed(1)),
          ...(ev.network ? { errorType: 'NetworkError', networkError: ev.network.message } : ev.failed ? { errorType: 'HTTPError' } : {}),
          ...base,
        }
      case 'screen': return { eventType: 'Mobile', category: 'Interaction', name: ev.name, interactionDuration: Number(ev.interactionDuration), ...base }
      case 'session': return { eventType: 'Mobile', category: 'Session', name: 'MobileSession', ...base }
      case 'tap':
      case 'launch': return { eventType: 'MobileUserAction', name: ev.name, actionType: ev.actionType, ...base }
      case 'breadcrumb': return { eventType: 'MobileBreadcrumb', name: ev.name, ...base }
      case 'custom': return { eventType: ev.type, name: ev.type, ...ev.attrs, ...base }
      case 'install': return { name: 'Mobile/App/Install', ...base }
      default: return { name: ev.kind, ...base }
    }
  })
}

/**
 * One event of a session as a row in the shape the span rows have, so every
 * shared consumer — the table, the drawer, the query evaluator, the
 * aggregator — reads it without knowing it came from a phone.
 *
 * Tags are flat strings, and a field the record does not have is absent rather
 * than blank: a crash has no duration, which is a different statement from a
 * request that took no time.
 */
function recordOf(s, ev, idx) {
  const tMs = s.startMs + ev.at
  const time = new Date(tMs)
  const head = { service: MOBILE_SERVICE }
  let body = {}

  switch (ev.kind) {
    case 'install': {
      head.span_name = 'Mobile/App/Install'
      head.span_kind = 'client'
      head['event.domain'] = 'nr.mobile'
      head.status_code = 'UNSET'
      head.trace_id = encodeTraceId(s.offset, s.word, idx)
      head.span_id = '0000000000000001'
      body = { count: '1' }
      break
    }
    case 'session': {
      Object.assign(head, {
        span_name: 'MobileSession', span_kind: 'client', eventType: 'Mobile', category: 'Session',
        'cube.eventType': 'MobileSession', 'event.domain': 'nr.mobile', status_code: 'UNSET',
      })
      body = { timeSinceLoad: ev.timeSinceLoad }
      break
    }
    case 'screen': {
      Object.assign(head, {
        span_name: ev.name, span_kind: 'client', eventType: 'Mobile', category: 'Interaction',
        'event.domain': 'nr.mobile', status_code: 'UNSET',
      })
      body = { interactionDuration: ev.interactionDuration }
      break
    }
    case 'launch':
    case 'tap': {
      Object.assign(head, {
        span_name: ev.name, span_kind: 'client', eventType: 'MobileUserAction',
        'event.domain': 'nr.mobile', status_code: 'UNSET',
      })
      body = { actionType: ev.actionType }
      break
    }
    case 'breadcrumb': {
      Object.assign(head, {
        span_name: ev.name, span_kind: 'client', eventType: 'MobileBreadcrumb',
        'event.domain': 'nr.mobile', status_code: 'UNSET',
      })
      break
    }
    case 'custom': {
      Object.assign(head, {
        span_name: ev.type, span_kind: 'client', eventType: ev.type, category: 'Custom',
        'event.domain': 'nr.mobile.custom',
      })
      body = { name: ev.type, ...ev.attrs, sessionId: s.sessionId, timestamp: String(tMs) }
      break
    }
    case 'request': {
      const traceId = encodeTraceId(s.offset, s.word, idx)
      const durationNs = Math.round(ev.durMs * 1e6)
      Object.assign(head, {
        span_name: `HTTP ${ev.target.method} ${ev.target.domain}`, span_kind: 'client',
        eventType: ev.failed ? 'MobileRequestError' : 'MobileRequest', category: ev.target.category,
        'event.domain': 'nr.mobile', status_code: ev.code, duration: String(durationNs),
        trace_id: traceId, span_id: digest(traceId, ['mob-s1', 'mob-s2'], 16),
      })
      body = {
        statusCode: ev.code,
        responseTime: ev.durMs.toFixed(1),
        requestDomain: ev.target.domain,
        requestMethod: ev.target.method,
        requestPath: ev.target.path,
        requestUrl: `https://${ev.target.domain}${ev.target.path}`,
        bytesSent: String(ev.sent),
        bytesReceived: String(ev.recv),
      }
      if (ev.network) {
        Object.assign(body, { errorType: 'NetworkError', networkError: ev.network.message, networkErrorCode: ev.network.code })
      } else if (ev.failed) {
        body.errorType = 'HTTPError'
      }
      body.timestamp = String(tMs)
      body['user_agent.original'] = `${s.P.agent_name}/${s.P.agent_version}`
      break
    }
    case 'crash': {
      const c = ev.crash
      Object.assign(head, {
        span_name: 'MobileCrash', span_kind: 'client', eventType: 'MobileCrash', 'event.domain': 'nr.mobile.crash',
      })
      body = {
        crash_location: c.location,
        exception_name: c.name,
        exception_cause: c.cause,
        crash_timestamp: String(tMs),
        app_bundle_id: 'com.cubedemo.shop',
        app_version: s.appBuild,
        device_architecture: 'arm64',
        device_memory_usage: String(ev.memoryMb),
        device_orientation: ev.orientation,
        device_screen_resolution: RESOLUTIONS[s.model],
        os_build: OS_BUILDS[s.osVersion],
        stacktrace: JSON.stringify({ crashed: true, stack: c.frames, state: 'Crashed', threadId: 0 }),
        analytics_events: JSON.stringify(analyticsTrail(s, idx)),
      }
      break
    }
    case 'anr': {
      Object.assign(head, {
        span_name: 'ANR', span_kind: 'client', eventType: 'ANR', 'cube.eventType': 'ANR', 'event.domain': 'nr.mobile.error',
      })
      body = {
        description: `Input dispatching timed out (com.cubedemo.shop/com.cubedemo.shop.checkout.CheckoutActivity, Waited ${ev.waitedMs}ms for MotionEvent)`,
        app_exit_id: s.exitId,
        app_state: 'foreground',
        importance: 'FOREGROUND',
        process_id: s.processId,
        process_name: 'com.cubedemo.shop',
        thread_dump: ANR_THREAD_DUMP,
      }
      break
    }
    default:
      break
  }

  const tags = { ...head, ...body, ...s.common, last_interaction: ev.lastInteraction ?? screenSpan(s, 'Home') }
  const durationNs = tags.duration != null ? Number(tags.duration) : null
  return {
    id: `mob_${s.offset.toString(36)}_${s.word.toString(36)}_${idx}`,
    time,
    ...timeParts(time, time.getMilliseconds()),
    level: levelOf(tags),
    // prod's `_msg` on every mobile record; the drawer hides it as it hides a
    // span's empty message.
    message: 'UNSET',
    service: MOBILE_SERVICE,
    spanName: tags.span_name,
    spanKind: 'client',
    durationNs,
    statusCode: tags.status_code ?? '',
    traceId: tags.trace_id ?? '',
    spanId: tags.span_id ?? '',
    tags,
  }
}

/* ---- the window's sample ---- */

// Sessions a minute the table samples. The stream holds ~44 a minute; a
// session is ~30 records, so this is the few hundred rows a table can show
// for an hour, and the cap keeps a week from building thousands to show 600.
const SESSIONS_PER_MIN = 0.23
const MIN_SESSIONS = 6
const MAX_SESSIONS = 17
// Sessions start this far before the window too, so the window's first
// minutes hold the tails of visits already under way rather than starting
// empty and filling up.
const LEAD_SEC = 150

// The rare records, each forced into one session of every window long enough
// to be asked about them: a crash (its trigger request fails with status 0),
// an ANR (after a 4xx from the payment provider), a first launch (the install
// record) and a checkout that runs into the outage (a 5xx). Placed at a fixed
// share of the window, the outage last so a window ending now meets it inside
// the incident.
const FORCED = [
  { scenario: SCENARIO.crash, at: 0.2 },
  { scenario: SCENARIO.anr, at: 0.45 },
  { scenario: SCENARIO.install, at: 0.68 },
  { scenario: SCENARIO.paymentOutage, at: 0.86 },
]
const FORCE_MIN_MINUTES = 15
const FORCED_SLOT = 0xf00

// The record each forced session exists to show. A crash and an ANR come
// after the failed request that caused them, so reaching them covers it too.
const FORCED_RECORD = {
  [SCENARIO.crash]: ev => ev.kind === 'crash',
  [SCENARIO.anr]: ev => ev.kind === 'anr',
  [SCENARIO.install]: ev => ev.kind === 'install',
  [SCENARIO.paymentOutage]: ev => ev.kind === 'request' && ev.key === 'payment' && ev.failed,
}

function forcedSessions(startMs, endMs) {
  const out = []
  FORCED.forEach((f, k) => {
    const word = wordOf(f.scenario, FORCED_SLOT + k)
    // The timeline up to the forced record does not depend on where the
    // session sits, so one build at any start says how far in it falls.
    const probe = buildSession(word, startMs)
    const target = probe.events.find(FORCED_RECORD[f.scenario])
    const reach = (target?.at ?? 0) + 5000
    const want = Math.floor(startMs + f.at * (endMs - startMs))
    const at = Math.max(startMs, Math.min(want, endMs - reach))
    out.push(buildSession(word, at))
  })
  return out
}

/**
 * The mobile sample for a window: whole sessions, flattened newest first and
 * clipped to the window and to now.
 *
 * Like the span table this is a sample, spread across the window so a wider
 * range reaches further back; the histogram above it counts the stream.
 */
export function mobileRowsForWindow(win) {
  const startMs = win.start * 1000
  const endMs = Math.min(win.end, win.nowSec) * 1000
  if (!(endMs > startMs)) return []

  const n = sampleCount(win, SESSIONS_PER_MIN, { min: MIN_SESSIONS, max: MAX_SESSIONS })
  const starts = spreadTimes({ start: win.start - LEAD_SEC, end: win.end, nowSec: win.nowSec }, n)
  const sessions = starts.map((t, i) => buildSession(wordOf(SCENARIO.natural, i), Math.floor(t)))
  if (win.pastMinutes >= FORCE_MIN_MINUTES) sessions.push(...forcedSessions(startMs, endMs))

  const out = []
  for (const s of sessions) {
    if (!(s.offset >= 0 && s.offset < MAX_OFFSET)) continue
    s.events.forEach((ev, idx) => {
      const t = s.startMs + ev.at
      if (t < startMs || t >= endMs || idx >= MAX_INDEX) return
      out.push(recordOf(s, ev, idx))
    })
  }
  return out.sort((a, b) => b.time - a.time || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** The reference hour's rows, for anything derived once at load (the field catalog). */
export const mobileReferenceRows = mobileRowsForWindow(REFERENCE_WINDOW)

/**
 * The request (or install) a mobile trace id stands for — the same row every
 * time, from any window — or null when the id is not one of these.
 */
export function mobileRecordForTraceId(id) {
  const ref = decodeTraceId(id)
  if (!ref) return null
  const startMs = BASE_MS - ref.offset
  const s = buildSession(ref.word, startMs)
  const ev = s.events[ref.idx]
  if (!ev || (ev.kind !== 'request' && ev.kind !== 'install')) return null
  // A record from after now was never in any table.
  if (s.startMs + ev.at >= NOW_MS) return null
  const row = recordOf(s, ev, ref.idx)
  return row.traceId === id ? row : null
}

/* ---- volume ---- */

// Records a minute by severity band, calibrated to prod's Last 1 hour legend
// (98.27K): 200 + UNSET ≈ 86.2K, blank ≈ 9.79K once crashes and ANRs move to
// the failing band, 400/404/429 ≈ 692, and 0/5xx plus crashes and ANRs ≈ 1.57K.
// Healthy traffic and custom events breathe with the day; refusals are flat
// noise; failures carry the incident, so the hour still sums to its legend while
// the live outage runs at several times the quiet rate and a week reads well
// below it. Each band is pinned so its noisy hour lands on its figure exactly.
const BAND_TARGETS = { ok: 86200 / 60, none: 9790 / 60, warn: 692 / 60, fail: 1570 / 60 }
const FAIL_QUIET = 14

const MOBILE_RATE = {
  ok: pinToReference({ baseline: BAND_TARGETS.ok, noise: 0.5, seed: 211, diurnal: true }, windowMean, BAND_TARGETS.ok),
  none: pinToReference({ baseline: BAND_TARGETS.none, noise: 0.6, seed: 223, diurnal: true }, windowMean, BAND_TARGETS.none),
  warn: pinToReference({ baseline: BAND_TARGETS.warn, noise: 0.7, seed: 227 }, windowMean, BAND_TARGETS.warn),
  fail: pinToReference(
    { baseline: FAIL_QUIET, peak: calibratePeak(FAIL_QUIET, BAND_TARGETS.fail), noise: 0.6, seed: 229 },
    windowMean, BAND_TARGETS.fail,
  ),
}

export const MOBILE_BAND_KEYS = ['ok', 'none', 'warn', 'fail']

/** One entry per window bucket, the shape the explorer's histogram reads. */
export function mobileVolumeForWindow(win) {
  return win.buckets.map(b => {
    const v = k => (b.future ? 0 : Math.round(sampleAt(MOBILE_RATE[k], b) * b.durMin))
    const ok = v('ok'), none = v('none'), warn = v('warn'), fail = v('fail')
    return {
      m: b.m, t: b.t, label: b.label, exactTime: b.exactTime,
      ok, none, warn, fail, total: ok + none + warn + fail,
    }
  })
}

/* ---- facets ---- */

// Prod's rail for this index is its stream labels, in this order. Pinned rather
// than admitted by value shape: `service` has one value on every row and would
// fail the span admission test, and everything else that would pass it (device
// model, OS version, connection…) is a column, not what prod filters on.
export const MOBILE_FACET_FIELDS = ['category', 'cube.eventType', 'event.domain', 'eventType', 'service']

/**
 * Value counts for the pinned fields over the rows given, most common first
 * (ties by name), blanks skipped. A field no row carries is left out rather
 * than listed empty.
 */
export function buildMobileFacets(rows) {
  const out = {}
  for (const field of MOBILE_FACET_FIELDS) {
    const counts = new Map()
    for (const row of rows) {
      const raw = row.tags?.[field]
      if (raw == null || raw === '') continue
      const v = String(raw)
      counts.set(v, (counts.get(v) || 0) + 1)
    }
    if (counts.size === 0) continue
    out[field] = [...counts.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
  }
  return out
}
