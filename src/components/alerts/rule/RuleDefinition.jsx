import { useState } from 'react'
import { Pencil, BellOff, ExternalLink } from 'lucide-react'
import GeneratedQuery from '@/components/explore/GeneratedQuery'
import { tokenizePromql } from '@/utils/explore/promql'
import { tokenizeLogsql } from '@/utils/explore/logsql'
import {
  DATASOURCES, STATIC_OPERATORS, ANOMALY_OPERATORS, QUICK_CALCULATE, SETTINGS_HELP,
} from '@/utils/alerts/catalog'
import { conditionText, formatThreshold, formatDuration, formatElapsed } from '@/utils/alerts/describe'
import { templateDisplay } from '@/utils/alerts/template'
import { muteCovering, nextMute } from '@/utils/alerts/routing'
import { integrationIcon } from './integrationIcons'
import { baseQueryOf } from './handoffs'
import { clockText, managedNote, SLO_EDIT_REASON } from './rulePage'

const OP_WORDS = { '=': 'equals', '!=': 'not equals', '=~': 'in', '!~': 'not in' }

// A builder row, as production's read-only editor shows it: "service equals payment-service".
const pairText = p => `${p.label} ${OP_WORDS[p.operator] ?? p.operator} ${(p.values ?? []).join(', ')}`
const pairsText = pairs => (pairs ?? []).filter(p => p.label).map(pairText).join(' AND ') || '—'

/** The rule's builder model as production's tabs would show it, read-only. */
function ModelSummary({ model }) {
  if (model.type === 'quick') {
    const calc = QUICK_CALCULATE.find(q => q.value === model.calculate)
    return (
      <dl className="alr-dl">
        <dt>Calculate</dt>
        <dd>{calc?.label ?? model.calculate}{model.calculate === 'latency_percentile' ? ` · p${model.value ?? 90}` : ''}</dd>
        <dt>Where</dt><dd className="mono">{pairsText(model.labelPairs)}</dd>
        <dt>Group by</dt><dd className="mono">{(model.groupBy ?? []).join(', ') || '—'}</dd>
      </dl>
    )
  }
  if (model.type === 'advanced') {
    const fn = f => {
      const labels = (f.args ?? []).find(a => a.type === 'labels')?.value
      const nums = (f.args ?? []).filter(a => a.type === 'number').map(a => a.value)
      return `${f.value}${nums.length ? `(${nums.join(', ')})` : ''}${labels?.length ? ` by (${labels.join(', ')})` : ''}`
    }
    return (
      <dl className="alr-dl">
        <dt>From</dt><dd className="mono">{model.metric || '—'}</dd>
        <dt>Where</dt><dd className="mono">{pairsText(model.labelPairs)}</dd>
        <dt>Select</dt><dd className="mono">{(model.functions ?? []).map(fn).join(' → ') || '—'}</dd>
      </dl>
    )
  }
  return (
    <dl className="alr-dl">
      <dt>Stream</dt><dd className="mono">{pairsText(model.streamPairs)}</dd>
      <dt>Fields</dt><dd className="mono">{pairsText(model.labelPairs)}</dd>
      <dt>Pipes</dt><dd className="mono">{(model.pipes ?? []).map(p => p.kind).join(' | ') || '—'}</dd>
    </dl>
  )
}

/**
 * The query, read-only, under the tabs production's editor has for its source
 * — Quick | Advanced | Code for Metrics, Builder | Code for Logs and Traces —
 * which stay clickable here (production disables them in read-only mode, so
 * only the pane it opened can be read: Explore reference R3). The builder tab
 * the rule was made in shows its model; Code shows the exact query, highlighted
 * by Explore's own tokenizer, with Copy.
 */
