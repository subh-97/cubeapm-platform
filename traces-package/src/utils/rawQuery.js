// Raw-mode query support: split conditions from pipes, parse the conditions
// grammar back into the chip model, and drive caret-aware autocomplete.
//
// Grammar per docs.cubeapm.com/logs/querying. The parser covers the subset the
// chip builder can express, so raw ⇄ builder round-trips losslessly for
// anything the builder itself can produce. Anything outside that subset parses
// to an error, which the UI surfaces rather than silently dropping filters.

import { FIELD_CATALOG, getFieldValue } from '@/components/QueryBuilder'
import { STAT_FUNCTIONS, PIPE_NAMES, BUILDER_PIPES } from '@/utils/pipes'
import { logRows } from '@/data/observability'

// PIPE_NAMES / BUILDER_PIPES now live with the pipe model in pipes.js.
export { PIPE_NAMES }

// Built-in fields that always exist regardless of the indexed field catalog.
export const BUILTIN_FIELDS = [
  { field: '_msg', desc: 'Log message body' },
  { field: '_time', desc: 'Log timestamp' },
  { field: '_stream', desc: 'Stream identity' },
]

export const BOOLEAN_KEYWORDS = ['AND', 'OR', 'NOT']

// ---------- Top-level splitting ----------

// Scans for a delimiter that isn't inside quotes, parens, or braces. Returns
// -1 when there is none. Used to find the conditions|pipes boundary without
// tripping over a `|` inside a regex literal.
function indexOfTopLevel(s, ch, from = 0) {
  let quote = null
  let depth = 0
  for (let i = from; i < s.length; i++) {
    const c = s[i]
    if (quote) {
      if (c === '\\') { i++; continue }
      if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") { quote = c; continue }
    if (c === '(' || c === '{' || c === '[') { depth++; continue }
    if (c === ')' || c === '}' || c === ']') { depth--; continue }
    if (c === ch && depth === 0) return i
  }
  return -1
}

// Splits a full query into its conditions head and its pipe tail.
// `pipes` keeps the raw text of each pipe stage, unparsed.
export function splitQuery(raw) {
  const s = raw ?? ''
  const at = indexOfTopLevel(s, '|')
  if (at === -1) return { conditions: s.trim(), pipeText: '', pipes: [] }
  const conditions = s.slice(0, at).trim()
  const pipeText = s.slice(at + 1).trim()
  const pipes = []
  let rest = pipeText
  for (;;) {
    const next = indexOfTopLevel(rest, '|')
    if (next === -1) { if (rest.trim()) pipes.push(rest.trim()); break }
    pipes.push(rest.slice(0, next).trim())
    rest = rest.slice(next + 1)
  }
  return { conditions, pipeText, pipes }
}

// Replaces the pipe section while preserving the hand-written conditions head.
// This is how a pill edit writes itself back into raw text.
export function replacePipeSection(raw, pipeStr) {
  const { conditions } = splitQuery(raw)
  const head = conditions || '*'
  if (!pipeStr) return conditions
  return `${head} | ${pipeStr}`
}

// ---------- Conditions parser ----------

class Cursor {
  constructor(s) { this.s = s; this.i = 0 }
  get eof() { return this.i >= this.s.length }
  peek(n = 0) { return this.s[this.i + n] }
  ws() { while (!this.eof && /\s/.test(this.s[this.i])) this.i++ }
  startsWith(str) {
    return this.s.slice(this.i, this.i + str.length).toLowerCase() === str.toLowerCase()
  }
}

function parseQuoted(cur) {
  const q = cur.peek()
  if (q !== '"' && q !== "'") return null
  cur.i++
  let out = ''
  while (!cur.eof && cur.peek() !== q) {
    if (cur.peek() === '\\') { cur.i++; if (!cur.eof) { out += cur.peek(); cur.i++ }; continue }
    out += cur.peek(); cur.i++
  }
  if (cur.eof) throw new QueryError('Unterminated quoted string.', cur.i)
  cur.i++
  return out
}

// Field names stop at whitespace, structural characters, AND the operator
// characters — otherwise `service:payment` swallows the operator and value
// into the name.
function parseFieldName(cur) {
  let out = ''
  while (!cur.eof && !/[\s(){},|:!=~]/.test(cur.peek())) { out += cur.peek(); cur.i++ }
  return out
}

// Values are permissive by comparison: `*` (wildcards) and `:` (URLs, durations)
// are legitimate inside one, so only whitespace and structure terminate them.
function parseBare(cur) {
  let out = ''
  while (!cur.eof && !/[\s(){},|]/.test(cur.peek())) { out += cur.peek(); cur.i++ }
  return out
}

function parseValueToken(cur) {
  const q = parseQuoted(cur)
  if (q != null) return { value: q, quoted: true }
  const b = parseBare(cur)
  return { value: b, quoted: false }
}

export class QueryError extends Error {
  constructor(msg, at) { super(msg); this.name = 'QueryError'; this.at = at }
}

// Parses the parenthesised list of an in()/not_in() clause.
function parseList(cur) {
  cur.ws()
  if (cur.peek() !== '(') throw new QueryError('Expected "(" to start a value list.', cur.i)
  cur.i++
  const out = []
  for (;;) {
    cur.ws()
    if (cur.eof) throw new QueryError('Unclosed value list — expected ")".', cur.i)
    if (cur.peek() === ')') { cur.i++; break }
    if (cur.peek() === ',') { cur.i++; continue }
    const { value } = parseValueToken(cur)
    if (value === '') throw new QueryError('Empty entry in value list.', cur.i)
    out.push(value)
  }
  return out
}

// Maps a parsed operator + raw value onto the chip model's {op, value}.
// Order matters: longer symbols are tested before their prefixes.
function parseOpAndValue(cur, field) {
  cur.ws()

  if (cur.startsWith('not_in')) { cur.i += 6; return { op: 'not_in', value: parseList(cur) } }
  if (cur.startsWith('not in')) { cur.i += 6; return { op: 'not_in', value: parseList(cur) } }
  if (cur.startsWith('in')) { cur.i += 2; return { op: 'in', value: parseList(cur) } }

  if (cur.startsWith('!~')) {
    cur.i += 2
    const { value } = parseValueToken(cur)
    return { op: 'nregex', value }
  }
  if (cur.startsWith('!=')) {
    cur.i += 2
    const { value } = parseValueToken(cur)
    return { op: 'neq', value }
  }
  if (cur.peek() !== ':') {
    throw new QueryError(`Expected an operator after "${field}".`, cur.i)
  }

  cur.i++ // consume ':'

  if (cur.peek() === '=') {
    cur.i++
    const { value } = parseValueToken(cur)
    return { op: 'eq', value }
  }
  if (cur.peek() === '~') {
    cur.i++
    const { value } = parseValueToken(cur)
    return { op: 'regex', value }
  }
  if (cur.peek() === '"' || cur.peek() === "'") {
    const value = parseQuoted(cur)
    if (value === '') return { op: 'empty', value: '' }
    return { op: 'phrase', value }
  }
  if (cur.peek() === '*') {
    cur.i++
    // `field:*` = exists; `field:*text*` = contains
    const body = parseBare(cur)
    if (body === '') return { op: 'exists', value: '' }
    if (body.endsWith('*')) return { op: 'contains', value: body.slice(0, -1) }
    return { op: 'contains', value: body }
  }

  const body = parseBare(cur)
  if (body === '') throw new QueryError(`Missing value after "${field}:".`, cur.i)
  if (body.endsWith('*')) return { op: 'prefix', value: body.slice(0, -1) }
  return { op: 'word', value: body }
}

const STREAM_OPS = [
  { sym: '=~', op: 'regex' },
  { sym: '!~', op: 'nregex' },
  { sym: '!=', op: 'neq' },
  { sym: '=', op: 'eq' },
]

// `{env="prod", service in ("a","b")}` → chips.
function parseStreamSelector(cur) {
  cur.i++ // consume '{'
  const chips = []
  for (;;) {
    cur.ws()
    if (cur.eof) throw new QueryError('Unclosed stream selector — expected "}".', cur.i)
    if (cur.peek() === '}') { cur.i++; break }
    if (cur.peek() === ',') { cur.i++; continue }

    const field = parseFieldName(cur)
    if (!field) throw new QueryError('Expected a field name inside {}.', cur.i)
    cur.ws()

    if (cur.startsWith('not_in')) {
      cur.i += 6
      chips.push({ field, op: 'not_in', value: parseList(cur) })
      continue
    }
    if (cur.startsWith('in')) {
      cur.i += 2
      chips.push({ field, op: 'in', value: parseList(cur) })
      continue
    }
    const found = STREAM_OPS.find(o => cur.startsWith(o.sym))
    if (!found) throw new QueryError(`Stream selector supports = != =~ !~ in not_in — got "${cur.peek()}".`, cur.i)
    cur.i += found.sym.length
    const { value } = parseValueToken(cur)
    chips.push({ field, op: found.op, value })
  }
  return chips
}

// Parses one list of terms, stopping at `|`, end of input, or — when nested —
// the `)` that closes it. Recurses on `(` to build group nodes.
function parseTermList(cur, depth) {
  const nodes = []
  let pendingConnector = null

  for (;;) {
    cur.ws()
    if (cur.eof) break
    if (cur.peek() === '|') break
    if (cur.peek() === ')') {
      if (depth === 0) throw new QueryError('Unmatched ")" — remove it or add the opening "(".', cur.i)
      break
    }

    // Connector between terms; absent means implicit AND.
    if (cur.startsWith('AND') && /[\s(]/.test(cur.peek(3) ?? ' ')) { cur.i += 3; pendingConnector = 'AND'; continue }
    if (cur.startsWith('OR') && /[\s(]/.test(cur.peek(2) ?? ' ')) { cur.i += 2; pendingConnector = 'OR'; continue }
    if (cur.startsWith('NOT') && /[\s(]/.test(cur.peek(3) ?? ' ')) {
      throw new QueryError('NOT is not supported by the visual builder — use != or not_in.', cur.i)
    }

    let node
    if (cur.peek() === '(') {
      // Unambiguous: the parens of `in (...)` / `not_in (...)` are consumed by
      // parseOpAndValue right after a field name, so a `(` in term position
      // can only ever open a group.
      const openAt = cur.i
      cur.i += 1
      const children = parseTermList(cur, depth + 1)
      cur.ws()
      if (cur.peek() !== ')') throw new QueryError('Unclosed "(" — add the matching ")".', openAt)
      cur.i += 1
      if (children.length === 0) throw new QueryError('Empty group "()" — put a filter inside it, or remove it.', openAt)
      // A lone child needs no bracket; this matches normalize() so the builder
      // and the parser agree on what a well-formed tree looks like.
      node = children.length === 1 ? children[0] : { kind: 'group', children }
    } else {
      const field = parseFieldName(cur)
      if (!field) throw new QueryError(`Unexpected character "${cur.peek()}".`, cur.i)
      const { op, value } = parseOpAndValue(cur, field)
      node = { field, op, value }
    }

    nodes.push(nodes.length === 0 ? node : { connector: pendingConnector || 'AND', ...node })
    pendingConnector = null
  }

  return nodes
}

// Parses the conditions head into chips. Throws QueryError on anything the
// chip model can't represent, so callers can show the reason.
export function parseConditions(input) {
  const s = (input ?? '').trim()
  if (!s || s === '*') return []

  const cur = new Cursor(s)
  const chips = []

  cur.ws()
  if (cur.peek() === '{') {
    for (const c of parseStreamSelector(cur)) {
      chips.push(chips.length === 0 ? c : { connector: 'AND', ...c })
    }
  }

  // A stream selector already occupies the head, so the first term after it
  // joins with an explicit AND rather than starting the list.
  for (const n of parseTermList(cur, 0)) {
    chips.push(chips.length === 0 ? n : { connector: n.connector || 'AND', ...n })
  }

  return chips
}

// Non-throwing wrapper. `{ ok, chips, error }`.
export function tryParseConditions(input) {
  try {
    return { ok: true, chips: parseConditions(input), error: null }
  } catch (e) {
    if (e instanceof QueryError) return { ok: false, chips: [], error: e.message }
    return { ok: false, chips: [], error: 'Could not parse this query.' }
  }
}

// Validates the pipe section well enough to flag obvious mistakes. Returns a
// message or null. Deliberately shallow — the builder owns real pipe editing.
export function validatePipeText(pipes) {
  for (const p of pipes) {
    const name = p.split(/[\s(]/)[0].toLowerCase()
    if (!name) continue
    if (!PIPE_NAMES.includes(name)) {
      return `Unknown pipe "${name}". Expected one of: ${PIPE_NAMES.join(', ')}.`
    }
    if (name === 'stats' && !/\(/.test(p)) {
      return 'stats needs at least one aggregation, e.g. stats count().'
    }
  }
  return null
}

// ---------- Suggestions ----------

// Built-ins lead: they exist on every record whatever the agent, whereas the
// catalogue is whatever this instance happens to index. `_msg` in particular
// is the field most queries start from, so it must not sit behind forty
// spellings of somebody's trace id.
const ALL_FIELDS = [
  ...BUILTIN_FIELDS.map(f => ({ value: f.field, detail: f.desc, kind: 'builtin' })),
  ...FIELD_CATALOG.map(f => ({ value: f.field, detail: f.desc, kind: 'field' })),
]

const OP_SUGGESTIONS = [
  { value: ':', detail: 'word match', kind: 'operator' },
  { value: ':=', detail: 'exact match', kind: 'operator' },
  { value: '!=', detail: 'not equal', kind: 'operator' },
  { value: ':*', detail: 'exists (any non-empty)', kind: 'operator' },
  { value: ':""', detail: 'is empty', kind: 'operator' },
  { value: ':~"', detail: 'regex match', kind: 'operator' },
  { value: '!~"', detail: 'regex negation', kind: 'operator' },
  { value: ' in (', detail: 'any of these values', kind: 'operator' },
  { value: ' not_in (', detail: 'none of these values', kind: 'operator' },
]

const PIPE_SUGGESTIONS = PIPE_NAMES.map(p => ({
  value: p,
  detail: BUILDER_PIPES.has(p) ? 'has a builder control' : 'raw only',
  kind: 'pipe',
}))

const FN_SUGGESTIONS = STAT_FUNCTIONS.map(f => ({
  value: `${f.fn}(`,
  detail: f.needsField ? `${f.category} — needs a field` : f.category,
  kind: 'function',
}))

// Caps the indexed field catalogue, which is the only open-ended category —
// one instance can index hundreds of fields. Every other category is a fixed
// handful and is never truncated; see `wrap`.
const MAX_FIELD_SUGGESTIONS = 20

function startsWithCI(a, b) { return a.toLowerCase().startsWith(b.toLowerCase()) }

// Where the token under the caret begins. Tokens break on whitespace and the
// structural characters, so `service:pay` yields the whole thing (letting us
// see there's already an operator) while `stats count(` breaks cleanly.
function tokenStart(text, caret) {
  let i = caret
  while (i > 0 && !/[\s|(){},]/.test(text[i - 1])) i--
  return i
}

// Caret-aware completion. Returns { items, from, to } where from..to is the
// span the chosen value replaces.
export function suggestRaw(text, caret) {
  const s = text ?? ''
  const pos = Math.max(0, Math.min(caret ?? s.length, s.length))
  const before = s.slice(0, pos)

  const lastPipe = indexOfTopLevel(before, '|')
  const inPipeSection = lastPipe !== -1
  const from = tokenStart(s, pos)
  const word = s.slice(from, pos)

  // A single cap over the concatenated list truncates whatever happens to sit
  // last, which is how a larger field catalogue once pushed the boolean
  // keywords and the pipe opener off the end of the list entirely. Only the
  // catalogue is capped; the fixed categories are always kept, whatever order
  // the caller assembled them in.
  const wrap = (items) => {
    const matched = items.filter(it => !word || startsWithCI(it.value.trim(), word.trim()))
    const catalogue = matched.filter(it => it.kind === 'field')
    if (catalogue.length <= MAX_FIELD_SUGGESTIONS) return { items: matched, from, to: pos }
    const keep = new Set(catalogue.slice(0, MAX_FIELD_SUGGESTIONS))
    return {
      items: matched.filter(it => it.kind !== 'field' || keep.has(it)),
      from,
      to: pos,
    }
  }

  if (inPipeSection) {
    // Which stage are we in, and is this the stage's first word?
    const segStart = before.lastIndexOf('|') + 1
    const seg = before.slice(segStart)
    const segTrimmed = seg.trimStart()

    // Still naming the pipe.
    if (!/\s/.test(segTrimmed)) return wrap(PIPE_SUGGESTIONS)

    const pipeName = segTrimmed.split(/\s+/)[0].toLowerCase()

    if (pipeName === 'stats') {
      // After `by (` we want field names; otherwise aggregation functions.
      const openBy = /\bby\s*\([^)]*$/i.test(seg)
      if (openBy) return wrap(ALL_FIELDS)
      if (/\($/.test(before) || /\(\s*[\w.]*$/.test(seg)) return wrap(ALL_FIELDS)
      return wrap([...FN_SUGGESTIONS, { value: 'by (', detail: 'group by fields', kind: 'keyword' }])
    }
    if (pipeName === 'sort') {
      if (/\($/.test(before) || /\(\s*"?[\w.]*$/.test(seg)) return wrap(ALL_FIELDS)
      return wrap([
        { value: 'desc', detail: 'largest first', kind: 'keyword' },
        { value: 'asc', detail: 'smallest first', kind: 'keyword' },
      ])
    }
    if (pipeName === 'limit') return wrap([
      { value: '10', detail: '', kind: 'value' },
      { value: '100', detail: '', kind: 'value' },
      { value: '500', detail: '', kind: 'value' },
      { value: '1000', detail: '', kind: 'value' },
    ])
    return wrap(ALL_FIELDS)
  }

  // Conditions section.
  // If the token already contains an operator, suggest values for that field.
  const opMatch = word.match(/^([\w._]+)(:=|:~|!~|!=|:)(.*)$/)
  if (opMatch) {
    const [, field, , typed] = opMatch
    const values = valuesForField(field)
    return {
      items: values
        .filter(v => !typed || startsWithCI(v.value, typed))
        .slice(0, 12)
        .map(v => ({ ...v, replaceWith: `${field}${opMatch[2]}${v.value}` })),
      from,
      to: pos,
    }
  }

  // A bare complete field name → offer operators.
  const known = ALL_FIELDS.some(f => f.value.toLowerCase() === word.toLowerCase())
  if (known) {
    return {
      items: OP_SUGGESTIONS.map(o => ({ ...o, replaceWith: `${word}${o.value}` })),
      from,
      to: pos,
    }
  }

  // Otherwise: fields, plus boolean keywords and the pipe opener once there's
  // already a term to join onto.
  const extras = before.trim()
    ? [
        ...BOOLEAN_KEYWORDS.filter(k => k !== 'NOT').map(k => ({ value: k, detail: 'combine terms', kind: 'keyword' })),
        { value: '|', detail: 'start a pipe', kind: 'keyword' },
      ]
    : []
  return wrap([...ALL_FIELDS, ...extras])
}

// Value suggestions come from the same mock data the chip builder samples, so
// raw mode and builder mode offer identical picklists.
const valueCache = {}
function valuesForField(field) {
  if (valueCache[field]) return valueCache[field]
  const counts = {}
  for (const l of logRows) {
    const v = getFieldValue(l, field)
    if (v != null && v !== '') counts[String(v)] = (counts[String(v)] || 0) + 1
  }
  const out = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([value, count]) => ({ value, detail: `${count} logs`, kind: 'value' }))
  valueCache[field] = out
  return out
}
