import { useCallback, useMemo, useState } from 'react'
import { webVitalsForWindow, webVitalsSummaryForWindow } from '@/data/browser'
import { previousPeriodText } from '@/utils/errorsPage'
import { WEB_VITAL_THRESHOLDS } from '@/utils/status'
import { fmtLoadTime, fmtCls, fmtLoadTimeTick, fmtPlainTick, maxOf } from '@/components/charts/chartDefaults'
import { browserColor } from '@/utils/chartPalette'
import { thresholdBands, bandAxisTop } from '@/components/charts/thresholdBands'
import LegendLineChart from '@/components/charts/LegendLineChart'
import { SortableTable } from '@/components/shared/SortableTable'
import InfoTip from '@/components/shared/InfoTip'
import SummaryCard from './SummaryCard'
import MetricPanel from './MetricPanel'
import {
  VITALS, VITAL_SHORT, VITAL_TITLES, FIGURE_COLUMN_WIDTH, filterByLabel, pagePath, vitalFigure, vitalRating,
  vitalThresholdFigure, vitalThresholdText, vitalsBySeverity, worstVitalTitle,
} from './metricLabels'
import './browser-metrics.css'

// The Browser page's third tab: Core Web Vitals, page by page. Production's Web
// Vitals tab — LCP, INP and CLS, each drawn over its good / needs-improvement /
// poor bands — with the app's own three as the cards above.
//
// Severity shows in three places only, each read off the same thresholds
// (status.js WEB_VITAL_THRESHOLDS): a card's rating chip, the bands behind
// every chart, and the one dot before a page's URL in the table. The figures
// themselves stay plain text, as every table on the service page keeps them.

// What each vital measures: production's own words for LCP and INP (its CLS
// card has none, so that one is written to match).
const VITAL_INFO = {
  lcp: 'LCP measures how long it takes a page to load, from when it starts to when it renders the largest text block or image.',
  inp: 'INP is a measurement of activity after the initial page load observing the latency of all interactions (click, tap, or keyboard) a user has made with the page.',
  cls: 'CLS measures how much a page\'s content moves unexpectedly while it loads and while it is used: how much of the screen shifts, and how far.',
}

const sentence = s => s.charAt(0).toUpperCase() + s.slice(1) + '.'

// A chart's tooltip and legend print a vital the way the page does
// everywhere: LCP and INP as load times, CLS to two decimals. Its axis prints
// round steps in one unit ('0 s, 2 s, 4 s'; '0, 0.1, 0.2').
const VITAL_FMT = { lcp: fmtLoadTime, inp: fmtLoadTime, cls: fmtCls }
const VITAL_TICK = { lcp: fmtLoadTimeTick, inp: fmtLoadTimeTick, cls: fmtPlainTick }

// The bands are the same for every app and every range, so they are built
// once. The full-size charts label their two threshold rules ('2.5 s');
// a summary card's chart is too small to carry the labels, and its chip's
// tooltip names the thresholds instead.
const bandsFor = (m, withLabels) => thresholdBands({
  good: WEB_VITAL_THRESHOLDS[m].good,
  poor: WEB_VITAL_THRESHOLDS[m].poor,
  keyPrefix: `${withLabels ? 'chart' : 'card'}-${m}`,
  fmt: withLabels ? v => vitalThresholdFigure(m, v) : undefined,
})
const CARD_BANDS = Object.fromEntries(VITALS.map(m => [m, bandsFor(m, false)]))
const CHART_BANDS = Object.fromEntries(VITALS.map(m => [m, bandsFor(m, true)]))
// The least a chart's axis may top out at, so all three bands always show.
// The charts lift it further themselves when a page's line runs higher.
const CHART_TOP = Object.fromEntries(VITALS.map(m => [m, bandAxisTop(0, WEB_VITAL_THRESHOLDS[m].poor)]))

const MENU_COLUMNS = VITALS.map(m => VITAL_SHORT[m])

// The Endpoint cell: the page's worst rating as one dot (its title says which
// vitals earned it), then the URL in full, cut short with an ellipsis if it
// must be and given whole in its title.
function VitalEndpoint({ row }) {
  const why = worstVitalTitle(row)
  return (
    <span className="brw-vital-ep">
      <span className={`status-dot ${row.status?.worst ?? 'neutral'}`} role="img" aria-label={why} title={why} />
      <span className="cell-clip" title={row.endpoint}>{row.endpoint}</span>
    </span>
  )
}

