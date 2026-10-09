import { useMemo, useState } from 'react'
import { pageViewsForWindow, pageViewsSummaryForWindow } from '@/data/browser'
import { previousPeriodText } from '@/utils/errorsPage'
import { fmtRpm2, fmtLoadTime, fmtRateTick, fmtLoadTimeTick } from '@/components/charts/chartDefaults'
import { browserColor } from '@/utils/chartPalette'
import LegendLineChart from '@/components/charts/LegendLineChart'
import { SortableTable } from '@/components/shared/SortableTable'
import InfoTip from '@/components/shared/InfoTip'
import SummaryCard from './SummaryCard'
import MetricPanel from './MetricPanel'
import { filterByLabel, FIGURE_COLUMN_WIDTH } from './metricLabels'
import './browser-metrics.css'

// The Browser page's first tab: full page loads, route by route. Production's
// Page Views tab — RPM and load time as a median and a mean — with the app as a
// whole in three cards above it, each against the window before.

const MENU_COLUMNS = ['RPM', 'Response Time (median)', 'Response Time (avg)']

// Production puts an ⓘ on every column; these say what each one measures.
const COLUMNS = [
  {
    key: 'endpoint', label: 'Route', align: 'left', mono: true, width: 360,
    info: <InfoTip label="About Route">The page&apos;s route: its URL with the parts that vary collapsed into parameters, so every product page counts under /product/:sku.</InfoTip>,
  },
  {
    key: 'rpm', label: 'RPM', render: r => fmtRpm2(r.rpm), width: FIGURE_COLUMN_WIDTH,
    info: <InfoTip label="About RPM">Page views per minute: full page loads of this route, averaged over the selected time range.</InfoTip>,
  },
  {
    key: 'median', label: 'Response Time (median)', render: r => fmtLoadTime(r.median), width: FIGURE_COLUMN_WIDTH,
    info: <InfoTip label="About Response Time (median)">How long this route&apos;s pages took to load: half of its page loads finished faster than this.</InfoTip>,
  },
  {
    key: 'avg', label: 'Response Time (avg)', render: r => fmtLoadTime(r.avg), width: FIGURE_COLUMN_WIDTH,
    info: <InfoTip label="About Response Time (avg)">The mean load time of this route&apos;s page loads. A few very slow loads pull it above the median.</InfoTip>,
  },
]

const byEndpoint = r => r.endpoint

/**
 * Page Views: the app's page loads in three cards, then every route as three
 * charts or a table.
 *
 * Props are the Browser page's, as every metric tab takes them: `app` (a row of
 * browserAppsForWindow), `win` and `timeRange` (the page's range, resolved and
 * as picked), `syncId` and `onFocus` (every chart on the tab shares a crosshair,
 * and a drag on any of them sets the range), and `view`/`onView` (Graph or
 * Table, the URL's `view=`).
 *
 * Isolating a route in one chart's legend isolates it in all three: the choice
 * is held here, by route, and handed to each. The page keys the tab by app, so
 * it starts clear on another app.
 */
export default function PageViewsTab({ app, win, timeRange, syncId, onFocus, view, onView }) {
  const data = useMemo(() => pageViewsForWindow(win, app.id), [win, app.id])
  const summary = useMemo(() => pageViewsSummaryForWindow(win, app.id), [win, app.id])
  const [isolated, setIsolated] = useState(null)
  const [search, setSearch] = useState('')
  const rows = useMemo(() => filterByLabel(data.rows, search), [data.rows, search])
  const q = search.trim()

  const card = { prevText: previousPeriodText(timeRange), syncId, win, onFocus }
  // Every chart gets the rows in the data's own order, the order their series
  // are aligned to; each chart sorts its own legend by its own figure.
  const chart = {
    eps: data.rows, syncId, win, onFocus,
    colorFor: browserColor, legendSort: 'valueDesc', legendScroll: true,
    noun: 'routes', searchPlaceholder: 'Search routes…',
    selected: isolated, onSelect: setIsolated,
  }

  return (
    <>
      {summary && (
        <div className="charts-row">
          <SummaryCard
            title="Page views / min"
            info="Full page loads per minute across every route of the app, averaged over the selected time range."
            value={summary.rpm} prev={summary.prev.rpm} fmt={fmtRpm2} series={summary.series.rpm} {...card}
          />
          <SummaryCard
            title="Load time (median)"
            info="Half of the app's page loads finished faster than this, every route's loads pooled together."
            value={summary.median} prev={summary.prev.median} fmt={fmtLoadTime} axisFormat={fmtLoadTimeTick} series={summary.series.median} {...card}
          />
          <SummaryCard
            title="Load time (avg)"
            info="The mean load time over every page load in the range. Slow loads pull it above the median."
            value={summary.avg} prev={summary.prev.avg} fmt={fmtLoadTime} axisFormat={fmtLoadTimeTick} series={summary.series.avg} {...card}
          />
        </div>
      )}
      <MetricPanel
        title="Page Views"
        menuColumns={MENU_COLUMNS}
        view={view}
        onView={onView}
        noun="routes"
        search={search}
        onSearch={setSearch}
        graph={(
          <>
            <LegendLineChart title="RPM" epSeries={data.series.rpm} dataKey="rpm" fmtFn={fmtRpm2} axisFormat={fmtRateTick} {...chart} />
            <LegendLineChart title="Response Time (median)" epSeries={data.series.median} dataKey="median" fmtFn={fmtLoadTime} axisFormat={fmtLoadTimeTick} {...chart} />
            <LegendLineChart title="Response Time (avg)" epSeries={data.series.avg} dataKey="avg" fmtFn={fmtLoadTime} axisFormat={fmtLoadTimeTick} {...chart} />
          </>
        )}
        table={(
          <SortableTable
            className="brw-static"
            columns={COLUMNS}
            rows={rows}
            rowKey={byEndpoint}
            defaultSort="avg"
            empty={q ? `No routes match "${q}"` : 'No page views in this time range'}
          />
        )}
      />
    </>
  )
}
