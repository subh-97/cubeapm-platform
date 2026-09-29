// A small query language for filtering a table over a handful of named fields.
//
// Deliberately not the logs query builder: that one is a chip tree with pipes
// and an operator catalogue, and a two- or three-column table does not earn it.
// This is one line of text over a field set the caller supplies.
//
//   payment                    both fields, substring
//   pod:payment                one field
//   namespace:*                the field has any value
//   pod:(redis OR coredns)     a union — one field, several values
//   pod:redis AND namespace:default
//   pod:redis OR pod:coredns
//
// A column may also carry tags, which are searched through the column that
// owns them:
//
//   service.team:alpha         the service column's `team` tag is alpha
//   service.team:*             the service carries a team tag at all
//   service.team:(a OR b)      either
//
// `field.tag` rather than a bare `tag` because a tag name is only unique
// within its column: two columns can both carry `team`, and the table cannot
// guess which was meant. It also keeps tags from colliding with column names
// as either set grows.
//
// AND binds tighter than OR, which is what every other query language does and
// therefore what someone typing `a OR b AND c` expects. The logs builder's
// flat, precedence-free chip list is a different contract for a different
// input; matching it here would surprise more people than it would please.

// A field is `{ name, key, tags?, free? }`: what the user types, the row
// property it reads, and — when the column carries tags — the row property
// holding them. Name and key differ more often than not: the pod column is a
// row's `name`.
//
// `free: false` keeps a field out of plain-text search while leaving it
// addressable as `field:value`. A table with two or three columns wants every
// one of them searched by a bare word; a set built from a record's fifty
// attributes does not — free text would then match opaque ids and hashes, and
// a search for "500" would return rows whose container id merely contains it.
export const POD_FIELDS = [
  { name: 'pod', key: 'name', tags: 'labels' },
  { name: 'namespace', key: 'namespace' },
]
export const POD_NODE_FIELDS = [...POD_FIELDS, { name: 'node', key: 'node' }]

// One column, which is what makes this the simpler variant: nothing to
// disambiguate between, so the field prefix is optional in practice and most
// queries are a word. The tags are why it is a query at all now.
export const SERVICE_FIELDS = [
  { name: 'service', key: 'name', tags: 'tags' },
]

const namesOf = (fields) => fields.map(f => f.name)
const fieldFor = (fields, name) => fields.find(f => f.name === name)
const taggedFields = (fields) => fields.filter(f => f.tags)

// Resolves the word before a colon. Either a column, or a column's tag written
// `column.tag`. Split on the FIRST dot only: tag names commonly contain dots
// themselves (`k8s.app`), while no column name does.
function resolveRef(raw, fields) {
  const direct = fieldFor(fields, raw)
  if (direct) return { field: direct.name, tag: null }
  const dot = raw.indexOf('.')
  if (dot <= 0) return null
  const owner = fieldFor(fields, raw.slice(0, dot))
  const tag = raw.slice(dot + 1)
  if (!owner || !owner.tags || !tag) return null
  return { field: owner.name, tag }
}

// "pod or namespace", "pod, namespace or node" — the phrasing an error uses to
// say what it will accept.
//
// Capped, because the field set is not always a table's two or three columns:
// searching a record's attributes there are dozens, and naming all of them
// turns "unknown field" into a paragraph nobody reads. A handful plus a count
// still says what shape a field name takes, which is the part that helps.
const NAME_LIST_MAX = 6

function listNames(fields) {
  const n = namesOf(fields)
  if (n.length <= 1) return n[0] ?? ''
  if (n.length > NAME_LIST_MAX) {
    return `${n.slice(0, NAME_LIST_MAX).join(', ')} and ${n.length - NAME_LIST_MAX} more`
  }
  return `${n.slice(0, -1).join(', ')} or ${n[n.length - 1]}`
}

// The placeholder is now the only place the syntax is taught, so it is built
// from the field set rather than written out at each call site: every table
// with more than one searchable column then advertises the same form, and
// adding a column cannot leave a stale example behind.
export function placeholderFor(fields = POD_FIELDS) {
  const [a, b] = namesOf(fields)
  const tagged = taggedFields(fields)[0]
  const example = tagged
    ? `${a}:abc ${b ? 'AND' : 'or'} ${tagged.name}.tag:value`
    : b
      ? `${a}:abc AND ${b}:def`
      : `${a}:abc`
  return `Search ${listNames(fields)} ( eg. ${example} )`
}

