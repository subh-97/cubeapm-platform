// Every Infrastructure view, rendered the way a source in the sidebar or a link
// opens it, and read for its charts: each is one of the APM service page's
// (the RED legend chart, the Runtime card, the Latency Drilldown frame), each
// carries that page's Expand and ⋮ menu, each can be drawn over an earlier
// window for its Compare, and none spends a status colour on a series.
// What a hover, a drag or a click does needs a DOM and is checked in the
// running page; the shared charts' own behaviour is tested beside them.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server.browser'
import { isValidElement, cloneElement } from 'react'
import { INFRA_SOURCES, infraHostsForWindow, k8sNodesForWindow, k8sPodsForWindow } from '@/data/observability'
import { REFERENCE_WINDOW, shiftWindow } from '@/data/timeWindow'
import { CHART_COMPARE_OPTIONS } from '@/components/charts/chartView'
import CardChart from '@/components/charts/CardChart.jsx'
import LegendLineChart from '@/components/charts/LegendLineChart.jsx'
import ChartActions from '@/components/charts/ChartActions.jsx'
import ChartModal from '@/components/charts/ChartModal.jsx'
import InfraView from './InfraView.jsx'

const noop = () => {}
const HOUR = { kind: 'preset', value: '1h' }

// The same server-render warnings LegendLineChart.test.js expects: a chart's
// frame has no size to draw at, and the card menus measure themselves in a
// layout effect. Anything else still reaches the console.
const EXPECTED = /width\(\d+\) and height\(\d+\) of chart|useLayoutEffect does nothing on the server/
function quietly(fn) {
  const { warn, error } = console
  const quiet = log => (...args) => { if (!EXPECTED.test(String(args[0]))) log(...args) }
  console.warn = quiet(warn)
  console.error = quiet(error)
  try { return fn() } finally { Object.assign(console, { warn, error }) }
}

const page = ({ source, resource = null, selectedHost = null }, timeRange = HOUR) => (
  <InfraView
    goHome={noop} source={source} resource={resource} selectedHost={selectedHost} setSelectedHost={noop}
    timeRange={timeRange} setTimeRange={noop} settingsOpen={false} setSettingsOpen={noop} setToast={noop}
  />
)
const view = (v, timeRange) => quietly(() => renderToStaticMarkup(page(v, timeRange)))

// What a view hands its charts, read off the tree it renders. The view renders
// as it does on the page, except that every component is called inside a
// wrapper of its own, so its hooks run under every context the page sets
// above it and the elements it returns can be read: a CardChart's and a legend
// chart's props are recorded, and so is the corner of a panel that builds its
// own view (ChartActions), and each is then drawn as usual. `html` is what was
// drawn. Opening the modal needs a DOM, and is checked in the running page.
//
// `acts` stand in for a reader: each is shown every element as it is read,
// and may call a handler on it — pick a container, a namespace, a Filter — as
// a click would. The component that drew the element is the one rendering,
// so its state updates in place and it renders again with the choice made.
const STOPS = new Map([[CardChart, 'card'], [LegendLineChart, 'legend'], [ChartActions, 'panel']])
function chartsOf(v, { timeRange, acts = [] } = {}) {
  const charts = []
  const walk = node => {
    if (Array.isArray(node)) return node.map(walk)
    if (!isValidElement(node)) return node
    const { type, props } = node
    acts.forEach(act => act(props ?? {}))
    if (STOPS.has(type)) {
      charts.push({ kind: STOPS.get(type), props })
      return node
    }
    if (typeof type === 'function' && !type.prototype?.isReactComponent) return <Unfold key={node.key} el={node} />
    if (props.children == null) return node
    const kids = walk(props.children)
    return Array.isArray(kids) ? cloneElement(node, undefined, ...kids) : cloneElement(node, undefined, kids)
  }
  function Unfold({ el }) {
    return walk(el.type(el.props))
  }
  const html = quietly(() => renderToStaticMarkup(walk(page(v, timeRange))))
  return { charts, html }
}

