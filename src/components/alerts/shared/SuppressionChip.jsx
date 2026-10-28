import { BellOff } from 'lucide-react'
import { suppressionText } from './alertShared'
import './alerts-shared.css'

/**
 * A snooze or mute, next to the state it suppresses. Suppression holds
 * notifications, not the state, so it never replaces the state chip: a snoozed
 * rule that is firing still reads Critical, with this beside it (DESIGN D10).
 * Neutral, and dashed so it reads as an overlay rather than another state.
 */
export default function SuppressionChip({ suppression, nowSec, className = '' }) {
  const t = suppressionText(suppression, nowSec)
  if (!t) return null
  return (
    <span className={`alr-chip suppressed${className ? ` ${className}` : ''}`} title={t.title}>
      <BellOff aria-hidden="true" />
      {t.text}
    </span>
  )
}
