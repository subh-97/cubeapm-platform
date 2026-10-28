import { useCallback, useId, useMemo, useRef, useState } from 'react'
import { ChevronUp } from 'lucide-react'
import { statusColor, statusForAlertState, STATUS } from '@/utils/status'
import { buildTimeAxis, formatTick } from '@/components/charts/timeAxis'
import { useTimeFocus, useMeasuredWidth } from '@/components/charts/useTimeFocus'
import { budgetView } from '@/components/charts/seriesBudget'
import SeriesBudgetFooter from '@/components/charts/SeriesBudgetFooter'
import ChartTooltip from '@/components/charts/ChartTooltip'
import { rulePath, formatValue, formatElapsed } from './adapters'
import {
  LANE_CAP, buildLanes, xPct, secAt, barLabel, barTitle, peakIn, clockAt, suppressedTitle, focusRangeFor,
  timelineSummary,
} from './timelineLanes'
import { isPlainClick } from './rulesList'

const LANE_H = 22
const BAR_H = 12
// How far the pointer travels before a press on a bar is a drag, not a click.
const DRAG_PX = 3

/**
 * The alert timeline (D4): one lane per rule that fired or pended over the
 * range, which replaces production's stacked count of firing alerts. A bar is
 * a stretch in one state, in that state's colour; the colour is legitimate
 * here because a bar IS a severity, the reasoning behind Home's health strip.
 *
 *   firing      solid, in the severity's colour (statusColor)
 *   pending     hatched, in the info colour
 *   suppressed  a neutral wash over the lane while a snooze or mute held it
 *   notified    a tick under the bar for each notification sent
 *
 * Drawn as plain SVG with x in percent of the window, so it lays out without
 * measuring and every bar's title is in the markup. Drag across it to make
 * that span the page's range, through the same `useTimeFocus` every chart
 * uses; a click on a bar opens its rule focused on that stretch.
 *
 * The head sums the range up ("Last 1 hr · 5 critical · 8 warning"), and the
 * whole head is the button that folds the panel to itself and back, its
 * chevron up while open and down while folded, as the filter sections'. It
 * arrives folded (`defaultOpen` false) and is not remembered.
 */
