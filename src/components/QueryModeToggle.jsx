import { Sparkles, Code2 } from 'lucide-react'
import clsx from 'clsx'

// Sits in the leading slot of the query input row — the position the magnifier
// icon used to occupy. Two segments rather than a single toggling button so the
// current mode and the available one are both legible without hovering, which
// matters here because the two modes look completely different once switched.
export default function QueryModeToggle({ mode, onChange, disabled = false, disabledReason }) {
  const seg = (value, Icon, label, title) => (
    <button
      type="button"
      className={clsx('qmode-seg', { 'is-active': mode === value })}
      onClick={(e) => { e.stopPropagation(); if (!disabled || mode === value) onChange?.(value) }}
      disabled={disabled && mode !== value}
      title={disabled && mode !== value ? disabledReason : title}
      aria-pressed={mode === value}
      aria-label={label}
    >
      <Icon size={13} strokeWidth={2} />
    </button>
  )

  return (
    <div className="qmode" role="group" aria-label="Query input mode" onClick={(e) => e.stopPropagation()}>
      {seg('builder', Sparkles, 'Query Builder mode', 'Query Builder — build filters as chips')}
      {seg('raw', Code2, 'Lucene mode', 'Lucene — write the query as text')}
    </div>
  )
}
