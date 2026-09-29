import { Trash2 } from 'lucide-react'
import clsx from 'clsx'
import PipePopover from './PipePopover'

const PRESETS = [10, 50, 100, 500, 1000]

// Live-commit editor for a single `limit` pipe. Presets cover the 90% case;
// the custom input caps out at the top so power users can go higher without
// leaving the pill.
export default function LimitPopover({
  anchorRef,
  open,
  onClose,
  pipe,
  onChange,
  onRemove,
}) {
  // A null `pipe` means the parent hasn't created a limit pipe yet — render
   // the form with the default (100) so the first interaction can create one.
  const n = Number(pipe?.n) || 100

  return (
    <PipePopover
      anchorRef={anchorRef}
      open={open}
      onClose={onClose}
      title="Limit"
      subtitle="Cap the number of returned rows"
      width={260}
    >
      <div className="agg-form">
        <div className="agg-field">
          <span className="agg-lbl">Show top</span>
          <div className="lim-presets">
            {PRESETS.map(p => (
              <button
                key={p}
                type="button"
                className={clsx('lim-preset', { 'is-active': n === p })}
                onClick={() => onChange?.({ n: p })}
              >
                {p.toLocaleString()}
              </button>
            ))}
          </div>
        </div>
        <label className="agg-field">
          <span className="agg-lbl">Custom</span>
          <input
            type="number"
            className="agg-input mono"
            min={1}
            step={1}
            value={n}
            onChange={(e) => {
              const v = Math.max(1, Math.floor(Number(e.target.value) || 0))
              onChange?.({ n: v })
            }}
          />
        </label>

        {onRemove && (
          <div className="agg-actions agg-actions-single">
            <button type="button" className="agg-btn agg-btn-danger" onClick={() => { onRemove(); onClose?.() }}>
              <Trash2 size={12} strokeWidth={2} /> Remove limit
            </button>
          </div>
        )}
      </div>
    </PipePopover>
  )
}
