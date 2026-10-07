// The Explore chart/legend/table model: legend naming and the common-label
// rule, colour by identity, the selection model, limit + search + "Others",
// comparison deltas, chart rows and tooltips, and the table's row model.
// Worked examples are from results-area.md §6-§7 and ARCH D6-D9.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EXPLORE_PALETTE, seriesColour, seriesId, reduceSeries, collectLabelKeys, splitCommonLabels,
  legendName, buildChartModel, buildChartRows, tooltipAt, nearestAt, buildTicks, xAxisFor,
  SHOW_ALL, shouldShow, isSelectMode, primaryClick, secondaryClick, legendClick,
  buildTableRows, sortRows, toggleSort, limitRows, tableView, searchValues, valueOf,
  LEGEND_LIMIT, OTHERS_LABEL, GHOST_KEY,
} from './series.js'
import { CHART_PALETTE } from '@/utils/chartPalette'

const T0 = Date.UTC(2026, 9, 1, 8, 0)
const pts = (...ys) => ys.map((y, i) => ({ x: T0 + i * 60000, y }))
const S = (metric, ...ys) => ({ metric, values: pts(...ys) })
const labels = (m) => m.datasets.map(d => d.label)

// ---------- naming and the common-label rule ----------

test('Labels = all: legend shows the varying keys; the rest is "Common:"', () => {
  const m = buildChartModel({
    series: [
      S({ env: 'prod', service: 'a', span_kind: 'server' }, 5),
      S({ env: 'prod', service: 'b', span_kind: 'server' }, 3),
    ],
  })
  assert.deepEqual(labels(m), ['service=a', 'service=b'])
  assert.equal(m.commonLabels, 'env=prod, span_kind=server')
  assert.equal(m.showCommon, true)
})

test('one series: every key is common and the legend reads "-"', () => {
  const m = buildChartModel({ series: [S({ __name__: 'count(*)' }, 1)] })
  assert.deepEqual(labels(m), ['-'])
  assert.equal(m.commonLabels, '__name__=count(*)')
})

test('Labels = a key: its value, "-" when the series lacks it; no Common line', () => {
  const m = buildChartModel({
    series: [S({ service: 'a' }, 5), S({ service: 'b' }, 4), S({ env: 'x' }, 3)],
    legendLabel: 'service',
  })
  assert.deepEqual(labels(m), ['a', 'b', '-'])
  assert.equal(m.showCommon, false)
})

test('no series: no datasets and an empty Common line', () => {
  const m = buildChartModel({ series: [] })
  assert.deepEqual(m.datasets, [])
  assert.equal(m.commonLabels, '')
  assert.equal(m.total, 0)
})

test('a key missing from some series is varying, and omitted from those series\' names', () => {
  const series = [S({ service: 'a', root_name: 'GET /x' }, 5), S({ service: 'a' }, 3)]
  const { common, varying } = splitCommonLabels(series)
  assert.deepEqual(common, { service: 'a' })
  assert.deepEqual([...varying], ['root_name'])
  const m = buildChartModel({ series })
  assert.deepEqual(labels(m), ['root_name=GET /x', '-'])
  assert.equal(m.commonLabels, 'service=a')
})

test('the logs example: the empty group is a label value like any other', () => {
  const m = buildChartModel({
    series: [
      S({ __name__: 'count(*)', service: '' }, 90),
      S({ __name__: 'count(*)', service: 'search' }, 10),
    ],
  })
  assert.deepEqual(labels(m), ['service=', 'service=search'])
  assert.equal(m.commonLabels, '__name__=count(*)')
})

test('multi-aggregate stats: series differ only by __name__', () => {
  const m = buildChartModel({ series: [S({ __name__: 'a' }, 2), S({ __name__: 'b' }, 1)] })
  assert.deepEqual(labels(m), ['__name__=a', '__name__=b'])
  assert.equal(m.commonLabels, '')
})

