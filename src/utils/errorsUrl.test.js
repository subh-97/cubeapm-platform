// The Errors page URL: what a link lands on, and what the page writes back.
//
// Two contracts. A link copied out of the original CubeAPM Errors page has to
// land on the same errors here, leftovers and all. And whatever the page writes
// has to read back to the same state, including the search text, which then
// has to read back to the same chips.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chipsToString } from '@/components/QueryBuilder'
import { tryParseConditions } from '@/utils/rawQuery'
import { newGroup } from '@/utils/queryTree'
import { parseErrorsSearch, errorsSearch } from './errorsUrl.js'

const EMPTY = { kind: 'server', facets: {}, q: '', time: null }

// ---------- The user's link ----------

// Exactly as pasted, `…` and all: the refresh value is a timestamp nobody needs.
const USER_URL = '/errors?service=payment-service&view=graph&index=cube%3Aerror&error=TypeError&name=POST+api.stripe.com%2Fv1%2Fpayment_intents&kind=server&time=7d&refresh=…&endpoint=&category=&host=&sv='

test('the original page\'s link seeds service, exception and span name, on Server, over 7 days', () => {
  assert.deepEqual(parseErrorsSearch(USER_URL), {
    kind: 'server',
    facets: {
      service: ['payment-service'],
      exception: ['TypeError'],
      span_name: ['POST api.stripe.com/v1/payment_intents'],
    },
    q: '',
    time: '7d',
  })
})

test('the same link reads the same from location.search, with or without the ?', () => {
  const search = USER_URL.slice(USER_URL.indexOf('?'))
  assert.deepEqual(parseErrorsSearch(search), parseErrorsSearch(USER_URL))
  assert.deepEqual(parseErrorsSearch(search.slice(1)), parseErrorsSearch(USER_URL))
})

test('what the page writes for that link is short, readable and reads back the same', () => {
  const state = parseErrorsSearch(USER_URL)
  const written = errorsSearch(state)
  assert.equal(written, '?service=payment-service&span_name=POST+api.stripe.com/v1/payment_intents&exception=TypeError')
  assert.deepEqual(parseErrorsSearch(written), { ...state, time: null })
})

// ---------- The original's other spellings ----------

test('the original stream parameter seeds the facets, root_name as the endpoint', () => {
  const stream = JSON.stringify({ service: ['payment-service'], root_name: ['POST /v1/payments/:id/capture'], exception: ['TypeError', 'java.lang.RuntimeException'] })
  const state = parseErrorsSearch(`?stream=${encodeURIComponent(stream)}`)
  assert.deepEqual(state.facets, {
    service: ['payment-service'],
    endpoint: ['POST /v1/payments/:id/capture'],
    exception: ['TypeError', 'java.lang.RuntimeException'],
  })
})

test('a malformed stream is dropped on its own; the rest of the link still applies', () => {
  const state = parseErrorsSearch('?stream=%7Bnot-json&service=order-service')
  assert.deepEqual(state.facets, { service: ['order-service'] })
  assert.deepEqual(parseErrorsSearch('?stream=%5B%22a%22%5D').facets, {})
})

test('one value under two spellings is one filter', () => {
  const state = parseErrorsSearch('?error=TypeError&exception=TypeError&stream=%7B%22exception%22%3A%5B%22TypeError%22%5D%7D')
  assert.deepEqual(state.facets, { exception: ['TypeError'] })
})

test('repeated keys are several values of one facet, in order', () => {
  const state = parseErrorsSearch('?http_code=500&http_code=503&service=a&service=b&service=a')
  assert.deepEqual(state.facets, { service: ['a', 'b'], http_code: ['500', '503'] })
})

test('a key that names something on every object is not a facet', () => {
  // The bug: on a plain-object key map these found Object.prototype members and
  // became facets on fields no row has, which emptied the page.
  const state = parseErrorsSearch('?toString=1&constructor=x&__proto__=y&hasOwnProperty=z&valueOf=w&service=a')
  assert.deepEqual(state.facets, { service: ['a'] })
  const stream = JSON.stringify({ toString: ['x'], constructor: ['y'], service: ['a'] })
  assert.deepEqual(parseErrorsSearch(`?stream=${encodeURIComponent(stream)}`).facets, { service: ['a'] })
})

test('stream values are strings or numbers; anything else is dropped, not written as text', () => {
  const stream = JSON.stringify({ service: 'payment-service', http_code: [503, '504', null, { a: 1 }, ['x']] })
  assert.deepEqual(parseErrorsSearch(`?stream=${encodeURIComponent(stream)}`).facets, {
    service: ['payment-service'],
    http_code: ['503', '504'],
  })
})

test('a bare query string keeps a ? inside a value; a whole URL loses its fragment', () => {
  assert.deepEqual(parseErrorsSearch('q=why%3F&service=a'), { ...EMPTY, facets: { service: ['a'] }, q: 'why?' })
  assert.equal(parseErrorsSearch('q=why?&service=a').q, 'why?')
  assert.deepEqual(
    parseErrorsSearch('https://demo.cubeapm.com/errors?service=a&kind=client#row-3').facets,
    { service: ['a'] },
  )
  assert.equal(parseErrorsSearch('?service=a#row-3').facets.service[0], 'a')
})

