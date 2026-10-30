// The Browser page's metric tabs as their chart cards hand themselves to
// Expand and Compare (docs/decisions/chart-compare-expand.md): every summary
// card and every legend chart carries an Expand, and a `forWindow` that gives,
// over the page's window, exactly what the card draws, and over an earlier one
// the same derivation — as many buckets, the same rows in the same order.
//
// What a tab hands its cards is read off the tab's own element tree: a probe
// calls the tab as a function inside its own render, so the tab's hooks run as
// they do on the page, and what comes back is the tree it would mount.
//
// The modal is server-rendered here too, as charts/chartModal.test.js renders
// it: with no document it draws in place rather than in a portal. So each
// card's Compare is opened with the card's own view — the one its corner
// (ChartActions) is handed — and both panels are read off the markup. Focus
// and the keyboard are checked in the running page.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server.browser'
import { isValidElement } from 'react'
import { REFERENCE_WINDOW as win, shiftWindow } from '@/data/timeWindow'
import { BROWSER_APPS, ajaxSummaryForWindow } from '@/data/browser'
import {
  CHART_COMPARE_OPTIONS, DEFAULT_CHART_COMPARE, COMPARE_PLOT_HEIGHT, chartCompareOption,
} from '@/components/charts/chartView'
import LegendLineChart from '@/components/charts/LegendLineChart.jsx'
import ChartActions from '@/components/charts/ChartActions.jsx'
import ChartModal from '@/components/charts/ChartModal.jsx'
import SummaryCard from './SummaryCard.jsx'
import PageViewsTab from './PageViewsTab.jsx'
import AjaxCallsTab from './AjaxCallsTab.jsx'
import WebVitalsTab from './WebVitalsTab.jsx'
import { VITALS, VITAL_SHORT, VITAL_TITLES } from './metricLabels'

const noop = () => {}
const timeRange = { kind: 'preset', value: '1h' }
const DAY = 86400

const TABS = [
  {
    name: 'Page Views', Tab: PageViewsTab,
    cards: ['Page views / min', 'Load time (median)', 'Load time (avg)'],
    charts: ['RPM', 'Response Time (median)', 'Response Time (avg)'],
  },
  {
    name: 'Ajax Calls', Tab: AjaxCallsTab,
    cards: ['Calls / min', 'Response time (avg)', 'Error %'],
    charts: ['RPM', 'Response Time (avg)', 'Error %'],
  },
  {
    name: 'Web Vitals', Tab: WebVitalsTab,
    cards: VITALS.map(m => VITAL_TITLES[m]),
    charts: VITALS.map(m => VITAL_SHORT[m]),
  },
]

// Two warnings are a server render's, not the tab's (LegendLineChart.test.js
// says the same): a chart's frame has no size to draw at, and the card menus
// measure themselves in layout effects a server render skips.
const EXPECTED = /width\(\d+\) and height\(\d+\) of chart|useLayoutEffect does nothing on the server/
function quietly(fn) {
  const { warn, error } = console
  const quiet = log => (...args) => { if (!EXPECTED.test(String(args[0]))) log(...args) }
  console.warn = quiet(warn)
  console.error = quiet(error)
  try { return fn() } finally { Object.assign(console, { warn, error }) }
}

const propsFor = (app, view) => ({ app, win, timeRange, syncId: 'rum-test', onFocus: noop, view, onView: noop })

const markup = (Tab, app, view) => quietly(() => renderToStaticMarkup(<Tab {...propsFor(app, view)} />))

function treeOf(Tab, app) {
  let tree
  function Probe() {
    tree = Tab(propsFor(app, 'graph'))
    return null
  }
  quietly(() => renderToStaticMarkup(<Probe />))
  return tree
}

// Every element of `type` in a tree, through children and through the props
// that carry elements (MetricPanel's `graph`).
function elementsOf(node, type, out = []) {
  if (Array.isArray(node)) node.forEach(n => elementsOf(n, type, out))
  else if (isValidElement(node)) {
    if (node.type === type) out.push(node.props)
    Object.values(node.props ?? {}).forEach(v => elementsOf(v, type, out))
  }
  return out
}

const expandTitles = html => [...html.matchAll(/<button type="button" class="card-expand-btn" title="Expand ([^"]*)"([^>]*)>/g)]
  .map(([, title, rest]) => ({ title: title.replace(/&amp;/g, '&'), disabled: /disabled/.test(rest) }))

