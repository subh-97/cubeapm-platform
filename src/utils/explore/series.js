// From API series to what the Explore chart, legend and table draw. Pure, so
// the components only render: every rule about naming, colour, ordering,
// limiting, selection, stacking and comparison lives here, where it can be
// tested against the reference's worked examples.
//
// Reference: the chart's dataset construction (`boe`), the legend's
// search/limit/selection (`yl`), and the table's row model (`Wn`) — see
// results-area.md §6-§7. Where ARCH overrides the reference it says so inline.

import { CHART_PALETTE } from '@/utils/chartPalette'
import { labelsToString, reduceValues, formatDelta, formatLocal } from './format.js'
import { timestamps } from '@/utils/timeRange.js'
import { filterRows } from './searchQuery.js'

export const LEGEND_LIMIT = 20
export const TABLE_LIMIT = 20
export const TOOLTIP_LIMIT = 15

// ---------- Colour (ARCH D7) ----------

// The house palette minus its warning amber: series identity must never read
// as severity (CLAUDE.md rule 2), and the amber is reached as soon as a
// group-by makes twelve series.
export const EXPLORE_PALETTE = CHART_PALETTE.filter(c => c.toUpperCase() !== '#F59E0B')
// Past one full cycle the hues repeat at lower opacity, as in the reference,
// so series 12 is visibly not series 1.
const BORDER_ALPHA = ['FF', 'DD', 'BB', '99']
const FILL_ALPHA = ['77', '55', '33', '11']

export const OTHERS_LABEL = 'Others'
export const OTHERS_COLOUR = 'var(--text-muted)'
export const OTHERS_FILL = 'color-mix(in srgb, var(--text-muted) 22%, transparent)'
export const GHOST_KEY = '__prev'
const OTHERS_KEY = '__others'

/** Palette colour for identity slot `i` (line, or the stacked area's fill). */
export function seriesColour(i, fill = false) {
  const n = EXPLORE_PALETTE.length
  const alpha = (fill ? FILL_ALPHA : BORDER_ALPHA)[Math.floor(i / n) % BORDER_ALPHA.length]
  return EXPLORE_PALETTE[i % n] + alpha
}

// ---------- Identity, labels, reduction ----------

/** A series' identity: its full, sorted label set. What colour and comparison key on. */
export function seriesId(metric) {
  return labelsToString(metric || {})
}

// Values sort high to low with NaN last. The reference sorts NaN wherever the
// comparator happens to leave it, which reorders a result between refreshes.
function byValueDesc(a, b) {
  const an = Number.isNaN(a)
  const bn = Number.isNaN(b)
  if (an || bn) return an === bn ? 0 : an ? 1 : -1
  if (a === b) return 0
  return b - a
}

/**
 * Attaches each series' Legend value and orders by it, highest first — the
 * order the reference legend lists series in.
 *
 * @param {Array<{ metric: object, values: Array<{x:number,y:number}> }>} series
 * @returns {Array<{ metric: object, values: Array<{x:number,y:number}>, reduceValue: number }>}
 */
export function reduceSeries(series, formula) {
  return (series || [])
    .map(s => ({ ...s, values: s.values || [], reduceValue: reduceValues(s.values || [], formula) }))
    .sort((a, b) => byValueDesc(a.reduceValue, b.reduceValue))
}

/**
 * Every label key seen on any series, in first-seen order (not sorted, and
 * `__name__` included) — the options of the "Labels" select.
 */
export function collectLabelKeys(series) {
  const keys = new Set()
  for (const s of series || []) for (const k of Object.keys(s.metric || {})) keys.add(k)
  return [...keys]
}

/**
 * Splits keys into common and varying (reference boe, bundle 114066-114084).
 * A key is common only when EVERY series carries it with the same value; a key
 * some series lack is varying, even if the ones that have it agree.
 *
 * @returns {{ common: Object<string,string>, varying: Set<string> }}
 */
export function splitCommonLabels(series, keys = collectLabelKeys(series)) {
  const common = {}
  const varying = new Set(keys)
  if (!series?.length) return { common, varying }
  for (const k of keys) {
    const v0 = series[0].metric?.[k] || ''
    if (series.every(s => s.metric?.[k] === v0)) {
      common[k] = v0
      varying.delete(k)
    }
  }
  return { common, varying }
}

