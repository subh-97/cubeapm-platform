import { useState, useMemo, useRef, useCallback, useEffect } from 'react'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { logRowsForWindow, logVolumeForWindow, buildLogFacets, BASE_TIME } from '@/data/observability'
import { resolveWindow, bucketIndexOf } from '@/data/timeWindow'
import PageBar from '@/components/layout/PageBar'
import QueryBuilder, { applyChipsToLog, chipsToString, FIELD_CATALOG, getFieldValue, SAVED_QUERIES } from '@/components/QueryBuilder'
import { flattenLeaves, newGroup } from '@/utils/queryTree'
import { toExploreLogsQuery } from '@/utils/explore/builders'
import { aggregate } from '@/utils/aggregator'
import AggregateResults from '@/components/AggregateResults'
import { serializePipes, composeQuery, parsePipes, withImpliedCount, newStatsPipe, newSortPipe, newLimitPipe, newMathPipe, namesInScopeBefore } from '@/utils/pipes'
import { tryParseConditions, splitQuery, replacePipeSection, validatePipeText } from '@/utils/rawQuery'
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
import { ALIASES, isNoiseField } from '@/utils/logFields'
import { escapeRegex, highlightTerms } from '@/utils/highlight'
import { LogRecordDrawer } from '@/components/LogRecordDrawer'
import FacetGroup from '@/components/explorer/FacetGroup'
import FieldsDropdown from '@/components/explorer/FieldsDropdown'
import QueryHistoryDrawer from '@/components/explorer/QueryHistoryDrawer'
import AlertDrawer from '@/components/explorer/AlertDrawer'
import { GRID_PROPS, valueAxisProps, fmtCount } from '@/components/charts/chartDefaults'
import { buildTimeAxis } from '@/components/charts/timeAxis'
import { useTimeFocus, useMeasuredWidth } from '@/components/charts/useTimeFocus'
import ChartTooltip from '@/components/charts/ChartTooltip'

const AGG_ALL_FIELDS = FIELD_CATALOG.map(f => f.field)
const AGG_NUMERIC_FIELDS = new Set(FIELD_CATALOG.filter(f => f.type === 'keyword').map(f => f.field))

// Compact chip display for a saved stats function inside the Aggregation pill.
function summarizeFn(f) {
  if (f.as) return f.as
  if (f.fn === 'quantile') return `q${Math.round((Number(f.p) || 0.9) * 100)}(${f.field || '·'})`
  if (f.field) return `${f.fn}(${f.field})`
  return `${f.fn}()`
}

// Full-form title used on hover (fn call + alias when present).
function fullFn(f) {
  const args = []
  if (f.fn === 'quantile') args.push(Number(f.p) || 0.9)
  if (f.field) args.push(f.field)
  const call = `${f.fn}(${args.join(', ')})`
  return f.as ? `${f.as} = ${call}` : call
}


// The log-level bands are the one case where a tooltip's colour means severity
// rather than identity, so these stay exactly the colours the bars are drawn
// in. What changes is where the colour sits: on the swatch, not on the text.
// Red text on the panel was the least legible row in the tooltip, and it was
// the row people came to read.
const VOLUME_BANDS = [
  { key: 'error', label: 'error', color: '#EF4444' },
  { key: 'warn', label: 'warn', color: '#F59E0B' },
  { key: 'info', label: 'info', color: '#60A5FA' },
]

// `hoverKey` is the band the pointer is actually inside. Recharts' tooltip is
// shared across the stack — it knows the bucket, not which segment of it the
// cursor is on — so the bars report that themselves.
//
// `suppressed` is the platform rule for a page with more than one chart: only
// the chart the pointer is actually in opens a panel, the rest show the
// crosshair alone. This page draws a single chart today, so it is always the
// hovered one and the flag never fires — it is wired anyway so that a second
// chart placed beside this one inherits the rule without an edit here.
function VolumeTooltip({ active, payload, nowMs, hoverKey, suppressed }) {
  if (!active || !payload?.length) return null
  const rec = payload[0]?.payload
  if (!rec) return null
  return (
    <ChartTooltip
      // The bucket's own instant, not the axis label: the heading carries the
      // year and the seconds, which the terse label never had.
      tMs={rec.t != null ? rec.t * 1000 : rec.x ?? null}
      nowMs={nowMs}
      hoverKey={hoverKey}
      suppressed={suppressed}
      items={VOLUME_BANDS.map(b => ({ ...b, value: rec[b.key] }))}
      footer={{ label: 'total', value: rec.total }}
    />
  )
}

// Every tag a record carries can be turned into a column, so the Fields
// dropdown lists all of them rather than an arbitrary subset. Derived from the
// rows rather than written out: the list was a hand-kept copy, and it silently
// stopped covering the data the moment records of another shape arrived.
// Agent boilerplate is left out - it is on every row of its kind and identical
// every time, so it makes a column that says nothing.
function extraFieldsFor(rows) {
  return [...new Set(rows.flatMap(r => Object.keys(r.tags)))]
    .filter(k => !isNoiseField(k))
    .sort()
    .map(key => ({ key, label: key }))
}

const DEFAULT_FIELDS = new Set()

const QUERY_HISTORY = (() => {
  const now = BASE_TIME.getTime()
  return [
    { id: 1, query: 'service:payment AND log.level:error', time: new Date(now - 4 * 60000), results: 23, saved: 'Payment errors' },
    { id: 2, query: 'http.status:5* AND service:order', time: new Date(now - 18 * 60000), results: 87, saved: null },
    { id: 3, query: 'log.level:error', time: new Date(now - 42 * 60000), results: 119, saved: 'All errors' },
    { id: 4, query: '"Failed connecting to database"', time: new Date(now - 1.5 * 3600000), results: 34, saved: null },
    { id: 5, query: 'service:search AND log.level!=info', time: new Date(now - 2.1 * 3600000), results: 56, saved: null },
    { id: 6, query: 'endpoint:/v1/payment AND http.status:408', time: new Date(now - 3 * 3600000), results: 12, saved: 'Payment timeouts' },
    { id: 7, query: 'k8s.namespace.name:production AND log.level:warn', time: new Date(now - 5 * 3600000), results: 203, saved: null },
    { id: 8, query: 'trace_id:abc123*', time: new Date(now - 7 * 3600000), results: 8, saved: null },
    { id: 9, query: 'service:shipment AND "timeout"', time: new Date(now - 12 * 3600000), results: 41, saved: 'Shipment timeouts' },
    { id: 10, query: 'log.exception.type:NullPointerException', time: new Date(now - 18 * 3600000), results: 15, saved: null },
    { id: 11, query: 'path:/v1/order AND log.level:error', time: new Date(now - 24 * 3600000), results: 67, saved: null },
    { id: 12, query: 'service:payment AND "Transaction committed"', time: new Date(now - 36 * 3600000), results: 340, saved: null },
  ]
})()

