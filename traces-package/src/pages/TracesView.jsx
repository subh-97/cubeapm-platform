import { useState, useMemo, useRef, useCallback, useEffect } from 'react'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceArea, ResponsiveContainer } from 'recharts'
import { spanRows, spanVolume, spanFacets, spanFacetFields } from '@/data/tracesExplorer'
import { BASE_TIME } from '@/data/observability'
import PageBar from '@/components/layout/PageBar'
import QueryBuilder, { applyChipsToLog, chipsToString } from '@/components/QueryBuilder'
import FacetGroup from '@/components/explorer/FacetGroup'
import FieldsDropdown from '@/components/explorer/FieldsDropdown'
import { newGroup } from '@/utils/queryTree'
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
import { Sigma, Network, ArrowUpDown, Hash, Calculator, AlertCircle, Bookmark, BookmarkPlus, BookmarkCheck, List } from 'lucide-react'
import { ALIASES } from '@/utils/logFields'
import { LogRecordDrawer } from '@/components/LogRecordDrawer'
import QueryHistoryDrawer from '@/components/explorer/QueryHistoryDrawer'
import AlertDrawer from '@/components/explorer/AlertDrawer'
import {
  TRACE_FIELD_CATALOG, getSpanFieldValue, SPAN_ALL_FIELDS, DEFAULT_ACTIVE_FIELDS,
  columnsFor, formatSpanDuration, statusForSpan,
} from '@/utils/traceFields'

const AGG_ALL_FIELDS = TRACE_FIELD_CATALOG.map(f => f.field)
const AGG_NUMERIC_FIELDS = new Set(TRACE_FIELD_CATALOG.filter(f => f.type === 'keyword').map(f => f.field))

const FILTERS_MIN_W = 232
const FILTERS_MAX_W = Math.round(FILTERS_MIN_W * 1.6)
const NOTE_DESC_MAX = 100

// Separates "a malformed query worth explaining" from "a plain value that
// happens not to parse". Only the former earns an error on paste.
const LOOKS_LIKE_QUERY = /[:(]|!=|!~|\s(?:AND|OR|in|not_in)\s/i

// Example queries offered in the bar's saved list. Traces get their own set —
// the log examples are written about fields a span does not have.
const TRACE_SAVED_QUERIES = [
  { id: 'tq1', name: 'Failing spans', chips: [{ field: 'status_code', op: 'eq', value: 'ERROR' }] },
  { id: 'tq2', name: 'Failing server spans', chips: [
    { field: 'span_kind', op: 'eq', value: 'server' },
    { field: 'status_code', op: 'eq', value: 'ERROR', connector: 'AND' },
  ] },
  { id: 'tq3', name: 'Database calls', chips: [{ field: 'category', op: 'eq', value: 'db' }] },
  { id: 'tq4', name: 'Span events only', chips: [{ field: 'event.domain', op: 'eq', value: 'span_event' }] },
]

// Recent queries, in the traces vocabulary. A log query offered here would be
// one that cannot run against spans, so the two pages keep separate histories.
const QUERY_HISTORY = (() => {
  const now = BASE_TIME.getTime()
  return [
    { id: 1, query: 'status_code:=ERROR AND span_kind:=server', time: new Date(now - 6 * 60000), results: 142 },
    { id: 2, query: 'service:=payment-service AND category:=db', time: new Date(now - 21 * 60000), results: 318 },
    { id: 3, query: 'http.status_code:5*', time: new Date(now - 48 * 60000), results: 96 },
    { id: 4, query: 'db.system:=redis AND cache.hit:=false', time: new Date(now - 1.4 * 3600000), results: 57 },
    { id: 5, query: 'event.domain:=span_event AND event_name:=exception', time: new Date(now - 2.2 * 3600000), results: 74 },
    { id: 6, query: 'span_name:"POST /v1/shipment"', time: new Date(now - 3.5 * 3600000), results: 210 },
    { id: 7, query: 'exception.type:=java.lang.RuntimeException', time: new Date(now - 5 * 3600000), results: 61 },
    { id: 8, query: 'shipment.carrier:=fedex AND status_code:=ERROR', time: new Date(now - 9 * 3600000), results: 18 },
    { id: 9, query: 'net.peer.name:=api.twilio.com', time: new Date(now - 14 * 3600000), results: 133 },
    { id: 10, query: 'span_kind:=client AND category:=http', time: new Date(now - 26 * 3600000), results: 402 },
  ]
})()

// Span status is the one dimension of a span that is a severity rather than an
// identity, so the bars use the same red/green the rest of the product reserves
// for severity. Span events get the neutral tone: they are rows in this table
// too — leaving them out would make the chart disagree with the row count under
// it — but they carry no status of their own to colour.
const VOLUME_SERIES = [
  { key: 'unset', label: 'UNSET', color: '#22C55E', opacity: 0.6 },
  { key: 'event', label: 'span_event', color: '#616C86', opacity: 0.65 },
  { key: 'error', label: 'ERROR', color: '#EF4444', opacity: 0.85 },
]

function VolumeTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  const rec = payload[0]?.payload
  if (!rec) return null
  return (
    <div style={{ background: 'var(--raised)', border: '1px solid var(--border-panel)', borderRadius: 6, padding: '6px 10px', fontSize: 11, minWidth: 150 }}>
      <div style={{ color: 'var(--text-primary)', fontWeight: 600, marginBottom: 4 }}>{label}</div>
      {[...VOLUME_SERIES].reverse().map(s => (
        <div key={s.key} style={{ color: s.color, display: 'flex', justifyContent: 'space-between', gap: 12 }}>
          <span>{s.label}</span><span style={{ fontWeight: 600 }}>{rec[s.key]?.toLocaleString()}</span>
        </div>
      ))}
      <div style={{ borderTop: '1px solid var(--border-panel)', marginTop: 5, paddingTop: 5, color: 'var(--text-primary)', fontWeight: 600, display: 'flex', justifyContent: 'space-between', gap: 12 }}>
        <span>total</span><span>{rec.total?.toLocaleString()}</span>
      </div>
    </div>
  )
}

