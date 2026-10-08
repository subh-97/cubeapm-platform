// Grouped-query evaluation. The point of parentheses is that they change the
// result — these tests pin the cases where a grouped tree and the equivalent
// flat chip list disagree.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyChipsToLog, chipsToString, chipSegments, buildFreeTextOptions,
  buildValueIndex, rankMatchingValues, landChips,
} from './QueryBuilder.jsx'
import { newGroup } from '../utils/queryTree.js'
import { tryParseConditions, splitQuery } from '../utils/rawQuery.js'

const log = (service, level) => ({ service, level, message: '', tags: {} })

const lvl = (v, connector) => (
  connector ? { field: 'log.level', op: 'eq', value: v, connector } : { field: 'log.level', op: 'eq', value: v }
)
const svc = (v, connector) => (
  connector ? { field: 'service', op: 'eq', value: v, connector } : { field: 'service', op: 'eq', value: v }
)

// (service:order OR service:payment) AND (log.level:error OR log.level:warn)
const GROUPED = [
  newGroup([svc('order'), svc('payment', 'OR')]),
  newGroup([lvl('error'), lvl('warn', 'OR')], 'AND'),
]

// The same four chips laid out flat — what the builder could express before.
const FLAT = [svc('order'), svc('payment', 'OR'), lvl('error', 'AND'), lvl('warn', 'OR')]

test('grouped query matches only the intended combinations', () => {
  assert.equal(applyChipsToLog(log('order', 'error'), GROUPED), true)
  assert.equal(applyChipsToLog(log('payment', 'warn'), GROUPED), true)
  assert.equal(applyChipsToLog(log('order', 'info'), GROUPED), false)
  assert.equal(applyChipsToLog(log('cart', 'error'), GROUPED), false)
})

test('the flat form leaks — which is the bug grouping fixes', () => {
  // Flat evaluates ((order OR payment) AND error) OR warn, so a warn from a
  // service the user never listed still matches.
  const stray = log('cart', 'warn')
  assert.equal(applyChipsToLog(stray, FLAT), true)
  assert.equal(applyChipsToLog(stray, GROUPED), false)
})

test('empty groups and empty lists are neutral', () => {
  assert.equal(applyChipsToLog(log('order', 'error'), []), true)
  assert.equal(applyChipsToLog(log('order', 'error'), [newGroup([])]), true)
})

test('nesting evaluates innermost first', () => {
  // ((error OR warn) AND service:order) OR service:payment
  const nodes = [
    newGroup([
      newGroup([lvl('error'), lvl('warn', 'OR')]),
      svc('order', 'AND'),
    ]),
    svc('payment', 'OR'),
  ]
  assert.equal(applyChipsToLog(log('order', 'error'), nodes), true)
  assert.equal(applyChipsToLog(log('payment', 'info'), nodes), true)
  assert.equal(applyChipsToLog(log('order', 'info'), nodes), false)
  assert.equal(applyChipsToLog(log('cart', 'error'), nodes), false)
})

test('serialization brackets groups and keeps stream promotion for leading chips', () => {
  // `service` is stream-eligible, so the leading group must NOT be promoted
  // into a {} block — only bare leading chips can be.
  assert.equal(
    chipsToString(GROUPED),
    '(service:=order OR service:=payment) AND (log.level:=error OR log.level:=warn)',
  )
  // A bare leading service chip still promotes, with the group left alone.
  assert.equal(
    chipsToString([svc('order'), newGroup([lvl('error'), lvl('warn', 'OR')], 'AND')]),
    '{service="order"} (log.level:=error OR log.level:=warn)',
  )
})

// The three free-text readings are a narrowness ladder: exact phrase, then
// starting-with, then anywhere. These pin the rungs apart — the reported bug
// was that the narrowest one matched everything the widest one did.
const msg = (message) => ({ service: 'x', level: 'info', message, tags: {} })
const ft = (op, value) => [{ field: '_msg', op, value }]

test('a phrase matches whole words, not fragments of them', () => {
  assert.equal(applyChipsToLog(msg('proces failed'), ft('phrase', 'proces')), true)
  // The bug: "processing" contains "proces", but it is not the word "proces".
  assert.equal(applyChipsToLog(msg('processing order'), ft('phrase', 'proces')), false)
  assert.equal(applyChipsToLog(msg('PROCES failed'), ft('phrase', 'proces')), true)
})

