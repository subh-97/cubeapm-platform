import { useState, useRef, useEffect } from 'react'
import {
  TIME_PRESETS, rangeLabel, resolveRange, formatDateTimeInput,
  validateCustomRange, autoFillTo,
} from '@/utils/timeRange'

function SvgIcon({ name }) {
  const paths = {
    refresh: <><path d="M4 4v6h6M20 20v-6h-6"/><path d="M5 15a8 8 0 0013.9 3.2M19 9A8 8 0 005.1 5.8"/></>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    gear: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></>,
    chevronDown: <path d="M6 9l6 6 6-6"/>,
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
 */
export default function PageBar({
  children,
  actions,
  timeRange,
  setTimeRange,
  showSettings = false,
  settingsOpen,
  setSettingsOpen,
}) {
  const [timeOpen, setTimeOpen] = useState(false)
  const timeBtnRef = useRef(null)

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

  return (
    <div className="card-crumbs">
      <div className="card-crumbs-left">{children}</div>
      <div className="card-crumbs-right">
        {actions}
        <button className="hbtn icon" title="Refresh now" aria-label="Refresh"><SvgIcon name="refresh" /></button>
        <div style={{ position: 'relative' }} ref={timeBtnRef}>
          <button
            className={`hbtn time-btn${timeOpen ? ' active' : ''}`}
            title={`Time range: ${rangeLabel(timeRange)}`}
            aria-label="Change time range"
            onClick={(e) => { e.stopPropagation(); setTimeOpen(o => !o) }}
          >
            <SvgIcon name="clock" /> {rangeLabel(timeRange)} <SvgIcon name="chevronDown" />
          </button>
          {timeOpen && (
            <TimePanel
              timeRange={timeRange}
              setTimeRange={(v) => { setTimeRange(v); setTimeOpen(false) }}
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
  const [from, setFrom] = useState(() => {
    if (timeRange?.kind === 'absolute') return formatDateTimeInput(timeRange.from)
    return formatDateTimeInput(resolveRange(timeRange).start * 1000)
  })
  const [to, setTo] = useState(() => {
    if (timeRange?.kind === 'absolute') return formatDateTimeInput(timeRange.to)
    return formatDateTimeInput(resolveRange(timeRange).end * 1000)
  })

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

  const r = anchorRef.current?.getBoundingClientRect()
  if (!r) return null
  const panelW = 460
  const left = Math.min(r.right - panelW, window.innerWidth - panelW - 8)
  const style = {
    position: 'fixed',
    top: r.bottom + 4,
    left: Math.max(8, left),
    zIndex: 500,
  }

  const activePreset = timeRange?.kind === 'absolute' ? null : (timeRange?.value ?? '1h')

  return (
    <div className="dd-panel time-portal" style={style} onClick={e => e.stopPropagation()}>
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
                value={to}
                onChange={e => setTo(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && apply()}
              />
            </div>
          </div>
          {/* The reason a disabled Apply is disabled, said out loud. A button
              that simply greys out leaves the reader checking both fields for
              a typo they cannot see. */}
          <div
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
        <div className="time-panel-presets">
          {TIME_PRESETS.map(p => (
            <div
              key={p.value}
              className={`time-preset${p.value === activePreset ? ' active' : ''}`}
              onClick={() => setTimeRange({ kind: 'preset', value: p.value })}
            >
              {p.label}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
