import { useState, useMemo, useRef, useEffect, useCallback, createContext, useContext } from 'react'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts'
import {
  INFRA_SOURCE_INDEX, infraHostsForWindow, HOST_PROCESSES,
  k8sAllocationForWindow, k8sContainersSeriesForWindow, k8sClusterSummary, k8sNamespaceSummary, k8sDeploymentSummary, k8sNamespaceDetailForWindow,
  k8sNodesForWindow, k8sPodsForWindow, K8S_NAMESPACES,
  mysqlSummary, mysqlSeriesForWindow, redisSummary, redisSeriesForWindow,
} from '@/data/observability'
import { resolveWindow } from '@/data/timeWindow'
import PageBar from '@/components/layout/PageBar'
import TableQuerySearch from '@/components/TableQuerySearch'
import CardMenu, { CardActionContext } from '@/components/CardMenu'
import SearchGlyph from '@/components/shared/SearchGlyph'
import FilterSelect from '@/components/shared/FilterSelect'
import { useScrollReveal, revealClass } from '@/hooks/useScrollReveal'
import { parsePodQuery, matchesPod, highlightsFor, tagHighlightsFor, tagTerms, POD_FIELDS, POD_NODE_FIELDS, HOST_FIELDS } from '@/utils/tableQuery'
import { highlightTerms } from '@/utils/highlight'
import { withX } from '@/components/charts/timeAxis'
import { TimeChart, SvcTooltip } from '@/components/charts/TimeChart'
import CardChart from '@/components/charts/CardChart'
import LegendLineChart from '@/components/charts/LegendLineChart'
import { GRID_PROPS, NO_ANIM, LINE_PROPS, LIMIT_DASH, valueAxisProps, maxOf, fmtBytes, fmtCount, fmtCompact, fmtPct1, fmtPct2, fmtPctTick } from '@/components/charts/chartDefaults'
import { infraColor, RESOURCE_COLORS } from '@/utils/chartPalette'
import { SortableTable, CellBar } from '@/components/shared/SortableTable'
// The process column borrows a legend's scrolling rule (.drill2-legend.is-scroll)
// from LegendLineChart's stylesheet, so it is named here rather than left to
// arrive with that component.
import '@/components/charts/legend-line-chart.css'

// The window every chart on this page draws, the setter a drag commits to, and
// the syncId that lines the charts of one view up on the same instant.
//
// Infrastructure nests deeply - source → node → pod, and each level carries its
// own charts - so threading three props the whole way down would touch every
// component on the page to tell them all the same thing. The page publishes
// them once instead, and a chart asks for them where it is drawn.
const InfraTime = createContext({ win: null, setTimeRange: () => {}, syncId: undefined })

/* ============ Tables ============ */

// Every list on this page is one table, SortableTable
// (components/shared/SortableTable), built the way the service page's are: a
// plain <table> whose headers sort, names and identifiers in mono on the left,
// figures right-aligned in the body face, a percentage as its figure over a
// brand bar, and nothing that colours or marks a row by how bad its values are.
// The column lists below are its `columns` (the fields are documented there);
// a table of one record, or of none, passes sortable={false}. It began on this
// page and moved there when the Browser page's tables were built from it.

// A host's or node's network figure is printed in its own unit (K or M); the
// rate behind it is what a column of them is ordered by.
const netRate = (value, unit) => value * (unit === 'K' ? 1e3 : unit === 'M' ? 1e6 : 1)
const withNetRates = r => ({ ...r, netInRate: netRate(r.netIn, r.unit), netOutRate: netRate(r.netOut, r.unit) })

// A pod's name with its labels, each highlighted where the search matched. It
// runs inline, so a cell that clips it ends in an ellipsis rather than a cut.
function PodName({ pod, hits, tagHits }) {
  return (
    <span className="infra-name-cell">
      <span>{highlightTerms(pod.name, hits.pod, 'svc-hit')}</span>
      {Object.entries(pod.labels ?? {}).map(([k, v]) => (
        <span key={k} className="svc-tag" title={`${k}: ${v} — search as pod.${k}:${v}`}>
          <span className="svc-tag-k">{k}</span>
          <span className="svc-tag-v">{highlightTerms(v, tagTerms(tagHits, 'pod', k), 'svc-hit')}</span>
        </span>
      ))}
    </span>
  )
}

