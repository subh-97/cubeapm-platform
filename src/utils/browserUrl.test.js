// The Browser page's URL: what a link lands on, and what the page writes back.
//
// Two contracts. A link copied out of the production Browser page has to land
// on the same app, tab and Traces filters here, leftovers and all. And what
// the page writes has to read back to the same state, in one spelling, because
// the page holds no other copy: it parses the address bar on every render and
// corrects it to browserSearch's spelling, which only settles if parsing that
// spelling gives the same spelling again.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TIME_PRESETS } from '@/utils/timeRange'
import { sameSearch } from '@/utils/searchParams'
import {
  BROWSER_PATH, BROWSER_TABS, DEFAULT_BROWSER_TAB, BROWSER_VIEWS, BROWSER_KINDS,
  parseBrowserSearch, browserSearch, browserUrl,
} from './browserUrl.js'

// The page's apps, most severe first, as the data module hands them out. Kept
// literal here so this test does not depend on the incident's current shape.
const APPS = ['cubedemo-web', 'cubedemo-admin']

const DEFAULTS = {
  service: 'cubedemo-web', tab: 'pageviews', view: 'graph', kind: 'server', endpoint: '', error: '', time: null,
}

// ---------- The user's link ----------

// Exactly as pasted out of production: the Errors page's `index` and `name`
// leaked into it, `refresh` is a timestamp, and `tab` comes near the end.
const USER_SEARCH = '?service=cubedemo-web&view=graph&index=cube%3Aerror&error=TypeError&name=POST+api.stripe.com%2Fv1%2Fpayment_intents&kind=server&time=7d&refresh=1791403390990&tab=pageviews&endpoint=%2Faccount%2F%3AuserId%2Fwishlist'

test('the production link lands on its app, tab, filters and range', () => {
  assert.deepEqual(parseBrowserSearch(USER_SEARCH, APPS), {
    service: 'cubedemo-web',
    tab: 'pageviews',
    view: 'graph',
    kind: 'server',
    endpoint: '/account/:userId/wishlist',
    error: 'TypeError',
    time: '7d',
  })
})

test('the leading ? is optional', () => {
  assert.deepEqual(parseBrowserSearch(USER_SEARCH.slice(1), APPS), parseBrowserSearch(USER_SEARCH, APPS))
})

test('name is the Errors page\'s span name, never the Traces endpoint', () => {
  const s = parseBrowserSearch('?service=cubedemo-web&tab=traces&name=POST+api.stripe.com%2Fv1%2Fpayment_intents', APPS)
  assert.equal(s.endpoint, '')
  assert.deepEqual(Object.keys(s), Object.keys(DEFAULTS))
})

// The Errors tab's ↗ on an Ajax row, as production writes it: the endpoint is
// the ajax call's span name, the error its HTTP status.
const AJAX_SEARCH = '?service=cubedemo-web&tab=traces&view=graph&kind=client&endpoint=GET+search.cubedemo.com%3A443%2Fv1%2Fsearch%2Fwealth&error=404&time=7d'
const AJAX_STATE = {
  service: 'cubedemo-web',
  tab: 'traces',
  view: 'graph',
  kind: 'client',
  endpoint: 'GET search.cubedemo.com:443/v1/search/wealth',
  error: '404',
  time: '7d',
}

test('an Ajax link lands on Traces, filtered to that call and status', () => {
  assert.deepEqual(parseBrowserSearch(AJAX_SEARCH, APPS), AJAX_STATE)
  // A space spelled %20 rather than + is the same endpoint.
  assert.deepEqual(parseBrowserSearch(AJAX_SEARCH.replace('GET+', 'GET%20'), APPS), AJAX_STATE)
})

// ---------- Fallbacks ----------

test('a bare URL is the most severe app on Page Views, Graph, Script, unfiltered', () => {
  assert.deepEqual(parseBrowserSearch('', APPS), DEFAULTS)
  assert.deepEqual(parseBrowserSearch('?', APPS), DEFAULTS)
  assert.deepEqual(parseBrowserSearch(undefined, APPS), DEFAULTS)
  assert.deepEqual(parseBrowserSearch(null, APPS), DEFAULTS)
})

