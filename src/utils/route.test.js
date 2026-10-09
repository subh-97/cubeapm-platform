// The URL is the only copy of the route, so these cases are the ones a reload
// or a pasted link actually meets: a real service, a stale one, a tab that no
// longer exists, and the round trip back to the one spelling App keeps.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseRoute, routeUrl, serviceUrl, traceUrl, canonicalUrl, SERVICE_TABS } from './route.js'
import { services } from '@/data/services'

const first = services[0].id

test('a service path names that service, on Overview by default', () => {
  assert.deepEqual(parseRoute('/service/notify-service'),
    { view: 'service', serviceId: 'notify-service', serviceSubTab: 'overview' })
})

test('the tab comes from the query string', () => {
  assert.equal(parseRoute('/service/notify-service', '?tab=red').serviceSubTab, 'red')
  for (const tab of SERVICE_TABS) {
    assert.equal(parseRoute('/service/notify-service', `?tab=${tab}`).serviceSubTab, tab)
  }
})

test('an unknown service falls back to the first, most severe one', () => {
  assert.equal(first, 'payment-service')
  assert.equal(parseRoute('/service/no-such-service').serviceId, first)
  assert.equal(parseRoute('/service/').serviceId, first)
})

test('an unknown tab falls back to Overview, including one the page dropped', () => {
  assert.equal(parseRoute('/service/notify-service', '?tab=bogus').serviceSubTab, 'overview')
  assert.equal(parseRoute('/service/notify-service', '?tab=traces').serviceSubTab, 'overview')
})

test('a trailing slash or extra segment still names the service', () => {
  assert.equal(parseRoute('/service/notify-service/').serviceId, 'notify-service')
  assert.equal(parseRoute('/service/notify-service/red').serviceId, 'notify-service')
})

test('the other pages parse from their paths', () => {
  assert.deepEqual(parseRoute('/logs'), { view: 'logs' })
  assert.deepEqual(parseRoute('/traces'), { view: 'traces' })
  assert.deepEqual(parseRoute('/mobile-traces'), { view: 'mtraces' })
  assert.deepEqual(parseRoute('/explore'), { view: 'explore' })
  assert.deepEqual(parseRoute('/errors'), { view: 'errors' })
  assert.deepEqual(parseRoute('/browser'), { view: 'browser' })
  assert.deepEqual(parseRoute('/infrastructure'), { view: 'infra' })
  assert.deepEqual(parseRoute('/trace/4bf92f3577b34da6'), { view: 'trace', traceId: '4bf92f3577b34da6' })
  assert.deepEqual(parseRoute('/home'), { view: 'home' })
  assert.deepEqual(parseRoute('/'), { view: 'home' })
  assert.deepEqual(parseRoute('/somewhere-else'), { view: 'home' })
})

test('a trace URL with no id is the Traces list', () => {
  assert.deepEqual(parseRoute('/trace/'), { view: 'traces' })
})

// A mobile trace is the one route whose dataset is in the query string, so
// these are the cases that decide whether a reload of one lands on the device's
// request or on a backend trace with the same id.
test('a mobile trace names its datasource; a backend trace has no such key', () => {
  assert.deepEqual(parseRoute('/trace/abc', '?datasource=mobile'),
    { view: 'trace', traceId: 'abc', datasource: 'mobile' })
  assert.deepEqual(parseRoute('/trace/abc', 'datasource=mobile'),
    { view: 'trace', traceId: 'abc', datasource: 'mobile' })
  assert.deepEqual(parseRoute('/trace/abc', ''), { view: 'trace', traceId: 'abc' })
  assert.deepEqual(parseRoute('/trace/abc', '?datasource=traces'), { view: 'trace', traceId: 'abc' })
})

test('an unknown datasource reads as the backend, with no key at all', () => {
  for (const q of ['?datasource=bogus', '?datasource=', '?datasource=MOBILE', '?datasource=mobile?datasource=mobile']) {
    const route = parseRoute('/trace/abc', q)
    assert.deepEqual(route, { view: 'trace', traceId: 'abc' }, q)
    assert.ok(!('datasource' in route), `${q} leaves no datasource key`)
    assert.equal(canonicalUrl('/trace/abc', q), '/trace/abc', q)
  }
})

test('a mobile trace URL with no id is the Mobile Traces list', () => {
  assert.deepEqual(parseRoute('/trace/', '?datasource=mobile'), { view: 'mtraces' })
  assert.equal(canonicalUrl('/trace/', '?datasource=mobile'), '/mobile-traces')
  assert.equal(canonicalUrl('/trace/', ''), '/traces')
})

