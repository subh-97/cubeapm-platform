import { useState, useMemo, useRef, useLayoutEffect } from 'react'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts'
import {
  GRID_PROPS, NO_ANIM, LINE_PROPS, valueAxisProps, maxOf, niceAxis, formatDecimals, labelMatches, scrollTopToReveal,
} from '@/components/charts/chartDefaults'
import { withX } from '@/components/charts/timeAxis'
import ChartTooltip from '@/components/charts/ChartTooltip'
import { TimeChart, rowInstant } from '@/components/charts/TimeChart'
import { useSeriesBudget } from '@/components/charts/useSeriesBudget'
import SeriesBudgetFooter from '@/components/charts/SeriesBudgetFooter'
import { fixesAxis, TOOLTIP_ROWS } from '@/components/charts/seriesBudget'
import ChartActions from '@/components/charts/ChartActions'
import SearchGlyph from '@/components/shared/SearchGlyph'
import { epColor } from '@/utils/chartPalette'
import './legend-line-chart.css'

// The tooltip of a legend chart. A row's dataKey is `ep${i}`, where i is the
// row's index in `eps` — the index the colour is keyed on too — so the label
// and colour are read back off the key rather than off the drawn order.
//
// Without a formatLabel a long label is cut from the end, as the service page
// always has. A family of labels that share a long prefix (an origin, a host
// and port) needs a formatLabel instead, or every row reads the same.
function LegendTooltip({ active, payload, eps, labelKey, formatLabel, colorFor, fmtFn, nowMs, hoverKey, suppressed }) {
  if (!active || !payload?.length) return null
  const items = payload.map(p => {
    const ei = parseInt(p.dataKey.replace('ep', ''), 10)
    const full = eps[ei]?.[labelKey] || ''
    const short = formatLabel ? formatLabel(full, eps[ei]) : (full.length > 28 ? full.slice(0, 26) + '…' : full)
    return { key: p.dataKey, label: short, value: fmtFn(p.value), color: colorFor(ei) }
  })
  return (
    <ChartTooltip
      tMs={rowInstant(payload[0])}
      nowMs={nowMs ?? Date.now()}
      items={items}
      hoverKey={hoverKey}
      suppressed={suppressed}
      limit={TOOLTIP_ROWS}
      minWidth={180}
    />
  )
}

// Rows in the order the legend lists them, as indices into `eps`. 'valueDesc'
// lists the largest legend value first, the way production's Browser charts
// do; a row with no value goes last, and ties keep the data's own order. Only
// the ORDER changes: the colour and the `ep${i}` key stay on the row's index in
// `eps`, so a route keeps its colour from chart to chart however each sorts.
function legendOrder(eps, dataKey, legendSort) {
  const all = eps.map((_, i) => i)
  if (legendSort !== 'valueDesc') return all
  const val = i => {
    const v = Number(eps[i]?.[dataKey])
    return Number.isFinite(v) ? v : -Infinity
  }
  return all.sort((a, b) => (val(b) - val(a)) || (a - b))
}

// Rows in a given order of LABELS: the order the page's own drawing lists
// them in, handed to the chart's other drawings (a Compare's earlier window).
// Ranked by its own window, the earlier drawing would trade the rows at the
// edge of its series budget for others, and the two charts of a Compare would
// draw different routes under one title. A row the order does not name goes
// after the rows it does, in the window's own order.
function orderByLabels(eps, labels, labelKey, fallback) {
  const rank = new Map(labels.map((l, i) => [l, i]))
  const own = new Map(fallback.map((ei, i) => [ei, i]))
  const at = i => rank.get(eps[i]?.[labelKey]) ?? Infinity
  return fallback.slice().sort((a, b) => (at(a) - at(b)) || (own.get(a) - own.get(b)))
}

