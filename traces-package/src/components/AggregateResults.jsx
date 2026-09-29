import { useMemo } from 'react'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts'
import { TrendingDown, TrendingUp } from 'lucide-react'
import { paletteColor as palette } from '@/utils/chartPalette'

function formatValue(n) {
  if (n == null || !Number.isFinite(n)) return '—'
  if (Math.abs(n) >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 0 })
  if (Math.abs(n) >= 100) return n.toFixed(0)
  if (Math.abs(n) >= 10) return n.toFixed(1)
  return n.toFixed(2)
}

function formatBucket(t) {
  const d = new Date(t)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// Custom tooltip — one line per visible series, muted "no data" for gaps.
function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  return (
    <div className="agg-tooltip">
      <div className="agg-tooltip-t">{formatBucket(label)}</div>
      {payload.map((p, i) => (
        <div key={i} className="agg-tooltip-row">
          <span className="agg-tooltip-swatch" style={{ background: p.color }} />
          <span className="agg-tooltip-name">{p.name}</span>
          <span className="agg-tooltip-val mono">{formatValue(p.value)}</span>
        </div>
      ))}
    </div>
  )
}

// ---------- Renderer ----------

export default function AggregateResults({ result, graphVisible = true }) {
  const { kind, series, buckets, statsPipe, filteredCount, sortPipe, limitPipe } = result
  const groupCount = statsPipe?.groupBy?.length || 0
  const fnCount = statsPipe?.functions?.length || 0
  const seriesCount = series.length

  // Reshape series → chart-ready rows: [{ t, s0, s1, s2, ... }, ...] with one
  // key per series so Recharts can render each as its own <Line />.
  const chartData = useMemo(() => {
    if (!series.length) return []
    return buckets.map((t, i) => {
      const row = { t }
      series.forEach((s, si) => { row[`s${si}`] = s.data[i]?.v ?? null })
      return row
    })
  }, [series, buckets])

  // Table rows collapse the time dimension: one row per group, each column
  // is a function (or math expression) showing the total across buckets.
  const tableRows = useMemo(() => {
    const rows = new Map()
    for (const s of series) {
      const k = s.groupValues.join('\x00') || '__all__'
      if (!rows.has(k)) {
        rows.set(k, { key: k, groupValues: s.groupValues, cells: {} })
      }
      rows.get(k).cells[s.fnKey] = { total: s.total, peak: s.peak, last: s.last, label: s.fnLabel }
    }
    return Array.from(rows.values())
  }, [series])

  const columns = useMemo(() => {
    if (!statsPipe) return []
    const cols = []
    for (const fn of statsPipe.functions) {
      cols.push({ key: fn.id, label: fn.as || `${fn.fn}(${fn.field || ''})` })
    }
    for (const mp of (result.mathPipes || [])) {
      cols.push({ key: `math::${mp.id}`, label: mp.as || mp.expression, isMath: true })
    }
    return cols
  }, [statsPipe, result.mathPipes])

  // ---- Branch: empty ----
  if (kind === 'empty' && series.length === 0) {
    const noStats = result.reason === 'no-stats'
    return (
      <div className="agg-panel">
        <div className="agg-empty">
          <div className="agg-empty-title">{noStats ? 'Add an aggregation to see results' : 'No data for these filters'}</div>
          {!noStats && (
            <div className="agg-empty-hint">
              Widen the time range or remove filter chips.
              {filteredCount > 0 && <> The current filter matched <strong>{filteredCount.toLocaleString()}</strong> log rows, but none fell inside the selected window.</>}
            </div>
          )}
        </div>
      </div>
    )
  }

  // ---- Branch: KPI (1 stats fn, no group-by, no math) ----
  if (groupCount === 0 && fnCount === 1 && (result.mathPipes || []).length === 0 && seriesCount === 1) {
    const s = series[0]
    const trend = s.last != null && s.data.length > 1
      ? s.last - (s.data[Math.max(0, s.data.length - 2)].v ?? s.last)
      : 0
    return (
      <div className="agg-panel">
        <div className="agg-kpi">
          <div className="agg-kpi-lbl">{s.fnLabel}</div>
          <div className="agg-kpi-val mono">{formatValue(s.total || s.last || 0)}</div>
          <div className="agg-kpi-meta">
            <span className="agg-kpi-scope">across {filteredCount.toLocaleString()} log{filteredCount === 1 ? '' : 's'}</span>
            {trend !== 0 && Number.isFinite(trend) && (
              <span className={`agg-kpi-trend${trend > 0 ? ' is-up' : ' is-down'}`}>
                {trend > 0 ? <TrendingUp size={12} strokeWidth={2} /> : <TrendingDown size={12} strokeWidth={2} />}
                {trend > 0 ? '+' : ''}{formatValue(trend)}
              </span>
            )}
          </div>
          {graphVisible && <div className="agg-kpi-spark">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 4, right: 4, left: 4, bottom: 4 }}>
                <Line type="monotone" dataKey="s0" stroke={palette(0)} strokeWidth={2} dot={false} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>}
        </div>
      </div>
    )
  }

  // ---- Branch: line chart + table ----
  return (
    <div className="agg-panel">
      {graphVisible && <div className="agg-chart">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData} margin={{ top: 8, right: 12, left: 4, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" vertical={false} />
            <XAxis
              dataKey="t"
              tickFormatter={formatBucket}
              tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
              tickLine={false}
              axisLine={{ stroke: 'var(--border-subtle)' }}
              interval={Math.max(0, Math.floor(chartData.length / 8))}
              minTickGap={24}
            />
            <YAxis
              tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
              tickLine={false}
              axisLine={false}
              width={38}
              tickFormatter={formatValue}
            />
            <Tooltip content={<ChartTooltip />} isAnimationActive={false} cursor={{ stroke: 'var(--border-strong)', strokeDasharray: '3 3' }} />
            <ReferenceLine y={0} stroke="var(--border-subtle)" />
            {series.map((s, i) => (
              <Line
                key={s.key}
                type="monotone"
                dataKey={`s${i}`}
                name={s.groupLabel ? `${s.groupLabel} · ${s.fnLabel}` : s.fnLabel}
                stroke={palette(i)}
                strokeWidth={2}
                strokeDasharray={s.kind === 'math' ? '5 3' : undefined}
                dot={false}
                connectNulls
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>}

      {graphVisible && <div className="agg-legend-wrap">
        <div className="agg-legend">
          {series.slice(0, 16).map((s, i) => (
            <div key={s.key} className="agg-legend-row">
              <span className="agg-legend-swatch" style={{ background: palette(i), borderStyle: s.kind === 'math' ? 'dashed' : 'solid' }} />
              <span className="agg-legend-name" title={`${s.groupLabel ?? ''} — ${s.fnLabel}`}>
                {s.groupLabel ? <><span className="agg-legend-group">{s.groupLabel}</span><span className="agg-legend-fn">{s.fnLabel}</span></> : s.fnLabel}
              </span>
              <span className="agg-legend-val mono">{formatValue(s.last)}</span>
            </div>
          ))}
          {series.length > 16 && <div className="agg-legend-more">+ {series.length - 16} more</div>}
        </div>
      </div>}

      <div className="agg-table-wrap">
        <table className="agg-table">
          <thead>
            <tr>
              {statsPipe.groupBy.map(f => <th key={f} className="agg-th-group">{f}</th>)}
              {columns.map(c => <th key={c.key} className={`agg-th-num${c.isMath ? ' is-math' : ''}`}>{c.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {tableRows.map(row => (
              <tr key={row.key}>
                {row.groupValues.length > 0
                  ? row.groupValues.map((v, i) => <td key={i} className="agg-td-group mono">{v}</td>)
                  : columns.length === 0 ? null : null}
                {columns.map(c => (
                  <td key={c.key} className="agg-td-num mono">{formatValue(row.cells[c.key]?.total)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="agg-table-foot">
          {series.length} series · {tableRows.length} group{tableRows.length === 1 ? '' : 's'} · {filteredCount.toLocaleString()} logs matched
          {limitPipe && <> · showing first {limitPipe.n}</>}
          {sortPipe && <> · sorted by <span className="mono">{sortPipe.field}</span> {sortPipe.dir === 'asc' ? '↑' : '↓'}</>}
        </div>
      </div>
    </div>
  )
}
