// Context-aware completion for the Metrics Code tab.
//
// Pure, except for the three fetchers it is handed: it reads the caret's
// surroundings out of `tokenizePromql` — the same token stream that paints the
// editor — decides which question the person is in the middle of asking, and
// answers it from the catalogs plus whatever metadata the caller fetches.
// Nothing here knows about React, the time range, or `api.js`; the page wires
// the fetchers to `metricNames` / `metricLabelNames` / `metricLabelValues` with
// its own range and AbortSignal captured.
//
// Four questions, in the order they are tested:
//
//   1. inside a matcher's string      → values of that label, narrowed by the
//                                       rest of the selector (`match[]`)
//   2. elsewhere inside `{…}`         → label names of that selector, or
//                                       values when a matcher operator precedes
//   3. inside `by (…)` / `on (…)` …   → label names
//   4. anywhere else                  → metric names, then functions,
//                                       aggregations and keywords
//
// Only values are rewritten on insert — quoted and escaped, because PromQL has
// no other way to write one. Names go in verbatim: a completion that also typed
// `(` or `=` would be guessing at the shape of an expression the person has not
// finished thinking about.

import { tokenizePromql } from '@/utils/explore/promql'
import { quoteString } from '../builders.js'
import {
  METRIC_DOCS, LABEL_DOCS, FUNCTION_DOCS, PROMQL_KEYWORDS, PROMQL_KEYWORD_GROUPS,
} from '../catalogs.js'
import {
  tokenIndexAt, prevSignificant, nextSignificant, lastSignificantBefore, wordRange,
  rankMatches, toValueRows, isQuoted,
} from '../caret.js'

/** Tokens a completion replaces whole. Numbers and durations are deliberately out. */
const WORDY = new Set(['metric', 'label', 'function', 'aggregation', 'keyword'])

/** Tokens that can name a label on the left of a matcher. */
const LABELISH = new Set(['label', 'metric'])

/** Tokens where a completion has nothing to say: the caret is inside a literal. */
const MUTE = new Set(['number', 'duration', 'macro'])

/** Keywords whose parenthesised list is a list of label names. */
const GROUPING = new Set(['by', 'without', 'on', 'ignoring', 'group_left', 'group_right'])

// Which group of PROMQL_KEYWORDS a word came from. The flat list is deduplicated
// in group order, so the first group that claims a name owns it.
const GROUP_OF = (() => {
  const m = new Map()
  for (const [group, names] of Object.entries(PROMQL_KEYWORD_GROUPS)) {
    for (const n of names) if (!m.has(n)) m.set(n, group)
  }
  return m
})()

const GROUP_KIND = {
  aggregations: 'aggregation',
  functions: 'function',
  overTime: 'function',
  vectorMatching: 'keyword',
  modifiers: 'keyword',
}

const GROUP_DETAIL = {
  aggregations: 'aggregation',
  functions: 'function',
  overTime: 'rollup',
  vectorMatching: 'vector matching',
  modifiers: 'modifier',
}

// Built once: the vocabulary never changes, and rebuilding it per keystroke
// would allocate ninety objects for every character typed.
const KEYWORD_ITEMS = PROMQL_KEYWORDS.map((name) => {
  const group = GROUP_OF.get(name) ?? 'functions'
  return {
    label: name,
    insertText: name,
    kind: GROUP_KIND[group] ?? 'keyword',
    detail: GROUP_DETAIL[group] ?? '',
    doc: FUNCTION_DOCS[name],
  }
})

const EMPTY = caret => ({ from: caret, to: caret, items: [] })

const clamp = (n, lo, hi) => Math.min(Math.max(Number.isFinite(n) ? n : lo, lo), hi)

async function fetchList(fn, ...args) {
  if (typeof fn !== 'function') return []
  try {
    return toValueRows(await fn(...args))
  } catch {
    // A completion is an offer, not a result. A metadata call that fails leaves
    // the person with the catalogs rather than with an error they did not ask for.
    return []
  }
}

const hitsDetail = row => (row.hits == null ? undefined : `${row.hits}`)

/** Index of the `{` opening the selector the caret is inside, or -1. */
function selectorAt(tokens, caret) {
  const stack = []
  for (let i = 0; i < tokens.length && tokens[i].start < caret; i++) {
    const t = tokens[i]
    if (t.type !== 'brace') continue
    if (t.value === '{') stack.push(i)
    else stack.pop()
  }
  return stack.length ? stack[stack.length - 1] : -1
}

/** True when the caret is inside the parenthesised list of a grouping keyword. */
function inGroupingList(tokens, caret) {
  const stack = []
  for (let i = 0; i < tokens.length && tokens[i].start < caret; i++) {
    const t = tokens[i]
    if (t.type !== 'paren') continue
    if (t.value === '(') stack.push(i)
    else stack.pop()
  }
  if (!stack.length) return false
  const kw = prevSignificant(tokens, stack[stack.length - 1])
  return kw >= 0 && tokens[kw].type === 'keyword' && GROUPING.has(tokens[kw].value.toLowerCase())
}

/**
 * The `match[]` that narrows a metadata call to this selector: the metric name
 * and every COMPLETE matcher in it, minus the one being edited.
 *
 * Half-written matchers are left out on purpose — `{service=}` selects nothing,
 * and narrowing the list to nothing is how the reference ends up offering no
 * values at the moment you most need them. `excludeAt` is the start offset of
 * the token under the caret.
 */
