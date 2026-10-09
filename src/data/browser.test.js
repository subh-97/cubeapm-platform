// What the Browser page's numbers promise, and what a sample promises about
// the trace behind it.
//
// Three risks. The figures are generated, so a plausible refactor can quietly
// stop Last 1 hour reproducing the production page the user compares this one
// with — the figures are copied from it, so they are copied here too, and a
// drift fails by name. The incident reaches the browser through the backend,
// so the two can drift apart at every range but the one they were calibrated
// on, which would show as a checkout that slows down at a different minute
// from the payment service it waits on. And a sample is only worth clicking if
// the trace it opens is the request it claims to be, from its id alone, after
// a reload — and is never mistaken for one of the Errors page's.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BASE_TIME, REFERENCE_WINDOW, INCIDENT_START_MIN, resolveWindow, windowSeries, valueAtWeight, bucketIndexOf,
  windowMean,
} from './timeWindow.js'
import { serviceProfile, errorRateProfiles } from './services.js'
import { errorSeriesForWindow, errorGroupsForWindow, errorSamplesFor, errorTraceRows } from './errors.js'
import { spanRows, spanRowsForWindow } from './tracesExplorer.js'
import { buildTrace } from '@/data/traceDetail'
import { statusForWebVital } from '@/utils/status'
import {
  BROWSER_APPS, BROWSER_SOURCE_MAP_SEED, browserAppsForWindow, browserProfiles,
  pageViewsForWindow, pageViewsSummaryForWindow, ajaxCallsForWindow, ajaxSummaryForWindow,
  webVitalsForWindow, webVitalsSummaryForWindow, browserErrorSeriesForWindow, browserErrorGroupsForWindow,
  browserEndpointOptions, browserErrorOptions, browserTracesForWindow, browserTraceRows, browserExceptionFor,
  browserGroupSampleTrace,
} from './browser.js'

// Pinned to a half-hour boundary so the exact-value assertions read the same
// windows, bucket edges included, on every run (errors.test.js does the same).
// One test below runs on the real clock.
const OFF_SEC = -new Date(BASE_TIME).getTimezoneOffset() * 60
const BASE_SEC = Math.floor(BASE_TIME.getTime() / 1000)
const nowMs = (BASE_SEC - ((BASE_SEC - OFF_SEC) % 1800)) * 1000
const preset = v => (v === '1h' ? REFERENCE_WINDOW : resolveWindow({ kind: 'preset', value: v }, nowMs))
const quietWindow = () => resolveWindow({
  kind: 'absolute',
  from: BASE_TIME.getTime() - 180 * 60000,
  to: BASE_TIME.getTime() - (INCIDENT_START_MIN + 15) * 60000,
})

const WEB = 'cubedemo-web'
const ADMIN = 'cubedemo-admin'
const APPS = [WEB, ADMIN]
const KINDS = ['server', 'client']
const total = rows => rows.reduce((a, r) => a + r.count, 0)
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol * Math.abs(b), `${msg}: ${a} vs ${b} (±${tol * 100}%)`)
const incidentStartMs = win => (win.nowSec - INCIDENT_START_MIN * 60) * 1000

const CHECKOUT = '/checkout'
const WISHLIST = '/account/:userId/wishlist'
const WEALTH = 'GET search.cubedemo.com:443/v1/search/wealth'
const POST_PAYMENTS = 'POST payment.cubedemo.com:443/v1/payments'

// Production's Browser page for cubedemo-web, as the user's link shows it.
// [route, rpm, median ms, avg ms]
const WEB_PAGES = [
  ['/product/:sku', 94.08, 1180, 1180],
  ['/', 78.33, 981.88, 981.74],
  ['/search', 62.71, 1470, 1470],
  ['/cart', 39.24, 883.55, 883.62],
  ['/orders', 31.37, 1280, 1280],
  ['/orders/:orderId', 31.34, 1570, 1570],
  [CHECKOUT, 23.49, 1970, 1960],
  [WISHLIST, 15.74, 1380, 1370],
  ['/shipments/:trackingId/track', 15.65, 1770, 1770],
  ['/category/home', 9.45, 1080, 1080],
  ['/category/apparel', 9.44, 1080, 1080],
  ['/category/grocery', 9.4, 1080, 1080],
  ['/category/footwear', 9.39, 1080, 1080],
  ['/category/audio', 9.39, 1080, 1080],
]
// [endpoint, rpm, avg ms, error %, on the incident path]
const WEB_CALLS = [
  ['GET order.cubedemo.com:443/v1/orders', 66.48, 229.76, 5, true],
  ['GET order.cubedemo.com:443/v1/orders/:orderId', 38.52, 228.97, 4.98, true],
  ['GET payment.cubedemo.com:443/v1/payments', 87.12, 229.43, 5.02, true],
  ['GET payment.cubedemo.com:443/v1/payments/:paymentId', 28.27, 228.9, 5.06, true],
  ['GET search.cubedemo.com:443/v1/search/fame', 110.89, 229.37, 5.03, false],
  ['GET search.cubedemo.com:443/v1/search/happiness', 110.53, 229.46, 5.03, false],
  ['GET search.cubedemo.com:443/v1/search/success', 110.69, 229.57, 4.98, false],
  [WEALTH, 110.55, 229.51, 4.98, false],
  ['GET shipment.cubedemo.com:443/v1/shipments/:trackingId/tracking', 62.05, 229.93, 4.95, true],
  ['POST order.cubedemo.com:443/v1/orders', 28.24, 229.74, 4.96, true],
  [POST_PAYMENTS, 28.29, 229.38, 4.92, true],
]
// [route, LCP ms, INP ms, CLS]
const WEB_VITALS = [
  ['/product/:sku', 4550, 176.66, 0.28],
  ['/', 1840, 108.16, 0.03],
  ['/search', 2210, 162.97, 0.06],
  ['/cart', 1600, 149.13, 0.03],
  ['/orders', 1970, 121.82, 0.04],
  ['/orders/:orderId', 2090, 135.43, 0.06],
  [CHECKOUT, 2210, 569.73, 0.04],
  [WISHLIST, 2210, 149.58, 0.07],
  ['/shipments/:trackingId/track', 2340, 163.19, 0.08],
  ['/category/home', 2100, 135.99, 0.07],
  ['/category/apparel', 2090, 135.59, 0.07],
  ['/category/grocery', 2090, 136.22, 0.07],
  ['/category/footwear', 2080, 136.01, 0.07],
  ['/category/audio', 2090, 135.8, 0.07],
]
// Script errors over production's week, where its top ten rows say (a
// TypeError count over the TypeError share); the rest at ~9.65% of views.
const WEB_SCRIPT_7D = { '/product/:sku': 91490, '/': 76077, '/search': 61103, '/cart': 37824, '/orders': 31220 }
const scriptPerMin = ([route, rpm]) => (WEB_SCRIPT_7D[route] != null ? WEB_SCRIPT_7D[route] / 10080 : rpm * 0.0965)