test('an unknown app falls back to the first, most severe one', () => {
  assert.equal(parseBrowserSearch('?service=no-such-app', APPS).service, 'cubedemo-web')
  assert.equal(parseBrowserSearch('?service=', APPS).service, 'cubedemo-web')
  assert.equal(parseBrowserSearch('?service=toString', APPS).service, 'cubedemo-web')
  assert.equal(parseBrowserSearch('?service=cubedemo-admin', APPS).service, 'cubedemo-admin')
  // Whatever the severity order, a known app stays the one the link names.
  assert.equal(parseBrowserSearch('?service=cubedemo-web', [...APPS].reverse()).service, 'cubedemo-web')
  assert.equal(parseBrowserSearch('?service=no-such-app', [...APPS].reverse()).service, 'cubedemo-admin')
})

test('without an app list the service is read as written', () => {
  assert.equal(parseBrowserSearch('?service=no-such-app').service, 'no-such-app')
  assert.equal(parseBrowserSearch('').service, '')
  assert.equal(parseBrowserSearch('?service=x', []).service, '')
})

test('every production tab is read; anything else is Page Views', () => {
  for (const tab of BROWSER_TABS) assert.equal(parseBrowserSearch(`?tab=${tab}`, APPS).tab, tab)
  for (const tab of ['', 'bogus', 'overview', 'constructor', '__proto__']) {
    assert.equal(parseBrowserSearch(`?tab=${tab}`, APPS).tab, 'pageviews')
  }
})

test('view is Graph unless it says table; kind is Script unless it says client', () => {
  assert.equal(parseBrowserSearch('?view=table', APPS).view, 'table')
  for (const v of ['graph', '', 'list', 'chart']) assert.equal(parseBrowserSearch(`?view=${v}`, APPS).view, 'graph')
  assert.equal(parseBrowserSearch('?kind=client', APPS).kind, 'client')
  for (const k of ['server', '', 'ajax', 'script']) assert.equal(parseBrowserSearch(`?kind=${k}`, APPS).kind, 'server')
})

test('time is kept only when it is a preset', () => {
  for (const { value } of TIME_PRESETS) assert.equal(parseBrowserSearch(`?time=${value}`, APPS).time, value)
  for (const t of ['', '90d', '1700000000000~1700003600000', 'now']) {
    assert.equal(parseBrowserSearch(`?time=${encodeURIComponent(t)}`, APPS).time, null)
  }
})

test('filter values lose their edges, not their insides', () => {
  const s = parseBrowserSearch('?endpoint=+GET+a.com:443/x++&error=%20404%20', APPS)
  assert.equal(s.endpoint, 'GET a.com:443/x')
  assert.equal(s.error, '404')
})

// ---------- What the page writes ----------

test('the production link is rewritten to one readable spelling', () => {
  const canon = browserSearch(parseBrowserSearch(USER_SEARCH, APPS))
  assert.equal(canon, '?service=cubedemo-web&endpoint=/account/:userId/wishlist&error=TypeError')
  assert.equal(browserUrl(parseBrowserSearch(USER_SEARCH, APPS)), `/browser${canon}`)
  assert.equal(browserSearch(parseBrowserSearch(AJAX_SEARCH, APPS)),
    '?service=cubedemo-web&tab=traces&kind=client&endpoint=GET+search.cubedemo.com:443/v1/search/wealth&error=404')
})

test('a bare /browser is pinned to its app', () => {
  assert.equal(browserUrl(parseBrowserSearch('', APPS)), '/browser?service=cubedemo-web')
})

