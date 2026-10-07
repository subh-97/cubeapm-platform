// The Explore page's state machine. These pin the three things a browser is
// worst at checking: which tab a payload opens, what a tab switch carries
// over, and whether the run button is honest about being out of date.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyIncoming, cleanModel, commit, committedQuery, DATASOURCES, draftQuery,
  explorePayloadForCard, initialState, isDirty, isMetricsSource, setDatasource,
  setEditor, setSetting, setTab, tabsFor,
} from '@/utils/explore/editorState.js'

// ---------- Initial state (ARCH D2) ----------

test('opens on Metrics › Quick with RPM by service, already committed', () => {
  const s = initialState()
  assert.equal(s.datasource, 'prometheus')
  assert.equal(s.editors.prometheus.tab, 'quick')
  assert.equal(s.editors.prometheus.quick.model.calculate, 'rpm')
  assert.deepEqual(s.editors.prometheus.quick.model.groupBy, ['service'])
  assert.equal(committedQuery(s).query, draftQuery(s))
  assert.ok(draftQuery(s).includes('cube_apm_calls_total'))
  assert.equal(isDirty(s), false)
})

test('Logs and Traces open on Builder with their own default stats query', () => {
  const s = initialState()
  assert.equal(s.editors.vlogs.tab, 'builder')
  assert.equal(s.editors.vlogs.committed, '* | stats by ("host.name") count()')
  assert.equal(s.editors.traces.committed, '* | stats by ("service") count()')
})

test('the whole state survives a JSON round trip (ARCH D14)', () => {
  const s = initialState()
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s)
})

test('tabsFor follows the datasource', () => {
  assert.deepEqual(tabsFor('prometheus').map(t => t.value), ['quick', 'advanced', 'code'])
  assert.deepEqual(tabsFor('vlogs').map(t => t.value), ['builder', 'code'])
  assert.equal(isMetricsSource('prometheus'), true)
  assert.equal(isMetricsSource('traces'), false)
  assert.deepEqual(DATASOURCES.map(d => d.value), ['prometheus', 'vlogs', 'traces'])
})

// ---------- Datasource switching ----------

test('switching datasource keeps each editor and shows that one\'s committed query', () => {
  const s = setDatasource(initialState(), 'traces')
  assert.equal(committedQuery(s).datasource, 'traces')
  assert.equal(committedQuery(s).query, '* | stats by ("service") count()')
  assert.equal(isDirty(s), false)
  // Back again, and Metrics is where it was left.
  assert.equal(committedQuery(setDatasource(s, 'prometheus')).query, initialState().editors.prometheus.committed)
})

test('a datasource switch resets the legend label but keeps the other toolbar settings', () => {
  let s = setSetting(initialState(), 'legendLabel', 'service')
  s = setSetting(s, 'unit', 'time')
  s = setSetting(s, 'stack', true)
  s = setDatasource(s, 'vlogs')
  assert.equal(s.legendLabel, '')
  assert.equal(s.unit, 'time')
  assert.equal(s.stack, true)
})

test('an unknown datasource is ignored', () => {
  const s = initialState()
  assert.equal(setDatasource(s, 'mobile'), s)
})

// ---------- Tabs (ARCH D3) ----------

test('switching into Code seeds it from the tab it came from, once', () => {
  const s = setTab(initialState(), 'code')
  assert.equal(s.editors.prometheus.tab, 'code')
  assert.equal(s.editors.prometheus.code.query, initialState().editors.prometheus.quick.query)
  assert.equal(s.editors.prometheus.code.seededFrom, 'quick')
  assert.equal(s.editors.prometheus.code.touched, false)
})

test('a touched Code tab is never re-seeded', () => {
  let s = setTab(initialState(), 'code')
  const editor = s.editors.prometheus
  s = setEditor(s, { ...editor, code: { ...editor.code, query: 'up', touched: true } })
  s = setTab(s, 'advanced')
  s = setTab(s, 'code')
  assert.equal(s.editors.prometheus.code.query, 'up')
})

test('a builder tab is never seeded from Code — there is no parser back', () => {
  let s = setTab(initialState(), 'code')
  const editor = s.editors.prometheus
  s = setEditor(s, { ...editor, code: { ...editor.code, query: 'up', touched: true } })
  s = setTab(s, 'quick')
  assert.equal(s.editors.prometheus.quick.query, initialState().editors.prometheus.quick.query)
})

