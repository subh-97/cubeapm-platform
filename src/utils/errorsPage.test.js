// The Errors page's own decisions: how groups sort, what a link or a side
// switch does to the selection, what an empty table says, and what the CSV
// carries.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveWindow } from '@/data/timeWindow'
import { errorSeriesForWindow } from '@/data/errors'
import {
  applyErrorFacets, getErrorFieldValue, ERROR_EXAMPLE_QUERIES, ERROR_RECENT_SEEDS,
} from '@/utils/errorFields'
import { errorsSearch } from '@/utils/errorsUrl'
import { chipsToString, applyChipsToLog } from '@/components/QueryBuilder'
import { newGroup, normalize } from '@/utils/queryTree'
import {
  httpReason, httpCodeClass, exceptionParts, previousPeriodText, deltaChip, sortErrorGroups,
  toggleFacetValue, hasFacetSelection, facetsForKind, facetSets, errorsStateFromLink,
  explainEmpty, errorGroupsCsv,
  initialErrorsState, sameSearch, parsePastedErrorsQuery,
} from './errorsPage.js'

// The link the user pasted from the original CubeAPM Errors page (spec §0.8).
const USER_URL = '?service=payment-service&view=graph&index=cube%3Aerror&error=TypeError'
  + '&name=POST+api.stripe.com%2Fv1%2Fpayment_intents&kind=server&time=7d&refresh=1696700000000'
  + '&endpoint=&category=&host=&sv='

const lists = facets => Object.fromEntries(Object.entries(facets).map(([k, v]) => [k, [...v]]))

const group = (over) => ({
  id: over.id, side: 'server', service: 'order-service', endpoint: 'GET /v1/order', spanName: 'GET /v1/order',
  category: 'http', exception: 'java.lang.RuntimeException', message: 'boom', httpCodes: [], count: 1, prevCount: 0,
  firstSeenMs: null, lastSeenMs: null, ...over,
})

// ---------- small readings ----------

test('a code reads with its reason phrase, and an unknown code with none', () => {
  assert.equal(httpReason('500'), 'Internal Server Error')
  assert.equal(httpReason(503), 'Service Unavailable')
  assert.equal(httpReason('429'), 'Too Many Requests')
  assert.equal(httpReason('599'), '')
})

test('a code chip is 5xx for the server failing and 4xx for the caller refused', () => {
  assert.equal(httpCodeClass('504'), 'is-5xx')
  assert.equal(httpCodeClass('402'), 'is-4xx')
  assert.equal(httpCodeClass('200'), 'is-2xx')
})

test('an exception splits into its package and the class name that must always show', () => {
  assert.deepEqual(exceptionParts('redis.clients.jedis.exceptions.JedisPoolException'),
    { pkg: 'redis.clients.jedis.exceptions.', short: 'JedisPoolException' })
  assert.deepEqual(exceptionParts('TypeError'), { pkg: '', short: 'TypeError' })
  assert.deepEqual(exceptionParts(''), { pkg: '', short: '' })
})

test('a delta names the window it compares with', () => {
  assert.equal(previousPeriodText({ kind: 'preset', value: '1h' }), 'the previous hour')
  assert.equal(previousPeriodText({ kind: 'preset', value: '7d' }), 'the previous 7 days')
  assert.equal(previousPeriodText({ kind: 'preset', value: '15m' }), 'the previous 15 minutes')
  assert.equal(previousPeriodText({ kind: 'preset', value: 'today' }), 'the same stretch of yesterday')
  assert.equal(previousPeriodText({ kind: 'absolute', from: 0, to: 1 }), 'the previous period of the same length')
})

test('Today so far is compared with the hours before midnight, not with yesterday morning', () => {
  // previousWindow shifts back by the window's own span, and Today so far
  // spans only the hours since midnight, so its comparison ends at midnight.
  assert.equal(previousPeriodText({ kind: 'preset', value: 'todayf' }), 'the same length of time before midnight')
})

test('a count reads against the previous window, and a group with nothing before reads New', () => {
  const up = deltaChip(235, 50, 'the previous hour')
  assert.equal(up.dir, 'up')
  assert.equal(up.title, `${up.label} vs the previous hour (50 then)`)
  const fresh = deltaChip(235, 0, 'the previous hour')
  assert.equal(fresh.label, 'New')
  assert.equal(fresh.title, 'New: none in the previous hour')
})

// ---------- sorting ----------