/**
 * The legend text of a series. Labels = a key → that key's value (a series
 * without it reads "-"); Labels = all → the varying keys the series actually
 * has, as `k=v, …`. An empty name is "-".
 */
export function legendName(metric, { legendLabel = '', varying } = {}) {
  let name
  if (legendLabel) name = metric?.[legendLabel] || ''
  else name = labelsToString(metric, Object.keys(metric || {}).filter(k => varying?.has(k)))
  return name || '-'
}

/** A value for a series in any of the API's shapes: instant, reduced, or raw range. */
export function valueOf(item, formula) {
  if (typeof item?.value === 'number') return item.value
  if (typeof item?.reduceValue === 'number') return item.reduceValue
  if (Array.isArray(item?.values)) return reduceValues(item.values, formula)
  return NaN
}

function indexById(series) {
  const m = new Map()
  for (const s of series || []) {
    const id = seriesId(s.metric)
    if (!m.has(id)) m.set(id, s)
  }
  return m
}

const UNKNOWN_DELTA = Object.freeze({ text: '—', dir: 'none', ratio: NaN })

// The comparison half of a row or dataset (ARCH D6). `prevSeries` null means
// Compare is off; `prevFailed` means it is on but its fetch failed, which must
// read as "unknown", never as "new".
function comparison(id, value, formula, prevIndex, prevFailed) {
  if (prevFailed) return { prevValue: NaN, delta: UNKNOWN_DELTA }
  if (!prevIndex) return { prevValue: undefined, delta: null }
  const prev = prevIndex.get(id)
  const prevValue = prev ? valueOf(prev, formula) : NaN
  return { prevValue, delta: formatDelta(value, prevValue) }
}

// ---------- Selection (reference `yl`) ----------
//
// `defaultShow` with a set of exceptions. Normal mode shows everything except
// the exceptions; select mode (after a plain click) shows only them. Keyed by
// legend TEXT, so series that share a name toggle together, as in the
// reference. Immutable and plain (arrays, not a Set) so it can sit in state.

/** @typedef {{ defaultShow: boolean, inverts: string[] }} Selection */

export const SHOW_ALL = Object.freeze({ defaultShow: true, inverts: Object.freeze([]) })

export function shouldShow(sel, key) {
  const s = sel || SHOW_ALL
  return s.defaultShow !== s.inverts.includes(key)
}

export function isSelectMode(sel) {
  return !(sel || SHOW_ALL).defaultShow
}

/** Click: isolate `key`; clicking a series that is already isolated-and-shown shows all again. */
export function primaryClick(sel, key) {
  const s = sel || SHOW_ALL
  if (!s.defaultShow && s.inverts.includes(key)) return SHOW_ALL
  return { defaultShow: false, inverts: [key] }
}

/** Ctrl/⌘-click: flip `key` alone — hide it in normal mode, add or drop it in select mode. */
export function secondaryClick(sel, key) {
  const s = sel || SHOW_ALL
  const inverts = s.inverts.includes(key) ? s.inverts.filter(k => k !== key) : [...s.inverts, key]
  return { defaultShow: s.defaultShow, inverts }
}

/** The legend row handler: routes on the modifier keys of the click. */
export function legendClick(sel, key, event) {
  return event?.ctrlKey || event?.metaKey ? secondaryClick(sel, key) : primaryClick(sel, key)
}

// ---------- Chart model ----------

/**
 * @typedef {Object} ChartDataset
 * @property {string} id           full label set; unique per series (React key)
 * @property {string} dataKey      stable key for the chart row objects ('s<slot>' | '__others')
 * @property {string} label        legend text (also the selection key)
 * @property {object} metric
 * @property {Array<{x:number,y:number}>} data   x in ms
 * @property {number} reduceValue  the Legend value
 * @property {string} colour       line / swatch colour
 * @property {string} fill         stacked-area fill
 * @property {boolean} dashed      "Others" is dashed
 * @property {boolean} hidden      excluded by the legend selection
 * @property {boolean} isOthers
 * @property {number|undefined} prevValue   comparison value (undefined when Compare is off)
 * @property {{text:string,dir:string,ratio:number}|null} delta  null when Compare is off
 */

