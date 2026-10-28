import { useEffect, useRef } from 'react'
import { HardDrive, Route, ScrollText } from 'lucide-react'
import { AlertStateChip } from '@/components/alerts/shared'
import Sparkline from '@/components/charts/Sparkline'
import { browserColor } from '@/utils/chartPalette'
import { formatValue, formatThreshold, formatElapsed, multipleText } from '@/utils/alerts/describe'
import { clockText, crossedTier, tierNumber, toSec } from './rulePage'
import { tracesHandoff, logsHandoff, hostHandoff } from './handoffs'

/** The newest send that concerned a row: a grouped rule's sends concern every series. */
function lastNotified(row, log) {
  let best = null
  for (const r of log) {
    if (r.status !== 'SUCCESS' && r.status !== 'ERROR') continue
    const labels = r.alert_labels
    if (labels && Object.entries(row.labels ?? {}).some(([k, v]) => labels[k] !== v)) continue
    const t = toSec(r.created_at)
    if (t != null && (best == null || t > best.t)) best = { t, failed: r.status === 'ERROR' }
  }
  return best
}

function sinceFor(row, nowSec) {
  if (row.state === 'firing') return `Firing ${formatElapsed(nowSec - (row.firingAt ?? row.activeAt))}`
  if (row.state === 'pending') return `Pending ${formatElapsed(nowSec - row.activeAt)}`
  return 'OK'
}

/**
 * The Instances tab (D5): one row per label set the query returns — its state,
 * the labels that tell it apart, its reading against the threshold it crossed
 * with a sparkline over the range, how long it has been in its state, and when
 * someone was last told. Production lists only open alerts, as raw values
 * ("0.28150713"), with no time at all (R9).
 *
 * A row's label button isolates its series on the Overview chart; the
 * selection is the page's, so a notification's `alert_id` arrives selected,
 * and this tab scrolls it into view when it opens (R10). The Traces and Logs
 * buttons are production's per-instance ways out, opened in place; Host,
 * which production lacks, opens the series' host on Infrastructure. Each row
 * offers the ones its own labels reach: a rule grouped by service or by host
 * names them on its series, not on the rule.
 */
export default function RuleInstances({ view, rows, log, nowSec, selected, onSelect, onTraces, onLogs, onHost, scrollToSelected = false }) {
  const selectedRef = useRef(null)
  useEffect(() => {
    if (scrollToSelected) selectedRef.current?.scrollIntoView?.({ block: 'center' })
  }, [scrollToSelected])

  if (rows.length === 0) {
    return (
      <p className="alr-empty">
        {view.state === 'paused' ? 'This rule is paused, so it has no instances: nothing is evaluated.'
          : view.state === 'error' ? 'This rule cannot evaluate its query, so it has no instances.'
            : 'The query returns no series in this range, so there is nothing to alert on yet.'}
      </p>
    )
  }

  return (
    <section className="panel alr-instances" aria-label="Instances">
      <table className="alr-table">
        <thead>
          <tr>
            <th scope="col">State</th>
            <th scope="col">Series</th>
            <th scope="col" className="num">Now vs threshold</th>
            <th scope="col">Over the range</th>
            <th scope="col">Since</th>
            <th scope="col">Last notified</th>
            <th scope="col"><span className="sr-only">Evidence</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const on = selected === row.name
            const crossed = crossedTier({ ...view, severity: row.severity })
            const t = crossed ? tierNumber(crossed.tier) : null
            const multiple = view.kind !== 'anomaly' && t && row.value != null ? multipleText({ thresholdMultiple: row.value / t }) : null
            const notified = lastNotified(row, log)
            const points = (row.points ?? []).filter(p => p.value != null)
            const host = onHost ? hostHandoff(view, { row }) : null
            const traces = onTraces ? tracesHandoff(view, { row }) : null
            const logs = onLogs ? logsHandoff(view, { row }) : null
            return (
              <tr
                key={row.key || `row-${i}`}
                ref={on ? selectedRef : undefined}
                className={on ? 'is-selected' : undefined}
                data-alert-ids={row.ids.join(' ') || undefined}
                aria-selected={on}
              >
                <td><AlertStateChip state={row.state} severity={row.severity} /></td>
                <td>
                  <button
                    type="button"
                    className="alr-series-btn"
                    aria-pressed={on}
                    title={on ? 'Show every series on the chart' : 'Show only this series on the Overview chart'}
                    onClick={() => onSelect?.(on ? null : row.name)}
                  >
                    {Object.keys(row.labels ?? {}).length
                      ? Object.entries(row.labels).map(([k, v]) => (
                        <span key={k} className="alr-label"><span className="alr-label-k">{k}</span>{v}</span>
                      ))
                      : <span className="alr-label">{row.name}</span>}
                  </button>
                </td>
                <td className="num mono">
                  <span className="alr-reading">{formatValue(view, row.value)}</span>
                  {multiple && t != null && <span className="alr-reading-vs"> {multiple} {formatThreshold(view, t)}</span>}
                </td>
                <td className="alr-spark-cell">
                  {points.length > 1 && <span className="alr-spark"><Sparkline data={points} color={browserColor(i)} height={24} /></span>}
                </td>
                <td>{sinceFor(row, nowSec)}{row.activeAt != null && <span className="alr-muted"> · {clockText(row.activeAt, nowSec)}</span>}</td>
                <td>
                  {notified
                    ? <span className={notified.failed ? 'alr-failed' : undefined}>{clockText(notified.t, nowSec)}{notified.failed ? ' · failed' : ''}</span>
                    : <span className="alr-muted">—</span>}
                </td>
                <td className="alr-row-actions">
                  {host && (
                    <button type="button" className="hbtn small" title={`${host.resource} on Infrastructure`} onClick={() => onHost(row)}>
                      <HardDrive aria-hidden="true" />Host
                    </button>
                  )}
                  {traces && (
                    <button type="button" className="hbtn small" title="This series' spans, 5 minutes either side of when it became active" onClick={() => onTraces(row)}>
                      <Route aria-hidden="true" />Traces
                    </button>
                  )}
                  {logs && (
                    <button type="button" className="hbtn small" title="This series' service logs at level error" onClick={() => onLogs(row)}>
                      <ScrollText aria-hidden="true" />Logs
                    </button>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </section>
  )
}