test('a multi-word phrase needs the words consecutive and in order', () => {
  const q = ft('phrase', 'connection refused')
  assert.equal(applyChipsToLog(msg('got connection refused here'), q), true)
  assert.equal(applyChipsToLog(msg('refused connection'), q), false)
  assert.equal(applyChipsToLog(msg('connection was refused'), q), false)
})

test('starting-with matches a word prefix anywhere in the message', () => {
  assert.equal(applyChipsToLog(msg('order processing failed'), ft('prefix', 'proces')), true)
  assert.equal(applyChipsToLog(msg('order reprocessing failed'), ft('prefix', 'proces')), false)
})

test('starting-with still anchors a single-token field value', () => {
  const status = { service: 'x', level: 'info', message: '', tags: { 'http.status': '503' } }
  assert.equal(applyChipsToLog(status, [{ field: 'http.status', op: 'prefix', value: '5' }]), true)
  assert.equal(applyChipsToLog(status, [{ field: 'http.status', op: 'prefix', value: '4' }]), false)
})

test('containing still matches inside a word — that is what it is for', () => {
  assert.equal(applyChipsToLog(msg('processing order'), ft('contains', 'proces')), true)
  assert.equal(applyChipsToLog(msg('reprocessing'), ft('contains', 'process')), true)
})

// ---------- What `field:value` means ----------
// Logs and Traces read `:` as LogsQL's word match; the Errors page reads it as
// the original Errors search does, a case-insensitive contains. The words of a
// word match keep their dots and hyphens, so there the short class name and the
// service's first word matched nothing.

const errRow = { exception: 'redis.clients.jedis.exceptions.JedisPoolException', service: 'payment-service' }
const errValue = (r, f) => r[f]
const colon = (field, value) => [{ field, op: 'word', value }]
const CONTAINS = { colonMatch: 'contains' }

test('by default `field:value` is a word match, so a fragment of a dotted or hyphenated value misses', () => {
  assert.equal(applyChipsToLog(errRow, colon('exception', 'JedisPoolException'), errValue), false)
  assert.equal(applyChipsToLog(errRow, colon('service', 'payment'), errValue), false)
  assert.equal(applyChipsToLog(errRow, colon('service', 'payment-service'), errValue), true)
  assert.equal(applyChipsToLog(msg('connection refused'), [{ field: '_msg', op: 'word', value: 'refused' }]), true)
  assert.equal(applyChipsToLog(msg('connection refused'), [{ field: '_msg', op: 'word', value: 'refuse' }]), false)
})

test('where a page reads `:` as contains, any part of the value matches, in any case', () => {
  assert.equal(applyChipsToLog(errRow, colon('exception', 'JedisPoolException'), errValue, CONTAINS), true)
  assert.equal(applyChipsToLog(errRow, colon('exception', 'Jed'), errValue, CONTAINS), true)
  assert.equal(applyChipsToLog(errRow, colon('exception', 'jedispool'), errValue, CONTAINS), true)
  assert.equal(applyChipsToLog(errRow, colon('service', 'payment'), errValue, CONTAINS), true)
  assert.equal(applyChipsToLog(errRow, colon('service', 'order'), errValue, CONTAINS), false)
  // Inside groups too, not just at the top level.
  const grouped = [newGroup([...colon('service', 'order'), { ...colon('exception', 'Pool')[0], connector: 'OR' }])]
  assert.equal(applyChipsToLog(errRow, grouped, errValue, CONTAINS), true)
  assert.equal(applyChipsToLog(errRow, grouped, errValue), false)
})

test('`:=` stays exact and case-sensitive whatever `:` means', () => {
  const eq = value => [{ field: 'exception', op: 'eq', value }]
  assert.equal(applyChipsToLog(errRow, eq('JedisPoolException'), errValue, CONTAINS), false)
  assert.equal(applyChipsToLog(errRow, eq('redis.clients.jedis.exceptions.jedispoolexception'), errValue, CONTAINS), false)
  assert.equal(applyChipsToLog(errRow, eq(errRow.exception), errValue, CONTAINS), true)
})

test('the chip text is `field:value` on every page, so a query reads back the same chip', () => {
  const chips = colon('exception', 'Jedis')
  assert.equal(roundTrips(chips), 'exception:Jedis')
})