/**
 * @typedef {Object} ChartModel
 * @property {ChartDataset[]} datasets   legend rows, in legend order (Legend value desc, "Others" last)
 * @property {ChartDataset[]} drawn      the visible subset, same order
 * @property {ChartDataset[]} drawOrder  render order: reversed when stacked, so the top-ranked series sits on top
 * @property {{dataKey:string,label:string,colour:string,data:Array<{x:number,y:number}>}|null} ghost
 *           the comparison line, only while exactly one series is drawn (ARCH D6)
 * @property {string[]} labelsSet        Labels select options, first-seen order
 * @property {string} commonLabels       "k=v, …" for the "Common:" line
 * @property {boolean} showCommon        that line shows only when Labels = all
 * @property {number} total              series in the result
 * @property {number} matchCount         series matching the legend search
 * @property {number} shownCount         series listed (excluding "Others")
 * @property {boolean} limited           the 20-series limit is cutting the list: "Showing 20 of {matchCount}"
 * @property {number} limit
 */

function othersDataset(rest) {
  const sums = new Map()
  let reduceValue = 0
  for (const d of rest) {
    if (Number.isFinite(d.reduceValue)) reduceValue += d.reduceValue
    for (const p of d.data) sums.set(p.x, (sums.get(p.x) || 0) + p.y)
  }
  return {
    id: OTHERS_KEY, dataKey: OTHERS_KEY, label: OTHERS_LABEL, metric: {},
    data: [...sums].map(([x, y]) => ({ x, y })).sort((a, b) => a.x - b.x),
    reduceValue, colour: OTHERS_COLOUR, fill: OTHERS_FILL, dashed: true, isOthers: true,
    prevValue: undefined, delta: null, count: rest.length,
  }
}

/**
 * Builds everything the chart and its legend show.
 *
 * @param {Object} args
 * @param {Array<{metric:object, values:Array<{x:number,y:number}>}>} args.series  queryRange().series
 * @param {string} [args.legendLabel]   '' = all
 * @param {'last'|'avg'|'sum'} [args.formula]
 * @param {boolean} [args.stack]
 * @param {string} [args.search]        legend search: filters the legend AND the lines
 * @param {boolean} [args.limitOn]      false after "Show all"
 * @param {Selection} [args.selection]
 * @param {Array|null} [args.prevSeries]  the comparison window's series; null = Compare off
 * @param {boolean} [args.prevFailed]
 * @param {number} [args.compareShiftSec] how far back the comparison window is (for the ghost line)
 * @returns {ChartModel}
 */