// The back office's own figures: [route, rpm, median, avg, lcp, inp, cls].
const ADMIN_PAGES = [
  ['/dashboard', 4.2, 1240, 1310, 1720, 96.4, 0.02],
  ['/orders', 3.6, 1120, 1180, 1580, 112.3, 0.03],
  ['/orders/:orderId', 2.9, 980, 1040, 1450, 104.7, 0.02],
  ['/refunds', 0.8, 1060, 1110, 1510, 118.2, 0.04],
  ['/customers/:customerId', 1.4, 940, 990, 1390, 92.8, 0.01],
  ['/reports/sales', 0.6, 1890, 2030, 2240, 168.5, 0.05],
]
const ADMIN_CALLS = [
  ['GET order.cubedemo.com:443/v1/orders', 6.2, 212.4, 0.31, true],
  ['GET order.cubedemo.com:443/v1/orders/:orderId', 4.1, 198.7, 0.27, true],
  ['GET analytics.cubedemo.com:443/v1/reports/sales', 1.8, 342.6, 0.12, false],
  ['POST notify.cubedemo.com:443/v1/notify', 0.9, 156.3, 0.4, false],
]

/* ---- calibration ---- */

test('the reference hour reproduces every published page-view figure off the incident path', () => {
  const web = pageViewsForWindow(REFERENCE_WINDOW, WEB).rows
  assert.deepEqual(web.map(r => r.endpoint), WEB_PAGES.map(p => p[0]))
  WEB_PAGES.forEach(([route, rpm, median, avg], i) => {
    assert.equal(web[i].rpm, rpm, `${route} rpm`)
    // The checkout's median is the percentile cliff's quiet side: a third of
    // the hour's loads were slow, so the 50th percentile is still a quiet one.
    assert.equal(web[i].median, median, `${route} median`)
    if (route !== CHECKOUT) assert.equal(web[i].avg, avg, `${route} avg`)
  })
  const admin = pageViewsForWindow(REFERENCE_WINDOW, ADMIN).rows
  assert.deepEqual(admin, ADMIN_PAGES.map(([endpoint, rpm, median, avg]) => ({ endpoint, rpm, median, avg })))
})

test('the reference hour reproduces every published call figure off the incident path', () => {
  for (const [app, table] of [[WEB, WEB_CALLS], [ADMIN, ADMIN_CALLS]]) {
    const rows = ajaxCallsForWindow(REFERENCE_WINDOW, app).rows
    assert.deepEqual(rows.map(r => r.endpoint), table.map(c => c[0]))
    table.forEach(([endpoint, rpm, avg, errPct, onPath], i) => {
      assert.equal(rows[i].rpm, rpm, `${endpoint} rpm`)
      if (onPath) return
      assert.equal(rows[i].avg, avg, `${endpoint} avg`)
      assert.equal(rows[i].errPct, errPct, `${endpoint} err%`)
    })
  }
  const services = Object.fromEntries(ajaxCallsForWindow(REFERENCE_WINDOW, WEB).rows.map(r => [r.endpoint, r.service]))
  assert.equal(services[POST_PAYMENTS], 'payment-service')
  assert.equal(services[WEALTH], 'search-service')
})

test('the reference hour reproduces every published web vital, rated through the vitals scale', () => {
  const web = webVitalsForWindow(REFERENCE_WINDOW, WEB).rows
  WEB_VITALS.forEach(([route, lcp, inp, cls], i) => {
    assert.equal(web[i].route, route)
    assert.equal(web[i].endpoint, `https://shop.cubedemo.com${route}`)
    assert.equal(web[i].lcp, lcp, `${route} lcp`)
    assert.equal(web[i].cls, cls, `${route} cls`)
    if (route !== CHECKOUT) assert.equal(web[i].inp, inp, `${route} inp`)
  })
  const admin = webVitalsForWindow(REFERENCE_WINDOW, ADMIN).rows
  ADMIN_PAGES.forEach(([route, , , , lcp, inp, cls], i) => {
    assert.deepEqual([admin[i].lcp, admin[i].inp, admin[i].cls], [lcp, inp, cls], route)
    assert.equal(admin[i].status.worst, 'healthy', `${route}: the back office's pages are all good`)
  })
  for (const r of [...web, ...admin]) {
    for (const k of ['lcp', 'inp', 'cls']) assert.equal(r.status[k], statusForWebVital(k, r[k]), `${r.endpoint} ${k}`)
  }
  const product = web.find(r => r.route === '/product/:sku')
  assert.equal(product.status.lcp, 'critical')
  assert.equal(product.status.worst, 'critical')
})

test('a window that never saw the incident reads production\'s figures on every row', () => {
  for (const win of [quietWindow(), preset('7d')]) {
    const pv = pageViewsForWindow(win, WEB).rows
    WEB_PAGES.forEach(([route, , median, avg], i) => {
      near(pv[i].median, median, 0.06, `${win.label} ${route} median`)
      near(pv[i].avg, avg, 0.05, `${win.label} ${route} avg`)
    })
    const calls = ajaxCallsForWindow(win, WEB).rows
    WEB_CALLS.forEach(([endpoint, , avg, errPct], i) => {
      near(calls[i].avg, avg, 0.05, `${win.label} ${endpoint} avg`)
      near(calls[i].errPct, errPct, 0.06, `${win.label} ${endpoint} err%`)
    })
    const vitals = webVitalsForWindow(win, WEB).rows
    WEB_VITALS.forEach(([route, lcp, inp, cls], i) => {
      near(vitals[i].lcp, lcp, 0.04, `${win.label} ${route} lcp`)
      near(vitals[i].inp, inp, 0.04, `${win.label} ${route} inp`)
      near(vitals[i].cls, cls, 0.06, `${win.label} ${route} cls`)
    })
  }
})

/* ---- the incident, through the backend ---- */

const deltaAt = (p, w) => valueAtWeight(p, w) - valueAtWeight(p, 0)
const redErr = endpoint => errorRateProfiles('red').find(p => p.endpoint === endpoint).err

// The backend each coupled call inherits its incident from: its service's
// latency, and the error rate of the RED endpoint it lands on where
// payment-service publishes one, else the service's.
const backends = () => {
  const svc = id => [id, serviceProfile(id).err]
  return {
    [WEB]: {
      'GET order.cubedemo.com:443/v1/orders': svc('order-service'),
      'GET order.cubedemo.com:443/v1/orders/:orderId': svc('order-service'),
      'GET payment.cubedemo.com:443/v1/payments': svc('payment-service'),
      'GET payment.cubedemo.com:443/v1/payments/:paymentId': ['payment-service', redErr('GET /v1/payments/:id')],
      'GET shipment.cubedemo.com:443/v1/shipments/:trackingId/tracking': svc('shipment-service'),
      'POST order.cubedemo.com:443/v1/orders': svc('order-service'),
      [POST_PAYMENTS]: ['payment-service', redErr('POST /v1/payments')],
    },
    [ADMIN]: {
      'GET order.cubedemo.com:443/v1/orders': svc('order-service'),
      'GET order.cubedemo.com:443/v1/orders/:orderId': svc('order-service'),
    },
  }
}

