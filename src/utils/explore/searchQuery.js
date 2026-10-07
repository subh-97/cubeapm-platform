// The Explore table's search box: the reference SearchQL, parsed and matched
// the way the reference does it, so a search that works there works here.
//
//   shipment                                 bare term: substring of the row
//   label:shipment and not label:client      one column, substring
//   label:a or label:b
//   (label:a label:b)                        implicit AND
//   label:="service=shipment-service"        exact (Labels = all)
//   label:=shipment-service                  exact (Labels = service)
//
// Precedence: or < and (explicit or by juxtaposition) < not < primary.
//
// Deliberately not ../tableQuery.js. That language is ours (AND binds the same
// way, but it has `field:*`, unions and error messages); this one is the
// reference's, including how it forgives: an input that does not parse has
// trailing tokens dropped one at a time until what is left does, so the table
// keeps filtering on the finished part of a query while the rest is typed.
//
// The only column is "Label", addressed as `label` (reference `xL` lower-cases
// and underscores a column title). A field is compared case-SENSITIVELY after
// that, so `Label:x` names no column and matches nothing — as in the reference.

// ---------- Lexer ----------

const KEYWORDS = { AND: 'and', and: 'and', OR: 'or', or: 'or', NOT: 'not', not: 'not' }
const STRING = /^(?:"(?:\\.|[^\n"\\])*"|'(?:\\.|[^\n'\\])*')/
const IDENT = /^[a-zA-Z_][a-zA-Z0-9_.]*(?=\s*:)/
const LITERAL = /^[^\s(),:=<>~"']+/

/**
 * Never throws: characters the reference lexer has no rule for (`,`, `<`, an
 * unclosed quote) become 'error' tokens, which the highlighter can mark. The
 * parser treats any of them as "no filter", as the reference does when its
 * lexer throws.
 *
 * @returns {Array<{ type: 'ws'|'eq'|'lparen'|'rparen'|'colon'|'string'|'ident'|'literal'|'and'|'or'|'not'|'error', value: string, start: number, end: number }>}
 */
export function tokenizeSearch(text) {
  const s = text ?? ''
  const out = []
  let i = 0
  while (i < s.length) {
    const rest = s.slice(i)
    let type
    let len
    const ws = /^\s+/.exec(rest)
    if (ws) { type = 'ws'; len = ws[0].length }
    else if (rest[0] === '=') { type = 'eq'; len = 1 }
    else if (rest[0] === '(') { type = 'lparen'; len = 1 }
    else if (rest[0] === ')') { type = 'rparen'; len = 1 }
    else if (rest[0] === ':') { type = 'colon'; len = 1 }
    else {
      // First rule that matches wins, in the reference lexer's order.
      const str = STRING.exec(rest)
      const ident = !str && IDENT.exec(rest)
      if (str) { type = 'string'; len = str[0].length }
      else if (ident) { type = 'ident'; len = ident[0].length }
      else {
        const lit = LITERAL.exec(rest)
        if (lit) { type = Object.hasOwn(KEYWORDS, lit[0]) ? KEYWORDS[lit[0]] : 'literal'; len = lit[0].length }
        // An open quote runs to the end of the line: that whole tail is the
        // mistake, not just its first character.
        else if (rest[0] === '"' || rest[0] === "'") { type = 'error'; len = rest.length }
        else { type = 'error'; len = 1 }
      }
    }
    out.push({ type, value: s.slice(i, i + len), start: i, end: i + len })
    i += len
  }
  return out
}

// ---------- Parser ----------

// Recursive descent over the grammar the reference compiles with nearley. It
// is unambiguous, so a deterministic parser accepts exactly what nearley does
// and builds the same tree.
function parseTokens(toks) {
  let i = 0
  const peek = () => toks[i]
  const fail = () => { throw new Error('parse') }
  const startsPrimary = (t) => t && (t.type === 'not' || t.type === 'lparen' || t.type === 'ident'
    || t.type === 'literal' || t.type === 'string')

  const value = () => {
    const t = peek()
    if (!t) fail()
    if (t.type === 'string') { i++; return t.value.slice(1, -1) }
    if (t.type === 'literal' || t.type === 'ident') { i++; return t.value }
    return fail()
  }
  const primary = () => {
    const t = peek()
    if (!t) fail()
    if (t.type === 'ident' && toks[i + 1]?.type === 'colon') {
      i += 2
      let operator = ':'
      if (peek()?.type === 'eq') { i++; operator = '=' }
      return { type: 'comparison', field: t.value, operator, value: value() }
    }
    if (t.type === 'lparen') {
      i++
      const e = or()
      if (peek()?.type !== 'rparen') fail()
      i++
      return e
    }
    return { type: 'term', value: value() }
  }
  const not = () => {
    if (peek()?.type === 'not') { i++; return { type: 'not', expr: not() } }
    return primary()
  }
  const and = () => {
    let left = not()
    for (;;) {
      const t = peek()
      if (t?.type === 'and') { i++; left = { type: 'and', left, right: not() } }
      else if (startsPrimary(t)) left = { type: 'and', left, right: not() }
      else return left
    }
  }
  const or = () => {
    let left = and()
    while (peek()?.type === 'or') { i++; left = { type: 'or', left, right: and() } }
    return left
  }

  const tree = or()
  if (i !== toks.length) fail()
  return tree
}

/**
 * Reference `UM`. Returns the filter tree, or null when there is none to apply
 * (empty input, a lexer error such as an unclosed quote, or nothing left after
 * recovery).
 *
 * Recovery drops trailing tokens one at a time; a dangling `:` goes with the
 * token before it, so `foo label:` searches `foo` rather than stalling.
 */
export function parseSearch(text) {
  const all = tokenizeSearch(text)
  if (all.some(t => t.type === 'error')) return null
  const toks = all.filter(t => t.type !== 'ws')
  while (toks.length > 0) {
    try { return parseTokens(toks) } catch { /* try a shorter prefix */ }
    if (toks.length > 1 && toks[toks.length - 1].type === 'colon') toks.pop()
    toks.pop()
  }
  return null
}

/** Reference `xL`: a column title as a field name ("Label" → "label"). */
export function fieldName(title) {
  return (title ?? '').toLowerCase().replace(/[^a-zA-Z0-9]/g, '_').replace(/^_+|_+$/g, '').replace(/_+/g, '_')
}

export const TABLE_FIELDS = ['label']

/**
 * Reference `_v`. `row` is a table row from series.js: `key` is the JSON of
 * its labels (what a bare term searches), `labels[i]` the text of column i.
 */
export function matchSearch(node, row, fields = TABLE_FIELDS) {
  if (!node) return true
  switch (node.type) {
    case 'term':
      return String(row.key ?? '').toLowerCase().includes(String(node.value).toLowerCase())
    case 'comparison': {
      const dot = node.field.indexOf('.')
      const name = dot === -1 ? node.field : node.field.slice(0, dot)
      const col = fields.indexOf(name)
      // `label.x` would address a tag of the column; table rows here carry none.
      if (col === -1 || dot !== -1) return false
      const cell = row.labels?.[col]
      if (cell === undefined || cell === null) return false
      // The reference compares loosely (`==`); both sides are strings here.
      if (node.operator === '=') return String(cell) === String(node.value)
      return String(cell).toLowerCase().includes(String(node.value).toLowerCase())
    }
    case 'and': return matchSearch(node.left, row, fields) && matchSearch(node.right, row, fields)
    case 'or': return matchSearch(node.left, row, fields) || matchSearch(node.right, row, fields)
    case 'not': return !matchSearch(node.expr, row, fields)
    default: return false
  }
}

/** Rows the search keeps; everything when the text holds no filter. */
export function filterRows(rows, text, fields = TABLE_FIELDS) {
  const node = parseSearch(text)
  if (!node) return rows
  return rows.filter(r => matchSearch(node, r, fields))
}

// ---------- Highlighting ----------

/**
 * Segments for an ink layer beneath the input (the TableQuerySearch technique).
 * Types: 'field' (a known field and its colon), 'op' (and/or/not and `=`),
 * 'paren', 'string', 'plain', 'error'.
 */
export function segmentSearch(text, fields = TABLE_FIELDS) {
  const toks = tokenizeSearch(text)
  const out = []
  const push = (value, type) => {
    const last = out[out.length - 1]
    if (last && last.type === type) last.text += value
    else out.push({ text: value, type })
  }
  toks.forEach((t, idx) => {
    if (t.type === 'ident') {
      push(t.value, fields.includes(t.value) ? 'field' : 'plain')
      return
    }
    if (t.type === 'colon') {
      // The colon belongs to the field it follows (possibly across spaces).
      let j = idx - 1
      while (j >= 0 && toks[j].type === 'ws') j--
      push(t.value, j >= 0 && toks[j].type === 'ident' && fields.includes(toks[j].value) ? 'field' : 'plain')
      return
    }
    const type = {
      and: 'op', or: 'op', not: 'op', eq: 'op',
      lparen: 'paren', rparen: 'paren',
      string: 'string', error: 'error',
    }[t.type] || 'plain'
    push(t.value, type)
  })
  return out
}

// ---------- Autocomplete ----------

const KEYWORD_ITEMS = ['AND', 'OR', 'NOT']
const BARE = /^\w+$/
const quote = (v) => (BARE.test(v) ? v : `"${v.replace(/[\\"]/g, '\\$&')}"`)
// The reference's context markers: a colon (with an optional `=` and opening
// quote), a quote, a paren, or a boolean keyword. The LAST one before the
// caret decides what is being typed.
const CONTEXT = /(:\s*=?\s*["']?|["']|\(|\)|\band\b|\bor\b|\bnot\b)/gi
// True when the text ends inside an unclosed quote.
const OPEN_QUOTE = /^([^'"]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')*("(?:\\.|[^"\\])*|'(?:\\.|[^'\\])*)$/

