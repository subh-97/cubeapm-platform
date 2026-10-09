import { useState, useRef, useEffect, useCallback, useMemo, useId } from 'react'
import { createPortal } from 'react-dom'
import SearchGlyph from './SearchGlyph'
import './filter-select.css'

// The filter dropdown of the service and Browser pages: a muted label and the
// current value, which opens a searchable list portalled to <body>. It is the
// Category / Host / Version filters and the Endpoint strip on the service page,
// and the Browser page's Endpoint, Type and Error filters.
//
// Opening one FilterSelect closes any other open one on the page. The nonce
// avoids every instance reacting to its own open event. Both live here, at
// module level, and nowhere else: a second copy of this component would count
// from 1 on its own, its ids would collide with these, and an open select of
// one kind would no longer close an open select of the other.
const FILTER_SELECT_EVENT = 'cube:filter-select-open'
let filterSelectNonce = 0

// A placeholder is prose standing in for a value ("All endpoints"), not a value
// itself, so it is drawn muted and in the body face even where the select draws
// its value in mono (the Endpoint strip) or in the brand colour (the subtab
// filters). Inline, because those value rules are more specific than any class
// this component could add, and it must read as empty in every one of them.
const PLACEHOLDER_STYLE = { color: 'var(--text-muted)', fontFamily: 'inherit', fontWeight: 400 }

