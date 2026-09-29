import { forwardRef } from 'react'
import { Plus, X, ChevronDown } from 'lucide-react'
import clsx from 'clsx'

// The shared toolbar pill used by every aggregate-mode operation
// (Group by, Aggregation, and later Order/Limit/Math under "More").
// Two visual modes:
//   Empty  ─  [icon] Label +   — entire pill is one click target
//   Filled ─  [icon] Label: <chip> <chip> +   — chips are their own click/×
// The parent owns popover state and passes `active` when its popover is open.
const PipePill = forwardRef(function PipePill({
  icon,
  label,
  active = false,
  addAffordance = 'plus',   // 'plus' | 'chevron' | 'none'
  addTitle,
  onAddClick,
  className,
  children,                 // PillChip(s) — presence flips the pill to filled state
}, ref) {
  const hasValue = !!children && (Array.isArray(children) ? children.some(Boolean) : true)
  const AddIcon = addAffordance === 'chevron' ? ChevronDown : Plus

  const handleContainerClick = (e) => {
    // Only fire container-level open when the click didn't land on a chip
    // or the +/▼ button itself (those handle their own onClick).
    if (e.target.closest('.pipe-pill-chip') || e.target.closest('.pipe-pill-add')) return
    if (hasValue) return   // filled pills don't have a "click anywhere" opener
    onAddClick?.()
  }

  const handleContainerKey = (e) => {
    if (hasValue) return
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onAddClick?.() }
  }

  return (
    <div
      ref={ref}
      className={clsx('pipe-pill', {
        'is-empty': !hasValue,
        'is-filled': hasValue,
        'is-active': active,
      }, className)}
      role={hasValue ? undefined : 'button'}
      tabIndex={hasValue ? undefined : 0}
      onClick={handleContainerClick}
      onKeyDown={handleContainerKey}
    >
      {icon && <span className="pipe-pill-icon">{icon}</span>}
      <span className="pipe-pill-label">{label}{hasValue && ':'}</span>
      {hasValue && <span className="pipe-pill-values">{children}</span>}
      {addAffordance !== 'none' && (
        <button
          type="button"
          className="pipe-pill-add"
          onClick={(e) => { e.stopPropagation(); onAddClick?.() }}
          title={addTitle || (hasValue ? `Add another ${label.toLowerCase()}` : `Configure ${label.toLowerCase()}`)}
          aria-label={addTitle || (hasValue ? `Add another ${label.toLowerCase()}` : `Configure ${label.toLowerCase()}`)}
        >
          <AddIcon size={14} strokeWidth={2} />
        </button>
      )}
    </div>
  )
})

export default PipePill

// A single value inside a filled pill. `onClick` (edit) and `onRemove` (delete)
// are independent — either or both may be provided.
export function PipePillChip({ children, onRemove, onClick, active, title }) {
  return (
    <span className={clsx('pipe-pill-chip', { 'is-active': active })}>
      {onClick ? (
        <button type="button" className="pipe-pill-chip-body" onClick={(e) => { e.stopPropagation(); onClick() }} title={title}>{children}</button>
      ) : (
        <span className="pipe-pill-chip-body" title={title}>{children}</span>
      )}
      {onRemove && (
        <button
          type="button"
          className="pipe-pill-chip-x"
          onClick={(e) => { e.stopPropagation(); onRemove() }}
          aria-label="Remove"
          title="Remove"
        >
          <X size={11} strokeWidth={2.4} />
        </button>
      )}
    </span>
  )
}
