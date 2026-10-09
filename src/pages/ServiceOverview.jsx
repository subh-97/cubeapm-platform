import { useState, useMemo, useRef, useEffect, useCallback } from 'react'
import { AreaChart, Area, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import {
  servicesForWindow, seriesForWindow, versionBandsForWindow, latencyDrilldownForWindow,
  latencyDrilldownSeriesForWindow, latencyDrilldownTotalForWindow, redEndpointsForWindow, redEndpointSeriesForWindow,
  infraCorrelationForWindow, infraSeriesForWindow, INFRA_AVG_OF_P90, slowRequestsForWindow, errorRequestsForWindow,
  externalEndpointsForWindow, dbEndpointsForWindow, externalEndpointSeriesForWindow, dbEndpointSeriesForWindow, runtimeMetricsForWindow,
  externalEndpointCallers, dbEndpointCallers, slowQueries, tracesList, traceDetail,
  FILTER_OPTS,
} from '@/data/services'
import { runtimeRoster } from '@/data/runtimeHosts'
import RuntimeRail, { RuntimeScope } from '@/components/runtime/RuntimeRail'
import { resolveWindow } from '@/data/timeWindow'
import { statusForLatency, statusForErrorRate } from '@/utils/status'
import { SERVICE_TABS } from '@/utils/route'
import PageBar from '@/components/layout/PageBar'
import ServicePicker from '@/components/ServicePicker'
import CardMenu, { CardActionContext } from '@/components/CardMenu'
import { explorePayloadForCard } from '@/utils/explore/editorState'
import InfoTip from '@/components/shared/InfoTip'
import SearchGlyph from '@/components/shared/SearchGlyph'
import FilterSelect from '@/components/shared/FilterSelect'
import ViewToggle from '@/components/shared/ViewToggle'
import TitleDropdown from '@/components/shared/TitleDropdown'
import { SortableTh, CellBar } from '@/components/shared/SortableTable'
import { useSortedRows } from '@/hooks/useSortedRows'
import { useScrollReveal, revealClass } from '@/hooks/useScrollReveal'
import RequestTraceSplit from '@/components/trace/RequestTraceSplit'
import ErrorGroupsPanel from '@/components/errors/ErrorGroupsPanel'
import { errorGroupsForWindow, tracesFiltersFor } from '@/data/errors'
import { previousPeriodText } from '@/utils/errorsPage'
import { Gauge, Crosshair, ChartLine, Globe, Database, TriangleAlert, Cpu, ArrowUpRight } from 'lucide-react'
import { GRID_PROPS, NO_ANIM, AREA_PROPS, LINE_PROPS, valueAxisProps, maxOf, niceAxis, formatDecimals, fmtCompact, fmtBytes, fmtCount, fmtRedMs, fmtRedRpm, fmtRedPct } from '@/components/charts/chartDefaults'
import { buildTimeAxis, withX } from '@/components/charts/timeAxis'
import { useMeasuredWidth, useSeriesHover } from '@/components/charts/useTimeFocus'
import ChartTooltip from '@/components/charts/ChartTooltip'
import { TimeChart, SvcTooltip, rowInstant } from '@/components/charts/TimeChart'
import LegendLineChart from '@/components/charts/LegendLineChart'
import MiniChart from '@/components/charts/MiniChart'
// For .errp-delta, the Errors page's count chip, so the Errors tab's counts
// read the same as the page its "Open in Errors" button lands on. Imported
// here rather than relied on through ErrorsView; every rule in it is
// errp-scoped, so nothing else on this page changes.
import '@/components/errors/errors.css'
import { useSeriesBudget } from '@/components/charts/useSeriesBudget'
import SeriesBudgetFooter from '@/components/charts/SeriesBudgetFooter'
import { fixesAxis, TOOLTIP_ROWS } from '@/components/charts/seriesBudget'
import { epColor } from '@/utils/chartPalette'
import { KpiCardsSkeleton, LatencyDrilldownSkeleton, TrendChartsSkeleton } from '@/pages/ServiceOverviewSkeleton'

// Which tabs there are, and their order, is SERVICE_TABS in utils/route — the
// list a ?tab= in the URL is checked against — so the strip cannot offer a tab
// the URL cannot name, or the other way round. Only the labels live here.
const VIEW_META = {
  overview: { label: 'Overview', Icon: Gauge },
  detail: { label: 'Detail', Icon: Crosshair },
  red: { label: 'RED', Icon: ChartLine },
  external: { label: 'External', Icon: Globe },
  db: { label: 'DB', Icon: Database },
  errors: { label: 'Errors', Icon: TriangleAlert },
  runtime: { label: 'Runtime', Icon: Cpu },
}
const SERVICE_VIEWS = SERVICE_TABS.map(id => ({ id, ...VIEW_META[id] }))

// Floating mini-chart that renders beside a hovered cell. The parent attaches
// `onMouseEnter`/`onMouseLeave` on the cells and keeps the hovered cell in
// state; this component places itself relative to the anchor rect.
//
// `series` is sampled over the page's window and drawn on that window's time
// axis, so the chart covers the same range as the figure it was opened from.
// It does not take part in drag-to-focus: it closes as soon as the pointer
// leaves it, which is no place to start a drag.
function HoverChartPopover({ anchor, title, series, win, color = '#3B82F6', formatVal = v => Math.round(v), unit = '', onEnter, onLeave }) {
  // Before the early return, not after it: a hook that runs on only some
  // renders shifts every later hook in this component by one the next time
  // round. The parent only mounts this when a cell is hovered, so `anchor` is
  // in practice always set — but the ordering has to hold regardless.
  const [wrapRef, width] = useMeasuredWidth()
  const data = useMemo(() => withX(series ?? [], win), [series, win])
  const axis = useMemo(() => buildTimeAxis(win, { width }), [win, width])
  if (!anchor) return null
  const rect = anchor.getBoundingClientRect()
  const W = 320, H = 180
  const spaceBelow = window.innerHeight - rect.bottom
  const top = spaceBelow > H + 12 ? rect.bottom + 8 : rect.top - H - 8
  const left = Math.min(Math.max(8, rect.left + rect.width / 2 - W / 2), window.innerWidth - W - 8)
  return (
    <div
      className="hover-chart-pop"
      style={{ position: 'fixed', top, left, width: W, zIndex: 600 }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <div className="hover-chart-pop-title">{title}</div>
      <div ref={wrapRef} style={{ width: '100%', height: H - 32 }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 6, right: 6, left: 0, bottom: 0 }}>
            <CartesianGrid {...GRID_PROPS} />
            <XAxis {...axis.props} />
            <YAxis {...valueAxisProps({ maxValue: maxOf(data, 'value'), format: v => `${formatVal(v)}${unit}` })} />
            <Tooltip content={<SvcTooltip color={color} unit={unit} formatVal={formatVal} nowMs={win.end * 1000} />} {...NO_ANIM} />
            <Area {...AREA_PROPS} dataKey="value" stroke={color} fill={color} strokeWidth={1.4}
              dot={false} activeDot={{ r: 3 }} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

function DrilldownTooltip({ active, payload, nowMs, hoverKey, colors, suppressed }) {
  if (!active || !payload?.length) return null
  // No footer: the Total series is already a row here, and a footer summing the
  // payload counted it a second time on top of the layers it is the sum of.
  const items = [...payload].reverse().map(p => ({
    key: p.dataKey,
    label: p.dataKey,
    value: `${Math.round(p.value)} ms`,
    color: colors?.[p.dataKey] ?? p.fill,
  }))
  return (
    <ChartTooltip
      tMs={rowInstant(payload[0])}
      nowMs={nowMs ?? Date.now()}
      items={items}
      hoverKey={hoverKey}
      suppressed={suppressed}
    />
  )
}

function KpiCards({ svc }) {
  const latS = statusForLatency(svc.latencyP90)
  const errS = statusForErrorRate(svc.errorRatePct)

  const cards = [
    { lbl: 'Requests / min', val: svc.rpm.toFixed(2), unit: '', status: 'healthy', threshold: 'Baseline ~452 rpm' },
    { lbl: 'p90 Latency', val: svc.latencyP90, unit: 'ms', status: latS, threshold: 'Threshold 300ms' },
    { lbl: 'Avg Latency', val: svc.latencyAvg, unit: 'ms', status: latS, threshold: 'Colored via p90 threshold - no independent avg threshold in this model' },
    { lbl: 'Error %', val: svc.errorRatePct, unit: '%', status: errS, threshold: 'Threshold 3%' },
  ]

  return (
    <div className="kpi-grid">
      {cards.map(c => (
        <div key={c.lbl} className={`kpi-card ${c.status}`}>
          <div className="kpi-card-head">
            <span className="lbl">{c.lbl}</span>
            <CardMenu kind="metric" title={c.lbl} />
          </div>
          <div className="val">{c.val}<span className="unit">{c.unit}</span></div>
        </div>
      ))}
    </div>
  )
}

// Figures for an endpoint the RED list does not carry. Derived from the name so
// the same endpoint always reads the same, rather than changing on every render.
function syntheticEndpoint(name) {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0
  const n = Math.abs(h)
  const rpm = 12 + (n % 140)
  const p90 = 60 + (n % 420)
  return {
    endpoint: name,
    totalReq: `${((rpm * 60) / 1000).toFixed(1)}K`,
    timeConsumedPct: 1 + (n % 20),
    rpm,
    p90,
    avg: Math.round(p90 * 0.55),
    errPct: Number(((n % 70) / 10).toFixed(1)),
  }
}

// The endpoint view: the same four numbers as the service, narrowed to one
// route. It exists because a log record knows its endpoint, and sending that
// link to the service overview would drop the one thing the record told us.
function EndpointTab({ data, endpoint, onOpenUpstream, onOpenTrace, syncId, win, onFocus }) {
  // An endpoint arriving from a log record will often not be in the RED list -
  // that list is what the service page happens to chart, not everything the
  // service serves. Showing the picker's first row instead would quietly answer
  // a different question from the one the link asked, so an unknown endpoint is
  // added to the list and given figures of its own.
  const eps = useMemo(() => (
    endpoint && !data.red.some(e => e.endpoint === endpoint)
      ? [...data.red, syntheticEndpoint(endpoint)]
      : data.red
  ), [data.red, endpoint])
  const ep = eps.find(e => e.endpoint === endpoint) ?? eps[0]
  const latS = statusForLatency(ep.p90)
  const errS = statusForErrorRate(ep.errPct)

  const cards = [
    { lbl: 'Requests / min', val: ep.rpm.toFixed(2), unit: '', status: 'healthy', threshold: `${ep.totalReq} requests in range` },
    { lbl: 'p90 Latency', val: ep.p90, unit: 'ms', status: latS, threshold: 'Threshold 300ms' },
    { lbl: 'Avg Latency', val: ep.avg, unit: 'ms', status: latS, threshold: 'Colored via the p90 threshold' },
    { lbl: 'Error %', val: ep.errPct, unit: '%', status: errS, threshold: 'Threshold 3%' },
  ]

  // What one request of this endpoint sets off downstream. The playground calls
  // this "hits per request", and it is the reason to open an endpoint at all.
  const hits = data.db.slice(0, 3).map(d => ({ name: d.endpoint ?? d.query ?? 'call', count: 1 }))

  return (
    <>
      <div className="kpi-grid">
        {cards.map(c => (
          <div key={c.lbl} className={`kpi-card ${c.status}`}>
            <div className="kpi-card-head">
              <span className="lbl">{c.lbl}</span>
              <CardMenu kind="metric" title={c.lbl} />
            </div>
            <div className="val">{c.val}<span className="unit">{c.unit}</span></div>
          </div>
        ))}
      </div>

      <LatencyDrilldown
        layers={data.drilldown}
        layerSeries={data.drilldownSeries}
        callerTotal={data.drilldownTotal}
        onOpenUpstream={onOpenUpstream}
        p90Series={data.series.latencyP90}
        p90EndpointLabel={ep.endpoint}
        syncId={syncId}
        win={win}
        onFocus={onFocus}
      />

      <TrendCharts bands={data.bands} syncId={syncId} win={win} onFocus={onFocus} aside={(
        <div className="panel">
          <div className="panel-head">
            <div className="panel-head-left">Hits per request</div>
            <CardMenu kind="list" title="Hits per request" />
          </div>
          <table className="ep-hits">
            <tbody>
              {hits.map(h => (
                <tr key={h.name}>
                  <td className="mono">{h.name}</td>
                  <td className="num">{h.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )} />
      <RequestTraceSplit onOpenTrace={onOpenTrace} data={data.slow} />
      <RequestTraceSplit onOpenTrace={onOpenTrace} data={data.errors} title="Requests with Errors" initialSort="none" />
      <InfraCorrelation hosts={data.infra} win={win} />
    </>
  )
}

function LatencyDrilldown({ layers, layerSeries, callerTotal, onOpenUpstream, p90Series, p90EndpointLabel, syncId, win, onFocus }) {
  // Two different totals, on purpose. `consumed` is what the layers add up to —
  // the time spent across every call, which is the top of the stacked chart.
  // `callerTotal` is the latency the caller actually waited, measured on its own:
  // calls that overlap count once there and twice in `consumed`, which is why
  // the Total line runs below the top of the stack.
  const consumed = layers.reduce((a, b) => a + b.ms, 0)
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState(null)
  // The Detail tab wants the same chart to also render a single p90 line for the
  // open endpoint. The toggle is opt-in via `p90Series`, so Overview's call site
  // keeps the old single-title header unchanged.
  const [view, setView] = useState('drilldown')
  const hasP90Toggle = !!p90Series
  const isP90 = hasP90Toggle && view === 'p90'

  const q = search.trim().toLowerCase()
  const shown = q ? layers.filter(l => l.label.toLowerCase().includes(q)) : layers

  const chartLayers = selected && shown.some(l => l.label === selected)
    ? shown.filter(l => l.label === selected)
    : shown

  // The composite row keeps each source point's `t`, which `withX` turns into
  // the instant the row plots at. Without it the stack would have a time axis
  // and nothing to hang on it.
  const data = useMemo(() => withX((layerSeries[0]?.series ?? []).map((pt, i) => {
    const entry = { t: pt.t, label: pt.label, exactTime: pt.exactTime }
    layerSeries.forEach((layer) => {
      entry[layer.label] = layer.series[i]?.value ?? 0
    })
    entry.Total = callerTotal?.series[i]?.value ?? null
    return entry
  }), win), [layerSeries, callerTotal, win])

  // Hover-dim: when the pointer is on one legend row, the other rows and the
  // areas they draw fade out, so the one in focus reads as the only series.
  const [hoverKey, setHoverKey] = useState(null)
  const dimOpacityFor = (key) => (hoverKey == null || hoverKey === key ? 1 : 0.22)

  // The swatch colour per stacked key. The Total line draws with no fill, so its
  // tag has to come from here rather than off the payload.
  const drillColors = useMemo(() => ({
    ...Object.fromEntries(chartLayers.map(l => [l.label, l.color])),
    Total: 'var(--text-primary)',
  }), [chartLayers])

  const p90Data = useMemo(() => p90Series ? withX(p90Series, win) : null, [p90Series, win])

  const info = (
    <InfoTip label="About Latency Drilldown">
      Break-down of average latency. Total latency can be less than the sum of individual
      latencies for several reasons - parallel execution, async execution and so on. Total
      latency reflects latency from the caller&apos;s perspective, while the sum of individual
      latencies reflects the amount of resources consumed on the server.
    </InfoTip>
  )

  return (
    <div className="panel">
      <div className="panel-head is-divided">
        <div className="panel-head-left">
          {hasP90Toggle ? (
            <div className="seg-toggle" role="tablist" aria-label="Latency view">
              <div
                role="tab"
                aria-selected={!isP90}
                className={`seg${!isP90 ? ' active' : ''}`}
                onClick={() => setView('drilldown')}
              >
                Latency Drilldown
                <span className="seg-info" onClick={e => e.stopPropagation()}>{info}</span>
              </div>
              <div
                role="tab"
                aria-selected={isP90}
                className={`seg${isP90 ? ' active' : ''}`}
                onClick={() => setView('p90')}
              >
                p90 Latency
              </div>
            </div>
          ) : (
            <>
              Latency Drilldown
              {info}
            </>
          )}
        </div>
        {isP90
          ? <CardMenu kind="chart" title="p90 Latency" />
          : <CardMenu kind="chart" title="Latency Drilldown" total="Total" />}
      </div>
      {isP90 ? (
        <div className="drill2 drill2-single">
          <div className="drill2-chart" style={{ width: '100%' }}>
            <TimeChart win={win} onFocus={onFocus} height={260}>
              {(axis, focus) => (
                <LineChart data={p90Data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} syncId={syncId} syncMethod="value" {...focus.chartProps}>
                  <CartesianGrid {...GRID_PROPS} />
                  <XAxis {...axis.props} />
                  <YAxis {...valueAxisProps({ format: v => `${Math.round(v)} ms`, maxValue: maxOf(p90Data, 'value') })} />
                  <Tooltip content={p => <SvcTooltip {...p} color="#F472B6" unit=" ms" formatVal={v => Math.round(v)} nowMs={win.end * 1000} suppressed={!focus.hovered} />} {...NO_ANIM} />
                  <Line {...LINE_PROPS} dataKey="value" stroke="#F472B6" strokeWidth={1.6} dot={false} activeDot={{ r: 3, strokeWidth: 0 }} />
                  {focus.overlay}
                </LineChart>
              )}
            </TimeChart>
            {p90EndpointLabel && (
              <div className="drill2-single-legend">
                <span className="drill2-swatch" style={{ background: '#F472B6' }} />
                <span className="mono">{p90EndpointLabel}</span>
              </div>
            )}
          </div>
        </div>
      ) : (
      <div className="drill2">
        <div className="drill2-chart">
          <TimeChart win={win} onFocus={onFocus} height={260}>
            {(axis, focus) => (
              <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} syncId={syncId} syncMethod="value" {...focus.chartProps}>
                <CartesianGrid {...GRID_PROPS} />
                <XAxis {...axis.props} />
                <YAxis {...valueAxisProps({ maxValue: selected ? maxOf(data, [selected]) : consumed })} />
                <Tooltip content={p => <DrilldownTooltip {...p} nowMs={win.end * 1000} hoverKey={hoverKey} colors={drillColors} suppressed={!focus.hovered} />} {...NO_ANIM} />
                {chartLayers.map(layer => (
                  <Area key={layer.label} {...AREA_PROPS} dataKey={layer.label} stackId="stack"
                    stroke={layer.color} fill={layer.color}
                    fillOpacity={0.18 * dimOpacityFor(layer.label)}
                    strokeOpacity={dimOpacityFor(layer.label)}
                    strokeWidth={1.5}
                    dot={false} activeDot={{ r: 3, strokeWidth: 0 }}
                    onMouseEnter={() => setHoverKey(layer.label)}
                    onMouseLeave={() => setHoverKey(null)} />
                ))}
                {/* Not stacked: Total plots at the caller's own latency, inside
                    the stack rather than on its top edge. Dashed and in the text
                    colour so it reads as a measure laid over the layers, not as
                    one more of them. Drawn last so it sits over every layer. */}
                {!selected && (
                  <Area {...AREA_PROPS} dataKey="Total" stroke="var(--text-primary)" fill="none"
                    strokeOpacity={dimOpacityFor('Total')}
                    strokeWidth={2} strokeDasharray="6 4" dot={false} activeDot={{ r: 3.5, strokeWidth: 0 }}
                    onMouseEnter={() => setHoverKey('Total')}
                    onMouseLeave={() => setHoverKey(null)} />
                )}
                {focus.overlay}
              </AreaChart>
            )}
          </TimeChart>
        </div>
        <div className="drill2-legend">
          <div className="drill2-search">
            <SearchGlyph />
            <input
              type="search"
              aria-label="Search upstreams"
              placeholder="Search upstreams…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
          {shown.map(d => {
            const dimmed = selected && selected !== d.label
            return (
              <div
                className={`drill2-item${dimmed ? ' dimmed' : ''}`}
                key={d.label}
                onClick={() => setSelected(s => s === d.label ? null : d.label)}
                onMouseEnter={() => setHoverKey(d.label)}
                onMouseLeave={() => setHoverKey(null)}
              >
                <div className="drill2-row">
                  <span className="drill2-swatch" style={{ background: d.color }} />
                  <span className="drill2-label">{d.label}</span>
                  <span className="drill2-val">{d.ms}<span className="drill2-unit"> ms</span></span>
                  <button
                    type="button"
                    className="drill2-go-btn"
                    onClick={e => { e.stopPropagation(); onOpenUpstream?.(d.label) }}
                    title={`${d.label} - open the External view`}
                  >
                    <svg className="drill2-go" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M14 4h6v6M20 4l-8 8M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5" />
                    </svg>
                  </button>
                </div>
              </div>
            )
          })}
          {shown.length === 0 && (
            <div className="drill2-empty">No upstream matches "{search.trim()}"</div>
          )}
          <div
            className="drill2-total"
            onMouseEnter={() => setHoverKey('Total')}
            onMouseLeave={() => setHoverKey(null)}
          >
            <span className="drill2-total-swatch" aria-hidden="true" />
            <span className="drill2-total-lbl">Total</span>
            <span className="drill2-total-val">{callerTotal?.ms ?? consumed} ms</span>
          </div>
        </div>
      </div>
      )}
    </div>
  )
}

// Series identity, never severity: a band's colour says which deploy it is, so
// these stay clear of the red/amber/green the status scale owns. Bands are laid
// down in version order, so consecutive deploys never land on the same colour.
const VERSION_COLORS = ['#3B82F6', '#A78BFA', '#F472B6', '#38BDF8', '#C084FC', '#2DD4BF', '#818CF8', '#E879F9']

function VersionTooltip({ active, payload, unit, formatVal, nowMs, colors, suppressed }) {
  if (!active || !payload?.length) return null
  // One version is serving at a time; listing the idle thirteen would bury it.
  const live = payload.filter(p => p.value != null && p.value !== 0)
  if (!live.length) return null
  const items = live.map(p => ({
    key: p.dataKey,
    label: p.dataKey,
    value: `${formatVal(p.value)}${unit}`,
    color: colors?.[p.dataKey] ?? (p.color || p.stroke),
  }))
  return (
    <ChartTooltip
      tMs={rowInstant(payload[0])}
      nowMs={nowMs ?? Date.now()}
      items={items}
      suppressed={suppressed}
      minWidth={150}
    />
  )
}

function TrendChart({ title, members, stack = false, domain, unit = '', formatVal, syncId, win, onFocus }) {
  const data = useMemo(() => withX(members[0].series.map((d, i) => {
    const entry = { t: d.t, label: d.label, exactTime: d.exactTime }
    members.forEach(mem => { entry[mem.label] = mem.series[i]?.value })
    return entry
  }), win), [members, win])

  const keys = useMemo(() => members.map(m => m.label), [members])
  // Only one band carries a value per minute, so the tallest member is also the
  // tallest stack - no need to sum across keys for the axis gutter.
  const peak = useMemo(() => maxOf(data, keys), [data, keys])
  const axis = valueAxisProps({ maxValue: peak, ...(domain ? { domain } : null) })
  // Same band order the series are drawn in, so the tag beside a version in the
  // tooltip is the colour that version occupies on the chart.
  const bandColors = useMemo(() => Object.fromEntries(
    keys.map((k, i) => [k, VERSION_COLORS[i % VERSION_COLORS.length]]),
  ), [keys])
  // Takes `focus` rather than closing over nothing: the stacked and line
  // branches below need the same tooltip, but whether it renders a panel
  // depends on which chart the pointer is in, and that is only known inside
  // TimeChart's render prop.
  const tipFor = focus => (
    <Tooltip
      content={p => (
        <VersionTooltip
          {...p}
          unit={unit}
          formatVal={formatVal}
          nowMs={win.end * 1000}
          colors={bandColors}
          suppressed={!focus.hovered}
        />
      )}
      {...NO_ANIM}
    />
  )

  return (
    <div className="chart-card">
      <div className="clbl"><span className="clbl-text">{title}</span><CardMenu kind="chart" title={title} /></div>
      <TimeChart className="chart-host" win={win} onFocus={onFocus}>
        {(timeAxis, focus) => (stack ? (
          <AreaChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }} syncId={syncId} syncMethod="value" {...focus.chartProps}>
            <CartesianGrid {...GRID_PROPS} />
            <XAxis {...timeAxis.props} />
            <YAxis {...axis} />
            {tipFor(focus)}
            {keys.map((k, i) => (
              <Area key={k} {...AREA_PROPS} dataKey={k} stackId="s"
                stroke={VERSION_COLORS[i % VERSION_COLORS.length]}
                fill={VERSION_COLORS[i % VERSION_COLORS.length]}
                fillOpacity={0.3} strokeWidth={1.3}
                dot={false} activeDot={{ r: 3, strokeWidth: 0 }} />
            ))}
            {focus.overlay}
          </AreaChart>
        ) : (
          <LineChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }} syncId={syncId} syncMethod="value" {...focus.chartProps}>
            <CartesianGrid {...GRID_PROPS} />
            <XAxis {...timeAxis.props} />
            <YAxis {...axis} />
            {tipFor(focus)}
            {keys.map((k, i) => (
              <Line key={k} {...LINE_PROPS} dataKey={k} connectNulls={false}
                stroke={VERSION_COLORS[i % VERSION_COLORS.length]}
                strokeWidth={1.3} dot={false} activeDot={{ r: 3, strokeWidth: 0 }} />
            ))}
            {focus.overlay}
          </LineChart>
        ))}
      </TimeChart>
    </div>
  )
}

// Three across by default. An `aside` makes it a fourth tile and the row a 2×2
// grid — the Detail tab puts its Hits per request table there, beside Apdex,
// rather than on a full-width row of its own above the charts.
function TrendCharts({ bands, syncId, win, onFocus, aside }) {
  return (
    <div className={`charts-row${aside ? ' charts-row-2x2' : ''}`}>
      <TrendChart title="RPM" members={bands.rpm} stack unit=" rpm"
        formatVal={v => (v == null ? '' : Math.round(v))} syncId={syncId} win={win} onFocus={onFocus} />
      <TrendChart title="Error %" members={bands.errorRatePct} unit="%"
        formatVal={v => (v == null ? '' : v.toFixed(2))} syncId={syncId} win={win} onFocus={onFocus} />
      <TrendChart title="Apdex" members={bands.apdex} domain={[0, 1]}
        formatVal={v => (v == null ? '' : v.toFixed(2))} syncId={syncId} win={win} onFocus={onFocus} />
      {aside}
    </div>
  )
}

const INFRA_METRICS = {
  rpm:          { label: 'RPM',           color: '#3B82F6', unit: '',     fmt: v => Math.round(v).toLocaleString() },
  latencyP90:   { label: 'p90 Latency',   color: '#A78BFA', unit: ' ms',  fmt: v => Math.round(v) },
  latencyAvg:   { label: 'Avg Latency',   color: '#A78BFA', unit: ' ms',  fmt: v => Math.round(v) },
  errorRatePct: { label: 'Error %',       color: '#F472B6', unit: '%',    fmt: v => v.toFixed(2) },
  cpuUsedPct:   { label: 'CPU Used %',    color: '#34D399', unit: '%',    fmt: v => v.toFixed(1) },
  memUsedPct:   { label: 'Memory Used %', color: '#34D399', unit: '%',    fmt: v => v.toFixed(1) },
}

const PCT_METRICS = { errorRatePct: true, cpuUsedPct: true, memUsedPct: true }

// Declared out here, not inside InfraCorrelation: a component defined in its
// parent's body is a new type on every render, so each hover would remount
// every cell and leave the popover anchored to a <td> no longer in the page —
// which measures as a zero rect and pins the chart to the top-left corner.
function InfraCell({ host, metric, value, onEnter, onLeave }) {
  const m = INFRA_METRICS[metric]
  const isPct = PCT_METRICS[metric]
  return (
    <td className="hoverable-cell"
      onMouseEnter={e => onEnter(e, host, metric)}
      onMouseLeave={onLeave}
    >
      {isPct ? (
        <CellBar fill={value}>{m.fmt(value)}{m.unit}</CellBar>
      ) : (
        <>{m.fmt(value)}{m.unit}</>
      )}
    </td>
  )
}

function InfraCorrelation({ hosts, win }) {
  const rowsWithAvg = useMemo(
    () => hosts.map(h => ({ ...h, latencyAvg: h.latencyAvg ?? Math.round(h.latencyP90 * INFRA_AVG_OF_P90) })),
    [hosts]
  )
  const { rows, sort, toggle } = useSortedRows(rowsWithAvg, 'latencyP90', 'desc')
  const [hover, setHover] = useState(null)
  // A short delay before clearing the popover lets the pointer travel from the
  // cell to the chart (and then around inside it) without the chart vanishing
  // the moment it leaves the cell's bounds.
  const closeTimer = useRef(null)
  const cancelClose = useCallback(() => {
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null }
  }, [])
  const scheduleClose = useCallback(() => {
    cancelClose()
    closeTimer.current = setTimeout(() => setHover(null), 120)
  }, [cancelClose])
  useEffect(() => () => cancelClose(), [cancelClose])

  const onEnter = useCallback((e, host, metric) => {
    cancelClose()
    setHover({ anchor: e.currentTarget, host, metric })
  }, [cancelClose])
  // Sampled here rather than when the cell is entered, so the open chart
  // follows the range if it changes underneath it.
  const hoverSeries = useMemo(
    () => (hover ? infraSeriesForWindow(win, hover.host, hover.metric) : null),
    [hover, win]
  )

  return (
    <div className="panel">
      <div className="panel-head">
        <div className="panel-head-left">Infrastructure Correlation</div>
        <CardMenu kind="table" title="Infrastructure Correlation" columns={['RPM', 'p90 Latency', 'Error %', 'CPU Used %', 'Memory Used %']} />
      </div>
      <table>
        <thead>
          <tr>
            <SortableTh sortKey="host" sort={sort} onToggle={toggle} align="left">Host</SortableTh>
            <SortableTh sortKey="rpm" sort={sort} onToggle={toggle}>RPM</SortableTh>
            <SortableTh sortKey="latencyP90" sort={sort} onToggle={toggle}>p90 Latency</SortableTh>
            <SortableTh sortKey="latencyAvg" sort={sort} onToggle={toggle}>Avg Latency</SortableTh>
            <SortableTh sortKey="errorRatePct" sort={sort} onToggle={toggle}>Error %</SortableTh>
            <SortableTh sortKey="cpuUsedPct" sort={sort} onToggle={toggle}>CPU Used %</SortableTh>
            <SortableTh sortKey="memUsedPct" sort={sort} onToggle={toggle}>Memory Used %</SortableTh>
          </tr>
        </thead>
        <tbody>
          {rows.map(h => (
            <tr key={h.host}>
              <td className="mono" style={{ textAlign: 'left' }}>{h.host}</td>
              <InfraCell host={h.host} metric="rpm" value={h.rpm} onEnter={onEnter} onLeave={scheduleClose} />
              <InfraCell host={h.host} metric="latencyP90" value={h.latencyP90} onEnter={onEnter} onLeave={scheduleClose} />
              <InfraCell host={h.host} metric="latencyAvg" value={h.latencyAvg} onEnter={onEnter} onLeave={scheduleClose} />
              <InfraCell host={h.host} metric="errorRatePct" value={h.errorRatePct} onEnter={onEnter} onLeave={scheduleClose} />
              <InfraCell host={h.host} metric="cpuUsedPct" value={h.cpuUsedPct} onEnter={onEnter} onLeave={scheduleClose} />
              <InfraCell host={h.host} metric="memUsedPct" value={h.memUsedPct} onEnter={onEnter} onLeave={scheduleClose} />
            </tr>
          ))}
        </tbody>
      </table>
      {hover && (
        <HoverChartPopover
          anchor={hover.anchor}
          title={`${INFRA_METRICS[hover.metric].label} · ${hover.host}`}
          series={hoverSeries}
          win={win}
          color={INFRA_METRICS[hover.metric].color}
          unit={INFRA_METRICS[hover.metric].unit}
          formatVal={INFRA_METRICS[hover.metric].fmt}
          onEnter={cancelClose}
          onLeave={scheduleClose}
        />
      )}
    </div>
  )
}

function SlowQueriesTable() {
  const { rows, sort, toggle } = useSortedRows(slowQueries, 'duration', 'desc')
  const Hdr = ({ sortKey, align, children }) => {
    const active = sort?.key === sortKey
    const dir = active ? sort.dir : null
    return (
      <span className="split-ep-head-cell" onClick={() => toggle(sortKey)} style={{ justifyContent: align === 'left' ? 'flex-start' : 'flex-end' }}>
        <span>{children}</span>
        <svg className={`sortable-th-arrow${active ? ' active' : ''}${dir === 'asc' ? ' asc' : ''}`}
          viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9" /><path d="M12 8v8M9 13l3 3 3-3" />
        </svg>
      </span>
    )
  }
  return (
    <div className="panel">
      <div className="panel-head is-divided">
        <div className="panel-head-left">Slow Queries</div>
        <CardMenu kind="list" title="Slow Queries" />
      </div>
      <div className="split-ep-head slowq-head is-sortable">
        <Hdr sortKey="time" align="left">Time</Hdr>
        <Hdr sortKey="query" align="left">Query</Hdr>
        <Hdr sortKey="duration">Duration</Hdr>
      </div>
      {rows.map((q, i) => (
        <div key={i} className="slowq-row">
          <div className="t">{q.time}</div>
          <div className="q" title={q.query}>{q.query}</div>
          <div className="d">{q.duration} ms</div>
        </div>
      ))}
    </div>
  )
}

const RED_COLUMNS = ['Total Requests', 'Time Consumed %', 'RPM', 'Response Time (p90)', 'Response Time (avg)', 'Error %']

// Table and graph are two readings of one set of endpoints, so they share a
// container. The table has its own search box; in graph view each chart carries
// its own search and legend instead.
//
// The graph used to draw only the first four endpoints, silently. Every chart
// now gets every endpoint and decides for itself how many to draw, and says so
// in its footer when it holds any back (components/charts/seriesBudget.js).
function RedTab({ win, endpoints, syncId, onFocus }) {
  const [view, setView] = useState('table')
  const [search, setSearch] = useState('')
  const isGraph = view === 'graph'
  const eps = endpoints

  // One sampled set per metric, in the same order as `endpoints`: both come out
  // of the same derived table, so index i is the same endpoint in each.
  const series = useMemo(() => ({
    rpm: redEndpointSeriesForWindow(win, 'rpm'),
    p90: redEndpointSeriesForWindow(win, 'p90'),
    avg: redEndpointSeriesForWindow(win, 'avg'),
    errPct: redEndpointSeriesForWindow(win, 'errPct'),
  }), [win])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return q ? endpoints.filter(e => e.endpoint.toLowerCase().includes(q)) : endpoints
  }, [endpoints, search])

  return (
    <div className="panel">
      <div className="panel-head is-divided red-table-head">
        <div className="panel-head-left red-head-left">
          <ViewToggle view={view} setView={setView} />
        </div>
        {!isGraph && <CardMenu kind="table" title="RED" columns={RED_COLUMNS} />}
      </div>
      {!isGraph && (
        <div className="red-table-search-row">
          <div className="search-with-icon">
            <SearchGlyph />
            <input
              type="search"
              className="red-table-search"
              placeholder="Search endpoints…"
              aria-label="Search endpoints"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
        </div>
      )}
      {isGraph ? (
        <>
          <LegendLineChart title="RPM" eps={eps} epSeries={series.rpm} dataKey="rpm" fmtFn={fmtRedRpm} syncId={syncId} win={win} onFocus={onFocus} />
          <LegendLineChart title="Response Time (p90)" eps={eps} epSeries={series.p90} dataKey="p90" fmtFn={fmtRedMs} syncId={syncId} win={win} onFocus={onFocus} />
          <LegendLineChart title="Response Time (avg)" eps={eps} epSeries={series.avg} dataKey="avg" fmtFn={fmtRedMs} syncId={syncId} win={win} onFocus={onFocus} />
          <LegendLineChart title="Error %" eps={eps} epSeries={series.errPct} dataKey="errPct" fmtFn={fmtRedPct} syncId={syncId} win={win} onFocus={onFocus} />
        </>
      ) : (
        <RedEndpointsTable rows={filtered} />
      )}
    </div>
  )
}

