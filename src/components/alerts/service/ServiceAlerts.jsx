import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { BellPlus } from 'lucide-react'
import AlertStateChip from '@/components/alerts/shared/AlertStateChip'
import { useAlerts } from '@/hooks/useAlerts'
import { conditionText, displayName } from '@/utils/alerts/describe'
import { sortRules } from '@/utils/alerts/model'
import { alertsSearch } from '@/utils/alertsUrl'
import { alertRuleUrl, alertEditorUrl, routeUrl } from '@/utils/route'
import { suggestionFor } from './serviceSuggestion'
import './service-alerts.css'

const isPlain = e => !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0)

// The rules that watch a service, worst first, as the Rules tab orders them.
function useServiceRules(serviceId) {
  const alerts = useAlerts()
  return useMemo(() => sortRules(alerts.rules.filter(r => r.scope?.service === serviceId)), [alerts.rules, serviceId])
}

/**
 * The service settings drawer's Alerts tab (D13): this service's rules, each
 * with its state and condition, and Create — in place of the three mock
 * settings (alert channel, suppression window, auto-resolve) the drawer had,
 * which no rule ever read.
 */
export function ServiceAlertsPanel({ serviceId, onLeave }) {
  const navigate = useNavigate()
  const rules = useServiceRules(serviceId)
  const go = (url, state) => (e) => {
    if (!isPlain(e)) return
    e.preventDefault()
    onLeave?.()
    navigate(url, state ? { state } : undefined)
  }
  const all = `${routeUrl({ view: 'alerts' })}${alertsSearch({ facets: { svc: [serviceId] } })}`
  return (
    <div className="svc-alerts-panel">
      <p className="drawer-description">
        The alert rules that watch <strong className="mono">{serviceId}</strong>, worst first. A rule&apos;s thresholds,
        contact points and mutes are set on the rule.
      </p>
      {rules.length === 0 ? (
        <p className="drawer-description">No rule watches this service yet.</p>
      ) : (
        <ul className="svc-alerts-list">
          {rules.map(r => (
            <li key={r.id}>
              <AlertStateChip state={r.state} severity={r.severity} />
              <a href={alertRuleUrl(r.id)} onClick={go(alertRuleUrl(r.id))}>{displayName(r)}</a>
              <span className="svc-alerts-cond">{conditionText(r)}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="svc-alerts-actions">
        <a className="hbtn primary" href={alertEditorUrl(null)} onClick={go(alertEditorUrl(null), { suggestion: suggestionFor(serviceId, rules) })}>
          <BellPlus aria-hidden="true" />Create a rule
        </a>
        {rules.length > 0 && <a className="hbtn" href={all} onClick={go(all)}>Open them in Alerts</a>}
      </div>
    </div>
  )
}
