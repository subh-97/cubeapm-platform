import { useState, useMemo, useRef, useEffect, useCallback } from 'react'
import { TracePreview } from '@/components/trace/RequestTraceSplit'
import { msLabel } from '@/components/trace/Waterfall'
import { INITIAL, arrive, pick, toggleFold } from '@/components/trace/spanTraceState'
import './span-trace.css'

// A trace nothing has been folded on yet. Shared, so never changed in place.
const NO_FOLDS = new Set()

const idOf = (record, field, tag) => record?.[field] || record?.tags?.[tag] || null
const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`

/**
 * The Waterfall tab of the Traces explorer's record drawer: the trace the
 * span on screen ran in, drawn as the Slow Requests preview draws a request's
 * (TracePreview), so the drawer, the service page and the trace page all show
 * one waterfall. The span opened is the row selected, with its ancestors
 * unfolded so it is on screen; a failed trace says what it threw above the
 * waterfall; and the trace page is a link away.
 *
 *   record              the drawer's record: a span row, or a mobile event
 *   traceFor(id)        the trace for an id, as the page reads it. Pass a
 *                       stable function: the trace is re-read when it changes
 *   onOpenTrace(id)     opens trace details
 *   onOpenException(span, trace)
 *                       opens a failed span's stack. The page draws the modal,
 *                       outside the drawer, so its clicks never reach the
 *                       drawer's handlers
 *
 * The tab stays mounted while Newer and Older step through records, so the
 * folds are kept per trace (RequestTraceSplit's reason: stepping between two
 * spans of one trace finds it as it was left), and a span picked here holds
 * until the record changes. Leaving the tab for Overview or JSON unmounts it:
 * coming back opens on the record's span again, with its trace folded afresh.
 */
export default function SpanTraceTab({ record, traceFor, onOpenTrace, onOpenException }) {
  const traceId = idOf(record, 'traceId', 'trace_id')
  const spanId = idOf(record, 'spanId', 'span_id')
  const trace = useMemo(() => (traceId ? traceFor(traceId) : null), [traceId, traceFor])
  const recordSpan = trace && spanId ? trace.byId[spanId] ?? null : null

  // What the tab keeps as records change (spanTraceState): the pick, and the
  // folds per trace. Moving to a record is applied during render, like
  // RequestTraceSplit's dropped pick, so the span opened is never drawn hidden,
  // or another span selected, even for a frame.
  const [state, setState] = useState(INITIAL)
  const here = arrive(state, trace, spanId, record?.id ?? '')
  if (here !== state) setState(here)
  const collapsed = (trace && here.folds.get(traceId)) || NO_FOLDS
  const selected = here.picked ?? recordSpan
  const onSelect = useCallback(span => setState(s => pick(s, span)), [])
  const onToggle = useCallback(id => setState(s => toggleFold(s, traceId, id)), [traceId])

  // The span opened is scrolled to, within the drawer's body alone — the
  // trace page's scrollIntoView would scroll the explorer behind it too. On
  // screen means below the sticky head, which covers the top of the body.
  const bodyRef = useRef(null)
  const rowRefs = useRef({})
  useEffect(() => {
    const body = bodyRef.current
    const row = spanId ? rowRefs.current[spanId] : null
    if (!body || !row) return
    const b = body.getBoundingClientRect()
    const head = body.querySelector('.slowreq-preview-head')
    const top = head ? Math.max(b.top, head.getBoundingClientRect().bottom) : b.top
    const r = row.getBoundingClientRect()
    if (r.top < top || r.bottom > b.bottom) body.scrollTop += r.top - top - (b.bottom - top - r.height) / 2
  }, [here.at, spanId])

  if (!traceId) {
    return (
      <div className="log-detail-body span-trace-body">
        <div className="slowreq-empty">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 12h4l3-9 4 18 3-9h4" />
          </svg>
          <span>This record carries no <span className="mono">trace_id</span>, so there is no trace to draw.</span>
        </div>
      </div>
    )
  }

  // The head says what the trace holds, beside the way to trace details. The
  // request needs no line of its own there: the waterfall's first row is its
  // root, named. A trace with no spans has only its id to show.
  const heading = trace ? (
    <span className="span-trace-meta">
      <span className="mono">{msLabel(trace.totalMs)}</span>
      {' · '}{plural(trace.spans.length, 'span')}
      {' · '}{plural(trace.services.length, 'service')}
      {spanId && !recordSpan && ' · this span is not among them'}
    </span>
  ) : <span className="mono">{traceId}</span>

  return (
    <div className="log-detail-body span-trace-body" ref={bodyRef}>
      <TracePreview
        heading={heading}
        traceId={traceId}
        onOpenTrace={onOpenTrace}
        linkLabel="View trace details"
        trace={trace}
        onOpenException={onOpenException}
        selected={selected}
        onSelect={onSelect}
        collapsed={collapsed}
        onToggle={onToggle}
        rowRefs={rowRefs}
        fill
      />
    </div>
  )
}
