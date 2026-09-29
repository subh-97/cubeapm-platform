// Log-query pipes — data model, serializer, validator.
// Emits CubeAPM canonical syntax, matched byte-for-byte to the playground
// Explore Builder (playground.cubeapm.com/explore → Logs → Builder) and the
// docs at docs.cubeapm.com/logs/querying.

// Pipes CubeAPM accepts. Only the first four have builder controls; the rest
// are recognised so a pasted query keeps its meaning instead of being rejected.
export const PIPE_NAMES = [
  'stats', 'math', 'sort', 'limit',
  'copy', 'drop', 'extract_regexp', 'join', 'keep',
  'rename', 'replace', 'replace_regexp', 'unpack_json',
]

export const BUILDER_PIPES = new Set(['stats', 'math', 'sort', 'limit'])

let idSeed = 0
export function newId() { return `p_${++idSeed}` }

// ---------- Stats function catalog ----------
// `needsField`: function is meaningless without a field arg
// `needsNumeric`: field arg must be numeric (avg/sum/etc.)
// `extra`: named extra parameter shown as its own input in the UI
export const STAT_FUNCTIONS = [
  { fn: 'count',       needsField: false, needsNumeric: false, category: 'Count' },
  { fn: 'count_empty', needsField: false, needsNumeric: false, category: 'Count' },
  { fn: 'count_uniq',  needsField: true,  needsNumeric: false, category: 'Count' },
  { fn: 'avg',         needsField: true,  needsNumeric: true,  category: 'Numeric' },
  { fn: 'sum',         needsField: true,  needsNumeric: true,  category: 'Numeric' },
  { fn: 'min',         needsField: true,  needsNumeric: true,  category: 'Numeric' },
  { fn: 'max',         needsField: true,  needsNumeric: true,  category: 'Numeric' },
  { fn: 'median',      needsField: true,  needsNumeric: true,  category: 'Numeric' },
  { fn: 'quantile',    needsField: true,  needsNumeric: true,  category: 'Numeric', extra: 'p' },
]

export const STAT_FN_BY_NAME = Object.fromEntries(STAT_FUNCTIONS.map(f => [f.fn, f]))

// ---------- Factories ----------

export function newStatsFunction(overrides = {}) {
  return {
    id: newId(),
    fn: 'count',
    p: 0.9,      // meaningful only when fn === 'quantile'
    field: '',
    if: '',
    as: '',
    ...overrides,
  }
}

export function newStatsPipe(overrides = {}) {
  return {
    id: newId(),
    kind: 'stats',
    groupBy: [],
    functions: [newStatsFunction()],
    ...overrides,
  }
}

export function newMathPipe(overrides = {}) {
  return { id: newId(), kind: 'math', expression: '', as: '', ...overrides }
}

export function newSortPipe(overrides = {}) {
  return { id: newId(), kind: 'sort', field: '', dir: 'desc', ...overrides }
}

export function newLimitPipe(overrides = {}) {
  return { id: newId(), kind: 'limit', n: 100, ...overrides }
}

// ---------- Serialization ----------
// Rules confirmed against the playground:
//   • group-by field names always double-quoted
//   • stats `as` names always double-quoted
//   • quantile keeps trailing comma when field arg is empty: quantile(0.9, )
//   • functions in a stats pipe are comma-joined with ", "
//   • math `as` names emitted unquoted (per docs) when a valid identifier
//   • sort field always double-quoted; direction omitted when asc (default)

const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/

function quoteName(name) {
  return IDENT_RE.test(name) ? name : `"${name.replace(/"/g, '\\"')}"`
}

function serializeStatsFn(f) {
  const args = []
  if (f.fn === 'quantile') args.push(String(f.p ?? 0.9))
  args.push(f.field || '')
  let s = `${f.fn}(${args.join(', ')})`
  if (f.if && f.if.trim()) s += ` if (${f.if.trim()})`
  if (f.as && f.as.trim()) s += ` as "${f.as.trim()}"`
  return s
}

