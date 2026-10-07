// Context-aware completion for the Logs and Traces Code tab.
//
// Same contract as its PromQL sibling: pure except for the fetchers it is
// handed, reading the caret's surroundings out of `tokenizeLogsql` — the token
// stream that already paints the editor — and answering from the catalogs plus
// whatever metadata the caller fetches.
//
// The tokenizer tracks which pipe it is in, and what each open paren opened,
// while it classifies; it does not publish that state. So this module walks the
// tokens up to the caret and rebuilds the little of it a completer needs: the
// current pipe, the paren stack, and whether we are inside a `{…}` stream
// selector. It is a local re-derivation of the lexer's own bookkeeping, not a
// second opinion about the language — the parser remains the authority on what
// a query means.
//
// Questions, in the order they are tested:
//
//   | <caret>                     → pipe names
//   {<caret>} / {"service"=…      → stream field names, then their values
//   field:<caret>                 → values of that field
//   field:in(<caret>              → values of that field
//   stats by (<caret> / fn(<caret>→ field names
//   | stats <caret>               → stats functions
//   | fields <caret>              → field names
//   anywhere in a filter          → field names (with the `:`) and filter functions
//
// Insert shapes follow what the Builder emits in the same position, so a query
// you complete by hand and the same query built with the rows read alike:
// stream names and stream values are always quoted; a field name elsewhere is
// quoted only when it has to be; a bare `field:value` filter keeps a plain
// value plain.

import { tokenizeLogsql } from '@/utils/explore/logsql'
import { quoteString, quoteFieldName } from '../builders.js'
import { LOGSQL_PIPES, LOGSQL_STATS_FUNCTIONS, LOGSQL_FILTER_FUNCTIONS } from '../catalogs.js'
import {
  tokenIndexAt, prevSignificant, lastSignificantBefore, wordRange,
  rankMatches, toValueRows, unquote, isQuoted,
} from '../caret.js'

/** Tokens a completion replaces whole. */
const WORDY = new Set(['field', 'word', 'number', 'pipeName', 'statsFn', 'keyword', 'error'])

/** Tokens that can name a field on the left of a `:` or an `=`. */
const FIELDISH = new Set(['field', 'word', 'string', 'number'])

/** Pipes whose bare arguments are field names (mirrors the lexer's own list). */
const FIELD_LIST_PIPES = new Set([
  'fields', 'keep', 'delete', 'del', 'drop', 'rm', 'rename', 'mv', 'copy', 'cp',
  'uniq', 'top', 'sort', 'order', 'first', 'last', 'facets', 'field_values',
])

/** Filter functions that take values of the field they were called on. */
const VALUE_FUNCS = new Set(['in', 'not_in', 'contains_all', 'contains_any', 'exact', 'i', 'seq'])

const PIPE_ITEMS = LOGSQL_PIPES.map(p => ({
  label: p.name, insertText: p.name, kind: 'pipe', detail: 'pipe', doc: p.detail,
}))

const STATS_ITEMS = LOGSQL_STATS_FUNCTIONS.map(f => ({
  label: f.name, insertText: f.name, kind: 'statsFn', detail: 'stats', doc: f.detail,
}))

const FILTER_ITEMS = LOGSQL_FILTER_FUNCTIONS.map(f => ({
  label: f.name, insertText: f.name, kind: 'filterFn', detail: 'filter', doc: f.detail,
}))

const EMPTY = caret => ({ from: caret, to: caret, items: [] })

const clamp = (n, lo, hi) => Math.min(Math.max(Number.isFinite(n) ? n : lo, lo), hi)

async function fetchList(fn, ...args) {
  if (typeof fn !== 'function') return []
  try {
    return toValueRows(await fn(...args))
  } catch {
    // A completion is an offer, not a result: a failed metadata call leaves the
    // person with the catalogs rather than with an error they did not ask for.
    return []
  }
}

const hitsDetail = row => (row.hits == null ? undefined : `${row.hits}`)

// A value LogsQL reads as one bare token. The first character may not be `-`
// (that is a negation) and the word may not read as an operator.
const PLAIN_VALUE = /^[A-Za-z0-9_.][A-Za-z0-9_.\-/@]*$/
const RESERVED = new Set(['and', 'or', 'not', 'in', 'not_in'])

