import { AlertTriangle, Pause, CircleDashed } from 'lucide-react'
import { ALERT_STATE_LABELS, alertStateKey, statusForAlertState } from '@/utils/status'
import './alerts-shared.css'

// The states someone may have to act on read loud (a solid fill); OK, no data
// and paused recede (a tint), so a list of mostly quiet rules does not shout.
const LOUD = new Set(['critical', 'warning', 'pending', 'error'])

// No data, a rule error and paused share the neutral tone, so a glyph tells
// them apart at a glance; the word still says it, for anyone who cannot see it.
const ICONS = { error: AlertTriangle, paused: Pause, nodata: CircleDashed }

/**
 * An alert rule's evaluation state as a chip: the word is the label
 * (`ALERT_STATE_LABELS`), the colour comes only from `statusForAlertState`
 * (CLAUDE.md rule 1), and a firing alert names its severity rather than saying
 * "firing" (signed off as Q2). `detail` carries a rule error's message into the
 * hover text, which production never shows (R8).
 */
export default function AlertStateChip({ state, severity, detail, className = '' }) {
  const key = alertStateKey(state, severity)
  if (!key) return null
  const tone = statusForAlertState(state, severity)
  const label = ALERT_STATE_LABELS[key]
  const Icon = ICONS[key]
  return (
    <span
      className={`alr-chip ${LOUD.has(key) ? 'loud' : 'quiet'} ${tone}${className ? ` ${className}` : ''}`}
      title={detail ? `State: ${label}: ${detail}` : `State: ${label}`}
    >
      {Icon && <Icon aria-hidden="true" />}
      {label}
    </span>
  )
}