// A reader's clicks, each made once: the pod's one row of the Containers
// table, a namespace on the Pod list's picker, a choice in one of its strip's
// selects.
const pickContainer = ({ rows, selectedKey, onRowClick }) => {
  if (selectedKey === null && rows?.[0]?.containerName) onRowClick(rows[0])
}
const pickNamespace = ns => ({ onPick }) => { if (onPick) onPick(ns) }
const pickIn = (label, choice) => ({ label: l, value, onSelect }) => { if (l === label && value === '' && onSelect) onSelect(choice) }

const count = (html, needle) => html.split(needle).length - 1

// The frames a view draws that carry a ⋮ menu: Runtime cards, RED legend
// charts, the Latency Drilldown frame (a .drill2 that is not inside a legend
// chart), the Kubernetes stat cards, and the cluster's Summary and a
// namespace's Pods tables. The charts among them, and only those, carry an
// Expand beside it.
function frames(html) {
  const cards = count(html, 'class="runtime-chart-card ')
  const legendCharts = count(html, 'class="red-chart-section"')
  const panels = count(html, 'class="drill2"') - legendCharts
  const stats = count(html, 'class="k8s-stat-card"')
  const tables = count(html, 'class="panel-head-left">Summary<') + count(html, 'class="panel-head-left">Pods<')
  return {
    cards, legendCharts, panels, stats, tables,
    total: cards + legendCharts + panels + stats + tables,
    charts: cards + legendCharts + panels,
    menus: count(html, 'class="card-menu-btn"'),
    expands: count(html, 'class="card-expand-btn"'),
    skeletons: (html.match(/class="card-expand-btn"[^>]*disabled=""/g) ?? []).length,
  }
}

// The status hues (tailwind.config.js and the style guide), and the greens,
// ambers and reds Infra's charts used to draw its series in.
const STATUS_HEX = /#(22C55E|F59E0B|EF4444|34D399|EAB308|F97316|FB7185)\b/i

const node = k8sNodesForWindow(REFERENCE_WINDOW)[0]
const pod = k8sPodsForWindow(REFERENCE_WINDOW)[0]

// Every source in the sidebar, groups' children included, plus the drill-ins.
const SOURCES = INFRA_SOURCES.flatMap(s => (s.children ? s.children.map(c => c.id) : [s.id]))
const VIEWS = [
  ...SOURCES.map(source => ({ source })),
  { source: 'host', selectedHost: 'ip-10-0-142-133' },
  { source: 'k8s-cluster', resource: 'kube-system' },
  { source: 'k8s-node', resource: node.name },
  { source: 'k8s-pod', resource: pod.name },
]
const nameOf = v => [v.source, v.selectedHost ?? v.resource].filter(Boolean).join(' › ')
// A source with no integration draws three flat "no data" cards and nothing to
// act on, so they carry no menu.
const isEmpty = html => html.includes('>Requests per Minute<') && html.includes('>Latency<')

test('every view renders, and every chart and stat card it draws carries the ⋮ menu', () => {
  for (const v of VIEWS) {
    const html = view(v)
    const f = frames(html)
    if (isEmpty(html)) {
      assert.equal(f.cards, 3, `${nameOf(v)}: three no-data cards`)
      assert.equal(f.menus, 0, `${nameOf(v)}: nothing to act on`)
      assert.equal(f.expands, 0, `${nameOf(v)}: nothing to look at closer`)
    } else {
      assert.equal(f.menus, f.total, `${nameOf(v)}: ${JSON.stringify(f)}`)
    }
  }
})

