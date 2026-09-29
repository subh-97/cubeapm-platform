// Saved queries: what counts as saveable, what a query descends from, and
// which of Save / Saved / Update is on offer.
//
// The rules live here rather than in the page because they are a state machine
// with three inputs — what is on screen, what the user has saved, and where the
// current query came from — and reading it off a render tree is how the wrong
// button ends up enabled.
//
// Everything here is pure. `stringify` is passed in rather than imported: it
// belongs to the query builder, which sits downstream of this module's
// neighbours, and injecting it keeps the dependency pointing one way.

import { composeQuery, withImpliedCount } from '@/utils/pipes'

// The composed query a saved entry stands for — conditions plus pipes, in the
// same form the bar produces. Identity is the query itself, never the name:
// the question these comparisons answer is "have I kept this one", not "is
// there something called this".
export function keyOf(entry, stringify) {
  return composeQuery(
    stringify(entry?.chips ?? []),
    withImpliedCount(entry?.pipes ?? []),
  )
}

// Raw mode has no chips to store, and a query of `*` is not worth a name.
export function canSave({ queryMode, appliedChips = [], effectivePipes = [] }) {
  return queryMode !== 'raw' && (appliedChips.length > 0 || effectivePipes.length > 0)
}

// Two ways to have nothing to save, and they need different advice: an empty
// bar wants a filter, a composed-but-unrun one wants Run. This is the second.
export function isComposedButUnrun({ queryMode, saveable, effectiveChips = [], livePipes = [] }) {
  return !saveable
    && queryMode !== 'raw'
    && (effectiveChips.length > 0 || livePipes.length > 0)
}

export function findMatch(list, appliedQuery, stringify) {
  return (list ?? []).find(q => keyOf(q, stringify) === appliedQuery) ?? null
}

// Where the query on screen came from. Not derivable from the query itself —
// once edited it matches nothing — so the id is carried from the moment a saved
// query was opened or written.
export function findOrigin(list, originId) {
  if (originId == null) return null
  return (list ?? []).find(q => q.id === originId) ?? null
}

// Update is offered only once the query has drifted from its origin. While it
// still matches, the Saved state covers it and there is nothing to update.
export function updatableFrom(origin, savedAs) {
  return origin && !savedAs ? origin : null
}

// The note under the bar answers "what am I looking at" after a query is
// applied. It reads the examples too — those are the ones whose purpose is
// least obvious from the query itself — and the user's own saves win, so
// keeping an example under your own name renames the note.
export function noteFor({ saved, examples, appliedQuery, saveable, stringify }) {
  if (!saveable) return null
  return findMatch(saved, appliedQuery, stringify)
    ?? findMatch(examples, appliedQuery, stringify)
    ?? null
}

export function newEntry({ name, description, chips, pipes, now = Date.now() }) {
  return { id: `sq-${now}`, savedAt: now, name, description, chips, pipes }
}

export function applyEdit(list, id, { name, description, chips, pipes, now = Date.now() }) {
  return (list ?? []).map(q => (
    q.id === id ? { ...q, name, description, chips, pipes, updatedAt: now } : q
  ))
}

export function removeEntry(list, id) {
  return (list ?? []).filter(q => q.id !== id)
}