test('labelsSet is first-seen order over the value-sorted series', () => {
  const m = buildChartModel({ series: [S({ zeta: '1' }, 1), S({ alpha: '1', zeta: '2' }, 9)] })
  assert.deepEqual(m.labelsSet, ['alpha', 'zeta'])
  assert.deepEqual(collectLabelKeys([{ metric: { b: 1, a: 1 } }]), ['b', 'a'])
})

test('legendName helper', () => {
  assert.equal(legendName({ a: '1', b: '2' }, { varying: new Set(['b']) }), 'b=2')
  assert.equal(legendName({ a: '1' }, { legendLabel: 'a' }), '1')
  assert.equal(legendName({ a: '' }, { legendLabel: 'a' }), '-')
})

// ---------- ordering and reduction ----------

test('legend order is the Legend value, highest first; NaN last', () => {
  const series = [S({ s: 'low' }, 1, 1), S({ s: 'nan' }), S({ s: 'high' }, 1, 9)]
  assert.deepEqual(labels(buildChartModel({ series, formula: 'avg' })), ['s=high', 's=low', 's=nan'])
  assert.deepEqual(labels(buildChartModel({ series, formula: 'last' })), ['s=high', 's=low', 's=nan'])
  const r = reduceSeries([S({ s: 'x' }, 2, 4)], 'sum')
  assert.equal(r[0].reduceValue, 6)
})

// ---------- colour ----------

test('the palette is the house palette without the warning amber', () => {
  assert.equal(EXPLORE_PALETTE.length, CHART_PALETTE.length - 1)
  assert.ok(!EXPLORE_PALETTE.includes('#F59E0B'))
  assert.equal(seriesColour(0), `${EXPLORE_PALETTE[0]}FF`)
  // Past a full cycle the hue repeats at the next alpha step.
  assert.equal(seriesColour(EXPLORE_PALETTE.length), `${EXPLORE_PALETTE[0]}DD`)
  assert.equal(seriesColour(0, true), `${EXPLORE_PALETTE[0]}77`)
})

test('colour follows identity, not rank: a new Legend value re-sorts without recolouring', () => {
  const series = [S({ s: 'b' }, 1, 10), S({ s: 'a' }, 5, 5), S({ s: 'c' }, 3, 3)]
  const colours = (formula) => Object.fromEntries(buildChartModel({ series, formula }).datasets.map(d => [d.label, d.colour]))
  assert.deepEqual(colours('avg'), colours('last'))
  const byLast = buildChartModel({ series, formula: 'last' })
  assert.deepEqual(labels(byLast), ['s=b', 's=a', 's=c'])
  // Alphabetical identity: a gets the first slot whatever its rank.
  assert.equal(byLast.datasets.find(d => d.label === 's=a').colour, seriesColour(0))
  assert.equal(byLast.datasets.find(d => d.label === 's=a').dataKey, 's0')
})

// ---------- selection (reference yl) ----------

test('the reference walkthrough: click B, ctrl-click C, click C, ctrl-click A, click A', () => {
  const visible = (sel) => ['A', 'B', 'C'].filter(k => shouldShow(sel, k))
  let sel = SHOW_ALL
  assert.deepEqual(visible(sel), ['A', 'B', 'C'])
  sel = primaryClick(sel, 'B')
  assert.deepEqual(visible(sel), ['B'])
  sel = secondaryClick(sel, 'C')
  assert.deepEqual(visible(sel), ['B', 'C'])
  sel = primaryClick(sel, 'C')
  assert.deepEqual(visible(sel), ['A', 'B', 'C'])
  sel = secondaryClick(sel, 'A')
  assert.deepEqual(visible(sel), ['B', 'C'])
  sel = primaryClick(sel, 'A')
  assert.deepEqual(visible(sel), ['A'])
  assert.equal(isSelectMode(sel), true)
})

test('ctrl-clicking the last visible series in select mode leaves nothing drawn', () => {
  let sel = primaryClick(SHOW_ALL, 'B')
  sel = secondaryClick(sel, 'B')
  assert.deepEqual(['A', 'B'].filter(k => shouldShow(sel, k)), [])
})

