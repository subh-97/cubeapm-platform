import { useState, useMemo, useEffect, useCallback } from 'react'
import {
  keyOf, canSave, isComposedButUnrun, findMatch, findOrigin,
  updatableFrom, noteFor, newEntry, applyEdit, removeEntry,
} from '@/utils/savedQueries'

/**
 * Saved queries for the logs view: the list, what the current query descends
 * from, and which of Save / Saved / Update is on offer.
 *
 * The rules are pure and live in utils/savedQueries.js; this binds them to
 * React state. Two things are deliberately kept apart:
 *
 *   `savedAs`  — the query on screen IS one of your saves. Derived from the
 *                query, so it appears and disappears as you edit.
 *   `origin`   — the query on screen CAME FROM one of your saves. Carried by
 *                id, because once edited it no longer matches anything and
 *                could not be derived at all.
 *
 * Update is what sits between them: offered only once a query has drifted from
 * its origin, because while it still matches there is nothing to update.
 *
 * `onApply` is supplied by the caller because applying a saved query writes the
 * page's own query state — the hook owns the saves, not the bar.
 */
export function useSavedQueries({
  queryMode,
  appliedChips = [],
  appliedPipes = [],
  effectiveChips = [],
  effectivePipes = [],
  livePipes = [],
  appliedQuery,
  stringify,
  examples = [],
  onToast,
  onApply,
}) {
  const [saved, setSaved] = useState([])
  const [originId, setOriginId] = useState(null)

  const saveable = canSave({ queryMode, appliedChips, effectivePipes })
  const composedButUnrun = isComposedButUnrun({ queryMode, saveable, effectiveChips, livePipes })

  const savedAs = useMemo(
    () => (saveable ? findMatch(saved, appliedQuery, stringify) : null),
    [saved, appliedQuery, saveable, stringify],
  )

  const origin = useMemo(() => findOrigin(saved, originId), [saved, originId])
  const updatable = updatableFrom(origin, savedAs)

  const note = useMemo(
    () => noteFor({ saved, examples, appliedQuery, saveable, stringify }),
    [saved, examples, appliedQuery, saveable, stringify],
  )

  // Emptying the bar ends the lineage: nothing is left that descended from
  // anything. Any lesser edit keeps it.
  useEffect(() => {
    if (!saveable) setOriginId(null)
  }, [saveable])

  const save = useCallback((name, description) => {
    const entry = newEntry({ name, description, chips: appliedChips, pipes: appliedPipes })
    setSaved(prev => [entry, ...prev])
    // What is on screen now descends from this entry, so editing it next offers
    // to update it rather than only to save a third copy.
    setOriginId(entry.id)
    onToast?.(`Saved “${name}” to My Queries`)
  }, [appliedChips, appliedPipes, onToast])

  const update = useCallback((id, name, description) => {
    setSaved(prev => applyEdit(prev, id, { name, description, chips: appliedChips, pipes: appliedPipes }))
    onToast?.(`Updated “${name}”`)
  }, [appliedChips, appliedPipes, onToast])

  // Reapplying runs it. A saved query is a destination, not a draft — landing
  // on the builder with the filters loaded but the old results still showing
  // would be the one state nobody wants.
  const apply = useCallback((q) => {
    onApply?.(q)
    // Examples have no id, so opening one starts no lineage: there is nothing
    // of the user's to update, only a new query to save.
    setOriginId(q.id ?? null)
  }, [onApply])

  const remove = useCallback((id) => {
    setSaved(prev => removeEntry(prev, id))
    setOriginId(prev => (prev === id ? null : prev))
  }, [])

  return {
    saved, saveable, composedButUnrun,
    savedAs, origin, updatable, note,
    save, update, apply, remove,
    keyOf: (entry) => keyOf(entry, stringify),
  }
}
