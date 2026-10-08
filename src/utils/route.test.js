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
  assert.deepEqual(parseRoute('/explore'), { view: 'explore' })
  assert.deepEqual(parseRoute('/errors'), { view: 'errors' })
  assert.deepEqual(parseRoute('/infrastructure'), { view: 'infra' })
  assert.deepEqual(parseRoute('/trace/4bf92f3577b34da6'), { view: 'trace', traceId: '4bf92f3577b34da6' })
  assert.deepEqual(parseRoute('/home'), { view: 'home' })
  assert.deepEqual(parseRoute('/'), { view: 'home' })
  assert.deepEqual(parseRoute('/somewhere-else'), { view: 'home' })
})

test('a trace URL with no id is the Traces list', () => {
  assert.deepEqual(parseRoute('/trace/'), { view: 'traces' })
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
  assert.equal(canon('/trace/abc', ''), traceUrl('abc'))
})

test('a page keeps its own query string; a service URL is rewritten whole', () => {
  const errors = '?kind=client&service=payment-service&exception=Jedis'
  assert.equal(canonicalUrl('/errors', errors), `/errors${errors}`)
  assert.equal(canonicalUrl('/explore', ''), '/explore')
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