function matchFor(tokens, openBrace, excludeAt) {
  if (openBrace < 0) return []
  const nameIdx = prevSignificant(tokens, openBrace)
  const name = nameIdx >= 0 && tokens[nameIdx].type === 'metric' ? tokens[nameIdx].value : ''
  const parts = []
  for (let i = openBrace + 1; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.type === 'brace') break
    if (!LABELISH.has(t.type)) continue
    const opIdx = nextSignificant(tokens, i)
    if (opIdx < 0 || tokens[opIdx].type !== 'matchop') continue
    const valIdx = nextSignificant(tokens, opIdx)
    if (valIdx < 0 || tokens[valIdx].type !== 'string') continue
    if (t.start !== excludeAt && tokens[valIdx].start !== excludeAt) {
      parts.push(`${t.value}${tokens[opIdx].value}${tokens[valIdx].value}`)
    }
    i = valIdx
  }
  if (parts.length) return [`${name}{${parts.join(',')}}`]
  return name ? [name] : []
}

function labelItems(rows) {
  return rows.map(r => ({
    label: r.value,
    insertText: r.value,
    kind: 'label',
    detail: hitsDetail(r) ?? 'label',
    doc: LABEL_DOCS[r.value],
  }))
}

function valueItems(rows) {
  return rows.map(r => ({
    label: r.value,
    insertText: quoteString(r.value),
    kind: 'value',
    detail: hitsDetail(r),
    doc: undefined,
  }))
}

function metricItems(rows) {
  return rows.map(r => ({
    label: r.value,
    insertText: r.value,
    kind: 'metric',
    detail: 'metric',
    doc: METRIC_DOCS[r.value],
  }))
}

/**
 * Completions for `text` with the caret at `caret`.
 *
 * @param {string} text
 * @param {number} caret
 * @param {{metricNames?:Function, labelNames?:Function, labelValues?:Function}} fetchers
 *   `metricNames()`, `labelNames(match)` and `labelValues(label, match)`, each
 *   resolving to `string[]` or `{value, hits}[]`. A missing one simply
 *   contributes nothing.
 * @param {{limit?:number}} [options]
 * @returns {Promise<{from:number, to:number, items:Array<{label:string, insertText:string, kind:string, detail?:string, doc?:string}>}>}
 *   `from`/`to` is the span in `text` the chosen `insertText` replaces.
 */
export async function suggestPromql(text, caret, fetchers = {}, { limit = 50 } = {}) {
  const src = String(text ?? '')
  const pos = clamp(caret, 0, src.length)
  const tokens = tokenizePromql(src)
  const idx = tokenIndexAt(tokens, pos)
  const tok = idx >= 0 ? tokens[idx] : null
  const openBrace = selectorAt(tokens, pos)

  if (tok && MUTE.has(tok.type)) return EMPTY(pos)

  // ---- 1. inside a label matcher's string ----
  const inString = tok && (tok.type === 'string' || (tok.type === 'error' && isQuoted(tok.value)))
  if (inString) {
    const opIdx = prevSignificant(tokens, idx)
    const lblIdx = opIdx < 0 ? -1 : prevSignificant(tokens, opIdx)
    if (openBrace < 0 || opIdx < 0 || tokens[opIdx].type !== 'matchop'
      || lblIdx < 0 || !LABELISH.has(tokens[lblIdx].type)) return EMPTY(pos)

    const label = tokens[lblIdx].value
    // An unterminated string swallowed the rest of the input, so replacing to
    // its end would eat the closing brace with it. Stop at the caret instead:
    // the inserted literal brings its own closing quote.
    const to = tok.type === 'error' ? pos : tok.end
    const fragment = src.slice(tok.start + 1, Math.max(tok.start + 1, pos))
    const rows = await fetchList(fetchers.labelValues, label, matchFor(tokens, openBrace, tok.start))
    return { from: tok.start, to, items: rankMatches(valueItems(rows), fragment).slice(0, limit) }
  }

  const w = wordRange(tokens, pos, WORDY)
  const prevIdx = lastSignificantBefore(tokens, w.from)
  const prev = prevIdx >= 0 ? tokens[prevIdx] : null

  // ---- 2. inside a selector ----
  if (openBrace >= 0) {
    if (prev && prev.type === 'matchop') {
      // `{service=` — a value, not yet quoted. Quote it on the way in.
      const lblIdx = prevSignificant(tokens, prevIdx)
      if (lblIdx < 0 || !LABELISH.has(tokens[lblIdx].type)) return EMPTY(pos)
      const rows = await fetchList(
        fetchers.labelValues, tokens[lblIdx].value, matchFor(tokens, openBrace, w.from)
      )
      return { from: w.from, to: w.to, items: rankMatches(valueItems(rows), w.fragment).slice(0, limit) }
    }
    const rows = await fetchList(fetchers.labelNames, matchFor(tokens, openBrace, w.from))
    return { from: w.from, to: w.to, items: rankMatches(labelItems(rows), w.fragment).slice(0, limit) }
  }

  // ---- 3. a grouping list ----
  if (inGroupingList(tokens, pos)) {
    const rows = await fetchList(fetchers.labelNames, [])
    return { from: w.from, to: w.to, items: rankMatches(labelItems(rows), w.fragment).slice(0, limit) }
  }

  // ---- 4. an expression ----
  const rows = await fetchList(fetchers.metricNames)
  const items = rankMatches(metricItems(rows).concat(KEYWORD_ITEMS), w.fragment)
  return { from: w.from, to: w.to, items: items.slice(0, limit) }
}

export default suggestPromql
