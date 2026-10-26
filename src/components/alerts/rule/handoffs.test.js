// The rule page's ways out (docs/alerts/DESIGN.md D5), each followed to where
// it lands, the way tracesHandoff.test follows the Errors page's links. The
// risk is a link that lands on an empty table, which reads as "no evidence"
// rather than as a broken link. So every payload goes through what App's
// openLink and the target page do with it — filtersToChips and the Traces
// stream, the Logs evaluator, Errors' facets, the service route, Explore's
// incoming payload and its engine — and has to come back with rows.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveWindow } from '@/data/timeWindow'
import { spanRowsForWindow } from '@/data/tracesExplorer'
import { logRowsForWindow, infraHostsForWindow } from '@/data/observability'
import { errorSeriesForWindow } from '@/data/errors'
import { createAlertsStore, alertsFor } from '@/utils/alerts/store'
import { applyChipsToLog, chipsToString } from '@/components/QueryBuilder'
import { getSpanFieldValue } from '@/utils/traceFields'
import { filtersToChips, errorSamplesFor, mergeErrorSpans } from '@/utils/tracesHandoff'
import { errorsStateFromLink } from '@/utils/errorsPage'
import { applyErrorFacets } from '@/utils/errorFields'
import { parseRoute, serviceUrl } from '@/utils/route'
import { applyIncoming, initialState } from '@/utils/explore/editorState'
import { queryRange, setSimulatedLatency } from '@/utils/explore/api'
import { tryParseConditions } from '@/utils/rawQuery'
import { instanceRows } from './rulePage.js'
import { failingExceptions } from './evidence.js'
import {
  serviceHandoff, hostHandoff, tracesHandoff, logsHandoff, errorsHandoff, exploreHandoff, exploreCanRead, handoffsFor,
  handoffRange, HANDOFF_HALF_SPAN_SEC, EXPLORE_UNREADABLE,
} from './handoffs.js'

const win = resolveWindow({ kind: 'preset', value: '1h' })
const nowSec = win.nowSec
const alerts = alertsFor(createAlertsStore({ storage: null }).getState(), win)
const view = id => alerts.byId(id)
// When a rule's worst instance became active: the anchor the page uses.
const anchorOf = id => instanceRows(view(id), alerts.seriesFor(id))[0]?.activeAt ?? view(id).since

// What the Traces page shows for a link: its seeded spans plus the error
// samples a query names the exception of, through the chips App builds.
function tracesRows(handoff) {
  const chips = filtersToChips(handoff.link.filters)
  const w = resolveWindow(handoff.range)
  const stream = mergeErrorSpans(spanRowsForWindow(w), errorSamplesFor(w, chips))
  return stream.filter(r => applyChipsToLog(r, chips, getSpanFieldValue))
}

test('the service handoff opens the rule\'s service on the tab with its evidence', () => {
  assert.deepEqual(serviceHandoff(view(501)), { view: 'service', serviceId: 'payment-service', subTab: 'errors' })
  assert.deepEqual(serviceHandoff(view(502)), { view: 'service', serviceId: 'payment-service', subTab: 'red' })
  // Production's demo rule names its endpoint, which is the Detail tab's.
  assert.deepEqual(serviceHandoff(view(437)), { view: 'service', serviceId: 'payment-service', subTab: 'errors', endpoint: 'POST /v1/payments' })
  const link = serviceHandoff(view(501))
  assert.deepEqual(parseRoute(serviceUrl(link.serviceId, link.subTab).split('?')[0], '?tab=errors'),
    { view: 'service', serviceId: 'payment-service', serviceSubTab: 'errors' })
  assert.equal(serviceHandoff(view(514)), null, 'redis.0 is not a service the app has a page for')
})

