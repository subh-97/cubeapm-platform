// PromQL / MetricsQL parser: tokens in, AST out.
//
// The dialect is MetricsQL, because the real CubeAPM backend is
// VictoriaMetrics and our generated queries lean on three of its extensions:
// `default` (every Quick query ends a selector with `default 0`), range
// functions written with no `[window]` at all, and `ignoring (…) group_left`
// with no label list on the right. A strict Prometheus parser rejects all
// three, so this one has to be MetricsQL-shaped or the editor would refuse the
// queries our own builders produce.
//
// Errors are `PromqlError`, phrased the way VictoriaMetrics phrases them
// (`cannot parse "…": unexpected token "…"`), because api.js wraps the message
// into the server-style band the page shows. `pos` is the offset the editor
// underlines.

import { tokenizePromql, durationSeconds, AGGREGATION_NAMES } from './lexer.js'

export class PromqlError extends Error {
  constructor(message, pos = 0) {
    super(message)
    this.name = 'PromqlError'
    this.pos = pos
  }
}

const AGGREGATIONS = new Set(AGGREGATION_NAMES)

// MetricsQL's binary priorities. `default` binds loosest of all, which is what
// makes `a default 0 / b` mean `a default (0 / b)` there and here alike; our
// generators only ever write `default` inside a function's parentheses, so the
// difference never bites, but getting it wrong would quietly change a
// hand-written query's meaning.
const PRIORITY = {
  default: 1,
  if: 2, ifnot: 2,
  or: 3,
  and: 4, unless: 4,
  '==': 5, '!=': 5, '<': 5, '>': 5, '<=': 5, '>=': 5,
  '+': 6, '-': 6,
  '*': 7, '/': 7, '%': 7, atan2: 7,
  '^': 8,
}

const MATCH_OPS = new Set(['=', '!=', '=~', '!~'])

const quote = v => JSON.stringify(String(v))

function fail(p, detail, pos) {
  return new PromqlError(`cannot parse ${quote(p.src)}: ${detail}`, Number.isFinite(pos) ? pos : p.src.length)
}

const peek = p => p.tokens[p.i]
const next = p => p.tokens[p.i++]
const atEnd = p => p.i >= p.tokens.length

function describe(tok) {
  return tok ? quote(tok.value) : 'end of query'
}

function expect(p, type, value) {
  const tok = peek(p)
  if (!tok || tok.type !== type || (value !== undefined && tok.value !== value)) {
    throw fail(p, `unexpected token ${describe(tok)}; want ${quote(value ?? type)}`, tok?.start)
  }
  return next(p)
}

const isKeyword = (tok, word) => !!tok && tok.type === 'keyword' && tok.value === word

/**
 * Parse `text` into an AST. Throws `PromqlError` on anything it cannot read.
 *
 * Node shapes:
 *   { type:'number', value }
 *   { type:'string', value }
 *   { type:'unary', op:'-', expr }
 *   { type:'selector', name, matchers:[{ label, op, value }], range, offset }
 *   { type:'call', func, args, keepMetricNames }
 *   { type:'aggregation', op, args, modifier:{ kind:'by'|'without', labels } | null }
 *   { type:'binary', op, bool, matching, lhs, rhs }
 * Every node carries `pos`, the offset it starts at.
 */
export function parsePromql(text) {
  const src = String(text ?? '')
  const p = { src, tokens: tokenizePromql(src).filter(t => t.type !== 'whitespace'), i: 0 }
  const bad = p.tokens.find(t => t.type === 'error')
  if (bad) {
    const detail = bad.unterminated
      ? `unterminated string literal ${quote(bad.value)}`
      : `unexpected token ${quote(bad.value)}`
    throw fail(p, detail, bad.start)
  }
  if (!p.tokens.length) throw fail(p, 'the query is empty', 0)
  const expr = parseExpr(p, 1)
  if (!atEnd(p)) throw fail(p, `unexpected token ${describe(peek(p))}`, peek(p).start)
  return expr
}

function binaryOpOf(tok) {
  if (!tok || tok.type !== 'operator') return null
  return PRIORITY[tok.value] !== undefined ? tok.value : null
}

