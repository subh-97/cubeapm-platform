// Query generators for the Explore editors — Metrics Quick, Metrics Advanced,
// the Logs/Traces Builder — and the conversion that carries a query from our
// Logs and Traces pages into Explore.
//
// The three generators are ports of the playground's (the Quick effect in GWn,
// KWn's compose effect with V2, and oce / qWe / MWn for LogsQL) and stay
// byte-for-byte with it. A generated query gets copied into the playground,
// into alert rules, into a colleague's chat; "the same clicks produce the same
// text" is the contract, so quirks that look wrong are kept on purpose — a label
// picked with no value still emits `label=""`, an empty Advanced number input
// still emits `round(Q, )`. Where a spec flags a reference BUG, the fix is
// marked `FIX:` with its reason; nothing else departs.
//
// Models are plain data (ExploreView keeps page state serialisable). A pair's
// `options` — the fetched value suggestions — is UI state and never read here.

import { QUICK_LABELS, LOGS_STATS_FUNCTIONS } from './catalogs.js'

// ---------- Quoting (reference `me`, `qN`) ----------

const QUOTE_ESCAPES = /[\\"]/g
const REGEX_META = /[.*+?^${}()|[\]\\"'<>-]/g

/** A double-quoted literal with `\` and `"` escaped — valid in PromQL and LogsQL. */
export function quoteString(s) {
  return `"${String(s ?? '').replace(QUOTE_ESCAPES, '\\$&')}"`
}

/**
 * "Any of these values" as one quoted regex: each value regex-escaped, joined
 * with `|`, then quoted — so every escaping backslash comes out doubled
 * (`['a-b', 'c']` → `"a\\-b|c"`), which is what the string literal needs to
 * hand the engine `a\-b|c`. Pick order is kept; the values are not sorted.
 */
export function quoteAlternation(values) {
  return quoteString((values ?? []).map(v => String(v).replace(REGEX_META, '\\$&')).join('|'))
}

// ---------- Filter rows (shared by every WHERE / STREAM / FIELDS editor) ----------

/** A fresh empty row: no label, "equals", no value. */
export function emptyPair() {
  return { label: '', operator: '=', values: [] }
}

const isMultiOp = op => op.endsWith('~')

/**
 * Switching operator keeps every value when going to in / not in, and only the
 * first when going to equals / not equals: a single select shows one value,
 * and a second one it cannot show must not linger in the model.
 */
export function changeOperator(pair, operator) {
  const values = pair.values ?? []
  return {
    ...pair,
    operator,
    values: isMultiOp(operator) || !values.length ? values : [values[0]],
  }
}

/** Picking a different label clears the values (they belonged to the old one). */
export function changeLabel(pair, label) {
  return { ...pair, label, values: [], ...(pair.options ? { options: [] } : null) }
}

/**
 * One PromQL matcher (reference `Gpt`): `service="a"`, `service=~"a|b"`. The
 * label is never quoted. A row with a label but no value is NOT skipped — it
 * emits `service=""`, which PromQL reads as "has no service label" and which
 * usually empties the result. That is the reference behaviour, kept so a
 * query built here matches one built there; the rows UI explains it.
 */
export function labelMatcher(pair) {
  const operator = pair.operator ?? '='
  const values = pair.values ?? []
  const rhs = isMultiOp(operator) ? quoteAlternation(values) : quoteString(values[0] || '')
  return `${pair.label}${operator}${rhs}`
}

// ---------- Metrics: SELECT operations (reference V2) ----------

/**
 * Wraps `query` in one operation. Aggregation args become `by (…)` AFTER the
 * closing paren; number args go before the inner query (`position: 'before'`)
 * or after it. `*` and `/` are bare infix operators with no parentheses — they
 * share precedence and associate left, so a chain still reads left to right.
 * Values are inserted verbatim: an empty input really does emit `round(Q, )`.
 */
export function applyOperation(query, op) {
  let before = ''
  let after = ''
  let by = ''
  for (const arg of op.args ?? []) {
    switch (arg.type) {
      case 'aggregation': {
        const labels = (arg.value ?? []).join(', ')
        by = labels && ` by (${labels})`
        break
      }
      case 'number': {
        // An arg straight from the catalog has no `value` yet; the picker would
        // have seeded it with its default, so render what the picker would.
        const v = arg.value ?? arg.default ?? 0
        if (arg.position === 'before') before += `${v}, `
        else after += `, ${v}`
        break
      }
      default:
        throw new Error(`Unknown arg type: ${arg.type}`)
    }
  }
  return op.type === 'operator'
    ? `${query} ${op.value} ${after.slice(1).trim()}`
    : `${op.value}(${before}${query}${after})${by}`
}

/**
 * A catalog option as the Advanced picker appends it: group-bys start empty,
 * number args start at their default (a string) or, without one, the number 0.
 */
export function newOperation(option) {
  return {
    ...option,
    label: '',
    args: (option.args ?? []).map(a => ({
      ...a,
      value: a.type === 'aggregation' ? [] : (a.default ?? 0),
    })),
  }
}

const RATE = { value: 'rate', args: [] }
const INCREASE = { value: 'increase', args: [] }
const sumBy = labels => ({ value: 'sum', args: [{ type: 'aggregation', value: labels }] })
const wrap = (base, ...ops) => ops.reduce(applyOperation, base)

// ---------- Metrics: Quick ----------

// Every Quick query — and every value lookup — is scoped to incoming work.
const QUICK_SPAN_KIND = 'span_kind=~"server|consumer"'
const QUICK_VALUE_METRIC = '__name__="cube_apm_calls_total"'

const PERCENTILE_TEXT = /^[+-]?((\d{1,8})|(\.\d{1,6})|(\d{1,8}\.\d{0,6}))$/

/**
 * The percentile input's validator (reference `bh`): plain decimal text only —
 * no exponent, at most 8 integer and 6 fractional digits — and deliberately NO
 * range check, so `150` is accepted and produces quantile 1.5. Returns the
 * number, or undefined when the text is not one.
 */
export function parsePercentile(text) {
  const s = String(text ?? '')
  if (!PERCENTILE_TEXT.test(s)) return undefined
  const n = parseFloat(s)
  return Number.isFinite(n) ? n : undefined
}

const isSpecialLabel = label => !!QUICK_LABELS.find(l => l.label === label)?.isSpecial

// Reference `m(excludeSpecial)`: the rows in order, then the span-kind scope.
function quickMatchers(labelPairs, excludeSpecial) {
  const out = (labelPairs ?? [])
    .filter(p => p.label && (!excludeSpecial || !isSpecialLabel(p.label)))
    .map(labelMatcher)
  out.push(QUICK_SPAN_KIND)
  return out
}

/**
 * Quick model → PromQL, or '' while incomplete (no CALCULATE yet, or a
 * percentile that does not parse). Latency is in seconds; `latencyInMs` is the
 * alert pages' variant and appends ` * 1000`.
 */
export function buildQuickQuery(model, { latencyInMs = false } = {}) {
  if (!model?.calculate) return ''
  const groupBy = model.groupBy ?? []
  const filters = quickMatchers(model.labelPairs, false).join(', ')
  const ms = latencyInMs ? ' * 1000' : ''

  switch (model.calculate) {
    case 'rpm':
      return `${wrap(`cube_apm_calls_total{${filters}} default 0`, RATE, sumBy(groupBy))} * 60`

    case 'error_percentage': {
      const errors = wrap(
        `cube_apm_calls_total{${[filters, 'status_code="ERROR"'].join(', ')}} default 0`,
        INCREASE, sumBy(groupBy),
      )
      // http_code / exception exist only on error series, so the denominator
      // (all calls) can neither filter nor group by them: it drops those
      // filters, groups by the rest, and `ignoring … group_left` matches the
      // finer-grained numerator onto it.
      const plain = groupBy.filter(l => !isSpecialLabel(l))
      const special = groupBy.filter(isSpecialLabel)
      const calls = wrap(
        `cube_apm_calls_total{${quickMatchers(model.labelPairs, true).join(', ')}} default 0`,
        INCREASE, sumBy(plain),
      )
      const ignoring = special.length ? ` ignoring (${special.join(',')}) group_left` : ''
      return `${errors} * 100 /${ignoring} ${calls}`
    }

    case 'latency_percentile': {
      // A model without a value is one the tab never produced; the tab's own
      // starting value is 90, so read it as that rather than as "invalid".
      const p = parsePercentile(model.value ?? '90')
      if (p === undefined) return ''
      // Not rounded: 99.9 → 0.9990000000000001, exactly as the reference prints it.
      const quantile = { value: 'histogram_quantile', args: [{ type: 'number', value: `${p / 100}`, position: 'before' }] }
      return wrap(
        `cube_apm_latency_bucket{${filters}} default 0`,
        INCREASE, sumBy([...groupBy, 'vmrange']), quantile,
      ) + ms
    }

    case 'latency_average': {
      const latency = wrap(`cube_apm_latency_total{${filters}} default 0`, INCREASE, sumBy(groupBy))
      const calls = wrap(`cube_apm_calls_total{${filters}} default 0`, INCREASE, sumBy(groupBy))
      return `${latency}${ms} / ${calls}`
    }

    // FIX: the reference throws on an unknown option. A model can arrive from
    // another page, and one bad field must not take the editor down with it.
    default:
      return ''
  }
}

/**
 * The `match[]` for fetching row `rowIndex`'s value options. Only the rows
 * ABOVE narrow it (the row itself and those below never do), and always on
 * `cube_apm_calls_total` — even for latency — as in the reference.
 */
export function quickMatchFor(labelPairs, rowIndex) {
  const earlier = (labelPairs ?? []).slice(0, rowIndex).filter(p => p.label).map(labelMatcher)
  return [`{${[QUICK_VALUE_METRIC, QUICK_SPAN_KIND, ...earlier].join(', ')}}`]
}

// ---------- Metrics: Advanced ----------

// A name PromQL accepts bare. MetricsQL allows dots, so `http.server.duration`
// qualifies; `my-metric` does not and is selected through `__name__`.
const BARE_METRIC = /^[a-zA-Z][a-zA-Z0-9_:.]*$/

/**
 * Advanced model → PromQL: metric, `{matchers}` when there are any, then each
 * operation wrapping the query so far (the first one added is innermost).
 * '' until a metric is picked. Range functions carry no `[window]` — MetricsQL
 * supplies it.
 */
export function buildAdvancedQuery(model) {
  const metric = model?.metric
  if (!metric) return ''
  const matchers = (model.labelPairs ?? []).filter(p => p.label).map(labelMatcher)
  let query = ''
  if (BARE_METRIC.test(metric)) query = metric
  else matchers.unshift(`__name__=${quoteString(metric)}`)
  if (matchers.length) query += `{${matchers.join(', ')}}`
  try {
    return (model.functions ?? []).reduce(applyOperation, query)
  } catch {
    // Only an arg type the catalog never produces lands here — a malformed
    // incoming model. Treat it as incomplete rather than guessing.
    return ''
  }
}

/** The `match[]` for row `rowIndex`'s value options: the metric plus the rows above. */
export function advancedMatchFor(metric, labelPairs, rowIndex) {
  const earlier = (labelPairs ?? []).slice(0, rowIndex).filter(p => p.label).map(labelMatcher)
  return [`{${[`__name__=${quoteString(metric ?? '')}`, ...earlier].join(', ')}}`]
}

// ---------- Logs/Traces: Builder ----------

// Field names LogsQL takes bare: `log.level`, `http.status_code`, `_msg`.
const PLAIN_FIELD = /^[A-Za-z_][A-Za-z0-9_.]*$/
const LOGSQL_OPERATOR_WORDS = new Set(['and', 'or', 'not'])

/**
 * FIX (spec B4): the reference writes FIELDS names and stats arguments bare, so
 * a real field such as `compact-revision` produced a query that does not parse.
 * Names that are not plain identifiers — or that read as AND / OR / NOT — are
 * quoted; everything the reference could already express is unchanged.
 */
export function quoteFieldName(name) {
  const s = String(name ?? '')
  return PLAIN_FIELD.test(s) && !LOGSQL_OPERATOR_WORDS.has(s.toLowerCase()) ? s : quoteString(s)
}

/**
 * STREAM rows → `{"service"="order","env"!="x"}` (reference `oce`). Names are
 * always quoted, pieces joined with a bare comma; in / not in become a regex
 * alternation. '' when no row has a label.
 */
export function streamSelector(pairs) {
  const body = (pairs ?? [])
    .filter(p => p.label)
    .map(p => {
      const operator = p.operator ?? '='
      const values = p.values ?? []
      const rhs = isMultiOp(operator) ? quoteAlternation(values) : quoteString(values[0] || '')
      return `${quoteString(p.label)}${operator}${rhs}`
    })
    .join(',')
  return body ? `{${body}}` : ''
}

/**
 * One FIELDS row (reference `qWe`): `f:="v"`, `NOT f:="v"`, `f:in("a","b")`,
 * `NOT f:in("a","b")`. Unlike the stream form, in-lists are exact values — no
 * regex escaping — and the list is joined with a bare comma.
 */
export function fieldFilter(pair) {
  const operator = pair.operator ?? '='
  const values = pair.values ?? []
  const negated = operator.startsWith('!')
  let op = operator.slice(negated ? 1 : 0)
  if (op.endsWith('~')) op = 'in'
  const rhs = op === 'in' ? `(${values.map(quoteString).join(',')})` : quoteString(values[0] || '')
  return `${negated ? 'NOT ' : ''}${quoteFieldName(pair.label)}:${op}${rhs}`
}

const STATS_FN = Object.fromEntries(LOGS_STATS_FUNCTIONS.map(f => [f.value, f]))

/** The default aggregate a stats card starts with, and "Add function" appends. */
export function newStatsAgg() {
  return { fn: 'count', args: [''], filter: '', alias: '' }
}

/** What the add-pipe select appends (reference `Tun`). */
export function newLogsqlPipe(kind) {
  if (kind === 'math') return { value: 'math', expr: '', alias: '' }
  return { value: 'stats', by: [], aggs: [newStatsAgg()] }
}

/**
 * Changing an aggregate's function re-seeds its arguments from the new
 * function's spec, so a picked field clears and quantile returns to 0.9.
 */
export function withStatsFunction(agg, fn) {
  const spec = STATS_FN[fn]
  return { ...agg, fn, args: spec ? spec.args.map(a => a.default ?? '') : [''] }
}

function statsArg(spec, index, arg) {
  const s = arg == null ? '' : String(arg)
  if (!s) return ''
  return spec?.args[index]?.type === 'field' ? quoteFieldName(s) : s
}

function statsPipeToString(pipe) {
  const by = pipe.by?.length ? ` by (${pipe.by.map(quoteString).join(', ')})` : ''
  // FIX: a stats pipe with no aggregate would emit `| stats ` and fail to parse.
  // The card never allows that, but an incoming model can; grouping on its own
  // means "how many per group", the same reading the Logs page gives it.
  const aggs = pipe.aggs?.length ? pipe.aggs : [newStatsAgg()]
  const text = aggs.map(({ fn, args = [], filter = '', alias = '' }) => {
    const spec = STATS_FN[fn]
    const argText = args.map((a, i) => statsArg(spec, i, a)).join(', ')
    // FIX: a whitespace-only "if" or "as" emitted `if ( )` / `as " "`.
    const cond = String(filter ?? '').trim()
    const name = String(alias ?? '').trim()
    return `${fn}(${argText})${cond ? ` if (${cond})` : ''}${name ? ` as ${quoteString(name)}` : ''}`
  }).join(', ')
  return `| stats${by} ${text}`
}

function mathPipeToString(pipe) {
  const expr = String(pipe.expr ?? '').trim()
  if (!expr) return ''
  const name = String(pipe.alias ?? '').trim()
  return `| math ${expr}${name ? ` as ${quoteString(name)}` : ''}`
}

/** One pipe (reference `MWn`). '' for a pipe that contributes nothing. */
export function pipeToString(pipe) {
  switch (pipe?.value) {
    case 'stats': return statsPipeToString(pipe)
    case 'math':  return mathPipeToString(pipe)
    // FIX: the reference throws on an unknown pipe; an incoming model must not.
    default:      return ''
  }
}

/**
 * Builder model → LogsQL: stream selector, FIELDS filters (space = AND), then
 * the pipes in the order they were added. With pipes and no filter, the query
 * starts from `*`. '' when nothing is set.
 */
export function buildLogsqlQuery(model) {
  if (!model) return ''
  const stream = streamSelector(model.streamPairs)
  const fields = (model.labelPairs ?? []).filter(p => p.label).map(fieldFilter)
  // FIX (spec B3): an empty math pipe still took part in the join, leaving a
  // trailing space or a double one. Empty pipes are skipped.
  const pipes = (model.pipes ?? []).map(pipeToString).filter(Boolean)
  const filter = [stream, ...fields].filter(Boolean).join(' ')
  if (!pipes.length) return filter
  return `${filter || '*'} ${pipes.join(' ')}`
}

/**
 * The query that narrows row `rowIndex`'s value options. A STREAM row is
 * narrowed by the stream rows above it; a FIELDS row by every stream row plus
 * the FIELDS rows above it. `section` is 'stream' or 'fields'.
 *
 * FIX (spec B1): with no stream filter the reference sent `" "` for the first
 * FIELDS row, which the server rejects — so that row never had any values.
 * An empty narrowing is `*`.
 */
export function logsqlValueQueryFor(model, section, rowIndex) {
  if (section === 'stream') {
    return streamSelector((model?.streamPairs ?? []).slice(0, rowIndex)) || '*'
  }
  const earlier = (model?.labelPairs ?? []).slice(0, rowIndex).filter(p => p.label).map(fieldFilter)
  return [streamSelector(model?.streamPairs), ...earlier].filter(Boolean).join(' ') || '*'
}

// ---------- Starting models ----------

/**
 * Sidebar arrival: RPM by service, committed on mount so the page opens on a
 * chart (CLAUDE.md rule 5) — the reference opens on an empty CALCULATE.
 */
export function defaultQuickModel() {
  return { type: 'quick', calculate: 'rpm', value: '90', labelPairs: [emptyPair()], groupBy: ['service'] }
}

export function defaultAdvancedModel() {
  return { type: 'advanced', metric: '', labelPairs: [emptyPair()], functions: [] }
}

/**
 * First visit to Logs or Traces: a count per host (logs) or per service
 * (traces), so the datasource opens on a chart instead of an empty Builder.
 *
 * Logs group by `host.name` rather than the more obvious `log.level` because a
 * default must group by something every row has. Only about a fifth of log
 * records are application logs carrying a level; the rest are platform noise —
 * k8s container logs, k8s events, browser events — and grouping by level puts
 * all of them in one unlabelled bucket four times the size of the real series.
 * `host.name` is on every record, so the first chart is all signal.
 */
export function defaultBuilderModel(datasource) {
  const stats = newLogsqlPipe('stats')
  stats.by = [datasource === 'traces' ? 'service' : 'host.name']
  return { type: 'builder', streamPairs: [emptyPair()], labelPairs: [emptyPair()], pipes: [stats] }
}

// ---------- Logs/Traces page → Explore ----------
//
// Our Logs and Traces pages spell queries in their own chip dialect
// (QueryBuilder `chipsToString` + pipes.js `composeQuery`). It is LogsQL-shaped
// but differs where it matters to the reference grammar Explore runs:
//
//   our pages                         reference LogsQL
//   {service="a", env="b"}            {"service"="a","env"="b"}
//   {service in ("a-b", "c")}         {"service"=~"a\\-b|c"}       (regex-escaped)
//   {service not_in ("a")}            {"service"!~"a"}
//   f:=v                              f:="v"
//   f!=v                              NOT f:="v"
//   f!~"re"                           NOT f:~"re"
//   f in ("a", "b")                   f:in("a","b")
//   f not_in ("a")                    NOT f:in("a")
//   f:/v1/x          (word)           f:"/v1/x"                    (not one LogsQL word)
//   compact-rev:=x                    "compact-rev":="x"
//   a OR b AND c     (left to right)  (a OR b) AND c               (LogsQL: AND binds first)
//
// Everything else — f:word, f:v*, f:*v*, f:"phrase", f:~"re", f:*, f:"",
// comparisons, AND / OR, groups, the stats and math pipes — is already spelled
// the same and passes through (values re-escaped). A filter the converter does
// not understand is passed through untouched rather than guessed at: text that
// already is LogsQL has to survive the trip.
//
// Pipes change in two ways. A stats `if (…)` filter is converted like the main
// filter. And row-shaping pipes are dropped: on the Logs page they trim the
// table, on a graph they mean nothing, and the graph endpoint refuses them
// (sort / limit / fields before stats "may modify or delete `_time`"; limit /
// top after it). The graph shows every series and its legend does the ranking.
// Finally ` | stats count()` is appended only when no stats pipe is left
// (the reference appends it always and double-counts, spec E7).

class Unconvertible extends Error {}
const giveUp = () => { throw new Unconvertible() }

class Scan {
  constructor(s) { this.s = s; this.i = 0 }
  get eof() { return this.i >= this.s.length }
  peek(n = 0) { return this.s[this.i + n] }
  ws() { while (!this.eof && /\s/.test(this.s[this.i])) this.i++ }
  at(text) { return this.s.slice(this.i, this.i + text.length).toLowerCase() === text }
  // A keyword is the word followed by whitespace, `(` or the end — `order:x`
  // is not `or`.
  atKeyword(word) { return this.at(word) && /^(?:[\s(]|$)/.test(this.s.slice(this.i + word.length)) }
  // `in` / `not_in` introduce a list only when a `(` follows.
  atListWord(word) { return this.at(word) && /^\s*\(/.test(this.s.slice(this.i + word.length)) }
}

// Quoted text, reading `\"` and `\\` as escapes and any other backslash as
// itself: our chips write values raw (`service=~"a\.b"` means the regex
// `a\.b`), LogsQL escapes them — honouring only the two escapes both agree on
// reads either spelling correctly.
function readQuoted(sc) {
  const quote = sc.peek()
  sc.i++
  let out = ''
  while (!sc.eof && sc.peek() !== quote) {
    const c = sc.peek()
    if (c === '\\' && (sc.peek(1) === quote || sc.peek(1) === '\\')) { out += sc.peek(1); sc.i += 2; continue }
    out += c
    sc.i++
  }
  if (sc.eof) giveUp()
  sc.i++
  return out
}

const isQuote = c => c === '"' || c === "'"

function readWhile(sc, stop) {
  const start = sc.i
  while (!sc.eof && !stop.test(sc.peek())) sc.i++
  return sc.s.slice(start, sc.i)
}

// Values may contain `*` and `:` (wildcards, URLs); only structure ends one.
const readBare = sc => readWhile(sc, /[\s(){},|]/)
const readName = sc => readWhile(sc, /[\s(){},|:!=~"']/)
const readValue = sc => (isQuote(sc.peek()) ? readQuoted(sc) : readBare(sc))

function readList(sc) {
  sc.ws()
  if (sc.peek() !== '(') giveUp()
  sc.i++
  const out = []
  for (;;) {
    sc.ws()
    if (sc.eof) giveUp()
    if (sc.peek() === ')') { sc.i++; return out }
    if (sc.peek() === ',') { sc.i++; continue }
    // `""` is a real (empty) value; an empty bare read means stray punctuation.
    const quoted = isQuote(sc.peek())
    const v = quoted ? readQuoted(sc) : readBare(sc)
    if (!quoted && !v) giveUp()
    out.push(v)
  }
}

// A word value LogsQL reads as one word stays bare; anything with punctuation
// is quoted, which LogsQL reads as a phrase — the same tokens, in order.
const ONE_WORD = /^[\p{L}\p{N}_]+$/u
const wordValue = v => (ONE_WORD.test(v) ? v : quoteString(v))

const LIST_OPERATORS = [['not_in', true], ['not in', true], ['in', false]]
const STREAM_LIST_OPERATORS = [['not_in', '!~'], ['not in', '!~'], ['in', '=~']]
const STREAM_OPERATORS = ['=~', '!~', '!=', '=']

function readStream(sc) {
  sc.i++ // {
  const parts = []
  for (;;) {
    sc.ws()
    if (sc.eof) giveUp()
    if (sc.peek() === '}') { sc.i++; break }
    if (sc.peek() === ',') { sc.i++; continue }
    const name = isQuote(sc.peek()) ? readQuoted(sc) : readWhile(sc, /[\s{},=!~"']/)
    if (!name) giveUp()
    sc.ws()
    const list = STREAM_LIST_OPERATORS.find(([word]) => sc.atListWord(word))
    if (list) {
      sc.i += list[0].length
      parts.push(`${quoteString(name)}${list[1]}${quoteAlternation(readList(sc))}`)
      continue
    }
    const op = STREAM_OPERATORS.find(o => sc.at(o))
    if (!op) giveUp()
    sc.i += op.length
    sc.ws()
    const value = isQuote(sc.peek()) ? readQuoted(sc) : readWhile(sc, /[\s{},|]/)
    parts.push(`${quoteString(name)}${op}${quoteString(value)}`)
  }
  return parts.length ? `{${parts.join(',')}}` : ''
}

// Everything after `field:`. Returns { text, negated }.
function fieldTerm(sc, name) {
  const f = quoteFieldName(name)
  const c = sc.peek()
  if (c === '=') {
    sc.i++
    const text = `${f}:=${quoteString(readValue(sc))}`
    if (sc.peek() === '*') { sc.i++; return { text: `${text}*` } }
    return { text }
  }
  if (c === '~') { sc.i++; return { text: `${f}:~${quoteString(readValue(sc))}` } }
  if (c === '!') {
    if (sc.at('!=')) { sc.i += 2; return { text: `${f}:=${quoteString(readValue(sc))}`, negated: true } }
    if (sc.at('!~')) { sc.i += 2; return { text: `${f}:~${quoteString(readValue(sc))}`, negated: true } }
    giveUp()
  }
  if (sc.atListWord('in')) {
    sc.i += 2
    return { text: `${f}:in(${readList(sc).map(quoteString).join(',')})` }
  }
  if (c === '>' || c === '<') {
    const body = readBare(sc)
    return { text: `${f}:${body}` }
  }
  if (isQuote(c)) {
    const v = readQuoted(sc)
    if (sc.peek() === '*') { sc.i++; return { text: `${f}:${quoteString(v)}*` } }
    return { text: `${f}:${quoteString(v)}` }
  }
  if (c === '*') {
    sc.i++
    if (isQuote(sc.peek())) {
      const v = readQuoted(sc)
      if (sc.peek() === '*') sc.i++
      return { text: `${f}:*${quoteString(v)}*` }
    }
    const body = readBare(sc)
    if (!body) return { text: `${f}:*` }
    return { text: `${f}:*${wordValue(body.endsWith('*') ? body.slice(0, -1) : body)}*` }
  }
  const body = readBare(sc)
  if (!body) giveUp()
  if (body.length > 1 && body.endsWith('*')) return { text: `${f}:${wordValue(body.slice(0, -1))}*` }
  return { text: `${f}:${wordValue(body)}` }
}

// One operand. Returns { text } (always atomic) or null for an empty `{}`.
function readPrimary(sc, depth) {
  const c = sc.peek()
  if (c === '(') {
    sc.i++
    const inner = readTerms(sc, depth + 1)
    sc.ws()
    if (!inner || sc.peek() !== ')') giveUp()
    sc.i++
    // A lone term needs no bracket; a group keeps its own.
    return { text: inner.top === 'atom' ? inner.text : `(${inner.text})` }
  }
  if (c === '{') {
    const text = readStream(sc)
    return text ? { text } : null
  }
  if (isQuote(c)) {
    const v = readQuoted(sc)
    if (sc.peek() === ':') { sc.i++; return fieldTerm(sc, v) }
    if (sc.peek() === '*') { sc.i++; return { text: `${quoteString(v)}*` } }
    return { text: quoteString(v) }
  }
  if (c === '*' && (sc.i + 1 >= sc.s.length || /[\s()|]/.test(sc.peek(1)))) { sc.i++; return { text: '*' } }

  const name = readName(sc)
  if (!name) giveUp()
  const afterName = sc.i
  sc.ws()
  const list = LIST_OPERATORS.find(([word]) => sc.atListWord(word))
  if (list) {
    sc.i += list[0].length
    return { text: `${quoteFieldName(name)}:in(${readList(sc).map(quoteString).join(',')})`, negated: list[1] }
  }
  sc.i = afterName
  if (sc.peek() === ':') { sc.i++; return fieldTerm(sc, name) }
  if (sc.at('!=')) { sc.i += 2; return { text: `${quoteFieldName(name)}:=${quoteString(readValue(sc))}`, negated: true } }
  if (sc.at('!~')) { sc.i += 2; return { text: `${quoteFieldName(name)}:~${quoteString(readValue(sc))}`, negated: true } }
  if (/[=~!]/.test(sc.peek() ?? '')) giveUp()
  // A bare word or `word*` over the message: already the reference spelling.
  return { text: name }
}

// An operand with its prefix negations (`NOT`, `!`, `-`). A converted `f!=v`
// arrives already negated, so negating it again cancels out. Returns
// { text, top: 'atom' } or null for an empty `{}`.
function readUnary(sc, depth) {
  let negated = false
  for (;;) {
    sc.ws()
    if (sc.atKeyword('not')) { sc.i += 3; negated = !negated; continue }
    const next = sc.peek(1) ?? ''
    if (sc.peek() === '!' && next !== '=' && next !== '~') { sc.i++; negated = !negated; continue }
    if (sc.peek() === '-' && /[\p{L}_"'({]/u.test(next)) { sc.i++; negated = !negated; continue }
    break
  }
  if (sc.eof) giveUp()
  const term = readPrimary(sc, depth)
  // Something glued straight onto a term — `f:i(foo)`, `_time:[a,b)` — is a
  // construct this reader does not know; splitting it would change its meaning.
  if (!sc.eof && !/[\s)]/.test(sc.peek())) giveUp()
  if (!term) {
    if (negated) giveUp()
    return null
  }
  return { text: negated !== !!term.negated ? `NOT ${term.text}` : term.text, top: 'atom' }
}

// A run of operands joined by AND / OR (a space is AND), up to the end or the
// `)` closing this group. Returns { text, top } — `top` is the loosest
// operator at the outermost level, which decides whether it needs brackets.
function readTerms(sc, depth) {
  const items = []
  let pending = null
  for (;;) {
    sc.ws()
    if (sc.eof) break
    if (sc.peek() === ')') {
      if (depth === 0) giveUp()
      break
    }
    const connector = sc.atKeyword('and') ? 'AND' : sc.atKeyword('or') ? 'OR' : null
    if (connector) {
      if (!items.length || pending) giveUp()
      sc.i += connector.length
      pending = connector
      continue
    }
    const term = readUnary(sc, depth)
    if (!term) continue
    items.push({ connector: pending ?? 'AND', explicit: pending !== null, term })
    pending = null
  }
  if (pending) giveUp()
  if (!items.length) return null

  let acc = { text: items[0].term.text, top: 'atom' }
  for (const { connector, explicit, term } of items.slice(1)) {
    if (connector === 'OR') {
      acc = { text: `${acc.text} OR ${term.text}`, top: 'or' }
      continue
    }
    // Our pages evaluate a chip list strictly left to right; LogsQL binds AND
    // before OR. An AND that follows an OR therefore needs a bracket to mean
    // what the page meant: `a OR b AND c` there is `(a OR b) AND c`.
    const left = acc.top === 'or' ? `(${acc.text})` : acc.text
    acc = { text: `${left}${explicit ? ' AND ' : ' '}${term.text}`, top: 'and' }
  }
  return acc
}

// The filter part of a query in reference spelling — or, when it holds
// something this reader does not know, exactly as given.
function convertFilter(text) {
  const src = String(text ?? '').trim()
  if (!src) return ''
  try {
    return readTerms(new Scan(src), 0)?.text ?? ''
  } catch (e) {
    if (e instanceof Unconvertible) return src
    throw e
  }
}

// Splits on `sep` outside quotes and brackets — a `|` inside a regex or an
// `if (…)` is not a pipe.
function splitTopLevel(s, sep) {
  const out = []
  let depth = 0
  let quote = null
  let start = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
      continue
    }
    if (isQuote(c) || c === '`') quote = c
    else if (c === '(' || c === '{' || c === '[') depth++
    else if (c === ')' || c === '}' || c === ']') depth = Math.max(0, depth - 1)
    else if (c === sep && depth === 0) { out.push(s.slice(start, i)); start = i + 1 }
  }
  out.push(s.slice(start))
  return out
}

function matchingParen(s, open) {
  let depth = 0
  let quote = null
  for (let i = open; i < s.length; i++) {
    const c = s[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
      continue
    }
    if (isQuote(c) || c === '`') quote = c
    else if (c === '(') depth++
    else if (c === ')' && --depth === 0) return i
  }
  return -1
}

// A stats stage with each `if (…)` filter converted like the main filter —
// people type those in the same dialect as the search bar.
function convertStatsFilters(stage) {
  let out = ''
  let last = 0
  let quote = null
  for (let i = 0; i < stage.length; i++) {
    const c = stage[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
      continue
    }
    if (isQuote(c) || c === '`') { quote = c; continue }
    if (!/^if\s*\(/i.test(stage.slice(i)) || (i > 0 && !/[\s)]/.test(stage[i - 1]))) continue
    const open = stage.indexOf('(', i)
    const close = matchingParen(stage, open)
    if (close === -1) return stage
    const inner = stage.slice(open + 1, close)
    out += `${stage.slice(last, open + 1)}${convertFilter(inner) || inner})`
    last = close + 1
    i = close
  }
  return out + stage.slice(last)
}

// Row-shaping pipes, dropped on the way in (see the block comment above).
const ROW_SHAPING_PIPES = new Set(['sort', 'order', 'limit', 'head'])
const REJECTED_BEFORE_STATS = new Set(['fields', 'keep'])
const REJECTED_AFTER_STATS = new Set(['top'])

/**
 * A Logs/Traces page query → the query Explore should open with, plus what
 * the conversion did: `dropped` lists the pipe stages removed (so the page can
 * say so), `addedCount` whether ` | stats count()` was appended.
 */
export function convertLogsQueryForExplore(query) {
  const text = String(query ?? '')
  try {
    const [head, ...rawStages] = splitTopLevel(text, '|')
    const stages = []
    const dropped = []
    let seenStats = false
    for (const raw of rawStages) {
      const stage = raw.trim()
      // `a | | b` or a trailing `|` still being typed: nothing to carry.
      if (!stage) continue
      const name = (/^[A-Za-z_]+/.exec(stage)?.[0] ?? '').toLowerCase()
      const rejected = seenStats ? REJECTED_AFTER_STATS : REJECTED_BEFORE_STATS
      // Our math serializer writes a bare `math` while the expression is empty.
      const emptyMath = name === 'math' && stage.length === 4
      if (ROW_SHAPING_PIPES.has(name) || rejected.has(name) || emptyMath) {
        dropped.push(stage)
        continue
      }
      if (name === 'stats') {
        seenStats = true
        stages.push(convertStatsFilters(stage))
        continue
      }
      stages.push(stage)
    }
    if (!seenStats) stages.push('stats count()')
    return { query: `${convertFilter(head) || '*'} | ${stages.join(' | ')}`, dropped, addedCount: !seenStats }
  } catch {
    // A bug here must not break the link that brought someone to Explore;
    // the unconverted query is still better than nothing.
    const trimmed = text.trim() || '*'
    const hasStats = /\|\s*stats\b/i.test(trimmed)
    return { query: hasStats ? trimmed : `${trimmed} | stats count()`, dropped: [], addedCount: !hasStats }
  }
}

/**
 * What "Open in Explore" on the Logs / Traces pages sends: the page query in
 * reference LogsQL, with ` | stats count()` appended only when it has no stats
 * pipe of its own.
 */
export function toExploreLogsQuery(query) {
  return convertLogsQueryForExplore(query).query
}
