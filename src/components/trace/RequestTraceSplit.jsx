import { useState, useMemo, useCallback } from 'react'
import CardMenu from '@/components/CardMenu'
import Waterfall from '@/components/trace/Waterfall'
import { buildTrace } from '@/data/traceDetail'
import './request-trace-split.css'

// The sorts the toggle offers, in its order. A caller that keeps the sort
// itself (sortBy / onSortBy) uses these ids.
const SLOWREQ_SORTS = [
  { id: 'latency', label: 'Latency' },
  { id: 'time', label: 'Time' },
  { id: 'none', label: 'None' },
]

// Newest first by the instant each request ran, when every row carries one.
// The service page's rows only say "9m ago" / "4h ago"; for those the old
// reading stays, which compares the leading number and ignores the unit — so
// past an hour it is out of order, and why a row that can carry `timeMs`
// should.
function sortRows(data, sortBy) {
  if (sortBy === 'none') return data
  const list = [...data]
  if (sortBy === 'latency') list.sort((a, b) => b.latencyMs - a.latencyMs)
  else if (list.every(r => Number.isFinite(r.timeMs))) list.sort((a, b) => b.timeMs - a.timeMs)
  else list.sort((a, b) => parseInt(a.timestamp, 10) - parseInt(b.timestamp, 10))
  return list
}

const defaultMeta = r => <>{r.timestamp} · trace <span className="mono">{r.traceId}</span></>
const defaultDuration = r => `${r.latencyMs} ms`
// A trace nothing has been folded on yet. Shared, so never changed in place:
// a fold makes that trace a set of its own.
const NO_FOLDS = new Set()

/**
 * What a failed trace threw, said above its waterfall: the exception class as
 * the way into its stack trace, and the message read in full. Only drawn for a
 * caller that can open the stack (`onOpenException(span, trace)`); without one
 * the preview is the waterfall alone, as on the service page.
 *
 * It names the trace's first failure in tree order — the root-most throw, the
 * one that ended the request — and says how many more there are.
 */
export function TraceErrorSummary({ trace, onOpenException }) {
  const failure = trace?.errors?.[0]
  if (!failure || !onOpenException) return null
  return (
    <div className="rts-errsum" role="group" aria-label="Error summary">
      <div className="rts-errsum-head">
        <span className="rts-errsum-lbl">Error summary</span>
        {trace.errors.length > 1 && (
          <span className="rts-errsum-more">{trace.errors.length} errors in this trace</span>
        )}
      </div>
      {/* Red because the thing named IS the failure; underlined like the
          error list's class, because it is the same link to the same stack. */}
      <button
        type="button"
        className="err-exc-cls"
        onClick={() => onOpenException(failure, trace)}
        title={`Show the stack trace for ${failure.exception.type}`}
      >
        {failure.exception.type}
      </button>
      {failure.exception.message && (
        <span className="rts-errsum-msg">{failure.exception.message}</span>
      )}
    </div>
  )
}

/**
 * A list of requests beside the trace of the one picked: the list picks the
 * trace, the preview shows it, so they share one panel rather than two cards.
 *
 * The service page's Slow Requests (and Requests with Errors) panel, lifted
 * out so the Browser page's Traces tab is the same panel rather than a copy of
 * it. Called with the service page's props it draws exactly what it did; the
 * rest is for a caller that owns more of it:
 *
 *   sortBy / onSortBy      the sort, when the caller keeps it (in a URL, say)
 *   limit                  how many rows show, cut after sorting
 *   headExtra              a control in the head, before the card menu
 *   resolveTrace(id)       how a trace id becomes a trace (default buildTrace)
 *   onOpenException(span, trace)
 *                          when given, a failed trace's preview opens with an
 *                          error summary — the exception, as a link to its
 *                          stack, and its message — above the waterfall
 *   emptyList              shown in place of the split when no row is left,
 *                          for a caller whose filters can empty it
 *   emptyPreview           the prompt before a row is picked
 *   rowMeta(row), durationLabel(row)
 *                          a row's second line and its duration
 *   initialSelected        the trace id to open on picked, for a caller that
 *                          restores where the reader was (back from the trace
 *                          page); dropped like any pick if it is not listed
 *   stickyPreview          the preview keeps beside the rows in view while a
 *                          long list scrolls under it, rather than staying at
 *                          the top of the split (see request-trace-split.css)
 */