// ---------- Query text round trip ----------
// chipsToString is how a query travels: recents, the copied query, a pasted
// query, the Errors page URL. Each of those reads it back with
// tryParseConditions, so whatever the builder writes has to parse back to the
// chips it came from. These are the values that did not: span names with
// spaces, values carrying quotes, colons or brackets.

const leaf = (field, op, value, connector) => (
  connector ? { field, op, value, connector } : { field, op, value }
)

function roundTrips(chips) {
  const text = chipsToString(chips)
  const back = tryParseConditions(text)
  assert.equal(back.ok, true, `expected "${text}" to parse, got: ${back.error}`)
  assert.deepEqual(back.chips, chips, `"${text}" read back as something else`)
  return text
}

test('a span name with spaces and a colon is quoted, and reads back as one filter', () => {
  const chips = [leaf('span_name', 'eq', 'POST /v1/payments/:id/capture')]
  assert.equal(roundTrips(chips), 'span_name:="POST /v1/payments/:id/capture"')
  // The bug: written raw, the parser read a filter on POST plus a second filter
  // on a field called "/v1/payments/" — no error, just a different query.
  const raw = tryParseConditions('span_name:=POST /v1/payments/:id/capture')
  assert.notDeepEqual(raw.chips, chips)
})

test('a dotted exception class needs no quotes and reads back exactly', () => {
  assert.equal(
    roundTrips([leaf('exception', 'eq', 'redis.clients.jedis.exceptions.JedisPoolException')]),
    'exception:=redis.clients.jedis.exceptions.JedisPoolException',
  )
  assert.equal(
    roundTrips([leaf('exception', 'neq', 'com.cubedemo.payment.CardDeclinedException')]),
    'exception!=com.cubedemo.payment.CardDeclinedException',
  )
  assert.equal(roundTrips([leaf('exception', 'word', 'java.lang.RuntimeException')]), 'exception:java.lang.RuntimeException')
})

test('an http_code prefix stays bare: 5* is the spelling people type', () => {
  assert.equal(roundTrips([leaf('http_code', 'prefix', '5')]), 'http_code:5*')
})

test('in and not_in lists keep values with spaces whole', () => {
  roundTrips([leaf('span_name', 'in', ['POST /v1/payments', 'GET /v1/payments/:id'])])
  roundTrips([leaf('endpoint', 'not_in', ['POST /v1/orders', 'PATCH /v1/payments/:id'])])
  // A stream-promoted list too.
  assert.equal(
    roundTrips([leaf('service', 'in', ['payment-service', 'order-service'])]),
    '{service in ("payment-service", "order-service")}',
  )
})

test('free text round trips in every reading the builder offers for one word or a phrase', () => {
  assert.equal(roundTrips([leaf('_msg', 'phrase', 'Could not get a resource')]), '_msg:"Could not get a resource"')
  assert.equal(roundTrips([leaf('_msg', 'contains', 'Timeout')]), '_msg:*Timeout*')
  assert.equal(roundTrips([leaf('_msg', 'prefix', 'Jedis')]), '_msg:Jedis*')
  // The split reading lands one chip per word, AND-ed.
  roundTrips([leaf('_msg', 'contains', 'card'), leaf('_msg', 'contains', 'declined', 'AND')])
})

test('quotes and backslashes inside a value are escaped, not lost', () => {
  roundTrips([leaf('message', 'eq', 'expected "}" at line 3')])
  roundTrips([leaf('message', 'phrase', 'say "hi"')])
  // The bug: a regex went out raw, and the parser reads `\.` as an escaped
  // dot, so `^/api\.v1` came back as `^/api.v1` — a different pattern.
  roundTrips([leaf('path', 'regex', '^/api\\.v1')])
  roundTrips([leaf('path', 'nregex', 'a\\\\b')])
  roundTrips([leaf('service', 'eq', 'odd"name')])
})

test('groups of quoted values round trip with their connectors', () => {
  const chips = [
    newGroup([
      leaf('span_name', 'eq', 'POST /v1/payments'),
      leaf('span_name', 'eq', 'GET /v1/payments/:id', 'OR'),
    ]),
    leaf('http_code', 'prefix', '5', 'AND'),
    leaf('exception', 'neq', 'com.cubedemo.payment.CardDeclinedException', 'AND'),
  ]
  assert.equal(
    roundTrips(chips),
    '(span_name:="POST /v1/payments" OR span_name:="GET /v1/payments/:id") AND http_code:5* AND exception!=com.cubedemo.payment.CardDeclinedException',
  )
})