test('groups sort by count, biggest first, and flip on asc', () => {
  const gs = [group({ id: 'a', count: 5 }), group({ id: 'b', count: 50 }), group({ id: 'c', count: 9 })]
  assert.deepEqual(sortErrorGroups(gs).map(g => g.id), ['b', 'c', 'a'])
  assert.deepEqual(sortErrorGroups(gs, { key: 'count', dir: 'asc' }).map(g => g.id), ['a', 'c', 'b'])
})

test('sorting by endpoint puts the critical service first, never the alphabetically first one', () => {
  const status = { 'payment-service': 'critical', 'notify-service': 'healthy', 'order-service': 'warning' }
  const gs = [
    group({ id: 'n', service: 'notify-service', count: 900 }),
    group({ id: 'o', service: 'order-service', count: 30 }),
    group({ id: 'p', service: 'payment-service', count: 2 }),
  ]
  assert.deepEqual(sortErrorGroups(gs, { key: 'endpoint', dir: 'asc' }, status).map(g => g.id), ['p', 'o', 'n'])
  assert.deepEqual(sortErrorGroups(gs, { key: 'endpoint', dir: 'desc' }, status).map(g => g.id), ['n', 'o', 'p'])
})

test('sorting by error reads the class name, not the package', () => {
  const gs = [
    group({ id: 'z', exception: 'a.b.ZooException' }),
    group({ id: 'a', exception: 'z.y.AppleException' }),
  ]
  assert.deepEqual(sortErrorGroups(gs, { key: 'error', dir: 'asc' }).map(g => g.id), ['a', 'z'])
})

// ---------- selection ----------

test('ticking and unticking a value leaves no empty field behind', () => {
  let f = toggleFacetValue({}, 'service', 'payment-service')
  assert.deepEqual([...f.service], ['payment-service'])
  assert.equal(hasFacetSelection(f), true)
  f = toggleFacetValue(f, 'service', 'payment-service')
  assert.deepEqual(f, {})
  assert.equal(hasFacetSelection(f), false)
})

test('switching to Server drops the span name a Server rail cannot show; Client keeps everything', () => {
  const f = facetSets({ service: ['payment-service'], span_name: ['GET redis.session:*'] })
  assert.deepEqual(Object.keys(facetsForKind(f, 'server')), ['service'])
  assert.deepEqual(Object.keys(facetsForKind(f, 'client')), ['service', 'span_name'])
})

test('a link from another page becomes ticked facets on its side', () => {
  const s = errorsStateFromLink({ view: 'errors', service: 'payment-service', kind: 'client', spanName: 'GET redis.session:*' })
  assert.equal(s.kind, 'client')
  assert.deepEqual(Object.fromEntries(Object.entries(s.facets).map(([k, v]) => [k, [...v]])),
    { service: ['payment-service'], span_name: ['GET redis.session:*'] })
  assert.equal(errorsStateFromLink({ view: 'errors', kind: 'sideways' }).kind, 'server')
})

// ---------- empty states ----------

test('a side with no errors at all says so as good news', () => {
  const e = explainEmpty({ rows: [], side: 'client', rangeText: 'Last 5 minutes' })
  assert.equal(e.kind, 'quiet')
  assert.equal(e.title, 'No client errors in Last 5 minutes')
  assert.match(e.sub, /outgoing call/)
})

test('the pasted link names the values that never occur, instead of a bare "no results"', () => {
  const win = resolveWindow({ kind: 'preset', value: '7d' })
  const e = explainEmpty({
    rows: errorSeriesForWindow(win, 'server'),
    otherRows: errorSeriesForWindow(win, 'client'),
    facets: facetSets({ service: ['payment-service'], exception: ['TypeError'], span_name: ['POST api.stripe.com/v1/payment_intents'] }),
    side: 'server',
    rangeText: 'Last 7 days',
  })
  assert.equal(e.kind, 'filtered')
  assert.ok(e.notes.includes('TypeError has no occurrences in Last 7 days.'))
  assert.ok(e.notes.some(n => n.startsWith('POST api.stripe.com/v1/payment_intents has no')))
  assert.ok(!e.notes.some(n => n.startsWith('payment-service')), 'a value that does occur is not blamed')
  assert.equal(e.switchTo, null)
})

test('a client call ticked on Server is pointed at Client', () => {
  const win = resolveWindow({ kind: 'preset', value: '1h' })
  const e = explainEmpty({
    rows: errorSeriesForWindow(win, 'server'),
    otherRows: errorSeriesForWindow(win, 'client'),
    facets: facetSets({ span_name: ['GET redis.session:*'] }),
    side: 'server',
    rangeText: 'Last 1 hour',
  })
  assert.match(e.notes[0], /has no server errors in Last 1 hour\. It has [\d,]+ on Client\./)
  assert.equal(e.switchTo, 'client')
})