test('a host rule\'s series opens its host on Infrastructure, a host the Hosts source lists', () => {
  const v = view(515)
  const rows = instanceRows(v, alerts.seriesFor(515))
  assert.ok(rows.length >= 2, 'one series per host')
  const listed = infraHostsForWindow(win)
  for (const row of rows) {
    const link = hostHandoff(v, { row })
    assert.deepEqual(link, { view: 'infra', source: 'host', resource: row.labels['host.name'] })
    // App's openLink drills into the host only when the Hosts source has it,
    // and the host page then charts its CPU.
    const host = listed.find(h => h.host === link.resource)
    assert.ok(host, `${link.resource} is listed on Infrastructure`)
    assert.ok(Number.isFinite(host.cpu))
  }
  // A rule over every host names none of them until a series is picked.
  assert.equal(hostHandoff(v), null)
  // A name the Hosts source does not list would land on the list, so no handoff.
  assert.equal(hostHandoff(v, { row: { labels: { 'host.name': 'node-4' } } }), null)
  // A rule whose matcher names one host opens it without a series.
  const one = rows[0].labels['host.name']
  assert.deepEqual(hostHandoff({ scope: { service: null, endpoint: null, host: one } }), { view: 'infra', source: 'host', resource: one })
  assert.equal(hostHandoff(view(501)), null, 'a service rule has no host')
})

test('the banner offers a picked series\' host beside the service, on the range already on screen', () => {
  const v = view(515)
  const row = instanceRows(v, alerts.seriesFor(515))[1]
  const ways = handoffsFor(v, { row, anchorSec: row.activeAt, nowSec })
  assert.deepEqual(ways.map(h => h.id), ['host', 'explore'])
  const host = ways.find(h => h.id === 'host')
  assert.equal(host.label, `Open ${row.labels['host.name']}`)
  assert.equal(host.title, `The ${row.labels['host.name']} host on Infrastructure`)
  assert.equal(host.range, null)
  assert.deepEqual(handoffsFor(v, { anchorSec: anchorOf(515), nowSec }).map(h => h.id), ['explore'])
})

test('the Traces handoff opens ±5 minutes around when the alert became active, never past now', () => {
  const a = anchorOf(501)
  const t = tracesHandoff(view(501), { anchorSec: a, nowSec })
  assert.deepEqual(t.range, { kind: 'absolute', from: (a - HANDOFF_HALF_SPAN_SEC) * 1000, to: (a + HANDOFF_HALF_SPAN_SEC) * 1000 })
  const late = handoffRange(nowSec - 60, nowSec)
  assert.equal(late.to, nowSec * 1000, 'clamped to now')
  assert.equal(late.to - late.from, 2 * HANDOFF_HALF_SPAN_SEC * 1000, 'still ten minutes wide')
  assert.equal(handoffRange(null, nowSec), null)
})

test('an error-rate rule\'s Traces handoff lands on the service\'s failed server spans', () => {
  const v = view(501)
  const anchorSec = anchorOf(501)
  const range = handoffRange(anchorSec, nowSec)
  const exceptions = failingExceptions(range, 'payment-service')
  assert.ok(exceptions.length >= 1)
  assert.equal(exceptions[0], 'redis.clients.jedis.exceptions.JedisPoolException', 'the incident\'s own exception first')
  const t = tracesHandoff(v, { anchorSec, nowSec, exceptions })
  assert.deepEqual(t.link.filters.slice(0, 3), [
    { field: 'service', op: 'eq', value: 'payment-service' },
    { field: 'span_kind', op: 'eq', value: 'server' },
    { field: 'status_code', op: 'eq', value: 'ERROR' },
  ])
  const rows = tracesRows(t)
  assert.ok(rows.length >= 1, `no span matches ${chipsToString(filtersToChips(t.link.filters))}`)
  for (const r of rows) {
    assert.equal(r.tags.service, 'payment-service')
    assert.equal(r.tags.span_kind, 'server')
    assert.equal(r.statusCode, 'ERROR')
  }
  // The chips read back from the query text the Traces bar shows.
  const text = chipsToString(filtersToChips(t.link.filters))
  assert.ok(tryParseConditions(text).ok, text)
})

test('a latency rule\'s Traces handoff lands on the service\'s server spans, with no error filter', () => {
  const t = tracesHandoff(view(502), { anchorSec: anchorOf(502), nowSec })
  assert.equal(t.link.filters.some(f => f.field === 'status_code'), false)
  const rows = tracesRows(t)
  assert.ok(rows.length >= 1)
  for (const r of rows) assert.equal(r.tags.service, 'payment-service')
})

test('a log rule\'s Logs handoff opens its own query, without its stats, on matching records', () => {
  const v = view(504)
  assert.equal(v.datasource, 'logs')
  const l = logsHandoff(v, { anchorSec: anchorOf(504), nowSec })
  assert.deepEqual(l.link.chips.map(c => [c.field, c.op, c.value]), [['env', 'eq', 'UNSET'], ['log.level', 'eq', 'error']])
  assert.deepEqual(l.link.pipes, [])
  const rows = logRowsForWindow(resolveWindow(l.range)).filter(r => applyChipsToLog(r, l.link.chips))
  assert.ok(rows.length >= 1, 'error records around when it fired')
  for (const r of rows) assert.equal(r.level, 'error')
})

