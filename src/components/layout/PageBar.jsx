import { useState, useRef, useEffect, useId } from 'react'
import {
  TIME_PRESETS, AUTO_REFRESH_OPTIONS, rangeLabel,
  validateCustomRange, autoFillTo, formatDateTimeInput,
} from '@/utils/timeRange'
import { seedCustomRange, normalizeAutoRefresh, panelPosition } from '@/utils/timePanel'
import './page-bar.css'

function SvgIcon({ name, className }) {
  const paths = {
    refresh: <><path d="M4 4v6h6M20 20v-6h-6"/><path d="M5 15a8 8 0 0013.9 3.2M19 9A8 8 0 005.1 5.8"/></>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    gear: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></>,
    chevronDown: <path d="M6 9l6 6 6-6"/>,
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      {paths[name]}
    </svg>
  )
}

/**
 * Page top-bar: breadcrumbs on the left, right-aligned controls
 * (refresh, time-range picker, optional settings gear).
 *
 * Kept as a wrapper — pages author their breadcrumb content as children,
 * which lets each page keep its own trail shape (including selects like
 * InfraView's host picker) without any restructuring here.
 *
 * `actions` is the same idea for the right-hand side: a page can put its own
 * controls ahead of the shared ones without this file learning what they are.
 *
 * `timeRange` is the app-wide range object, not a label — `{ kind: 'preset' }`
 * or `{ kind: 'absolute' }`. Only this component and the data layer care which;
 * a page hands it straight through.
 *
 * Refresh (all optional, ARCH D5 — a page that passes none of them gets exactly
 * the bar it got before these existed, down to the inert ↻):
 *   onRefresh            run the page's query again. Gives the ↻ button its job.
 *   refreshing           a run is in flight: ↻ spins, and an auto-refresh tick
 *                        that lands mid-run is skipped rather than stacked.
 *   autoRefresh          the chosen interval in seconds; 0 / absent is Off. The
 *                        page owns the value, this bar owns the timer — it is
 *                        the one calling `onRefresh` on the interval, so a page
 *                        must not run a second one of its own.
 *   onAutoRefreshChange  receives the new interval. Passing it is what makes the
 *                        auto-refresh control appear at all.
 */
