// The Explore page's state, as data.
//
// Everything the page remembers lives in ONE plain object: which datasource is
// showing, each datasource's three (or two) editor drafts, what each has
// committed, and the toolbar settings. No functions, no class instances, no
// React handles — ARCH D14 keeps URL state sync out of scope but keeps it
// *possible*, and that is only true while this object can be stringified.
//
// Keeping the transitions here rather than in `ExploreView` buys three things:
//
//   · They are testable without rendering anything. The rules below — which
//     tab an incoming payload opens, what a tab switch carries over, when the
//     run button is dirty — are the parts of the page most likely to be got
//     subtly wrong, and they are the parts a browser test is worst at pinning.
//   · They are total. Every function takes a state and returns a state; an
//     unknown datasource, a tab a datasource does not have, or a model from
//     another product version returns the state unchanged instead of throwing
//     inside a render (the reference throws in three such places — see
//     `docs/explore/reference/`).
//   · The page component reads as a layout again, because the decisions are
//     named rather than inlined.
//
// The one thing NOT here is the editors' own internal state (which row is
// open, what the metadata fetch returned). That belongs to the editors, and it
// is not serialisable.

import {
  buildAdvancedQuery, buildLogsqlQuery, buildQuickQuery,
  defaultAdvancedModel, defaultBuilderModel, defaultQuickModel,
  emptyPair, newStatsAgg,
} from './builders.js'
import { DEFAULT_COMPARE } from '@/utils/timeRange.js'

// ---------- Vocabulary ----------

/** The datasource switch, in the reference's order. Mobile is out of scope. */
export const DATASOURCES = Object.freeze([
  Object.freeze({ value: 'prometheus', label: 'Metrics' }),
  Object.freeze({ value: 'vlogs', label: 'Logs' }),
  Object.freeze({ value: 'traces', label: 'Traces' }),
])

const METRICS_TABS = Object.freeze([
  Object.freeze({ value: 'quick', label: 'Quick' }),
  Object.freeze({ value: 'advanced', label: 'Advanced' }),
  Object.freeze({ value: 'code', label: 'Code' }),
])

const LOGS_TABS = Object.freeze([
  Object.freeze({ value: 'builder', label: 'Builder' }),
  Object.freeze({ value: 'code', label: 'Code' }),
])

const FORMULAS = new Set(['last', 'avg', 'sum'])

/** Metrics is the one datasource with a model-less middle tab and three modes. */
export function isMetricsSource(datasource) {
  return datasource === 'prometheus'
}

/** The mode toggle's options for a datasource (ARCH D1). */
export function tabsFor(datasource) {
  return isMetricsSource(datasource) ? METRICS_TABS : LOGS_TABS
}

// ---------- Initial state ----------

// ARCH D2 / CLAUDE.md rule 5: the page opens on a chart, not on an empty form.
// Every datasource is committed up front rather than on first arrival —
// observably the same thing, since only the showing datasource is ever run,
// and it keeps "returning to a datasource restores its committed query" true
// without a visited-set to maintain.

function metricsEditor() {
  const quick = defaultQuickModel()
  const advanced = defaultAdvancedModel()
  const query = buildQuickQuery(quick)
  return {
    tab: 'quick',
    quick: { model: quick, query },
    advanced: { model: advanced, query: buildAdvancedQuery(advanced) },
    code: { query: '', touched: false, seededFrom: null },
    committed: query,
  }
}

function logsEditor(datasource) {
  const model = defaultBuilderModel(datasource)
  const query = buildLogsqlQuery(model)
  return {
    tab: 'builder',
    builder: { model, query },
    code: { query: '', touched: false, seededFrom: null },
    committed: query,
  }
}

/** The page as it opens from the sidebar. */
export function initialState() {
  return {
    datasource: 'prometheus',
    editors: {
      prometheus: metricsEditor(),
      vlogs: logsEditor('vlogs'),
      traces: logsEditor('traces'),
    },
    // Toolbar settings are page-global and survive a datasource switch
    // (ARCH D2). Compare defaults to the previous period per ARCH D6.
    view: 'line',
    legendLabel: '',
    formula: 'avg',
    unit: 'number',
    stack: false,
    compare: DEFAULT_COMPARE,
  }
}