test('every chart a view draws carries a live Expand beside its ⋮, and nothing else does', () => {
  for (const v of VIEWS) {
    const html = view(v)
    if (isEmpty(html)) continue
    const f = frames(html)
    assert.equal(f.expands, f.charts, `${nameOf(v)}: ${JSON.stringify(f)}`)
    assert.equal(f.skeletons, 0, `${nameOf(v)}: no chart is a skeleton`)
    // Expand and the ⋮ are one element in the header, where the ⋮ stood.
    assert.equal(count(html, '<span class="card-actions"><button type="button" class="card-expand-btn"'), f.charts, nameOf(v))
  }
})

test('every view renders on a short, a long and a part-future window', () => {
  // Today runs to midnight, so most of its buckets hold no reading yet; every
  // figure a card or a legend prints from one must say nothing rather than throw.
  for (const value of ['5m', '7d', 'today']) {
    for (const v of VIEWS) assert.doesNotThrow(() => view(v, { kind: 'preset', value }), `${nameOf(v)} over ${value}`)
  }
})

test('no panel head carries a hint line beside its title', () => {
  for (const v of VIEWS) assert.doesNotMatch(view(v), /class="hint"/, nameOf(v))
})

test('no view draws a series in a status colour (rule 2)', () => {
  for (const v of VIEWS) {
    const html = view(v)
    assert.doesNotMatch(html, STATUS_HEX, nameOf(v))
  }
})

test('the views with data draw the charts they did, in the service page\'s frames', () => {
  const shape = v => {
    const { cards, legendCharts, panels } = frames(view(v))
    return { cards, legendCharts, panels }
  }
  assert.deepEqual(shape({ source: 'host' }), { cards: 3, legendCharts: 0, panels: 0 })
  assert.deepEqual(shape({ source: 'host', selectedHost: 'ip-10-0-142-133' }), { cards: 3, legendCharts: 0, panels: 2 })
  assert.deepEqual(shape({ source: 'k8s-node' }), { cards: 3, legendCharts: 0, panels: 0 })
  assert.deepEqual(shape({ source: 'k8s-node', resource: node.name }), { cards: 4, legendCharts: 0, panels: 0 })
  assert.deepEqual(shape({ source: 'k8s-pod', resource: pod.name }), { cards: 5, legendCharts: 0, panels: 0 })
  assert.deepEqual(shape({ source: 'k8s-cluster' }), { cards: 3, legendCharts: 0, panels: 0 })
  assert.deepEqual(shape({ source: 'k8s-cluster', resource: 'kube-system' }), { cards: 3, legendCharts: 0, panels: 0 })
  assert.deepEqual(shape({ source: 'k8s-deployment' }), { cards: 1, legendCharts: 0, panels: 0 })
  assert.deepEqual(shape({ source: 'mysql' }), { cards: 3, legendCharts: 0, panels: 0 })
  assert.deepEqual(shape({ source: 'redis' }), { cards: 3, legendCharts: 0, panels: 0 })
})

