import { useMemo } from 'react'
import { formatNumber, formatValue, formatThreshold, formatElapsed, formatDuration, multipleText, sinceText } from '@/utils/alerts/describe'
import { formatDelta } from '@/utils/explore/format'
import { previousPeriodText } from '@/utils/errorsPage'
import RuleChart from './RuleChart'
import { clockText, crossedTier, tierNumber, incidentsStarted, sendCounts, recentEvents, seriesName } from './rulePage'

// The headline figure's unit, beside it in small type (the kpi-card's .unit).
const UNIT_TEXT = { '%': '%', ms: 'ms', rpm: 'rpm', MB: 'MB', s: 's', x: '×', deviations: 'σ' }

// A count against the previous window, as a chip's text and title.
function countDelta(count, prev, prevText) {
  const d = formatDelta(count, prev)
  if (d.dir === 'new') return { text: 'new', title: `None in ${prevText}`, dir: 'up' }
  if (d.dir === 'none') return { text: 'same', title: `None in ${prevText} either`, dir: 'flat' }
  return { text: d.text, title: `${d.text} vs ${prevText} (${prev} then)`, dir: d.dir }
}

function Kpi({ label, tone, value, unit, sub, delta, title }) {
  return (
    <div className={`kpi-card alr-kpi${tone ? ` ${tone}` : ''}`} title={title}>
      <div className="kpi-card-head">
        <span className="lbl">{label}</span>
        {delta && <span className={`alr-delta is-${delta.dir}`} title={delta.title}>{delta.text}</span>}
      </div>
      <div className="val mono">{value}{unit && <span className="unit">{unit}</span>}</div>
      {sub && <div className="alr-kpi-sub">{sub}</div>}
    </div>
  )
}

/**
 * The Overview tab (D5): the chart with its bands, shading and state strip;
 * four KPIs, each against something (rule 6) — the reading against its
 * threshold and the previous period, how long it has fired, incidents against
 * the previous range, notifications sent; then what happened, newest first,
 * and when the rule was last evaluated (production never shows it, R8).
 */
