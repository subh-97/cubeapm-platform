import { useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Check, Copy, Pencil, Plus, Trash2, X } from 'lucide-react'
import UndoMessage from '@/components/alerts/shared/UndoMessage'
import AlertDialog from '@/components/alerts/shared/AlertDialog'
import { useFocusHandoff } from '@/components/alerts/shared/useFocusHandoff'
import { integrationIcon } from '@/components/alerts/rule/integrationIcons'
import { ALERTS_NOW } from '@/data/alerts'
import { statusForDelivery } from '@/utils/status'
import { formatElapsed } from '@/utils/alerts/describe'
import { effectiveReceivers, receiverSummary } from '@/utils/alerts/routing'
import { usageByContactPoint, deliveryHealth, sortContactPoints } from '@/utils/alerts/configViews'
import { alertsSearch } from '@/utils/alertsUrl'
import { alertRuleUrl, routeUrl } from '@/utils/route'
import { formatLocal } from '@/utils/timeRange'
import ContactPointDrawer from './ContactPointDrawer.jsx'

const ALERTS_PATH = routeUrl({ view: 'alerts' })
const isPlain = e => !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0)
const ago = sec => `${formatElapsed(ALERTS_NOW - sec)} ago`
const stamp = sec => formatLocal(sec * 1000, 'MMM DD HH:mm')

/**
 * The Contact points tab (production's Receiver Groups; docs/alerts/DESIGN.md
 * D9). Each contact point says where it sends — every integration as icon,
 * label and target — who sends there, and how its last send went, read from
 * the notification log. That last part is new: production shows nothing, so
 * a webhook answering 503 is found out during the incident it was meant to
 * page for. Here a failing contact point heads the list, red, with the error.
 *
 * Range-free, so the page bar drops its time picker here (D16).
 */
export default function ContactPointsTab({ alerts, setToast }) {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [drawer, setDrawer] = useState(null)
  // A deleted contact point hands focus to the one after it (7c).
  const listRef = useRef(null)
  const newRef = useRef(null)
  const onListFocus = useFocusHandoff(listRef, { item: '.cfg-item', target: '.cfg-item-name', fallback: () => newRef.current })
  const [confirming, setConfirming] = useState(null)
  const cancelRef = useRef(null)
  const groups = alerts.receiverGroups
  const usage = useMemo(() => usageByContactPoint(alerts.rules), [alerts.rules])
  const deliveries = useMemo(() => alerts.deliveries?.() ?? new Map(), [alerts])
  const health = useMemo(() => new Map(groups.map(g => [g.id, deliveryHealth(deliveries.get(g.id))])), [groups, deliveries])
  const sorted = useMemo(() => sortContactPoints(groups, usage, health), [groups, usage, health])
  const q = query.trim().toLowerCase()
  const shown = q ? sorted.filter(g => searchText(g, usage, alerts.lookups).includes(q)) : sorted
  const failing = groups.filter(g => health.get(g.id)?.status === 'ERROR').length

  const go = url => (e) => { if (!isPlain(e)) return; e.preventDefault(); navigate(url) }
  const save = (group) => {
    const { group: saved, undo } = alerts.actions.saveReceiverGroup(group)
    setDrawer(null)
    setToast?.(<UndoMessage text={`Saved ${saved.name}.`} onUndo={() => { undo(); setToast?.(null) }} />)
  }
  const remove = (group) => {
    const undo = alerts.actions.removeReceiverGroup(group.id)
    setDrawer(null)
    if (typeof undo !== 'function') {
      setToast?.(`${group.name} is still used by a rule; nothing was deleted.`)
      return
    }
    setToast?.(<UndoMessage text={`Deleted ${group.name}.`} onUndo={() => { undo(); setToast?.(null) }} />)
  }

  return (
    <div className="svc-main cfg-tab">
      <div className="cfg-toolbar">
        <p className="cfg-count">
          {groups.length} contact point{groups.length === 1 ? '' : 's'}
          {failing > 0 && <span className="cfg-count-bad"> · {failing} failing</span>}
        </p>
        <input
          className="ae-input cfg-search"
          type="search"
          value={query}
          placeholder="Search names, channels, addresses, rules"
          aria-label="Search contact points"
          onChange={e => setQuery(e.target.value)}
        />
        <button ref={newRef} type="button" className="hbtn primary" onClick={() => setDrawer({ mode: 'new', group: null })}>
          <Plus aria-hidden="true" />New contact point
        </button>
      </div>

      {groups.length === 0 ? (
        <div className="cfg-empty">
          <p className="cfg-empty-title">No contact points yet</p>
          <p className="ae-hint">A contact point is a named set of destinations — a Slack channel, an email list, a PagerDuty service — that rules send to. Make one, then pick it in a rule&apos;s Notify.</p>
        </div>
      ) : shown.length === 0 ? (
        <div className="cfg-empty">
          <p className="cfg-empty-title">Nothing matches “{query.trim()}”</p>
          <button type="button" className="ae-link" onClick={() => setQuery('')}>Clear the search</button>
        </div>
      ) : (
        <ul className="cfg-list" ref={listRef} onFocus={onListFocus}>
          {shown.map((g) => {
            const users = usage.get(g.id) ?? []
            const h = health.get(g.id)
            const sent = deliveries.get(g.id) ?? []
            return (
              <li key={g.id} className={`cfg-item${h?.status === 'ERROR' ? ' is-failing' : ''}`} data-key={g.id}>
                <div className="cfg-item-head">
                  <button type="button" className="cfg-item-name" onClick={() => setDrawer({ mode: 'edit', group: g })}>{g.name}</button>
                  <UsedBy users={users} empty="Not used by any rule" go={go}
                    filtered={users.length ? `${ALERTS_PATH}${alertsSearch({ facets: { notifies: [g.name] } })}` : null} />
                  <div className="cfg-item-actions">
                    <button type="button" className="hbtn" onClick={() => setDrawer({ mode: 'edit', group: g })}><Pencil aria-hidden="true" />Edit</button>
                    <button type="button" className="hbtn" onClick={() => setDrawer({ mode: 'clone', group: g })}><Copy aria-hidden="true" />Clone</button>
                    <button
                      type="button"
                      className="hbtn"
                      aria-disabled={users.length > 0 || undefined}
                      title={users.length ? `Used by ${users.length} rule${users.length === 1 ? '' : 's'}: move them to another contact point first.` : `Delete ${g.name}`}
                      onClick={users.length ? undefined : () => setConfirming(g)}
                    >
                      <Trash2 aria-hidden="true" />Delete
                    </button>
                  </div>
                </div>
                <ul className="cfg-integrations">
                  {effectiveReceivers({ config: { receiver_group_ids: [g.id] } }, [g]).map((r, i) => {
                    const s = receiverSummary(r, alerts.lookups)
                    const Icon = integrationIcon(r.type)
                    const last = sent.find(d => d.type === r.type && JSON.stringify(d.data) === JSON.stringify(r.data))
                    return (
                      <li key={i} className="cfg-integration">
                        <Icon aria-hidden="true" className="cfg-integration-icon" />
                        <span className="cfg-integration-label">{s.label}</span>
                        <span className="cfg-integration-target" title={s.full}>{s.target}</span>
                        <Delivery last={last} />
                      </li>
                    )
                  })}
                </ul>
              </li>
            )
          })}
        </ul>
      )}

      {drawer && (
        <ContactPointDrawer
          key={`${drawer.mode}-${drawer.group?.id ?? 'new'}`}
          mode={drawer.mode}
          group={drawer.group}
          usedBy={drawer.group ? usage.get(drawer.group.id) ?? [] : []}
          others={groups.filter(x => drawer.mode !== 'edit' || x.id !== drawer.group?.id).map(x => x.name)}
          lookups={alerts.lookups}
          onSave={save}
          onDelete={remove}
          onClose={() => setDrawer(null)}
        />
      )}
      {confirming && (
        <div className="cfg-dialog-layer">
          <AlertDialog
            title={`Delete ${confirming.name}?`}
            onCancel={() => setConfirming(null)}
            initialFocus={cancelRef}
            footer={(
              <>
                <button ref={cancelRef} type="button" className="hbtn" onClick={() => setConfirming(null)}>Cancel</button>
                <button type="button" className="hbtn alr-btn-danger" onClick={() => { remove(confirming); setConfirming(null) }}>Delete contact point</button>
              </>
            )}
          >
            <p>No rule sends here. Its past notifications stay in the history.</p>
          </AlertDialog>
        </div>
      )}
    </div>
  )
}

