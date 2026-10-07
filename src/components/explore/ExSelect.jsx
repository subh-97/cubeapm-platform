import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, RotateCw } from 'lucide-react'
import clsx from 'clsx'
import './explore-controls.css'

// The one dropdown every Explore editor is built from: the datasource picker,
// the WHERE rows, the operation cards, the toolbar's Legend value and Type.
// A native <select> cannot carry a second line of help, a checkbox, a loading
// row or a retry, and Explore needs all four.
//
// Two things about it are not decoration.
//
// The menu is portaled and positioned FIXED against the trigger's viewport
// rect, then clamped to the viewport. Explore's editors sit inside cards that
// scroll and clip; an absolutely positioned menu is cut off by the first
// ancestor with `overflow` long before the person sees it, and a row near the
// right edge of the window opens a menu that runs off the screen. Portaling
// escapes every overflow context, and the clamp keeps the list on screen.
//
// Options are usually FETCHED when the menu opens — label values depend on the
// rows above and on the time range, so a list cached at mount is stale by the
// time it is read. `onOpen` is that fetch; `loading`, `error` and `onRetry` are
// what the caller shows while it is in flight or after it failed. A dropdown
// that opens empty with no explanation is indistinguishable from a dropdown
// with nothing to offer, which is the reference's worst dead end.

const MENU_MAX_H = 320
const MIN_W = 180
const GAP = 4
const EDGE = 8
// Long enough to type `ship` into a list of services, short enough that coming
// back to the keyboard a moment later starts a new word.
const TYPEAHEAD_MS = 700

const normalise = options => (options ?? []).map(o => (
  typeof o === 'string' ? { value: o, label: o } : o
)).filter(Boolean)

const textOf = o => String(o.label ?? o.value ?? '')