export default function AlertTimeline({ timeline, byId, seriesFor, win, onOpenRule, setTimeRange, defaultOpen = false }) {
  const lanes = useMemo(() => buildLanes(timeline, byId, win, seriesFor), [timeline, byId, win, seriesFor])
  const uid = useId().replace(/[^A-Za-z0-9_-]/g, '')
  const hatchId = `rtab-hatch-${uid}`
  const bodyId = `rtab-tl-body-${uid}`
  const [open, setOpen] = useState(defaultOpen)

  // Five lanes, then "Show N more" five at a time, and "Show less" back to
  // five. A lane is a DOM row, not an SVG path, so nothing needs drawing in
  // chunks: what is asked for is what is drawn.
  const [want, setWant] = useState(0)
  const view = budgetView({ total: lanes.length, cap: LANE_CAP, want, drawn: want })
  const shown = lanes.slice(0, view.count)
  const budget = {
    ...view,
    total: lanes.length,
    cap: LANE_CAP,
    step: LANE_CAP,
    showMore: () => setWant(w => Math.max(LANE_CAP, w) + LANE_CAP),
    showAll: () => setWant(Infinity),
    showFewer: () => setWant(0),
  }

  const [plotRef, plotWidth] = useMeasuredWidth()
  const axis = useMemo(() => buildTimeAxis(win, { width: plotWidth, kind: 'time' }), [win, plotWidth])

  const onFocus = useCallback(next => setTimeRange?.(next), [setTimeRange])
  const focus = useTimeFocus(win, { onFocus, kind: 'time', enabled: !!setTimeRange })

  // useTimeFocus speaks Recharts: it wants the instant under the pointer as
  // `activeLabel` (ms on a time axis) and the pointer's x as `chartX`. This
  // plot is plain SVG, so they are worked out from the pointer here.
  const stateAt = (e) => {
    const r = plotRef.current?.getBoundingClientRect()
    if (!r || !r.width) return null
    const x = e.clientX - r.left
    return { activeLabel: secAt(x / r.width, win) * 1000, chartX: x }
  }
  const press = useRef(null)
  const onMouseDown = (e) => {
    press.current = { x: e.clientX, moved: false }
    // No native drag of the bar links, and no text selected across the labels.
    if (e.button === 0) e.preventDefault()
    focus.chartProps.onMouseDown?.(stateAt(e), e)
  }
  const onMouseMove = (e) => {
    if (press.current && Math.abs(e.clientX - press.current.x) > DRAG_PX) press.current.moved = true
    focus.chartProps.onMouseMove?.(stateAt(e))
  }

  // The drag's band, read off the overlay the hook builds for Recharts: its
  // x1 and x2 are the dragged buckets' starts in ms (a time-kind axis), and the
  // later bucket counts whole, as the hook commits it.
  const sel = focus.overlay?.props
  const selBand = sel && Number.isFinite(sel.x1) && Number.isFinite(sel.x2)
    ? (() => {
      const lo = Math.min(sel.x1, sel.x2) / 1000
      const hi = Math.min(win.end, Math.max(sel.x1, sel.x2) / 1000 + win.step)
      return { x: xPct(lo, win), w: Math.max(0.2, xPct(hi, win) - xPct(lo, win)) }
    })()
    : null

  const [tip, setTip] = useState(null)
  const showTip = (lane, bar, laneIndex) => setTip({ lane, bar, laneIndex })
  const hideTip = () => setTip(null)

  const openBar = (e, lane, bar) => {
    if (press.current?.moved) { e.preventDefault(); return }
    if (!isPlainClick(e)) return
    e.preventDefault()
    onOpenRule?.(lane.ruleId, { ...(focusRangeFor(bar, win) ?? {}), alertId: lane.alertId })
  }
  const openLane = (e, lane) => {
    if (!isPlainClick(e)) return
    e.preventDefault()
    onOpenRule?.(lane.ruleId)
  }

  const height = shown.length * LANE_H
  const nowX = win.nowSec >= win.start && win.nowSec < win.end - win.step / 2 ? xPct(win.nowSec, win) : null
  const pendingColor = statusColor(statusForAlertState('pending'))
  const heldColor = statusColor(STATUS.neutral)

  return (
    <div className={`panel rtab-tl${open ? '' : ' is-collapsed'}`}>
      <button
        type="button"
        className={`panel-head rtab-tl-head${open ? ' is-divided' : ''}`}
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen(o => !o)}
      >
        <span>Recent Timeline</span>
        <span className="panel-head-right">
          <span className="hint" title={setTimeRange ? 'Drag across the timeline to zoom' : undefined}>
            {timelineSummary(lanes, win)}
          </span>
          <ChevronUp className="rtab-tl-chevron" aria-hidden="true" />
        </span>
      </button>
      <div id={bodyId} className="rtab-tl-body" hidden={!open}>
        {lanes.length === 0 ? (
          <div className="rtab-tl-empty">Nothing fired or pended in {win.isAbsolute ? 'this range' : win.label.toLowerCase().replace(/^last /, 'the last ')}.</div>
        ) : (
          <>
            <div className="rtab-tl-grid">
              <div className="rtab-tl-labels">
                {shown.map(lane => (
                  <div key={lane.key} className="rtab-tl-label">
                    <a className="rtab-tl-name" href={rulePath(lane.ruleId)} onClick={e => openLane(e, lane)} title={lane.name}>{lane.name}</a>
                    {lane.sub && <span className="rtab-tl-sub" title={lane.sub}>{lane.sub}</span>}
                  </div>
                ))}
              </div>
              <div
                ref={plotRef}
                className="rtab-tl-plot"
                style={setTimeRange ? focus.chartProps.style : undefined}
                onMouseDown={setTimeRange ? onMouseDown : undefined}
                onMouseMove={setTimeRange ? onMouseMove : undefined}
              >
                <svg className="rtab-tl-svg" height={height} role="group" aria-label={`Alert timeline, ${win.label}`}>
                  <defs>
                    <pattern id={hatchId} patternUnits="userSpaceOnUse" width="5" height="5" patternTransform="rotate(45)">
                      <rect width="5" height="5" fill={pendingColor} fillOpacity="0.14" />
                      <rect width="2" height="5" fill={pendingColor} fillOpacity="0.85" />
                    </pattern>
                  </defs>
                  {shown.map((lane, li) => (
                    <rect key={`bg-${lane.key}`} className="rtab-tl-lane-bg" x="0" y={li * LANE_H + 2} width="100%" height={LANE_H - 4} rx="2" />
                  ))}
                  {axis.ticks.map(ms => {
                    const x = `${xPct(ms / 1000, win)}%`
                    return <line key={ms} className="rtab-tl-grid-line" x1={x} x2={x} y1="0" y2={height} />
                  })}
                  {shown.map((lane, li) => {
                    const barY = li * LANE_H + (LANE_H - BAR_H) / 2
                    return (
                      <g key={lane.key}>
                        {lane.bars.map(bar => {
                          const x = xPct(bar.start, win)
                          const w = Math.max(0.35, xPct(bar.end, win) - x)
                          const title = barTitle(bar, lane, win)
                          const href = `${rulePath(lane.ruleId)}${lane.alertId ? `?alert_id=${encodeURIComponent(lane.alertId)}` : ''}`
                          const firing = bar.state === 'firing'
                          return (
                            <a
                              key={`${bar.state}-${bar.start}`}
                              href={href}
                              className="rtab-tl-bar"
                              aria-label={`${lane.name}${lane.sub ? ` (${lane.sub})` : ''}: ${title}`}
                              onClick={e => openBar(e, lane, bar)}
                              onMouseEnter={() => showTip(lane, bar, li)}
                              onMouseLeave={hideTip}
                              onFocus={() => showTip(lane, bar, li)}
                              onBlur={hideTip}
                            >
                              <title>{title}</title>
                              <rect
                                className="rtab-tl-fill"
                                x={`${x}%`} y={barY} width={`${w}%`} height={BAR_H} rx="2"
                                fill={firing ? statusColor(statusForAlertState('firing', bar.severity)) : `url(#${hatchId})`}
                                stroke={firing ? 'none' : pendingColor}
                                strokeOpacity={firing ? undefined : 0.7}
                                strokeWidth={firing ? undefined : 1}
                              />
                            </a>
                          )
                        })}
                        {lane.suppressed.map(s => {
                          const x = xPct(s.start, win)
                          const w = Math.max(0.35, xPct(s.end, win) - x)
                          return (
                            <g key={`held-${s.start}`}>
                              {/* The wash lets the bar under it keep its pointer:
                                  the strip above the bar is what reads out. */}
                              <rect x={`${x}%`} y={barY} width={`${w}%`} height={BAR_H} fill={heldColor} fillOpacity="0.5" pointerEvents="none" />
                              <rect x={`${x}%`} y={barY - 3} width={`${w}%`} height="2" fill={heldColor}>
                                <title>{suppressedTitle(s, win)}</title>
                              </rect>
                            </g>
                          )
                        })}
                        {lane.notifications.map(t => {
                          const x = `${xPct(t, win)}%`
                          return (
                            <line key={`n-${t}`} className="rtab-tl-tick-mark" x1={x} x2={x} y1={barY + BAR_H + 1} y2={barY + BAR_H + 4}>
                              <title>{`Notification sent ${clockAt(t, win)}`}</title>
                            </line>
                          )
                        })}
                      </g>
                    )
                  })}
                  {nowX != null && <line className="rtab-tl-now" x1={`${nowX}%`} x2={`${nowX}%`} y1="0" y2={height}><title>Now</title></line>}
                  {selBand && <rect className="rtab-tl-select" x={`${selBand.x}%`} y="0" width={`${selBand.w}%`} height={height} />}
                </svg>
                {tip && !focus.dragging && <BarTip tip={tip} win={win} />}
              </div>
            </div>
            <div className="rtab-tl-grid">
              <span />
              <div className="rtab-tl-axis" aria-hidden="true">
                {axis.ticks.map((ms, i) => (
                  <span key={ms} className={`rtab-tl-axis-tick${i === 0 && xPct(ms / 1000, win) < 3 ? ' is-first' : ''}`} style={{ left: `${xPct(ms / 1000, win)}%` }}>
                    {formatTick(ms, axis.labelKind)}
                  </span>
                ))}
              </div>
            </div>
            <Legend hatchId={hatchId} heldColor={heldColor} />
            <SeriesBudgetFooter budget={budget} noun="lanes" collapsible />
          </>
        )}
      </div>
    </div>
  )
}

