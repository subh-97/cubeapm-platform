import { useState, useMemo, useRef, useEffect, useCallback, createContext, useContext } from 'react'
import { AreaChart, Area, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import {
  INFRA_SOURCE_INDEX, infraHostsForWindow, HOST_PROCESSES,
  k8sAllocationForWindow, k8sContainersSeriesForWindow, k8sClusterSummary, k8sNamespaceSummary, k8sDeploymentSummary, k8sNamespaceDetailForWindow,
  k8sNodesForWindow, k8sPodsForWindow, K8S_NAMESPACES,
  mysqlSummary, mysqlSeriesForWindow, redisSummary, redisSeriesForWindow,
} from '@/data/observability'
import { resolveWindow } from '@/data/timeWindow'
import PageBar from '@/components/layout/PageBar'
import TableQuerySearch from '@/components/TableQuerySearch'
import { parsePodQuery, matchesPod, highlightsFor, tagHighlightsFor, tagTerms, POD_FIELDS, POD_NODE_FIELDS } from '@/utils/tableQuery'
import { highlightTerms } from '@/utils/highlight'
import { buildTimeAxis, withX } from '@/components/charts/timeAxis'
import ChartTooltip from '@/components/charts/ChartTooltip'
import { useTimeFocus, useMeasuredWidth, useSeriesHover } from '@/components/charts/useTimeFocus'
import { GRID_PROPS, NO_ANIM, AREA_PROPS, LINE_PROPS, valueAxisProps, maxOf, fmtBytes, fmtCount } from '@/components/charts/chartDefaults'

// The window every chart on this page draws, the setter a drag commits to, and
// the syncId that lines the charts of one view up on the same instant.
//
// Infrastructure nests deeply - source → node → pod, and each level carries its
// own charts - so threading three props the whole way down would touch every
// component on the page to tell them all the same thing. The page publishes
// them once instead, and a chart asks for them where it is drawn.
const InfraTime = createContext({ win: null, setTimeRange: () => {}, syncId: undefined })

/**
 * Everything one chart needs to sit on the page's window: a tick ladder sized
 * to that chart's own measured width, the drag that turns a span of it into the
 * page's time range, and the view's syncId.
 *
 * `focusable` is false only for a chart with no <Tooltip>. Recharts never
 * delivers move events to those, so a crosshair there would advertise a gesture
 * that can be started and never finished.
 */
function useChartTime({ kind = 'time', focusable = true } = {}) {
  const { win, setTimeRange, syncId } = useContext(InfraTime)
  const [wrapRef, width] = useMeasuredWidth()
  const axis = useMemo(() => buildTimeAxis(win, { width, kind }), [win, width, kind])
  const focus = useTimeFocus(win, { onFocus: setTimeRange, kind, enabled: focusable })
  return { win, wrapRef, axis, focus, syncId }
}

/**
 * The newest value a series actually holds.
 *
 * Not simply the last element: a window that runs past now - "Today" does,
 * every day - ends in buckets whose value is null because they have not
 * happened. Reading those as the current figure would print a flat zero beside
 * a chart that stops halfway across.
 */
function lastReading(series) {
  for (let i = series.length - 1; i >= 0; i--) {
    if (series[i]?.value != null) return series[i].value
  }
  return null
}

/**
 * Several per-entity series of the same metric, merged into the one row shape a
 * chart reads. The bucket's instant - `t` in unix seconds, and the `x` in ms the
 * time axis plots on - is taken from the first entity and carried onto the
 * merged row, because the series are sampled over the same buckets. The tooltip
 * reads `t` off the row it is pointing at, so the merged row has to carry it.
 */
function mergeSeries(win, entities, metric) {
  const base = entities[0]?.[metric] ?? []
  return withX(base, win).map((d, i) => {
    const row = { t: d.t, x: d.x }
    entities.forEach((e, ei) => { row[`h${ei}`] = e[metric]?.[i]?.value })
    return row
  })
}

function MultiHostChart({ metric, unit, formatVal, height = 130, palette, hosts, nameKey = 'host' }) {
  const { win, wrapRef, axis, focus, syncId } = useChartTime()
  const [hoverKey, hoverProps] = useSeriesHover()
  const data = useMemo(() => mergeSeries(win, hosts, metric), [win, hosts, metric])
  return (
    <div ref={wrapRef} style={{ width: '100%', height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 6, right: 6, left: 0, bottom: 0 }} syncId={syncId} syncMethod="value" {...focus.chartProps}>
          <CartesianGrid {...GRID_PROPS} />
          <XAxis {...axis.props} />
          <YAxis {...valueAxisProps({ chartWidth: axis.width, format: formatVal, maxValue: maxOf(data, hosts.map((_, hi) => `h${hi}`)) })} />
          <Tooltip content={p => <MultiTooltip {...p} unit={unit} formatVal={formatVal} palette={palette} hosts={hosts} nameKey={nameKey} hoverKey={hoverKey} suppressed={!focus.hovered} />} {...NO_ANIM} />
          {hosts.map((h, hi) => (
            <Line {...LINE_PROPS} key={h[nameKey]} dataKey={`h${hi}`} stroke={palette[hi % palette.length]} strokeWidth={1.4} dot={false} activeDot={{ r: 3, strokeWidth: 0 }} {...hoverProps(`h${hi}`)} />
          ))}
          {focus.overlay}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

// Both tooltips take their instant off the hovered ROW rather than off Recharts'
// `label`. On a numeric time axis that label is the x the row plots at, which is
// the bucket's CENTRE rather than its opening instant - half a bucket out, and
// on a seven-day window that is ninety minutes. The row has carried `t` all
// along, so the heading reads the bucket the reading belongs to.
//
// `x` is the fallback rather than the source for the same reason: it is only
// reached by a row that somehow arrived without `t`, and a heading half a bucket
// out still beats no heading at all.
function rowInstantMs(row) {
  if (row?.t != null) return row.t * 1000
  return row?.x ?? null
}

// The per-host palette survives the move to the shared tooltip - it is series
// IDENTITY, which is exactly what a palette is for - but it moves off the row
// text and onto the swatch. Every host then reads at the same contrast, instead
// of the pale ones being harder to read than the rest for no reason the data
// supports.
function MultiTooltip({ active, payload, unit = '', formatVal, palette, hosts, nameKey = 'host', hoverKey, suppressed }) {
  const { win } = useContext(InfraTime)
  if (!active || !payload?.length) return null
  const items = payload.flatMap((p, i) => {
    // A bucket that has not happened yet carries `value: null` - "Today" runs to
    // midnight, so most of that window is in that state - and Recharts still
    // hands those rows to the tooltip. Formatting one is never right: the
    // formatters here round, so `null` would print a confident `0%` for a
    // reading nobody took. `0` itself is a reading and stays.
    if (p.value == null) return []
    // Which host a row belongs to comes from its own dataKey (`h3`) rather
    // than from its position in the payload, so a series Recharts leaves
    // out cannot slide every name below it onto the wrong host.
    const keyed = Number(String(p.dataKey).slice(1))
    const hi = Number.isInteger(keyed) ? keyed : i
    return [{
      key: p.dataKey ?? hi,
      label: hosts[hi]?.[nameKey],
      value: `${formatVal ? formatVal(p.value) : Math.round(p.value)}${unit}`,
      color: palette[hi % palette.length],
    }]
  })
  if (!items.length) return null
  return (
    <ChartTooltip
      tMs={rowInstantMs(payload[0]?.payload)}
      nowMs={win.end * 1000}
      hoverKey={hoverKey}
      suppressed={suppressed}
      items={items}
    />
  )
}

// One series, so there is nothing to name beside it and nothing to emphasise
// against: the swatch carries the colour the line is drawn in, and the heading
// does the rest of the work.
/**
 * One reading, or several.
 *
 * Three charts here stack or overlay more than one series — containers
 * ready/notReady, network transmit/receive, the allocation lines — and all
 * three used to report a single row, so the tooltip answered a different
 * question from the one the chart was drawing. Pass `series` to list them all;
 * the hovered one is emphasised and the rest recede.
 */
function SingleAreaTooltip({ active, payload, unit = '', formatVal, color, series, hoverKey, suppressed }) {
  const { win } = useContext(InfraTime)
  if (!active || !payload?.length) return null
  const fmt = v => `${formatVal ? formatVal(v) : Math.round(v)}${unit}`
  if (series) {
    const items = series.flatMap(sr => {
      const row = payload.find(p => p.dataKey === sr.key)
      // A bucket that has not happened yet carries null; formatting one would
      // print a confident number for a reading nobody took.
      if (row?.value == null) return []
      return [{ key: sr.key, label: sr.label, value: fmt(row.value), color: sr.color }]
    })
    if (!items.length) return null
    return (
      <ChartTooltip
        tMs={rowInstantMs(payload[0]?.payload)}
        nowMs={win.end * 1000}
        hoverKey={hoverKey}
        suppressed={suppressed}
        minWidth={170}
        items={items}
      />
    )
  }
  const raw = payload[0]?.value
  // No reading, no tooltip - the same thing the chart itself says here, which
  // draws nothing across the part of the window that has not happened. Several
  // of these formatters are `v => v.toFixed(n)`, so handing them a null does
  // not merely print something wrong, it throws out of the render.
  if (raw == null) return null
  return (
    <ChartTooltip
      tMs={rowInstantMs(payload[0]?.payload)}
      nowMs={win.end * 1000}
      suppressed={suppressed}
      minWidth={140}
      items={[{ key: 'value', label: '', value: fmt(raw), color }]}
    />
  )
}

function HostChart({ title, series, color, unit, formatVal, value, height = 130 }) {
  const { win, wrapRef, axis, focus, syncId } = useChartTime()
  const data = useMemo(() => withX(series, win), [series, win])
  return (
    <div className="infra-chart-card">
      <div className="clbl">{title} {value != null && <span className="cval">{value}{unit}</span>}</div>
      <div ref={wrapRef} className="chart-host" style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 6, right: 6, left: 0, bottom: 0 }} syncId={syncId} syncMethod="value" {...focus.chartProps}>
            <CartesianGrid {...GRID_PROPS} />
            <XAxis {...axis.props} />
            <YAxis {...valueAxisProps({ chartWidth: axis.width, format: formatVal, maxValue: maxOf(data, 'value') })} />
            <Tooltip content={p => <SingleAreaTooltip {...p} color={color} unit={unit} formatVal={formatVal} suppressed={!focus.hovered} />} {...NO_ANIM} />
            <Area {...AREA_PROPS} dataKey="value" stroke={color} strokeWidth={1.6} fill={color} dot={false} activeDot={{ r: 3 }} />
            {focus.overlay}
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
  const { win, wrapRef, axis, focus, syncId } = useChartTime()
  const data = useMemo(() => withX(series, win), [series, win])
  return (
    <div className="infra-chart-full">
      <div className="infra-chart-head"><div className="clbl">{title}</div></div>
      <div className="infra-chart-body">
        <div className="infra-chart-svg-wrap">
          <div ref={wrapRef} style={{ width: '100%', height }}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data} margin={{ top: 6, right: 6, left: 0, bottom: 0 }} syncId={syncId} syncMethod="value" {...focus.chartProps}>
                <CartesianGrid {...GRID_PROPS} />
                <XAxis {...axis.props} />
                <YAxis {...valueAxisProps({ chartWidth: axis.width, format: formatVal, maxValue: maxOf(data, 'value') })} />
                <Tooltip content={p => <SingleAreaTooltip {...p} color={color} unit={unit} formatVal={formatVal} suppressed={!focus.hovered} />} {...NO_ANIM} />
                <Area {...AREA_PROPS} dataKey="value" stroke={color} strokeWidth={1.6} fill={color} dot={false} activeDot={{ r: 3 }} />
                {focus.overlay}
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * A host's CPU or memory with the process breakdown beside it. Its own
 * component rather than inline JSX so each of the two charts owns one width
 * measurement and one drag, instead of HostDetail juggling both.
 */
function HostProcessChart({ title, series, color, metric, tabs }) {
  const { win, wrapRef, axis, focus, syncId } = useChartTime()
  const data = useMemo(() => withX(series, win), [series, win])
  return (
    <div className="infra-chart-full">
      <div className="infra-chart-head">
        <div className="clbl">{title}</div>
        {tabs && (
          <div className="infra-chart-tabs">
            {tabs.map((t, i) => <span key={t} className={`ict${i === 0 ? ' active' : ''}`}>{t}</span>)}
          </div>
        )}
      </div>
      <div className="infra-chart-body">
        <div className="infra-chart-svg-wrap">
          <div ref={wrapRef} style={{ width: '100%', height: '100%', minHeight: 160 }}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data} margin={{ top: 6, right: 6, left: 0, bottom: 0 }} syncId={syncId} syncMethod="value" {...focus.chartProps}>
                <CartesianGrid {...GRID_PROPS} />
                <XAxis {...axis.props} />
                <YAxis {...valueAxisProps({ chartWidth: axis.width, maxValue: 100 })} />
                <Tooltip content={p => <SingleAreaTooltip {...p} color={color} unit="%" formatVal={v => v.toFixed(1)} suppressed={!focus.hovered} />} {...NO_ANIM} />
                <Area {...AREA_PROPS} dataKey="value" stroke={color} strokeWidth={1.6} fill={color} dot={false} activeDot={{ r: 3 }} />
                {focus.overlay}
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
        <ProcessLegend metric={metric} />
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
        <HostProcessChart
          title="CPU Used %"
          series={host.cpuSeries}
          color="#F59E0B"
          metric="cpu"
          tabs={['CPU Used %', 'CPU State %', 'Load Average']}
        />

        <HostProcessChart title="Memory Used %" series={host.memSeries} color="#EF4444" metric="mem" />

        <div className="infra-detail-row">
          <HostChart title="Disk Used %" series={host.diskSeries} color="#34D399" unit="%" formatVal={v => Math.round(v)} value={host.disk.toFixed(1)} height={140} />
          <HostChart title="Network Traffic (bytes/s)" series={host.netInSeries} color="#3B82F6" unit="" formatVal={fmtBytes} value={fmtBytes(host.netIn * (host.unit === 'K' ? 1000 : 1000000))} height={140} />
        </div>
        <div className="infra-detail-row">
          <HostChart title="Disk I/O Utilization %" series={host.diskIoSeries} color="#A78BFA" unit="%" formatVal={v => v.toFixed(1)} value={(lastReading(host.diskIoSeries) ?? 0).toFixed(1)} height={140} />
        </div>
      </div>
    </div>
  )
}

/* ============ Kubernetes: Cluster ============ */

const ALLOC_KEYS = ['total', 'request', 'limit', 'used']

// The two stacked pairs, named once so the tooltip rows and the areas cannot
// drift apart.
const CONTAINER_BANDS = [
  { key: 'ready', label: 'ready', color: '#F59E0B' },
  { key: 'notReady', label: 'not ready', color: '#3B82F6' },
]
const NET_BANDS = [
  { key: 'transmit', label: 'transmit', color: '#F59E0B' },
  { key: 'receive', label: 'receive', color: '#3B82F6' },
]

/**
 * CPU or memory allocation: four parallel series merged onto one row apiece,
 * carrying the window's bucket keys so the axis and the tooltip agree.
 *
 * `lines` is in draw order, which is why the two charts that use this differ -
 * the memory chart puts `used` under its ceilings and the CPU one does not.
 */
function AllocationChart({ title, alloc, lines, legend, axisFormat, tooltipUnit, tooltipFormat }) {
  const { win, wrapRef, axis, focus, syncId } = useChartTime()
  const [hoverKey, hoverProps] = useSeriesHover()
  const data = useMemo(() => {
    const base = withX(alloc.total, win)
    return base.map((d, i) => ({
      t: d.t,
      x: d.x,
      total: d.value,
      request: alloc.request[i]?.value,
      limit: alloc.limit[i]?.value,
      used: alloc.used[i]?.value,
    }))
  }, [alloc, win])

  return (
    <div className="infra-chart-card">
      <div className="clbl">{title}</div>
      <div ref={wrapRef} style={{ height: 130 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 6, right: 6, left: 0, bottom: 0 }} syncId={syncId} syncMethod="value" {...focus.chartProps}>
            <CartesianGrid {...GRID_PROPS} />
            <XAxis {...axis.props} />
            <YAxis {...valueAxisProps({ chartWidth: axis.width, ...(axisFormat ? { format: axisFormat } : null), maxValue: maxOf(data, ALLOC_KEYS) })} />
            <Tooltip
              content={p => (
                <SingleAreaTooltip
                  {...p}
                  unit={tooltipUnit}
                  formatVal={tooltipFormat}
                  hoverKey={hoverKey}
                  suppressed={!focus.hovered}
                  series={lines.map(l => ({ key: l.key, label: l.key, color: l.color }))}
                />
              )}
              {...NO_ANIM}
            />
            {lines.map(l => (
              <Line {...LINE_PROPS} key={l.key} dataKey={l.key} stroke={l.color} strokeWidth={l.width} strokeDasharray={l.dash} dot={false} {...hoverProps(l.key)} />
            ))}
            {focus.overlay}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="k8s-alloc-legend">
        {legend.map(g => (
          <span key={g.label} className="k8s-alloc-legend-item">
            <span className={`sw${g.dashed ? ' dashed' : ''}`} style={g.dashed ? { color: g.color } : { background: g.color }} />
            {' '}{g.label}
          </span>
        ))}
      </div>
    </div>
  )
}

/**
 * Containers ready against not-ready. Flat by definition in this cluster, and
 * it still gets the ladder and the drag: an axis that changes shape depending
 * on whether a chart happens to be interesting is an axis a reader cannot
 * trust, and a flat stretch is exactly where someone zooms in to check.
 */
function ContainersChart({ series }) {
  const { win, wrapRef, axis, focus, syncId } = useChartTime()
  const [hoverKey, hoverProps] = useSeriesHover()
  const data = useMemo(() => {
    const base = withX(series.ready, win)
    return base.map((d, i) => ({
      t: d.t,
      x: d.x,
      ready: d.value,
      notReady: series.notReady[i]?.value,
    }))
  }, [series, win])

  return (
    <div className="infra-chart-card">
      <div className="clbl">Containers</div>
      <div ref={wrapRef} style={{ height: 130 }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 6, right: 6, left: 0, bottom: 0 }} syncId={syncId} syncMethod="value" {...focus.chartProps}>
            <CartesianGrid {...GRID_PROPS} />
            <XAxis {...axis.props} />
            <YAxis {...valueAxisProps({ chartWidth: axis.width, format: fmtCount, allowDecimals: false, maxValue: 99 })} />
            <Tooltip
              content={p => (
                <SingleAreaTooltip
                  {...p}
                  formatVal={v => Math.round(v)}
                  hoverKey={hoverKey}
                  suppressed={!focus.hovered}
                  series={CONTAINER_BANDS}
                />
              )}
              {...NO_ANIM}
            />
            <Area {...AREA_PROPS} dataKey="ready" stackId="c" stroke="#F59E0B" fill="#F59E0B" fillOpacity={0.5} strokeWidth={1.4} dot={false} {...hoverProps('ready')} />
            <Area {...AREA_PROPS} dataKey="notReady" stackId="c" stroke="#3B82F6" fill="#3B82F6" fillOpacity={0.5} strokeWidth={1.4} dot={false} {...hoverProps('notReady')} />
            {focus.overlay}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

// One view, two scopes. With a namespace it is the namespace overview that a
// k8s.namespace.name link opens; without one it is the cluster. They share the
// charts and the stat grid because they answer the same question at different
// altitudes - the only real difference is that a node is not namespaced, so the
// node counts drop out when a namespace is selected.
function K8sClusterView({ namespace, setNamespace }) {
  const { win } = useContext(InfraTime)
  const detail = useMemo(() => (namespace ? k8sNamespaceDetailForWindow(win, namespace) : null), [win, namespace])
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

  const alloc = useMemo(() => k8sAllocationForWindow(win), [win])
  const containers = useMemo(() => k8sContainersSeriesForWindow(win), [win])

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
        <AllocationChart
          title="CPU Allocation (cores)"
          alloc={alloc.cpu}
          tooltipUnit=" cores"
          tooltipFormat={v => v.toFixed(2)}
          lines={[
            { key: 'total', color: '#34D399', width: 1.4, dash: '4 3' },
            { key: 'request', color: '#F59E0B', width: 1.4 },
            { key: 'limit', color: '#EF4444', width: 1.4 },
            { key: 'used', color: '#3B82F6', width: 1.6 },
          ]}
          legend={[
            { label: 'Total', color: '#34D399', dashed: true },
            { label: 'Request', color: '#F59E0B' },
            { label: 'Limit', color: '#EF4444' },
            { label: 'Used', color: '#3B82F6' },
          ]}
        />
        <AllocationChart
          title="Memory Allocation (bytes)"
          alloc={alloc.mem}
          axisFormat={fmtBytes}
          tooltipUnit=""
          tooltipFormat={fmtBytes}
          lines={[
            { key: 'total', color: '#34D399', width: 1.4, dash: '4 3' },
            { key: 'used', color: '#3B82F6', width: 1.6 },
            { key: 'limit', color: '#EF4444', width: 1.4 },
            { key: 'request', color: '#A78BFA', width: 1.4 },
          ]}
          legend={[
            { label: 'Total', color: '#34D399', dashed: true },
            { label: 'Used', color: '#3B82F6' },
            { label: 'Limit', color: '#EF4444' },
            { label: 'Request', color: '#A78BFA' },
          ]}
        />
        <ContainersChart series={containers} />
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
  const { win, wrapRef, axis, focus, syncId } = useChartTime()
  const data = useMemo(() => withX(k8sContainersSeriesForWindow(win).notReady, win), [win])
  return (
    <>
      <div className="infra-chart-card" style={{ marginBottom: 20 }}>
        <div className="clbl">Pods Desired but not Available</div>
        <div ref={wrapRef} style={{ height: 130 }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 6, right: 6, left: 0, bottom: 0 }} syncId={syncId} syncMethod="value" {...focus.chartProps}>
              <CartesianGrid {...GRID_PROPS} />
              <XAxis {...axis.props} />
              <YAxis {...valueAxisProps({ chartWidth: axis.width, format: fmtCount, allowDecimals: false, maxValue: 99 })} />
              <Tooltip content={p => <SingleAreaTooltip {...p} color="#EF4444" unit="" formatVal={v => Math.round(v)} suppressed={!focus.hovered} />} {...NO_ANIM} />
              <Line {...LINE_PROPS} dataKey="value" stroke="#EF4444" strokeWidth={1.6} dot={false} />
              {focus.overlay}
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

/** A node's transmit and receive stacked over the window. */
function NodeNetworkChart({ node }) {
  const { win, wrapRef, axis, focus, syncId } = useChartTime()
  const [hoverKey, hoverProps] = useSeriesHover()
  const data = useMemo(() => {
    const base = withX(node.netInSeries, win)
    return base.map((d, i) => ({
      t: d.t,
      x: d.x,
      transmit: node.netOutSeries[i]?.value,
      receive: d.value,
    }))
  }, [node, win])

  return (
    <div className="infra-chart-card" style={{ marginBottom: 20 }}>
      <div className="clbl">Network Traffic (bytes/s)</div>
      <div ref={wrapRef} style={{ height: 160 }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 6, right: 6, left: 0, bottom: 0 }} syncId={syncId} syncMethod="value" {...focus.chartProps}>
            <CartesianGrid {...GRID_PROPS} />
            <XAxis {...axis.props} />
            <YAxis {...valueAxisProps({ chartWidth: axis.width, format: fmtBytes, maxValue: 1e9 })} />
            <Tooltip
              content={p => (
                <SingleAreaTooltip {...p} formatVal={fmtBytes} hoverKey={hoverKey} suppressed={!focus.hovered} series={NET_BANDS} />
              )}
              {...NO_ANIM}
            />
            <Area {...AREA_PROPS} dataKey="transmit" stackId="n" stroke="#F59E0B" fill="#F59E0B" fillOpacity={0.4} strokeWidth={1.4} dot={false} {...hoverProps('transmit')} />
            <Area {...AREA_PROPS} dataKey="receive" stackId="n" stroke="#3B82F6" fill="#3B82F6" fillOpacity={0.4} strokeWidth={1.4} dot={false} {...hoverProps('receive')} />
            {focus.overlay}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

function K8sNodeDetail({ node, pods, onSelectPod }) {
  const [podQuery, setPodQuery] = useState('')

  const onNode = useMemo(() => pods.filter(p => p.node === node.name), [pods, node.name])

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

      <NodeNetworkChart node={node} />

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
          <div key={p.name} className="appdb-summary-row" style={{ gridTemplateColumns: '1fr 120px 110px 130px 130px 110px 110px', cursor: 'pointer' }} onClick={() => onSelectPod(p.name)}>
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

function K8sNodeView({ nodes, pods, selectedNode, setSelectedNode, selectedPod, setSelectedPod }) {
  if (selectedPod) {
    return <K8sPodDetail pod={selectedPod} />
  }
  if (selectedNode) {
    return <K8sNodeDetail node={selectedNode} pods={pods} onSelectPod={setSelectedPod} />
  }
  return (
    <>
      <div className="infra-row-charts">
        <div className="infra-chart-card">
          <div className="clbl">CPU Used %</div>
          <MultiHostChart metric="cpuSeries" unit="%" formatVal={v => Math.round(v)} palette={['#3B82F6', '#A78BFA']} hosts={nodes} nameKey="name" />
        </div>
        <div className="infra-chart-card">
          <div className="clbl">Memory Used %</div>
          <MultiHostChart metric="memSeries" unit="%" formatVal={v => Math.round(v)} palette={['#3B82F6', '#A78BFA']} hosts={nodes} nameKey="name" />
        </div>
        <div className="infra-chart-card">
          <div className="clbl">Disk Used %</div>
          <MultiHostChart metric="diskSeries" unit="%" formatVal={v => Math.round(v)} palette={['#3B82F6', '#A78BFA']} hosts={nodes} nameKey="name" />
        </div>
      </div>
      <div className="panel">
        <div className="panel-head">Summary <span className="hint">{nodes.length} nodes · click a row to drill in</span></div>
        <div className="appdb-summary-head" style={{ gridTemplateColumns: '1fr 110px 110px 110px 110px 110px 80px' }}>
          <span>Node</span><span>CPU Used %</span><span>Memory Used %</span><span>Disk Used %</span><span>Network In</span><span>Network Out</span><span>Pods</span>
        </div>
        {nodes.map(n => (
          <div key={n.name} className="appdb-summary-row" style={{ gridTemplateColumns: '1fr 110px 110px 110px 110px 110px 80px', cursor: 'pointer' }} onClick={() => setSelectedNode(n.name)}>
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

function K8sPodListView({ nodes, pods, selectedPod, setSelectedPod }) {
  const [query, setQuery] = useState('')

  const { node: queryNode, ok } = parsePodQuery(query, POD_NODE_FIELDS)
  const shown = useMemo(
    () => (ok ? pods.filter(p => matchesPod(queryNode, p, POD_NODE_FIELDS)) : pods),
    [pods, queryNode, ok],
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
              ? `${shown.length} of ${pods.length} pods`
              : `${pods.length} pods across ${nodes.length} nodes · click a row to inspect`}
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
        <div key={p.name} className="appdb-summary-row" style={{ gridTemplateColumns: '1fr 120px 150px 110px 130px 110px', cursor: 'pointer' }} onClick={() => setSelectedPod(p.name)}>
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

/**
 * The flat line a source with no integration draws. It is still the window's
 * own axis - "no data" over the last seven days has to say seven days - but it
 * carries no Tooltip, so it is the one chart on the page that cannot be
 * brushed and does not offer to be.
 */
function NoDataChart({ title }) {
  const { win, wrapRef, axis } = useChartTime({ focusable: false })
  const data = useMemo(
    () => withX(win.buckets.map(b => ({ t: b.t, label: b.label, exactTime: b.exactTime, value: 0 })), win),
    [win],
  )
  return (
    <div className="infra-chart-card">
      <div className="clbl">{title}</div>
      <div ref={wrapRef} style={{ height: 130 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 6, right: 6, left: 0, bottom: 0 }}>
            <CartesianGrid {...GRID_PROPS} />
            <XAxis {...axis.props} />
            <YAxis {...valueAxisProps({ chartWidth: axis.width, domain: [0, 1], maxValue: 1 })} />
            <Line {...LINE_PROPS} dataKey="value" stroke="var(--text-muted)" strokeWidth={1} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

function InfraEmptyView({ columns }) {
  return (
    <>
      <div className="infra-empty-charts">
        {['Requests per Minute', 'Errors', 'Latency'].map(t => <NoDataChart key={t} title={t} />)}
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
  const { win } = useContext(InfraTime)
  const series = useMemo(() => mysqlSeriesForWindow(win), [win])
  const s = mysqlSummary
  return (
    <>
      <div className="infra-row-charts">
        <HostChart title="Operations per Minute" series={series.opsPerMin} color="#34D399" unit="" formatVal={v => Math.round(v)} value={s.opsPerMin} />
        <HostChart title="Connection Errors per Minute" series={series.connErrors} color="#EF4444" unit="" formatVal={v => Math.round(v)} value={s.connErrPerMin} />
        <HostChart title="Slow Queries per Minute" series={series.slowQueries} color="#F59E0B" unit="" formatVal={v => Math.round(v)} value={s.slowQueriesPerMin} />
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
  const { win } = useContext(InfraTime)
  const series = useMemo(() => redisSeriesForWindow(win), [win])
  const s = redisSummary
  return (
    <>
      <div className="infra-row-charts">
        <HostChart title="Memory Used (bytes)" series={series.memUsed} color="#EF4444" unit="" formatVal={fmtBytes} value={fmtBytes(s.memUsedBytes)} />
        <HostChart title="Commands per Minute" series={series.cmdPerMin} color="#3B82F6" unit="" formatVal={v => Math.round(v)} value={s.cmdPerMin} />
        <HostChart title="Evictions per Minute" series={series.evictionsPerMin} color="#F59E0B" unit="" formatVal={v => Math.round(v)} value={lastReading(series.evictionsPerMin)} />
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

  const win = useMemo(() => resolveWindow(timeRange), [timeRange])

  // Every row on this page is "what the selected window held", so the lists are
  // rebuilt from the window rather than read off the module's reference hour.
  const hosts = useMemo(() => infraHostsForWindow(win), [win])
  const nodes = useMemo(() => k8sNodesForWindow(win), [win])
  const pods = useMemo(() => k8sPodsForWindow(win), [win])

  // Seeded from the incoming link, so /infra?tab=k8s-cluster&section=kube-system
  // arrives already scoped. App remounts on a resource change, so this only has
  // to be right at mount.
  //
  // A selection is held as a NAME and resolved against the current lists, not
  // kept as the row object. The rows are rebuilt whenever the range changes, so
  // a stored object would go on showing the window it was selected in while
  // every chart around it moved - and a link that arrives naming a node would
  // seed a bare string where a row was expected.
  const [k8sNodeName, setK8sNodeName] = useState(() => (source === 'k8s-node' ? resource ?? null : null))
  const [k8sNamespace, setK8sNamespace] = useState(() => (source === 'k8s-cluster' ? resource ?? null : null))
  const [k8sPodName, setK8sPodName] = useState(() => (source === 'k8s-pod' ? resource ?? null : null))

  const k8sNode = useMemo(() => nodes.find(n => n.name === k8sNodeName) ?? null, [nodes, k8sNodeName])
  const k8sPod = useMemo(() => pods.find(p => p.name === k8sPodName) ?? null, [pods, k8sPodName])

  const host = selectedHost ? hosts.find(h => h.host === selectedHost) : null
  const meta = INFRA_SOURCE_INDEX[source]
  const sourceLabel = meta?.label || 'Host'
  const crumbParent = meta?.parent

  // One syncId per view, so hovering any chart puts the crosshair on every
  // other chart beside it at the same instant - the three host charts read as
  // one reading rather than three.
  //
  // Built from everything that decides which body is rendered, not from the
  // source alone: this page drills in place, so the cluster and the namespace
  // inside it, or a node and one of its pods, are different views at the same
  // source. A drill-in gets its own id and cannot sync against the charts of
  // the view it replaced.
  const syncId = useMemo(
    () => ['infra', source, host?.host, k8sNamespace, k8sNodeName, k8sPodName].filter(Boolean).join('~'),
    [source, host, k8sNamespace, k8sNodeName, k8sPodName],
  )
  const time = useMemo(() => ({ win, setTimeRange, syncId }), [win, setTimeRange, syncId])

  let body
  if (host) {
    body = <HostDetail host={host} />
  } else if (source === 'host') {
    body = (
      <>
        <div className="infra-row-charts">
          <div className="infra-chart-card">
            <div className="clbl">CPU Used % <span className="cval">per host</span></div>
            <MultiHostChart metric="cpuSeries" unit="%" formatVal={v => Math.round(v)} palette={PALETTE} hosts={hosts} />
          </div>
          <div className="infra-chart-card">
            <div className="clbl">Memory Used % <span className="cval">per host</span></div>
            <MultiHostChart metric="memSeries" unit="%" formatVal={v => Math.round(v)} palette={PALETTE} hosts={hosts} />
          </div>
          <div className="infra-chart-card">
            <div className="clbl">Disk Used % <span className="cval">per host</span></div>
            <MultiHostChart metric="diskSeries" unit="%" formatVal={v => Math.round(v)} palette={PALETTE} hosts={hosts} />
          </div>
        </div>

        <div className="panel">
          <div className="panel-head">Summary <span className="hint">{hosts.length} hosts · sortable · click a row to drill in</span></div>
          <div className="infra-summary-head">
            <span>Host</span>
            <span>Service</span>
            <span>CPU %</span>
            <span>Mem %</span>
            <span>Disk %</span>
            <span>Net In</span>
            <span>Net Out</span>
          </div>
          {[...hosts].sort((a, b) => (a.status === 'critical' ? -2 : a.status === 'warning' ? -1 : 0) - (b.status === 'critical' ? -2 : b.status === 'warning' ? -1 : 0) || b.cpu - a.cpu).map(h => {
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
    body = <K8sNodeView nodes={nodes} pods={pods} selectedNode={k8sNode} setSelectedNode={setK8sNodeName} selectedPod={k8sPod} setSelectedPod={setK8sPodName} />
  } else if (source === 'k8s-pod') {
    body = <K8sPodListView nodes={nodes} pods={pods} selectedPod={k8sPod} setSelectedPod={setK8sPodName} />
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
    <InfraTime.Provider value={time}>
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
            <CrumbSelect value={host.host} options={hosts.map(h => h.host)} onSelect={setSelectedHost} searchPlaceholder="Search hosts…" />
          </>
        ) : source === 'k8s-node' ? (
          <>
            <a onClick={goHome}>Infrastructure</a>
            <span className="sep">/</span>
            <span className="current">{crumbParent}</span>
            <span className="sep">/</span>
            {k8sNode ? (
              <a onClick={() => { setK8sNodeName(null); setK8sPodName(null) }}>{sourceLabel}</a>
            ) : (
              <span className="current">{sourceLabel}</span>
            )}
            {k8sNode && (
              <>
                <span className="sep">/</span>
                <CrumbSelect
                  value={k8sNode.name}
                  options={nodes.map(n => n.name)}
                  onSelect={(name) => { setK8sNodeName(name); setK8sPodName(null) }}
                  searchPlaceholder="Search nodes…"
                />
              </>
            )}
            {k8sPod && (
              <>
                <span className="sep">/</span>
                <CrumbSelect
                  value={k8sPod.name}
                  options={pods.filter(p => p.node === k8sNode?.name).map(p => p.name)}
                  onSelect={setK8sPodName}
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
              <a onClick={() => setK8sPodName(null)}>{sourceLabel}</a>
            ) : (
              <span className="current">{sourceLabel}</span>
            )}
            {k8sPod && (
              <>
                <span className="sep">/</span>
                <CrumbSelect
                  value={k8sPod.name}
                  options={pods.map(p => p.name)}
                  onSelect={setK8sPodName}
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
    </InfraTime.Provider>
  )
}
