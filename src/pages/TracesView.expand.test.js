// Expand graph on the span explorer (TracesView), on Traces and on Mobile
// Traces alike: the toolbar's button, and the volume strip it expands drawn at
// the modal's height (docs/decisions/chart-compare-expand.md, "Expand without
// a ⋮").
//
// A server render sees the page as it mounts: the graph shown and no pipe run,
// so the volume strip is what Expand graph opens. Hiding the graph, or running
// a stats query whose result is a single number, is page state a server render
// cannot reach; the strip and the modal are rendered on their own instead.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server.browser'
import { createElement } from 'react'
import { REFERENCE_WINDOW } from '@/data/timeWindow'
import TracesView, { VolumeStrip } from '@/pages/TracesView'
import ChartModal from '@/components/charts/ChartModal'
import { ChartFrameContext, EXPAND_PLOT_HEIGHT } from '@/components/charts/chartView'
import { TRACES_SOURCE, MOBILE_TRACES_SOURCE } from '@/utils/explorerSources'

const noop = () => {}
const renderPage = source => renderToStaticMarkup(createElement(TracesView, {
  source,
  timeRange: { kind: 'preset', value: '1h' },
  setTimeRange: noop,
  goHome: noop,
}))

// The strip's props as the page builds them for the reference hour.
function stripProps(source, extra = {}) {
  const win = REFERENCE_WINDOW
  const data = source.volumeForWindow(win)
  const series = source.bands.map(b => ({ ...b, color: `var(--${b.status})` }))
  const totals = { total: data.reduce((a, b) => a + b.total, 0) }
  for (const { key } of source.bands) totals[key] = data.reduce((a, b) => a + b[key], 0)
  return { win, data, series, legendSeries: [...series].reverse(), totals, zoomed: false, onClearZoom: noop, onFocus: noop, ...extra }
}

const strip = (source, frame, extra) => renderToStaticMarkup(
  frame === undefined
    ? createElement(VolumeStrip, stripProps(source, extra))
    : createElement(ChartFrameContext.Provider, { value: frame }, createElement(VolumeStrip, stripProps(source, extra))),
)

const frameOf = height => ({ syncId: 'test-modal', syncMethod: 'index', height, brush: true, nowMs: REFERENCE_WINDOW.end * 1000 })

const SOURCES = [
  ['Traces', TRACES_SOURCE, 'Span volume'],
  ['Mobile Traces', MOBILE_TRACES_SOURCE, 'Event volume'],
]

for (const [name, source, title] of SOURCES) {
  test(`${name}: Expand graph sits beside Hide graph, named for what the strip counts`, () => {
    const html = renderPage(source)
    // A labelled button (rule 4), opening a dialog, right after Hide graph.
    const expand = new RegExp(
      `>Hide graph</button><button type="button" class="hbtn small" title="Expand ${title}" aria-haspopup="dialog"><svg[^>]*>.*?</svg>Expand graph</button>`,
    )
    assert.match(html, expand)
    assert.equal(html.split('Expand graph').length - 1, 1, 'one Expand graph')
  })

  test(`${name}: the page's strip keeps its own height`, () => {
    // No frame on the page, so no inline height: the strip stays the 112px
    // its CSS gives it.
    const html = renderPage(source)
    assert.ok(html.includes('<div class="logs-volume"><div class="logs-volume-chart"><div class="volume-brush-hint">'), 'strip markup changed')
    assert.ok(!/class="logs-volume-chart" style=/.test(html), 'the page strip carries an inline height')
  })
}

test('the strip takes the frame\'s height, as a CSS length or in pixels', () => {
  assert.match(strip(TRACES_SOURCE), /<div class="logs-volume-chart"><div class="volume-brush-hint">/)
  assert.ok(strip(TRACES_SOURCE, frameOf(EXPAND_PLOT_HEIGHT))
    .includes(`<div class="logs-volume-chart" style="height:${EXPAND_PLOT_HEIGHT}">`))
  assert.ok(strip(MOBILE_TRACES_SOURCE, frameOf(420)).includes('<div class="logs-volume-chart" style="height:420px">'))
})

test('a frame that takes the drag away takes the hint with it; Reset stays', () => {
  const still = { ...frameOf(300), brush: false }
  assert.ok(strip(TRACES_SOURCE, frameOf(300)).includes('Click &amp; drag on chart to zoom in'))
  assert.ok(!strip(TRACES_SOURCE, still).includes('Click &amp; drag'), 'a hint for a drag that does nothing')
  // Reset acts on the page's range, which a drag elsewhere set.
  const zoomed = strip(TRACES_SOURCE, still, { zoomed: true })
  assert.ok(zoomed.includes('Reset zoom'))
})

test('Expand draws the strip in the modal at the modal\'s height, legend and all', () => {
  const props = stripProps(MOBILE_TRACES_SOURCE)
  const html = renderToStaticMarkup(createElement(ChartModal, {
    mode: 'expand',
    onMode: noop,
    onClose: noop,
    title: 'Event volume',
    menu: false,
    view: { win: props.win, render: () => createElement(VolumeStrip, props), value: () => '98.27K events', comparable: false },
  }))
  assert.match(html, /class="chart-modal-title">Event volume<span class="cval">98\.27K events<\/span>/)
  assert.ok(html.includes(`<div class="logs-volume-chart" style="height:${EXPAND_PLOT_HEIGHT}">`), 'strip not at the modal height')
  // The legend comes along, worst band first, in its status token.
  for (const band of MOBILE_TRACES_SOURCE.bands) assert.ok(html.includes(`<span class="lvl-key">${band.label}</span>`), band.label)
  assert.ok(html.indexOf('background:var(--critical)') < html.indexOf('background:var(--healthy)'), 'legend not worst-first')
  // No ⋮: the histogram has no card menu to carry into the modal.
  assert.ok(!html.includes('card-menu'), 'a ⋮ in a menu-less modal')
})
