import { useCallback, useId, useMemo, useRef, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import RequestTraceSplit from '@/components/trace/RequestTraceSplit'
import FilterSelect from '@/components/shared/FilterSelect'
import { LatencyHistogram, LatencyHeatmap } from '@/components/trace/LatencyCharts'
import { LIMIT_OPTIONS, resultsLabel } from '@/components/trace/requestLimits'
import {
  NO_SELECTION, hasSelection, selectionScope, selectionLabel, tracesFilters, tracesRange, axisRange,
  histogramCounts, columnsOf, timeOfColumns, emptyListText,
} from '@/components/trace/slowRequests'
import { endpointModel, latencyGrid, slowThresholdNs, requestSample } from '@/data/requestLatency'
import { fmtLatency } from '@/utils/latencyBuckets'
import './slow-requests.css'

// Production's Slow Requests opens on five.
const DEFAULT_LIMIT = 5

// What the panel shows above its list: a chart, or none — the list alone.
const VIEWS = [
  { id: 'histogram', label: 'Histogram' },
  { id: 'heatmap', label: 'Heatmap' },
  { id: 'none', label: 'None' },
]

const rowMeta = r => <>{r.timestamp} · trace <span className="mono">{r.traceId.slice(0, 8)}</span></>
const durationLabel = r => fmtLatency(r.latencyMs)

/**
 * The service page's Slow Requests on the Detail tab: one endpoint's requests
 * as a latency histogram or a latency-by-time heatmap, and under it the list
 * the chart filters — drag across the chart to list only the requests in that
 * latency (and, on the heatmap, that time). Production's panel, built from this
 * repo's pieces: the request/trace split (RequestTraceSplit, its chart in the
 * `above` slot), its Sort by, the Browser tab's "N results" counts in the
 * platform's filter dropdown (FilterSelect), the seg-toggle, tooltip and
 * brush. "Show preview" picks the chart, or None to hide it and leave the
 * list (and a selection's line, while one is in force).
 *
 * With nothing selected the list is the window's slowest tenth of requests,
 * under production's hint ("Drag on the chart to filter by latency"); a
 * selection replaces the hint with "Latency:
 * … , Time: …", Clear, and View in Traces, which opens the Traces page on the
 * endpoint's server spans in the same latency band (duration >= lo, < hi) and,
 * for a time selection, on that time. The decisions, and every difference from
 * production, are in docs/decisions/slow-requests-latency.md.
 *
 *   serviceId, endpoint   whose requests (the page's service: the requests,
 *                         their traces and the Traces link all carry it)
 *   fallback              { rpm, p90 } for an endpoint the RED table does not
 *                         list — the figures the page shows for it
 *   win                   the page's window
 *   onOpenTrace(id), onOpenLink(link), setTimeRange(range)
 *   initialView, initialSelection, initialLimit
 *                         where the panel starts (for tests, and for a caller
 *                         that restores it); the view is 'histogram',
 *                         'heatmap' or 'none'
 *
 * The selection belongs to this endpoint on this service: another endpoint or
 * service starts clear, keeping the view, the count and the sort. A new window
 * keeps the latency half (it still means something) and drops the time half.
 */
export default function SlowRequestsPanel({
  serviceId, endpoint, fallback, win, onOpenTrace, onOpenLink, setTimeRange,
  initialView = 'histogram', initialSelection = NO_SELECTION, initialLimit = DEFAULT_LIMIT,
}) {
  const model = useMemo(() => endpointModel(serviceId, endpoint, fallback), [serviceId, endpoint, fallback])
  const [view, setView] = useState(initialView)
  const [limit, setLimit] = useState(initialLimit)
  const winKey = `${win.start}-${win.end}`
  const [stored, setStored] = useState(() => ({ key: model?.key, win: winKey, sel: initialSelection }))
  const sel = !model || stored.key !== model.key ? NO_SELECTION
    : stored.win !== winKey ? { lat: stored.sel.lat, time: null }
      : stored.sel
  // What this render shows is what is kept: a selection left behind on another
  // endpoint, or a time half dropped by a new window, is gone for good rather
  // than back when the reader returns (React's state-from-props adjustment,
  // made during render so no frame shows the old one).
  if (model && (stored.key !== model.key || stored.win !== winKey)) {
    setStored({ key: model.key, win: winKey, sel })
  }
  const setSel = useCallback(next => setStored({ key: model?.key, win: winKey, sel: next }), [model, winKey])

  const grid = useMemo(() => (model ? latencyGrid(model, win) : null), [model, win])
  const slowNs = useMemo(() => (model ? slowThresholdNs(model, win) : null), [model, win])
  // Now, as the window counts it: the list and the Traces link both stop here.
  const nowMs = win.nowSec * 1000
  const scope = selectionScope(sel, slowNs, nowMs)
  const rows = useMemo(
    () => (model && grid?.total ? requestSample(model, win, scope, limit) : []),
    // The scope is rebuilt every render; its four numbers are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [model, grid, win, scope.loNs, scope.hiNs, scope.fromMs, scope.toMs, limit],
  )

  // What a screen reader hears: the selection as it is made and cleared, and
  // the cell or bar the keyboard is on.
  const [announce, setAnnounce] = useState('')
  const plotRef = useRef(null)
  const viewsRef = useRef(null)
  const uid = useId().replace(/[^A-Za-z0-9_-]/g, '')
  const previewLabelId = `srq-${uid}-preview`
  const showChart = view !== 'none'

  const axis = grid ? axisRange(grid, sel) : null
  const counts = useMemo(() => (axis ? histogramCounts(grid, axis, sel.time) : []), [grid, axis?.[0], axis?.[1], sel.time]) // eslint-disable-line react-hooks/exhaustive-deps

  const selectLatency = useCallback(lat => {
    const next = { lat, time: sel.time }
    setSel(next)
    setAnnounce(`${selectionLabel(next)}. The list shows requests in this range.`)
  }, [sel.time, setSel])
  const selectCells = useCallback(({ lat, cols }) => {
    const next = { lat, time: timeOfColumns(win, cols[0], cols[1]) }
    setSel(next)
    setAnnounce(`${selectionLabel(next)}. The list shows requests in this range.`)
  }, [win, setSel])
  const clear = useCallback(() => {
    setSel(NO_SELECTION)
    setAnnounce('Selection cleared. The list shows the slowest requests.')
    // Clear is gone once there is nothing to clear: focus goes to the chart it
    // cleared — or, with the preview hidden, to the preview choice — not to
    // the top of the document.
    requestAnimationFrame(() => (plotRef.current ?? viewsRef.current?.querySelector('[aria-checked="true"]'))?.focus())
  }, [setSel])

  const viewInTraces = () => {
    const range = tracesRange(sel, nowMs)
    if (range) setTimeRange?.(range)
    onOpenLink?.({ view: 'traces', filters: tracesFilters({ serviceId, endpoint, scope }) })
  }

  const label = selectionLabel(sel)
  const total = grid?.total ?? 0
  const chartLabel = `${view === 'histogram' ? 'Latency histogram' : 'Latency heatmap'} of ${endpoint}, ${total.toLocaleString()} requests. Arrow keys move, Shift and an arrow selects, Enter lists the selection, Escape clears it.`

  // A radio group, roving focus: the arrows (and Home, End) move the choice.
  const onViewKey = e => {
    const i = VIEWS.findIndex(v => v.id === view)
    const n = VIEWS.length
    const j = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? (i + 1) % n
      : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? (i + n - 1) % n
        : e.key === 'Home' ? 0
          : e.key === 'End' ? n - 1
            : null
    if (j == null) return
    e.preventDefault()
    setView(VIEWS[j].id)
    e.currentTarget.parentElement?.querySelector(`[data-view="${VIEWS[j].id}"]`)?.focus()
  }

  // "Show preview" Histogram | Heatmap | None, in the panel's head, labelled
  // the way Sort by is; Sort by and "N results" sit on a bar at the top of the
  // list they order and count (controlsAt="list").
  const viewSwitch = (
    <>
      <span className="sort-lbl" id={previewLabelId}>Show preview</span>
      <div className="seg-toggle srq-views" role="radiogroup" aria-labelledby={previewLabelId} ref={viewsRef}>
        {VIEWS.map(v => (
          <button
            key={v.id}
            type="button"
            role="radio"
            data-view={v.id}
            aria-checked={view === v.id}
            tabIndex={view === v.id ? 0 : -1}
            className={`seg${view === v.id ? ' active' : ''}`}
            onClick={() => setView(v.id)}
            onKeyDown={onViewKey}
          >
            {v.label}
          </button>
        ))}
      </div>
    </>
  )

  // With the preview hidden, a selection made on it still filters the list,
  // so its line stays (what it is, Clear, View in Traces) — the list is never
  // narrowed by something the reader cannot see. With nothing selected, nothing
  // shows but the live region.
  const selectionLine = (
    <>
      <span className="srq-sel" title={label}>{label}</span>
      <button type="button" className="split-ep-clear srq-clear" onClick={clear}>Clear</button>
      <button
        type="button"
        className="srq-traces"
        onClick={viewInTraces}
        title="Open these requests on the Traces page"
      >
        View in Traces
        <ChevronRight aria-hidden="true" />
      </button>
    </>
  )

  const above = (
    <div className={`srq${showChart ? '' : hasSelection(sel) ? ' is-bare' : ' is-hidden'}`}>
      {(showChart || hasSelection(sel)) && (
        <div className="srq-sub">
          <div className="srq-sub-right">
            {hasSelection(sel) ? selectionLine : (
              <span className="srq-hint">
                Drag on the chart to filter by latency{view === 'heatmap' ? ' and time' : ''}
              </span>
            )}
          </div>
        </div>
      )}
      {showChart && (
        <div className="srq-chart">
          {!axis ? (
            <div className="srq-nochart">No requests in {win.isAbsolute ? 'this range' : win.label.replace(/^Last /, 'the last ').toLowerCase()}</div>
          ) : view === 'histogram' ? (
            <LatencyHistogram
              axis={axis}
              counts={counts}
              selected={sel.lat}
              onSelect={selectLatency}
              onClear={hasSelection(sel) ? clear : undefined}
              announce={setAnnounce}
              plotRef={plotRef}
              label={chartLabel}
            />
          ) : (
            <LatencyHeatmap
              grid={grid}
              axis={axis}
              win={win}
              selected={{ lat: sel.lat, cols: columnsOf(win, sel.time) }}
              onSelect={selectCells}
              onClear={hasSelection(sel) ? clear : undefined}
              announce={setAnnounce}
              plotRef={plotRef}
              label={chartLabel}
            />
          )}
        </div>
      )}
      <div className="sr-only" role="status" aria-live="polite">{announce}</div>
    </div>
  )

  return (
    <div className="srq-host">
      <RequestTraceSplit
        onOpenTrace={onOpenTrace}
        data={rows}
        initialSort="latency"
        rowMeta={rowMeta}
        durationLabel={durationLabel}
        stickyPreview
        above={above}
        headLead={viewSwitch}
        controlsAt="list"
        headExtra={(
          // The platform's filter dropdown, as the service page's Host and
          // Version filters draw it (.subtab-filters), with the value alone:
          // "5 results" says what it is.
          <div className="subtab-filters srq-limit">
            <FilterSelect
              label="Show"
              hideLabel
              value={resultsLabel(limit)}
              options={LIMIT_OPTIONS}
              onSelect={v => setLimit(Number.parseInt(v, 10) || DEFAULT_LIMIT)}
            />
          </div>
        )}
        emptyList={(
          <div className="srq-empty">
            <span>{emptyListText(sel, win)}</span>
            {hasSelection(sel) && <button type="button" className="split-ep-clear" onClick={clear}>Clear selection</button>}
          </div>
        )}
      />
    </div>
  )
}