test('a browser call rises by exactly the points and milliseconds its backend rose, at every incident weight', () => {
  const BACKENDS = backends()
  for (const app of APPS) {
    for (const row of browserProfiles(app).ajax) {
      const backend = BACKENDS[app][row.endpoint]
      for (const w of [0.125, 0.5, 1]) {
        if (!backend) {
          assert.equal(deltaAt(row.err, w), 0, `${app} ${row.endpoint}: off the incident path, flat`)
          assert.equal(deltaAt(row.avg, w), 0, `${app} ${row.endpoint}: off the incident path, flat`)
          continue
        }
        const [service, err] = backend
        assert.equal(row.service, service)
        near(deltaAt(row.err, w), deltaAt(err, w), 1e-9, `${app} ${row.endpoint} err Δ at w=${w}`)
        near(deltaAt(row.avg, w), deltaAt(serviceProfile(service).avg, w), 1e-9, `${app} ${row.endpoint} latency Δ at w=${w}`)
      }
    }
  }
  // The pool's plateau, in the browser: POST payments fails ~23% of the time.
  const post = browserProfiles(WEB).ajax.find(r => r.endpoint === POST_PAYMENTS)
  assert.ok(valueAtWeight(post.err, 1) > 20, `${valueAtWeight(post.err, 1)}`)
  // The back office's worst call stays under the error-rate scale's critical line.
  for (const row of browserProfiles(ADMIN).ajax) assert.ok(valueAtWeight(row.err, 1) < 3, row.endpoint)
})

test('the checkout loads, and answers the Pay click, slower by what payment-service added', () => {
  const pay = serviceProfile('payment-service').avg
  const checkout = browserProfiles(WEB).routes.find(r => r.endpoint === CHECKOUT)
  for (const w of [0.125, 0.5, 1]) {
    near(deltaAt(checkout.avg, w), deltaAt(pay, w), 1e-9, `avg Δ at w=${w}`)
    near(deltaAt(checkout.inp, w), deltaAt(pay, w), 1e-9, `INP Δ at w=${w}`)
    near(deltaAt(checkout.median, w), deltaAt(pay, w), 0.005, `median Δ at w=${w}`)
  }
  for (const r of browserProfiles(WEB).routes.filter(x => x.endpoint !== CHECKOUT)) {
    for (const k of ['median', 'avg', 'lcp', 'inp', 'cls', 'jsErr']) assert.equal(deltaAt(r[k], 1), 0, `${r.endpoint} ${k}`)
  }

  // Read over windows: the average carries the backend's hour, the median
  // keeps the quiet value until the window is narrow enough for slow loads to
  // be most of it — the percentile cliff, from the other side.
  const row = win => pageViewsForWindow(win, WEB).rows.find(r => r.endpoint === CHECKOUT)
  const payHour = windowMean(REFERENCE_WINDOW, pay) - valueAtWeight(pay, 0)
  near(row(REFERENCE_WINDOW).avg, 1960 + payHour, 0.03, '1h avg = quiet + the backend\'s hour')
  assert.equal(row(REFERENCE_WINDOW).median, 1970)
  for (const v of ['5m', '15m']) {
    assert.ok(row(preset(v)).median > 1970 + 0.7 * deltaAt(pay, 1), `${v} median ${row(preset(v)).median}`)
    assert.ok(row(preset(v)).avg > 1960 + 0.7 * deltaAt(pay, 1), `${v} avg ${row(preset(v)).avg}`)
  }
  near(row(preset('7d')).avg, 1960, 0.03, 'a week dilutes it away')
  const inp = webVitalsForWindow(preset('15m'), WEB).rows.find(r => r.route === CHECKOUT).inp
  assert.ok(inp > 569.73 + 0.7 * deltaAt(pay, 1), `15m INP ${inp}`)
})

// Two halves. Noise aside, the browser's call and payment-service's endpoint
// must move by the same amount in every bucket of every range — so both are
// drawn with their jitter switched off and compared bucket by bucket. And the
// series the chart actually draws must sit at its quiet value wherever the
// incident was not and well above it wherever the incident was. (Comparing
// where two noisy series first cross a threshold instead flakes: the
// incident's first, partial bucket can land either side of it.)
test('a payment call fails and slows in the same minutes payment-service does, on every range', () => {
  const post = browserProfiles(WEB).ajax.find(r => r.endpoint === POST_PAYMENTS)
  const redPost = redErr('POST /v1/payments')
  const pay = serviceProfile('payment-service').avg
  const i = WEB_CALLS.findIndex(c => c[0] === POST_PAYMENTS)
  const still = p => ({ ...p, noise: 0 })
  for (const v of ['1h', '15m', '6h', '7d']) {
    const win = preset(v)
    for (const [browser, backend, key] of [[post.err, redPost, 'errPct'], [post.avg, pay, 'avg']]) {
      const b = windowSeries(win, still(browser), { round: 6 })
      const r = windowSeries(win, still(backend), { round: 6 })
      b.forEach((p, j) => {
        if (p.value == null) return
        const moved = p.value - valueAtWeight(browser, 0)
        const want = r[j].value - valueAtWeight(backend, 0)
        assert.ok(Math.abs(moved - want) < 1e-4 * Math.max(1, Math.abs(want)), `${v} ${key} bucket ${j}: ${moved} vs ${want}`)
      })
      const drawn = ajaxCallsForWindow(win, WEB).series[key][i].series
      const quiet = valueAtWeight(browser, 0)
      const plateau = deltaAt(browser, 1)
      let raised = 0
      win.buckets.forEach((bk, j) => {
        if (bk.future) return
        if (bk.w === 0) assert.ok(drawn[j].value <= quiet * 1.07, `${v} ${key} bucket ${j}: ${drawn[j].value} with no incident`)
        if (bk.w >= 0.5) {
          raised++
          assert.ok(drawn[j].value > quiet + 0.4 * plateau, `${v} ${key} bucket ${j}: ${drawn[j].value} inside the incident`)
        }
      })
      if (v === '1h' || v === '15m') assert.ok(raised > 0, `${v}: the incident is in the window`)
    }
  }
})

