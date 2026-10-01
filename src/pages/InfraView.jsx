import { useState, useMemo, useRef, useEffect, useCallback } from 'react'
import { AreaChart, Area, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import {
  INFRA_SOURCE_INDEX, infraHosts, HOST_PROCESSES,
  k8sCpuAllocation, k8sMemAllocation, k8sContainersSeries, k8sClusterSummary, k8sNamespaceSummary, k8sDeploymentSummary, k8sNamespaceDetail,
  k8sNodes, k8sPods, K8S_NAMESPACES,
  mysqlSummary, mysqlSeries, redisSummary, redisSeries,
} from '@/data/observability'
import PageBar from '@/components/layout/PageBar'
import TableQuerySearch from '@/components/TableQuerySearch'
import { parsePodQuery, matchesPod, highlightsFor, tagHighlightsFor, tagTerms, POD_FIELDS, POD_NODE_FIELDS } from '@/utils/tableQuery'
import { highlightTerms } from '@/utils/highlight'
import { GRID_PROPS, NO_ANIM, AREA_PROPS, LINE_PROPS, timeAxisProps, valueAxisProps, maxOf, fmtBytes, fmtCount } from '@/components/charts/chartDefaults'

const BASE_TIME = new Date()

function toChartData(series) {
  return series.map(d => {
    const t = new Date(BASE_TIME.getTime() - d.m * 60 * 1000)
    const hh = t.getHours().toString().padStart(2, '0')
    const mm = t.getMinutes().toString().padStart(2, '0')
    return { label: d.m === 0 ? 'now' : `-${d.m}m`, exactTime: `${hh}:${mm}`, value: d.value }
  })
}

function MultiHostChart({ metric, unit, formatVal, height = 130, palette, hosts = infraHosts, nameKey = 'host' }) {
  const data = useMemo(() => {
    const n = hosts[0][metric].length
    return Array.from({ length: n }, (_, i) => {
      const d = hosts[0][metric][i]
      const t = new Date(BASE_TIME.getTime() - d.m * 60 * 1000)
      const hh = t.getHours().toString().padStart(2, '0')
      const mm = t.getMinutes().toString().padStart(2, '0')
      const entry = { label: d.m === 0 ? 'now' : `-${d.m}m`, exactTime: `${hh}:${mm}` }
      hosts.forEach((h, hi) => { entry[`h${hi}`] = h[metric][i]?.value })
      return entry
    })
  }, [metric, hosts])
  return (
    <div style={{ width: '100%', height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 6, right: 6, left: 0, bottom: 0 }}>
          <CartesianGrid {...GRID_PROPS} />
          <XAxis {...timeAxisProps(data.length)} />
          <YAxis {...valueAxisProps({ format: formatVal, maxValue: maxOf(data, hosts.map((_, hi) => `h${hi}`)) })} />
          <Tooltip content={<MultiTooltip unit={unit} formatVal={formatVal} palette={palette} hosts={hosts} nameKey={nameKey} />} {...NO_ANIM} />
          {hosts.map((h, hi) => (
            <Line {...LINE_PROPS} key={h[nameKey]} dataKey={`h${hi}`} stroke={palette[hi % palette.length]} strokeWidth={1.4} dot={false} activeDot={{ r: 3, strokeWidth: 0 }} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

function MultiTooltip({ active, payload, label, unit, formatVal, palette, hosts = infraHosts, nameKey = 'host' }) {
  if (!active || !payload?.length) return null
  const exactTime = payload[0]?.payload?.exactTime || ''
  return (
    <div style={{ background: 'var(--raised)', border: '1px solid var(--border-panel)', borderRadius: 6, padding: '6px 10px', fontSize: 11, minWidth: 200 }}>
      <div style={{ color: 'var(--text-primary)', fontWeight: 600, marginBottom: 1 }}>{exactTime}</div>
      <div style={{ color: 'var(--text-muted)', fontSize: 10, marginBottom: 4 }}>{label}</div>
      {payload.map((p, i) => (
        <div key={i} style={{ color: palette[i % palette.length], display: 'flex', justifyContent: 'space-between', gap: 12 }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 140, whiteSpace: 'nowrap' }}>{hosts[i]?.[nameKey]}</span>
          <span style={{ fontWeight: 600, flexShrink: 0 }}>{formatVal ? formatVal(p.value) : Math.round(p.value)}{unit}</span>
        </div>
      ))}
    </div>
  )
}

function SingleAreaTooltip({ active, payload, label, unit, formatVal, color }) {
  if (!active || !payload?.length) return null
  const exactTime = payload[0]?.payload?.exactTime || ''
  const raw = payload[0]?.value
  return (
    <div style={{ background: 'var(--raised)', border: '1px solid var(--border-panel)', borderRadius: 6, padding: '5px 9px', fontSize: 11 }}>
      <div style={{ color: 'var(--text-primary)', fontWeight: 600, marginBottom: 1 }}>{exactTime}</div>
      <div style={{ color: 'var(--text-muted)', fontSize: 10, marginBottom: 3 }}>{label}</div>
      <div style={{ color, fontWeight: 600 }}>{formatVal ? formatVal(raw) : Math.round(raw)}{unit}</div>
    </div>
  )
}

function HostChart({ title, series, color, unit, formatVal, value, height = 130 }) {
  const data = useMemo(() => toChartData(series), [series])
  const gid = `hc_${title.replace(/\W/g, '')}`
  return (
    <div className="infra-chart-card">
      <div className="clbl">{title} {value != null && <span className="cval">{value}{unit}</span>}</div>
      <div className="chart-host" style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 6, right: 6, left: 0, bottom: 0 }}>
            <CartesianGrid {...GRID_PROPS} />
            <XAxis {...timeAxisProps(data.length)} />
            <YAxis {...valueAxisProps({ format: formatVal, maxValue: maxOf(data, 'value') })} />
            <Tooltip content={<SingleAreaTooltip color={color} unit={unit} formatVal={formatVal} />} {...NO_ANIM} />
            <Area {...AREA_PROPS} dataKey="value" stroke={color} strokeWidth={1.6} fill={color} dot={false} activeDot={{ r: 3 }} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

function ProcessLegend({ metric }) {
  const [showAll, setShowAll] = useState(false)
  const sorted = useMemo(() => [...HOST_PROCESSES].sort((a, b) => b[metric] - a[metric]), [metric])
  const visible = showAll ? sorted : sorted.slice(0, 6)
  return (
    <div className="infra-chart-legend">
      <div className="ilegend-hdr">Top processes</div>
      {visible.map(p => (
        <div key={p.name} className="ilegend-row">
          <span className="ilegend-swatch" style={{ background: p.color }} />
          <span className="ilegend-name">{p.name}</span>
          <span className="ilegend-val">{p[metric].toFixed(2)}</span>
        </div>
      ))}
      {sorted.length > 6 && (
        <div className="ilegend-showall">
          <span className="ilegend-showall-count">{showAll ? `${sorted.length} of ${sorted.length}` : `6 of ${sorted.length}`}</span>
          <button className="ilegend-showall-btn" onClick={() => setShowAll(s => !s)}>{showAll ? 'Show less' : 'Show all'}</button>
        </div>
      )}
    </div>
  )
}

function OneMetricChart({ title, series, color, height = 160, unit = '', formatVal = v => v.toFixed(1) }) {
  return (
    <div className="infra-chart-full">
      <div className="infra-chart-head"><div className="clbl">{title}</div></div>
      <div className="infra-chart-body">
        <div className="infra-chart-svg-wrap">
          <div style={{ width: '100%', height }}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={toChartData(series)} margin={{ top: 6, right: 6, left: 0, bottom: 0 }}>
                <CartesianGrid {...GRID_PROPS} />
                <XAxis {...timeAxisProps(60)} />
                <YAxis {...valueAxisProps({ format: formatVal, maxValue: maxOf(toChartData(series), 'value') })} />
                <Tooltip content={<SingleAreaTooltip color={color} unit={unit} formatVal={formatVal} />} {...NO_ANIM} />
                <Area {...AREA_PROPS} dataKey="value" stroke={color} strokeWidth={1.6} fill={color} dot={false} activeDot={{ r: 3 }} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  )
}

function HostDetail({ host }) {
  return (
    <div className="infra-host-detail">
      <div className="infra-host-meta">
        <span className={`badge ${host.status}`}>{host.status}</span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>traffic → <span className="mono" style={{ color: 'var(--text-secondary)' }}>{host.service}</span></span>
      </div>

      <div className="infra-detail-grid">
        <div className="infra-chart-full">
          <div className="infra-chart-head">
            <div className="clbl">CPU Used %</div>
            <div className="infra-chart-tabs">
              <span className="ict active">CPU Used %</span>
              <span className="ict">CPU State %</span>
              <span className="ict">Load Average</span>
            </div>
          </div>
          <div className="infra-chart-body">
            <div className="infra-chart-svg-wrap">
              <div style={{ width: '100%', height: '100%', minHeight: 160 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={toChartData(host.cpuSeries)} margin={{ top: 6, right: 6, left: 0, bottom: 0 }}>
                    <CartesianGrid {...GRID_PROPS} />
                    <XAxis {...timeAxisProps(60)} />
                    <YAxis {...valueAxisProps({ maxValue: 100 })} />
                    <Tooltip content={<SingleAreaTooltip color="#F59E0B" unit="%" formatVal={v => v.toFixed(1)} />} {...NO_ANIM} />
                    <Area {...AREA_PROPS} dataKey="value" stroke="#F59E0B" strokeWidth={1.6} fill="#F59E0B" dot={false} activeDot={{ r: 3 }} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
            <ProcessLegend metric="cpu" />
          </div>
        </div>

        <div className="infra-chart-full">
          <div className="infra-chart-head"><div className="clbl">Memory Used %</div></div>
          <div className="infra-chart-body">
            <div className="infra-chart-svg-wrap">
              <div style={{ width: '100%', height: '100%', minHeight: 160 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={toChartData(host.memSeries)} margin={{ top: 6, right: 6, left: 0, bottom: 0 }}>
                    <CartesianGrid {...GRID_PROPS} />
                    <XAxis {...timeAxisProps(60)} />
                    <YAxis {...valueAxisProps({ maxValue: 100 })} />
                    <Tooltip content={<SingleAreaTooltip color="#EF4444" unit="%" formatVal={v => v.toFixed(1)} />} {...NO_ANIM} />
                    <Area {...AREA_PROPS} dataKey="value" stroke="#EF4444" strokeWidth={1.6} fill="#EF4444" dot={false} activeDot={{ r: 3 }} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
            <ProcessLegend metric="mem" />
          </div>
        </div>

        <div className="infra-detail-row">
          <HostChart title="Disk Used %" series={host.diskSeries} color="#34D399" unit="%" formatVal={v => Math.round(v)} value={host.disk.toFixed(1)} height={140} />
          <HostChart title="Network Traffic (bytes/s)" series={host.netInSeries} color="#3B82F6" unit="" formatVal={fmtBytes} value={fmtBytes(host.netIn * (host.unit === 'K' ? 1000 : 1000000))} height={140} />
        </div>
        <div className="infra-detail-row">
          <HostChart title="Disk I/O Utilization %" series={host.diskIoSeries} color="#A78BFA" unit="%" formatVal={v => v.toFixed(1)} value={(host.diskIoSeries[host.diskIoSeries.length - 1]?.value ?? 0).toFixed(1)} height={140} />
        </div>
      </div>
    </div>
  )
}

/* ============ Kubernetes: Cluster ============ */

// One view, two scopes. With a namespace it is the namespace overview that a
// k8s.namespace.name link opens; without one it is the cluster. They share the
// charts and the stat grid because they answer the same question at different
// altitudes - the only real difference is that a node is not namespaced, so the
// node counts drop out when a namespace is selected.
function K8sClusterView({ namespace, setNamespace }) {
  const detail = namespace ? k8sNamespaceDetail(namespace) : null
  const s = detail ?? k8sClusterSummary
  const cards = [
    ...(detail ? [] : [['Nodes Total', s.nodesTotal], ['Nodes Ready', s.nodesReady]]),
    ['Pods Total', s.podsTotal], ['Pods Pending', s.podsPending], ['Pods Failed', s.podsFailed], ['Containers Ready', s.containersReady],
    ['DaemonSets Total', s.daemonSetsTotal], ['DaemonSets Unhealthy', s.daemonSetsUnhealthy],
    ['Deployments Total', s.deploymentsTotal], ['Deployments Unhealthy', s.deploymentsUnhealthy],
    ['HPAs Total', s.hpasTotal],
    ['StatefulSets Total', s.statefulSetsTotal], ['StatefulSets Unhealthy', s.statefulSetsUnhealthy],
    ['ReplicaSets Total', s.replicaSetsTotal], ['ReplicaSets Unhealthy', s.replicaSetsUnhealthy],
    ['Repl. Controllers Total', s.replControllersTotal], ['Repl. Controllers Unhealthy', s.replControllersUnhealthy],
  ]

  const cpuData = useMemo(() => {
    const base = toChartData(k8sCpuAllocation.total)
    return base.map((d, i) => ({ ...d, total: d.value, request: k8sCpuAllocation.request[i]?.value, limit: k8sCpuAllocation.limit[i]?.value, used: k8sCpuAllocation.used[i]?.value }))
  }, [])
  const memData = useMemo(() => {
    const base = toChartData(k8sMemAllocation.total)
    return base.map((d, i) => ({ ...d, total: d.value, request: k8sMemAllocation.request[i]?.value, limit: k8sMemAllocation.limit[i]?.value, used: k8sMemAllocation.used[i]?.value }))
  }, [])
  const containersData = useMemo(() => {
    const base = toChartData(k8sContainersSeries.ready)
    return base.map((d, i) => ({ ...d, ready: d.value, notReady: k8sContainersSeries.notReady[i]?.value }))
  }, [])

  return (
    <>
      {detail && (
        <div className="infra-drill-head">
          <button className="infra-back" onClick={() => setNamespace(null)} aria-label="Back to cluster">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5M12 19l-7-7 7-7" /></svg>
          </button>
          <div className="k8s-selector">
            <span className="k8s-selector-lbl">Namespace</span>
            <span className="k8s-selector-val">{namespace}</span>
          </div>
        </div>
      )}
      <div className="infra-row-charts">
        <div className="infra-chart-card">
          <div className="clbl">CPU Allocation (cores)</div>
          <div style={{ height: 130 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={cpuData} margin={{ top: 6, right: 6, left: 0, bottom: 0 }}>
                <CartesianGrid {...GRID_PROPS} />
                <XAxis {...timeAxisProps(60)} />
                <YAxis {...valueAxisProps({ maxValue: maxOf(cpuData, ['total', 'request', 'limit', 'used']) })} />
                <Tooltip content={<SingleAreaTooltip color="#34D399" unit=" cores" formatVal={v => v.toFixed(2)} />} {...NO_ANIM} />
                <Line {...LINE_PROPS} dataKey="total" stroke="#34D399" strokeWidth={1.4} strokeDasharray="4 3" dot={false} />
                <Line {...LINE_PROPS} dataKey="request" stroke="#F59E0B" strokeWidth={1.4} dot={false} />
                <Line {...LINE_PROPS} dataKey="limit" stroke="#EF4444" strokeWidth={1.4} dot={false} />
                <Line {...LINE_PROPS} dataKey="used" stroke="#3B82F6" strokeWidth={1.6} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="k8s-alloc-legend">
            <span className="k8s-alloc-legend-item"><span className="sw dashed" style={{ color: '#34D399' }} /> Total</span>
            <span className="k8s-alloc-legend-item"><span className="sw" style={{ background: '#F59E0B' }} /> Request</span>
            <span className="k8s-alloc-legend-item"><span className="sw" style={{ background: '#EF4444' }} /> Limit</span>
            <span className="k8s-alloc-legend-item"><span className="sw" style={{ background: '#3B82F6' }} /> Used</span>
          </div>
        </div>
        <div className="infra-chart-card">
          <div className="clbl">Memory Allocation (bytes)</div>
          <div style={{ height: 130 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={memData} margin={{ top: 6, right: 6, left: 0, bottom: 0 }}>
                <CartesianGrid {...GRID_PROPS} />
                <XAxis {...timeAxisProps(60)} />
                <YAxis {...valueAxisProps({ format: fmtBytes, maxValue: maxOf(memData, ['total', 'request', 'limit', 'used']) })} />
                <Tooltip content={<SingleAreaTooltip color="#34D399" unit="" formatVal={fmtBytes} />} {...NO_ANIM} />
                <Line {...LINE_PROPS} dataKey="total" stroke="#34D399" strokeWidth={1.4} strokeDasharray="4 3" dot={false} />
                <Line {...LINE_PROPS} dataKey="used" stroke="#3B82F6" strokeWidth={1.6} dot={false} />
                <Line {...LINE_PROPS} dataKey="limit" stroke="#EF4444" strokeWidth={1.4} dot={false} />
                <Line {...LINE_PROPS} dataKey="request" stroke="#A78BFA" strokeWidth={1.4} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="k8s-alloc-legend">
            <span className="k8s-alloc-legend-item"><span className="sw dashed" style={{ color: '#34D399' }} /> Total</span>
            <span className="k8s-alloc-legend-item"><span className="sw" style={{ background: '#3B82F6' }} /> Used</span>
            <span className="k8s-alloc-legend-item"><span className="sw" style={{ background: '#EF4444' }} /> Limit</span>
            <span className="k8s-alloc-legend-item"><span className="sw" style={{ background: '#A78BFA' }} /> Request</span>
          </div>
        </div>
        <div className="infra-chart-card">
          <div className="clbl">Containers</div>
          <div style={{ height: 130 }}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={containersData} margin={{ top: 6, right: 6, left: 0, bottom: 0 }}>
                <CartesianGrid {...GRID_PROPS} />
                <XAxis {...timeAxisProps(60)} />
                <YAxis {...valueAxisProps({ format: fmtCount, allowDecimals: false, maxValue: 99 })} />
                <Tooltip content={<SingleAreaTooltip color="#F59E0B" unit="" formatVal={v => Math.round(v)} />} {...NO_ANIM} />
                <Area {...AREA_PROPS} dataKey="ready" stackId="c" stroke="#F59E0B" fill="#F59E0B" fillOpacity={0.5} strokeWidth={1.4} dot={false} />
                <Area {...AREA_PROPS} dataKey="notReady" stackId="c" stroke="#3B82F6" fill="#3B82F6" fillOpacity={0.5} strokeWidth={1.4} dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      <div className="k8s-stat-grid">
        {cards.map(([lbl, val]) => {
          const isUnhealthy = lbl.includes('Unhealthy') && val > 0
          const isZeroNeutral = val === 0 && !lbl.includes('Ready') && !lbl.includes('Total')
          return (
            <div key={lbl} className="k8s-stat-card">
              <div className="k8s-stat-lbl">{lbl}</div>
              <div className={`k8s-stat-val${isUnhealthy ? ' unhealthy' : isZeroNeutral ? ' zero' : ''}`}>{val}</div>
            </div>
          )
        })}
      </div>

      {detail ? (
        <div className="panel">
          <div className="panel-head">Pods <span className="hint">{detail.podsTotal} in {namespace}</span></div>
          <div className="appdb-summary-head" style={{ gridTemplateColumns: '1fr 160px 110px 130px 110px' }}>
            <span>Pod</span><span style={{ textAlign: 'left' }}>Node</span><span>CPU Used</span><span>Memory Used</span><span>Memory Limit</span>
          </div>
          {detail.pods.map(pod => (
            <div key={pod.name} className="appdb-summary-row" style={{ gridTemplateColumns: '1fr 160px 110px 130px 110px' }}>
              <span className="host-cell mono">{pod.name}</span>
              <span className="host-cell mono" style={{ textAlign: 'left' }}>{pod.node}</span>
              <span className="num-cell">{pod.cpuUsed}</span>
              <span className="num-cell">{fmtBytes(pod.memUsed)}</span>
              <span className="num-cell">{pod.memLimit ? fmtBytes(pod.memLimit) : '-'}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="panel">
          <div className="panel-head">Summary <span className="hint">Resource usage by namespace &middot; click a row to scope</span></div>
          <div className="appdb-summary-head" style={{ gridTemplateColumns: '1fr 110px 110px 110px 120px 120px 120px 90px' }}>
            <span>Namespace</span><span>CPU Used</span><span>CPU Request</span><span>CPU Limit</span><span>Memory Used</span><span>Memory Request</span><span>Memory Limit</span><span>Containers</span>
          </div>
          {k8sNamespaceSummary.map(n => (
            <div
              key={n.namespace}
              className="appdb-summary-row is-clickable"
              style={{ gridTemplateColumns: '1fr 110px 110px 110px 120px 120px 120px 90px' }}
              onClick={() => setNamespace(n.namespace)}
            >
              <span className="host-cell mono">{n.namespace}</span>
              <span className="num-cell">{n.cpuUsed}</span>
              <span className="num-cell">{n.cpuRequest}</span>
              <span className="num-cell">{n.cpuLimit ?? '-'}</span>
              <span className="num-cell">{fmtBytes(n.memUsed)}</span>
              <span className="num-cell">{fmtBytes(n.memRequest)}</span>
              <span className="num-cell">{fmtBytes(n.memLimit)}</span>
              <span className="num-cell">{n.containers}</span>
            </div>
          ))}
        </div>
      )}

      <div className="k8s-events">
        <div className="k8s-events-head">Events</div>
        <div className="k8s-events-query">
          <input readOnly value='NOT object.type:="Normal"' />
          <button className="k8s-events-search-btn">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>
            Search
          </button>
          <a className="k8s-events-logs-link" href="#" onClick={e => e.preventDefault()}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M9 18l6-6-6-6" /></svg>
            Search in Logs
          </a>
        </div>
        <div className="err-head" style={{ gridTemplateColumns: '130px 100px 140px 1fr 100px 1fr' }}>
          <span>Time</span><span>Type</span><span>Namespace</span><span>Name</span><span>Kind</span><span>Note</span>
        </div>
        <div className="err-empty">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9 12l2 2 4-4" /><circle cx="12" cy="12" r="10" /></svg>
          <div>No abnormal events in the selected time range</div>
        </div>
      </div>
    </>
  )
}

/* ============ Kubernetes: Deployment ============ */

function K8sDeploymentView() {
  return (
    <>
      <div className="infra-chart-card" style={{ marginBottom: 20 }}>
        <div className="clbl">Pods Desired but not Available</div>
        <div style={{ height: 130 }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={toChartData(k8sContainersSeries.notReady)} margin={{ top: 6, right: 6, left: 0, bottom: 0 }}>
              <CartesianGrid {...GRID_PROPS} />
              <XAxis {...timeAxisProps(60)} />
              <YAxis {...valueAxisProps({ format: fmtCount, allowDecimals: false, maxValue: 99 })} />
              <Tooltip content={<SingleAreaTooltip color="#EF4444" unit="" formatVal={v => Math.round(v)} />} {...NO_ANIM} />
              <Line {...LINE_PROPS} dataKey="value" stroke="#EF4444" strokeWidth={1.6} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
      <div className="panel">
        <div className="panel-head">Summary <span className="hint">Deployments by namespace</span></div>
        <div className="appdb-summary-head" style={{ gridTemplateColumns: '1fr 130px 130px 130px' }}>
          <span>Namespace</span><span>Deployments</span><span>Pods Desired</span><span>Pods Available</span>
        </div>
        {k8sDeploymentSummary.map(n => (
          <div key={n.namespace} className="appdb-summary-row" style={{ gridTemplateColumns: '1fr 130px 130px 130px' }}>
            <span className="host-cell mono">{n.namespace}</span>
            <span className="num-cell">{n.deployments}</span>
            <span className="num-cell">{n.podsDesired}</span>
            <span className="num-cell">{n.podsAvailable}</span>
          </div>
        ))}
      </div>
    </>
  )
}

/* ============ Kubernetes: Node → Pod drill-in ============ */

function K8sPodDetail({ pod }) {
  return (
    <div>
      <div className="infra-host-meta">
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>namespace <span className="mono" style={{ color: 'var(--text-secondary)' }}>{pod.namespace}</span></span>
      </div>

      <div className="k8s-containers-table">
        <div className="k8s-containers-head">Containers</div>
        <div className="appdb-summary-head" style={{ gridTemplateColumns: '1fr 110px 120px 110px 120px 130px 120px' }}>
          <span>Container</span><span>CPU Used</span><span>CPU Request</span><span>CPU Limit</span><span>Memory Used</span><span>Memory Request</span><span>Memory Limit</span>
        </div>
        <div className="appdb-summary-row" style={{ gridTemplateColumns: '1fr 110px 120px 110px 120px 130px 120px' }}>
          <span className="host-cell mono">{pod.containerName}</span>
          <span className="num-cell">{pod.cpuUsed}</span>
          <span className="num-cell">{pod.cpuRequest}</span>
          <span className="num-cell">{pod.cpuLimit}</span>
          <span className="num-cell">{fmtBytes(pod.memUsed)}</span>
          <span className="num-cell">{fmtBytes(pod.memRequest)}</span>
          <span className="num-cell">{fmtBytes(pod.memLimit)}</span>
        </div>
      </div>

      <div className="infra-detail-grid">
        <OneMetricChart title="CPU Used (cores)" series={pod.cpuSeries} color="#F59E0B" unit=" cores" formatVal={v => v.toFixed(3)} />
        <OneMetricChart title="Memory Used (bytes)" series={pod.memSeries} color="#EF4444" unit="" formatVal={fmtBytes} />
        <HostChart title="Disk Used %" series={pod.diskSeries} color="#34D399" unit="%" formatVal={v => Math.round(v)} height={140} />
        <div className="infra-detail-row">
          <HostChart title="Container Restarts" series={pod.restartsSeries} color="#F59E0B" unit="" formatVal={v => Math.round(v)} height={140} />
          <HostChart title="Network Traffic (bytes/s)" series={pod.netInSeries} color="#3B82F6" unit="" formatVal={fmtBytes} height={140} />
        </div>
      </div>
    </div>
  )
}

function K8sNodeDetail({ node, onSelectPod }) {
  const [podQuery, setPodQuery] = useState('')

  const onNode = useMemo(() => k8sPods.filter(p => p.node === node.name), [node.name])

  // A query that does not parse filters nothing: the row list should not empty
  // itself while someone is halfway through typing an operator.
  const { node: queryNode, ok } = parsePodQuery(podQuery)
  const shown = useMemo(
    () => (ok ? onNode.filter(p => matchesPod(queryNode, p)) : onNode),
    [onNode, queryNode, ok],
  )
  const hits = useMemo(() => (ok ? highlightsFor(queryNode) : { pod: [], namespace: [] }), [queryNode, ok])
  const tagHits = useMemo(() => (ok ? tagHighlightsFor(queryNode) : {}), [queryNode, ok])

  return (
    <div>
      <div className="infra-row-charts">
        <HostChart title="CPU Used %" series={node.cpuSeries} color="#F59E0B" unit="%" formatVal={v => Math.round(v)} value={node.cpu.toFixed(1)} />
        <HostChart title="Memory Used %" series={node.memSeries} color="#EF4444" unit="%" formatVal={v => Math.round(v)} value={node.mem.toFixed(1)} />
        <HostChart title="Disk Used %" series={node.diskSeries} color="#34D399" unit="%" formatVal={v => Math.round(v)} value={node.disk.toFixed(1)} />
      </div>

      <div className="infra-chart-card" style={{ marginBottom: 20 }}>
        <div className="clbl">Network Traffic (bytes/s)</div>
        <div style={{ height: 160 }}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={useMemo(() => {
              const base = toChartData(node.netInSeries)
              return base.map((d, i) => ({ ...d, transmit: node.netOutSeries[i]?.value, receive: d.value }))
            }, [node])} margin={{ top: 6, right: 6, left: 0, bottom: 0 }}>
              <CartesianGrid {...GRID_PROPS} />
              <XAxis {...timeAxisProps(60)} />
              <YAxis {...valueAxisProps({ format: fmtBytes, maxValue: 1e9 })} />
              <Tooltip content={<SingleAreaTooltip color="#3B82F6" unit="" formatVal={fmtBytes} />} {...NO_ANIM} />
              <Area {...AREA_PROPS} dataKey="transmit" stackId="n" stroke="#F59E0B" fill="#F59E0B" fillOpacity={0.4} strokeWidth={1.4} dot={false} />
              <Area {...AREA_PROPS} dataKey="receive" stackId="n" stroke="#3B82F6" fill="#3B82F6" fillOpacity={0.4} strokeWidth={1.4} dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head is-stacked">
          <div className="panel-head-row">
            <span>Pods</span>
            <span className="hint">
              {podQuery.trim()
                ? `${shown.length} of ${onNode.length} pods`
                : `${node.pods} pods scheduled · click a row to inspect`}
            </span>
          </div>
          <TableQuerySearch onApply={setPodQuery} fields={POD_FIELDS} />
        </div>
        <div className="appdb-summary-head" style={{ gridTemplateColumns: '1fr 120px 110px 130px 130px 110px 110px' }}>
          <span>Pod</span><span style={{ textAlign: 'left' }}>Namespace</span><span>CPU Used</span><span>Memory Used</span><span>Memory Remaining</span><span>Network In</span><span>Network Out</span>
        </div>
        {shown.length === 0 && (
          <div className="pod-empty-row">No data matches “{podQuery.trim()}”.</div>
        )}
        {shown.map(p => (
          <div key={p.name} className="appdb-summary-row" style={{ gridTemplateColumns: '1fr 120px 110px 130px 130px 110px 110px', cursor: 'pointer' }} onClick={() => onSelectPod(p)}>
            <span className="host-cell mono">
              <span className="host-cell-name">{highlightTerms(p.name, hits.pod, 'svc-hit')}</span>
              {Object.entries(p.labels ?? {}).map(([k, v]) => (
                <span key={k} className="svc-tag" title={`${k}: ${v} — search as pod.${k}:${v}`}>
                  <span className="svc-tag-k">{k}</span>
                  <span className="svc-tag-v">{highlightTerms(v, tagTerms(tagHits, 'pod', k), 'svc-hit')}</span>
                </span>
              ))}
            </span>
            <span className="num-cell" style={{ textAlign: 'left', fontFamily: "'JetBrains Mono',monospace", color: 'var(--text-secondary)' }}>{highlightTerms(p.namespace, hits.namespace, 'svc-hit')}</span>
            <span className="num-cell">{p.cpuUsed}</span>
            <span className="num-cell">{fmtBytes(p.memUsed)}</span>
            <span className="num-cell">{p.memRequest ? fmtBytes(p.memRequest - p.memUsed) : '-'}</span>
            <span className="num-cell">-</span>
            <span className="num-cell">-</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function K8sNodeView({ selectedNode, setSelectedNode, selectedPod, setSelectedPod }) {
  if (selectedPod) {
    return <K8sPodDetail pod={selectedPod} />
  }
  if (selectedNode) {
    return <K8sNodeDetail node={selectedNode} onSelectPod={setSelectedPod} />
  }
  return (
    <>
      <div className="infra-row-charts">
        <div className="infra-chart-card">
          <div className="clbl">CPU Used %</div>
          <MultiHostChart metric="cpuSeries" unit="%" formatVal={v => Math.round(v)} palette={['#3B82F6', '#A78BFA']} hosts={k8sNodes} nameKey="name" />
        </div>
        <div className="infra-chart-card">
          <div className="clbl">Memory Used %</div>
          <MultiHostChart metric="memSeries" unit="%" formatVal={v => Math.round(v)} palette={['#3B82F6', '#A78BFA']} hosts={k8sNodes} nameKey="name" />
        </div>
        <div className="infra-chart-card">
          <div className="clbl">Disk Used %</div>
          <MultiHostChart metric="diskSeries" unit="%" formatVal={v => Math.round(v)} palette={['#3B82F6', '#A78BFA']} hosts={k8sNodes} nameKey="name" />
        </div>
      </div>
      <div className="panel">
        <div className="panel-head">Summary <span className="hint">{k8sNodes.length} nodes · click a row to drill in</span></div>
        <div className="appdb-summary-head" style={{ gridTemplateColumns: '1fr 110px 110px 110px 110px 110px 80px' }}>
          <span>Node</span><span>CPU Used %</span><span>Memory Used %</span><span>Disk Used %</span><span>Network In</span><span>Network Out</span><span>Pods</span>
        </div>
        {k8sNodes.map(n => (
          <div key={n.name} className="appdb-summary-row" style={{ gridTemplateColumns: '1fr 110px 110px 110px 110px 110px 80px', cursor: 'pointer' }} onClick={() => setSelectedNode(n)}>
            <span className="host-cell mono"><span className={`status-dot ${n.status}`} style={{ marginRight: 8 }} />{n.name}</span>
            <span className="num-cell">{n.cpu.toFixed(2)}</span>
            <span className="num-cell">{n.mem.toFixed(2)}</span>
            <span className="num-cell">{n.disk.toFixed(2)}</span>
            <span className="num-cell">{n.netIn.toFixed(2)}{n.unit}</span>
            <span className="num-cell">{n.netOut.toFixed(2)}{n.unit}</span>
            <span className="num-cell">{n.pods}</span>
          </div>
        ))}
      </div>
    </>
  )
}

function K8sPodListView({ selectedPod, setSelectedPod }) {
  const [query, setQuery] = useState('')

  const { node: queryNode, ok } = parsePodQuery(query, POD_NODE_FIELDS)
  const shown = useMemo(
    () => (ok ? k8sPods.filter(p => matchesPod(queryNode, p, POD_NODE_FIELDS)) : k8sPods),
    [queryNode, ok],
  )
  const hits = useMemo(
    () => (ok ? highlightsFor(queryNode, POD_NODE_FIELDS) : { pod: [], namespace: [], node: [] }),
    [queryNode, ok],
  )
  const tagHits = useMemo(() => (ok ? tagHighlightsFor(queryNode, POD_NODE_FIELDS) : {}), [queryNode, ok])

  if (selectedPod) return <K8sPodDetail pod={selectedPod} />
  return (
    <div className="panel">
      <div className="panel-head is-stacked">
        <div className="panel-head-row">
          <span>Pods</span>
          <span className="hint">
            {query.trim()
              ? `${shown.length} of ${k8sPods.length} pods`
              : `${k8sPods.length} pods across ${k8sNodes.length} nodes · click a row to inspect`}
          </span>
        </div>
        <TableQuerySearch onApply={setQuery} fields={POD_NODE_FIELDS} />
      </div>
      <div className="appdb-summary-head" style={{ gridTemplateColumns: '1fr 120px 150px 110px 130px 110px' }}>
        <span>Pod</span><span style={{ textAlign: 'left' }}>Namespace</span><span style={{ textAlign: 'left' }}>Node</span><span>CPU Used</span><span>Memory Used</span><span>Restarts</span>
      </div>
      {shown.length === 0 && (
        <div className="pod-empty-row">No data matches “{query.trim()}”.</div>
      )}
      {shown.map(p => (
        <div key={p.name} className="appdb-summary-row" style={{ gridTemplateColumns: '1fr 120px 150px 110px 130px 110px', cursor: 'pointer' }} onClick={() => setSelectedPod(p)}>
          <span className="host-cell mono">
            <span className="host-cell-name">{highlightTerms(p.name, hits.pod, 'svc-hit')}</span>
            {Object.entries(p.labels ?? {}).map(([k, v]) => (
              <span key={k} className="svc-tag" title={`${k}: ${v} — search as pod.${k}:${v}`}>
                <span className="svc-tag-k">{k}</span>
                <span className="svc-tag-v">{highlightTerms(v, tagTerms(tagHits, 'pod', k), 'svc-hit')}</span>
              </span>
            ))}
          </span>
          <span className="num-cell" style={{ textAlign: 'left', fontFamily: "'JetBrains Mono',monospace", color: 'var(--text-secondary)' }}>{highlightTerms(p.namespace, hits.namespace, 'svc-hit')}</span>
          <span className="num-cell" style={{ textAlign: 'left', fontFamily: "'JetBrains Mono',monospace", color: 'var(--text-secondary)' }}>{highlightTerms(p.node, hits.node, 'svc-hit')}</span>
          <span className="num-cell">{p.cpuUsed}</span>
          <span className="num-cell">{fmtBytes(p.memUsed)}</span>
          <span className="num-cell">0</span>
        </div>
      ))}
    </div>
  )
}

/* ============ Kubernetes: namespace-gated resources (PVC-style) ============ */

function K8sNamespaceGateView({ resourceLabel }) {
  const [namespace, setNamespace] = useState(null)
  const [search, setSearch] = useState('')
  const filtered = K8S_NAMESPACES.filter(n => n.toLowerCase().includes(search.toLowerCase()))

  if (namespace) {
    return (
      <div>
        <div className="k8s-selector-row">
          <button className="infra-back" onClick={() => setNamespace(null)} aria-label="Back">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
          </button>
          <div className="k8s-selector"><span className="k8s-selector-lbl">Namespace</span><span className="k8s-selector-val">{namespace}</span></div>
        </div>
        <div className="infra-empty-table">
          <div className="infra-empty-table-head"><span>{resourceLabel}</span><span>Used</span><span>Capacity</span></div>
          <div className="err-empty">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9 12l2 2 4-4" /><circle cx="12" cy="12" r="10" /></svg>
            <div>No {resourceLabel.toLowerCase()} resources in "{namespace}"</div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="infra-namespace-select">
      <div className="infra-namespace-select-title">Select Namespace</div>
      <div className="infra-namespace-search">
        <input placeholder="Search…" value={search} onChange={e => setSearch(e.target.value)} />
      </div>
      {filtered.map(n => (
        <label key={n} className="infra-namespace-opt" onClick={() => setNamespace(n)}>
          <input type="radio" readOnly checked={false} />
          {n}
        </label>
      ))}
    </div>
  )
}

/* ============ Generic empty state (AWS / GCP sub-services, disconnected KBs resources) ============ */

function InfraEmptyView({ columns }) {
  return (
    <>
      <div className="infra-empty-charts">
        {['Requests per Minute', 'Errors', 'Latency'].map(t => (
          <div key={t} className="infra-chart-card">
            <div className="clbl">{t}</div>
            <div style={{ height: 130 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={toChartData(Array.from({ length: 60 }, (_, i) => ({ m: 59 - i, value: 0 })))} margin={{ top: 6, right: 6, left: 0, bottom: 0 }}>
                  <CartesianGrid {...GRID_PROPS} />
                  <XAxis {...timeAxisProps(60)} />
                  <YAxis {...valueAxisProps({ domain: [0, 1], maxValue: 1 })} />
                  <Line {...LINE_PROPS} dataKey="value" stroke="var(--text-muted)" strokeWidth={1} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        ))}
      </div>
      <div className="infra-empty-table">
        <div className="infra-empty-table-head">
          <span>{columns[0]}</span>
          {columns.slice(1).map(c => <span key={c}>{c}</span>)}
        </div>
        <div className="err-empty">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9 12l2 2 4-4" /><circle cx="12" cy="12" r="10" /></svg>
          <div>No data</div>
        </div>
      </div>
    </>
  )
}

/* ============ MySQL / Redis dedicated dashboards ============ */

function MySQLView() {
  const s = mysqlSummary
  return (
    <>
      <div className="infra-row-charts">
        <HostChart title="Operations per Minute" series={mysqlSeries.opsPerMin} color="#34D399" unit="" formatVal={v => Math.round(v)} value={s.opsPerMin} />
        <HostChart title="Connection Errors per Minute" series={mysqlSeries.connErrors} color="#EF4444" unit="" formatVal={v => Math.round(v)} value={s.connErrPerMin} />
        <HostChart title="Slow Queries per Minute" series={mysqlSeries.slowQueries} color="#F59E0B" unit="" formatVal={v => Math.round(v)} value={s.slowQueriesPerMin} />
      </div>
      <div className="panel">
        <div className="panel-head">Summary</div>
        <div className="appdb-summary-head" style={{ gridTemplateColumns: '1fr 110px 120px 150px 120px 130px 130px' }}>
          <span>Host</span><span>Connections</span><span>Operations / min</span><span>Connection Errors / min</span><span>Slow Queries / min</span><span>Replication Lag</span><span>Database Size</span>
        </div>
        <div className="appdb-summary-row" style={{ gridTemplateColumns: '1fr 110px 120px 150px 120px 130px 130px' }}>
          <span className="host-cell">{s.host}</span>
          <span className="num-cell">{s.connections}</span>
          <span className="num-cell">{s.opsPerMin}</span>
          <span className="num-cell">{s.connErrPerMin}</span>
          <span className="num-cell">{s.slowQueriesPerMin}</span>
          <span className="num-cell">{s.replicationLag ?? '-'}</span>
          <span className="num-cell">{fmtBytes(s.dbSizeBytes)}</span>
        </div>
      </div>
    </>
  )
}

function RedisView() {
  const s = redisSummary
  return (
    <>
      <div className="infra-row-charts">
        <HostChart title="Memory Used (bytes)" series={redisSeries.memUsed} color="#EF4444" unit="" formatVal={fmtBytes} value={fmtBytes(s.memUsedBytes)} />
        <HostChart title="Commands per Minute" series={redisSeries.cmdPerMin} color="#3B82F6" unit="" formatVal={v => Math.round(v)} value={s.cmdPerMin} />
        <HostChart title="Evictions per Minute" series={redisSeries.evictionsPerMin} color="#F59E0B" unit="" formatVal={v => Math.round(v)} value={redisSeries.evictionsPerMin[redisSeries.evictionsPerMin.length - 1]?.value} />
      </div>
      <div className="panel">
        <div className="panel-head">Summary <span className="hint">{s.status === 'critical' ? 'Connection pool under pressure - see payment-service incident' : ''}</span></div>
        <div className="appdb-summary-head" style={{ gridTemplateColumns: '1fr 110px 120px 110px 130px 100px' }}>
          <span>Host</span><span>Connections</span><span>Connections / min</span><span>Commands / min</span><span>Memory Used</span><span>Cache Hit %</span>
        </div>
        <div className="appdb-summary-row" style={{ gridTemplateColumns: '1fr 110px 120px 110px 130px 100px' }}>
          <span className="host-cell mono"><span className={`status-dot ${s.status}`} style={{ marginRight: 8 }} />{s.host}</span>
          <span className="num-cell">{s.connections}</span>
          <span className="num-cell">{s.connPerMin}</span>
          <span className="num-cell">{s.cmdPerMin}</span>
          <span className="num-cell">{fmtBytes(s.memUsedBytes)}</span>
          <span className={`num-cell ${s.cacheHitPct < 80 ? 'val-warning' : ''}`}>{s.cacheHitPct}%</span>
        </div>
      </div>
    </>
  )
}

/* ============ Root dispatcher ============ */

const K8S_EMPTY_COLUMNS = {
  'k8s-cronjob': ['CronJob', 'Namespace', 'Last Schedule', 'Active'],
  'k8s-daemonset': ['DaemonSet', 'Namespace', 'Desired', 'Ready'],
  'k8s-hpa': ['HPA', 'Namespace', 'Min', 'Max', 'Current'],
  'k8s-ingress-controller-nginx': ['Ingress', 'Namespace', 'Requests / min', 'Errors / min'],
  'k8s-job': ['Job', 'Namespace', 'Completions', 'Duration'],
  'k8s-replicaset': ['ReplicaSet', 'Namespace', 'Desired', 'Available'],
  'k8s-statefulset': ['StatefulSet', 'Namespace', 'Desired', 'Ready'],
}

function CrumbSelect({ value, options, onSelect, searchPlaceholder = 'Search…' }) {
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
  const panelW = Math.max(rect?.width || 200, 200)

  return (
    <>
      <span
        ref={btnRef}
        className={`crumb-select${open ? ' open' : ''}`}
        onClick={(e) => { e.stopPropagation(); setOpen(o => !o) }}
      >
        <span className="current mono">{value}</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
      </span>
      {open && rect && (
        <div
          ref={ref}
          className="dd-panel"
          style={{ position: 'fixed', top: rect.bottom + 4, left: rect.left, minWidth: panelW, zIndex: 500 }}
          onClick={e => e.stopPropagation()}
        >
          <div className="dd-search">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>
            <input placeholder={searchPlaceholder} value={search} onChange={e => setSearch(e.target.value)} autoFocus />
          </div>
          <div className="dd-list">
            {filtered.map(o => (
              <div key={o} className={`dd-item${o === value ? ' active' : ''}`} onClick={() => { onSelect(o); close() }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="dd-item-check"><path d="M20 6L9 17l-5-5" /></svg>
                <span className="mono">{o}</span>
              </div>
            ))}
            {filtered.length === 0 && <div className="dd-item" style={{ opacity: .5, cursor: 'default' }}>No matches</div>}
          </div>
        </div>
      )}
    </>
  )
}

export default function InfraView({ goHome, source, resource, selectedHost, setSelectedHost, timeRange, setTimeRange, settingsOpen, setSettingsOpen }) {
  const PALETTE = ['#3B82F6', '#A78BFA', '#F472B6', '#34D399', '#F59E0B', '#60A5FA', '#EC4899']
  // Seeded from the incoming link, so /infra?tab=k8s-cluster&section=kube-system
  // arrives already scoped. App remounts on a resource change, so this only has
  // to be right at mount.
  const [k8sNode, setK8sNode] = useState(() => (source === 'k8s-node' ? resource ?? null : null))
  const [k8sNamespace, setK8sNamespace] = useState(() => (source === 'k8s-cluster' ? resource ?? null : null))
  const [k8sPod, setK8sPod] = useState(() => (source === 'k8s-pod' ? resource ?? null : null))

  const host = selectedHost ? infraHosts.find(h => h.host === selectedHost) : null
  const meta = INFRA_SOURCE_INDEX[source]
  const sourceLabel = meta?.label || 'Host'
  const crumbParent = meta?.parent

  let body
  if (host) {
    body = <HostDetail host={host} />
  } else if (source === 'host') {
    body = (
      <>
        <div className="infra-row-charts">
          <div className="infra-chart-card">
            <div className="clbl">CPU Used % <span className="cval">per host</span></div>
            <MultiHostChart metric="cpuSeries" unit="%" formatVal={v => Math.round(v)} palette={PALETTE} />
          </div>
          <div className="infra-chart-card">
            <div className="clbl">Memory Used % <span className="cval">per host</span></div>
            <MultiHostChart metric="memSeries" unit="%" formatVal={v => Math.round(v)} palette={PALETTE} />
          </div>
          <div className="infra-chart-card">
            <div className="clbl">Disk Used % <span className="cval">per host</span></div>
            <MultiHostChart metric="diskSeries" unit="%" formatVal={v => Math.round(v)} palette={PALETTE} />
          </div>
        </div>

        <div className="panel">
          <div className="panel-head">Summary <span className="hint">{infraHosts.length} hosts · sortable · click a row to drill in</span></div>
          <div className="infra-summary-head">
            <span>Host</span>
            <span>Service</span>
            <span>CPU %</span>
            <span>Mem %</span>
            <span>Disk %</span>
            <span>Net In</span>
            <span>Net Out</span>
          </div>
          {[...infraHosts].sort((a, b) => (a.status === 'critical' ? -2 : a.status === 'warning' ? -1 : 0) - (b.status === 'critical' ? -2 : b.status === 'warning' ? -1 : 0) || b.cpu - a.cpu).map(h => {
            const cpuCls = h.cpu >= 85 ? 'val-critical' : h.cpu >= 70 ? 'val-warning' : ''
            const memCls = h.mem >= 85 ? 'val-critical' : h.mem >= 70 ? 'val-warning' : ''
            return (
              <div key={h.host} className="infra-summary-row" onClick={() => setSelectedHost(h.host)}>
                <span className="isr-host">
                  <span className={`status-dot ${h.status}`} />
                  <span className="mono">{h.host}</span>
                </span>
                <span className="mono" style={{ color: 'var(--text-secondary)', fontSize: 11 }}>{h.service}</span>
                <span className="isr-bar">
                  <span className="track"><span className="fill" style={{ width: `${h.cpu}%`, background: h.cpu >= 85 ? 'var(--critical)' : h.cpu >= 70 ? 'var(--warning)' : 'var(--brand)' }} /></span>
                  <span className={`isr-val ${cpuCls}`}>{h.cpu.toFixed(2)}</span>
                </span>
                <span className="isr-bar">
                  <span className="track"><span className="fill" style={{ width: `${h.mem}%`, background: h.mem >= 85 ? 'var(--critical)' : h.mem >= 70 ? 'var(--warning)' : 'var(--brand)' }} /></span>
                  <span className={`isr-val ${memCls}`}>{h.mem.toFixed(2)}</span>
                </span>
                <span className="isr-bar">
                  <span className="track"><span className="fill" style={{ width: `${h.disk}%`, background: 'var(--brand)' }} /></span>
                  <span className="isr-val">{h.disk.toFixed(1)}</span>
                </span>
                <span className="isr-val mono">{h.netIn.toFixed(2)}{h.unit}</span>
                <span className="isr-val mono">{h.netOut.toFixed(2)}{h.unit}</span>
              </div>
            )
          })}
        </div>
      </>
    )
  } else if (source === 'mysql') {
    body = <MySQLView />
  } else if (source === 'redis') {
    body = <RedisView />
  } else if (source === 'k8s-cluster') {
    body = <K8sClusterView namespace={k8sNamespace} setNamespace={setK8sNamespace} />
  } else if (source === 'k8s-node') {
    body = <K8sNodeView selectedNode={k8sNode} setSelectedNode={setK8sNode} selectedPod={k8sPod} setSelectedPod={setK8sPod} />
  } else if (source === 'k8s-pod') {
    body = <K8sPodListView selectedPod={k8sPod} setSelectedPod={setK8sPod} />
  } else if (source === 'k8s-deployment') {
    body = <K8sDeploymentView />
  } else if (source === 'k8s-pvc') {
    body = <K8sNamespaceGateView resourceLabel="PVC" />
  } else if (K8S_EMPTY_COLUMNS[source]) {
    body = <InfraEmptyView label={sourceLabel} columns={K8S_EMPTY_COLUMNS[source]} />
  } else if (source.startsWith('aws-')) {
    body = <InfraEmptyView label={sourceLabel} columns={[sourceLabel.includes('EC2') ? 'Instance' : 'Resource', 'Requests / min', 'Errors / min', 'Latency']} />
  } else if (source.startsWith('gcp-')) {
    body = <InfraEmptyView label={sourceLabel} columns={['Resource', 'Requests / min', 'Errors / min', 'Latency']} />
  } else {
    body = (
      <div className="panel">
        <div className="placeholder">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="20" height="20"><rect x="3" y="4" width="18" height="6" rx="1" /><rect x="3" y="14" width="18" height="6" rx="1" /></svg>
          <div>{sourceLabel} - connect an integration to start ingesting metrics.</div>
        </div>
      </div>
    )
  }

  return (
    <>
      <PageBar
        timeRange={timeRange}
        setTimeRange={setTimeRange}
        showSettings
        settingsOpen={settingsOpen}
        setSettingsOpen={setSettingsOpen}
      >
        <a onClick={goHome}>CubeAPM</a>
        <span className="sep">/</span>
        {host ? (
          <>
            <a onClick={() => setSelectedHost(null)}>Infrastructure</a>
            <span className="sep">/</span>
            <a onClick={() => setSelectedHost(null)}>{sourceLabel}</a>
            <span className="sep">/</span>
            <CrumbSelect value={host.host} options={infraHosts.map(h => h.host)} onSelect={setSelectedHost} searchPlaceholder="Search hosts…" />
          </>
        ) : source === 'k8s-node' ? (
          <>
            <a onClick={goHome}>Infrastructure</a>
            <span className="sep">/</span>
            <span className="current">{crumbParent}</span>
            <span className="sep">/</span>
            {k8sNode ? (
              <a onClick={() => { setK8sNode(null); setK8sPod(null) }}>{sourceLabel}</a>
            ) : (
              <span className="current">{sourceLabel}</span>
            )}
            {k8sNode && (
              <>
                <span className="sep">/</span>
                <CrumbSelect
                  value={k8sNode.name}
                  options={k8sNodes.map(n => n.name)}
                  onSelect={(name) => { setK8sNode(k8sNodes.find(n => n.name === name)); setK8sPod(null) }}
                  searchPlaceholder="Search nodes…"
                />
              </>
            )}
            {k8sPod && (
              <>
                <span className="sep">/</span>
                <CrumbSelect
                  value={k8sPod.name}
                  options={k8sPods.filter(p => p.node === k8sNode?.name).map(p => p.name)}
                  onSelect={(name) => setK8sPod(k8sPods.find(p => p.name === name))}
                  searchPlaceholder="Search pods…"
                />
              </>
            )}
          </>
        ) : source === 'k8s-pod' ? (
          <>
            <a onClick={goHome}>Infrastructure</a>
            <span className="sep">/</span>
            <span className="current">{crumbParent}</span>
            <span className="sep">/</span>
            {k8sPod ? (
              <a onClick={() => setK8sPod(null)}>{sourceLabel}</a>
            ) : (
              <span className="current">{sourceLabel}</span>
            )}
            {k8sPod && (
              <>
                <span className="sep">/</span>
                <CrumbSelect
                  value={k8sPod.name}
                  options={k8sPods.map(p => p.name)}
                  onSelect={(name) => setK8sPod(k8sPods.find(p => p.name === name))}
                  searchPlaceholder="Search pods…"
                />
              </>
            )}
          </>
        ) : (
          <>
            <a onClick={goHome}>Infrastructure</a>
            {crumbParent && (
              <>
                <span className="sep">/</span>
                <span className="current">{crumbParent}</span>
              </>
            )}
            <span className="sep">/</span>
            <span className="current">{sourceLabel}</span>
          </>
        )}
      </PageBar>
      <div className="svc-main">
        {body}
      </div>
    </>
  )
}