const HOST_COLUMNS = [
  { key: 'host', label: 'Host', align: 'left', mono: true },
  { key: 'service', label: 'Service', align: 'left', mono: true, render: h => <span title={h.service ? undefined : 'No APM service reports from this host'}>{h.service ?? '—'}</span> },
  { key: 'cpu', label: 'CPU %', render: h => <CellBar fill={h.cpu}>{h.cpu.toFixed(2)}</CellBar> },
  { key: 'mem', label: 'Mem %', render: h => <CellBar fill={h.mem}>{h.mem.toFixed(2)}</CellBar> },
  { key: 'disk', label: 'Disk %', render: h => <CellBar fill={h.disk}>{h.disk.toFixed(1)}</CellBar> },
  { key: 'netIn', label: 'Net In', sortKey: 'netInRate', render: h => `${h.netIn.toFixed(2)}${h.unit}` },
  { key: 'netOut', label: 'Net Out', sortKey: 'netOutRate', render: h => `${h.netOut.toFixed(2)}${h.unit}` },
]

const NODE_COLUMNS = [
  { key: 'name', label: 'Node', align: 'left', mono: true },
  { key: 'cpu', label: 'CPU Used %', render: n => <CellBar fill={n.cpu}>{n.cpu.toFixed(2)}</CellBar> },
  { key: 'mem', label: 'Memory Used %', render: n => <CellBar fill={n.mem}>{n.mem.toFixed(2)}</CellBar> },
  { key: 'disk', label: 'Disk Used %', render: n => <CellBar fill={n.disk}>{n.disk.toFixed(2)}</CellBar> },
  { key: 'netIn', label: 'Network In', sortKey: 'netInRate', render: n => `${n.netIn.toFixed(2)}${n.unit}` },
  { key: 'netOut', label: 'Network Out', sortKey: 'netOutRate', render: n => `${n.netOut.toFixed(2)}${n.unit}` },
  { key: 'pods', label: 'Pods' },
]

const NAMESPACE_COLUMNS = [
  { key: 'namespace', label: 'Namespace', align: 'left', mono: true },
  { key: 'cpuUsed', label: 'CPU Used' },
  { key: 'cpuRequest', label: 'CPU Request' },
  { key: 'cpuLimit', label: 'CPU Limit', render: n => n.cpuLimit ?? '-' },
  { key: 'memUsed', label: 'Memory Used', render: n => fmtBytes(n.memUsed) },
  { key: 'memRequest', label: 'Memory Request', render: n => fmtBytes(n.memRequest) },
  { key: 'memLimit', label: 'Memory Limit', render: n => fmtBytes(n.memLimit) },
  { key: 'containers', label: 'Containers' },
]

const NAMESPACE_POD_COLUMNS = [
  { key: 'name', label: 'Pod', align: 'left', mono: true },
  { key: 'node', label: 'Node', align: 'left', mono: true },
  { key: 'cpuUsed', label: 'CPU Used' },
  { key: 'memUsed', label: 'Memory Used', render: p => fmtBytes(p.memUsed) },
  { key: 'memLimit', label: 'Memory Limit', render: p => (p.memLimit ? fmtBytes(p.memLimit) : '-') },
]

const EVENT_COLUMNS = ['Time', 'Type', 'Namespace', 'Name', 'Kind', 'Note'].map(label => ({ key: label, label, align: 'left' }))

const DEPLOYMENT_COLUMNS = [
  { key: 'namespace', label: 'Namespace', align: 'left', mono: true },
  { key: 'deployments', label: 'Deployments' },
  { key: 'podsDesired', label: 'Pods Desired' },
  { key: 'podsAvailable', label: 'Pods Available' },
]

const CONTAINER_COLUMNS = [
  { key: 'containerName', label: 'Container', align: 'left', mono: true },
  { key: 'cpuUsed', label: 'CPU Used' },
  { key: 'cpuRequest', label: 'CPU Request' },
  { key: 'cpuLimit', label: 'CPU Limit' },
  { key: 'memUsed', label: 'Memory Used', render: p => fmtBytes(p.memUsed) },
  { key: 'memRequest', label: 'Memory Request', render: p => fmtBytes(p.memRequest) },
  { key: 'memLimit', label: 'Memory Limit', render: p => fmtBytes(p.memLimit) },
]

const MYSQL_COLUMNS = [
  { key: 'host', label: 'Host', align: 'left', mono: true, clip: 220, title: s => s.host },
  { key: 'connections', label: 'Connections' },
  { key: 'opsPerMin', label: 'Operations / min' },
  { key: 'connErrPerMin', label: 'Connection Errors / min' },
  { key: 'slowQueriesPerMin', label: 'Slow Queries / min' },
  { key: 'replicationLag', label: 'Replication Lag', render: s => s.replicationLag ?? '-' },
  { key: 'dbSizeBytes', label: 'Database Size', render: s => fmtBytes(s.dbSizeBytes) },
]

