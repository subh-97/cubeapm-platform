import { useState, useMemo, useRef, useEffect, useCallback } from 'react'
import { AreaChart, Area, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { services, paymentServiceSeries, latencyDrilldown, redEndpoints, infraCorrelation, slowRequests, externalEndpoints, dbEndpoints, slowQueries, errorGroups, tracesList, traceDetail, runtimeHosts, runtimeMetrics, FILTER_OPTS } from '@/data/services'
import { statusForLatency, statusForErrorRate } from '@/utils/status'
import PageBar from '@/components/layout/PageBar'
import ServicePicker from '@/components/ServicePicker'
import CardMenu, { CardActionContext } from '@/components/CardMenu'
import InfoTip from '@/components/shared/InfoTip'
import Waterfall from '@/components/trace/Waterfall'
import { buildTrace } from '@/data/traceDetail'
import { GRID_PROPS, NO_ANIM, AREA_PROPS, LINE_PROPS, timeAxisProps, valueAxisProps, maxOf, fmtCompact } from '@/components/charts/chartDefaults'

const BASE_TIME = new Date()

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
      {payload.map((p, i) => {
        const ep = eps[i]?.endpoint || ''
        const short = ep.length > 28 ? ep.slice(0, 26) + '…' : ep
        return (
          <div key={i} style={{ color: colors[i], display: 'flex', justifyContent: 'space-between', gap: 16 }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 140, whiteSpace: 'nowrap' }}>{short}</span>
            <span style={{ fontWeight: 600, flexShrink: 0 }}>{fmtFn(p.value)}</span>
          </div>
        )
      })}
    </div>
  )
}

function SparkChart({ series, color, unit = '', formatVal }) {
  const data = useMemo(() => chartData(series), [series])
  return (
    <div style={{ width: '100%', height: '100%' }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
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
          <div className="kpi-threshold">{c.threshold}</div>
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
function EndpointTab({ endpoint, setEndpoint, onOpenUpstream }) {
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
      <div className="ep-bar">
        <select
          id="ep-select"
          aria-label="Endpoint"
          title="Endpoint"
          value={ep.endpoint}
          onChange={e => setEndpoint(e.target.value)}
        >
          {eps.map(e => <option key={e.endpoint} value={e.endpoint}>{e.endpoint}</option>)}
        </select>
      </div>

      <div className="kpi-grid">
        {cards.map(c => (
          <div key={c.lbl} className={`kpi-card ${c.status}`}>
            <div className="kpi-card-head">
              <span className="lbl">{c.lbl}</span>
              <CardMenu kind="metric" title={c.lbl} />
            </div>
            <div className="val">{c.val}<span className="unit">{c.unit}</span></div>
            <div className="kpi-threshold">{c.threshold}</div>
          </div>
        ))}
      </div>

      <div className="two-col">
        <LatencyDrilldown onOpenUpstream={onOpenUpstream} />
        <div className="panel">
          <div className="panel-head">
            <div className="panel-head-left">Hits per request <span className="hint">what one call sets off downstream</span></div>
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
      </div>
    </>
  )
}

function LatencyDrilldown({ onOpenUpstream }) {
  const layers = latencyDrilldown
  const total = layers.reduce((a, b) => a + b.ms, 0)
  const [search, setSearch] = useState('')

  // One list drives both halves of the panel: filtering the legend filters the
  // chart. A legend that still lists four upstreams while the chart draws one
  // would be the panel disagreeing with itself.
  const q = search.trim().toLowerCase()
  const shown = q ? layers.filter(l => l.label.toLowerCase().includes(q)) : layers

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
    layers.forEach((layer, li) => {
      const j = Math.sin(i * 4.1 + li * 2.3) * 0.06 + Math.cos(i * 7.7 + li * 1.1) * 0.04
      entry[layer.label] = (baselines[li] + (peaks[li] - baselines[li]) * ramp) * (1 + j)
    })
    return entry
  }), [])

  return (
    <div className="panel">
      <div className="panel-head is-divided">
        <div className="panel-head-left">
          Latency Drilldown
          <InfoTip label="About Latency Drilldown">
            Break-down of average latency. Total latency can be less than the sum of individual
            latencies for several reasons - parallel execution, async execution and so on. Total
            latency reflects latency from the caller&apos;s perspective, while the sum of individual
            latencies reflects the amount of resources consumed on the server.
          </InfoTip>
        </div>
        <CardMenu kind="chart" title="Latency Drilldown" total="Total" />
      </div>
      <div className="drill2">
        <div className="drill2-chart">
          <div style={{ width: '100%', height: 260 }}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid {...GRID_PROPS} />
                <XAxis {...timeAxisProps(data.length)} />
                <YAxis {...valueAxisProps({ maxValue: total })} />
                <Tooltip content={<DrilldownTooltip />} {...NO_ANIM} />
                {shown.map(layer => (
                  <Area key={layer.label} {...AREA_PROPS} dataKey={layer.label} stackId="stack"
                    stroke={layer.color} fill={layer.color} fillOpacity={0.18} strokeWidth={1.5}
                    dot={false} activeDot={{ r: 3, strokeWidth: 0 }} />
                ))}
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
            // The share stays measured against the whole, so filtering narrows
            // what is on screen without restating what each upstream costs.
            const pct = ((d.ms / total) * 100).toFixed(1)
            return (
              <button
                type="button"
                className="drill2-item"
                key={d.label}
                onClick={() => onOpenUpstream?.(d.label)}
                title={`${d.label} - open the External view`}
              >
                <div className="drill2-row">
                  <span className="drill2-swatch" style={{ background: d.color }} />
                  <span className="drill2-label">{d.label}</span>
                  <span className="drill2-pct">{pct}%</span>
                  <span className="drill2-val">{d.ms}<span className="drill2-unit"> ms</span></span>
                  <svg className="drill2-go" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M14 4h6v6M20 4l-8 8M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5" />
                  </svg>
                </div>
                <div className="drill2-bartrack"><div className="drill2-barfill" style={{ width: `${pct}%`, background: d.color, opacity: 0.75 }} /></div>
              </button>
            )
          })}
          {shown.length === 0 && (
            <div className="drill2-empty">No upstream matches “{search.trim()}”</div>
          )}
          <div className="drill2-total">
            <span className="drill2-total-lbl">Total</span>
            <span className="drill2-total-val">{total} ms</span>
          </div>
        </div>
      </div>
    </div>
  )
}