function serializeStats(pipe) {
  // Skip entirely if there are no functions — an orphan `stats by (…)` with
  // no aggregations is invalid CubeAPM syntax and would fail on run.
  const fns = (pipe.functions || []).map(serializeStatsFn).join(', ')
  if (!fns) return ''
  let head = 'stats'
  if (pipe.groupBy && pipe.groupBy.length > 0) {
    head += ` by (${pipe.groupBy.map(f => `"${f}"`).join(', ')})`
  }
  return `${head} ${fns}`
}

function serializeMath(pipe) {
  const expr = (pipe.expression || '').trim()
  const as = (pipe.as || '').trim()
  if (!expr) return 'math'
  return as ? `math ${expr} as ${quoteName(as)}` : `math ${expr}`
}

function serializeSort(pipe) {
  const f = (pipe.field || '').trim()
  if (!f) return 'sort'
  const dir = pipe.dir === 'asc' ? '' : ' desc'
  return `sort ("${f}")${dir}`
}

function serializeLimit(pipe) {
  const n = Number.isFinite(pipe.n) ? Math.max(1, Math.floor(pipe.n)) : 100
  return `limit ${n}`
}

export function serializePipe(pipe) {
  switch (pipe?.kind) {
    case 'stats': return serializeStats(pipe)
    case 'math':  return serializeMath(pipe)
    case 'sort':  return serializeSort(pipe)
    case 'limit': return serializeLimit(pipe)
    // A stage with no builder control, carried verbatim so a pasted query
    // keeps its meaning even though nothing renders a pill for it.
    case 'raw':   return (pipe.text || '').trim()
    default:      return ''
  }
}

// Pipe section of a full query. No leading separator; caller composes with
// the conditions string via composeQuery.
export function serializePipes(pipes) {
  return (pipes || []).map(serializePipe).filter(Boolean).join(' | ')
}

// Composes conditions + pipes into a full CubeAPM query. When conditions are
// empty and pipes exist, the leading `*` (match-all) is inserted so the pipe
// section has an input to operate on — matching the playground's behavior.
export function composeQuery(conditionsStr, pipes) {
  const cond = (conditionsStr || '').trim()
  const pstr = serializePipes(pipes)
  if (!pstr) return cond
  const head = cond || '*'
  return `${head} | ${pstr}`
}

// ---------- Validation ----------
// Returns [{ path, msg }]. Empty array = valid. Pass numericFields to enable
// numeric-field checks for avg/sum/etc.

export function validatePipe(pipe, opts = {}) {
  const numericFields = opts.numericFields || new Set()
  const errors = []
  if (pipe.kind === 'stats') {
    if (!pipe.functions || pipe.functions.length === 0) {
      errors.push({ path: 'functions', msg: 'Add at least one aggregation.' })
    }
    ;(pipe.functions || []).forEach((f, i) => {
      const meta = STAT_FN_BY_NAME[f.fn]
      if (!meta) {
        errors.push({ path: `functions[${i}].fn`, msg: `Unknown function "${f.fn}".` })
        return
      }
      if (meta.needsField && !f.field) {
        errors.push({ path: `functions[${i}].field`, msg: `${f.fn} needs a field.` })
      }
      if (meta.needsNumeric && f.field && !numericFields.has(f.field)) {
        errors.push({ path: `functions[${i}].field`, msg: `${f.fn} needs a numeric field.` })
      }
      if (f.fn === 'quantile') {
        const n = Number(f.p)
        if (!(n >= 0 && n <= 1)) {
          errors.push({ path: `functions[${i}].p`, msg: 'Percentile must be between 0 and 1.' })
        }
      }
      if (f.as && !IDENT_RE.test(f.as)) {
        errors.push({ path: `functions[${i}].as`, msg: 'Name must start with a letter or underscore.' })
      }
    })
    const seen = new Set()
    ;(pipe.functions || []).forEach((f, i) => {
      if (f.as && seen.has(f.as)) {
        errors.push({ path: `functions[${i}].as`, msg: `Duplicate name "${f.as}".` })
      }
      if (f.as) seen.add(f.as)
    })
  } else if (pipe.kind === 'math') {
    if (!pipe.expression?.trim()) {
      errors.push({ path: 'expression', msg: 'Expression is required.' })
    }
    if (pipe.as && !IDENT_RE.test(pipe.as)) {
      errors.push({ path: 'as', msg: 'Name must start with a letter or underscore.' })
    }
    let depth = 0
    for (const ch of pipe.expression || '') {
      if (ch === '(') depth++
      else if (ch === ')') depth--
      if (depth < 0) break
    }
    if (depth !== 0) {
      errors.push({ path: 'expression', msg: 'Unbalanced parentheses.' })
    }
  } else if (pipe.kind === 'sort') {
    if (!pipe.field) errors.push({ path: 'field', msg: 'Choose a field to sort by.' })
  } else if (pipe.kind === 'limit') {
    const n = Number(pipe.n)
    if (!(Number.isFinite(n) && n > 0)) {
      errors.push({ path: 'n', msg: 'Limit must be a positive number.' })
    }
  }
  return errors
}