test('selection states are new objects, never mutated in place', () => {
  const a = primaryClick(SHOW_ALL, 'x')
  const b = secondaryClick(a, 'y')
  assert.deepEqual(a.inverts, ['x'])
  assert.deepEqual(b.inverts, ['x', 'y'])
  assert.deepEqual(SHOW_ALL.inverts, [])
})

test('legendClick routes Ctrl and ⌘ to the secondary action', () => {
  assert.deepEqual(legendClick(SHOW_ALL, 'x', {}), { defaultShow: false, inverts: ['x'] })
  assert.deepEqual(legendClick(SHOW_ALL, 'x', { ctrlKey: true }), { defaultShow: true, inverts: ['x'] })
  assert.deepEqual(legendClick(SHOW_ALL, 'x', { metaKey: true }), { defaultShow: true, inverts: ['x'] })
})

test('hidden datasets stay in the legend but are not drawn', () => {
  const series = [S({ s: 'a' }, 3), S({ s: 'b' }, 2), S({ s: 'c' }, 1)]
  const m = buildChartModel({ series, selection: primaryClick(SHOW_ALL, 's=b') })
  assert.deepEqual(m.datasets.map(d => d.hidden), [true, false, true])
  assert.deepEqual(m.drawn.map(d => d.label), ['s=b'])
})

test('series that share a legend name share selection', () => {
  const series = [S({ svc: 'a', k: '1' }, 3), S({ svc: 'a', k: '2' }, 2), S({ svc: 'b', k: '3' }, 1)]
  const m = buildChartModel({ series, legendLabel: 'svc', selection: primaryClick(SHOW_ALL, 'a') })
  assert.deepEqual(m.drawn.map(d => d.id), ['k=1, svc=a', 'k=2, svc=a'])
})

// ---------- limit, search, Others ----------

const many = (n) => Array.from({ length: n }, (_, i) => S({ i: String(i).padStart(2, '0') }, n - i))

test('more than 20 series: the top 20 are listed and the limit is flagged', () => {
  const m = buildChartModel({ series: many(25) })
  assert.equal(m.datasets.length, LEGEND_LIMIT)
  assert.equal(m.shownCount, 20)
  assert.equal(m.total, 25)
  assert.equal(m.matchCount, 25)
  assert.equal(m.limited, true)
  const all = buildChartModel({ series: many(25), limitOn: false })
  assert.equal(all.datasets.length, 25)
  assert.equal(all.limited, false)
})

test('an isolated series past the top 20 stays listed and drawn', () => {
  const m = buildChartModel({ series: many(25), selection: primaryClick(SHOW_ALL, 'i=23') })
  assert.equal(m.datasets.length, 21)
  assert.deepEqual(m.drawn.map(d => d.label), ['i=23'])
})

test('search filters the legend and the lines, case-insensitively; the limit counts matches', () => {
  const m = buildChartModel({ series: many(25), search: 'I=0' })
  assert.deepEqual(labels(m), ['i=00', 'i=01', 'i=02', 'i=03', 'i=04', 'i=05', 'i=06', 'i=07', 'i=08', 'i=09'])
  assert.equal(m.matchCount, 10)
  assert.equal(m.limited, false)
  assert.equal(m.total, 25)
})

test('stacked: left-out series are summed into a dashed "Others", drawn on top', () => {
  const series = [S({ s: 'a' }, 5, 5), S({ s: 'b' }, 3, 1), S({ s: 'c' }, 2, 4)]
  const m = buildChartModel({ series, stack: true, search: 's=a' })
  assert.deepEqual(labels(m), ['s=a', OTHERS_LABEL])
  const others = m.datasets[1]
  assert.equal(others.isOthers, true)
  assert.equal(others.dashed, true)
  assert.deepEqual(others.data.map(p => p.y), [5, 5])
  assert.equal(others.reduceValue, 5)   // avg(b)=2 + avg(c)=3
  // Render order is reversed so the top-ranked series sits on top of the stack.
  assert.deepEqual(m.drawOrder.map(d => d.label), [OTHERS_LABEL, 's=a'])
})

