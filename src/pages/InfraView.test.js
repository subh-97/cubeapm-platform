// Every Infrastructure view, rendered the way a source in the sidebar or a link
// opens it, and read for its charts: each is one of the APM service page's
// (the RED legend chart, the Runtime card, the Latency Drilldown frame), each
// carries that page's ⋮ menu, and none spends a status colour on a series.
// What a hover, a drag or a click does needs a DOM and is checked in the
// running page; the shared charts' own behaviour is tested beside them.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server.browser'
import { INFRA_SOURCES, k8sNodesForWindow, k8sPodsForWindow } from '@/data/observability'
import { REFERENCE_WINDOW } from '@/data/timeWindow'
import InfraView from './InfraView.jsx'

const noop = () => {}
const HOUR = { kind: 'preset', value: '1h' }

// The same server-render warnings LegendLineChart.test.js expects: a chart's
// frame has no size to draw at, and the card menus measure themselves in a
// layout effect. Anything else still reaches the console.
const EXPECTED = /width\(\d+\) and height\(\d+\) of chart|useLayoutEffect does nothing on the server/
function view({ source, resource = null, selectedHost = null }, timeRange = HOUR) {
  const { warn, error } = console
  const quiet = log => (...args) => { if (!EXPECTED.test(String(args[0]))) log(...args) }
  console.warn = quiet(warn)
  console.error = quiet(error)
  try {
    return renderToStaticMarkup(
      <InfraView
        goHome={noop} source={source} resource={resource} selectedHost={selectedHost} setSelectedHost={noop}
        timeRange={timeRange} setTimeRange={noop} settingsOpen={false} setSettingsOpen={noop} setToast={noop}
      />,
    )
  } finally {
    Object.assign(console, { warn, error })
  }
}

const count = (html, needle) => html.split(needle).length - 1

// The chart frames a view draws: Runtime cards, RED legend charts, and the
// Latency Drilldown frame (a .drill2 that is not inside a legend chart).
function frames(html) {
  const cards = count(html, 'class="runtime-chart-card ')
  const legendCharts = count(html, 'class="red-chart-section"')
  const panels = count(html, 'class="drill2"') - legendCharts
  return { cards, legendCharts, panels, total: cards + legendCharts + panels, menus: count(html, 'class="card-menu-btn"') }
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

test('every view renders, and every chart it draws carries the ⋮ menu', () => {
  for (const v of VIEWS) {
    const html = view(v)
    const f = frames(html)
    if (isEmpty(html)) {
      assert.equal(f.cards, 3, `${nameOf(v)}: three no-data cards`)
      assert.equal(f.menus, 0, `${nameOf(v)}: nothing to act on`)
    } else {
      assert.equal(f.menus, f.total, `${nameOf(v)}: ${JSON.stringify(f)}`)
    }
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
