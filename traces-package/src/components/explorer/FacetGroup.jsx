import { useState, useEffect } from 'react'

// Rows visible before the facet list starts scrolling.
const FACET_VISIBLE_ROWS = 6

/**
 * One collapsible facet: a searchable, checkable list of a field's values.
 *
 * Shared by Logs and Traces. The two pages differ in which fields earn a facet
 * and what the counts mean, never in how a facet behaves — so this file is the
 * single place that interaction is defined, and the pages hand it options.
 *
 * The "N selected" count doubles as the control that narrows the list to those
 * selections. One affordance for every facet: log.level used to carry a second,
 * text-link version of the same action, which made the panel's first group the
 * one place the interaction had to be learnt twice.
 */
export default function FacetGroup({ title, options = [], selected, onToggle }) {
  const [open, setOpen] = useState(true)
  const [q, setQ] = useState('')
  const [onlySelected, setOnlySelected] = useState(false)

  const selectedCount = options.filter(o => selected.has(o.value)).length

  // Unchecking the last value while filtered to selections would strand the user
  // on an empty list, so drop back to showing everything.
  useEffect(() => {
    if (onlySelected && selectedCount === 0) setOnlySelected(false)
  }, [onlySelected, selectedCount])

  const searched = q ? options.filter(o => o.value.toLowerCase().includes(q.toLowerCase())) : options
  const shown = onlySelected ? searched.filter(o => selected.has(o.value)) : searched
  const scrollable = shown.length > FACET_VISIBLE_ROWS

  return (
    <div className="facet-group">
      <div className="facet-head" onClick={() => setOpen(o => !o)}>
        <div>
          <div className="facet-title">{title}</div>
          <div className="facet-meta">
            <div className="facet-meta-left">
              <span>{options.length} total ·</span>
              {selectedCount === 0 ? (
                <span>{selectedCount} selected</span>
              ) : (
                <button
                  type="button"
                  className={`facet-sel-toggle${onlySelected ? ' on' : ''}`}
                  aria-pressed={onlySelected}
                  title={onlySelected
                    ? `Showing only selected — click to show all ${options.length} values`
                    : `Show only the ${selectedCount} selected value${selectedCount === 1 ? '' : 's'}`}
                  onClick={(e) => { e.stopPropagation(); setOpen(true); setOnlySelected(v => !v) }}
                >
                  {selectedCount} selected
                  {onlySelected ? (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                  ) : (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                  )}
                </button>
              )}
            </div>
            {selectedCount > 0 && (
              <button
                type="button"
                className="facet-clear-btn-meta"
                title="Clear selected"
                onClick={(e) => { e.stopPropagation(); [...selected].forEach(v => onToggle(title, v)) }}
              >
                <span>Clear</span>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
              </button>
            )}
          </div>
        </div>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={`facet-chev${open ? ' open' : ''}`}><path d="M6 9l6 6 6-6"/></svg>
      </div>
      {open && (
        <>
          <div className="facet-search">
            <input placeholder="search…" value={q} onChange={e => setQ(e.target.value)} />
          </div>
          <div className={`facet-list${scrollable ? ' scrollable' : ''}`}>
            {shown.length === 0 && <div className="facet-none">No values match</div>}
            {shown.map(o => (
              <label key={o.value} className="facet-opt">
                <input type="checkbox" checked={selected.has(o.value)} onChange={() => onToggle(title, o.value)} />
                <span className="facet-opt-label" title={o.value}>{o.value}</span>
                <span className="facet-opt-count">{o.count.toLocaleString()}</span>
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
