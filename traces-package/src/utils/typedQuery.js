// Recognising query syntax as the user types it.
//
// The builder has always been click-driven. This lets someone who knows the
// grammar type `service:=order ` and get the same chip, without ever opening a
// suggestion. Everything here is pure and takes the field list as an argument,
// so it stays free of import cycles and is testable on its own.
//
// THE RULE THAT MAKES THIS SAFE: a `:` or `!` only means "operator" when the
// token in front of it is EXACTLY a known field name. `service` on its own is
// still free text — it is a perfectly plausible thing to grep the log body for
// — and a colon inside ordinary search text ("GET /v1: timeout") never
// triggers a filter, because "GET /v1" is not a field.

// Operator symbols that can be typed, longest first so `:=` wins over `:` and
// ` not_in (` over ` in (`. `needsValue: false` commits the moment it matches.
const TYPED_OPS = [
  { sym: ' not_in (', op: 'not_in', close: ')', needsValue: true, multi: true },
  { sym: ' in (',     op: 'in',     close: ')', needsValue: true, multi: true },
  { sym: ':""',       op: 'empty',  needsValue: false },
  { sym: ':=',        op: 'eq',     needsValue: true },
  { sym: '!=',        op: 'neq',    needsValue: true },
  { sym: ':~"',       op: 'regex',  close: '"', needsValue: true },
  { sym: '!~"',       op: 'nregex', close: '"', needsValue: true },
  { sym: ':"',        op: 'phrase', close: '"', needsValue: true },
]

export const FIELD_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.]*/

export function opMeta(op) {
  return TYPED_OPS.find(o => o.op === op) ?? null
}

// `service` → yes; `servic` / `Service ` → no. Exact match only.
export function isKnownField(name, fields) {
  return !!name && fields.includes(name)
}

// Splits a buffer into a known field name and whatever follows it.
// Returns null when the buffer does not start with a known field, which is the
// signal to treat the whole thing as free text.
export function splitField(text, fields) {
  const m = FIELD_NAME_RE.exec(text ?? '')
  if (!m) return null
  const field = m[0]
  if (!isKnownField(field, fields)) return null
  return { field, rest: text.slice(field.length) }
}

// Matches an operator at the head of `rest` (the text after a field name).
//
// `:*` is deliberately ambiguous — `:*` alone is `exists`, `:*pay*` is
// `contains` — so it resolves to `exists` only when nothing follows. A bare `:`
// followed by ordinary characters starts out as `word`; whether it is really
// `prefix` or `contains` depends on asterisks in the value, which deriveOp
// settles at commit time.
export function matchOperator(rest, { allowMulti = true } = {}) {
  if (!rest) return null
  for (const o of TYPED_OPS) {
    if (!allowMulti && o.multi) continue
    if (rest.startsWith(o.sym)) {
      return { op: o.op, rest: rest.slice(o.sym.length), close: o.close ?? null, needsValue: o.needsValue }
    }
  }
  if (rest.startsWith(':*')) {
    const after = rest.slice(2)
    // Nothing after the star means "field is present" — but it is still only
    // provisional, since another character would make it a contains. A space
    // settles it, so that case resolves for real.
    if (after === '') return { op: 'exists', rest: '', close: null, needsValue: false, pending: true }
    if (/^\s/.test(after)) return { op: 'exists', rest: '', close: null, needsValue: false }
    return { op: 'contains', rest: after, close: null, needsValue: true }
  }
  if (rest.startsWith(':')) {
    return { op: 'word', rest: rest.slice(1), close: null, needsValue: true }
  }
  return null
}

// Boolean connectors between terms. Uppercase only, matching the raw parser —
// lowercase "and"/"or" are far too common in log text to hijack, and someone
// searching for the word "and" should get a text search, not a connector.
export const CONNECTORS = ['AND', 'OR']

export function matchConnector(text) {
  const t = (text ?? '').trim()
  return CONNECTORS.includes(t) ? t : null
}

// Every symbol that can begin an operator, used to tell "still typing" from
// "that's the whole operator".
const ALL_SYMBOLS = [...TYPED_OPS.map(o => o.sym), ':*', ':']

// Decides whether an operator buffer is finished or might still grow.
//
// This is what makes live chipping safe. `:` cannot resolve on sight — `:=`,
// `:"`, `:~"`, `:*` and `:""` all extend it — so it stays pending until the
// next keystroke settles it. Resolving eagerly and correcting later would eat
// keystrokes; waiting one character never does.
//
//   'pending'  — a proper prefix of some operator; keep it in the input
//   'resolved' — the operator is settled; `rest` is the start of the value
//   'none'     — not an operator at all, so the buffer is free text
export function resolveOperator(buf) {
  if (!buf) return { status: 'pending' }

  // Checked FIRST, before matchOperator's loose `:` fallback gets a look in.
  // Otherwise `:~` would resolve as word-with-value-"~" instead of waiting for
  // the quote that makes it a regex.
  if (ALL_SYMBOLS.some(sym => sym.length > buf.length && sym.startsWith(buf))) {
    return { status: 'pending' }
  }

  const m = matchOperator(buf)
  if (!m) return { status: 'none' }

  // `:*` is genuinely undecided: alone it means exists, with more after it it
  // means contains. A space (handled by the caller) is what settles it.
  if (m.op === 'exists' && m.pending) return { status: 'pending' }

  return { status: 'resolved', op: m.op, rest: m.rest }
}

