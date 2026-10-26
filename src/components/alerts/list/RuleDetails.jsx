import { ArrowUpRight, CalendarClock, Compass, FileText, HardDrive, History, Waypoints } from 'lucide-react'
import { AlertStateChip, SuppressionChip } from '@/components/alerts/shared'
import Sparkline from '@/components/charts/Sparkline'
import { ALERT_STATE_LABELS, alertStateKey } from '@/utils/status'
import { rulePath, ruleSentence, formatValue, formatDuration, formatElapsed, displayName } from './adapters'
import { ruleSource, SOURCE_LABELS } from './rulesQuery'
import { isPlainClick } from './rulesList'
import { tracesLink, logsLink, hostLink, exploreLink } from './handoffs'
import {
  integrationIcon, receiverText, receiversOf, oneOffReceivers, valueTone, tierFor, tierCondition, managedText,
  instanceLabels, historyHref, lastEvaluatedText, snoozesOf, seriesTrend,
} from './ruleDisplay'

/**
 * A rule, expanded in place (D3; signed off as Q5, production's behaviour):
 * production's details panel restyled, with the rule in words where it printed
 * PromQL, the evaluation settings, who it tells, what is holding it, its tags
 * and when it last ran (R8), then one row per firing or pending series with
 * the way to its evidence, and the way to everything else at the foot.
 */
export default function RuleDetails({ view, panelId, nowSec, seriesFor, handlers }) {
  const name = displayName(view)
  const source = ruleSource(view)
  const managed = managedText(view)
  const cps = (view.contactPoints ?? []).filter(c => c?.name)
  const oneOff = oneOffReceivers(view)
  const tags = Object.entries(view.tags ?? {})
  const schedules = view.muteSchedules ?? []
  const snoozes = snoozesOf(view)
  const muted = view.suppression?.kind === 'mute' ? view.suppression : null
  const explore = exploreLink(view)
  const instances = view.instances ?? []
  // An SLO's rule can be snoozed (D18), so it can be unsnoozed; a read-only
  // rule of any other kind cannot be changed from here at all.
  const canUnsnooze = !view.readonly || view.managedBy?.kind === 'slo'

  const go = handler => (e) => {
    if (!isPlainClick(e)) return
    e.preventDefault()
    handler()
  }

  return (
    <div className="rtab-details" id={panelId} role="region" aria-label={`${name}: details`}>
      <p className="rtab-d-sentence">{ruleSentence(view)}</p>
      <dl className="rtab-d-grid">
        <dt>Source</dt>
        <dd>
          {SOURCE_LABELS[source] ?? source} · {view.kind === 'anomaly' ? 'Anomaly' : 'Static'}
          {managed && <span className="rtab-d-muted"> · {managed}</span>}
        </dd>

        <dt>Evaluation</dt>
        <dd className="rtab-d-settings">
          <span>Check every <b>{formatDuration(view.intervalSec)}</b></span>
          <span>Fire after <b>{formatDuration(view.forSec)}</b></span>
          <span>Re-notify every <b>{formatDuration(view.repeatSec)}</b></span>
        </dd>

        <dt>Notifies</dt>
        <dd className="rtab-d-list">
          {cps.length === 0 && oneOff.length === 0 && <span className="rtab-d-muted">Nobody</span>}
          {cps.map(cp => {
            const dests = receiversOf(view, cp)
            const Icon = integrationIcon(dests[0]?.type)
            const targets = dests.map(receiverText).join(', ')
            return (
              <span key={cp.id ?? cp.name} className="rtab-cp" title={targets || undefined}>
                <Icon aria-hidden="true" />
                {cp.name}
                {targets && <span className="rtab-cp-targets">{targets}</span>}
              </span>
            )
          })}
          {oneOff.map((r, i) => {
            const Icon = integrationIcon(r.type)
            return (
              <span key={`one-off-${i}`} className="rtab-cp" title={r.full ?? undefined}>
                <Icon aria-hidden="true" />
                {receiverText(r)}
                <span className="rtab-cp-targets">one-off</span>
              </span>
            )
          })}
        </dd>

        <dt>Snoozes &amp; mutes</dt>
        <dd className="rtab-d-list">
          {snoozes.length === 0 && !muted && schedules.length === 0 && <span className="rtab-d-muted">None</span>}
          {snoozes.map(s => (
            <span key={s.silenceId ?? `${s.startsAt}-${s.endsAt}`} className="rtab-d-list">
              <SuppressionChip suppression={s} nowSec={nowSec} />
              {(s.createdBy || s.comment) && (
                <span className="rtab-d-muted">
                  {[s.createdBy && `by ${s.createdBy}`, s.comment && `“${s.comment}”`].filter(Boolean).join(' · ')}
                </span>
              )}
              {canUnsnooze && (
                <button type="button" className="rtab-link-btn" onClick={() => handlers.onUnsnooze(view, s)}>
                  {s.scheduled || s.startsAt > nowSec ? 'Cancel snooze' : 'Unsnooze'}
                </button>
              )}
            </span>
          ))}
          {muted && <SuppressionChip suppression={muted} nowSec={nowSec} />}
          {schedules.map(m => (
            <span key={m.id ?? m.name} className="rtab-cp" title="Mute schedule">
              <CalendarClock aria-hidden="true" />
              {m.name}
            </span>
          ))}
        </dd>

        {tags.length > 0 && (
          <>
            <dt>Tags</dt>
            <dd className="rtab-d-list">
              {tags.map(([k, v]) => <span key={k} className="rtab-tag">{k}: {v}</span>)}
            </dd>
          </>
        )}

        <dt>Last evaluated</dt>
        <dd>{lastEvaluatedText(view, nowSec)}</dd>
      </dl>

      {view.lastError && (
        <pre className="rtab-d-error"><span className="rtab-d-error-label">Rule error</span>{view.lastError}</pre>
      )}

      {instances.length > 0 && (
        <div className="rtab-inst">
          <h4 className="rtab-inst-head">{instances.length === 1 ? '1 alert' : `${instances.length} alerts`}</h4>
          {instances.map(inst => (
            <InstanceRow
              key={inst.id ?? inst.key}
              view={view}
              instance={inst}
              points={seriesTrend(view, seriesFor, inst.labels).points}
              nowSec={nowSec}
              onOpenLink={handlers.onOpenLink}
            />
          ))}
        </div>
      )}

      <div className="rtab-d-foot">
        <a className="hbtn small" href={rulePath(view.id)} onClick={go(() => handlers.onOpenRule(view.id))}>
          <ArrowUpRight aria-hidden="true" />
          Open rule
        </a>
        <a className="hbtn small" href={historyHref(view.id)} onClick={go(() => handlers.onHistory(view.id))}>
          <History aria-hidden="true" />
          Notification history
        </a>
        <button
          type="button"
          className="hbtn small"
          disabled={!explore.link}
          title={explore.reason ?? 'Open this rule\'s query in Explore'}
          onClick={() => explore.link && handlers.onOpenLink(explore.link)}
        >
          <Compass aria-hidden="true" />
          Open in Explore
        </button>
      </div>
    </div>
  )
}

