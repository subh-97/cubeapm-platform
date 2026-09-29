import { useEffect, useRef, useState } from 'react'
import PipePopover from './PipePopover'
import { newMathPipe, validatePipe } from '@/utils/pipes'

// Save-on-close editor for a math pipe. Expression is free-text (validation
// is limited to non-empty + balanced parens), so a Save button lets users
// commit deliberately. Available names from preceding stats/math pipes are
// clickable — insert-at-caret matches Coralogix's expression builder pattern.
export default function MathPopover({
  anchorRef,
  open,
  onClose,
  onSave,
  initial = null,
  availableNames = [],
}) {
  const [draft, setDraft] = useState(() => initial ? { ...initial } : newMathPipe())
  const exprRef = useRef(null)

  useEffect(() => {
    if (!open) return
    setDraft(initial ? { ...initial } : newMathPipe())
  }, [open, initial])

  const errors = validatePipe(draft)
  const canSave = errors.length === 0

  const insertName = (name) => {
    const el = exprRef.current
    if (!el) return
    const start = el.selectionStart ?? draft.expression.length
    const end = el.selectionEnd ?? start
    const before = draft.expression.slice(0, start)
    const after = draft.expression.slice(end)
    const next = `${before}${name}${after}`
    setDraft(d => ({ ...d, expression: next }))
    requestAnimationFrame(() => {
      el.focus()
      const cursor = start + name.length
      el.setSelectionRange(cursor, cursor)
    })
  }

  const handleSave = () => {
    if (!canSave) return
    onSave?.({ ...draft, expression: draft.expression.trim(), as: draft.as.trim() })
    onClose?.()
  }

  const onFormKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && e.target.tagName !== 'TEXTAREA') {
      e.preventDefault()
      handleSave()
    }
  }

  const isEdit = !!initial

  return (
    <PipePopover
      anchorRef={anchorRef}
      open={open}
      onClose={onClose}
      title={isEdit ? 'Edit math expression' : 'New math expression'}
      subtitle="Compute a derived series from aggregation outputs"
      width={340}
    >
      <div className="agg-form" onKeyDown={onFormKeyDown}>
        <label className="agg-field">
          <span className="agg-lbl">Expression</span>
          <input
            ref={exprRef}
            type="text"
            className="agg-input mono"
            placeholder="e.g. errors / requests * 100"
            value={draft.expression}
            onChange={(e) => setDraft(d => ({ ...d, expression: e.target.value }))}
            autoFocus
          />
          {availableNames.length > 0 && (
            <div className="math-scope">
              <span className="math-scope-lbl">Insert:</span>
              {availableNames.map(name => (
                <button
                  key={name}
                  type="button"
                  className="math-scope-chip mono"
                  onClick={() => insertName(name)}
                  title={`Insert "${name}" at the cursor`}
                >
                  {name}
                </button>
              ))}
            </div>
          )}
        </label>

        <label className="agg-field">
          <span className="agg-lbl">Name <span className="agg-optional">· optional</span></span>
          <input
            type="text"
            className="agg-input mono"
            placeholder="e.g. error_pct"
            value={draft.as}
            onChange={(e) => setDraft(d => ({ ...d, as: e.target.value }))}
          />
        </label>

        {errors.length > 0 && (
          <ul className="agg-errors">
            {errors.map((e, i) => <li key={i}>{e.msg}</li>)}
          </ul>
        )}

        <div className="agg-actions">
          <button type="button" className="agg-btn" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="agg-btn is-primary"
            onClick={handleSave}
            disabled={!canSave}
            title={canSave ? '' : 'Fix errors above to save'}
          >
            {isEdit ? 'Update' : 'Add math'}
          </button>
        </div>
      </div>
    </PipePopover>
  )
}
