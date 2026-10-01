import { useState, useMemo } from 'react'
import { services, serviceSummary, serviceEdges, externalDependencies } from '@/data/services'
import { statusForLatency, statusForErrorRate, statusColor } from '@/utils/status'
import PageBar from '@/components/layout/PageBar'
import { highlightTerms } from '@/utils/highlight'
import TableSearch from '@/components/TableSearch'
import TabBar from '@/components/shared/TabBar'
import { parsePodQuery, matchesPod, highlightsFor, tagHighlightsFor, tagTerms, SERVICE_FIELDS } from '@/utils/tableQuery'

function SummaryStrip() {
  const s = serviceSummary
  const pills = [
    { cls: 'total', num: s.total, lbl: 'SERVICES', icon: <><rect x="3" y="4" width="18" height="6" rx="1"/><rect x="3" y="14" width="18" height="6" rx="1"/><circle cx="7" cy="7" r=".7"/><circle cx="7" cy="17" r=".7"/></> },
    { cls: 'critical', num: s.critical, lbl: 'CRITICAL', icon: <><path d="M12 3l9 17H3z"/><path d="M12 10v4M12 17v.01"/></> },
    { cls: 'warning', num: s.warning, lbl: 'WARNING', icon: <><path d="M6 10a6 6 0 1112 0c0 5 2 6 2 6H4s2-1 2-6"/><path d="M10 20a2 2 0 004 0"/></> },
    { cls: 'healthy', num: s.healthy, lbl: 'HEALTHY', icon: <path d="M20 6L9 17l-5-5"/> },
  ]
  return (
    <div className="summary-strip">
      {pills.map(p => (
        <div key={p.cls} className={`summary-pill ${p.cls}`}>
          <div>
            <div className="num">{p.num}</div>
            <div className="lbl">{p.lbl}</div>
          </div>
          <div className="icon-wrap">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{p.icon}</svg>
          </div>
        </div>
      ))}
    </div>
  )
}