test('a search that only matches the other side says where its errors are', () => {
  const win = resolveWindow({ kind: 'preset', value: '1h' })
  const e = explainEmpty({
    rows: errorSeriesForWindow(win, 'server'),
    otherRows: errorSeriesForWindow(win, 'client'),
    matchesSearch: r => r.exception === 'com.cubedemo.payment.CardDeclinedException',
    searchText: 'exception:=com.cubedemo.payment.CardDeclinedException',
    side: 'server',
    rangeText: 'Last 1 hour',
  })
  assert.match(e.notes[0], /^The search matches no server errors in Last 1 hour\. It matches [\d,]+ on Client\.$/)
  assert.equal(e.switchTo, 'client')
})

test('the other side is offered only when it has errors for the whole selection, not for each value alone', () => {
  const win = resolveWindow({ kind: 'preset', value: '1h' })
  const client = errorSeriesForWindow(win, 'client')
  const facets = facetSets({ service: ['notify-service'], span_name: ['GET redis.session:*'] })
  // Both values are on Client, but never on the same error.
  assert.ok(applyErrorFacets(client, { span_name: ['GET redis.session:*'] }).length > 0)
  assert.equal(applyErrorFacets(client, facets).length, 0)
  const e = explainEmpty({
    rows: errorSeriesForWindow(win, 'server'), otherRows: client, facets, side: 'server', rangeText: 'Last 1 hour',
  })
  assert.match(e.notes[0], /^GET redis\.session:\* has no server errors in Last 1 hour\. It has [\d,]+ on Client\.$/)
  assert.equal(e.switchTo, null)
})

test('a combination only the other side has is pointed at, with a reason beside the button', () => {
  const win = resolveWindow({ kind: 'preset', value: '1h' })
  // payment-service and the Twilio exception each fail on Server, but only
  // payment's outgoing Twilio calls have both.
  const e = explainEmpty({
    rows: errorSeriesForWindow(win, 'server'),
    otherRows: errorSeriesForWindow(win, 'client'),
    facets: facetSets({ service: ['payment-service'], exception: ['com.twilio.exception.ApiException'] }),
    side: 'server',
    rangeText: 'Last 1 hour',
  })
  assert.equal(e.switchTo, 'client')
  assert.deepEqual(e.notes.slice(0, 1), ['service and exception each match errors on their own, but no error matches both at once.'])
  assert.match(e.notes[1], /^On Client, these filters match [\d,]+ errors\.$/)
})

test('a value at 0 beside a sibling with errors is not blamed, because values of one field are alternatives', () => {
  const win = resolveWindow({ kind: 'preset', value: '1h' })
  const rows = errorSeriesForWindow(win, 'server')
  const otherRows = errorSeriesForWindow(win, 'client')
  // analytics-service has no server errors, but payment-service beside it
  // does, so unticking it would leave the table as empty as it is. What
  // empties it is that no payment-service server error is the Twilio one.
  const facets = facetSets({
    service: ['payment-service', 'analytics-service'], exception: ['com.twilio.exception.ApiException'],
  })
  assert.equal(applyErrorFacets(rows, { service: ['analytics-service'] }).length, 0)
  assert.equal(applyErrorFacets(rows, facets).length, 0)
  const e = explainEmpty({ rows, otherRows, facets, side: 'server', rangeText: 'Last 1 hour' })
  assert.deepEqual(e.filters.map(f => [f.value, f.count > 0]), [
    ['payment-service', true], ['analytics-service', false], ['com.twilio.exception.ApiException', true],
  ])
  assert.equal(e.notes[0], 'service and exception each match errors on their own, but no error matches both at once.')
  assert.match(e.notes[1], /^On Client, these filters match [\d,]+ errors\.$/)
  assert.equal(e.notes.at(-1), 'analytics-service has no occurrences in Last 1 hour, but another service value ticked with it does.')
  assert.equal(e.switchTo, 'client')

  // The same zero sibling must not hide a search that excludes the rest.
  const searched = explainEmpty({
    rows, otherRows, facets: facetSets({ service: ['payment-service', 'analytics-service'] }),
    matchesSearch: r => r.service === 'order-service', searchText: 'service:=order-service',
    side: 'server', rangeText: 'Last 1 hour',
  })
  assert.match(searched.notes[0], /^The ticked filters match [\d,]+ errors, and the search excludes all of them\.$/)
})

