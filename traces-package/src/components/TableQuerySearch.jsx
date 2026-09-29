// The query variant of table search: several fields, a small query language,
// and syntax colouring.
//
// On a table the syntax is discoverable from the placeholder's worked example
// alone: the field is one line of text, and a panel covering the rows being
// filtered cost more than it taught. Where the field set is too large to name
// in a placeholder — a record's attributes rather than a table's two columns —
// `suggest` turns on an overlay listing the field names. It offers names and a
// colon only, never values: the point is to say what can be searched, and a
// list of values would be a second, longer list answering a question the person
// has not asked yet.
//
// Its counterpart is TableSearch, which filters one field with plain text and
// nothing else. Pick by how many fields the table can be searched on: one field
// needs no syntax, and giving it any would be ceremony.
//
// The table follows the text as it is typed, queries included — there is
// nothing to press. Two things keep that from turning into noise while a query
// is still being written.
//
// A query that does not parse is never applied: the rows go on answering the
// last text that did, instead of emptying under the person mid-`pod:(a OR`.
//
// The error waits for a pause in typing. Every query is malformed on the way to
// being written — `pod:` is a stop on the road to `pod:redis` — so complaining
// on each keystroke would be nagging rather than help. Enter asks for the
// verdict now instead of waiting.
//
// It then arrives in two strengths. A squiggle marks the characters at fault,
// quietly, the way an editor does. The sentence explaining it is held back
// while the caret is still in a query that merely ran out: someone who has
// typed `pod:` is deciding what to search for, not making a mistake, and does
// not need telling. Leaving the field ends that grace — the query is as
// finished as it is going to get, so it is worth saying what is wrong with it.

import { useState, useRef, useEffect, useMemo } from 'react'
import { parsePodQuery, segmentQuery, placeholderFor, POD_FIELDS } from '@/utils/tableQuery'

// Long enough to type a colon and keep going, short enough that a query that
// will never work does not sit there unexplained.
const SETTLE_MS = 500