test('the app list is worst first, and the back office goes to warning with the incident and no further', () => {
  const ranks = { healthy: 0, warning: 1, critical: 2 }
  for (const v of ['5m', '15m', '1h', '6h', '24h', '7d', 'today']) {
    const apps = browserAppsForWindow(preset(v))
    assert.deepEqual(apps.map(a => a.id), [WEB, ADMIN], v)
    for (let k = 1; k < apps.length; k++) assert.ok(ranks[apps[k - 1].status] >= ranks[apps[k].status], v)
    const [web, admin] = apps
    // Production's own calls fail ~5% all week and its product page paints in
    // 4.55 s: that is critical with or without the incident.
    assert.equal(web.status, 'critical', v)
    assert.equal(admin.status, 'warning', `${v}: the window holds the incident`)
    assert.notEqual(admin.aggregateStatus, 'critical', v)
    for (const a of apps) {
      assert.equal(a.language, 'web')
      assert.equal(a.origin, BROWSER_APPS.find(x => x.id === a.id).origin)
    }
  }
  assert.equal(browserAppsForWindow(preset('1h'))[1].aggregateStatus, 'healthy', 'its hour averages back to healthy')
  const quiet = browserAppsForWindow(quietWindow())
  assert.deepEqual(quiet.map(a => [a.id, a.status, a.aggregateStatus]), [[WEB, 'critical', 'critical'], [ADMIN, 'healthy', 'healthy']])
  // On the real clock too: a trailing week reaches now, and so the incident.
  assert.equal(browserAppsForWindow(resolveWindow({ kind: 'preset', value: '7d' }))[1].status, 'warning')
})

/* ---- counts ---- */

test('every series and group adds up, bucket by bucket, in whole errors, and a bucket still to come is null', () => {
  for (const v of ['15m', '1h', '7d', 'today']) {
    const win = preset(v)
    for (const app of APPS) {
      for (const kind of KINDS) {
        const rows = browserErrorSeriesForWindow(win, app, kind)
        for (const r of rows) {
          assert.equal(r.series.length, win.buckets.length)
          r.series.forEach((p, i) => {
            if (win.buckets[i].future) assert.equal(p.value, null, `${v} ${r.id} future`)
            else assert.ok(Number.isInteger(p.value) && p.value >= 0, `${v} ${r.id} ${p.value}`)
          })
          assert.equal(r.series.reduce((a, p) => a + (p.value ?? 0), 0), r.count, `${v} ${r.id}`)
          assert.ok(Number.isInteger(r.prevCount) && r.prevCount >= 0, `${v} ${r.id} prev`)
        }
        const groups = browserErrorGroupsForWindow(win, app, kind)
        assert.equal(total(groups), total(rows), `${v} ${app} ${kind}`)
        for (const g of groups) {
          assert.equal(g.series.reduce((a, p) => a + (p.value ?? 0), 0), g.count, `${v} ${g.id}`)
          assert.equal(g.side, kind)
          assert.equal(g.service, app)
          assert.equal(typeof g.exception, 'string')
          assert.ok(g.firstSeenMs <= g.lastSeenMs, g.id)
        }
        for (let k = 1; k < groups.length; k++) assert.ok(groups[k - 1].count >= groups[k].count, 'count desc')
      }
    }
  }
})

test('the reference hour counts each route\'s and each call\'s errors off the published rates', () => {
  const byEndpoint = (app, kind) => {
    const m = new Map()
    for (const g of browserErrorGroupsForWindow(REFERENCE_WINDOW, app, kind)) m.set(g.endpoint, (m.get(g.endpoint) ?? 0) + g.count)
    return m
  }
  const script = byEndpoint(WEB, 'server')
  for (const p of WEB_PAGES) {
    if (p[0] === CHECKOUT) continue
    assert.equal(script.get(p[0]) ?? 0, Math.round(scriptPerMin(p) * 60), p[0])
  }
  assert.equal(Math.round(scriptPerMin(WEB_PAGES[0]) * 60), 545, "/product/:sku's 91,490 a week, an hour of it")
  const calls = byEndpoint(WEB, 'client')
  for (const [endpoint, rpm, , errPct, onPath] of WEB_CALLS) {
    if (!onPath) assert.equal(calls.get(endpoint), Math.round(rpm * errPct * 0.6), endpoint)
  }
  const adminScript = byEndpoint(ADMIN, 'server')
  for (const [route, rpm] of ADMIN_PAGES) assert.equal(adminScript.get(route) ?? 0, Math.round(rpm * 0.012 * 60), route)
})

test('the catalog is production\'s 42 script and 22 ajax rows, and the incident adds its own', () => {
  const keys = (win, kind) => new Set(browserErrorGroupsForWindow(win, WEB, kind).map(g => `${g.endpoint} ${g.exception}`))
  for (const v of ['1h', '7d']) {
    const win = preset(v)
    const script = keys(win, 'server')
    assert.equal(script.size, 42, v)
    for (const [route] of WEB_PAGES) for (const t of ['TypeError', 'NetworkError', 'RangeError']) assert.ok(script.has(`${route} ${t}`), `${v} ${route} ${t}`)
    const ajax = keys(win, 'client')
    for (const [endpoint] of WEB_CALLS) for (const c of ['404', '500']) assert.ok(ajax.has(`${endpoint} ${c}`), `${v} ${endpoint} ${c}`)
    // The pool's 503s on payment calls, order- and shipment-service's 502s.
    const extra = [...ajax].filter(k => / 50[23]$/.test(k))
    assert.equal(extra.length, 7, `${v}: ${extra.join(', ')}`)
    assert.equal(ajax.size, 29, v)
    assert.ok(script.has(`${WISHLIST} TypeError`) && ajax.has(`${WEALTH} 404`), 'the user\'s two links')
  }
  const quiet = quietWindow()
  assert.ok(![...keys(quiet, 'client')].some(k => / 50[23]$/.test(k)), 'no incident codes before the incident')
  const checkout = win => browserErrorGroupsForWindow(win, WEB, 'server').find(g => g.endpoint === CHECKOUT && g.exception === 'TypeError')
  assert.match(checkout(quiet).message, /shippingAddress/)
  // Narrow the range and the pool's TypeError is the checkout's top error;
  // widen it and the one it shares a row with all week takes over.
  assert.match(checkout(REFERENCE_WINDOW).message, /clientSecret/)
  assert.match(checkout(preset('7d')).message, /shippingAddress/)
  assert.ok(checkout(REFERENCE_WINDOW).count > checkout(REFERENCE_WINDOW).prevCount)
  for (const g of browserErrorGroupsForWindow(REFERENCE_WINDOW, WEB, 'client').filter(x => x.exception === '503')) {
    assert.equal(g.prevCount, 0, g.id)
    assert.equal(g.isNew, true, g.id)
    assert.ok(g.firstSeenMs >= incidentStartMs(REFERENCE_WINDOW) - 60000, `${g.id}: first seen with the incident`)
  }
  const week = preset('7d')
  for (const g of browserErrorGroupsForWindow(week, WEB, 'client').filter(x => x.exception === '503')) {
    assert.equal(g.firstSeenMs, incidentStartMs(week), `${g.id}: not the opening edge of a three-hour bucket`)
  }
  assert.equal(browserErrorGroupsForWindow(REFERENCE_WINDOW, WEB, 'client').find(g => g.exception === '503').message, 'Service Unavailable')
})

