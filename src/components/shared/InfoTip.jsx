import { useState, useRef, useId, useLayoutEffect, useEffect, useCallback } from 'react'

/**
 * The small ⓘ beside a panel title, and the explanation it holds.
 *
 * Panels used to carry their caveats as a line of grey text in the header,
 * which costs a line of width on every render to say something a reader needs
 * once. The icon keeps the explanation one hover away and the header short.
 *
 * The bubble is positioned fixed rather than absolutely: these panels clip
 * their overflow, and an absolutely positioned tooltip is cut off by the card.
 */
export default function InfoTip({ label = 'More information', children, width = 320 }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState(null)
  const btnRef = useRef(null)
  const tipRef = useRef(null)
  const id = useId()

  const close = useCallback(() => setOpen(false), [])

  useLayoutEffect(() => {
    if (!open) return
    const r = btnRef.current?.getBoundingClientRect()
    if (!r) return
    const h = tipRef.current?.offsetHeight ?? 0
    const half = width / 2
    const center = r.left + r.width / 2
    // Keep the bubble on screen, then point the arrow back at the icon.
    const left = Math.min(Math.max(8, center - half), window.innerWidth - width - 8)
    const below = window.innerHeight - r.bottom - 12
    const flip = h > below && r.top > h
    setPos({
      left,
      arrow: Math.min(Math.max(12, center - left), width - 12),
      flip,
      ...(flip ? { bottom: window.innerHeight - r.top + 8 } : { top: r.bottom + 8 }),
    })
  }, [open, width])

  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === 'Escape') close() }
    const onScroll = () => close()
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [open, close])

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`infotip-btn${open ? ' open' : ''}`}
        aria-label={label}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={close}
        onFocus={() => setOpen(true)}
        onBlur={close}
        onClick={e => { e.stopPropagation(); setOpen(o => !o) }}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 16v-4M12 8.5v.01" />
        </svg>
      </button>
      {open && (
        <div
          ref={tipRef}
          id={id}
          role="tooltip"
          className={`infotip${pos?.flip ? ' flip' : ''}`}
          style={{
            position: 'fixed',
            width,
            zIndex: 600,
            ...(pos ? { left: pos.left, ...(pos.flip ? { bottom: pos.bottom } : { top: pos.top }) } : { top: -9999, left: 0 }),
            '--infotip-arrow': `${pos?.arrow ?? 12}px`,
          }}
        >
          {children}
        </div>
      )}
    </>
  )
}
