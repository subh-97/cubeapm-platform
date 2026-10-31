// The Traces drawer's Waterfall tab: the span's own trace, drawn as the Slow
// Requests preview draws one, with the span opened selected and on screen, an
// error summary for a failed trace, and the trace page a link away. Static renders, so a state is reached through the
// record handed in, as the drawer hands it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server.browser'
import { createElement } from 'react'
import SpanTraceTab from './SpanTraceTab'
import { TracePreview } from './RequestTraceSplit'
import { LogRecordDrawer } from '@/components/LogRecordDrawer'
import { resolveWindow } from '@/data/timeWindow'
import { traceInRows } from '@/data/traceDetail'
import { resolveTrace } from '@/data/traceResolvers'
import { TRACES_SOURCE, MOBILE_TRACES_SOURCE } from '@/utils/explorerSources'

const noop = () => {}
const win = resolveWindow({ kind: 'preset', value: '1h' })
const rows = TRACES_SOURCE.rowsForWindow(win)
const traceFor = id => traceInRows(id, rows)

const render = (record, extra = {}) => renderToStaticMarkup(createElement(SpanTraceTab, {
  record, traceFor, onOpenTrace: noop, onOpenException: noop, ...extra,
}))

const rowCount = html => (html.match(/class="tw-row(?: [^"]*)?"/g) || []).length
const currentRows = html => [...html.matchAll(/<div[^>]*class="tw-row[^"]*"[^>]*aria-current="true"[^>]*>(.*?)<span class="tw-dur/g)]
  .map(m => m[1].replace(/<[^>]+>/g, ''))

test('the span opened is the one row selected, in its own trace', () => {
  for (const record of rows.filter(r => r.tags['event.domain'] === 'span').slice(0, 40)) {
    const html = render(record)
    const current = currentRows(html)
    assert.equal(current.length, 1, `${record.id}: one selected row`)
    assert.ok(current[0].includes(record.spanName), `${record.id}: the selected row is ${record.spanName}`)
  }
})

test('the head counts what the trace holds, beside the link to trace details', () => {
  const record = rows.find(r => r.tags['event.domain'] === 'span')
  const t = traceFor(record.traceId)
  const html = render(record)
  assert.match(html, /class="slowreq-trace-link"[^>]*title="Open trace [0-9a-f]+ in trace details"/)
  assert.match(html, />View trace details</)
  const head = html.match(/<span class="slowreq-preview-ep">(.*?)<\/span><button/)[1].replace(/<[^>]+>/g, '')
  assert.match(head, new RegExp(`^[0-9.]+ m?s · ${t.spans.length} spans · ${t.services.length} services?$`))
  // The request is the waterfall's first row, so the head does not name it again.
  assert.ok(!head.includes(t.root.name))
  assert.ok(html.indexOf(`<span class="tw-svc">${t.root.service}</span>`) > html.indexOf('slowreq-waterfall'))
  // Nothing between the head and what follows it.
  assert.match(html, /<\/button><\/div><div class="slowreq-waterfall is-fill">/)
  // The drawer scrolls; the waterfall is not capped inside it.
  assert.match(html, /class="slowreq-waterfall is-fill"/)
})

test('the link opens the trace the span ran in, through the page\'s opener', () => {
  const record = rows.find(r => r.tags['event.domain'] === 'span' && r.traceId)
  const html = render(record)
  assert.ok(html.includes(`title="Open trace ${record.traceId} in trace details"`))
  // TracePreview is the tab's head, and has no state: press its link directly.
  let opened = null
  const el = TracePreview({ heading: 'x', traceId: record.traceId, onOpenTrace: id => { opened = id }, trace: null, linkLabel: 'View trace details' })
  const head = [].concat(el.props.children)[0]
  head.props.children[1].props.onClick()
  assert.equal(opened, record.traceId)
})

test('a failed trace says what it threw above the waterfall; a clean one does not', () => {
  const failed = rows.find(r => r.statusCode === 'ERROR' && r.tags['exception.type'])
  const html = render(failed)
  assert.match(html, /aria-label="Error summary"/)
  assert.ok(html.indexOf('Error summary') < html.indexOf('slowreq-waterfall'))
  assert.ok(html.includes(failed.tags['exception.type']))
  const cleanTrace = [...new Set(rows.map(r => r.traceId))].find(id => !traceFor(id).failed)
  assert.doesNotMatch(render(rows.find(r => r.traceId === cleanTrace)), /Error summary/)
})

test('a span deep in a large trace is unfolded into view, while the rest stays folded', () => {
  const wide = rows.find(r => r.durationNs > 1.5e9)
  const t = traceFor(wide.traceId)
  assert.ok(t.spans.length > 40)
  const deep = rows.find(r => r.traceId === wide.traceId && t.byId[r.spanId]?.depth >= 3)
  const html = render(deep)
  const shown = rowCount(html)
  assert.ok(shown < t.spans.length, 'the large trace opens folded')
  // The 1.85 s fan-out is the slowest request on screen, and still only the
  // failed get a callout above the waterfall.
  assert.doesNotMatch(html, /Slow request|rts-errsum/)
  assert.equal(currentRows(html).length, 1, 'the deep span is on screen and selected')
})

test('a record with no trace says so, rather than drawing a waterfall', () => {
  const event = MOBILE_TRACES_SOURCE.rowsForWindow(win).find(r => !r.traceId && !r.tags?.trace_id)
  const html = render(event, { traceFor: id => resolveTrace(id, 'mobile') })
  assert.match(html, /carries no <span class="mono">trace_id<\/span>/)
  assert.doesNotMatch(html, /tw-row|slowreq-trace-link/)
})

test('a device\'s request is its trace: one span, its own, and a failed one says how', () => {
  const mobile = MOBILE_TRACES_SOURCE.rowsForWindow(win)
  const mobileFor = id => resolveTrace(id, 'mobile')
  const req = mobile.find(r => r.traceId)
  const html = render(req, { traceFor: mobileFor })
  assert.equal(rowCount(html), 1)
  assert.equal(currentRows(html).length, 1)
  const failed = mobile.find(r => r.traceId && mobileFor(r.traceId)?.errors?.length)
  assert.match(render(failed, { traceFor: mobileFor }), /aria-label="Error summary"/)
})

test('in the drawer: a Waterfall tab after JSON, and the drawer held at a fixed width', () => {
  const record = rows.find(r => r.tags['event.domain'] === 'span')
  const tabs = [{ id: 'waterfall', label: 'Waterfall', render: rec => createElement(SpanTraceTab, { record: rec, traceFor, onOpenTrace: noop, onOpenException: noop }) }]
  const html = renderToStaticMarkup(createElement(LogRecordDrawer, {
    record, onClose: noop, searchTerms: [], onAddChip: noop, onCopy: noop, onNavigate: noop, onTogglePin: noop,
    badge: TRACES_SOURCE.badgeFor(record), traceList: 'Traces', tabs, className: 'trace-drawer', initialView: 'waterfall',
  }))
  assert.match(html, /<aside class="log-detail trace-drawer">/)
  const strip = [...html.matchAll(/role="tab" aria-selected="(true|false)"[^>]*>([^<]+)</g)].map(m => `${m[2]}${m[1] === 'true' ? '*' : ''}`)
  assert.deepEqual(strip, ['Overview', 'JSON', 'Waterfall*'])
  assert.equal(currentRows(html).length, 1)
})
