import { useState, useRef, useEffect, useId } from 'react'
import './title-dropdown.css'

// Simple inline dropdown for a panel-head title. Lightweight sibling of
// FilterSelect - renders a bold label with a caret, pops a short menu on
// click, closes on outside click. No search or multi-select.
//
// Moved here from ServiceOverview (the DB tab's "All Database Calls" title)
// so the Browser page's Traces panel can use the same control for its
// "10 results" picker. With neither of the two optional props it draws what
// it drew there, plus the two attributes that tell a screen reader the button
// opens a list and whether it is open:
//
//   className   an extra class on the button, for a picker that sits among
//               the head's right-hand controls rather than being its title
//               and so wants their smaller, lighter type
//   ariaLabel   an accessible name for the button, for a value that does not
//               say on its own what picking it changes ("10 results" of
//               what?). Keep the visible text inside it, so speech input that
//               says what is on screen still finds the button.
//
// The menu works from the keyboard as a listbox: it takes focus when it opens,
// on the current choice; the arrows, Home and End move along it, Enter or
// Space picks, and Escape or Tab closes it with focus back on the button.
// However it closes - a pick by key or by pointer included - focus ends on the
// button: the menu that held it is gone, and focus left in it would fall to
// the top of the document.
//
// The option the keys are on is only drawn (.is-hl) once the keyboard is in
// use - the menu opened by Enter, Space or an arrow, or a key pressed in it -
// so a menu opened and used with the pointer looks as it always has: no fill
// on the current choice as it opens, none left on the last option the pointer
// crossed. A screen reader hears the option through aria-activedescendant
// either way, and that draws nothing.
export default function TitleDropdown({ value, options, onChange, className, ariaLabel }) {
  const [open, setOpen] = useState(false)
  // The option the keyboard is on, as an index into `options`.
  const [hl, setHl] = useState(0)
  const [kbd, setKbd] = useState(false)
  const btnRef = useRef(null)
  const menuRef = useRef(null)
  const uid = useId()
  const optId = i => `${uid}-opt-${i}`

  useEffect(() => {
    if (!open) return
    const handler = e => {
      if (!btnRef.current?.contains(e.target) && !menuRef.current?.contains(e.target)) setOpen(false)
    }
    document.addEventListener('click', handler)
    return () => document.removeEventListener('click', handler)
  }, [open])

  // Into the menu as it opens, so the keys below reach it.
  useEffect(() => {
    if (open) menuRef.current?.focus({ preventScroll: true })
  }, [open])

  // `byKeys` when the keyboard opened it.
  const openMenu = (byKeys = false) => {
    setHl(Math.max(0, options.indexOf(value)))
    setKbd(byKeys)
    setOpen(true)
  }
  const closeToButton = () => { setOpen(false); btnRef.current?.focus({ preventScroll: true }) }
  const choose = o => { onChange(o); closeToButton() }

  const onButtonKeyDown = e => {
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !open) { e.preventDefault(); openMenu(true) }
  }
  const onMenuKeyDown = e => {
    if (e.key !== 'Tab' && e.key !== 'Escape') setKbd(true)
    const last = options.length - 1
    if (e.key === 'ArrowDown') { e.preventDefault(); setHl(i => Math.min(i + 1, last)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHl(i => Math.max(i - 1, 0)) }
    else if (e.key === 'Home') { e.preventDefault(); setHl(0) }
    else if (e.key === 'End') { e.preventDefault(); setHl(last) }
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      if (options[hl] != null) onChange(options[hl])
      closeToButton()
    } else if (e.key === 'Escape') {
      // One press undoes one thing: not the drawer or modal this may sit in.
      e.preventDefault()
      e.stopPropagation()
      closeToButton()
    } else if (e.key === 'Tab') {
      // Back on the button before the browser moves focus, so Tab goes on
      // from where the menu was opened.
      closeToButton()
    }
  }

  const rect = btnRef.current?.getBoundingClientRect()
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`title-dropdown${className ? ` ${className}` : ''}${open ? ' open' : ''}`}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        // A click a key made (Enter or Space on the button) has no pointer
        // behind it, and says so with detail 0.
        onClick={e => { e.stopPropagation(); if (open) setOpen(false); else openMenu(e.detail === 0) }}
        onKeyDown={onButtonKeyDown}
      >
        <span>{value}</span>
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
      </button>
      {open && rect && (
        <div
          ref={menuRef}
          className="title-dropdown-menu"
          role="listbox"
          tabIndex={-1}
          aria-label={ariaLabel ?? value}
          aria-activedescendant={options[hl] != null ? optId(hl) : undefined}
          style={{ position: 'fixed', top: rect.bottom + 4, left: rect.left, minWidth: rect.width }}
          onKeyDown={onMenuKeyDown}
          // A press on an option must not blur the menu before its click lands.
          onMouseDown={e => e.preventDefault()}
          // Focus leaving for another control closes the menu, so it is never
          // left open behind whatever took focus. Focus going nowhere (no
          // relatedTarget) is left to the outside-click handler above: Safari
          // and Firefox on the Mac do not focus a button they click, so a
          // press on this one to close the menu blurs it towards nothing, and
          // closing here would let that same press's click open it again.
          onBlur={e => {
            const to = e.relatedTarget
            if (!to || menuRef.current?.contains(to) || btnRef.current?.contains(to)) return
            setOpen(false)
          }}
        >
          {options.map((o, i) => (
            <div
              key={o}
              id={optId(i)}
              role="option"
              aria-selected={o === value}
              className={`title-dropdown-item${o === value ? ' active' : ''}${kbd && i === hl ? ' is-hl' : ''}`}
              onClick={() => choose(o)}
              onMouseEnter={() => setHl(i)}
            >
              {o}
            </div>
          ))}
        </div>
      )}
    </>
  )
}
