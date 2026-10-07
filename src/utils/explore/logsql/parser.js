// LogsQL parser: text → `{ filter, stream, pipes }`.
//
// The grammar is VictoriaLogs', narrowed to what Explore can actually run: the
// filter language in full shape (stream selectors, field filters, filter
// functions, boolean algebra) plus structured parsing of the pipes we evaluate
// (`stats`, `math`, `filter`, and the field-shaping pipes). Every other pipe is
// recognised by name and kept as raw text — that is enough for the server rules
// in api.js, which only need each pipe's name and its printed form.
//
// Two things here are not "nice parser design" but deliberate fidelity:
//
//  1. Errors carry the server's wording, because the page shows them verbatim
//     ("Failed to fetch data: …"). The shape is
//     `cannot parse \`query\` arg: <detail>; context: [<query up to the bad
//     token>]; query=<whole query>`, and `detail` is built by nesting prefixes
//     the way VictoriaLogs nests its own parsers ("cannot parse \"stats\"
//     pipe: cannot parse 'by' clause: cannot parse field name: …").
//
//  2. A stats pipe also carries `text`, its NORMALIZED printing
//     (`stats count(*) as "count(*)"`), because that is what the server quotes
//     back in the "cannot be put in front of" rule errors — not the source.
//
// The token model comes from lexer.js: a token is a word, a quoted string or a
// single punctuation character, and each one knows whether whitespace preceded
// it. Multi-character values (`log.level`, `cubedemo-web`, `0.9`, `100ms`) are
// reassembled here as "compound tokens", exactly as the server describes them
// in its errors.

import {
  scanLogsql,
  LOGSQL_PIPE_NAMES,
  LOGSQL_STATS_FUNC_NAMES,
  LOGSQL_FILTER_FUNC_NAMES,
  LOGSQL_MATH_FUNC_NAMES,
} from './lexer.js'

/** The field a filter with no field name searches — LogsQL's default field. */
export const DEFAULT_FIELD = '_msg'

export class LogsqlError extends Error {
  constructor(detail, pos, query) {
    const q = String(query ?? '')
    super(`cannot parse \`query\` arg: ${detail}; context: [${q.slice(0, pos)}]; query=${q}`)
    this.name = 'LogsqlError'
    this.detail = detail
    this.pos = pos
  }
}

const PIPES = new Set(LOGSQL_PIPE_NAMES)
const STATS_FUNCS = new Set(LOGSQL_STATS_FUNC_NAMES)
const FILTER_FUNCS = new Set(LOGSQL_FILTER_FUNC_NAMES)
const MATH_FUNCS = new Set(LOGSQL_MATH_FUNC_NAMES)

// Characters that glue onto a bare word with nothing between them, so
// `cubedemo-web`, `/v1/orders` and `0.9` read as one value. The operator
// characters are deliberately absent — they end a compound token.
const GLUE = new Set(['.', '-', '/', '@', '$', '+', '%', '&', '?', ';', '\\', '^', '*'])
// Inside a `math` expression only a dot joins: `a-b` there is a subtraction.
const MATH_GLUE = new Set(['.'])

const STREAM_OPS = new Set(['=', '!=', '=~', '!~'])

// Pipes we parse into something the evaluator can run. Everything else is kept
// as raw text (the server rules in api.js work off the name alone).
const FIELD_LIST_PIPES = new Set(['fields', 'keep', 'drop', 'del', 'delete', 'rm'])
const RENAME_PIPES = new Set(['rename', 'mv', 'copy', 'cp'])
const FILTER_PIPES = new Set(['filter', 'where'])

const PLAIN_NAME = /^[A-Za-z_][A-Za-z0-9_.]*$/
// Words that would be read back as syntax, so the server quotes them even
// though they look like plain identifiers (`count(*) as "by"`).
const RESERVED_NAMES = new Set(['by', 'as', 'if', 'and', 'or', 'not', 'in', 'limit', 'offset', 'desc', 'asc', 'with'])

/** A field or result name as the server prints it: bare when it can be, quoted when it must be. */
export function printName(name) {
  const s = String(name ?? '')
  return PLAIN_NAME.test(s) && !RESERVED_NAMES.has(s.toLowerCase()) ? s : JSON.stringify(s)
}

const NUMBER_TEXT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/