test('values that already read back bare are written exactly as before', () => {
  assert.equal(chipsToString([leaf('url', 'word', 'http://x/y')]), 'url:http://x/y')
  assert.equal(chipsToString([leaf('path', 'contains', 'pay')]), 'path:*pay*')
  assert.equal(chipsToString([leaf('path', 'regex', '^/api')]), 'path:~"^/api"')
  assert.equal(chipsToString([leaf('log.level', 'eq', 'error')]), 'log.level:=error')
})

test('a word that cannot be written bare becomes a phrase, which is stable from then on', () => {
  // The raw grammar has no quoted word; a quoted value after `:` IS a phrase,
  // which is also how LogsQL reads it — the same tokens, in order.
  const text = chipsToString([leaf('span_name', 'word', 'GET /v1/search')])
  assert.equal(text, 'span_name:"GET /v1/search"')
  const back = tryParseConditions(text)
  assert.deepEqual(back.chips, [leaf('span_name', 'phrase', 'GET /v1/search')])
  assert.equal(chipsToString(back.chips), text)
})

test('a starts-with or contains is written the LogsQL way when it needs quotes, and reads back whole', () => {
  assert.equal(roundTrips([leaf('_msg', 'contains', 'timed out')]), '_msg:*"timed out"*')
  assert.equal(roundTrips([leaf('_msg', 'prefix', 'Could not')]), '_msg:"Could not"*')
  // The bug: bare, `f:*"a* AND g:*x"*` also reads as one contains on `a* AND g:*x`.
  assert.equal(roundTrips([leaf('f', 'contains', '"a'), leaf('g', 'contains', 'x"', 'AND')]), 'f:*"\\"a"* AND g:*x"*')
  assert.equal(roundTrips([leaf('_msg', 'contains', '"status'), leaf('_msg', 'contains', '500"', 'OR')]), '_msg:*"\\"status"* OR _msg:*500"*')
})

test('an exact match on a value with an unbalanced bracket is quoted, so the pipes after it still run', () => {
  // Whatever reads the text, the pipes after a bracketed value must still split
  // off: once, a bare bracket swallowed the ` | limit 5` into the conditions.
  const chips = [leaf('message', 'eq', '[WARN')]
  const text = roundTrips(chips)
  assert.equal(text, 'message:="[WARN"')
  assert.deepEqual(splitQuery(`${text} | limit 5`).pipes, ['limit 5'])
  roundTrips([leaf('message', 'neq', 'done]')])
})

test('a stream-eligible chip that an OR joins to the next stays a term, so the OR survives', () => {
  // The bug: `{service="payment-service"} exception:=X`, which reads back as AND.
  assert.equal(
    roundTrips([leaf('service', 'eq', 'payment-service'), leaf('exception', 'eq', 'X', 'OR')]),
    'service:=payment-service OR exception:=X',
  )
  // Only the chip the OR binds to stays out; the run before it is still promoted.
  assert.equal(
    roundTrips([leaf('env', 'eq', 'prod'), leaf('service', 'eq', 'payment-service', 'AND'), leaf('service', 'eq', 'order-service', 'OR')]),
    '{env="prod"} service:=payment-service OR service:=order-service',
  )
  roundTrips([leaf('service', 'eq', 'a'), newGroup([leaf('http_code', 'eq', '500'), leaf('http_code', 'eq', '503', 'OR')], 'OR')])
  // An AND after the run is promoted exactly as before.
  assert.equal(chipsToString([leaf('service', 'eq', 'a'), leaf('exception', 'eq', 'X', 'AND')]), '{service="a"} exception:=X')
})

test('the chip itself still shows the value raw', () => {
  // Quoting is for the text; a pill reads fine without it.
  assert.deepEqual(chipSegments('eq', 'POST /v1/payments/:id/capture'),
    { prefix: ':=', value: 'POST /v1/payments/:id/capture', suffix: '' })
  assert.deepEqual(chipSegments('in', ['a b', 'c']), { prefix: ' in (', value: '"a b", "c"', suffix: ')' })
  assert.deepEqual(chipSegments('regex', '^/api\\.v1'), { prefix: ':~"', value: '^/api\\.v1', suffix: '"' })
})