// Long enough for a paragraph explaining when to reach for a query, short
// enough that the panel stays a list of queries rather than of essays.
// `maxLength` alone stops typing but not every paste, so the value is cut on
// the way into state as well.
// The note is a caption on the query bar, not the place to read a description
// in full — that is what the panel is for. Cut on a word where one is close, so
// the tail is not a half-word plus an ellipsis.
const NOTE_DESC_MAX = 100

function truncate(text, max) {
  const t = String(text ?? '')
  if (t.length <= max) return t
  const cut = t.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return `${(space > max - 20 ? cut.slice(0, space) : cut).trimEnd()}…`
}



function PatternsDrawer({ onClose }) {
  return (
    <div className="alert-drawer-overlay" onClick={onClose}>
      <aside className="alert-drawer" onClick={e => e.stopPropagation()}>
        <div className="alert-drawer-head">
          <div>
            <div className="alert-drawer-title">Top Patterns</div>
            <div className="alert-drawer-sub">Most frequently occurring log patterns</div>
          </div>
          <button className="log-detail-close" onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </div>
        <div className="alert-drawer-body" style={{ alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
          Pattern analysis will appear here
        </div>
      </aside>
    </div>
  )
}

// Separates "a malformed query worth explaining" from "a plain value that
// happens not to parse". Only the former earns an error on paste — pasting a
// service name or a URL into a value should just paste.
const LOOKS_LIKE_QUERY = /[:(]|!=|!~|\s(?:AND|OR|in|not_in)\s/i

// Leading facets in the order someone reaches for them — what happened, then
// who it happened to. Anything else the data turns up follows, alphabetically,
// so a new tag appears in the panel without being named here.
// Reads a facet's value off a row. `log.level` and `service` are properties of
// the row itself; every other facet is a tag. Mirrors how the facet lists are
// counted in observability.js, so a tick matches exactly the rows it counted.
function facetValueOf(row, field) {
  if (field === 'log.level') return row.level
  if (field === 'service') return row.service
  return row.tags?.[field]
}

const FACET_LEAD = ['log.level', 'service', 'http.status']

const FILTERS_MIN_W = 232
const FILTERS_MAX_W = Math.round(FILTERS_MIN_W * 1.6)

// Fields shown in the Stream column — selecting one of these values offers the
// extra "Show distribution" action (mirrors CubeAPM's log selection menu).
const STREAM_DIST_FIELDS = new Set(['env', 'log.level', 'service'])
const DIST_BAR_COLOR = { error: '#EF4444', warn: '#F59E0B', info: '#60A5FA' }

function rowFieldValue(row, field) {
  if (field === 'log.level') return row.level
  if (field === 'service') return row.service
  if (field === '_msg' || field === 'message') return row.message
  return row.tags?.[field]
}

function computeDistribution(rows, field, k = 12) {
  const counts = {}
  let total = 0
  for (const r of rows) {
    const v = rowFieldValue(r, field)
    if (v == null || v === '') continue
    counts[String(v)] = (counts[String(v)] || 0) + 1
    total++
  }
  const items = Object.entries(counts).sort((a, b) => b[1] - a[1])
  return { items: items.slice(0, k), total, distinct: items.length }
}


function downloadCSV(rows) {
  const cols = ['time', 'level', 'service', 'message', 'k8s.namespace.name', 'k8s.pod.name', 'env']
  const escape = v => `"${String(v ?? '').replace(/"/g, '""')}"`
  const lines = [
    cols.map(escape).join(','),
    ...rows.map(r => cols.map(c => {
      if (c === 'time') return escape(`${r.dateStr}T${r.timeStr}Z`)
      if (c === 'level') return escape(r.level)
      if (c === 'service') return escape(r.service)
      if (c === 'message') return escape(r.message)
      return escape(r.tags[c] ?? '')
    }).join(','))
  ]
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = `logs-${Date.now()}.csv`; a.click()
  URL.revokeObjectURL(url)
}

export default function LogsView({ goHome, timeRange, setTimeRange, setToast, onOpenLink, incomingChip, onIncomingChipApplied }) {
  // Everything on this page is a function of the selected range. The stream is
  // re-read for the window rather than sliced out of a fixed hour, so widening
  // the range reaches further back instead of re-showing the same records with
  // a different label on the button.
  const win = useMemo(() => resolveWindow(timeRange), [timeRange])
  const rows = useMemo(() => logRowsForWindow(win), [win])
  const volume = useMemo(() => logVolumeForWindow(win), [win])
  // Facets are counted over the window's records, so the numbers beside each
  // value are the numbers for what is on screen.
  const logFacets = useMemo(() => buildLogFacets(rows), [rows])
  const EXTRA_FIELDS = useMemo(() => extraFieldsFor(rows), [rows])

  const [filters, setFilters] = useState({})
  const [selectedId, setSelectedId] = useState(null)
  const [query, setQuery] = useState('')
  const [chips, setChips] = useState([])
  const [runRequested, setRunRequested] = useState(false)
  const [recents, setRecents] = useState([
    [{ field: 'service', op: 'eq', value: 'payment' }, { field: 'log.level', op: 'eq', value: 'error' }],
    [{ field: 'http.status', op: 'prefix', value: '5' }],
    [{ field: 'log.level', op: 'neq', value: 'info' }],
  ])
  const addRecent = useCallback((next) => {
    if (!next || next.length === 0) return
    const key = chipsToString(next)
    setRecents(prev => {
      const dedup = prev.filter(r => chipsToString(r) !== key)
      return [next, ...dedup].slice(0, 5)
    })
  }, [])
  const [live, setLive] = useState('off')
  const [pipes, setPipes] = useState([])         // populated by the pill toolbar
  // 'builder' = chip UI, 'raw' = hand-written CubeAPM syntax. The pill toolbar
  // stays live in both; in raw mode its edits rewrite the pipe section of the
  // raw text rather than feeding a separate preview.
  const [queryMode] = useState('builder')
  const [rawText, setRawText] = useState('')
  // True while the builder has an uncommitted, half-built filter chip. Drives the
  // Run button into a disabled (toned-down) state — you can't run a query that
  // still has an unfinished filter in it.
  const [builderBlocked, setBuilderBlocked] = useState(null)

  // In raw mode the text is the source of truth for filtering, so parse its
  // conditions head back into chips and surface any failure under the input.
  const rawParse = useMemo(() => {
    if (queryMode !== 'raw') return { ok: true, chips: [], error: null }
    const { conditions, pipes: pipeStages } = splitQuery(rawText)
    const parsed = tryParseConditions(conditions)
    if (!parsed.ok) return parsed
    const pipeErr = validatePipeText(pipeStages)
    return pipeErr ? { ok: false, chips: [], error: pipeErr } : parsed
  }, [queryMode, rawText])

  // Whichever mode is active supplies the chips that actually filter rows.
  // While raw text is mid-edit it spends most keystrokes in an unparseable
  // state; filtering on that would blow the result set away on every typo, so
  // the last good parse is held until a new one succeeds.
  const lastGoodChips = useRef([])
  if (queryMode === 'raw' && rawParse.ok) lastGoodChips.current = rawParse.chips
  const effectiveChips = queryMode === 'raw'
    ? (rawParse.ok ? rawParse.chips : lastGoodChips.current)
    : chips

  // `effectiveChips` is what the QUERY BAR currently spells; `appliedChips` is
  // what the RESULTS reflect. They are separate because re-filtering on every
  // chip edit means, against a real backend, one request per chip — expensive
  // and mostly wasted, since a half-built query is rarely the one wanted. A run
  // (the Run button, or Enter in the bar) is what moves the bar's state into
  // the results.
  //
  // Seeded from the default query rather than left empty, so the page still
  // auto-loads on mount instead of showing a blank "click Search" screen.
  const [appliedChips, setAppliedChips] = useState(effectiveChips)
  // Pipes defer the same way. A group-by or aggregation is part of the query,
  // not a view toggle, so picking one costs a request just like a chip does —
  // and switching to an aggregate panel before the user has run anything shows
  // a result they never asked for.
  const [appliedPipes, setAppliedPipes] = useState([])
  // Running a query is a request, even though the mock resolves in a microtask.
  // Keeping the round trip here — rather than assigning state inline — is what
  // lets the in-flight, stale and failed states exist at all; swapping the
  // resolved promise for a real fetch is the whole integration.
  const [queryState, setQueryState] = useState({ status: 'idle', error: null })
  const runSeq = useRef(0)

  const runQuery = useCallback(() => {
    const nextChips = effectiveChips
    const nextPipes = pipes
    const seq = ++runSeq.current
    setQueryState({ status: 'running', error: null })
    Promise.resolve()
      .then(() => {
        // A reply from a superseded run must not overwrite a newer one.
        if (seq !== runSeq.current) return
        setAppliedChips(nextChips)
        setAppliedPipes(nextPipes)
        setQueryState({ status: 'idle', error: null })
      })
      .catch(err => {
        if (seq !== runSeq.current) return
        // The previous results stay on screen behind the message: a failed
        // refresh is not a reason to throw away what the user was reading.
        setQueryState({ status: 'error', error: err?.message || 'Could not run this query. Check the connection and try again.' })
      })
  }, [effectiveChips, pipes])

  useEffect(() => {
    if (!runRequested) return
    setRunRequested(false)
    runQuery()
  }, [runRequested, runQuery])

  const isRunning = queryState.status === 'running'

  // Whether the bar has moved on from what the table is showing. Compared by
  // serialization so a re-render with an equal-but-new array is not "dirty".
  const queryDirty =
    chipsToString(effectiveChips) !== chipsToString(appliedChips)
    || serializePipes(withImpliedCount(pipes)) !== serializePipes(withImpliedCount(appliedPipes))

  // A query that cannot run, and why. Raw-mode parse failures and the builder's
  // own unfinished-filter/typing errors are the same kind of problem here.
  const runBlocked = queryMode === 'raw'
    ? (rawParse.ok ? null : rawParse.error)
    : builderBlocked
  const aggPillRef = useRef(null)
  const [aggPopOpen, setAggPopOpen] = useState(false)
  const [editingFuncId, setEditingFuncId] = useState(null)   // null = create mode
  const groupByPillRef = useRef(null)
  const [groupByPopOpen, setGroupByPopOpen] = useState(false)
  const orderPillRef = useRef(null)
  const [orderPopOpen, setOrderPopOpen] = useState(false)
  const limitPillRef = useRef(null)
  const [limitPopOpen, setLimitPopOpen] = useState(false)
  const mathPillRef = useRef(null)
  const [mathPopOpen, setMathPopOpen] = useState(false)
  const [editingMathId, setEditingMathId] = useState(null)

  // All stats functions currently defined across pipes[] (v1 has at most one
  // stats pipe, but the model supports more so we flatten defensively).
  const statsFunctions = useMemo(
    () => pipes.filter(p => p.kind === 'stats').flatMap(p => p.functions || []),
    [pipes]
  )
  const editingFunc = editingFuncId ? statsFunctions.find(f => f.id === editingFuncId) : null

  const upsertAggregation = useCallback((fn) => {
    setPipes(prev => {
      const idx = prev.findIndex(p => p.kind === 'stats')
      if (idx === -1) {
        // First aggregation ever — create the stats pipe with this function.
        return [...prev, newStatsPipe({ functions: [fn] })]
      }
      const stats = prev[idx]
      const fnIdx = stats.functions.findIndex(f => f.id === fn.id)
      const nextFns = fnIdx === -1
        ? [...stats.functions, fn]                              // create
        : stats.functions.map(f => f.id === fn.id ? fn : f)     // edit
      const next = [...prev]
      next[idx] = { ...stats, functions: nextFns }
      return next
    })
  }, [])

  // Group-by fields live on the stats pipe. Read the current array (or []
   // if no stats pipe exists yet) and write updates through a single setter
   // that only mutates when a stats pipe is present.
  const groupBy = useMemo(() => {
    const stats = pipes.find(p => p.kind === 'stats')
    return stats?.groupBy || []
  }, [pipes])

  const setGroupBy = useCallback((next) => {
    setPipes(prev => {
      const idx = prev.findIndex(p => p.kind === 'stats')
      const current = idx === -1 ? [] : (prev[idx].groupBy || [])
      const nextArr = typeof next === 'function' ? next(current) : next
      if (idx === -1) {
        // No stats pipe yet — create an empty one holding the group-by so
        // users can pre-configure grouping before adding aggregations.
        if (nextArr.length === 0) return prev
        return [...prev, newStatsPipe({ groupBy: nextArr, functions: [] })]
      }
      const stats = prev[idx]
      // If both groupBy and functions become empty, drop the orphan pipe.
      if (nextArr.length === 0 && stats.functions.length === 0) {
        return prev.filter(p => p.id !== stats.id)
      }
      const next2 = [...prev]
      next2[idx] = { ...stats, groupBy: nextArr }
      return next2
    })
  }, [])

  const removeAggregation = useCallback((funcId) => {
    setPipes(prev => prev.flatMap(p => {
      if (p.kind !== 'stats') return [p]
      const nextFns = p.functions.filter(f => f.id !== funcId)
      // Keep the pipe if groupBy still has values (so the user's grouping
      // setup persists across "add/remove all aggregations" cycles).
      if (nextFns.length === 0 && (!p.groupBy || p.groupBy.length === 0)) return []
      return [{ ...p, functions: nextFns }]
    }))
  }, [])

  // Sort / limit / math pipes are singletons for sort+limit, multi for math.
   // These derived selectors + upserts keep LogsView state minimal (just
   // `pipes`) while the pill toolbar reads the current shape declaratively.
  const sortPipe = useMemo(() => pipes.find(p => p.kind === 'sort') || null, [pipes])
  const limitPipe = useMemo(() => pipes.find(p => p.kind === 'limit') || null, [pipes])
  const mathPipes = useMemo(() => pipes.filter(p => p.kind === 'math'), [pipes])
  const editingMath = editingMathId ? mathPipes.find(p => p.id === editingMathId) : null

  const removePipeById = useCallback((id) => {
    setPipes(prev => prev.filter(p => p.id !== id))
  }, [])

  // Field options for Order — you can only sort by things that appear in the
  // aggregation result: group-by columns and aliased stat outputs.
  const orderFieldOptions = useMemo(() => {
    const opts = []
    for (const f of groupBy) opts.push({ value: f, hint: 'group by' })
    for (const fn of statsFunctions) {
      if (fn.as) opts.push({ value: fn.as, hint: 'aggregation' })
    }
    return opts
  }, [groupBy, statsFunctions])

  // Names available inside a math expression = aliased stats + prior math.
  const mathAvailableNames = useMemo(() => {
    const idx = editingMath
      ? pipes.findIndex(p => p.id === editingMath.id)
      : pipes.length
    return namesInScopeBefore(pipes, idx === -1 ? pipes.length : idx)
  }, [pipes, editingMath])

  const openCreateMath = useCallback(() => {
    setEditingMathId(null)
    setMathPopOpen(true)
  }, [])
  const openEditMath = useCallback((id) => {
    setEditingMathId(id)
    setMathPopOpen(true)
  }, [])
  const closeMath = useCallback(() => {
    setMathPopOpen(false)
    setEditingMathId(null)
  }, [])
  const upsertMathPipe = useCallback((math) => {
    setPipes(prev => {
      const idx = prev.findIndex(p => p.id === math.id)
      if (idx === -1) return [...prev, { ...newMathPipe(), ...math }]
      const next = [...prev]
      next[idx] = { ...prev[idx], ...math }
      return next
    })
  }, [])

  const openCreateAggregation = useCallback(() => {
    setEditingFuncId(null)
    setAggPopOpen(true)
  }, [])
  const openEditAggregation = useCallback((funcId) => {
    setEditingFuncId(funcId)
    setAggPopOpen(true)
  }, [])
  const closeAggregation = useCallback(() => {
    setAggPopOpen(false)
    setEditingFuncId(null)
  }, [])
  const [activeFields, setActiveFields] = useState(DEFAULT_FIELDS)
  const [filtersWidth, setFiltersWidth] = useState(FILTERS_MIN_W)
  const [graphVisible, setGraphVisible] = useState(true)
  const [alertOpen, setAlertOpen] = useState(false)
  const [patternsOpen, setPatternsOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [myQueriesOpen, setMyQueriesOpen] = useState(false)
  const [saveQueryOpen, setSaveQueryOpen] = useState(false)
  const myQueriesBtnRef = useRef(null)
  const saveQueryBtnRef = useRef(null)
  // Saved-query state disabled — kept for future restoration:
  //   const [historySaved, setHistorySaved] = useState(
  //     () => Object.fromEntries(QUERY_HISTORY.map(h => [h.id, h.saved]))
  //   )
  //   const toggleHistorySave = useCallback((id, name) => {
  //     setHistorySaved(prev => ({ ...prev, [id]: name }))
  //   }, [])
  const [moreOpen, setMoreOpen] = useState(false)
  const moreRef = useRef(null)

  useEffect(() => {
    if (!moreOpen) return
    const handler = (e) => { if (!moreRef.current?.contains(e.target)) setMoreOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [moreOpen])

  // Re-running a past query means putting it back in the builder, not just
  // filtering by its text: parse it into chips so the bar shows the same
  // filters it originally ran with and the results follow from them. Pipes are
  // reset because a history entry is a whole query — leaving a stale group-by
  // attached would show something the entry never produced.
  const applyHistoryQuery = useCallback((q) => {
    const parsed = tryParseConditions(splitQuery(q).conditions)
    if (parsed.ok) {
      setChips(parsed.chips)
      setPipes([])
      setQuery('')
    } else {
      // Not expressible as chips — fall back to matching it against the body.
      setQuery(q)
    }
    setHistoryOpen(false)
  }, [])

  // rawQuery.js imports from QueryBuilder, so the builder can't import the
  // parser back without a cycle — the parse is injected from here instead.
  //
  // `ok: false` with no error means "this isn't a query, it's a value": the
  // builder lets those paste as ordinary text rather than complaining.
  const parsePastedQuery = useCallback((raw) => {
    const { conditions, pipes: pipeStages } = splitQuery(raw)
    const parsed = tryParseConditions(conditions)
    if (!parsed.ok) {
      return { ok: false, error: LOOKS_LIKE_QUERY.test(raw) ? parsed.error : null }
    }

    const pipeRes = pipeStages.length ? parsePipes(pipeStages) : null
    // A stage the builder can't represent at all refuses the whole paste —
    // applying half of it would run a query the user never wrote.
    if (pipeRes && !pipeRes.ok && pipeRes.fatal) {
      return { ok: false, error: pipeRes.error }
    }

    const gotPipes = !!pipeRes?.ok && pipeRes.pipes.length > 0
    if (!parsed.chips.length && !gotPipes) return { ok: false, error: null }

    // A malformed pipe section still lets the filters through; the reason rides
    // along so the user knows the pipe half didn't land.
    // A typo in the pipe section shouldn't destroy pipe controls the user
    // already set, so those are left as they are — the wording has to say so.
    const notice = pipeRes && !pipeRes.ok
      ? `Applied the filters. The pipe section was left as it is — ${pipeRes.error}`
      : pipeRes?.unsupported?.length
        ? `Kept ${pipeRes.unsupported.map(n => `“${n}”`).join(', ')} as written — no builder control for ${pipeRes.unsupported.length > 1 ? 'those stages' : 'that stage'}, so ${pipeRes.unsupported.length > 1 ? 'they' : 'it'} shows only in the generated query.`
        : null

    return {
      ok: true,
      chips: parsed.chips,
      // Only a paste that carried a pipe section touches the pipe controls;
      // one without leaves whatever is already configured alone.
      pipes: gotPipes ? pipeRes.pipes : null,
      notice,
    }
  }, [])

  // Replaces the pipe config wholesale, so what runs is what was pasted rather
  // than the paste plus a leftover stage. Any open math editor is pointing at a
  // pipe that no longer exists, so it closes with it.
  const applyPastedPipes = useCallback((next) => {
    setPipes(next)
    setMathPopOpen(false)
    setEditingMathId(null)
  }, [])

  // A drag on the histogram IS a time range — it sets the app-wide range to an
  // absolute window rather than keeping a private "zoom" beside it. One concept
  // instead of two, and the range the rest of the product sees is the range you
  // dragged. `zoomedFrom` is only what Reset goes back to.
  const [zoomedFrom, setZoomedFrom] = useState(null)
  // Text-selection context menu: { x, y, text, field, value } | null
  const [selMenu, setSelMenu] = useState(null)
  // Distribution popover: { field, x, y } | null
  const [distField, setDistField] = useState(null)
  const dragRef = useRef(null)

  // Detect a text selection inside the log table / detail panel and surface the menu.
  const handleLogSelection = useCallback(() => {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) { setSelMenu(null); return }
    const text = sel.toString().trim()
    if (!text) { setSelMenu(null); return }
    const range = sel.getRangeAt(0)
    const node = range.commonAncestorContainer
    const anchorEl = node.nodeType === 3 ? node.parentElement : node
    if (!anchorEl?.closest?.('[data-log-content]')) { setSelMenu(null); return }
    const fieldEl = anchorEl.closest('[data-log-field]')
    const rect = range.getBoundingClientRect()
    setDistField(null)
    setSelMenu({
      x: Math.max(8, Math.min(rect.left, window.innerWidth - 232)),
      y: rect.bottom + 6,
      text,
      field: fieldEl ? fieldEl.getAttribute('data-log-field') : null,
      value: fieldEl ? (fieldEl.getAttribute('data-log-value') ?? text) : text,
    })
  }, [])

  const addChipToQuery = useCallback((chip) => {
    setChips(prev => prev.length === 0 ? [chip] : [...prev, { connector: 'AND', ...chip }])
  }, [setChips])

  // A filter handed in from another page - the trace view's "check logs".
  //
  // It replaces the query rather than appending, because arriving with someone
  // else's filters still applied is not what the button promised; and it runs
  // itself, because a filter that lands in the bar unapplied looks like the
  // button did nothing.
  //
  // A trace id is matched across every spelling: one instance can hold trace_id
  // and trace.id at once, and asking for either alone silently drops the rest
  // of the trace's logs.
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

  // Shared by every copy action in the record drawer, so all of them report
  // through the same toast the query bar already uses.
  // Pins live here rather than in the drawer so they survive closing it, not
  // just stepping between records — a field you chose to watch stays watched.
  const [pinnedFields, setPinnedFields] = useState([])
  const togglePinnedField = useCallback((field) => {
    setPinnedFields(prev => prev.includes(field)
      ? prev.filter(f => f !== field)
      : [...prev, field])
  }, [])

  const copyText = useCallback((text, message) => {
    try { navigator.clipboard.writeText(text)?.catch(() => {}) } catch (_) {}
    setToast?.(message)
  }, [setToast])

  const applySelectionChip = useCallback((mode) => {
    if (!selMenu) return
    const { field, value, text } = selMenu
    const chip = field
      ? { field, op: mode === 'include' ? 'eq' : 'neq', value }
      : mode === 'include'
        ? { field: '_msg', op: 'contains', value: text }
        : { field: '_msg', op: 'nregex', value: escapeRegex(text) }
    addChipToQuery(chip)
    window.getSelection()?.removeAllRanges()
    setSelMenu(null)
  }, [selMenu, addChipToQuery])

  const copySelection = useCallback(() => {
    if (!selMenu) return
    try { navigator.clipboard.writeText(selMenu.text) } catch (_) {}
    window.getSelection()?.removeAllRanges()
    setSelMenu(null)
  }, [selMenu])

  const openDistribution = useCallback(() => {
    if (!selMenu?.field) return
    setDistField({ field: selMenu.field, x: selMenu.x, y: selMenu.y })
    window.getSelection()?.removeAllRanges()
    setSelMenu(null)
  }, [selMenu])

  // Dismiss menu/popover on Escape, outside click, or scroll.
  useEffect(() => {
    if (!selMenu && !distField) return
    const onKey = (e) => { if (e.key === 'Escape') { setSelMenu(null); setDistField(null) } }
    const onDown = (e) => {
      if (e.target.closest?.('.log-sel-menu') || e.target.closest?.('.log-dist-pop')) return
      setSelMenu(null); setDistField(null)
    }
    const onScroll = () => { setSelMenu(null); setDistField(null) }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [selMenu, distField])

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

  // A released drag becomes the page's range. The gesture itself — the slop that
  // keeps a click a click, the bucket the pointer is over, the overlay, the
  // commit on release anywhere on the page — belongs to `useTimeFocus`, which
  // every chart on the product shares; the only part that is this page's is
  // remembering where the drag started from so Reset has somewhere to go back
  // to. The first drag records it; later drags keep the original, so Reset
  // returns to the range you were reading, not to the previous zoom.
  const focusRange = useCallback((next) => {
    setZoomedFrom(cur => cur ?? timeRange)
    setTimeRange(next)
  }, [timeRange, setTimeRange])

  // Category, not time: the volume chart is a stacked BarChart and needs the
  // band scale. The ticks are the same ladder either way — resolved to bucket
  // labels here rather than to instants.
  const volumeFocus = useTimeFocus(win, { onFocus: focusRange, kind: 'category' })

  // Which band of the stack the pointer is inside, so the tooltip can bring
  // that row forward and let the other two recede. The bars have to say so
  // themselves — the tooltip is shared across the stack and only knows which
  // bucket is under the cursor. Clearing is guarded on the key still being this
  // one, so that crossing from one band straight into the next cannot land on
  // "nothing hovered" whichever order the two events arrive in.
  const [volumeHover, setVolumeHover] = useState(null)
  const bandHoverProps = (key) => ({
    onMouseEnter: () => setVolumeHover(key),
    onMouseLeave: () => setVolumeHover(cur => (cur === key ? null : cur)),
  })

  const [volumeWrapRef, volumeWidth] = useMeasuredWidth()
  const volumeAxis = useMemo(
    () => buildTimeAxis(win, { width: volumeWidth, kind: 'category' }),
    [win, volumeWidth],
  )

  const startResize = useCallback((e) => {
    e.preventDefault()
    dragRef.current = { startX: e.clientX, startW: filtersWidth }
    const onMove = (ev) => {
      const { startX, startW } = dragRef.current
      const next = Math.min(FILTERS_MAX_W, Math.max(FILTERS_MIN_W, startW + (ev.clientX - startX)))
      setFiltersWidth(next)
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

  // The panel keeps its own selection, separate from the query bar's chips.
  // An empty set means nothing is ruled out for that field, which is why the
  // list starts unticked: no selection and every value selected would filter
  // the same rows, and unticked is the one that leaves the query bar alone.
  const toggleFilter = (group, value) => {
    setFilters(prev => {
      const next = { ...prev }
      const set = new Set(next[group] || [])
      if (set.has(value)) set.delete(value)
      else set.add(value)
      next[group] = set
      return next
    })
  }

  const getSet = key => filters[key] || new Set()

  const facetFields = useMemo(() => {
    const keys = Object.keys(logFacets)
    const lead = FACET_LEAD.filter(k => keys.includes(k))
    const rest = keys.filter(k => !lead.includes(k)).sort()
    return [...lead, ...rest]
  }, [logFacets])

  // Rows matching chips/query/facets. The time window is already applied — the
  // stream was read for it — so this is the full result set, and the table and
  // the histogram are built from the same list.
  const chipFilteredRows = useMemo(() => {
    // Every facet the panel shows filters, not just the two it once listed:
    // the field list is derived from the rows now, so naming fields here would
    // leave the rest of the panel decorative.
    const active = Object.entries(filters).filter(([, set]) => set?.size)
    return rows.filter(l => {
      for (const [field, set] of active) {
        if (!set.has(String(facetValueOf(l, field) ?? ''))) return false
      }
      if (query && !l.message.toLowerCase().includes(query.toLowerCase())) return false
      if (appliedChips.length && !applyChipsToLog(l, appliedChips)) return false
      return true
    })
  }, [rows, filters, query, appliedChips])

  // Literal strings the user is searching the message body for — the free-text
  // chips plus the facet search box. Regex chips are left out: their value is a
  // pattern, not the text that will appear in the line.
  const searchTerms = useMemo(() => {
    const terms = flattenLeaves(appliedChips)
      .filter(c => c.field === '_msg' && c.op !== 'regex' && c.op !== 'nregex')
      .flatMap(c => (Array.isArray(c.value) ? c.value : [c.value]))
      .map(v => String(v ?? '').trim())
      .filter(Boolean)
    if (query.trim()) terms.push(query.trim())
    return [...new Set(terms)].sort((a, b) => b.length - a.length)
  }, [appliedChips, query])

  // Pill edits in raw mode rewrite only the pipe section, leaving the
  // hand-written conditions head untouched. Writing the same string back is a
  // no-op for React, so this can't feed back into itself.
  useEffect(() => {
    if (queryMode !== 'raw') return
    setRawText(prev => replacePipeSection(prev, serializePipes(pipes)))
  }, [pipes, queryMode])

  // Reads appliedPipes, not pipes: everything downstream of here is results, and
  // results only move on Run.
  const effectivePipes = useMemo(() => withImpliedCount(appliedPipes), [appliedPipes])

  // The live counterpart, for the generated-query preview only.
  const livePipes = useMemo(() => withImpliedCount(pipes), [pipes])

  // The applied counterparts of statsFunctions/groupBy. The pills read the live
  // pipes so the controls stay responsive; the results panel reads these, so it
  // keeps showing the log table until the aggregate query is actually run.
  const appliedStatsFunctions = useMemo(
    () => appliedPipes.filter(p => p.kind === 'stats').flatMap(p => p.functions || []),
    [appliedPipes]
  )
  const appliedGroupBy = useMemo(
    () => appliedPipes.find(p => p.kind === 'stats')?.groupBy || [],
    [appliedPipes]
  )

  // What the bar currently spells. Live, not applied: it tracks every edit
  // rather than waiting for Run, because the query worth reading while you
  // build it is the one you are about to run. The results deliberately lag.
  //
  // One expression feeds both the preview and the copy button, so the two can
  // never disagree about what the query is.
  const spelledQuery = useMemo(
    () => (queryMode === 'raw'
      ? rawText.trim()
      : composeQuery(chipsToString(effectiveChips), livePipes)),
    [queryMode, rawText, effectiveChips, livePipes]
  )

  // The preview is always on screen. An empty bar is not the absence of a
  // query, it is `*`, and saying so is the whole value of the strip: somewhere
  // to read what will run that is in the same place every time you look.
  const composedQuery = spelledQuery || '*'

  // Copy stays gated on there being something to copy — handing over `*` would
  // be handing over nothing.
  const copyableQuery = spelledQuery

  // Explore speaks the reference's LogsQL and needs a `| stats` pipe to have
  // anything to plot; `toExploreLogsQuery` translates our chip dialect and
  // appends `| stats count()` when the query has no aggregation of its own
  // (ARCH D13). The bar as it stands travels, not the last run — what you are
  // looking at is what you mean to chart.
  const openInExplore = useCallback(() => {
    onOpenLink?.({ view: 'explore', datasource: 'vlogs', query: toExploreLogsQuery(composedQuery) })
  }, [onOpenLink, composedQuery])

  // The save controls read the query that has been RUN, not the one in the bar.
  // Everything else on this surface splits the same way — the preview is live,
  // the results lag behind Run — and saving belongs on the results side of that
  // line: a query nobody has executed is one nobody has checked, and keeping it
  // under a name is how an untested query becomes someone else's starting point.
  //
  // It also keeps the button honest. Enabled by the run query but saving the
  // typed one would store something the user never saw results for.
  const appliedQuery = useMemo(
    () => composeQuery(chipsToString(appliedChips), effectivePipes),
    [appliedChips, effectivePipes]
  )

  // The saved-query state machine lives in a hook: the rules are pure and
  // tested in utils/savedQueries.js, and reading which of Save / Saved / Update
  // is on offer off a render tree is how the wrong button ends up enabled.
  const applySaved = useCallback((q) => {
    const nextChips = q.chips ?? []
    const nextPipes = q.pipes ?? []
    setChips(nextChips)
    setAppliedChips(nextChips)
    setPipes(nextPipes)
    setAppliedPipes(nextPipes)
    setQuery('')
    setMyQueriesOpen(false)
  }, [])

  const {
    saved: savedQueries, saveable: canSaveQuery, composedButUnrun,
    savedAs, updatable, note: queryNote,
    save: saveQuery, update: updateQuery, apply: applySavedQuery, remove: deleteSavedQuery,
  } = useSavedQueries({
    queryMode,
    appliedChips, appliedPipes,
    effectiveChips, effectivePipes, livePipes,
    appliedQuery,
    stringify: chipsToString,
    examples: SAVED_QUERIES,
    onToast: setToast,
    onApply: applySaved,
  })


  const copyQuery = useCallback(() => {
    if (!copyableQuery) return
    // writeText rejects rather than throws when the clipboard is blocked, so
    // both paths need swallowing or the console fills with unhandled rejections.
    try { navigator.clipboard.writeText(copyableQuery)?.catch(() => {}) } catch (_) {}
    setToast?.(livePipes.length > 0
      ? 'This query has been copied to clipboard along with pipes'
      : 'This query has been copied to clipboard')
  }, [copyableQuery, livePipes, setToast])

  // Run the client-side aggregator whenever chips or pipes change. Anchors
   // to BASE_TIME so the mock stream (which is deterministic from BASE_TIME
   // backward) always falls inside the window.
  const aggregateResult = useMemo(() => aggregate({
    pipes: effectivePipes,
    logs: chipFilteredRows,
    getFieldValue,
    now: win.end * 1000,
    timeRange: win.spanSec * 1000,
    bucketCount: Math.min(30, win.buckets.length),
  }), [effectivePipes, chipFilteredRows, win])

  // Scale the window's volume (production-shaped baseline) by per-level
  // filtered ratios. With nothing filtered every ratio is 1 and the chart is
  // the window's own histogram; with a filter on, each level's bar shrinks by
  // how many of that bucket's sampled rows still match, which keeps the
  // production-like silhouette while agreeing with the table.
  const filteredVolume = useMemo(() => {
    // appliedChips, not chips — the chart must agree with the table, and in raw
    // mode `chips` is empty anyway (the active filter comes from parsed raw
    // text), which would short-circuit to the unfiltered baseline.
    const hasFilters = appliedChips.length > 0 || !!query || Object.values(filters).some(s => s?.size)
    if (!hasFilters) return volume

    const all = [], filt = []
    const bucket = (acc, l) => {
      const i = bucketIndexOf(win, l.time.getTime())
      if (i < 0) return
      if (!acc[i]) acc[i] = { error: 0, warn: 0, info: 0 }
      acc[i][l.level]++
    }
    rows.forEach(l => bucket(all, l))
    chipFilteredRows.forEach(l => bucket(filt, l))

    return volume.map((d, i) => {
      const a = all[i]
      if (!a) return { ...d, info: 0, warn: 0, error: 0, total: 0 }
      const f = filt[i] || { error: 0, warn: 0, info: 0 }
      const scale = k => (a[k] > 0 ? Math.round(d[k] * f[k] / a[k]) : 0)
      const info = scale('info'), warn = scale('warn'), error = scale('error')
      return { ...d, info, warn, error, total: info + warn + error }
    })
  }, [chipFilteredRows, rows, volume, win, filters, query, appliedChips])

  // No time filter left to apply: the rows were read for this window.
  const filtered = chipFilteredRows
  const visibleVolume = filteredVolume

  // Tallest stacked bucket on screen - the axis gutter is sized from it.
  const volumeMax = useMemo(
    () => visibleVolume.reduce((max, d) => (d.total > max ? d.total : max), 0),
    [visibleVolume],
  )

  const visibleTotals = useMemo(() => ({
    total: visibleVolume.reduce((a, b) => a + b.total, 0),
    error: visibleVolume.reduce((a, b) => a + b.error, 0),
    warn: visibleVolume.reduce((a, b) => a + b.warn, 0),
    info: visibleVolume.reduce((a, b) => a + b.info, 0),
  }), [visibleVolume])

  const selected = selectedId ? filtered.find(l => l.id === selectedId) : null
  // Position within the rows currently on screen, so stepping through records
  // walks the same list the table shows rather than the unfiltered set.
  const selectedIndex = selectedId ? filtered.findIndex(l => l.id === selectedId) : -1

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
        <span className="current">Logs</span>
      </PageBar>
      <div className="logs-layout logs-layout-stitched" style={{ gridTemplateColumns: `${filtersWidth}px 1fr` }} onMouseUp={handleLogSelection}>
      <div className="logs-filters">
        <div className="logs-filters-head">
          <span>Filters</span>
          {Object.values(filters).some(s => s?.size) && (
            <button className="logs-filters-clear" onClick={() => setFilters({})}>Clear all</button>
          )}
        </div>
        {/* The facets scroll; the header does not, so "Clear all" stays reachable
            however far down the list you are. */}
        <div className="logs-filters-scroll">
          {facetFields.map(field => (
            <FacetGroup
              key={field}
              title={field}
              options={logFacets[field]}
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
            {isRunning ? 'Running' : 'Run'}
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
                <button role="menuitem" className="logs-more-item" onClick={() => { openInExplore(); setMoreOpen(false) }}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><path d="M16 8l-2.4 5.6L8 16l2.4-5.6z"/></svg>
                  Open in Explore
                </button>
                <a
                  role="menuitem"
                  className="logs-more-item"
                  href="https://docs.cubeapm.com/logs/querying"
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
            {groupBy.length > 0 && groupBy.map(field => (
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
            {statsFunctions.length > 0 && statsFunctions.map(fn => (
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
          {/* Math sits next to Aggregation because its expressions operate on
              the aggregation's output names — Order and Limit act on the result
              set afterwards, so they read better downstream of it. */}
          <PipePill
            ref={mathPillRef}
            icon={<Calculator />}
            label="Math"
            active={mathPopOpen && !editingMathId}
            onAddClick={openCreateMath}
          >
            {mathPipes.length > 0 && mathPipes.map(mp => (
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
          fields={FIELD_CATALOG}
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
            <button className="hbtn small" onClick={() => setPatternsOpen(true)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>
              Top Patterns
            </button>
            <FieldsDropdown fields={EXTRA_FIELDS} activeFields={activeFields} setActiveFields={setActiveFields} />
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
          <button className="hbtn small" onClick={() => downloadCSV(filtered)} title="Download as CSV">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            CSV
          </button>
          <button className="hbtn small" onClick={() => setAlertOpen(true)} title="Create alert from this query">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 10a6 6 0 1112 0c0 5 2 6 2 6H4s2-1 2-6"/><path d="M10 20a2 2 0 004 0"/><line x1="12" y1="2" x2="12" y2="4"/></svg>
            Alert
          </button>
          <button className="hbtn small" onClick={openInExplore} title="Chart this query in Explore">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><path d="M16 8l-2.4 5.6L8 16l2.4-5.6z"/></svg>
            Explore
          </button>
          </div>
        </div>

        {/* A failed run keeps the previous results underneath — losing what you
            were reading because a refresh failed is worse than the failure. */}
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
          <div className="logs-volume-chart" ref={volumeWrapRef}>
            {zoomedFrom && (
              <button className="volume-reset-btn" onClick={clearZoom} title="Go back to the range this was zoomed from">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
                Reset zoom
              </button>
            )}
            {!zoomedFrom && (
              <div className="volume-brush-hint">Click & drag on chart to zoom in</div>
            )}
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={visibleVolume}
                margin={{ top: 8, right: 6, left: 0, bottom: 0 }}
                {...volumeFocus.chartProps}
              >
                <CartesianGrid {...GRID_PROPS} />
                <XAxis {...volumeAxis.props} />
                <YAxis {...valueAxisProps({ format: fmtCount, allowDecimals: false, maxValue: volumeMax })} />
                <Tooltip
                  content={p => <VolumeTooltip {...p} nowMs={win.end * 1000} hoverKey={volumeHover} suppressed={!volumeFocus.hovered} />}
                  cursor={{ fill: 'rgba(255,255,255,0.02)' }}
                  isAnimationActive={false}
                />
                <Bar dataKey="info" stackId="v" fill="#60A5FA" fillOpacity={0.55} isAnimationActive={false} {...bandHoverProps('info')} />
                <Bar dataKey="warn" stackId="v" fill="#F59E0B" fillOpacity={0.75} isAnimationActive={false} {...bandHoverProps('warn')} />
                <Bar dataKey="error" stackId="v" fill="#EF4444" fillOpacity={0.85} isAnimationActive={false} {...bandHoverProps('error')} />
                {volumeFocus.overlay}
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="logs-volume-legend">
            <div className="lvl-row"><span className="lvl-key">Total</span><span className="lvl-val">{visibleTotals.total >= 1000 ? `${(visibleTotals.total / 1000).toFixed(2)}K` : visibleTotals.total.toLocaleString()}</span></div>
            <div className="lvl-row"><span className="lvl-swatch" style={{ background: '#EF4444' }} /><span className="lvl-key">error</span><span className="lvl-val val-critical">{visibleTotals.error}</span></div>
            <div className="lvl-row"><span className="lvl-swatch" style={{ background: '#F59E0B' }} /><span className="lvl-key">warn</span><span className="lvl-val val-warning">{visibleTotals.warn}</span></div>
            <div className="lvl-row"><span className="lvl-swatch" style={{ background: '#60A5FA' }} /><span className="lvl-key">info</span><span className="lvl-val">{visibleTotals.info.toLocaleString()}</span></div>
          </div>
        </div>}

        <div className="logs-stream-head">
          <div className="log-fixed-cols">
            <span className="lh-bar-spacer" />
            <span className="lh-time">Time</span>
          </div>
          <span className="lh-text">Text</span>
          <span className="lh-stream">Stream</span>
          {[...activeFields].map(f => (
            <span key={f} className="lh-extra">{f}</span>
          ))}
        </div>
        <div className="logs-stream-wrap">
          <div className="logs-stream" data-log-content>
            {filtered.length === 0 && (
              <div className="err-empty">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="10"/></svg>
                <div>No logs match this filter</div>
              </div>
            )}
            {filtered.map(l => (
              <div
                key={l.id}
                className={`log-row${selectedId === l.id ? ' selected' : ''}`}
                onClick={() => { if (window.getSelection()?.isCollapsed !== false) setSelectedId(l.id) }}
              >
                <div className="log-fixed-cols">
                  <span className={`log-lvl-bar log-lvl-${l.level}`} />
                  <span className="log-time">
                    <span className="log-date">{l.dateStr}</span>
                    <span className="log-hhmm">{l.timeStr}</span>
                  </span>
                </div>
                <span className="log-text">{highlightTerms(l.message, searchTerms)}</span>
                <span className="log-stream">
                  <span className="log-tag"><span className="k">env</span><span className="v" data-log-field="env" data-log-value={l.tags.env}>{l.tags.env}</span></span>
                  <span className="log-tag"><span className="k">log.level</span><span className="v" data-log-field="log.level" data-log-value={l.level}>{l.level}</span></span>
                  <span className="log-tag"><span className="k">service</span><span className="v" data-log-field="service" data-log-value={l.service}>{l.service}</span></span>
                </span>
                {[...activeFields].map(f => (
                  <span key={f} className="log-extra mono" data-log-field={f} data-log-value={l.tags[f] ?? l[f] ?? ''}>{l.tags[f] ?? l[f] ?? ''}</span>
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
          searchTerms={searchTerms}
          onAddChip={addChipToQuery}
          onOpenLink={onOpenLink}
          onDistribution={(field, x, y) => setDistField({ field, x, y })}
          onCopy={copyText}
          index={selectedIndex}
          total={filtered.length}
          onNavigate={(i) => { const row = filtered[i]; if (row) setSelectedId(row.id) }}
          pinned={pinnedFields}
          onTogglePin={togglePinnedField}
        />
      )}
      </div>
    </div>
    {alertOpen && (
      <AlertDrawer
        filters={filters}
        query={query}
        onClose={() => setAlertOpen(false)}
        emptyLabel="All logs"
      />
    )}
    {patternsOpen && <PatternsDrawer onClose={() => setPatternsOpen(false)} />}
    {myQueriesOpen && (
      <MyQueriesDrawer
        onClose={() => setMyQueriesOpen(false)}
        saved={savedQueries}
        onApply={applySavedQuery}
        onDelete={deleteSavedQuery}
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

    {selMenu && (
      <div className="log-sel-menu" style={{ left: selMenu.x, top: selMenu.y }}>
        <button className="log-sel-item" onClick={() => applySelectionChip('include')}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Include in Query
        </button>
        <button className="log-sel-item" onClick={() => applySelectionChip('exclude')}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Exclude from Query
        </button>
        <button className="log-sel-item" onClick={copySelection}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
          Copy Text
        </button>
        {selMenu.field && STREAM_DIST_FIELDS.has(selMenu.field) && (
          <button className="log-sel-item" onClick={openDistribution}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
            Show distribution
          </button>
        )}
      </div>
    )}

    {distField && (() => {
      const dist = computeDistribution(filtered, distField.field)
      const width = 320
      const left = Math.max(8, Math.min(distField.x, window.innerWidth - width - 8))
      return (
        <div className="log-dist-pop" style={{ left, top: distField.y, width }}>
          <div className="log-dist-head">
            <div className="log-dist-title">Distribution · <span className="mono">{distField.field}</span></div>
            <button className="log-dist-close" onClick={() => setDistField(null)} aria-label="Close">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
            </button>
          </div>
          <div className="log-dist-sub">{dist.distinct} values · {dist.total.toLocaleString()} logs in view</div>
          <div className="log-dist-list">
            {dist.items.length === 0 && <div className="log-dist-empty">No values</div>}
            {dist.items.map(([val, count]) => {
              const pct = dist.total ? (count / dist.total) * 100 : 0
              const color = distField.field === 'log.level' ? (DIST_BAR_COLOR[val] || 'var(--brand)') : 'var(--brand)'
              return (
                <button
                  key={val}
                  className="log-dist-row"
                  onClick={() => { addChipToQuery({ field: distField.field, op: 'eq', value: val }); setDistField(null) }}
                  title={`Include ${distField.field} = ${val}`}
                >
                  <span className="log-dist-val mono" title={val}>{val}</span>
                  <span className="log-dist-bar-wrap"><span className="log-dist-bar" style={{ width: `${pct}%`, background: color }} /></span>
                  <span className="log-dist-count mono">{count.toLocaleString()}</span>
                  <span className="log-dist-pct mono">{pct.toFixed(1)}%</span>
                </button>
              )
            })}
          </div>
        </div>
      )
    })()}
    </>
  )
}
