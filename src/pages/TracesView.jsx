import { useState, useMemo, useRef, useCallback, useEffect } from 'react'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { resolveWindow } from '@/data/timeWindow'
import { TRACES_SOURCE, filterVolume } from '@/utils/explorerSources'
import PageBar from '@/components/layout/PageBar'
import QueryBuilder, { applyChipsToLog, chipsToString } from '@/components/QueryBuilder'
import FacetGroup from '@/components/explorer/FacetGroup'
import FieldsDropdown from '@/components/explorer/FieldsDropdown'
import { newGroup } from '@/utils/queryTree'
import { toExploreLogsQuery } from '@/utils/explore/builders'
import { aggregate } from '@/utils/aggregator'
import AggregateResults from '@/components/AggregateResults'
import { serializePipes, composeQuery, parsePipes, withImpliedCount, newStatsPipe, newSortPipe, newLimitPipe, newMathPipe, namesInScopeBefore } from '@/utils/pipes'
import { tryParseConditions, splitQuery } from '@/utils/rawQuery'
import PipePill, { PipePillChip } from '@/components/PipePill'
import AggregationPopover from '@/components/AggregationPopover'
import GroupByPopover from '@/components/GroupByPopover'
import OrderPopover from '@/components/OrderPopover'
import LimitPopover from '@/components/LimitPopover'
import MathPopover from '@/components/MathPopover'
import SaveQueryPopover from '@/components/SaveQueryPopover'
import MyQueriesDrawer from '@/components/MyQueriesDrawer'
import { useSavedQueries } from '@/hooks/useSavedQueries'
import { useHeaderScrollSync } from '@/hooks/useHeaderScrollSync'
import { Sigma, Network, ArrowUpDown, Hash, Calculator, AlertCircle, Bookmark, BookmarkPlus, BookmarkCheck, List } from 'lucide-react'
import { ALIASES } from '@/utils/logFields'
import { LogRecordDrawer } from '@/components/LogRecordDrawer'
import QueryHistoryDrawer from '@/components/explorer/QueryHistoryDrawer'
import AlertDrawer from '@/components/explorer/AlertDrawer'
import { GRID_PROPS, valueAxisProps, fmtCount } from '@/components/charts/chartDefaults'
import { buildTimeAxis } from '@/components/charts/timeAxis'
import ChartTooltip from '@/components/charts/ChartTooltip'
import { useTimeFocus, useMeasuredWidth, useSeriesHover } from '@/components/charts/useTimeFocus'

const FILTERS_MIN_W = 232
const FILTERS_MAX_W = Math.round(FILTERS_MIN_W * 1.6)
const NOTE_DESC_MAX = 100

// Separates "a malformed query worth explaining" from "a plain value that
// happens not to parse". Only the former earns an error on paste.
const LOOKS_LIKE_QUERY = /[:(]|!=|!~|\s(?:AND|OR|in|not_in)\s/i

// Named because the tick ladder has to subtract the right-hand margin from the
// width it is given: that strip is not room a label can be drawn in.
const VOLUME_MARGIN = { top: 8, right: 6, left: 0, bottom: 0 }

// A band is a severity, so its colour is its status's token rather than a hex
// of its own: one place decides what "critical" looks like, in either theme.
const bandColor = (band) => `var(--${band.status})`

// The legend's value emphasis follows the band's severity, not its name, so a
// dataset's own failing band is marked without the page knowing what it is
// called.
const BAND_VALUE_CLASS = { critical: ' val-critical', warning: ' val-warning' }

// The band colours survive the move to the shared tooltip, because here they
// genuinely mean severity rather than identity — but they move off the text and
// onto the swatch, so an ERROR count reads as legibly as an UNSET one. The
// caller passes the bands worst-first, matching the legend under the chart.
//
// `suppressed` is the platform rule for a page with more than one chart: only
// the chart the pointer is actually in opens a panel, the rest show the
// crosshair alone. This page draws a single chart today, so it is always the
// hovered one and the flag never fires — it is wired anyway so that a second
// chart placed beside this one inherits the rule without an edit here.
function VolumeTooltip({ active, payload, nowMs, hoverKey, suppressed, series }) {
  if (!active || !payload?.length) return null
  const rec = payload[0]?.payload
  if (!rec) return null
  // The bucket's own instant, off the row — not parsed back out of the axis
  // label, which has already been shortened for the axis.
  const tMs = rec.t != null ? rec.t * 1000 : rec.x ?? null
  return (
    <ChartTooltip
      tMs={tMs}
      nowMs={nowMs}
      hoverKey={hoverKey}
      suppressed={suppressed}
      items={series.map(s => ({
        key: s.key,
        label: s.label,
        value: rec[s.key]?.toLocaleString(),
        color: s.color,
      }))}
      footer={{ label: 'total', value: rec.total?.toLocaleString() }}
    />
  )
}

// A week of spans runs to tens of millions, which "26040.64K" spells badly.
function compactCount(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(2)}K`
  return n.toLocaleString()
}

function summarizeFn(f) {
  if (f.as) return f.as
  if (f.fn === 'quantile') return `q${Math.round((Number(f.p) || 0.9) * 100)}(${f.field || '·'})`
  if (f.field) return `${f.fn}(${f.field})`
  return `${f.fn}()`
}

function fullFn(f) {
  const args = []
  if (f.fn === 'quantile') args.push(Number(f.p) || 0.9)
  if (f.field) args.push(f.field)
  const call = `${f.fn}(${args.join(', ')})`
  return f.as ? `${f.as} = ${call}` : call
}

function truncate(text, max) {
  const t = String(text ?? '')
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

function downloadCSV(rows, cols, prefix) {
  const escape = v => `"${String(v ?? '').replace(/"/g, '""')}"`
  const lines = [
    cols.map(escape).join(','),
    ...rows.map(r => cols.map(c => {
      if (c === 'time') return escape(`${r.dateStr}T${r.timeStr}Z`)
      return escape(r.tags[c] ?? '')
    }).join(','))
  ]
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = `${prefix}-${Date.now()}.csv`; a.click()
  URL.revokeObjectURL(url)
}

const isBlank = (v) => v == null || v === ''

/**
 * One cell of the table. Only duration, status_code and the columns marked as
 * links are more than their text.
 */
