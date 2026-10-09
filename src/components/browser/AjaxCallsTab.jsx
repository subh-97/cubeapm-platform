import { useMemo, useState } from 'react'
import { ajaxCallsForWindow, ajaxSummaryForWindow } from '@/data/browser'
import { previousPeriodText } from '@/utils/errorsPage'
import { fmtRpm2, fmtLoadTime, fmtRedPct, fmtRateTick, fmtLoadTimeTick, fmtPctTick } from '@/components/charts/chartDefaults'
import { browserColor } from '@/utils/chartPalette'
import LegendLineChart from '@/components/charts/LegendLineChart'
import { SortableTable, CellBar } from '@/components/shared/SortableTable'
import InfoTip from '@/components/shared/InfoTip'
import SummaryCard from './SummaryCard'
import MetricPanel from './MetricPanel'
import { filterByLabel, ajaxLabel, FIGURE_COLUMN_WIDTH } from './metricLabels'
import './browser-metrics.css'

// The Browser page's second tab: the XHR and fetch calls the app's pages make,
// endpoint by endpoint. Production's Ajax Calls tab — RPM, average response
// time and error % — with the app's calls as a whole in three cards above it.

const MENU_COLUMNS = ['RPM', 'Response Time (avg)', 'Error %']

// fmtRedPct is the service page's percentage, which has never had to print a
// missing reading; a card's chip names the window before's figure through it.
const fmtPct = v => (v == null || Number.isNaN(v) ? '' : fmtRedPct(v))

const COLUMNS = [
  {
    key: 'endpoint', label: 'Endpoint', align: 'left', mono: true, width: 360,
    info: <InfoTip label="About Endpoint">The call a page made: its HTTP method, host and port, and path, with the parts that vary collapsed into parameters (:orderId).</InfoTip>,
  },
  {
    key: 'rpm', label: 'RPM', render: r => fmtRpm2(r.rpm), width: FIGURE_COLUMN_WIDTH,
    info: <InfoTip label="About RPM">Calls per minute to this endpoint from every page of the app, averaged over the selected time range.</InfoTip>,
  },
  {
    key: 'avg', label: 'Response Time (avg)', render: r => fmtLoadTime(r.avg), width: FIGURE_COLUMN_WIDTH,
    info: <InfoTip label="About Response Time (avg)">The mean time the browser waited for this endpoint to answer, network included, so it reads above the backend service&apos;s own latency.</InfoTip>,
  },
  {
    // Drawn ×12, as the service page draws its error %: the rates sit around
    // 5%, and at their true width every bar would be a sliver.
    key: 'errPct', label: 'Error %', render: r => <CellBar fill={r.errPct * 12}>{fmtPct(r.errPct)}</CellBar>, width: FIGURE_COLUMN_WIDTH,
    info: <InfoTip label="About Error %">The share of this endpoint&apos;s calls answered with an HTTP 4xx or 5xx status.</InfoTip>,
  },
]

const byEndpoint = r => r.endpoint

/**
 * Ajax Calls: the app's calls in three cards, then every endpoint as three
 * charts or a table. Takes the same props as every Browser metric tab (see
 * PageViewsTab), and isolates an endpoint across its three charts the same way.
 *
 * The table opens worst error rate first: an endpoint that fails is what a
 * reader comes to this tab for, and on the incident's range it is the payment
 * calls that lead.
 */
export default function AjaxCallsTab({ app, win, timeRange, syncId, onFocus, view, onView }) {
  const data = useMemo(() => ajaxCallsForWindow(win, app.id), [win, app.id])
  const summary = useMemo(() => ajaxSummaryForWindow(win, app.id), [win, app.id])
  const [isolated, setIsolated] = useState(null)
  const [search, setSearch] = useState('')
  // The table search also matches the label the legends show (ajaxLabel: the
  // endpoint without ':443'), so what is typed off one view finds it in both.
  const rows = useMemo(() => filterByLabel(data.rows, search, ajaxLabel), [data.rows, search])
  const q = search.trim()

  const card = { prevText: previousPeriodText(timeRange), syncId, win, onFocus }
  const chart = {
    eps: data.rows, syncId, win, onFocus,
    // The legend and tooltip label: the endpoint without ':443' (metricLabels.js).
    // The legend row's title, and the table, keep the endpoint as recorded.
    colorFor: browserColor, formatLabel: ajaxLabel, legendSort: 'valueDesc', legendScroll: true,
    noun: 'endpoints', searchPlaceholder: 'Search endpoints…',
    selected: isolated, onSelect: setIsolated,
  }

  return (
    <>
      {summary && (
        <div className="charts-row">
          <SummaryCard
            title="Calls / min"
            info="XHR and fetch calls per minute made by the app's pages, every endpoint together, averaged over the selected time range."
            value={summary.rpm} prev={summary.prev.rpm} fmt={fmtRpm2} series={summary.series.rpm} {...card}
          />
          <SummaryCard
            title="Response time (avg)"
            info="The mean time a call waited for its answer, as the browser measured it: network included, every endpoint's calls together."
            value={summary.avg} prev={summary.prev.avg} fmt={fmtLoadTime} axisFormat={fmtLoadTimeTick} series={summary.series.avg} {...card}
          />
          <SummaryCard
            title="Error %"
            info="Calls answered with an HTTP 4xx or 5xx status, as a share of every call the app made. Weighted by calls, not an average of the endpoints' rates."
            value={summary.errPct} prev={summary.prev.errPct} fmt={fmtPct} axisFormat={fmtPctTick} series={summary.series.errPct} {...card}
          />
        </div>
      )}
      <MetricPanel
        title="Ajax Calls"
        menuColumns={MENU_COLUMNS}
        view={view}
        onView={onView}
        noun="endpoints"
        search={search}
        onSearch={setSearch}
        graph={(
          <>
            <LegendLineChart title="RPM" epSeries={data.series.rpm} dataKey="rpm" fmtFn={fmtRpm2} axisFormat={fmtRateTick} {...chart} />
            <LegendLineChart title="Response Time (avg)" epSeries={data.series.avg} dataKey="avg" fmtFn={fmtLoadTime} axisFormat={fmtLoadTimeTick} {...chart} />
            <LegendLineChart title="Error %" epSeries={data.series.errPct} dataKey="errPct" fmtFn={fmtPct} axisFormat={fmtPctTick} {...chart} />
          </>
        )}
        table={(
          <SortableTable
            className="brw-static"
            columns={COLUMNS}
            rows={rows}
            rowKey={byEndpoint}
            defaultSort="errPct"
            empty={q ? `No endpoints match "${q}"` : 'No ajax calls in this time range'}
          />
        )}
      />
    </>
  )
}
