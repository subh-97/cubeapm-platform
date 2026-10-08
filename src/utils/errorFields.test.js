// The errors vocabulary, run through the same evaluator Logs and Traces use.
//
// The rows are synthetic but shaped exactly like src/data/errors.js
// ErrorSeriesRows, so these hold whatever the generator's numbers turn out to
// be: they pin what a query MEANS on an error, not how many errors there are.
// The one test on generated rows compares against the original page's search
// on those same rows, so it holds whatever the numbers are too.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyChipsToLog, chipsToString, buildFreeTextOptions } from '@/components/QueryBuilder'
import { tryParseConditions } from '@/utils/rawQuery'
import { errorSeriesForWindow } from '@/data/errors'
import { resolveWindow } from '@/data/timeWindow'
import {
  ERROR_FIELD_CATALOG, ERROR_FACET_FIELDS, getErrorFieldValue, buildErrorFacets,
  applyErrorFacets, ERROR_EXAMPLE_QUERIES, ERROR_RECENT_SEEDS, ERROR_COLON_MATCH,
} from './errorFields.js'

function row({ side = 'server', service, endpoint, spanName, category = 'http', exception, message, httpCode, count }) {
  const span = spanName ?? endpoint
  return {
    id: `${side}|${service}|${endpoint}|${span}|${exception}|${httpCode}`,
    side, service, endpoint, spanName: span, category,
    exception, exceptionShort: exception.split('.').pop(), message, httpCode,
    count, prevCount: 0, series: [],
  }
}

const JEDIS = 'redis.clients.jedis.exceptions.JedisPoolException'
const CAPTURE = 'POST /v1/payments/:id/capture'

const JEDIS_500 = row({ service: 'payment-service', endpoint: CAPTURE, exception: JEDIS, message: 'Could not get a resource from the pool', httpCode: '500', count: 120 })
const JEDIS_503 = row({ service: 'payment-service', endpoint: CAPTURE, exception: JEDIS, message: 'Could not get a resource from the pool', httpCode: '503', count: 115 })
const STRIPE_TIMEOUT = row({ service: 'payment-service', endpoint: 'POST /v1/payments', exception: 'java.util.concurrent.TimeoutException', message: 'Timed out waiting for stripe after 30000ms', httpCode: '504', count: 9 })
const DOWNSTREAM = row({ service: 'order-service', endpoint: 'POST /v1/orders', exception: 'java.lang.RuntimeException', message: 'Downstream call failed', httpCode: '502', count: 30 })
const SEARCH_DB = row({ service: 'search-service', endpoint: 'GET /v1/search', exception: 'java.lang.RuntimeException', message: 'Failed connecting to database', httpCode: '500', count: 400 })

const TWILIO_429 = row({ side: 'client', service: 'notify-service', endpoint: 'POST /v1/notify', spanName: 'POST api.twilio.com/2010-04-01/Messages.json', exception: 'com.twilio.exception.ApiException', message: '429 Too Many Requests', httpCode: '429', count: 12 })
const REDIS_CONN = row({ side: 'client', service: 'payment-service', endpoint: 'GET /v1/payments/:id', spanName: 'SETEX redis.session:*', category: 'db', exception: 'redis.clients.jedis.exceptions.JedisConnectionException', message: 'Failed connecting to host redis.0:6379', httpCode: '', count: 40 })
const CARD_DECLINED = row({ side: 'client', service: 'payment-service', endpoint: CAPTURE, spanName: 'POST api.stripe.com/v1/charges', exception: 'com.cubedemo.payment.CardDeclinedException', message: 'Card declined by issuer: insufficient_funds', httpCode: '402', count: 3 })
const HIKARI = row({ side: 'client', service: 'order-service', endpoint: 'POST /v1/orders', spanName: 'UPDATE payments.transactions', category: 'db', exception: 'java.sql.SQLTransientConnectionException', message: 'HikariPool-1 - Connection is not available, request timed out after 30000ms', httpCode: '', count: 2 })

