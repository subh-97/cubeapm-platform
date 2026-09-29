import { useState, useRef, useEffect } from 'react'

/**
 * Column picker for an explorer table.
 *
 * `fields` is the full set a record can carry, as `{ key, label }`. Logs and
 * Traces derive theirs from their own rows, so a new tag becomes a column
 * without this file learning about it — which is also why the count in the
 * button reads off `activeFields` rather than anything hard-coded here.
 */
export default function FieldsDropdown({ fields, activeFields, setActiveFields }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    const handler = (e) => { if (!ref.current?.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const shown = q ? fields.filter(f => f.label.toLowerCase().includes(q.toLowerCase())) : fields
  const count = activeFields.size

  return (
    <div className="fields-drop-wrap" ref={ref}>
      <button className={`hbtn small${open ? ' active' : ''}`} onClick={() => setOpen(o => !o)}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
        Fields{count ? ` (${count})` : ''}
      </button>
      {open && (
        <div className="fields-drop">
          <div className="fields-drop-head">
            <span>Fields ({count})</span>
            <button
              className="fields-drop-select-all"
              onClick={() => setActiveFields(count === fields.length ? new Set() : new Set(fields.map(f => f.key)))}
            >
              {count === fields.length ? 'Deselect all' : 'Select all'}
            </button>
          </div>
          <div className="fields-drop-search">
            <input placeholder="search" value={q} onChange={e => setQ(e.target.value)} />
          </div>
          {shown.length === 0 && <div className="facet-none">No fields match</div>}
          {shown.map(f => (
            <label key={f.key} className="fields-drop-opt">
              <input
                type="checkbox"
                checked={activeFields.has(f.key)}
                onChange={() => {
                  const next = new Set(activeFields)
                  if (next.has(f.key)) next.delete(f.key); else next.add(f.key)
                  setActiveFields(next)
                }}
              />
              {f.label}
            </label>
          ))}
        </div>
      )}
    </div>
  )
}