// `options` are unique strings: each is shown as it is and doubles as its row's
// key. `value` is the option shown as chosen; '' or null means nothing is
// chosen, which shows `placeholder` when one is given. `clearLabel` adds a first
// row ("All endpoints") that chooses nothing, by calling onSelect('').
export default function FilterSelect({ label, value, options, onSelect, className, placeholder, clearLabel }) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  // The row the keyboard is on: an index into `rows` below, or -1 for none.
  const [hl, setHl] = useState(-1)
  // Whether the keyboard is driving this opening of the panel. The row the
  // keys are on is only drawn (.is-hl) while it is: a panel opened and used
  // with the pointer looks exactly as it did before the keys did anything —
  // no rule on the chosen row as it opens, no fill left on the last row the
  // pointer crossed. A screen reader is told the row either way, through
  // aria-activedescendant, which draws nothing.
  const [kbd, setKbd] = useState(false)
  const ref = useRef(null)
  const btnRef = useRef(null)
  const listRef = useRef(null)
  const idRef = useRef(null)
  const uid = useId()
  const listId = `${uid}-list`
  const optId = i => `${uid}-opt-${i}`

  const filtered = search
    ? options.filter(o => o.toLowerCase().includes(search.toLowerCase()))
    : options

  const isEmpty = value === '' || value == null
  const showPlaceholder = isEmpty && placeholder != null
  // The clear row stands for "no filter", which is not something a search is
  // looking for, so it steps aside while one is typed.
  const showClear = clearLabel != null && !search
  // What the list shows, in order: the clear row (choosing '') when there is
  // one, then the options the search left. The keyboard moves over exactly
  // these, the clear row included, so a filter can be emptied without a mouse.
  const rows = useMemo(() => [
    ...(showClear ? [{ value: '', label: clearLabel, clear: true }] : []),
    ...filtered.map(o => ({ value: o, label: o })),
  ], [showClear, clearLabel, filtered])
  const hlIdx = hl < rows.length ? hl : rows.length - 1

  const close = useCallback(() => { setOpen(false); setSearch(''); setHl(-1); setKbd(false) }, [])

  // Only one FilterSelect may be open at a time. Opening one dispatches an
  // event the others listen for and respond to by closing themselves.
  useEffect(() => {
    const handler = (e) => {
      if (e.detail?.id !== idRef.current && open) close()
    }
    window.addEventListener(FILTER_SELECT_EVENT, handler)
    return () => window.removeEventListener(FILTER_SELECT_EVENT, handler)
  }, [open, close])

  // `byKeys` when Enter, Space or ArrowDown on the trigger opened it.
  const openPanel = useCallback((byKeys = false) => {
    idRef.current = ++filterSelectNonce
    window.dispatchEvent(new CustomEvent(FILTER_SELECT_EVENT, { detail: { id: idRef.current } }))
    // The keyboard starts on what is chosen — the clear row when nothing is —
    // so Enter straight away keeps it, and an arrow steps from it. A value the
    // list does not hold starts it on no row (not on the clear row, which
    // would read as "nothing is chosen"), and the first arrow goes to the top.
    const at = options.indexOf(value)
    const startOn = value === '' || value == null
      ? (clearLabel != null ? 0 : -1)
      : at < 0 ? -1 : at + (clearLabel != null ? 1 : 0)
    setHl(startOn)
    setKbd(byKeys)
    setOpen(true)
  }, [value, options, clearLabel])

  // The highlighted row stays in view as the arrows walk the list. Only for
  // the keyboard: a list opened with the pointer opens at its top, as it
  // always has, and does not shift under a pointer resting on a row the
  // list's edge cuts in half.
  useEffect(() => {
    if (!open || !kbd || hlIdx < 0) return
    listRef.current?.children[hlIdx]?.scrollIntoView?.({ block: 'nearest' })
  }, [open, kbd, hlIdx])

  useEffect(() => {
    if (!open) return
    const handler = (e) => {
      if (!ref.current?.contains(e.target) && !btnRef.current?.contains(e.target)) close()
    }
    // The panel is placed once from the trigger's rect, so a scroll anywhere
    // outside it would leave it floating detached; close instead of chasing.
    const onScroll = (e) => { if (!ref.current?.contains(e.target)) close() }
    document.addEventListener('click', handler)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('click', handler)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [open, close])

  // A choice made from the keyboard hands focus back to the trigger. The panel
  // is portalled to the end of <body>, so letting focus fall out of it would
  // drop a keyboard user at the bottom of the document, far from where they
  // were working.
  const closeToTrigger = useCallback(() => { close(); btnRef.current?.focus() }, [close])
  const choose = (o) => { onSelect(o); close() }

  // The trigger is a div so it keeps the look every filter on the page shares;
  // these give it what a <button> would have had. A div never turns Enter or
  // Space into a click, so both are handled here, and Space must not scroll
  // the page underneath.
  const onTriggerKeyDown = (e) => {
    if (e.key === 'Enter' || e.key === ' ' || (e.key === 'ArrowDown' && !open)) {
      e.preventDefault()
      if (open) close()
      else openPanel(true)
    } else if (e.key === 'Escape' && open) {
      e.preventDefault()
      e.stopPropagation()
      close()
    }
  }

  // Escape anywhere in the panel closes it, and only it: the select can sit
  // inside something Escape also closes (a drawer, a modal), and one press
  // should undo one thing.
  //
  // Tab closes it too, and hands focus to the trigger on the way — before the
  // browser moves it — so Tab lands on the control after the select (and
  // Shift+Tab on the one before) rather than past the end of <body>, where the
  // portalled panel sits.
  const onPanelKeyDown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeToTrigger() }
    else if (e.key === 'Tab') closeToTrigger()
  }
  // The search box is a combobox over the list: the arrows, Home and End move
  // the highlighted row (aria-activedescendant says which to a screen reader),
  // and Enter takes it. Typing highlights the first row the search left, which
  // is what a typed name is reaching for. With nothing typed and nothing
  // highlighted, Enter does nothing rather than choosing whatever happens to
  // be listed first.
  //
  // Any key pressed here (typing a search included) puts the panel in the
  // keyboard's hands, so the row Enter would take is drawn from then on.
  const onSearchKeyDown = (e) => {
    if (e.key !== 'Tab' && e.key !== 'Escape') setKbd(true)
    const last = rows.length - 1
    if (e.key === 'ArrowDown') { e.preventDefault(); setHl(Math.min(hlIdx + 1, last)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHl(Math.max(hlIdx - 1, 0)) }
    else if (e.key === 'Home' && !search) { e.preventDefault(); setHl(0) }
    else if (e.key === 'End' && !search) { e.preventDefault(); setHl(last) }
    else if (e.key === 'Enter') {
      const row = rows[hlIdx]
      if (!row) return
      e.preventDefault()
      onSelect(row.value)
      closeToTrigger()
    }
  }

  const rect = btnRef.current?.getBoundingClientRect()
  // The panel widens to fit the longest option so the list never has to wrap or
  // ellipsize. 7.4px/char is a conservative estimate for Rubik at 12px; the
  // extra 72px covers the check icon, horizontal padding and the search row.
  const longestOption = useMemo(
    () => options.reduce((m, o) => Math.max(m, o.length), clearLabel ? clearLabel.length : 0),
    [options, clearLabel]
  )
  // Never wider than the window, though: a pasted 130-character endpoint would
  // otherwise push the panel's left edge (and its search box) off the screen.
  // A row too long for it ends in an ellipsis, and only then do the rows carry
  // themselves as titles: a panel wide enough for every row shows no tooltips,
  // as it never did. (Only measured once the trigger has been: a server render
  // has no window.)
  const fit = Math.max(rect?.width || 160, Math.round(longestOption * 7.4 + 72))
  const panelW = rect ? Math.min(fit, window.innerWidth - 16) : fit
  const clamped = panelW < fit
  const overflows = rect && rect.left + panelW > window.innerWidth - 8
  // Right-anchored to the trigger when it would run off the right edge, and
  // then kept at least 8px from the left.
  const left = !rect ? 0 : overflows ? Math.max(8, rect.right - panelW) : rect.left

  return (
    <>
      <div
        ref={btnRef}
        className={`filter-select${className ? ` ${className}` : ''}${open ? ' dd-open' : ''}`}
        title={`${label}: ${showPlaceholder ? placeholder : value}`}
        role="button"
        tabIndex={0}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); if (open) close(); else openPanel(false) }}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="filter-label">{label}</span>
        <span className="filter-value">
          {showPlaceholder
            ? <span className="filter-placeholder" style={PLACEHOLDER_STYLE}>{placeholder}</span>
            : <span>{value}</span>}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
        </span>
      </div>
      {/* Portalled because a transformed ancestor (the sliding endpoint strip)
          becomes the containing block for position: fixed, which would offset
          the panel from its trigger. */}
      {open && rect && createPortal(
        <div
          ref={ref}
          className="dd-panel"
          style={{ position: 'fixed', top: rect.bottom + 4, left, width: panelW, zIndex: 500 }}
          onClick={e => e.stopPropagation()}
          // A press on a row must not take focus out of the search box: it
          // would blur the combobox (closing the panel) before the click that
          // chooses the row arrives.
          onMouseDown={e => { if (e.target !== e.currentTarget.querySelector('input')) e.preventDefault() }}
          onKeyDown={onPanelKeyDown}
          // Focus that leaves the panel for another control — one clicked in
          // the page, Tab handled above — closes it, so an open panel is never
          // left behind the control that now has focus. Focus going nowhere
          // (no relatedTarget: a click on plain page, or the window losing
          // focus) is the outside-click handler's to judge, as it always was;
          // closing here too would race a click on the trigger, which some
          // browsers do not focus, and reopen the panel that click closed.
          onBlur={e => {
            const to = e.relatedTarget
            if (!to || ref.current?.contains(to) || btnRef.current?.contains(to)) return
            close()
          }}
        >
          <div className="dd-search">
            <SearchGlyph />
            <input
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={hlIdx >= 0 ? optId(hlIdx) : undefined}
              placeholder="Search…"
              aria-label={`Search ${label} options`}
              value={search}
              onChange={e => { setSearch(e.target.value); setHl(e.target.value ? 0 : -1) }}
              onKeyDown={onSearchKeyDown}
              autoFocus
            />
          </div>
          <div ref={listRef} className="dd-list" role="listbox" id={listId} aria-label={label}>
            {rows.map((r, i) => {
              const chosen = r.clear ? isEmpty : r.value === value
              return (
                <div
                  // The clear row's key is not a string, so no option can share it.
                  key={r.clear ? 0 : r.value}
                  id={optId(i)}
                  role="option"
                  aria-selected={chosen}
                  className={`dd-item${chosen ? ' active' : ''}${kbd && i === hlIdx ? ' is-hl' : ''}`}
                  title={clamped ? r.label : undefined}
                  onClick={() => choose(r.value)}
                  onMouseEnter={() => setHl(i)}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="dd-item-check"><path d="M20 6L9 17l-5-5" /></svg>
                  <span className="dd-item-label">{r.label}</span>
                </div>
              )
            })}
          </div>
        </div>,
        document.body
      )}
    </>
  )
}