const REDIS_COLUMNS = [
  { key: 'host', label: 'Host', align: 'left', mono: true },
  { key: 'connections', label: 'Connections' },
  { key: 'connPerMin', label: 'Connections / min' },
  { key: 'cmdPerMin', label: 'Commands / min' },
  { key: 'memUsedBytes', label: 'Memory Used', render: s => fmtBytes(s.memUsedBytes) },
  { key: 'cacheHitPct', label: 'Cache Hit %', render: s => <CellBar fill={s.cacheHitPct}>{s.cacheHitPct}%</CellBar> },
]

// A header-only table: the columns a source would list, over the reason it
// lists nothing.
const emptyColumns = labels => labels.map((label, i) => ({ key: label, label, align: i === 0 ? 'left' : undefined }))

/* ============ Charts ============ */

// Every chart on this page is one of the APM service page's, so the two read as
// one product rather than two that drift apart:
//
//   - A fleet — every host, every node — is the RED tab's legend chart: a line
//     per host, with a searchable legend beside it (FleetCharts).
//   - Anything else is the Runtime tab's card (CardChart): a title with its ⋮
//     menu and the window's reading beside it, the plot, and a legend under any
//     chart that draws more than one series.
//   - A host's CPU and memory sit in the Latency Drilldown's frame, the chart
//     beside the processes that use it (ProcessChartPanel).
//
// Series colours are identity, never severity (rule 2): infraColor for a fleet,
// RESOURCE_COLORS for a reading and its ceilings, the brand blue for a lone
// series. This page shows severity in its tables' dots and bars, and a red
// memory line beside them would read as a memory alarm.

/** A CardChart on this page's window, with its drag and crosshair. */
function InfraCard(props) {
  const { win, setTimeRange, syncId } = useContext(InfraTime)
  return <CardChart win={win} onFocus={setTimeRange} syncId={syncId} {...props} />
}

// One reading, labelled with what it was read from: a single-series card has no
// legend, so its tooltip row names the host, node or pod instead, as the
// Runtime tab's names the host.
const one = (label, rows) => [{ key: 'value', label, color: RESOURCE_COLORS.used, rows }]

// Traffic both ways, stacked into what crossed the interface. A host, a node
// and a pod draw it alike.
const netSeries = e => [
  { key: 'transmit', label: 'transmit', color: RESOURCE_COLORS.alt, rows: e.netOutSeries },
  { key: 'receive', label: 'receive', color: RESOURCE_COLORS.used, rows: e.netInSeries },
]

const fmtCores2 = v => (v == null || Number.isNaN(v) ? '' : `${v.toFixed(2)} cores`)
const fmtCores3 = v => (v == null || Number.isNaN(v) ? '' : `${v.toFixed(3)} cores`)

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

const FLEET_METRICS = [
  { title: 'CPU Used %', dataKey: 'cpu', seriesKey: 'cpuSeries' },
  { title: 'Memory Used %', dataKey: 'mem', seriesKey: 'memSeries' },
  { title: 'Disk Used %', dataKey: 'disk', seriesKey: 'diskSeries' },
]

/**
 * A fleet's CPU, memory and disk, a line per host (or node) on each: the
 * service page's RED charts (LegendLineChart), in one panel.
 *
 * Each legend lists the fleet busiest-first by its own figure. That is the
 * order the hosts table sorts by, and the order the series budget draws in, so
 * a chart that cannot draw all 64 hosts holds back the quiet ones rather than
 * whichever came last in the data. A legend's figure is the window's mean, the
 * same number as the host's table row, and it scrolls beside the chart rather
 * than growing the row to the length of the fleet.
 *
 * A host keeps its colour on all three charts (it is keyed on the host's place
 * in the data's own order), and isolating it in one legend isolates it in all
 * three: the choice is held here, by name, as the Browser page's metric tabs
 * hold theirs.
 */
