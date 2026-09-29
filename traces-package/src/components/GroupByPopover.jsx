import { useMemo, useRef, useState, useEffect } from 'react'
import { Search, X, Check } from 'lucide-react'
import clsx from 'clsx'
import PipePopover from './PipePopover'

// Multi-select field picker that drives the stats pipe's `groupBy` array.
// Commits live (no Save button): each toggle updates the parent immediately.
// Order matters — CubeAPM emits `by (field1, field2)` in the order the user
// selected them, so toggling ON appends to the end of the array and toggling
// OFF removes-in-place.
export default function GroupByPopover({
  anchorRef,
  open,
  onClose,
  fields = [],            // [{ field, type, desc, highCard }]
  selected = [],          // string[]
  onChange,
}) {
  const [query, setQuery] = useState('')
  const searchRef = useRef(null)

  useEffect(() => {
    if (open) {
      setQuery('')
      // autoFocus fights the popover mount, defer a tick
      setTimeout(() => searchRef.current?.focus(), 10)
    }
  }, [open])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return fields
    return fields.filter(f => f.field.toLowerCase().includes(q))
  }, [fields, query])

  const selectedSet = useMemo(() => new Set(selected), [selected])

  // Functional updater so rapid consecutive toggles don't collide on stale
   // props — the parent sees each transition applied to the latest state.
  const toggle = (fieldName) => {
    onChange?.(prev => {
      const arr = prev || []
      return arr.includes(fieldName)
        ? arr.filter(f => f !== fieldName)
        : [...arr, fieldName]
    })
  }

  const clearAll = () => onChange?.([])

  return (
    <PipePopover
      anchorRef={anchorRef}
      open={open}
      onClose={onClose}
      title="Group by"
      subtitle="Split results by field values"
      width={300}
    >
      <div className="gby-form">
        <div className="gby-search">
          <Search size={13} strokeWidth={2} className="gby-search-icon" />
          <input
            ref={searchRef}
            type="text"
            className="gby-search-input"
            placeholder="Search fields…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button
              type="button"
              className="gby-search-clear"
              onClick={() => { setQuery(''); searchRef.current?.focus() }}
              aria-label="Clear search"
            >
              <X size={12} strokeWidth={2.2} />
            </button>
          )}
        </div>

        <ul className="gby-list" role="listbox" aria-multiselectable="true">
          {filtered.length === 0 && (
            <li className="gby-empty">No fields match “{query}”.</li>
          )}
          {filtered.map(f => {
            const on = selectedSet.has(f.field)
            return (
              <li key={f.field}>
                <button
                  type="button"
                  role="option"
                  aria-selected={on}
                  className={clsx('gby-row', { 'is-on': on })}
                  onClick={() => toggle(f.field)}
                >
                  <span className={clsx('gby-check', { 'is-on': on })}>
                    {on && <Check size={11} strokeWidth={3} />}
                  </span>
                  <span className="gby-name mono">{f.field}</span>
                  {f.highCard && <span className="gby-tag gby-tag-warn" title="High cardinality — grouping may produce many series">high card</span>}
                  {!f.highCard && f.type === 'keyword' && <span className="gby-tag">numeric</span>}
                </button>
              </li>
            )
          })}
        </ul>

        <div className="gby-footer">
          <span className="gby-count">
            {selected.length === 0 ? 'None selected' : `${selected.length} selected`}
          </span>
          {selected.length > 0 && (
            <button type="button" className="gby-clear" onClick={clearAll}>Clear all</button>
          )}
        </div>
      </div>
    </PipePopover>
  )
}
