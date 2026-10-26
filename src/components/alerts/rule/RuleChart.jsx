import { useMemo } from 'react'
import LegendLineChart from '@/components/charts/LegendLineChart'
import { shadedIntervals, expectedRangeBand, nowLine, compareLine } from '@/components/charts/chartOverlays'
import FilterSelect from '@/components/shared/FilterSelect'
import InfoTip from '@/components/shared/InfoTip'
import { displayName } from '@/utils/alerts/describe'
import { ruleChartModel, firingShades, expectedRange, PLOT_MARGIN_RIGHT } from './chartModel'
import { tierBands } from './ruleOverlays'
import StateStrip from './StateStrip'
import './alert-rule.css'

// The Compare choices (D5's "Compare [Previous period ▾]"), by their labels,
// which is what FilterSelect takes. The values are timeRange's COMPARE_OPTIONS'.
const COMPARE_CHOICES = [
  { value: 'previous', label: 'Previous period' },
  { value: 'off', label: 'Off' },
]
const COMPARE_LABEL = Object.fromEntries(COMPARE_CHOICES.map(o => [o.value, o.label]))
const COMPARE_VALUE = Object.fromEntries(COMPARE_CHOICES.map(o => [o.label, o.value]))
const COMPARE_LABELS = COMPARE_CHOICES.map(o => o.label)

/**
 * The rule's query over the window (D5, D7): the platform's LegendLineChart,
 * series in palette colours (never a status hue, R45), over both tiers' bands,
 * with the firing stretches shaded, a "now" rule, and the comparison window as
 * a dashed line in its series' colour when one series is drawn. Under it, the
 * state strip, inset to the plot so a block sits under the minutes it
 * describes. Drag across the plot to zoom, as on every chart (useTimeFocus).
 *
 * `selected` / `onSelect` isolate one series by name, shared with the
 * Instances tab, so an instance picked there (or by a notification's
 * `alert_id`) is the line drawn here. `lane` is the stretches the page drew
 * the strip from — the isolated series' own, or the rule's — so the shading
 * and the strip say the same thing.
 *
 * `preview` draws a rule that is not saved yet: the editor's backtest (D7),
 * where `lane` is where the draft WOULD have fired. It has no history to
 * compare with, so there is no Compare control; it says "would have fired"
 * where a saved rule says "was firing"; and a draft with no name yet is "this
 * rule" rather than an empty name. It never reads the rule's id.
 *
 * It brings its own styles and status tones (`.alr-tones`), so it draws the
 * same outside the rule page, as the editor's preview rail draws it.
 */
export default function RuleChart({
  view, series, compareSeries, compare, onCompare, timeline, lane = [], segments, win, nowSec, onFocus, selected, onSelect,
  preview = false,
}) {
  const compareLabel = COMPARE_LABEL[compare] ?? COMPARE_LABEL.previous
  const comparing = !preview && compare !== 'off'
  const model = useMemo(
    () => ruleChartModel({ view, series, compare: comparing ? compareSeries : [], compareLabel, selected }),
    [view, series, compareSeries, comparing, compareLabel, selected],
  )
  const range = win.label ?? 'the range'
  // Templated names read as their display name (‹host.name›); a draft that has
  // no name yet is "this rule", never an empty or undefined one.
  const name = view.name?.trim() ? displayName(view) : 'this rule'

  const overlays = useMemo(() => {
    const els = [...tierBands(view)]
    const expected = model.drawnIndex >= 0 ? expectedRange(view, series[model.drawnIndex]?.points, win.step) : []
    els.push(...expectedRangeBand({ points: expected }))
    els.push(...shadedIntervals({ intervals: firingShades(lane, nowSec), keyPrefix: 'firing' }))
    if (nowSec >= win.start && nowSec < win.end + win.step) els.push(nowLine({ x: Math.min(nowSec, win.end) * 1000 }))
    if (model.compareKey) els.push(compareLine({ dataKey: model.compareKey, color: model.compareColor }))
    return els
  }, [view, series, model, lane, win, nowSec])

  const info = preview ? (
    <InfoTip label={`About the ${view.metric ?? 'rule'} preview`}>
      The query over the range, one line per series. The shaded bands are its tiers (amber from
      the warning threshold, red from the critical one), and the shaded columns are where this
      rule would have fired, given its Fire after and Check every. The strip underneath is the
      same backtest: OK, pending, then firing. Drag across the chart to zoom.
    </InfoTip>
  ) : (
    <InfoTip label={`About the ${view.metric ?? 'rule'} chart`}>
      The rule&apos;s query over the range, one line per series. The shaded bands are its tiers
      (amber from the warning threshold, red from the critical one), and the shaded columns are
      where it was firing. A dashed line is the same series over the previous period. The strip
      underneath is the rule&apos;s state: OK, pending, then firing. Drag across the chart to zoom.
    </InfoTip>
  )

  return (
    <section className="panel alr-chart-panel alr-tones" aria-label={`${view.metric ?? 'Query'} chart`}>
      <div className="panel-head is-divided alr-chart-head">
        <div className="panel-head-left">
          <span>{preview ? 'Preview' : 'Condition'} over {range}</span>
          {selected != null && (
            <span className="alr-chart-isolated">
              Showing <span className="mono">{selected}</span>
              <button type="button" className="alr-linkbtn" onClick={() => onSelect?.(null)}>Show all</button>
            </span>
          )}
        </div>
        {!preview && (
          <div className="panel-head-right">
            <FilterSelect
              label="Compare"
              value={compareLabel}
              options={COMPARE_LABELS}
              onSelect={label => onCompare?.(COMPARE_VALUE[label] ?? 'off')}
            />
          </div>
        )}
      </div>
      <LegendLineChart
        title={view.metric ?? 'Value'}
        info={info}
        eps={model.eps}
        epSeries={model.epSeries}
        dataKey="value"
        labelKey="label"
        fmtFn={model.fmtFn}
        axisFormat={model.axisFormat}
        colorFor={model.colorFor}
        formatLabel={model.formatLabel}
        legendSort="valueDesc"
        selected={selected}
        onSelect={onSelect}
        noun="series"
        searchPlaceholder="Search series…"
        overlays={overlays}
        yTop={model.yTop}
        syncId="alr-rule"
        win={win}
        onFocus={onFocus}
      />
      {/* The strip sits in the same two columns as the chart above it, so its
          track spans exactly the plot: the y axis's gutter on the left, the
          plot's margin on the right (chartModel works both out). */}
      <div className="drill2 alr-strip-row">
        <div className="drill2-chart alr-strip-cell">
          <StateStrip
            segments={segments}
            notifications={timeline?.notifications ?? []}
            win={win}
            nowSec={nowSec}
            inset={{ left: model.axisWidth, right: PLOT_MARGIN_RIGHT }}
            label={preview ? `Where ${name} would have fired over ${range}` : `${name}'s state over ${range}`}
          />
        </div>
        <div className="drill2-legend alr-strip-spacer" aria-hidden="true" />
      </div>
    </section>
  )
}