function FleetCharts({ rows, nameKey, noun }) {
  const { win, setTimeRange, syncId } = useContext(InfraTime)
  const [isolated, setIsolated] = useState(null)
  const series = useMemo(() => Object.fromEntries(FLEET_METRICS.map(m => [
    m.dataKey,
    rows.map(r => ({ [nameKey]: r[nameKey], series: r[m.seriesKey] })),
  ])), [rows, nameKey])
  return (
    <div className="panel">
      {FLEET_METRICS.map(m => (
        <LegendLineChart
          key={m.dataKey}
          title={m.title}
          eps={rows}
          epSeries={series[m.dataKey]}
          dataKey={m.dataKey}
          labelKey={nameKey}
          fmtFn={fmtPct2}
          axisFormat={fmtPctTick}
          colorFor={infraColor}
          legendSort="valueDesc"
          legendScroll
          noun={noun}
          selected={isolated}
          onSelect={setIsolated}
          syncId={syncId}
          win={win}
          onFocus={setTimeRange}
        />
      ))}
    </div>
  )
}

/**
 * A host's CPU or memory over the window, beside the processes that use the
 * most of it: the service page's Latency Drilldown frame — a panel head that
 * names the chart and carries its ⋮ menu, the chart, and a searchable column
 * beside it.
 *
 * The column is a ranking rather than a legend. The agent reports a process's
 * share as one figure, not as a series, so there is no line for a row to name:
 * the rows carry no swatch, and pressing one isolates nothing. The host's own
 * reading is the one line, in the brand blue the service page draws every
 * single-series chart in.
 *
 * `tabs` are production's other views of the CPU card. Only the first has data
 * in this prototype; the rest are stubbed the way the sidebar stubs a page that
 * is not built yet — dimmed, inert, and saying so on hover.
 */
function ProcessChartPanel({ title, series, metric, tabs }) {
  const { win, setTimeRange, syncId } = useContext(InfraTime)
  const [search, setSearch] = useState('')
  const data = useMemo(() => withX(series, win), [series, win])
  const ranked = useMemo(() => [...HOST_PROCESSES].sort((a, b) => b[metric] - a[metric]), [metric])
  const q = search.trim().toLowerCase()
  const shown = q ? ranked.filter(p => p.name.toLowerCase().includes(q)) : ranked
  return (
    <div className="panel">
      <div className="panel-head is-divided">
        <div className="panel-head-left">
          {tabs ? (
            <div className="seg-toggle" role="tablist" aria-label={`${title} views`}>
              {tabs.map((t, i) => (i === 0
                ? <div key={t} role="tab" aria-selected="true" className="seg active">{t}</div>
                : <div key={t} role="tab" aria-selected="false" aria-disabled="true" className="seg is-stub" title={`${t} - not part of this prototype yet`}>{t}</div>
              ))}
            </div>
          ) : title}
        </div>
        <CardMenu kind="chart" title={title} />
      </div>
      <div className="drill2">
        <div className="drill2-chart">
          <TimeChart win={win} onFocus={setTimeRange} height={260}>
            {(axis, focus) => (
              <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} syncId={syncId} syncMethod="value" {...focus.chartProps}>
                <CartesianGrid {...GRID_PROPS} />
                <XAxis {...axis.props} />
                <YAxis {...valueAxisProps({ format: fmtPct1, maxValue: maxOf(data, 'value') })} />
                <Tooltip content={p => <SvcTooltip {...p} color={RESOURCE_COLORS.used} unit="" formatVal={fmtPct1} nowMs={win.end * 1000} suppressed={!focus.hovered} />} {...NO_ANIM} />
                <Line {...LINE_PROPS} dataKey="value" stroke={RESOURCE_COLORS.used} strokeWidth={1.6} dot={false} activeDot={{ r: 3, strokeWidth: 0 }} />
                {focus.overlay}
              </LineChart>
            )}
          </TimeChart>
        </div>
        <div className="drill2-legend is-scroll">
          <div className="drill2-legend-hdr">Top processes</div>
          <div className="drill2-search">
            <SearchGlyph />
            <input
              type="search"
              aria-label="Search processes"
              placeholder="Search processes…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
          {shown.map(p => (
            <div key={p.name} className="drill2-item is-static">
              <span className="drill2-row">
                <span className="drill2-label">{p.name}</span>
                <span className="drill2-val">{p[metric].toFixed(2)}<span className="drill2-unit">%</span></span>
              </span>
            </div>
          ))}
          {shown.length === 0 && (
            <div className="drill2-empty">No processes match "{search.trim()}"</div>
          )}
        </div>
      </div>
    </div>
  )
}