const regimeOf = row => row.id.split('|')[4]

test('every checkout clientSecret TypeError is a create-payment call the pool failed, and the browser never fails more calls than payment-service', () => {
  const POOL = 'redis.clients.jedis.exceptions.JedisPoolException'
  for (const v of ['15m', '1h', '7d']) {
    const win = preset(v)
    const mirror = browserErrorSeriesForWindow(win, WEB, 'server').find(r => r.id.endsWith('|clientSecret'))
    const failed = browserErrorSeriesForWindow(win, WEB, 'client')
      .filter(r => r.endpoint === POST_PAYMENTS && regimeOf(r) === 'incident' && Number(r.exception) >= 500)
    assert.ok(mirror && failed.length === 2, v)
    mirror.series.forEach((p, i) => assert.equal(p.value, failed.reduce((a, r) => a + r.series[i].value, 0), `${v} bucket ${i}`))

    const backend = errorSeriesForWindow(win, 'server').filter(r => r.service === 'payment-service' && r.exception === POOL)
    const pool = endpoint => total(backend.filter(r => endpoint == null || r.endpoint === endpoint))
    const browser = endpoint => total(browserErrorSeriesForWindow(win, WEB, 'client').filter(r => r.endpoint === endpoint && regimeOf(r) === 'incident'))
    assert.ok(browser(POST_PAYMENTS) > 0, v)
    assert.ok(browser(POST_PAYMENTS) <= pool('POST /v1/payments'), `${v}: ${browser(POST_PAYMENTS)} vs ${pool('POST /v1/payments')}`)
    const byId = 'GET payment.cubedemo.com:443/v1/payments/:paymentId'
    assert.ok(browser(byId) <= pool('GET /v1/payments/:id'), `${v}: ${browser(byId)} vs ${pool('GET /v1/payments/:id')}`)
    const list = 'GET payment.cubedemo.com:443/v1/payments'
    assert.ok(browser(list) <= pool(), `${v}: ${browser(list)} vs ${pool()}`)
  }
})

/* ---- samples ---- */

const LINKS = [
  { kind: 'server', endpoint: WISHLIST, error: 'TypeError' },
  { kind: 'client', endpoint: WEALTH, error: '404' },
]

test('the two links production hands out open traces at 1h and at 7d, each the request it names', () => {
  for (const v of ['1h', '7d']) {
    const win = preset(v)
    for (const f of LINKS) {
      const rows = browserTracesForWindow(win, WEB, f)
      assert.equal(rows.length, 10, `${v} ${f.endpoint}`)
      for (const r of rows) {
        assert.equal(r.endpoint, f.endpoint)
        assert.equal(r.status, 'error')
        const t = buildTrace(r.traceId)
        assert.ok(t, r.traceId)
        assert.equal(t.root.name, f.endpoint)
        assert.equal(t.root.service, WEB)
        assert.equal(t.root.status, 'error')
        assert.equal(t.root.duration, r.latencyMs)
        assert.equal(t.startTime.getTime(), r.timeMs)
        if (f.kind === 'server') {
          assert.equal(t.root.kind, 'server')
          assert.equal(t.root.exception.type, 'TypeError')
          assert.equal(r.exception, 'TypeError')
          assert.equal(r.method, null)
          assert.equal(r.httpStatus, null)
        } else {
          assert.equal(t.root.kind, 'client')
          assert.equal(t.root.httpStatus, '404')
          assert.equal(t.root.exception, null, 'a failed fetch is a status, not an exception')
          assert.equal(r.httpStatus, '404')
          assert.equal(r.method, 'GET')
          assert.equal(r.exception, null)
          // search-service answered it: a 404 leaves a server span's status unset.
          const backend = t.spans.find(s => s.service === 'search-service')
          assert.equal(backend.parentId, t.root.id)
          assert.equal(backend.httpStatus, '404')
          assert.equal(backend.status, 'ok')
        }
      }
    }
  }
})

test('an error\'s samples sit in buckets that hold it, newest first, and an incident code never predates the incident', () => {
  for (const v of ['1h', '7d', 'today']) {
    const win = preset(v)
    const endMs = Math.min(win.end, win.nowSec) * 1000
    for (const app of APPS) {
      for (const kind of KINDS) {
        for (const g of browserErrorGroupsForWindow(win, app, kind)) {
          const rows = browserTracesForWindow(win, app, { kind, endpoint: g.endpoint, error: g.exception, limit: 20 })
          assert.equal(rows.length, Math.min(20, g.count), `${v} ${g.id}`)
          rows.forEach((r, k) => {
            if (k > 0) assert.ok(rows[k - 1].timeMs >= r.timeMs, `${v} ${g.id}: newest first`)
            assert.ok(r.timeMs >= win.start * 1000 && r.timeMs < endMs, `${v} ${g.id}: inside the window`)
            const i = bucketIndexOf(win, r.timeMs)
            assert.ok(g.series[i].value > 0, `${v} ${g.id}: a sample in a bucket without the error`)
            if (g.exception === '503' || g.exception === '502') {
              assert.ok(r.timeMs >= incidentStartMs(win), `${v} ${g.id}: ${new Date(r.timeMs).toISOString()} predates the incident`)
            }
          })
          assert.equal(new Set(rows.map(r => r.traceId)).size, rows.length, `${v} ${g.id}: unique`)
        }
      }
    }
  }
})

// /checkout's TypeError group holds two messages: the page's own slip and the
// incident's clientSecret one. From two hours up the row reads the quiet one,
// while the newest error is the incident's, and a sample of the whole group
// would open a stack for a message the row never showed.
test('the Errors tab\'s sample is the exception its row names, and the Traces tab\'s first row when the group says one thing', () => {
  let mixed = 0
  for (const v of ['1h', '2h', '6h', '7d', 'today']) {
    const win = preset(v)
    for (const app of APPS) {
      for (const kind of KINDS) {
        const series = browserErrorSeriesForWindow(win, app, kind)
        for (const g of browserErrorGroupsForWindow(win, app, kind)) {
          const id = browserGroupSampleTrace(win, app, g)
          const at = `${v} ${g.id}`
          const own = series.filter(r => g.seriesIds.includes(r.id))
          const messages = new Set(own.map(r => r.message))
          const [first] = browserTracesForWindow(win, app, { kind, endpoint: g.endpoint, error: g.exception, limit: 5 })
          if (messages.size === 1) assert.equal(id, first.traceId, at)
          else mixed++
          const t = buildTrace(id)
          assert.equal(t.root.name, g.endpoint, at)
          // Sampled from a bucket where the row's own message was thrown.
          const i = bucketIndexOf(win, t.startTime.getTime())
          assert.ok(own.some(r => r.message === g.message && r.series[i]?.value > 0), `${at}: sampled where the row's message is`)
          const ex = browserExceptionFor(id)
          if (kind === 'client') { assert.equal(ex, null, at); continue }
          assert.equal(ex.type, g.exception, at)
          assert.equal(ex.message, g.message, `${at}: the modal opens on the message the row shows`)
          assert.equal(t.root.exception.message, ex.message, at)
        }
      }
    }
  }
  assert.ok(mixed >= 5, `a two-message group at every range (${mixed})`)
  assert.equal(browserGroupSampleTrace(REFERENCE_WINDOW, WEB, null), null)
})