function SpanCell({ col, row, source, onOpenTrace, onFilter }) {
  const raw = row.tags[col.key]
  if (col.key === 'duration') {
    // A record with no duration has not "taken 0 ns" — it was never timed — so
    // the blank reads as a blank, like every other empty cell.
    const text = isBlank(raw) ? '' : source.formatDuration(raw)
    return (
      <span className="span-cell span-dur mono" style={{ width: col.width }}>
        {text || <span className="span-empty">—</span>}
      </span>
    )
  }
  if (col.key === 'status_code') {
    // A span event has no status, which is a different statement from UNSET.
    // Rendering the blank as a dash rather than nothing keeps the column
    // readable as a column instead of looking like a rendering failure.
    const status = source.statusForStatusCode(raw)
    return (
      <span className="span-cell" style={{ width: col.width }}>
        {raw
          ? <span className={`span-status status-${status}`} data-log-field="status_code" data-log-value={raw}>{raw}</span>
          : <span className="span-empty">—</span>}
      </span>
    )
  }
  if (col.link === 'trace' || col.link === 'filter') {
    // The values on the row that lead somewhere else: a trace id opens the
    // waterfall for the whole request, a filter link narrows the results to
    // its value. A record without the value has nowhere to lead, so it gets
    // the blank rather than a link to nothing.
    const cls = `span-cell${col.mono ? ' mono' : ''}${col.grow ? ' grow' : ''}`
    if (isBlank(raw)) {
      return <span className={cls} style={{ width: col.width }}><span className="span-empty">—</span></span>
    }
    const isTrace = col.link === 'trace'
    // A filter link's values are long and the column cuts them off, so the
    // full value leads the tooltip and the action follows it.
    const title = isTrace
      ? (col.linkTitle ?? `Open trace ${raw}`)
      : (col.linkTitle ? `${raw}\n${col.linkTitle}` : `Filter to ${raw}`)
    return (
      <span className={cls} style={{ width: col.width }}>
        <button
          type="button"
          className="span-trace-link"
          title={title}
          onClick={(e) => {
            e.stopPropagation()
            if (isTrace) onOpenTrace(raw)
            else onFilter({ field: col.key, op: 'eq', value: String(raw) })
          }}
        >
          {raw}
        </button>
      </span>
    )
  }
  return (
    <span
      className={`span-cell${col.mono ? ' mono' : ''}${col.grow ? ' grow' : ''}`}
      style={{ width: col.width }}
      title={raw || undefined}
      data-log-field={col.key}
      data-log-value={raw ?? ''}
    >
      {raw || <span className="span-empty">—</span>}
    </span>
  )
}

// What a source without extra rows contributes: one shared empty array, so
// the merged stream stays the seeded one and nothing downstream recomputes.
const NO_EXTRA_ROWS = []

/**
 * Traces explorer.
 *
 * Deliberately the same surface as Logs — same rail, same query bar, same pipe
 * toolbar, same record drawer — because they are the same activity performed on
 * a different record. What changes is the vocabulary (spans, not lines), the
 * severity dimension the chart stacks by, and the table: a log line is one
 * blob of text, a span is a fixed set of columns, so this one is a real table
 * rather than a stream.
 *
 * `source` is the dataset the page reads (see utils/explorerSources): Traces by
 * default, Mobile Traces by passing its config. Everything that differs between
 * the two lives there, so this file holds no knowledge of either. The page
 * reads it on mount and assumes it never changes — a caller showing a different
 * dataset mounts a new page (`key={source.id}`), because the bar's chips,
 * recents and saved queries belong to the dataset they were written about.
 */