export function buildChartModel({
  series, legendLabel = '', formula = 'avg', stack = false, search = '', limitOn = true,
  selection = SHOW_ALL, prevSeries = null, prevFailed = false, compareShiftSec = 0,
}) {
  const sorted = reduceSeries(series, formula)
  const labelsSet = collectLabelKeys(sorted)
  const { common, varying } = splitCommonLabels(sorted, labelsSet)
  const prevIndex = prevSeries && !prevFailed ? indexById(prevSeries) : null

  // Colour by identity, not rank (ARCH D7): slot = position in the
  // alphabetical order of full label sets, so changing the Legend value
  // re-sorts the legend without recolouring a single line.
  const ids = sorted.map(s => seriesId(s.metric))
  const slotOf = new Map([...new Set(ids)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map((id, i) => [id, i]))
  const seen = new Map()

  const all = sorted.map((s, i) => {
    const base = ids[i]
    const n = (seen.get(base) || 0) + 1
    seen.set(base, n)
    const slot = slotOf.get(base)
    const label = legendName(s.metric, { legendLabel, varying })
    return {
      id: n > 1 ? `${base}#${n}` : base,
      dataKey: n > 1 ? `s${slot}_${n}` : `s${slot}`,
      label, metric: s.metric, data: s.values, reduceValue: s.reduceValue,
      colour: seriesColour(slot), fill: seriesColour(slot, true), dashed: false, isOthers: false,
      ...comparison(base, s.reduceValue, formula, prevIndex, prevFailed),
    }
  })

  const q = (search || '').trim().toLowerCase()
  const shown = []
  const rest = []
  for (const d of all) (!q || d.label.toLowerCase().includes(q) ? shown : rest).push(d)
  const matchCount = shown.length

  const limited = limitOn && shown.length > LEGEND_LIMIT
  if (limited) {
    // An isolated series stays listed (and drawn) even past the top 20.
    for (const o of shown.splice(LEGEND_LIMIT)) {
      if (isSelectMode(selection) && shouldShow(selection, o.label)) shown.push(o)
      else rest.push(o)
    }
  }
  const shownCount = shown.length
  // Only a stack needs the left-out series accounted for: without "Others"
  // the stack's top would be a lie about the total.
  if (stack && rest.length) shown.push(othersDataset(rest))

  const datasets = shown.map(d => ({ ...d, hidden: !shouldShow(selection, d.label) }))
  const drawn = datasets.filter(d => !d.hidden)

  let ghost = null
  if (prevIndex && compareShiftSec > 0 && drawn.length === 1 && !drawn[0].isOthers) {
    const prev = prevIndex.get(seriesId(drawn[0].metric))
    if (prev?.values?.length) {
      ghost = {
        dataKey: GHOST_KEY, label: drawn[0].label, colour: drawn[0].colour,
        data: prev.values.map(p => ({ x: p.x + compareShiftSec * 1000, y: p.y })),
      }
    }
  }

  return {
    datasets, drawn, drawOrder: stack ? [...drawn].reverse() : drawn, ghost,
    labelsSet, commonLabels: labelsToString(common), showCommon: !legendLabel,
    total: all.length, matchCount, shownCount, limited, limit: LEGEND_LIMIT,
  }
}

/**
 * The chart's row objects for Recharts: one per x, each drawn series under
 * its `dataKey`. The x range is the full aligned window (every step, data or
 * not), so the axis spans what was asked for even when the result is empty.
 *
 * Unstacked, a missing point is left undefined and the line joins across it
 * (connectNulls), as the reference draws. Stacked, it is 0 within the series'
 * own span — a hole in a stack would otherwise drop every series above it.
 */
export function buildChartRows(model, xsMs, { stack = false } = {}) {
  const byX = new Map()
  for (const x of xsMs || []) byX.set(x, { x })
  const rowAt = (x) => {
    let r = byX.get(x)
    if (!r) { r = { x }; byX.set(x, r) }
    return r
  }
  for (const d of model.drawn) for (const p of d.data) rowAt(p.x)[d.dataKey] = p.y
  if (model.ghost) for (const p of model.ghost.data) if (byX.has(p.x)) byX.get(p.x)[GHOST_KEY] = p.y
  const rows = [...byX.values()].sort((a, b) => a.x - b.x)
  if (stack) {
    for (const d of model.drawn) {
      if (!d.data.length) continue
      const lo = d.data[0].x
      const hi = d.data[d.data.length - 1].x
      for (const r of rows) if (r.x >= lo && r.x <= hi && r[d.dataKey] === undefined) r[d.dataKey] = 0
    }
  }
  return rows
}

// Points are sorted by x; tooltips ask on every mouse move.
function pointAt(data, x) {
  let lo = 0
  let hi = data.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (data[mid].x === x) return data[mid]
    if (data[mid].x < x) lo = mid + 1
    else hi = mid - 1
  }
  return null
}

/**
 * The series whose line is vertically nearest `y` at `x` — the one a hover
 * emphasises. Stacked, it is the band `y` falls in.
 */
export function nearestAt(model, x, y, { stack = false } = {}) {
  if (!Number.isFinite(y)) return null
  if (stack) {
    let base = 0
    let best = null
    for (const d of model.drawOrder) {
      const p = pointAt(d.data, x)
      const top = base + (p ? p.y : 0)
      if (p && y >= base && y <= top) return d.dataKey
      if (p) best = d.dataKey
      base = top
    }
    return best
  }
  let best = null
  let dist = Infinity
  for (const d of model.drawn) {
    const p = pointAt(d.data, x)
    if (!p) continue
    const dd = Math.abs(p.y - y)
    if (dd < dist) { dist = dd; best = d.dataKey }
  }
  return best
}

