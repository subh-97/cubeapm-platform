import { useState, useMemo, useRef, useCallback, useEffect, useLayoutEffect } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { resolveWindow } from '@/data/timeWindow'
import { servicesForWindow } from '@/data/services'
import { errorSeriesForWindow, groupErrorSeries, sumErrorSeries, tracesFiltersFor } from '@/data/errors'
import PageBar from '@/components/layout/PageBar'
import FacetGroup from '@/components/explorer/FacetGroup'
import { applyChipsToLog, chipsToString } from '@/components/QueryBuilder'
import ErrorsQueryBuilder from '@/components/errors/ErrorsQueryBuilder'
import ErrorGroupTable from '@/components/errors/ErrorGroupTable'
import ErrorDetailsDrawer from '@/components/errors/ErrorDetailsDrawer'
import { ERROR_SERIES_COLOR } from '@/components/errors/ErrorSpark'
import { buildErrorFacets, applyErrorFacets, getErrorFieldValue, ERROR_RECENT_SEEDS, ERROR_COLON_MATCH } from '@/utils/errorFields'
import { errorsSearch } from '@/utils/errorsUrl'
import {
  previousPeriodText, deltaChip, sortErrorGroups, SORT_FIRST_DIR, toggleFacetValue, hasFacetSelection,
  facetsForKind, errorsStateFromLink, explainEmpty, errorGroupsCsv,
  ERRORS_PATH, initialErrorsState, sameSearch, parsePastedErrorsQuery, exceptionParts,
} from '@/utils/errorsPage'
import { normalize } from '@/utils/queryTree'
import { copyText } from '@/utils/clipboard'
import { rangeLabel } from '@/utils/timeRange'
import { GRID_PROPS, valueAxisProps, fmtCount } from '@/components/charts/chartDefaults'
import { buildTimeAxis } from '@/components/charts/timeAxis'
import ChartTooltip from '@/components/charts/ChartTooltip'
import { useTimeFocus, useMeasuredWidth } from '@/components/charts/useTimeFocus'
import '@/components/errors/errors.css'

// The facet rail's width: the Logs/Traces range, remembered between visits.
const FILTERS_MIN_W = 232
const FILTERS_MAX_W = Math.round(FILTERS_MIN_W * 1.6)
const FILTERS_W_KEY = 'cubeapm-errors-filters-w'
const FILTERS_KEY_STEP = 16

const clampRail = w => Math.min(FILTERS_MAX_W, Math.max(FILTERS_MIN_W, Math.round(w)))

// Storage can be unavailable (a private window, blocked site data); the rail
// then simply starts at its narrowest, as it does on Logs and Traces.
function readRailWidth() {
  try {
    const w = Number(localStorage.getItem(FILTERS_W_KEY))
    return w ? clampRail(w) : FILTERS_MIN_W
  } catch {
    return FILTERS_MIN_W
  }
}

function saveRailWidth(w) {
  try { localStorage.setItem(FILTERS_W_KEY, String(w)) } catch { /* not remembered; still applied */ }
}

const MAX_RECENTS = 5

// How long a refresh dims the results. The data is read synchronously, so
// without it ↻ would do nothing visible and read as broken; with a backend
// this is where the request's own round trip goes.
const REFRESH_MS = 280

const VOLUME_MARGIN = { top: 8, right: 6, left: 0, bottom: 0 }

const SIDES = [
  {
    value: 'server',
    label: 'Server',
    title: 'Server: requests these services failed to answer — the errors their own callers saw',
  },
  {
    value: 'client',
    label: 'Client',
    title: 'Client: outgoing calls that failed — the databases, caches and external APIs these services call',
  },
]