function RedEndpointsTable({ rows: input }) {
  const { rows, sort, toggle } = useSortedRows(input, 'timeConsumedPct', 'desc')
  // The route is what a reader scans this table by, so it gets a set 360px
  // rather than only as much as its longest route needs. A fixed width holds at
  // every panel size; a percentage resolves against a panel that is already
  // narrower than the table and changes nothing. When the panel is narrower
  // than the table, the table scrolls sideways instead of the panel clipping
  // its last columns off.
  return (
    <div className="red-table-scroll">
      <table>
        <thead>
          <tr>
            <SortableTh sortKey="endpoint" sort={sort} onToggle={toggle} align="left" style={{ width: 360 }}>Endpoint</SortableTh>
            <SortableTh sortKey="totalReq" sort={sort} onToggle={toggle}>Total Requests</SortableTh>
            <SortableTh sortKey="timeConsumedPct" sort={sort} onToggle={toggle}>Time Consumed %</SortableTh>
            <SortableTh sortKey="rpm" sort={sort} onToggle={toggle}>RPM</SortableTh>
            <SortableTh sortKey="p90" sort={sort} onToggle={toggle}>Response Time (p90)</SortableTh>
            <SortableTh sortKey="avg" sort={sort} onToggle={toggle}>Response Time (avg)</SortableTh>
            <SortableTh sortKey="errPct" sort={sort} onToggle={toggle}>Error %</SortableTh>
          </tr>
        </thead>
        <tbody>
          {rows.map(e => {
            return (
              <tr key={e.endpoint}>
                <td className="mono" style={{ textAlign: 'left' }}>{e.endpoint}</td>
                <td>{e.totalReq}</td>
                <td><CellBar fill={e.timeConsumedPct}>{e.timeConsumedPct}%</CellBar></td>
                <td>{e.rpm}</td>
                <td className="val-critical">{e.p90} ms</td>
                <td>{e.avg} ms</td>
                <td><CellBar fill={e.errPct * 12}>{e.errPct}%</CellBar></td>
              </tr>
            )
          })}
          {rows.length === 0 && (
            <tr>
              <td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '28px 16px' }}>
                No endpoints match your search.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

// Multi-line chart used by the External and DB tabs when nothing is selected:
// one line per endpoint, series identity carried by colour. Shares the time
// cursor with the rest of the page via syncId. hoverKey is lifted so that
// hovering a line here or a swatch in the shared legend dims the same series
// across every chart in the group.
//
// The tab owns the series budget, because its three charts and one legend have
// to agree on what is drawn: it passes the full list plus `drawCount`, and
// `onWidth` to hear how wide the plot is. With every series in hand, the axis
// can span all of them while the budget is holding some back (`fixAxis`).
function MultiLineChart({ seriesList, drawCount = seriesList.length, fixAxis = false, onWidth, unit = '', formatVal, height = 182, syncId, hoverKey, setHoverKey, win, onFocus }) {
  const data = useMemo(() => {
    const base = seriesList[0]?.data || []
    return withX(base.map((p, i) => {
      const row = { t: p.t, label: p.label, exactTime: p.exactTime }
      seriesList.forEach(s => { row[s.key] = s.data[i]?.value })
      return row
    }), win)
  }, [seriesList, win])
  const drawn = seriesList.slice(0, drawCount)
  const allMax = useMemo(() => maxOf(data, seriesList.map(s => s.key)), [data, seriesList])
  const y = useMemo(() => (
    fixAxis ? niceAxis(allMax, 4, { decimals: formatVal ? formatDecimals(formatVal) : Infinity }) : null
  ), [fixAxis, allMax, formatVal])
  const opacityFor = key => (hoverKey == null || hoverKey === key ? 1 : 0.18)
  return (
    <TimeChart win={win} onFocus={onFocus} height={height} onWidth={onWidth}>
      {(axis, focus) => (
        <LineChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }} syncId={syncId} syncMethod="value" {...focus.chartProps}>
          <CartesianGrid {...GRID_PROPS} />
          <XAxis {...axis.props} />
          <YAxis {...valueAxisProps({ maxValue: y?.top ?? maxOf(data, drawn.map(s => s.key)), format: formatVal, domain: y ? [0, y.top] : undefined })} ticks={y?.ticks} />
          <Tooltip content={p => <MultiSeriesTooltip {...p} seriesList={seriesList} unit={unit} formatVal={formatVal} hoverKey={hoverKey} nowMs={win.end * 1000} suppressed={!focus.hovered} />} {...NO_ANIM} />
          {drawn.map(s => (
            <Line key={s.key} {...LINE_PROPS} dataKey={s.key} stroke={s.color}
              strokeWidth={1.5} strokeOpacity={opacityFor(s.key)}
              dot={false} activeDot={{ r: 3, strokeWidth: 0 }}
              onMouseEnter={() => setHoverKey?.(s.key)}
              onMouseLeave={() => setHoverKey?.(null)} />
          ))}
          {focus.overlay}
        </LineChart>
      )}
    </TimeChart>
  )
}