function HostDetail({ host }) {
  return (
    <div className="infra-host-detail">
      <ProcessChartPanel title="CPU Used %" series={host.cpuSeries} metric="cpu" tabs={['CPU Used %', 'CPU State %', 'Load Average']} />
      <ProcessChartPanel title="Memory Used %" series={host.memSeries} metric="mem" />

      <div className="infra-card-grid">
        <InfraCard title="Disk Used %" value={fmtPct1(host.disk)} span="third" fmt={fmtPct1} series={one(host.host, host.diskSeries)} />
        <InfraCard title="Network Traffic (bytes/s)" span="third" area fmt={fmtBytes} series={netSeries(host)} />
        <InfraCard title="Disk I/O Utilization %" value={fmtPct1(lastReading(host.diskIoSeries) ?? 0)} span="third" fmt={fmtPct1} series={one(host.host, host.diskIoSeries)} />
      </div>
    </div>
  )
}

/**
 * The hosts table under the fleet charts, with the multi-column table search
 * the pod tables use (TableQuerySearch over HOST_FIELDS): a bare word matches
 * the host or its service, `host:` and `service:` narrow to one. A query that
 * does not parse yet filters nothing, so the list does not empty itself while
 * an operator is half typed.
 */
function HostTable({ hosts, onSelect }) {
  const [query, setQuery] = useState('')
  const { node, ok } = parsePodQuery(query, HOST_FIELDS)
  const shown = useMemo(() => (ok ? hosts.filter(h => matchesPod(node, h, HOST_FIELDS)) : hosts), [hosts, node, ok])
  const hits = useMemo(() => (ok ? highlightsFor(node, HOST_FIELDS) : { host: [], service: [] }), [node, ok])
  const columns = useMemo(() => HOST_COLUMNS.map(c => (
    c.key === 'host' ? { ...c, render: h => highlightTerms(h.host, hits.host, 'svc-hit') }
      : c.key === 'service' ? { ...c, render: h => (h.service ? highlightTerms(h.service, hits.service, 'svc-hit') : c.render(h)) }
        : c
  )), [hits])
  return (
    <div className="panel">
      <div className="panel-head is-stacked">
        <div className="panel-head-row">
          <span>Summary</span>
        </div>
        <TableQuerySearch onApply={setQuery} fields={HOST_FIELDS} />
      </div>
      <SortableTable
        columns={columns}
        rows={shown.map(withNetRates)}
        rowKey={h => h.host}
        defaultSort="cpu"
        onRowClick={h => onSelect(h.host)}
        empty={`No data matches “${query.trim()}”.`}
      />
    </div>
  )
}

/* ============ Kubernetes: Cluster ============ */

// CPU or memory allocation. Total, request and limit are what the cluster was
// configured for, so they are dashed (LIMIT_DASH), as the Runtime tab dashes a
// JVM's limit; `used` is the one reading. Colours are keyed on the role, as on
// the Runtime tab's heap charts — a request is what is committed to a pod.
const ALLOC_ROLES = {
  total: { label: 'total', color: RESOURCE_COLORS.alt, dash: LIMIT_DASH },
  request: { label: 'request', color: RESOURCE_COLORS.committed, dash: LIMIT_DASH },
  limit: { label: 'limit', color: RESOURCE_COLORS.limit, dash: LIMIT_DASH },
  used: { label: 'used', color: RESOURCE_COLORS.used },
}

// In draw order, which is also the legend's and the tooltip's. The two charts
// differ on purpose: the memory chart puts `used` under its ceilings and the
// CPU one does not.
const allocSeries = (alloc, order) => order.map(key => ({ key, ...ALLOC_ROLES[key], rows: alloc[key] }))
const CPU_ALLOC_ORDER = ['total', 'request', 'limit', 'used']
const MEM_ALLOC_ORDER = ['total', 'used', 'limit', 'request']

// Ready and not ready, stacked into every container the scope runs. Flat by
// definition in this cluster, and it still gets the ladder and the drag: an
// axis that changes shape depending on whether a chart happens to be
// interesting is an axis a reader cannot trust, and a flat stretch is exactly
// where someone zooms in to check.
const containerSeries = c => [
  { key: 'ready', label: 'ready', color: RESOURCE_COLORS.used, rows: c.ready },
  { key: 'notReady', label: 'not ready', color: RESOURCE_COLORS.alt, rows: c.notReady },
]

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
      <div className="infra-card-grid">
        <InfraCard title="CPU Allocation (cores)" span="third" fmt={fmtCompact} tipFmt={fmtCores2} series={allocSeries(alloc.cpu, CPU_ALLOC_ORDER)} />
        <InfraCard title="Memory Allocation (bytes)" span="third" fmt={fmtBytes} series={allocSeries(alloc.mem, MEM_ALLOC_ORDER)} />
        <InfraCard title="Containers" span="third" area allowDecimals={false} fmt={fmtCount} series={containerSeries(containers)} />
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
          <div className="panel-head">Pods</div>
          <SortableTable columns={NAMESPACE_POD_COLUMNS} rows={detail.pods} rowKey={p => p.name} />
        </div>
      ) : (
        <div className="panel">
          <div className="panel-head">Summary</div>
          <SortableTable columns={NAMESPACE_COLUMNS} rows={k8sNamespaceSummary} rowKey={n => n.namespace} onRowClick={n => setNamespace(n.namespace)} />
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
        <SortableTable columns={EVENT_COLUMNS} rows={[]} rowKey={e => e.id} sortable={false} empty="No abnormal events in the selected time range" />
      </div>
    </>
  )
}

