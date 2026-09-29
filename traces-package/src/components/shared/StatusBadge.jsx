import { clsx } from 'clsx'
import { STATUS_LABELS } from '@/utils/status'

// Solid severity fill with white text in both themes. The fill alone carries
// the signal, so there is no dot repeating it and no border competing with it.
const BADGE_STYLES = {
  healthy: 'bg-healthy',
  warning: 'bg-warning',
  critical: 'bg-critical',
  info: 'bg-info',
  neutral: 'bg-neutral',
}

export default function StatusBadge({ status, label, className = '' }) {
  return (
    <span
      className={clsx(
        'inline-flex items-center px-2 py-[3px] rounded-[2px] text-[11px] font-medium text-white',
        BADGE_STYLES[status] || BADGE_STYLES.neutral,
        className
      )}
      title={`Status: ${STATUS_LABELS[status] || status}`}
    >
      {label || STATUS_LABELS[status]}
    </span>
  )
}