test('every chart card on a metric tab carries an Expand, live: three cards, and three charts in Graph', () => {
  for (const { name, Tab, cards, charts } of TABS) {
    for (const app of BROWSER_APPS) {
      const graph = expandTitles(markup(Tab, app, 'graph'))
      assert.deepEqual(graph.map(b => b.title), [...cards, ...charts], `${name}, ${app.id}`)
      assert.ok(graph.every(b => !b.disabled), `${name}, ${app.id}: no card is a skeleton`)
      // Table view mounts no charts: the cards' Expand only.
      assert.deepEqual(expandTitles(markup(Tab, app, 'table')).map(b => b.title), cards, `${name}, ${app.id}: Table`)
    }
  }
})

test('over the page\'s window a card\'s forWindow is exactly what the card draws', () => {
  for (const { name, Tab } of TABS) {
    for (const app of BROWSER_APPS) {
      const tree = treeOf(Tab, app)
      const cards = elementsOf(tree, SummaryCard)
      const charts = elementsOf(tree, LegendLineChart)
      assert.equal(cards.length, 3, `${name}, ${app.id}: cards`)
      assert.equal(charts.length, 3, `${name}, ${app.id}: charts`)
      for (const c of cards) {
        assert.equal(typeof c.forWindow, 'function', `${name} · ${c.title}: offers Compare`)
        const own = c.forWindow(win)
        assert.equal(own.value, c.value, `${name} · ${c.title}: value`)
        // The readers memoise per window, so the same derivation is the same list.
        assert.equal(own.series, c.series, `${name} · ${c.title}: series`)
        if ('yTop' in own) assert.equal(own.yTop, c.yTop, `${name} · ${c.title}: axis top`)
      }
      for (const c of charts) {
        assert.equal(typeof c.forWindow, 'function', `${name} · ${c.title}: offers Compare`)
        const own = c.forWindow(win)
        assert.equal(own.eps, c.eps, `${name} · ${c.title}: rows`)
        assert.equal(own.epSeries, c.epSeries, `${name} · ${c.title}: series`)
      }
    }
  }
})

test('over an earlier window it is the same chart: as many buckets, the same rows in the same order', () => {
  for (const { name, Tab } of TABS) {
    for (const app of BROWSER_APPS) {
      const tree = treeOf(Tab, app)
      for (const { sec, label } of CHART_COMPARE_OPTIONS) {
        const w = shiftWindow(win, sec)
        const at = `${name}, ${app.id}, ${label}`
        for (const c of elementsOf(tree, SummaryCard)) {
          const then = c.forWindow(w)
          assert.ok(Number.isFinite(then.value), `${at} · ${c.title}: a figure`)
          assert.equal(then.series.length, win.buckets.length, `${at} · ${c.title}: buckets`)
          assert.notEqual(then.series, c.series, `${at} · ${c.title}: its own window's series`)
          if (c.yTop != null) assert.ok(then.yTop > 0, `${at} · ${c.title}: bands in view`)
        }
        for (const c of elementsOf(tree, LegendLineChart)) {
          const then = c.forWindow(w)
          // Colours are keyed on a row's index and the isolation on its label,
          // so both copies of a Compare must list the same rows in one order.
          assert.deepEqual(then.eps.map(r => r.endpoint), c.eps.map(r => r.endpoint), `${at} · ${c.title}: rows`)
          assert.deepEqual(then.epSeries.map(s => s.endpoint), c.epSeries.map(s => s.endpoint), `${at} · ${c.title}: series`)
          assert.ok(then.epSeries.every(s => s.series.length === win.buckets.length), `${at} · ${c.title}: buckets`)
        }
      }
    }
  }
})

// The view a card hands its corner (ChartActions), which is what its Expand
// and Compare open, read off the card's own tree. A legend chart holds its
// legend's state (the isolated row, the search) for every drawing of it, so
// the card is called inside a render of its own, where its hooks have a
// component to belong to, and the tree it returns is read there.
const viewOf = (Card, props) => {
  let view
  function Probe() {
    view = elementsOf(Card(props), ChartActions)[0].view
    return null
  }
  quietly(() => renderToStaticMarkup(<Probe />))
  return view
}

const unescape = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, '\'').replace(/&amp;/g, '&')

const compareMarkup = (title, view) => quietly(() => renderToStaticMarkup(
  <ChartModal mode="compare" onMode={noop} onClose={noop} title={title} view={view} />,
))

