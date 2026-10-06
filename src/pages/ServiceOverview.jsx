import { useState, useMemo, useRef, useEffect, useCallback } from 'react'
import { AreaChart, Area, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { services, paymentServiceSeries, versionBands, latencyDrilldown, redEndpoints, infraCorrelation, slowRequests, errorRequests, externalEndpoints, externalEndpointCallers, dbEndpoints, slowQueries, errorGroups, tracesList, traceDetail, runtimeHosts, runtimeMetrics, FILTER_OPTS } from '@/data/services'
import { statusForLatency, statusForErrorRate, statusColor } from '@/utils/status'
import PageBar from '@/components/layout/PageBar'
import ServicePicker from '@/components/ServicePicker'
import CardMenu, { CardActionContext } from '@/components/CardMenu'
import InfoTip from '@/components/shared/InfoTip'
import Waterfall from '@/components/trace/Waterfall'
import { buildTrace } from '@/data/traceDetail'
import { Gauge, Crosshair, ChartLine, Globe, Database, TriangleAlert, Cpu } from 'lucide-react'
import { GRID_PROPS, NO_ANIM, AREA_PROPS, LINE_PROPS, timeAxisProps, valueAxisProps, maxOf, fmtCompact } from '@/components/charts/chartDefaults'

const SERVICE_VIEWS = [
  { id: 'overview', label: 'Overview', Icon: Gauge },
  { id: 'detail', label: 'Detail', Icon: Crosshair },
  { id: 'red', label: 'RED', Icon: ChartLine },
  { id: 'external', label: 'External', Icon: Globe },
  { id: 'db', label: 'DB', Icon: Database },
  { id: 'errors', label: 'Errors', Icon: TriangleAlert },
  { id: 'runtime', label: 'Runtime', Icon: Cpu },
]

const BASE_TIME = new Date()

const RED_EP_COLORS = ['#3B82F6', '#34D399', '#F472B6', '#A78BFA']

// Column sort state for a table. Clicking the header toggles asc → desc →
// unsorted. `rows` are returned already ordered. A `defaultKey` is used when
// nothing is picked.
function useSortedRows(rows, defaultKey = null, defaultDir = 'desc') {
  const [sort, setSort] = useState(defaultKey ? { key: defaultKey, dir: defaultDir } : null)
  const sorted = useMemo(() => {
    if (!sort) return rows
    const list = [...rows]
    list.sort((a, b) => {
      const av = a[sort.key], bv = b[sort.key]
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      if (typeof av === 'number' && typeof bv === 'number') return sort.dir === 'asc' ? av - bv : bv - av
      return sort.dir === 'asc'
        ? String(av).localeCompare(String(bv))
        : String(bv).localeCompare(String(av))
    })
    return list
  }, [rows, sort])
  const toggle = useCallback(key => setSort(cur => {
    if (!cur || cur.key !== key) return { key, dir: 'desc' }
    if (cur.dir === 'desc') return { key, dir: 'asc' }
    return null
  }), [])
  return { rows: sorted, sort, toggle }
}

// A header cell that participates in column sorting. The arrow follows the
// active direction, and inactive columns show a faint arrow so the control is
// discoverable before the first click.
function SortableTh({ sortKey, sort, onToggle, children, align = 'right', style }) {
  const active = sort?.key === sortKey
  const dir = active ? sort.dir : null
  return (
    <th
      className="sortable-th"
      style={{ textAlign: align, cursor: 'pointer', userSelect: 'none', ...style }}
      onClick={() => onToggle(sortKey)}
      aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <span className={`sortable-th-inner${align === 'left' ? ' align-left' : ''}`}>
        <span>{children}</span>
        <svg className={`sortable-th-arrow${active ? ' active' : ''}${dir === 'asc' ? ' asc' : ''}`}
          viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8v8M9 13l3 3 3-3" />
        </svg>
      </span>
    </th>
  )
}

// Build a believable mini time-series around a steady-state value. The spread
// is proportional to the value, and the seed keeps renders stable.
function buildHoverSeries(baseValue, seed, points = 30) {
  let s = seed
  const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280 }
  const spread = Math.max(0.08, Math.min(0.35, 0.15))
  return Array.from({ length: points }, (_, i) => {
    const m = points - 1 - i
    return { m, value: baseValue * (1 + (rnd() - 0.5) * spread * 2) }
  })
}

// Floating mini-chart that renders beside a hovered cell. The parent attaches
// `onMouseEnter`/`onMouseLeave` on the cells and keeps `anchor`+`title`+`series`
// in state; this component places itself relative to the anchor rect.
function HoverChartPopover({ anchor, title, series, color = '#3B82F6', formatVal = v => Math.round(v), unit = '', onEnter, onLeave }) {
  if (!anchor) return null
  const data = useMemo(() => chartData(series), [series])
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
      <div style={{ width: '100%', height: H - 32 }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 6, right: 6, left: 0, bottom: 0 }}>
            <CartesianGrid {...GRID_PROPS} />
            <XAxis {...timeAxisProps(data.length)} />
            <YAxis {...valueAxisProps({ maxValue: maxOf(data, 'value'), format: v => `${formatVal(v)}${unit}` })} />
            <Tooltip content={<SvcTooltip color={color} unit={unit} formatVal={formatVal} />} {...NO_ANIM} />
            <Area {...AREA_PROPS} dataKey="value" stroke={color} fill={color} strokeWidth={1.4}
              dot={false} activeDot={{ r: 3 }} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
const fmtRedMs = v => `${Math.round(v)} ms`
const fmtRedRpm = v => v >= 1000 ? `${(v / 1000).toFixed(1)}K` : Math.round(v).toString()
const fmtRedPct = v => `${v.toFixed(2)}%`

function chartData(series) {
  return series.map(d => {
    const t = new Date(BASE_TIME.getTime() - d.m * 60 * 1000)
    const hh = t.getHours().toString().padStart(2, '0')
    const mm = t.getMinutes().toString().padStart(2, '0')
    return { label: d.m === 0 ? 'now' : `-${d.m}m`, exactTime: `${hh}:${mm}`, value: d.value }
  })
}

function SvcTooltip({ active, payload, label, color, unit, formatVal }) {
  if (!active || !payload?.length) return null
  const exactTime = payload[0]?.payload?.exactTime || ''
  const raw = payload[0]?.value
  const val = formatVal ? formatVal(raw) : (raw != null ? String(Math.round(raw * 100) / 100) : '')
  return (
    <div style={{ background: 'var(--raised)', border: '1px solid var(--border-panel)', borderRadius: 6, padding: '5px 9px', fontSize: 11, lineHeight: '1.5' }}>
      <div style={{ color: 'var(--text-primary)', fontWeight: 600, marginBottom: 1 }}>{exactTime}</div>
      <div style={{ color: 'var(--text-muted)', fontSize: 10, marginBottom: 3 }}>{label}</div>
      <div style={{ color, fontWeight: 600 }}>{val}{unit}</div>
    </div>
  )
}

function DrilldownTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  const exactTime = payload[0]?.payload?.exactTime || ''
  const total = payload.reduce((s, p) => s + (p.value || 0), 0)
  return (
    <div style={{ background: 'var(--raised)', border: '1px solid var(--border-panel)', borderRadius: 6, padding: '6px 10px', fontSize: 11, lineHeight: '1.5', minWidth: 200 }}>
      <div style={{ color: 'var(--text-primary)', fontWeight: 600, marginBottom: 1 }}>{exactTime}</div>
      <div style={{ color: 'var(--text-muted)', fontSize: 10, marginBottom: 4 }}>{label}</div>
      {[...payload].reverse().map(p => (
        <div key={p.dataKey} style={{ color: p.fill, display: 'flex', justifyContent: 'space-between', gap: 16 }}>
          <span style={{ flexShrink: 1 }}>{p.dataKey}</span>
          <span style={{ fontWeight: 600, flexShrink: 0 }}>{Math.round(p.value)} ms</span>
        </div>
      ))}
      <div style={{ borderTop: '1px solid var(--border-panel)', marginTop: 5, paddingTop: 5, color: 'var(--text-primary)', fontWeight: 600, display: 'flex', justifyContent: 'space-between', gap: 16 }}>
        <span>Total</span><span>{Math.round(total)} ms</span>
      </div>
    </div>
  )
}

function RedChartTooltip({ active, payload, label, eps, colors, fmtFn }) {
  if (!active || !payload?.length) return null
  const exactTime = payload[0]?.payload?.exactTime || ''
  return (
    <div style={{ background: 'var(--raised)', border: '1px solid var(--border-panel)', borderRadius: 6, padding: '5px 9px', fontSize: 11, lineHeight: '1.5', minWidth: 180 }}>
      <div style={{ color: 'var(--text-primary)', fontWeight: 600, marginBottom: 1 }}>{exactTime}</div>
      <div style={{ color: 'var(--text-muted)', fontSize: 10, marginBottom: 4 }}>{label}</div>
      {payload.map(p => {
        const ei = parseInt(p.dataKey.replace('ep', ''), 10)
        const ep = eps[ei]?.endpoint || ''
        const short = ep.length > 28 ? ep.slice(0, 26) + '…' : ep
        return (
          <div key={p.dataKey} style={{ color: colors[ei], display: 'flex', justifyContent: 'space-between', gap: 16 }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 140, whiteSpace: 'nowrap' }}>{short}</span>
            <span style={{ fontWeight: 600, flexShrink: 0 }}>{fmtFn(p.value)}</span>
          </div>
        )
      })}
    </div>
  )
}