export function validatePipes(pipes, opts) {
  return (pipes || []).map(p => ({ id: p.id, errors: validatePipe(p, opts) }))
}

// ---------- Scope helpers ----------
// Names in scope for a math expression, produced by any preceding stats pipe.
// Used by the UI's "Available names" helper and by the (soft) reference check.
export function namesInScopeBefore(pipes, index) {
  const names = []
  for (let i = 0; i < index; i++) {
    const p = pipes[i]
    if (p.kind === 'stats') {
      for (const f of p.functions || []) {
        if (f.as) names.push(f.as)
      }
    } else if (p.kind === 'math' && p.as) {
      names.push(p.as)
    }
  }
  return names
}


// ---------- Parsing ----------
// The inverse of the serializers above. What keeps the two honest is the
// round-trip property, asserted in the tests: for every pipe the builder can
// produce, serializePipe(parsePipeStage(serializePipe(p))) === serializePipe(p).
//
// Stages CubeAPM accepts but the builder has no control for parse to
// `{ kind: 'raw' }` and serialize straight back out.

export class PipeError extends Error {
  constructor(msg) { super(msg); this.name = 'PipeError' }
}

class PipeCursor {
  constructor(s) { this.s = s; this.i = 0 }
  get eof() { return this.i >= this.s.length }
  peek(n = 0) { return this.s[this.i + n] }
  ws() { while (!this.eof && /\s/.test(this.s[this.i])) this.i++ }
  // A keyword only counts when what follows can't be part of a longer name,
  // so `as` in `ascending` is never mistaken for the alias keyword.
  startsWithWord(w) {
    if (this.s.slice(this.i, this.i + w.length).toLowerCase() !== w.toLowerCase()) return false
    const after = this.s[this.i + w.length]
    return after === undefined || /[\s(]/.test(after)
  }
  eatWord(w) { if (!this.startsWithWord(w)) return false; this.i += w.length; return true }
}

// Splits on `sep` at paren depth 0 and outside quotes, so the commas inside
// `quantile(0.9, duration_ms)` and `if (a AND b)` don't split the list.
function splitTopLevel(s, sep) {
  const out = []
  let depth = 0, inStr = false, esc = false, cur = ''
  for (const c of s) {
    if (inStr) {
      cur += c
      if (esc) { esc = false; continue }
      if (c === '\\') { esc = true; continue }
      if (c === '"') inStr = false
      continue
    }
    if (c === '"') { inStr = true; cur += c; continue }
    if (c === '(') depth++
    else if (c === ')') depth--
    if (c === sep && depth === 0) { out.push(cur); cur = ''; continue }
    cur += c
  }
  out.push(cur)
  return out
}

// Index of the last `word` sitting at paren depth 0 and outside quotes.
function lastTopLevelWord(s, word) {
  let depth = 0, inStr = false, esc = false, found = -1
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inStr) {
      if (esc) { esc = false; continue }
      if (c === '\\') { esc = true; continue }
      if (c === '"') inStr = false
      continue
    }
    if (c === '"') { inStr = true; continue }
    if (c === '(') { depth++; continue }
    if (c === ')') { depth--; continue }
    if (depth !== 0) continue
    if (s.slice(i, i + word.length).toLowerCase() !== word) continue
    const before = s[i - 1], after = s[i + word.length]
    if (before !== undefined && !/\s/.test(before)) continue
    if (after !== undefined && !/\s/.test(after)) continue
    found = i
  }
  return found
}

