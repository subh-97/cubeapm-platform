// The request list + trace preview: the APM service page's Slow Requests panel,
// lifted out so the Browser page's Traces tab is the same panel.
//
// The original is kept below as a fixture, copied exactly as it stood in
// ServiceOverview.jsx, and each of the service page's three uses (Slow
// Requests on Overview and on an endpoint, Requests with Errors) is rendered
// both ways over every range and sort, character for character — so the
// switch moves nothing. The one difference allowed is what the extraction added
// on purpose: the sort toggle's role, focus and pressed state. The new options
// are then checked for what they add. A row is picked by a click, which a
// static render cannot make, so the error summary is checked on its own.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server.browser'
import { useState, useMemo, useCallback } from 'react'
import CardMenu from '@/components/CardMenu'
import Waterfall from '@/components/trace/Waterfall'
import { buildTrace } from '@/data/traceDetail'
import { REFERENCE_WINDOW, resolveWindow } from '@/data/timeWindow'
import { slowRequestsForWindow, errorRequestsForWindow } from '@/data/services'
import RequestTraceSplit, { TraceErrorSummary } from './RequestTraceSplit.jsx'

const noop = () => {}
const html = el => renderToStaticMarkup(el)

/* ── Fixture: the original, verbatim (ServiceOverview.jsx) ── */

const ORIGINAL_SORTS = [
  { id: 'latency', label: 'Latency' },
  { id: 'time', label: 'Time' },
  { id: 'none', label: 'None' },
]

