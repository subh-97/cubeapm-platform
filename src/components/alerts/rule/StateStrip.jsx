import { clockText } from './rulePage'
import { formatElapsed } from '@/utils/alerts/describe'

/**
 * The rule's state under its chart, on the chart's own time axis (D5): OK,
 * pending and firing as blocks — Home's health strip, read the same way, with
 * the severity colour on the blocks because they ARE states (DESIGN rule 2).
 * Notifications sent show as ticks above the strip.
 *
 * `segments` are rulePage's stripSegments; `inset` is the plot's left gutter
 * and right margin in px, so a block sits under the minutes it describes.
 * Colour is never alone: every block names its state and its span in a title,
 * and the strip as a whole reads as one sentence to a screen reader.
 */
export default function StateStrip({ segments, notifications = [], win, nowSec, inset = { left: 0, right: 0 }, label }) {
  const span = Math.max(1, win.end - win.start)
  const when = s => {
    const to = s.to >= nowSec ? 'now' : clockText(s.to, nowSec)
    return `${clockText(s.from, nowSec)}–${to}`
  }
  const said = segments
    .filter(s => s.key !== 'future')
    .map(s => `${s.label} ${when(s)}`)
    .join(', ')
  const present = [...new Map(segments.filter(s => s.key !== 'future').map(s => [s.key, s])).values()]
  const ticks = notifications.filter(t => t >= win.start && t <= win.end)

  return (
    <div className="alr-strip" style={{ paddingLeft: inset.left, paddingRight: inset.right }}>
      <div className="alr-strip-track" role="img" aria-label={`${label ?? 'State'}: ${said || 'no data'}`}>
        {ticks.map(t => (
          <span
            key={`tick-${t}`}
            className="alr-strip-tick"
            style={{ left: `${((t - win.start) / span) * 100}%` }}
            title={`Notified ${clockText(t, nowSec)}`}
          />
        ))}
        {segments.map(s => (
          <span
            key={`${s.key}-${s.from}`}
            className={`alr-strip-seg tone-${s.tone}${s.key === 'future' ? ' is-future' : ''}${s.key === 'pending' ? ' is-pending' : ''}`}
            style={{ left: `${s.leftPct}%`, width: `${s.widthPct}%` }}
            title={s.key === 'future' ? 'Not yet' : `${s.label} ${when(s)} (${formatElapsed(Math.min(s.to, nowSec) - s.from)})`}
          />
        ))}
      </div>
      <div className="alr-strip-legend" aria-hidden="true">
        {present.map(s => (
          <span key={s.key} className="alr-strip-key">
            <span className={`alr-strip-swatch tone-${s.tone}${s.key === 'pending' ? ' is-pending' : ''}`} />
            {s.label}
          </span>
        ))}
        {ticks.length > 0 && (
          <span className="alr-strip-key">
            <span className="alr-strip-swatch is-tick" />
            Notified
          </span>
        )}
      </div>
    </div>
  )
}
