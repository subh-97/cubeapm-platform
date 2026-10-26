import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertTriangle, ArrowRight } from 'lucide-react'
import { useAlerts } from '@/hooks/useAlerts'
import { ALERTS_NOW } from '@/data/alerts'
import { statusForAlertState } from '@/utils/status'
import { displayName } from '@/utils/alerts/describe'
import { worstFiring, bannerFactParts } from '@/components/alerts/list/firingSummary'
import { alertRuleUrl } from '@/utils/route'
import './home-alerts.css'

const isPlain = e => !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0)

/**
 * What Alerts has to say on Home (docs/alerts/DESIGN.md D13): a quiet nudge
 * about the worst firing alert — the rule, its value against its threshold
 * and for how long, and a way to its page — and nothing while nothing fires.
 * Production's Home says nothing about alerts, so a firing incident was a
 * click away in another module.
 *
 * A card like the services panel below it rather than a red bar: severity
 * sits in the icon's tint and in the words, so it nudges without shouting
 * over a table that already lists the incident first.
 */
export default function HomeAlerts() {
  const navigate = useNavigate()
  const alerts = useAlerts()
  const worst = useMemo(() => worstFiring(alerts.rules), [alerts.rules])
  if (!worst) return null
  const href = alertRuleUrl(worst.id)
  const { value, threshold, firingFor } = bannerFactParts(worst, ALERTS_NOW)
  const facts = [value, threshold].filter(Boolean)

  return (
    <aside className={`home-nudge ${statusForAlertState(worst.state, worst.severity)}`} aria-label="Firing alert">
      <span className="home-nudge-icon" aria-hidden="true"><AlertTriangle /></span>
      <div className="home-nudge-body">
        <p className="home-nudge-title">
          <strong>{displayName(worst)}</strong> is firing{firingFor ? ` for ${firingFor}` : ''}
        </p>
        {facts.length > 0 && (
          <p className="home-nudge-meta">
            {facts.map(f => <span key={f}>{f}</span>)}
          </p>
        )}
      </div>
      <a
        className="hbtn home-nudge-action"
        href={href}
        onClick={(e) => { if (!isPlain(e)) return; e.preventDefault(); navigate(href) }}
      >
        Open rule<ArrowRight aria-hidden="true" />
      </a>
    </aside>
  )
}