// ---------- Reading ----------

function queryOfTab(editor, tab) {
  if (!editor) return ''
  if (tab === 'code') return editor.code?.query ?? ''
  return editor[tab]?.query ?? ''
}

/**
 * The query the ACTIVE tab of a datasource currently spells — what Generate
 * Graph would commit, which is not what the chart is drawing.
 *
 * @param {object} state  the whole page state
 * @param {string} [datasource]  defaults to the showing one
 */
export function draftQuery(state, datasource = state?.datasource) {
  const editor = state?.editors?.[datasource]
  return queryOfTab(editor, editor?.tab)
}

/**
 * What the results area is for: the showing datasource and its committed
 * query, or null while nothing has been committed. The pair is what
 * `useExploreResult` keys on, so it must be stable between real changes —
 * callers memoise it.
 */
export function committedQuery(state) {
  const datasource = state?.datasource
  const query = state?.editors?.[datasource]?.committed
  return query ? { datasource, query } : null
}

/** Has the editor run ahead of the chart? (ARCH D2 — the run button's dot.) */
export function isDirty(state) {
  const editor = state?.editors?.[state?.datasource]
  if (!editor) return false
  return draftQuery(state) !== (editor.committed ?? '')
}

// ---------- Transitions ----------

function withEditor(state, datasource, editor) {
  return { ...state, editors: { ...state.editors, [datasource]: editor } }
}

/**
 * Switch datasource. Each one keeps its own drafts and its own committed
 * query, so this is a move between two running pages rather than a reset.
 *
 * `legendLabel` is the one toolbar setting that cannot travel: it names a
 * label KEY of the result, and logs and metrics do not share a vocabulary
 * (ARCH D2).
 */
export function setDatasource(state, datasource) {
  if (!state?.editors?.[datasource] || datasource === state.datasource) return state
  return { ...state, datasource, legendLabel: '' }
}

/**
 * Switch mode within the showing datasource.
 *
 * ARCH D3: moving INTO Code seeds it from the tab you came from, but only
 * while Code is untouched — once it has been typed in, it owns its text and a
 * later visit must not overwrite it. `seededFrom` is the tab's own key, which
 * the Code tabs turn into the one-line "this is a copy" hint. There is no
 * parsing back the other way, so no other switch carries anything.
 */
export function setTab(state, tab) {
  const datasource = state?.datasource
  const editor = state?.editors?.[datasource]
  if (!editor || tab === editor.tab) return state
  if (!tabsFor(datasource).some(t => t.value === tab)) return state
  const next = { ...editor, tab }
  if (tab === 'code' && !editor.code?.touched) {
    next.code = { ...editor.code, query: queryOfTab(editor, editor.tab), seededFrom: editor.tab }
  }
  return withEditor(state, datasource, next)
}

/** What an editor hands back from `onChange`: its whole state object. */
export function setEditor(state, editor) {
  if (!editor || !state?.editors?.[state.datasource]) return state
  return withEditor(state, state.datasource, editor)
}

/** Generate Graph: the draft becomes what the results area is drawing. */
export function commit(state) {
  const datasource = state?.datasource
  const editor = state?.editors?.[datasource]
  const query = draftQuery(state)
  if (!editor || !query || query === editor.committed) return state
  return withEditor(state, datasource, { ...editor, committed: query })
}

/** A page-global toolbar setting (view, legendLabel, formula, unit, stack, compare). */
export function setSetting(state, key, value) {
  if (!state || !(key in state) || key === 'editors' || key === 'datasource') return state
  return { ...state, [key]: value }
}

// ---------- Incoming payloads (ARCH D13) ----------

