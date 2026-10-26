import { useId, useMemo } from 'react'
import { X } from 'lucide-react'
import ExSelect from '@/components/explore/ExSelect'
import { WEEKDAYS, WEEKDAY_SHORT, weekSegments, muteWindowState } from '@/utils/alerts/muteWeek'
import WeekGrid from './WeekGrid.jsx'
import './alert-editor.css'

// Every zone the browser knows, with its offset, the way production lists them
// ("Asia/Calcutta +05:30"). Built once: a formatter per zone is the cost.
let ZONES = null
function zoneOptions(current) {
  if (!ZONES) {
    const names = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : ['UTC']
    ZONES = names.map(z => ({ value: z, label: z.replace(/_/g, ' '), description: offsetOf(z) }))
  }
  return current && !ZONES.some(o => o.value === current)
    ? [{ value: current, label: current.replace(/_/g, ' '), description: offsetOf(current) }, ...ZONES]
    : ZONES
}
function offsetOf(zone) {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'shortOffset' }).formatToParts(new Date())
      .find(p => p.type === 'timeZoneName')?.value ?? ''
    return part.replace('GMT', 'UTC') || 'UTC'
  } catch {
    return ''
  }
}

const clock = sec => new Date(sec * 1000).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })

/**
 * A one-off mute window (docs/alerts/DESIGN.md D10, reference §9.2): when it
 * starts, how long it holds, on which days, in which timezone — production's
 * fields — drawn as a week so an overnight window is seen to run into the next
 * morning, and saying whether it holds right now or when it next opens.
 */
export default function MuteWindowCard({ index, window: w, onChange, onRemove, problem, nowSec }) {
  const id = useId()
  const set = patch => onChange({ ...w, ...patch })
  const segs = useMemo(() => weekSegments(w), [w])
  const state = useMemo(() => (problem ? null : muteWindowState(w, nowSec)), [w, nowSec, problem])
  const toggleDay = d => set({ weekdays: w.weekdays.includes(d) ? w.weekdays.filter(x => x !== d) : WEEKDAYS.filter(x => x === d || w.weekdays.includes(x)) })

  return (
    <div className={`ae-mute${problem ? ' invalid' : ''}`} id={`ae-field-mute-${index}`} tabIndex={-1}>
      <div className="ae-dest-head">
        <span className="ae-dest-type">Mute window</span>
        <button type="button" className="hbtn icon-only" aria-label="Remove this mute window" title="Remove window" onClick={onRemove}>
          <X aria-hidden="true" />
        </button>
      </div>
      <div className="ae-row ae-mute-fields">
        <label className="ae-setting">
          <span className="ae-label">Start at</span>
          <input type="time" className="ae-input" value={w.start} onChange={e => set({ start: e.target.value })} />
        </label>
        <span className="ae-setting">
          <span className="ae-label" id={`${id}-for`}>Mute for</span>
          <span className="ae-duration" role="group" aria-labelledby={`${id}-for`}>
            <input type="number" min="0" className="ae-input narrow" aria-label="Hours" value={w.hours} onChange={e => set({ hours: e.target.value === '' ? 0 : Number(e.target.value) })} />
            <span>h</span>
            <input type="number" min="0" max="59" className="ae-input narrow" aria-label="Minutes" value={w.minutes} onChange={e => set({ minutes: e.target.value === '' ? 0 : Number(e.target.value) })} />
            <span>m</span>
          </span>
        </span>
        <span className="ae-setting">
          <span className="ae-label">Timezone</span>
          <ExSelect value={w.location} options={zoneOptions(w.location)} onChange={v => set({ location: v })} searchable ariaLabel="Timezone" width={240} />
        </span>
      </div>
      <fieldset className="ae-days">
        <legend className="ae-label">Every</legend>
        {WEEKDAYS.map((d, i) => (
          <label key={d} className="ae-check">
            <input type="checkbox" checked={w.weekdays.includes(d)} onChange={() => toggleDay(d)} />
            {WEEKDAY_SHORT[i]}
          </label>
        ))}
        <span className="ae-hint">No day ticked means every day.</span>
      </fieldset>

      <WeekGrid segments={segs} />
      <p className="ae-hint">
        Hours are {w.location || 'the timezone above'}&apos;s.
        {state && (state.active ? ` Active now, ends ${clock(state.end)} your time.` : ` Next: ${clock(state.start)} your time.`)}
      </p>
      {problem && <span className="ae-field-problem">{problem}</span>}
    </div>
  )
}