/* ============ Kubernetes: Deployment ============ */

function K8sDeploymentView() {
  const { win } = useContext(InfraTime)
  const notAvailable = useMemo(() => k8sContainersSeriesForWindow(win).notReady, [win])
  return (
    <>
      <div className="infra-card-grid">
        <InfraCard title="Pods Desired but not Available" span="full" allowDecimals={false} fmt={fmtCount} series={one('not available', notAvailable)} />
      </div>
      <div className="panel">
        <div className="panel-head">Summary</div>
        <SortableTable columns={DEPLOYMENT_COLUMNS} rows={k8sDeploymentSummary} rowKey={n => n.namespace} />
      </div>
    </>
  )
}

/* ============ Kubernetes: Node → Pod drill-in ============ */

// `pods` are the ones this pod could be swapped for: the node's, when it was
// reached through a node, or every pod. A pod lives in exactly one namespace,
// so picking another opens the first of those pods that lives there. The strip
// is the service page's Endpoint strip, sliding away and back with `reveal`.
function K8sPodDetail({ pod, pods, onSelectPod, reveal }) {
  const namespaces = useMemo(() => [...new Set(pods.map(p => p.namespace))].sort(), [pods])
  const pickNamespace = ns => {
    const first = ns !== pod.namespace && pods.find(p => p.namespace === ns)
    if (first) onSelectPod(first.name)
  }

  return (
    <div>
      <div className={`endpoint-strip is-sticky${revealClass(reveal)}`}>
        <FilterSelect
          className="is-endpoint"
          label="Namespace"
          value={pod.namespace}
          options={namespaces}
          onSelect={pickNamespace}
        />
      </div>

      <div className="k8s-containers-table">
        <div className="k8s-containers-head">Containers</div>
        <SortableTable columns={CONTAINER_COLUMNS} rows={[pod]} rowKey={p => p.containerName} sortable={false} />
      </div>

      <div className="infra-card-grid">
        <InfraCard title="CPU Used (cores)" fmt={fmtCompact} tipFmt={fmtCores3} series={one(pod.name, pod.cpuSeries)} />
        <InfraCard title="Memory Used (bytes)" fmt={fmtBytes} series={one(pod.name, pod.memSeries)} />
        <InfraCard title="Disk Used %" span="third" fmt={fmtPct1} series={one(pod.name, pod.diskSeries)} />
        <InfraCard title="Container Restarts" span="third" allowDecimals={false} fmt={fmtCount} series={one(pod.name, pod.restartsSeries)} />
        <InfraCard title="Network Traffic (bytes/s)" span="third" area fmt={fmtBytes} series={netSeries(pod)} />
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
      <div className="infra-card-grid">
        <InfraCard title="CPU Used %" value={fmtPct1(node.cpu)} span="third" fmt={fmtPct1} series={one(node.name, node.cpuSeries)} />
        <InfraCard title="Memory Used %" value={fmtPct1(node.mem)} span="third" fmt={fmtPct1} series={one(node.name, node.memSeries)} />
        <InfraCard title="Disk Used %" value={fmtPct1(node.disk)} span="third" fmt={fmtPct1} series={one(node.name, node.diskSeries)} />
        <InfraCard title="Network Traffic (bytes/s)" span="full" area fmt={fmtBytes} series={netSeries(node)} />
      </div>

      <div className="panel">
        <div className="panel-head is-stacked">
          <div className="panel-head-row">
            <span>Pods</span>
          </div>
          <TableQuerySearch onApply={setPodQuery} fields={POD_FIELDS} />
        </div>
        <SortableTable
          columns={[
            { key: 'name', label: 'Pod', align: 'left', mono: true, clip: 300, title: p => p.name, render: p => <PodName pod={p} hits={hits} tagHits={tagHits} /> },
            { key: 'namespace', label: 'Namespace', align: 'left', mono: true, render: p => highlightTerms(p.namespace, hits.namespace, 'svc-hit') },
            { key: 'cpuUsed', label: 'CPU Used' },
            { key: 'memUsed', label: 'Memory Used', render: p => fmtBytes(p.memUsed) },
            { key: 'memRemaining', label: 'Memory Remaining', render: p => (p.memRemaining == null ? '-' : fmtBytes(p.memRemaining)) },
            { key: 'netIn', label: 'Network In', sortable: false, render: () => '-' },
            { key: 'netOut', label: 'Network Out', sortable: false, render: () => '-' },
          ]}
          rows={shown.map(p => ({ ...p, memRemaining: p.memRequest ? p.memRequest - p.memUsed : null }))}
          rowKey={p => p.name}
          onRowClick={p => onSelectPod(p.name)}
          empty={`No data matches “${podQuery.trim()}”.`}
        />
      </div>
    </div>
  )
}

