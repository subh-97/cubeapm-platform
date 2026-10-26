import { useMemo } from 'react'
import { AlertTriangle, Lightbulb } from 'lucide-react'
import RuleChart from '@/components/alerts/rule/RuleChart'
import { stripSegments } from '@/components/alerts/rule/rulePage'
import { formatElapsed, formatThreshold, formatValue } from '@/utils/alerts/describe'
import { renderTemplate } from '@/utils/alerts/template'

// "once", "twice", "5 times".
const times = n => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`)

// The labels every series shares, as production's "Common:" line reads them,
// and how many series there are beside it.
function commonLabels(series) {
  if (!series.length) return []
  const [first, ...rest] = series
  return Object.entries(first.labels ?? {}).filter(([k, v]) => rest.every(s => s.labels?.[k] === v))
}

/**
 * The preview (docs/alerts/DESIGN.md D6, D7): the draft's query over the
 * picked range, its tiers drawn as bands, and where it would have fired —
 * answered before saving, which production cannot do (its preview draws only
 * on "Generate Graph" and never backtests).
 *
 * It runs by itself a moment after the draft stops changing (R25), through
 * `previewRule` — the evaluator a saved rule's page reads — so saving changes
 * nothing it showed. While a new answer is worked out the old one stays,
 * dimmed, rather than the chart blinking empty on every keystroke.
 *
 * A draft that fires most of the range is offered a threshold it would rarely
 * cross; production's own demo rule fires 98.8% of its week, which is how a
 * list fills with noise nobody reads.
 */
export default function PreviewRail({ result, stale, rule, view, win, nowSec, onFocus, onUseThreshold, destinationsText }) {
  const segments = useMemo(() => (result ? stripSegments(result.lane, win, nowSec) : []), [result, win, nowSec])
  const lead = view.tiers.warning ?? view.tiers.critical
  const unitText = t => formatThreshold(view, t)

  let body
  if (!result) {
    body = <div className="ae-preview-empty" aria-busy="true">Working out where this rule would have fired…</div>
  } else if (result.error) {
    body = (
      <div className="ae-preview-empty error" role="alert">
        <AlertTriangle aria-hidden="true" />
        <span>The preview can&apos;t run this query: {result.error}</span>
      </div>
    )
  } else if (!result.series.length) {
    body = (
      <div className="ae-preview-empty">
        This query returns no series over {win.label?.toLowerCase() ?? 'the range'}. A rule on it would read
        <strong> No data</strong> until it does.
      </div>
    )
  } else {
    const firing = result.lane.find(iv => iv.state === 'firing' && iv.end == null)
    const share = Math.round(result.share * 1000) / 10
    body = (
      <>
        <RuleChart
          preview
          view={view}
          series={result.series}
          lane={result.lane}
          segments={segments}
          timeline={null}
          compare="off"
          win={win}
          nowSec={nowSec}
          onFocus={onFocus}
        />
        <p className="ae-preview-summary" aria-live="polite">
          {result.incidents === 0
            ? <>Wouldn&apos;t have fired over {win.label?.toLowerCase() ?? 'this range'}.</>
            : (
              <>
                Would have fired <strong>{times(result.incidents)}</strong> over {win.label?.toLowerCase() ?? 'this range'},
                for <strong>{formatElapsed(result.firingSec)}</strong> ({share}% of it).
              </>
            )}
          {firing && <> It would be firing now{firing.severity === 'critical' ? ', critical' : ''}.</>}
        </p>
        {result.suggestion != null && lead && result.suggestion !== lead.threshold && (
          <div className="ae-suggest">
            <Lightbulb aria-hidden="true" />
            <span>
              This would fire most of the time. {unitText(result.suggestion)} is about where the query sits 95% of the
              range.
            </span>
            <button type="button" className="hbtn" onClick={() => onUseThreshold(result.suggestion)}>
              Use {unitText(result.suggestion)}
            </button>
          </div>
        )}
        <p className="ae-preview-series">
          <span>{result.series.length} series</span>
          {commonLabels(result.series).length > 0 && (
            <span> · Common: {commonLabels(result.series).map(([k, v]) => `${k}=${v}`).join(', ')}</span>
          )}
        </p>
        <details className="ae-notify-preview">
          <summary>Notification preview</summary>
          <NotificationPreview view={view} rule={rule} series={result.series[0]} destinationsText={destinationsText} />
        </details>
      </>
    )
  }

  return (
    <aside className={`ae-rail${stale && result ? ' stale' : ''}`} aria-label="Preview" aria-busy={stale || undefined}>
      {body}
    </aside>
  )
}

// What a notification for the draft's first series would say: its title, the
// summary line, and who gets it. The environment is added to titles by the
// server when the query returns an env label, so it is noted, not invented.
function NotificationPreview({ view, rule, series, destinationsText }) {
  const value = series?.points?.findLast?.(p => p.value != null)?.value ?? null
  const ctx = { labels: series?.labels ?? {}, value }
  const title = renderTemplate(rule.name || 'This rule', ctx)
  const summary = rule.annotations?.summary ? renderTemplate(rule.annotations.summary, ctx) : null
  return (
    <div className="ae-notify-card">
      <div className="ae-notify-title">[FIRING] {title}</div>
      <div className="ae-notify-line">
        {view.metric ?? 'Value'} is {value == null ? 'unknown' : formatValue(view, value)}
        {view.tiers.critical ? ` · critical over ${formatThreshold(view, view.tiers.critical.threshold ?? view.tiers.critical.deviations)}` : ''}
      </div>
      {summary && <div className="ae-notify-line">{summary}</div>}
      <div className="ae-notify-to">To: {destinationsText || 'nobody yet'}</div>
      {'env' in (series?.labels ?? {}) && <div className="ae-notify-note">The server adds the env label to the title.</div>}
    </div>
  )
}
