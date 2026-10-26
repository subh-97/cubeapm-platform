import { useMemo, useRef } from 'react'
import { X } from 'lucide-react'
import FacetGroup from '@/components/explorer/FacetGroup'
import { ALERTS_NOW } from '@/data/alerts'
import { logRows, filterLog, logFacets, LOG_FACETS, ONE_OFF } from '@/utils/alerts/notificationLog'
import NotificationLog from './NotificationLog.jsx'

/**
 * The Notifications tab (production's Notification History; docs/alerts/
 * DESIGN.md D12): every notification over the range — sent, failed, muted or
 * snoozed — with what it was about and why, filtered from a facet rail.
 *
 * The URL is production's where production has one: `rule_id` filters to one
 * rule, so a rule row's "Notification history" link lands here as it does
 * there. The facets go in our dialect, with production's status values
 * (SUCCESS, ERROR, MUTE, SNOOZE).
 */
export default function NotificationsTab({ alerts, url, onUrlChange }) {
  const rows = useMemo(
    () => logRows(alerts.log, { views: alerts.rules, receiverGroups: alerts.receiverGroups, lookups: alerts.lookups }),
    [alerts.log, alerts.rules, alerts.receiverGroups, alerts.lookups],
  )
  const ruleId = url.ruleId ?? null
  const facets = useMemo(() => Object.fromEntries(LOG_FACETS.map(f => [f.key, new Set(url.facets?.[f.key] ?? [])])), [url.facets])
  const forRule = useMemo(() => filterLog(rows, { ruleId }), [rows, ruleId])
  const options = useMemo(() => logFacets(forRule, url.facets ?? {}), [forRule, url.facets])
  const shown = useMemo(() => filterLog(forRule, { facets }), [forRule, facets])
  const rule = ruleId != null ? alerts.byId(ruleId) : null
  const labelOf = Object.fromEntries(LOG_FACETS.map(f => [f.key, new Map(options[f.key].map(o => [o.value, o.label]))]))

  // The selection as this render knows it, carried across the toggles one click
  // can make: a facet's "clear" toggles each of its values in turn, and each
  // must start from where the last one left the selection, not from the render.
  const pending = useRef(null)
  pending.current = Object.fromEntries(Object.entries(facets).map(([k, v]) => [k, new Set(v)]))
  const toggle = key => (title, value) => {
    const next = pending.current[key]
    if (next.has(value)) next.delete(value)
    else next.add(value)
    onUrlChange({ facets: Object.fromEntries(Object.entries(pending.current).map(([k, v]) => [k, [...v]])) })
  }
  const anySelected = LOG_FACETS.some(f => facets[f.key].size) || ruleId != null

  return (
    <div className="svc-main nlog-tab">
      <aside className="nlog-rail" aria-label="Filters">
        {ruleId != null && (
          <div className="nlog-rule-filter">
            <span className="ae-label">Rule</span>
            <span className="nlog-rule-chip">
              {rule?.name ?? `#${ruleId}`}
              <button type="button" className="hbtn icon-only" aria-label="Show every rule's notifications" title="Show every rule's notifications" onClick={() => onUrlChange({ ruleId: null })}>
                <X aria-hidden="true" />
              </button>
            </span>
          </div>
        )}
        {LOG_FACETS.map(({ key, title }) => (
          <FacetGroup
            key={key}
            title={title}
            options={options[key].map(o => ({ value: o.value, count: o.count }))}
            selected={facets[key]}
            onToggle={toggle(key)}
            renderLabel={v => (v === ONE_OFF ? 'One-off destination' : labelOf[key].get(v) ?? v)}
          />
        ))}
        {anySelected && (
          <button type="button" className="ae-link" onClick={() => onUrlChange({ ruleId: null, facets: {} })}>Clear every filter</button>
        )}
      </aside>
      <div className="nlog-main">
        <NotificationLog
          rows={shown}
          nowSec={ALERTS_NOW}
          empty={rows.length
            ? 'No notification matches these filters in this range.'
            : 'Nothing was notified in this range: no rule fired, reminded or resolved.'}
        />
      </div>
    </div>
  )
}