function MultiSeriesTooltip({ active, payload, seriesList, unit, formatVal, hoverKey, nowMs, suppressed }) {
  if (!active || !payload?.length) return null
  const byKey = Object.fromEntries(seriesList.map(s => [s.key, s]))
  // Every line stays listed and the pointed-at one is emphasised. Filtering down
  // to the hovered series threw away the comparison the reader hovered FOR —
  // one number on its own says nothing about whether it is the high line.
  const items = payload.flatMap(p => {
    const s = byKey[p.dataKey]
    if (!s) return []
    const val = formatVal ? formatVal(p.value) : (p.value != null ? String(Math.round(p.value * 100) / 100) : '')
    const short = s.label.length > 28 ? s.label.slice(0, 26) + '…' : s.label
    return [{ key: p.dataKey, label: short, value: `${val}${unit}`, color: s.color }]
  })
  if (!items.length) return null
  return (
    <ChartTooltip
      tMs={rowInstant(payload[0])}
      nowMs={nowMs ?? Date.now()}
      items={items}
      hoverKey={hoverKey}
      suppressed={suppressed}
      limit={TOOLTIP_ROWS}
    />
  )
}

function SplitEndpointList({ title, endpoints, selectedIdx, onSelect, onClear }) {
  const [search, setSearch] = useState('')
  const filtered = useMemo(() => (
    search ? endpoints.filter(e => e.endpoint.toLowerCase().includes(search.toLowerCase())) : endpoints
  ), [search, endpoints])
  const { rows, sort, toggle } = useSortedRows(filtered, 'timeConsumedPct', 'desc')
  const hasSelection = selectedIdx != null && endpoints[selectedIdx]
  const selectedEndpoint = hasSelection ? endpoints[selectedIdx].endpoint : null

  const SortLbl = ({ sortKey, children }) => {
    const active = sort?.key === sortKey
    const dir = active ? sort.dir : null
    return (
      <span className="split-ep-head-cell" onClick={() => toggle(sortKey)}>
        <span>{children}</span>
        <svg className={`sortable-th-arrow${active ? ' active' : ''}${dir === 'asc' ? ' asc' : ''}`}
          viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9" /><path d="M12 8v8M9 13l3 3 3-3" />
        </svg>
      </span>
    )
  }

  return (
    <div className="panel split-endpoints">
      <div className="panel-head">
        <div className="panel-head-left">{title}</div>
        <div className="panel-head-right">
          {hasSelection && onClear && (
            <button type="button" className="split-ep-clear" onClick={onClear}>Clear Endpoint</button>
          )}
          <CardMenu kind="table" title={title} columns={['Time %', 'RPM', 'Avg', 'Error %']} />
        </div>
      </div>
      <div className="split-endpoints-search">
        <div className="search-with-icon">
          <SearchGlyph />
          <input placeholder="Search endpoints…" aria-label="Search endpoints" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
      </div>
      <div className="split-ep-head is-sortable">
        <SortLbl sortKey="endpoint">Endpoint</SortLbl>
        <SortLbl sortKey="timeConsumedPct">Time %</SortLbl>
        <SortLbl sortKey="rpm">RPM</SortLbl>
        <SortLbl sortKey="avg">Avg</SortLbl>
        <SortLbl sortKey="errPct">Error %</SortLbl>
      </div>
      {rows.map(e => {
        const errS = statusForErrorRate(e.errPct)
        const isSel = e.endpoint === selectedEndpoint
        const originalIdx = endpoints.indexOf(e)
        return (
          <div key={e.endpoint} className={`split-ep-row${isSel ? ' selected' : ''}`} onClick={() => onSelect(originalIdx)}>
            <div className="split-ep-ep" title={e.endpoint}>
              <span className="split-ep-kind">{e.kind}</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.endpoint}</span>
            </div>
            <div className="split-ep-bar">
              <span className="split-ep-cell dim">{e.timeConsumedPct}%</span>
              <span className="track"><span className="fill" style={{ width: `${e.timeConsumedPct}%` }} /></span>
            </div>
            <div className="split-ep-cell">{e.rpm >= 1000 ? (e.rpm / 1000).toFixed(1) + 'K' : e.rpm.toFixed(1)}</div>
            <div className="split-ep-cell dim">{e.avg}ms</div>
            <div className="split-ep-bar">
              <span className={`split-ep-cell ${errS === 'critical' ? 'val-critical' : errS === 'warning' ? 'val-warning' : 'dim'}`}>{e.errPct}%</span>
              <span className="track"><span className="fill" style={{ width: `${Math.min(100, e.errPct * 12)}%` }} /></span>
            </div>
          </div>
        )
      })}
      {rows.length === 0 && (
        <div className="err-empty">No endpoints match "{search}"</div>
      )}
    </div>
  )
}