// ---------- Free text: what Enter commits ----------
// Where a page opts into enterCommitsFreeText, Enter commits the first reading
// buildFreeTextOptions offers. These pin which one that is.

test('one typed word reads first as an exact phrase', () => {
  const [first] = buildFreeTextOptions('RuntimeException')
  assert.equal(first.op, 'phrase')
  assert.equal(first.value, 'RuntimeException')
})

test('several words read first as all-of-these-words, one chip each', () => {
  const [first] = buildFreeTextOptions('card declined')
  assert.equal(first.kind, 'split')
  assert.deepEqual(first.words, ['card', 'declined'])
})

test('decoration the user typed picks the reading', () => {
  assert.equal(buildFreeTextOptions('Jedis*')[0].op, 'prefix')
  assert.equal(buildFreeTextOptions('Jedis*')[0].value, 'Jedis')
  assert.equal(buildFreeTextOptions('*pool*')[0].op, 'contains')
  assert.equal(buildFreeTextOptions('"timed out"')[0].op, 'phrase')
})

test('a page can lead a bare term with its own reading, and only a bare term', () => {
  const CONTAINS = { lead: 'contains' }
  // Errors reads a bare term as a substring, as the original page did.
  assert.equal(buildFreeTextOptions('payment', CONTAINS)[0].op, 'contains')
  assert.deepEqual(buildFreeTextOptions('payment', CONTAINS).map(o => o.op), ['contains', 'phrase', 'prefix'])
  // What the user wrote out still wins, and several words still split first.
  assert.equal(buildFreeTextOptions('"payment"', CONTAINS)[0].op, 'phrase')
  assert.equal(buildFreeTextOptions('pay*', CONTAINS)[0].op, 'prefix')
  assert.equal(buildFreeTextOptions('card declined', CONTAINS)[0].kind, 'split')
  assert.equal(buildFreeTextOptions('card declined', CONTAINS)[1].op, 'contains')
  // Without one, nothing moves: Logs and Traces keep the phrase first.
  assert.deepEqual(buildFreeTextOptions('payment').map(o => o.op), ['phrase', 'prefix', 'contains'])
})

// ---------- Matching values ----------

const JEDIS_POOL = 'redis.clients.jedis.exceptions.JedisPoolException'            // 49 chars
const JEDIS_CONN = 'redis.clients.jedis.exceptions.JedisConnectionException'      // 55 chars
const series = (exception, endpoint, count, spanName = endpoint) => ({ exception, endpoint, spanName, count })
const fieldOf = (row, field) => (field === 'span_name' ? row.spanName : row[field])
const ROWS = [
  series(JEDIS_POOL, 'POST /v1/payments/:id/capture', 235),
  series(JEDIS_POOL, 'GET /v1/payments/:id', 195),
  series(JEDIS_CONN, 'GET /v1/payments/:id', 12, 'SETEX redis.session:*'),
  series('java.lang.RuntimeException', 'PATCH /v1/payments/:id', 9),
]
const FIELDS = ['exception', 'endpoint', 'span_name']

test('the value index counts what each row stands for, not rows', () => {
  const index = buildValueIndex(ROWS, FIELDS, { getValue: fieldOf, weight: r => r.count })
  const pool = index.find(e => e.field === 'exception' && e.value === JEDIS_POOL)
  assert.equal(pool.count, 430)
  // Without a weight each row is one occurrence, as on Logs.
  const unweighted = buildValueIndex(ROWS, FIELDS, { getValue: fieldOf })
  assert.equal(unweighted.find(e => e.value === JEDIS_POOL).count, 2)
})

test('the value index keeps every value — no top-k cut, no length cap', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ exception: `com.example.deep.package.Failure${i}Exception`, count: 1 }))
  const index = buildValueIndex(many, ['exception'], { getValue: (r, f) => r[f] })
  assert.equal(index.length, 40)
})

test('matching values need two characters', () => {
  const index = buildValueIndex(ROWS, FIELDS, { getValue: fieldOf })
  assert.deepEqual(rankMatchingValues(index, 'j'), [])
  assert.deepEqual(rankMatchingValues(index, ' '), [])
  assert.ok(rankMatchingValues(index, 'je').length > 0)
})

