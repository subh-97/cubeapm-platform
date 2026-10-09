import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FilterX } from 'lucide-react'
import RequestTraceSplit from '@/components/trace/RequestTraceSplit'
import TitleDropdown from '@/components/shared/TitleDropdown'
import SpanExceptionModal from '@/components/errors/SpanExceptionModal'
import BrowserExceptionModal from '@/components/browser/BrowserExceptionModal'
import { fmtLoadTime } from '@/components/charts/chartDefaults'
import { browserTracesForWindow, browserExceptionFor } from '@/data/browser'
import { buildTrace } from '@/data/traceDetail'
import { BROWSER_KINDS } from '@/utils/browserUrl'
import { formatLocal } from '@/utils/timeRange'
// For the empty list, which is the Errors page's "your filters emptied this"
// state (.errp-empty and its filter chips) rather than a second look for the
// same thing. Every rule in it is errp-scoped.
import '@/components/errors/errors.css'
import './browser-traces.css'

// Production's "N results" choices, and its default. The list is that many
// requests sampled across the range, newest first (browserTracesForWindow:
// spread through the window, an error's samples where its counts are), and the
// Sort by toggle orders those — so "Latency" is the slowest of the ten, a
// sample of the range rather than its slowest ten.
const LIMITS = [5, 10, 20, 50, 100]
const DEFAULT_LIMIT = 10
const resultsLabel = n => `${n} results`
const LIMIT_OPTIONS = LIMITS.map(resultsLabel)

const KIND_LABEL = Object.fromEntries(BROWSER_KINDS.map(k => [k.id, k.label]))
const KIND_NOUN = { server: 'page loads', client: 'Ajax calls' }

// A row's second line: what kind of request it was, then when. The name line
// above already starts with a call's method ('GET search.…'), so a call says
// what it was answered with instead; a page load has neither, and says so in
// words rather than leaving a gap.
const rowMetaWith = stamp => r => (r.httpStatus ? `HTTP ${r.httpStatus} · ${stamp(r)}` : `Page load · ${stamp(r)}`)
// A page load runs to seconds, a call to milliseconds: the page's own load
// time format, so a row reads like the Page Views tab's figures.
const durationLabel = r => fmtLoadTime(r.latencyMs)
// When two rows would print the same minute — a short range, or a hundred
// rows of one — every row says its second too, so the list can be told apart
// and sorted by time visibly.
const MINUTE = r => r.timestamp
const SECOND = r => formatLocal(r.timeMs, 'MMM DD, HH:mm:ss')

/**
 * How this tab reads a trace for its preview: buildTrace's, with one change
 * to what the error summary above the waterfall says.
 *
 * A failed Ajax call's trace holds no browser exception — a 503 is a status
 * code — but the call landed on one of our services, and that service's span
 * under it threw: payment-service's pool exception behind the storefront's
 * failed payment. That is the most useful thing the preview can say, because
 * it is where the browser's error comes from, so the summary keeps naming it.
 * But the summary only prints a class and a message, and a Java class under
 * a browser request needs saying whose it is — so for a span of another
 * service the message is prefixed with that service and span, the way the
 * stack modal's subtitle names them. The waterfall reads `spans`, which are
 * untouched; the modal looks the span up again by id, so it shows the
 * message as thrown.
 */
function readTrace(traceId, appId) {
  const trace = buildTrace(traceId)
  if (!trace || trace.errors.every(s => s.service === appId)) return trace
  return {
    ...trace,
    errors: trace.errors.map(s => {
      if (s.service === appId) return s
      const where = `${s.service} · ${s.name}`
      return { ...s, exception: { ...s.exception, message: s.exception.message ? `${where} — ${s.exception.message}` : where } }
    }),
  }
}

// Production's empty list is a bare "No results". This says which filters
// emptied it and over what range, and — when any is set — offers to clear
// them (Type stays: it is which list this is, not a narrowing of it).
function EmptyTraces({ kind, endpoint, error, win, onClearFilters }) {
  const filtered = Boolean(endpoint || error)
  const noun = KIND_NOUN[kind]
  const chips = [
    ['type', KIND_LABEL[kind]],
    endpoint && ['endpoint', endpoint],
    error && ['error', error],
    ['range', win?.label ?? ''],
  ].filter(Boolean)
  return (
    <div className="errp-empty" role="status">
      <FilterX strokeWidth={1.5} aria-hidden="true" />
      <div className="errp-empty-title">
        {filtered ? 'No traces match these filters' : `No ${noun} were recorded in this range`}
      </div>
      <ul className="errp-empty-list" aria-label="Active filters">
        {chips.map(([field, value]) => (
          <li key={field} className="errp-empty-filter" title={`${field} = ${value}`}>
            <span>{field}</span>
            <span className="v">{value}</span>
          </li>
        ))}
      </ul>
      <div className="errp-empty-sub">
        {filtered
          ? `Nothing in ${win?.label ?? 'this range'} matches all of them. Widen the time range, or clear the filters to list all ${noun}.`
          : 'Pick a wider or an earlier time range.'}
      </div>
      {filtered && onClearFilters && (
        <div className="errp-empty-actions">
          <button type="button" className="search-empty-clear" onClick={onClearFilters}>Clear filters</button>
        </div>
      )}
    </div>
  )
}