class Parser {
  constructor(text) {
    this.s = String(text ?? '')
    // Whitespace and comments are dropped, but the `sp` flag they leave on the
    // next token is what tells glued syntax (`f:=v`) from separate tokens.
    this.t = scanLogsql(this.s).filter(t => t.k !== 'ws' && t.k !== 'comment')
    this.i = 0
    this.stop = this.t.length
  }

  // ---------- cursor ----------

  peek(n = 0) {
    const j = this.i + n
    return j < this.stop ? this.t[j] : null
  }

  next() { return this.t[this.i++] }

  atPunct(ch, n = 0) {
    const t = this.peek(n)
    return !!t && t.k === 'punct' && t.text === ch
  }

  atWord(w, n = 0) {
    const t = this.peek(n)
    return !!t && t.k === 'word' && t.text.toLowerCase() === w
  }

  /** `and` / `or` / `not` as syntax rather than as the start of a field name. */
  keywordAt(w) {
    const t = this.peek()
    if (!t || t.k !== 'word' || t.text.toLowerCase() !== w) return false
    const nx = this.peek(1)
    if (!nx || nx.sp || nx.k !== 'punct') return true
    if (nx.text === ':' || GLUE.has(nx.text)) return false
    // `not(a)` negates; `in(…)` is a filter function, so only `not` may be glued to `(`.
    return !(nx.text === '(' && w !== 'not')
  }

  // ---------- errors ----------

  fail(detail, pos) {
    throw new LogsqlError(detail, pos ?? (this.peek() ? this.peek().end : this.s.length), this.s)
  }

  /** Re-throws with one more layer of the server's nested wording. */
  wrap(prefix, fn) {
    try {
      return fn()
    } catch (err) {
      if (err instanceof LogsqlError) throw new LogsqlError(`${prefix}${err.detail}`, err.pos, this.s)
      throw err
    }
  }

  compoundFail() {
    const t = this.peek()
    this.fail(
      `compound token cannot start with ${JSON.stringify(t ? t.text : '')}; put it into quotes if needed`,
      t ? t.end : this.s.length,
    )
  }

  expectPunct(ch) {
    const t = this.peek()
    if (!t || t.k !== 'punct' || t.text !== ch) {
      this.fail(`unexpected token ${JSON.stringify(t ? t.text : '')}; want ${JSON.stringify(ch)}`, t ? t.end : this.s.length)
    }
    return this.next()
  }

  // ---------- compound tokens ----------

  /**
   * One value: a quoted string, or a run of glued words and punctuation.
   * `value` is decoded (escapes resolved), `text` is the source slice — the
   * normalized stats printing needs the source, matching needs the value.
   */
  readCompound(glue = GLUE) {
    const first = this.peek()
    if (!first) this.compoundFail()
    if (first.k === 'badstr') this.fail('missing closing quote', first.end)
    if (first.k === 'punct' && !glue.has(first.text)) this.compoundFail()
    let value = ''
    let quoted = false
    let j = this.i
    for (; j < this.stop; j++) {
      const tok = this.t[j]
      if (j > this.i && (tok.sp || tok.k === 'badstr' || (tok.k === 'punct' && !glue.has(tok.text)))) break
      if (tok.k === 'str') { value += tok.value; quoted = true } else value += tok.text
    }
    const start = first.start
    const end = this.t[j - 1].end
    this.i = j
    return { value, quoted, text: this.s.slice(start, end), start, end }
  }

  readFieldName() {
    return this.wrap('cannot parse field name: ', () => this.readCompound())
  }

  // ---------- filters ----------

  parseFilter(field) {
    const items = [this.parseAnd(field)]
    while (this.keywordAt('or')) {
      this.next()
      items.push(this.parseAnd(field))
    }
    return items.length === 1 ? items[0] : { type: 'or', items }
  }

  parseAnd(field) {
    const items = [this.parseNot(field)]
    for (;;) {
      if (this.keywordAt('and')) { this.next(); items.push(this.parseNot(field)); continue }
      if (this.keywordAt('or')) break
      if (!this.startsTerm()) break
      // Juxtaposition is AND: `{"service"="order"} NOT log.level:="info"`.
      items.push(this.parseNot(field))
    }
    return items.length === 1 ? items[0] : { type: 'and', items }
  }

  startsTerm() {
    const t = this.peek()
    if (!t) return false
    return !(t.k === 'punct' && (t.text === ')' || t.text === '}' || t.text === ']' || t.text === ',' || t.text === '|'))
  }