test('a field none of whose ticked values occurs is the one named, value by value', () => {
  const win = resolveWindow({ kind: 'preset', value: '1h' })
  const e = explainEmpty({
    rows: errorSeriesForWindow(win, 'server'),
    otherRows: errorSeriesForWindow(win, 'client'),
    facets: facetSets({
      service: ['analytics-service', 'no-such-service'], exception: ['com.twilio.exception.ApiException'],
    }),
    side: 'server',
    rangeText: 'Last 1 hour',
  })
  assert.deepEqual(e.notes, [
    'analytics-service has no occurrences in Last 1 hour.',
    'no-such-service has no occurrences in Last 1 hour.',
  ])
})

test('when every value occurs but the search excludes them, the search is the one named', () => {
  const win = resolveWindow({ kind: 'preset', value: '1h' })
  const e = explainEmpty({
    rows: errorSeriesForWindow(win, 'server'),
    facets: facetSets({ service: ['notify-service'] }),
    matchesSearch: r => r.service === 'payment-service',
    searchText: 'service:=payment-service',
    side: 'server',
    rangeText: 'Last 1 hour',
  })
  assert.equal(e.search, 'service:=payment-service')
  assert.match(e.notes[0], /^The ticked filters match [\d,]+ errors, and the search excludes all of them\.$/)
})

// ---------- the address bar ----------

test('the pasted CubeAPM link opens on Server, Last 7 days, with its three filters ticked', () => {
  const s = initialErrorsState({ pathname: '/errors', search: USER_URL })
  assert.equal(s.kind, 'server')
  assert.equal(s.time, '7d')
  assert.deepEqual(s.chips, [])
  assert.equal(s.lostQuery, false)
  assert.deepEqual(lists(s.facets), {
    service: ['payment-service'],
    exception: ['TypeError'],
    span_name: ['POST api.stripe.com/v1/payment_intents'],
  })
})

test('the pasted link lands on an empty state that names both missing values and offers nowhere else', () => {
  // The whole path the page takes: URL → opening state → the week's rows →
  // the facets filter → nothing → why.
  const s = initialErrorsState({ pathname: '/errors', search: USER_URL })
  const win = resolveWindow({ kind: 'preset', value: s.time })
  const rows = errorSeriesForWindow(win, s.kind)
  assert.equal(applyErrorFacets(rows, s.facets).length, 0)
  const e = explainEmpty({
    rows, otherRows: errorSeriesForWindow(win, 'client'), facets: s.facets, side: s.kind, rangeText: 'Last 7 days',
  })
  assert.equal(e.title, 'No errors match these filters')
  assert.deepEqual(e.filters.map(f => [f.field, f.count > 0]), [
    ['service', true], ['exception', false], ['span_name', false],
  ])
  assert.deepEqual(e.notes, [
    'TypeError has no occurrences in Last 7 days.',
    'POST api.stripe.com/v1/payment_intents has no occurrences in Last 7 days.',
  ])
  assert.equal(e.switchTo, null)
})

test('a link from another page wins over the URL, and carries no time or search of its own', () => {
  const s = initialErrorsState({
    incoming: { view: 'errors', service: 'notify-service', kind: 'client', nonce: 3 },
    pathname: '/errors',
    search: '?service=payment-service&time=7d&q=service:%3Dx',
  })
  assert.equal(s.kind, 'client')
  assert.deepEqual(lists(s.facets), { service: ['notify-service'] })
  assert.deepEqual(s.chips, [])
  assert.equal(s.time, null)
})

test("another page's query string is not read as this page's state", () => {
  // Arriving from the sidebar, the address bar still shows the page being left.
  const s = initialErrorsState({ pathname: '/traces', search: '?service=order-service&time=7d&kind=client' })
  assert.equal(s.kind, 'server')
  assert.deepEqual(s.facets, {})
  assert.equal(s.time, null)
})

test('the search text in a URL comes back as chips, and one that cannot be read is reported', () => {
  const ok = initialErrorsState({ pathname: '/errors', search: '?q=exception:%3Dcom.cubedemo.payment.CardDeclinedException' })
  assert.deepEqual(ok.chips, [{ field: 'exception', op: 'eq', value: 'com.cubedemo.payment.CardDeclinedException' }])
  assert.equal(ok.lostQuery, false)
  const lost = initialErrorsState({ pathname: '/errors', search: '?service=payment-service&q=' + encodeURIComponent('exception:=a OR ()') })
  assert.deepEqual(lost.chips, [])
  assert.equal(lost.lostQuery, true)
  assert.deepEqual(lists(lost.facets), { service: ['payment-service'] }, 'the rest of the link still applies')
})