/**
 * One line per row of `eps` over the page's window, with a searchable legend
 * beside it: the service page's RED charts, and the Browser page's Page Views,
 * Ajax Calls and Web Vitals charts.
 *
 * Every chart keeps a series budget of its own: it draws the first rows its
 * width can make legible and its footer says how many it is holding back. Each
 * chart has its own search and legend, so each keeps its own budget — and the
 * search runs over EVERY row, so a held-back one is a few keystrokes away
 * without pressing Show all.
 *
 * `epSeries[i]` is row i's series, index-aligned with `eps`. Pass both in the
 * data's own order, never a sorted or filtered copy: the colour is keyed on
 * that index, which is what keeps a row the same colour in every chart.
 *
 * Every prop past the first eight is optional, and left out reproduces the
 * service page's RED chart exactly:
 *
 *   labelKey          the row field that names it ('endpoint')
 *   colorFor(i)       a row's colour by its index in `eps` (epColor)
 *   formatLabel(l, r) a short label for the legend and tooltip; the legend row
 *                     then carries the full one as its title
 *   legendSort        'data' (as given) or 'valueDesc' (largest legend value
 *                     first; it is also the order the budget draws in)
 *   selected/onSelect isolation by LABEL, owned by the caller — pass both to
 *                     isolate one row across several charts at once. Without
 *                     `selected` the chart keeps its own, as it always has.
 *   noun, searchPlaceholder   the legend's wording ('endpoints')
 *   info              a node after the title — an InfoTip
 *   overlays          Recharts elements behind the lines (thresholdBands)
 *   yTop              the least the y axis may top out at, so overlays stay in
 *                     view whatever the lines do (bandAxisTop)
 *   height            the plot's height in px (260)
 *   legendScroll      the legend scrolls beside the chart instead of growing
 *                     the row, for a long list of rows
 *   axisFormat(v, top)  the y axis's tick formatter, when a tick should read
 *                     differently from a legend value ('30' on the axis,
 *                     '30.00' in the legend). It gets the axis's top as well,
 *                     so a load-time axis can keep one unit from 0 to the top.
 *                     Left out, the axis prints with `fmtFn`, as it always has.
 *   forWindow(w)      the chart over another window, by the same derivation
 *                     that gave its props for `win`: { eps, epSeries } and
 *                     whatever else moves with the window (yTop, overlays).
 *                     It is what the chart's Compare draws ("1 day ago",
 *                     ChartModal). Left out, the chart can be expanded but
 *                     offers no Compare.
 *   compare           false to leave Compare out of the ⋮ even with a
 *                     forWindow: a chart that owns a comparison of its own
 *                     (the alert rule's, RuleChart).
 */
export default function LegendLineChart(props) {
  const { title, info, win, forWindow, compare = true } = props
  // What the reader has done to the legend — the row they isolated (by label,
  // when the caller does not own it) and what they typed in its search — is
  // the chart's, not one drawing's: Expand and Compare open on the legend as
  // the card shows it, and both drawings of a Compare isolate and filter
  // together. Hover and the series budget stay with each drawing.
  const [ownSelected, setOwnSelected] = useState(null)
  const [search, setSearch] = useState('')
  const legend = { ownSelected, setOwnSelected, search, setSearch }

  // The chart over any window: its own props for the page's window, the
  // caller's derivation laid over them for any other. Built with each render,
  // since every prop is part of what the chart draws; a window's rows are
  // worked out once per build, however often the modal asks for them. A window
  // the derivation has nothing for draws no rows, never the page's.
  const { eps, dataKey, legendSort = 'data', labelKey = 'endpoint' } = props
  const pageOrder = legendOrder(eps, dataKey, legendSort).map(i => eps[i]?.[labelKey])
  const other = new WeakMap()
  const at = w => {
    if (w === win) return props
    if (!other.has(w)) other.set(w, { ...props, eps: [], epSeries: [], ...(forWindow(w) ?? {}), rankLabels: pageOrder })
    return other.get(w)
  }
  const view = {
    win,
    comparable: compare !== false && typeof forWindow === 'function',
    render: w => <LegendLineBody {...at(w)} {...legend} win={w} />,
  }

  return (
    <div className="red-chart-section">
      <div className="red-chart-head">
        {info ? <span className="clbl-text">{title}{info}</span> : <span>{title}</span>}
        <ChartActions title={title} view={view} />
      </div>
      <LegendLineBody {...props} {...legend} />
    </div>
  )
}

/**
 * Everything under the chart's header: the plot, its legend and its series
 * budget. The chart draws it once over the page's window, and its Expand and
 * Compare draw it again in the modal, over whichever window they show.
 */
