// LogsQL tokenizer.
//
// Two layers live here.
//
// `scanLogsql` is the raw scanner the parser consumes. It follows VictoriaLogs'
// own lexer model: a token is a run of word characters, a quoted string, or a
// single punctuation character, and each token remembers whether whitespace
// came before it. Multi-character values such as `log.level`, `cubedemo-web`
// or `0.9` are reassembled by the parser from adjacent tokens. Keeping that
// model is what makes the server's error texts reproducible — "compound token
// cannot start with ")"" is phrased in terms of exactly these tokens.
//
// `tokenizeLogsql` is the highlighter's view: the same scan glued back into the
// units a person reads (a field name, an operator like `:=`, a pipe name) and
// classified. It never throws and always covers the input end to end, so the
// editor's ink layer can paint a half-typed query up to the caret; anything it
// cannot place is an 'error' token.

// Names the server knows, used by the parser to reject unknown pipes and stats
// functions and by the highlighter to colour them. The descriptions shown in
// autocomplete live with the UI catalogs; these are only the vocabularies.
export const LOGSQL_PIPE_NAMES = [
  'block_stats', 'blocks_count', 'collapse_nums', 'copy', 'cp', 'decolorize', 'del', 'delete',
  'drop', 'drop_empty_fields', 'eval', 'extract', 'extract_regexp', 'facets', 'field_names',
  'field_values', 'fields', 'filter', 'first', 'format', 'generate_sequence', 'hash', 'head',
  'join', 'json_array_len', 'keep', 'last', 'len', 'limit', 'math', 'mv', 'offset', 'order',
  'pack_json', 'pack_logfmt', 'query_stats', 'rename', 'replace', 'replace_regexp', 'rm',
  'running_stats', 'sample', 'set_stream_fields', 'skip', 'sort', 'split', 'stats',
  'stats_remote', 'stream_context', 'time_add', 'top', 'total_stats', 'union', 'uniq',
  'unpack_json', 'unpack_logfmt', 'unpack_syslog', 'unpack_words', 'unroll', 'where',
]

export const LOGSQL_STATS_FUNC_NAMES = [
  'any', 'avg', 'count', 'count_empty', 'count_uniq', 'count_uniq_hash', 'field_max', 'field_min',
  'histogram', 'json_values', 'max', 'median', 'median_absolute_deviation', 'min', 'quantile',
  'rate', 'rate_sum', 'row_any', 'row_max', 'row_min', 'stddev', 'sum', 'sum_len', 'uniq_values',
  'values',
]

export const LOGSQL_FILTER_FUNC_NAMES = [
  'contains_all', 'contains_any', 'contains_common_case', 'eq_field', 'equals_common_case',
  'exact', 'i', 'in', 'ipv4_range', 'ipv6_range', 'json_array_contains_any', 'le_field',
  'len_range', 'lt_field', 'pattern_match', 'pattern_match_full', 'pattern_match_prefix',
  'pattern_match_suffix', 'range', 're', 'seq', 'string_range', 'value_type',
]

// Functions a `math` expression may call.
export const LOGSQL_MATH_FUNC_NAMES = ['abs', 'ceil', 'exp', 'floor', 'ln', 'max', 'min', 'now', 'rand', 'round']

const PIPES = new Set(LOGSQL_PIPE_NAMES)
const STATS_FUNCS = new Set(LOGSQL_STATS_FUNC_NAMES)
const FILTER_FUNCS = new Set(LOGSQL_FILTER_FUNC_NAMES)
const MATH_FUNCS = new Set(LOGSQL_MATH_FUNC_NAMES)

// ---------- Raw scan ----------

// A word character in VictoriaLogs' sense: letters, digits and `_`. Anything
// beyond ASCII is treated as a letter — close enough to unicode.IsLetter for
// every value this app carries (`µs` is the one that matters).
export function isWordChar(ch) {
  if (!ch) return false
  const c = ch.charCodeAt(0)
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c > 127
}

const isSpace = ch => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v'

// Go's strconv.Unquote escapes. An escape Go would reject is kept verbatim
// instead: `"a\-b"` reaching a regex means what the person typed, and a
// highlighter must not fail on it.
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
      case '\\': case '"': case "'": case '`': out += n; break
      case 'x': {
        const hex = body.slice(i + 1, i + 3)
        if (/^[0-9a-fA-F]{2}$/.test(hex)) { out += String.fromCharCode(parseInt(hex, 16)); i += 2 } else out += '\\x'
        break
      }
      case 'u': {
        const hex = body.slice(i + 1, i + 5)
        if (/^[0-9a-fA-F]{4}$/.test(hex)) { out += String.fromCharCode(parseInt(hex, 16)); i += 4 } else out += '\\u'
        break
      }
      default: out += '\\' + n
    }
  }
  return out
}