function QueryTabs({ view }) {
  const metrics = view.datasource === 'metrics'
  const tabs = metrics ? ['quick', 'advanced', 'code'] : ['builder', 'code']
  const label = { quick: 'Quick', advanced: 'Advanced', builder: 'Builder', code: 'Code' }
  const made = view.model?.type && tabs.includes(view.model.type) ? view.model.type : 'code'
  const [tab, setTab] = useState(made)
  const query = baseQueryOf(view)
  const tokenize = metrics ? tokenizePromql : tokenizeLogsql
  return (
    <div className="alr-query">
      <div className="seg-toggle" role="tablist" aria-label="Query editor views">
        {tabs.map(t => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            className={`seg${tab === t ? ' active' : ''}`}
            onClick={() => setTab(t)}
            title={t === made && t !== 'code' ? `This rule was built in ${label[t]}` : undefined}
          >
            {label[t]}
          </button>
        ))}
      </div>
      <div className="alr-query-pane" role="tabpanel" aria-label={`${label[tab]} (read-only)`}>
        {tab === 'code' && <GeneratedQuery query={query} tokenize={tokenize} title="Query" empty="This rule has no query" />}
        {tab !== 'code' && view.model?.type === tab && <ModelSummary model={view.model} />}
        {tab !== 'code' && view.model?.type !== tab && (
          <p className="alr-muted alr-query-note">
            {view.model?.type
              ? `This rule was built in ${label[view.model.type]}; its query is on the Code tab.`
              : `This rule was written as code, so there is no ${label[tab]} form to show; its query is on the Code tab.`}
          </p>
        )}
      </div>
      {(view.query || view.query2) && (
        <details className="alr-stored">
          <summary>As stored</summary>
          <p className="alr-muted">The expressions the backend evaluates, condition included, exactly as saved.</p>
          {view.query && <pre className="alr-pre mono">{view.query}</pre>}
          {view.query2 && <pre className="alr-pre mono">{view.query2}</pre>}
        </details>
      )}
    </div>
  )
}

const WEEKDAY_SHORT = { monday: 'Mon', tuesday: 'Tue', wednesday: 'Wed', thursday: 'Thu', friday: 'Fri', saturday: 'Sat', sunday: 'Sun' }

// "Start at 21:00 · Mute for 10h · Every day · Asia/Calcutta" (reference §3).
function intervalText(iv) {
  const times = (iv.times ?? []).map(t => `from ${t.start_time} for ${formatDuration(t.duration_minutes * 60)}`).join(', ')
  const days = iv.weekdays?.length ? iv.weekdays.map(d => WEEKDAY_SHORT[d] ?? d).join(', ') : 'every day'
  return `${times || 'no times'} · ${days} · ${iv.location || 'UTC'}`
}

function scheduleState(intervals, nowSec) {
  for (const iv of intervals) {
    const w = muteCovering(iv, nowSec)
    if (w) return `Active now, ends ${clockText(w.end, nowSec)}`
  }
  const next = intervals.map(iv => nextMute(iv, nowSec)).filter(Boolean).sort((a, b) => a.start - b.start)[0]
  return next ? `Next: ${clockText(next.start, nowSec)}` : null
}

/**
 * The Definition tab (D5): the rule as configured, read-only — its source and
 * type, the query under production's editor tabs, the condition in words and
 * per tier, when it is checked, after how long it fires and how often it
 * reminds, where it notifies, what holds it back (mute schedules, its own mute
 * windows, every snooze active or scheduled), its tags and annotations, who
 * may edit it, and the way into the editor.
 */
