import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle } from 'lucide-react'
import PageBar from '@/components/layout/PageBar'
import MetricsEditor from '@/components/explore/MetricsEditor'
import LogsEditor from '@/components/explore/LogsEditor'
import ResultsToolbar from '@/components/explore/ResultsToolbar'
import ExploreChart from '@/components/explore/ExploreChart'
import ExploreLegend from '@/components/explore/ExploreLegend'
import ExploreTable from '@/components/explore/ExploreTable'
import useExploreResult from '@/components/explore/useExploreResult'
import {
  applyIncoming, commit, committedQuery, DATASOURCES, draftQuery, initialState,
  isDirty, isMetricsSource, setDatasource, setEditor, setSetting, setTab, tabsFor,
} from '@/utils/explore/editorState'
import { buildChartModel, buildTableRows, SHOW_ALL } from '@/utils/explore/series'
import { queryReduced } from '@/utils/explore/api'
import { COMPARE_OPTIONS, resolveRange, zoomRange } from '@/utils/timeRange'
import '@/components/explore/explore-page.css'

// Explore: pick a datasource, build a query, read the answer.
//
// The page is a shell. Everything with a rule behind it lives somewhere else —
// the query generators in `utils/explore/builders.js`, the legend, colour and
// limiting model in `utils/explore/series.js`, the fetch and its comparison
// window in `useExploreResult`, and the page's own transitions in
// `utils/explore/editorState.js`. What is left here is layout, the handful of
// view-only pieces of state nothing else needs (legend search, selection, the
// 20-series limit), and the wiring between them.
//
// Three decisions are visible in this file and nowhere else:
//
//   · It runs on arrival (ARCH D2, CLAUDE.md rule 5). `initialState()` arrives
//     with a committed query per datasource, so the first paint is a chart.
//     After that, EDITING does not re-run — the run button grows a dot instead
//     — while the time range, refresh, Legend value and Compare do, because
//     those change what the committed query means rather than what it is.
//   · A drag-zoom is the page's own range, not the app's (ARCH D5). It is held
//     here, shown in the time button so the label never lies about what is
//     drawn, and dropped the moment the reader picks a range themselves.
//   · An incoming payload is applied once per nonce (ARCH D13). A second
//     arrival carrying the same card re-applies because its nonce is new.
//
// `onOpenLink` is deliberately absent: ARCH D13's links run INTO Explore, and
// nothing here links back out yet.

const CHART_HEIGHT = 300

// Enough of each half to stay usable at the extremes of the drag: a row or two
// of the query above, and the actions row plus the top of the chart below.
const EDITOR_MIN_PX = 96
const LOWER_MIN_PX = 220