export class PodQueryError extends Error {
  // `span` is [start, end) over the raw text: the characters to underline.
  // Null when the complaint is about text that is not there yet — a query that
  // stops mid-clause — which the caller widens to the whole line.
  //
  // `incomplete` separates the two kinds of wrong. A query that simply ran out
  // — `pod:`, `a AND`, `pod:(a` — is on its way somewhere, and the next
  // keystroke may well finish it. Anything else is a mistake already made:
  // more typing at the end will not repair an unknown field or a stray ")".
  // The field uses the difference to decide how loudly to say so.
  constructor(msg, span = null, incomplete = false) {
    super(msg)
    this.name = 'PodQueryError'
    this.span = span
    this.incomplete = incomplete
  }
}

// ---------- Tokenizer ----------

const isWordChar = (c) => c && !/[\s():]/.test(c)

function tokenize(input) {
  const out = []
  let i = 0
  const s = input ?? ''
  while (i < s.length) {
    const c = s[i]
    if (/\s/.test(c)) { i++; continue }
    if (c === '(' || c === ')' || c === ':') { out.push({ t: c, at: i }); i++; continue }
    let start = i
    while (i < s.length && isWordChar(s[i])) i++
    const word = s.slice(start, i)
    const upper = word.toUpperCase()
    if (upper === 'AND' || upper === 'OR') out.push({ t: upper, at: start })
    else out.push({ t: 'word', value: word, at: start })
  }
  return out
}

// ---------- Parser ----------
// query := or ; or := and (OR and)* ; and := term (AND? term)*

// Every error points at the token it is about, so the field can squiggle those
// characters and nothing else.
const spanOf = (tok) => [tok.at, tok.at + String(tok.value ?? tok.t).length]

// `pod.` and `namespace.team` fail for different reasons than `foo` does, and
// being told "unknown field" for a column that exists but carries no tags
// sends someone looking in the wrong place.
function unknownRef(raw, typed, fields) {
  const dot = raw.indexOf('.')
  if (dot > 0) {
    const owner = fieldFor(fields, raw.slice(0, dot))
    if (owner && !owner.tags) return `"${owner.name}" has no tags to search.`
    if (owner && !raw.slice(dot + 1)) return `Nothing after "${owner.name}." — name the tag, as in ${owner.name}.team:alpha.`
  }
  const tagged = taggedFields(fields)[0]
  const tagHint = tagged ? ` Tags are searched as ${tagged.name}.tag:value.` : ''
  return `Unknown field "${typed}". Search ${listNames(fields)}.${tagHint}`
}

function parseTokens(tokens, fields) {
  let pos = 0
  const peek = () => tokens[pos]
  const eat = () => tokens[pos++]

  // `head` is the extent of the `pod:` part, which is what a missing value is
  // really a complaint about. `label` is what the user actually typed there —
  // `pod` or `service.team` — so the advice quotes their text back.
  function parseValue(ref, head, label) {
    const tok = peek()
    if (!tok) throw new PodQueryError(`Nothing after "${label}:" — add a value, or ${label}:* for any.`, head, true)

    if (tok.t === '(') {
      const open = eat()
      const values = []
      let close = null
      for (;;) {
        const v = peek()
        if (!v) throw new PodQueryError('Unclosed "(" — add the matching ")".', spanOf(open), true)
        if (v.t === ')') { close = eat(); break }
        if (v.t === 'OR' || v.t === 'AND') { eat(); continue }
        if (v.t !== 'word') throw new PodQueryError(`Unexpected "${v.t}" inside the list.`, spanOf(v))
        eat()
        values.push(v.value)
      }
      if (values.length === 0) {
        throw new PodQueryError('Empty list "()" — put a value inside it, or remove it.', [open.at, close.at + 1])
      }
      return { kind: 'union', field: ref.field, tag: ref.tag, values }
    }

    if (tok.t !== 'word') throw new PodQueryError(`Nothing after "${label}:" — add a value, or ${label}:* for any.`, head)
    eat()
    return tok.value === '*'
      ? { kind: 'any', field: ref.field, tag: ref.tag }
      : { kind: 'field', field: ref.field, tag: ref.tag, value: tok.value }
  }

  function parseTerm() {
    const tok = peek()
    if (!tok) throw new PodQueryError('Unfinished query.', null, true)
    if (tok.t === ')') throw new PodQueryError('Unmatched ")" — remove it or add the opening "(".', spanOf(tok))
    if (tok.t === 'AND' || tok.t === 'OR') throw new PodQueryError(`"${tok.t}" needs something on both sides.`, spanOf(tok))
    if (tok.t === '(') {
      throw new PodQueryError(`Brackets group the values of one field, as in ${namesOf(fields)[0]}:(a OR b).`, spanOf(tok))
    }
    if (tok.t === ':') {
      const named = namesOf(fields).slice(0, 2).map(n => `${n}:`).join(' or ')
      throw new PodQueryError(`":" needs a field name before it, like ${named}.`, spanOf(tok))
    }

    eat()
    if (peek()?.t === ':') {
      const raw = tok.value.toLowerCase()
      const ref = resolveRef(raw, fields)
      if (!ref) throw new PodQueryError(unknownRef(raw, tok.value, fields), spanOf(tok))
      const colon = eat()
      return parseValue(ref, [tok.at, colon.at + 1], raw)
    }
    // No colon: free text, matched against either field.
    return { kind: 'free', value: tok.value }
  }

  function parseAnd() {
    const parts = [parseTerm()]
    for (;;) {
      const tok = peek()
      if (!tok || tok.t === 'OR' || tok.t === ')') break
      if (tok.t === 'AND') {
        const op = eat()
        if (!peek()) throw new PodQueryError('"AND" needs something on both sides.', spanOf(op), true)
      }
      parts.push(parseTerm())
    }
    return parts.length === 1 ? parts[0] : { kind: 'and', parts }
  }

  function parseOr() {
    const parts = [parseAnd()]
    while (peek()?.t === 'OR') {
      const op = eat()
      if (!peek()) throw new PodQueryError('"OR" needs something on both sides.', spanOf(op), true)
      parts.push(parseAnd())
    }
    return parts.length === 1 ? parts[0] : { kind: 'or', parts }
  }

  const node = parseOr()
  if (pos < tokens.length) {
    // A stray ")" is nearly always a bracket the user forgot to open, so it
    // gets the same advice here as it does in term position.
    if (tokens[pos].t === ')') {
      throw new PodQueryError('Unmatched ")" — remove it or add the opening "(".', spanOf(tokens[pos]))
    }
    throw new PodQueryError(`Unexpected "${tokens[pos].value ?? tokens[pos].t}".`, spanOf(tokens[pos]))
  }
  return node
}

