// The Errors page's Expand: the toolbar's "Expand graph" for the volume strip,
// the strip drawn again at the modal's height, and an Expand in the corner of
// every error group's chart.
//
// Server-rendered, like every page test here: nothing can be clicked, so the
// modal is drawn by handing ChartModal the strip directly, as the toolbar's
// view does, and Hide graph cannot be pressed. The button and the strip are
// drawn under the same `graphVisible`, so what is checked is that they come
// together. Opening, focus and the keyboard are checked in the running page.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server.browser'
import { MemoryRouter } from 'react-router-dom'
import { REFERENCE_WINDOW, resolveWindow } from '@/data/timeWindow'
import { errorSeriesForWindow, groupErrorSeries, sumErrorSeries } from '@/data/errors'
import { exceptionParts, deltaChip } from '@/utils/errorsPage'
import { ChartFrameContext, EXPAND_PLOT_HEIGHT } from '@/components/charts/chartView'
import ChartModal from '@/components/charts/ChartModal.jsx'
import ErrorGroupTable from '@/components/errors/ErrorGroupTable.jsx'
import ErrorsView, { ErrorsVolume } from './ErrorsView.jsx'

const noop = () => {}
const html = el => renderToStaticMarkup(el)
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;')

const WIN = REFERENCE_WINDOW

/* ---- the toolbar ---- */

test('the toolbar offers Expand graph right after Hide graph, named by its text, with the strip it expands', () => {
  const h = html(
    <MemoryRouter initialEntries={['/errors']}>
      <ErrorsView timeRange={{ kind: 'preset', value: '1h' }} setTimeRange={noop} setToast={noop} onOpenLink={noop} goHome={noop} />
    </MemoryRouter>,
  )
  assert.match(
    h,
    /Hide graph<\/button><button type="button" class="hbtn small" title="Expand Error volume" aria-haspopup="dialog"><svg [^>]*class="lucide lucide-maximize2" aria-hidden="true">.*?<\/svg>Expand graph<\/button>/,
  )
  assert.equal((h.match(/Expand graph<\/button>/g) ?? []).length, 1)
  // Drawn under the same switch as the strip, which is on the page with it.
  assert.equal((h.match(/<div class="logs-volume">/g) ?? []).length, 1)
})

/* ---- the strip, on the page and expanded ---- */

const rows = errorSeriesForWindow(WIN, 'server')
const strip = (props = {}) => (
  <ErrorsVolume
    win={WIN}
    volume={sumErrorSeries(rows, WIN)}
    totals={{ count: 1234, prev: 200, services: 3, newGroups: 2 }}
    totalDelta={deltaChip(1234, 200, 'the previous hour')}
    prevText="the previous hour"
    groupCount={9}
    zoomedFrom={null}
    onFocus={noop}
    onClearZoom={noop}
    {...props}
  />
)

test('on the page the strip sets no height of its own: the stylesheet\'s 112px stands', () => {
  const h = html(strip())
  assert.ok(h.startsWith('<div class="logs-volume"><div class="logs-volume-chart"><div class="volume-brush-hint">'), h.slice(0, 200))
  assert.doesNotMatch(h, /logs-volume-chart" style/)
})

test('expanded, the strip takes the modal\'s height and keeps its legend and its Reset zoom', () => {
  const h = html(
    <ChartModal
      mode="expand" onMode={noop} onClose={noop} title="Error volume" menu={false}
      view={{ win: WIN, render: () => strip({ zoomedFrom: { kind: 'preset', value: '1h' } }), comparable: false }}
    />,
  )
  assert.match(h, /<span id="[^"]+" class="chart-modal-title">Error volume<span class="chart-modal-range">Last 1 hour<\/span><\/span>/)
  assert.ok(h.includes(`<div class="logs-volume-chart" style="height:${EXPAND_PLOT_HEIGHT}"><button class="volume-reset-btn"`), h)
  assert.match(h, /<span class="lvl-key">Errors<\/span><span class="lvl-val">1,234<\/span>/)
  assert.match(h, /<span class="lvl-key">Groups<\/span><span class="lvl-val">9<span class="errp-legend-new">\(2 new\)<\/span>/)
  // A frame's height in pixels is a number, and is drawn as one.
  const px = html(<ChartFrameContext.Provider value={{ height: 300 }}>{strip()}</ChartFrameContext.Provider>)
  assert.ok(px.includes('<div class="logs-volume-chart" style="height:300px">'), px)
})

/* ---- each group's chart ---- */

// Each row, from its opening tag to the next row's.
const rowsOf = h => h.split('<div class="errp-row').slice(1)

for (const [range, win] of [['1h', WIN], ['7d', resolveWindow({ kind: 'preset', value: '7d' })]]) {
  for (const side of ['server', 'client']) {
    test(`every row ends in its chart's Expand and its Traces, boxed icons named for its group, lazy rows too (${range}, ${side})`, () => {
      const groups = groupErrorSeries(errorSeriesForWindow(win, side), win)
      assert.ok(groups.length > 8, 'enough rows that some charts wait to mount')
      const h = html(
        <ErrorGroupTable
          groups={groups} side={side} win={win} onFocus={noop}
          sort={{ key: 'count', dir: 'desc' }} onSort={noop} selectedId={null} onSelect={noop} onOpenTraces={noop}
          serviceStatus={{}} prevText="the previous hour" scrollRoot={null}
        />,
      )
      const rs = rowsOf(h)
      assert.equal(rs.length, groups.length)
      rs.forEach((row, i) => {
        const g = groups[i]
        const where = side === 'client' ? `${g.endpoint}, calling ${g.spanName}` : g.endpoint
        const name = esc(`Expand ${g.exceptionShort || exceptionParts(g.exception).short} in ${g.service} at ${where}`)
        // The chart cell holds the chart (or, past the first eight, its
        // placeholder) and nothing else; the actions follow it, Expand first.
        const [, chart, actions] = row.match(/<div class="errp-spark">(.*?)<div class="errp-actions">(.*)$/) ?? []
        assert.ok(chart, `row ${i} has its spark cell`)
        assert.doesNotMatch(chart, /<button/)
        assert.equal(chart.includes('errp-spark-ph'), i >= 8, `row ${i}`)
        const buttons = [...actions.matchAll(/<button type="button" class="row-icon-btn" ([^>]*)>/g)].map(m => m[1])
        assert.equal(buttons.length, 2, `row ${i}: Expand and Traces`)
        assert.equal(buttons[0], `title="${name}" aria-label="${name}" aria-haspopup="dialog"`)
        assert.match(buttons[1], /^title="View these errors in Traces" aria-label="View these errors in Traces: /)
      })
      assert.equal((h.match(/aria-haspopup="dialog"/g) ?? []).length, groups.length)
    })
  }
}
