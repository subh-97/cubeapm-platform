// PromQL / MetricsQL tokenizer.
//
// One token stream serves two readers: the parser, and the Code editor's ink
// layer. That is why it never throws and always covers the input end to end —
// a half-typed query still has to be painted, and a brace the person has not
// closed yet must not take the editor down. Anything it cannot place becomes
// an 'error' token, which the parser rejects with a message and the
// highlighter underlines.
//
// Dialect notes that shape the scan:
//   - metric names may contain `.` and `:` (`service.version`,
//     `cube_apm_calls_total:increase15m`), so an identifier is greedier here
//     than in upstream Prometheus;
//   - `$__macro` is a token of its own. api.js substitutes macros before the
//     parser ever sees a query, but the editor paints them while they are
//     being typed;
//   - a duration (`5m`, `1h30m`) is scanned before a number, because `5m`
//     must not come out as `5` followed by a metric called `m`.

export const AGGREGATION_NAMES = [
  'avg', 'bottomk', 'count', 'count_values', 'group', 'max', 'median', 'min',
  'quantile', 'stddev', 'stdvar', 'sum', 'topk',
]

export const FUNCTION_NAMES = [
  'abs', 'absent', 'absent_over_time', 'alias', 'avg_over_time', 'ceil', 'changes', 'clamp',
  'clamp_max', 'clamp_min', 'count_over_time', 'delta', 'deriv', 'exp', 'floor',
  'histogram_quantile', 'idelta', 'increase', 'irate', 'label_replace', 'last_over_time', 'ln',
  'log10', 'log2', 'max_over_time', 'min_over_time', 'present_over_time', 'quantile_over_time',
  'rate', 'resets', 'round', 'scalar', 'sgn', 'sort', 'sort_desc', 'sqrt', 'stddev_over_time',
  'stdvar_over_time', 'sum_over_time', 'time', 'timestamp', 'vector',
]

/** Modifiers: words that shape an expression without being an operator. */
export const PROMQL_MODIFIERS = [
  'bool', 'by', 'group_left', 'group_right', 'ignoring', 'keep_metric_names', 'offset', 'on',
  'without',
]

/** Binary operators spelled as words (MetricsQL adds the last three). */
export const BINARY_WORD_OPERATORS = ['and', 'atan2', 'default', 'if', 'ifnot', 'or', 'unless']

const AGGREGATIONS = new Set(AGGREGATION_NAMES)
const FUNCTIONS = new Set(FUNCTION_NAMES)
const MODIFIERS = new Set(PROMQL_MODIFIERS)
const WORD_OPERATORS = new Set(BINARY_WORD_OPERATORS)

// Longest first: `=~` must win over `=`, `!=` over `!`.
const SYMBOL_OPERATORS = ['==', '!=', '>=', '<=', '=~', '!~', '>', '<', '+', '-', '*', '/', '%', '^']

const DURATION_UNITS = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400, w: 604800, y: 31536000 }