  parseNot(field) {
    if (this.keywordAt('not') || this.atPunct('!')) {
      this.next()
      return { type: 'not', item: this.parseNot(field) }
    }
    // A dash glued to what follows negates (`-error`); standing alone it is a value.
    if (this.atPunct('-') && this.peek(1) && !this.peek(1).sp) {
      this.next()
      return { type: 'not', item: this.parseNot(field) }
    }
    return this.parsePrimary(field)
  }

  parsePrimary(field) {
    const t = this.peek()
    if (!t) this.compoundFail()
    if (t.k === 'punct') {
      if (t.text === '(') {
        this.next()
        const inner = this.parseFilter(field)
        this.expectPunct(')')
        return inner
      }
      if (t.text === '{') return this.parseStreamSelector()
      if (t.text === '*' && this.standalone(1)) { this.next(); return { type: 'all' } }
    }
    const name = this.readCompound()
    const colon = this.peek()
    if (colon && !colon.sp && colon.k === 'punct' && colon.text === ':') {
      this.next()
      return this.parseFieldOperand(name.value)
    }
    return termFromToken(field, name)
  }

  /** True when the token at `n` does not glue onto the one before it. */
  standalone(n) {
    const nx = this.peek(n)
    return !nx || nx.sp || (nx.k === 'punct' && !GLUE.has(nx.text))
  }

  parseFieldOperand(field) {
    // The server injects the time filter itself, so a `_time:` filter in the
    // query is accepted and ignored rather than fighting with it.
    if (field === '_time') { this.skipOperand(); return { type: 'time' } }
    const t = this.peek()
    if (!t) this.compoundFail()
    if (t.k === 'punct' && !t.sp) {
      if (t.text === '=') { this.next(); return { type: 'term', field, op: 'exact', value: this.readCompound().value } }
      if (t.text === '~') { this.next(); return { type: 'term', field, op: 'regex', value: this.readCompound().value } }
      if (t.text === '>' || t.text === '<') {
        this.next()
        let op = t.text === '>' ? 'gt' : 'lt'
        if (this.atPunct('=') && !this.peek().sp) { this.next(); op += 'e' }
        return { type: 'term', field, op, value: this.readCompound().value }
      }
      if (t.text === '(') {
        // `level:(error or warn)` — a sub-filter scoped to this field.
        this.next()
        const inner = this.parseFilter(field)
        this.expectPunct(')')
        return inner
      }
      if (t.text === '*' && this.standalone(1)) { this.next(); return { type: 'term', field, op: 'exists' } }
    }
    if (t.k === 'word') {
      const fn = t.text.toLowerCase()
      const open = this.peek(1)
      if (FILTER_FUNCS.has(fn) && open && !open.sp && open.k === 'punct' && open.text === '(') {
        this.next()
        this.next()
        const args = this.readArgList()
        this.expectPunct(')')
        return filterFunctionTerm(field, fn, args)
      }
    }
    return termFromToken(field, this.readCompound())
  }

  /** Consumes whatever follows `_time:` — a value, a bracketed range or a group. */
  skipOperand() {
    const t = this.peek()
    if (!t) return
    if (t.k === 'punct' && (t.text === '[' || t.text === '(')) {
      const close = t.text === '[' ? ']' : ')'
      let depth = 0
      while (this.peek()) {
        // A range whose brackets do not match (`_time:[a,b)` — which our own
        // Logs page can produce, and which builders.js carries over verbatim)
        // would otherwise swallow the rest of the query, pipes and all, and the
        // query would be reported as missing the `| stats` pipe it plainly has.
        if (depth > 0 && this.atPunct('|')) break
        const tok = this.next()
        if (tok.k === 'punct' && tok.text === t.text) depth++
        else if (tok.k === 'punct' && tok.text === close && --depth === 0) break
      }
      return
    }
    if (t.k === 'punct' && !GLUE.has(t.text)) { this.next(); if (this.peek() && !this.peek().sp) this.readCompound(); return }
    this.readCompound()
  }

  parseStreamSelector() {
    this.next()
    const matchers = []
    while (!this.atPunct('}')) {
      if (!this.peek()) this.fail('missing closing `}` for the stream filter', this.s.length)
      const label = this.readFieldName()
      const op = this.readStreamOp()
      const value = this.readCompound()
      matchers.push({ label: label.value, op, value: value.value })
      if (this.atPunct(',')) { this.next(); continue }
      break
    }
    this.expectPunct('}')
    return { type: 'stream', matchers }
  }