/** Lucide has no outline "run" glyph that matches the Logs page's; this is its. */
function RunIcon({ busy }) {
  if (busy) {
    return (
      <svg className="run-spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <path d="M12 3a9 9 0 1 0 9 9" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polygon points="6 4 20 12 6 20 6 4" />
    </svg>
  )
}

/**
 * @param {Object} props
 * @param {() => void} props.goHome
 * @param {{kind:'preset',value:string}|{kind:'absolute',from:number,to:number}} props.timeRange
 * @param {(range:object) => void} props.setTimeRange
 * @param {(message:string) => void} [props.setToast]
 * @param {{nonce:number, datasource:string, query?:string, model?:object,
 *          unit?:string, formula?:string, legendLabel?:string, stack?:boolean}|null} [props.incoming]
 *   a payload from a card menu or a Logs/Traces page (ARCH D13)
 * @param {() => void} [props.onIncomingApplied]
 */
export default function ExploreView({ goHome, timeRange, setTimeRange, setToast, incoming, onIncomingApplied }) {
  const [page, setPage] = useState(initialState)
  // The range this page is drawing, when a drag has set one. Null means "the
  // app's range", which is what the time picker edits.
  const [zoom, setZoom] = useState(null)
  const [autoRefresh, setAutoRefresh] = useState(0)
  const [runId, setRunId] = useState(0)
  const [legendSearch, setLegendSearch] = useState('')
  const [selection, setSelection] = useState(SHOW_ALL)
  const [limitOn, setLimitOn] = useState(true)
  const [hoverKey, setHoverKey] = useState(null)
  const [csvBusy, setCsvBusy] = useState(false)
  // null means "as tall as its content", which is where the editor starts and
  // what a double-click on the separator puts it back to.
  const [editorPx, setEditorPx] = useState(null)
  const [dragging, setDragging] = useState(false)
  const editorRef = useRef(null)
  const splitRef = useRef(null)
  const dragRef = useRef(null)

  const range = zoom ?? timeRange
  const datasource = page.datasource
  const editor = page.editors[datasource]
  const committed = useMemo(() => committedQuery(page), [page])
  const draft = draftQuery(page)
  const dirty = isDirty(page)

  const result = useExploreResult({
    committed,
    range,
    formula: page.formula,
    compare: page.compare,
    runId,
  })

  // ---- running ----

  // Read through a ref so the handler is stable: it is passed to both editors,
  // and an editor that re-memoises its callbacks on every keystroke is an
  // editor that re-fetches its metadata on every keystroke.
  const pageRef = useRef(page)
  pageRef.current = page

  const run = useCallback(() => {
    if (!draftQuery(pageRef.current)) return
    setPage(p => commit(p))
    setRunId(n => n + 1)
  }, [])

  const refresh = useCallback(() => setRunId(n => n + 1), [])

  // Cmd/Ctrl+Enter anywhere in the editor card runs it (ARCH D4). The code
  // editors bind it themselves; this is for the builders, where the focus is
  // on a dropdown that has never heard of a query.
  const onCardKeyDown = useCallback((e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      run()
    }
  }, [run])

  // ---- time ----

  // A range the reader picks is an explicit answer to "what window?", so it
  // replaces the drag rather than being overlaid by it (ARCH D5).
  const pickRange = useCallback((next) => {
    setZoom(null)
    setTimeRange(next)
  }, [setTimeRange])

  // Both halves have to stay usable at every position: enough editor left to
  // see which query is running, and enough room below the separator that the
  // toolbar and the top of the chart are still on screen. A pane dragged shut
  // looks like a bug, and there is no affordance left to drag it back open by.
  const clampEditor = useCallback((px) => {
    const top = editorRef.current?.getBoundingClientRect().top ?? 0
    // The separator sits between the two, so its own height comes out of the
    // budget as well — otherwise the lower half is short by exactly the grab
    // area and the constant below would not mean what it says.
    const splitH = splitRef.current?.getBoundingClientRect().height ?? 0
    const room = window.innerHeight - top - splitH - LOWER_MIN_PX
    return Math.min(Math.max(EDITOR_MIN_PX, room), Math.max(EDITOR_MIN_PX, px))
  }, [])

  const startSplitDrag = useCallback((e) => {
    e.preventDefault()
    const startPx = editorPx ?? editorRef.current?.getBoundingClientRect().height ?? EDITOR_MIN_PX
    dragRef.current = { startY: e.clientY, startPx }
    setDragging(true)
    const onMove = (ev) => {
      const { startY, startPx: from } = dragRef.current
      setEditorPx(clampEditor(from + (ev.clientY - startY)))
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      setDragging(false)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
  }, [editorPx, clampEditor])

  // A separator only the mouse can move is one a keyboard cannot move at all,
  // and this one decides how much of the screen each half gets.
  const onSplitKey = useCallback((e) => {
    const step = e.shiftKey ? 80 : 24
    const current = () => editorPx ?? editorRef.current?.getBoundingClientRect().height ?? EDITOR_MIN_PX
    if (e.key === 'ArrowUp') { e.preventDefault(); setEditorPx(clampEditor(current() - step)) }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setEditorPx(clampEditor(current() + step)) }
    else if (e.key === 'Home') { e.preventDefault(); setEditorPx(clampEditor(EDITOR_MIN_PX)) }
    else if (e.key === 'End') { e.preventDefault(); setEditorPx(clampEditor(Number.MAX_SAFE_INTEGER)) }
    else if (e.key === 'Escape') { e.preventDefault(); setEditorPx(null) }
  }, [editorPx, clampEditor])

  // A window that shrank can leave the editor taller than the room below it,
  // which would push the results off the bottom with no way back.
  useEffect(() => {
    if (editorPx == null) return undefined
    const onResize = () => setEditorPx(px => (px == null ? px : clampEditor(px)))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [editorPx, clampEditor])

  const onZoom = useCallback((minMs, maxMs) => {
    const next = zoomRange(minMs, maxMs)
    if (next) setZoom(next)
  }, [])

  // The chart's x axis must come from the window the run actually asked for,
  // not from a second resolution at a later `now`. Before the first run there
  // is none, so the page resolves one for the empty axis to span.
  const fallbackResolved = useMemo(() => resolveRange(range), [range])
  const resolved = result.resolved ?? fallbackResolved

  // ---- incoming payloads ----

  const appliedNonce = useRef(null)
  useEffect(() => {
    if (!incoming || incoming.nonce === appliedNonce.current) return
    appliedNonce.current = incoming.nonce
    setPage(p => applyIncoming(p, incoming))
    setZoom(null)
    setRunId(n => n + 1)
    onIncomingApplied?.()
  }, [incoming, onIncomingApplied])

  // ---- the result model ----

  const comparing = page.compare !== 'off' && result.compareShiftSec > 0
  const compareLabel = COMPARE_OPTIONS.find(o => o.value === page.compare)?.vs ?? ''

  const chartModel = useMemo(() => buildChartModel({
    series: result.series,
    legendLabel: page.legendLabel,
    formula: page.formula,
    stack: page.stack,
    search: legendSearch,
    limitOn,
    selection,
    prevSeries: result.prevSeries,
    prevFailed: result.prevFailed,
    compareShiftSec: result.compareShiftSec,
  }), [
    result.series, result.prevSeries, result.prevFailed, result.compareShiftSec,
    page.legendLabel, page.formula, page.stack, legendSearch, limitOn, selection,
  ])

  const tableRows = useMemo(() => buildTableRows({
    series: result.series,
    legendLabel: page.legendLabel,
    formula: page.formula,
    prevSeries: result.prevSeries,
    prevFailed: result.prevFailed,
  }), [result.series, result.prevSeries, result.prevFailed, page.legendLabel, page.formula])

  // Which series are drawn is an answer about THIS result under THESE names
  // (ARCH D8). A new query, or a new Labels choice, makes the answer
  // meaningless rather than stale, so it goes.
  const resultKey = `${committed?.datasource ?? ''}|${committed?.query ?? ''}|${page.legendLabel}`
  useEffect(() => {
    setSelection(SHOW_ALL)
    setLimitOn(true)
    setHoverKey(null)
  }, [resultKey])

  // ---- CSV ----

  const onCsv = useCallback(async () => {
    if (!committed?.query) {
      setToast?.('Nothing to export yet — generate a graph first.')
      return undefined
    }
    setCsvBusy(true)
    try {
      const { series } = await queryReduced({
        datasource: committed.datasource,
        query: committed.query,
        start: resolved.start,
        end: resolved.end,
        step: resolved.step,
        formula: page.formula,
      })
      if (!series.length) {
        setToast?.('Nothing to export — the query returned no series.')
        return undefined
      }
      return series
    } catch (err) {
      setToast?.(`Could not export: ${err?.message || err}`)
      return undefined
    } finally {
      setCsvBusy(false)
    }
  }, [committed, resolved, page.formula, setToast])

  // ---- editor plumbing ----

  const onEditorChange = useCallback((next) => setPage(p => setEditor(p, next)), [])
  const setting = useCallback((key) => (value) => setPage(p => setSetting(p, key, value)), [])

  const busy = result.status === 'loading'
  const runTitle = !draft
    ? 'Nothing to run yet — build a query above.'
    : busy
      ? 'Running. The chart below is the previous answer until this one lands.'
      : dirty
        ? 'Generate the graph. The editor has changes the result does not show yet.'
        : 'Run the committed query again.'

  return (
    <>
      <PageBar
        timeRange={range}
        setTimeRange={pickRange}
        onRefresh={refresh}
        refreshing={busy}
        autoRefresh={autoRefresh}
        onAutoRefreshChange={setAutoRefresh}
        actions={zoom && (
          <button
            type="button"
            className="hbtn"
            onClick={() => setZoom(null)}
            title="Drop the range this chart was zoomed to and go back to the one the time picker holds"
          >
            Reset zoom
          </button>
        )}
      >
        <a onClick={goHome}>CubeAPM</a>
        <span className="sep">/</span>
        <a className="current">Explore</a>
      </PageBar>

      <div className="ex-page">
        {/* One bordered sub-card holds the whole journey — editor, actions,
            error and result — because they are one thought (ARCH D1). */}
        <div className="ex-card" onKeyDown={onCardKeyDown}>
          <div className="ex-card-head">
            <div className="tabbar" role="tablist" aria-label="Datasource">
              {DATASOURCES.map(d => (
                <button
                  key={d.value}
                  type="button"
                  role="tab"
                  aria-selected={d.value === datasource}
                  className={`tab${d.value === datasource ? ' active' : ''}`}
                  onClick={() => setPage(p => setDatasource(p, d.value))}
                >
                  {d.label}
                </button>
              ))}
            </div>

            <div className="seg-toggle" role="tablist" aria-label="Query mode">
              {tabsFor(datasource).map(t => (
                <button
                  key={t.value}
                  type="button"
                  role="tab"
                  aria-selected={t.value === editor.tab}
                  className={`seg${t.value === editor.tab ? ' active' : ''}`}
                  onClick={() => setPage(p => setTab(p, t.value))}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          <div
            ref={editorRef}
            className="ex-card-editor"
            style={editorPx == null ? undefined : { height: editorPx, overflowY: 'auto' }}
            role="tabpanel"
            aria-label={`${datasource === 'prometheus' ? 'Metrics' : datasource === 'vlogs' ? 'Logs' : 'Traces'} query editor`}
          >
            {isMetricsSource(datasource) ? (
              <MetricsEditor state={editor} onChange={onEditorChange} onSubmit={run} range={range} />
            ) : (
              // Keyed by datasource: logs and traces share this component but
              // not their field catalogues, and a remount is the honest way to
              // drop the previous one's in-flight lookups.
              <LogsEditor
                key={datasource}
                datasource={datasource}
                state={editor}
                onChange={onEditorChange}
                onSubmit={run}
                range={range}
              />
            )}
          </div>

          {/* The query is written above, read below. The separator lets a
              reader decide how that room is split — an Advanced query with
              several operation cards, or a Builder with a stats pipe and a
              math pipe, is tall enough to push the chart off the screen
              otherwise. Same control as the trace waterfall's. */}
          <div
            ref={splitRef}
            className={`ex-split${dragging ? ' is-dragging' : ''}`}
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize the query editor"
            aria-valuenow={Math.round(editorPx ?? editorRef.current?.getBoundingClientRect().height ?? 0)}
            tabIndex={0}
            onMouseDown={startSplitDrag}
            onKeyDown={onSplitKey}
            onDoubleClick={() => setEditorPx(null)}
            title="Drag to resize · double-click to fit the editor to its content"
          >
            <span className="ex-split-grip" aria-hidden="true" />
          </div>

          <div className="ex-lower">
          <div className="ex-actions">
            <ResultsToolbar
              view={page.view}
              setView={setting('view')}
              labelsSet={chartModel.labelsSet}
              legendLabel={page.legendLabel}
              setLegendLabel={setting('legendLabel')}
              formula={page.formula}
              setFormula={setting('formula')}
              unit={page.unit}
              setUnit={setting('unit')}
              stack={page.stack}
              setStack={setting('stack')}
              compare={page.compare}
              setCompare={setting('compare')}
              onCsv={onCsv}
              csvBusy={csvBusy}
              seriesCount={result.series.length || undefined}
            />

            {/* Last in the row and last in the tab order: the controls above
                change how an answer is read, this is the one that goes and
                gets it. */}
            <button
              type="button"
              className={`hbtn primary run-btn${dirty && draft && !busy ? ' is-dirty' : ''}${busy ? ' is-running' : ''}`}
              onClick={run}
              disabled={!draft}
              title={runTitle}
              aria-label={busy ? 'Running query' : 'Generate graph'}
            >
              <RunIcon busy={busy} />
              Generate Graph
            </button>
          </div>

          {/* The band is an addition to the view, never a replacement for it:
              the previous result stays readable underneath (ARCH D8). */}
          {result.error && (
            <div className="ex-error-band" role="alert">
              <AlertCircle size={14} strokeWidth={2} aria-hidden="true" />
              <span className="ex-error-band-msg">{result.error}</span>
              <button type="button" className="ex-error-retry" onClick={result.retry}>
                Try again
              </button>
            </div>
          )}

          {page.view === 'line' ? (
            <div className="ex-results">
              <div className="ex-results-chart">
                <ExploreChart
                  model={chartModel}
                  resolved={resolved}
                  unit={page.unit}
                  stack={page.stack}
                  height={CHART_HEIGHT}
                  onZoom={onZoom}
                  hoverKey={hoverKey}
                  status={result.status}
                  stale={result.stale}
                  emptyHint={result.status === 'error' ? 'The last run failed — the message above says why.' : undefined}
                />
              </div>
              <div className="ex-results-legend">
                <ExploreLegend
                  model={chartModel}
                  unit={page.unit}
                  search={legendSearch}
                  onSearchChange={setLegendSearch}
                  selection={selection}
                  onSelectionChange={setSelection}
                  onShowAll={() => setLimitOn(false)}
                  hoverKey={hoverKey}
                  onHoverKey={setHoverKey}
                  comparing={comparing}
                  compareLabel={compareLabel}
                />
              </div>
            </div>
          ) : (
            <ExploreTable
              rows={tableRows}
              unit={page.unit}
              comparing={comparing}
              compareLabel={compareLabel}
              resetKey={`${committed?.datasource ?? ''}|${committed?.query ?? ''}`}
              status={result.status}
              stale={result.stale}
              emptyHint={result.status === 'error' ? 'The last run failed — the message above says why.' : undefined}
            />
          )}
          </div>
        </div>
      </div>
    </>
  )
}