test('stacked with more than 20 series: the overflow becomes "Others"', () => {
  const m = buildChartModel({ series: many(22), stack: true })
  assert.equal(m.datasets.length, 21)
  assert.equal(m.datasets[20].label, OTHERS_LABEL)
  assert.equal(m.datasets[20].count, 2)
})

test('unstacked never creates "Others"', () => {
  const m = buildChartModel({ series: many(22) })
  assert.ok(!labels(m).includes(OTHERS_LABEL))
})

// ---------- comparison (ARCH D6) ----------

test('deltas match previous series by the full label set', () => {
  const m = buildChartModel({
    series: [S({ service: 'payment' }, 0.612), S({ service: 'order' }, 110), S({ service: 'new' }, 4)],
    prevSeries: [S({ service: 'order' }, 100), S({ service: 'payment' }, 0.14)],
    formula: 'avg',
  })
  const by = Object.fromEntries(m.datasets.map(d => [d.label, d.delta.text]))
  assert.deepEqual(by, { 'service=order': '↑10%', 'service=new': 'new', 'service=payment': '↑4.4×' })
  assert.equal(m.datasets.find(d => d.label === 'service=order').prevValue, 100)
})

test('Compare off: no deltas; a failed comparison reads as unknown, never "new"', () => {
  const series = [S({ s: 'a' }, 1)]
  assert.equal(buildChartModel({ series }).datasets[0].delta, null)
  assert.equal(buildChartModel({ series }).datasets[0].prevValue, undefined)
  const failed = buildChartModel({ series, prevSeries: [], prevFailed: true })
  assert.equal(failed.datasets[0].delta.text, '—')
})

test('the ghost line exists only while exactly one series is drawn, shifted onto this window', () => {
  const series = [S({ s: 'a' }, 5, 6), S({ s: 'b' }, 1, 1)]
  const prevSeries = [{ metric: { s: 'a' }, values: [{ x: T0 - 3600000, y: 2 }, { x: T0 - 3540000, y: 3 }] }]
  const both = buildChartModel({ series, prevSeries, compareShiftSec: 3600 })
  assert.equal(both.ghost, null)
  const one = buildChartModel({ series, prevSeries, compareShiftSec: 3600, selection: primaryClick(SHOW_ALL, 's=a') })
  assert.equal(one.ghost.dataKey, GHOST_KEY)
  assert.equal(one.ghost.colour, one.drawn[0].colour)
  assert.deepEqual(one.ghost.data, [{ x: T0, y: 2 }, { x: T0 + 60000, y: 3 }])
  const single = buildChartModel({ series: [series[0]], prevSeries, compareShiftSec: 3600 })
  assert.ok(single.ghost)
})

// ---------- chart rows, tooltip, nearest ----------

test('chart rows cover every x; unstacked gaps stay undefined', () => {
  const m = buildChartModel({ series: [{ metric: { s: 'a' }, values: [{ x: T0, y: 1 }, { x: T0 + 120000, y: 3 }] }] })
  const xs = [T0, T0 + 60000, T0 + 120000, T0 + 180000]
  const rows = buildChartRows(m, xs)
  assert.deepEqual(rows.map(r => r.x), xs)
  assert.deepEqual(rows.map(r => r.s0), [1, undefined, 3, undefined])
})

test('stacked rows fill gaps with 0 inside a series\' own span only', () => {
  const m = buildChartModel({ series: [{ metric: { s: 'a' }, values: [{ x: T0, y: 1 }, { x: T0 + 120000, y: 3 }] }], stack: true })
  const rows = buildChartRows(m, [T0, T0 + 60000, T0 + 120000, T0 + 180000], { stack: true })
  assert.deepEqual(rows.map(r => r.s0), [1, 0, 3, undefined])
})