/**
 * A bar on hover or focus: the platform's chart tooltip, headed by when the
 * stretch began, then its state and how long, when it ended, and its peak.
 */
function BarTip({ tip, win }) {
  const { lane, bar, laneIndex } = tip
  const peak = lane.rule ? peakIn(lane.points, bar.start, bar.end) : null
  const items = [
    {
      key: 'state',
      label: `${barLabel(bar)} for`,
      value: formatElapsed(bar.end - bar.start),
      color: bar.state === 'firing' ? statusColor(statusForAlertState('firing', bar.severity)) : statusColor(statusForAlertState('pending')),
    },
    { key: 'end', label: 'Until', value: bar.ongoing ? 'now, still going' : clockAt(bar.end, win), color: 'transparent' },
    ...(peak != null ? [{ key: 'peak', label: 'Peak', value: formatValue(lane.rule, peak), color: 'transparent' }] : []),
  ]
  const x = (xPct(bar.start, win) + xPct(bar.end, win)) / 2
  return (
    <div className="rtab-tl-tip" style={{ left: `${Math.max(12, Math.min(88, x))}%`, top: laneIndex * LANE_H }}>
      <ChartTooltip
        tMs={bar.start * 1000}
        nowMs={win.end * 1000}
        items={items}
        minWidth={200}
        footer={{ label: lane.name, value: lane.sub || '' }}
      />
    </div>
  )
}