/**
 * One alert the rule raised: production's instance row, with the value in the
 * rule's unit against the condition it crossed (production printed
 * `0.28150713`), how long, and Traces and Logs opening in place, with its host
 * on Infrastructure when the alert names one.
 */
function InstanceRow({ view, instance, points, nowSec, onOpenLink }) {
  const entry = tierFor(view, instance.severity)
  const condition = tierCondition(view, entry)
  const tone = valueTone(instance.state, instance.severity)
  const labels = instanceLabels(view, instance)
  const key = alertStateKey(instance.state, instance.severity)
  const word = instance.state === 'firing' ? 'Firing' : instance.state === 'pending' ? 'Pending' : ALERT_STATE_LABELS[key] ?? ''
  // A firing alert counts from when it fired, not from `activeAt`, which is
  // when it began pending; the rule's own "Firing 15m" and the rule page's
  // instances count the same way, so the three cannot disagree.
  const start = instance.state === 'firing' ? (instance.firingAt ?? instance.activeAt) : instance.activeAt
  const since = Number.isFinite(start) ? `${word} ${formatElapsed(nowSec - start)}` : word
  const host = hostLink(view, instance)
  const traces = tracesLink(view, instance)
  const logs = logsLink(view, instance)
  return (
    <div className="rtab-inst-row">
      <AlertStateChip state={instance.state} severity={instance.severity} />
      <div className="rtab-inst-labels" title={instance.name && instance.name !== view.name ? instance.name : undefined}>
        {labels.length === 0 && <span className="rtab-d-muted">All series</span>}
        {labels.map(l => <span key={l.key} className="rtab-scope" title={`${l.key}: ${l.value}`}>{l.key}={l.value}</span>)}
      </div>
      <div className="rtab-inst-value">
        <span className={`rtab-val ${tone}`}>{formatValue(view, instance.value)}</span>
        {condition && <span className="rtab-inst-of" title={`The ${entry.name} condition`}>{condition}</span>}
        {points.length > 1 && (
          <span className="rtab-spark" title={`${view.metric ?? 'Value'} over the range`}>
            <Sparkline data={points} color="var(--brand)" height={18} />
          </span>
        )}
      </div>
      <span className="rtab-since">{since}</span>
      <div className="rtab-inst-links">
        {host && (
          <button type="button" className="hbtn small" onClick={() => onOpenLink(host)} title={`Open ${host.resource} on Infrastructure`}>
            <HardDrive aria-hidden="true" />
            Host
          </button>
        )}
        {traces && (
          <button type="button" className="hbtn small" onClick={() => onOpenLink(traces)} title="Open this alert's traces">
            <Waypoints aria-hidden="true" />
            Traces
          </button>
        )}
        {logs && (
          <button type="button" className="hbtn small" onClick={() => onOpenLink(logs)} title="Open this alert's logs">
            <FileText aria-hidden="true" />
            Logs
          </button>
        )}
      </div>
    </div>
  )
}