test('an unfiltered list is mostly clean requests, spread across the window, and each opens as listed', () => {
  for (const v of ['1h', '7d']) {
    const win = preset(v)
    for (const app of APPS) {
      for (const kind of KINDS) {
        const rows = browserTracesForWindow(win, app, { kind, limit: 100 })
        assert.equal(rows.length, 100, `${v} ${app} ${kind}`)
        assert.equal(new Set(rows.map(r => r.traceId)).size, 100)
        const ok = rows.filter(r => r.status === 'ok')
        assert.ok(ok.length >= 70, `${v} ${app} ${kind}: ${ok.length} clean`)
        const endpoints = browserEndpointOptions(app, kind)
        for (const r of rows) {
          assert.ok(endpoints.includes(r.endpoint), r.endpoint)
          assert.ok(r.timeMs >= win.start * 1000 && r.timeMs < Math.min(win.end, win.nowSec) * 1000)
          if (kind === 'client') assert.equal(r.httpStatus, r.status === 'ok' ? '200' : r.httpStatus)
          if (r.httpStatus === '503' || r.httpStatus === '502') assert.ok(r.timeMs >= incidentStartMs(win), `${v} ${r.traceId}`)
          const t = buildTrace(r.traceId)
          assert.equal(t.root.name, r.endpoint)
          assert.equal(t.root.status, r.status)
        }
        // Ten is an even pick of the hundred: the newest first.
        const ten = browserTracesForWindow(win, app, { kind, limit: 10 })
        assert.equal(ten[0].traceId, rows[0].traceId)
        assert.ok(ten.every(r => rows.some(x => x.traceId === r.traceId)))
      }
    }
    const one = browserTracesForWindow(win, WEB, { kind: 'client', endpoint: WEALTH, limit: 20 })
    assert.ok(one.length === 20 && one.every(r => r.endpoint === WEALTH))
  }
  assert.deepEqual(browserTracesForWindow(REFERENCE_WINDOW, WEB, { kind: 'client', endpoint: WISHLIST }), [], 'a route is not a call')
  assert.deepEqual(browserTracesForWindow(REFERENCE_WINDOW, WEB, { kind: 'server', error: '404' }), [], 'a status is not a script error')
  assert.deepEqual(browserTracesForWindow(REFERENCE_WINDOW, 'nope'), [])
})

test('a browser trace is a browser\'s: no JVM on its spans, and its own row and span ids', () => {
  const page = browserTracesForWindow(REFERENCE_WINDOW, WEB, { kind: 'server', endpoint: CHECKOUT, error: 'TypeError' })
  const call = browserTracesForWindow(REFERENCE_WINDOW, WEB, LINKS[1])
  for (const id of [...page, ...call].map(r => r.traceId)) {
    const rows = browserTraceRows(id)
    assert.ok(rows.length >= 1)
    assert.equal(new Set(rows.map(r => r.id)).size, rows.length)
    for (const r of rows) {
      assert.ok(r.id.startsWith(`brw_${id}_`), r.id)
      assert.match(r.spanId, /^[0-9a-f]{16}$/)
      assert.equal(r.traceId, id)
      if (r.service !== WEB) continue
      assert.equal(r.tags['_resource.telemetry.sdk.language'], 'webjs')
      assert.equal(r.tags['host.name'], '')
      for (const [k, val] of Object.entries(r.tags)) {
        if (k.startsWith('_resource.process.')) assert.equal(val, '', `${k} on a browser span`)
      }
    }
    const t = buildTrace(id)
    for (const s of t.spans.filter(x => x.service === WEB)) {
      assert.equal(s.tags['telemetry.sdk.language'], 'webjs')
      for (const k of ['k8s.pod.name', 'process.executable.name', 'exception.stacktrace.unminified', 'rum.kind', 'host.name']) {
        assert.equal(s.tags[k], undefined, `${k} on ${s.name}`)
      }
      assert.ok(s.tags['session.id'] && s.tags['browser.name'] && s.tags['page.url'].startsWith('https://shop.cubedemo.com/'))
    }
  }
  // The pool's TypeError carries the call that caused it, and the pool behind that.
  const incidentPage = page.map(r => buildTrace(r.traceId)).find(t => /clientSecret/.test(t.root.exception.message))
  assert.ok(incidentPage, 'a clientSecret sample in the hour')
  const child = incidentPage.spans.find(s => s.parentId === incidentPage.root.id)
  assert.equal(child.name, POST_PAYMENTS)
  assert.ok(['500', '503'].includes(child.httpStatus))
  assert.ok(incidentPage.errors.some(s => s.service === 'payment-service' && /JedisPoolException/.test(s.exception.type)))
})

test('sample ids are trace ids, unique, and neither the Errors page nor the span stream decodes them, nor they theirs', () => {
  const seeded = new Set(spanRows.map(r => r.traceId))
  for (const r of spanRowsForWindow(preset('7d'))) seeded.add(r.traceId)
  const ids = new Set()
  for (const v of ['1h', '7d']) {
    const win = preset(v)
    for (const app of APPS) {
      for (const kind of KINDS) {
        for (const r of browserTracesForWindow(win, app, { kind, limit: 100 })) ids.add(r.traceId)
        for (const g of browserErrorGroupsForWindow(win, app, kind).slice(0, 6)) {
          for (const r of browserTracesForWindow(win, app, { kind, endpoint: g.endpoint, error: g.exception })) ids.add(r.traceId)
        }
      }
    }
  }
  assert.ok(ids.size > 500)
  for (const id of ids) {
    assert.match(id, /^[0-9a-f]{32}$/)
    assert.ok(!seeded.has(id), `${id} collides with a seeded trace`)
    assert.equal(errorTraceRows(id), null, `${id} decodes as an Errors-page sample`)
  }
  for (const side of KINDS) {
    for (const g of errorGroupsForWindow(REFERENCE_WINDOW, { side }).slice(0, 8)) {
      for (const s of errorSamplesFor(g, REFERENCE_WINDOW, 3)) {
        assert.equal(browserTraceRows(s.traceId), null, `${s.traceId} decodes as a browser sample`)
        assert.equal(browserExceptionFor(s.traceId), null)
      }
    }
  }
  for (const id of seeded) assert.equal(browserTraceRows(id), null)
  let x = 54321
  for (let i = 0; i < 200; i++) {
    let id = ''
    while (id.length < 32) { x = (x * 1103515245 + 12345) >>> 0; id += x.toString(16).padStart(8, '0') }
    assert.equal(browserTraceRows(id.slice(0, 32)), null)
  }
  for (const bad of ['not-a-trace', null, undefined, 42, '469567625']) assert.equal(browserTraceRows(bad), null)
})