/**
 * Raw tokens, whitespace and comments included, covering `text` end to end.
 *
 * Kinds: 'ws', 'comment' (`#` to end of line), 'word' (a run of word
 * characters), 'str' (a quoted string; `value` is decoded), 'badstr' (an
 * unterminated string, to the end of input), 'punct' (any single other char).
 * Every non-space token carries `sp`: whether whitespace or a comment came
 * right before it — the parser's "glued or not" signal.
 */
export function scanLogsql(text) {
  const s = String(text ?? '')
  const out = []
  let i = 0
  let sp = false
  while (i < s.length) {
    const start = i
    const ch = s[i]
    if (isSpace(ch)) {
      while (i < s.length && isSpace(s[i])) i++
      out.push({ k: 'ws', start, end: i, text: s.slice(start, i) })
      sp = true
      continue
    }
    if (ch === '#') {
      while (i < s.length && s[i] !== '\n') i++
      out.push({ k: 'comment', start, end: i, text: s.slice(start, i) })
      sp = true
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      i++
      while (i < s.length && s[i] !== ch) i += (s[i] === '\\' && ch !== '`') ? 2 : 1
      if (i >= s.length) {
        out.push({ k: 'badstr', start, end: s.length, text: s.slice(start), sp })
        i = s.length
      } else {
        i++
        const body = s.slice(start + 1, i - 1)
        out.push({ k: 'str', start, end: i, text: s.slice(start, i), value: ch === '`' ? body : decodeEscapes(body), sp })
      }
      sp = false
      continue
    }
    if (isWordChar(ch)) {
      while (i < s.length && isWordChar(s[i])) i++
      out.push({ k: 'word', start, end: i, text: s.slice(start, i), sp })
      sp = false
      continue
    }
    i++
    out.push({ k: 'punct', start, end: i, text: ch, sp })
    sp = false
  }
  return out
}

// ---------- Highlighting tokens ----------

// Keywords that belong to a pipe's own grammar, so `by` in a stats pipe or
// `desc` in a sort colours as syntax rather than as a stray word.
const PIPE_KEYWORDS = {
  stats: ['by', 'as', 'if', 'limit'],
  sort: ['by', 'desc', 'asc', 'limit', 'offset', 'partition'],
  order: ['by', 'desc', 'asc', 'limit', 'offset', 'partition'],
  first: ['by', 'desc', 'asc', 'partition'],
  last: ['by', 'desc', 'asc', 'partition'],
  top: ['by', 'hits', 'as', 'rank'],
  uniq: ['by', 'with', 'hits', 'limit'],
  math: ['as'],
  eval: ['as'],
  rename: ['as'],
  mv: ['as'],
  copy: ['as'],
  cp: ['as'],
  len: ['as'],
  hash: ['as'],
  format: ['as', 'if', 'keep_original_fields', 'skip_empty_results'],
  extract: ['from', 'if', 'keep_original_fields', 'skip_empty_results'],
  extract_regexp: ['from', 'if', 'keep_original_fields', 'skip_empty_results'],
  unpack_json: ['from', 'fields', 'result_prefix', 'if', 'keep_original_fields', 'skip_empty_results'],
  unpack_logfmt: ['from', 'fields', 'result_prefix', 'if', 'keep_original_fields', 'skip_empty_results'],
  replace: ['at', 'limit', 'if'],
  replace_regexp: ['at', 'limit', 'if'],
  collapse_nums: ['at', 'prettify'],
  pack_json: ['fields', 'as'],
  pack_logfmt: ['fields', 'as'],
}

// Pipes whose bare arguments are field names.
const FIELD_LIST_PIPES = new Set(['fields', 'keep', 'delete', 'del', 'drop', 'rm', 'rename', 'mv', 'copy', 'cp'])

// Characters glued into a bare word when nothing separates them: `cubedemo-web`,
// `/v1/orders`, `a@b.com`. The operator characters are deliberately absent.
const WORD_GLUE = new Set(['.', '-', '/', '@', '$', '+', '%', '&', '?', ';', '\\', '^', '*'])

const NUMBER_RE = /^[-+]?(?:\d[\d_]*(?:\.\d+)?(?:[eE][-+]?\d+)?|0x[0-9a-fA-F]+)$/
const DURATION_RE = /^[-+]?(?:\d+(?:\.\d+)?(?:ns|us|µs|ms|s|m|h|d|w|y))+$/
const SIZE_RE = /^[-+]?\d+(?:\.\d+)?(?:[KMGT]i?B?|[kmgt]i?b)$/

function looksNumeric(s) {
  return NUMBER_RE.test(s) || DURATION_RE.test(s) || SIZE_RE.test(s)
}