function parseExpr(p, minPriority) {
  let lhs = parseUnary(p)
  for (;;) {
    const op = binaryOpOf(peek(p))
    if (!op) break
    const priority = PRIORITY[op]
    if (priority < minPriority) break
    const pos = next(p).start
    const { bool, matching } = parseBinaryModifiers(p, op)
    // `^` is the one right-associative operator, so it re-enters at its own
    // priority instead of one above it.
    const rhs = parseExpr(p, op === '^' ? priority : priority + 1)
    lhs = { type: 'binary', op, bool, matching, lhs, rhs, pos }
  }
  return lhs
}

function parseBinaryModifiers(p, op) {
  let bool = false
  let matching = null
  for (;;) {
    const tok = peek(p)
    if (isKeyword(tok, 'bool')) { next(p); bool = true; continue }
    if (isKeyword(tok, 'on') || isKeyword(tok, 'ignoring')) {
      if (matching) throw fail(p, `duplicate vector matching clause ${quote(tok.value)}`, tok.start)
      next(p)
      matching = { on: tok.value === 'on', labels: parseLabelList(p), card: null, include: [] }
      continue
    }
    if (isKeyword(tok, 'group_left') || isKeyword(tok, 'group_right')) {
      if (!matching) matching = { on: false, labels: [], card: null, include: [] }
      next(p)
      matching.card = tok.value === 'group_left' ? 'left' : 'right'
      // A `(` here opens the include list. `group_left sum(x)` — which is what
      // our error-percentage query writes — starts with an identifier instead,
      // so the two never collide in practice.
      if (peek(p)?.value === '(') matching.include = parseLabelList(p)
      continue
    }
    break
  }
  if (bool && !'== != < > <= >='.split(' ').includes(op)) {
    throw fail(p, `"bool" modifier cannot be applied to ${quote(op)}`, p.tokens[p.i - 1]?.start)
  }
  return { bool, matching }
}

function parseLabelList(p) {
  expect(p, 'paren', '(')
  const labels = []
  while (peek(p)?.value !== ')') {
    const tok = peek(p)
    if (!tok) throw fail(p, 'unexpected end of query; want ")"')
    if (tok.type === 'string') { next(p); labels.push(tok.str) }
    else if (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(tok.value)) { next(p); labels.push(tok.value) }
    else throw fail(p, `unexpected token ${describe(tok)}; want a label name`, tok.start)
    if (peek(p)?.type === 'comma') next(p)
    else break
  }
  expect(p, 'paren', ')')
  return labels
}

function parseUnary(p) {
  const tok = peek(p)
  if (tok && tok.type === 'operator' && (tok.value === '-' || tok.value === '+')) {
    next(p)
    const expr = parseUnary(p)
    return tok.value === '-' ? { type: 'unary', op: '-', expr, pos: tok.start } : expr
  }
  return parsePostfix(p)
}

function parsePostfix(p) {
  const expr = parsePrimary(p)
  if (isKeyword(peek(p), 'keep_metric_names')) { next(p); expr.keepMetricNames = true }
  return expr
}

function parsePrimary(p) {
  const tok = peek(p)
  if (!tok) throw fail(p, 'missing expression')

  if (tok.value === '(') {
    next(p)
    const inner = parseExpr(p, 1)
    expect(p, 'paren', ')')
    return inner
  }
  if (tok.type === 'number') {
    next(p)
    return { type: 'number', value: numberOf(tok.value), pos: tok.start }
  }
  if (tok.type === 'duration') {
    // A bare duration outside brackets is a number of seconds (MetricsQL).
    next(p)
    return { type: 'number', value: durationSeconds(tok.value), pos: tok.start }
  }
  if (tok.type === 'string') {
    next(p)
    return { type: 'string', value: tok.str, pos: tok.start }
  }
  if (tok.type === 'macro') {
    throw fail(p, `unexpanded macro ${quote(tok.value)}`, tok.start)
  }
  if (tok.type === 'brace' && tok.value === '{') {
    return parseSelector(p, null, tok.start)
  }
  if (tok.type === 'metric' || tok.type === 'label' || tok.type === 'function' || tok.type === 'aggregation') {
    next(p)
    const name = tok.value
    if (AGGREGATIONS.has(name) && (peek(p)?.value === '(' || isKeyword(peek(p), 'by') || isKeyword(peek(p), 'without'))) {
      return parseAggregation(p, name, tok.start)
    }
    if (peek(p)?.value === '(') return parseCall(p, name, tok.start)
    return parseSelector(p, name, tok.start)
  }
  throw fail(p, `unexpected token ${describe(tok)}`, tok.start)
}