export default function RuleDefinition({ view, nowSec, muteGroups = [], lookups = {}, onEdit, onUnsnooze, onBlocked }) {
  const slo = view.managedBy?.kind === 'slo'
  const source = DATASOURCES.find(d => d.id === view.datasource)?.label ?? view.datasource
  const ops = view.kind === 'anomaly' ? ANOMALY_OPERATORS : STATIC_OPERATORS
  const opWords = op => ops.find(o => o.op === op)?.words ?? op
  const tier = (name, t) => (t ? (
    <li key={name}>
      <span className={`alr-tier-name tone-${name}`}>{name === 'critical' ? 'Critical' : 'Warning'}</span>
      {' when '}{opWords(t.op)} {formatThreshold(view, t.threshold ?? t.deviations)}
    </li>
  ) : null)
  const byContactPoint = new Map()
  for (const r of view.receivers ?? []) {
    const key = r.oneOff ? 'one-off' : `cp:${r.groupId}`
    if (!byContactPoint.has(key)) byContactPoint.set(key, { name: r.oneOff ? 'One-off destinations' : r.groupName, items: [] })
    byContactPoint.get(key).items.push(r)
  }
  const schedules = (view.muteSchedules ?? []).map(s => {
    const g = muteGroups.find(m => String(m.id) === String(s.id))
    const intervals = g?.mute?.time_intervals ?? []
    return { ...s, intervals, state: scheduleState(intervals, nowSec) }
  })
  const permissions = view.rule?.permissions ?? []
  const entityName = p => {
    if (p.entity_type === 'team') return lookups.teams?.find(t => t.id === p.entity_id)?.name ?? p.entity_id
    const u = lookups.users?.find(x => x.id === p.entity_id)
    return u ? `${u.first_name} ${u.last_name}` : p.entity_id
  }
  const note = managedNote(view)

  return (
    <div className="alr-definition">
      <div className="alr-def-bar">
        <p className="alr-muted">{note ?? 'This is the rule as saved. The editor changes it.'}</p>
        {slo ? (
          <button type="button" className="hbtn small is-inert" aria-disabled="true" title={SLO_EDIT_REASON} onClick={() => onBlocked?.(SLO_EDIT_REASON)}>
            <ExternalLink aria-hidden="true" />Edit in SLO
          </button>
        ) : view.readonly ? (
          <button type="button" className="hbtn small is-inert" aria-disabled="true" title="This rule is read-only" onClick={() => onBlocked?.('This rule is read-only')}>
            <Pencil aria-hidden="true" />Edit
          </button>
        ) : (
          <button type="button" className="hbtn small primary" onClick={onEdit} title="Open this rule in the editor">
            <Pencil aria-hidden="true" />Edit rule
          </button>
        )}
      </div>

      <section className="panel alr-def-section" aria-labelledby="alr-def-query">
        <div className="panel-head is-divided"><span id="alr-def-query">Query</span><span className="hint">{source} · {view.kind === 'anomaly' ? 'Anomaly' : 'Static'}</span></div>
        <div className="alr-def-body"><QueryTabs view={view} /></div>
      </section>

      <section className="panel alr-def-section" aria-labelledby="alr-def-condition">
        <div className="panel-head is-divided"><span id="alr-def-condition">Condition</span></div>
        <div className="alr-def-body">
          <p className="alr-def-lead">{conditionText(view)}</p>
          <ul className="alr-tiers">{tier('warning', view.tiers?.warning)}{tier('critical', view.tiers?.critical)}</ul>
          <dl className="alr-dl alr-dl-3">
            <dt title={SETTINGS_HELP.interval}>Check every</dt><dd>{formatDuration(view.intervalSec)}</dd>
            <dt title={SETTINGS_HELP.duration}>Fire after</dt><dd>{view.forSec ? formatDuration(view.forSec) : 'Immediately'}</dd>
            <dt title={SETTINGS_HELP.repeatInterval}>Re-notify every</dt><dd>{formatDuration(view.repeatSec)}</dd>
            <dt title={SETTINGS_HELP.grouping}>Send</dt><dd>{view.groupingDisable ? 'One notification per series' : 'One notification for all series'}</dd>
            <dt>Group</dt><dd>{view.group}</dd>
          </dl>
        </div>
      </section>

      <section className="panel alr-def-section" aria-labelledby="alr-def-notifies">
        <div className="panel-head is-divided"><span id="alr-def-notifies">Notifies</span></div>
        <div className="alr-def-body">
          {byContactPoint.size === 0 ? <p className="alr-muted">No one: this rule has no contact point.</p> : (
            <ul className="alr-cp-list">
              {[...byContactPoint.values()].map(cp => (
                <li key={cp.name}>
                  <span className="alr-cp-name">{cp.name}</span>
                  <ul className="alr-int-list">
                    {cp.items.map((r, i) => {
                      const Icon = integrationIcon(r.type)
                      return (
                        <li key={`${r.type}-${i}`} title={r.full || undefined}>
                          <Icon aria-hidden="true" />
                          <span>{r.label}</span>
                          {r.target && <span className="alr-muted mono">{r.target}</span>}
                          {r.sendResolved === false && <span className="alr-muted">· not when resolved</span>}
                        </li>
                      )
                    })}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="panel alr-def-section" aria-labelledby="alr-def-mutes">
        <div className="panel-head is-divided"><span id="alr-def-mutes">Mutes and snoozes</span></div>
        <div className="alr-def-body">
          {schedules.length === 0 && !(view.inlineMutes ?? []).length && !(view.snoozes ?? []).length && (
            <p className="alr-muted">Nothing holds this rule&apos;s notifications back.</p>
          )}
          {schedules.length > 0 && (
            <ul className="alr-plain-list">
              {schedules.map(s => (
                <li key={s.id}>
                  <strong>{s.name}</strong>
                  {s.intervals.map((iv, i) => <span key={i} className="alr-muted"> · {intervalText(iv)}</span>)}
                  {s.state && <span className={`alr-mute-state${s.state.startsWith('Active') ? ' is-active' : ''}`}> · {s.state}</span>}
                </li>
              ))}
            </ul>
          )}
          {(view.inlineMutes ?? []).length > 0 && (
            <ul className="alr-plain-list">
              {view.inlineMutes.map((iv, i) => <li key={i}><strong>This rule&apos;s own window</strong><span className="alr-muted"> · {intervalText(iv)}</span></li>)}
            </ul>
          )}
          {(view.snoozes ?? []).length > 0 && (
            <ul className="alr-plain-list">
              {view.snoozes.map(s => (
                <li key={s.silenceId} className="alr-snooze">
                  <BellOff aria-hidden="true" />
                  <span>
                    {s.scheduled ? `Snooze from ${clockText(s.startsAt, nowSec)} to ${clockText(s.endsAt, nowSec)}` : `Snoozed until ${clockText(s.endsAt, nowSec)} (${formatElapsed(s.endsAt - nowSec)} left)`}
                    {s.createdBy && <span className="alr-muted"> · by {s.createdBy}</span>}
                    {s.comment && <span className="alr-muted"> · “{s.comment}”</span>}
                  </span>
                  {onUnsnooze && (
                    <button type="button" className="hbtn small" onClick={() => onUnsnooze(s)}>
                      {s.scheduled ? 'Cancel snooze' : 'Unsnooze'}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="panel alr-def-section" aria-labelledby="alr-def-details">
        <div className="panel-head is-divided"><span id="alr-def-details">Details</span></div>
        <div className="alr-def-body">
          <dl className="alr-dl">
            <dt>Tags</dt>
            <dd>
              {Object.keys(view.tags ?? {}).length
                ? Object.entries(view.tags).map(([k, v]) => <span key={k} className="alr-label"><span className="alr-label-k">{k}</span>{v}</span>)
                : <span className="alr-muted">None</span>}
            </dd>
            <dt>Summary</dt><dd>{annotationText(view.annotations?.summary)}</dd>
            <dt>Description</dt><dd>{annotationText(view.annotations?.description)}</dd>
            <dt>Runbook</dt>
            <dd>
              {view.annotations?.runbook_url
                ? <a className="alr-link" href={view.annotations.runbook_url} target="_blank" rel="noreferrer">{view.annotations.runbook_url}</a>
                : <span className="alr-muted">None</span>}
            </dd>
            <dt>Access</dt>
            <dd>
              {permissions.length
                ? permissions.map((p, i) => <span key={i} className="alr-label"><span className="alr-label-k">{p.permission === 'editor' ? 'Editor' : 'Viewer'}</span>{entityName(p)}</span>)
                : 'By role: users with the Viewer role can view; users with the Editor role can edit.'}
            </dd>
          </dl>
        </div>
      </section>
    </div>
  )
}

// An annotation as it reads in a notification, with each template action shown
// as the label or value it stands for (‹value›, ‹host.name›) rather than as Go
// template syntax; the text as stored stays in the title.
function annotationText(text) {
  if (!text) return <span className="alr-muted">None</span>
  return <span title={text}>{templateDisplay(text)}</span>
}