test('defaults are left out, and time is never written', () => {
  assert.equal(browserSearch({ service: 'cubedemo-web' }), '?service=cubedemo-web')
  assert.equal(browserSearch({ ...DEFAULTS, time: '7d' }), '?service=cubedemo-web')
  assert.equal(browserSearch({ ...AJAX_STATE, tab: 'pageviews', kind: 'server', endpoint: '', error: '' }), '?service=cubedemo-web')
  assert.equal(browserSearch({ service: 'cubedemo-web', view: 'table' }), '?service=cubedemo-web&view=table')
  assert.equal(browserSearch({}), '')
  assert.equal(browserSearch(), '')
  assert.equal(browserUrl({}), BROWSER_PATH)
})

test('a value the page does not have is written as its default', () => {
  assert.equal(browserSearch({ service: 'a', tab: 'bogus', view: 'list', kind: 'ajax' }), '?service=a')
  assert.equal(browserSearch({ service: 'a', endpoint: null, error: undefined }), '?service=a')
})

test('keys are written in one order, whatever order the state has them in', () => {
  const state = { error: '500', endpoint: '/cart', kind: 'client', view: 'table', tab: 'traces', service: 'cubedemo-admin' }
  assert.equal(browserSearch(state), '?service=cubedemo-admin&tab=traces&view=table&kind=client&endpoint=/cart&error=500')
})

test('the constants match production', () => {
  assert.equal(BROWSER_PATH, '/browser')
  assert.deepEqual(BROWSER_TABS, ['pageviews', 'ajax-calls', 'web-vitals', 'errors', 'traces'])
  assert.equal(DEFAULT_BROWSER_TAB, 'pageviews')
  assert.deepEqual(BROWSER_VIEWS, ['graph', 'table'])
  // Production's values, under the page's words; Script is the default.
  assert.deepEqual(BROWSER_KINDS, [{ id: 'server', label: 'Script' }, { id: 'client', label: 'Ajax' }])
  assert.equal(parseBrowserSearch('').kind, BROWSER_KINDS[0].id)
})

// ---------- Round trips ----------

// Real endpoints of both kinds, plus the characters a query string cares
// about, so nothing the page can hold gets lost or reshaped on the way out.
const ENDPOINTS = [
  '', '/', '/account/:userId/wishlist', '/product/:sku', 'https://shop.cubedemo.com/checkout',
  'GET search.cubedemo.com:443/v1/search/wealth', 'POST payment.cubedemo.com:443/v1/payments',
  'a&b=c', '50% off', 'x+y', 'q?x=1', '#frag', 'é/ü, ok', "it's \"quoted\"",
]
const ERRORS = ['', 'TypeError', 'NetworkError', '404', '500']

function* states() {
  for (const service of APPS) {
    for (const tab of BROWSER_TABS) {
      for (const view of BROWSER_VIEWS) {
        for (const kind of ['server', 'client']) {
          for (const endpoint of ENDPOINTS) {
            for (const error of ERRORS) yield { service, tab, view, kind, endpoint, error }
          }
        }
      }
    }
  }
}

test('everything the page writes reads back to the same state', () => {
  let n = 0
  for (const s of states()) {
    const search = browserSearch(s)
    assert.deepEqual(parseBrowserSearch(search, APPS), { ...s, time: null }, search)
    assert.equal(browserUrl(s), BROWSER_PATH + search)
    n++
  }
  assert.ok(n > 1000)
})

test('the written spelling is a fixed point, so the page\'s correction settles', () => {
  const messy = [
    USER_SEARCH, AJAX_SEARCH, '', '?tab=errors&service=cubedemo-admin&kind=client',
    '?endpoint=%2Fcart&service=nope&view=table&view=graph&refresh=1', '?error=404&error=500&tab=traces',
  ]
  for (const raw of messy) {
    const once = browserSearch(parseBrowserSearch(raw, APPS))
    assert.equal(browserSearch(parseBrowserSearch(once, APPS)), once, raw)
  }
})

test('the browser\'s own re-escaping of a written URL is not a difference', () => {
  for (const s of states()) {
    if (s.view !== 'graph' || s.kind !== 'server') continue
    const written = browserSearch(s)
    const shown = new URL(`https://example.test${browserUrl(s)}`).search
    assert.ok(sameSearch(written, shown), `${written} vs ${shown}`)
  }
})