const DURATION_RE = /^(?:\d+(?:\.\d+)?(?:ms|s|m|h|d|w|y))+/
const NUMBER_RE = /^(?:0[xX][0-9a-fA-F]+|(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?)/
const MACRO_RE = /^\$__[A-Za-z0-9_]*/
const DURATION_PART_RE = /(\d+(?:\.\d+)?)(ms|s|m|h|d|w|y)/g

const isSpace = ch => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v'
const isDigit = ch => ch >= '0' && ch <= '9'
const isIdentStart = ch => (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_'
// `:` and `.` continue a name (`cube_apm_latency:increase15m_bucket`,
// `service.version`) but cannot start one — otherwise the `:` of a subquery
// window `[1h:5m]` would be eaten as the head of an identifier.
const isIdentPart = ch => isIdentStart(ch) || isDigit(ch) || ch === '.' || ch === ':'

/**
 * A duration literal in seconds (`90s` → 90, `1h30m` → 5400), or NaN when the
 * text is not one. Compound durations add up, as MetricsQL reads them.
 */
export function durationSeconds(text) {
  const s = String(text ?? '')
  if (!DURATION_RE.test(s) || DURATION_RE.exec(s)[0] !== s) return NaN
  let total = 0
  DURATION_PART_RE.lastIndex = 0
  for (let m = DURATION_PART_RE.exec(s); m; m = DURATION_PART_RE.exec(s)) {
    total += parseFloat(m[1]) * DURATION_UNITS[m[2]]
  }
  return total
}

// Go/JSON string escapes. An escape neither understands is kept verbatim: a
// query is a thing people paste, and `"a\-b"` reaching a regex should mean
// what they typed rather than make the editor give up.
function decodeEscapes(body) {
  if (!body.includes('\\')) return body
  let out = ''
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (c !== '\\' || i === body.length - 1) { out += c; continue }
    const n = body[++i]
    switch (n) {
      case 'n': out += '\n'; break
      case 't': out += '\t'; break
      case 'r': out += '\r'; break
      case '\\': out += '\\'; break
      case '"': out += '"'; break
      case "'": out += "'"; break
      case '`': out += '`'; break
      case 'u': out += String.fromCharCode(parseInt(body.slice(i + 1, i + 5), 16) || 0); i += 4; break
      default: out += '\\' + n
    }
  }
  return out
}

// Is the identifier that ends at `j` the left-hand side of a label matcher?
// Inside braces every match operator qualifies; outside them `!=` is a
// comparison (`errors != 0`), so only the forms PromQL has no other use for
// mark a label. `=` alone must not swallow `==`.
function matcherAhead(s, j, depth) {
  while (j < s.length && isSpace(s[j])) j++
  const two = s.slice(j, j + 2)
  if (two === '=~' || two === '!~') return true
  if (two === '!=') return depth > 0
  if (s[j] === '=' && s[j + 1] !== '=') return true
  return false
}

/**
 * Highlighting-and-parsing tokens `{ type, value, start, end }` covering
 * `text` end to end. `value` is always the raw source slice, so the ink layer
 * can glue the stream back into the original text; a 'string' token also
 * carries the decoded contents as `str`.
 *
 * Types: 'metric' | 'label' | 'string' | 'number' | 'duration' | 'function' |
 * 'aggregation' | 'keyword' | 'operator' | 'paren' | 'brace' | 'bracket' |
 * 'comma' | 'matchop' | 'macro' | 'whitespace' | 'error'. Comments (`#` to end
 * of line) come out as 'whitespace' — that is what they are to the query — with
 * their text kept.
 */
export function tokenizePromql(text) {
  const s = String(text ?? '')
  const out = []
  let i = 0
  let depth = 0
  const push = (type, start, end, extra) => { out.push({ type, value: s.slice(start, end), start, end, ...extra }) }

  while (i < s.length) {
    const start = i
    const ch = s[i]

    if (isSpace(ch)) {
      while (i < s.length && isSpace(s[i])) i++
      push('whitespace', start, i)
      continue
    }

    if (ch === '#') {
      while (i < s.length && s[i] !== '\n') i++
      push('whitespace', start, i)
      continue
    }

    if (ch === '$') {
      const m = MACRO_RE.exec(s.slice(i))
      if (m) { i += m[0].length; push('macro', start, i); continue }
      i++
      push('error', start, i)
      continue
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      i++
      while (i < s.length && s[i] !== ch) i += (s[i] === '\\' && ch !== '`') ? 2 : 1
      if (i > s.length) i = s.length
      if (i >= s.length) {
        // Unterminated: 'error' so the editor flags it and the parser can say so.
        push('error', start, s.length, { unterminated: true })
        i = s.length
        continue
      }
      i++
      const body = s.slice(start + 1, i - 1)
      push('string', start, i, { str: ch === '`' ? body : decodeEscapes(body) })
      continue
    }

    if (isDigit(ch) || (ch === '.' && isDigit(s[i + 1]))) {
      const rest = s.slice(i)
      const dur = DURATION_RE.exec(rest)
      // `5m` is a duration, `5` a number, `1e3` a number again — the duration
      // pattern simply fails on an exponent because `e` is not a unit.
      if (dur && !isIdentPart(rest[dur[0].length] ?? '')) {
        i += dur[0].length
        push('duration', start, i)
        continue
      }
      const num = NUMBER_RE.exec(rest)
      if (num) { i += num[0].length; push('number', start, i); continue }
      i++
      push('error', start, i)
      continue
    }

    if (isIdentStart(ch)) {
      i++
      while (i < s.length && isIdentPart(s[i])) i++
      const word = s.slice(start, i)
      const lower = word.toLowerCase()
      let type
      if (lower === 'inf' || lower === 'nan') type = 'number'
      else if (WORD_OPERATORS.has(lower)) type = 'operator'
      else if (MODIFIERS.has(lower)) type = 'keyword'
      else if (AGGREGATIONS.has(word)) type = 'aggregation'
      else if (FUNCTIONS.has(word)) type = 'function'
      else if (matcherAhead(s, i, depth)) type = 'label'
      else type = 'metric'
      push(type, start, i)
      continue
    }

    if (ch === '(' || ch === ')') { i++; push('paren', start, i); continue }
    if (ch === '{' || ch === '}') { depth += ch === '{' ? 1 : -1; if (depth < 0) depth = 0; i++; push('brace', start, i); continue }
    if (ch === '[' || ch === ']') { i++; push('bracket', start, i); continue }
    if (ch === ',') { i++; push('comma', start, i); continue }
    if (ch === ':') { i++; push('operator', start, i); continue }

    const op = SYMBOL_OPERATORS.find(o => s.startsWith(o, i))
    if (op) {
      i += op.length
      // Match operators and comparisons share spellings; which one a `=` or
      // `!=` is depends on whether we are inside a selector's braces.
      const isMatch = op === '=~' || op === '!~' || (depth > 0 && (op === '!=' || op === '=='))
      push(isMatch ? 'matchop' : 'operator', start, i)
      continue
    }
    if (ch === '=') { i++; push('matchop', start, i); continue }

    // Unknown input, run by run, so the editor underlines it in one piece.
    while (i < s.length && !isSpace(s[i]) && !isIdentStart(s[i]) && !isDigit(s[i])
      && !'"\'`${}()[],:=!<>+-*/%^#~'.includes(s[i])) i++
    if (i === start) i++
    push('error', start, i)
  }
  return out
}