const COLUMNS = [
  {
    key: 'endpoint', label: 'Endpoint', align: 'left', mono: true, width: 440,
    render: r => <VitalEndpoint row={r} />,
    info: <InfoTip label="About Endpoint">The page the vitals were measured on, as its full URL. The dot is the page&apos;s worst rating across LCP, INP and CLS.</InfoTip>,
  },
  ...VITALS.map(m => ({
    key: m, label: VITAL_SHORT[m], render: r => vitalFigure(m, r[m]), width: FIGURE_COLUMN_WIDTH,
    info: <InfoTip label={`About ${VITAL_SHORT[m]}`}>{`${VITAL_INFO[m]} ${sentence(vitalThresholdText(m))}`}</InfoTip>,
  })),
]

const byEndpoint = r => r.endpoint

/**
 * Web Vitals: the app's LCP, INP and CLS in three rated cards, then every page
 * as three banded charts or a table. Takes the same props as every Browser
 * metric tab (see PageViewsTab), and isolates a page across its three charts
 * the same way.
 *
 * The table opens worst rating first, then the slowest LCP (vitalsBySeverity),
 * and has no default column: a third click on a header goes back to that order
 * rather than to the data's.
 *
 * Figures are page-view means, as production's are, so nothing here calls them
 * a p75.
 */
export default function WebVitalsTab({ app, win, timeRange, syncId, onFocus, view, onView }) {
  const data = useMemo(() => webVitalsForWindow(win, app.id), [win, app.id])
  const summary = useMemo(() => webVitalsSummaryForWindow(win, app.id), [win, app.id])
  const [isolated, setIsolated] = useState(null)
  const [search, setSearch] = useState('')

  // A legend shows a page by its path: every page of the app shares the
  // origin, which would fill the row before the part that differs. The legend
  // row's title and the table keep the full URL.
  const shortLabel = useCallback((full, row) => row?.route ?? pagePath(full, app.origin), [app.origin])
  const ordered = useMemo(() => vitalsBySeverity(data.rows), [data.rows])
  const rows = useMemo(() => filterByLabel(ordered, search, shortLabel), [ordered, search, shortLabel])
  const q = search.trim()

  const prevText = previousPeriodText(timeRange)
  const chart = {
    eps: data.rows, syncId, win, onFocus,
    colorFor: browserColor, formatLabel: shortLabel, legendSort: 'valueDesc', legendScroll: true,
    noun: 'pages', searchPlaceholder: 'Search pages…',
    selected: isolated, onSelect: setIsolated,
  }

  return (
    <>
      {summary && (
        <div className="charts-row">
          {VITALS.map(m => (
            <SummaryCard
              key={m}
              title={VITAL_TITLES[m]}
              info={`${VITAL_INFO[m]} ${sentence(vitalThresholdText(m))} Averaged over every page view in the range.`}
              value={summary[m]}
              prev={summary.prev[m]}
              fmt={v => vitalFigure(m, v)}
              formatVal={VITAL_FMT[m]}
              axisFormat={VITAL_TICK[m]}
              prevText={prevText}
              series={summary.series[m]}
              rating={vitalRating(m, summary.status[m])}
              overlays={CARD_BANDS[m]}
              yTop={bandAxisTop(maxOf(summary.series[m], 'value'), WEB_VITAL_THRESHOLDS[m].poor)}
              syncId={syncId}
              win={win}
              onFocus={onFocus}
            />
          ))}
        </div>
      )}
      <MetricPanel
        title="Web Vitals"
        menuColumns={MENU_COLUMNS}
        view={view}
        onView={onView}
        noun="pages"
        search={search}
        onSearch={setSearch}
        graph={(
          <>
            {VITALS.map(m => (
              <LegendLineChart
                key={m}
                title={VITAL_SHORT[m]}
                info={<InfoTip label={`About the ${VITAL_SHORT[m]} chart`}>{`${VITAL_TITLES[m]} per page. The shaded bands are its ratings: ${vitalThresholdText(m)}.`}</InfoTip>}
                epSeries={data.series[m]}
                dataKey={m}
                fmtFn={VITAL_FMT[m]}
                axisFormat={VITAL_TICK[m]}
                overlays={CHART_BANDS[m]}
                yTop={CHART_TOP[m]}
                {...chart}
              />
            ))}
          </>
        )}
        table={(
          <SortableTable
            className="brw-static"
            columns={COLUMNS}
            rows={rows}
            rowKey={byEndpoint}
            defaultSort={null}
            empty={q ? `No pages match "${q}"` : 'No page views in this time range'}
          />
        )}
      />
    </>
  )
}