function presetToMinutes(tr) {
  const map = {
    'Last 5 minutes': 5, 'Last 15 minutes': 15, 'Last 30 minutes': 30,
    'Last 1 hour': 60, 'Last 2 hours': 120, 'Last 3 hours': 180,
    'Last 6 hours': 360, 'Last 12 hours': 720, 'Last 24 hours': 1440,
    'Last 2 days': 2880, 'Last 3 days': 4320, 'Last 7 days': 10080,
  }
  if (tr === 'Today' || tr === 'Today so far') {
    const now = BASE_TIME
    const sod = new Date(now); sod.setHours(0, 0, 0, 0)
    return Math.round((now - sod) / 60000)
  }
  return map[tr] ?? null
}

function compactCount(n) {
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

function downloadCSV(rows) {
  const cols = ['time', 'service', 'span_name', 'span_kind', 'duration', 'status_code', 'trace_id', 'span_id']
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
  a.href = url; a.download = `traces-${Date.now()}.csv`; a.click()
  URL.revokeObjectURL(url)
}

/** One cell of the span table. Only three columns are more than their text. */
function SpanCell({ col, row, onOpenTrace }) {
  const raw = row.tags[col.key]
  if (col.key === 'duration') {
    return <span className="span-cell span-dur mono" style={{ width: col.width }}>{formatSpanDuration(raw)}</span>
  }
  if (col.key === 'status_code') {
    // A span event has no status, which is a different statement from UNSET.
    // Rendering the blank as a dash rather than nothing keeps the column
    // readable as a column instead of looking like a rendering failure.
    const status = statusForSpan(raw)
    return (
      <span className="span-cell" style={{ width: col.width }}>
        {raw
          ? <span className={`span-status status-${status}`} data-log-field="status_code" data-log-value={raw}>{raw}</span>
          : <span className="span-empty">—</span>}
      </span>
    )
  }
  if (col.key === 'trace_id') {
    // The one value on the row that leads somewhere else: the waterfall for the
    // whole request this span belongs to.
    return (
      <span className="span-cell mono" style={{ width: col.width }}>
        <button
          type="button"
          className="span-trace-link"
          title={`Open trace ${raw}`}
          onClick={(e) => { e.stopPropagation(); onOpenTrace(raw) }}
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

/**
 * Traces explorer.
 *
 * Deliberately the same surface as Logs — same rail, same query bar, same pipe
 * toolbar, same record drawer — because they are the same activity performed on
 * a different record. What changes is the vocabulary (spans, not lines), the
 * severity dimension the chart stacks by, and the table: a log line is one
 * blob of text, a span is a fixed set of columns, so this one is a real table
 * rather than a stream.
 */
export default function TracesView({ goHome, timeRange, setTimeRange, setToast, onOpenLink, onOpenTrace, incomingChip, onIncomingChipApplied }) {
  const [filters, setFilters] = useState({})
  const [selectedId, setSelectedId] = useState(null)
  const [chips, setChips] = useState([])
  const [runRequested, setRunRequested] = useState(false)
  const [recents, setRecents] = useState([
    [{ field: 'status_code', op: 'eq', value: 'ERROR' }],
    [{ field: 'span_kind', op: 'eq', value: 'server' }],
    [{ field: 'service', op: 'eq', value: 'payment-service' }],
  ])
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

  const [activeFields, setActiveFields] = useState(DEFAULT_ACTIVE_FIELDS)
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

  const [zoom, setZoom] = useState(null)
  const [dragBrush, setDragBrush] = useState(null)
  const dragRef = useRef(null)
  const brushStartRef = useRef(null)
  const prevTimeRangeRef = useRef(timeRange)

  const addChipToQuery = useCallback((chip) => {
    setChips(prev => prev.length === 0 ? [chip] : [...prev, { connector: 'AND', ...chip }])
  }, [])

  // A filter handed in from another page — the trace view's "see the spans".
  // Replaces rather than appends, and runs itself, for the same reasons it does
  // on Logs: arriving with someone else's filters still applied is not what the
  // button promised, and a filter that lands unapplied looks like nothing
  // happened.
  useEffect(() => {
    if (!incomingChip) return
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
    if (zoom && prevTimeRangeRef.current) setTimeRange(prevTimeRangeRef.current)
    setZoom(null)
  }, [zoom, setTimeRange])

  const wrappedSetTimeRange = useCallback((v) => {
    if (!v?.startsWith?.('Custom')) prevTimeRangeRef.current = v
    setZoom(null)
    setTimeRange(v)
  }, [setTimeRange])

  useEffect(() => {
    if (!zoom) return
    const span = zoom.m1 - zoom.m2 + 1
    const spanLabel = span === 1 ? '1 min' : `${span} min`
    const fromLabel = zoom.m1 === 0 ? 'now' : `-${zoom.m1}m`
    const toLabel = zoom.m2 === 0 ? 'now' : `-${zoom.m2}m`
    setTimeRange(`Custom · ${fromLabel} → ${toLabel} (${spanLabel})`)
  }, [zoom, setTimeRange])

  useEffect(() => {
    const onUp = () => {
      if (!brushStartRef.current) return
      brushStartRef.current = null
      setDragBrush(prev => {
        if (prev && prev.s1 !== prev.s2) {
          const b1 = spanVolume.find(d => d.label === prev.s1)
          const b2 = spanVolume.find(d => d.label === prev.s2)
          if (b1 && b2) setZoom({ m1: Math.max(b1.m, b2.m), m2: Math.min(b1.m, b2.m) })
        }
        return null
      })
    }
    document.addEventListener('mouseup', onUp)
    return () => document.removeEventListener('mouseup', onUp)
  }, [])

  const onChartMouseDown = (e) => {
    if (!e?.activeLabel) return
    brushStartRef.current = e.activeLabel
    setDragBrush({ s1: e.activeLabel, s2: e.activeLabel })
  }
  const onChartMouseMove = (e) => {
    if (!brushStartRef.current || !e?.activeLabel) return
    setDragBrush(prev => (prev && prev.s2 === e.activeLabel ? prev : { s1: brushStartRef.current, s2: e.activeLabel }))
  }

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
      if (appliedChips.length && !applyChipsToLog(s, appliedChips, getSpanFieldValue)) return false
      return true
    })
  }, [filters, appliedChips])

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
    examples: TRACE_SAVED_QUERIES,
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
    getFieldValue: getSpanFieldValue,
    now: BASE_TIME.getTime(),
    timeRange: 60 * 60 * 1000,
    bucketCount: 30,
  }), [effectivePipes, chipFilteredRows])

  // Scale the production-shaped baseline by per-band filtered ratios, so the
  // chart keeps a realistic silhouette while still agreeing with the filter.
  // With nothing filtered every ratio is 1 and the baseline is untouched.
  const filteredVolume = useMemo(() => {
    const hasFilters = appliedChips.length > 0 || Object.values(filters).some(s => s?.size)
    if (!hasFilters) return spanVolume

    const bandOf = (r) => r.tags['event.domain'] === 'span_event'
      ? 'event'
      : r.statusCode === 'ERROR' ? 'error' : 'unset'

    const now = BASE_TIME.getTime()
    const allByMin = {}, filtByMin = {}
    const bucket = (acc, r) => {
      const m = Math.floor((now - r.time.getTime()) / 60000)
      if (m >= 0 && m < 60) {
        if (!acc[m]) acc[m] = { unset: 0, event: 0, error: 0 }
        acc[m][bandOf(r)]++
      }
    }
    spanRows.forEach(r => bucket(allByMin, r))
    chipFilteredRows.forEach(r => bucket(filtByMin, r))

    return spanVolume.map(d => {
      const all = allByMin[d.m]
      if (!all) return { ...d, unset: 0, event: 0, error: 0, total: 0 }
      const filt = filtByMin[d.m] || { unset: 0, event: 0, error: 0 }
      const scale = k => (all[k] > 0 ? Math.round(d[k] * filt[k] / all[k]) : 0)
      const unset = scale('unset'), event = scale('event'), error = scale('error')
      return { ...d, unset, event, error, total: unset + event + error }
    })
  }, [chipFilteredRows, filters, appliedChips])

  const filtered = useMemo(() => {
    let rows = chipFilteredRows
    if (zoom) {
      const now = BASE_TIME.getTime()
      const tMin = now - (zoom.m1 + 1) * 60000
      const tMax = now - zoom.m2 * 60000
      rows = rows.filter(r => r.time.getTime() >= tMin && r.time.getTime() <= tMax)
    } else {
      const mins = presetToMinutes(timeRange)
      if (mins !== null) {
        const cutoff = BASE_TIME.getTime() - mins * 60000
        rows = rows.filter(r => r.time.getTime() >= cutoff)
      }
    }
    return rows
  }, [chipFilteredRows, zoom, timeRange])

  const visibleVolume = useMemo(() => {
    if (zoom) return filteredVolume.filter(d => d.m >= zoom.m2 && d.m <= zoom.m1)
    const mins = presetToMinutes(timeRange)
    if (mins !== null) return filteredVolume.filter(d => d.m <= mins)
    return filteredVolume
  }, [zoom, timeRange, filteredVolume])

  const visibleTotals = useMemo(() => ({
    total: visibleVolume.reduce((a, b) => a + b.total, 0),
    unset: visibleVolume.reduce((a, b) => a + b.unset, 0),
    event: visibleVolume.reduce((a, b) => a + b.event, 0),
    error: visibleVolume.reduce((a, b) => a + b.error, 0),
  }), [visibleVolume])

  const selected = selectedId ? filtered.find(r => r.id === selectedId) : null
  const selectedIndex = selectedId ? filtered.findIndex(r => r.id === selectedId) : -1

  const columns = useMemo(() => columnsFor(activeFields), [activeFields])

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
        <span className="current">Traces</span>
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
                onRun={runQuery}
                onBlockedChange={setBuilderBlocked}
                onCopyQuery={copyableQuery ? copyQuery : null}
                parsePastedQuery={parsePastedQuery}
                onApplyPipes={applyPastedPipes}
                fieldCatalog={TRACE_FIELD_CATALOG}
                rows={spanRows}
                valueOf={getSpanFieldValue}
                placeholder="Type a field name (e.g. service, span_name, duration) or free text"
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
                    <button role="menuitem" className="logs-more-item" onClick={() => { downloadCSV(filtered); setMoreOpen(false) }}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                      Download CSV
                    </button>
                    <button role="menuitem" className="logs-more-item" onClick={() => { setAlertOpen(true); setMoreOpen(false) }}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 10a6 6 0 1112 0c0 5 2 6 2 6H4s2-1 2-6"/><path d="M10 20a2 2 0 004 0"/><line x1="12" y1="2" x2="12" y2="4"/></svg>
                      Create Alert
                    </button>
                    <a
                      role="menuitem"
                      className="logs-more-item"
                      href="https://docs.cubeapm.com/traces/querying"
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={() => setMoreOpen(false)}
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                      Learn about Querying
                    </a>
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
              allFields={AGG_ALL_FIELDS}
              numericFields={AGG_NUMERIC_FIELDS}
            />
            <GroupByPopover
              anchorRef={groupByPillRef}
              open={groupByPopOpen}
              onClose={() => setGroupByPopOpen(false)}
              fields={TRACE_FIELD_CATALOG}
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
                <FieldsDropdown fields={SPAN_ALL_FIELDS} activeFields={activeFields} setActiveFields={setActiveFields} />
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
                <span className="span-count">{filtered.length.toLocaleString()} spans</span>
                <button className="hbtn small" onClick={() => downloadCSV(filtered)} title="Download as CSV">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                  CSV
                </button>
                <button className="hbtn small" onClick={() => setAlertOpen(true)} title="Create alert from this query">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 10a6 6 0 1112 0c0 5 2 6 2 6H4s2-1 2-6"/><path d="M10 20a2 2 0 004 0"/><line x1="12" y1="2" x2="12" y2="4"/></svg>
                  Alert
                </button>
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
                    {zoom && (
                      <button className="volume-reset-btn" onClick={clearZoom} title="Clear time selection">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
                        Reset zoom
                      </button>
                    )}
                    {!zoom && <div className="volume-brush-hint">Click &amp; drag on chart to zoom in</div>}
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart
                        data={visibleVolume}
                        margin={{ top: 8, right: 6, left: 0, bottom: 0 }}
                        onMouseDown={onChartMouseDown}
                        onMouseMove={onChartMouseMove}
                        style={{ cursor: brushStartRef.current ? 'ew-resize' : 'crosshair', userSelect: 'none' }}
                      >
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" vertical={false} />
                        <XAxis dataKey="label" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} tickLine={false} axisLine={{ stroke: 'var(--border-subtle)' }} interval={Math.max(0, Math.floor(visibleVolume.length / 6))} minTickGap={20} />
                        <YAxis tick={{ fontSize: 10, fill: 'var(--text-muted)' }} tickLine={false} axisLine={false} width={40} />
                        <Tooltip content={<VolumeTooltip />} cursor={{ fill: 'rgba(255,255,255,0.02)' }} isAnimationActive={false} />
                        {VOLUME_SERIES.map(s => (
                          <Bar key={s.key} dataKey={s.key} stackId="v" fill={s.color} fillOpacity={s.opacity} isAnimationActive={false} />
                        ))}
                        {dragBrush && dragBrush.s1 !== dragBrush.s2 && (
                          <ReferenceArea x1={dragBrush.s1} x2={dragBrush.s2} stroke="var(--brand)" strokeOpacity={0.6} fill="var(--brand)" fillOpacity={0.14} />
                        )}
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="logs-volume-legend">
                    <div className="lvl-row"><span className="lvl-key">Total</span><span className="lvl-val">{compactCount(visibleTotals.total)}</span></div>
                    {[...VOLUME_SERIES].reverse().map(s => (
                      <div key={s.key} className="lvl-row">
                        <span className="lvl-swatch" style={{ background: s.color }} />
                        <span className="lvl-key">{s.label}</span>
                        <span className={`lvl-val${s.key === 'error' ? ' val-critical' : ''}`}>{compactCount(visibleTotals[s.key])}</span>
                      </div>
                    ))}
                  </div>
                </div>}

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

                <div className="logs-stream-wrap">
                  <div className="logs-stream" data-log-content>
                    {filtered.length === 0 && (
                      <div className="err-empty">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="10"/></svg>
                        <div>No spans match this filter</div>
                      </div>
                    )}
                    {filtered.map(row => (
                      <div
                        key={row.id}
                        className={`log-row span-row${selectedId === row.id ? ' selected' : ''}`}
                        onClick={() => { if (window.getSelection()?.isCollapsed !== false) setSelectedId(row.id) }}
                      >
                        <div className="log-fixed-cols">
                          <span className={`log-lvl-bar span-bar-${statusForSpan(row.statusCode)}`} />
                          <span className="log-time">
                            <span className="log-date">{row.dateStr}</span>
                            <span className="log-hhmm">{row.timeStr}</span>
                          </span>
                        </div>
                        {columns.map(c => (
                          <SpanCell key={c.key} col={c} row={row} onOpenTrace={openTrace} />
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
              badge={{
                status: statusForSpan(selected.statusCode),
                label: selected.statusCode || 'Span event',
              }}
            />
          )}
        </div>
      </div>

      {alertOpen && (
        <AlertDrawer
          filters={filters}
          query={appliedQuery}
          onClose={() => setAlertOpen(false)}
          emptyLabel="All spans"
          namePlaceholder="e.g. Error spans on payment-service"
        />
      )}
      {historyOpen && (
        <QueryHistoryDrawer
          history={QUERY_HISTORY}
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