/**
 * The hover tooltip at `x`: every drawn series with a point there, highest
 * value first, capped at 15 rows plus "+N more". The nearest series is
 * flagged, and kept in the list even when it would fall past the cap.
 *
 * @returns {{ x:number, title:string, items:Array<{dataKey:string,label:string,colour:string,dashed:boolean,value:number,nearest:boolean,prev?:number}>, more:number }}
 */
export function tooltipAt(model, x, { nearestKey = null, limit = TOOLTIP_LIMIT } = {}) {
  const items = []
  for (const d of model.drawn) {
    const p = pointAt(d.data, x)
    if (p) items.push({ dataKey: d.dataKey, label: d.label, colour: d.colour, dashed: d.dashed, value: p.y, nearest: d.dataKey === nearestKey })
  }
  items.sort((a, b) => byValueDesc(a.value, b.value))
  if (model.ghost && items.length === 1) {
    const g = pointAt(model.ghost.data, x)
    if (g) items[0].prev = g.y
  }
  let shown = items.slice(0, limit)
  const nearIdx = items.findIndex(it => it.nearest)
  if (nearIdx >= limit) shown = [...items.slice(0, limit - 1), items[nearIdx]]
  return { x, title: formatLocal(x, 'yyyy-MM-dd HH:mm:ss'), items: shown, more: Math.max(0, items.length - shown.length) }
}

// ---------- X axis (reference tick table `fln`) ----------

const TICK_TABLE = [
  [168, 1440], [72, 720], [48, 480], [24, 120], [6, 60], [2, 30], [1, 10], [0.5, 5],
]

/**
 * Ticks for a time axis from minMs to maxMs: the interval grows with the range
 * and ticks sit on multiples of it counted from local midnight of the start,
 * so a 6h chart ticks on the hour rather than at "start + 1h".
 */
export function buildTicks(minMs, maxMs) {
  if (!(maxMs > minMs)) return []
  const hours = (maxMs - minMs) / 36e5
  const minutes = TICK_TABLE.find(([h]) => hours >= h)?.[1] ?? 1
  const every = minutes * 60000
  const fmt = hours >= 48 ? 'yyyy-MM-dd HH:mm' : 'HH:mm'
  const midnight = new Date(minMs)
  midnight.setHours(0, 0, 0, 0)
  const origin = midnight.getTime()
  const out = []
  for (let t = origin + Math.ceil((minMs - origin) / every) * every; t <= maxMs; t += every) {
    out.push({ value: t, label: formatLocal(t, fmt) })
  }
  return out
}

/** The x axis for a resolved range: every step (ms), the domain, and the ticks. */
export function xAxisFor(resolved) {
  const xs = timestamps(resolved).map(t => t * 1000)
  const domain = resolved ? [resolved.start * 1000, resolved.end * 1000] : [0, 0]
  return { xs, domain, ticks: buildTicks(domain[0], domain[1]) }
}

// ---------- Table (reference `Wn` as Explore uses it) ----------

/**
 * @typedef {Object} TableRow
 * @property {string} key          JSON of the label cells — what a bare search term matches
 * @property {string} label        the Label cell
 * @property {string[]} labels     [label], for the search matcher
 * @property {number|undefined} value
 * @property {number|undefined} prevValue   undefined when Compare is off
 * @property {{text:string,dir:string,ratio:number}|null} delta
 * @property {number} change       relative change for sorting (NaN unknown, Infinity new)
 * @property {{metric:object, values:Array<{x:number,y:number}>}|null} series
 *           the row's series for the value sparkline (range results only)
 * @property {object} metric
 * @property {number} merged       how many series collapsed into this row
 */

function relativeChange(value, prevValue, delta) {
  if (!delta) return NaN
  if (delta.dir === 'new') return Infinity
  if (!Number.isFinite(value) || !Number.isFinite(prevValue) || prevValue === 0) return NaN
  return (value - prevValue) / Math.abs(prevValue)
}