export default function TableQuerySearch({
  onApply, fields = POD_FIELDS, suggest = false, status = null, placeholder: placeholderProp,
  valuesFor,
}) {
  const [draft, setDraft] = useState('')
  // Whether typing has paused. Nothing is said about a broken query until it has.
  const [settled, setSettled] = useState(true)
  const [focused, setFocused] = useState(false)
  const [caret, setCaret] = useState(0)
  const [active, setActive] = useState(0)
  // Escape closes the list without clearing the query; typing brings it back.
  const [dismissed, setDismissed] = useState(false)
  const inputRef = useRef(null)
  const listRef = useRef(null)
  const inkRef = useRef(null)

  const placeholder = placeholderProp ?? placeholderFor(fields)
  const typed = draft.trim()
  const parsed = parsePodQuery(draft, fields)
  const error = settled && !parsed.ok ? parsed.error : null
  // A query still being composed keeps its explanation to itself until the
  // caret leaves. One that is wrong rather than unfinished says so straight away.
  const message = error && (!parsed.incomplete || !focused) ? error : null

  useEffect(() => {
    if (parsed.ok) onApply(draft, parsed.node)
  }, [draft, parsed.ok])   // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (parsed.ok) { setSettled(true); return }
    setSettled(false)
    const t = setTimeout(() => setSettled(true), SETTLE_MS)
    return () => clearTimeout(t)
  }, [draft, parsed.ok])

  const clear = () => {
    setDraft('')
    setSettled(true)
    inputRef.current?.focus()
  }

  // The word the caret is in, when that word is still naming a field. Once a
  // colon has been typed the person is choosing a value, and offering field
  // names then would be answering the previous question.
  // What the caret is in the middle of naming: a field, or a value for a field
  // already named. The two are different questions and get different lists —
  // offering field names after the colon would be answering the previous one.
  //
  // A value is recognised both as `field:frag` in one token and as a fragment
  // sitting inside an open `field:(a OR …`, so the union form completes too.
  const ctx = useMemo(() => {
    if (!suggest) return null
    const head = draft.slice(0, caret)
    const frag = /[^\s(),]*$/.exec(head)[0]
    const before = head.slice(0, head.length - frag.length)

    const colon = frag.indexOf(':')
    if (colon !== -1) {
      const field = fields.find(f => f.name === frag.slice(0, colon))
      return field ? { mode: 'value', field, frag: frag.slice(colon + 1) } : null
    }
    // `service:`, `service:(`, `service:(redis OR ` — all still asking for a value.
    const open = /([A-Za-z_][A-Za-z0-9_.]*):(\([^)]*)?$/.exec(before)
    if (open) {
      const field = fields.find(f => f.name === open[1])
      if (field) return { mode: 'value', field, frag }
    }
    return { mode: 'field', frag }
  }, [suggest, draft, caret, fields])

  const suggestions = useMemo(() => {
    if (!ctx) return []
    const t = ctx.frag.toLowerCase()
    if (ctx.mode === 'field') {
      const hit = fields.filter(f => !t || f.name.toLowerCase().includes(t))
      // An exact, sole match is a field already named — nothing left to suggest.
      if (hit.length === 1 && hit[0].name.toLowerCase() === t) return []
      return hit.slice(0, 8).map(f => ({ key: f.name, text: f.name, tail: ':' }))
    }
    // Values are only offered where a list of them is a real answer. The caller
    // decides that — a field whose every value is a distinct id has nothing to
    // suggest, and saying so is more useful than listing a hundred of them.
    const values = valuesFor?.(ctx.field.name)
    if (!values?.length) return []
    const hit = values.filter(v => !t || v.toLowerCase().includes(t))
    if (hit.length === 1 && hit[0].toLowerCase() === t) return []
    return hit.slice(0, 8).map(v => ({ key: v, text: v, value: true }))
  }, [ctx, fields, valuesFor])

  // Replaces the fragment under the caret, leaving the rest of the query alone
  // so a suggestion can be taken mid-expression.
  const applySuggestion = (item) => {
    if (!ctx) return
    const head = draft.slice(0, caret)
    const insert = ctx.mode === 'field' ? `${item.text}:` : item.text
    const start = head.length - ctx.frag.length
    const next = `${head.slice(0, start)}${insert}${draft.slice(caret)}`
    setDraft(next)
    const pos = start + insert.length
    window.requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.setSelectionRange(pos, pos)
      setCaret(pos)
    })
  }

  // A list that has changed under the cursor cannot keep its old position, so
  // the highlight goes back to the top rather than to whatever now sits there.
  useEffect(() => { setActive(0); setDismissed(false) }, [draft])
  const open = suggest && focused && !dismissed && suggestions.length > 0
  const activeIdx = Math.min(active, suggestions.length - 1)

  useEffect(() => {
    if (!open) return
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [open, activeIdx])

  // The ink layer does not scroll itself, so it follows the input's scroll to
  // stay aligned once the text is longer than the field.
  const syncScroll = () => {
    if (inkRef.current && inputRef.current) {
      inkRef.current.scrollLeft = inputRef.current.scrollLeft
    }
  }

  return (
    <div className="pod-search-wrap">
      <div className="svc-search pod-search-field">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" />
        </svg>

        {/* The input carries the caret and the selection; the layer beneath
            carries the colour. Both must keep identical metrics or the two
            copies of the text drift apart. */}
        <div className="pod-search-ink-wrap">
          <div className="pod-search-ink" ref={inkRef} aria-hidden="true">
            {segmentQuery(draft, fields, error ? parsed.span : null).map((seg, i) => (
              <span key={i} className={`pod-ink-${seg.type}${seg.bad ? ' pod-ink-bad' : ''}`}>{seg.text}</span>
            ))}
          </div>
          <input
            ref={inputRef}
            type="text"
            value={draft}
            role={suggest ? 'combobox' : undefined}
            aria-expanded={suggest ? open : undefined}
            aria-controls={suggest ? 'pod-suggest-list' : undefined}
            aria-activedescendant={open ? `pod-suggest-${activeIdx}` : undefined}
            aria-autocomplete={suggest ? 'list' : undefined}
            onChange={e => { setDraft(e.target.value); setCaret(e.target.selectionStart ?? e.target.value.length) }}
            onSelect={e => setCaret(e.target.selectionStart ?? 0)}
            onScroll={syncScroll}
            onFocus={e => { setFocused(true); setCaret(e.target.selectionStart ?? 0) }}
            // Leaving is as final as the query gets: stop waiting on both counts.
            onBlur={() => { setFocused(false); setSettled(true) }}
            onKeyDown={e => {
              // The overlay takes the arrows and Enter only while it is open and
              // has something highlighted; otherwise every key means what it
              // meant before, so the field does not change behaviour under you.
              if (open) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setActive(i => (i + 1) % suggestions.length)
                  return
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setActive(i => (i - 1 + suggestions.length) % suggestions.length)
                  return
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                  e.preventDefault()
                  applySuggestion(suggestions[activeIdx])
                  return
                }
                // One Escape dismisses the list; the query survives it. Clearing
                // the field on the same key would throw away a query whose only
                // problem was a panel covering the rows.
                if (e.key === 'Escape') { e.preventDefault(); setDismissed(true); return }
              }
              if (e.key === 'Enter') { e.preventDefault(); setSettled(true) }
              else if (e.key === 'Escape') clear()
            }}
            placeholder={placeholder}
            aria-label={placeholder}
            spellCheck={false}
            autoComplete="off"
          />
        </div>

        {typed && (
          <button type="button" className="svc-search-clear" onClick={clear} title="Clear search" aria-label="Clear search">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        )}
      </div>

      {open && (
        <div
          className="pod-search-suggest"
          role="listbox"
          id="pod-suggest-list"
          ref={listRef}
          aria-label={ctx.mode === 'field' ? 'Fields' : `Values for ${ctx.field.name}`}
        >
          {suggestions.map((item, i) => (
            <button
              key={item.key}
              id={`pod-suggest-${i}`}
              type="button"
              role="option"
              aria-selected={i === activeIdx}
              data-active={i === activeIdx}
              className={`pod-search-suggest-item${i === activeIdx ? ' is-active' : ''}`}
              onMouseEnter={() => setActive(i)}
              onMouseDown={e => { e.preventDefault(); applySuggestion(item) }}
            >
              <span className={item.value ? 'pod-suggest-value' : 'pod-suggest-name'}>{item.text}</span>
              {item.tail && <span className="pod-suggest-colon">{item.tail}</span>}
            </button>
          ))}
        </div>
      )}

      {message && <div className="pod-search-error" role="alert">{message}</div>}
      {status}
    </div>
  )
}