function numberOf(text) {
  const lower = String(text).toLowerCase()
  if (lower === 'inf') return Infinity
  if (lower === 'nan') return NaN
  return Number(text)
}

function parseCall(p, func, pos) {
  expect(p, 'paren', '(')
  const args = []
  if (peek(p)?.value !== ')') {
    args.push(parseExpr(p, 1))
    while (peek(p)?.type === 'comma') { next(p); args.push(parseExpr(p, 1)) }
  }
  expect(p, 'paren', ')')
  return { type: 'call', func, args, keepMetricNames: false, pos }
}

function parseAggregation(p, op, pos) {
  let modifier = null
  const grouping = () => {
    const tok = next(p)
    return { kind: tok.value, labels: parseLabelList(p) }
  }
  if (isKeyword(peek(p), 'by') || isKeyword(peek(p), 'without')) modifier = grouping()
  const call = parseCall(p, op, pos)
  // `by`/`without` is legal on either side of the argument list; the reference
  // generators write it after, the hand-written queries in the specs before.
  if (!modifier && (isKeyword(peek(p), 'by') || isKeyword(peek(p), 'without'))) modifier = grouping()
  return { type: 'aggregation', op, args: call.args, modifier, pos }
}

function parseSelector(p, name, pos) {
  const node = { type: 'selector', name: name || '', matchers: [], range: null, offset: 0, pos }
  if (peek(p)?.value === '{') {
    next(p)
    while (peek(p)?.value !== '}') {
      node.matchers.push(parseMatcher(p))
      if (peek(p)?.type === 'comma') next(p)
      else break
    }
    expect(p, 'brace', '}')
  }
  if (!node.name && !node.matchers.length) {
    throw fail(p, 'vector selector must contain at least one non-empty matcher', pos)
  }
  for (;;) {
    const tok = peek(p)
    if (tok?.value === '[' && node.range === null) { node.range = parseRange(p); continue }
    if (isKeyword(tok, 'offset')) { next(p); node.offset = parseOffset(p); continue }
    break
  }
  return node
}

function parseMatcher(p) {
  const nameTok = peek(p)
  if (!nameTok) throw fail(p, 'unexpected end of query; want a label name')
  let label
  if (nameTok.type === 'string') { next(p); label = nameTok.str }
  else if (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(nameTok.value)) { next(p); label = nameTok.value }
  else throw fail(p, `unexpected token ${describe(nameTok)}; want a label name`, nameTok.start)

  const opTok = peek(p)
  if (!opTok || !MATCH_OPS.has(opTok.value)) {
    throw fail(p, `unexpected token ${describe(opTok)}; want one of "=", "!=", "=~", "!~"`, opTok?.start ?? nameTok.end)
  }
  next(p)
  const valueTok = peek(p)
  if (!valueTok || valueTok.type !== 'string') {
    throw fail(p, `unexpected token ${describe(valueTok)}; want a quoted label value`, valueTok?.start ?? opTok.end)
  }
  next(p)
  return { label, op: opTok.value, value: valueTok.str }
}

// `[5m]`, `[3600s]`, `[60]` (bare seconds, which is what `$__step` expands to)
// and the subquery form `[1h:5m]`. The subquery resolution is parsed so a
// pasted query still runs; evaluation treats it as the lookbehind window.
function parseRange(p) {
  expect(p, 'bracket', '[')
  const window = parseDurationValue(p)
  let resolution = null
  if (peek(p)?.value === ':') { next(p); if (peek(p)?.value !== ']') resolution = parseDurationValue(p) }
  expect(p, 'bracket', ']')
  return { window, resolution }
}

function parseDurationValue(p) {
  const tok = peek(p)
  if (tok?.type === 'duration') { next(p); return durationSeconds(tok.value) }
  if (tok?.type === 'number') { next(p); return Number(tok.value) }
  throw fail(p, `unexpected token ${describe(tok)}; want a duration`, tok?.start)
}

function parseOffset(p) {
  let sign = 1
  const tok = peek(p)
  if (tok?.type === 'operator' && (tok.value === '-' || tok.value === '+')) { next(p); sign = tok.value === '-' ? -1 : 1 }
  return sign * parseDurationValue(p)
}