function K8sNodeView({ nodes, pods, selectedNode, setSelectedNode, selectedPod, setSelectedPod, reveal }) {
  if (selectedPod) {
    const onNode = selectedNode ? pods.filter(p => p.node === selectedNode.name) : pods
    return <K8sPodDetail pod={selectedPod} pods={onNode} onSelectPod={setSelectedPod} reveal={reveal} />
  }
  if (selectedNode) {
    return <K8sNodeDetail node={selectedNode} pods={pods} onSelectPod={setSelectedPod} />
  }
  return (
    <>
      <FleetCharts rows={nodes} nameKey="name" noun="nodes" />
      <div className="panel">
        <div className="panel-head">Summary</div>
        <SortableTable columns={NODE_COLUMNS} rows={nodes.map(withNetRates)} rowKey={n => n.name} onRowClick={n => setSelectedNode(n.name)} />
      </div>
    </>
  )
}

function K8sPodListView({ pods, selectedPod, setSelectedPod, reveal }) {
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

  if (selectedPod) return <K8sPodDetail pod={selectedPod} pods={pods} onSelectPod={setSelectedPod} reveal={reveal} />
  return (
    <div className="panel">
      <div className="panel-head is-stacked">
        <div className="panel-head-row">
          <span>Pods</span>
        </div>
        <TableQuerySearch onApply={setQuery} fields={POD_NODE_FIELDS} />
      </div>
      <SortableTable
        columns={[
          { key: 'name', label: 'Pod', align: 'left', mono: true, clip: 300, title: p => p.name, render: p => <PodName pod={p} hits={hits} tagHits={tagHits} /> },
          { key: 'namespace', label: 'Namespace', align: 'left', mono: true, render: p => highlightTerms(p.namespace, hits.namespace, 'svc-hit') },
          { key: 'node', label: 'Node', align: 'left', mono: true, render: p => highlightTerms(p.node, hits.node, 'svc-hit') },
          { key: 'cpuUsed', label: 'CPU Used' },
          { key: 'memUsed', label: 'Memory Used', render: p => fmtBytes(p.memUsed) },
          { key: 'restarts', label: 'Restarts', sortable: false, render: () => 0 },
        ]}
        rows={shown}
        rowKey={p => p.name}
        onRowClick={p => setSelectedPod(p.name)}
        empty={`No data matches “${query.trim()}”.`}
      />
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
          <SortableTable columns={emptyColumns([resourceLabel, 'Used', 'Capacity'])} rows={[]} rowKey={r => r.name} sortable={false} empty={`No ${resourceLabel.toLowerCase()} resources in "${namespace}"`} />
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
 * The flat line a source with no integration draws, in the same card as every
 * other chart on the page. It is still the window's own axis - "no data" over
 * the last seven days has to say seven days - but it carries no Tooltip, so it
 * is the one chart on the page that cannot be brushed, and it leaves out the
 * drag's handlers and crosshair rather than offer a gesture that cannot finish.
 * It carries no ⋮ menu either: there is nothing in it to alert on, compare or
 * explore.
 */
function NoDataChart({ title }) {
  const { win } = useContext(InfraTime)
  const data = useMemo(
    () => withX(win.buckets.map(b => ({ t: b.t, label: b.label, exactTime: b.exactTime, value: 0 })), win),
    [win],
  )
  return (
    <div className="runtime-chart-card rt-third">
      <div className="clbl"><span className="clbl-text">{title}</span></div>
      <TimeChart className="chart-host" win={win}>
        {axis => (
          <LineChart data={data} margin={{ top: 6, right: 4, left: 0, bottom: 0 }}>
            <CartesianGrid {...GRID_PROPS} />
            <XAxis {...axis.props} />
            <YAxis {...valueAxisProps({ domain: [0, 1], maxValue: 1 })} />
            <Line {...LINE_PROPS} dataKey="value" stroke="var(--text-muted)" strokeWidth={1} dot={false} />
          </LineChart>
        )}
      </TimeChart>
    </div>
  )
}

function InfraEmptyView({ columns }) {
  return (
    <>
      <div className="infra-card-grid">
        {['Requests per Minute', 'Errors', 'Latency'].map(t => <NoDataChart key={t} title={t} />)}
      </div>
      <div className="infra-empty-table">
        <SortableTable columns={emptyColumns(columns)} rows={[]} rowKey={r => r.name} sortable={false} empty="No data" />
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
      <div className="infra-card-grid">
        <InfraCard title="Operations per Minute" value={s.opsPerMin} span="third" allowDecimals={false} fmt={fmtCount} series={one(s.host, series.opsPerMin)} />
        <InfraCard title="Connection Errors per Minute" value={s.connErrPerMin} span="third" allowDecimals={false} fmt={fmtCount} series={one(s.host, series.connErrors)} />
        <InfraCard title="Slow Queries per Minute" value={s.slowQueriesPerMin} span="third" allowDecimals={false} fmt={fmtCount} series={one(s.host, series.slowQueries)} />
      </div>
      <div className="panel">
        <div className="panel-head">Summary</div>
        <SortableTable columns={MYSQL_COLUMNS} rows={[s]} rowKey={r => r.host} sortable={false} />
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
      <div className="infra-card-grid">
        <InfraCard title="Memory Used (bytes)" value={fmtBytes(s.memUsedBytes)} span="third" fmt={fmtBytes} series={one(s.host, series.memUsed)} />
        <InfraCard title="Commands per Minute" value={s.cmdPerMin} span="third" allowDecimals={false} fmt={fmtCount} series={one(s.host, series.cmdPerMin)} />
        <InfraCard title="Evictions per Minute" value={lastReading(series.evictionsPerMin)} span="third" allowDecimals={false} fmt={fmtCount} series={one(s.host, series.evictionsPerMin)} />
      </div>
      <div className="panel">
        <div className="panel-head">Summary</div>
        <SortableTable columns={REDIS_COLUMNS} rows={[s]} rowKey={r => r.host} sortable={false} />
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

export default function InfraView({ goHome, source, resource, selectedHost, setSelectedHost, timeRange, setTimeRange, settingsOpen, setSettingsOpen, setToast }) {
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

  // A pod's Namespace strip slides away and back as the body scrolls, as the
  // service page's Endpoint strip does. Only a pod has the strip, so only a
  // pod's scrolling is followed: every reveal re-renders this page, and the
  // fleet views under it draw dozens of series.
  const { reveal: stripReveal, onScroll: onStripScroll } = useScrollReveal(syncId)

  // The chart cards carry the service page's ⋮ menu, and offer what it offers.
  // None of the screens behind it - the alert builder, the comparison window,
  // Explore over host metrics - is wired to this page yet, so the menu says so
  // rather than doing nothing, as the service page's does for its own gaps.
  const onCardAction = useCallback((action, title) => {
    setToast?.(`${action} · ${title} - that screen is not part of this prototype yet.`)
  }, [setToast])

  let body
  if (host) {
    body = <HostDetail host={host} />
  } else if (source === 'host') {
    body = (
      <>
        <FleetCharts rows={hosts} nameKey="host" noun="hosts" />

        <HostTable hosts={hosts} onSelect={setSelectedHost} />
      </>
    )
  } else if (source === 'mysql') {
    body = <MySQLView />
  } else if (source === 'redis') {
    body = <RedisView />
  } else if (source === 'k8s-cluster') {
    body = <K8sClusterView namespace={k8sNamespace} setNamespace={setK8sNamespace} />
  } else if (source === 'k8s-node') {
    body = <K8sNodeView nodes={nodes} pods={pods} selectedNode={k8sNode} setSelectedNode={setK8sNodeName} selectedPod={k8sPod} setSelectedPod={setK8sPodName} reveal={stripReveal} />
  } else if (source === 'k8s-pod') {
    body = <K8sPodListView pods={pods} selectedPod={k8sPod} setSelectedPod={setK8sPodName} reveal={stripReveal} />
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
    <CardActionContext.Provider value={onCardAction}>
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
        <div className="svc-main infra-main" onScroll={k8sPod ? onStripScroll : undefined}>
          {body}
        </div>
      </InfraTime.Provider>
    </CardActionContext.Provider>
  )
}
