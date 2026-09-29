import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, Check } from 'lucide-react'
import clsx from 'clsx'

// Tall enough that the full function catalog fits without scrolling; long
// lists (the field picker) still cap here and scroll internally.
const MENU_MAX_H = 360
const GAP = 4

// A small styled dropdown used inside the aggregation popover for function
// and field pickers. Native <select> chrome doesn't match our dark theme, so
// this renders a themed button + list. Accepts either flat options
// (`[{ value, label, hint, disabled }]`) or grouped options
// (`[{ group: 'Label', items: [...] }]`). Registers its Escape/outside-click
// handlers only while open; runs the Escape handler in the capture phase and
// calls stopImmediatePropagation so a parent popover doesn't also dismiss.
//
// The menu is portaled to <body> and positioned fixed against the button's
// viewport rect. It lives inside PipePopover, whose scrollable body would
// otherwise clip an absolutely-positioned menu — portaling puts it outside
// every ancestor's overflow context. It flips above the button when there
// isn't room below.
export default function PipeSelect({
  value,
  onChange,
  options,
  placeholder = 'Choose…',
  disabled = false,
  className,
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState(null)
  const wrapRef = useRef(null)
  const btnRef = useRef(null)
  const menuRef = useRef(null)

  const isGrouped = Array.isArray(options) && options.some(o => o && Array.isArray(o.items))
  const flatOpts = isGrouped ? options.flatMap(g => g.items) : (options || [])
  const current = flatOpts.find(o => o.value === value)

  // Position before paint so the menu never flashes at the wrong spot.
  useLayoutEffect(() => {
    if (!open) return
    const compute = () => {
      const btn = btnRef.current
      if (!btn) return
      const r = btn.getBoundingClientRect()
      const below = window.innerHeight - r.bottom - GAP - 8
      const above = r.top - GAP - 8
      const flip = below < Math.min(MENU_MAX_H, 160) && above > below
      setPos({
        left: r.left,
        width: r.width,
        top: flip ? undefined : r.bottom + GAP,
        bottom: flip ? window.innerHeight - r.top + GAP : undefined,
        maxHeight: Math.min(MENU_MAX_H, flip ? above : below),
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

  // The menu lives outside .pipe-pop in the DOM, so the parent popover's
  // document-level outside-click check would read a menu click as "outside"
  // and dismiss itself. Swallow mousedown at the menu so it never reaches
  // document; `click` is a separate event, so item selection still fires.
  useEffect(() => {
    const el = menuRef.current
    if (!el) return
    const stop = (e) => e.stopPropagation()
    el.addEventListener('mousedown', stop)
    return () => el.removeEventListener('mousedown', stop)
  }, [open, pos])

  useEffect(() => {
    if (!open) return
    const onDown = (e) => {
      if (wrapRef.current?.contains(e.target)) return
      if (menuRef.current?.contains(e.target)) return
      setOpen(false)
    }
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation()
        e.preventDefault()
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  const renderItem = (opt) => (
    <button
      key={opt.value}
      type="button"
      className={clsx('pipe-select-item', {
        'is-selected': opt.value === value,
        'is-disabled': opt.disabled,
      })}
      onClick={() => {
        if (opt.disabled) return
        onChange(opt.value)
        setOpen(false)
      }}
      disabled={opt.disabled}
    >
      <span className="pipe-select-item-label">{opt.label ?? opt.value}</span>
      {opt.hint && <span className="pipe-select-item-hint">{opt.hint}</span>}
      {opt.value === value && <Check size={12} strokeWidth={2.4} className="pipe-select-item-check" />}
    </button>
  )

  const menu = open && pos && createPortal(
    <div
      ref={menuRef}
      className="pipe-select-menu"
      role="listbox"
      style={{
        left: pos.left,
        width: pos.width,
        top: pos.top,
        bottom: pos.bottom,
        maxHeight: pos.maxHeight,
      }}
    >
      {isGrouped
        ? options.map(g => (
            <div key={g.group} className="pipe-select-group">
              <div className="pipe-select-group-lbl">{g.group}</div>
              {g.items.map(renderItem)}
            </div>
          ))
        : (options || []).map(renderItem)}
    </div>,
    document.body
  )

  return (
    <div ref={wrapRef} className={clsx('pipe-select', { 'is-open': open, 'is-disabled': disabled }, className)}>
      <button
        ref={btnRef}
        type="button"
        className="pipe-select-btn"
        onClick={() => { if (!disabled) setOpen(o => !o) }}
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        <span className={clsx('pipe-select-value', { 'is-placeholder': !current })}>
          {current ? (current.label ?? current.value) : placeholder}
        </span>
        <ChevronDown size={13} strokeWidth={2} className="pipe-select-chev" />
      </button>
      {menu}
    </div>
  )
}