// A Compare's panels, top to bottom: each one's title, the figure beside it,
// and everything it draws.
const panelsOf = html => [...html.matchAll(/<section class="chart-modal-panel" aria-label="[^"]*">([\s\S]*?)<\/section>/g)]
  .map(([, body]) => {
    const [, title, value] = body.match(/<span class="chart-modal-panel-title">([^<]*)(?:<span class="cval">([^<]*)<\/span>)?/)
    return { title: unescape(title), value: value == null ? null : unescape(value), body }
  })

// A legend's rows as drawn: the label it shows and the figure beside it.
const legendOf = body => [...body.matchAll(/<span class="drill2-label">([^<]*)<\/span><span class="drill2-val">([^<]*)<\/span>/g)]
  .map(([, label, value]) => ({ label: unescape(label), value: unescape(value) }))

// What each card's Compare opens, through its own view rather than through
// forWindow alone: the at(w) cache SummaryCard and LegendLineChart keep, and
// the window their render hands the plot, are what put the earlier window's
// figures in the earlier panel.
test('each card\'s Compare draws it twice, the earlier panel from the earlier window\'s figures', () => {
  const back = chartCompareOption(DEFAULT_CHART_COMPARE)
  const earlier = shiftWindow(win, back.sec)
  // Both plots are drawn at the modal's height, so under its frame.
  const framed = `style="width:100%;height:${COMPARE_PLOT_HEIGHT}"`
  for (const { name, Tab } of TABS) {
    for (const app of BROWSER_APPS) {
      const tree = treeOf(Tab, app)
      for (const c of elementsOf(tree, SummaryCard)) {
        const at = `${name}, ${app.id} · ${c.title}`
        const figure = v => (v == null ? null : c.fmt(v))
        const view = viewOf(SummaryCard, c)
        const then = c.forWindow(earlier)
        const panels = panelsOf(compareMarkup(c.title, view))
        assert.deepEqual(panels.map(p => p.title), [c.title, back.label], `${at}: two panels`)
        assert.equal(panels[0].value, figure(c.value), `${at}: now`)
        assert.equal(panels[1].value, figure(then.value), `${at}: ${back.label}`)
        assert.ok(panels.every(p => p.body.includes(framed)), `${at}: a plot in each`)
        // A server render has no width to draw a line at, so what the earlier
        // plot is handed is read off the element its render returns.
        const plot = view.render(earlier).props
        assert.equal(plot.win, earlier, `${at}: the earlier window's axis`)
        assert.equal(plot.series, then.series, `${at}: the earlier window's series`)
        assert.equal(plot.yTop, 'yTop' in then ? then.yTop : c.yTop, `${at}: its axis top`)
      }
      for (const c of elementsOf(tree, LegendLineChart)) {
        const at = `${name}, ${app.id} · ${c.title}`
        const view = viewOf(LegendLineChart, c)
        const then = c.forWindow(earlier)
        const panels = panelsOf(compareMarkup(c.title, view))
        assert.deepEqual(panels.map(p => p.title), [c.title, back.label], `${at}: two panels`)
        const plot = view.render(earlier).props
        assert.equal(plot.win, earlier, `${at}: the earlier window's axis`)
        assert.equal(plot.epSeries, then.epSeries, `${at}: the earlier window's series`)
        // Every row a legend lists carries its own window's figure for that
        // row: the page's above, the earlier window's below.
        const shown = r => {
          const full = r[c.labelKey ?? 'endpoint']
          return c.formatLabel ? c.formatLabel(full, r) : full
        }
        const rowsByPanel = [c.eps, then.eps]
        rowsByPanel.forEach((rows, i) => {
          const { body } = panels[i]
          const legend = legendOf(body)
          assert.ok(body.includes(framed), `${at}, panel ${i + 1}: a plot`)
          assert.ok(legend.length > 0, `${at}, panel ${i + 1}: a legend`)
          for (const { label, value } of legend) {
            const figures = rows.filter(r => shown(r) === label).map(r => c.fmtFn(r[c.dataKey]))
            assert.ok(figures.includes(value), `${at}, panel ${i + 1} · ${label}: ${value}, not one of ${figures}`)
          }
        })
      }
    }
  }
})

// What Compare is for: the incident is 22 minutes old, so a day back the
// payment calls answer as they normally do.
test('a day back, the Ajax Error % card shows the quiet baseline under the incident\'s figure', () => {
  const app = BROWSER_APPS.find(a => a.id === 'cubedemo-web')
  const card = elementsOf(treeOf(AjaxCallsTab, app), SummaryCard).find(c => c.title === 'Error %')
  const then = card.forWindow(shiftWindow(win, DAY))
  assert.equal(then.value, ajaxSummaryForWindow(shiftWindow(win, DAY), app.id).errPct)
  assert.ok(then.value < card.value, `${then.value} a day ago, against ${card.value} now`)
})