  readStreamOp() {
    const t = this.peek()
    if (t && t.k === 'punct' && (t.text === '=' || t.text === '!')) {
      this.next()
      let op = t.text
      const n = this.peek()
      if (n && !n.sp && n.k === 'punct' && (n.text === '=' || n.text === '~')) { this.next(); op += n.text }
      if (STREAM_OPS.has(op)) return op
      this.fail(`unexpected token ${JSON.stringify(op)}; want '=', '!=', '=~' or '!~'`, this.t[this.i - 1].end)
    }
    this.fail(
      `unexpected token ${JSON.stringify(t ? t.text : '')}; want '=', '!=', '=~' or '!~'`,
      t ? t.end : this.s.length,
    )
  }

  /** Comma-separated operands up to `)`. An omitted one is an empty argument — `quantile(0.9, )` is legal. */
  readArgList() {
    const args = []
    if (this.atPunct(')')) return args
    for (;;) {
      if (this.atPunct(',') || this.atPunct(')') || !this.peek()) args.push({ value: '', quoted: false, text: '' })
      else args.push(this.readCompound())
      if (this.atPunct(',')) { this.next(); continue }
      break
    }
    return args
  }

  // ---------- pipes ----------

  parsePipes() {
    const pipes = []
    while (this.atPunct('|')) {
      this.next()
      pipes.push(this.parsePipe())
    }
    return pipes
  }

  parsePipe() {
    const nameTok = this.peek()
    if (!nameTok) this.fail('missing pipe name', this.s.length)
    const name = nameTok.k === 'word' ? nameTok.text.toLowerCase() : ''
    if (!PIPES.has(name)) this.fail(`unexpected pipe ${JSON.stringify(nameTok.text)}`, nameTok.end)
    this.next()
    const bodyStop = this.findPipeEnd()
    const raw = this.s.slice(nameTok.start, this.t[bodyStop - 1].end)
    const outer = this.stop
    this.stop = bodyStop
    const pipe = this.wrap(`cannot parse ${JSON.stringify(name)} pipe: `, () => this.parsePipeBody(name))
    this.i = bodyStop
    this.stop = outer
    return { type: name, name, raw, text: pipe.text ?? raw, start: nameTok.start, end: this.t[bodyStop - 1].end, ...pipe }
  }

  /** Index of the next `|` outside any bracket — where this pipe's body ends. */
  findPipeEnd() {
    let depth = 0
    for (let j = this.i; j < this.stop; j++) {
      const tok = this.t[j]
      if (tok.k !== 'punct') continue
      if (tok.text === '(' || tok.text === '[' || tok.text === '{') depth++
      else if (tok.text === ')' || tok.text === ']' || tok.text === '}') depth = Math.max(0, depth - 1)
      else if (tok.text === '|' && depth === 0) return j
    }
    return this.stop
  }

  parsePipeBody(name) {
    if (name === 'stats' || name === 'stats_remote' || name === 'total_stats' || name === 'running_stats') {
      return this.parseStatsBody()
    }
    if (name === 'math' || name === 'eval') return { entries: this.parseMathBody() }
    if (FILTER_PIPES.has(name)) return { filter: this.parseFilter(DEFAULT_FIELD) }
    if (FIELD_LIST_PIPES.has(name)) return { fields: this.readNameList() }
    if (RENAME_PIPES.has(name)) return { pairs: this.readRenamePairs() }
    // Recognised but not evaluated: its name is all the server rules need.
    this.i = this.stop
    return {}
  }

  parseStatsBody() {
    const by = []
    const byTexts = []
    if (this.atWord('by')) {
      this.next()
      this.wrap("cannot parse 'by' clause: ", () => {
        this.expectPunct('(')
        if (!this.atPunct(')')) {
          for (;;) {
            const f = this.readFieldName()
            by.push(f.value)
            byTexts.push(printName(f.value))
            if (this.atPunct(',')) { this.next(); continue }
            break
          }
        }
        this.expectPunct(')')
      })
    }
    const entries = []
    for (;;) {
      entries.push(this.wrap("cannot parse 'stats' entry: ", () => this.parseStatsEntry()))
      if (this.atPunct(',')) { this.next(); continue }
      break
    }
    // `| stats … limit N` caps the number of groups; we parse it and move on.
    let limit = 0
    if (this.atWord('limit') && this.peek(1)) {
      this.next()
      limit = Number(this.readCompound().value) || 0
    }
    if (this.i < this.stop) {
      const tok = this.peek()
      this.fail(
        `unexpected token ${JSON.stringify(tok.text)} after [${entries.map(e => e.text).join(', ')}]; want ',', '|' or ')'`,
        tok.end,
      )
    }
    const text = `stats${byTexts.length ? ` by (${byTexts.join(', ')})` : ''} ${entries.map(e => e.text).join(', ')}`
    return { by, entries, limit, text }
  }