function VolumeTooltip({ active, payload, nowMs, suppressed }) {
  if (!active || !payload?.length) return null
  const rec = payload[0]?.payload
  if (!rec) return null
  return (
    <ChartTooltip
      tMs={rec.t != null ? rec.t * 1000 : null}
      nowMs={nowMs}
      suppressed={suppressed}
      items={[{ key: 'value', label: 'errors', value: rec.value?.toLocaleString(), color: ERROR_SERIES_COLOR }]}
    />
  )
}

// An exception in the facet rail, drawn as the table draws it: plain text is
// cut from the right, which hid the class name and left both Jedis exceptions
// reading `redis.clients.jedis.exc…`.
function renderExceptionLabel(value) {
  const { pkg, short } = exceptionParts(value)
  return (
    <span className="errp-facet-exc">
      {pkg && <span className="errp-exc-pkg"><bdi>{pkg}</bdi></span>}
      <span className="errp-facet-exc-cls">{short}</span>
    </span>
  )
}

function CheckCircle() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 12l2 2 4-4" /><circle cx="12" cy="12" r="10" />
    </svg>
  )
}

function FilterOff() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 4h18l-7 8.5V19l-4 2v-8.5z" /><path d="M16 15l5 5M21 15l-5 5" />
    </svg>
  )
}

/**
 * Why the table is empty — good news, or the filters talking. See explainEmpty.
 */