test('a tab the datasource does not have is ignored', () => {
  const s = setDatasource(initialState(), 'vlogs')
  assert.equal(setTab(s, 'advanced'), s)
  assert.equal(setTab(s, 'builder'), s)
})

// ---------- Dirty and commit ----------

test('editing marks the run button dirty; committing clears it', () => {
  let s = initialState()
  const editor = s.editors.prometheus
  s = setEditor(s, { ...editor, quick: { model: editor.quick.model, query: 'up' } })
  assert.equal(isDirty(s), true)
  assert.equal(committedQuery(s).query, editor.committed)
  s = commit(s)
  assert.equal(isDirty(s), false)
  assert.equal(committedQuery(s).query, 'up')
})

test('switching to an empty Code tab is dirty, and committing nothing is a no-op', () => {
  let s = initialState()
  const editor = s.editors.prometheus
  // Untouched Code is seeded, so empty it the way typing would.
  s = setEditor(s, { ...editor, tab: 'code', code: { query: '', touched: true, seededFrom: null } })
  assert.equal(isDirty(s), true)
  assert.equal(commit(s), s)
  assert.equal(committedQuery(s).query, editor.committed)
})

// ---------- Incoming payloads (ARCH D13) ----------

test('a quick model opens Quick, rebuilds the query from it, and is committed', () => {
  const s = applyIncoming(initialState(), {
    datasource: 'prometheus',
    query: 'this is ignored',
    model: {
      type: 'quick', calculate: 'error_percentage', value: '90',
      labelPairs: [{ label: 'service', operator: '=', values: ['order-service'] }], groupBy: [],
    },
  })
  assert.equal(s.editors.prometheus.tab, 'quick')
  assert.ok(s.editors.prometheus.quick.query.includes('status_code="ERROR"'))
  assert.equal(committedQuery(s).query, s.editors.prometheus.quick.query)
  assert.equal(isDirty(s), false)
})

test('an options key on an incoming filter row is stripped', () => {
  const s = applyIncoming(initialState(), {
    datasource: 'prometheus',
    model: {
      type: 'quick', calculate: 'rpm', value: '90', groupBy: [],
      labelPairs: [{ label: 'env', operator: '=', values: ['prod'], options: ['prod', 'stage'] }],
    },
  })
  const [row] = s.editors.prometheus.quick.model.labelPairs
  assert.deepEqual(Object.keys(row).sort(), ['label', 'operator', 'values'])
})

test('a query with no model opens Code, already touched', () => {
  const s = applyIncoming(initialState(), { datasource: 'prometheus', query: 'sum(up)' })
  assert.equal(s.editors.prometheus.tab, 'code')
  assert.equal(s.editors.prometheus.code.query, 'sum(up)')
  assert.equal(s.editors.prometheus.code.touched, true)
  assert.equal(s.editors.prometheus.code.seededFrom, null)
  assert.equal(committedQuery(s).query, 'sum(up)')
})

test('a model of the wrong type for its datasource falls back to Code', () => {
  const s = applyIncoming(initialState(), {
    datasource: 'prometheus',
    query: 'sum(up)',
    model: { type: 'builder', streamPairs: [], labelPairs: [], pipes: [] },
  })
  assert.equal(s.editors.prometheus.tab, 'code')
  assert.equal(s.editors.prometheus.code.query, 'sum(up)')
})

test('a logs payload switches datasource and builds LogsQL from the builder model', () => {
  const s = applyIncoming(initialState(), {
    datasource: 'vlogs',
    model: {
      type: 'builder',
      streamPairs: [{ label: 'service', operator: '=', values: ['order-service'], options: [] }],
      labelPairs: [],
      pipes: [{ value: 'stats', by: ['log.level'], aggs: [{ fn: 'count', args: [''], filter: '', alias: '' }] }],
    },
  })
  assert.equal(s.datasource, 'vlogs')
  assert.equal(s.editors.vlogs.tab, 'builder')
  assert.equal(committedQuery(s).query, '{"service"="order-service"} | stats by ("log.level") count()')
})

test('a logs query with no model opens the Logs Code tab', () => {
  const s = applyIncoming(initialState(), { datasource: 'traces', query: '* | stats count()' })
  assert.equal(s.datasource, 'traces')
  assert.equal(s.editors.traces.tab, 'code')
  assert.equal(committedQuery(s).query, '* | stats count()')
})