test('a service rule\'s Logs handoff is the service at level error, in the Logs page\'s fields', () => {
  const l = logsHandoff(view(501), {})
  assert.equal(l.range, null, 'the range in force stays')
  assert.deepEqual(l.link, {
    view: 'logs',
    chips: [
      { field: 'service', op: 'eq', value: 'payment-service' },
      { field: 'log.level', op: 'eq', value: 'error', connector: 'AND' },
    ],
    pipes: [],
  })
  assert.ok(tryParseConditions(chipsToString(l.link.chips)).ok)
  // The Logs sample spells its services without "-service" ('payment') and
  // carries no payment error records, so this one is pinned as a payload
  // rather than followed to rows: a data gap, not a link fault.
})

test('the Errors handoff lands on the service\'s error groups', () => {
  const link = errorsHandoff(view(501))
  assert.deepEqual(link, { view: 'errors', service: 'payment-service' })
  const { kind, facets } = errorsStateFromLink(link)
  const rows = applyErrorFacets(errorSeriesForWindow(win, kind), facets)
  assert.ok(rows.length >= 1)
  for (const r of rows) assert.equal(r.service, 'payment-service')
  const endpoint = errorsHandoff(view(437))
  assert.equal(endpoint.endpoint, 'POST /v1/payments')
  const st = errorsStateFromLink(endpoint)
  assert.ok(applyErrorFacets(errorSeriesForWindow(win, st.kind), st.facets).length >= 1)
})

test('the Explore handoff carries the exact query, and Explore charts it', async () => {
  const v = view(501)
  const link = exploreHandoff(v)
  assert.equal(link.view, 'explore')
  assert.equal(link.datasource, 'prometheus')
  assert.equal(link.query, v.baseQuery)
  assert.deepEqual(link.model, v.model, 'Explore rebuilds this exact query from the Quick model, so it opens on Quick')
  const page = applyIncoming(initialState(), { ...link, nonce: 1 })
  assert.equal(page.editors.prometheus.committed, v.baseQuery)
  const prev = setSimulatedLatency(0)
  try {
    const { series } = await queryRange({ datasource: 'prometheus', query: link.query, start: win.start, end: win.end, step: 60 })
    assert.ok(series.length >= 1 && series.some(s => s.values.some(p => p.y > 0)), 'Explore draws it')
  } finally {
    setSimulatedLatency(prev)
  }
})

test('a Quick latency rule goes to Explore as code, since Explore would rebuild it in seconds', () => {
  const v = view(502)
  const link = exploreHandoff(v)
  assert.equal(link.query, v.baseQuery)
  assert.match(link.query, /\* 1000$/)
  assert.equal('model' in link, false)
  const page = applyIncoming(initialState(), { ...link, nonce: 1 })
  assert.equal(page.editors.prometheus.tab, 'code')
  assert.equal(page.editors.prometheus.committed, v.baseQuery)
})

test('Explore stays listed for every rule, and unavailable with its reason when its parser cannot read the query', () => {
  assert.equal(exploreCanRead(view(437)), false, 'production\'s (x default 0)[5m] rollup')
  assert.equal(exploreCanRead(view(501)), true)
  assert.equal(exploreCanRead(view(504)), true, 'LogsQL')
  const demo = handoffsFor(view(437), { anchorSec: anchorOf(437), nowSec })
  const explore = demo.find(h => h.id === 'explore')
  assert.equal(explore.disabled, true)
  assert.equal(explore.title, EXPLORE_UNREADABLE)
  // Its scope comes from scanning the query, so the rest still go somewhere.
  assert.deepEqual(demo.map(h => h.id), ['service', 'traces', 'logs', 'errors', 'explore'])
  const payment = handoffsFor(view(501), { anchorSec: anchorOf(501), nowSec })
  assert.equal(payment.find(h => h.id === 'explore').disabled, undefined)
  assert.equal(payment.find(h => h.id === 'traces').label, 'Failing traces')
  // A rule that names no service still has Explore.
  assert.deepEqual(handoffsFor(view(514), {}).map(h => h.id), ['explore'])
})