// A payload is `{ datasource, query?, model?, unit?, formula?, legendLabel?,
// stack? }` and arrives from another page, so none of it is trusted to have
// the shape this build expects. Three rules decide where it lands, and they
// are the reference's own (`docs/explore/reference/metrics-editor.md`,
// "Choosing the opening tab"):
//
//   · A model wins over a query: the builder regenerates the query from the
//     model, so a disagreeing `query` would be overwritten anyway.
//   · `model.type` picks the tab — but only when that tab exists on the
//     payload's datasource. A Logs `builder` model addressed to Metrics is a
//     model this editor cannot show, and the reference opens Code for it.
//   · A query with no usable model opens Code, already touched, because it is
//     the author of its own text and nothing should re-seed it.

/**
 * Filter rows arrive as the reference emits them — `{label, operator, values,
 * options}`, with the fetched value list still attached. Ours are
 * `{label, operator, values}`; `options` is stripped here, exactly as the
 * reference strips it on the way in (reference divergence 2 / 7).
 */
function cleanPair(pair) {
  const label = pair?.label
  const operator = pair?.operator
  const values = pair?.values
  return {
    // `allowClear` in the reference sets a cleared label to undefined, not ''.
    label: label == null ? '' : String(label),
    operator: operator ? String(operator) : '=',
    values: Array.isArray(values) ? values.map(v => (v == null ? '' : String(v))) : [],
  }
}

function cleanPairs(list) {
  const rows = Array.isArray(list) ? list.map(cleanPair) : []
  // Every rows editor expects at least the blank row to type into.
  return rows.length ? rows : [emptyPair()]
}

// A pipe is copied rather than referenced: `catalogs.js` is deep-frozen and
// the reference appends the catalogue constant itself, so two cards in an
// imported model can share one object (reference divergence 9).
function cleanPipe(pipe) {
  if (pipe?.value === 'stats') {
    const aggs = Array.isArray(pipe.aggs) ? pipe.aggs : []
    return {
      value: 'stats',
      by: Array.isArray(pipe.by) ? pipe.by.map(String) : [],
      aggs: aggs.length
        ? aggs.map(a => ({
          fn: a?.fn ? String(a.fn) : 'count',
          args: Array.isArray(a?.args) ? a.args.map(x => (x == null ? '' : String(x))) : [''],
          filter: a?.filter == null ? '' : String(a.filter),
          alias: a?.alias == null ? '' : String(a.alias),
        }))
        : [newStatsAgg()],
    }
  }
  if (pipe?.value === 'math') {
    return {
      value: 'math',
      expr: pipe.expr == null ? '' : String(pipe.expr),
      alias: pipe.alias == null ? '' : String(pipe.alias),
    }
  }
  return null
}

/** An incoming model in this build's shape, or null when it is not one we show. */
export function cleanModel(model) {
  if (!model || typeof model !== 'object') return null
  if (model.type === 'quick') {
    return {
      type: 'quick',
      calculate: model.calculate ? String(model.calculate) : 'rpm',
      // The percentile is the raw input text in the reference, so a number here
      // is still legal — `buildQuickQuery` parses it.
      value: model.value == null ? '90' : String(model.value),
      labelPairs: cleanPairs(model.labelPairs),
      groupBy: Array.isArray(model.groupBy) ? model.groupBy.map(String) : [],
    }
  }
  if (model.type === 'advanced') {
    return {
      type: 'advanced',
      metric: model.metric == null ? '' : String(model.metric),
      labelPairs: cleanPairs(model.labelPairs),
      functions: Array.isArray(model.functions) ? model.functions.map(f => ({ ...f })) : [],
    }
  }
  if (model.type === 'builder') {
    return {
      type: 'builder',
      streamPairs: cleanPairs(model.streamPairs),
      labelPairs: cleanPairs(model.labelPairs),
      pipes: Array.isArray(model.pipes) ? model.pipes.map(cleanPipe).filter(Boolean) : [],
    }
  }
  return null
}

/**
 * Apply a payload from another page. It is committed immediately (ARCH D2) —
 * a link that lands on an unrun query asks the reader to press a button to see
 * the thing they just clicked through to.
 */