test('chart rows carry the ghost line under its own key', () => {
  const m = buildChartModel({
    series: [S({ s: 'a' }, 5, 6)],
    prevSeries: [{ metric: { s: 'a' }, values: [{ x: T0 - 3600000, y: 2 }] }],
    compareShiftSec: 3600,
  })
  const rows = buildChartRows(m, [T0, T0 + 60000])
  assert.equal(rows[0][GHOST_KEY], 2)
  assert.equal(tooltipAt(m, T0).items[0].prev, 2)
})

test('tooltip: every drawn series with a point at x, highest first, capped with "+N more"', () => {
  const m = buildChartModel({ series: many(18), limitOn: false })
  const tip = tooltipAt(m, T0, { nearestKey: m.drawn[17].dataKey })
  assert.equal(tip.items.length, 15)
  assert.equal(tip.more, 3)
  assert.deepEqual(tip.items.slice(0, 3).map(i => i.value), [18, 17, 16])
  // The nearest line is kept even though it ranks last.
  assert.equal(tip.items[14].nearest, true)
  assert.equal(tip.items[14].value, 1)
  assert.match(tip.title, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  assert.deepEqual(tooltipAt(m, T0 + 1).items, [])
})

test('nearestAt: closest line by value; stacked, the band the cursor is in', () => {
  const m = buildChartModel({ series: [S({ s: 'a' }, 10), S({ s: 'b' }, 4)] })
  assert.equal(nearestAt(m, T0, 9), 's0')
  assert.equal(nearestAt(m, T0, 5), 's1')
  const st = buildChartModel({ series: [S({ s: 'a' }, 10), S({ s: 'b' }, 4)], stack: true })
  // b (lower rank) is the bottom band 0-4, a sits on it at 4-14.
  assert.equal(nearestAt(st, T0, 2, { stack: true }), 's1')
  assert.equal(nearestAt(st, T0, 9, { stack: true }), 's0')
  assert.equal(nearestAt(m, T0, NaN), null)
})

// ---------- x axis ----------

test('ticks: 1h ticks every 10 minutes on the clock, 7d daily with dates', () => {
  const start = new Date(2026, 9, 1, 13, 37).getTime()
  const hour = buildTicks(start, start + 3600000)
  assert.deepEqual(hour.map(t => t.label), ['13:40', '13:50', '14:00', '14:10', '14:20', '14:30'])
  const week = buildTicks(start - 7 * 86400000, start)
  assert.equal(week.length, 7)
  assert.match(week[0].label, /^\d{4}-\d{2}-\d{2} 00:00$/)
  const quarter = buildTicks(start, start + 15 * 60000)
  assert.equal(quarter.length, 16)   // < 30 min: every minute
  assert.deepEqual(buildTicks(start, start), [])
})

test('xAxisFor spans every step of the resolved range', () => {
  const ax = xAxisFor({ start: 1000, end: 1240, step: 60 })
  assert.deepEqual(ax.xs, [1000000, 1060000, 1120000, 1180000, 1240000])
  assert.deepEqual(ax.domain, [1000000, 1240000])
})

// ---------- table ----------

test('Labels = all: the row label is the FULL label set, __name__ included', () => {
  const rows = buildTableRows({
    series: [S({ __name__: 'x', service: 'a', span_kind: 'server' }, 2)],
  })
  assert.equal(rows[0].label, '__name__=x, service=a, span_kind=server')
  assert.equal(rows[0].key, JSON.stringify(['__name__=x, service=a, span_kind=server']))
  assert.deepEqual(rows[0].labels, [rows[0].label])
})

test('rows with the same label text merge, and the last (lowest value) wins', () => {
  const rows = buildTableRows({
    series: [S({ service: 'a', k: '1' }, 9), S({ service: 'a', k: '2' }, 1), S({ service: 'b' }, 5)],
    legendLabel: 'service',
  })
  assert.deepEqual(rows.map(r => [r.label, r.value, r.merged]), [['a', 1, 2], ['b', 5, 1]])
  assert.deepEqual(rows[0].metric, { service: 'a', k: '2' })
})

test('a missing label is an empty cell; instant results carry no sparkline series', () => {
  const rows = buildTableRows({ series: [{ metric: { env: 'x' }, value: 3 }], legendLabel: 'service' })
  assert.equal(rows[0].label, '')
  assert.equal(rows[0].value, 3)
  assert.equal(rows[0].series, null)
  const ranged = buildTableRows({ series: [S({ s: 'a' }, 1, 2)], formula: 'sum' })
  assert.equal(ranged[0].value, 3)
  assert.equal(ranged[0].series.values.length, 2)
})

test('table comparison columns: previous value, delta and a sortable change', () => {
  const rows = buildTableRows({
    series: [S({ s: 'a' }, 200), S({ s: 'b' }, 50), S({ s: 'c' }, 7)],
    prevSeries: [{ metric: { s: 'a' }, value: 100 }, { metric: { s: 'b' }, value: 100 }],
  })
  const by = Object.fromEntries(rows.map(r => [r.label, r]))
  assert.equal(by['s=a'].delta.text, '↑2×')
  assert.equal(by['s=a'].change, 1)
  assert.equal(by['s=b'].change, -0.5)
  assert.equal(by['s=c'].delta.text, 'new')
  assert.equal(by['s=c'].change, Infinity)
  assert.deepEqual(sortRows(rows, { col: 'change' }).map(r => r.label), ['s=c', 's=a', 's=b'])
})

test('sort: Label A→Z by default; Value high→low on first click; reversal; missing last', () => {
  const rows = [
    { label: 'b', value: 1 }, { label: 'a', value: 3 }, { label: 'c', value: undefined }, { label: 'd', value: 2 },
  ]
  assert.deepEqual(sortRows(rows).map(r => r.label), ['a', 'b', 'c', 'd'])
  assert.deepEqual(sortRows(rows, { col: 'label', reversed: true }).map(r => r.label), ['d', 'c', 'b', 'a'])
  assert.deepEqual(sortRows(rows, { col: 'value' }).map(r => r.label), ['a', 'd', 'b', 'c'])
  assert.deepEqual(sortRows(rows, { col: 'value', reversed: true }).map(r => r.label), ['b', 'd', 'a', 'c'])
})

test('toggleSort: same column flips, a new column starts unreversed', () => {
  assert.deepEqual(toggleSort({ col: 'label', reversed: false }, 'label'), { col: 'label', reversed: true })
  assert.deepEqual(toggleSort({ col: 'label', reversed: true }, 'value'), { col: 'value', reversed: false })
})

test('limit: 20 rows unless Show all; tableView counts the FILTERED rows', () => {
  const rows = buildTableRows({ series: many(30) })
  const lim = limitRows(rows)
  assert.equal(lim.rows.length, 20)
  assert.equal(lim.limited, true)
  assert.equal(limitRows(rows, false).rows.length, 30)
  // Quoted: a bare `=` ends a literal in SearchQL, so `label:i=1` would search `i`.
  const v = tableView({ rows, search: 'label:"i=1"' })
  assert.equal(v.total, 10)
  assert.equal(v.limited, false)
  assert.equal(v.allCount, 30)
  assert.deepEqual(v.rows.slice(0, 2).map(r => r.label), ['i=10', 'i=11'])
  const byValue = tableView({ rows, sort: { col: 'value', reversed: false } })
  assert.equal(byValue.rows[0].label, 'i=00')
  assert.equal(byValue.total, 30)
  assert.equal(byValue.limited, true)
})

test('searchValues lists distinct non-empty labels for autocomplete', () => {
  assert.deepEqual(searchValues([{ label: 'a' }, { label: '' }, { label: 'a' }, { label: 'b' }]), ['a', 'b'])
})

test('valueOf reads any API shape', () => {
  assert.equal(valueOf({ value: 3 }, 'avg'), 3)
  assert.equal(valueOf({ reduceValue: 4, values: [] }, 'avg'), 4)
  assert.equal(valueOf({ values: pts(1, 3) }, 'avg'), 2)
  assert.ok(Number.isNaN(valueOf({}, 'avg')))
  assert.equal(seriesId({ b: '2', a: '1' }), 'a=1, b=2')
})