export default function TracesView({ source = TRACES_SOURCE, goHome, timeRange, setTimeRange, setToast, onOpenLink, onOpenTrace, incomingChip, onIncomingChipApplied }) {
  // The span stream is read for the selected range, the same way the log stream
  // is — see LogsView. Facets count over the window's rows, so the number
  // beside each value describes what is actually on screen. The error samples
  // a link from Errors needs are merged in further down, once the applied
  // query they depend on exists.
  const win = useMemo(() => resolveWindow(timeRange), [timeRange])
  const seededRows = useMemo(() => source.rowsForWindow(win), [source, win])
  const volume = useMemo(() => source.volumeForWindow(win), [source, win])

  // The aggregation popover's field lists, derived from the dataset's own
  // vocabulary: `keyword` there means numeric, which is what avg() and its
  // kind can be asked of.
  const aggAllFields = useMemo(() => source.fieldCatalog.map(f => f.field), [source])
  const aggNumericFields = useMemo(
    () => new Set(source.fieldCatalog.filter(f => f.type === 'keyword').map(f => f.field)),
    [source],
  )

  // The histogram's bands with their colours resolved, bottom to top as they
  // stack, and worst-first for the legend and the tooltip.
  const volumeSeries = useMemo(() => source.bands.map(b => ({ ...b, color: bandColor(b) })), [source])
  const legendSeries = useMemo(() => [...volumeSeries].reverse(), [volumeSeries])

  const [filters, setFilters] = useState({})
  const [selectedId, setSelectedId] = useState(null)
  const [chips, setChips] = useState([])
  const [runRequested, setRunRequested] = useState(false)
  const [recents, setRecents] = useState(source.initialRecents)
  const addRecent = useCallback((next) => {
    if (!next || next.length === 0) return
    const key = chipsToString(next)
    setRecents(prev => [next, ...prev.filter(r => chipsToString(r) !== key)].slice(0, 5))
  }, [])
  const [live, setLive] = useState('off')
  const [pipes, setPipes] = useState([])
  const [builderBlocked, setBuilderBlocked] = useState(null)

  const effectiveChips = chips

  // The bar's state and the results' state are separate for the same reason
  // they are on Logs: re-filtering on every chip edit means one request per
  // chip against a real backend, and a half-built query is rarely the one
  // wanted. Seeded from the default query so the page auto-loads on mount
  // rather than showing a blank "click Search" screen.
  const [appliedChips, setAppliedChips] = useState(effectiveChips)
  const [appliedPipes, setAppliedPipes] = useState([])
  const [queryState, setQueryState] = useState({ status: 'idle', error: null })
  const runSeq = useRef(0)

  // The window's error samples join the stream only for an applied query that
  // names their exception — see `errorSamplesFor` — so a link from the Errors
  // page lands on rows, while every other query, and no query at all, reads
  // the seeded stream the histogram draws. They are merged here, once, so every
  // reader downstream (facets, filters, columns, the drawer, the aggregations,
  // the CSV) sees one stream rather than two that disagree. A dataset no other
  // page links into has no such rows (`extraRowsFor: null`).
  const extraRows = useMemo(
    () => source.extraRowsFor?.(win, appliedChips) ?? NO_EXTRA_ROWS,
    [source, win, appliedChips],
  )
  const spanRows = useMemo(
    () => (extraRows.length ? source.mergeExtraRows(seededRows, extraRows) : seededRows),
    [source, seededRows, extraRows],
  )
  const spanFacets = useMemo(() => source.buildFacets(spanRows), [source, spanRows])
  const spanFacetFields = useMemo(() => source.facetFieldsFor(spanFacets), [source, spanFacets])

  const runQuery = useCallback(() => {
    const nextChips = effectiveChips
    const nextPipes = pipes
    const seq = ++runSeq.current
    setQueryState({ status: 'running', error: null })
    Promise.resolve()
      .then(() => {
        if (seq !== runSeq.current) return
        setAppliedChips(nextChips)
        setAppliedPipes(nextPipes)
        setQueryState({ status: 'idle', error: null })
      })
      .catch(err => {
        if (seq !== runSeq.current) return
        setQueryState({ status: 'error', error: err?.message || 'Could not run this query. Check the connection and try again.' })
      })
  }, [effectiveChips, pipes])

  useEffect(() => {
    if (!runRequested) return
    setRunRequested(false)
    runQuery()
  }, [runRequested, runQuery])

  const isRunning = queryState.status === 'running'

  const queryDirty =
    chipsToString(effectiveChips) !== chipsToString(appliedChips)
    || serializePipes(withImpliedCount(pipes)) !== serializePipes(withImpliedCount(appliedPipes))

  const runBlocked = builderBlocked

  const aggPillRef = useRef(null)
  const [aggPopOpen, setAggPopOpen] = useState(false)
  const [editingFuncId, setEditingFuncId] = useState(null)
  const groupByPillRef = useRef(null)
  const [groupByPopOpen, setGroupByPopOpen] = useState(false)
  const orderPillRef = useRef(null)
  const [orderPopOpen, setOrderPopOpen] = useState(false)
  const limitPillRef = useRef(null)
  const [limitPopOpen, setLimitPopOpen] = useState(false)
  const mathPillRef = useRef(null)
  const [mathPopOpen, setMathPopOpen] = useState(false)
  const [editingMathId, setEditingMathId] = useState(null)

  const statsFunctions = useMemo(
    () => pipes.filter(p => p.kind === 'stats').flatMap(p => p.functions || []),
    [pipes]
  )
  const editingFunc = editingFuncId ? statsFunctions.find(f => f.id === editingFuncId) : null

  const upsertAggregation = useCallback((fn) => {
    setPipes(prev => {
      const idx = prev.findIndex(p => p.kind === 'stats')
      if (idx === -1) return [...prev, newStatsPipe({ functions: [fn] })]
      const stats = prev[idx]
      const fnIdx = stats.functions.findIndex(f => f.id === fn.id)
      const nextFns = fnIdx === -1 ? [...stats.functions, fn] : stats.functions.map(f => f.id === fn.id ? fn : f)
      const next = [...prev]
      next[idx] = { ...stats, functions: nextFns }
      return next
    })
  }, [])

  const groupBy = useMemo(() => pipes.find(p => p.kind === 'stats')?.groupBy || [], [pipes])

  const setGroupBy = useCallback((next) => {
    setPipes(prev => {
      const idx = prev.findIndex(p => p.kind === 'stats')
      const current = idx === -1 ? [] : (prev[idx].groupBy || [])
      const nextArr = typeof next === 'function' ? next(current) : next
      if (idx === -1) {
        if (nextArr.length === 0) return prev
        return [...prev, newStatsPipe({ groupBy: nextArr, functions: [] })]
      }
      const stats = prev[idx]
      if (nextArr.length === 0 && stats.functions.length === 0) return prev.filter(p => p.id !== stats.id)
      const next2 = [...prev]
      next2[idx] = { ...stats, groupBy: nextArr }
      return next2
    })
  }, [])

  const removeAggregation = useCallback((funcId) => {
    setPipes(prev => prev.flatMap(p => {
      if (p.kind !== 'stats') return [p]
      const nextFns = p.functions.filter(f => f.id !== funcId)
      if (nextFns.length === 0 && (!p.groupBy || p.groupBy.length === 0)) return []
      return [{ ...p, functions: nextFns }]
    }))
  }, [])

  const sortPipe = useMemo(() => pipes.find(p => p.kind === 'sort') || null, [pipes])
  const limitPipe = useMemo(() => pipes.find(p => p.kind === 'limit') || null, [pipes])
  const mathPipes = useMemo(() => pipes.filter(p => p.kind === 'math'), [pipes])
  const editingMath = editingMathId ? mathPipes.find(p => p.id === editingMathId) : null

  const removePipeById = useCallback((id) => setPipes(prev => prev.filter(p => p.id !== id)), [])

  const orderFieldOptions = useMemo(() => {
    const opts = []
    for (const f of groupBy) opts.push({ value: f, hint: 'group by' })
    for (const fn of statsFunctions) if (fn.as) opts.push({ value: fn.as, hint: 'aggregation' })
    return opts
  }, [groupBy, statsFunctions])

  const mathAvailableNames = useMemo(() => {
    const idx = editingMath ? pipes.findIndex(p => p.id === editingMath.id) : pipes.length
    return namesInScopeBefore(pipes, idx === -1 ? pipes.length : idx)
  }, [pipes, editingMath])

  const openCreateMath = useCallback(() => { setEditingMathId(null); setMathPopOpen(true) }, [])
  const openEditMath = useCallback((id) => { setEditingMathId(id); setMathPopOpen(true) }, [])
  const closeMath = useCallback(() => { setMathPopOpen(false); setEditingMathId(null) }, [])
  const upsertMathPipe = useCallback((math) => {
    setPipes(prev => {
      const idx = prev.findIndex(p => p.id === math.id)
      if (idx === -1) return [...prev, { ...newMathPipe(), ...math }]
      const next = [...prev]
      next[idx] = { ...prev[idx], ...math }
      return next
    })
  }, [])

  const openCreateAggregation = useCallback(() => { setEditingFuncId(null); setAggPopOpen(true) }, [])
  const openEditAggregation = useCallback((funcId) => { setEditingFuncId(funcId); setAggPopOpen(true) }, [])
  const closeAggregation = useCallback(() => { setAggPopOpen(false); setEditingFuncId(null) }, [])

  const [activeFields, setActiveFields] = useState(source.defaultActiveFields)
  const [filtersWidth, setFiltersWidth] = useState(FILTERS_MIN_W)
  const [graphVisible, setGraphVisible] = useState(true)
  const [myQueriesOpen, setMyQueriesOpen] = useState(false)
  const [saveQueryOpen, setSaveQueryOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [alertOpen, setAlertOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const myQueriesBtnRef = useRef(null)
  const saveQueryBtnRef = useRef(null)
  const moreRef = useRef(null)

  useEffect(() => {
    if (!moreOpen) return
    const handler = (e) => { if (!moreRef.current?.contains(e.target)) setMoreOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [moreOpen])

  // Re-running a past query means putting it back in the builder, not just
  // filtering by its text: parse it into chips so the bar shows the same
  // filters it originally ran with, and the results follow from them.
  const applyHistoryQuery = useCallback((q) => {
    const parsed = tryParseConditions(splitQuery(q).conditions)
    if (parsed.ok) {
      setChips(parsed.chips)
      setPipes([])
      setRunRequested(true)
    } else {
      setToast?.('That query could not be read back into the builder.')
    }
    setHistoryOpen(false)
  }, [setToast])

  const parsePastedQuery = useCallback((raw) => {
    const { conditions, pipes: pipeStages } = splitQuery(raw)
    const parsed = tryParseConditions(conditions)
    if (!parsed.ok) return { ok: false, error: LOOKS_LIKE_QUERY.test(raw) ? parsed.error : null }
    const pipeRes = pipeStages.length ? parsePipes(pipeStages) : null
    if (pipeRes && !pipeRes.ok && pipeRes.fatal) return { ok: false, error: pipeRes.error }
    const gotPipes = !!pipeRes?.ok && pipeRes.pipes.length > 0
    if (!parsed.chips.length && !gotPipes) return { ok: false, error: null }
    const notice = pipeRes && !pipeRes.ok
      ? `Applied the filters. The pipe section was left as it is — ${pipeRes.error}`
      : pipeRes?.unsupported?.length
        ? `Kept ${pipeRes.unsupported.map(n => `“${n}”`).join(', ')} as written — no builder control for ${pipeRes.unsupported.length > 1 ? 'those stages' : 'that stage'}.`
        : null
    return { ok: true, chips: parsed.chips, pipes: gotPipes ? pipeRes.pipes : null, notice }
  }, [])

  const applyPastedPipes = useCallback((next) => {
    setPipes(next)
    setMathPopOpen(false)
    setEditingMathId(null)
  }, [])

  // A drag on the histogram sets the app-wide range rather than keeping a
  // private zoom beside it; `zoomedFrom` is only what Reset goes back to.
  const [zoomedFrom, setZoomedFrom] = useState(null)
  const [bandHover, bandHoverProps] = useSeriesHover()
  const dragRef = useRef(null)

  const addChipToQuery = useCallback((chip) => {
    setChips(prev => prev.length === 0 ? [chip] : [...prev, { connector: 'AND', ...chip }])
  }, [])

  // A filter link in the table: narrow the results to the value clicked. It
  // narrows what is on screen, not what is being typed — the clicked row came
  // from the applied query, so the narrowed query is built from that one, and
  // the row is always kept. Built from the bar instead, an edit nobody had run
  // yet would be applied along with it, and could leave the row out. The bar
  // adopts the result and the run is requested rather than made here, the way
  // the incoming-chip path does it, so it reads the bar after the chip has
  // landed. A query that already requires this exact value is run as it stands
  // rather than given the same condition twice.
  const filterTo = useCallback((chip) => {
    const allAnd = appliedChips.every((n, i) => i === 0 || (n.connector ?? 'AND') === 'AND')
    const has = allAnd && appliedChips.some(n =>
      n.kind !== 'group' && n.field === chip.field && n.op === chip.op && n.value === chip.value)
    setChips(has ? appliedChips
      : appliedChips.length === 0 ? [chip]
        : [...appliedChips, { connector: 'AND', ...chip }])
    setPipes(appliedPipes)
    setRunRequested(true)
  }, [appliedChips, appliedPipes])

  // A filter handed in from another page — the trace view's "see the spans".
  // Replaces rather than appends, and runs itself, for the same reasons it does
  // on Logs: arriving with someone else's filters still applied is not what the
  // button promised, and a filter that lands unapplied looks like nothing
  // happened.
  //
  // Two shapes arrive. `{ chips }` is a whole query, already in the bar's own
  // vocabulary — an error group's "these spans" is five filters, not one — and
  // lands as it is. `{ concept, field, value }` is a single value that may be
  // spelled several ways, and becomes an OR across those spellings.
  useEffect(() => {
    if (!incomingChip) return
    if (Array.isArray(incomingChip.chips)) {
      setChips(incomingChip.chips)
      setRunRequested(true)
      onIncomingChipApplied?.()
      return
    }
    const spellings = ALIASES[incomingChip.concept] ?? [incomingChip.field]
    const leaves = spellings.map((field, i) => ({
      field, op: 'eq', value: incomingChip.value,
      ...(i > 0 ? { connector: 'OR' } : {}),
    }))
    setChips(leaves.length > 1 ? [newGroup(leaves)] : leaves)
    setRunRequested(true)
    onIncomingChipApplied?.()
  }, [incomingChip])   // eslint-disable-line react-hooks/exhaustive-deps

  const [pinnedFields, setPinnedFields] = useState([])
  const togglePinnedField = useCallback((field) => {
    setPinnedFields(prev => prev.includes(field) ? prev.filter(f => f !== field) : [...prev, field])
  }, [])

  const copyText = useCallback((text, message) => {
    try { navigator.clipboard.writeText(text)?.catch(() => {}) } catch (_) {}
    setToast?.(message)
  }, [setToast])

  const clearZoom = useCallback(() => {
    if (zoomedFrom) setTimeRange(zoomedFrom)
    setZoomedFrom(null)
  }, [zoomedFrom, setTimeRange])

  // Picking a range from the time control replaces whatever was dragged, so
  // there is no longer anything to reset back to.
  const wrappedSetTimeRange = useCallback((v) => {
    setZoomedFrom(null)
    setTimeRange(v)
  }, [setTimeRange])

  // Where a drag on the histogram lands: the app-wide range moves, and the
  // range it moved away from is remembered once, so Reset goes back to where
  // the reader started rather than to the previous drag.
  const focusTimeRange = useCallback((next) => {
    setZoomedFrom(cur => cur ?? timeRange)
    setTimeRange(next)
  }, [timeRange, setTimeRange])

  // The gesture itself is the shared one — see `useTimeFocus`. 'category'
  // because this is a stacked BarChart and needs the band scale.
  const focus = useTimeFocus(win, { onFocus: focusTimeRange, kind: 'category' })

  const startResize = useCallback((e) => {
    e.preventDefault()
    dragRef.current = { startX: e.clientX, startW: filtersWidth }
    const onMove = (ev) => {
      const { startX, startW } = dragRef.current
      setFiltersWidth(Math.min(FILTERS_MAX_W, Math.max(FILTERS_MIN_W, startW + (ev.clientX - startX))))
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [filtersWidth])

  const toggleFilter = (group, value) => {
    setFilters(prev => {
      const next = { ...prev }
      const set = new Set(next[group] || [])
      if (set.has(value)) set.delete(value); else set.add(value)
      next[group] = set
      return next
    })
  }

  const getSet = key => filters[key] || new Set()

  // Rows matching chips and facets but NOT the time window — the histogram is
  // built from these, so the chart keeps its shape while a zoom narrows the table.
  const chipFilteredRows = useMemo(() => {
    const active = Object.entries(filters).filter(([, set]) => set?.size)
    return spanRows.filter(s => {
      for (const [field, set] of active) {
        if (!set.has(String(s.tags[field] ?? ''))) return false
      }
      if (appliedChips.length && !applyChipsToLog(s, appliedChips, source.getValue)) return false
      return true
    })
  }, [source, spanRows, filters, appliedChips])

  const effectivePipes = useMemo(() => withImpliedCount(appliedPipes), [appliedPipes])
  const livePipes = useMemo(() => withImpliedCount(pipes), [pipes])

  const appliedStatsFunctions = useMemo(
    () => appliedPipes.filter(p => p.kind === 'stats').flatMap(p => p.functions || []),
    [appliedPipes]
  )
  const appliedGroupBy = useMemo(
    () => appliedPipes.find(p => p.kind === 'stats')?.groupBy || [],
    [appliedPipes]
  )

  const spelledQuery = useMemo(
    () => composeQuery(chipsToString(effectiveChips), livePipes),
    [effectiveChips, livePipes]
  )
  const composedQuery = spelledQuery || '*'
  const copyableQuery = spelledQuery

  // Explore speaks the reference's LogsQL and needs a `| stats` pipe to have
  // anything to plot; `toExploreLogsQuery` translates our chip dialect and
  // appends `| stats count()` when the query has no aggregation of its own
  // (ARCH D13). The bar as it stands travels, not the last run.
  //
  // A dataset Explore has no datasource for gets no entry point at all
  // (`exploreDatasource: null`): sending its query to another datasource would
  // chart that one's records under this one's field names.
  const exploreDatasource = source.exploreDatasource
  const openInExplore = useCallback(() => {
    if (!exploreDatasource) return
    onOpenLink?.({ view: 'explore', datasource: exploreDatasource, query: toExploreLogsQuery(composedQuery) })
  }, [onOpenLink, composedQuery, exploreDatasource])

  const appliedQuery = useMemo(
    () => composeQuery(chipsToString(appliedChips), effectivePipes),
    [appliedChips, effectivePipes]
  )

  const applySaved = useCallback((q) => {
    const nextChips = q.chips ?? []
    const nextPipes = q.pipes ?? []
    setChips(nextChips)
    setAppliedChips(nextChips)
    setPipes(nextPipes)
    setAppliedPipes(nextPipes)
    setMyQueriesOpen(false)
  }, [])

  const {
    saved: savedQueries, saveable: canSaveQuery, composedButUnrun,
    savedAs, updatable, note: queryNote,
    save: saveQuery, update: updateQuery, apply: applySavedQuery, remove: deleteSavedQuery,
  } = useSavedQueries({
    queryMode: 'builder',
    appliedChips, appliedPipes,
    effectiveChips, effectivePipes, livePipes,
    appliedQuery,
    stringify: chipsToString,
    examples: source.exampleQueries,
    onToast: setToast,
    onApply: applySaved,
  })

  const copyQuery = useCallback(() => {
    if (!copyableQuery) return
    try { navigator.clipboard.writeText(copyableQuery)?.catch(() => {}) } catch (_) {}
    setToast?.(livePipes.length > 0
      ? 'This query has been copied to clipboard along with pipes'
      : 'This query has been copied to clipboard')
  }, [copyableQuery, livePipes, setToast])

  const aggregateResult = useMemo(() => aggregate({
    pipes: effectivePipes,
    logs: chipFilteredRows,
    getFieldValue: source.getValue,
    now: win.end * 1000,
    timeRange: win.spanSec * 1000,
    bucketCount: Math.min(30, win.buckets.length),
  }), [source, effectivePipes, chipFilteredRows, win])

  // Scale the production-shaped baseline by per-band filtered ratios, so the
  // chart keeps a realistic silhouette while still agreeing with the filter —
  // see `filterVolume`. With nothing filtered the baseline is drawn untouched.
  const filteredVolume = useMemo(() => {
    const hasFilters = appliedChips.length > 0 || Object.values(filters).some(s => s?.size)
    if (!hasFilters) return volume
    return filterVolume({
      volume,
      bands: source.bands,
      bandOf: source.bandOf,
      win,
      allRows: spanRows,
      filteredRows: chipFilteredRows,
    })
  }, [source, chipFilteredRows, spanRows, volume, win, filters, appliedChips])

  // No time filter left to apply: the spans were read for this window.
  const filtered = chipFilteredRows
  const visibleVolume = filteredVolume

  // Tallest stacked bucket on screen - the axis gutter is sized from it.
  const volumeMax = useMemo(
    () => visibleVolume.reduce((max, d) => (d.total > max ? d.total : max), 0),
    [visibleVolume],
  )

  const [volumeWrapRef, volumeWrapWidth] = useMeasuredWidth()
  const streamScroll = useHeaderScrollSync()

  const volumeYAxis = useMemo(
    () => valueAxisProps({ format: fmtCount, allowDecimals: false, maxValue: volumeMax }),
    [volumeMax],
  )

  // The ladder is budgeted against the PLOT rather than the card, so the value
  // gutter and the right margin come off the measured width before the tick
  // interval is chosen.
  const volumeAxis = useMemo(
    () => buildTimeAxis(win, {
      width: Math.max(0, volumeWrapWidth - volumeYAxis.width - VOLUME_MARGIN.right),
      kind: 'category',
    }),
    [win, volumeWrapWidth, volumeYAxis.width],
  )

  const visibleTotals = useMemo(() => {
    const totals = { total: visibleVolume.reduce((a, b) => a + b.total, 0) }
    for (const { key } of source.bands) totals[key] = visibleVolume.reduce((a, b) => a + b[key], 0)
    return totals
  }, [source, visibleVolume])

  const selected = selectedId ? filtered.find(r => r.id === selectedId) : null
  const selectedIndex = selectedId ? filtered.findIndex(r => r.id === selectedId) : -1

  const columns = useMemo(() => source.columnsFor(activeFields), [source, activeFields])

  const openTrace = useCallback((id) => {
    if (onOpenTrace) onOpenTrace(id)
    else onOpenLink?.({ view: 'traces', traceId: id })
  }, [onOpenTrace, onOpenLink])

  return (
    <>
      <PageBar
        timeRange={timeRange}
        setTimeRange={wrappedSetTimeRange}
        actions={
          <div className="query-actions">
            <button
              ref={saveQueryBtnRef}
              className={`pipe-btn sq-save${savedAs ? ' is-saved' : ''}${saveQueryOpen ? ' is-active' : ''}`}
              disabled={!canSaveQuery || !!savedAs}
              title={savedAs
                ? `Saved as “${savedAs.name}”`
                : canSaveQuery
                  ? 'Save query'
                  : composedButUnrun
                    ? 'Run the query first — saving keeps the one you have run'
                    : 'Add a filter or a pipe first — there is nothing to save yet'}
              aria-label={savedAs ? `Saved as ${savedAs.name}` : 'Save query'}
              onClick={() => setSaveQueryOpen(o => !o)}
            >
              {savedAs ? <BookmarkCheck strokeWidth={2} /> : <BookmarkPlus strokeWidth={2} />}
              {savedAs ? 'Saved' : 'Save Query'}
            </button>
            <button
              ref={myQueriesBtnRef}
              className={`pipe-btn${myQueriesOpen ? ' is-active' : ''}`}
              onClick={() => setMyQueriesOpen(true)}
            >
              <List strokeWidth={2} />
              My Queries
            </button>
          </div>
        }
      >
        <a onClick={goHome}>CubeAPM</a>
        <span className="sep">/</span>
        <span className="current">{source.title}</span>
      </PageBar>

      <div className="logs-layout logs-layout-stitched" style={{ gridTemplateColumns: `${filtersWidth}px 1fr` }}>
        <div className="logs-filters">
          <div className="logs-filters-head">
            <span>Filters</span>
            {Object.values(filters).some(s => s?.size) && (
              <button className="logs-filters-clear" onClick={() => setFilters({})}>Clear all</button>
            )}
          </div>
          <div className="logs-filters-scroll">
            {spanFacetFields.map(field => (
              <FacetGroup
                key={field}
                title={field}
                options={spanFacets[field]}
                selected={getSet(field)}
                onToggle={toggleFilter}
              />
            ))}
          </div>
          <div
            className="logs-filters-resize"
            onMouseDown={startResize}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize filters panel"
          />
        </div>

        <div className="logs-main">
          <div className="logs-main-body">
            <div className="logs-query-bar">
              <QueryBuilder
                chips={chips}
                setChips={setChips}
                recents={recents}
                addRecent={addRecent}
                savedQueries={savedQueries}
                exampleQueries={source.exampleQueries}
                onRun={runQuery}
                onBlockedChange={setBuilderBlocked}
                onCopyQuery={copyableQuery ? copyQuery : null}
                parsePastedQuery={parsePastedQuery}
                onApplyPipes={applyPastedPipes}
                fieldCatalog={source.fieldCatalog}
                rows={spanRows}
                getValue={source.getValue}
                placeholder={source.placeholder}
                freeTextNoun={source.freeTextNoun}
                freeTextMeta={source.freeTextMeta}
              />
              <button className="hbtn small icon-only" title="Query history" aria-label="Query history" onClick={() => setHistoryOpen(true)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/></svg>
              </button>
              <button
                className={`hbtn primary run-btn${queryDirty && !runBlocked && !isRunning ? ' is-dirty' : ''}${isRunning ? ' is-running' : ''}`}
                title={runBlocked || (isRunning ? 'Running…' : queryDirty ? 'Run query — the bar has changes the results do not show yet' : 'Run query')}
                aria-label={isRunning ? 'Running query' : 'Run query'}
                disabled={!!runBlocked || isRunning}
                onClick={() => { addRecent(chips); runQuery() }}
              >
                {isRunning ? (
                  <svg className="run-spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 3a9 9 0 1 0 9 9"/></svg>
                ) : (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 01-4 4H4"/></svg>
                )}
                Run
              </button>
              <div className="logs-more-wrap" ref={moreRef}>
                <button
                  className="hbtn small icon-only"
                  title="More actions"
                  aria-label="More actions"
                  aria-haspopup="menu"
                  aria-expanded={moreOpen}
                  onClick={() => setMoreOpen(o => !o)}
                >
                  <svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg>
                </button>
                {moreOpen && (
                  <div className="logs-more-menu" role="menu">
                    <button role="menuitem" className="logs-more-item" onClick={() => { downloadCSV(filtered, source.csvColumns, source.csvPrefix); setMoreOpen(false) }}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                      Download CSV
                    </button>
                    <button role="menuitem" className="logs-more-item" onClick={() => { setAlertOpen(true); setMoreOpen(false) }}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 10a6 6 0 1112 0c0 5 2 6 2 6H4s2-1 2-6"/><path d="M10 20a2 2 0 004 0"/><line x1="12" y1="2" x2="12" y2="4"/></svg>
                      Create Alert
                    </button>
                    {exploreDatasource && (
                      <button role="menuitem" className="logs-more-item" onClick={() => { openInExplore(); setMoreOpen(false) }}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><path d="M16 8l-2.4 5.6L8 16l2.4-5.6z"/></svg>
                        Open in Explore
                      </button>
                    )}
                    {source.docsUrl && (
                      <a
                        role="menuitem"
                        className="logs-more-item"
                        href={source.docsUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={() => setMoreOpen(false)}
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                        Learn about Querying
                      </a>
                    )}
                  </div>
                )}
              </div>
            </div>

            {queryNote && (
              <div className="logs-query-note">
                <Bookmark className="logs-query-note-icon" strokeWidth={2} aria-hidden="true" />
                <span className="logs-query-note-name">{queryNote.name}</span>
                {queryNote.description && (
                  <span className="logs-query-note-desc" title={queryNote.description}>
                    {truncate(queryNote.description, NOTE_DESC_MAX)}
                  </span>
                )}
              </div>
            )}

            <div className="pipe-toolbar">
              <PipePill
                ref={groupByPillRef}
                icon={<Network />}
                label="Group by"
                active={groupByPopOpen}
                onAddClick={() => setGroupByPopOpen(o => !o)}
              >
                {groupBy.map(field => (
                  <PipePillChip
                    key={field}
                    title={`Grouping by ${field}`}
                    onRemove={() => setGroupBy(prev => prev.filter(f => f !== field))}
                  >
                    {field}
                  </PipePillChip>
                ))}
              </PipePill>
              <PipePill
                ref={aggPillRef}
                icon={<Sigma />}
                label="Aggregation"
                active={aggPopOpen}
                onAddClick={openCreateAggregation}
              >
                {statsFunctions.map(fn => (
                  <PipePillChip
                    key={fn.id}
                    title={fullFn(fn)}
                    active={editingFuncId === fn.id && aggPopOpen}
                    onClick={() => openEditAggregation(fn.id)}
                    onRemove={() => removeAggregation(fn.id)}
                  >
                    {summarizeFn(fn)}
                  </PipePillChip>
                ))}
              </PipePill>
              <PipePill
                ref={mathPillRef}
                icon={<Calculator />}
                label="Math"
                active={mathPopOpen && !editingMathId}
                onAddClick={openCreateMath}
              >
                {mathPipes.map(mp => (
                  <PipePillChip
                    key={mp.id}
                    title={mp.expression + (mp.as ? ` as ${mp.as}` : '')}
                    active={editingMathId === mp.id && mathPopOpen}
                    onClick={() => openEditMath(mp.id)}
                    onRemove={() => removePipeById(mp.id)}
                  >
                    {mp.as || mp.expression || 'expr'}
                  </PipePillChip>
                ))}
              </PipePill>
              <PipePill
                ref={orderPillRef}
                icon={<ArrowUpDown />}
                label="Order"
                active={orderPopOpen}
                addAffordance={sortPipe ? 'chevron' : 'plus'}
                onAddClick={() => setOrderPopOpen(o => !o)}
              >
                {sortPipe && (
                  <PipePillChip
                    title={`Sort by ${sortPipe.field || '…'} ${sortPipe.dir === 'asc' ? 'ascending' : 'descending'}`}
                    onClick={() => setOrderPopOpen(true)}
                    onRemove={() => removePipeById(sortPipe.id)}
                  >
                    {sortPipe.field || '…'} {sortPipe.dir === 'asc' ? '↑' : '↓'}
                  </PipePillChip>
                )}
              </PipePill>
              <PipePill
                ref={limitPillRef}
                icon={<Hash />}
                label="Limit"
                active={limitPopOpen}
                addAffordance={limitPipe ? 'chevron' : 'plus'}
                onAddClick={() => setLimitPopOpen(o => !o)}
              >
                {limitPipe && (
                  <PipePillChip
                    title={`Return at most ${Number(limitPipe.n).toLocaleString()} rows`}
                    onClick={() => setLimitPopOpen(true)}
                    onRemove={() => removePipeById(limitPipe.id)}
                  >
                    {Number(limitPipe.n).toLocaleString()}
                  </PipePillChip>
                )}
              </PipePill>
            </div>

            <SaveQueryPopover
              anchorRef={saveQueryBtnRef}
              open={saveQueryOpen}
              onClose={() => setSaveQueryOpen(false)}
              onSave={saveQuery}
              preview={appliedQuery || '*'}
              existingNames={savedQueries.map(q => q.name)}
              origin={updatable}
              onUpdate={updateQuery}
              previousQuery={updatable
                ? composeQuery(chipsToString(updatable.chips ?? []), withImpliedCount(updatable.pipes ?? []))
                : null}
            />
            <AggregationPopover
              anchorRef={aggPillRef}
              open={aggPopOpen}
              onClose={closeAggregation}
              onSave={upsertAggregation}
              initial={editingFunc}
              allFields={aggAllFields}
              numericFields={aggNumericFields}
            />
            <GroupByPopover
              anchorRef={groupByPillRef}
              open={groupByPopOpen}
              onClose={() => setGroupByPopOpen(false)}
              fields={source.fieldCatalog}
              selected={groupBy}
              onChange={setGroupBy}
            />
            <OrderPopover
              anchorRef={orderPillRef}
              open={orderPopOpen}
              onClose={() => setOrderPopOpen(false)}
              pipe={sortPipe}
              onChange={(patch) => setPipes(prev => {
                const idx = prev.findIndex(p => p.kind === 'sort')
                if (idx === -1) return [...prev, newSortPipe({ field: '', dir: 'desc', ...patch })]
                const next = [...prev]
                next[idx] = { ...next[idx], ...patch }
                return next
              })}
              onRemove={() => setPipes(prev => prev.filter(p => p.kind !== 'sort'))}
              fieldOptions={orderFieldOptions}
            />
            <LimitPopover
              anchorRef={limitPillRef}
              open={limitPopOpen}
              onClose={() => setLimitPopOpen(false)}
              pipe={limitPipe}
              onChange={(patch) => setPipes(prev => {
                const idx = prev.findIndex(p => p.kind === 'limit')
                if (idx === -1) return [...prev, newLimitPipe({ n: 100, ...patch })]
                const next = [...prev]
                next[idx] = { ...next[idx], ...patch }
                return next
              })}
              onRemove={() => setPipes(prev => prev.filter(p => p.kind !== 'limit'))}
            />
            <MathPopover
              anchorRef={mathPillRef}
              open={mathPopOpen}
              onClose={closeMath}
              onSave={upsertMathPipe}
              initial={editingMath}
              availableNames={mathAvailableNames}
            />

            <div className="logs-query-preview">
              <span className="qb-preview-label">Generated Query</span>
              <code className="qb-preview-code">{composedQuery}</code>
            </div>

            <div className="logs-controls">
              <div className="logs-controls-left">
                <button className={`hbtn small${!graphVisible ? ' brand-lit' : ''}`} onClick={() => setGraphVisible(v => !v)} title={graphVisible ? 'Hide graph' : 'Show graph'}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="13" width="4" height="8" rx="1"/><rect x="10" y="8" width="4" height="13" rx="1"/><rect x="18" y="3" width="4" height="18" rx="1"/></svg>
                  {graphVisible ? 'Hide graph' : 'Show graph'}
                </button>
                <FieldsDropdown fields={source.allFields} activeFields={activeFields} setActiveFields={setActiveFields} />
                <div className="live-toggle">
                  <button
                    className={`live-btn${live === 'on' ? ' active' : live === 'pause' ? ' paused' : ''}`}
                    onClick={() => setLive(live === 'off' ? 'on' : 'off')}
                    title={live === 'off' ? 'Start live stream' : 'Stop live stream'}
                  >
                    <span className={`live-dot${live === 'on' ? ' on' : live === 'pause' ? ' paused' : ''}`} />
                    {live === 'off' ? 'Live' : live === 'on' ? 'Live' : 'Paused'}
                  </button>
                  {live !== 'off' && (
                    <button
                      className="live-action-btn"
                      onClick={() => setLive(live === 'on' ? 'pause' : 'on')}
                      title={live === 'on' ? 'Pause live stream' : 'Resume live stream'}
                    >
                      {live === 'on' ? (
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
                      ) : (
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>
                      )}
                    </button>
                  )}
                </div>
              </div>
              <div className="logs-controls-right">
                <span className="span-count">{filtered.length.toLocaleString()} {filtered.length === 1 ? source.noun.one : source.noun.many}</span>
                <button className="hbtn small" onClick={() => downloadCSV(filtered, source.csvColumns, source.csvPrefix)} title="Download as CSV">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                  CSV
                </button>
                <button className="hbtn small" onClick={() => setAlertOpen(true)} title="Create alert from this query">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 10a6 6 0 1112 0c0 5 2 6 2 6H4s2-1 2-6"/><path d="M10 20a2 2 0 004 0"/><line x1="12" y1="2" x2="12" y2="4"/></svg>
                  Alert
                </button>
                {exploreDatasource && (
                  <button className="hbtn small" onClick={openInExplore} title="Chart this query in Explore">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><path d="M16 8l-2.4 5.6L8 16l2.4-5.6z"/></svg>
                    Explore
                  </button>
                )}
              </div>
            </div>

            {queryState.status === 'error' && (
              <div className="logs-query-error" role="alert">
                <AlertCircle size={14} strokeWidth={2} />
                <span className="logs-query-error-msg">{queryState.error}</span>
                <button type="button" className="logs-query-retry" onClick={runQuery}>Try again</button>
                <button
                  type="button"
                  className="logs-query-error-x"
                  onClick={() => setQueryState({ status: 'idle', error: null })}
                  aria-label="Dismiss"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
                </button>
              </div>
            )}

            <div className={`logs-results${isRunning ? ' is-stale' : ''}`} aria-busy={isRunning}>
              {appliedStatsFunctions.length === 0 && appliedGroupBy.length === 0 ? (<>
                {graphVisible && <div className="logs-volume">
                  <div className="logs-volume-chart">
                    {zoomedFrom && (
                      <button className="volume-reset-btn" onClick={clearZoom} title="Clear time selection">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
                        Reset zoom
                      </button>
                    )}
                    {!zoomedFrom && <div className="volume-brush-hint">Click &amp; drag on chart to zoom in</div>}
                    <div ref={volumeWrapRef} style={{ width: '100%', height: '100%' }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart
                          data={visibleVolume}
                          margin={VOLUME_MARGIN}
                          {...focus.chartProps}
                        >
                          <CartesianGrid {...GRID_PROPS} />
                          <XAxis {...volumeAxis.props} />
                          <YAxis {...volumeYAxis} />
                          <Tooltip content={p => <VolumeTooltip {...p} series={legendSeries} nowMs={win.end * 1000} hoverKey={bandHover} suppressed={!focus.hovered} />} cursor={{ fill: 'rgba(255,255,255,0.02)' }} isAnimationActive={false} />
                          {volumeSeries.map(s => (
                            <Bar key={s.key} dataKey={s.key} stackId="v" fill={s.color} fillOpacity={s.opacity} isAnimationActive={false} {...bandHoverProps(s.key)} />
                          ))}
                          {focus.overlay}
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                  <div className="logs-volume-legend">
                    <div className="lvl-row"><span className="lvl-key">Total</span><span className="lvl-val">{compactCount(visibleTotals.total)}</span></div>
                    {legendSeries.map(s => (
                      <div key={s.key} className="lvl-row" title={s.desc}>
                        <span className="lvl-swatch" style={{ background: s.color }} />
                        <span className="lvl-key">{s.label}</span>
                        <span className={`lvl-val${BAND_VALUE_CLASS[s.status] ?? ''}`}>{compactCount(visibleTotals[s.key])}</span>
                      </div>
                    ))}
                  </div>
                </div>}

                <div className="logs-stream-head-scroll" ref={streamScroll.headRef} onWheel={streamScroll.onHeadWheel}>
                  <div className="logs-stream-head span-head">
                    <div className="log-fixed-cols">
                      <span className="lh-bar-spacer" />
                      <span className="lh-time">Time</span>
                    </div>
                    {columns.map(c => (
                      <span
                        key={c.key}
                        className={`span-cell${c.grow ? ' grow' : ''}${c.align === 'right' ? ' right' : ''}`}
                        style={{ width: c.width }}
                      >
                        {c.label}
                      </span>
                    ))}
                  </div>
                </div>

                <div className="logs-stream-wrap">
                  <div className="logs-stream" data-log-content ref={streamScroll.bodyRef} onScroll={streamScroll.onBodyScroll}>
                    {filtered.length === 0 && (
                      <div className="err-empty">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="10"/></svg>
                        <div>{source.emptyText}</div>
                      </div>
                    )}
                    {filtered.map(row => (
                      <div
                        key={row.id}
                        className={`log-row span-row${selectedId === row.id ? ' selected' : ''}`}
                        onClick={() => { if (window.getSelection()?.isCollapsed !== false) setSelectedId(row.id) }}
                      >
                        <div className="log-fixed-cols">
                          <span className={`log-lvl-bar span-bar-${source.statusForRow(row)}`} />
                          <span className="log-time">
                            <span className="log-date">{row.dateStr}</span>
                            <span className="log-hhmm">{row.timeStr}</span>
                          </span>
                        </div>
                        {columns.map(c => (
                          <SpanCell key={c.key} col={c} row={row} source={source} onOpenTrace={openTrace} onFilter={filterTo} />
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
              </>) : (
                <AggregateResults result={aggregateResult} graphVisible={graphVisible} />
              )}
            </div>
          </div>

          {selected && (
            <LogRecordDrawer
              record={selected}
              onClose={() => setSelectedId(null)}
              searchTerms={[]}
              onAddChip={addChipToQuery}
              onOpenLink={onOpenLink}
              onCopy={copyText}
              index={selectedIndex}
              total={filtered.length}
              onNavigate={(i) => { const r = filtered[i]; if (r) setSelectedId(r.id) }}
              pinned={pinnedFields}
              onTogglePin={togglePinnedField}
              badge={source.badgeFor(selected)}
              traceList={source.title}
            />
          )}
        </div>
      </div>

      {alertOpen && (
        <AlertDrawer
          filters={filters}
          query={appliedQuery}
          onClose={() => setAlertOpen(false)}
          emptyLabel={source.alertEmptyLabel}
          namePlaceholder={source.alertNamePlaceholder}
        />
      )}
      {historyOpen && (
        <QueryHistoryDrawer
          history={source.queryHistory}
          subject="workspace"
          onClose={() => setHistoryOpen(false)}
          onApply={applyHistoryQuery}
        />
      )}
      {myQueriesOpen && (
        <MyQueriesDrawer
          onClose={() => setMyQueriesOpen(false)}
          saved={savedQueries}
          onApply={applySavedQuery}
          onDelete={deleteSavedQuery}
        />
      )}
    </>
  )
}
