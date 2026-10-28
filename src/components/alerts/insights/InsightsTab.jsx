import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Download, SlidersHorizontal } from 'lucide-react'
import InfoTip from '@/components/shared/InfoTip'
import { radioGroupKeyDown } from '@/components/alerts/shared/alertShared'
import { SortableTable, CellBar } from '@/components/shared/SortableTable'
import { statusForDelivery } from '@/utils/status'
import { formatElapsed, displayName } from '@/utils/alerts/describe'
import { insightRows, insightsSummary, insightsCsv, FLAG_TEXT } from '@/utils/alerts/insights'
import { downloadCsv } from '@/utils/explore/csv'
import { alertRuleUrl, alertEditorUrl } from '@/utils/route'
import './insights.css'

const isPlain = e => !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0)
// A change against the previous period, as a figure that says which way: "↑3",
// "↓1", "same". Neutral, never a status hue: more incidents is not by itself a
// severity, and colour is kept for those (CLAUDE.md rule 2).
const change = (d, unit = '') => (d == null ? null : d === 0 ? 'same' : `${d > 0 ? '↑' : '↓'}${Math.abs(Math.round(d * 10) / 10)}${unit}`)
const isFlagged = r => r.flags.alwaysFiring || r.flags.flapping || r.flags.neverFired

/**
 * The Insights tab (production's Stats; docs/alerts/DESIGN.md D11): which
 * rules are noisy, which never do anything, and how that moved against the
 * previous period. Every rule is listed, so "Never fired" can be said at all;
 * the flagged ones lead, each with Tune, which opens the rule's editor at the
 * same range with its preview already offering a threshold (D7).
 */