function LegendLineBody({
  eps, epSeries, dataKey, fmtFn, syncId, win, onFocus,
  labelKey = 'endpoint',
  colorFor = epColor,
  formatLabel,
  legendSort = 'data',
  selected,
  onSelect,
  noun = 'endpoints',
  searchPlaceholder = `Search ${noun}…`,
  overlays,
  yTop,
  height = 260,
  legendScroll = false,
  axisFormat,
  ownSelected,
  setOwnSelected,
  search,
  setSearch,
  rankLabels,
}) {
  // Isolation has two owners, and either way it is held by LABEL. Left to
  // itself the chart keeps its own (`ownSelected`, held by LegendLineChart so
  // its every drawing shares it), as the service page's RED charts always
  // have. Given `selected` — a label, or null for none — the caller owns it,
  // so the charts of one panel can isolate the same row together. A label,
  // not an index into `eps`: the index is meaningless across charts whose
  // legends sort differently, and across the windows of a Compare.
  const controlled = selected !== undefined
  const [hoverKey, setHoverKey] = useState(null)
  const [plotWidth, setPlotWidth] = useState(0)
  const dimOpacityFor = (key) => (hoverKey == null || hoverKey === key ? 1 : 0.22)
  const labelOf = i => eps[i]?.[labelKey]

  // The search finds a row by the label as stored or as the legend shows it:
  // an Ajax row reads 'GET payment.cubedemo.com/v1/payments' (formatLabel
  // drops the default port), and typing exactly that must find it. The test is
  // labelMatches, the same one the table search on a Browser tab runs
  // (metricLabels filterByLabel), so the chart and the table beside it answer
  // a query alike. Without a formatLabel it is the stored label alone, as the
  // service page's search has always been.
  const q = search.trim().toLowerCase()
  const shownIdxs = useMemo(() => {
    const own = legendOrder(eps, dataKey, legendSort)
    const all = rankLabels ? orderByLabels(eps, rankLabels, labelKey, own) : own
    return q ? all.filter(i => labelMatches(eps[i], q, formatLabel, labelKey)) : all
  }, [eps, dataKey, legendSort, labelKey, formatLabel, q, rankLabels])
  const budget = useSeriesBudget(shownIdxs.length, plotWidth)
  const drawnIdxs = shownIdxs.slice(0, budget.count)

  // Left to itself, a selection only counts while its row is drawn. "Show
  // fewer" or a new search can take it off the chart, and a stale one would dim
  // every legend row against a line that is not there.
  //
  // A shared selection is checked against `eps` instead, and outranks this
  // chart's search and budget: the row is drawn and pinned to the top of the
  // legend even when they would hide it. Otherwise one chart of the panel would
  // be isolated and the next not, over a search typed into one of them.
  let sel
  if (controlled) {
    const i = selected == null ? -1 : eps.findIndex(e => e?.[labelKey] === selected)
    sel = i === -1 ? null : i
  } else {
    const i = ownSelected == null ? -1 : eps.findIndex(e => e?.[labelKey] === ownSelected)
    sel = i !== -1 && drawnIdxs.includes(i) ? i : null
  }
  const pinned = sel != null && !drawnIdxs.includes(sel) ? sel : null
  const legendIdxs = pinned != null ? [pinned, ...drawnIdxs] : drawnIdxs
  const chartIdxs = sel != null ? [sel] : drawnIdxs

  const toggle = ei => {
    const next = sel === ei ? null : ei
    const label = next == null ? null : labelOf(next)
    if (!controlled) setOwnSelected(label)
    onSelect?.(label)
  }

  // A scrolling legend can hold the isolated row below its own fold: in the
  // chart it was clicked in the row is in view, but in the other charts of the
  // panel, whose legends sort by their own figure, it can be the twelfth of
  // fourteen — one line drawn and no highlighted row to say which. So the
  // legend scrolls itself, and only itself, until the pressed row shows. Not
  // scrollIntoView: that would scroll the page too, to a chart the reader is
  // not looking at.
  //
  // It runs when the isolated row changes, and again whenever the legend's
  // order does: a new time range re-sorts it, and a chart that has just
  // mounted (Graph again after Table) draws its first frame at width 0 under
  // the narrow series cap, with the row pinned on top, then widens and drops
  // the row to its sorted place below the fold. Not while the reader is in
  // this legend's search box: the box sits at the top of the same scroll, and
  // scrolling down to the row would carry it out of view under their typing —
  // a row the search hides is pinned to the top anyway. And never on a plain
  // re-render (a hover is one), or a reader who scrolled the legend away would
  // be pulled back each time.
  const legendRef = useRef(null)
  const legendKey = legendIdxs.join(',')
  useLayoutEffect(() => {
    const box = legendRef.current
    if (!legendScroll || sel == null || !box) return
    const typing = document.activeElement
    if (typing && typing.tagName === 'INPUT' && box.contains(typing)) return
    const row = box.querySelector('.drill2-item[aria-pressed="true"]')
    if (!row) return
    // Where the row sits in the legend's scrolled content, from the two boxes
    // on screen.
    const top = row.getBoundingClientRect().top - box.getBoundingClientRect().top - box.clientTop + box.scrollTop
    const next = scrollTopToReveal({ top, bottom: top + row.offsetHeight, scrollTop: box.scrollTop, height: box.clientHeight })
    if (next != null) box.scrollTop = next
  }, [sel, legendScroll, eps, legendKey])

  const data = useMemo(() => {
    const base = epSeries[0]?.series ?? []
    return withX(base.map((pt, i) => {
      const entry = { t: pt.t, label: pt.label, exactTime: pt.exactTime }
      epSeries.forEach((ep, ei) => { entry[`ep${ei}`] = ep.series[i]?.value })
      return entry
    }), win)
  }, [epSeries, win])

  // An isolated row gets the axis fitted to it, as it always has. Otherwise,
  // while the budget is holding rows back, the axis spans every matching row
  // so Show all adds lines without rescaling the ones already drawn.
  //
  // A `yTop` keeps that choice of WHICH rows the axis spans, and only stops the
  // top from falling below it — so a chart drawn over threshold bands keeps
  // its thresholds in view when it is isolated or budget-fixed too, and every
  // fixed axis still lands on round ticks its formatter prints.
  const isolated = sel != null
  const drawnCount = drawnIdxs.length
  const y = useMemo(() => {
    const fixed = !isolated && fixesAxis(budget.status)
    const decimals = formatDecimals(axisFormat ?? fmtFn)
    if (yTop == null) {
      return fixed ? niceAxis(maxOf(data, shownIdxs.map(i => `ep${i}`)), 4, { decimals }) : null
    }
    const spanned = fixed ? shownIdxs : isolated ? [sel] : shownIdxs.slice(0, drawnCount)
    return niceAxis(Math.max(maxOf(data, spanned.map(i => `ep${i}`)) ?? 0, yTop), 4, { decimals })
  }, [isolated, sel, budget.status, data, shownIdxs, drawnCount, fmtFn, axisFormat, yTop])

  // The axis's top, for a tick formatter that picks its unit from it. Left to
  // Recharts the domain is its own; the data's maximum stands in for it.
  const axisTop = y?.top ?? maxOf(data, chartIdxs.map(i => `ep${i}`))
  const tickFmt = useMemo(
    () => (axisFormat ? v => axisFormat(v, axisTop ?? v) : fmtFn),
    [axisFormat, axisTop, fmtFn],
  )

  return (
    <>
      <div className="drill2">
        <div className="drill2-chart">
          <TimeChart win={win} onFocus={onFocus} height={height} onWidth={setPlotWidth}>
            {(axis, focus) => (
              <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} syncId={syncId} syncMethod="value" {...focus.chartProps}>
                <CartesianGrid {...GRID_PROPS} />
                {overlays}
                <XAxis {...axis.props} />
                <YAxis {...valueAxisProps({ format: tickFmt, maxValue: axisTop, domain: y ? [0, y.top] : undefined })} ticks={y?.ticks} />
                <Tooltip content={p => <LegendTooltip {...p} eps={eps} labelKey={labelKey} formatLabel={formatLabel} colorFor={colorFor} fmtFn={fmtFn} nowMs={win.end * 1000} hoverKey={hoverKey} suppressed={!focus.hovered} />} {...NO_ANIM} />
                {chartIdxs.map(ei => (
                  <Line key={ei} {...LINE_PROPS} dataKey={`ep${ei}`} stroke={colorFor(ei)}
                    strokeOpacity={dimOpacityFor(`ep${ei}`)}
                    strokeWidth={1.5} dot={false} activeDot={{ r: 3, strokeWidth: 0 }}
                    onMouseEnter={() => setHoverKey(`ep${ei}`)}
                    onMouseLeave={() => setHoverKey(null)} />
                ))}
                {focus.overlay}
              </LineChart>
            )}
          </TimeChart>
        </div>
        <div ref={legendRef} className={`drill2-legend${legendScroll ? ' is-scroll' : ''}`}>
          <div className="drill2-search">
            <SearchGlyph />
            <input
              type="search"
              aria-label={`Search ${noun}`}
              placeholder={searchPlaceholder}
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
          {legendIdxs.map(ei => {
            const dimmed = sel != null && sel !== ei
            const full = labelOf(ei)
            // A button, so a row isolates from the keyboard as well as by
            // pointer; .drill2-item already resets the button chrome, and
            // legend-line-chart.css the little it leaves (see there).
            return (
              <button
                type="button"
                className={`drill2-item${dimmed ? ' dimmed' : ''}`}
                key={ei}
                aria-pressed={sel === ei}
                title={formatLabel ? full : undefined}
                onClick={() => toggle(ei)}
                onMouseEnter={() => setHoverKey(`ep${ei}`)}
                onMouseLeave={() => setHoverKey(null)}
              >
                <span className="drill2-row">
                  <span className="drill2-swatch" style={{ background: colorFor(ei) }} />
                  <span className="drill2-label">{formatLabel ? formatLabel(full, eps[ei]) : full}</span>
                  <span className="drill2-val">{fmtFn(eps[ei][dataKey])}</span>
                </span>
              </button>
            )
          })}
          {shownIdxs.length === 0 && (
            <div className="drill2-empty">
              {q ? `No ${noun} match "${search.trim()}"` : `No ${noun} in this time range`}
            </div>
          )}
        </div>
      </div>
      <SeriesBudgetFooter budget={budget} noun={noun} />
    </>
  )
}