const SERVER = [JEDIS_500, JEDIS_503, STRIPE_TIMEOUT, DOWNSTREAM, SEARCH_DB]
const CLIENT = [TWILIO_429, REDIS_CONN, CARD_DECLINED, HIKARI]
const ALL = [...SERVER, ...CLIENT]

// Read as the page reads it, `field:value` included (ERROR_COLON_MATCH).
const matching = (chips, rows = ALL) => rows.filter(r => applyChipsToLog(r, chips, getErrorFieldValue, { colonMatch: ERROR_COLON_MATCH }))
const ft = (op, value) => [{ field: '_msg', op, value }]

// ---------- Fields ----------

test('every catalog field resolves on a row, and so do the span spellings of them', () => {
  for (const { field } of ERROR_FIELD_CATALOG) {
    assert.notEqual(getErrorFieldValue(JEDIS_500, field), undefined, `${field} resolved to nothing`)
  }
  assert.equal(getErrorFieldValue(TWILIO_429, 'span_name'), 'POST api.twilio.com/2010-04-01/Messages.json')
  assert.equal(getErrorFieldValue(TWILIO_429, 'http_code'), '429')
  assert.equal(getErrorFieldValue(JEDIS_500, 'exception.type'), JEDIS)
  assert.equal(getErrorFieldValue(JEDIS_500, 'root_name'), CAPTURE)
  assert.equal(getErrorFieldValue(TWILIO_429, 'span_kind'), 'client')
  assert.equal(getErrorFieldValue(JEDIS_500, 'no.such.field'), undefined)
})

test('message is the message alone; free text is the whole error', () => {
  assert.equal(getErrorFieldValue(JEDIS_500, 'message'), 'Could not get a resource from the pool')
  const text = getErrorFieldValue(JEDIS_500, '_msg')
  for (const part of [JEDIS, 'Could not get a resource', CAPTURE, 'payment-service']) {
    assert.ok(text.includes(part), `free text is missing "${part}"`)
  }
})

// ---------- Free text over dotted class names ----------

test('free text "RuntimeException" matches java.lang.RuntimeException as a phrase', () => {
  assert.deepEqual(matching(ft('phrase', 'RuntimeException')), [DOWNSTREAM, SEARCH_DB])
})

test('free text "RuntimeException" matches it as a prefix too, and so does "Runtime"', () => {
  assert.deepEqual(matching(ft('prefix', 'RuntimeException')), [DOWNSTREAM, SEARCH_DB])
  assert.deepEqual(matching(ft('prefix', 'Runtime')), [DOWNSTREAM, SEARCH_DB])
})

test('the class field alone is one word to the matcher — which is why free text carries the split spelling', () => {
  // `java.lang.RuntimeException` is a single token (dots are word characters),
  // so a phrase on the field itself never sees "RuntimeException" in it.
  assert.deepEqual(matching([{ field: 'exception', op: 'phrase', value: 'RuntimeException' }]), [])
  assert.deepEqual(matching([{ field: 'exception', op: 'contains', value: 'RuntimeException' }]), [DOWNSTREAM, SEARCH_DB])
})

test('a pasted full class name still matches as a phrase', () => {
  assert.deepEqual(matching(ft('phrase', JEDIS)), [JEDIS_500, JEDIS_503])
})

test('one word of a class name is found as a phrase: Timeout finds TimeoutException', () => {
  assert.deepEqual(matching(ft('phrase', 'Timeout')), [STRIPE_TIMEOUT])
  assert.deepEqual(matching(ft('phrase', 'card declined')), [CARD_DECLINED])
  // SQLTransient… splits after the acronym, not between its letters.
  assert.deepEqual(matching(ft('phrase', 'SQL Transient')), [HIKARI])
})

test('free text reaches the message, the endpoint and the outgoing call', () => {
  assert.deepEqual(matching(ft('phrase', 'resource from the pool')), [JEDIS_500, JEDIS_503])
  assert.deepEqual(matching(ft('contains', '/v1/orders')), [DOWNSTREAM, HIKARI])
  assert.deepEqual(matching(ft('contains', 'api.stripe.com')), [CARD_DECLINED])
})

