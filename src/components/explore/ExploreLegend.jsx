// The chart's right-hand legend: which series are in the result, what each is
// worth under the current Legend value, and which of them the chart draws.
//
// It is a list of buttons rather than a list of swatches because it is the
// only control for what the chart shows. Click isolates a series, clicking the
// isolated one shows everything again, Ctrl/⌘-click toggles one on its own —
// the model for all three is `legendClick` in utils/explore/series.js, so the
// rules live next to the limiting and ordering they interact with.
//
// The search box filters the legend AND the lines. That is one search, not
// two: a legend listing series the chart is not drawing would be lying about
// the picture beside it.

import { clsx } from 'clsx'
import { isSelectMode, legendClick, SHOW_ALL } from '@/utils/explore/series'
import { formatValue } from '@/utils/explore/format'
import './explore-results.css'

const CLICK_HELP = 'Click to show only this series. Click it again to show all. Ctrl or ⌘ click to toggle it on its own.'

/**
 * @param {Object} props
 * @param {import('@/utils/explore/series').ChartModel} props.model
 * @param {'number'|'time'} [props.unit]
 * @param {string} props.search                      legend search text
 * @param {(next:string) => void} props.onSearchChange
 * @param {{defaultShow:boolean, inverts:string[]}} props.selection
 * @param {(next:object) => void} props.onSelectionChange
 * @param {() => void} [props.onShowAll]             lifts the 20-series limit
 * @param {string|null} [props.hoverKey]
 * @param {(key:string|null) => void} [props.onHoverKey]
 * @param {boolean} [props.comparing]                show the delta chips
 * @param {string} [props.compareLabel]              e.g. "vs previous period"
 */
export default function ExploreLegend({
  model, unit = 'number', search, onSearchChange, selection = SHOW_ALL, onSelectionChange,
  onShowAll, hoverKey = null, onHoverKey, comparing = false, compareLabel = '',
}) {
  const selecting = isSelectMode(selection) || selection.inverts.length > 0

  return (
    <div className="ex-legend">
      <div className="ex-legend-head">
        <div className="svc-search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" />
          </svg>
          <input
            type="text"
            value={search}
            onChange={e => onSearchChange(e.target.value)}
            placeholder="Filter series"
            aria-label="Filter series shown in the chart and legend"
            spellCheck={false}
            autoComplete="off"
          />
          {search && (
            <button
              type="button"
              className="svc-search-clear"
              onClick={() => onSearchChange('')}
              title="Clear the series filter"
              aria-label="Clear the series filter"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
            </button>
          )}
        </div>

        {/* What every series in the result has in common, said once, so each
            name below carries only what makes it different (ARCH D8). */}
        {model.showCommon && model.commonLabels && (
          <div className="ex-legend-common"><b>Common:</b> {model.commonLabels}</div>
        )}
      </div>

      <div className="ex-legend-rows">
        {model.datasets.map(d => (
          <button
            key={d.id}
            type="button"
            className={clsx('ex-legend-row', { 'is-off': d.hidden, 'is-others': d.isOthers })}
            title={d.isOthers
              ? `${d.count} further series, summed so the stack still totals correctly. ${CLICK_HELP}`
              : `${d.label}\n${CLICK_HELP}`}
            aria-pressed={!d.hidden}
            onClick={e => onSelectionChange(legendClick(selection, d.label, e))}
            onMouseEnter={() => onHoverKey?.(d.dataKey)}
            onMouseLeave={() => onHoverKey?.(null)}
            onFocus={() => onHoverKey?.(d.dataKey)}
            onBlur={() => onHoverKey?.(null)}
            data-hovered={hoverKey === d.dataKey || undefined}
          >
            <span
              className="ex-legend-swatch"
              style={{ background: d.colour }}
              aria-hidden="true"
            />
            <span className="ex-legend-name">{d.label}</span>
            <span className="ex-legend-right">
              <span className="ex-legend-val">{formatValue(d.reduceValue, unit)}</span>
              {comparing && d.delta && (
                <span
                  className="ex-delta"
                  data-dir={d.delta.dir}
                  title={compareLabel ? `${d.delta.text} ${compareLabel}` : d.delta.text}
                >
                  {d.delta.text}
                </span>
              )}
            </span>
          </button>
        ))}
      </div>

      <div className="ex-legend-foot">
        {model.limited ? (
          <>
            <span>Showing {model.shownCount} of {model.matchCount}</span>
            <button type="button" className="ex-link" onClick={() => onShowAll?.()} title="List every series, however many there are">
              Show all
            </button>
          </>
        ) : (
          <span>
            {model.matchCount} series
            {model.matchCount !== model.total && ` of ${model.total}`}
          </span>
        )}
        {selecting && (
          <button
            type="button"
            className="ex-link"
            onClick={() => onSelectionChange(SHOW_ALL)}
            title="Draw every series again"
          >
            Reset selection
          </button>
        )}
      </div>
    </div>
  )
}