function TrendCharts() {
  return (
    <div className="charts-row">
      <div className="chart-card">
        <div className="clbl"><span className="clbl-text">RPM</span><CardMenu kind="chart" title="RPM" /></div>
        <div className="chart-host"><SparkChart series={paymentServiceSeries.rpm} color="#3B82F6" unit=" rpm" formatVal={v => Math.round(v)} /></div>
      </div>
      <div className="chart-card">
        <div className="clbl"><span className="clbl-text">Error % <span className="flag crit">incident +22m</span></span><CardMenu kind="chart" title="Error %" /></div>
        <div className="chart-host"><SparkChart series={paymentServiceSeries.errorRatePct} color="#EF4444" incidentAt={22} unit="%" formatVal={v => v.toFixed(2)} /></div>
      </div>
      <div className="chart-card">
        <div className="clbl"><span className="clbl-text">Apdex</span><CardMenu kind="chart" title="Apdex" /></div>
        <div className="chart-host"><SparkChart series={paymentServiceSeries.apdex} color="#34D399" incidentAt={22} unit="" formatVal={v => v.toFixed(2)} /></div>
      </div>
    </div>
  )
}

const SLOWREQ_SORTS = [
  { id: 'latency', label: 'Latency' },
  { id: 'time', label: 'Time' },
  { id: 'none', label: 'None' },
]