// Shortened label for the external-call legend/tooltip. Drops the HTTP verb and
// path and keeps just "HTTP <host>" so stacked lines stay readable.
function externalShortLabel(endpoint) {
  const rest = endpoint.replace(/^[A-Z]+\s+/, '')
  const host = rest.split('/')[0] || rest
  return `HTTP ${host}`
}

// Every row's own sampled series for one window, by endpoint name: { avg, rpm,
// errPct }. `sampleFor` is a data-layer sampler (externalEndpointSeriesForWindow
// or dbEndpointSeriesForWindow) — module functions, so their identity is stable.
function useRowSeries(win, sampleFor) {
  return useMemo(() => {
    const byEndpoint = new Map()
    for (const key of ['avg', 'rpm', 'errPct']) {
      for (const { endpoint, series } of sampleFor(win, key)) {
        if (!byEndpoint.has(endpoint)) byEndpoint.set(endpoint, {})
        byEndpoint.get(endpoint)[key] = series
      }
    }
    return byEndpoint
  }, [win, sampleFor])
}

function ExternalTab({ svc, data, syncId, win, onFocus }) {
  const [sel, setSel] = useState(null)
  const [hoverKey, setHoverKey] = useState(null)
  const endpoints = data.external
  const ep = sel != null ? endpoints[sel] : null

  // Each call's own series, sampled from the profile its table row is reduced
  // from (see externalEndpointSeriesForWindow), so a line and its row agree.
  const rowSeries = useRowSeries(win, externalEndpointSeriesForWindow)
  const perEp = useMemo(() => endpoints.map((e, i) => {
    const r = rowSeries.get(e.endpoint) ?? {}
    return { key: `ep${i}`, label: externalShortLabel(e.endpoint), color: epColor(i), lat: r.avg ?? [], rpm: r.rpm ?? [], err: r.errPct ?? [] }
  }), [endpoints, rowSeries])

  // One budget for the three charts and the legend under them, so they always
  // agree on which endpoints are drawn. The charts report their (shared) width.
  const [plotWidth, setPlotWidth] = useState(0)
  const budget = useSeriesBudget(perEp.length, plotWidth)
  const multiProps = { drawCount: budget.count, fixAxis: fixesAxis(budget.status), onWidth: setPlotWidth }

  // Single-endpoint mode re-uses MiniChart's single area; multi mode shows a
  // line per endpoint with a shared legend under the three charts.
  const epRow = ep ? rowSeries.get(ep.endpoint) ?? {} : null
  const latSeries = epRow ? epRow.avg ?? [] : null
  const rpmSeries = epRow ? epRow.rpm ?? [] : null
  const errSeries = epRow ? epRow.errPct ?? [] : null

  const latMulti = useMemo(() => perEp.map(s => ({ key: s.key, label: s.label, color: s.color, data: s.lat })), [perEp])
  const rpmMulti = useMemo(() => perEp.map(s => ({ key: s.key, label: s.label, color: s.color, data: s.rpm })), [perEp])
  const errMulti = useMemo(() => perEp.map(s => ({ key: s.key, label: s.label, color: s.color, data: s.err })), [perEp])

  const callers = ep ? (externalEndpointCallers[ep.endpoint] || []) : []

  return (
    <>
      <KpiCards svc={svc} />
      <div className="svc-split">
        <SplitEndpointList
          title="All External HTTP Calls"
          endpoints={endpoints}
          selectedIdx={sel}
          onSelect={setSel}
          onClear={() => setSel(null)}
        />
        <div className="split-charts">
          <div className="split-chart-card">
            <div className="clbl">
              <span className="clbl-text">Response Time (avg)</span>
              <CardMenu kind="chart" title="Response Time (avg)" />
            </div>
            <div className="chart-host">
              {ep
                ? <MiniChart syncId={syncId} win={win} onFocus={onFocus} series={latSeries} color="#3B82F6" unit=" ms" formatVal={v => Math.round(v)} />
                : <MultiLineChart {...multiProps} syncId={syncId} win={win} onFocus={onFocus} seriesList={latMulti} unit=" ms" formatVal={v => Math.round(v)} hoverKey={hoverKey} setHoverKey={setHoverKey} />}
            </div>
          </div>
          <div className="split-chart-card">
            <div className="clbl"><span className="clbl-text">RPM</span><CardMenu kind="chart" title="RPM" /></div>
            <div className="chart-host">
              {ep
                ? <MiniChart syncId={syncId} win={win} onFocus={onFocus} series={rpmSeries} color="#A78BFA" unit=" rpm" formatVal={v => Math.round(v)} />
                : <MultiLineChart {...multiProps} syncId={syncId} win={win} onFocus={onFocus} seriesList={rpmMulti} unit=" rpm" formatVal={v => Math.round(v)} hoverKey={hoverKey} setHoverKey={setHoverKey} />}
            </div>
          </div>
          <div className="split-chart-card">
            <div className="clbl"><span className="clbl-text">Error %</span><CardMenu kind="chart" title="Error %" /></div>
            <div className="chart-host">
              {ep
                ? <MiniChart syncId={syncId} win={win} onFocus={onFocus} series={errSeries} color="#F472B6" unit="%" formatVal={v => v.toFixed(2)} />
                : <MultiLineChart {...multiProps} syncId={syncId} win={win} onFocus={onFocus} seriesList={errMulti} unit="%" formatVal={v => v.toFixed(2)} hoverKey={hoverKey} setHoverKey={setHoverKey} />}
            </div>
          </div>
          {!ep && (
            <div className="split-chart-legend">
              {perEp.slice(0, budget.count).map(s => {
                const dim = hoverKey != null && hoverKey !== s.key
                return (
                  <span
                    key={s.key}
                    className={`split-chart-legend-item${dim ? ' dim' : ''}`}
                    onMouseEnter={() => setHoverKey(s.key)}
                    onMouseLeave={() => setHoverKey(null)}
                  >
                    <span className="split-chart-legend-swatch" style={{ background: s.color }} />
                    <span>{s.label}</span>
                  </span>
                )
              })}
            </div>
          )}
          {!ep && <SeriesBudgetFooter budget={budget} noun="endpoints" />}
          {ep && <EndpointBreakdownRows rows={callers} />}
        </div>
      </div>
    </>
  )
}

