import CardMenu from '@/components/CardMenu'

/**
 * Placeholders for the Overview tab while its figures are in flight.
 *
 * Each one is built from the same classes, in the same card, as the panel it
 * stands in for, titles and menus included, so the real panel replaces it
 * without anything on the page moving. The titles are known before the query
 * returns; only the figures are not, so only the figures are bones.
 *
 * Every bone shares one sheen (see `.ovsk-bone`): it is painted against the
 * viewport rather than the element, so it reads as one light passing over the
 * page instead of a dozen bars shimmering out of step.
 */

// `inline` sits the bone on a line of text, inside the class of the text it
// stands in for, so the row keeps that text's line height rather than taking
// the bone's.
function Bone({ w, h, inline = false, className = '', style }) {
  return <span className={`ovsk-bone${inline ? ' is-inline' : ''} ${className}`} style={{ width: w, height: h, ...style }} aria-hidden="true" />
}

// Value and unit widths roughly the size of what each card prints, so the
// reveal swaps a bar for a number of about the same width rather than a
// uniform strip for whatever lands.
const KPI_SLOTS = [
  { lbl: 'Requests / min', val: 112, unit: 0 },
  { lbl: 'p90 Latency', val: 62, unit: 20 },
  { lbl: 'Avg Latency', val: 62, unit: 20 },
  { lbl: 'Error %', val: 44, unit: 11 },
]

export function KpiCardsSkeleton() {
  return (
    <div className="kpi-grid" aria-busy="true">
      {KPI_SLOTS.map(c => (
        <div key={c.lbl} className="kpi-card">
          <div className="kpi-card-head">
            <span className="lbl">{c.lbl}</span>
            <CardMenu kind="metric" title={c.lbl} />
          </div>
          <div className="ovsk-kpi-val">
            <Bone w={c.val} h={22} />
            {c.unit > 0 && <Bone w={c.unit} h={9} />}
          </div>
        </div>
      ))}
    </div>
  )
}

// A ghost of the mark the chart draws (a stacked area, an area, a line), never
// of the data it will draw. Drawn into a 200×100 box stretched over the plot,
// and used as a mask so the ghost takes the same sheen as every other bone.
function ghostPath(level, seed) {
  return Array.from({ length: 25 }, (_, i) => {
    const y = level + 9 * Math.sin(i * 0.52 + seed) + 4 * Math.sin(i * 1.9 + seed * 2.3)
    return `${(i / 24) * 200},${y.toFixed(1)}`
  })
}

function ghostMask(shape, level, seed) {
  const top = ghostPath(level, seed)
  let marks
  if (shape === 'line') {
    marks = `<polyline points="${top.join(' ')}" fill="none" stroke="#000" stroke-width="1.5" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`
  } else {
    marks = `<polygon points="0,100 ${top.join(' ')} 200,100" fill="#000" fill-opacity="${shape === 'stack' ? 0.45 : 0.6}"/>`
    // The stack's lower layer, denser than the one above it.
    if (shape === 'stack') {
      const low = ghostPath(level + 24, seed + 1.4)
      marks += `<polygon points="0,100 ${low.join(' ')} 200,100" fill="#000" fill-opacity="0.55"/>`
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100" preserveAspectRatio="none">${marks}</svg>`
  const url = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
  return { WebkitMaskImage: url, maskImage: url }
}

const Y_TICKS = [18, 18, 18, 18, 7] // top to bottom; the bottom tick is the one-character "0"

// The plot laid out on the real chart's geometry: a 29px value gutter, the
// chart's own top and right margins, a 30px time axis, the dashed grid at the
// value ticks and the solid axis line under it.
function PlotSkeleton({ ghost, top, right, xTicks }) {
  return (
    <div className="ovsk-plot" style={{ paddingTop: top, paddingRight: right }} aria-hidden="true">
      <div className="ovsk-y">
        {Y_TICKS.map((w, i) => (
          <Bone key={i} w={w} h={6} style={{ top: `calc(${i * 25}% - 3px)` }} />
        ))}
      </div>
      <div className="ovsk-field">
        {[0, 1, 2, 3].map(i => <span key={i} className="ovsk-gridline" style={{ top: `${i * 25}%` }} />)}
        <span className="ovsk-bone ovsk-ghost" style={ghost} />
      </div>
      <div className="ovsk-x">
        {Array.from({ length: xTicks }, (_, i) => <Bone key={i} w={24} h={6} />)}
      </div>
    </div>
  )
}

const DRILL_GHOST = ghostMask('stack', 34, 0.4)
// Label and bar widths vary row to row, as upstream names and shares do.
const DRILL_ROWS = [
  { label: '58%', bar: '52%' },
  { label: '74%', bar: '30%' },
  { label: '46%', bar: '12%' },
  { label: '64%', bar: '8%' },
]

export function LatencyDrilldownSkeleton() {
  return (
    <div className="panel" aria-busy="true">
      <div className="panel-head is-divided">
        <div className="panel-head-left">Latency Drilldown</div>
        <CardMenu kind="chart" title="Latency Drilldown" total="Total" />
      </div>
      <div className="drill2">
        <div className="drill2-chart">
          <div style={{ height: 260 }}>
            <PlotSkeleton ghost={DRILL_GHOST} top={8} right={8} xTicks={11} />
          </div>
        </div>
        <div className="drill2-legend">
          <div className="drill2-search" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" />
            </svg>
            <span className="ovsk-search-line"><Bone inline w="38%" h={7} /></span>
          </div>
          {DRILL_ROWS.map((r, i) => (
            <div key={i} className="drill2-item ovsk-item">
              <div className="drill2-row">
                <Bone className="drill2-swatch" />
                <span className="drill2-label"><Bone inline w={r.label} h={7} /></span>
                <span className="drill2-pct"><Bone inline w={26} h={6} /></span>
                <span className="drill2-val"><Bone inline w={40} h={8} /></span>
              </div>
              <div className="drill2-bartrack"><Bone w={r.bar} h="100%" /></div>
            </div>
          ))}
          <div className="drill2-total">
            <span className="drill2-total-swatch ovsk-total-swatch" aria-hidden="true" />
            <span className="drill2-total-lbl">Total</span>
            <span className="drill2-total-val"><Bone inline w={52} h={9} /></span>
          </div>
        </div>
      </div>
    </div>
  )
}

// RPM stacks its versions as areas; Error % and Apdex draw lines. Each sits
// about where its kind of series sits on its axis: errors low, Apdex near 1.
const TREND_SLOTS = [
  { title: 'RPM', ghost: ghostMask('area', 46, 1.3) },
  { title: 'Error %', ghost: ghostMask('line', 74, 2.1) },
  { title: 'Apdex', ghost: ghostMask('line', 22, 3.4) },
]

export function TrendChartsSkeleton() {
  return (
    <div className="charts-row" aria-busy="true">
      {TREND_SLOTS.map(t => (
        <div key={t.title} className="chart-card">
          <div className="clbl"><span className="clbl-text">{t.title}</span><CardMenu kind="chart" title={t.title} /></div>
          <div className="chart-host">
            <PlotSkeleton ghost={t.ghost} top={4} right={4} xTicks={6} />
          </div>
        </div>
      ))}
    </div>
  )
}