/** A value as the Builder would write it in a bare `field:value` filter. */
export function logsqlValueLiteral(value) {
  const s = String(value ?? '')
  return PLAIN_VALUE.test(s) && !RESERVED.has(s.toLowerCase()) ? s : quoteString(s)
}

/** The field named immediately before token `index`, '' when there is none. */
function fieldBefore(tokens, index) {
  const i = prevSignificant(tokens, index)
  if (i < 0) return ''
  const t = tokens[i]
  if (!FIELDISH.has(t.type)) return ''
  // A field token is often already quoted — `{"service"=…}`, `by ("log.level")`
  // — and the name we ask the metadata call for is the one inside the quotes.
  return isQuoted(t.value) ? unquote(t.value) : t.value
}

/** True for the `:`, `:=`, `:!=`, `:~`, `:>` … that introduce a field's value. */
const isFieldOp = t => !!t && (t.type === 'colon' || (t.type === 'operator' && t.value.startsWith(':')))

/** True for the `=`, `!=`, `=~` … inside a `{…}` stream selector. */
const isStreamOp = t => !!t && t.type === 'operator' && !t.value.startsWith(':')

/**
 * What the paren at significant position `k` opened.
 *
 * `field:in(` is the one worth the extra look-back: inside it the person is
 * picking values of that field, and offering field names there would answer the
 * previous question.
 */
function parenFrame(tokens, sig, k) {
  const prev = k > 0 ? tokens[sig[k - 1]] : null
  if (!prev) return { kind: 'group' }
  const word = prev.value.toLowerCase()
  if (prev.type === 'statsFn') return { kind: 'statsFn' }
  if (prev.type === 'keyword' && word === 'by') return { kind: 'by' }
  if (prev.type === 'keyword' && word === 'if') return { kind: 'if' }
  if (prev.type === 'keyword' && VALUE_FUNCS.has(word)) {
    const colon = k >= 2 ? tokens[sig[k - 2]] : null
    const field = isFieldOp(colon) ? fieldBefore(tokens, sig[k - 2]) : ''
    return { kind: 'fn', fn: word, field }
  }
  if (prev.type === 'keyword') return { kind: 'fn', fn: word, field: '' }
  return { kind: 'group' }
}

/**
 * The lexer's own state at `limit`: which pipe we are in, whether a pipe name is
 * expected next, how deep the stream selector is, and what each open paren opened.
 */
function stateAt(tokens, limit) {
  const sig = []
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].end > limit) break
    if (tokens[i].type !== 'whitespace') sig.push(i)
  }
  let pipe = null
  let expectPipeName = false
  let braceDepth = 0
  const parens = []
  for (let k = 0; k < sig.length; k++) {
    const t = tokens[sig[k]]
    if (t.type === 'pipe') {
      pipe = null
      expectPipeName = true
      parens.length = 0
      braceDepth = 0
      continue
    }
    if (expectPipeName) {
      pipe = t.value.toLowerCase()
      expectPipeName = false
      continue
    }
    if (t.type === 'paren') {
      if (t.value === '(' || t.value === '[') parens.push(parenFrame(tokens, sig, k))
      else parens.pop()
      continue
    }
    if (t.type === 'brace') {
      braceDepth += t.value === '{' ? 1 : -1
      if (braceDepth < 0) braceDepth = 0
    }
  }
  return { pipe, expectPipeName, braceDepth, parens, top: parens[parens.length - 1] ?? null }
}

function valueItems(rows, quoteAll) {
  return rows.map(r => ({
    label: r.value,
    insertText: quoteAll ? quoteString(r.value) : logsqlValueLiteral(r.value),
    kind: 'value',
    detail: hitsDetail(r),
    doc: undefined,
  }))
}

function fieldItems(rows, { colon = false, quoteAll = false } = {}) {
  return rows.map(r => ({
    label: r.value,
    insertText: (quoteAll ? quoteString(r.value) : quoteFieldName(r.value)) + (colon ? ':' : ''),
    kind: 'field',
    detail: hitsDetail(r) ?? 'field',
    doc: undefined,
  }))
}