/**
 * Suggestions for the search box (reference provider, with its fixes: the
 * fragment replaced is everything since the last separator, so a value with a
 * `-` is replaced whole; a value picked inside an open quote closes it).
 *
 * @param {{ text: string, cursor: number, values: string[], fields?: string[] }} args
 *   `values` — the distinct non-empty label texts of the table's rows
 * @returns {{ from: number, to: number, items: Array<{ label: string, insertText: string, kind: 'keyword'|'field'|'value' }> }}
 */
export function suggestSearch({ text, cursor, values = [], fields = TABLE_FIELDS }) {
  const s = text ?? ''
  const at = Math.max(0, Math.min(cursor ?? s.length, s.length))
  const head = s.slice(0, at)
  const distinct = [...new Set(values.filter(Boolean))]

  const fieldItems = fields.map(f => ({ label: `${f}:`, insertText: `${f}:`, kind: 'field' }))
  const valueItems = (vs, raw) => vs.map(v => ({ label: v, insertText: raw ? v : quote(v), kind: 'value' }))
  const keywordItems = KEYWORD_ITEMS.map(k => ({ label: k, insertText: k, kind: 'keyword' }))

  let marker = null
  for (const m of head.matchAll(CONTEXT)) marker = m
  let fragment = /[^\s()"':=]*$/.exec(head)[0]
  let items = null
  let closeQuote = ''

  if (marker) {
    const g = marker[0]
    const gEnd = marker.index + g.length
    if (g === '(' || /^(and|or|not)$/i.test(g)) {
      items = [...fieldItems, ...valueItems(distinct)]
    } else if (g.includes(':')) {
      const typed = head.slice(gEnd)
      const before = head.slice(0, marker.index)
      const name = /([a-zA-Z_][a-zA-Z0-9_.]*)\s*$/.exec(before)?.[1] ?? ''
      // Values of the named column; an unknown field has none to offer.
      const own = !name ? distinct : fields.includes(name) ? distinct : []
      const last = g[g.length - 1]
      if (last === '"' || last === "'") {
        fragment = typed
        closeQuote = last
        items = valueItems(own, true)
      } else if (!/\S\s/.test(typed)) {
        fragment = typed.trimStart()
        items = valueItems(own)
      }
    } else if ((g === '"' || g === "'") && OPEN_QUOTE.test(head)) {
      fragment = head.slice(gEnd)
      closeQuote = g
      items = valueItems(distinct, true)
    }
  }
  if (!items) {
    items = s.trim() ? [...keywordItems, ...fieldItems, ...valueItems(distinct)] : [...fieldItems, ...valueItems(distinct)]
  }

  const f = fragment.toLowerCase()
  let hit = f ? items.filter(it => it.label.toLowerCase().includes(f)) : items
  // A fragment that already IS the only candidate has nothing left to offer.
  if (hit.length === 1 && hit[0].label.toLowerCase() === f) hit = []
  if (closeQuote && s[at] !== closeQuote) hit = hit.map(it => ({ ...it, insertText: it.insertText + closeQuote }))
  return { from: at - fragment.length, to: at, items: hit }
}
