import { Fragment, useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { AlertCircle } from 'lucide-react'
import { logRows } from '@/data/observability'
import {
  isGroup, newGroup, getAt, replaceAt, removeAt, appendInto, normalize,
  wrapWithNeighbour, unwrapAt, toggleConnectorAt, lastLeafPath, pathEquals,
  concatWithAnd,
} from '@/utils/queryTree'
import {
  splitField, resolveOperator, buildChip, isCommittable, interpret, isKnownField,
  matchConnector, CONNECTORS, deriveFreeText,
} from '@/utils/typedQuery'

// ---------- Field catalog ----------
// Types map to CubeAPM's log query grammar (docs.cubeapm.com/logs/querying).
// `keyword` is short numeric/alphanumeric text (status codes, small ints) that
// still uses string-style operators — CubeAPM's log grammar has no `>`/`<`.

export const FIELD_CATALOG = [
  { field: 'service',            type: 'string',  desc: 'Service name' },
  { field: 'log.level',          type: 'string',  desc: 'Log severity' },
  { field: 'env',                type: 'string',  desc: 'Environment' },
  { field: 'endpoint',           type: 'string',  desc: 'Request endpoint' },
  { field: 'path',               type: 'string',  desc: 'Request path' },
  { field: 'log.exception.type', type: 'string',  desc: 'Exception class' },
  { field: 'http.status',        type: 'keyword', desc: 'HTTP status code' },
  { field: 'duration_ms',        type: 'keyword', desc: 'Request duration (ms)' },
  { field: 'trace_id',           type: 'string',  desc: 'Trace identifier', highCard: true },

  // Added with the non-request record shapes. The catalogue drives what can be
  // typed and autocompleted; evaluation already falls through to log.tags, so
  // a field missing from here still filters - it just cannot be reached from
  // the keyboard, which is the same as not existing.
  { field: 'event.domain',       type: 'string',  desc: 'Record domain (k8s, span)' },
  { field: 'severity',           type: 'string',  desc: 'Log severity (OTel spelling)' },
  { field: 'level',              type: 'string',  desc: 'Log severity (New Relic spelling)' },
  { field: 'service.name',       type: 'string',  desc: 'Service name (OTel/NR spelling)' },
  { field: 'host.name',          type: 'string',  desc: 'Host' },
  { field: 'hostname',           type: 'string',  desc: 'Host (New Relic spelling)' },
  { field: 'trace.id',           type: 'string',  desc: 'Trace identifier (NR/ECS spelling)', highCard: true },
  { field: 'span_id',            type: 'string',  desc: 'Span identifier', highCard: true },
  { field: 'span.id',            type: 'string',  desc: 'Span identifier (NR spelling)', highCard: true },

  { field: 'object.type',        type: 'string',  desc: 'k8s event type (Normal, Warning)' },
  { field: 'object.reason',      type: 'string',  desc: 'k8s event reason' },
  { field: 'object.regarding.kind', type: 'string', desc: 'k8s object the event is about' },
  { field: 'k8s.namespace.name', type: 'string',  desc: 'Kubernetes namespace' },
  { field: 'k8s.pod.name',       type: 'string',  desc: 'Kubernetes pod' },
  { field: 'k8s.node.name',      type: 'string',  desc: 'Kubernetes node' },
  { field: 'k8s.container.name', type: 'string',  desc: 'Container' },

  { field: 'db.system',          type: 'string',  desc: 'Database engine' },
  { field: 'db.operation',       type: 'string',  desc: 'Database operation' },
  { field: 'db.name',            type: 'string',  desc: 'Database name' },
  { field: 'db.sql.table',       type: 'string',  desc: 'SQL table' },
  { field: 'span_kind',          type: 'string',  desc: 'Span kind (server, client)' },
  { field: 'duration',           type: 'keyword', desc: 'Span duration (nanoseconds)' },

  { field: 'error.class',        type: 'string',  desc: 'Exception class (New Relic spelling)' },
  { field: 'error.type',         type: 'string',  desc: 'Exception class (ECS spelling)' },
  { field: 'exception.type',     type: 'string',  desc: 'Exception class (OTel spelling)' },
  { field: 'log.logger',         type: 'string',  desc: 'Logger name (ECS spelling)' },
  { field: 'logger.name',        type: 'string',  desc: 'Logger name (New Relic spelling)' },
]

const FIELD_BY_NAME = Object.fromEntries(FIELD_CATALOG.map(f => [f.field, f]))

// Operator catalog — mirrors CubeAPM query grammar.
// `sym` is what shows in the operator picker's icon slot.
// `freeText` = user must type a value (no picklist).
// `noValue`  = commit immediately, no value phase.
const OPERATORS = {
  string: [
    { op: 'word',     label: 'is (word)',      hint: 'field:value  — word/token match',                  sym: ':',     cat: 'Equality' },
    { op: 'eq',       label: 'is exactly',     hint: 'field:=value  — exact match',                      sym: ':=',    cat: 'Equality' },
    { op: 'neq',      label: 'is not',         hint: 'field!=value  — excludes this value',              sym: '!=',    cat: 'Equality' },
    { op: 'in',       label: 'in (list)',      hint: 'field in ("a","b")  — matches any of these',       sym: 'in',    cat: 'List',       multi: true },
    { op: 'not_in',   label: 'not in (list)',  hint: 'field not_in ("a","b")  — none of these',          sym: '!in',   cat: 'List',       multi: true },
    { op: 'contains', label: 'contains',       hint: 'field:*value*  — substring anywhere',              sym: ':*_*',  cat: 'Text',       freeText: true },
    { op: 'prefix',   label: 'starts with',    hint: 'field:value*  — prefix match',                     sym: ':_*',   cat: 'Text',       freeText: true },
    { op: 'phrase',   label: 'matches phrase', hint: 'field:"a b c"  — multi-word exact',                sym: ':"_"',  cat: 'Text',       freeText: true },
    { op: 'regex',    label: 'matches regex',  hint: 'field:~"pattern"  — regular expression',           sym: ':~',    cat: 'Pattern',    freeText: true },
    { op: 'nregex',   label: 'not regex',      hint: 'field!~"pattern"  — negated regex',                sym: '!~',    cat: 'Pattern',    freeText: true },
    { op: 'exists',   label: 'exists',         hint: 'field:*  — any non-empty value',                   sym: ':*',    cat: 'Presence',   noValue: true },
    { op: 'empty',    label: 'is empty',       hint: 'field:""  — field is present but empty',           sym: ':""',   cat: 'Presence',   noValue: true },
  ],
  keyword: [
    { op: 'word',     label: 'is',             hint: 'field:value  — word match',                        sym: ':',     cat: 'Equality' },
    { op: 'eq',       label: 'is exactly',     hint: 'field:=value  — exact match',                      sym: ':=',    cat: 'Equality' },
    { op: 'neq',      label: 'is not',         hint: 'field!=value  — excludes this value',              sym: '!=',    cat: 'Equality' },
    { op: 'in',       label: 'in (list)',      hint: 'field in ("a","b")  — matches any of these',       sym: 'in',    cat: 'List',       multi: true },
    { op: 'not_in',   label: 'not in (list)',  hint: 'field not_in ("a","b")  — none of these',          sym: '!in',   cat: 'List',       multi: true },
    { op: 'prefix',   label: 'starts with',    hint: 'field:5*  — e.g. 5* covers all 5xx codes',         sym: ':_*',   cat: 'Text',       freeText: true },
    { op: 'exists',   label: 'exists',         hint: 'field:*  — field is present',                      sym: ':*',    cat: 'Presence',   noValue: true },
  ],
  highCard: [
    { op: 'eq',       label: 'is exactly',     hint: 'field:=value  — exact match',                      sym: ':=',    cat: 'Equality' },
    { op: 'prefix',   label: 'starts with',    hint: 'field:value*  — prefix match',                     sym: ':_*',   cat: 'Text',       freeText: true },
    { op: 'regex',    label: 'matches regex',  hint: 'field:~"pattern"  — regular expression',           sym: ':~',    cat: 'Pattern',    freeText: true },
    { op: 'exists',   label: 'exists',         hint: 'field:*  — field is present',                      sym: ':*',    cat: 'Presence',   noValue: true },
  ],
}

const CATEGORY_ORDER = ['Equality', 'List', 'Text', 'Pattern', 'Presence']

// The operator set a field gets is decided by its entry in the ACTIVE catalog,
// which differs per dataset — `duration` is nanoseconds on a span and has no
// entry at all on some log shapes. Callers inside the component pass the map
// they resolved from their own dataset; the default keeps the module-level
// helpers usable on their own.
function opSetFor(field, byName = FIELD_BY_NAME) {
  const meta = byName[field]
  if (!meta) return OPERATORS.string
  if (meta.highCard) return OPERATORS.highCard
  if (meta.type === 'keyword') return OPERATORS.keyword
  return OPERATORS.string
}

function opMetaFor(field, op, byName = FIELD_BY_NAME) {
  return opSetFor(field, byName).find(o => o.op === op)
}

// Renders the op+value portion of a chip using CubeAPM's canonical syntax.
// The full chip is `field` + this string.
function asArray(v) {
  if (Array.isArray(v)) return v
  if (v == null || v === '') return []
  return [v]
}

// Splits the op+value tail into separately addressable pieces, so each part of a
// chip can be clicked to edit just that part. The punctuation (prefix/suffix) is
// the operator; whatever sits between them is the value.
function chipSegments(op, value) {
  const v = String(value ?? '')
  const list = () => asArray(value).map(x => `"${x}"`).join(', ')
  switch (op) {
    case 'exists':   return { prefix: ':*',       value: '',      suffix: '' }
    case 'empty':    return { prefix: ':""',      value: '',      suffix: '' }
    case 'word':     return { prefix: ':',        value: v,       suffix: '' }
    case 'eq':       return { prefix: ':=',       value: v,       suffix: '' }
    case 'neq':      return { prefix: '!=',       value: v,       suffix: '' }
    case 'in':       return { prefix: ' in (',    value: list(),  suffix: ')' }
    case 'not_in':   return { prefix: ' not_in (', value: list(), suffix: ')' }
    case 'contains': return { prefix: ':*',       value: v,       suffix: '*' }
    case 'prefix':   return { prefix: ':',        value: v,       suffix: '*' }
    case 'phrase':   return { prefix: ':"',       value: v,       suffix: '"' }
    case 'regex':    return { prefix: ':~"',      value: v,       suffix: '"' }
    case 'nregex':   return { prefix: '!~"',      value: v,       suffix: '"' }
    default:         return { prefix: ':',        value: v,       suffix: '' }
  }
}

// Canonical CubeAPM syntax for a chip's tail — derived from the segments so the
// rendered chip and the generated query can never drift apart.
function opValueText(op, value) {
  const s = chipSegments(op, value)
  return s.prefix + s.value + s.suffix
}

// Renders just the operator prefix for the composing chip (before user picks a value).
function opStartText(op) {
  switch (op) {
    case 'exists':   return ':*'
    case 'empty':    return ':""'
    case 'word':     return ':'
    case 'eq':       return ':='
    case 'neq':      return '!='
    case 'in':       return ' in ('
    case 'not_in':   return ' not_in ('
    case 'contains': return ':*'
    case 'prefix':   return ':'
    case 'phrase':   return ':"'
    case 'regex':    return ':~"'
    case 'nregex':   return '!~"'
    default:         return ':'
  }
}

// The free-text readings offered for whatever the user typed. Mirrors the Text
// operator set the field path exposes, so "search the message" gets the same
// substring / prefix / exact-phrase choice a field filter would.
// Ordered narrowest reading first: the exact phrase, then that run of
// characters at the start of the message, then anywhere in it. The first row is
// also the Enter default, so the tightest match is what you get for free.
const FREE_TEXT_OPS = [
  { op: 'phrase',   label: 'matching the exact phrase' },  // "text"
  { op: 'prefix',   label: 'starting with' },              // text*
  { op: 'contains', label: 'containing' },                 // *text*
]

// Builds the free-text rows for a typed string. Multi-word input gets one extra
// option that splits on whitespace into a chip per word (AND-ed), which reads as
// "all of these words appear" rather than "this exact run of characters appears".
function buildFreeTextOptions(typed) {
  // Quotes and stars the user typed are syntax, so they are stripped off the
  // value and used to pick which reading leads — otherwise `"text"` would search
  // for a string that literally includes the quote characters.
  const { op: writtenOp, value, explicit } = deriveFreeText(typed)
  const words = value.split(/\s+/).filter(Boolean)
  const opts = FREE_TEXT_OPS.map(o => ({ ...o, value, kind: 'single' }))

  if (explicit) {
    // They already said which one they want; the others stay available below.
    return [
      ...opts.filter(o => o.op === writtenOp),
      ...opts.filter(o => o.op !== writtenOp),
    ]
  }
  if (words.length > 1) {
    // Several words are far more often "find these words" than "find this exact
    // run of characters", so the split reading leads once there is a space.
    // Quoting is exactly how someone says they did NOT mean separate words,
    // which is why this only applies when nothing was written explicitly.
    opts.unshift({ op: 'contains', label: 'containing all of', value, words, kind: 'split' })
  }
  return opts
}

export const SAVED_QUERIES = [
  { name: 'Payments — errors last hour', description: 'Where a payment failure shows up first. Start here when checkout is reported broken.', chips: [
    { field: 'service',   op: 'eq', value: 'payment' },
    { field: 'log.level', op: 'eq', value: 'error' },
  ]},
  { name: 'Server errors (5xx)', description: 'Everything the server itself failed to handle — excludes 4xx, which are the caller’s problem.', chips: [
    { field: 'http.status', op: 'prefix', value: '5' },
  ]},
  { name: 'Payment path — anything matching', description: 'Every request touching a payment route, regardless of service or outcome.', chips: [
    { field: 'path', op: 'contains', value: 'payment' },
  ]},
  { name: 'Connection failures', description: 'The pool could not reach a dependency. Usually the database, occasionally DNS.', chips: [
    { field: 'log.exception.type', op: 'eq', value: 'ConnectionRefusedException' },
  ]},
  { name: 'Any exception raised', description: 'Anything that threw, of any type — the widest net before narrowing by class.', chips: [
    { field: 'log.exception.type', op: 'exists' },
  ]},
  { name: 'Payment or order services', description: 'The two services that share the checkout path, so a fault in either surfaces together.', chips: [
    { field: 'service', op: 'in', value: ['payment', 'order'] },
  ]},
  { name: 'Errors OR warnings only', description: 'Drops info, keeping the two levels that mean something needed attention.', chips: [
    { field: 'log.level', op: 'eq', value: 'error' },
    { field: 'log.level', op: 'eq', value: 'warn', connector: 'OR' },
  ]},
]

export function getFieldValue(log, field) {
  if (field === 'log.level') return log.level
  if (field === 'service') return log.service
  if (field === '_msg' || field === 'message') return log.message
  return log.tags?.[field]
}

// Long enough that arrowing through fields doesn't fire a request per step,
// short enough that a deliberate stop feels immediate.
const VALUE_DEBOUNCE_MS = 180

function computeTopValues(field, k = 24, { rows = logRows, byName = FIELD_BY_NAME, valueOf = getFieldValue } = {}) {
  const meta = byName[field]
  if (meta?.highCard) return null
  const counts = {}
  for (const l of rows) {
    const v = valueOf(l, field)
    if (v != null && v !== '') {
      const key = String(v)
      counts[key] = (counts[key] || 0) + 1
    }
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([value, count]) => ({ value, count }))
}

// Stream selectors have their own syntax (`=`, `!=`, `=~`, `!~`) and only support
// a limited op set. When a chip qualifies, we promote it into the leading `{}` block.
const STREAM_FIELDS = new Set(['env', 'service'])

const STREAM_OP_MAP = {
  eq:     (f, v) => `${f}="${v}"`,
  neq:    (f, v) => `${f}!="${v}"`,
  in:     (f, v) => `${f} in (${asArray(v).map(x => `"${x}"`).join(', ')})`,
  not_in: (f, v) => `${f} not_in (${asArray(v).map(x => `"${x}"`).join(', ')})`,
  regex:  (f, v) => `${f}=~"${v}"`,
  nregex: (f, v) => `${f}!~"${v}"`,
}

function isStreamable(chip) {
  if (isGroup(chip)) return false
  return STREAM_FIELDS.has(chip.field) && !!STREAM_OP_MAP[chip.op]
}

// A group serializes as its children wrapped in parens. `normalize` guarantees
// no empty or single-child groups reach here, so no redundant parens are emitted.
function nodeToString(n) {
  if (isGroup(n)) return `(${nodesToString(n.children ?? [])})`
  return `${n.field}${opValueText(n.op, n.value)}`
}

function nodesToString(nodes) {
  return (nodes ?? []).map((n, i) => {
    const chunk = nodeToString(n)
    // The first node in a list has nothing before it to join to.
    if (i === 0) return chunk
    return `${n.connector === 'OR' ? 'OR' : 'AND'} ${chunk}`
  }).join(' ')
}

export function chipsToString(chips) {
  // Promote the longest run of AND-connected stream-eligible chips at the front.
  let splitAt = 0
  for (let i = 0; i < chips.length; i++) {
    const c = chips[i]
    if (i > 0 && c.connector === 'OR') break
    if (!isStreamable(c)) break
    splitAt = i + 1
  }
  const streams = chips.slice(0, splitAt)
  const rest = chips.slice(splitAt)

  const streamStr = streams.length > 0
    ? `{${streams.map(c => STREAM_OP_MAP[c.op](c.field, c.value)).join(', ')}}`
    : ''

  const restStr = nodesToString(rest)

  if (streamStr && restStr) return `${streamStr} ${restStr}`
  return streamStr || restStr
}

function tokenize(s) {
  return s.toLowerCase().split(/[^a-z0-9._-]+/i).filter(Boolean)
}

// A phrase matches a run of WHOLE tokens, in order. `"proces"` matches the word
// "proces" and not "processing" — matching inside a word is what `*proces*` is
// for, and treating a phrase as a substring made the narrowest of the three
// free-text readings behave exactly like the widest.
function matchesPhrase(haystack, value) {
  const hay = tokenize(haystack)
  const needle = tokenize(value)
  if (!needle.length) return false
  for (let i = 0; i + needle.length <= hay.length; i++) {
    if (needle.every((w, j) => hay[i + j] === w)) return true
  }
  return false
}

// `text*` reads as "starting with": either the value as a whole starts with it
// (`http.status:5*` covering 5xx) or some word inside does (`proces*` finding
// "processing" in a message). The second is why this is not just startsWith —
// a message body is many words, and only the first would ever match.
function matchesPrefix(haystack, value) {
  const hl = haystack.toLowerCase()
  const vl = value.toLowerCase()
  if (!vl) return false
  return hl.startsWith(vl) || tokenize(haystack).some(t => t.startsWith(vl))
}

function matchChip(log, c, valueOf = getFieldValue) {
  const raw = valueOf(log, c.field)
  const present = raw != null && raw !== ''
  if (c.op === 'exists') return present
  if (c.op === 'empty')  return !present
  if (!present) return false
  const s = String(raw)
  const sl = s.toLowerCase()
  const v = String(c.value ?? '')
  const vl = v.toLowerCase()
  switch (c.op) {
    case 'word':     return tokenize(s).includes(vl) || sl === vl
    case 'eq':       return s === v
    case 'neq':      return s !== v
    case 'in':       return asArray(c.value).map(String).includes(s)
    case 'not_in':   return !asArray(c.value).map(String).includes(s)
    case 'contains': return sl.includes(vl)
    case 'prefix':   return matchesPrefix(s, v)
    case 'phrase':   return matchesPhrase(s, v)
    case 'regex':    { try { return new RegExp(v).test(s) } catch { return false } }
    case 'nregex':   { try { return !new RegExp(v).test(s) } catch { return false } }
    default: return false
  }
}

// Evaluates a sibling list left-to-right, respecting each node's `connector`
// (default AND). There is still no operator precedence WITHIN a list — groups
// are what express precedence, and users can reorder chips as before.
function evalNodes(log, nodes, valueOf = getFieldValue) {
  if (!nodes?.length) return true
  let result = evalNode(log, nodes[0], valueOf)
  for (let i = 1; i < nodes.length; i++) {
    const n = nodes[i]
    const m = evalNode(log, n, valueOf)
    if (n.connector === 'OR') result = result || m
    else result = result && m
  }
  return result
}

function evalNode(log, n, valueOf = getFieldValue) {
  return isGroup(n) ? evalNodes(log, n.children, valueOf) : matchChip(log, n, valueOf)
}

// `valueOf` is the same dataset seam the builder takes: a span resolves its
// fields differently from a log line, and the chip semantics above are
// identical either way. Defaulting it keeps every existing caller unchanged.
export function applyChipsToLog(log, chips, valueOf = getFieldValue) {
  return evalNodes(log, chips, valueOf)
}

// ---------- Component ----------

/**
 * `fieldCatalog`, `rows` and `valueOf` are the dataset seam. Logs and Traces
 * share one grammar, one keyboard model and one chip UI, and differ only in the
 * nouns they can be written about — so the page supplies the vocabulary and this
 * file stays the single definition of how a query is built.
 */
export default function QueryBuilder({
  chips, setChips, recents = [], addRecent, savedQueries = [], onRun, onBlockedChange,
  onCopyQuery, parsePastedQuery, onApplyPipes, fetchFieldValues, leading,
  fieldCatalog = FIELD_CATALOG, rows = logRows, valueOf = getFieldValue,
  placeholder = 'Type a field name (e.g. service, duration_ms) or free text',
}) {
  const fieldByName = useMemo(() => Object.fromEntries(fieldCatalog.map(f => [f.field, f])), [fieldCatalog])
  // Names that count as a field when typed. `_msg` is here so `_msg:"a b"` can
  // be written out in full, even though free text normally produces it implicitly.
  const typeableFields = useMemo(() => [...fieldCatalog.map(f => f.field), '_msg', '_time', '_stream'], [fieldCatalog])
  const [text, setText] = useState('')
  const [open, setOpen] = useState(false)
  // null → field phase | { field, type, highCard } → operator phase | { …, op } → value phase
  const [composing, setComposing] = useState(null)
  const [highlight, setHighlight] = useState(0)
  // Selected values while composing a multi-value chip (in / not_in)
  const [pendingValues, setPendingValues] = useState([])
  // Path of the chip being re-opened for editing, or null when composing a new
  // one. The chip itself stays in `chips` the whole time — this only redirects
  // rendering and the eventual commit — so abandoning an edit reverts for free.
  const [editingPath, setEditingPath] = useState(null)
  // Path of the group new chips land in, or null for the top level. Set when the
  // user opens a group from the overlay.
  const [insertionPath, setInsertionPath] = useState(null)
  // Path whose group/ungroup menu is open, or null.
  const [menuPath, setMenuPath] = useState(null)
  // True when `composing` was reached by typing rather than clicking. Backspace
  // then puts the text back so it stays editable; a clicked chip clears instead,
  // which is what the click flow has always done.
  const [typedEntry, setTypedEntry] = useState(false)
  // Connector typed ahead of the next chip (`… AND ` / `… OR `). Applied when
  // that chip commits, then cleared.
  const [pendingConnector, setPendingConnector] = useState(null)
  // Set when a rejected space is pressed; cleared on the next real keystroke.
  const [spaceError, setSpaceError] = useState(null)
  // Feedback from the last paste — a refusal, a parse reason, or a note that
  // a pipe section was ignored. Transient, cleared like spaceError.
  const [pasteError, setPasteError] = useState(null)
  const wrapRef = useRef(null)
  const inputRef = useRef(null)
  const listRef = useRef(null)

  const phase = !composing ? 'field' : composing.op == null ? 'operator' : 'value'
  const isEditing = editingPath != null

  const closeOverlay = useCallback(() => {
    setOpen(false)
    setHighlight(0)
    // Dropping out of an edit discards the in-progress changes and restores the
    // original chip. A new-chip trip keeps its composing state instead, so it can
    // surface the "unfinished filter" error.
    setEditingPath(prev => {
      if (prev != null) { setComposing(null); setText('') }
      return null
    })
    setMenuPath(null)
    // A group the user opened but never filled is meaningless once they leave,
    // and normalize also unwraps any group left holding a single filter.
    setInsertionPath(null)
    setChips(prev => normalize(prev))
  }, [setChips])

  // Whether the value phase needs a typed value instead of a picklist
  const opMeta = composing?.op ? opMetaFor(composing.field, composing.op, fieldByName) : null
  const isMulti = !!opMeta?.multi
  const needsTypedValue = !!(!isMulti && (composing?.highCard || opMeta?.freeText))

  // Reset pending selections whenever we (re)enter a multi-value composing session.
  // Editing is exempt: beginEdit seeds pendingValues from the chip being edited,
  // and this would immediately wipe that seed.
  useEffect(() => {
    if (isMulti && !isEditing) setPendingValues([])
  }, [isMulti, isEditing, composing?.field, composing?.op])

  // Surface "there's an uncommitted filter in progress" upward so the parent can
  // reflect it on the Run button. A trip is incomplete until it commits to a chip
  // (composing → null) or is cancelled. Always clear on unmount (e.g. switching
  // away from builder mode) so a stale signal doesn't linger.
  // What blocks Run is reported as a reason string (see `blockedReason` below,
  // computed once the error messages it draws on exist). Null means runnable.
  useEffect(() => () => onBlockedChange?.(null), [onBlockedChange])

  // Enter can finish a term and run in one press, but `setChips` does not land
  // until the next render — running inline would run the query as it was
  // *before* the chip it just added. So the run waits for `chips` to arrive.
  const runAfterCommit = useRef(false)
  useEffect(() => {
    if (!runAfterCommit.current) return
    runAfterCommit.current = false
    addRecent?.(chips)
    onRun?.()
    closeOverlay()
  }, [chips])   // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- Value suggestions, sync or async ----------
  // Values arrive through `fetchFieldValues` so the builder can sit in front of
  // a real API. Without a provider it reads the local index synchronously, which
  // is what the mock build does — so the default path has no loading state to
  // flicker through and existing behaviour is unchanged.
  //
  // `field` is stamped on the result: a reply that arrives after the user has
  // moved to a different field describes the wrong field and must not render.
  const [valueSource, setValueSource] = useState({ status: 'ready', field: null, items: [], error: null })
  const [valueRetry, setValueRetry] = useState(0)
  const retryValues = useCallback(() => setValueRetry(n => n + 1), [])

  // Null unless a value list is actually on screen — high-cardinality fields
  // take typed input instead and must never trigger a fetch.
  const valueField = phase === 'value' && !needsTypedValue ? composing?.field ?? null : null

  useEffect(() => {
    if (!valueField) return
    if (!fetchFieldValues) {
      setValueSource({ status: 'ready', field: valueField, items: computeTopValues(valueField, 24, { rows, byName: fieldByName, valueOf }) || [], error: null })
      return
    }
    let cancelled = false
    const ctl = new AbortController()
    setValueSource({ status: 'loading', field: valueField, items: [], error: null })
    // Debounced so stepping through fields with the keyboard doesn't fire a
    // request per keystroke; the abort covers the ones already in flight.
    const timer = setTimeout(() => {
      Promise.resolve(fetchFieldValues(valueField, { signal: ctl.signal }))
        .then(items => {
          if (cancelled) return
          const list = Array.isArray(items) ? items : []
          setValueSource({
            status: list.length ? 'ready' : 'empty',
            field: valueField, items: list, error: null,
          })
        })
        .catch(err => {
          if (cancelled || err?.name === 'AbortError') return
          setValueSource({
            status: 'error', field: valueField, items: [],
            error: err?.message || 'Could not load values.',
          })
        })
    }, VALUE_DEBOUNCE_MS)
    return () => { cancelled = true; ctl.abort(); clearTimeout(timer) }
  }, [valueField, fetchFieldValues, valueRetry])

  const suggestions = useMemo(() => {
    const q = text.trim().toLowerCase()

    if (phase === 'operator') {
      const ops = opSetFor(composing.field, fieldByName)
      const filtered = q
        ? ops.filter(o => o.op.toLowerCase().includes(q) || o.label.toLowerCase().includes(q) || o.sym.toLowerCase().includes(q))
        : ops
      // Sort by declared category order so flat (keyboard) index matches visual order.
      const sorted = [...filtered].sort((a, b) => {
        const ai = CATEGORY_ORDER.indexOf(a.cat)
        const bi = CATEGORY_ORDER.indexOf(b.cat)
        return ai - bi
      })
      return { mode: 'operators', items: sorted }
    }

    if (phase === 'value') {
      if (needsTypedValue) return { mode: 'typed-value' }
      // A result stamped with a different field belongs to the previous one;
      // treat it as still loading rather than showing the wrong values.
      const src = valueSource.field === composing.field
        ? valueSource
        : { status: 'loading', items: [], error: null }
      const values = src.items || []
      const filtered = q ? values.filter(v => v.value.toLowerCase().includes(q)) : values

      if (isMulti) {
        // Offer a "custom value" row when typed text isn't in the list yet.
        const customRow = q && src.status === 'ready' && !filtered.some(v => v.value.toLowerCase() === q)
          ? { value: text.trim(), count: 0, custom: true }
          : null
        return {
          mode: 'multi-values',
          items: customRow ? [customRow, ...filtered] : filtered,
          status: src.status, error: src.error,
        }
      }
      return { mode: 'values', items: filtered, status: src.status, error: src.error }
    }

    const rec = recents
      .filter(r => !q || chipsToString(r).toLowerCase().includes(q))
      .slice(0, 5)
    // User-saved queries appear before the built-in demo set.
    const allSaved = [...savedQueries, ...SAVED_QUERIES]
    const sav = allSaved.filter(s =>
      !q || s.name.toLowerCase().includes(q) || chipsToString(s.chips).toLowerCase().includes(q)
    )
    const fac = fieldCatalog.filter(f =>
      !q || f.field.toLowerCase().includes(q) || f.desc.toLowerCase().includes(q)
    )
    // Anything typed can also be searched against the log body instead — including
    // a string that happens to spell a field name, since "service" is a plausible
    // thing to grep the message for. When no field matches, that's the only sensible
    // reading of the input, so the rows lead the list and Enter takes the first by
    // default; otherwise they sit behind the field matches as a deliberate choice.
    const typed = text.trim()
    const freeText = typed ? buildFreeTextOptions(typed) : []
    // AND/OR are offered once there is something for them to join to. Matching
    // is case-insensitive so `an` still surfaces the row, but only an exact
    // uppercase AND/OR ranks it first — otherwise Enter on a lowercase "and"
    // would commit a connector when the user meant to search for the word.
    const canConnect = chips.length > 0 || !!insertionPath
    const conns = canConnect
      ? CONNECTORS.filter(c => !typed || c.startsWith(typed.toUpperCase()))
      : []

    // The group row is an action, not a match — it only makes sense on an empty
    // input, where the user isn't already narrowing towards a field.
    return {
      mode: 'fields', recents: rec, saved: sav, facets: fac, freeText,
      freeTextFirst: fac.length === 0, canGroup: !typed,
      connectors: conns, connectorsFirst: CONNECTORS.includes(typed),
    }
  }, [text, phase, composing, needsTypedValue, recents, savedQueries, chips.length, insertionPath, valueSource])

  const flatItems = useMemo(() => {
    if (suggestions.mode === 'fields') {
      // Mirrors the section order rendered below — keyboard index must track it.
      const ft = suggestions.freeText.map((o, i) => ({ kind: 'freetext', payload: o, key: `ft${i}` }))
      const fac = suggestions.facets.map((f, i) => ({ kind: 'facet', payload: f, key: `f${i}` }))
      const conn = suggestions.connectors.map((c, i) => ({ kind: 'connector', payload: c, key: `c${i}` }))
      return [
        // An exact AND/OR leads, so Enter and Tab take the connector rather than
        // a free-text search for the word itself.
        ...(suggestions.connectorsFirst ? conn : []),
        ...(suggestions.freeTextFirst ? ft : fac),
        ...(suggestions.freeTextFirst ? fac : ft),
        ...(suggestions.connectorsFirst ? [] : conn),
        // Sits behind the field matches so it never steals the Enter target.
        ...(suggestions.canGroup ? [{ kind: 'group', payload: null, key: 'grp' }] : []),
        ...suggestions.recents.map((r, i) => ({ kind: 'recent', payload: r, key: `r${i}` })),
        ...suggestions.saved.map((s, i) => ({ kind: 'saved', payload: s, key: `s${i}` })),
      ]
    }
    if (suggestions.mode === 'operators') {
      return suggestions.items.map((o, i) => ({ kind: 'operator', payload: o, key: `o${i}` }))
    }
    // Only a settled list is navigable — skeleton and error rows are not
    // targets, so Enter while loading can never commit a placeholder.
    if (suggestions.mode === 'values') {
      if (suggestions.status !== 'ready') return []
      return suggestions.items.map((v, i) => ({ kind: 'value', payload: v, key: `v${i}` }))
    }
    if (suggestions.mode === 'multi-values') {
      if (suggestions.status !== 'ready') return []
      return suggestions.items.map((v, i) => ({ kind: 'multi-value', payload: v, key: `m${i}` }))
    }
    return []
  }, [suggestions])

  useEffect(() => { setHighlight(0) }, [flatItems.length, phase, composing?.field, composing?.op])

  // Moving to a different slot makes the last space complaint stale.
  useEffect(() => { setSpaceError(null) }, [phase, composing?.field, composing?.op, chips.length])
  // Deliberately not keyed on chips.length: a successful paste *is* a chip
  // change, so clearing there would wipe the note about an ignored pipe section
  // in the same tick it was set.
  useEffect(() => { setPasteError(null) }, [phase, composing?.field, composing?.op])

  useEffect(() => {
    if (!open || !listRef.current) return
    const rows = listRef.current.querySelectorAll('.qb-ov-row')
    rows[highlight]?.scrollIntoView({ block: 'nearest' })
  }, [highlight, open])

  useEffect(() => {
    if (!open) return
    const onClick = (e) => { if (!wrapRef.current?.contains(e.target)) closeOverlay() }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open, closeOverlay])

  useEffect(() => {
    if (!menuPath) return
    const onDown = (e) => {
      if (!e.target?.closest?.('.qb-menu-wrap')) setMenuPath(null)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [menuPath])

  const applyChipSet = (nextChips) => {
    setChips(nextChips)
    setComposing(null)
    setEditingPath(null)
    setText('')
    closeOverlay()
    addRecent?.(nextChips)
  }

  // Re-opens an existing chip for editing, at whichever part was clicked:
  // 'field' re-picks the whole thing, 'operator' keeps the field, 'value' keeps
  // both. Backspace still steps back from wherever you land.
  const beginEdit = (path, target, e) => {
    e?.stopPropagation()
    const c = getAt(chips, path)
    if (!c || isGroup(c)) return
    const meta = fieldByName[c.field]
    const om = opMetaFor(c.field, c.op, fieldByName)
    setMenuPath(null)
    setEditingPath(path)
    setHighlight(0)
    setOpen(true)

    if (target === 'field') {
      // Nothing survives a field change — the old operator and value belong to
      // the old field, so start the trip from scratch.
      setComposing(null)
      setPendingValues([])
      setText('')
    } else if (target === 'operator') {
      setComposing({ field: c.field, type: meta?.type ?? 'string', highCard: !!meta?.highCard })
      // Carry the value across so switching e.g. `is exactly` → `in (list)`
      // keeps what was already there instead of starting empty.
      setPendingValues(asArray(c.value).map(String))
      setText('')
    } else {
      setComposing({ field: c.field, type: meta?.type ?? 'string', highCard: !!meta?.highCard, op: c.op })
      setPendingValues(om?.multi ? asArray(c.value).map(String) : [])
      // Seed the input only where the value is typed rather than picked; a picklist
      // wants an unfiltered list, not one pre-narrowed to the current value.
      const typedSeed = !om?.multi && (meta?.highCard || om?.freeText)
      setText(typedSeed ? String(c.value ?? '') : '')
    }
    inputRef.current?.focus()
  }

  const commitChip = (chip) => {
    if (isEditing) {
      // Preserve the connector — editing a filter's content shouldn't silently
      // change how it joins to its neighbours.
      const prev = getAt(chips, editingPath)
      setChips(replaceAt(chips, editingPath, { ...chip, connector: prev?.connector }))
      setComposing(null)
      setEditingPath(null)
      setText('')
      inputRef.current?.focus()
      return
    }
    // appendInto strips the connector when this is the first node in its list,
    // so the same call works at the top level and inside an open group.
    setChips(appendInto(chips, insertionPath, { connector: pendingConnector ?? 'AND', ...chip }))
    setPendingConnector(null)
    setComposing(null)
    setText('')
    inputRef.current?.focus()
  }

  // Appends several chips in one go, AND-ed together. Used by the word-split
  // free-text option; editing is single-chip only, so this always appends.
  const commitChips = (list) => {
    if (!list.length) return
    let next = chips
    for (const chip of list) next = appendInto(next, insertionPath, { connector: 'AND', ...chip })
    setChips(next)
    setComposing(null)
    setEditingPath(null)
    setText('')
    inputRef.current?.focus()
  }

  const commitItem = (item) => {
    if (!item) return
    if (item.kind === 'group') { startGroup(); return }
    if (item.kind === 'connector') {
      setPendingConnector(item.payload)
      setText('')
      setHighlight(0)
      inputRef.current?.focus()
      return
    }
    // Free text commits straight to a chip — no operator/value phases, since the
    // field (_msg) and the operator are both carried by the chosen row. The split
    // variant lands several chips at once, one per word.
    if (item.kind === 'freetext') {
      const o = item.payload
      if (o.kind === 'split') {
        commitChips(o.words.map(w => ({ field: '_msg', op: o.op, value: w })))
      } else {
        commitChip({ field: '_msg', op: o.op, value: o.value })
      }
      return
    }
    if (item.kind === 'facet') {
      const f = item.payload
      setTypedEntry(false)
      setComposing({ field: f.field, type: f.type, highCard: !!f.highCard })
      setText('')
      inputRef.current?.focus()
      return
    }
    if (item.kind === 'operator') {
      const o = item.payload
      if (o.noValue) { commitChip({ field: composing.field, op: o.op }); return }
      setComposing({ ...composing, op: o.op })
      setText('')
      inputRef.current?.focus()
      return
    }
    if (item.kind === 'value') {
      commitChip({ field: composing.field, op: composing.op, value: item.payload.value })
      return
    }
    if (item.kind === 'multi-value') {
      const v = String(item.payload.value)
      setPendingValues(prev => prev.includes(v) ? prev.filter(x => x !== v) : [...prev, v])
      setText('')
      inputRef.current?.focus()
      return
    }
    if (item.kind === 'recent') { applyChipSet(item.payload); return }
    if (item.kind === 'saved') { applyChipSet(item.payload.chips); return }
  }

  const commitTypedValue = () => {
    if (!composing?.op || !text.trim()) return
    commitChip({ field: composing.field, op: composing.op, value: text.trim() })
  }

  const commitMultiValues = () => {
    if (!composing?.op || pendingValues.length === 0) return
    commitChip({ field: composing.field, op: composing.op, value: pendingValues })
  }

  // Abandon the in-progress trip entirely (the composing chip's × button).
  const cancelComposing = useCallback(() => {
    setComposing(null)
    setEditingPath(null)
    setText('')
    setPendingValues([])
  }, [])

  const stepBack = () => {
    if (!composing) {
      // A pending connector is the most recent thing added, so it goes first —
      // otherwise backspace would reach past it and delete the chip before it.
      if (pendingConnector) { setPendingConnector(null); return }
      const last = lastLeafPath(chips)
      if (last) setChips(removeAt(chips, last, insertionPath))
      return
    }
    if (composing.op != null) setComposing({ ...composing, op: undefined })
    // Stepping past the field ends the trip; for an edit that means abandoning
    // it, which restores the untouched original. Text typed by hand comes back
    // as text so backspace keeps behaving like backspace.
    else {
      const restore = typedEntry && !isEditing ? composing.field : ''
      setComposing(null)
      setEditingPath(null)
      setTypedEntry(false)
      if (restore) setText(restore)
    }
  }

  // Returns the message explaining why a space is invalid here, or null when the
  // space is legitimate (mid-phrase in free text or in a typed value).
  const spaceRejection = () => {
    const typed = text.trim()
    if (phase === 'operator') {
      return `Spaces aren’t allowed here — pick an operator for “${composing.field}”.`
    }
    if (phase === 'value') {
      if (!needsTypedValue) return `Spaces aren’t allowed here — pick a value for “${composing.field}”.`
      return typed ? null : `Type a value for “${composing.field}” before adding a space.`
    }
    // Field phase: a space with nothing typed starts nothing.
    return typed ? null : 'Spaces aren’t allowed here — start typing a field name or search text.'
  }

  // ---------- Typing query syntax directly ----------
  // Someone who knows the grammar can write `service:=order ` and get the same
  // chip a click would produce. The interpreter is pure (utils/typedQuery.js);
  // this only decides when to hand a resolved piece over to `composing`.

  const fieldMeta = (name) => {
    const m = fieldByName[name]
    return { field: name, type: m?.type ?? 'string', highCard: !!m?.highCard }
  }

  // Runs on every keystroke. Advances field → operator → value as soon as each
  // part is unambiguous, and leaves the buffer alone while it still isn't.
  const advanceFromTyping = (raw) => {
    // Field slot: peel off `<known field><operator>` if that is what was typed.
    if (!composing) {
      const sp = splitField(raw, typeableFields)
      if (!sp || !sp.rest) return false
      const r = resolveOperator(sp.rest)
      if (r.status === 'none') return false
      // Move into the operator phase either way; when the operator is still
      // ambiguous its symbol stays in the input, which also narrows the list.
      setComposing(r.status === 'resolved' ? { ...fieldMeta(sp.field), op: r.op } : fieldMeta(sp.field))
      setTypedEntry(true)
      setText(r.status === 'resolved' ? r.rest : sp.rest)
      setHighlight(0)
      return true
    }
    // Operator slot: the buffer holds the symbol being typed.
    if (composing.op == null) {
      const r = resolveOperator(raw)
      if (r.status !== 'resolved') return false
      setComposing({ ...composing, op: r.op })
      setText(r.rest)
      setHighlight(0)
      return true
    }
    return false
  }

  const onTextChange = (raw) => {
    if (!isEditing && !composing) {
      // A bracket only opens or closes a group from an empty slot. Typed part
      // way through something else it is ordinary text, so `time(out)` still
      // searches for what it says.
      if (raw === '(') { startGroup(); setText(''); return }
      if (raw === ')' && insertionPath) { closeGroup(); setText(''); return }
    }
    setText(raw)
    if (!open) setOpen(true)
    if (!isEditing) advanceFromTyping(raw)
  }

  // What the buffer will become if committed right now — drives the live hint
  // and tells the space key whether it is a separator or just a character.
  const typedView = useMemo(() => {
    if (composing?.op != null) {
      const chip = isCommittable(composing.op, text) ? buildChip(composing.op, text) : null
      return chip
        ? { kind: 'complete', label: 'field filter', field: composing.field, ...chip }
        : { kind: 'partial', label: 'field filter', field: composing.field }
    }
    if (composing) return { kind: 'partial', label: 'field filter', field: composing.field }
    return interpret(text, typeableFields)
  }, [text, composing, typeableFields])

  // Commits whatever the buffer currently spells out. Returns false when there
  // is nothing complete to commit, so the caller can fall through.
  const commitTyped = () => {
    if (composing?.op != null) {
      const chip = isCommittable(composing.op, text) ? buildChip(composing.op, text) : null
      if (!chip) return false
      commitChip({ field: composing.field, ...chip })
      return true
    }
    return false
  }

  // Decides what a space means where the caret is:
  //   'commit'  — the buffer spells a finished filter
  //   'advance' — already applied (the operator moved on)
  //   'allow'   — a real character, e.g. inside a phrase or a free-text search
  //   'reject'  — nothing here for a space to separate
  const spaceAction = () => {
    // Value slot. Operators that carry spaces (phrase, regex, in-lists) are not
    // committable until they close, so their spaces stay content.
    if (composing?.op != null) {
      return isCommittable(composing.op, text) ? 'commit' : 'allow'
    }

    // Operator slot. This is where ` in (` and ` not_in (` live, so a space can
    // legitimately be the first character of the operator.
    if (composing) {
      const next = text + ' '
      const r = resolveOperator(next)
      if (r.status === 'resolved') {
        setComposing({ ...composing, op: r.op })
        setText(r.rest)
        const chip = isCommittable(r.op, r.rest) ? buildChip(r.op, r.rest) : null
        if (chip) commitChip({ field: composing.field, ...chip })
        return 'advance'
      }
      if (r.status === 'pending') { setText(next); return 'advance' }
      return 'reject'
    }

    // A connector joins the chip that follows to the one before it, so it only
    // means anything once something is already there.
    const conn = matchConnector(text)
    if (conn && (chips.length > 0 || insertionPath)) {
      setPendingConnector(conn)
      setText('')
      setHighlight(0)
      return 'advance'
    }

    // Field slot. A space straight after a complete field name opens the
    // in()/not_in() path rather than starting a free-text phrase — the one
    // place where a field name stops behaving like ordinary search text.
    if (isKnownField(text, typeableFields)) {
      setComposing(fieldMeta(text))
      setText(' ')
      setHighlight(0)
      return 'advance'
    }

    // Free-text syntax the user wrote out themselves is a finished term the
    // moment it closes — `"a b"`, `pay*`, `*pay*` — so a space commits the pill
    // it spells, exactly as it would for a typed field filter. Undecorated text
    // stays open, because a space there is just the next word.
    const ft = deriveFreeText(text)
    if (ft.explicit) {
      commitChip({ field: '_msg', op: ft.op, value: ft.value })
      return 'advance'
    }

    return text.trim() ? 'allow' : 'reject'
  }

  const onKeyDown = (e) => {
    // A space only carries meaning while typing a free-text phrase — either the
    // bare search text in the field slot, or a typed value for an operator that
    // takes one. Anywhere else (empty input, picking a field, picking an operator,
    // picking from a value list) it separates nothing, so it's rejected loudly
    // rather than silently swallowed.
    if (e.key === ' ') {
      const action = spaceAction()
      if (action === 'advance') { e.preventDefault(); return }
      if (action === 'commit') {
        e.preventDefault()
        if (commitTyped()) return
      }
      if (action === 'reject') {
        e.preventDefault(); setSpaceError(spaceRejection()); return
      }
    } else if ((spaceError || pasteError) && e.key.length === 1) {
      setSpaceError(null); setPasteError(null)
    }

    if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      setOpen(true); e.preventDefault(); return
    }
    if (e.key === 'Backspace' && !text) {
      e.preventDefault(); stepBack(); return
    }
    // With the overlay closed there is no suggestion to take, so Enter runs —
    // guarded the same way the Run button is, so it cannot no-op silently past
    // an error the button would have refused.
    if (!open && e.key === 'Enter') {
      e.preventDefault()
      if (!blockedReason) { addRecent?.(chips); onRun?.() }
      return
    }
    if (!open) return

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlight(h => Math.min(h + 1, Math.max(flatItems.length - 1, 0)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight(h => Math.max(h - 1, 0))
    } else if (e.key === 'Tab') {
      // Tab is the ONLY key that takes something out of the overlay. Keeping
      // that on one key is what lets Enter mean exactly one thing.
      e.preventDefault()
      if (isMulti) {
        // Shift+Tab steps back through the values picked so far.
        if (e.shiftKey && pendingValues.length) setPendingValues(pendingValues.slice(0, -1))
        else if (flatItems.length > 0) commitItem(flatItems[highlight])
      } else if (flatItems.length > 0) {
        commitItem(flatItems[highlight])
      } else if (needsTypedValue && text.trim()) {
        commitTypedValue()
      } else if (typedView.kind === 'complete') {
        // A typed value that matches no known one is still valid — the picklist
        // only shows values already seen in the data.
        commitTyped()
      }
    } else if (e.key === 'Enter') {
      // Enter runs the query. It never reaches into the overlay — a highlighted
      // suggestion is Tab's to take. What it will do first is close off whatever
      // the user built themselves, so that a half-finished term is carried into
      // the run rather than silently dropped (or left blocking it).
      e.preventDefault()
      const committed =
        isMulti && pendingValues.length ? (commitMultiValues(), true)
        : needsTypedValue && text.trim() ? (commitTypedValue(), true)
        : typedView.kind === 'complete' ? commitTyped()
        : false
      if (committed) runAfterCommit.current = true
      else if (!blockedReason) { addRecent?.(chips); onRun?.(); closeOverlay() }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      closeOverlay()
    }
  }

  // Resets the whole bar, not just the committed chips — leaving a half-built
  // filter or stray text behind after "clear everything" would be surprising.
  const clearAll = (e) => {
    e?.stopPropagation()
    setChips([])
    setComposing(null)
    setEditingPath(null)
    setPendingConnector(null)
    setPendingValues([])
    setText('')
    inputRef.current?.focus()
  }

  // normalize inside removeAt also tidies up whatever the removal left behind —
  // a group down to one filter unwraps, an emptied group disappears.
  const removeNode = (path, e) => {
    e?.stopPropagation()
    setChips(removeAt(chips, path, insertionPath))
    setMenuPath(null)
    inputRef.current?.focus()
  }

  const toggleConnector = (path) => {
    setChips(toggleConnectorAt(chips, path))
  }

  // The pending connector isn't on a chip yet, so it flips its own state rather
  // than going through the tree — but it has to behave identically to a
  // committed one, which is click-to-toggle.
  const togglePendingConnector = () => {
    setPendingConnector(c => (c === 'OR' ? 'AND' : 'OR'))
    inputRef.current?.focus()
  }

  const groupWith = (path, dir) => {
    setChips(wrapWithNeighbour(chips, path, dir))
    setInsertionPath(null)
    setMenuPath(null)
    inputRef.current?.focus()
  }

  const ungroup = (path) => {
    setChips(unwrapAt(chips, path))
    setInsertionPath(null)
    setMenuPath(null)
    inputRef.current?.focus()
  }

  // Opens an empty group and points new filters into it.
  const startGroup = () => {
    const next = appendInto(chips, insertionPath, newGroup([], pendingConnector ?? 'AND'))
    // Path of the group just added — groups can nest, so it may not be at root.
    const list = insertionPath ? (getAt(next, insertionPath)?.children ?? []) : next
    const path = insertionPath ? [...insertionPath, list.length - 1] : [next.length - 1]
    setChips(next)
    setPendingConnector(null)
    setInsertionPath(path)
    setComposing(null)
    setText('')
    setHighlight(0)
    setOpen(true)
    inputRef.current?.focus()
  }

  // Leaves the open group; normalize drops it if it never got two filters.
  const closeGroup = () => {
    setInsertionPath(null)
    setChips(normalize(chips))
    inputRef.current?.focus()
  }

  // The sibling list a path lives in — used to decide which menu items apply.
  const siblingsAt = (path) => {
    const parent = path.slice(0, -1)
    return parent.length ? (getAt(chips, parent)?.children ?? []) : chips
  }

  const typedValuePlaceholder = (op, field) => {
    switch (op) {
      case 'regex':    return `Regex pattern for ${field} (e.g. ^error.*)`
      case 'nregex':   return `Regex to exclude on ${field} (e.g. ^info)`
      case 'contains': return `Substring to match anywhere in ${field}…`
      case 'prefix':   return `Prefix for ${field} (e.g. pay matches payment, payer)`
      case 'phrase':   return `Phrase in ${field} — multi-word exact (quotes auto)`
      default:         return `Type a value for ${field}…`
    }
  }

  const idlePlaceholder = placeholder
  const inputPlaceholder = phase === 'operator'
    ? `Choose an operator for ${composing.field}…`
    : phase === 'value'
      ? (isMulti
          ? `Pick values — Tab to commit ${pendingValues.length ? `(${pendingValues.length} selected)` : ''}`
          : needsTypedValue
            ? typedValuePlaceholder(composing.op, composing.field)
            : isEditing
              ? `Pick a new value for ${composing.field} — Esc to cancel`
              : `Search values for ${composing.field}…`)
      : isEditing
        ? 'Pick a replacement field — Esc to cancel'
        : chips.length
          ? 'Add another filter'
          : idlePlaceholder

  // Rendered either above or below the facet list depending on freeTextFirst, so
  // it's built once here rather than duplicated at both call sites.
  const freeTextSection = suggestions.mode === 'fields' && suggestions.freeText.length ? (
    <Section label="Free Text Search" meta="Log message">
      {suggestions.freeText.map((o, i) => {
        const idx = flatItems.findIndex(x => x.key === `ft${i}`)
        const preview = o.kind === 'split'
          ? o.words.map(w => opValueText(o.op, w).replace(/^:/, '')).join(' AND ')
          : opValueText(o.op, o.value).replace(/^:/, '')
        return (
          <Row key={o.kind + o.op} icon="⌕" active={idx === highlight}
            onHover={() => setHighlight(idx)} onPick={() => commitItem(flatItems[idx])}
            label={<>
              <span className="qb-ov-name">
                Search logs {o.label} {o.kind === 'split'
                  ? o.words.map(w => `“${w}”`).join(', ')
                  : `“${o.value}”`}
              </span>
              <span className="qb-ov-preview mono">{preview}</span>
            </>} />
        )
      })}
    </Section>
  ) : null

  const connectorSection = suggestions.mode === 'fields' && suggestions.connectors?.length ? (
    <Section label="Connector" meta="Joins to the previous filter">
      {suggestions.connectors.map((c, i) => {
        const idx = flatItems.findIndex(x => x.key === `c${i}`)
        return (
          <Row key={`c${i}`} icon={c === 'OR' ? '∨' : '∧'} active={idx === highlight}
            onHover={() => setHighlight(idx)} onPick={() => commitItem(flatItems[idx])}
            label={<>
              <span className="qb-ov-name">{c}</span>
              <span className="qb-ov-meta">
                {c === 'OR'
                  ? 'Match either this filter or the one before it'
                  : 'Match this filter as well as the one before it'}
              </span>
            </>}
            meta={<span className="qb-ov-preview mono">… {c} …</span>} />
        )
      })}
    </Section>
  ) : null

  // A trip is "abandoned" when it's still composing but the overlay has closed
  // (blur, Run, click-away) without being committed as a chip. That's the point
  // we flip the composing chip from in-progress blue to error red and explain
  // what's missing. While the overlay is open we treat it as in-progress and
  // stay quiet — no nagging mid-build.
  const composingAbandoned = !!composing && !open
  const incompleteMessage = !composingAbandoned
    ? null
    : composing.op == null
      ? `Unfinished filter — choose an operator for “${composing.field}”, or remove it.`
      : isMulti
        ? `Unfinished filter — pick at least one value for “${composing.field}”, or remove it.`
        : `Unfinished filter — add a value for “${composing.field}”, or remove it.`

  // Everything that makes the current query un-runnable, as one reason string.
  // The Run button both disables on it and shows it as its tooltip, so the user
  // is told *why* rather than being left with a dead control. Only a *new*
  // half-built chip counts: an in-flight edit leaves the original chip in
  // `chips`, still valid, so the query stays runnable.
  const blockedReason = spaceError || incompleteMessage || (
    composing && !isEditing
      ? `Unfinished filter on “${composing.field}” — finish it or remove it to run.`
      : null
  )
  useEffect(() => { onBlockedChange?.(blockedReason) }, [blockedReason, onBlockedChange])

  // Pasting a whole query only makes sense from a clean position: a half-built
  // chip or half-typed text has no obvious place to put the pasted tree, and
  // guessing would be worse than refusing.
  //
  // Anything that doesn't parse as a query is left entirely alone — no
  // preventDefault, no chips — so pasting a value into a value field keeps
  // working. A bare word like `payment` has no operator and so never parses,
  // which makes "does it parse?" the whole test.
  const onPaste = (e) => {
    if (!parsePastedQuery) return
    const raw = e.clipboardData?.getData('text') ?? ''
    if (!raw.trim()) return

    const res = parsePastedQuery(raw)
    if (!res?.ok) {
      // The text still pastes; when it looked like a query, the parser's
      // reason rides along so the user can see what went wrong.
      if (res?.error) setPasteError(res.error)
      return
    }

    e.preventDefault()
    const inProgress = blockedReason
      || (composing ? `Finish or remove the filter on “${composing.field}” before pasting a query.` : null)
      || (text.trim() ? 'Clear the text in the query bar before pasting a query.' : null)
    if (inProgress) { setPasteError(inProgress); return }

    setChips(concatWithAnd(chips, res.chips))
    if (res.pipes) onApplyPipes?.(res.pipes)
    setPasteError(res.notice ?? null)
  }

  // Shows a typed `AND`/`OR` in the slot it will occupy, so the connector is
  // visible before the chip it belongs to exists.
  const connectorGhost = pendingConnector ? (
    <button
      type="button"
      className={`qb-connector is-ghost${pendingConnector === 'OR' ? ' or' : ''}`}
      onClick={(e) => { e.stopPropagation(); togglePendingConnector() }}
      onMouseDown={(e) => e.preventDefault()}
      title={`Boolean connector — click to toggle (currently ${pendingConnector}). Backspace removes it.`}
      aria-label={`Toggle pending connector — currently ${pendingConnector}`}
    >{pendingConnector}</button>
  ) : null

  // The in-progress chip. Renders at the end of the row for a new filter, or in
  // the edited chip's own slot so the query keeps its reading order while editing.
  const composingChip = composing ? (
    <span className={`qb-composing${composingAbandoned ? ' is-error' : ''}${isEditing ? ' is-editing' : ''}`} aria-live="polite">
      <span className="qb-composing-field">{composing.field}</span>
      {composing.op != null && <span className="qb-composing-op">{opStartText(composing.op)}</span>}
      {isMulti && pendingValues.length > 0 && (
        <span className="qb-composing-op">{pendingValues.map(v => `"${v}"`).join(', ')})</span>
      )}
      <button
        type="button"
        className="qb-composing-x"
        onClick={(e) => { e.stopPropagation(); cancelComposing() }}
        onMouseDown={(e) => e.preventDefault()}
        aria-label={isEditing ? `Cancel editing ${composing.field}` : `Remove unfinished filter ${composing.field}`}
        title={isEditing ? 'Cancel edit' : 'Remove unfinished filter'}
      >×</button>
    </span>
  ) : null

  // ---------- Recursive chip rendering ----------
  // Positions are paths, so the same code renders the top level and any depth
  // of nesting. `basePath` is the path of the list being rendered.

  const renderChip = (c, path) => {
    const raw = chipSegments(c.op, c.value)
    // A free-text chip targets the log body, which the user never named — so
    // the implied `_msg:` head is dropped and only the pattern shows
    // (`*text*`, `text*`, `"text"`). The generated query still carries it.
    const isFreeText = c.field === '_msg'
    const seg = isFreeText ? { ...raw, prefix: raw.prefix.replace(/^:/, '') } : raw
    const full = `${c.field}${opValueText(c.op, c.value)}`
    const opBtn = (key) => (
      <button
        key={key}
        type="button"
        className="qb-chip-seg qb-chip-op"
        onClick={(e) => beginEdit(path, 'operator', e)}
        onMouseDown={(e) => e.preventDefault()}
        title="Click to change the operator"
        aria-label={`Change operator for ${full}`}
      >{key === 'pre' ? seg.prefix : seg.suffix}</button>
    )
    return (
      <span className={`qb-chip${isFreeText ? ' is-freetext' : ''}`}>
        {!isFreeText && (
          <button
            type="button"
            className="qb-chip-seg qb-chip-field"
            onClick={(e) => beginEdit(path, 'field', e)}
            onMouseDown={(e) => e.preventDefault()}
            title="Click to change the field"
            aria-label={`Change field for ${full}`}
          >{c.field}</button>
        )}
        {seg.prefix && opBtn('pre')}
        {seg.value && (
          <button
            type="button"
            className="qb-chip-seg qb-chip-val"
            onClick={(e) => beginEdit(path, 'value', e)}
            onMouseDown={(e) => e.preventDefault()}
            title="Click to change the value"
            aria-label={`Change value for ${full}`}
          >{seg.value}</button>
        )}
        {seg.suffix && opBtn('suf')}
        {renderMenu(path, full)}
        <button
          type="button"
          className="qb-chip-x"
          onClick={(e) => removeNode(path, e)}
          aria-label={`Remove filter ${full}`}
          title="Remove filter"
        >×</button>
      </span>
    )
  }

  // The bracket / ungroup menu. Kept off the three editable chip segments so it
  // never competes with click-to-edit.
  const renderMenu = (path, label) => {
    const node = getAt(chips, path)
    const sibs = siblingsAt(path)
    const idx = path[path.length - 1]
    const canPrev = idx > 0
    const canNext = idx < sibs.length - 1
    const canUngroup = isGroup(node)
    if (!canPrev && !canNext && !canUngroup) return null
    const isOpen = pathEquals(menuPath, path)
    return (
      <span className="qb-menu-wrap">
        <button
          type="button"
          className={`qb-node-menu${isOpen ? ' is-open' : ''}`}
          onClick={(e) => { e.stopPropagation(); setMenuPath(isOpen ? null : path) }}
          onMouseDown={(e) => e.preventDefault()}
          title="Grouping options"
          aria-label={`Grouping options for ${label}`}
          aria-expanded={isOpen}
        >⋯</button>
        {isOpen && (
          <span className="qb-node-menu-pop" role="menu">
            {canPrev && (
              <button type="button" role="menuitem" onMouseDown={(e) => e.preventDefault()}
                onClick={(e) => { e.stopPropagation(); groupWith(path, 'prev') }}>
                ( ) Group with previous
              </button>
            )}
            {canNext && (
              <button type="button" role="menuitem" onMouseDown={(e) => e.preventDefault()}
                onClick={(e) => { e.stopPropagation(); groupWith(path, 'next') }}>
                ( ) Group with next
              </button>
            )}
            {canUngroup && (
              <button type="button" role="menuitem" onMouseDown={(e) => e.preventDefault()}
                onClick={(e) => { e.stopPropagation(); ungroup(path) }}>
                ⤫ Ungroup
              </button>
            )}
          </span>
        )}
      </span>
    )
  }

  const renderGroup = (g, path) => {
    const kids = g.children ?? []
    const isTarget = pathEquals(insertionPath, path)
    // Alternate the tint by depth so nested brackets stay legible.
    const depthClass = path.length % 2 === 0 ? ' alt' : ''
    return (
      <span className={`qb-group${depthClass}${isTarget ? ' is-target' : ''}`}>
        <span className="qb-group-bracket" aria-hidden>(</span>
        {renderNodes(kids, path)}
        {isTarget && connectorGhost}
        {isTarget && !isEditing && composingChip}
        {kids.length === 0 && !composing && (
          <span className="qb-group-empty">add a filter…</span>
        )}
        <span className="qb-group-bracket" aria-hidden>)</span>
        {isTarget && (
          <button
            type="button"
            className="qb-group-done"
            onClick={(e) => { e.stopPropagation(); closeGroup() }}
            onMouseDown={(e) => e.preventDefault()}
            title="Finish this group — new filters go back to the top level"
          >done</button>
        )}
        {renderMenu(path, 'group')}
        <button
          type="button"
          className="qb-chip-x"
          onClick={(e) => removeNode(path, e)}
          aria-label="Remove group"
          title="Remove group"
        >×</button>
      </span>
    )
  }

  const renderNodes = (nodes, basePath) => nodes.map((n, i) => {
    const path = [...basePath, i]
    return (
      <Fragment key={path.join('.')}>
        {i > 0 && (
          <button
            type="button"
            className={`qb-connector${n.connector === 'OR' ? ' or' : ''}`}
            onClick={(e) => { e.stopPropagation(); toggleConnector(path) }}
            title={`Boolean connector — click to toggle (currently ${n.connector === 'OR' ? 'OR' : 'AND'})`}
            aria-label={`Toggle connector — currently ${n.connector === 'OR' ? 'OR' : 'AND'}`}
          >
            {n.connector === 'OR' ? 'OR' : 'AND'}
          </button>
        )}
        {pathEquals(editingPath, path) ? (composingChip ?? (
          // Field phase of an edit: no composing chip exists yet, so show the
          // original in the editing style — the slot keeps its place and the
          // × still cancels back to it.
          <span className="qb-chip is-editing">
            <span className="qb-chip-field">{n.field}</span>
            <span className="qb-chip-opval">{opValueText(n.op, n.value)}</span>
            <button
              type="button"
              className="qb-chip-x"
              onClick={(e) => { e.stopPropagation(); cancelComposing() }}
              onMouseDown={(e) => e.preventDefault()}
              title="Cancel edit"
              aria-label={`Cancel editing ${n.field}`}
            >×</button>
          </span>
        )) : isGroup(n) ? renderGroup(n, path) : renderChip(n, path)}
      </Fragment>
    )
  })

  return (
    <div className="qb-wrap" ref={wrapRef}>
      <div className="qb-input-row" onClick={() => inputRef.current?.focus()}>
        {/* Leading slot — the mode toggle lives here in place of the magnifier.
            Falls back to the icon when no toggle is supplied. */}
        {leading ?? (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>
          </svg>
        )}

        {renderNodes(chips, [])}

        {/* A new filter composes at the end of whichever list it will land in;
            when a group is open that slot lives inside the group instead. */}
        {!insertionPath && connectorGhost}
        {!isEditing && !insertionPath && composingChip}

        <input
          ref={inputRef}
          className="qb-input"
          value={text}
          onChange={(e) => onTextChange(e.target.value)}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder={inputPlaceholder}
          spellCheck={false}
          autoComplete="off"
        />

        {/* Says which reading the buffer will get before it is committed, so
            free text and a field filter are never confused for one another. */}
        {typedView.label && (
          <span
            className={`qb-interp is-${typedView.kind === 'freetext' ? 'freetext' : typedView.kind === 'connector' ? 'connector' : 'field'}`}
            aria-live="polite"
          >
            {typedView.kind === 'freetext' ? '⌕ free text'
              : typedView.kind === 'connector' ? 'connector'
              : 'field filter'}
          </span>
        )}

        {/* Sits left of the × so the destructive control stays the last thing
            in the row. onMouseDown is swallowed to keep input focus. */}
        {onCopyQuery && (
          <button
            type="button"
            className="qb-copy-query"
            onClick={onCopyQuery}
            onMouseDown={(e) => e.preventDefault()}
            title="Copy query to clipboard"
            aria-label="Copy query to clipboard"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
          </button>
        )}

        {chips.length > 0 && (
          <button
            type="button"
            className="qb-clear-all"
            onClick={clearAll}
            onMouseDown={(e) => e.preventDefault()}
            title="Clear all filters"
            aria-label="Clear all filters"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        )}
      </div>

      {(pasteError || spaceError || incompleteMessage) && (
        <div className="qb-composing-error" role="alert">
          <AlertCircle size={12} strokeWidth={2} />
          <span>{pasteError || spaceError || incompleteMessage}</span>
        </div>
      )}

      {open && (
        // stopPropagation here keeps a click on an overlay row from reaching the
        // document-level outside-click handler. Without it, a row that re-renders
        // out of existence on click (facet → operators) is seen as a detached
        // target "outside" the wrap, which wrongly closed the overlay and broke
        // the field → operator → value flow.
        <div className="qb-overlay" role="listbox" onMouseDown={(e) => e.stopPropagation()}>
          <div ref={listRef} className="qb-overlay-scroll">

            {suggestions.mode === 'fields' && (
              <>
                {suggestions.connectorsFirst && connectorSection}
                {suggestions.freeTextFirst && freeTextSection}
                <Section label="Top Facets / Keys" meta="Indexed">
                  {suggestions.facets.length === 0 ? (
                    <Empty>No fields match "{text}"</Empty>
                  ) : suggestions.facets.map((f, i) => {
                    const idx = flatItems.findIndex(x => x.key === `f${i}`)
                    return (
                      <Row key={`f${i}`} icon={f.type === 'keyword' ? '#' : 'A'} active={idx === highlight}
                        onHover={() => setHighlight(idx)} onPick={() => commitItem(flatItems[idx])}
                        label={<>
                          <span className="mono">{f.field}</span>
                          {(f.highCard || !['log.level', 'service', 'trace_id'].includes(f.field)) &&
                            <span className="qb-ov-meta">{f.highCard ? 'high cardinality' : f.desc}</span>
                          }
                        </>}
                        meta={<span className="qb-ov-type">{f.type}</span>} />
                    )
                  })}
                </Section>

                {!suggestions.freeTextFirst && freeTextSection}
                {!suggestions.connectorsFirst && connectorSection}
                {suggestions.canGroup && (() => {
                  const idx = flatItems.findIndex(x => x.key === 'grp')
                  return (
                    <Section label="Grouping" meta="Parentheses">
                      <Row icon="( )" active={idx === highlight}
                        onHover={() => setHighlight(idx)} onPick={() => commitItem(flatItems[idx])}
                        label={<>
                          <span className="qb-ov-name">
                            {insertionPath ? 'New group inside this one' : 'New group'}
                          </span>
                          <span className="qb-ov-meta">
                            Filters you add next go inside the brackets
                          </span>
                        </>}
                        meta={<span className="qb-ov-preview mono">( … )</span>} />
                    </Section>
                  )
                })()}

                <Section label="Recent Searches" meta={suggestions.recents.length ? `Last ${suggestions.recents.length}` : 'Empty'}>
                  {suggestions.recents.length === 0 ? (
                    <Empty>No recent searches yet — run a query to save it here.</Empty>
                  ) : suggestions.recents.map((r, i) => {
                    const idx = flatItems.findIndex(x => x.key === `r${i}`)
                    return (
                      <Row key={`r${i}`} icon="⟲" active={idx === highlight}
                        onHover={() => setHighlight(idx)} onPick={() => commitItem(flatItems[idx])}
                        label={<span className="mono">{chipsToString(r) || '(empty query)'}</span>} />
                    )
                  })}
                </Section>

                <Section label="Saved Queries" meta="Team">
                  {suggestions.saved.length === 0 ? (
                    <Empty>No saved queries match "{text}"</Empty>
                  ) : suggestions.saved.map((s, i) => {
                    const idx = flatItems.findIndex(x => x.key === `s${i}`)
                    return (
                      <Row key={`s${i}`} icon="☆" active={idx === highlight}
                        onHover={() => setHighlight(idx)} onPick={() => commitItem(flatItems[idx])}
                        label={<>
                          <span className="qb-ov-name">{s.name}</span>
                          <span className="qb-ov-preview mono">{chipsToString(s.chips)}</span>
                        </>} />
                    )
                  })}
                </Section>
              </>
            )}

            {suggestions.mode === 'operators' && (() => {
              // Group ops by category, preserving the flat index for keyboard nav
              const grouped = CATEGORY_ORDER
                .map(cat => ({ cat, ops: suggestions.items.filter(o => o.cat === cat) }))
                .filter(g => g.ops.length > 0)
              return (
                <div className="qb-ov-ops-wrap">
                  <div className="qb-ov-header">
                    <span className="qb-ov-lbl">Operators for {composing.field}</span>
                    <span className="qb-ov-lbl-meta">
                      {composing.highCard ? 'high-cardinality field' : `${composing.type} field`}
                    </span>
                  </div>
                  {grouped.map(({ cat, ops }) => (
                    <div key={cat} className="qb-ov-subsection">
                      <div className="qb-ov-subhead">{cat}</div>
                      {ops.map(o => {
                        const flatIdx = suggestions.items.indexOf(o)
                        const idx = flatItems.findIndex(x => x.key === `o${flatIdx}`)
                        return (
                          <Row key={`o${flatIdx}`}
                            icon={<span className="qb-ov-opsym">{o.sym}</span>}
                            active={idx === highlight}
                            onHover={() => setHighlight(idx)}
                            onPick={() => commitItem(flatItems[idx])}
                            label={<>
                              <span className="qb-ov-name">{o.label}</span>
                              <span className="qb-ov-meta mono">{o.hint}</span>
                            </>} />
                        )
                      })}
                    </div>
                  ))}
                </div>
              )
            })()}

            {suggestions.mode === 'values' && (
              <Section
                label={`Values for ${composing.field}`}
                meta={valueSectionMeta(suggestions)}
              >
                {suggestions.status === 'loading' ? <LoadingRows /> :
                 suggestions.status === 'error' ? <ErrorRow message={suggestions.error} onRetry={retryValues} /> :
                 suggestions.status === 'empty' ? (
                  <Empty>
                    No values recorded for <span className="mono">{composing.field}</span> in this time range.
                    Type one and press <kbd>Enter</kbd> to use it anyway.
                  </Empty>
                ) : suggestions.items.length === 0 ? (
                  <Empty>No values match "{text}". Press <kbd>Enter</kbd> to use it as an exact value.</Empty>
                ) : suggestions.items.map((v, i) => {
                  const idx = flatItems.findIndex(x => x.key === `v${i}`)
                  return (
                    <Row key={`v${i}`} icon="A" active={idx === highlight}
                      onHover={() => setHighlight(idx)} onPick={() => commitItem(flatItems[idx])}
                      label={<span className="mono">{v.value}</span>} />
                  )
                })}
              </Section>
            )}

            {suggestions.mode === 'multi-values' && (
              <Section
                label={`Values for ${composing.field} ${composing.op === 'in' ? '(in)' : '(not in)'}`}
                meta={suggestions.status === 'ready' ? `${pendingValues.length} selected` : valueSectionMeta(suggestions)}
              >
                {suggestions.status === 'loading' ? <LoadingRows /> :
                 suggestions.status === 'error' ? <ErrorRow message={suggestions.error} onRetry={retryValues} /> :
                 suggestions.status === 'empty' ? (
                  <Empty>
                    No values recorded for <span className="mono">{composing.field}</span> in this time range.
                  </Empty>
                ) : suggestions.items.length === 0 ? (
                  <Empty>No values match "{text}".</Empty>
                ) : suggestions.items.map((v, i) => {
                  const idx = flatItems.findIndex(x => x.key === `m${i}`)
                  const checked = pendingValues.includes(String(v.value))
                  return (
                    <Row key={`m${i}`}
                      icon={<span className={`qb-mv-check${checked ? ' on' : ''}`}>{checked ? '✓' : ''}</span>}
                      active={idx === highlight}
                      onHover={() => setHighlight(idx)}
                      onPick={() => commitItem(flatItems[idx])}
                      label={<>
                        <span className="mono">{v.value}</span>
                        {v.custom && <span className="qb-ov-meta">custom value</span>}
                      </>}
                      />
                  )
                })}
              </Section>
            )}

            {suggestions.mode === 'typed-value' && (
              <div className="qb-hc-section">
                <div className="qb-ov-header">
                  <span className="qb-ov-lbl">Value for {composing.field}</span>
                  <span className="qb-ov-lbl-meta">{composing.highCard ? 'Exact match' : opMeta?.hint}</span>
                </div>
                <div className="qb-hc-body">
                  <p>
                    {composing.highCard
                      ? <><span className="mono">{composing.field}</span> is a high-cardinality field — too many distinct values to list. Type an exact value.</>
                      : composing.op === 'regex' || composing.op === 'nregex'
                        ? <>Type a regular expression to match against <span className="mono">{composing.field}</span>.</>
                        : composing.op === 'phrase'
                          ? <>Type the phrase to match inside <span className="mono">{composing.field}</span>. Quotes are added automatically.</>
                          : <>Type the text to match against <span className="mono">{composing.field}</span>.</>}
                  </p>
                  <button type="button" className="qb-hc-commit" disabled={!text.trim()} onClick={commitTypedValue}>
                    {text.trim()
                      ? `Add filter ${composing.field}${opValueText(composing.op, text.trim())}`
                      : 'Add filter'}
                  </button>
                </div>
              </div>
            )}
          </div>

          {suggestions.mode === 'multi-values' && (
            <div className="qb-mv-foot">
              <span className="qb-mv-count">{pendingValues.length} selected</span>
              <button
                type="button"
                className="qb-hc-commit qb-mv-commit"
                disabled={pendingValues.length === 0}
                onClick={commitMultiValues}
              >
                {pendingValues.length === 0
                  ? 'Pick one or more values'
                  : `Add ${composing.field}${opValueText(composing.op, pendingValues)}`}
              </button>
            </div>
          )}

          <div className="qb-ov-foot">
            <span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span>
            {isMulti
              ? <><span><kbd>Tab</kbd> Toggle value</span><span><kbd>↵</kbd> Done &amp; run</span></>
              : <><span><kbd>Tab</kbd> Insert &amp; continue</span><span><kbd>↵</kbd> Run query</span></>}
            <span><kbd>Backspace</kbd> Back</span>
            <span><kbd>Esc</kbd> Dismiss</span>
          </div>
        </div>
      )}
    </div>
  )
}

// The section's meta slot doubles as the status line, so the header never
// claims "0 values" for a list that simply hasn't arrived.
function valueSectionMeta({ status, items }) {
  if (status === 'loading') return 'Loading…'
  if (status === 'error') return 'Unavailable'
  if (status === 'empty') return 'None in range'
  return `${items.length} value${items.length === 1 ? '' : 's'}`
}

function Section({ label, meta, children }) {
  return (
    <div className="qb-ov-section">
      <div className="qb-ov-header">
        <span className="qb-ov-lbl">{label}</span>
        {meta && <span className="qb-ov-lbl-meta">{meta}</span>}
      </div>
      <div className="qb-ov-list">{children}</div>
    </div>
  )
}

function Empty({ children }) {
  return <div className="qb-ov-empty">{children}</div>
}

// Placeholder rows sized like real ones, so the list doesn't resize when values
// land. Not focusable and not in flatItems — there is nothing here to pick.
function LoadingRows({ count = 5 }) {
  return (
    <div className="qb-ov-loading" aria-live="polite" aria-busy="true">
      <span className="sr-only">Loading values…</span>
      {Array.from({ length: count }, (_, i) => (
        <div className="qb-ov-skel-row" key={i} aria-hidden="true">
          <span className="qb-ov-skel" style={{ width: `${58 - i * 7}%` }} />
        </div>
      ))}
    </div>
  )
}

// A failed lookup is recoverable, so it offers the recovery rather than just
// reporting the failure. Typing a value by hand still works underneath.
function ErrorRow({ message, onRetry }) {
  return (
    <div className="qb-ov-error" role="alert">
      <AlertCircle size={13} strokeWidth={2} />
      <span className="qb-ov-error-msg">{message}</span>
      <button type="button" className="qb-ov-retry" onMouseDown={(e) => { e.preventDefault(); onRetry?.() }}>
        Retry
      </button>
    </div>
  )
}

function Row({ icon, label, meta, active, onHover, onPick }) {
  return (
    <div
      role="option"
      aria-selected={active}
      className={`qb-ov-row${active ? ' hl' : ''}`}
      onMouseEnter={onHover}
      onMouseDown={(e) => { e.preventDefault(); onPick?.() }}
    >
      <span className="qb-ov-icon">{icon}</span>
      <span className="qb-ov-body">{label}</span>
      {meta && <span className="qb-ov-meta-cell">{meta}</span>}
    </div>
  )
}