// The text without its surrounding whitespace — what to underline when the
// error is about something missing rather than something written.
function textSpan(s) {
  const start = s.length - s.trimStart().length
  const end = s.trimEnd().length
  return end > start ? [start, end] : null
}

// Non-throwing. `{ ok, node, error, span, incomplete }`, where `span` is the
// extent of the offending text and `incomplete` says the query merely ran out
// rather than went wrong. An empty query parses to a null node, which matches
// everything — an empty search box is not a filter.
export function parsePodQuery(input, fields = POD_FIELDS) {
  const ok = (node) => ({ ok: true, node, error: null, span: null, incomplete: false })
  const tokens = tokenize(input)
  if (tokens.length === 0) return ok(null)
  try {
    return ok(parseTokens(tokens, fields))
  } catch (e) {
    if (e instanceof PodQueryError) {
      return {
        ok: false,
        node: null,
        error: e.message,
        span: e.span ?? textSpan(input ?? ''),
        incomplete: e.incomplete,
      }
    }
    throw e
  }
}

// ---------- Display ----------

// Splits the raw text into coloured segments, covering every character
// including whitespace so a mirror layer can reproduce the input exactly.
// An <input> cannot render spans, so the field is drawn twice: this underneath,
// and a transparent input on top carrying the caret and the selection.
//
// `field` is only claimed once the colon is there. Colouring `pod` before the
// user has typed `:` would promise a field search they have not asked for yet,
// and would flicker on every word that merely starts like one. A tag reference
// colours as one token, `service.team:` — it names one thing.
//
// `span` marks a run of characters as `bad`, which the field draws with a
// squiggle. Splitting it in here rather than in the component keeps the mirror
// layer's one invariant: the segments still concatenate back to the input.
export function segmentQuery(input, fields = POD_FIELDS, span = null) {
  const s = input ?? ''
  const out = []
  const push = (text, type) => {
    if (!text) return
    const last = out[out.length - 1]
    if (last && last.type === type) last.text += text
    else out.push({ text, type })
  }

  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (/\s/.test(c)) { push(c, 'plain'); i++; continue }
    if (c === '(' || c === ')') { push(c, 'paren'); i++; continue }
    if (c === ':') { push(c, 'plain'); i++; continue }

    const start = i
    while (i < s.length && isWordChar(s[i])) i++
    const word = s.slice(start, i)
    const upper = word.toUpperCase()

    if (upper === 'AND' || upper === 'OR') { push(word, 'op'); continue }
    if (s[i] === ':' && resolveRef(word.toLowerCase(), fields)) {
      push(word + ':', 'field')
      i++
      continue
    }
    push(word, 'plain')
  }
  return span ? markSpan(out, span) : out
}

// Re-cuts the segments at the span's edges. A span can start or end mid-segment
// — `pod:` is one segment and only its colon may be at fault — so each segment
// yields up to three pieces.
function markSpan(segs, [from, to]) {
  const out = []
  const push = (text, type, bad) => {
    if (!text) return
    const last = out[out.length - 1]
    if (last && last.type === type && !!last.bad === bad) last.text += text
    else out.push(bad ? { text, type, bad: true } : { text, type })
  }
  let at = 0
  for (const seg of segs) {
    const len = seg.text.length
    const a = Math.min(Math.max(from - at, 0), len)
    const b = Math.min(Math.max(to - at, 0), len)
    push(seg.text.slice(0, a), seg.type, false)
    push(seg.text.slice(a, b), seg.type, true)
    push(seg.text.slice(b), seg.type, false)
    at += len
  }
  return out
}