/**
 * Completions for `text` with the caret at `caret`.
 *
 * @param {string} text
 * @param {number} caret
 * @param {{fieldNames?:Function, fieldValues?:Function, streamFieldNames?:Function, streamFieldValues?:Function}} fetchers
 *   `fieldNames()`, `fieldValues(field)`, `streamFieldNames()` and
 *   `streamFieldValues(field)`, each resolving to `string[]` or
 *   `{value, hits}[]`. A missing one simply contributes nothing.
 * @param {{limit?:number}} [options]
 * @returns {Promise<{from:number, to:number, items:Array<{label:string, insertText:string, kind:string, detail?:string, doc?:string}>}>}
 *   `from`/`to` is the span in `text` the chosen `insertText` replaces.
 */
export async function suggestLogsql(text, caret, fetchers = {}, { limit = 50 } = {}) {
  const src = String(text ?? '')
  const pos = clamp(caret, 0, src.length)
  const tokens = tokenizeLogsql(src)
  const idx = tokenIndexAt(tokens, pos)
  const tok = idx >= 0 ? tokens[idx] : null

  // A string the caret is inside is replaced whole, and whatever goes back in
  // brings its own quotes. An unterminated one swallowed the rest of the input,
  // so the replacement stops at the caret rather than eating the pipes after it.
  const inString = tok && (tok.type === 'string' || (tok.type === 'error' && isQuoted(tok.value)))
  const w = inString
    ? {
        from: tok.start,
        to: tok.type === 'error' ? pos : tok.end,
        fragment: src.slice(tok.start + 1, Math.max(tok.start + 1, pos)),
        quoted: true,
      }
    : { ...wordRange(tokens, pos, WORDY), quoted: false }

  const st = stateAt(tokens, w.from)
  const prevIdx = lastSignificantBefore(tokens, w.from)
  const prev = prevIdx >= 0 ? tokens[prevIdx] : null
  const span = items => ({ from: w.from, to: w.to, items: rankMatches(items, w.fragment).slice(0, limit) })

  // ---- a pipe name ----
  if (st.expectPipeName) return span(PIPE_ITEMS)

  // ---- a `{…}` stream selector ----
  if (st.braceDepth > 0) {
    if (isStreamOp(prev)) {
      const field = fieldBefore(tokens, prevIdx)
      if (!field) return EMPTY(pos)
      const rows = await fetchList(fetchers.streamFieldValues, field)
      return span(valueItems(rows, true))
    }
    const rows = await fetchList(fetchers.streamFieldNames)
    return span(fieldItems(rows, { quoteAll: true }))
  }

  // ---- the value of `field:` ----
  if (isFieldOp(prev)) {
    const field = fieldBefore(tokens, prevIdx)
    if (!field) return EMPTY(pos)
    const rows = await fetchList(fetchers.fieldValues, field)
    return span(valueItems(rows, w.quoted))
  }

  // ---- inside a function's parentheses ----
  if (st.top?.kind === 'fn') {
    if (st.top.field) {
      const rows = await fetchList(fetchers.fieldValues, st.top.field)
      // An in-list is written with quoted values, as `fieldFilter` writes it.
      return span(valueItems(rows, true))
    }
    const rows = await fetchList(fetchers.fieldNames)
    return span(fieldItems(rows))
  }

  // ---- a group-by list or a stats function's arguments ----
  if (st.top?.kind === 'by' || st.top?.kind === 'statsFn') {
    const rows = await fetchList(fetchers.fieldNames)
    return span(fieldItems(rows, { quoteAll: st.top.kind === 'by' }))
  }

  const inFilter = st.pipe === null || st.pipe === 'filter' || st.pipe === 'where'
    || st.parens.some(p => p.kind === 'if')

  // ---- a stats pipe's function list ----
  if (st.pipe === 'stats' && !st.parens.length && !inFilter) {
    if (prev && prev.type === 'keyword' && prev.value.toLowerCase() === 'by') {
      const rows = await fetchList(fetchers.fieldNames)
      return span(fieldItems(rows, { quoteAll: true }))
    }
    return span(STATS_ITEMS)
  }

  // ---- a pipe whose arguments are field names ----
  if (st.pipe && FIELD_LIST_PIPES.has(st.pipe)) {
    const rows = await fetchList(fetchers.fieldNames)
    return span(fieldItems(rows))
  }

  // ---- a filter ----
  if (inFilter) {
    const rows = await fetchList(fetchers.fieldNames)
    return span(fieldItems(rows, { colon: true }).concat(FILTER_ITEMS))
  }

  const rows = await fetchList(fetchers.fieldNames)
  return span(fieldItems(rows))
}

export default suggestLogsql
