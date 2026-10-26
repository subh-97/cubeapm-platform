import { WEEKDAY_SHORT } from '@/utils/alerts/muteWeek'
import './alert-editor.css'

/**
 * A mute window as a week (docs/alerts/DESIGN.md D10): seven rows of
 * twenty-four hours, shaded where it holds, an overnight window wrapping into
 * the next morning. `segments` are muteWeek's `{ day, from, to }`, in minutes
 * of the schedule's own day. `compact` drops the hour axis, for a list row.
 */
export default function WeekGrid({ segments, compact = false, label }) {
  return (
    <div className={`ae-week${compact ? ' compact' : ''}`} role="img" aria-label={label ?? (segments.length ? `Muted ${segments.length} stretches a week, shaded by day and hour` : 'Not muted yet')}>
      {WEEKDAY_SHORT.map((d, day) => (
        <div key={d} className="ae-week-row">
          <span className="ae-week-day">{d}</span>
          <span className="ae-week-track">
            {segments.filter(s => s.day === day).map((s, i) => (
              <span key={i} className="ae-week-bar" style={{ left: `${(s.from / 1440) * 100}%`, width: `${((s.to - s.from) / 1440) * 100}%` }} />
            ))}
          </span>
        </div>
      ))}
      {!compact && <div className="ae-week-axis" aria-hidden="true"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>}
    </div>
  )
}