/**
 * The Browser page's Traces tab: production's request list and preview, as
 * the APM service page's Slow Requests split (RequestTraceSplit).
 *
 * The filters are the page's (URL `kind`, `endpoint`, `error`; the strip and
 * the selects above this panel set them, and an Errors-tab row arrives with
 * all three). This tab owns only how many to list, which production keeps out
 * of the URL too.
 *
 * Picking a request previews its trace: the id as the way to the full trace
 * page (production's "More Info"), what it threw, and its waterfall — a page
 * load's span, or a call's with the backend span it reached under it, so a
 * failed Ajax call shows the APM service that failed it. The exception opens
 * its stack: a browser script error in the source-map-aware modal, a backend
 * exception in the trace page's own stack modal.
 *
 * Going to the trace page and back keeps the reader's place: `onOpenTrace(id,
 * place)` hands the page the count and the picked request, and `place` comes
 * back on the return as the tab's starting point.
 */
export default function BrowserTracesTab({
  app, win, kind, endpoint, error, onOpenTrace, onClearFilters, sourceMaps, onOpenSourceMaps, place,
}) {
  const appId = app.id
  const [limit, setLimit] = useState(() => (LIMITS.includes(place?.limit) ? place.limit : DEFAULT_LIMIT))

  const data = useMemo(
    () => browserTracesForWindow(win, appId, { kind, endpoint: endpoint || null, error: error || null, limit }),
    [win, appId, kind, endpoint, error, limit],
  )
  const rowMeta = useMemo(() => {
    const sameMinute = new Set(data.map(r => r.timestamp)).size < data.length
    return rowMetaWith(sameMinute ? SECOND : MINUTE)
  }, [data])

  // Stable for an app: RequestTraceSplit rebuilds the previewed trace whenever
  // this function changes, and a new one per render would rebuild it on every
  // hover that re-renders the page.
  const resolveTrace = useCallback(id => readTrace(id, appId), [appId])

  // What the stack modal shows: a browser exception by its trace id (the
  // modal reads the exception, page and source map off it), or a backend span
  // as the trace page shows one.
  const [modal, setModal] = useState(null)
  // RequestTraceSplit hands back the summary's span — this tab's reworded copy
  // for a backend span (see readTrace) — and the trace it came from, whose
  // `byId` holds the span as built.
  const openException = useCallback((span, trace) => {
    const built = trace?.byId?.[span.id] ?? span
    if (built.service === appId && browserExceptionFor(trace.traceId)) setModal({ traceId: trace.traceId })
    else setModal({ span: built })
  }, [appId])
  const closeModal = useCallback(() => setModal(null), [])

  const openTrace = useCallback(id => onOpenTrace?.(id, { limit, selected: id }), [onOpenTrace, limit])

  // Clear filters sits in the empty state, which the cleared list replaces —
  // taking the focused button with it. Focus goes to the first request of the
  // list that has come back, rather than to the top of the document.
  const rootRef = useRef(null)
  const refocus = useRef(false)
  const clearFilters = useCallback(() => {
    refocus.current = true
    onClearFilters?.()
  }, [onClearFilters])
  // Back from the trace page, the request that was open may be the eightieth
  // of a hundred: the list is brought to it, as it was left.
  useEffect(() => {
    if (place?.selected) rootRef.current?.querySelector('.slowreq-row.selected')?.scrollIntoView({ block: 'center' })
    // Once, on the way back in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    if (!refocus.current) return
    refocus.current = false
    if (document.activeElement && document.activeElement !== document.body) return
    rootRef.current?.querySelector('.slowreq-row')?.focus()
  }, [data])

  const limitControl = (
    <TitleDropdown
      value={resultsLabel(limit)}
      options={LIMIT_OPTIONS}
      onChange={v => setLimit(Number.parseInt(v, 10) || DEFAULT_LIMIT)}
      className="brw-limit"
      ariaLabel={`${resultsLabel(limit)}: how many requests to list`}
    />
  )

  const backend = modal?.span ?? null

  return (
    <>
      {/* The wrapper gives browser-traces.css a place to say where the
          sticky preview stops (under the Endpoint strip), and Clear filters
          a list to put focus back into. The modals stay outside it: a
          refresh dims the tab's panels (browser.css), never an open modal. */}
      <div ref={rootRef} className="brw-traces">
        <RequestTraceSplit
          title="Traces"
          data={data}
          initialSort="none"
          // Back from the trace page, the request that was open is open again
          // (RequestTraceSplit drops it if it is no longer listed).
          initialSelected={place?.selected ?? null}
          stickyPreview
          headExtra={limitControl}
          resolveTrace={resolveTrace}
          onOpenTrace={openTrace}
          onOpenException={openException}
          rowMeta={rowMeta}
          durationLabel={durationLabel}
          emptyPreview="Select a request to see its details"
          emptyList={(
            <EmptyTraces kind={kind} endpoint={endpoint} error={error} win={win} onClearFilters={onClearFilters ? clearFilters : undefined} />
          )}
        />
      </div>
      {/* At the tab's root: neither modal is portalled, and inside the split
          a click in one would reach the list and preview under it. */}
      {modal?.traceId && (
        <BrowserExceptionModal
          traceId={modal.traceId}
          sourceMaps={sourceMaps}
          onClose={closeModal}
          onOpenSourceMaps={onOpenSourceMaps}
        />
      )}
      {backend && <SpanExceptionModal span={backend} onClose={closeModal} />}
    </>
  )
}
