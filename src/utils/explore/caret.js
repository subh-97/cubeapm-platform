// Cursor arithmetic shared by the two Explore completers.
//
// Both languages hand us the same shape — a token stream `{type, value, start,
// end}` that covers the text end to end, from a lexer that never throws. So the
// question "what is the caret in the middle of, and what span would a
// completion replace?" has one answer for both, and it lives here rather than
// twice.
//
// Everything in this file is pure and synchronous. The completers are the ones
// that talk to fetchers.

/** Token types that carry no meaning and are stepped over when looking around. */
export const SKIPPABLE = new Set(['whitespace'])

/**
 * Index of the token the caret sits inside or immediately after, or -1.
 *
 * `start < caret <= end` rather than `start <= caret`: a caret touching the
 * boundary between two tokens belongs to the one on its LEFT, because that is
 * the word the person is still typing. At offset 0 nothing is being typed yet.
 */
export function tokenIndexAt(tokens, caret) {
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].start < caret && caret <= tokens[i].end) return i
  }
  return -1
}

/** Index of the nearest meaningful token before `index`, or -1. */
export function prevSignificant(tokens, index, skip = SKIPPABLE) {
  for (let i = Math.min(index, tokens.length) - 1; i >= 0; i--) {
    if (!skip.has(tokens[i].type)) return i
  }
  return -1
}

/** Index of the nearest meaningful token after `index`, or -1. */
export function nextSignificant(tokens, index, skip = SKIPPABLE) {
  for (let i = Math.max(index, -1) + 1; i < tokens.length; i++) {
    if (!skip.has(tokens[i].type)) return i
  }
  return -1
}

/**
 * Index of the last meaningful token that ends at or before `offset`, or -1.
 *
 * This is the one the completers ask about: "what comes before the span I am
 * about to replace" — an operator, a comma, a pipe — which is what decides
 * which list to offer.
 */
export function lastSignificantBefore(tokens, offset, skip = SKIPPABLE) {
  let found = -1
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].end > offset) break
    if (!skip.has(tokens[i].type)) found = i
  }
  return found
}

/**
 * The span a completion would replace, and the prefix typed into it so far.
 *
 * When the caret is in a word-like token the whole token is replaced — taking a
 * suggestion mid-word should finish the word, not splice into it. Anywhere else
 * (after a space, a brace, a comma) the completion is an insertion at the caret.
 */
export function wordRange(tokens, caret, wordy) {
  const index = tokenIndexAt(tokens, caret)
  const t = index === -1 ? null : tokens[index]
  if (!t || !wordy.has(t.type)) return { index: -1, from: caret, to: caret, fragment: '' }
  return { index, from: t.start, to: t.end, fragment: t.value.slice(0, caret - t.start) }
}

/**
 * Candidates that contain `fragment`, prefix matches first, order otherwise
 * kept.
 *
 * Order is kept because the catalogs are already in the order the product
 * documents them, and a completion list that re-sorts alphabetically throws
 * that away. Prefix matches are lifted because that is what the person is
 * typing towards.
 */
export function rankMatches(items, fragment, key = it => it.label) {
  const frag = String(fragment ?? '').toLowerCase()
  if (!frag) return items.slice()
  const prefix = []
  const inside = []
  for (const it of items) {
    const k = String(key(it) ?? '').toLowerCase()
    if (k.startsWith(frag)) prefix.push(it)
    else if (k.includes(frag)) inside.push(it)
  }
  return prefix.concat(inside)
}

/**
 * A metadata response as `{value, hits}` rows, whatever shape it arrived in.
 *
 * `api.js` answers `metricLabelValues` with plain strings and `logFieldValues`
 * with `{value, hits}`; a completer should not care which call it was wired to.
 */
export function toValueRows(result) {
  if (!Array.isArray(result)) return []
  const out = []
  for (const row of result) {
    if (row == null) continue
    if (typeof row === 'object') out.push({ value: String(row.value ?? ''), hits: row.hits })
    else out.push({ value: String(row), hits: undefined })
  }
  return out
}

/** The text of a quoted token, unquoted and unescaped; other tokens unchanged. */
export function unquote(raw) {
  const s = String(raw ?? '')
  const q = s[0]
  if (q !== '"' && q !== "'" && q !== '`') return s
  const closed = s.length > 1 && s.endsWith(q)
  const body = s.slice(1, closed ? -1 : undefined)
  if (q === '`') return body
  return body.replace(/\\(.)/g, (_, c) => ({ n: '\n', t: '\t', r: '\r' }[c] ?? c))
}

/** True for a token that is, or is on its way to being, a quoted string. */
export function isQuoted(raw) {
  const c = String(raw ?? '')[0]
  return c === '"' || c === "'" || c === '`'
}