test('matching values are case-insensitive substrings, most frequent first', () => {
  const index = buildValueIndex(ROWS, FIELDS, { getValue: fieldOf, weight: r => r.count })
  const hits = rankMatchingValues(index, 'JEDIS')
  assert.deepEqual(hits.map(h => [h.field, h.value, h.count]), [
    ['exception', JEDIS_POOL, 430],
    ['exception', JEDIS_CONN, 12],
  ])
})

test('the same value with the same count under two fields is listed once, under the earlier field', () => {
  // On a server span the span name is the endpoint: one row, not two.
  const index = buildValueIndex(ROWS, FIELDS, { getValue: fieldOf, weight: r => r.count })
  const hits = rankMatchingValues(index, 'capture')
  assert.deepEqual(hits.map(h => h.field), ['endpoint'])
  // Different counts are different filters, so both stay.
  const ids = rankMatchingValues(index, 'payments/:id').map(h => `${h.field} ${h.value} ${h.count}`)
  assert.ok(ids.includes('endpoint GET /v1/payments/:id 207'))
  assert.ok(ids.includes('span_name GET /v1/payments/:id 195'))
})

test('matching values stop at the limit, ties broken by field order then value', () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ exception: `x.Err${String(i).padStart(2, '0')}`, endpoint: `GET /err/${i}`, count: 1 }))
  const index = buildValueIndex(rows, ['endpoint', 'exception'], { getValue: (r, f) => r[f] })
  const hits = rankMatchingValues(index, 'err')
  assert.equal(hits.length, 8)
  assert.ok(hits.every(h => h.field === 'endpoint'))
  assert.equal(hits[0].value, 'GET /err/0')
  assert.equal(rankMatchingValues(index, 'err', 30).length, 24)
})

// ---------- Landing a multi-chip reading ----------
// The word split lands a chip per word. Enter commits it on the Errors page,
// so whatever the builder is pointed at — a pending connector, a chip being
// edited, an open group — reaches it there on the main gesture.

const words = [leaf('_msg', 'contains', 'card'), leaf('_msg', 'contains', 'declined')]
const X = leaf('service', 'eq', 'payment-service')
const Y = leaf('http_code', 'eq', '402', 'OR')

test('AND-ed onto the end, the words land loose, as they always have', () => {
  assert.deepEqual(landChips([], words), [words[0], { connector: 'AND', ...words[1] }])
  assert.deepEqual(landChips([X], words), [X, { connector: 'AND', ...words[0] }, { connector: 'AND', ...words[1] }])
  assert.deepEqual(landChips([X], words, { connector: 'AND' }), landChips([X], words))
})

test('after a pending OR the words land as one group, so the OR joins all of them', () => {
  const next = landChips([X], words, { connector: 'OR' })
  assert.deepEqual(next, [X, newGroup([words[0], { connector: 'AND', ...words[1] }], 'OR')])
  assert.equal(chipsToString(next), 'service:=payment-service OR (_msg:*card* AND _msg:*declined*)')
  assert.deepEqual(tryParseConditions(chipsToString(next)).chips, next)
  // Loose, it read as (service OR card) AND declined: a payment error without
  // "declined" in it was dropped.
  const row = { service: 'payment-service', message: 'Card was fine', tags: {} }
  const get = (r, f) => (f === '_msg' ? r.message : r[f])
  assert.equal(applyChipsToLog(row, next, get), true)
})

test('in place of a chip being edited, the words replace it as a group with its connector', () => {
  const next = landChips([X, Y], words, { editingPath: [1] })
  assert.equal(next.length, 2)
  assert.deepEqual(next[1], newGroup([words[0], { connector: 'AND', ...words[1] }], 'OR'))
  // Editing the first chip: nothing before it, so no connector at all.
  assert.deepEqual(landChips([X, Y], words, { editingPath: [0] })[0], newGroup([words[0], { connector: 'AND', ...words[1] }]))
})

test('inside an open group the words land in the group', () => {
  const open = [X, newGroup([], 'AND')]
  const next = landChips(open, words, { insertionPath: [1] })
  assert.deepEqual(next[1].children, [words[0], { connector: 'AND', ...words[1] }])
})