// Rows block that sits inside .split-charts below the Error % chart. No panel
// chrome and no title - the preceding "Clear Endpoint" button in the sibling
// list already names the context, so a second header would just repeat it.
function EndpointBreakdownRows({ rows }) {
  const { rows: sorted, sort, toggle } = useSortedRows(rows, 'timeConsumedPct', 'desc')
  const SortLbl = ({ sortKey, children }) => {
    const active = sort?.key === sortKey
    const dir = active ? sort.dir : null
    return (
      <span className="split-ep-head-cell" onClick={() => toggle(sortKey)}>
        <span>{children}</span>
        <svg className={`sortable-th-arrow${active ? ' active' : ''}${dir === 'asc' ? ' asc' : ''}`}
          viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9" /><path d="M12 8v8M9 13l3 3 3-3" />
        </svg>
      </span>
    )
  }
  return (
    <div className="split-breakdown">
      <div className="split-ep-head is-sortable">
        <SortLbl sortKey="endpoint">Endpoint</SortLbl>
        <SortLbl sortKey="timeConsumedPct">Time %</SortLbl>
        <SortLbl sortKey="rpm">RPM</SortLbl>
        <SortLbl sortKey="avg">Avg</SortLbl>
        <SortLbl sortKey="errPct">Error %</SortLbl>
      </div>
      {sorted.map(r => {
        const errS = statusForErrorRate(r.errPct)
        return (
          <div key={r.endpoint} className="split-ep-row no-hover">
            <div className="split-ep-ep" title={r.endpoint}>
              <span className="split-ep-kind">{r.kind}</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.endpoint}</span>
            </div>
            <div className="split-ep-bar">
              <span className="split-ep-cell dim">{r.timeConsumedPct}%</span>
              <span className="track"><span className="fill" style={{ width: `${r.timeConsumedPct}%` }} /></span>
            </div>
            <div className="split-ep-cell">{r.rpm >= 1000 ? (r.rpm / 1000).toFixed(1) + 'K' : r.rpm.toFixed(1)}</div>
            <div className="split-ep-cell dim">{r.avg}ms</div>
            <div className="split-ep-bar">
              <span className={`split-ep-cell ${errS === 'critical' ? 'val-critical' : errS === 'warning' ? 'val-warning' : 'dim'}`}>{r.errPct}%</span>
              <span className="track"><span className="fill" style={{ width: `${Math.min(100, r.errPct * 12)}%` }} /></span>
            </div>
          </div>
        )
      })}
      {sorted.length === 0 && (
        <div className="err-empty">No endpoints call this external endpoint</div>
      )}
    </div>
  )
}

const DB_FILTER_OPTIONS = ['All Database Calls', 'MySQL', 'Redis']
const DB_KIND_FOR_FILTER = { 'MySQL': 'mysql', 'Redis': 'redis' }