// ---------- kind and time ----------

test('kind is server unless it says client', () => {
  assert.equal(parseErrorsSearch('').kind, 'server')
  assert.equal(parseErrorsSearch('?kind=client').kind, 'client')
  assert.equal(parseErrorsSearch('?kind=Client').kind, 'client')
  assert.equal(parseErrorsSearch('?kind=consumer').kind, 'server')
})

test('only a preset time range is carried', () => {
  assert.equal(parseErrorsSearch('?time=1h').time, '1h')
  assert.equal(parseErrorsSearch('?time=todayf').time, 'todayf')
  // The original also writes absolute ranges; those belong to App, not a link.
  assert.equal(parseErrorsSearch('?time=2026-10-01T10:00:00Z~2026-10-01T11:00:00Z').time, null)
  assert.equal(parseErrorsSearch('?time=forever').time, null)
  assert.equal(parseErrorsSearch('').time, null)
})

test('an empty search is the default state', () => {
  assert.deepEqual(parseErrorsSearch(''), EMPTY)
  assert.deepEqual(parseErrorsSearch(undefined), EMPTY)
  assert.deepEqual(parseErrorsSearch('?endpoint=&q=&kind='), EMPTY)
})

// ---------- Writing ----------

test('the default state writes nothing at all', () => {
  assert.equal(errorsSearch(EMPTY), '')
  assert.equal(errorsSearch({}), '')
})

test('keys are written in one fixed order, kind first, and only when they say something', () => {
  const written = errorsSearch({
    kind: 'client',
    facets: { http_code: ['429'], exception: [], span_name: new Set(['SETEX redis.session:*']), service: ['notify-service', 'payment-service'] },
    q: 'http_code:5*',
  })
  assert.equal(written, '?kind=client&service=notify-service&service=payment-service&span_name=SETEX+redis.session:*&http_code=429&q=http_code:5*')
})

test('time, refresh and index are never written, whatever the state carries', () => {
  const written = errorsSearch({ ...EMPTY, time: '7d', refresh: '123', index: 'cube:error', facets: { service: ['x'] } })
  assert.equal(written, '?service=x')
})

test('a lone string is one value, and a repeated value is written once', () => {
  assert.equal(errorsSearch({ facets: { service: 'payment-service' } }), '?service=payment-service')
  assert.equal(errorsSearch({ facets: { http_code: ['500', '500', '503'] } }), '?http_code=500&http_code=503')
})

test('values carrying URL syntax survive the trip', () => {
  const facets = { endpoint: ['GET /v1/search?q=a&b=c#top', 'POST /v1/a+b', '100% done'] }
  const back = parseErrorsSearch(errorsSearch({ kind: 'server', facets, q: '' }))
  assert.deepEqual(back.facets, facets)
})

// ---------- The search text ----------

const leaf = (field, op, value, connector) => (
  connector ? { field, op, value, connector } : { field, op, value }
)

const QUERIES = {
  'a service and a dotted exception class': [
    leaf('service', 'eq', 'payment-service'),
    leaf('exception', 'eq', 'redis.clients.jedis.exceptions.JedisPoolException', 'AND'),
  ],
  'a span name with spaces and a colon': [leaf('span_name', 'eq', 'POST /v1/payments/:id/capture')],
  'an http_code prefix': [leaf('http_code', 'prefix', '5')],
  'a list with spaces in it': [leaf('endpoint', 'not_in', ['POST /v1/orders', 'GET /v1/payments/:id'])],
  'free text and an exclusion': [
    leaf('_msg', 'phrase', 'Could not get a resource'),
    leaf('exception', 'neq', 'com.cubedemo.payment.CardDeclinedException', 'AND'),
  ],
  'a regex carrying URL syntax and a backslash': [leaf('message', 'regex', 'a+b&c=d#e%20f\\.g?')],
  'an OR after a stream-eligible chip': [
    leaf('service', 'eq', 'payment-service'),
    leaf('exception', 'eq', 'java.lang.RuntimeException', 'OR'),
  ],
  'a group': [
    newGroup([leaf('http_code', 'eq', '503'), leaf('http_code', 'eq', '504', 'OR')]),
    leaf('_msg', 'contains', 'Timeout', 'AND'),
  ],
}

for (const [name, chips] of Object.entries(QUERIES)) {
  test(`q round trip — ${name}`, () => {
    const q = chipsToString(chips)
    const state = parseErrorsSearch(errorsSearch({ kind: 'server', facets: {}, q }))
    assert.equal(state.q, q)
    const back = tryParseConditions(state.q)
    assert.equal(back.ok, true, `expected "${state.q}" to parse, got: ${back.error}`)
    assert.deepEqual(back.chips, chips)
  })
}