/** What the marks mean, for anyone who cannot tell the colours apart. */
function Legend({ hatchId, heldColor }) {
  return (
    <div className="rtab-tl-legend" aria-hidden="true">
      <span className="rtab-tl-legend-item">
        <svg viewBox="0 0 14 8"><rect width="14" height="8" rx="1.5" fill={statusColor(statusForAlertState('firing', 'critical'))} /></svg>Critical
      </span>
      <span className="rtab-tl-legend-item">
        <svg viewBox="0 0 14 8"><rect width="14" height="8" rx="1.5" fill={statusColor(statusForAlertState('firing', 'warning'))} /></svg>Warning
      </span>
      <span className="rtab-tl-legend-item">
        <svg viewBox="0 0 14 8"><rect width="14" height="8" rx="1.5" fill={`url(#${hatchId})`} /></svg>Pending
      </span>
      <span className="rtab-tl-legend-item">
        <svg viewBox="0 0 14 8"><rect width="14" height="8" rx="1.5" fill={heldColor} fillOpacity="0.5" /></svg>Snoozed or muted
      </span>
      <span className="rtab-tl-legend-item">
        <svg viewBox="0 0 14 8"><line x1="7" x2="7" y1="1" y2="7" stroke="currentColor" strokeWidth="1.5" /></svg>Notification sent
      </span>
    </div>
  )
}
