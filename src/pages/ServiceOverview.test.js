// The service page's chart cards carry Expand and Compare
// (docs/decisions/chart-compare-expand.md): every card whose ⋮ is a chart's
// has Expand beside it, in one corner where the bare ⋮ stood, and the Overview
// tab's loading skeletons hold that corner's shape with Expand disabled.
//
// Server-rendered, so only what the page draws before any click: the RED tab
// opens on its table (its four charts are LegendLineChart's, tested there),
// the Detail tab's latency card on its drilldown, and the Overview tab on its
// skeletons. What Compare draws for an earlier window is the cards' own
// derivations run for it, so the last test holds those to the earlier
// window's shape: the same buckets, and the same rows in the same order,
// which is what keeps a line its colour across the two charts.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server.browser'
import {
  seriesForWindow, versionBandsForWindow, latencyDrilldownForWindow, latencyDrilldownSeriesForWindow,
  latencyDrilldownTotalForWindow, redEndpointsForWindow, redEndpointSeriesForWindow, externalEndpointsForWindow,
  externalEndpointSeriesForWindow, dbEndpointsForWindow, dbEndpointSeriesForWindow, runtimeMetricsForWindow,
} from '@/data/services'
import { resolveWindow, shiftWindow } from '@/data/timeWindow'
import { CHART_COMPARE_OPTIONS } from '@/components/charts/chartView'
import ServiceOverview from './ServiceOverview.jsx'

const RANGE = { kind: 'preset', value: '1h' }
const EXPECTED = /width\(\d+\) and height\(\d+\) of chart|useLayoutEffect does nothing on the server/

function page(tab) {
  const { warn, error } = console
  const quiet = log => (...args) => { if (!EXPECTED.test(String(args[0]))) log(...args) }
  console.warn = quiet(warn)
  console.error = quiet(error)
  try {
    return renderToStaticMarkup(
      <ServiceOverview serviceId="payment-service" serviceSubTab={tab} timeRange={RANGE} setTimeRange={() => {}} setServiceSubTab={() => {}} onOpenLink={() => {}} setToast={() => {}} />,
    )
  } finally {
    Object.assign(console, { warn, error })
  }
}

// Every chart corner on the page: its title, whether its Expand opens the
// modal (a dialog), whether it is disabled, and the corner's markup.
const CORNER = /<span class="card-actions"><button type="button" class="card-expand-btn" title="Expand ([^"]+)" aria-label="Expand \1" ([a-z-]+="[a-z]+")( disabled="")?>.*?<\/button><button type="button" class="card-menu-btn" title="\1 options".*?<\/button><\/span>/g
const corners = html => [...html.matchAll(CORNER)].map(([markup, title, opens, disabled]) => ({
  title, dialog: opens === 'aria-haspopup="dialog"', disabled: !!disabled, markup,
}))

const RUNTIME_TITLES = [
  'CPU Used %', 'Memory Used (bytes)', 'Thread Count', 'Class Count', 'Heap Memory (bytes)',
  'Non-Heap Memory Pool Used (bytes)', 'Garbage Collection CPU Time', 'G1 Old Gen Heap (bytes)',
  'G1 Eden Space Heap (bytes)', 'G1 Survivor Space Heap (bytes)', 'Buffer Memory-direct (bytes)',
  'Buffer Memory-mapped (bytes)',
]
const SPLIT_TITLES = ['Response Time (avg)', 'RPM', 'Error %']

test('every chart card has Expand beside its ⋮, in the one corner the ⋮ stood in', () => {
  const expected = {
    detail: ['Latency Drilldown', 'RPM', 'Error %', 'Apdex'],
    external: SPLIT_TITLES,
    db: SPLIT_TITLES,
    runtime: RUNTIME_TITLES,
  }
  for (const [tab, titles] of Object.entries(expected)) {
    const html = page(tab)
    const found = corners(html)
    assert.deepEqual(found.map(c => c.title), titles, tab)
    assert.ok(found.every(c => !c.disabled), `${tab}: every card has a chart to expand`)
    // No Expand outside a corner, and no chart header left with a bare ⋮.
    assert.equal((html.match(/class="card-expand-btn"/g) ?? []).length, titles.length, tab)
    for (const [, head] of html.matchAll(/<div class="clbl">(.*?)<\/div>/g)) {
      assert.match(head, /^<span class="clbl-text">.*?<\/span><span class="card-actions">/, `${tab}: ${head.slice(0, 60)}`)
    }
  }
})