/**
 * One row per distinct label text. Labels = all → the FULL label set (not just
 * the varying keys the legend uses); Labels = a key → that key's value, "" when
 * absent. Series with the same text MERGE into one row and the last one (the
 * lowest value, in value order) wins — reference behaviour, kept (ARCH D9).
 *
 * @param {Object} args
 * @param {Array} args.series  queryRange().series, queryInstant().series or queryReduced()
 * @returns {TableRow[]}
 */
export function buildTableRows({ series, legendLabel = '', formula = 'avg', prevSeries = null, prevFailed = false }) {
  const prevIndex = prevSeries && !prevFailed ? indexById(prevSeries) : null
  const items = (series || [])
    .map(s => ({ s, value: valueOf(s, formula) }))
    .sort((a, b) => byValueDesc(a.value, b.value))
  const byKey = new Map()
  for (const { s, value } of items) {
    const label = legendLabel ? (s.metric?.[legendLabel] || '') : labelsToString(s.metric)
    const key = JSON.stringify([label])
    let row = byKey.get(key)
    if (!row) {
      row = { key, label, labels: [label], series: null, merged: 0 }
      byKey.set(key, row)
    }
    const cmp = comparison(seriesId(s.metric), value, formula, prevIndex, prevFailed)
    row.value = value
    row.metric = s.metric
    row.merged += 1
    row.prevValue = cmp.prevValue
    row.delta = cmp.delta
    row.change = relativeChange(value, cmp.prevValue, cmp.delta)
    if (s.values?.length) row.series = { metric: s.metric, values: s.values }
  }
  return [...byKey.values()]
}

export const DEFAULT_TABLE_SORT = Object.freeze({ col: 'label', reversed: false })

// Missing values sort last in both directions: sorting ascending is asking
// for the smallest values, not for the rows that have none.
function numDesc(a, b) {
  const am = a === undefined || a === null || Number.isNaN(a)
  const bm = b === undefined || b === null || Number.isNaN(b)
  if (am || bm) return am === bm ? 0 : am ? 1 : -1
  if (a === b) return 0
  return b - a
}

/**
 * Reference sort: Label A→Z by default; the first click on a numeric column
 * sorts it high to low; clicking the active column again reverses it.
 *
 * @param {TableRow[]} rows
 * @param {{ col: 'label'|'value'|'prev'|'change', reversed: boolean }} sort
 */
export function sortRows(rows, sort = DEFAULT_TABLE_SORT) {
  const { col = 'label', reversed = false } = sort || {}
  const field = { value: 'value', prev: 'prevValue', change: 'change' }[col]
  const out = [...rows]
  if (!field) {
    out.sort((a, b) => (reversed ? -1 : 1) * (a.label ?? '').localeCompare(b.label ?? ''))
    return out
  }
  out.sort((a, b) => {
    const av = a[field]
    const bv = b[field]
    const missing = (v) => v === undefined || v === null || Number.isNaN(v)
    if (missing(av) || missing(bv)) return numDesc(av, bv)
    return reversed ? -numDesc(av, bv) : numDesc(av, bv)
  })
  return out
}

/** Header click: the same column flips direction; a new column starts unreversed. */
export function toggleSort(sort, col) {
  return sort?.col === col ? { col, reversed: !sort.reversed } : { col, reversed: false }
}

/** The first 20 unless "Show all" was pressed. */
export function limitRows(rows, limitOn = true, limit = TABLE_LIMIT) {
  const limited = limitOn && rows.length > limit
  return { rows: limited ? rows.slice(0, limit) : rows, total: rows.length, limited }
}

/**
 * What the table renders: search, then sort, then limit. `total` is the
 * FILTERED count, so "Showing 20 of N" never counts rows the search removed
 * (a reference bug, fixed per ARCH D9).
 */
export function tableView({ rows, search = '', sort = DEFAULT_TABLE_SORT, limitOn = true }) {
  const filtered = filterRows(rows || [], search)
  const view = limitRows(sortRows(filtered, sort), limitOn)
  return { ...view, allCount: (rows || []).length }
}

/** Distinct non-empty label texts — the value suggestions of the table search. */
export function searchValues(rows) {
  return [...new Set((rows || []).map(r => r.label).filter(Boolean))]
}
