import { useMemo } from 'react'
import NotificationLog from '@/components/alerts/notifications/NotificationLog'
import { logRows } from '@/utils/alerts/notificationLog'

/**
 * The Notifications tab (D5, D12): this rule's notification log over the
 * range, drawn by the Notifications tab's own log (P6c) — what each send was
 * about, where it went as contact point + integration, what became of it and
 * why, rows that expand in place — without the Rule column, since this page
 * is the rule. `historyHref` is the rule's history on the Notifications tab,
 * with its filters.
 */
export default function RuleNotifications({ view, log, nowSec, lookups, historyHref }) {
  // The rule's own contact points name its rows; the log keeps only their ids.
  const rows = useMemo(
    () => logRows(log, { views: [view], receiverGroups: view.contactPoints ?? [], lookups }),
    [log, view, lookups],
  )

  if (log.length === 0) {
    return (
      <p className="alr-empty">
        No notifications in this range. This rule sends when it fires, every {view.repeatSec ? `${Math.round(view.repeatSec / 60)} minutes` : 'repeat interval'} while
        it fires, and when it resolves.
        {historyHref && <> <a className="alr-link" href={historyHref}>All of its notifications</a></>}
      </p>
    )
  }

  return (
    <section className="alr-notifications" aria-label="Notifications">
      <NotificationLog rows={rows} nowSec={nowSec} compact />
      {historyHref && (
        <p className="alr-notif-more-link"><a className="alr-link" href={historyHref}>Filter these on the Notifications tab</a></p>
      )}
    </section>
  )
}