function SlowRequests({ onOpenTrace, data, title = 'Slow Requests', initialSort = 'latency' }) {
  const [sortBy, setSortBy] = useState(initialSort)
  const [selected, setSelected] = useState(null)
  const [collapsed, setCollapsed] = useState(() => new Set())
  const [span, setSpan] = useState(null)

  const rows = useMemo(() => {
    if (sortBy === 'none') return data
    const list = [...data]
    if (sortBy === 'latency') list.sort((a, b) => b.latencyMs - a.latencyMs)
    else list.sort((a, b) => parseInt(a.timestamp, 10) - parseInt(b.timestamp, 10))
    return list
  }, [sortBy, data])

  const row = selected ? rows.find(r => r.traceId === selected) : null

  // eslint-disable-next-line react-hooks/exhaustive-deps -- verbatim fixture
  const trace = useMemo(() => row ? buildTrace(row.traceId) : null, [row?.traceId])

  const toggle = useCallback(id => setCollapsed(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  }), [])

  return (
    <div className="panel">
      <div className="panel-head is-divided">
        <div className="panel-head-left">{title}</div>
        <div className="panel-head-right">
          <span className="sort-lbl">Sort by</span>
          <div className="seg-toggle">
            {ORIGINAL_SORTS.map(s => (
              <div key={s.id} className={`seg${sortBy === s.id ? ' active' : ''}`} onClick={() => setSortBy(s.id)}>{s.label}</div>
            ))}
          </div>
          <CardMenu kind="list" title={title} />
        </div>
      </div>
      <div className="slowreq-split">
        <div className="slowreq-list">
          {rows.map(r => (
            <button
              type="button"
              className={`slowreq-row${r.traceId === selected ? ' selected' : ''}`}
              key={r.traceId}
              onClick={() => setSelected(r.traceId)}
              aria-pressed={r.traceId === selected}
            >
              <div>
                <div className="ep">{r.endpoint}</div>
                <div className="meta">{r.timestamp} · trace <span className="mono">{r.traceId}</span></div>
              </div>
              <div className="dur">{r.latencyMs} ms</div>
            </button>
          ))}
        </div>
        <div className="slowreq-preview">
          {row ? (
            <>
              <div className="slowreq-preview-head">
                <span className="slowreq-preview-ep">{row.endpoint}</span>
                <button
                  type="button"
                  className="slowreq-trace-link"
                  onClick={() => onOpenTrace?.(row.traceId)}
                  title={`Open trace ${row.traceId} in trace details`}
                >
                  Trace ID · <span className="mono">{row.traceId}</span>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M14 4h6v6M20 4l-8 8M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5" />
                  </svg>
                </button>
              </div>
              {trace ? (
                <div className="slowreq-waterfall">
                  <Waterfall
                    trace={trace}
                    selected={span}
                    onSelect={setSpan}
                    collapsed={collapsed}
                    onToggle={toggle}
                  />
                </div>
              ) : (
                <div className="drill2-empty">No spans recorded for this trace.</div>
              )}
            </>
          ) : (
            <div className="slowreq-empty">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 12h4l3-9 4 18 3-9h4" />
              </svg>
              <span>Select a request to view its trace</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

const withoutSegA11y = h => h.replace(/(<div class="seg(?: active)?") role="button" tabindex="0" aria-pressed="(?:true|false)"/g, '$1')
const order = h => [...h.matchAll(/<div class="ep">([^<]*)<\/div><div class="meta">[^]*?<span class="mono">([^<]*)<\/span>/g)].map(m => m[2])
const activeSort = h => /<div class="seg active"[^>]*>([^<]*)<\/div>/.exec(h)?.[1]

test('the sorts on offer are the original three, in order', () => {
  const h = html(<RequestTraceSplit data={[]} />)
  const offered = [...h.matchAll(/<div class="seg(?: active)?"[^>]*>([^<]*)<\/div>/g)].map(m => m[1])
  assert.deepEqual(offered, ORIGINAL_SORTS.map(s => s.label))
})

test('on the service page the panel draws exactly what Slow Requests drew, every use, range and sort', () => {
  const wins = [REFERENCE_WINDOW, ...['24h', '7d'].map(value => resolveWindow({ kind: 'preset', value }))]
  let rows = 0
  for (const win of wins) {
    const uses = [
      { data: slowRequestsForWindow(win) },
      { data: errorRequestsForWindow(win), title: 'Requests with Errors', initialSort: 'none' },
    ]
    for (const use of uses) {
      for (const { id } of ORIGINAL_SORTS) {
        const props = { ...use, initialSort: id, onOpenTrace: noop }
        const before = html(<SlowRequests {...props} />)
        assert.equal(withoutSegA11y(html(<RequestTraceSplit {...props} />)), before, `${win.label} ${props.title ?? 'Slow Requests'} ${id}`)
        rows += order(before).length
      }
      // And with no initial sort given, the default is the same one.
      const { initialSort: _ignored, ...bare } = use
      assert.equal(withoutSegA11y(html(<RequestTraceSplit {...bare} />)), html(<SlowRequests {...bare} />))
    }
  }
  assert.ok(rows > 20, 'compared real rows')
})

test('the sort toggle is reachable from the keyboard and says which sort is on', () => {
  const h = html(<RequestTraceSplit data={[]} initialSort="time" />)
  assert.match(h, /<div class="seg active" role="button" tabindex="0" aria-pressed="true">Time<\/div>/)
  assert.match(h, /<div class="seg" role="button" tabindex="0" aria-pressed="false">Latency<\/div>/)
})

/* ── What the Browser page asks of it ── */

const MIN = 60_000
const T0 = Date.UTC(2026, 9, 5, 5, 0)
// Browser rows carry the instant they ran. Their text label alone would sort
// "4h ago" before "24m ago".
const BROWSER_ROWS = [
  { traceId: 'a1', endpoint: '/checkout', method: null, latencyMs: 2410, timeMs: T0 - 4 * 60 * MIN, timestamp: '4h ago' },
  { traceId: 'b2', endpoint: 'POST payment.cubedemo.com:443/v1/payments', method: 'POST', latencyMs: 880, timeMs: T0 - 24 * MIN, timestamp: '24m ago' },
  { traceId: 'c3', endpoint: '/account/:userId/wishlist', method: null, latencyMs: 1320, timeMs: T0 - 2 * MIN, timestamp: '2m ago' },
  { traceId: 'd4', endpoint: 'GET search.cubedemo.com:443/v1/search/wealth', method: 'GET', latencyMs: 199, timeMs: T0 - 90 * MIN, timestamp: '1h ago' },
]

test('sorted by time, rows that carry their instant run newest first', () => {
  assert.deepEqual(order(html(<RequestTraceSplit data={BROWSER_ROWS} initialSort="time" />)), ['c3', 'b2', 'd4', 'a1'])
  // One row without an instant and the whole list keeps the old reading,
  // rather than mixing two orders in one sort: the leading number of each
  // label, unit and all ignored — 1h, 2m, 4h, 24m. (The service page's rows,
  // which have no instant, still sort this way.)
  const mixed = BROWSER_ROWS.map((r, i) => (i === 0 ? { ...r, timeMs: undefined } : r))
  assert.deepEqual(order(html(<RequestTraceSplit data={mixed} initialSort="time" />)), ['d4', 'c3', 'a1', 'b2'])
})

test('a sort the caller keeps wins over the initial one, and None keeps the data\'s order', () => {
  const h = html(<RequestTraceSplit data={BROWSER_ROWS} initialSort="latency" sortBy="none" onSortBy={noop} />)
  assert.equal(activeSort(h), 'None')
  assert.deepEqual(order(h), ['a1', 'b2', 'c3', 'd4'])
})

test('a limit is cut after sorting, so it keeps the slowest (or newest), not the first few', () => {
  assert.deepEqual(order(html(<RequestTraceSplit data={BROWSER_ROWS} sortBy="latency" limit={2} />)), ['a1', 'c3'])
  assert.deepEqual(order(html(<RequestTraceSplit data={BROWSER_ROWS} sortBy="time" limit={2} />)), ['c3', 'b2'])
})

test('a row\'s second line, its duration and the prompt are the caller\'s to word', () => {
  const h = html(
    <RequestTraceSplit
      data={BROWSER_ROWS.slice(0, 1)}
      rowMeta={r => <span className="probe-meta">{r.method ?? 'Page load'}</span>}
      durationLabel={r => `${(r.latencyMs / 1000).toFixed(2)} s`}
      emptyPreview="Select a request to see its details"
    />,
  )
  assert.match(h, /<div class="meta"><span class="probe-meta">Page load<\/span><\/div><\/div><div class="dur">2\.41 s<\/div>/)
  assert.match(h, /<span>Select a request to see its details<\/span>/)
})

test('a head control sits after the sort and before the card menu', () => {
  const h = html(<RequestTraceSplit data={BROWSER_ROWS} title="Traces" headExtra={<span className="probe-extra">10 results</span>} />)
  const seg = h.indexOf('class="seg-toggle"')
  const extra = h.indexOf('class="probe-extra"')
  const menu = h.indexOf('class="card-menu-btn')
  assert.ok(seg >= 0 && seg < extra && extra < menu, `${seg} < ${extra} < ${menu}`)
  assert.match(h, /<div class="panel-head-left">Traces<\/div>/)
})

test('an empty list shows the caller\'s empty state in place of the split; without one, the split as before', () => {
  const empty = <div className="probe-empty">No traces match these filters</div>
  const h = html(<RequestTraceSplit data={[]} emptyList={empty} />)
  assert.match(h, /<div class="probe-empty">No traces match these filters<\/div>/)
  assert.doesNotMatch(h, /slowreq-split/)
  // Rows to show: the empty state stays out of the way.
  assert.doesNotMatch(html(<RequestTraceSplit data={BROWSER_ROWS} emptyList={empty} />), /probe-empty/)
  assert.match(html(<RequestTraceSplit data={[]} />), /<div class="slowreq-list"><\/div>/)
})

/* ── The error summary ── */

const failed = (n = 1) => ({
  errors: Array.from({ length: n }, (_, i) => ({
    id: `s${i}`,
    exception: { type: i ? 'NetworkError' : 'TypeError', message: "Cannot read properties of undefined (reading 'clientSecret')", stack: '' },
  })),
})

test('a failed trace\'s preview names what it threw, as the way into the stack', () => {
  const h = html(<TraceErrorSummary trace={failed()} onOpenException={noop} />)
  assert.match(h, /^<div class="rts-errsum" role="group" aria-label="Error summary">/)
  assert.match(h, /<button type="button" class="err-exc-cls" title="Show the stack trace for TypeError">TypeError<\/button>/)
  assert.match(h, /<span class="rts-errsum-msg">Cannot read properties of undefined \(reading &#x27;clientSecret&#x27;\)<\/span>/)
  assert.doesNotMatch(h, /errors in this trace/)
  // The first failure is named; the rest are counted.
  const two = html(<TraceErrorSummary trace={failed(2)} onOpenException={noop} />)
  assert.match(two, /<span class="rts-errsum-more">2 errors in this trace<\/span>/)
  assert.match(two, />TypeError<\/button>/)
})

test('no summary for a trace that did not fail, or for a caller that cannot open the stack', () => {
  assert.equal(html(<TraceErrorSummary trace={{ errors: [] }} onOpenException={noop} />), '')
  assert.equal(html(<TraceErrorSummary trace={null} onOpenException={noop} />), '')
  assert.equal(html(<TraceErrorSummary trace={failed()} />), '')
})

test('a caller can open the split on a picked request, and keep its preview in view', () => {
  const data = slowRequestsForWindow(REFERENCE_WINDOW)
  const id = data[1].traceId
  const h = html(<RequestTraceSplit data={data} initialSort="none" initialSelected={id} stickyPreview />)
  assert.match(h, /^<div class="panel rts-sticky">/)
  assert.ok(h.includes(`class="slowreq-row selected"`), 'the restored pick is shown as picked')
  assert.ok(h.includes(`Trace ID · <span class="mono">${id}</span>`), 'and previewed')
  // A pick the list no longer holds is dropped, as any pick is.
  const gone = html(<RequestTraceSplit data={data} initialSelected="no-such-trace" />)
  assert.doesNotMatch(gone, /slowreq-row selected/)
  assert.match(gone, /Select a request to view its trace/)
})