function DbTab({ svc, data, syncId, win, onFocus }) {
  const [sel, setSel] = useState(null)
  const [hoverKey, setHoverKey] = useState(null)
  const [filter, setFilter] = useState('All Database Calls')

  // Narrow by kind before anything else, so index 0 of the filtered list is the
  // only "selected" position the row IDs ever refer to. Clearing filter after a
  // selection could leave `sel` pointing past the end - the ep? pattern below
  // falls back cleanly, and we also reset the selection on filter change.
  const allEndpoints = data.db
  const endpoints = useMemo(() => {
    const kind = DB_KIND_FOR_FILTER[filter]
    return kind ? allEndpoints.filter(e => e.kind === kind) : allEndpoints
  }, [allEndpoints, filter])
  const ep = sel != null ? endpoints[sel] : null

  // Each operation's own series, sampled from the profile its row is reduced
  // from (see dbEndpointSeriesForWindow). A MySQL statement with no errors draws
  // a flat zero, and a Redis call's error rate stays a percentage.
  const rowSeries = useRowSeries(win, dbEndpointSeriesForWindow)
  const perEp = useMemo(() => endpoints.map((e, i) => {
    const r = rowSeries.get(e.endpoint) ?? {}
    return { key: `ep${i}`, label: dbShortLabel(e), color: epColor(i), lat: r.avg ?? [], rpm: r.rpm ?? [], err: r.errPct ?? [] }
  }), [endpoints, rowSeries])

  // One budget for the three charts and the legend, as on the External tab. It
  // counts the operations the kind filter leaves, so narrowing to MySQL or
  // Redis is itself a way to see everything.
  const [plotWidth, setPlotWidth] = useState(0)
  const budget = useSeriesBudget(perEp.length, plotWidth)
  const multiProps = { drawCount: budget.count, fixAxis: fixesAxis(budget.status), onWidth: setPlotWidth }

  const epRow = ep ? rowSeries.get(ep.endpoint) ?? {} : null
  const latSeries = epRow ? epRow.avg ?? [] : null
  const rpmSeries = epRow ? epRow.rpm ?? [] : null
  const errSeries = epRow ? epRow.errPct ?? [] : null

  const latMulti = useMemo(() => perEp.map(s => ({ key: s.key, label: s.label, color: s.color, data: s.lat })), [perEp])
  const rpmMulti = useMemo(() => perEp.map(s => ({ key: s.key, label: s.label, color: s.color, data: s.rpm })), [perEp])
  const errMulti = useMemo(() => perEp.map(s => ({ key: s.key, label: s.label, color: s.color, data: s.err })), [perEp])

  const callers = ep ? (dbEndpointCallers[ep.endpoint] || []) : []

  const titleNode = (
    <TitleDropdown
      value={filter}
      options={DB_FILTER_OPTIONS}
      onChange={v => { setFilter(v); setSel(null); setHoverKey(null); budget.showFewer() }}
    />
  )

  return (
    <>
      <KpiCards svc={svc} />
      <div className="svc-split">
        <SplitEndpointList
          title={titleNode}
          endpoints={endpoints}
          selectedIdx={sel}
          onSelect={setSel}
          onClear={() => setSel(null)}
        />
        <div className="split-charts">
          <div className="split-chart-card">
            <div className="clbl">
              <span className="clbl-text">Response Time (avg)</span>
              <CardMenu kind="chart" title="Response Time (avg)" />
            </div>
            <div className="chart-host">
              {ep
                ? <MiniChart syncId={syncId} win={win} onFocus={onFocus} series={latSeries} color="#3B82F6" unit=" ms" formatVal={v => Math.round(v)} />
                : <MultiLineChart {...multiProps} syncId={syncId} win={win} onFocus={onFocus} seriesList={latMulti} unit=" ms" formatVal={v => Math.round(v)} hoverKey={hoverKey} setHoverKey={setHoverKey} />}
            </div>
          </div>
          <div className="split-chart-card">
            <div className="clbl"><span className="clbl-text">RPM</span><CardMenu kind="chart" title="RPM" /></div>
            <div className="chart-host">
              {ep
                ? <MiniChart syncId={syncId} win={win} onFocus={onFocus} series={rpmSeries} color="#A78BFA" unit=" rpm" formatVal={v => Math.round(v)} />
                : <MultiLineChart {...multiProps} syncId={syncId} win={win} onFocus={onFocus} seriesList={rpmMulti} unit=" rpm" formatVal={v => Math.round(v)} hoverKey={hoverKey} setHoverKey={setHoverKey} />}
            </div>
          </div>
          <div className="split-chart-card">
            <div className="clbl"><span className="clbl-text">Error %</span><CardMenu kind="chart" title="Error %" /></div>
            <div className="chart-host">
              {ep
                ? <MiniChart syncId={syncId} win={win} onFocus={onFocus} series={errSeries} color="#F472B6" unit="%" formatVal={v => v.toFixed(2)} />
                : <MultiLineChart {...multiProps} syncId={syncId} win={win} onFocus={onFocus} seriesList={errMulti} unit="%" formatVal={v => v.toFixed(2)} hoverKey={hoverKey} setHoverKey={setHoverKey} />}
            </div>
          </div>
          {!ep && (
            <div className="split-chart-legend">
              {perEp.slice(0, budget.count).map(s => {
                const dim = hoverKey != null && hoverKey !== s.key
                return (
                  <span
                    key={s.key}
                    className={`split-chart-legend-item${dim ? ' dim' : ''}`}
                    onMouseEnter={() => setHoverKey(s.key)}
                    onMouseLeave={() => setHoverKey(null)}
                  >
                    <span className="split-chart-legend-swatch" style={{ background: s.color }} />
                    <span>{s.label}</span>
                  </span>
                )
              })}
            </div>
          )}
          {!ep && <SeriesBudgetFooter budget={budget} noun="operations" />}
          {ep && <EndpointBreakdownRows rows={callers} />}
        </div>
      </div>
      <SlowQueriesTable />
    </>
  )
}

// Keep the verb (SELECT vs UPDATE) so two mysql rows against the same table
// don't collapse to the same legend label.
function dbShortLabel(ep) {
  return `${ep.kind.toUpperCase()} ${ep.endpoint}`
}

// The Client side keys a row on the outgoing call, not on the endpoint that
// made it: the same Redis GET failing under four endpoints is one failing
// call, and four rows of it would bury the next call down the list.
const CLIENT_ERRORS_BY = ['side', 'service', 'spanName', 'exception']

// The side is App's when App passes it, so a link naming a side lands on it
// even with the tab already mounted; standing alone, the tab keeps its own.
//
// What the tab draws is ErrorGroupsPanel (shared with the Browser page's Errors
// tab); what stays here is the service page's own part of it — which groups,
// and where a row, an exception and the head's button go.
function ErrorsTab({ win, timeRange, serviceId, onFocus, syncId, onOpenLink, side: sideProp, onSide }) {
  const [ownSide, setOwnSide] = useState('server')
  const side = sideProp ?? ownSide
  const setSide = onSide ?? setOwnSide
  // What each count's chip compares against, worded from the picked range
  // ("the previous hour") as the Errors page words it (rule 6).
  const prevText = previousPeriodText(timeRange)
  const groups = useMemo(
    () => errorGroupsForWindow(win, { side, service: serviceId, by: side === 'client' ? CLIENT_ERRORS_BY : undefined }),
    [win, side, serviceId],
  )
  // A row click lands on the Traces page filtered to exactly the spans the row
  // counts: this service, this side, failed, this span, this exception. The
  // Traces stream carries a span for every error group, so it is never empty.
  const openRow = (e) => onOpenLink?.({ view: 'traces', filters: tracesFiltersFor(e) })
  // The exception goes one step further than the row: to the Errors page,
  // filtered to this group, with its details drawer open — the stack trace,
  // the sample occurrences and their traces are there.
  const openDetails = (e) => onOpenLink?.({
    view: 'errors', service: serviceId, kind: side, exception: e.exception,
    ...(side === 'client' ? { spanName: e.spanName } : { endpoint: e.endpoint }),
    open: true,
  })
  // The panel's default sides (Server | Client) and Endpoint column (the route
  // on Server, the call on Client) are this tab's, so neither is passed.
  return (
    <ErrorGroupsPanel
      side={side}
      onSide={setSide}
      groups={groups}
      prevText={prevText}
      win={win}
      onFocus={onFocus}
      syncId={syncId}
      onOpenRow={openRow}
      onOpenException={openDetails}
      headRight={(
        <button
          type="button"
          className="hbtn small"
          title={`Open ${serviceId}'s ${side} errors on the Errors page`}
          onClick={() => onOpenLink?.({ view: 'errors', service: serviceId, kind: side })}
        >
          Open in Errors
          <ArrowUpRight size={12} strokeWidth={2} aria-hidden="true" />
        </button>
      )}
    />
  )
}

// The Overview tab loads in two stages: the scorecards land first, the charts
// after them. The mock data is ready on the first render, so these delays
// stand in for the queries a real backend would run.
const KPI_LOAD_MS = 400
const CHART_LOAD_MS = 1100

// True once `ms` has passed since `key` last changed, and false again the
// moment it changes, so a new key never shows the previous one's content.
function useLoadedAfter(key, ms) {
  const [loaded, setLoaded] = useState(null)
  useEffect(() => {
    const id = setTimeout(() => setLoaded(key), ms)
    return () => clearTimeout(id)
  }, [key, ms])
  return loaded === key
}

// Mounted with the tab, so coming back to Overview loads it again. Keyed on the
// service, not the range: a drag-to-zoom redraws the charts in place and keeps
// whatever upstream is selected in the drilldown.
function OverviewTab({ svc, data, win, syncId, onFocus, onOpenTrace, onOpenUpstream }) {
  const kpisReady = useLoadedAfter(svc.id, KPI_LOAD_MS)
  const chartsReady = useLoadedAfter(svc.id, CHART_LOAD_MS)
  return (
    <>
      {kpisReady
        ? <div className="svc-reveal"><KpiCards svc={svc} /></div>
        : <KpiCardsSkeleton />}
      {chartsReady ? (
        <div className="svc-reveal">
          <LatencyDrilldown layers={data.drilldown} layerSeries={data.drilldownSeries} callerTotal={data.drilldownTotal} onOpenUpstream={onOpenUpstream} syncId={syncId} win={win} onFocus={onFocus} />
          <TrendCharts bands={data.bands} syncId={syncId} win={win} onFocus={onFocus} />
        </div>
      ) : (
        <>
          <LatencyDrilldownSkeleton />
          <TrendChartsSkeleton />
        </>
      )}
      <RequestTraceSplit onOpenTrace={onOpenTrace} data={data.slow} />
      <InfraCorrelation hosts={data.infra} win={win} />
    </>
  )
}

