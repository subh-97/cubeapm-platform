import { createContext, useContext, useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react'

// The per-card overflow menu. Every card on the service pages carries one, and
// what it offers is decided by what the card holds rather than by where it sits:
// a single number can be alerted on and explored, a chart can additionally be
// compared against another window, and a table offers that pair per column plus
// an export. Production CubeAPM puts the same control in the same corner, so the
// menu is the one place a reader already looks for "what can I do with this".

export const CardActionContext = createContext(null)

const ICONS = {
  alert: <><path d="M18 8A6 6 0 006 8c0 7-3 7-3 9h18c0-2-3-2-3-9" /><path d="M13.7 21a2 2 0 01-3.4 0" /></>,
  explore: <><circle cx="12" cy="12" r="9" /><path d="M16 8l-2.4 5.6L8 16l2.4-5.6z" /></>,
  compare: <><rect x="3" y="4" width="7" height="16" rx="1" /><rect x="14" y="4" width="7" height="16" rx="1" /></>,
  csv: <><path d="M12 3v12" /><path d="M7 11l5 5 5-5" /><path d="M4 20h16" /></>,
}

// `total` names the aggregate series a stacked chart also carries, so the menu
// can offer the breakdown and the total separately - the drilldown's total
// latency is a different thing to alert on than any one of its layers.
function itemsFor({ kind, columns, total }) {
  if (kind === 'metric') {
    return [
      { icon: 'alert', label: 'Create Alert' },
      { icon: 'explore', label: 'Explore' },
    ]
  }
  if (kind === 'chart') {
    const base = [
      { icon: 'compare', label: 'Compare' },
      { icon: 'alert', label: 'Create Alert' },
      { icon: 'explore', label: 'Explore' },
    ]
    if (!total) return base
    return [
      ...base,
      { icon: 'alert', label: `Create Alert (${total})` },
      { icon: 'explore', label: `Explore (${total})` },
    ]
  }
  if (kind === 'table') {
    return [
      ...(columns ?? []).flatMap(c => [
        { icon: 'alert', label: `Create Alert - ${c}` },
        { icon: 'explore', label: `Explore - ${c}` },
      ]),
      { sep: true },
      { icon: 'csv', label: 'Download CSV' },
    ]
  }
  return [
    { icon: 'explore', label: 'Explore' },
    { sep: true },
    { icon: 'csv', label: 'Download CSV' },
  ]
}

export default function CardMenu({ kind = 'chart', title, columns, total, onAction }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState(null)
  const [hl, setHl] = useState(-1)
  const btnRef = useRef(null)
  const menuRef = useRef(null)
  const fromContext = useContext(CardActionContext)
  const act = onAction ?? fromContext

  const items = itemsFor({ kind, columns, total })
  const options = items.filter(i => !i.sep)

  const close = useCallback(({ refocus } = {}) => {
    setOpen(false)
    setHl(-1)
    if (refocus) btnRef.current?.focus()
  }, [])

  // Anchored with fixed coordinates rather than an absolutely positioned child:
  // most of these cards clip their overflow, which would cut the menu off.
  useLayoutEffect(() => {
    if (!open) return
    const r = btnRef.current?.getBoundingClientRect()
    if (!r) return
    const h = menuRef.current?.offsetHeight ?? 0
    const below = window.innerHeight - r.bottom - 8
    setPos({
      right: Math.max(8, window.innerWidth - r.right),
      ...(h > below && r.top > h ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }),
    })
  }, [open, items.length])

  // The menu takes focus so arrow keys and Escape reach it without the reader
  // having to tab into it first.
  useEffect(() => {
    if (open) menuRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (e) => {
      if (menuRef.current?.contains(e.target) || btnRef.current?.contains(e.target)) return
      close()
    }
    // The card sits in a scrolling shell, and a fixed menu would drift away from
    // its button - so a scroll closes it rather than chasing it.
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
    close({ refocus: true })
    act?.(item.label, title)
  }

  const onKeyDown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close({ refocus: true }) }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setHl(i => Math.min(i + 1, options.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHl(i => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter' || e.key === ' ') {
      if (hl < 0) return
      e.preventDefault()
      choose(options[hl])
    }
    else if (e.key === 'Tab') close()
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`card-menu-btn${open ? ' open' : ''}`}
        title={title ? `${title} options` : 'Card options'}
        aria-label={title ? `${title} options` : 'Card options'}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={e => { e.stopPropagation(); setOpen(o => !o); setHl(-1) }}
        onKeyDown={e => { if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setHl(0) } }}
      >
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="12" cy="5" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="12" cy="19" r="1.7" />
        </svg>
      </button>
      {open && (
        <div
          ref={menuRef}
          className="card-menu-panel"
          role="menu"
          aria-label={title ? `${title} options` : 'Card options'}
          tabIndex={-1}
          style={{ position: 'fixed', zIndex: 500, ...(pos ?? { top: -9999, right: 0 }) }}
          onKeyDown={onKeyDown}
          onClick={e => e.stopPropagation()}
        >
          {items.map((item, i) => item.sep
            ? <div key={`sep-${i}`} className="card-menu-sep" />
            : (
              <div
                key={item.label}
                role="menuitem"
                tabIndex={-1}
                className={`card-menu-item${options.indexOf(item) === hl ? ' hl' : ''}`}
                onMouseEnter={() => setHl(options.indexOf(item))}
                onClick={() => choose(item)}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  {ICONS[item.icon]}
                </svg>
                {item.label}
              </div>
            ))}
        </div>
      )}
    </>
  )
}