export default function RequestTraceSplit({
  onOpenTrace, data, title = 'Slow Requests', initialSort = 'latency',
  sortBy: sortByProp, onSortBy, limit, headExtra, resolveTrace = buildTrace,
  onOpenException, emptyList, emptyPreview = 'Select a request to view its trace',
  rowMeta = defaultMeta, durationLabel = defaultDuration,
  initialSelected = null, stickyPreview = false,
}) {
  const [ownSort, setOwnSort] = useState(initialSort)
  const sortBy = sortByProp ?? ownSort
  const setSortBy = id => {
    if (sortByProp == null) setOwnSort(id)
    onSortBy?.(id)
  }
  const [selected, setSelected] = useState(initialSelected)
  // The span picked and the spans folded, per trace. Stepping from request A
  // to B and back finds A as it was left: on the service page that is what one
  // shared selection and one shared fold set always did, because no two of its
  // sample traces share a span id. Keyed by trace, it stays true where ids do
  // repeat (a trace borrowed from the seeded set has its lender's ids), and A's
  // choices never pick or fold a span of B's.
  const [spanByTrace, setSpanByTrace] = useState(() => new Map())
  const [foldsByTrace, setFoldsByTrace] = useState(() => new Map())

  const rows = useMemo(() => {
    const sorted = sortRows(data, sortBy)
    return limit != null ? sorted.slice(0, limit) : sorted
  }, [sortBy, data, limit])

  const row = selected ? rows.find(r => r.traceId === selected) ?? null : null
  // A picked request that a filter, a narrower limit or a new range has taken
  // out of the list is dropped, not kept on as a preview of a row no longer
  // there — and not brought back if the row returns later. Set during render
  // (React re-renders straight away, before painting) so the stale preview is
  // never drawn even for a frame.
  if (selected && !row) setSelected(null)

  const traceId = row?.traceId ?? null
  // `resolveTrace` is a dependency: a caller that swaps how ids resolve gets
  // the new reading. Pass a stable function, or the trace rebuilds every render.
  const trace = useMemo(() => (traceId ? resolveTrace(traceId) : null), [traceId, resolveTrace])

  const span = traceId ? spanByTrace.get(traceId) ?? null : null
  const collapsed = traceId ? foldsByTrace.get(traceId) ?? NO_FOLDS : NO_FOLDS
  const pickSpan = useCallback(s => {
    if (traceId) setSpanByTrace(prev => new Map(prev).set(traceId, s))
  }, [traceId])
  const toggle = useCallback(id => {
    if (!traceId) return
    setFoldsByTrace(prev => {
      const next = new Set(prev.get(traceId))
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return new Map(prev).set(traceId, next)
    })
  }, [traceId])

  return (
    <div className={`panel${stickyPreview ? ' rts-sticky' : ''}`}>
      <div className="panel-head is-divided">
        <div className="panel-head-left">{title}</div>
        <div className="panel-head-right">
          <span className="sort-lbl">Sort by</span>
          <div className="seg-toggle">
            {SLOWREQ_SORTS.map(s => (
              // The <div class="seg"> look is kept; role, focus and keys make
              // the sort reachable without a mouse.
              <div
                key={s.id}
                className={`seg${sortBy === s.id ? ' active' : ''}`}
                role="button"
                tabIndex={0}
                aria-pressed={sortBy === s.id}
                onClick={() => setSortBy(s.id)}
                onKeyDown={ev => {
                  if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); setSortBy(s.id) }
                }}
              >
                {s.label}
              </div>
            ))}
          </div>
          {headExtra}
          <CardMenu kind="list" title={title} />
        </div>
      </div>
      {rows.length === 0 && emptyList != null ? emptyList : (
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
                  <div className="meta">{rowMeta(r)}</div>
                </div>
                <div className="dur">{durationLabel(r)}</div>
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
                <TraceErrorSummary trace={trace} onOpenException={onOpenException} />
                {trace ? (
                  <div className="slowreq-waterfall">
                    <Waterfall
                      trace={trace}
                      selected={span}
                      onSelect={pickSpan}
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
                <span>{emptyPreview}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
