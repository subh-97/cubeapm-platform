import { useState, useRef, useEffect, useLayoutEffect, useCallback, useId } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown } from 'lucide-react'
import { nextMenuIndex } from './alertShared'
import './alerts-shared.css'

/**
 * A labelled button that opens a menu: the shape the alert rows and the rule
 * page use for Snooze and Actions, where production put six icon-only buttons
 * (R11). The trigger always carries its word, and so does every item.
 *
 * The mechanics are CardMenu's (components/CardMenu.jsx), on purpose: anchored
 * with fixed coordinates because the rows it sits in clip their overflow, focus
 * moves into the menu so arrows and Escape reach it without a Tab, and a scroll
 * closes it rather than leaving it floating away from its button. The panel and
 * item classes are CardMenu's too, so the two menus look like one product.
 *
 * Two differences, both because these menus live inside a scrolling list. The
 * panel is portalled to the body, as FilterSelect's is, so no scroll container
 * or transformed ancestor can offset a fixed panel. And it takes focus only once
 * it has its position, without scrolling: focused while still parked off-screen,
 * the browser scrolls the list to reveal it, and that scroll closes the menu the
 * moment it opens.
 *
 * Items: `{ id, label, icon?, disabled?, title?, danger?, ariaLabel? }` or
 * `{ sep: true }`. A disabled item stays visible with its reason as its title.
 */
export default function MenuButton({
  label, icon: Icon, items, onSelect, disabled = false, title, ariaLabel, align = 'right', className = '',
}) {
  const [open, setOpen] = useState(false)
  const [hl, setHl] = useState(-1)
  const [pos, setPos] = useState(null)
  const btnRef = useRef(null)
  const menuRef = useRef(null)
  const menuId = useId()

  const close = useCallback(({ refocus } = {}) => {
    setOpen(false)
    setHl(-1)
    if (refocus) btnRef.current?.focus()
  }, [])

  useLayoutEffect(() => {
    if (!open) return
    const r = btnRef.current?.getBoundingClientRect()
    if (!r) return
    const h = menuRef.current?.offsetHeight ?? 0
    const below = window.innerHeight - r.bottom - 8
    const vertical = h > below && r.top > h ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }
    const horizontal = align === 'left' ? { left: Math.max(8, r.left) } : { right: Math.max(8, window.innerWidth - r.right) }
    setPos({ ...vertical, ...horizontal })
  }, [open, align, items.length])

  useEffect(() => {
    if (open && pos) menuRef.current?.focus({ preventScroll: true })
  }, [open, pos])

  useEffect(() => {
    if (!open) return
    const onDown = (e) => {
      if (menuRef.current?.contains(e.target) || btnRef.current?.contains(e.target)) return
      close()
    }
    const onScroll = () => close()
    document.addEventListener('mousedown', onDown)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [open, close])

  const choose = (item) => {
    if (!item || item.sep || item.disabled) return
    close({ refocus: true })
    onSelect?.(item.id)
  }

  // Keys handled here stop here: the menu often sits inside a row that expands
  // on Enter and Space, and a choice in the menu must not also toggle the row.
  const onKeyDown = (e) => {
    e.stopPropagation()
    if (e.key === 'Escape') { e.preventDefault(); close({ refocus: true }) }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setHl(i => nextMenuIndex(items, i < 0 ? -1 : i, 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHl(i => nextMenuIndex(items, i < 0 ? items.length : i, -1)) }
    else if (e.key === 'Enter' || e.key === ' ') {
      if (hl < 0) return
      e.preventDefault()
      choose(items[hl])
    }
    else if (e.key === 'Tab') close()
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`hbtn small alr-menu-btn${open ? ' open' : ''}${className ? ` ${className}` : ''}`}
        title={title}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        onClick={e => { e.stopPropagation(); setOpen(o => !o); setHl(-1) }}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') e.stopPropagation()
          if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); setOpen(true); setHl(nextMenuIndex(items, -1, 1)) }
        }}
      >
        {Icon && <Icon aria-hidden="true" />}
        {label}
        <ChevronDown className="chev" aria-hidden="true" />
      </button>
      {open && portal(
        <div
          ref={menuRef}
          id={menuId}
          className="card-menu-panel alr-menu-panel"
          role="menu"
          aria-label={label}
          tabIndex={-1}
          style={{ position: 'fixed', zIndex: 500, ...(pos ?? { top: 0, right: 0, visibility: 'hidden' }) }}
          onKeyDown={onKeyDown}
          onClick={e => e.stopPropagation()}
        >
          {items.map((item, i) => item.sep
            ? <div key={`sep-${i}`} className="card-menu-sep" role="separator" />
            : (
              <div
                key={item.id}
                role="menuitem"
                tabIndex={-1}
                aria-disabled={item.disabled || undefined}
                aria-label={item.ariaLabel}
                title={item.title || undefined}
                className={`card-menu-item${i === hl ? ' hl' : ''}${item.disabled ? ' disabled' : ''}${item.danger ? ' danger' : ''}`}
                onMouseEnter={() => { if (!item.disabled) setHl(i) }}
                onClick={() => choose(item)}
              >
                {item.icon}
                {item.label}
              </div>
            ))}
        </div>,
      )}
    </>
  )
}

// To the body in a browser; in place where there is no document (a server
// render draws the menu closed anyway).
const portal = node => (typeof document === 'undefined' ? node : createPortal(node, document.body))