// `/trace/<id>` is often the first thing a reload opens. Nothing the page did
// before may change what the id decodes to.
test('a browser trace decodes from its id alone, the same every time, whatever else has been opened', () => {
  const ids = [
    ...browserTracesForWindow(REFERENCE_WINDOW, WEB, LINKS[0]),
    ...browserTracesForWindow(REFERENCE_WINDOW, WEB, { kind: 'client', limit: 20 }),
    ...browserTracesForWindow(REFERENCE_WINDOW, WEB, { kind: 'server', endpoint: CHECKOUT, error: 'TypeError' }),
  ].map(r => r.traceId)
  const decoded = () => ids.map(id => JSON.stringify([browserTraceRows(id), browserExceptionFor(id)]))
  const before = decoded()
  assert.deepEqual(decoded(), before)
  for (const v of ['5m', '6h', 'today']) {
    const win = resolveWindow({ kind: 'preset', value: v })
    for (const app of APPS) {
      for (const kind of KINDS) {
        browserTracesForWindow(win, app, { kind, limit: 50 })
        browserErrorGroupsForWindow(win, app, kind)
      }
    }
    spanRowsForWindow(win)
    errorSeriesForWindow(win)
  }
  assert.deepEqual(decoded(), before)
  assert.deepEqual(buildTrace(ids[0]), buildTrace(ids[0]))
})

/* ---- exceptions ---- */

