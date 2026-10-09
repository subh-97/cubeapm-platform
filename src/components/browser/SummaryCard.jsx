import MiniChart from '@/components/charts/MiniChart'
import CardMenu from '@/components/CardMenu'
import InfoTip from '@/components/shared/InfoTip'
import { splitFigure, figureDelta } from './metricLabels'
import '@/components/errors/errors.css'
import './browser-metrics.css'

/**
 * One headline figure of a Browser metric tab, with the window's history of it
 * underneath: the three cards across the top of Page Views, Ajax Calls and Web
 * Vitals.
 *
 * It is the service page's trend card (TrendChart's .chart-card, .clbl and
 * chart-host) with the figure itself added above the chart, because a card here
 * answers "how is the app doing" before it answers "since when". The figure
 * carries the Errors tab's comparison chip (rule 6: "1.18 s" alone does not say
 * whether that is the incident or a normal hour), info-coloured whichever way
 * it moved, since a faster page and a busier one are both just news.
 *
 *   title, info        the card's name and its ⓘ explanation (a string)
 *   value, prev        the window's figure and the window before's, raw
 *   fmt(v)             prints a figure with its unit ('1.18 s'); the unit is
 *                      split off for the headline and the chip's tooltip names
 *                      the earlier figure through it
 *   prevText           what "the window before" was ('the previous hour')
 *   series             the app-wide aggregate, bucket by bucket (windowSeries)
 *   formatVal          the chart tooltip's formatter (defaults to `fmt`)
 *   axisFormat         the chart's y-axis ticks (MiniChart's default when left
 *                      out); a card of milliseconds passes fmtLoadTimeTick, so
 *                      its axis reads in one unit like the full-size charts
 *                      below it ('0 s, 0.5 s, 1 s', never '1.4k')
 *   rating             { status, label, title } — a web vital's rating chip, or
 *                      nothing; the only severity a card carries, and only
 *                      where the figure has a standard to be rated against
 *   overlays, yTop     drawn behind the chart and the axis floor that keeps
 *                      them in view (thresholdBands / bandAxisTop)
 *   syncId, win, onFocus   as every chart on the tab
 *
 * Single-series, so the area is the brand colour, as the service page's other
 * single-series charts are: a series colour says which thing a line is, and
 * there is only one thing here.
 */
export default function SummaryCard({
  title, info, value, prev, fmt, prevText, series, formatVal, axisFormat, rating, overlays, yTop, syncId, win, onFocus,
}) {
  const figure = splitFigure(fmt(value))
  const delta = value == null ? null : figureDelta(value, prev, prevText, fmt)
  return (
    <div className="chart-card brw-sum-card">
      <div className="clbl">
        <span className="clbl-text">
          <span className="brw-sum-title" title={title}>{title}</span>
          {info && <InfoTip label={`About ${title}`}>{info}</InfoTip>}
        </span>
        <CardMenu kind="chart" title={title} />
      </div>
      {/* The rating sits on the figure's line, at its right end, rather than in
          the head beside the ⋮: it is a verdict on the figure, and in the head
          'Needs improvement' left 'Largest Contentful Paint (LCP)' too little
          room to show its own abbreviation on a 1280px screen. */}
      <div className="brw-sum-figure">
        <div className="cval">
          {figure.value || '—'}
          {figure.unit && <span className="u">{figure.unit}</span>}
        </div>
        {delta && <span className="errp-delta" data-dir={delta.dir} title={delta.title}>{delta.label}</span>}
        {rating && <span className={`kpi-chip ${rating.status}`} title={rating.title}>{rating.label}</span>}
      </div>
      <MiniChart
        className="chart-host"
        height={null}
        series={series}
        color="var(--brand)"
        formatVal={formatVal ?? fmt}
        axisFormat={axisFormat}
        overlays={overlays}
        yTop={yTop}
        syncId={syncId}
        win={win}
        onFocus={onFocus}
      />
    </div>
  )
}