function EmptyState({ empty, onClear, onSwitch }) {
  if (empty.kind === 'quiet') {
    return (
      <div className="errp-empty" role="status">
        <CheckCircle />
        <div className="errp-empty-title">{empty.title}</div>
        <div className="errp-empty-sub">{empty.sub}</div>
      </div>
    )
  }
  const other = empty.switchTo === 'client' ? 'Client' : 'Server'
  return (
    <div className="errp-empty" role="status">
      <FilterOff />
      <div className="errp-empty-title">{empty.title}</div>
      {(empty.filters.length > 0 || empty.search) && (
        <ul className="errp-empty-list" aria-label="Active filters">
          {empty.filters.map(f => (
            <li key={`${f.field}=${f.value}`} className="errp-empty-filter" title={`${f.field} = ${f.value}`}>
              <span>{f.field}</span>
              <span className="v">{f.value}</span>
              {f.count === 0 && <span className="zero">· 0</span>}
            </li>
          ))}
          {empty.search && (
            <li className="errp-empty-filter" title={empty.search}>
              <span>search</span>
              <span className="v">{empty.search}</span>
            </li>
          )}
        </ul>
      )}
      {empty.notes.length > 0 && (
        <ul className="errp-empty-notes">
          {empty.notes.map(n => <li key={n}>{n}</li>)}
        </ul>
      )}
      <div className="errp-empty-actions">
        <button type="button" className="search-empty-clear" onClick={onClear}>Clear filters</button>
        {empty.switchTo && (
          <button type="button" className="hbtn small" onClick={() => onSwitch(empty.switchTo)}>
            Show {other} errors
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * Errors explorer.
 *
 * The Logs/Traces surface — same rail, same query bar, same results column and
 * the same right-hand drawer — applied to exceptions rather than to records.
 * What a row is differs: not one event but an error GROUP, everything one
 * service threw of one exception type at one endpoint, counted over the range
 * and compared with the range before it.
 *
 * Unlike Logs and Traces there is no Run. The rows are a few hundred
 * pre-aggregated series, cheap to filter on every change, so facets and
 * committed chips apply as they are made; a chip still being composed does
 * not. What the page is filtered to — side, facets, search — is in its URL
 * (the range belongs to the whole app), so a link reproduces it.
 */
export default function ErrorsView({
  goHome, timeRange, setTimeRange, setToast, onOpenLink, onOpenTrace, incoming, onIncomingApplied,
}) {
  const location = useLocation()
  const navigate = useNavigate()

  // ---- what the page opens on ----

  // A link from another page wins over the URL; otherwise the URL — ours or the
  // original CubeAPM page's, and only while it is the Errors address — is the
  // starting state, so a pasted link lands filtered on its first paint and
  // never runs unfiltered first. See initialErrorsState.
  const [initial] = useState(() => initialErrorsState({
    incoming, pathname: location.pathname, search: location.search,
  }))
  const [kind, setKind] = useState(initial.kind)
  const [facets, setFacets] = useState(initial.facets)
  const [chips, setChips] = useState(initial.chips)
  const [selectedId, setSelectedId] = useState(null)
  const [sort, setSort] = useState({ key: 'count', dir: 'desc' })
  const [graphVisible, setGraphVisible] = useState(true)
  const [zoomedFrom, setZoomedFrom] = useState(null)
  const [railW, setRailW] = useState(readRailWidth)
  const [recents, setRecents] = useState(ERROR_RECENT_SEEDS)
  const [refreshing, setRefreshing] = useState(false)
  // The scroll container, as state rather than a ref: the lazy sparks measure
  // against it, and have to hear when it exists.
  const [scrollEl, setScrollEl] = useState(null)

  // The link's time preset is the range everything else is read for, so it is
  // applied before the first paint — after it, the page would draw an hour,
  // then redraw a week. Once, on a cold load; after that the range is the app's.
  const hydrated = useRef(false)
  useLayoutEffect(() => {
    if (hydrated.current) return
    hydrated.current = true
    if (initial.time) setTimeRange({ kind: 'preset', value: initial.time })
    if (initial.lostQuery) setToast?.('The search in this link could not be read, so it was left out.')
  }, [initial, setTimeRange, setToast])

  // A later "open in Errors" while the page is already up: applied once per
  // nonce, replacing what was there — arriving with someone else's filters
  // still applied is not what the link promised.
  const appliedNonce = useRef(incoming?.nonce ?? null)
  useEffect(() => {
    if (!incoming) return
    if (incoming.nonce !== appliedNonce.current) {
      appliedNonce.current = incoming.nonce
      const next = errorsStateFromLink(incoming)
      setKind(next.kind)
      setFacets(next.facets)
      setChips([])
      setSelectedId(null)
    }
    onIncomingApplied?.()
  }, [incoming, onIncomingApplied])

  // The URL follows the page, replacing rather than pushing: one history entry
  // per filter tick would make Back step through every checkbox. Only while
  // the address bar is ours — arriving from another page, this runs before App
  // has moved the path to /errors, and writing then would rewrite the page we
  // came from.
  //
  // What is applied — to the table and to the URL — is the chips as they
  // read, not as they are being built: a group the builder has just opened is
  // empty until its first filter lands, and an empty group OR-ed onto the query
  // matched every row, and wrote `… OR ()` into the URL, which does not parse
  // back. normalize drops it (and unwraps a group of one), as the builder
  // itself does when the bar loses focus.
  //
  // And it is held by what it says, not by which array it is: the builder
  // normalizes its own chips every time the bar closes (Enter, Esc, a click
  // outside), which hands back an equal tree in a new array. Taken at its word,
  // that regrouped every row and redrew every spark for a query that had not
  // changed. The tree is compared whole rather than by its query text, which
  // two different operators can share (`:"a b"` is a phrase or a word).
  const normalizedChips = useMemo(() => normalize(chips), [chips])
  const appliedKey = useMemo(() => JSON.stringify(normalizedChips), [normalizedChips])
  const appliedChips = useMemo(() => normalizedChips, [appliedKey])   // eslint-disable-line react-hooks/exhaustive-deps
  const queryText = useMemo(() => chipsToString(appliedChips), [appliedChips])
  const search = useMemo(() => errorsSearch({ kind, facets, q: queryText }), [kind, facets, queryText])
  useEffect(() => {
    if (location.pathname !== ERRORS_PATH) return
    if (sameSearch(search, location.search)) return
    navigate({ search }, { replace: true })
  }, [search, location.pathname, location.search, navigate])

  // ---- the data ----

  const win = useMemo(() => resolveWindow(timeRange), [timeRange])
  const serviceStatus = useMemo(
    () => Object.fromEntries(servicesForWindow(win).map(s => [s.id, s.status])),
    [win],
  )
  // The same array per (window, side) — the search bar indexes its values off
  // it, and a fresh array every render would rebuild that index every render.
  const rows = useMemo(() => errorSeriesForWindow(win, kind), [win, kind])
  const otherRows = useMemo(() => errorSeriesForWindow(win, kind === 'server' ? 'client' : 'server'), [win, kind])

  // Facet counts are over the side's rows, never narrowed by the other facets
  // or the search — the same reading as Logs and Traces, and the original.
  const facetOptions = useMemo(
    () => buildErrorFacets(rows, { side: kind, selected: facets, serviceStatus }),
    [rows, kind, facets, serviceStatus],
  )

  // `field:value` read the way the search bar describes it (ERROR_COLON_MATCH);
  // explainEmpty reuses this, so the empty state counts the same way.
  const matchesSearch = useMemo(
    () => (appliedChips.length
      ? row => applyChipsToLog(row, appliedChips, getErrorFieldValue, { colonMatch: ERROR_COLON_MATCH })
      : null),
    [appliedChips],
  )
  // Rows are filtered BEFORE they are grouped, so a filter on one HTTP code
  // keeps the part of a group that answered with it rather than the whole group.
  const filteredRows = useMemo(() => {
    const byFacet = applyErrorFacets(rows, facets)
    return matchesSearch ? byFacet.filter(matchesSearch) : byFacet
  }, [rows, facets, matchesSearch])
  const groups = useMemo(() => groupErrorSeries(filteredRows, win), [filteredRows, win])
  const sortedGroups = useMemo(() => sortErrorGroups(groups, sort, serviceStatus), [groups, sort, serviceStatus])
  const volume = useMemo(() => sumErrorSeries(filteredRows, win), [filteredRows, win])

  // The previous total is Σ prevCount, so it counts only series still failing
  // now; one that went quiet this window is missed. In this data that is an
  // error or two in a thousand, against a second full pass over the window
  // before, so the cheap reading stands.
  const totals = useMemo(() => ({
    count: filteredRows.reduce((a, r) => a + r.count, 0),
    prev: filteredRows.reduce((a, r) => a + r.prevCount, 0),
    services: new Set(filteredRows.map(r => r.service)).size,
    newGroups: groups.filter(g => g.isNew).length,
  }), [filteredRows, groups])

  const prevText = previousPeriodText(timeRange)
  const totalDelta = deltaChip(totals.count, totals.prev, prevText)
  const rangeText = timeRange?.kind === 'preset' ? rangeLabel(timeRange) : 'the selected range'

  // The drawer reads the group from THIS window's groups: its samples are
  // looked up in the window the group was built from. A group that the range
  // or a filter has just taken away closes the drawer rather than leaving it
  // to reopen by surprise when the group comes back.
  const selected = selectedId ? groups.find(g => g.id === selectedId) ?? null : null
  useEffect(() => {
    if (selectedId && !selected) setSelectedId(null)
  }, [selectedId, selected])

  // ---- time: the range control, and drag-to-zoom on any chart ----

  const clearZoom = useCallback(() => {
    if (zoomedFrom) setTimeRange(zoomedFrom)
    setZoomedFrom(null)
  }, [zoomedFrom, setTimeRange])

  // Picking a range replaces whatever was dragged, so there is nothing left to
  // reset back to.
  const wrappedSetTimeRange = useCallback((v) => {
    setZoomedFrom(null)
    setTimeRange(v)
  }, [setTimeRange])

  // A drag on the volume chart or on any row's spark moves the app-wide range,
  // and the range it moved away from is remembered once, so Reset goes back to
  // where the reader started rather than to the previous drag.
  const focusTimeRange = useCallback((next) => {
    setZoomedFrom(cur => cur ?? timeRange)
    setTimeRange(next)
  }, [timeRange, setTimeRange])

  const focus = useTimeFocus(win, { onFocus: focusTimeRange, kind: 'category' })

  // ---- refresh ----

  const refreshTimer = useRef(null)
  const refresh = useCallback(() => {
    clearTimeout(refreshTimer.current)
    setRefreshing(true)
    refreshTimer.current = setTimeout(() => setRefreshing(false), REFRESH_MS)
  }, [])
  useEffect(() => () => clearTimeout(refreshTimer.current), [])

  // ---- filters ----

  const toggleFacet = useCallback((field, value) => {
    setFacets(f => toggleFacetValue(f, field, value))
  }, [])

  const clearFilters = useCallback(() => {
    setFacets({})
    setChips([])
  }, [])

  // Each side is its own set of errors, so a row open on one is not on the
  // other. Chips carry across — they are written in fields both sides have.
  const switchKind = useCallback((next) => {
    if (next === kind) return
    setKind(next)
    setSelectedId(null)
    setFacets(f => facetsForKind(f, next))
  }, [kind])

  const toggleSort = useCallback((key) => {
    setSort(cur => (cur.key === key
      ? { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: SORT_FIRST_DIR[key] ?? 'desc' }))
  }, [])

  // ---- the search bar ----

  // The builder records a recent itself whenever it runs, so this is only the
  // list's bookkeeping: newest first, one entry per query, five at most.
  const addRecent = useCallback((next) => {
    if (!next || next.length === 0) return
    const key = chipsToString(next)
    setRecents(prev => [next, ...prev.filter(r => chipsToString(r) !== key)].slice(0, MAX_RECENTS))
  }, [])

  // The toast waits for the clipboard's answer, so it never claims a copy
  // that did not happen; see copyText for the fallback when the browser has no
  // async clipboard or refuses it.
  const copyQuery = useCallback(() => {
    if (!queryText) return
    copyText(queryText).then(ok => setToast?.(ok
      ? 'This query has been copied to clipboard'
      : 'The browser blocked the clipboard, so nothing was copied.'))
  }, [queryText, setToast])

  // ---- links out ----

  const openTrace = useCallback((id) => {
    if (onOpenTrace) onOpenTrace(id)
    else onOpenLink?.({ view: 'traces', traceId: id })
  }, [onOpenTrace, onOpenLink])

  const openTracesFor = useCallback((group) => {
    onOpenLink?.({ view: 'traces', filters: tracesFiltersFor(group) })
  }, [onOpenLink])

  const selectGroup = useCallback(group => setSelectedId(group.id), [])
  // The drawer hands focus back to the row that opened it on its own.
  const closeDrawer = useCallback(() => setSelectedId(null), [])

  const downloadCsv = useCallback(() => {
    const blob = new Blob([errorGroupsCsv(sortedGroups)], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `errors-${kind}-${Date.now()}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }, [sortedGroups, kind])

  // ---- the rail ----

  const dragRef = useRef(null)

  const startResize = useCallback((e) => {
    e.preventDefault()
    dragRef.current = { startX: e.clientX, startW: railW, w: railW }
    const onMove = (ev) => {
      const d = dragRef.current
      d.w = clampRail(d.startW + (ev.clientX - d.startX))
      setRailW(d.w)
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      saveRailWidth(dragRef.current.w)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [railW])

  // The handle is focusable, so it answers the arrow keys as well as the mouse.
  const resizeByKey = useCallback((e) => {
    const step = e.key === 'ArrowLeft' ? -FILTERS_KEY_STEP : e.key === 'ArrowRight' ? FILTERS_KEY_STEP : 0
    if (!step) return
    e.preventDefault()
    const w = clampRail(railW + step)
    setRailW(w)
    saveRailWidth(w)
  }, [railW])

  // ---- the volume chart ----

  const volumeMax = useMemo(() => volume.reduce((m, d) => (d.value > m ? d.value : m), 0), [volume])
  const [volumeWrapRef, volumeWrapWidth] = useMeasuredWidth()
  const volumeYAxis = useMemo(
    () => valueAxisProps({ format: fmtCount, allowDecimals: false, maxValue: volumeMax }),
    [volumeMax],
  )
  // The tick ladder is budgeted against the plot, not the card: the value
  // gutter and the right margin are not room a label can be drawn in.
  const volumeAxis = useMemo(
    () => buildTimeAxis(win, {
      width: Math.max(0, volumeWrapWidth - volumeYAxis.width - VOLUME_MARGIN.right),
      kind: 'category',
    }),
    [win, volumeWrapWidth, volumeYAxis.width],
  )

  const anySelection = hasFacetSelection(facets)
  const empty = sortedGroups.length ? null : explainEmpty({
    rows, otherRows, facets, matchesSearch, searchText: queryText, side: kind, rangeText,
  })

  return (
    <>
      <PageBar timeRange={timeRange} setTimeRange={wrappedSetTimeRange} onRefresh={refresh} refreshing={refreshing}>
        <a onClick={goHome}>CubeAPM</a>
        <span className="sep">/</span>
        <span className="current">Errors</span>
      </PageBar>

      <div className="logs-layout logs-layout-stitched" style={{ gridTemplateColumns: `${railW}px 1fr` }}>
        <div className="logs-filters">
          <div className="logs-filters-head">
            <span>Filters</span>
            {anySelection && (
              <button className="logs-filters-clear" onClick={() => setFacets({})}>Clear all</button>
            )}
          </div>
          <div className="logs-filters-scroll">
            {Object.keys(facetOptions).map(field => (
              <FacetGroup
                key={field}
                title={field}
                options={facetOptions[field]}
                selected={facets[field] ?? new Set()}
                onToggle={toggleFacet}
                renderLabel={field === 'exception' ? renderExceptionLabel : undefined}
              />
            ))}
          </div>
          <div
            className="logs-filters-resize"
            onMouseDown={startResize}
            onKeyDown={resizeByKey}
            tabIndex={0}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize filters panel"
            aria-valuemin={FILTERS_MIN_W}
            aria-valuemax={FILTERS_MAX_W}
            aria-valuenow={railW}
          />
        </div>

        <div className="logs-main">
          <div className="logs-main-body" ref={setScrollEl}>
            <div className="logs-query-bar">
              <div className="seg-toggle logs-mode-toggle errp-kind" role="group" aria-label="Which errors">
                {SIDES.map(s => (
                  <button
                    key={s.value}
                    type="button"
                    className={`seg${kind === s.value ? ' active' : ''}`}
                    aria-pressed={kind === s.value}
                    title={s.title}
                    onClick={() => switchKind(s.value)}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
              <ErrorsQueryBuilder
                chips={chips}
                setChips={setChips}
                rows={rows}
                recents={recents}
                addRecent={addRecent}
                onRun={refresh}
                onCopyQuery={queryText ? copyQuery : null}
                parsePastedQuery={parsePastedErrorsQuery}
              />
            </div>

            <div className="logs-controls">
              <div className="logs-controls-left">
                <button
                  className={`hbtn small${!graphVisible ? ' brand-lit' : ''}`}
                  onClick={() => setGraphVisible(v => !v)}
                  title={graphVisible ? 'Hide graph' : 'Show graph'}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="2" y="13" width="4" height="8" rx="1"/><rect x="10" y="8" width="4" height="13" rx="1"/><rect x="18" y="3" width="4" height="18" rx="1"/></svg>
                  {graphVisible ? 'Hide graph' : 'Show graph'}
                </button>
                {/* A row's spark still zooms with the graph hidden, and the
                    graph's Reset is hidden with it — so it is offered here,
                    and only then, never in both places at once. */}
                {!graphVisible && zoomedFrom && (
                  <button className="hbtn small" onClick={clearZoom} title="Clear time selection">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
                    Reset zoom
                  </button>
                )}
                <span className="span-count">
                  {sortedGroups.length.toLocaleString()} error group{sortedGroups.length === 1 ? '' : 's'}
                </span>
              </div>
              <div className="logs-controls-right">
                <button
                  className="hbtn small"
                  onClick={downloadCsv}
                  disabled={!sortedGroups.length}
                  title="Download these error groups as CSV"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                  CSV
                </button>
              </div>
            </div>

            <div className={`logs-results${refreshing ? ' is-stale' : ''}`} aria-busy={refreshing}>
              {graphVisible && (
                <div className="logs-volume">
                  <div className="logs-volume-chart">
                    {zoomedFrom ? (
                      <button className="volume-reset-btn" onClick={clearZoom} title="Clear time selection">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
                        Reset zoom
                      </button>
                    ) : (
                      <div className="volume-brush-hint">Click &amp; drag on chart to zoom in</div>
                    )}
                    <div ref={volumeWrapRef} style={{ width: '100%', height: '100%' }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={volume} margin={VOLUME_MARGIN} {...focus.chartProps}>
                          <CartesianGrid {...GRID_PROPS} />
                          <XAxis {...volumeAxis.props} />
                          <YAxis {...volumeYAxis} />
                          <Tooltip
                            content={p => <VolumeTooltip {...p} nowMs={win.end * 1000} suppressed={!focus.hovered} />}
                            cursor={{ fill: 'var(--overlay-hover)' }}
                            isAnimationActive={false}
                          />
                          {/* One series, the error count, so red here is the
                              severity it stands for — see ERROR_SERIES_COLOR. */}
                          <Bar dataKey="value" fill={ERROR_SERIES_COLOR} fillOpacity={0.85} isAnimationActive={false} />
                          {focus.overlay}
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                  <div className="logs-volume-legend errp-legend">
                    <div className="lvl-row">
                      <span className="lvl-swatch" style={{ background: ERROR_SERIES_COLOR }} />
                      <span className="lvl-key">Errors</span>
                      <span className="lvl-val">{totals.count.toLocaleString()}</span>
                    </div>
                    <div className="errp-legend-delta">
                      <span className="errp-delta" data-dir={totalDelta.dir} title={totalDelta.title}>{totalDelta.label}</span>
                      <span>vs {prevText.replace(/^the /, '')}</span>
                    </div>
                    <div className="lvl-row">
                      <span className="lvl-key">Groups</span>
                      <span className="lvl-val">
                        {groups.length.toLocaleString()}
                        {totals.newGroups > 0 && <span className="errp-legend-new">({totals.newGroups} new)</span>}
                      </span>
                    </div>
                    <div className="lvl-row">
                      <span className="lvl-key">Services</span>
                      <span className="lvl-val">{totals.services}</span>
                    </div>
                  </div>
                </div>
              )}

              {empty ? (
                <EmptyState empty={empty} onClear={clearFilters} onSwitch={switchKind} />
              ) : (
                <ErrorGroupTable
                  groups={sortedGroups}
                  side={kind}
                  win={win}
                  onFocus={focusTimeRange}
                  sort={sort}
                  onSort={toggleSort}
                  selectedId={selectedId}
                  onSelect={selectGroup}
                  onOpenTraces={openTracesFor}
                  serviceStatus={serviceStatus}
                  prevText={prevText}
                  scrollRoot={scrollEl}
                />
              )}
            </div>
          </div>

          {selected && (
            <ErrorDetailsDrawer
              key={selected.id}
              group={selected}
              win={win}
              onClose={closeDrawer}
              onOpenTrace={openTrace}
              onOpenLink={onOpenLink}
              onViewTraces={openTracesFor}
              setToast={setToast}
            />
          )}
        </div>
      </div>
    </>
  )
}