test('free text finds a service by one of its words, and an error by its HTTP code, in every reading', () => {
  // `payment-service` is one word to the matcher, so without the hyphen-split
  // spelling the phrase `payment` found nothing on the incident's own service.
  for (const op of ['phrase', 'prefix', 'contains']) {
    assert.deepEqual(matching(ft(op, 'payment'), SERVER), [JEDIS_500, JEDIS_503, STRIPE_TIMEOUT], op)
    assert.deepEqual(matching(ft(op, '503')), [JEDIS_503], op)
  }
})

test('on the generated rows, a word of the incident service and a code find what the original page finds', () => {
  // The original reads a bare term as a substring of the service, endpoint, span
  // name, exception and HTTP code. Whichever single-word reading the search bar
  // commits, these two must find the same Server errors, or the page answers
  // "nothing here" about the one service that is failing.
  const rows = errorSeriesForWindow(resolveWindow({ kind: 'preset', value: '1h' }), 'server')
  const original = q => rows.filter(r => [r.service, r.endpoint, r.spanName, r.exception, r.httpCode]
    .some(v => String(v ?? '').toLowerCase().includes(q.toLowerCase())))
  for (const q of ['payment', '503']) {
    const want = original(q)
    assert.ok(want.length > 0, `the original finds no "${q}", so this would prove nothing`)
    for (const op of ['phrase', 'prefix', 'contains']) {
      assert.deepEqual(matching(ft(op, q), rows), want, `${op} "${q}"`)
    }
  }
})

test('on the generated rows, a fragment and Enter find at least what the original page finds', () => {
  // The search bar leads a bare term with contains on this page
  // (ErrorsQueryBuilder's freeTextLead), so Enter on a fragment of a class or a
  // service is a substring search, as the original's bare term was. An exact
  // phrase found none of `pay`, `JedisPool`, `sms` or `CardDeclined`.
  const win = resolveWindow({ kind: 'preset', value: '1h' })
  const enter = q => {
    const first = buildFreeTextOptions(q, { lead: 'contains' })[0]
    return first.kind === 'split'
      ? first.words.map((w, i) => ({ field: '_msg', op: 'contains', value: w, ...(i ? { connector: 'AND' } : {}) }))
      : ft(first.op, first.value)
  }
  for (const q of ['pay', 'JedisPool', 'sms', 'CardDeclined']) {
    let found = 0
    for (const side of ['server', 'client']) {
      const rows = errorSeriesForWindow(win, side)
      const want = rows.filter(r => [r.service, r.endpoint, r.spanName, r.exception, r.httpCode]
        .some(v => String(v ?? '').toLowerCase().includes(q.toLowerCase())))
      const got = new Set(matching(enter(q), rows))
      for (const r of want) assert.ok(got.has(r), `${side} "${q}" misses ${r.id}`)
      found += want.length
    }
    assert.ok(found > 0, `the original finds no "${q}", so this would prove nothing`)
  }
})

// ---------- Field filters ----------

test('field:value is a case-insensitive contains, as on the original page; := stays exact', () => {
  const colon = (field, value) => [{ field, op: 'word', value }]
  assert.deepEqual(matching(colon('service', 'PAYMENT'), SERVER), [JEDIS_500, JEDIS_503, STRIPE_TIMEOUT])
  assert.deepEqual(matching(colon('exception', 'jedis')), [JEDIS_500, JEDIS_503, REDIS_CONN])
  assert.deepEqual(matching([{ field: 'exception', op: 'eq', value: 'JedisPoolException' }]), [])
  assert.deepEqual(matching([{ field: 'exception', op: 'eq', value: JEDIS }]), [JEDIS_500, JEDIS_503])

  // On generated rows, the searches people type find what a substring finds.
  // Read as LogsQL's word match they found nothing: a dotted class name and a
  // hyphenated service are each one word to it.
  const rows = errorSeriesForWindow(resolveWindow({ kind: 'preset', value: '1h' }), 'server')
  for (const [field, q, prop] of [['exception', 'Jedis', 'exception'], ['service', 'payment', 'service']]) {
    const want = rows.filter(r => r[prop].toLowerCase().includes(q.toLowerCase()))
    assert.ok(want.length > 0, `no ${field} contains "${q}", so this would prove nothing`)
    assert.deepEqual(matching(colon(field, q), rows), want, `${field}:${q}`)
  }
})