export default function InsightsTab({ alerts, win }) {
  const navigate = useNavigate()
  const [only, setOnly] = useState('all')
  const before = useMemo(() => alerts.statsBefore?.() ?? null, [alerts])
  const rows = useMemo(() => insightRows(alerts.rules, alerts.stats, before), [alerts.rules, alerts.stats, before])
  const summary = insightsSummary(rows)
  const shown = only === 'flagged' ? rows.filter(isFlagged) : rows
  const go = url => (e) => { if (!isPlain(e)) return; e.preventDefault(); navigate(url) }
  const range = win.label?.toLowerCase() ?? 'the range'
  const prev = before ? `the previous ${win.isAbsolute ? 'period' : range.replace(/^last /, '')}` : null

  const columns = [
    {
      key: 'name', label: 'Rule', align: 'left', sortKey: 'name',
      render: r => (
        <span className="ins-rule">
          <a href={alertRuleUrl(r.id)} onClick={go(alertRuleUrl(r.id))}>{displayName(r.view)}</a>
          <span className="ins-rule-meta">{r.group} · #{r.id}{r.paused ? ' · paused' : ''}</span>
          {Object.keys(FLAG_TEXT).filter(k => r.flags[k]).map(k => (
            <span key={k} className={`ins-flag ${k}`} title={FLAG_TEXT[k].help}>{FLAG_TEXT[k].label}</span>
          ))}
        </span>
      ),
    },
    {
      key: 'incidents', label: 'Incidents',
      info: <InfoTip label="About Incidents">Times the rule went into firing in the range. A warning that escalates to critical is one incident; one already firing when the range opens is not counted again.</InfoTip>,
      render: r => <Figure value={r.incidents.toLocaleString()} delta={change(r.deltas?.incidents)} />,
    },
    {
      key: 'firing', label: 'Time firing', sortKey: 'firingPct',
      info: <InfoTip label="About Time firing">How long the rule spent firing in the range, and that as a share of the range.</InfoTip>,
      render: r => (
        <CellBar fill={r.firingPct}>
          <Figure value={`${formatElapsed(r.firingSec)} · ${Math.round(r.firingPct * 10) / 10}%`} delta={change(r.deltas?.firingPct, ' pts')} />
        </CellBar>
      ),
    },
    {
      key: 'median', label: 'Median incident', sortKey: 'medianSec',
      info: <InfoTip label="About Median incident">Half the incidents in the range lasted less than this. Short and many is flapping.</InfoTip>,
      render: r => (r.medianSec == null ? '—' : formatElapsed(r.medianSec)),
    },
    {
      key: 'notifications', label: 'Notifications',
      info: <InfoTip label="About Notifications">Messages sent for the rule in the range, to every integration of every contact point it notifies, reminders included. Failed sends are counted apart.</InfoTip>,
      render: r => (
        <span>
          <Figure value={r.notifications.toLocaleString()} delta={change(r.deltas?.notifications)} />
          {r.failed > 0 && <span className={`ins-failed ${statusForDelivery('ERROR')}`}> · {r.failed} failed</span>}
        </span>
      ),
    },
    {
      key: 'tune', label: '', sortable: false,
      render: (r) => {
        const locked = r.view.managedBy?.kind === 'slo' || r.view.readonly
        return (
          <button
            type="button"
            className="hbtn ins-tune"
            aria-disabled={locked || undefined}
            title={locked ? 'Its thresholds are set by its SLO.' : `Open ${displayName(r.view)} in the editor, previewed over ${range}`}
            onClick={locked ? undefined : () => navigate(alertEditorUrl(r.id), { state: { focus: 'tiers' } })}
          >
            <SlidersHorizontal aria-hidden="true" />Tune
          </button>
        )
      },
    },
  ]

  return (
    <div className="svc-main ins-tab">
      <div className="ins-strip" role="list" aria-label={`Over ${range}`}>
        <Cell label="Incidents" value={summary.incidents.toLocaleString()} delta={change(summary.incidentsDelta)} prev={prev} />
        <Cell label="Notifications sent" value={summary.notifications.toLocaleString()} delta={change(summary.notificationsDelta)} prev={prev} />
        <Cell label="Failed notifications" value={summary.failed.toLocaleString()} tone={summary.failed > 0 ? statusForDelivery('ERROR') : null} />
        <Cell label="Flagged rules" value={summary.flagged} note={summary.alwaysFiring ? `${summary.alwaysFiring} always firing` : null} />
      </div>
      {!before && (
        <p className="ae-hint">
          No comparison: the period before {range} reaches past the 8 days the rules are evaluated over.
        </p>
      )}
      <div className="cfg-toolbar">
        <div className="seg-toggle" role="radiogroup" aria-label="Which rules" onKeyDown={radioGroupKeyDown}>
          {[['all', `All rules (${rows.length})`], ['flagged', `Flagged (${rows.filter(isFlagged).length})`]].map(([k, label]) => (
            <button key={k} type="button" role="radio" aria-checked={only === k} className={`seg${only === k ? ' active' : ''}`} tabIndex={only === k ? 0 : -1} onClick={() => setOnly(k)}>{label}</button>
          ))}
        </div>
        <button type="button" className="hbtn" onClick={() => downloadCsv(insightsCsv(rows), 'alert-insights')}>
          <Download aria-hidden="true" />Download CSV
        </button>
      </div>
      <SortableTable
        columns={columns}
        rows={shown}
        rowKey={r => r.id}
        className="ins-table"
        empty="No rule is flagged over this range."
      />
    </div>
  )
}

function Figure({ value, delta }) {
  return (
    <span className="ins-figure">
      {value}
      {delta && <span className="ins-delta">{delta}</span>}
    </span>
  )
}

function Cell({ label, value, delta, prev, tone, note }) {
  return (
    <div className="ins-cell" role="listitem">
      <span className="ins-cell-label">{label}</span>
      <span className={`ins-cell-value${tone ? ` ${tone}` : ''}`}>{value}</span>
      {delta && <span className="ins-cell-delta">{delta}{prev ? ` vs ${prev}` : ''}</span>}
      {note && <span className="ins-cell-delta">{note}</span>}
    </div>
  )
}