// ---------- Matching ----------

// Reads either the column's own value or one of its tags, depending on the
// node. Both are strings by the time they leave here, so the matcher below
// does not care which it got.
function valueOf(row, fields, name, tag = null) {
  const f = fieldFor(fields, name)
  if (!f) return ''
  if (!tag) return String(row?.[f.key] ?? '')
  return f.tags ? String(row?.[f.tags]?.[tag] ?? '') : ''
}

const tagValuesOf = (row, f) => (f.tags ? Object.values(row?.[f.tags] ?? {}) : [])
const has = (haystack, needle) => String(haystack).toLowerCase().includes(needle.toLowerCase())

export function matchesPod(node, row, fields = POD_FIELDS) {
  if (!node) return true
  switch (node.kind) {
    case 'and':   return node.parts.every(p => matchesPod(p, row, fields))
    case 'or':    return node.parts.some(p => matchesPod(p, row, fields))
    case 'any':   return valueOf(row, fields, node.field, node.tag).length > 0
    case 'field': return has(valueOf(row, fields, node.field, node.tag), node.value)
    case 'union': return node.values.some(v => has(valueOf(row, fields, node.field, node.tag), v))
    // Free text reads the tags too. They are shown in the column, so a word
    // visible on screen that the search would not find reads as a broken box.
    case 'free':  return fields.filter(f => f.free !== false).some(f =>
      has(valueOf(row, fields, f.name), node.value)
      || tagValuesOf(row, f).some(v => has(v, node.value)))
    default:      return true
  }
}

// The strings to highlight in each column. A free-text term highlights in both,
// a field term only in its own — so the highlight explains which clause matched
// rather than just colouring anything that looks similar.
export function highlightsFor(node, fields = POD_FIELDS, out = null) {
  const acc = out ?? Object.fromEntries(namesOf(fields).map(n => [n, []]))
  if (!node) return acc
  switch (node.kind) {
    case 'and':
    case 'or':
      node.parts.forEach(p => highlightsFor(p, fields, acc))
      break
    // A tag term highlights in the tag, not in the column's own value — see
    // tagHighlightsFor. `service.team:alpha` should not underline "alpha"
    // wherever it happens to occur in a service name.
    case 'field':
      if (!node.tag) acc[node.field]?.push(node.value)
      break
    case 'union':
      if (!node.tag) acc[node.field]?.push(...node.values)
      break
    case 'free':
      namesOf(fields).forEach(n => acc[n].push(node.value))
      break
    default:
      break   // `any` has no text to highlight
  }
  // Longest first, so an overlapping short term cannot chop a longer match.
  for (const n of namesOf(fields)) {
    acc[n] = [...new Set(acc[n])].sort((a, b) => b.length - a.length)
  }
  return acc
}

// The strings to highlight inside each tag, as `{ field: { tag: [terms] } }`.
//
// Free text is collected under ANY, because it matches whatever tag happens to
// contain it and this function cannot know which tags a row carries. Callers
// read a tag's terms through `tagTerms` rather than indexing directly, so that
// merge happens in one place.
export const ANY_TAG = '*'

export function tagHighlightsFor(node, fields = POD_FIELDS, out = null) {
  const acc = out ?? Object.fromEntries(taggedFields(fields).map(f => [f.name, {}]))
  if (!node) return acc
  const add = (field, tag, values) => {
    if (!acc[field]) return
    acc[field][tag] = [...new Set([...(acc[field][tag] ?? []), ...values])]
      .sort((a, b) => b.length - a.length)
  }
  switch (node.kind) {
    case 'and':
    case 'or':
      node.parts.forEach(p => tagHighlightsFor(p, fields, acc))
      break
    case 'field':
      if (node.tag) add(node.field, node.tag, [node.value])
      break
    case 'union':
      if (node.tag) add(node.field, node.tag, node.values)
      break
    case 'free':
      taggedFields(fields).forEach(f => add(f.name, ANY_TAG, [node.value]))
      break
    default:
      break
  }
  return acc
}

// The terms to highlight in one tag chip: the ones aimed at that tag by name,
// plus any free text, which could have matched it.
export function tagTerms(tagHits, field, tag) {
  const forField = tagHits?.[field]
  if (!forField) return []
  return [...new Set([...(forField[tag] ?? []), ...(forField[ANY_TAG] ?? [])])]
    .sort((a, b) => b.length - a.length)
}
