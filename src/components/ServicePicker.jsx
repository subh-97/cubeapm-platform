import { useState, useRef, useEffect, useCallback } from 'react'
import { services } from '@/data/services'

// A combobox modelled on the production service selector: the field itself
// turns into the search box, and the list opens directly underneath it.
//
// One deliberate difference: production lists services alphabetically, and
// this lists them in the order the data layer already sorts them - critical,
// then warning, then healthy - so an incident is the first thing in the list
// however much of it the search leaves.

export default function ServicePicker({ serviceId, onSelect }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [hl, setHl] = useState(0)
  const rootRef = useRef(null)
  const btnRef = useRef(null)
  const inputRef = useRef(null)
  const listRef = useRef(null)
  // Set when the list closes from the keyboard, so focus returns to the field
  // rather than dropping to the page.
  const refocus = useRef(false)

  const current = services.find(s => s.id === serviceId) || services[0]
  const q = query.trim().toLowerCase()
  const matches = q ? services.filter(s => s.name.toLowerCase().includes(q)) : services

  const close = useCallback(() => { setOpen(false); setQuery('') }, [])

  const openList = () => {
    setHl(Math.max(0, services.findIndex(s => s.id === current.id)))
    setOpen(true)
  }

  const choose = (s) => {
    close()
    if (s.id !== current.id) onSelect(s.id)
  }

  useEffect(() => {
    if (open) inputRef.current?.focus()
    else if (refocus.current) {
      refocus.current = false
      btnRef.current?.focus()
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (e) => { if (!rootRef.current?.contains(e.target)) close() }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open, close])

  useEffect(() => {
    if (open) listRef.current?.children[hl]?.scrollIntoView({ block: 'nearest' })
  }, [hl, open])

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHl(i => Math.min(i + 1, matches.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHl(i => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter') {
      e.preventDefault()
      if (!matches[hl]) return
      refocus.current = true
      choose(matches[hl])
    }
    else if (e.key === 'Escape') { e.preventDefault(); refocus.current = true; close() }
    else if (e.key === 'Tab') close()
  }

  return (
    <div className="svc-picker" ref={rootRef}>
      <div className={`svc-picker-field${open ? ' open' : ''}`}>
        {open ? (
          <div className="svc-picker-control">
            <span className="svc-picker-label" aria-hidden="true">Service</span>
            <input
              ref={inputRef}
              className="svc-picker-input mono"
              role="combobox"
              aria-label="Search services"
              aria-expanded="true"
              aria-controls="svc-picker-list"
              aria-activedescendant={matches[hl] ? `svc-opt-${matches[hl].id}` : undefined}
              placeholder={current.name}
              value={query}
              onChange={e => { setQuery(e.target.value); setHl(0) }}
              onKeyDown={onKeyDown}
            />
            <svg className="svc-picker-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>
          </div>
        ) : (
          <button
            ref={btnRef}
            type="button"
            className="svc-picker-control"
            onClick={openList}
            onKeyDown={e => { if (e.key === 'ArrowDown') { e.preventDefault(); openList() } }}
            title="Switch service"
            aria-label={`Service: ${current.name}. Switch service`}
            aria-haspopup="listbox"
            aria-expanded="false"
          >
            <span className="svc-picker-label" aria-hidden="true">Service</span>
            <span className="svc-picker-name mono">{current.name}</span>
            {current.language && <span className="svc-lang">{current.language}</span>}
            <svg className="svc-picker-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
          </button>
        )}
        {open && (
          <div className="svc-picker-list" id="svc-picker-list" role="listbox" aria-label="Services" ref={listRef}>
            {matches.map((s, i) => (
              <div
                key={s.id}
                id={`svc-opt-${s.id}`}
                role="option"
                aria-selected={s.id === current.id}
                className={`svc-picker-item${s.id === current.id ? ' active' : ''}${i === hl ? ' hl' : ''}`}
                onMouseDown={e => e.preventDefault()}
                onMouseEnter={() => setHl(i)}
                onClick={() => choose(s)}
              >
                <span className="svc-picker-name mono">{s.name}</span>
                {s.language && <span className="svc-lang">{s.language}</span>}
              </div>
            ))}
            {matches.length === 0 && <div className="svc-picker-empty">No services match “{query.trim()}”</div>}
          </div>
        )}
      </div>
    </div>
  )
}