  parseStatsEntry() {
    const t = this.peek()
    if (!t || t.k !== 'word') this.compoundFail()
    const fn = t.text.toLowerCase()
    if (!STATS_FUNCS.has(fn)) this.fail(`unknown stats func ${JSON.stringify(t.text)}`, t.end)
    this.next()
    if (!this.atPunct('(')) this.fail(`missing '(' after ${JSON.stringify(fn)}`, this.peek() ? this.peek().end : this.s.length)
    this.next()
    const args = this.readArgList()
    this.expectPunct(')')

    let filter = null
    let filterText = ''
    if (this.atWord('if')) {
      this.next()
      const open = this.expectPunct('(')
      filter = this.parseFilter(DEFAULT_FIELD)
      const close = this.peek()
      this.expectPunct(')')
      filterText = this.s.slice(open.end, close ? close.start : this.s.length).trim()
    }

    let alias = ''
    if (this.atWord('as')) {
      this.next()
      alias = this.readCompound().value
    } else if (this.i < this.stop && !this.atPunct(',') && !this.isStatsLimit()) {
      const nx = this.peek()
      // A bare word after the call is the alias: `count() by` names the series "by".
      if (nx.k === 'word' || nx.k === 'str') alias = this.readCompound().value
    }

    // `count()` prints as `count(*)`; every other function keeps its arguments.
    const argText = args.map(a => a.text).join(', ')
    const call = `${fn}(${argText || (fn === 'count' ? '*' : '')})${filterText ? ` if (${filterText})` : ''}`
    const name = alias || call
    return { fn, args, filter, filterText, alias, name, call, text: `${call} as ${printName(name)}` }
  }

  isStatsLimit() {
    return this.atWord('limit') && !!this.peek(1) && this.peek(1).k === 'word' && /^\d+$/.test(this.peek(1).text)
  }

  // ---------- math ----------

  parseMathBody() {
    const entries = []
    for (;;) {
      const first = this.peek()
      if (!first) this.compoundFail()
      const expr = this.mathAdd()
      let name = this.s.slice(first.start, this.t[this.i - 1].end).trim()
      if (this.atWord('as')) {
        this.next()
        name = this.readCompound(MATH_GLUE).value
      } else if (this.i < this.stop && !this.atPunct(',')) {
        const nx = this.peek()
        if (nx.k === 'word' || nx.k === 'str') name = this.readCompound(MATH_GLUE).value
      }
      entries.push({ expr, name })
      if (this.atPunct(',')) { this.next(); continue }
      break
    }
    if (this.i < this.stop) {
      const tok = this.peek()
      this.fail(`unexpected token ${JSON.stringify(tok.text)}`, tok.end)
    }
    return entries
  }

  mathAdd() {
    let left = this.mathMul()
    while (this.atPunct('+') || this.atPunct('-')) {
      const op = this.next().text
      left = { type: 'bin', op, left, right: this.mathMul() }
    }
    return left
  }

  mathMul() {
    let left = this.mathPow()
    while (this.atPunct('*') || this.atPunct('/') || this.atPunct('%')) {
      const op = this.next().text
      left = { type: 'bin', op, left, right: this.mathPow() }
    }
    return left
  }

  mathPow() {
    const left = this.mathUnary()
    if (this.atPunct('^')) {
      this.next()
      // Right-associative, as in every other expression language.
      return { type: 'bin', op: '^', left, right: this.mathPow() }
    }
    return left
  }

  mathUnary() {
    if (this.atPunct('-')) { this.next(); return { type: 'neg', expr: this.mathUnary() } }
    if (this.atPunct('+')) { this.next(); return this.mathUnary() }
    return this.mathPrimary()
  }