// Built but not wired: SERVICE_TABS has no Traces entry yet, so nothing
// renders this. Kept intact for the sub-tab that will mount it — unlike the
// SparkChart that sat beside it, this is a finished screen rather than a
// superseded helper, so it is silenced rather than deleted.
// eslint-disable-next-line no-unused-vars
function TracesTab() {
  const [sortBy, setSortBy] = useState('latency')
  const [selectedId, setSelectedId] = useState(tracesList[0].id)
  const [fetched, setFetched] = useState(true)
  const sorted = useMemo(() => {
    const list = [...tracesList]
    if (sortBy === 'latency') list.sort((a, b) => b.durationMs - a.durationMs)
    return list
  }, [sortBy])
  const detail = traceDetail

  return (
    <>
      <div className="trace-query">
        <div className="trace-query-head">
          <div className="trace-query-tabs">
            <div className="tqt active">Search</div>
            <div className="tqt">Code</div>
          </div>
          <button className="trace-run-btn" onClick={() => setFetched(true)}>Fetch Results</button>
        </div>
        <div className="trace-clause">
          <span className="trace-clause-op">Where</span>
          <span className="trace-clause-pill">root_name</span>
          <span className="trace-clause-pill op">equals</span>
          <span className="trace-clause-pill">POST /v1/payments/:id/capture</span>
          <span className="trace-clause-btn">Remove</span>
        </div>
        <div className="trace-clause">
          <span className="trace-clause-op">And</span>
          <span className="trace-clause-pill">span_kind</span>
          <span className="trace-clause-pill op">in</span>
          <span className="trace-clause-pill">
            <span className="trace-clause-tag">server</span>
            <span className="trace-clause-tag">consumer</span>
          </span>
          <span className="trace-clause-btn">Remove</span>
          <span className="trace-clause-btn primary" style={{ marginLeft: 0 }}>+ Add condition</span>
        </div>
        <div className="trace-query-preview">
          <span className="trace-query-preview-lbl">Generated query</span>
          "root_name":="POST /v1/payments/:id/capture" "span_kind":in("server","consumer")
        </div>
      </div>

      {fetched && (
        <div className="trace-results">
          <div className="panel">
            <div className="panel-head">
              <div className="panel-head-left">Traces</div>
              <div className="panel-head-right">
                <div className="seg-toggle">
                  <div className={`seg${sortBy === 'latency' ? ' active' : ''}`} onClick={() => setSortBy('latency')}>Latency</div>
                  <div className={`seg${sortBy === 'time' ? ' active' : ''}`} onClick={() => setSortBy('time')}>Time</div>
                </div>
                <CardMenu kind="list" title="Traces" />
              </div>
            </div>
            {sorted.map(t => (
              <div key={t.id} className={`trace-list-row${t.id === selectedId ? ' selected' : ''}`} onClick={() => setSelectedId(t.id)}>
                <div>
                  <div className="trace-list-ep">
                    <span className={`status-dot ${t.status}`} />
                    {t.endpoint}
                  </div>
                  <div className="trace-list-meta">trace <span className="mono">{t.id.slice(0, 10)}…</span></div>
                </div>
                <div className="trace-list-dur">
                  <span className={t.status === 'critical' ? 'val-critical' : t.status === 'warning' ? 'val-warning' : ''}>{t.durationMs} ms</span>
                  <span className="t">{t.time}</span>
                </div>
              </div>
            ))}
          </div>

          <div className="trace-detail-panel">
            <div className="trace-detail-head">
              <div className="trace-detail-svc">{detail.service}</div>
              <div className="trace-detail-ep">{detail.endpoint}</div>
              <div className="trace-detail-id">Trace ID · {detail.id}</div>
            </div>
            <div className="trace-waterfall">
              <div className="trace-wf-head">
                <span>Span waterfall</span>
                <span>{detail.durationMs} ms total</span>
              </div>
              {detail.spans.map((sp, i) => (
                <div key={i} className="trace-wf-row">
                  <div className="trace-wf-label" style={{ paddingLeft: sp.level * 12 }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sp.name}</span>
                    <span className="dur">{sp.durationMs} ms</span>
                  </div>
                  <div className="trace-wf-bar-wrap">
                    <div className="trace-wf-bar" style={{ left: `${sp.offsetPct}%`, width: `${sp.widthPct}%`, background: sp.color, opacity: 0.85 }} />
                  </div>
                </div>
              ))}
            </div>
            <div className="trace-tags">
              <div className="trace-tags-title">Tags · {detail.tags.length}</div>
              {detail.tags.map(t => (
                <div key={t.k} className="trace-tag-row">
                  <span className="trace-tag-key">{t.k}</span>
                  <span className="trace-tag-val" title={t.v}>{t.v}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  )
}

/**
 * Series identity for the runtime panel.
 *
 * Six of these twelve charts draw some combination of a limit, a committed and
 * a used line, and they have to agree about which colour is which. A reader who
 * learns "blue is what the JVM is actually holding" on the heap chart must not
 * have to relearn it on eden, so the colour is keyed on the series' ROLE rather
 * than on the chart it happens to sit in.
 *
 * Blues, teals, purples and pinks only. Red, amber and green mean severity
 * everywhere else on this platform, and "which series is this" is not a
 * severity.
 */
const RT_COLORS = {
  used: '#3B82F6',
  committed: '#06B6D4',
  limit: '#A78BFA',
  alt: '#F472B6',
}

// A limit is configuration, not a reading — `-Xmx` does not move because Redis
// is down. Dashing it says so, and it says so identically on all five charts
// that carry one.
const LIMIT_DASH = '4 3'

const fmtRuntimePct = v => (v == null || Number.isNaN(v) ? '' : `${v.toFixed(1)}%`)
const fmtRuntimeMs = v => (v == null || Number.isNaN(v) ? '' : `${v.toFixed(1)} ms`)

/**
 * Merge the series one runtime chart draws into a row per bucket.
 *
 * Every series in the panel is sampled from the same window, so they share an
 * index — there is no need to join on time.
 */
function runtimeRows(series, win) {
  const base = series[0]?.rows ?? []
  return withX(base.map((d, i) => {
    const row = { t: d.t, label: d.label, exactTime: d.exactTime }
    for (const s of series) row[s.key] = s.rows[i]?.value
    return row
  }), win)
}

/**
 * Every series the chart drew, in the order its legend lists them.
 *
 * Read off the ROW rather than off `payload`, so a series that is null in this
 * particular bucket still holds its place. A tooltip whose rows appear and
 * disappear as the pointer travels cannot be scanned, and on a used-vs-limit
 * chart the missing row is usually the one being looked for.
 */
function RuntimeTooltip({ active, payload, series, fmt, nowMs, hoverKey, suppressed }) {
  if (!active || !payload?.length) return null
  const row = payload[0]?.payload ?? {}
  const items = series.map(s => ({
    key: s.key,
    label: s.label,
    value: fmt(row[s.key]),
    color: s.color,
  }))
  return (
    <ChartTooltip
      tMs={rowInstant(payload[0])}
      nowMs={nowMs ?? Date.now()}
      items={items}
      hoverKey={hoverKey}
      suppressed={suppressed}
      minWidth={series.length > 1 ? 196 : 160}
    />
  )
}

/**
 * One runtime chart: header, plot, tooltip, legend.
 *
 * Twelve configurations of this rather than twelve blocks of chart markup. The
 * panel's charts differ in what they plot and in almost nothing else, and every
 * one of them has to carry the same tick ladder, the same drag-to-focus, the
 * same tooltip and the same crosshair as the rest of the page — which is
 * exactly the kind of agreement that rots when it is retyped twelve times.
 *
 * @param {string} title     the header, and the name the card menu acts on
 * @param {Array}  series    [{ key, label, color, rows, dash }] in legend order
 * @param {Function} fmt     value → axis label
 * @param {Function} [tipFmt] value → tooltip value; defaults to `fmt`, and
 *                           differs where a unit is worth the width in a
 *                           tooltip but not on every tick
 * @param {boolean} [area]   filled bands instead of lines
 * @param {'half'|'third'} [span] how much of the grid row the card takes
 */
function RuntimeChart({ title, series, fmt, tipFmt, area = false, span = 'half', syncId, win, onFocus }) {
  const [hoverKey, hoverProps] = useSeriesHover()
  const data = useMemo(() => runtimeRows(series, win), [series, win])
  const keys = useMemo(() => series.map(s => s.key), [series])
  const dimFor = key => (hoverKey == null || hoverKey === key ? 1 : 0.2)
  const Chart = area ? AreaChart : LineChart

  return (
    <div className={`runtime-chart-card rt-${span}`}>
      <div className="clbl">
        <span className="clbl-text">{title}</span>
        <CardMenu kind="chart" title={title} />
      </div>
      <TimeChart className="chart-host" win={win} onFocus={onFocus}>
        {(axis, focus) => (
          <Chart data={data} margin={{ top: 6, right: 4, left: 0, bottom: 0 }} syncId={syncId} syncMethod="value" {...focus.chartProps}>
            <CartesianGrid {...GRID_PROPS} />
            <XAxis {...axis.props} />
            <YAxis {...valueAxisProps({ maxValue: maxOf(data, keys), format: fmt })} />
            {/* Not decoration: Recharts delivers no move events to the wrapper
                without a Tooltip, so the drag-to-focus gesture depends on it. */}
            <Tooltip
              content={p => (
                <RuntimeTooltip
                  {...p}
                  series={series}
                  fmt={tipFmt ?? fmt}
                  nowMs={win.end * 1000}
                  hoverKey={hoverKey}
                  suppressed={!focus.hovered}
                />
              )}
              {...NO_ANIM}
            />
            {series.map(s => (area ? (
              <Area key={s.key} {...AREA_PROPS} dataKey={s.key} stackId="rt"
                stroke={s.color} fill={s.color}
                fillOpacity={0.3 * dimFor(s.key)} strokeOpacity={dimFor(s.key)}
                strokeWidth={1.4} dot={false} activeDot={{ r: 3, strokeWidth: 0 }}
                {...hoverProps(s.key)} />
            ) : (
              <Line key={s.key} {...LINE_PROPS} dataKey={s.key} connectNulls={false}
                stroke={s.color} strokeOpacity={dimFor(s.key)}
                strokeWidth={s.dash ? 1.2 : 1.5} strokeDasharray={s.dash}
                dot={false} activeDot={{ r: 3, strokeWidth: 0 }}
                {...hoverProps(s.key)} />
            )))}
            {focus.overlay}
          </Chart>
        )}
      </TimeChart>
      {series.length > 1 && (
        <div className="runtime-legend">
          {series.map(s => (
            <div key={s.key} className="runtime-legend-item" {...hoverProps(s.key)}>
              <span className="runtime-legend-swatch" style={{ background: s.color }} />
              {s.label}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function RuntimeTab({ syncId, win, onFocus }) {
  // null is every host, averaged per JVM: the default, and what Clear returns
  // to. It survives range changes — a host that sent nothing in the new range
  // stays selected as a ghost row rather than being dropped silently.
  const [host, setHost] = useState(null)
  const roster = useMemo(() => runtimeRoster(win, host), [win, host])
  const hostName = host ? (roster.hosts.find(h => h.id === host)?.name ?? host) : 'All hosts (avg per JVM)'
  // Sampled here rather than with the rest of the page's data, because this is
  // the one panel whose series depend on something the panel itself owns.
  const runtimeMetrics = useMemo(() => runtimeMetricsForWindow(win, host), [win, host])

  // The scope strip behaves like the Detail tab's endpoint strip: it slides away
  // while the charts scroll down and back as soon as they scroll up. The charts
  // column is the scroller here, not .svc-main, so it keeps its own copy of the
  // same rule. No reset key, as before: the tab is keyed on the service, so a
  // new service mounts it, and with it the strip, afresh.
  const { reveal: stripReveal, onScroll: onChartsScroll } = useScrollReveal()

  /**
   * The panel, as a list. Order, headers and legend labels are the reference
   * platform's, down to the wording — "Buffer Memory-direct (bytes)" reads
   * oddly on its own and is left alone, because an operator who has one of
   * these screens open beside the other is comparing them line for line.
   */
  const charts = useMemo(() => {
    const rt = runtimeMetrics
    // A single-series chart has no legend, so its one tooltip row is labelled
    // with the host it was sampled from — the only thing left worth saying.
    const one = rows => [{ key: 'value', label: hostName, color: RT_COLORS.used, rows }]
    const limitRow = rows => ({ key: 'limit', label: 'limit', color: RT_COLORS.limit, rows, dash: LIMIT_DASH })
    const committedRow = rows => ({ key: 'committed', label: 'committed', color: RT_COLORS.committed, rows })
    const usedRow = rows => ({ key: 'used', label: 'used', color: RT_COLORS.used, rows })

    return [
      { title: 'CPU Used %', span: 'half', fmt: fmtRuntimePct, series: one(rt.cpuPct) },
      { title: 'Memory Used (bytes)', span: 'half', fmt: fmtBytes, series: one(rt.memUsedBytes) },
      { title: 'Thread Count', span: 'half', fmt: fmtCount, series: one(rt.threadCount) },
      {
        title: 'Class Count',
        span: 'half',
        fmt: fmtCount,
        series: [
          { key: 'count', label: 'count', color: RT_COLORS.used, rows: rt.classCount.count },
          { key: 'unloaded', label: 'unloaded', color: RT_COLORS.alt, rows: rt.classCount.unloaded },
        ],
      },
      {
        title: 'Heap Memory (bytes)',
        span: 'third',
        fmt: fmtBytes,
        series: [limitRow(rt.heap.limit), committedRow(rt.heap.committed), usedRow(rt.heap.used)],
      },
      { title: 'Non-Heap Memory Pool Used (bytes)', span: 'third', fmt: fmtBytes, series: one(rt.nonHeapPoolUsed) },
      {
        // The one filled chart in the panel. Collector time is an amount spent
        // inside each bucket rather than a level the JVM is sitting at, so the
        // two generations stack into the total the collector cost.
        title: 'Garbage Collection CPU Time',
        span: 'third',
        area: true,
        fmt: fmtCompact,
        tipFmt: fmtRuntimeMs,
        series: [
          { key: 'g1Old', label: 'G1 Old Generation', color: RT_COLORS.alt, rows: rt.gcCpuTime.g1Old },
          { key: 'g1Young', label: 'G1 Young Generation', color: RT_COLORS.used, rows: rt.gcCpuTime.g1Young },
        ],
      },
      {
        title: 'G1 Old Gen Heap (bytes)',
        span: 'third',
        fmt: fmtBytes,
        series: [limitRow(rt.g1OldGenHeap.limit), committedRow(rt.g1OldGenHeap.committed), usedRow(rt.g1OldGenHeap.used)],
      },
      {
        title: 'G1 Eden Space Heap (bytes)',
        span: 'third',
        fmt: fmtBytes,
        series: [committedRow(rt.g1EdenHeap.committed), usedRow(rt.g1EdenHeap.used)],
      },
      {
        title: 'G1 Survivor Space Heap (bytes)',
        span: 'third',
        fmt: fmtBytes,
        series: [committedRow(rt.g1SurvivorHeap.committed), usedRow(rt.g1SurvivorHeap.used)],
      },
      {
        title: 'Buffer Memory-direct (bytes)',
        span: 'half',
        fmt: fmtBytes,
        series: [limitRow(rt.bufferDirect.limit), usedRow(rt.bufferDirect.used)],
      },
      {
        title: 'Buffer Memory-mapped (bytes)',
        span: 'half',
        fmt: fmtBytes,
        series: [limitRow(rt.bufferMapped.limit), usedRow(rt.bufferMapped.used)],
      },
    ]
  }, [runtimeMetrics, hostName])

  return (
    <div className="runtime-layout">
      <RuntimeRail
        win={win}
        roster={roster}
        selectedId={host}
        onSelect={id => setHost(cur => (cur === id ? null : id))}
        onClear={() => setHost(null)}
      />
      <div className="runtime-main" onScroll={onChartsScroll}>
        <RuntimeScope win={win} roster={roster} selectedId={host} onShowAll={() => setHost(null)} reveal={stripReveal} />
        <div className="runtime-grid">
          {charts.map(c => (
            <RuntimeChart key={c.title} {...c} syncId={syncId} win={win} onFocus={onFocus} />
          ))}
        </div>
      </div>
    </div>
  )
}

export default function ServiceOverview({ serviceId, onSelectService, onOpenTrace, goHome, serviceSubTab, setServiceSubTab, serviceEndpoint, setServiceEndpoint, errorsSide, onErrorsSide, timeRange, setTimeRange, settingsOpen, setSettingsOpen, setToast, onOpenLink }) {
  // Everything this page draws comes out of one window, built once. The tables
  // and the charts are the same profiles reduced and sampled, so a headline
  // figure and the chart under it cannot disagree about the range.
  const win = useMemo(() => resolveWindow(timeRange), [timeRange])
  const services = useMemo(() => servicesForWindow(win), [win])
  const data = useMemo(() => ({
    series: seriesForWindow(win),
    bands: versionBandsForWindow(win),
    red: redEndpointsForWindow(win),
    external: externalEndpointsForWindow(win),
    db: dbEndpointsForWindow(win),
    infra: infraCorrelationForWindow(win),
    drilldown: latencyDrilldownForWindow(win),
    drilldownSeries: latencyDrilldownSeriesForWindow(win),
    drilldownTotal: latencyDrilldownTotalForWindow(win),
    slow: slowRequestsForWindow(win),
    errors: errorRequestsForWindow(win),
    // Runtime is not here: it is sampled per selected host inside RuntimeTab.
  }), [win])

  const svc = services.find(s => s.id === serviceId) || services[0]

  const [filterCategory, setFilterCategory] = useState('ALL')
  const [filterHost, setFilterHost] = useState('ALL')
  const [filterVersion, setFilterVersion] = useState('ALL')

  // Endpoint strip reveal: scrolls away with the body, then slides back down
  // from the top when the user starts scrolling up again. 'natural' = sitting
  // in flow at scroll top; 'hidden' = out of view (scrolling down); 'revealed'
  // = sticky overlay slid back down (scrolling up while past the natural pos).
  // It starts over in its place whenever the tab or the endpoint changes.
  const svcMainRef = useRef(null)
  const { reveal: stripReveal, onScroll: onSvcScroll } = useScrollReveal(`${serviceSubTab}:${serviceEndpoint}`)

  const endpoint = serviceEndpoint || data.red[0].endpoint
  const setEndpoint = setServiceEndpoint

  // The card menus offer the actions production offers; none of the screens
  // behind them - the alert builder, Explore, the comparison window - are part
  // of this redesign yet, so the menu says so rather than doing nothing.
  // An upstream in the drilldown is a call this service makes, which is what the
  // External view lists - so a row there is a link into it.
  const openExternal = useCallback(() => setServiceSubTab?.('external'), [setServiceSubTab])

  // Explore is built, so the menu's Explore item goes there instead of
  // apologising: the card's title says what it plots, and that is enough to
  // open the query builder on the nearest thing to it (ARCH D13). Only the
  // Detail tab is scoped to one endpoint, so only it carries that filter.
  const onCardAction = useCallback((action, title) => {
    const payload = explorePayloadForCard({
      action,
      title,
      serviceId,
      endpoint: serviceSubTab === 'detail' ? endpoint : '',
    })
    if (payload) {
      onOpenLink?.({ view: 'explore', ...payload })
      return
    }
    setToast?.(`${action} · ${title} - that screen is not part of this prototype yet.`)
  }, [setToast, onOpenLink, serviceId, serviceSubTab, endpoint])

  // One syncId per visible sub-tab, so hovering any chart on the page lines up
  // the x-axis indicator on every other chart that shares the same time axis.
  const syncId = `svc-${serviceSubTab}`

  // Dragging across any chart hands its span to `setTimeRange`, which is the
  // same range the window above was built from — so a drag on one chart redraws
  // every other chart on the page, and the time control agrees with all of them.

  let body
  if (serviceSubTab === 'overview') {
    body = <OverviewTab svc={svc} data={data} win={win} syncId={syncId} onFocus={setTimeRange} onOpenTrace={onOpenTrace} onOpenUpstream={openExternal} />
  } else if (serviceSubTab === 'detail') {
    body = <EndpointTab data={data} endpoint={endpoint} onOpenUpstream={openExternal} onOpenTrace={onOpenTrace} syncId={syncId} win={win} onFocus={setTimeRange} />
  } else if (serviceSubTab === 'red') {
    body = <RedTab win={win} endpoints={data.red} syncId={syncId} onFocus={setTimeRange} />
  } else if (serviceSubTab === 'external') {
    body = <ExternalTab svc={svc} data={data} syncId={syncId} win={win} onFocus={setTimeRange} />
  } else if (serviceSubTab === 'db') {
    body = <DbTab svc={svc} data={data} syncId={syncId} win={win} onFocus={setTimeRange} />
  } else if (serviceSubTab === 'errors') {
    body = <ErrorsTab win={win} timeRange={timeRange} serviceId={svc.id} onFocus={setTimeRange} syncId={syncId} onOpenLink={onOpenLink} side={errorsSide} onSide={onErrorsSide} />
  } else if (serviceSubTab === 'runtime') {
    // Keyed on the service so switching services drops the host selection.
    body = <RuntimeTab key={svc.id} syncId={syncId} win={win} onFocus={setTimeRange} />
  } else {
    body = (
      <div className="panel">
        <div className="placeholder">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="20" height="20">
            <path d="M12 2l1.6 5.4L19 9l-5.4 1.6L12 16l-1.6-5.4L5 9l5.4-1.6z" />
          </svg>
          <div>Reserved for the next redesign pass - mirrors the existing {serviceSubTab} sub-tab.</div>
        </div>
      </div>
    )
  }

  return (
    <CardActionContext.Provider value={onCardAction}>
      <PageBar
        timeRange={timeRange}
        setTimeRange={setTimeRange}
        showSettings
        settingsOpen={settingsOpen}
        setSettingsOpen={setSettingsOpen}
      >
        <a onClick={goHome}>CubeAPM</a>
        <span className="sep">/</span>
        <a className="current" onClick={goHome}>APM &amp; Services</a>
      </PageBar>
      <div className="card-tab-strip">
        <div className="subtab-row">
          <div className="subtab-left">
            <ServicePicker serviceId={svc.id} onSelect={onSelectService} />
          </div>
          <div className="subtab-filters">
            {(serviceSubTab === 'overview' || serviceSubTab === 'red') && (
              <FilterSelect label="Category" value={filterCategory} options={FILTER_OPTS.category} onSelect={setFilterCategory} />
            )}
            {/* Runtime picks its host from the rail inside the tab: the hosts
                that reported in this range, with when each was up, rather than
                a flat ALL/one-of dropdown. Two host controls disagreeing about
                which host you are looking at is worse than one. */}
            {serviceSubTab !== 'runtime' && (
              <FilterSelect label="Host" value={filterHost} options={FILTER_OPTS.host} onSelect={setFilterHost} />
            )}
            <FilterSelect label="Version" value={filterVersion} options={FILTER_OPTS.version} onSelect={setFilterVersion} />
          </div>
        </div>
        <div className="view-tabs" role="tablist" aria-label="Service views">
          {SERVICE_VIEWS.map(({ Icon, ...v }) => (
            <button
              key={v.id}
              type="button"
              role="tab"
              aria-selected={serviceSubTab === v.id}
              className={`view-tab${serviceSubTab === v.id ? ' active' : ''}`}
              onClick={() => setServiceSubTab(v.id)}
            >
              <Icon size={14} strokeWidth={1.75} aria-hidden="true" />
              {v.label}
            </button>
          ))}
        </div>
      </div>
      <div
        className={`svc-main${serviceSubTab === 'runtime' ? ' has-rail' : ''}`}
        ref={svcMainRef}
        onScroll={onSvcScroll}
      >
        {serviceSubTab === 'detail' && (
          <div className={`endpoint-strip is-sticky${revealClass(stripReveal)}`}>
            <FilterSelect
              className="is-endpoint"
              label="Endpoint"
              value={endpoint}
              options={(data.red.some(e => e.endpoint === endpoint) ? data.red : [...data.red, syntheticEndpoint(endpoint)]).map(e => e.endpoint)}
              onSelect={setEndpoint}
            />
          </div>
        )}
        {body}
      </div>
    </CardActionContext.Provider>
  )
}