test('a fleet is three cards in one row, with no legend, each holding back what it cannot draw', () => {
  for (const source of ['host', 'k8s-node']) {
    const html = view({ source })
    assert.equal(count(html, 'class="runtime-chart-card rt-third"'), 3, source)
    assert.doesNotMatch(html, /class="runtime-legend"|class="drill2-legend/, source)
  }
  // Each card keeps its own series budget: 64 hosts are held to a third's
  // eight, with the rest offered under the plot; two nodes need no footer.
  const hostHtml = view({ source: 'host' })
  assert.equal(count(hostHtml, '<span aria-hidden="true">Showing 8 of 64 hosts</span>'), 3)
  assert.equal(count(hostHtml, '>Show 20 more</button>'), 3)
  assert.equal(count(view({ source: 'k8s-node' }), 'class="series-budget"'), 0)
})

test('a host\'s CPU and memory sit beside its top processes, with production\'s other CPU views stubbed', () => {
  const html = view({ source: 'host', selectedHost: 'ip-10-0-142-133' })
  assert.equal(count(html, '>Top processes<'), 2)
  assert.equal(count(html, 'aria-label="Search processes"'), 2)
  // A ranking, not a legend: no swatch claims a line the chart does not draw.
  assert.doesNotMatch(html.slice(html.indexOf('>Top processes<'), html.indexOf('class="infra-card-grid"')), /drill2-swatch/)
  assert.match(html, /<div role="tab" aria-selected="true" class="seg active">CPU Used %<\/div>/)
  assert.equal(count(html, 'aria-disabled="true" class="seg is-stub"'), 2)
  assert.match(html, /<span class="clbl-text">Disk Used %<span class="cval">72\.8%<\/span><\/span>/)
})

/* ---- Expand and Compare ---- */

// Over the page's window a chart's forWindow must be exactly what the chart
// draws, and over an earlier one the same derivation: the same lines, keys and
// colours in one order (a host keeps its colour, and the fleet card its
// hosts), each as many buckets long as the page's window.
//
// Every view that draws a chart with data, and the three a reader reaches by
// clicking: a pod's container, and the Pod list, as it opens on a namespace and
// narrowed by its Filter to one workload.
const hasCharts = html => !isEmpty(html) && frames(html).charts > 0
const CASES = [
  ...VIEWS.filter(v => hasCharts(view(v))).map(v => ({ name: nameOf(v), v })),
  { name: `k8s-pod › ${pod.name} › its container`, v: { source: 'k8s-pod', resource: pod.name }, acts: [pickContainer] },
  { name: 'k8s-pod › default', v: { source: 'k8s-pod' }, acts: [pickNamespace('default')] },
  {
    name: 'k8s-pod › default › Deployment payment-service',
    v: { source: 'k8s-pod' },
    acts: [pickNamespace('default'), pickIn('Filter', 'Deployment'), pickIn('Deployment', 'payment-service')],
  },
]
const linesOf = series => series.map(({ key, label, color, dash }) => ({ key, label, color, dash }))

test('the clicks reach the charts they open', () => {
  const titles = c => chartsOf(c.v, c).charts.map(x => x.props.title)
  const [container, list, filtered] = CASES.slice(-3)
  assert.deepEqual(titles(container), ['CPU Used (cores)', 'Memory Used (bytes)', 'Disk Used %', 'Container Restarts', 'Network Traffic (bytes/s)'])
  assert.deepEqual(titles(list), ['CPU Used (cores)', 'Memory Remaining (bytes)', 'Disk Used %', 'Pods'])
  const cpu = chartsOf(filtered.v, filtered).charts[0].props
  assert.deepEqual(cpu.series.map(s => s.key), [pod.name], 'the Filter keeps the one pod')
})

test('every chart a view draws can be compared, and over the page\'s window draws what the card does', () => {
  for (const c of CASES) {
    const { charts, html } = chartsOf(c.v, c)
    const f = frames(html)
    assert.ok(charts.length > 0, `${c.name}: charts found`)
    assert.equal(charts.length, f.charts, `${c.name}: every chart found`)
    assert.equal(f.expands, f.charts, `${c.name}: an Expand on each`)
    for (const { kind, props } of charts) {
      const at = `${c.name} · ${props.title}`
      if (kind === 'panel') {
        const { win, render, comparable } = props.view
        assert.equal(comparable, true, `${at}: offers Compare`)
        const host = infraHostsForWindow(win).find(h => h.host === c.v.selectedHost)
        assert.deepEqual(render(win).props.series, props.title === 'CPU Used %' ? host.cpuSeries : host.memSeries, at)
        continue
      }
      assert.equal(typeof props.forWindow, 'function', `${at}: offers Compare`)
      const own = props.forWindow(props.win)
      if (kind === 'card') {
        assert.deepEqual(own.series, props.series, `${at}: series`)
        if ('value' in own) assert.equal(own.value, props.value, `${at}: value`)
      } else {
        assert.deepEqual(own.eps, props.eps, `${at}: rows`)
        assert.deepEqual(own.epSeries, props.epSeries, `${at}: series`)
      }
    }
  }
})

test('over an earlier window a chart is the same chart: the same lines in one order, as many buckets', () => {
  for (const timeRange of [HOUR, { kind: 'preset', value: 'today' }]) {
    for (const c of CASES) {
      for (const { kind, props } of chartsOf(c.v, { ...c, timeRange }).charts) {
        const win = kind === 'panel' ? props.view.win : props.win
        for (const { sec, label } of CHART_COMPARE_OPTIONS) {
          const w = shiftWindow(win, sec)
          const at = `${c.name} over ${timeRange.value}, ${label} · ${props.title}`
          // Dated by w, bucket for bucket. A different array is not enough: a
          // closure that rebuilds the page window's rows hands back a fresh
          // array with today's times on it, and only the times give it away.
          assert.equal(w.buckets.length, win.buckets.length, `${at}: buckets`)
          const times = w.buckets.map(b => b.t)
          const datedBy = rows => assert.deepEqual(rows.map(r => r.t), times, `${at}: its own window's buckets`)
          if (kind === 'panel') {
            datedBy(props.view.render(w).props.series)
          } else if (kind === 'card') {
            const then = props.forWindow(w).series
            assert.deepEqual(linesOf(then), linesOf(props.series), `${at}: lines`)
            then.forEach(s => datedBy(s.rows))
          } else {
            const then = props.forWindow(w)
            assert.deepEqual(then.eps.map(r => r.name), props.eps.map(r => r.name), `${at}: rows`)
            then.epSeries.forEach(s => datedBy(s.series))
          }
        }
      }
    }
  }
})

test('a figure read off the window goes back with the chart; a summary\'s reading stays on the page', () => {
  const day = w => shiftWindow(w, 86400)
  const cardsOf = v => Object.fromEntries(chartsOf(v).charts.map(c => [c.props.title, c.props]))
  // Redis IS the incident: a day back its memory sits at the quiet baseline.
  const redis = cardsOf({ source: 'redis' })
  const peak = s => Math.max(...s[0].rows.map(r => r.value ?? 0))
  const mem = redis['Memory Used (bytes)']
  assert.ok(peak(mem.forWindow(day(mem.win)).series) < peak(mem.series), 'memory a day back is below the plateau')
  const evictions = redis['Evictions per Minute']
  assert.ok(Number.isFinite(evictions.forWindow(day(evictions.win)).value), 'evictions are read off the window')
  assert.equal('value' in mem.forWindow(day(mem.win)), false, 'the summary\'s memory is today\'s')
  for (const card of Object.values(cardsOf({ source: 'mysql' }))) {
    assert.equal('value' in card.forWindow(day(card.win)), false, `MySQL · ${card.title}`)
  }
  // A host's own readings are its window's, and go back with it.
  const host = cardsOf({ source: 'host', selectedHost: 'ip-10-0-142-133' })['Disk Used %']
  assert.match(host.forWindow(day(host.win)).value, /^\d+\.\d%$/)
})

test('a host\'s CPU panel opens with its processes, once expanded and twice compared, sized by the modal', () => {
  const panel = chartsOf({ source: 'host', selectedHost: 'ip-10-0-142-133' }).charts.find(c => c.kind === 'panel').props
  const modal = mode => quietly(() => renderToStaticMarkup(
    <ChartModal mode={mode} onMode={noop} onClose={noop} title={panel.title} view={panel.view} />,
  ))
  const expand = modal('expand')
  assert.equal(count(expand, '>Top processes<'), 1)
  assert.equal(count(expand, 'class="drill2-chart"'), 1)
  const compare = modal('compare')
  assert.equal(count(compare, '>Top processes<'), 2)
  assert.equal(count(compare, 'class="drill2-chart"'), 2)
  // The modal's plot height outranks the panel's 260px.
  assert.doesNotMatch(compare, /height:260px/)
  // The tabs are the panel's: in the modal there is nothing to switch to.
  assert.doesNotMatch(compare, /seg-toggle/)
})