function stripQuotes(raw) {
  const t = (raw ?? '').trim()
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1).replace(/\\"/g, '"')
  }
  return t
}

// Returns the text inside a balanced paren group and leaves the cursor past it.
function readParenGroup(cur) {
  if (cur.peek() !== '(') throw new PipeError('Expected "(" in pipe.')
  const start = cur.i
  let depth = 0, inStr = false, esc = false
  for (; !cur.eof; cur.i++) {
    const c = cur.peek()
    if (inStr) {
      if (esc) { esc = false; continue }
      if (c === '\\') { esc = true; continue }
      if (c === '"') inStr = false
      continue
    }
    if (c === '"') { inStr = true; continue }
    if (c === '(') depth++
    else if (c === ')') {
      depth--
      if (depth === 0) { const inner = cur.s.slice(start + 1, cur.i); cur.i++; return inner }
    }
  }
  throw new PipeError('Unclosed "(" in pipe.')
}

function readName(cur) {
  cur.ws()
  if (cur.peek() === '"') {
    const start = cur.i
    let esc = false
    cur.i++
    for (; !cur.eof; cur.i++) {
      const c = cur.peek()
      if (esc) { esc = false; continue }
      if (c === '\\') { esc = true; continue }
      if (c === '"') { const raw = cur.s.slice(start, cur.i + 1); cur.i++; return stripQuotes(raw) }
    }
    throw new PipeError('Unclosed quoted name in pipe.')
  }
  const m = /^[a-zA-Z_][a-zA-Z0-9_.]*/.exec(cur.s.slice(cur.i))
  if (!m) return ''
  cur.i += m[0].length
  return m[0]
}

function parseStatsFn(cur) {
  cur.ws()
  const name = readName(cur)
  if (!name) throw new PipeError('Expected an aggregation, e.g. count().')
  const meta = STAT_FN_BY_NAME[name]
  if (!meta) throw new PipeError(`Unknown aggregation "${name}".`)
  cur.ws()
  if (cur.peek() !== '(') throw new PipeError(`Expected "(" after "${name}".`)
  const args = splitTopLevel(readParenGroup(cur), ',').map(a => a.trim())

  const out = { fn: name }
  if (name === 'quantile') {
    // serializeStatsFn emits `quantile(p, field)`, keeping the trailing comma
    // while the field is still blank.
    const p = Number(args[0])
    if (!Number.isFinite(p)) throw new PipeError('quantile needs a numeric p, e.g. quantile(0.9, duration_ms).')
    out.p = p
    out.field = stripQuotes(args[1] ?? '')
  } else {
    out.field = stripQuotes(args[0] ?? '')
  }

  cur.ws()
  if (cur.eatWord('if')) { cur.ws(); out.if = readParenGroup(cur).trim() }
  cur.ws()
  if (cur.eatWord('as')) {
    out.as = readName(cur)
    if (!out.as) throw new PipeError('Expected a name after "as".')
  }
  return newStatsFunction(out)
}

function parseStatsStage(cur) {
  const groupBy = []
  cur.ws()
  if (cur.eatWord('by')) {
    cur.ws()
    for (const f of splitTopLevel(readParenGroup(cur), ',')) {
      const name = stripQuotes(f)
      if (name) groupBy.push(name)
    }
  }
  const functions = []
  for (;;) {
    cur.ws()
    if (cur.eof) break
    functions.push(parseStatsFn(cur))
    cur.ws()
    if (cur.peek() === ',') { cur.i++; continue }
    break
  }
  if (!functions.length) throw new PipeError('stats needs at least one aggregation, e.g. stats count().')
  cur.ws()
  if (!cur.eof) throw new PipeError(`Unexpected "${cur.s.slice(cur.i).trim()}" after the stats functions.`)
  return newStatsPipe({ groupBy, functions })
}

