import { useNavigate } from 'react-router-dom'
import { BellOff, CalendarClock } from 'lucide-react'
import UndoMessage from '@/components/alerts/shared/UndoMessage'
import { changeRule } from '@/components/alerts/list/ruleActions'
import { formatElapsed, durationWords, displayName } from '@/utils/alerts/describe'
import { snoozeRows, dayClock } from '@/utils/alerts/configViews'
import { alertRuleUrl } from '@/utils/route'

const isPlain = e => !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0)

/**
 * Every snooze in one place (docs/alerts/DESIGN.md D10): the ones holding a
 * rule's notifications now, with how long they have left, and the ones still
 * to start. Production has no such list — a snooze shows only as a chip inside
 * an expanded rule, and its "×" ends it at once, with no undo.
 *
 * Ending one here goes through the same change the Rules tab and the rule page
 * make (ruleActions.changeRule), so it says the same thing and offers the same
 * Undo wherever it is done.
 */
export default function SnoozeList({ views, actions, nowSec, setToast }) {
  const navigate = useNavigate()
  const rows = snoozeRows(views)
  const end = (row) => {
    const { text, undo } = changeRule(actions, row.view, { kind: 'unsnooze', snooze: row.snooze }, nowSec)
    setToast?.(undo ? <UndoMessage text={text} onUndo={() => { undo(); setToast?.(null) }} /> : text)
  }
  return (
    <section className="cfg-section" aria-labelledby="cfg-snoozes-title">
      <h2 id="cfg-snoozes-title" className="cfg-section-title">Snoozes</h2>
      {rows.length === 0 ? (
        <p className="ae-hint">
          No rule is snoozed. Snooze one from its row or its page, and it is listed here until the snooze ends.
        </p>
      ) : (
        <ul className="cfg-list">
          {rows.map(({ rule, view, snooze }) => {
            const href = alertRuleUrl(rule.id)
            return (
              <li key={snooze.silenceId} className="cfg-item cfg-snooze">
                <div className="cfg-item-head">
                  {snooze.scheduled ? <CalendarClock aria-hidden="true" className="cfg-snooze-icon" /> : <BellOff aria-hidden="true" className="cfg-snooze-icon" />}
                  <a className="cfg-item-name" href={href} onClick={(e) => { if (!isPlain(e)) return; e.preventDefault(); navigate(href) }}>
                    {displayName(view)}
                  </a>
                  <span className="cfg-snooze-when">
                    {snooze.scheduled
                      ? `Starts ${dayClock(snooze.startsAt, nowSec)}, for ${durationWords(snooze.endsAt - snooze.startsAt)}`
                      : `${formatElapsed(snooze.endsAt - nowSec)} left, until ${dayClock(snooze.endsAt, nowSec)}`}
                  </span>
                  <div className="cfg-item-actions">
                    <button type="button" className="hbtn" onClick={() => end({ rule, view, snooze })}>
                      {snooze.scheduled ? 'Cancel snooze' : 'Unsnooze'}
                    </button>
                  </div>
                </div>
                {(snooze.comment || snooze.createdBy) && (
                  <p className="cfg-snooze-why">
                    {snooze.comment && <q>{snooze.comment}</q>}
                    {snooze.createdBy && <span className="cfg-snooze-by"> — {snooze.createdBy}</span>}
                  </p>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