test('http_code prefix 5 matches 500 and 503, not 429, 402 or a call with no code', () => {
  const hits = matching([{ field: 'http_code', op: 'prefix', value: '5' }])
  assert.deepEqual(hits.map(r => r.httpCode), ['500', '503', '504', '502', '500'])
  assert.ok(!hits.includes(TWILIO_429))
  assert.ok(!hits.includes(CARD_DECLINED))
  assert.ok(!hits.includes(REDIS_CONN))
})

test('exception != keeps everything except that class', () => {
  const chips = [{ field: 'exception', op: 'neq', value: 'com.cubedemo.payment.CardDeclinedException' }]
  assert.deepEqual(matching(chips), ALL.filter(r => r !== CARD_DECLINED))
})

test('an exact span name with spaces and a colon matches its rows only', () => {
  const chips = [{ field: 'span_name', op: 'eq', value: 'SETEX redis.session:*' }]
  assert.deepEqual(matching(chips), [REDIS_CONN])
  assert.deepEqual(matching([{ field: 'endpoint', op: 'eq', value: CAPTURE }]), [JEDIS_500, JEDIS_503, CARD_DECLINED])
})

test('in and not_in compare one value per row', () => {
  assert.deepEqual(matching([{ field: 'http_code', op: 'in', value: ['503', '429'] }]), [JEDIS_503, TWILIO_429])
  assert.deepEqual(
    matching([{ field: 'service', op: 'not_in', value: ['payment-service'] }]),
    [DOWNSTREAM, SEARCH_DB, TWILIO_429, HIKARI],
  )
})

// ---------- Example queries and recent seeds ----------

test('every example query reads back from its own text', () => {
  for (const q of [...ERROR_EXAMPLE_QUERIES.map(e => e.chips), ...ERROR_RECENT_SEEDS]) {
    const text = chipsToString(q)
    const back = tryParseConditions(text)
    assert.equal(back.ok, true, `expected "${text}" to parse, got: ${back.error}`)
    assert.deepEqual(back.chips, q, `"${text}" read back as something else`)
  }
})

test('every example query narrows: it keeps some errors and drops others', () => {
  assert.ok(ERROR_EXAMPLE_QUERIES.length >= 4 && ERROR_EXAMPLE_QUERIES.length <= 6)
  for (const e of ERROR_EXAMPLE_QUERIES) {
    assert.ok(e.id && e.name && e.description, `example "${e.name}" is missing a field`)
    const n = matching(e.chips).length
    assert.ok(n > 0 && n < ALL.length, `"${e.name}" kept ${n} of ${ALL.length}`)
  }
})

test('the example queries mean what their names say', () => {
  const byId = Object.fromEntries(ERROR_EXAMPLE_QUERIES.map(e => [e.id, e.chips]))
  assert.deepEqual(matching(byId['errors-5xx'], CLIENT), [])
  assert.deepEqual(matching(byId['errors-timeouts']), [STRIPE_TIMEOUT, HIKARI])
  assert.deepEqual(matching(byId['errors-connections']), [JEDIS_500, JEDIS_503, REDIS_CONN, HIKARI])
  assert.deepEqual(matching(byId['errors-429']), [TWILIO_429])
  assert.deepEqual(matching(byId['errors-no-declines']), ALL.filter(r => r !== CARD_DECLINED))
})

// ---------- Facets ----------

const STATUS = { 'payment-service': 'critical', 'order-service': 'warning', 'search-service': 'healthy' }

test('facet fields follow the side: Client adds the outgoing call', () => {
  assert.deepEqual(Object.keys(buildErrorFacets(SERVER, { side: 'server' })), ERROR_FACET_FIELDS.server)
  assert.deepEqual(Object.keys(buildErrorFacets(CLIENT, { side: 'client' })), ERROR_FACET_FIELDS.client)
})