// How an integration's last send went: sent, failed with why, or nothing yet.
function Delivery({ last }) {
  if (!last) return <span className="cfg-delivery muted">Nothing sent in the last 8 days</span>
  const tone = statusForDelivery(last.status)
  const ok = last.status === 'SUCCESS'
  return (
    <span className={`cfg-delivery ${tone}`} title={`${ok ? 'Sent' : 'Failed'} ${stamp(last.at)}, for ${last.ruleName}${last.details ? `\n${last.details}` : ''}`}>
      {ok ? <Check aria-hidden="true" /> : <X aria-hidden="true" />}
      {ok ? `Sent ${ago(last.at)}` : `Failed ${ago(last.at)}`}
      {!ok && last.details && <span className="cfg-delivery-why">{last.details}</span>}
    </span>
  )
}

// "Used by 3 rules": the rules, as links, and the Rules tab filtered to them.
export function UsedBy({ users, empty, go, filtered }) {
  if (!users.length) return <span className="cfg-usedby muted">{empty}</span>
  return (
    <details className="cfg-usedby">
      <summary>Used by {users.length} rule{users.length === 1 ? '' : 's'}</summary>
      <ul>
        {users.map(r => (
          <li key={r.id}><a href={alertRuleUrl(r.id)} onClick={go(alertRuleUrl(r.id))}>{r.name}</a></li>
        ))}
      </ul>
      {filtered && <a className="ae-link" href={filtered} onClick={go(filtered)}>Show them in Rules</a>}
    </details>
  )
}

function searchText(g, usage, lookups) {
  const targets = effectiveReceivers({ config: { receiver_group_ids: [g.id] } }, [g])
    .map(r => { const s = receiverSummary(r, lookups); return `${s.label} ${s.full}` })
  return [g.name, ...targets, ...(usage.get(g.id) ?? []).map(r => r.name)].join(' ').toLowerCase()
}