/**
 * Highlighting tokens `{ type, value, start, end }` covering `text` end to end.
 *
 * Types: 'field' | 'string' | 'word' | 'number' | 'operator' | 'pipe' |
 * 'pipeName' | 'statsFn' | 'keyword' | 'paren' | 'brace' | 'comma' | 'colon' |
 * 'star' | 'whitespace' | 'error'. Comments come out as 'whitespace' (they
 * are, to the query) with their text kept.
 *
 * This is a reading aid, not the parser: it classifies from local context and
 * never rejects anything. What it gets wrong in exotic queries only affects
 * colour; the parser remains the authority on what a query means.
 */
export function tokenizeLogsql(text) {
  const s = String(text ?? '')
  let raw
  try {
    raw = scanLogsql(s)
  } catch {
    return s ? [{ type: 'error', value: s, start: 0, end: s.length }] : []
  }
  const out = []
  const push = (type, start, end) => out.push({ type, value: s.slice(start, end), start, end })

  // Index of the next significant raw token at or after i.
  const sig = (i) => {
    while (i < raw.length && (raw[i].k === 'ws' || raw[i].k === 'comment')) i++
    return i
  }
  const tokAt = (i) => raw[sig(i)]

  let pipe = null              // current pipe name, null in the filter section
  let expectPipeName = false
  let braceDepth = 0
  let afterAs = false
  // Each open paren records what it opened: 'by' (a field list), 'statsFn'
  // (a stats function's arguments), 'if' (a nested filter), 'fn', 'group'.
  const parens = []
  const top = () => parens[parens.length - 1]
  let prevWord = ''            // lowercase text of the previous significant word
  const inMath = () => (pipe === 'math' || pipe === 'eval') && top() !== 'if'
  const inFilterCtx = () => pipe === null || pipe === 'filter' || pipe === 'where' || parens.includes('if')

  for (let i = 0; i < raw.length; i++) {
    const t = raw[i]
    if (t.k === 'ws' || t.k === 'comment') { push('whitespace', t.start, t.end); continue }
    if (t.k === 'badstr') { push('error', t.start, t.end); continue }

    if (t.k === 'str') {
      const nxt = tokAt(i + 1)
      let type = 'string'
      if (nxt && nxt.k === 'punct' && nxt.text === ':' && inFilterCtx()) type = 'field'
      else if (braceDepth > 0 && nxt && nxt.k === 'punct' && (nxt.text === '=' || nxt.text === '!')) type = 'field'
      else if (top() === 'by' || top() === 'statsFn') type = 'field'
      else if (FIELD_LIST_PIPES.has(pipe) || inMath()) type = 'field'
      else if (afterAs) type = 'field'
      afterAs = false
      expectPipeName = false
      push(type, t.start, t.end)
      prevWord = ''
      continue
    }

    if (t.k === 'punct') {
      const c = t.text
      const n1 = raw[i + 1]
      const glued = (tk, chars) => tk && tk.k === 'punct' && !tk.sp && chars.includes(tk.text)
      afterAs = false
      if (c === '|') {
        push('pipe', t.start, t.end)
        pipe = null; expectPipeName = true; parens.length = 0; braceDepth = 0; prevWord = ''
        continue
      }
      expectPipeName = false
      if (c === '(' || c === '[') {
        let kind = 'group'
        if (prevWord === 'by' || (pipe && ['fields', 'keep', 'first', 'last', 'top', 'uniq', 'sort', 'order', 'unpack_json', 'unpack_logfmt', 'pack_json', 'pack_logfmt'].includes(pipe) && prevWord !== 'if')) kind = 'by'
        if (prevWord === 'if') kind = 'if'
        else if (out.length && out[out.length - 1].type === 'statsFn') kind = 'statsFn'
        else if (out.length && out[out.length - 1].type === 'keyword' && prevWord && (FILTER_FUNCS.has(prevWord) || MATH_FUNCS.has(prevWord))) kind = 'fn'
        parens.push(kind)
        push('paren', t.start, t.end)
        prevWord = ''
        continue
      }
      if (c === ')' || c === ']') { parens.pop(); push('paren', t.start, t.end); prevWord = ''; continue }
      if (c === '{') { braceDepth++; push('brace', t.start, t.end); prevWord = ''; continue }
      if (c === '}') { braceDepth = Math.max(0, braceDepth - 1); push('brace', t.start, t.end); prevWord = ''; continue }
      if (c === ',') { push('comma', t.start, t.end); prevWord = ''; continue }
      if (c === ':') {
        // `:=`, `:!=`, `:~`, `:=~`, `:!~`, `:>`, `:>=`, `:<`, `:<=` read as one operator.
        let j = i
        if (glued(raw[j + 1], ['=', '!', '~', '>', '<'])) {
          j++
          if (glued(raw[j + 1], ['=', '~'])) j++
          push('operator', t.start, raw[j].end)
          i = j
        } else push('colon', t.start, t.end)
        prevWord = ''
        continue
      }
      if (c === '*') {
        push(inMath() ? 'operator' : 'star', t.start, t.end)
        prevWord = ''
        continue
      }
      if (c === '!' || c === '=' || c === '~' || c === '<' || c === '>') {
        let end = t.end
        if (glued(n1, ['=', '~'])) { end = n1.end; i++ }
        push('operator', t.start, end)
        prevWord = ''
        continue
      }
      if (c === '-' || c === '+' || c === '/' || c === '%' || c === '^') {
        // In a math expression these are arithmetic. Elsewhere a dash glued to
        // what follows is a negation (`-foo`); any other stray symbol starts a
        // bare word such as `/v1/orders`.
        if (inMath() || (c === '-' && n1 && !n1.sp && n1.k !== 'ws')) {
          if (inMath() || c === '-') { push('operator', t.start, t.end); prevWord = ''; continue }
        }
      }
      // Anything else starts a bare word (below) together with whatever is glued to it.
    }

    // ---- a word: glue adjacent pieces into the unit a reader sees ----
    let j = i
    let end = t.end
    const math = inMath()
    for (;;) {
      const n = raw[j + 1]
      if (!n || n.sp || n.k === 'ws' || n.k === 'comment' || n.k === 'str' || n.k === 'badstr') break
      if (n.k === 'word') {
        // In math only a dot joins (`log.level`, `0.5`); `a-b` is a subtraction.
        if (math && !(raw[j].k === 'punct' && raw[j].text === '.')) break
        j++; end = n.end; continue
      }
      if (n.text === '.' || (!math && WORD_GLUE.has(n.text) && !(n.text === '*' && raw[j + 2] && !raw[j + 2].sp && raw[j + 2].k === 'punct' && raw[j + 2].text === '|'))) {
        // A trailing `*` is kept as its own star token so `foo*` shows the
        // prefix operator; one inside a word (`*foo*` start) glues.
        if (n.text === '*') {
          const after = raw[j + 2]
          if (!after || after.sp || after.k !== 'word') break
        }
        j++; end = n.end; continue
      }
      break
    }
    const word = s.slice(t.start, end)
    const lower = word.toLowerCase()
    const nextTok = tokAt(j + 1)
    const nextIs = (...chars) => !!nextTok && nextTok.k === 'punct' && chars.includes(nextTok.text)
    const nextGluedParen = !!raw[j + 1] && !raw[j + 1].sp && raw[j + 1].k === 'punct' && raw[j + 1].text === '('
    i = j

    let type
    if (expectPipeName) {
      type = PIPES.has(lower) ? 'pipeName' : 'error'
      pipe = lower
      expectPipeName = false
    } else if (afterAs) {
      type = looksNumeric(word) ? 'number' : 'field'
    } else if (braceDepth > 0 && (lower === 'in' || lower === 'not_in') && nextIs('(')) {
      type = 'keyword'
    } else if (braceDepth > 0 && (nextIs('=', '!') || (nextTok && nextTok.k === 'word' && ['in', 'not_in'].includes(nextTok.text.toLowerCase())))) {
      type = 'field'
    } else if (braceDepth > 0) {
      type = looksNumeric(word) ? 'number' : 'word'
    } else if (inFilterCtx() && ['and', 'or', 'not'].includes(lower) && !nextIs(':')) {
      type = 'keyword'
    } else if (inFilterCtx() && nextIs(':')) {
      type = 'field'
    } else if (inFilterCtx() && (lower === 'in' || lower === 'not_in') && nextIs('(')) {
      type = 'keyword'
    } else if (nextGluedParen && FILTER_FUNCS.has(lower) && inFilterCtx()) {
      type = 'keyword'
    } else if (pipe === 'stats' && !parens.includes('if') && top() !== 'statsFn' && top() !== 'by' && nextIs('(') && !['by', 'if'].includes(lower)) {
      type = STATS_FUNCS.has(lower) ? 'statsFn' : 'error'
    } else if (pipe && (PIPE_KEYWORDS[pipe] || []).includes(lower) && top() !== 'by' && top() !== 'statsFn') {
      type = 'keyword'
      if (lower === 'as') afterAs = true
    } else if (math && nextGluedParen && MATH_FUNCS.has(lower)) {
      type = 'keyword'
    } else if (looksNumeric(word)) {
      type = 'number'
    } else if (top() === 'by' || top() === 'statsFn' || FIELD_LIST_PIPES.has(pipe) || math) {
      type = 'field'
    } else {
      type = 'word'
    }
    if (type !== 'keyword' || lower !== 'as') afterAs = afterAs && type === 'keyword'
    push(type, t.start, end)
    prevWord = lower
  }
  return out
}