test('traceUrl spells the datasource only for mobile', () => {
  assert.equal(traceUrl('abc'), '/trace/abc')
  assert.equal(traceUrl('abc', 'traces'), '/trace/abc')
  assert.equal(traceUrl('abc', 'bogus'), '/trace/abc')
  assert.equal(traceUrl('abc', 'mobile'), '/trace/abc?datasource=mobile')
  assert.equal(traceUrl('a b/c', 'mobile'), '/trace/a%20b%2Fc?datasource=mobile')
  assert.equal(routeUrl({ view: 'trace', traceId: 'abc', datasource: 'mobile' }), '/trace/abc?datasource=mobile')
  assert.equal(routeUrl({ view: 'trace', traceId: 'abc' }), '/trace/abc')
  assert.equal(routeUrl({ view: 'mtraces' }), '/mobile-traces')
})

test('a mobile trace round-trips with exactly one ?datasource=mobile', () => {
  const once = (url) => {
    const [path, query = ''] = url.split('?')
    return canonicalUrl(path, query ? `?${query}` : '')
  }
  const start = traceUrl('mob_4bf92f3577b34da6', 'mobile')
  assert.equal(once(start), start)
  assert.equal(once(once(start)), start)
  assert.equal(start.split('datasource=').length - 1, 1)
  const [path, query] = start.split('?')
  assert.deepEqual(parseRoute(path, `?${query}`),
    { view: 'trace', traceId: 'mob_4bf92f3577b34da6', datasource: 'mobile' })
  // A trace owns its whole URL, as a service does: a stray parameter is
  // dropped rather than carried, and the datasource survives it.
  assert.equal(canonicalUrl('/trace/abc', '?datasource=mobile&stray=1'), '/trace/abc?datasource=mobile')
  assert.equal(canonicalUrl('/trace/abc', '?stray=1&datasource=mobile'), '/trace/abc?datasource=mobile')
  assert.equal(canonicalUrl('/trace/abc', '?stray=1'), '/trace/abc')
})

test('Overview is left out of the URL, other tabs are spelled as ?tab=', () => {
  assert.equal(serviceUrl('notify-service'), '/service/notify-service')
  assert.equal(serviceUrl('notify-service', 'overview'), '/service/notify-service')
  assert.equal(serviceUrl('notify-service', 'red'), '/service/notify-service?tab=red')
})

test('parsing then printing lands on the canonical URL', () => {
  const canon = (path, search) => routeUrl(parseRoute(path, search))
  assert.equal(canon('/service/notify-service', '?tab=db'), '/service/notify-service?tab=db')
  assert.equal(canon('/service/notify-service', '?tab=overview'), '/service/notify-service')
  assert.equal(canon('/service/notify-service/', ''), '/service/notify-service')
  assert.equal(canon('/service/no-such-service', '?tab=red'), `/service/${first}?tab=red`)
  assert.equal(canon('/', ''), '/home')
  assert.equal(canon('/logs', ''), '/logs')
  assert.equal(canon('/browser', '?service=cubedemo-web&tab=traces'), '/browser')
  assert.equal(routeUrl({ view: 'browser' }), '/browser')
  assert.equal(canon('/trace/abc', ''), traceUrl('abc'))
})

test('a page keeps its own query string; a service URL is rewritten whole', () => {
  const errors = '?kind=client&service=payment-service&exception=Jedis'
  assert.equal(canonicalUrl('/errors', errors), `/errors${errors}`)
  // The Browser page's link, pasted from production exactly: its foreign keys
  // (index, name, refresh) are the page's to read past, not App's to strip.
  const browser = '?service=cubedemo-web&view=graph&index=cube%3Aerror&error=TypeError&name=POST+api.stripe.com%2Fv1%2Fpayment_intents&kind=server&time=7d&refresh=1791403390990&tab=pageviews&endpoint=%2Faccount%2F%3AuserId%2Fwishlist'
  assert.equal(canonicalUrl('/browser', browser), `/browser${browser}`)
  assert.equal(canonicalUrl('/browser', ''), '/browser')
  assert.equal(canonicalUrl('/explore', ''), '/explore')
  assert.equal(canonicalUrl('/mobile-traces', ''), '/mobile-traces')
  assert.equal(canonicalUrl('/mobile-traces', '?q=eventType%3AMobileCrash'), '/mobile-traces?q=eventType%3AMobileCrash')
  assert.equal(canonicalUrl('/', ''), '/home')
  assert.equal(canonicalUrl('/service/notify-service', '?tab=red'), '/service/notify-service?tab=red')
  assert.equal(canonicalUrl('/service/notify-service', '?tab=red&stray=1'), '/service/notify-service?tab=red')
  assert.equal(canonicalUrl('/service/notify-service', '?tab=overview'), '/service/notify-service')
})

test('every URL App prints parses back to the same route', () => {
  for (const s of services) {
    for (const tab of SERVICE_TABS) {
      const url = serviceUrl(s.id, tab)
      const [path, query = ''] = url.split('?')
      assert.deepEqual(parseRoute(path, query ? `?${query}` : ''), { view: 'service', serviceId: s.id, serviceSubTab: tab })
    }
  }
})