export default function ExSelect({
  value,
  options,
  onChange,
  multiple = false,
  searchable = false,
  placeholder = 'Choose…',
  onOpen,
  loading = false,
  error = null,
  onRetry,
  disabled = false,
  width,
  renderValue,
  ariaLabel,
  className,
  id,
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState(null)
  const [highlight, setHighlight] = useState(0)
  const [search, setSearch] = useState('')
  const wrapRef = useRef(null)
  const btnRef = useRef(null)
  const menuRef = useRef(null)
  const listRef = useRef(null)
  const searchRef = useRef(null)
  const typeahead = useRef({ text: '', at: 0 })
  const reactId = useId()
  const listId = `${id ?? reactId}-list`

  const all = useMemo(() => normalise(options), [options])
  const selected = useMemo(
    () => new Set(multiple ? (Array.isArray(value) ? value : []) : (value == null ? [] : [value])),
    [multiple, value]
  )

  const shown = useMemo(() => {
    const q = searchable ? search.trim().toLowerCase() : ''
    if (!q) return all
    return all.filter(o => (
      textOf(o).toLowerCase().includes(q)
      || String(o.value ?? '').toLowerCase().includes(q)
      || String(o.description ?? '').toLowerCase().includes(q)
    ))
  }, [all, search, searchable])

  // Position before paint, so the menu never flashes at the wrong spot, and
  // again on scroll or resize because the trigger moves under it.
  useLayoutEffect(() => {
    if (!open) return undefined
    const compute = () => {
      const btn = btnRef.current
      if (!btn) return
      const r = btn.getBoundingClientRect()
      const vw = window.innerWidth
      const vh = window.innerHeight
      const w = Math.max(MIN_W, Math.min(Math.max(r.width, MIN_W), vw - 2 * EDGE))
      const below = vh - r.bottom - GAP - EDGE
      const above = r.top - GAP - EDGE
      const flip = below < Math.min(MENU_MAX_H, 200) && above > below
      setPos({
        left: Math.min(Math.max(EDGE, r.left), Math.max(EDGE, vw - w - EDGE)),
        width: w,
        top: flip ? undefined : r.bottom + GAP,
        bottom: flip ? vh - r.top + GAP : undefined,
        maxHeight: Math.max(120, Math.min(MENU_MAX_H, flip ? above : below)),
      })
    }
    compute()
    window.addEventListener('resize', compute)
    window.addEventListener('scroll', compute, true)
    return () => {
      window.removeEventListener('resize', compute)
      window.removeEventListener('scroll', compute, true)
    }
  }, [open])

  const close = useCallback(({ refocus = true } = {}) => {
    setOpen(false)
    setSearch('')
    if (refocus) btnRef.current?.focus()
  }, [])

  // Outside click and Escape, registered only while open. Escape runs in the
  // capture phase and stops immediately so a parent popover does not also close
  // — one key, one dismissal.
  useEffect(() => {
    if (!open) return undefined
    const onDown = (e) => {
      if (wrapRef.current?.contains(e.target)) return
      if (menuRef.current?.contains(e.target)) return
      close({ refocus: false })
    }
    const onKey = (e) => {
      if (e.key !== 'Escape') return
      e.stopImmediatePropagation()
      e.preventDefault()
      close()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open, close])

  // The menu lives outside this component's DOM, so a parent's own
  // outside-click check would read a click in it as "outside" and dismiss
  // itself. Swallow mousedown at the menu; `click` is a separate event, so
  // picking an option still works.
  useEffect(() => {
    const el = menuRef.current
    if (!el) return undefined
    const stop = e => e.stopPropagation()
    el.addEventListener('mousedown', stop)
    return () => el.removeEventListener('mousedown', stop)
  }, [open, pos])

  useEffect(() => {
    if (open && searchable) searchRef.current?.focus()
  }, [open, searchable])

  // A list that changed under the cursor cannot keep its old position.
  useEffect(() => { setHighlight(0) }, [search])

  useEffect(() => {
    if (!open) return
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [open, highlight, shown.length])

  const openMenu = () => {
    if (disabled || open) return
    const first = shown.findIndex(o => selected.has(o.value))
    setHighlight(first === -1 ? 0 : first)
    setOpen(true)
    onOpen?.()
  }

  const pick = (opt) => {
    if (!opt || opt.disabled) return
    if (multiple) {
      const current = Array.isArray(value) ? value : []
      const next = current.includes(opt.value)
        ? current.filter(v => v !== opt.value)
        : [...current, opt.value]
      onChange?.(next)
      return   // a multi-select stays open: picking three values is one gesture
    }
    onChange?.(opt.value)
    close()
  }

  // Jumping to a value by typing its first letters — the behaviour a native
  // <select> has and a themed one usually loses. Only when there is no search
  // box; with one, the characters belong to it.
  const typeTo = (ch) => {
    const now = Date.now()
    const t = typeahead.current
    t.text = now - t.at > TYPEAHEAD_MS ? ch : t.text + ch
    t.at = now
    const i = shown.findIndex(o => textOf(o).toLowerCase().startsWith(t.text))
    if (i !== -1) setHighlight(i)
  }

  const onKeyDown = (e) => {
    if (disabled) return
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        openMenu()
      }
      return
    }
    const n = shown.length
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        if (n) setHighlight(h => (h + 1) % n)
        break
      case 'ArrowUp':
        e.preventDefault()
        if (n) setHighlight(h => (h - 1 + n) % n)
        break
      case 'Home':
        e.preventDefault()
        setHighlight(0)
        break
      case 'End':
        e.preventDefault()
        setHighlight(Math.max(0, n - 1))
        break
      case 'Enter':
        e.preventDefault()
        if (n) pick(shown[Math.min(highlight, n - 1)])
        break
      case ' ':
        // In a search box a space is a space. Everywhere else it picks, the way
        // a native select does.
        if (!searchable) { e.preventDefault(); if (n) pick(shown[Math.min(highlight, n - 1)]) }
        break
      case 'Tab':
        close({ refocus: false })
        break
      default:
        if (!searchable && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) typeTo(e.key)
    }
  }

  const label = (() => {
    if (renderValue) return renderValue(value)
    if (multiple) {
      const picked = all.filter(o => selected.has(o.value))
      if (!picked.length) return null
      return picked.length <= 2 ? picked.map(textOf).join(', ') : `${picked.length} selected`
    }
    const one = all.find(o => o.value === value)
    if (one) return textOf(one)
    return value == null || value === '' ? null : String(value)
  })()

  const activeId = open && shown.length ? `${listId}-${Math.min(highlight, shown.length - 1)}` : undefined

  const rows = []
  let lastGroup
  shown.forEach((opt, i) => {
    if (opt.group && opt.group !== lastGroup) {
      rows.push(<div key={`g-${opt.group}-${i}`} className="ex-select-group" role="presentation">{opt.group}</div>)
    }
    lastGroup = opt.group
    const isOn = selected.has(opt.value)
    rows.push(
      <button
        key={`${opt.value}-${i}`}
        id={`${listId}-${i}`}
        type="button"
        role="option"
        tabIndex={-1}
        aria-selected={isOn}
        aria-disabled={opt.disabled || undefined}
        data-active={i === Math.min(highlight, shown.length - 1)}
        className={clsx('ex-select-item', { 'is-on': isOn, 'is-disabled': opt.disabled })}
        onMouseEnter={() => setHighlight(i)}
        onMouseDown={e => e.preventDefault()}
        onClick={() => pick(opt)}
      >
        {multiple && (
          <span className={clsx('ex-select-box', { 'is-on': isOn })} aria-hidden="true">
            {isOn && <Check size={11} strokeWidth={3} />}
          </span>
        )}
        <span className="ex-select-item-text">
          <span className="ex-select-item-label">{textOf(opt)}</span>
          {opt.description && <span className="ex-select-item-desc">{opt.description}</span>}
        </span>
        {!multiple && isOn && <Check size={12} strokeWidth={2.4} className="ex-select-tick" />}
      </button>
    )
  })

  const menu = open && pos && createPortal(
    <div
      ref={menuRef}
      className="ex-select-menu"
      style={{ left: pos.left, width: pos.width, top: pos.top, bottom: pos.bottom }}
    >
      {searchable && (
        <div className="ex-select-search">
          <input
            ref={searchRef}
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search…"
            aria-label={`Search ${ariaLabel ?? 'options'}`}
            aria-controls={listId}
            aria-activedescendant={activeId}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
      )}
      <div
        ref={listRef}
        className="ex-select-list"
        id={listId}
        role="listbox"
        aria-label={ariaLabel}
        aria-multiselectable={multiple || undefined}
        style={{ maxHeight: pos.maxHeight }}
      >
        {loading && <div className="ex-select-note" role="status">Loading…</div>}
        {!loading && error && (
          <div className="ex-select-note is-error" role="alert">
            <span>{typeof error === 'string' ? error : 'Could not load options'}</span>
            {onRetry && (
              <button type="button" className="ex-select-retry" onClick={() => onRetry()}>
                <RotateCw size={11} strokeWidth={2} aria-hidden="true" />
                Retry
              </button>
            )}
          </div>
        )}
        {!loading && !error && !shown.length && (
          <div className="ex-select-note">{all.length ? 'No match' : 'Nothing to choose'}</div>
        )}
        {!loading && !error && rows}
      </div>
    </div>,
    document.body
  )

  return (
    <div
      ref={wrapRef}
      className={clsx('ex-select', { 'is-open': open, 'is-disabled': disabled }, className)}
      style={width ? { width } : undefined}
    >
      <button
        ref={btnRef}
        id={id}
        type="button"
        className="ex-select-btn"
        disabled={disabled}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={searchable ? undefined : activeId}
        aria-label={ariaLabel}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={onKeyDown}
      >
        <span className={clsx('ex-select-value', { 'is-placeholder': label == null })}>
          {label ?? placeholder}
        </span>
        <ChevronDown size={13} strokeWidth={2} className="ex-select-chev" aria-hidden="true" />
      </button>
      {menu}
    </div>
  )
}