test('every query the bar offers survives the trip through the URL and matches the same errors', () => {
  // The page writes chipsToString into `q` and reads it back on reload; a
  // query that does not come back whole reloads as a different page.
  const win = resolveWindow({ kind: 'preset', value: '1h' })
  const rows = [...errorSeriesForWindow(win, 'server'), ...errorSeriesForWindow(win, 'client')]
  const queries = [
    ...ERROR_EXAMPLE_QUERIES.map(q => q.chips),
    ...ERROR_RECENT_SEEDS,
    [{ field: 'span_name', op: 'eq', value: 'GET redis.session:*' }],
    [{ field: '_msg', op: 'contains', value: 'timed out' }],
    [{ field: '_msg', op: 'phrase', value: "can't" }, { field: 'service', op: 'eq', value: 'payment-service', connector: 'OR' }],
    [{ field: 'service', op: 'eq', value: 'payment-service' }, newGroup([
      { field: 'http_code', op: 'eq', value: '503' },
      { field: 'exception', op: 'eq', value: 'java.util.concurrent.TimeoutException', connector: 'OR' },
    ], 'AND')],
  ]
  for (const chips of queries) {
    const q = chipsToString(chips)
    const back = initialErrorsState({ pathname: '/errors', search: errorsSearch({ kind: 'client', facets: {}, q }) })
    assert.equal(back.lostQuery, false, q)
    assert.equal(back.kind, 'client')
    assert.equal(chipsToString(back.chips), q)
    const ids = list => rows.filter(r => applyChipsToLog(r, list, getErrorFieldValue)).map(r => r.id)
    assert.deepEqual(ids(back.chips), ids(chips), q)
  }
})

test('a group opened in the bar but not yet filled neither filters the page nor reaches the URL', () => {
  // The page applies normalize(chips): the builder holds the empty group in
  // `chips` while it waits for the group's first filter.
  const win = resolveWindow({ kind: 'preset', value: '1h' })
  const rows = errorSeriesForWindow(win, 'server')
  const composing = [{ field: 'service', op: 'eq', value: 'notify-service' }, newGroup([], 'OR')]
  const match = list => rows.filter(r => applyChipsToLog(r, list, getErrorFieldValue)).length
  assert.equal(match(composing), rows.length, 'raw, the empty OR group matches every row')
  const applied = normalize(composing)
  assert.equal(match(applied), rows.filter(r => r.service === 'notify-service').length)
  const q = chipsToString(applied)
  assert.equal(initialErrorsState({ pathname: '/errors', search: errorsSearch({ q }) }).lostQuery, false)
})

test('two searches that differ only in how the browser escaped them are the same', () => {
  assert.equal(sameSearch("?q=_msg:%22can't%22", '?q=_msg:%22can%27t%22'), true)
  assert.equal(sameSearch('?span_name=POST+api.stripe.com/v1/charges', '?span_name=POST%20api.stripe.com%2Fv1%2Fcharges'), true)
  assert.equal(sameSearch('', '?'), true)
  assert.equal(sameSearch('?service=a', ''), false)
  // Same filters in another order is not our spelling, so it is rewritten.
  assert.equal(sameSearch('?service=a&exception=b', '?exception=b&service=a'), false)
})

test('a pasted query lands as chips, one with pipes is refused, and plain text is left alone', () => {
  const ok = parsePastedErrorsQuery('service:=payment-service AND http_code:5*')
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.chips.map(c => [c.field, c.op]), [['service', 'eq'], ['http_code', 'prefix']])
  const piped = parsePastedErrorsQuery('service:=payment-service | stats count()')
  assert.equal(piped.ok, false)
  assert.match(piped.error, /no pipe stages/)
  assert.deepEqual(parsePastedErrorsQuery('JedisPoolException'), { ok: false, error: null })
})

// ---------- CSV ----------

test('the CSV carries raw numbers, per-code counts and quoted text', () => {
  const csv = errorGroupsCsv([group({
    id: 'g', count: 1234, prevCount: 0, message: 'said "no"',
    httpCodes: [{ code: '500', count: 1000 }, { code: '503', count: 234 }],
    firstSeenMs: Date.UTC(2026, 0, 1), lastSeenMs: Date.UTC(2026, 0, 1, 1),
  })])
  const [head, line] = csv.split('\n')
  assert.match(head, /^"side","service","endpoint"/)
  assert.ok(line.includes('"1234","0"'))
  assert.ok(line.includes('"500:1000 503:234"'))
  assert.ok(line.includes('"said ""no"""'))
  assert.ok(line.includes('"2026-01-01T00:00:00.000Z","2026-01-01T01:00:00.000Z"'))
})