function SparkChart({ series, color, unit = '', formatVal, syncId }) {
  const data = useMemo(() => chartData(series), [series])
  return (
    <div style={{ width: '100%', height: '100%' }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }} syncId={syncId} syncMethod="value">
          <CartesianGrid {...GRID_PROPS} />
          <XAxis {...timeAxisProps(data.length)} />
          <YAxis {...valueAxisProps({ maxValue: maxOf(data, 'value') })} />
          <Tooltip content={<SvcTooltip color={color} unit={unit} formatVal={formatVal} />} {...NO_ANIM} />
          <Area {...AREA_PROPS} dataKey="value" stroke={color} strokeWidth={1.8} fill={color} dot={false} activeDot={{ r: 3 }} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
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
function EndpointTab({ endpoint, setEndpoint, onOpenUpstream, onOpenTrace, syncId }) {
  // An endpoint arriving from a log record will often not be in the RED list -
  // that list is what the service page happens to chart, not everything the
  // service serves. Showing the picker's first row instead would quietly answer
  // a different question from the one the link asked, so an unknown endpoint is
  // added to the list and given figures of its own.
  const eps = useMemo(() => (
    endpoint && !redEndpoints.some(e => e.endpoint === endpoint)
      ? [...redEndpoints, syntheticEndpoint(endpoint)]
      : redEndpoints
  ), [endpoint])
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
  const hits = dbEndpoints.slice(0, 3).map(d => ({ name: d.endpoint ?? d.query ?? 'call', count: 1 }))

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
        onOpenUpstream={onOpenUpstream}
        p90Series={paymentServiceSeries.latencyP90}
        p90EndpointLabel={ep.endpoint}
        syncId={syncId}
      />
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
                <td className="num mono">{h.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <TrendCharts syncId={syncId} />
      <SlowRequests onOpenTrace={onOpenTrace} />
      <SlowRequests onOpenTrace={onOpenTrace} data={errorRequests} title="Requests with Errors" initialSort="none" />
      <InfraCorrelation />
    </>
  )
}

function LatencyDrilldown({ onOpenUpstream, p90Series, p90EndpointLabel, syncId }) {
  const layers = latencyDrilldown
  const total = layers.reduce((a, b) => a + b.ms, 0)
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

  const N = 30, INCIDENT_IDX = 18
  const baselines = [40, 18, 12, 14], peaks = layers.map(d => d.ms)

  const data = useMemo(() => Array.from({ length: N }, (_, i) => {
    const minsAgo = (N - 1 - i) * 2
    const t = new Date(BASE_TIME.getTime() - minsAgo * 60 * 1000)
    const hh = t.getHours().toString().padStart(2, '0')
    const mm = t.getMinutes().toString().padStart(2, '0')
    const label = minsAgo === 0 ? 'now' : `-${minsAgo}m`
    const ramp = i < INCIDENT_IDX ? 0 : Math.min(1, (i - INCIDENT_IDX) / 5)
    const entry = { label, exactTime: `${hh}:${mm}` }
    let sum = 0
    layers.forEach((layer, li) => {
      const j = Math.sin(i * 4.1 + li * 2.3) * 0.06 + Math.cos(i * 7.7 + li * 1.1) * 0.04
      const v = (baselines[li] + (peaks[li] - baselines[li]) * ramp) * (1 + j)
      entry[layer.label] = v
      sum += v
    })
    entry.Total = sum
    return entry
  }), [])

  // Hover-dim: when the pointer is on one legend row, the other rows and the
  // areas they draw fade out, so the one in focus reads as the only series.
  const [hoverKey, setHoverKey] = useState(null)
  const dimOpacityFor = (key) => (hoverKey == null || hoverKey === key ? 1 : 0.22)

  const p90Data = useMemo(() => p90Series ? chartData(p90Series) : null, [p90Series])

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
            <div style={{ width: '100%', height: 260 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={p90Data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} syncId={syncId} syncMethod="value">
                  <CartesianGrid {...GRID_PROPS} />
                  <XAxis {...timeAxisProps(p90Data.length)} />
                  <YAxis {...valueAxisProps({ format: v => `${Math.round(v)} ms`, maxValue: maxOf(p90Data, 'value') })} />
                  <Tooltip content={<SvcTooltip color="#F472B6" unit=" ms" formatVal={v => Math.round(v)} />} {...NO_ANIM} />
                  <Line {...LINE_PROPS} dataKey="value" stroke="#F472B6" strokeWidth={1.6} dot={false} activeDot={{ r: 3, strokeWidth: 0 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
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
          <div style={{ width: '100%', height: 260 }}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} syncId={syncId} syncMethod="value">
                <CartesianGrid {...GRID_PROPS} />
                <XAxis {...timeAxisProps(data.length)} />
                <YAxis {...valueAxisProps({ maxValue: selected ? maxOf(data, [selected]) : total })} />
                <Tooltip content={<DrilldownTooltip />} {...NO_ANIM} />
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
                {!selected && (
                  <Area {...AREA_PROPS} dataKey="Total" stroke="var(--text-secondary)" fill="none"
                    strokeOpacity={dimOpacityFor('Total')}
                    strokeWidth={1.4} strokeDasharray="4 3" dot={false} activeDot={{ r: 3, strokeWidth: 0 }}
                    onMouseEnter={() => setHoverKey('Total')}
                    onMouseLeave={() => setHoverKey(null)} />
                )}
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
        <div className="drill2-legend">
          <div className="drill2-search">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>
            <input
              type="search"
              aria-label="Search upstreams"
              placeholder="Search upstreams…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
          {shown.map(d => {
            const pct = ((d.ms / total) * 100).toFixed(1)
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
                  <span className="drill2-pct">{pct}%</span>
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
                <div className="drill2-bartrack"><div className="drill2-barfill" style={{ width: `${pct}%`, background: d.color, opacity: 0.75 }} /></div>
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
            <span className="drill2-total-val">{total} ms</span>
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

function VersionTooltip({ active, payload, label, unit, formatVal }) {
  if (!active || !payload?.length) return null
  // One version is serving at a time; listing the idle thirteen would bury it.
  const live = payload.filter(p => p.value != null && p.value !== 0)
  if (!live.length) return null
  const exactTime = payload[0]?.payload?.exactTime || ''
  return (
    <div style={{ background: 'var(--raised)', border: '1px solid var(--border-panel)', borderRadius: 6, padding: '6px 10px', fontSize: 11, lineHeight: '1.5', minWidth: 150 }}>
      <div style={{ color: 'var(--text-primary)', fontWeight: 600, marginBottom: 1 }}>{exactTime}</div>
      <div style={{ color: 'var(--text-muted)', fontSize: 10, marginBottom: 4 }}>{label}</div>
      {live.map(p => (
        <div key={p.dataKey} style={{ color: p.color || p.stroke, display: 'flex', justifyContent: 'space-between', gap: 14 }}>
          <span className="mono">{p.dataKey}</span>
          <span style={{ fontWeight: 600, flexShrink: 0 }}>{formatVal(p.value)}{unit}</span>
        </div>
      ))}
    </div>
  )
}

function TrendChart({ title, members, stack = false, domain, unit = '', formatVal, syncId }) {
  const data = useMemo(() => members[0].series.map((d, i) => {
    const t = new Date(BASE_TIME.getTime() - d.m * 60 * 1000)
    const hh = t.getHours().toString().padStart(2, '0')
    const mm = t.getMinutes().toString().padStart(2, '0')
    const entry = { label: d.m === 0 ? 'now' : `-${d.m}m`, exactTime: `${hh}:${mm}` }
    members.forEach(mem => { entry[mem.label] = mem.series[i]?.value })
    return entry
  }), [members])

  const keys = useMemo(() => members.map(m => m.label), [members])
  // Only one band carries a value per minute, so the tallest member is also the
  // tallest stack - no need to sum across keys for the axis gutter.
  const peak = useMemo(() => maxOf(data, keys), [data, keys])
  const axis = valueAxisProps({ maxValue: peak, ...(domain ? { domain } : null) })
  const tip = <Tooltip content={<VersionTooltip unit={unit} formatVal={formatVal} />} {...NO_ANIM} />

  return (
    <div className="chart-card">
      <div className="clbl"><span className="clbl-text">{title}</span><CardMenu kind="chart" title={title} /></div>
      <div className="chart-host">
        <ResponsiveContainer width="100%" height="100%">
          {stack ? (
            <AreaChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }} syncId={syncId} syncMethod="value">
              <CartesianGrid {...GRID_PROPS} />
              <XAxis {...timeAxisProps(data.length)} />
              <YAxis {...axis} />
              {tip}
              {keys.map((k, i) => (
                <Area key={k} {...AREA_PROPS} dataKey={k} stackId="s"
                  stroke={VERSION_COLORS[i % VERSION_COLORS.length]}
                  fill={VERSION_COLORS[i % VERSION_COLORS.length]}
                  fillOpacity={0.3} strokeWidth={1.3}
                  dot={false} activeDot={{ r: 3, strokeWidth: 0 }} />
              ))}
            </AreaChart>
          ) : (
            <LineChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }} syncId={syncId} syncMethod="value">
              <CartesianGrid {...GRID_PROPS} />
              <XAxis {...timeAxisProps(data.length)} />
              <YAxis {...axis} />
              {tip}
              {keys.map((k, i) => (
                <Line key={k} {...LINE_PROPS} dataKey={k} connectNulls={false}
                  stroke={VERSION_COLORS[i % VERSION_COLORS.length]}
                  strokeWidth={1.3} dot={false} activeDot={{ r: 3, strokeWidth: 0 }} />
              ))}
            </LineChart>
          )}
        </ResponsiveContainer>
      </div>
    </div>
  )
}

function TrendCharts({ syncId }) {
  return (
    <div className="charts-row">
      <TrendChart title="RPM" members={versionBands.rpm} stack unit=" rpm"
        formatVal={v => (v == null ? '' : Math.round(v))} syncId={syncId} />
      <TrendChart title="Error %" members={versionBands.errorRatePct} unit="%"
        formatVal={v => (v == null ? '' : v.toFixed(2))} syncId={syncId} />
      <TrendChart title="Apdex" members={versionBands.apdex} domain={[0, 1]}
        formatVal={v => (v == null ? '' : v.toFixed(2))} syncId={syncId} />
    </div>
  )
}

const SLOWREQ_SORTS = [
  { id: 'latency', label: 'Latency' },
  { id: 'time', label: 'Time' },
  { id: 'none', label: 'None' },
]

function SlowRequests({ onOpenTrace, data = slowRequests, title = 'Slow Requests', initialSort = 'latency' }) {
  const [sortBy, setSortBy] = useState(initialSort)
  const [selected, setSelected] = useState(null)
  const [collapsed, setCollapsed] = useState(() => new Set())
  const [span, setSpan] = useState(null)

  const rows = useMemo(() => {
    if (sortBy === 'none') return data
    const list = [...data]
    if (sortBy === 'latency') list.sort((a, b) => b.latencyMs - a.latencyMs)
    else list.sort((a, b) => parseInt(a.timestamp, 10) - parseInt(b.timestamp, 10))
    return list
  }, [sortBy, data])

  const row = selected ? rows.find(r => r.traceId === selected) : null

  const trace = useMemo(() => row ? buildTrace(row.traceId) : null, [row?.traceId])

  const toggle = useCallback(id => setCollapsed(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  }), [])

  return (
    <div className="panel">
      <div className="panel-head is-divided">
        <div className="panel-head-left">{title}</div>
        <div className="panel-head-right">
          <span className="sort-lbl">Sort by</span>
          <div className="seg-toggle">
            {SLOWREQ_SORTS.map(s => (
              <div key={s.id} className={`seg${sortBy === s.id ? ' active' : ''}`} onClick={() => setSortBy(s.id)}>{s.label}</div>
            ))}
          </div>
          <CardMenu kind="list" title={title} />
        </div>
      </div>
      <div className="slowreq-split">
        <div className="slowreq-list">
          {rows.map(r => (
            <button
              type="button"
              className={`slowreq-row${r.traceId === selected ? ' selected' : ''}`}
              key={r.traceId}
              onClick={() => setSelected(r.traceId)}
              aria-pressed={r.traceId === selected}
            >
              <div>
                <div className="ep">{r.endpoint}</div>
                <div className="meta">{r.timestamp} · trace <span className="mono">{r.traceId}</span></div>
              </div>
              <div className="dur">{r.latencyMs} ms</div>
            </button>
          ))}
        </div>
        <div className="slowreq-preview">
          {row ? (
            <>
              <div className="slowreq-preview-head">
                <span className="slowreq-preview-ep">{row.endpoint}</span>
                <button
                  type="button"
                  className="slowreq-trace-link"
                  onClick={() => onOpenTrace?.(row.traceId)}
                  title={`Open trace ${row.traceId} in trace details`}
                >
                  Trace ID · <span className="mono">{row.traceId}</span>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M14 4h6v6M20 4l-8 8M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5" />
                  </svg>
                </button>
              </div>
              {trace ? (
                <div className="slowreq-waterfall">
                  <Waterfall
                    trace={trace}
                    selected={span}
                    onSelect={setSpan}
                    collapsed={collapsed}
                    onToggle={toggle}
                  />
                </div>
              ) : (
                <div className="drill2-empty">No spans recorded for this trace.</div>
              )}
            </>
          ) : (
            <div className="slowreq-empty">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 12h4l3-9 4 18 3-9h4" />
              </svg>
              <span>Select a request to view its trace</span>
            </div>
          )}
        </div>
      </div>
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

function InfraCorrelation() {
  const rowsWithAvg = useMemo(
    () => infraCorrelation.map(h => ({ ...h, latencyAvg: h.latencyAvg ?? Math.round(h.latencyP90 * 0.55) })),
    []
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

  const onEnter = useCallback((e, host, metric, value) => {
    cancelClose()
    setHover({
      anchor: e.currentTarget,
      title: `${INFRA_METRICS[metric].label} · ${host}`,
      series: buildHoverSeries(value, host.length * 13 + metric.length * 7),
      color: INFRA_METRICS[metric].color,
      unit: INFRA_METRICS[metric].unit,
      fmt: INFRA_METRICS[metric].fmt,
    })
  }, [cancelClose])

  const Cell = ({ host, metric, value }) => (
    <td className="hoverable-cell"
      onMouseEnter={e => onEnter(e, host, metric, value)}
      onMouseLeave={scheduleClose}
    >
      {INFRA_METRICS[metric].fmt(value)}{INFRA_METRICS[metric].unit}
    </td>
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
              <Cell host={h.host} metric="rpm" value={h.rpm} />
              <Cell host={h.host} metric="latencyP90" value={h.latencyP90} />
              <Cell host={h.host} metric="latencyAvg" value={h.latencyAvg} />
              <Cell host={h.host} metric="errorRatePct" value={h.errorRatePct} />
              <Cell host={h.host} metric="cpuUsedPct" value={h.cpuUsedPct} />
              <Cell host={h.host} metric="memUsedPct" value={h.memUsedPct} />
            </tr>
          ))}
        </tbody>
      </table>
      {hover && (
        <HoverChartPopover
          anchor={hover.anchor}
          title={hover.title}
          series={hover.series}
          color={hover.color}
          unit={hover.unit}
          formatVal={hover.fmt}
          onEnter={cancelClose}
          onLeave={scheduleClose}
        />
      )}
    </div>
  )
}

// The table/graph choice belongs to the page rather than the panel - it now
// sits in the filter strip beside Category, Host and Version, which is where a
// reader already goes to change what the page is showing.
function RedViewToggle({ view, setView }) {
  const isGraph = view === 'graph'
  return (
    <div className="view-toggle">
      <button
        type="button"
        className={`view-toggle-btn${!isGraph ? ' active' : ''}`}
        onClick={() => setView('table')}
        title="Table view"
        aria-pressed={!isGraph}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M3 15h18M9 3v18" /></svg>
        <span>Table</span>
      </button>
      <button
        type="button"
        className={`view-toggle-btn${isGraph ? ' active' : ''}`}
        onClick={() => setView('graph')}
        title="Graph view"
        aria-pressed={isGraph}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12" /></svg>
        <span>Graph</span>
      </button>
    </div>
  )
}

function RedDrilldownChart({ title, eps, dataKey, fmtFn, syncId }) {
  const [selected, setSelected] = useState(null)
  const [hoverKey, setHoverKey] = useState(null)
  const dimOpacityFor = (key) => (hoverKey == null || hoverKey === key ? 1 : 0.22)

  const shownIdxs = eps.map((_, i) => i)
  const chartIdxs = selected != null ? [selected] : shownIdxs

  const data = useMemo(() => {
    const N = 30, INC = 18
    return Array.from({ length: N }, (_, i) => {
      const minsAgo = (N - 1 - i) * 2
      const t = new Date(BASE_TIME.getTime() - minsAgo * 60 * 1000)
      const hh = t.getHours().toString().padStart(2, '0')
      const mm = t.getMinutes().toString().padStart(2, '0')
      const entry = { label: minsAgo === 0 ? 'now' : `-${minsAgo}m`, exactTime: `${hh}:${mm}` }
      eps.forEach((ep, ei) => {
        const base = ep[dataKey]
        const j = Math.sin(i * 3.7 + ei * 2.1) * 0.09 + Math.cos(i * 6.3 + ei * 1.4) * 0.05
        const spike = i >= INC ? Math.min(1, (i - INC) / 6) * (ep.errPct > 3 ? 0.28 : 0.04) : 0
        entry[`ep${ei}`] = base * (1 + j + spike)
      })
      return entry
    })
  }, [eps, dataKey])

  return (
    <div className="red-chart-section">
      <div className="red-chart-head">
        <span>{title}</span>
        <CardMenu kind="chart" title={title} />
      </div>
      <div className="drill2">
        <div className="drill2-chart">
          <div style={{ width: '100%', height: 260 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} syncId={syncId} syncMethod="value">
                <CartesianGrid {...GRID_PROPS} />
                <XAxis {...timeAxisProps(data.length)} />
                <YAxis {...valueAxisProps({ format: fmtFn, maxValue: maxOf(data, chartIdxs.map(i => `ep${i}`)) })} />
                <Tooltip content={p => <RedChartTooltip {...p} eps={eps} colors={RED_EP_COLORS} fmtFn={fmtFn} />} {...NO_ANIM} />
                {chartIdxs.map(ei => (
                  <Line key={ei} {...LINE_PROPS} dataKey={`ep${ei}`} stroke={RED_EP_COLORS[ei]}
                    strokeOpacity={dimOpacityFor(`ep${ei}`)}
                    strokeWidth={1.5} dot={false} activeDot={{ r: 3, strokeWidth: 0 }}
                    onMouseEnter={() => setHoverKey(`ep${ei}`)}
                    onMouseLeave={() => setHoverKey(null)} />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
        <div className="drill2-legend">
          {shownIdxs.map(ei => {
            const dimmed = selected != null && selected !== ei
            return (
              <div
                className={`drill2-item${dimmed ? ' dimmed' : ''}`}
                key={ei}
                onClick={() => setSelected(s => s === ei ? null : ei)}
                onMouseEnter={() => setHoverKey(`ep${ei}`)}
                onMouseLeave={() => setHoverKey(null)}
              >
                <div className="drill2-row">
                  <span className="drill2-swatch" style={{ background: RED_EP_COLORS[ei] }} />
                  <span className="drill2-label">{eps[ei].endpoint}</span>
                  <span className="drill2-val">{fmtFn(eps[ei][dataKey])}</span>
                </div>
              </div>
            )
          })}
        </div>
      </div>
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
      <div className="panel-head">
        <div className="panel-head-left">Slow Queries</div>
        <CardMenu kind="list" title="Slow Queries" />
      </div>
      <div className="split-ep-head is-sortable" style={{ gridTemplateColumns: '130px 1fr 84px' }}>
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
// container and a search box: typing filters the table rows and every chart's
// lines at once, and switching view keeps whatever was typed.
function RedTab({ syncId }) {
  const [view, setView] = useState('table')
  const [search, setSearch] = useState('')
  const isGraph = view === 'graph'
  const eps = redEndpoints.slice(0, 4)

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return q ? redEndpoints.filter(e => e.endpoint.toLowerCase().includes(q)) : redEndpoints
  }, [search])

  return (
    <div className="panel">
      <div className="panel-head is-divided red-table-head">
        <div className="panel-head-left red-head-left">
          <RedViewToggle view={view} setView={setView} />
          {!isGraph && (
            <input
              type="search"
              className="red-table-search"
              placeholder="Search"
              aria-label="Search endpoints"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          )}
        </div>
        {!isGraph && <CardMenu kind="table" title="RED" columns={RED_COLUMNS} />}
      </div>
      {isGraph ? (
        <>
          <RedDrilldownChart title="RPM" eps={eps} dataKey="rpm" fmtFn={fmtRedRpm} syncId={syncId} />
          <RedDrilldownChart title="Response Time (p90)" eps={eps} dataKey="p90" fmtFn={fmtRedMs} syncId={syncId} />
          <RedDrilldownChart title="Response Time (avg)" eps={eps} dataKey="avg" fmtFn={fmtRedMs} syncId={syncId} />
          <RedDrilldownChart title="Error %" eps={eps} dataKey="errPct" fmtFn={fmtRedPct} syncId={syncId} />
        </>
      ) : (
        <RedEndpointsTable rows={filtered} />
      )}
    </div>
  )
}

function RedEndpointsTable({ rows: input }) {
  const { rows, sort, toggle } = useSortedRows(input, 'timeConsumedPct', 'desc')
  return (
      <table>
        <thead>
          <tr>
            <SortableTh sortKey="endpoint" sort={sort} onToggle={toggle} align="left">Endpoint</SortableTh>
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
            const errS = statusForErrorRate(e.errPct)
            return (
              <tr key={e.endpoint}>
                <td className="mono" style={{ textAlign: 'left' }}>{e.endpoint}</td>
                <td>{e.totalReq}</td>
                <td>
                  <span className="cell-bar">
                    <span className="track"><span className="fill" style={{ width: `${Math.min(100, e.timeConsumedPct)}%`, background: 'var(--brand)' }} /></span>
                    <span>{e.timeConsumedPct}%</span>
                  </span>
                </td>
                <td>{e.rpm}</td>
                <td className="val-critical">{e.p90} ms</td>
                <td>{e.avg} ms</td>
                <td>
                  <span className="cell-bar">
                    <span className="track"><span className="fill" style={{ width: `${Math.min(100, e.errPct * 12)}%`, background: statusColor(errS) }} /></span>
                    <span className={errS === 'critical' ? 'val-critical' : errS === 'warning' ? 'val-warning' : ''}>{e.errPct}%</span>
                  </span>
                </td>
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
  )
}

function MiniChart({ series, color, unit = '', formatVal, height = 130, syncId }) {
  const data = useMemo(() => chartData(series), [series])
  return (
    <div style={{ width: '100%', height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }} syncId={syncId} syncMethod="value">
          <CartesianGrid {...GRID_PROPS} />
          <XAxis {...timeAxisProps(data.length)} />
          <YAxis {...valueAxisProps({ maxValue: maxOf(data, 'value') })} />
          <Tooltip content={<SvcTooltip color={color} unit={unit} formatVal={formatVal} />} {...NO_ANIM} />
          <Area {...AREA_PROPS} dataKey="value" stroke={color} strokeWidth={1.6} fill={color} dot={false} activeDot={{ r: 3 }} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

// Multi-line chart used by the External and (potentially) DB tabs when nothing
// is selected: one line per endpoint, series identity carried by colour. Shares
// the time cursor with the rest of the page via syncId. hoverKey is lifted so
// that hovering a line here or a swatch in the shared legend dims the same
// series across every chart in the group.
function MultiLineChart({ seriesList, unit = '', formatVal, height = 130, syncId, hoverKey, setHoverKey }) {
  const data = useMemo(() => {
    const base = seriesList[0]?.data || []
    return base.map((p, i) => {
      const t = new Date(BASE_TIME.getTime() - p.m * 60 * 1000)
      const hh = t.getHours().toString().padStart(2, '0')
      const mm = t.getMinutes().toString().padStart(2, '0')
      const row = { label: p.m === 0 ? 'now' : `-${p.m}m`, exactTime: `${hh}:${mm}` }
      seriesList.forEach(s => { row[s.key] = s.data[i]?.value })
      return row
    })
  }, [seriesList])
  const keys = seriesList.map(s => s.key)
  const opacityFor = key => (hoverKey == null || hoverKey === key ? 1 : 0.18)
  return (
    <div style={{ width: '100%', height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }} syncId={syncId} syncMethod="value">
          <CartesianGrid {...GRID_PROPS} />
          <XAxis {...timeAxisProps(data.length)} />
          <YAxis {...valueAxisProps({ maxValue: maxOf(data, keys), format: formatVal })} />
          <Tooltip content={<MultiSeriesTooltip seriesList={seriesList} unit={unit} formatVal={formatVal} hoverKey={hoverKey} />} {...NO_ANIM} />
          {seriesList.map(s => (
            <Line key={s.key} {...LINE_PROPS} dataKey={s.key} stroke={s.color}
              strokeWidth={1.5} strokeOpacity={opacityFor(s.key)}
              dot={false} activeDot={{ r: 3, strokeWidth: 0 }}
              onMouseEnter={() => setHoverKey?.(s.key)}
              onMouseLeave={() => setHoverKey?.(null)} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

function MultiSeriesTooltip({ active, payload, label, seriesList, unit, formatVal, hoverKey }) {
  if (!active || !payload?.length) return null
  const exactTime = payload[0]?.payload?.exactTime || ''
  const byKey = Object.fromEntries(seriesList.map(s => [s.key, s]))
  const rows = hoverKey ? payload.filter(p => p.dataKey === hoverKey) : payload
  return (
    <div style={{ background: 'var(--raised)', border: '1px solid var(--border-panel)', borderRadius: 6, padding: '5px 9px', fontSize: 11, lineHeight: '1.5', minWidth: 200 }}>
      <div style={{ color: 'var(--text-primary)', fontWeight: 600, marginBottom: 1 }}>{exactTime}</div>
      <div style={{ color: 'var(--text-muted)', fontSize: 10, marginBottom: 4 }}>{label}</div>
      {rows.map(p => {
        const s = byKey[p.dataKey]
        if (!s) return null
        const val = formatVal ? formatVal(p.value) : (p.value != null ? String(Math.round(p.value * 100) / 100) : '')
        const short = s.label.length > 28 ? s.label.slice(0, 26) + '…' : s.label
        return (
          <div key={p.dataKey} style={{ color: s.color, display: 'flex', justifyContent: 'space-between', gap: 16 }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 150, whiteSpace: 'nowrap' }}>{short}</span>
            <span style={{ fontWeight: 600, flexShrink: 0 }}>{val}{unit}</span>
          </div>
        )
      })}
    </div>
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
        <input placeholder="Search endpoints…" value={search} onChange={e => setSearch(e.target.value)} />
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
              <span className="track"><span className="fill" style={{ width: `${e.timeConsumedPct}%` }} /></span>
              <span className="split-ep-cell dim">{e.timeConsumedPct}%</span>
            </div>
            <div className="split-ep-cell">{e.rpm >= 1000 ? (e.rpm / 1000).toFixed(1) + 'K' : e.rpm.toFixed(1)}</div>
            <div className="split-ep-cell dim">{e.avg}ms</div>
            <div className={`split-ep-cell ${errS === 'critical' ? 'val-critical' : errS === 'warning' ? 'val-warning' : 'dim'}`}>{e.errPct}%</div>
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

function ExternalTab({ svc, syncId }) {
  const [sel, setSel] = useState(null)
  const [hoverKey, setHoverKey] = useState(null)
  const ep = sel != null ? externalEndpoints[sel] : null

  const scale = (baseSeries, factor) => baseSeries.map(d => ({ m: d.m, value: d.value * factor }))
  const seriesFor = (e, i) => ({
    key: `ep${i}`,
    label: externalShortLabel(e.endpoint),
    color: RED_EP_COLORS[i % RED_EP_COLORS.length],
    lat: scale(paymentServiceSeries.latencyAvg, e.avg / 78),
    rpm: scale(paymentServiceSeries.rpm, e.rpm / 452),
    err: scale(paymentServiceSeries.errorRatePct, Math.max(e.errPct / 0.05, 0.5)),
  })
  const perEp = useMemo(() => externalEndpoints.map(seriesFor), [])

  // Single-endpoint mode re-uses MiniChart's single area; multi mode shows a
  // line per endpoint with a shared legend under the three charts.
  const latSeries = ep ? scale(paymentServiceSeries.latencyAvg, ep.avg / 78) : null
  const rpmSeries = ep ? scale(paymentServiceSeries.rpm, ep.rpm / 452) : null
  const errSeries = ep ? scale(paymentServiceSeries.errorRatePct, Math.max(ep.errPct / 0.05, 0.5)) : null

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
          endpoints={externalEndpoints}
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
                ? <MiniChart syncId={syncId} series={latSeries} color="#3B82F6" unit=" ms" formatVal={v => Math.round(v)} />
                : <MultiLineChart syncId={syncId} seriesList={latMulti} unit=" ms" formatVal={v => Math.round(v)} hoverKey={hoverKey} setHoverKey={setHoverKey} />}
            </div>
          </div>
          <div className="split-chart-card">
            <div className="clbl"><span className="clbl-text">RPM</span><CardMenu kind="chart" title="RPM" /></div>
            <div className="chart-host">
              {ep
                ? <MiniChart syncId={syncId} series={rpmSeries} color="#A78BFA" unit=" rpm" formatVal={v => Math.round(v)} />
                : <MultiLineChart syncId={syncId} seriesList={rpmMulti} unit=" rpm" formatVal={v => Math.round(v)} hoverKey={hoverKey} setHoverKey={setHoverKey} />}
            </div>
          </div>
          <div className="split-chart-card">
            <div className="clbl"><span className="clbl-text">Error %</span><CardMenu kind="chart" title="Error %" /></div>
            <div className="chart-host">
              {ep
                ? <MiniChart syncId={syncId} series={errSeries} color="#F472B6" unit="%" formatVal={v => v.toFixed(2)} />
                : <MultiLineChart syncId={syncId} seriesList={errMulti} unit="%" formatVal={v => v.toFixed(2)} hoverKey={hoverKey} setHoverKey={setHoverKey} />}
            </div>
          </div>
          {!ep && (
            <div className="split-chart-legend">
              {perEp.map(s => {
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
              <span className="track"><span className="fill" style={{ width: `${r.timeConsumedPct}%` }} /></span>
              <span className="split-ep-cell dim">{r.timeConsumedPct}%</span>
            </div>
            <div className="split-ep-cell">{r.rpm >= 1000 ? (r.rpm / 1000).toFixed(1) + 'K' : r.rpm.toFixed(1)}</div>
            <div className="split-ep-cell dim">{r.avg}ms</div>
            <div className={`split-ep-cell ${errS === 'critical' ? 'val-critical' : errS === 'warning' ? 'val-warning' : 'dim'}`}>{r.errPct}%</div>
          </div>
        )
      })}
      {sorted.length === 0 && (
        <div className="err-empty">No endpoints call this external endpoint</div>
      )}
    </div>
  )
}

function DbTab({ svc, syncId }) {
  const [sel, setSel] = useState(2)
  const ep = dbEndpoints[sel] || dbEndpoints[0]

  const scale = (baseSeries, factor) => baseSeries.map(d => ({ m: d.m, value: d.value * factor }))
  const rpmSeries = scale(paymentServiceSeries.rpm, ep.rpm / 452)
  const latSeries = scale(paymentServiceSeries.latencyAvg, ep.avg / 78)
  const errSeries = scale(paymentServiceSeries.errorRatePct, Math.max(ep.errPct / 0.05, 0.5))

  return (
    <>
      <KpiCards svc={svc} />
      <div className="svc-split">
        <SplitEndpointList title="All Database Calls" endpoints={dbEndpoints} selectedIdx={sel} onSelect={setSel} />
        <div className="split-charts">
          <div className="split-chart-card">
            <div className="clbl">
              <span className="clbl-text">Response Time (avg)</span>
              <CardMenu kind="chart" title="Response Time (avg)" />
            </div>
            <div className="chart-host"><MiniChart syncId={syncId} series={latSeries} color="#3B82F6" unit=" ms" formatVal={v => Math.round(v)} /></div>
          </div>
          <div className="split-chart-card">
            <div className="clbl"><span className="clbl-text">RPM</span><CardMenu kind="chart" title="RPM" /></div>
            <div className="chart-host"><MiniChart syncId={syncId} series={rpmSeries} color="#A78BFA" unit=" rpm" formatVal={v => Math.round(v)} /></div>
          </div>
          <div className="split-chart-card">
            <div className="clbl"><span className="clbl-text">Error %</span><CardMenu kind="chart" title="Error %" /></div>
            <div className="chart-host"><MiniChart syncId={syncId} series={errSeries} color="#F472B6" unit="%" formatVal={v => v.toFixed(2)} /></div>
          </div>
        </div>
      </div>
      <SlowQueriesTable />
    </>
  )
}

function ErrorSpark({ series, color }) {
  const data = useMemo(() => chartData(series), [series])
  return (
    <div style={{ width: '100%', height: '100%' }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 2, right: 2, left: 0, bottom: 0 }}>
          <Tooltip content={<SvcTooltip color={color} unit="" formatVal={fmtCompact} />} {...NO_ANIM} />
          <Area {...AREA_PROPS} dataKey="value" stroke={color} strokeWidth={1.4} fill={color} dot={false} activeDot={{ r: 3 }} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

function ErrorsTab() {
  const [side, setSide] = useState('server')
  const [q, setQ] = useState('')
  const groups = errorGroups[side]
  const filtered = q
    ? groups.filter(e => (e.endpoint + ' ' + e.exception + ' ' + e.message).toLowerCase().includes(q.toLowerCase()))
    : groups
  return (
    <div className="panel">
      <div className="panel-head">
        <div className="panel-head-left">
          Errors
        </div>
        <div className="panel-head-right">
          <div className="seg-toggle">
            <div className={`seg${side === 'server' ? ' active' : ''}`} onClick={() => setSide('server')}>Server</div>
            <div className={`seg${side === 'client' ? ' active' : ''}`} onClick={() => setSide('client')}>Client</div>
          </div>
          <CardMenu kind="table" title="Errors" columns={['Count']} />
        </div>
      </div>
      <div className="split-endpoints-search" style={{ borderTop: '1px solid var(--border-subtle)' }}>
        <input placeholder="Search endpoints or exceptions…" value={q} onChange={e => setQ(e.target.value)} />
      </div>
      <div className="err-head">
        <span>Endpoint</span><span>Error</span><span>Count</span><span>Last 60 min</span>
      </div>
      {filtered.map((e, i) => (
        <div key={i} className="err-row">
          <div className="err-endpoint">{e.endpoint}</div>
          <div className="err-exc">
            <span className="err-exc-cls">{e.exception}</span>
            <span className="err-exc-msg">{e.message}</span>
          </div>
          <div className="err-count">{e.count}</div>
          <div className="err-spark"><ErrorSpark series={e.series} color="#EF4444" /></div>
        </div>
      ))}
      {filtered.length === 0 && (
        <div className="err-empty">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="10"/></svg>
          <div>No errors match "{q || 'this filter'}"</div>
        </div>
      )}
    </div>
  )
}

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

function RuntimeTab({ syncId }) {
  const [host, setHost] = useState(runtimeHosts[0].id)
  const [heapHover, setHeapHover] = useState(null)
  const [gcHover, setGcHover] = useState(null)
  const dimFor = (hover, key) => (hover == null || hover === key ? 1 : 0.22)

  const heapStackData = useMemo(() => {
    const used = chartData(runtimeMetrics.heapUsedMB)
    const limit = chartData(runtimeMetrics.heapLimitMB)
    return used.map((d, i) => ({ ...d, used: d.value, limit: limit[i]?.value }))
  }, [])
  const gcStackData = useMemo(() => {
    const minor = chartData(runtimeMetrics.gcMinorMs)
    const major = chartData(runtimeMetrics.gcMajorMs)
    return minor.map((d, i) => ({ ...d, minor: d.value, major: major[i]?.value }))
  }, [])

  return (
    <div className="runtime-layout">
      <div className="runtime-hosts">
        <div className="runtime-hosts-head">
          <span>Hosts · {runtimeHosts.length}</span>
          <CardMenu kind="list" title="Hosts" />
        </div>
        {runtimeHosts.map(h => (
          <div key={h.id} className={`runtime-host-row${h.id === host ? ' selected' : ''}`} onClick={() => setHost(h.id)}>
            <span className={`status-dot ${h.status}`} />
            <span>{h.name}</span>
          </div>
        ))}
      </div>
      <div className="runtime-grid">
        <div className="runtime-chart-card">
          <div className="clbl"><span className="clbl-text">CPU Used % <span className="cval">68.4%</span></span><CardMenu kind="chart" title="CPU Used %" /></div>
          <div className="chart-host"><MiniChart syncId={syncId} series={runtimeMetrics.cpuPct} color="#3B82F6" unit="%" formatVal={v => v.toFixed(1)} height={140} /></div>
        </div>
        <div className="runtime-chart-card">
          <div className="clbl"><span className="clbl-text">Heap Memory (MB) <span className="cval">483 / 640</span></span><CardMenu kind="chart" title="Heap Memory" /></div>
          <div className="chart-host">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={heapStackData} margin={{ top: 6, right: 4, left: 0, bottom: 0 }} syncId={syncId} syncMethod="value">
                <CartesianGrid {...GRID_PROPS} />
                <XAxis {...timeAxisProps(heapStackData.length)} />
                <YAxis {...valueAxisProps({ maxValue: maxOf(heapStackData, ['limit', 'used']) })} />
                <Tooltip content={<DrilldownTooltip />} {...NO_ANIM} />
                <Area {...AREA_PROPS} dataKey="limit" stroke="#A78BFA" strokeWidth={1.4} fill="#A78BFA"
                  fillOpacity={0.08 * dimFor(heapHover, 'limit')}
                  strokeOpacity={dimFor(heapHover, 'limit')}
                  dot={false} strokeDasharray="4 3"
                  onMouseEnter={() => setHeapHover('limit')}
                  onMouseLeave={() => setHeapHover(null)} />
                <Area {...AREA_PROPS} dataKey="used" stroke="#3B82F6" strokeWidth={1.6} fill="#3B82F6"
                  fillOpacity={dimFor(heapHover, 'used')}
                  strokeOpacity={dimFor(heapHover, 'used')}
                  dot={false} activeDot={{ r: 3 }}
                  onMouseEnter={() => setHeapHover('used')}
                  onMouseLeave={() => setHeapHover(null)} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <div className="runtime-legend">
            <div className="runtime-legend-item" onMouseEnter={() => setHeapHover('used')} onMouseLeave={() => setHeapHover(null)}><span className="runtime-legend-swatch" style={{ background: '#3B82F6' }} /> used</div>
            <div className="runtime-legend-item" onMouseEnter={() => setHeapHover('limit')} onMouseLeave={() => setHeapHover(null)}><span className="runtime-legend-swatch" style={{ background: '#A78BFA' }} /> limit</div>
          </div>
        </div>
        <div className="runtime-chart-card">
          <div className="clbl"><span className="clbl-text">Threads <span className="cval">220</span></span><CardMenu kind="chart" title="Threads" /></div>
          <div className="chart-host"><MiniChart syncId={syncId} series={runtimeMetrics.threads} color="#34D399" formatVal={v => Math.round(v)} height={140} /></div>
        </div>
        <div className="runtime-chart-card">
          <div className="clbl"><span className="clbl-text">Garbage Collection (ms) <span className="cval">minor + major</span></span><CardMenu kind="chart" title="Garbage Collection" /></div>
          <div className="chart-host">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={gcStackData} margin={{ top: 6, right: 4, left: 0, bottom: 0 }} syncId={syncId} syncMethod="value">
                <CartesianGrid {...GRID_PROPS} />
                <XAxis {...timeAxisProps(gcStackData.length)} />
                <YAxis {...valueAxisProps({ maxValue: maxOf(gcStackData, ['minor', 'major']) })} />
                <Tooltip content={<DrilldownTooltip />} {...NO_ANIM} />
                <Area {...AREA_PROPS} dataKey="minor" stackId="gc" stroke="#3B82F6" strokeWidth={1.4} fill="#3B82F6"
                  fillOpacity={dimFor(gcHover, 'minor')}
                  strokeOpacity={dimFor(gcHover, 'minor')}
                  dot={false}
                  onMouseEnter={() => setGcHover('minor')}
                  onMouseLeave={() => setGcHover(null)} />
                <Area {...AREA_PROPS} dataKey="major" stackId="gc" stroke="#F472B6" strokeWidth={1.4} fill="#F472B6"
                  fillOpacity={dimFor(gcHover, 'major')}
                  strokeOpacity={dimFor(gcHover, 'major')}
                  dot={false}
                  onMouseEnter={() => setGcHover('major')}
                  onMouseLeave={() => setGcHover(null)} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <div className="runtime-legend">
            <div className="runtime-legend-item" onMouseEnter={() => setGcHover('minor')} onMouseLeave={() => setGcHover(null)}><span className="runtime-legend-swatch" style={{ background: '#3B82F6' }} /> minor</div>
            <div className="runtime-legend-item" onMouseEnter={() => setGcHover('major')} onMouseLeave={() => setGcHover(null)}><span className="runtime-legend-swatch" style={{ background: '#F472B6' }} /> major</div>
          </div>
        </div>
      </div>
    </div>
  )
}

// Opening one FilterSelect closes any other open one on the page. The nonce
// avoids every instance reacting to its own open event.
const FILTER_SELECT_EVENT = 'cube:filter-select-open'
let filterSelectNonce = 0

function FilterSelect({ label, value, options, onSelect }) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const ref = useRef(null)
  const btnRef = useRef(null)
  const idRef = useRef(null)

  const filtered = search
    ? options.filter(o => o.toLowerCase().includes(search.toLowerCase()))
    : options

  const close = useCallback(() => { setOpen(false); setSearch('') }, [])

  // Only one FilterSelect may be open at a time. Opening one dispatches an
  // event the others listen for and respond to by closing themselves.
  useEffect(() => {
    const handler = (e) => {
      if (e.detail?.id !== idRef.current && open) close()
    }
    window.addEventListener(FILTER_SELECT_EVENT, handler)
    return () => window.removeEventListener(FILTER_SELECT_EVENT, handler)
  }, [open, close])

  const openPanel = useCallback(() => {
    idRef.current = ++filterSelectNonce
    window.dispatchEvent(new CustomEvent(FILTER_SELECT_EVENT, { detail: { id: idRef.current } }))
    setOpen(true)
  }, [])

  useEffect(() => {
    if (!open) return
    const handler = (e) => {
      if (!ref.current?.contains(e.target) && !btnRef.current?.contains(e.target)) close()
    }
    document.addEventListener('click', handler)
    return () => document.removeEventListener('click', handler)
  }, [open, close])

  const rect = btnRef.current?.getBoundingClientRect()
  // The panel widens to fit the longest option so the list never has to wrap or
  // ellipsize. 7.4px/char is a conservative estimate for Rubik at 12px; the
  // extra 72px covers the check icon, horizontal padding and the search row.
  const longestOption = useMemo(
    () => options.reduce((m, o) => Math.max(m, o.length), 0),
    [options]
  )
  const panelW = Math.max(rect?.width || 160, Math.round(longestOption * 7.4 + 72))
  const overflows = rect && rect.left + panelW > window.innerWidth - 8

  return (
    <>
      <div
        ref={btnRef}
        className={`filter-select${open ? ' dd-open' : ''}`}
        onClick={(e) => { e.stopPropagation(); if (open) close(); else openPanel() }}
      >
        <span className="filter-label">{label}</span>
        <span className="filter-value">
          <span>{value}</span>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
        </span>
      </div>
      {open && rect && (
        <div
          ref={ref}
          className="dd-panel"
          style={{
            position: 'fixed',
            top: rect.bottom + 4,
            ...(overflows
              ? { right: window.innerWidth - rect.right, width: panelW }
              : { left: rect.left, width: panelW }),
            zIndex: 500,
          }}
          onClick={e => e.stopPropagation()}
        >
          <div className="dd-search">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>
            <input placeholder="Search…" value={search} onChange={e => setSearch(e.target.value)} autoFocus />
          </div>
          <div className="dd-list">
            {filtered.map(o => (
              <div key={o} className={`dd-item${o === value ? ' active' : ''}`} onClick={() => { onSelect(o); close() }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="dd-item-check"><path d="M20 6L9 17l-5-5" /></svg>
                {o}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  )
}

export default function ServiceOverview({ serviceId, onSelectService, onOpenTrace, goHome, serviceSubTab, setServiceSubTab, serviceEndpoint, setServiceEndpoint, timeRange, setTimeRange, settingsOpen, setSettingsOpen, setToast }) {
  const svc = services.find(s => s.id === serviceId) || services[0]

  const [filterCategory, setFilterCategory] = useState('ALL')
  const [filterHost, setFilterHost] = useState('ALL')
  const [filterVersion, setFilterVersion] = useState('ALL')

  const endpoint = serviceEndpoint || redEndpoints[0].endpoint
  const setEndpoint = setServiceEndpoint

  // The card menus offer the actions production offers; none of the screens
  // behind them - the alert builder, Explore, the comparison window - are part
  // of this redesign yet, so the menu says so rather than doing nothing.
  // An upstream in the drilldown is a call this service makes, which is what the
  // External view lists - so a row there is a link into it.
  const openExternal = useCallback(() => setServiceSubTab?.('external'), [setServiceSubTab])

  const onCardAction = useCallback((action, title) => {
    setToast?.(`${action} · ${title} - that screen is not part of this prototype yet.`)
  }, [setToast])

  // One syncId per visible sub-tab, so hovering any chart on the page lines up
  // the x-axis indicator on every other chart that shares the same time axis.
  const syncId = `svc-${serviceSubTab}`

  let body
  if (serviceSubTab === 'overview') {
    body = (
      <>
        <KpiCards svc={svc} />
        <LatencyDrilldown onOpenUpstream={openExternal} syncId={syncId} />
        <TrendCharts syncId={syncId} />
        <SlowRequests onOpenTrace={onOpenTrace} />
        <InfraCorrelation />
      </>
    )
  } else if (serviceSubTab === 'detail') {
    body = <EndpointTab endpoint={endpoint} setEndpoint={setEndpoint} onOpenUpstream={openExternal} onOpenTrace={onOpenTrace} syncId={syncId} />
  } else if (serviceSubTab === 'red') {
    body = <RedTab syncId={syncId} />
  } else if (serviceSubTab === 'external') {
    body = <ExternalTab svc={svc} syncId={syncId} />
  } else if (serviceSubTab === 'db') {
    body = <DbTab svc={svc} syncId={syncId} />
  } else if (serviceSubTab === 'errors') {
    body = <ErrorsTab />
  } else if (serviceSubTab === 'runtime') {
    body = <RuntimeTab syncId={syncId} />
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
            {serviceSubTab === 'detail' && (
              <div className="ep-bar is-inline">
                <select
                  id="ep-select"
                  aria-label="Endpoint"
                  title="Endpoint"
                  value={endpoint}
                  onChange={e => setEndpoint(e.target.value)}
                >
                  {(redEndpoints.some(e => e.endpoint === endpoint) ? redEndpoints : [...redEndpoints, syntheticEndpoint(endpoint)])
                    .map(e => <option key={e.endpoint} value={e.endpoint}>{e.endpoint}</option>)}
                </select>
              </div>
            )}
          </div>
          <div className="subtab-filters">
            {(serviceSubTab === 'overview' || serviceSubTab === 'red') && (
              <FilterSelect label="Category" value={filterCategory} options={FILTER_OPTS.category} onSelect={setFilterCategory} />
            )}
            <FilterSelect label="Host" value={filterHost} options={FILTER_OPTS.host} onSelect={setFilterHost} />
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
      <div className="svc-main">
        {body}
      </div>
    </CardActionContext.Provider>
  )
}