export default function RuleOverview({
  view, series, prevSeries, compare, onCompare, timeline, lane, prev, log, segments, win, nowSec, timeRange,
  onFocus, selected, onSelect, lookups, staleAlertId, headline = null,
}) {
  const prevText = previousPeriodText(timeRange)

  // The headline reading is the isolated instance's when one is picked —
  // the chart above it draws that one line — and the rule's otherwise.
  const isolated = selected != null && headline?.name === selected ? headline : null
  const reading = isolated ? { ...view, value: isolated.value, severity: isolated.severity } : view
  const crossed = crossedTier(reading)
  const threshold = crossed ? formatThreshold(view, tierNumber(crossed.tier)) : null
  const multiple = isolated
    ? (crossed && isolated.value != null && tierNumber(crossed.tier) ? multipleText({ thresholdMultiple: isolated.value / tierNumber(crossed.tier) }) : null)
    : multipleText(view)

  // The previous period's reading at the same point in it, for the series the
  // headline is about: the model's own previous value for the rule, else the
  // store's for the series, else the previous window's last reading of it.
  const name = headline?.name ?? null
  const drawn = series.length === 1 ? 0 : series.findIndex(s => seriesName(s, view) === name)
  const previous = (!isolated ? view.previousValue : null) ?? (drawn >= 0 ? series[drawn]?.previous : null) ?? (() => {
    if (drawn < 0) return null
    const pts = prevSeries?.[drawn]?.points ?? []
    for (let i = pts.length - 1; i >= 0; i--) if (pts[i]?.value != null) return pts[i].value
    return null
  })()

  const to = Math.min(win.end, nowSec)
  const incidents = incidentsStarted(timeline?.intervals ?? [], win.start, to)
  const prevIncidents = incidentsStarted(prev?.timeline?.intervals ?? [], prev?.win?.start ?? 0, prev?.win?.end ?? 0)
  const sends = sendCounts(log, win.start, to)
  const prevSends = sendCounts(prev?.log ?? [], prev?.win?.start ?? 0, prev?.win?.end ?? 0)

  const events = useMemo(
    () => recentEvents({ intervals: timeline?.intervals ?? [], log, view, from: win.start, to, limit: 8, lookups }),
    [timeline, log, view, win.start, to, lookups],
  )

  const lastFired = [...(timeline?.intervals ?? [])].reverse().find(iv => iv.state === 'firing')
  const firingCard = view.state === 'firing'
    ? { value: formatElapsed(nowSec - view.since) + (view.sinceOpen ? '+' : ''), sub: `since ${clockText(view.since, nowSec)}` }
    : view.state === 'pending'
      ? { value: 'Pending', sub: sinceText(view, nowSec) }
      : { value: 'Not firing', sub: lastFired ? `last fired ${clockText(lastFired.start, nowSec)}${lastFired.end ? `, for ${formatElapsed(lastFired.end - lastFired.start)}` : ''}` : `no incidents in ${win.label ?? 'this range'}` }

  const nowValue = reading.value != null ? formatNumber(reading.value) : '—'
  const nowSub = [
    view.kind === 'anomaly' ? null
      : threshold ? `${multiple ?? '—'} the ${threshold} ${crossed.severity} threshold` : null,
    previous != null ? `${formatValue(view, previous)} ${prevText.replace(/^the /, '')}` : null,
  ].filter(Boolean).join(' · ')
  const nowDelta = previous != null && reading.value != null ? (() => {
    const d = formatDelta(reading.value, previous)
    return { text: d.text, dir: d.dir === 'new' ? 'up' : d.dir, title: `${d.text} vs ${prevText} (${formatValue(view, previous)} then)` }
  })() : null

  const evaluated = view.lastEvaluation
  const evaluatedText = evaluated
    ? `Last evaluated ${clockText(evaluated, nowSec)}${nowSec - evaluated >= 0 ? ` (${formatElapsed(nowSec - evaluated)} ago)` : ''} · every ${formatDuration(view.intervalSec)}`
    : view.state === 'paused' ? 'Not evaluated while paused' : 'Not evaluated yet'

  return (
    <div className="alr-overview">
      {staleAlertId && (
        <p className="alr-note" role="note">
          The alert this link was about (<span className="mono">{staleAlertId}</span>) is no longer open. The rule is shown in full.
        </p>
      )}
      <RuleChart
        view={view} series={series} compareSeries={prevSeries} compare={compare} onCompare={onCompare}
        timeline={timeline} lane={lane} segments={segments} win={win} nowSec={nowSec} onFocus={onFocus}
        selected={selected} onSelect={onSelect}
      />

      <div className="kpi-grid alr-kpis">
        <Kpi
          label={isolated ? `Now · ${isolated.name}` : 'Now'}
          tone={isolated ? isolated.tone : view.tone}
          value={nowValue}
          unit={reading.value != null ? UNIT_TEXT[view.unit] : null}
          sub={nowSub || null}
          delta={nowDelta}
          title={view.kind === 'anomaly' ? undefined : threshold ? `Against the ${threshold} threshold` : undefined}
        />
        <Kpi label="Firing for" tone={view.state === 'firing' ? view.tone : null} value={firingCard.value} sub={firingCard.sub} />
        <Kpi
          label="Incidents"
          value={String(incidents)}
          sub={`${prevIncidents} in ${prevText}`}
          delta={countDelta(incidents, prevIncidents, prevText)}
          title="An incident is the rule starting to fire; a warning that escalates to critical is one incident."
        />
        <Kpi
          label="Notifications"
          tone={sends.failed ? 'critical' : null}
          value={String(sends.sent)}
          sub={[
            sends.failed ? `${sends.failed} failed` : null,
            sends.muted + sends.snoozed ? `${sends.muted + sends.snoozed} held back` : null,
            `${prevSends.sent} sent in ${prevText}`,
          ].filter(Boolean).join(' · ')}
          delta={countDelta(sends.sent, prevSends.sent, prevText)}
        />
      </div>

      <section className="panel alr-events" aria-labelledby="alr-events-title">
        <div className="panel-head is-divided">
          <span id="alr-events-title">Recent events</span>
          <span className="hint">{evaluatedText}</span>
        </div>
        {events.length === 0 ? (
          <p className="alr-empty">Nothing happened to this rule in {win.label ?? 'this range'}: it did not go pending, fire or notify.</p>
        ) : (
          <ol className="alr-event-list">
            {events.map((e, i) => (
              <li key={`${e.t}-${e.kind}-${i}`} className="alr-event">
                <time className="alr-event-time mono" dateTime={new Date(e.t * 1000).toISOString()}>{clockText(e.t, nowSec)}</time>
                <span className={`alr-event-dot tone-${e.tone}`} aria-hidden="true" />
                <span className="alr-event-text">{e.text}</span>
                {e.detail && <span className="alr-event-detail">{e.detail}</span>}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  )
}