// A typed value carries its own decoration: `pay*` is a prefix match, `*pay*`
// is a substring match. Applied at commit so the operator matches what was
// actually written rather than what the first keystroke implied.
export function deriveOp(op, value) {
  const v = String(value ?? '')
  if (op === 'word') {
    if (v.length > 1 && v.startsWith('*') && v.endsWith('*')) return { op: 'contains', value: v.slice(1, -1) }
    if (v.length > 1 && v.endsWith('*')) return { op: 'prefix', value: v.slice(0, -1) }
    return { op: 'word', value: v }
  }
  if (op === 'contains') {
    // matchOperator already ate the leading `*`; drop the closing one.
    return { op: 'contains', value: v.endsWith('*') ? v.slice(0, -1) : v }
  }
  return { op, value: v }
}

// Free text carries its own syntax too: `"a b"` is a phrase, `pay*` a prefix,
// `*pay*` a substring. Without this the quotes and stars are taken as literal
// characters to search for, so `"text"` would generate `_msg:""text""`.
//
// `explicit` says the user wrote the decoration themselves, which is the signal
// to lead the suggestion list with that reading rather than guessing.
export function deriveFreeText(typed) {
  const t = (typed ?? '').trim()
  const wrapped = (open, close, minLen) =>
    t.length >= minLen && t.startsWith(open) && t.endsWith(close)

  if (wrapped('"', '"', 2)) {
    const v = t.slice(1, -1)
    if (v) return { op: 'phrase', value: v, explicit: true }
  }
  if (wrapped('*', '*', 3)) {
    const v = t.slice(1, -1)
    if (v) return { op: 'contains', value: v, explicit: true }
  }
  if (t.length >= 2 && t.endsWith('*')) {
    const v = t.slice(0, -1)
    if (v && !v.endsWith('*')) return { op: 'prefix', value: v, explicit: true }
  }
  return { op: null, value: t, explicit: false }
}

// Splits `"a", "b"` into ['a','b'] for in()/not_in().
export function parseListValue(inner) {
  const out = []
  const re = /"([^"]*)"|'([^']*)'|([^,\s]+)/g
  let m
  while ((m = re.exec(inner ?? '')) !== null) {
    const v = m[1] ?? m[2] ?? m[3]
    if (v !== undefined && v !== '') out.push(v)
  }
  return out
}

// True when a space at the end of the buffer should commit rather than being
// typed into the value. Inside quotes or an unclosed list a space is content.
export function isCommittable(op, valueText) {
  const meta = opMeta(op)
  if (op === 'exists' || op === 'empty') return true
  const v = valueText ?? ''
  if (meta?.close === '"') return v.length >= 1 && v.endsWith('"')
  if (meta?.close === ')') return v.includes(')')
  if (op === 'contains') return v.endsWith('*') && v.length > 1
  return v.trim().length > 0
}

// Turns a finished buffer into a chip. Returns null when it is not a complete
// field term — the caller then treats the text as free text instead.
export function buildChip(op, valueText) {
  if (op === 'exists' || op === 'empty') return { op, value: '' }
  const meta = opMeta(op)
  let raw = valueText ?? ''
  if (meta?.close === '"') {
    const end = raw.lastIndexOf('"')
    if (end < 0) return null
    raw = raw.slice(0, end)
    if (raw === '' && op === 'phrase') return null
    return { op, value: raw }
  }
  if (meta?.close === ')') {
    const end = raw.indexOf(')')
    if (end < 0) return null
    const list = parseListValue(raw.slice(0, end))
    if (!list.length) return null
    return { op, value: list }
  }
  const d = deriveOp(op, raw.trim())
  if (!d.value) return null
  return d
}

// The whole picture for a buffer, used to drive the live "free text / field
// filter" hint and to decide what a space or Enter should do.
//
// `kind`:
//   'empty'    — nothing typed
//   'freetext' — will search the log body
//   'field'    — a known field, no operator yet
//   'partial'  — operator known, value still incomplete
//   'complete' — a full term, ready to become a chip
export function interpret(text, fields) {
  const s = text ?? ''
  if (!s.trim()) return { kind: 'empty', label: null }

  const conn = matchConnector(s)
  if (conn) return { kind: 'connector', label: 'connector', connector: conn }

  const split = splitField(s, fields)
  if (!split) return { kind: 'freetext', label: 'free text', value: s.trim() }

  const { field, rest } = split
  // A bare field name is not yet a filter — `service` alone is free text.
  if (rest === '') return { kind: 'freetext', label: 'free text', value: s.trim(), field }

  const m = matchOperator(rest)
  if (!m) return { kind: 'freetext', label: 'free text', value: s.trim() }

  if (!m.needsValue) {
    return { kind: 'complete', label: 'field filter', field, op: m.op, value: '' }
  }
  const chip = isCommittable(m.op, m.rest) ? buildChip(m.op, m.rest) : null
  if (chip) return { kind: 'complete', label: 'field filter', field, op: chip.op, value: chip.value }
  return { kind: 'partial', label: 'field filter', field, op: m.op, valueText: m.rest }
}
