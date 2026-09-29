import { useEffect, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import PipePopover from './PipePopover'
import PipeSelect from './PipeSelect'
import { newStatsFunction, STAT_FUNCTIONS, STAT_FN_BY_NAME, validatePipe } from '@/utils/pipes'

// Grouped function options for the picker. Ordered to lead with the most
// common choice (count), then the count family, then numeric aggregations.
const FN_GROUPS = [
  { group: 'Count',   items: STAT_FUNCTIONS.filter(f => f.category === 'Count')  .map(f => ({ value: f.fn })) },
  { group: 'Numeric', items: STAT_FUNCTIONS.filter(f => f.category === 'Numeric').map(f => ({ value: f.fn })) },
]

// The aggregation editor popover. Reused for both Create and Edit — if
// `initial` is provided, its values pre-fill the form and the header/CTA
// switch to edit language. The parent (LogsView) owns the pipes state and
// receives the finished draft via `onSave`.
export default function AggregationPopover({
  anchorRef,
  open,
  onClose,
  onSave,
  initial = null,
  allFields = [],
  numericFields,
}) {
  const [draft, setDraft] = useState(() => initial ? { ...initial } : newStatsFunction())
  const [ifOpen, setIfOpen] = useState(!!initial?.if)

  // Reset draft whenever the popover reopens or the seed record changes.
  useEffect(() => {
    if (!open) return
    setDraft(initial ? { ...initial } : newStatsFunction())
    setIfOpen(!!initial?.if)
  }, [open, initial])

  const meta = STAT_FN_BY_NAME[draft.fn]
  const showP = draft.fn === 'quantile'
  const fieldRequired = !!meta?.needsField

  // Field dropdown scope depends on function type: numeric fns can only
  // aggregate numeric fields; count-family fns accept any field.
  const fieldOptions = (allFields || [])
    .filter(f => (meta?.needsNumeric ? numericFields?.has(f) : true))
    .map(f => ({ value: f, hint: numericFields?.has(f) ? 'numeric' : undefined }))

  // Reuse the pipe validator by wrapping the draft in a single-function
  // stats pipe — same rules, single source of truth.
  const errors = validatePipe(
    { kind: 'stats', groupBy: [], functions: [draft] },
    { numericFields }
  )
  const canSave = errors.length === 0

  const handleSave = () => {
    if (!canSave) return
    onSave?.({ ...draft, if: draft.if?.trim() || '', as: draft.as?.trim() || '' })
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
      title={isEdit ? 'Edit aggregation' : 'New aggregation'}
      subtitle="Pick a function and field"
      width={340}
    >
      <div className="agg-form" onKeyDown={onFormKeyDown}>
        <label className="agg-field">
          <span className="agg-lbl">Function</span>
          <PipeSelect
            value={draft.fn}
            onChange={(v) => setDraft(d => ({ ...d, fn: v }))}
            options={FN_GROUPS}
          />
        </label>

        {showP && (
          <label className="agg-field">
            <span className="agg-lbl">Percentile</span>
            <input
              type="number"
              className="agg-input mono"
              value={draft.p ?? 0.9}
              min={0} max={1} step={0.01}
              onChange={(e) => setDraft(d => ({ ...d, p: parseFloat(e.target.value) }))}
            />
            <span className="agg-hint">Between 0 and 1 (e.g. <code>0.9</code> = p90).</span>
          </label>
        )}

        <label className="agg-field">
          <span className="agg-lbl">
            Field{!fieldRequired && <span className="agg-optional"> · optional</span>}
          </span>
          <PipeSelect
            value={draft.field || ''}
            onChange={(v) => setDraft(d => ({ ...d, field: v }))}
            options={fieldOptions}
            placeholder={fieldRequired ? 'Choose a field…' : 'Any (all rows)'}
            disabled={fieldOptions.length === 0}
          />
          {meta?.needsNumeric && fieldOptions.length === 0 && (
            <span className="agg-hint agg-hint-warn">No numeric fields available for this function.</span>
          )}
        </label>

        <div className="agg-accordion">
          <button
            type="button"
            className={`agg-accordion-head${ifOpen ? ' is-open' : ''}`}
            onClick={() => setIfOpen(o => !o)}
            aria-expanded={ifOpen}
          >
            <ChevronRight size={12} strokeWidth={2.4} className="agg-accordion-chev" />
            <span>Filter this aggregation</span>
            {!ifOpen && draft.if && (
              <span className="agg-accordion-summary mono" title={draft.if}>{draft.if}</span>
            )}
          </button>
          {ifOpen && (
            <div className="agg-accordion-body">
              <input
                type="text"
                className="agg-input mono"
                placeholder="e.g. log.level:=error"
                value={draft.if}
                onChange={(e) => setDraft(d => ({ ...d, if: e.target.value }))}
              />
              <span className="agg-hint">Only rows matching this condition contribute.</span>
            </div>
          )}
        </div>

        <label className="agg-field">
          <span className="agg-lbl">Name <span className="agg-optional">· optional</span></span>
          <input
            type="text"
            className="agg-input mono"
            placeholder="e.g. p90_lat"
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
            {isEdit ? 'Update' : 'Add aggregation'}
          </button>
        </div>
      </div>
    </PipePopover>
  )
}