test('facet counts are errors, not rows, and an empty code is not a value', () => {
  const f = buildErrorFacets(CLIENT, { side: 'client', serviceStatus: STATUS })
  assert.deepEqual(f.http_code, [{ value: '429', count: 12 }, { value: '402', count: 3 }])
  const payment = f.service.find(o => o.value === 'payment-service')
  assert.equal(payment.count, 43)
})

test('services sort by severity before count, so a busier healthy service never buries the incident', () => {
  const f = buildErrorFacets(SERVER, { side: 'server', serviceStatus: STATUS })
  // search-service has the most errors, and still sorts last.
  assert.deepEqual(f.service.map(o => o.value), ['payment-service', 'order-service', 'search-service'])
  // A service with no known status sorts after every known one.
  const g = buildErrorFacets(ALL, { side: 'client', serviceStatus: STATUS })
  assert.equal(g.service.at(-1).value, 'notify-service')
})

test('other facets sort by count, then by value', () => {
  const f = buildErrorFacets(SERVER, { side: 'server', serviceStatus: STATUS })
  assert.deepEqual(f.exception.map(o => o.value), ['java.lang.RuntimeException', JEDIS, 'java.util.concurrent.TimeoutException'])
  assert.deepEqual(f.http_code.map(o => o.value), ['500', '503', '502', '504'])
})

test('a selected value with no errors stays listed at 0, so it can be seen and unticked', () => {
  const f = buildErrorFacets(SERVER, {
    side: 'server', serviceStatus: STATUS,
    selected: { exception: new Set(['TypeError']), service: ['payment-service'] },
  })
  assert.deepEqual(f.exception.at(-1), { value: 'TypeError', count: 0 })
  // A selected value that does have errors is not duplicated.
  assert.equal(f.service.filter(o => o.value === 'payment-service').length, 1)
})

test('a selection on a field this side has no group for gets one, holding only what was selected', () => {
  // The user's link: a span name on Server, where the span name is the endpoint
  // and has no group of its own. Listed, it can be seen and unticked.
  const f = buildErrorFacets(SERVER, {
    side: 'server', serviceStatus: STATUS,
    selected: { span_name: ['POST api.stripe.com/v1/payment_intents', CAPTURE], 'exception.type': ['x'] },
  })
  assert.deepEqual(Object.keys(f), [...ERROR_FACET_FIELDS.server, 'span_name'])
  assert.deepEqual(f.span_name, [
    { value: CAPTURE, count: 235 },
    { value: 'POST api.stripe.com/v1/payment_intents', count: 0 },
  ])
})

test('facet selection: OR within a field, AND across fields, nothing selected keeps everything', () => {
  assert.equal(applyErrorFacets(ALL, {}), ALL)
  assert.equal(applyErrorFacets(ALL, { service: new Set() }), ALL)
  assert.deepEqual(
    applyErrorFacets(ALL, { http_code: new Set(['500', '429']) }),
    [JEDIS_500, SEARCH_DB, TWILIO_429],
  )
  assert.deepEqual(
    applyErrorFacets(ALL, { http_code: ['500', '429'], service: ['payment-service'] }),
    [JEDIS_500],
  )
  // A seeded value nothing has excludes everything rather than being ignored.
  assert.deepEqual(applyErrorFacets(ALL, { exception: ['TypeError'] }), [])
})

test('a lone string selection is one value, not a selection of its letters', () => {
  assert.deepEqual(applyErrorFacets(ALL, { service: 'order-service' }), [DOWNSTREAM, HIKARI])
  const f = buildErrorFacets(SERVER, { side: 'server', selected: { exception: 'TypeError' } })
  assert.deepEqual(f.exception.at(-1), { value: 'TypeError', count: 0 })
  assert.equal(f.exception.filter(o => o.count === 0).length, 1)
})

test('a field named after an Object member is a field the row does not have', () => {
  for (const field of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    assert.equal(getErrorFieldValue(JEDIS_500, field), undefined, field)
  }
  assert.deepEqual(matching([{ field: 'constructor', op: 'exists' }]), [])
})