// Every card's Expand opens the chart modal, and says so.
test('every card\'s Expand opens the modal', () => {
  for (const tab of ['overview', 'detail', 'external', 'db', 'runtime']) {
    const found = corners(page(tab))
    assert.ok(found.length > 0, tab)
    assert.ok(found.every(c => c.dialog), tab)
  }
})

test('the latency card\'s corner closes its head, after the view toggle, and the plot follows the head', () => {
  const html = page('detail')
  const drill = corners(html).find(c => c.title === 'Latency Drilldown')
  assert.ok(html.includes(`<span class="seg-info">`))
  assert.ok(html.includes(`</div></div>${drill.markup}</div><div class="drill2">`))
})

test('the Overview skeletons hold the real cards\' corners, with Expand disabled until there is a chart', () => {
  const skeleton = corners(page('overview'))
  assert.deepEqual(skeleton.map(c => c.title), ['Latency Drilldown', 'RPM', 'Error %', 'Apdex'])
  assert.ok(skeleton.every(c => c.disabled))
  // Byte for byte the corner the card replaces it with, but for `disabled`, so
  // nothing in the header moves at the reveal.
  const real = Object.fromEntries(corners(page('detail')).map(c => [c.title, c.markup]))
  for (const c of skeleton) assert.equal(c.markup.replace(' disabled=""', ''), real[c.title], c.title)
})

test('an earlier window gives every card\'s chart the same buckets, its rows in the same order', () => {
  const sameRows = (a, b, what) => assert.deepEqual(b.map(r => r.label ?? r.endpoint), a.map(r => r.label ?? r.endpoint), what)
  for (const value of ['1h', '1d']) {
    const win = resolveWindow({ kind: 'preset', value })
    const n = win.buckets.length
    for (const { label, sec } of CHART_COMPARE_OPTIONS) {
      const w = shiftWindow(win, sec)
      const at = `${value}, ${label}`

      // Latency Drilldown, both views.
      sameRows(latencyDrilldownForWindow(win), latencyDrilldownForWindow(w), `${at}: drilldown layers`)
      const layers = latencyDrilldownSeriesForWindow(w)
      sameRows(latencyDrilldownSeriesForWindow(win), layers, `${at}: drilldown series`)
      assert.deepEqual(layers.map(l => l.color), latencyDrilldownSeriesForWindow(win).map(l => l.color))
      for (const l of layers) assert.equal(l.series.length, n, `${at}: ${l.label}`)
      assert.equal(latencyDrilldownTotalForWindow(w).series.length, n)
      assert.equal(seriesForWindow(w).latencyP90.length, n)

      // RPM, Error % and Apdex: a band per deploy, coloured by its place.
      const bands = versionBandsForWindow(w)
      for (const key of ['rpm', 'errorRatePct', 'apdex']) {
        sameRows(versionBandsForWindow(win)[key], bands[key], `${at}: ${key} bands`)
        for (const b of bands[key]) assert.equal(b.series.length, n)
      }

      // The RED, External and DB charts: a line per row, coloured by its index.
      for (const [rows, sample] of [
        [redEndpointsForWindow, redEndpointSeriesForWindow],
        [externalEndpointsForWindow, externalEndpointSeriesForWindow],
        [dbEndpointsForWindow, dbEndpointSeriesForWindow],
      ]) {
        sameRows(rows(win), rows(w), `${at}: ${rows.name}`)
        for (const key of ['avg', 'rpm', 'errPct']) {
          const lines = sample(w, key)
          sameRows(rows(w), lines, `${at}: ${sample.name} ${key}`)
          for (const l of lines) assert.equal(l.series.length, n)
        }
      }

      // Runtime, for the whole fleet and for one host.
      for (const host of [null, 'ip-10-0-130-150']) {
        const rt = runtimeMetricsForWindow(w, host)
        assert.equal(rt.cpuPct.length, n, `${at}: runtime ${host}`)
        assert.equal(rt.heap.used.length, n)
      }
    }
  }
})
