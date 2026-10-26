import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'
import { integrationIcon } from '@/components/alerts/rule/integrationIcons'
import { statusForDelivery } from '@/utils/status'
import { dayClock } from '@/utils/alerts/configViews'
import { payloadOf } from '@/utils/alerts/notificationLog'
import { alertRuleUrl } from '@/utils/route'
import { formatLocal } from '@/utils/timeRange'
import './notifications.css'

const PAGE = 20
const isPlain = e => !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0)

/**
 * The notification log (docs/alerts/DESIGN.md D12), wherever it is shown: the
 * Notifications tab, and one rule's page. Each row says when, which rule, what
 * the message was about (Event), where it went (contact point and
 * integration, never a raw webhook URL), what became of it (Status) and why.
 *
 * Rows expand in place, as the rules list does (signed off as Q5), to the full
 * target, the error for a failure, the payload, and links to the rule and the
 * instance — production opens a modal of raw text instead. Twenty rows at a
 * time, then "Show 20 more · Show all", where production pages with a red
 * "Load more" and searches only what it has loaded.
 *
 * `rows` come from notificationLog.logRows, newest first. `compact` drops the
 * Rule column, for a page that is already one rule's.
 */
export default function NotificationLog({ rows, nowSec, compact = false, empty }) {
  const navigate = useNavigate()
  const [limit, setLimit] = useState(PAGE)
  const [open, setOpen] = useState(() => new Set())
  const toggle = id => setOpen((s) => {
    const next = new Set(s)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  const go = url => (e) => { if (!isPlain(e)) return; e.preventDefault(); navigate(url) }

  if (!rows.length) return <p className="nlog-empty">{empty ?? 'No notifications match.'}</p>

  const shown = rows.slice(0, limit)
  return (
    <div className={`nlog${compact ? ' compact' : ''}`}>
      <div className="nlog-head" aria-hidden="true">
        <span>Time</span>
        {!compact && <span>Rule</span>}
        <span>Event</span>
        <span>Sent to</span>
        <span>Status</span>
        <span>Why</span>
      </div>
      <ul className="nlog-list">
        {shown.map((r) => {
          const isOpen = open.has(r.id)
          const panelId = `nlog-${r.id}`
          const Icon = integrationIcon(r.integration.type)
          const series = Object.entries(r.labels).map(([k, v]) => `${k}=${v}`).join(', ')
          return (
            <li key={r.id} className={`nlog-row${isOpen ? ' is-open' : ''}`}>
              <button type="button" className="nlog-toggle" aria-expanded={isOpen} aria-controls={panelId} onClick={() => toggle(r.id)}>
                <span className="nlog-time" title={formatLocal(r.at * 1000, 'YYYY-MM-DD HH:mm:ss')}>
                  <ChevronRight aria-hidden="true" className="nlog-chev" />{dayClock(r.at, nowSec)}
                </span>
                {!compact && (
                  <span className="nlog-rule">{r.ruleName}{series && <span className="nlog-series">{series}</span>}</span>
                )}
                <span className="nlog-event">{r.eventLabel}</span>
                <span className="nlog-dest" title={r.integration.full}>
                  <Icon aria-hidden="true" />
                  <span>{r.contact?.name ?? 'One-off destination'}</span>
                  <span className="nlog-int">{`${r.integration.label} ${r.integration.target}`}</span>
                </span>
                <span className={`nlog-status ${statusForDelivery(r.status)}`} title={`Status: ${r.status}`}>{r.statusLabel}</span>
                <span className="nlog-why">{r.why}</span>
              </button>
              {isOpen && (
                <div id={panelId} className="nlog-panel">
                  <dl>
                    <div><dt>Sent to</dt><dd>{r.contact?.name ?? 'One-off destination'} · {r.integration.label} <code>{r.integration.full}</code></dd></div>
                    {series && <div><dt>Series</dt><dd><code>{series}</code></dd></div>}
                    <div><dt>When</dt><dd>{formatLocal(r.at * 1000, 'YYYY-MM-DD HH:mm:ss')}</dd></div>
                  </dl>
                  {r.status === 'ERROR' && r.why && (
                    <div className="nlog-block"><span className="ae-label">Error</span><pre>{r.why}</pre></div>
                  )}
                  <div className="nlog-block"><span className="ae-label">Payload</span><pre>{JSON.stringify(payloadOf(r), null, 2)}</pre></div>
                  <div className="nlog-links">
                    <a className="ae-link" href={alertRuleUrl(r.ruleId)} onClick={go(alertRuleUrl(r.ruleId))}>Open the rule</a>
                    {r.instanceId && (
                      <a className="ae-link" href={`${alertRuleUrl(r.ruleId)}?alert_id=${r.instanceId}`} onClick={go(`${alertRuleUrl(r.ruleId)}?alert_id=${r.instanceId}`)}>
                        Open this series
                      </a>
                    )}
                  </div>
                </div>
              )}
            </li>
          )
        })}
      </ul>
      <div className="nlog-foot">
        <span>Showing {shown.length.toLocaleString()} of {rows.length.toLocaleString()}</span>
        {rows.length > limit && (
          <>
            <button type="button" className="ae-link" onClick={() => setLimit(l => l + PAGE)}>Show {Math.min(PAGE, rows.length - limit)} more</button>
            <span aria-hidden="true">·</span>
            <button type="button" className="ae-link" onClick={() => setLimit(rows.length)}>Show all</button>
          </>
        )}
      </div>
    </div>
  )
}