function DetailTable({ onServiceClick }) {
  const [search, setSearch] = useState('')
  const term = search.trim()
  // A query that does not parse leaves the rows alone rather than emptying the
  // table under someone mid-`service.team:(`.
  const { node: queryNode, ok } = parsePodQuery(search, SERVICE_FIELDS)

  // Filtering only removes rows, so severity order survives it — `services` is
  // already sorted critical-first at the data layer, and a search must never be
  // the thing that quietly reorders the list alphabetically.
  const shown = useMemo(
    () => (ok ? services.filter(s => matchesPod(queryNode, s, SERVICE_FIELDS)) : services),
    [queryNode, ok]
  )

  // Two highlight sets: the service name, and the tag chips. A term aimed at
  // one tag underlines only that tag; free text underlines wherever it could
  // have matched, which is both.
  const hits = useMemo(
    () => (ok ? highlightsFor(queryNode, SERVICE_FIELDS) : { service: [] }), [queryNode, ok])
  const tagHits = useMemo(
    () => (ok ? tagHighlightsFor(queryNode, SERVICE_FIELDS) : {}), [queryNode, ok])

  // The hint slot earns its keep either way: the sort rule when the whole list
  // is showing, the count when it is not.
  const hint = term
    ? `${shown.length} of ${services.length} services`
    : 'Sorted by severity - critical first'

  return (
    <div className="panel">
      <div className="panel-head is-stacked">
        {/* Title and hint share the top row so the search below them can span
            the panel's full width rather than stopping short of the hint. */}
        <div className="panel-head-row">
          <span>All services</span>
          <span className="hint">{hint}</span>
        </div>
        <TableSearch onApply={setSearch} />
      </div>
      <table>
        <thead>
          <tr>
            <th style={{ textAlign: 'left' }}>Service</th>
            <th className="sortable">RPM<span className="arrow">▾</span></th>
            <th className="sortable">Latency p90<span className="arrow">▾</span></th>
            <th className="sortable">Latency Avg</th>
            <th className="sortable">Error Rate</th>
          </tr>
        </thead>
        <tbody>
          {shown.length === 0 && (
            <tr className="svc-empty-row">
              <td colSpan={5}>
                No service matches “{term}”.
              </td>
            </tr>
          )}
          {shown.map(s => {
            const latS = statusForLatency(s.latencyP90)
            const errS = statusForErrorRate(s.errorRatePct)
            return (
              <tr key={s.id} onClick={() => onServiceClick(s.id)}>
                <td>
                  <div className="svc-name">
                    <span className={`status-dot ${s.status}`} title={`Status: ${s.status}`} />
                    {/* One element whether highlighted or not: .svc-name is a
                        flex row with a gap, so returning the name as several
                        nodes would space each fragment apart. */}
                    <span className="svc-name-text">
                      {highlightTerms(s.name, hits.service, 'svc-hit')}
                    </span>
                    <span className="svc-lang">{s.language}</span>
                    <span className={`badge ${s.status}`}>{s.status}</span>
                    {/* The tags live in this column, so they are searched
                        through it: service.team:payments. */}
                    {Object.entries(s.tags ?? {}).map(([k, v]) => (
                      <span key={k} className="svc-tag" title={`${k}: ${v} — search as service.${k}:${v}`}>
                        <span className="svc-tag-k">{k}</span>
                        <span className="svc-tag-v">{highlightTerms(v, tagTerms(tagHits, 'service', k), 'svc-hit')}</span>
                      </span>
                    ))}
                  </div>
                </td>
                <td>{s.rpm >= 1000 ? (s.rpm / 1000).toFixed(2) + 'K' : s.rpm.toFixed(2)}</td>
                <td className={latS === 'critical' ? 'val-critical' : latS === 'warning' ? 'val-warning' : ''}>{s.latencyP90} ms</td>
                <td>{s.latencyAvg} ms</td>
                <td>
                  <span className="cell-bar">
                    <span className="track">
                      <span className="fill" style={{ width: `${Math.min(100, s.errorRatePct * 12)}%`, background: statusColor(errS) }} />
                    </span>
                    <span className={errS === 'critical' ? 'val-critical' : errS === 'warning' ? 'val-warning' : ''}>{s.errorRatePct}%</span>
                  </span>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function HealthTab() {
  const buckets = 36
  const seriesFor = (status, seed) => {
    let s = seed
    const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280 }
    return Array.from({ length: buckets }, (_, i) => {
      const recent = i > buckets - 8
      if (status === 'critical') return recent ? 'critical' : (rnd() < 0.3 ? 'warning' : 'healthy')
      if (status === 'warning') return recent ? 'warning' : (rnd() < 0.15 ? 'warning' : 'healthy')
      return 'healthy'
    })
  }
  return (
    <div className="panel">
      <div className="panel-head">Health history <span className="hint">Last 1 hour · {buckets} buckets</span></div>
      {services.map((s, idx) => {
        const blocks = seriesFor(s.status, idx * 7 + 3)
        return (
          <div className="health-row" key={s.id}>
            <div className="name">
              <span className={`status-dot ${s.status}`} title={`Status: ${s.status}`} />
              {s.name}
            </div>
            <div className="health-strip">
              {blocks.map((st, i) => (
                <div key={i} className="health-block" style={{ background: statusColor(st), opacity: st === 'healthy' ? 0.5 : 1 }} title={`Status: ${st}`} />
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function GraphTab() {
  const pos = {
    'payment-service': [50, 18], 'order-service': [22, 18], 'shipment-service': [78, 18],
    'notify-service': [22, 44], 'search-service': [50, 44], 'analytics-service': [78, 44],
    'demo-nodejs-service': [50, 64], 'redis.0': [50, 88], 'mysql.cubedemo': [20, 88],
    'mongodb.cubedemo': [64, 88], 'api.twilio.com': [84, 88], 'maps.googleapis.com': [34, 100],
    'email.ap-south-1.amazonaws.com': [98, 100],
  }
  return (
    <div className="panel">
      <div className="panel-head">Service graph <span className="hint">Node color = status · red edges trace the incident path</span></div>
      <div className="graph-wrap">
        <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
          {serviceEdges.map(([a, b], i) => {
            const pa = pos[a], pb = pos[b]
            if (!pa || !pb) return null
            const crit = a === 'payment-service' || b === 'payment-service' || b === 'redis.0'
            return <line key={i} x1={`${pa[0]}%`} y1={`${pa[1]}%`} x2={`${pb[0]}%`} y2={`${pb[1]}%`} stroke={crit ? 'rgba(239,68,68,.4)' : 'var(--border-panel)'} strokeWidth="1.5" />
          })}
        </svg>
        {[...services, ...externalDependencies].map(n => {
          const p = pos[n.id]
          if (!p) return null
          const dep = !!n.type && !services.find(s => s.id === n.id)
          return (
            <div key={n.id} className={`graph-node ${dep ? 'dep' : n.status}`} style={{ left: `${p[0]}%`, top: `${p[1]}%` }}>
              {n.name}
            </div>
          )
        })}
      </div>
    </div>
  )
}

const HOME_TABS = [
  { id: 'detail', label: 'Detail' },
  { id: 'health', label: 'Health' },
  { id: 'graph', label: 'Service Graph' },
]

export default function HomePage({ selectService, timeRange, setTimeRange }) {
  const [homeTab, setHomeTab] = useState('detail')

  return (
    <>
      <PageBar timeRange={timeRange} setTimeRange={setTimeRange}>
        <span>CubeAPM</span>
        <span className="sep">/</span>
        <span className="current">Home</span>
      </PageBar>
      <div className="home-scroll">
      <SummaryStrip />
      <div style={{ marginBottom: 12 }}>
        <TabBar tabs={HOME_TABS} active={homeTab} onChange={setHomeTab} ariaLabel="Service view" />
      </div>
      {homeTab === 'detail' && <DetailTable onServiceClick={selectService} />}
      {homeTab === 'health' && <HealthTab />}
      {homeTab === 'graph' && <GraphTab />}
      </div>
    </>
  )
}
