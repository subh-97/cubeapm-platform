import { Trash2 } from 'lucide-react'
import PipePopover from './PipePopover'
import PipeSelect from './PipeSelect'

// Live-commit editor for a single `sort` pipe. Field options come from the
// current stats result — group-by columns and aliased aggregation outputs —
// because you can only sort by things that appear in the result set.
export default function OrderPopover({
  anchorRef,
  open,
  onClose,
  pipe,
  onChange,               // (patch) => merges into pipe
  onRemove,               // () => removes the entire sort pipe
  fieldOptions = [],      // [{ value, label?, hint? }]
}) {
  // A null `pipe` means the parent hasn't created a sort pipe yet — render
   // the form with defaults so the first user interaction can create one.
  const field = pipe?.field || ''
  const dir = pipe?.dir || 'desc'

  return (
    <PipePopover
      anchorRef={anchorRef}
      open={open}
      onClose={onClose}
      title="Order"
      subtitle="Sort the aggregation result"
      width={300}
    >
      <div className="agg-form">
        <label className="agg-field">
          <span className="agg-lbl">Field</span>
          <PipeSelect
            value={field || ''}
            onChange={(v) => onChange?.({ field: v })}
            options={fieldOptions}
            placeholder={fieldOptions.length === 0 ? 'Add a group-by or named aggregation first' : 'Choose a field…'}
            disabled={fieldOptions.length === 0}
          />
        </label>

        <div className="agg-field">
          <span className="agg-lbl">Direction</span>
          <div className="ord-dir">
            <button
              type="button"
              className={`ord-dir-btn${dir !== 'asc' ? ' is-active' : ''}`}
              onClick={() => onChange?.({ dir: 'desc' })}
            >
              <span className="ord-dir-arrow" aria-hidden="true">↓</span>
              Descending
              <span className="ord-dir-hint">largest first</span>
            </button>
            <button
              type="button"
              className={`ord-dir-btn${dir === 'asc' ? ' is-active' : ''}`}
              onClick={() => onChange?.({ dir: 'asc' })}
            >
              <span className="ord-dir-arrow" aria-hidden="true">↑</span>
              Ascending
              <span className="ord-dir-hint">smallest first</span>
            </button>
          </div>
        </div>

        {onRemove && (
          <div className="agg-actions agg-actions-single">
            <button type="button" className="agg-btn agg-btn-danger" onClick={() => { onRemove(); onClose?.() }}>
              <Trash2 size={12} strokeWidth={2} /> Remove sort
            </button>
          </div>
        )}
      </div>
    </PipePopover>
  )
}