function SlowRequests({ onOpenTrace }) {
  const [sortBy, setSortBy] = useState('latency')
  const [selected, setSelected] = useState(slowRequests[0].traceId)
  const [collapsed, setCollapsed] = useState(() => new Set())
  const [span, setSpan] = useState(null)

  // "None" is the order the backend returned, so it has to be the untouched
  // list rather than another sort that happens to look unsorted.
  const rows = useMemo(() => {
    if (sortBy === 'none') return slowRequests
    const list = [...slowRequests]
    if (sortBy === 'latency') list.sort((a, b) => b.latencyMs - a.latencyMs)
    else list.sort((a, b) => parseInt(a.timestamp, 10) - parseInt(b.timestamp, 10))
    return list
  }, [sortBy])

  const row = rows.find(r => r.traceId === selected) ?? rows[0]

  // The same builder the trace details page uses, so the preview is that page's
  // trace rather than a sketch of one.
  const trace = useMemo(() => buildTrace(row.traceId), [row.traceId])

  const toggle = useCallback(id => setCollapsed(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  }), [])

  return (
    <div className="panel">
      <div className="panel-head is-divided">
        <div className="panel-head-left">Slow Requests <span className="hint">{rows.length} results</span></div>
        <div className="panel-head-right">
          <span className="sort-lbl">Sort by</span>
          <div className="seg-toggle">
            {SLOWREQ_SORTS.map(s => (
              <div key={s.id} className={`seg${sortBy === s.id ? ' active' : ''}`} onClick={() => setSortBy(s.id)}>{s.label}</div>
            ))}
          </div>
          <CardMenu kind="list" title="Slow Requests" />
        </div>
      </div>
      <div className="slowreq-split">
        <div className="slowreq-list">
          {rows.map(r => (
            <button
              type="button"
              className={`slowreq-row${r.traceId === row.traceId ? ' selected' : ''}`}
              key={r.traceId}
              onClick={() => setSelected(r.traceId)}
              aria-pressed={r.traceId === row.traceId}
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
        </div>
      </div>
    </div>
  )
}

function InfraCorrelation() {
  return (
    <div className="panel">
      <div className="panel-head">
        <div className="panel-head-left">Infrastructure Correlation <span className="hint">All 3 hosts under resource pressure</span></div>
        <CardMenu kind="table" title="Infrastructure Correlation" columns={['RPM', 'p90 Latency', 'Error %', 'CPU Used %', 'Memory Used %']} />
      </div>
      <table>
        <thead><tr><th style={{ textAlign: 'left' }}>Host</th><th>RPM</th><th>p90</th><th>Error %</th><th>CPU</th><th>Mem</th></tr></thead>
        <tbody>
          {infraCorrelation.map(h => (
            <tr key={h.host}>
              <td className="mono" style={{ textAlign: 'left' }}>{h.host}</td>
              <td>{h.rpm}</td>
              <td className="val-critical">{h.latencyP90} ms</td>
              <td className="val-critical">{h.errorRatePct}%</td>
              <td className="val-critical">{h.cpuUsedPct}%</td>
              <td className="val-critical">{h.memUsedPct}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const RED_COLUMNS = ['Total Req', 'Time Consumed %', 'RPM', 'p90', 'Avg', 'Error %']

function RedTab() {
  const [redView, setRedView] = useState('table')
  const isGraph = redView === 'graph'

  const EP_COLORS = ['#3B82F6', '#34D399', '#F472B6', '#A78BFA']
  const eps = redEndpoints.slice(0, 4)
  const N2 = 30, INC2 = 18

  const makeRedChart = (title, valFn, fmtFn) => {
    const chartData2 = Array.from({ length: N2 }, (_, i) => {
      const minsAgo = (N2 - 1 - i) * 2
      const t = new Date(BASE_TIME.getTime() - minsAgo * 60 * 1000)
      const hh = t.getHours().toString().padStart(2, '0')
      const mm = t.getMinutes().toString().padStart(2, '0')
      const label = minsAgo === 0 ? 'now' : `-${minsAgo}m`
      const entry = { label, exactTime: `${hh}:${mm}` }
      eps.forEach((ep, ei) => {
        const base = valFn(ep)
        const j = Math.sin(i * 3.7 + ei * 2.1) * 0.09 + Math.cos(i * 6.3 + ei * 1.4) * 0.05
        const spike = i >= INC2 ? Math.min(1, (i - INC2) / 6) * (ep.errPct > 3 ? 0.28 : 0.04) : 0
        entry[`ep${ei}`] = base * (1 + j + spike)
      })
      return entry
    })

    return (
      <div className="red-chart-section" key={title}>
        <div className="red-chart-title-row">{title}</div>
        <div className="red-chart-body">
          <div className="red-chart-svg-wrap">
            <div style={{ width: '100%', height: 130 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData2} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid {...GRID_PROPS} />
                  <XAxis {...timeAxisProps(chartData2.length)} />
                  <YAxis {...valueAxisProps({ format: fmtFn, maxValue: maxOf(chartData2, eps.map((_, ei) => `ep${ei}`)) })} />
                  <Tooltip content={(p) => <RedChartTooltip {...p} eps={eps} colors={EP_COLORS} fmtFn={fmtFn} />} {...NO_ANIM} />
                  {eps.map((_, ei) => (
                    <Line key={ei} {...LINE_PROPS} dataKey={`ep${ei}`} stroke={EP_COLORS[ei]} strokeWidth={1.5} dot={false} activeDot={{ r: 3, strokeWidth: 0 }} />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div className="red-chart-legend">
            {eps.map((ep, ei) => {
              const epShort = ep.endpoint.length > 26 ? ep.endpoint.slice(0, 24) + '…' : ep.endpoint
              return (
                <div className="red-legend-row" key={ei}>
                  <div className="red-legend-dash" style={{ background: EP_COLORS[ei] }} />
                  <span className="red-legend-ep">{epShort}</span>
                  <span className="red-legend-val">{fmtFn(valFn(ep))}</span>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    )
  }

  const fmtMs = v => `${Math.round(v)} ms`
  const fmtRpm = v => v >= 1000 ? `${(v / 1000).toFixed(1)}K` : Math.round(v).toString()
  const fmtPct = v => `${v.toFixed(2)}%`

  const viewToggle = (
    <div className="view-toggle">
      <div className={`view-toggle-btn${!isGraph ? ' active' : ''}`} onClick={() => setRedView('table')} title="Table view">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M3 15h18M9 3v18" /></svg>
      </div>
      <div className={`view-toggle-btn${isGraph ? ' active' : ''}`} onClick={() => setRedView('graph')} title="Graph view">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12" /></svg>
      </div>
    </div>
  )

  if (isGraph) {
    return (
      <div className="panel">
        <div className="panel-head">
          <div className="panel-head-left">RED - endpoint breakdown <span className="hint">POST /v1/payments/:id/capture is slowest &amp; highest-error</span></div>
          <div className="panel-head-right">
            {viewToggle}
            <CardMenu kind="table" title="RED - endpoint breakdown" columns={RED_COLUMNS} />
          </div>
        </div>
        {makeRedChart('RPM', ep => ep.rpm, fmtRpm)}
        {makeRedChart('Response Time (p90)', ep => ep.p90, fmtMs)}
        {makeRedChart('Response Time (avg)', ep => ep.avg, fmtMs)}
        {makeRedChart('Error %', ep => ep.errPct, fmtPct)}
      </div>
    )
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <div className="panel-head-left">RED - endpoint breakdown <span className="hint">POST /v1/payments/:id/capture is slowest &amp; highest-error</span></div>
        <div className="panel-head-right">
          {viewToggle}
          <CardMenu kind="table" title="RED - endpoint breakdown" columns={RED_COLUMNS} />
        </div>
      </div>
      <table>
        <thead><tr><th style={{ textAlign: 'left' }}>Endpoint</th><th>Total Req</th><th>Time Consumed %</th><th>RPM</th><th>p90</th><th>Avg</th><th>Error %</th></tr></thead>
        <tbody>
          {redEndpoints.map(e => (
            <tr key={e.endpoint}>
              <td className="mono" style={{ textAlign: 'left' }}>{e.endpoint}</td>
              <td>{e.totalReq}</td>
              <td>
                <span className="cell-bar">
                  <span className="track"><span className="fill" style={{ width: `${e.timeConsumedPct}%`, background: '#3B82F6' }} /></span>
                  <span>{e.timeConsumedPct}%</span>
                </span>
              </td>
              <td>{e.rpm}</td>
              <td className="val-critical">{e.p90} ms</td>
              <td>{e.avg} ms</td>
              <td className={e.errPct >= 3 ? 'val-critical' : e.errPct >= 1 ? 'val-warning' : ''}>{e.errPct}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function MiniChart({ series, color, unit = '', formatVal, height = 130 }) {
  const data = useMemo(() => chartData(series), [series])
  return (
    <div style={{ width: '100%', height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
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

function SplitEndpointList({ title, hint, endpoints, selectedIdx, onSelect }) {
  const [search, setSearch] = useState('')
  const filtered = search
    ? endpoints.filter(e => e.endpoint.toLowerCase().includes(search.toLowerCase()))
    : endpoints
  return (
    <div className="panel split-endpoints">
      <div className="panel-head">
        <div className="panel-head-left">{title} <span className="hint">{hint}</span></div>
        <CardMenu kind="table" title={title} columns={['Time %', 'RPM', 'Avg', 'Error %']} />
      </div>
      <div className="split-endpoints-search">
        <input placeholder="Search endpoints…" value={search} onChange={e => setSearch(e.target.value)} />
      </div>
      <div className="split-ep-head">
        <span>Endpoint</span><span>Time %</span><span>RPM</span><span>Avg</span><span>Error %</span>
      </div>
      {filtered.map((e, i) => {
        const errS = statusForErrorRate(e.errPct)
        const isSel = i === selectedIdx
        return (
          <div key={e.endpoint} className={`split-ep-row${isSel ? ' selected' : ''}`} onClick={() => onSelect(i)}>
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
      {filtered.length === 0 && (
        <div className="err-empty">No endpoints match "{search}"</div>
      )}
    </div>
  )
}

function ExternalTab({ svc }) {
  const [sel, setSel] = useState(0)
  const ep = externalEndpoints[sel] || externalEndpoints[0]

  const scale = (baseSeries, factor) => baseSeries.map(d => ({ m: d.m, value: d.value * factor }))
  const rpmSeries = scale(paymentServiceSeries.rpm, ep.rpm / 452)
  const latSeries = scale(paymentServiceSeries.latencyAvg, ep.avg / 78)
  const errSeries = scale(paymentServiceSeries.errorRatePct, Math.max(ep.errPct / 0.05, 0.5))

  return (
    <>
      <KpiCards svc={svc} />
      <div className="svc-split">
        <SplitEndpointList title="All External HTTP Calls" hint={`${externalEndpoints.length} endpoints · last 60 min`} endpoints={externalEndpoints} selectedIdx={sel} onSelect={setSel} />
        <div className="split-charts">
          <div className="split-chart-card">
            <div className="clbl">
              <span className="clbl-text">Response Time (avg) <span className="hint" style={{ color: 'var(--text-muted)', fontWeight: 400, fontSize: 10 }}>{ep.endpoint.length > 30 ? ep.endpoint.slice(0, 28) + '…' : ep.endpoint}</span></span>
              <CardMenu kind="chart" title="Response Time (avg)" />
            </div>
            <div className="chart-host"><MiniChart series={latSeries} color="#3B82F6" unit=" ms" formatVal={v => Math.round(v)} /></div>
          </div>
          <div className="split-chart-card">
            <div className="clbl"><span className="clbl-text">RPM</span><CardMenu kind="chart" title="RPM" /></div>
            <div className="chart-host"><MiniChart series={rpmSeries} color="#A78BFA" unit=" rpm" formatVal={v => Math.round(v)} /></div>
          </div>
          <div className="split-chart-card">
            <div className="clbl"><span className="clbl-text">Error %</span><CardMenu kind="chart" title="Error %" /></div>
            <div className="chart-host"><MiniChart series={errSeries} color="#F472B6" unit="%" formatVal={v => v.toFixed(2)} /></div>
          </div>
        </div>
      </div>
    </>
  )
}

function DbTab({ svc }) {
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
        <SplitEndpointList title="All Database Calls" hint={`${dbEndpoints.length} operations · last 60 min`} endpoints={dbEndpoints} selectedIdx={sel} onSelect={setSel} />
        <div className="split-charts">
          <div className="split-chart-card">
            <div className="clbl">
              <span className="clbl-text">Response Time (avg) <span className="hint" style={{ color: 'var(--text-muted)', fontWeight: 400, fontSize: 10 }}>{ep.endpoint.length > 30 ? ep.endpoint.slice(0, 28) + '…' : ep.endpoint}</span></span>
              <CardMenu kind="chart" title="Response Time (avg)" />
            </div>
            <div className="chart-host"><MiniChart series={latSeries} color="#3B82F6" unit=" ms" formatVal={v => Math.round(v)} /></div>
          </div>
          <div className="split-chart-card">
            <div className="clbl"><span className="clbl-text">RPM</span><CardMenu kind="chart" title="RPM" /></div>
            <div className="chart-host"><MiniChart series={rpmSeries} color="#A78BFA" unit=" rpm" formatVal={v => Math.round(v)} /></div>
          </div>
          <div className="split-chart-card">
            <div className="clbl"><span className="clbl-text">Error %</span><CardMenu kind="chart" title="Error %" /></div>
            <div className="chart-host"><MiniChart series={errSeries} color="#F472B6" unit="%" formatVal={v => v.toFixed(2)} /></div>
          </div>
        </div>
      </div>
      <div className="panel">
        <div className="panel-head">
          <div className="panel-head-left">Slow Queries <span className="hint">Top 5 by latency · last 60 min</span></div>
          <CardMenu kind="list" title="Slow Queries" />
        </div>
        <div className="split-ep-head" style={{ gridTemplateColumns: '130px 1fr 84px' }}>
          <span>Time</span><span>Query</span><span style={{ textAlign: 'right' }}>Duration</span>
        </div>
        {slowQueries.map((q, i) => (
          <div key={i} className="slowq-row">
            <div className="t">{q.time}</div>
            <div className="q" title={q.query}>{q.query}</div>
            <div className="d">{q.duration} ms</div>
          </div>
        ))}
      </div>
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
          Errors <span className="hint">{side === 'server' ? 'HTTP responses returned to callers' : 'Downstream failures raised by this service'}</span>
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
              <div className="panel-head-left">Traces <span className="hint">{sorted.length} results · sortable</span></div>
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

function RuntimeTab() {
  const [host, setHost] = useState(runtimeHosts[0].id)

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
          <div className="chart-host"><MiniChart series={runtimeMetrics.cpuPct} color="#3B82F6" unit="%" formatVal={v => v.toFixed(1)} height={140} /></div>
        </div>
        <div className="runtime-chart-card">
          <div className="clbl"><span className="clbl-text">Heap Memory (MB) <span className="cval">483 / 640</span></span><CardMenu kind="chart" title="Heap Memory" /></div>
          <div className="chart-host">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={heapStackData} margin={{ top: 6, right: 4, left: 0, bottom: 0 }}>
                <CartesianGrid {...GRID_PROPS} />
                <XAxis {...timeAxisProps(heapStackData.length)} />
                <YAxis {...valueAxisProps({ maxValue: maxOf(heapStackData, ['limit', 'used']) })} />
                <Tooltip content={<DrilldownTooltip />} {...NO_ANIM} />
                <Area {...AREA_PROPS} dataKey="limit" stroke="#A78BFA" strokeWidth={1.4} fill="#A78BFA" fillOpacity={0.08} dot={false} strokeDasharray="4 3" />
                <Area {...AREA_PROPS} dataKey="used" stroke="#3B82F6" strokeWidth={1.6} fill="#3B82F6" dot={false} activeDot={{ r: 3 }} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <div className="runtime-legend">
            <div className="runtime-legend-item"><span className="runtime-legend-swatch" style={{ background: '#3B82F6' }} /> used</div>
            <div className="runtime-legend-item"><span className="runtime-legend-swatch" style={{ background: '#A78BFA' }} /> limit</div>
          </div>
        </div>
        <div className="runtime-chart-card">
          <div className="clbl"><span className="clbl-text">Threads <span className="cval">220</span></span><CardMenu kind="chart" title="Threads" /></div>
          <div className="chart-host"><MiniChart series={runtimeMetrics.threads} color="#34D399" formatVal={v => Math.round(v)} height={140} /></div>
        </div>
        <div className="runtime-chart-card">
          <div className="clbl"><span className="clbl-text">Garbage Collection (ms) <span className="cval">minor + major</span></span><CardMenu kind="chart" title="Garbage Collection" /></div>
          <div className="chart-host">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={gcStackData} margin={{ top: 6, right: 4, left: 0, bottom: 0 }}>
                <CartesianGrid {...GRID_PROPS} />
                <XAxis {...timeAxisProps(gcStackData.length)} />
                <YAxis {...valueAxisProps({ maxValue: maxOf(gcStackData, ['minor', 'major']) })} />
                <Tooltip content={<DrilldownTooltip />} {...NO_ANIM} />
                <Area {...AREA_PROPS} dataKey="minor" stackId="gc" stroke="#3B82F6" strokeWidth={1.4} fill="#3B82F6" dot={false} />
                <Area {...AREA_PROPS} dataKey="major" stackId="gc" stroke="#F472B6" strokeWidth={1.4} fill="#F472B6" dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <div className="runtime-legend">
            <div className="runtime-legend-item"><span className="runtime-legend-swatch" style={{ background: '#3B82F6' }} /> minor</div>
            <div className="runtime-legend-item"><span className="runtime-legend-swatch" style={{ background: '#F472B6' }} /> major</div>
          </div>
        </div>
      </div>
    </div>
  )
}

function FilterSelect({ label, value, options, onSelect }) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const ref = useRef(null)
  const btnRef = useRef(null)

  const filtered = search
    ? options.filter(o => o.toLowerCase().includes(search.toLowerCase()))
    : options

  const close = useCallback(() => { setOpen(false); setSearch('') }, [])

  useEffect(() => {
    if (!open) return
    const handler = (e) => {
      if (!ref.current?.contains(e.target) && !btnRef.current?.contains(e.target)) close()
    }
    document.addEventListener('click', handler)
    return () => document.removeEventListener('click', handler)
  }, [open, close])

  const rect = btnRef.current?.getBoundingClientRect()
  const panelW = Math.max(rect?.width || 160, 160)
  const overflows = rect && rect.left + panelW > window.innerWidth - 8

  return (
    <>
      <div
        ref={btnRef}
        className={`filter-select${open ? ' dd-open' : ''}`}
        onClick={(e) => { e.stopPropagation(); setOpen(o => !o) }}
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
              ? { right: window.innerWidth - rect.right, minWidth: panelW }
              : { left: rect.left, minWidth: panelW }),
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

  // The crumb names the view rather than the service: the service is already
  // named by the picker directly below it, and two acronyms in the list read as
  // words unless they are left alone.
  const view = serviceSubTab || 'overview'
  const viewLabel = view === 'red' ? 'RED' : view === 'db' ? 'DB' : view[0].toUpperCase() + view.slice(1)

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

  let body
  if (serviceSubTab === 'overview') {
    body = (
      <>
        <KpiCards svc={svc} />
        <LatencyDrilldown onOpenUpstream={openExternal} />
        <TrendCharts />
        <SlowRequests onOpenTrace={onOpenTrace} />
        <InfraCorrelation />
      </>
    )
  } else if (serviceSubTab === 'detail') {
    body = <EndpointTab endpoint={endpoint} setEndpoint={setEndpoint} onOpenUpstream={openExternal} />
  } else if (serviceSubTab === 'red') {
    body = <RedTab />
  } else if (serviceSubTab === 'external') {
    body = <ExternalTab svc={svc} />
  } else if (serviceSubTab === 'db') {
    body = <DbTab svc={svc} />
  } else if (serviceSubTab === 'errors') {
    body = <ErrorsTab />
  } else if (serviceSubTab === 'traces') {
    body = <TracesTab />
  } else if (serviceSubTab === 'runtime') {
    body = <RuntimeTab />
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
        <a onClick={goHome}>APM &amp; Services</a>
        <span className="sep">/</span>
        <span className="current">{viewLabel}</span>
      </PageBar>
      <div className="card-tab-strip">
        <div className="subtab-row">
          <ServicePicker serviceId={svc.id} onSelect={onSelectService} />
          <div className="subtab-filters">
            <FilterSelect label="Category" value={filterCategory} options={FILTER_OPTS.category} onSelect={setFilterCategory} />
            <FilterSelect label="Host" value={filterHost} options={FILTER_OPTS.host} onSelect={setFilterHost} />
            <FilterSelect label="Version" value={filterVersion} options={FILTER_OPTS.version} onSelect={setFilterVersion} />
          </div>
        </div>
      </div>
      <div className="svc-main">
        {body}
      </div>
    </CardActionContext.Provider>
  )
}