  mathPrimary() {
    const t = this.peek()
    if (!t) this.compoundFail()
    if (t.k === 'punct' && t.text === '(') {
      this.next()
      const expr = this.mathAdd()
      this.expectPunct(')')
      return expr
    }
    const open = this.peek(1)
    if (t.k === 'word' && MATH_FUNCS.has(t.text.toLowerCase()) && open && !open.sp && open.k === 'punct' && open.text === '(') {
      const fn = t.text.toLowerCase()
      this.next()
      this.next()
      const args = []
      if (!this.atPunct(')')) {
        for (;;) {
          args.push(this.mathAdd())
          if (this.atPunct(',')) { this.next(); continue }
          break
        }
      }
      this.expectPunct(')')
      return { type: 'call', fn, args }
    }
    const c = this.readCompound(MATH_GLUE)
    if (!c.quoted && NUMBER_TEXT.test(c.value)) return { type: 'num', value: Number(c.value) }
    return { type: 'ref', name: c.value }
  }

  // ---------- small lists ----------

  readNameList() {
    const names = []
    const paren = this.atPunct('(')
    if (paren) this.next()
    while (this.peek() && !this.atPunct(')')) {
      names.push(this.readFieldName().value)
      if (this.atPunct(',')) { this.next(); continue }
      break
    }
    if (paren) this.expectPunct(')')
    return names
  }

  readRenamePairs() {
    const pairs = []
    while (this.peek()) {
      const from = this.readFieldName().value
      if (this.atWord('as')) this.next()
      const to = this.peek() ? this.readFieldName().value : ''
      pairs.push({ from, to })
      if (this.atPunct(',')) { this.next(); continue }
      break
    }
    return pairs
  }

  // ---------- entry point ----------

  parseQuery() {
    const first = this.peek()
    if (!first) this.fail('missing query', this.s.length)
    // A query may not start with a pipe — the server says "missing query".
    if (first.k === 'punct' && first.text === '|') this.fail('missing query', first.end)
    const filter = this.parseFilter(DEFAULT_FIELD)
    const pipes = this.parsePipes()
    if (this.i < this.stop) {
      const tok = this.peek()
      this.fail(`unexpected token ${JSON.stringify(tok.text)}`, tok.end)
    }
    return {
      query: this.s,
      filter,
      stream: filter && filter.type === 'stream' ? filter : null,
      pipes,
    }
  }
}

// ---------- term helpers ----------

function termFromToken(field, tok) {
  if (tok.quoted) return { type: 'term', field, op: 'phrase', value: tok.value }
  if (tok.value.endsWith('*')) return { type: 'term', field, op: 'prefix', value: tok.value.slice(0, -1) }
  return { type: 'term', field, op: 'word', value: tok.value }
}

// Filter functions we evaluate. The rest parse and then match everything: the
// server accepts them, and silently dropping rows would be a worse lie than
// over-counting a filter nobody in this app emits.
const FILTER_FUNCTION_OPS = {
  in: 'in',
  exact: 'exact_list',
  i: 'icase',
  re: 'regex',
  contains_any: 'contains_any',
  contains_all: 'contains_all',
  range: 'range',
  len_range: 'len_range',
  string_range: 'string_range',
  seq: 'seq',
  value_type: 'value_type',
  eq_field: 'eq_field',
  le_field: 'le_field',
  lt_field: 'lt_field',
}

function filterFunctionTerm(field, fn, args) {
  const values = args.map(a => a.value)
  const op = FILTER_FUNCTION_OPS[fn]
  if (!op) return { type: 'term', field, op: 'any', fn, values }
  if (op === 'icase' || op === 'regex') return { type: 'term', field, op, value: values[0] ?? '' }
  if (op === 'eq_field' || op === 'le_field' || op === 'lt_field') return { type: 'term', field, op, value: values[0] ?? '' }
  if (op === 'exact_list') {
    return values.length > 1
      ? { type: 'term', field, op: 'in', values }
      : { type: 'term', field, op: 'exact', value: values[0] ?? '' }
  }
  return { type: 'term', field, op, values }
}

/**
 * Parses a LogsQL query.
 *
 * @param {string} text
 * @returns {{ query:string, filter:object, stream:object|null, pipes:Array<object> }}
 * @throws {LogsqlError} with the server's wording, ready to show verbatim
 */
export function parseLogsql(text) {
  const s = String(text ?? '')
  if (!s.trim()) throw new LogsqlError('missing query', s.length, s)
  return new Parser(s).parseQuery()
}
