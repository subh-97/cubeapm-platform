import { useId, useMemo, useRef, useState } from 'react'
import { formatLocal } from '@/utils/timeRange'
import AlertDialog from './AlertDialog'
import { customSnoozeSpec } from './alertShared'

const LOCAL_INPUT = 'YYYY-MM-DDTHH:mm'

/**
 * Production's Custom snooze: a start (now, or later, which makes it a
 * scheduled snooze) and a duration, because the presets stop at an hour and
 * "snooze for two hours" is the common case (reference J10). Two changes:
 * the start defaults to now rather than an empty picker, and a reason note
 * travels with the snooze into the notification log, where production records
 * neither who nor why (DESIGN D10).
 */
export default function CustomSnoozeDialog({ nowSec, onConfirm, onCancel }) {
  const [startMode, setStartMode] = useState('now')
  const [at, setAt] = useState(() => formatLocal(nowSec * 1000, LOCAL_INPUT))
  const [hours, setHours] = useState('2')
  const [minutes, setMinutes] = useState('0')
  const [comment, setComment] = useState('')
  const hoursRef = useRef(null)
  const ids = { form: useId(), reason: useId(), err: useId() }

  const startSec = startMode === 'now' ? nowSec : Math.floor(new Date(at).getTime() / 1000)
  const spec = useMemo(
    () => customSnoozeSpec({ startSec, hours, minutes, comment }),
    [startSec, hours, minutes, comment],
  )
  const invalid = spec
    ? null
    : !Number.isFinite(startSec) ? 'Choose when the snooze starts.' : 'Choose a duration longer than zero.'

  const submit = (e) => {
    e?.preventDefault()
    if (spec) onConfirm(spec)
  }

  return (
    <AlertDialog
      title="Snooze notifications"
      onCancel={onCancel}
      initialFocus={hoursRef}
      footer={(
        <>
          <button type="button" className="hbtn" onClick={onCancel}>Cancel</button>
          <button
            type="submit"
            form={ids.form}
            className="hbtn primary"
            disabled={!spec}
            title={invalid || undefined}
          >
            Snooze
          </button>
        </>
      )}
    >
      <form id={ids.form} className="alr-form" onSubmit={submit}>
        <fieldset className="alr-field">
          <legend className="alr-field-label">Starts</legend>
          <div className="alr-row">
            <label className="alr-radio">
              <input type="radio" name="alr-snooze-start" checked={startMode === 'now'} onChange={() => setStartMode('now')} />
              Now
            </label>
            <label className="alr-radio">
              <input type="radio" name="alr-snooze-start" checked={startMode === 'at'} onChange={() => setStartMode('at')} />
              At
            </label>
            <input
              type="datetime-local"
              className="alr-input"
              aria-label="Snooze start"
              value={at}
              min={formatLocal(nowSec * 1000, LOCAL_INPUT)}
              disabled={startMode !== 'at'}
              onChange={e => setAt(e.target.value)}
            />
          </div>
        </fieldset>

        <fieldset className="alr-field" aria-describedby={invalid ? ids.err : undefined}>
          <legend className="alr-field-label">Snooze for</legend>
          <div className="alr-row">
            <label className="alr-num">
              <input
                ref={hoursRef}
                type="number" min="0" step="1" className="alr-input"
                value={hours} onChange={e => setHours(e.target.value)}
              />
              <span>h</span>
            </label>
            <label className="alr-num">
              <input
                type="number" min="0" max="59" step="1" className="alr-input"
                value={minutes} onChange={e => setMinutes(e.target.value)}
              />
              <span>m</span>
            </label>
            {spec && (
              <span className="alr-hint">
                Until {formatLocal(spec.end * 1000, 'MMM DD HH:mm')}
              </span>
            )}
          </div>
          {invalid && <div id={ids.err} className="alr-error" role="alert">{invalid}</div>}
        </fieldset>

        <div className="alr-field">
          <label className="alr-field-label" htmlFor={ids.reason}>Reason (optional)</label>
          <input
            id={ids.reason}
            type="text"
            className="alr-input wide"
            placeholder="Shown in the notification log"
            value={comment}
            onChange={e => setComment(e.target.value)}
          />
        </div>
      </form>
    </AlertDialog>
  )
}