test('the error modal reads a minified stack, a source-mapped one, and what the agent recorded', () => {
  const mapped = new Set(BROWSER_SOURCE_MAP_SEED.map(m => m.sourceFile))
  assert.deepEqual(BROWSER_SOURCE_MAP_SEED.map(m => m.appId), APPS, 'one map per app')
  for (const app of APPS) {
    const origin = BROWSER_APPS.find(a => a.id === app).origin
    for (const g of browserErrorGroupsForWindow(preset('7d'), app, 'server')) {
      const ex = browserExceptionFor(browserGroupSampleTrace(preset('7d'), app, g))
      assert.equal(ex.type, g.exception)
      const [head, ...frames] = ex.stack.split('\n')
      assert.equal(head, `${ex.type}: ${ex.message}`)
      assert.ok(frames.length >= 1 && frames.length <= 10, `${g.id}: V8 keeps ten frames`)
      assert.ok(frames.every(f => /^ {4}at /.test(f)), g.id)
      assert.ok(frames.every(f => f.includes(`${origin}/`) || f.includes('(<anonymous>)')), `${g.id}: minified frames point into the bundles`)
      assert.ok(frames.every(f => !f.includes('src/')), `${g.id}: nothing source-mapped in the original`)
      assert.ok(ex.stack.includes(ex.bundle), g.id)
      assert.ok(mapped.has(ex.bundle), `${g.id}: a seeded map covers ${ex.bundle}`)
      const un = ex.unminified.split('\n')
      assert.equal(un[0], head)
      assert.equal(un.length, frames.length + 1)
      assert.ok(un.slice(1).some(f => / \(src\//.test(f)), `${g.id}: the app's own frames`)
      // (The head can name a URL: a ChunkLoadError's message is the chunk's.)
      assert.ok(un.slice(1).every(f => !f.includes(origin)), `${g.id}: no bundle frames left once mapped`)
      // Production's tags first (the event, the exception as recorded, its
      // stack as sent), then what the agent knew of the page and browser.
      assert.deepEqual(Object.keys(ex.attributes), [
        'event', 'exception.type', 'exception.message', 'exception.stacktrace',
        'page.url', 'browser.name', 'browser.version', 'os.name', 'device.type', 'session.id', 'app.release',
      ])
      assert.equal(ex.attributes.event, 'exception')
      assert.equal(ex.attributes['exception.stacktrace'], ex.stack)
      assert.ok(ex.attributes['page.url'].startsWith(origin), ex.attributes['page.url'])
      assert.equal(ex.attributes['exception.type'], ex.type)
      // Whose bundle it is, for the source-map gate.
      assert.equal(ex.appId, app)
    }
  }
  // The frame production's own modal shows.
  const cart = browserErrorGroupsForWindow(REFERENCE_WINDOW, WEB, 'server').find(g => g.endpoint === '/cart' && g.exception === 'TypeError')
  const ex = browserExceptionFor(browserGroupSampleTrace(REFERENCE_WINDOW, WEB, cart))
  assert.equal(ex.message, "Cannot read properties of undefined (reading 'total')")
  assert.equal(ex.unminified.split('\n')[1], '    at CartSummary (src/components/cart.js:118:22)')
  assert.match(ex.unminified.split('\n')[2], /^ {4}at renderWithHooks \(node_modules\/react-dom\//)
  assert.equal(buildTrace(browserGroupSampleTrace(REFERENCE_WINDOW, WEB, cart)).root.exception.stack, ex.stack)

  const clean = browserTracesForWindow(REFERENCE_WINDOW, WEB, { kind: 'server', limit: 100 }).find(r => r.status === 'ok')
  assert.equal(browserExceptionFor(clean.traceId), null, 'a clean page load threw nothing')
  assert.equal(browserExceptionFor(browserTracesForWindow(REFERENCE_WINDOW, WEB, LINKS[1])[0].traceId), null, 'a 404 is not an exception')
  assert.equal(browserExceptionFor('nope'), null)
})

/* ---- summaries, alignment, options ---- */

test('rows and every series line up index for index, and a series stops at now', () => {
  for (const win of [REFERENCE_WINDOW, preset('today')]) {
    for (const app of APPS) {
      for (const [{ rows, series }, keys] of [
        [pageViewsForWindow(win, app), ['rpm', 'median', 'avg']],
        [ajaxCallsForWindow(win, app), ['rpm', 'avg', 'errPct']],
        [webVitalsForWindow(win, app), ['lcp', 'inp', 'cls']],
      ]) {
        for (const k of keys) {
          assert.deepEqual(series[k].map(s => s.endpoint), rows.map(r => r.endpoint), `${app} ${k}`)
          for (const s of series[k]) {
            assert.equal(s.series.length, win.buckets.length)
            s.series.forEach((p, i) => assert.equal(p.value === null, win.buckets[i].future, `${app} ${k} ${i}`))
          }
        }
      }
    }
  }
  assert.deepEqual(pageViewsForWindow(REFERENCE_WINDOW, 'nope'), { rows: [], series: { rpm: [], median: [], avg: [] } })
})

test('the app-wide cards pool every row by its traffic, and carry the window before', () => {
  for (const v of ['1h', '7d']) {
    const win = preset(v)
    for (const app of APPS) {
      const pv = pageViewsSummaryForWindow(win, app)
      const rows = pageViewsForWindow(win, app).rows
      // The card rounds once and the rows each round: they can part by half a
      // cent a row.
      const sum = rows.reduce((a, r) => a + r.rpm, 0)
      assert.ok(Math.abs(pv.rpm - sum) <= 0.005 * (rows.length + 1), `${v} ${app} rpm: ${pv.rpm} vs ${sum}`)
      const avgs = rows.map(r => r.avg)
      assert.ok(pv.avg >= Math.min(...avgs) && pv.avg <= Math.max(...avgs))
      const aj = ajaxSummaryForWindow(win, app)
      const errs = ajaxCallsForWindow(win, app).rows.map(r => r.errPct)
      assert.ok(aj.errPct >= Math.min(...errs) && aj.errPct <= Math.max(...errs), `${v} ${app} err%`)
      const vit = webVitalsSummaryForWindow(win, app)
      for (const k of ['lcp', 'inp', 'cls']) assert.equal(vit.status[k], statusForWebVital(k, vit[k]), `${v} ${app} ${k}`)
      for (const s of [pv, aj, vit]) {
        for (const [k, val] of Object.entries(s.prev)) assert.ok(Number.isFinite(val) && val > 0, `${v} ${app} prev ${k}`)
        for (const series of Object.values(s.series)) assert.equal(series.length, win.buckets.length)
      }
    }
  }
  // Production shows ~2.6 s / ~160 ms / ~0.08 for the storefront overall.
  const vit = webVitalsSummaryForWindow(REFERENCE_WINDOW, WEB)
  assert.ok(vit.lcp > 2400 && vit.lcp < 2700, `${vit.lcp}`)
  assert.ok(vit.inp > 150 && vit.inp < 200, `${vit.inp}`)
  assert.ok(vit.cls > 0.07 && vit.cls < 0.11, `${vit.cls}`)
  // The hour before this one never saw the pool fail.
  const aj = ajaxSummaryForWindow(REFERENCE_WINDOW, WEB)
  assert.ok(aj.errPct > aj.prev.errPct + 0.5, `${aj.errPct} vs ${aj.prev.errPct}`)
  assert.equal(pageViewsSummaryForWindow(REFERENCE_WINDOW, 'nope'), null)
})

test('the filters offer what the window holds, most frequent first', () => {
  assert.deepEqual(browserEndpointOptions(WEB, 'server'), WEB_PAGES.map(p => p[0]))
  assert.deepEqual(browserEndpointOptions(WEB, 'client'), WEB_CALLS.map(c => c[0]))
  assert.deepEqual(browserEndpointOptions(ADMIN, 'client'), ADMIN_CALLS.map(c => c[0]))
  assert.deepEqual(browserEndpointOptions('nope', 'server'), [])
  assert.equal(browserErrorOptions(REFERENCE_WINDOW, WEB, 'server')[0], 'TypeError')
  assert.deepEqual([...browserErrorOptions(REFERENCE_WINDOW, WEB, 'server')].sort(), ['NetworkError', 'RangeError', 'TypeError'])
  assert.deepEqual(browserErrorOptions(REFERENCE_WINDOW, WEB, 'client', WEALTH), ['404', '500'])
  assert.deepEqual([...browserErrorOptions(REFERENCE_WINDOW, WEB, 'client', POST_PAYMENTS)].sort(), ['404', '500', '503'])
  assert.deepEqual([...browserErrorOptions(quietWindow(), WEB, 'client')].sort(), ['404', '500'])
  assert.deepEqual([...browserErrorOptions(preset('7d'), ADMIN, 'server')].sort(), ['ChunkLoadError', 'TypeError'])
})

test('the same window gives the same answers, built once', () => {
  const again = v => resolveWindow({ kind: 'preset', value: v }, nowMs)
  for (const v of ['15m', '7d']) {
    const a = again(v)
    const b = again(v)
    for (const app of APPS) {
      assert.deepEqual(pageViewsForWindow(a, app), pageViewsForWindow(b, app))
      assert.deepEqual(ajaxSummaryForWindow(a, app), ajaxSummaryForWindow(b, app))
      assert.deepEqual(webVitalsSummaryForWindow(a, app), webVitalsSummaryForWindow(b, app))
      for (const kind of KINDS) {
        assert.deepEqual(browserErrorGroupsForWindow(a, app, kind), browserErrorGroupsForWindow(b, app, kind))
        assert.deepEqual(browserTracesForWindow(a, app, { kind }), browserTracesForWindow(b, app, { kind }))
      }
    }
    assert.deepEqual(browserAppsForWindow(a), browserAppsForWindow(b))
    assert.equal(pageViewsForWindow(a, WEB), pageViewsForWindow(a, WEB), 'memoised per window')
    assert.equal(browserErrorGroupsForWindow(a, WEB, 'client'), browserErrorGroupsForWindow(a, WEB, 'client'))
  }
})

// A custom range wholly after the moment the demo was opened: the picker
// checks ranges against the clock, the data against BASE_TIME, so after the
// app has been open a while such a range can be picked, and nothing in it
// has happened yet. The page must say "nothing here", not baseline figures
// beside 0 ms load times rated Good.
test('a range none of whose time has happened yet measures nothing, and says so', () => {
  const base = BASE_TIME.getTime()
  const later = resolveWindow({ kind: 'absolute', from: base + 5 * 60000, to: base + 15 * 60000 })
  assert.equal(later.pastBuckets.length, 0)
  for (const app of APPS) {
    for (const read of [pageViewsForWindow, ajaxCallsForWindow, webVitalsForWindow]) {
      const { rows, series } = read(later, app)
      assert.deepEqual(rows, [], `${read.name} ${app}`)
      for (const list of Object.values(series)) assert.deepEqual(list, [])
    }
    assert.equal(pageViewsSummaryForWindow(later, app), null)
    assert.equal(ajaxSummaryForWindow(later, app), null)
    assert.equal(webVitalsSummaryForWindow(later, app), null)
    for (const kind of KINDS) {
      assert.deepEqual(browserErrorGroupsForWindow(later, app, kind), [])
      assert.deepEqual(browserTracesForWindow(later, app, { kind }), [])
    }
  }
  // The apps still list, in an order, for the picker.
  assert.equal(browserAppsForWindow(later).length, APPS.length)
})