export function applyIncoming(state, payload) {
  if (!state || !payload) return state
  const datasource = state.editors?.[payload.datasource] ? payload.datasource : 'prometheus'
  const editor = state.editors[datasource]
  const model = cleanModel(payload.model)
  const type = model?.type
  const metrics = isMetricsSource(datasource)

  let next = editor
  if (metrics && (type === 'quick' || type === 'advanced')) {
    const query = type === 'quick' ? buildQuickQuery(model) : buildAdvancedQuery(model)
    next = { ...editor, tab: type, [type]: { model, query }, committed: query || editor.committed }
  } else if (!metrics && type === 'builder') {
    const query = buildLogsqlQuery(model)
    next = { ...editor, tab: 'builder', builder: { model, query }, committed: query || editor.committed }
  } else {
    const query = payload.query == null ? '' : String(payload.query)
    // Nothing to load: the datasource still changes, and its own committed
    // query is what the reader sees — better than a blank Code tab.
    if (query) {
      next = { ...editor, tab: 'code', code: { query, touched: true, seededFrom: null }, committed: query }
    }
  }

  return {
    ...withEditor(state, datasource, next),
    datasource,
    legendLabel: typeof payload.legendLabel === 'string' ? payload.legendLabel : '',
    formula: FORMULAS.has(payload.formula) ? payload.formula : 'avg',
    unit: payload.unit === 'time' || payload.unit === 'number' ? payload.unit : state.unit,
    stack: typeof payload.stack === 'boolean' ? payload.stack : state.stack,
  }
}

// ---------- Card menus → a payload (ARCH D13) ----------

// `CardMenu` reports an action and the card's title and nothing else, and the
// service pages are full of cards whose titles are the only description of
// what they plot. Rather than teach every one of them a query — a change
// across thirty call sites in a file someone else has work in flight on —
// the title IS the description, read here.
//
// This is a best effort by design: it answers with the Quick model nearest to
// what the card showed, lands the reader on the Quick tab with every control
// filled in, and lets them correct it in one click. Guessing wrong costs a
// dropdown; refusing to guess costs the entry point.

const PERCENTILE = /\bp(\d{1,3}(?:\.\d+)?)\b/i

function calculateFor(subject) {
  const s = subject.toLowerCase()
  if (/error|fail|5xx|4xx/.test(s)) return { calculate: 'error_percentage', unit: 'number' }
  const p = PERCENTILE.exec(s)
  if (p) return { calculate: 'latency_percentile', value: p[1], unit: 'time' }
  if (/%ile|percentile|quantile/.test(s)) return { calculate: 'latency_percentile', value: '90', unit: 'time' }
  if (/rpm|throughput|rate|calls|requests|hits|count|traffic/.test(s)) return { calculate: 'rpm', unit: 'number' }
  if (/latency|response time|duration|apdex|time/.test(s)) return { calculate: 'latency_average', unit: 'time' }
  return { calculate: 'rpm', unit: 'number' }
}

/**
 * A card menu's Explore action → the payload App's `openLink` carries, or null
 * when the action is one of the others.
 *
 * `action` is the menu item's visible label, which is how the per-column items
 * on a table card say which column was picked ("Explore - p90 Latency"). The
 * subject is that column when there is one and the card's title otherwise.
 *
 * @param {{action:string, title?:string, serviceId?:string, endpoint?:string}} args
 */
export function explorePayloadForCard({ action, title = '', serviceId = '', endpoint = '' }) {
  const label = String(action ?? '')
  if (!/^Explore\b/.test(label)) return null
  const column = label.startsWith('Explore - ') ? label.slice('Explore - '.length) : ''
  const subject = (column || title || '').trim()
  const { calculate, value = '90', unit } = calculateFor(subject)

  const labelPairs = []
  if (serviceId) labelPairs.push({ label: 'service', operator: '=', values: [serviceId] })
  if (endpoint) labelPairs.push({ label: 'root_name', operator: '=', values: [endpoint] })
  labelPairs.push(emptyPair())

  return {
    datasource: 'prometheus',
    model: { type: 'quick', calculate, value, labelPairs, groupBy: ['root_name'] },
    // One service's endpoints: naming each line by its endpoint says more than
    // repeating the service name on every row (ARCH D8's label rules).
    legendLabel: 'root_name',
    unit,
  }
}