test('an unusable payload still switches datasource and leaves that editor alone', () => {
  const s = applyIncoming(initialState(), { datasource: 'vlogs' })
  assert.equal(s.datasource, 'vlogs')
  assert.equal(s.editors.vlogs.tab, 'builder')
  assert.equal(committedQuery(s).query, initialState().editors.vlogs.committed)
})

test('toolbar settings are normalised: bad legendLabel and formula, kept unit and stack', () => {
  const base = setSetting(setSetting(initialState(), 'unit', 'time'), 'stack', true)
  const s = applyIncoming(base, { datasource: 'prometheus', query: 'up', legendLabel: 7, formula: 'median' })
  assert.equal(s.legendLabel, '')
  assert.equal(s.formula, 'avg')
  assert.equal(s.unit, 'time')
  assert.equal(s.stack, true)

  const t = applyIncoming(base, { datasource: 'prometheus', query: 'up', legendLabel: 'service', formula: 'sum', unit: 'number', stack: false })
  assert.equal(t.legendLabel, 'service')
  assert.equal(t.formula, 'sum')
  assert.equal(t.unit, 'number')
  assert.equal(t.stack, false)
})

test('an unknown datasource on a payload lands on Metrics', () => {
  const s = applyIncoming(initialState(), { datasource: 'mobile', query: 'up' })
  assert.equal(s.datasource, 'prometheus')
})

test('cleanModel rejects what it cannot show and repairs what it can', () => {
  assert.equal(cleanModel(null), null)
  assert.equal(cleanModel({ type: 'nonsense' }), null)
  const m = cleanModel({ type: 'quick', labelPairs: [{ label: undefined, values: null }] })
  assert.equal(m.calculate, 'rpm')
  assert.equal(m.value, '90')
  assert.deepEqual(m.labelPairs, [{ label: '', operator: '=', values: [] }])
  const b = cleanModel({ type: 'builder', pipes: [{ value: 'sort' }, { value: 'math', expr: 'a/b' }] })
  assert.deepEqual(b.pipes, [{ value: 'math', expr: 'a/b', alias: '' }])
  assert.equal(b.streamPairs.length, 1)
})

// ---------- Card menus ----------

test('only an Explore action produces a payload', () => {
  assert.equal(explorePayloadForCard({ action: 'Create Alert', title: 'RPM' }), null)
  assert.equal(explorePayloadForCard({ action: 'Download CSV' }), null)
  assert.ok(explorePayloadForCard({ action: 'Explore', title: 'RPM' }))
  assert.ok(explorePayloadForCard({ action: 'Explore (Total)', title: 'Latency Drilldown' }))
})

test('the card title picks the calculation and the unit', () => {
  const of = (title) => explorePayloadForCard({ action: 'Explore', title })
  assert.equal(of('RPM').model.calculate, 'rpm')
  assert.equal(of('RPM').unit, 'number')
  assert.equal(of('Error %').model.calculate, 'error_percentage')
  assert.equal(of('Error %').unit, 'number')
  assert.equal(of('p90 Latency').model.calculate, 'latency_percentile')
  assert.equal(of('p90 Latency').model.value, '90')
  assert.equal(of('p99 Latency').model.value, '99')
  assert.equal(of('p90 Latency').unit, 'time')
  assert.equal(of('Response Time (avg)').model.calculate, 'latency_average')
  assert.equal(of('Response Time (avg)').unit, 'time')
  assert.equal(of('Something else entirely').model.calculate, 'rpm')
})

test('a table card names its column in the action, and that is the subject', () => {
  const p = explorePayloadForCard({ action: 'Explore - Error %', title: 'Infrastructure Correlation' })
  assert.equal(p.model.calculate, 'error_percentage')
})

test('the service and endpoint in scope become filter rows, with a blank row to type into', () => {
  const p = explorePayloadForCard({ action: 'Explore', title: 'RPM', serviceId: 'payment-service', endpoint: '/v1/payment' })
  assert.deepEqual(p.model.labelPairs, [
    { label: 'service', operator: '=', values: ['payment-service'] },
    { label: 'root_name', operator: '=', values: ['/v1/payment'] },
    { label: '', operator: '=', values: [] },
  ])
  assert.deepEqual(p.model.groupBy, ['root_name'])
  assert.equal(p.legendLabel, 'root_name')
  // And it is a payload applyIncoming accepts whole.
  const s = applyIncoming(initialState(), p)
  assert.equal(s.editors.prometheus.tab, 'quick')
  assert.ok(committedQuery(s).query.includes('service="payment-service"'))
})
