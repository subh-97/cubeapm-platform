import { Pause, Pencil, Play, ExternalLink, TriangleAlert } from 'lucide-react'
import { AlertStateChip, SuppressionChip, SnoozeMenu, RuleActionsMenu, snoozeBlockedReason } from '@/components/alerts/shared'
import { displayName, ruleSentence } from '@/utils/alerts/describe'
import { managedNote, SLO_EDIT_REASON } from './rulePage'

/**
 * The rule page's head (D5): the state chip and any suppression beside it, the
 * rule's name (production titles every rule page "Alert"), the rule as one
 * sentence, and the labelled actions — Snooze, Pause or Resume, Edit and the
 * Actions menu — where production has six icon-only buttons (R11).
 *
 * An SLO burn-rate rule keeps what does not contradict its SLO (D18): Snooze,
 * which holds notifications rather than changing anything, and its history,
 * in the Actions menu. "Edit in SLO" stands where Edit would, inert, saying
 * why. A synthetic monitor's rule is editable, and says where it came from.
 */
export default function RuleHead({ view, nowSec, onSnooze, onPause, onResume, onEdit, onAction, onBlocked }) {
  const slo = view.managedBy?.kind === 'slo'
  const paused = view.status === 'PAUSED'
  const locked = view.readonly ? 'This rule is read-only' : null
  const note = managedNote(view)
  const blocked = snoozeBlockedReason(view)

  // Disabled-looking controls stay focusable and say why when pressed:
  // a disabled <button> swallows both the click and the hover that would
  // show its title.
  const inert = (reason) => ({ 'aria-disabled': true, title: reason, onClick: () => onBlocked?.(reason) })

  return (
    <div className="alr-head">
      <div className="alr-head-row">
        <div className="alr-head-title">
          <AlertStateChip state={view.state} severity={view.severity} detail={view.lastError ?? undefined} />
          <SuppressionChip suppression={view.suppression} nowSec={nowSec} />
          {/* A snooze scheduled for later holds nothing yet, but it is coming:
              each one is shown, saying when it starts. */}
          {(view.snoozes ?? []).filter(s => s.scheduled).map(s => (
            <SuppressionChip key={s.silenceId} suppression={{ kind: 'snooze', ...s }} nowSec={nowSec} />
          ))}
          <h1 className="alr-head-name" title={displayName(view)}>{displayName(view)}</h1>
        </div>
        <div className="alr-head-actions">
          <SnoozeMenu
            onSnooze={onSnooze}
            disabled={!!blocked}
            disabledReason={blocked ?? undefined}
            nowSec={nowSec}
            ruleName={displayName(view)}
          />
          {!slo && (
            paused ? (
              <button type="button" className="hbtn small" {...(locked ? inert(locked) : { onClick: onResume, title: 'Evaluate this rule again' })}>
                <Play aria-hidden="true" />Resume
              </button>
            ) : (
              <button type="button" className="hbtn small" {...(locked ? inert(locked) : { onClick: onPause, title: 'Stop evaluating this rule until it is resumed' })}>
                <Pause aria-hidden="true" />Pause
              </button>
            )
          )}
          {slo ? (
            <button type="button" className="hbtn small is-inert" {...inert(SLO_EDIT_REASON)}>
              <ExternalLink aria-hidden="true" />Edit in SLO
            </button>
          ) : (
            <button type="button" className="hbtn small" {...(locked ? inert(locked) : { onClick: onEdit, title: 'Open this rule in the editor' })}>
              <Pencil aria-hidden="true" />Edit
            </button>
          )}
          <RuleActionsMenu rule={view} onAction={onAction} />
        </div>
      </div>
      <p className="alr-head-sentence">
        {ruleSentence(view)}
        <span className="alr-head-group" title="The rule's group">{view.group}</span>
      </p>
      {note && <p className="alr-head-note">{note}</p>}
      {view.state === 'error' && view.lastError && (
        <p className="alr-head-error" role="note">
          <TriangleAlert aria-hidden="true" />
          <span><strong>This rule can&apos;t evaluate:</strong> <span className="mono">{view.lastError}</span></span>
        </p>
      )}
    </div>
  )
}