export default function PageBar({
  children,
  actions,
  timeRange,
  setTimeRange,
  showSettings = false,
  settingsOpen,
  setSettingsOpen,
  onRefresh,
  refreshing = false,
  autoRefresh,
  onAutoRefreshChange,
}) {
  const [timeOpen, setTimeOpen] = useState(false)
  const timeBtnRef = useRef(null)
  const timeTriggerRef = useRef(null)
  const autoId = useId()

  // The interval must not restart on every render — pages pass inline arrows,
  // and an interval rebuilt that often would never reach its first tick. The
  // tick reads both through refs, so only the period is a dependency.
  const liveRef = useRef({ onRefresh, refreshing })
  useEffect(() => { liveRef.current = { onRefresh, refreshing } })

  const autoSec = normalizeAutoRefresh(autoRefresh)
  const canRefresh = Boolean(onRefresh)

  useEffect(() => {
    if (!autoSec || !canRefresh) return undefined
    const id = setInterval(() => {
      // A tick that lands while the last run is still out is dropped, not
      // queued: a 5 s interval over a slower query would otherwise pile up.
      if (liveRef.current.refreshing) return
      liveRef.current.onRefresh?.()
    }, autoSec * 1000)
    return () => clearInterval(id)
  }, [autoSec, canRefresh])

  useEffect(() => {
    if (!timeOpen) return
    const handler = (e) => {
      if (!e.target.closest('.time-portal') && !e.target.closest('.time-btn')) {
        setTimeOpen(false)
      }
    }
    document.addEventListener('click', handler)
    return () => document.removeEventListener('click', handler)
  }, [timeOpen])

  // Esc closes the panel and hands focus back to the button that opened it —
  // without it a keyboard user who changes their mind is stranded inside it.
  useEffect(() => {
    if (!timeOpen) return undefined
    const onKey = (e) => {
      if (e.key !== 'Escape') return
      setTimeOpen(false)
      timeTriggerRef.current?.focus()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [timeOpen])

  return (
    <div className="card-crumbs">
      <div className="card-crumbs-left">{children}</div>
      <div className="card-crumbs-right">
        {actions}
        {onAutoRefreshChange && (
          <label className={`hbtn ex-auto${autoSec ? ' active' : ''}`} htmlFor={autoId}>
            <span className="ex-auto-text">Auto</span>
            <select
              id={autoId}
              className="ex-auto-select"
              value={autoSec}
              aria-label="Auto-refresh interval"
              onChange={e => onAutoRefreshChange(Number(e.target.value))}
            >
              {AUTO_REFRESH_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            <SvgIcon name="chevronDown" />
          </label>
        )}
        <button
          className="hbtn icon"
          title={refreshing ? 'Refreshing…' : 'Refresh now'}
          aria-label="Refresh"
          aria-busy={refreshing || undefined}
          onClick={onRefresh}
        >
          <SvgIcon name="refresh" className={refreshing ? 'ex-spin' : undefined} />
        </button>
        <div style={{ position: 'relative' }} ref={timeBtnRef}>
          <button
            ref={timeTriggerRef}
            className={`hbtn time-btn${timeOpen ? ' active' : ''}`}
            title={`Time range: ${rangeLabel(timeRange)}`}
            aria-label="Change time range"
            aria-haspopup="dialog"
            aria-expanded={timeOpen}
            onClick={(e) => { e.stopPropagation(); setTimeOpen(o => !o) }}
          >
            <SvgIcon name="clock" /> {rangeLabel(timeRange)} <SvgIcon name="chevronDown" />
          </button>
          {timeOpen && (
            <TimePanel
              timeRange={timeRange}
              setTimeRange={(v) => {
                setTimeRange(v)
                setTimeOpen(false)
                // Choosing a range unmounts the panel under the cursor — and
                // under the keyboard. Focus goes back to the button that opened
                // it rather than falling to the top of the document.
                timeTriggerRef.current?.focus()
              }}
              anchorRef={timeBtnRef}
            />
          )}
        </div>
        {showSettings && (
          <button
            className={`hbtn icon${settingsOpen ? ' active' : ''}`}
            title="Settings"
            aria-label="Open settings"
            onClick={() => setSettingsOpen(o => !o)}
          >
            <SvgIcon name="gear" />
          </button>
        )}
      </div>
    </div>
  )
}

const ClockIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" width="13" height="13">
    <circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>
  </svg>
)

function TimePanel({ timeRange, setTimeRange, anchorRef }) {
  // The custom fields open on the range that is already showing, whatever form
  // it took — so narrowing "Last 6 hours" by an hour is an edit rather than a
  // date lookup, and a range arrived at by dragging on a chart can be nudged.
  const [seed] = useState(() => seedCustomRange(timeRange))
  const [from, setFrom] = useState(seed.from)
  const [to, setTo] = useState(seed.to)
  const reasonId = useId()

  const { from: fromMs, to: toMs, canApply, reason } = validateCustomRange(from, to)

  const apply = () => {
    if (!canApply) return
    setTimeRange({ kind: 'absolute', from: fromMs, to: toMs })
  }

  // Filling in From with To still empty proposes a day-long window rather than
  // leaving Apply disabled on a half-finished answer.
  const onFromBlur = () => {
    if (to.trim()) return
    const parsed = validateCustomRange(from, '').from
    if (parsed != null) setTo(formatDateTimeInput(autoFillTo(parsed)))
  }

  const at = panelPosition(anchorRef.current?.getBoundingClientRect(), window.innerWidth)
  if (!at) return null
  const style = { position: 'fixed', ...at, zIndex: 500 }

  const activePreset = timeRange?.kind === 'absolute' ? null : (timeRange?.value ?? '1h')

  return (
    <div
      className="dd-panel time-portal"
      style={style}
      role="dialog"
      aria-label="Select time range"
      onClick={e => e.stopPropagation()}
    >
      <div className="time-panel">
        <div className="time-panel-custom">
          <div className="time-panel-title">Select time range</div>
          <div className="time-field">
            <label htmlFor="time-from">From</label>
            <div className="time-field-input">
              <ClockIcon />
              <input
                id="time-from"
                type="text"
                placeholder="YYYY-MM-DD HH:mm:ss"
                aria-describedby={reasonId}
                value={from}
                onChange={e => setFrom(e.target.value)}
                onBlur={onFromBlur}
                onKeyDown={e => e.key === 'Enter' && apply()}
              />
            </div>
          </div>
          <div className="time-field">
            <label htmlFor="time-to">To</label>
            <div className="time-field-input">
              <ClockIcon />
              <input
                id="time-to"
                type="text"
                placeholder="YYYY-MM-DD HH:mm:ss"
                aria-describedby={reasonId}
                value={to}
                onChange={e => setTo(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && apply()}
              />
            </div>
          </div>
          {/* The reason a disabled Apply is disabled, said out loud. A button
              that simply greys out leaves the reader checking both fields for
              a typo they cannot see. Both inputs point at it, so a screen
              reader hears the same sentence the sighted reader does. */}
          <div
            id={reasonId}
            role="status"
            style={{
              minHeight: 15, fontSize: 10.5, lineHeight: '15px',
              color: reason ? 'var(--status-critical, #EF4444)' : 'var(--text-muted)',
            }}
          >
            {reason || 'Local time'}
          </div>
          <button
            className="time-apply"
            onClick={apply}
            disabled={!canApply}
            title={canApply ? 'Apply this range' : reason}
            style={canApply ? undefined : { opacity: 0.42, cursor: 'not-allowed' }}
          >
            Apply
          </button>
        </div>
        {/* Real buttons: the presets are the fast path through this panel, and
            a <div> with an onClick would hand the keyboard nothing to press.
            `active` stays off while a custom range is set, so the highlight
            never claims a preset the charts are not drawing. */}
        <div className="time-panel-presets">
          {TIME_PRESETS.map(p => (
            <button
              key={p.value}
              type="button"
              className={`time-preset${p.value === activePreset ? ' active' : ''}`}
              aria-pressed={p.value === activePreset}
              onClick={() => setTimeRange({ kind: 'preset', value: p.value })}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
