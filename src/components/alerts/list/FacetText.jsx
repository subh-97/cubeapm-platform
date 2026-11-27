import { useEffect, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'

/**
 * A substring filter as a text box — the rail counterpart of a text chip (Alert
 * name, Query contains). It keeps its own draft and applies it as the reader
 * types (debounced) and on blur, so the URL is not rewritten per keystroke; an
 * outside change (a chip removed, Clear all) resyncs the draft while the box is
 * not focused.
 *
 * `value` is the one applied substring; `onChange(next)` writes it into the
 * shared selection.
 */
const SETTLE_MS = 300

export default function FacetText({ title, placeholder, value = '', onChange }) {
  const [draft, setDraft] = useState(value)
  const inputRef = useRef(null)
  const applied = useRef(value)

  // An outside change (Clear all, a chip removed) resyncs the draft, unless the
  // reader is mid-edit in this box.
  useEffect(() => {
    if (value !== applied.current && document.activeElement !== inputRef.current) {
      applied.current = value
      setDraft(value)
    }
  }, [value])

  // Apply the draft a short beat after typing stops.
  useEffect(() => {
    if (draft === applied.current) return undefined
    const id = setTimeout(() => { applied.current = draft; onChange(draft) }, SETTLE_MS)
    return () => clearTimeout(id)
  }, [draft, onChange])

  const apply = () => { if (draft !== applied.current) { applied.current = draft; onChange(draft) } }

  return (
    <div className="facet-group facet-text" role="group" aria-label={title}>
      <div className="facet-toggle-title">{title}</div>
      <div className="facet-text-field">
        <Search aria-hidden="true" />
        <input
          ref={inputRef}
          type="text"
          value={draft}
          placeholder={placeholder}
          aria-label={title}
          spellCheck={false}
          onChange={e => setDraft(e.target.value)}
          onBlur={apply}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); apply() } }}
        />
        {draft && (
          <button type="button" className="facet-text-clear" aria-label={`Clear ${title}`} onClick={() => { setDraft(''); applied.current = ''; onChange('') }}>
            <X aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  )
}