function parseMathStage(cur) {
  const rest = cur.s.slice(cur.i).trim()
  if (!rest) return newMathPipe()
  const at = lastTopLevelWord(rest, 'as')
  if (at === -1) return newMathPipe({ expression: rest })
  const as = stripQuotes(rest.slice(at + 2))
  if (!as) throw new PipeError('Expected a name after "as".')
  return newMathPipe({ expression: rest.slice(0, at).trim(), as })
}

function parseSortStage(cur) {
  cur.ws()
  if (cur.eof) return newSortPipe()
  const field = cur.peek() === '('
    ? stripQuotes(splitTopLevel(readParenGroup(cur), ',')[0] ?? '')
    : readName(cur)
  cur.ws()
  // serializeSort omits the direction for asc, so a bare field means ascending.
  const dir = cur.eatWord('desc') ? 'desc' : (cur.eatWord('asc'), 'asc')
  cur.ws()
  if (!cur.eof) throw new PipeError(`Unexpected "${cur.s.slice(cur.i).trim()}" after the sort field.`)
  return newSortPipe({ field, dir })
}

function parseLimitStage(cur) {
  cur.ws()
  const m = /^\d+(?:\.\d+)?/.exec(cur.s.slice(cur.i))
  if (!m) throw new PipeError('limit needs a number, e.g. limit 100.')
  cur.i += m[0].length
  cur.ws()
  if (!cur.eof) throw new PipeError(`Unexpected "${cur.s.slice(cur.i).trim()}" after the limit.`)
  return newLimitPipe({ n: Math.max(1, Math.floor(Number(m[0]))) })
}

// Parses one `|`-separated stage. Throws PipeError on anything malformed.
export function parsePipeStage(text) {
  const s = (text ?? '').trim()
  if (!s) return null
  const cur = new PipeCursor(s)
  if (cur.eatWord('stats')) return parseStatsStage(cur)
  if (cur.eatWord('math'))  return parseMathStage(cur)
  if (cur.eatWord('sort'))  return parseSortStage(cur)
  if (cur.eatWord('limit')) return parseLimitStage(cur)

  const name = (s.split(/[\s(]/)[0] || '').toLowerCase()
  if (!PIPE_NAMES.includes(name)) {
    throw new PipeError(`Unknown pipe "${name}". Expected one of: ${PIPE_NAMES.join(', ')}.`)
  }
  return { id: newId(), kind: 'raw', text: s }
}

// Parses every stage of a pipe section.
//
// `fatal` marks a query the builder cannot represent at all, as opposed to one
// that merely failed to parse: repeating a stage the UI shows only once would
// mean silently dropping a stage that changes the result.
export function parsePipes(stages) {
  const pipes = []
  try {
    for (const s of stages ?? []) {
      const p = parsePipeStage(s)
      if (p) pipes.push(p)
    }
  } catch (e) {
    if (e instanceof PipeError) return { ok: false, pipes: [], error: e.message }
    throw e
  }

  for (const kind of ['stats', 'sort', 'limit']) {
    if (pipes.filter(p => p.kind === kind).length > 1) {
      return {
        ok: false,
        fatal: true,
        pipes: [],
        error: `This query has more than one "${kind}" stage — the builder can only show one.`,
      }
    }
  }

  const unsupported = pipes
    .filter(p => p.kind === 'raw')
    .map(p => (p.text.split(/[\s(]/)[0] || '').toLowerCase())
  return { ok: true, pipes, unsupported }
}

// Grouping on its own is a complete question — "how many logs per service?" —
// so an implied count() stands in until the user names a real aggregation.
// Without it the aggregator has nothing to compute and returns empty, which
// reads as "your grouping did nothing".
//
// Dirty-checking runs both sides through this too: serializeStats drops a stats
// pipe that has no functions, so a group-by on its own would otherwise look
// byte-identical to no pipes at all and never light up the Run button.
export function withImpliedCount(pipes) {
  const stats = (pipes ?? []).find(p => p.kind === 'stats')
  if (!stats || stats.functions?.length || !stats.groupBy?.length) return pipes
  return pipes.map(p => (
    p.id === stats.id ? { ...p, functions: [{ ...newStatsFunction(), fn: 'count' }] } : p
  ))
}
