import { useMemo, useRef, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import AlertDialog from '@/components/alerts/shared/AlertDialog'
import MuteWindowCard from '@/components/alerts/editor/MuteWindowCard'
import { newMuteWindow, muteOf } from '@/utils/alerts/editorDraft'
import { scheduleIssues, scheduleDraft } from '@/utils/alerts/configViews'
import ConfigDrawer from './ConfigDrawer.jsx'
import { focusFirstIssue } from './focusIssue'

/**
 * A mute schedule's drawer (docs/alerts/DESIGN.md D10, reference §9): its
 * name and windows, each the rule editor's window card — production's fields,
 * drawn as a week, saying whether it holds now. Saving one that rules use says
 * how many it changes; Delete is refused, with the reason, while any rule is
 * still muted by it.
 */
export default function MuteScheduleDrawer({ group, mode, usedBy, others, nowSec, onSave, onDelete, onClose }) {
  const initial = useMemo(() => {
    const d = scheduleDraft(group)
    if (mode === 'clone') return { ...d, name: `Copy of ${d.name}` }
    return mode === 'new' ? { ...d, windows: [newMuteWindow()] } : d
  }, [group, mode])
  const [draft, setDraft] = useState(initial)
  const [attempted, setAttempted] = useState(false)
  const [asking, setAsking] = useState(null)
  const stayRef = useRef(null)
  const issues = scheduleIssues(draft, others)
  const shown = Object.fromEntries(issues.filter(i => attempted || (i.field === 'name' && draft.name.trim())).map(i => [i.field, i.message]))
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial)
  const mutes = mode === 'edit' ? usedBy.length : 0
  const set = patch => setDraft(d => ({ ...d, ...patch }))

  const close = () => (dirty ? setAsking('discard') : onClose())
  const save = () => {
    setAttempted(true)
    if (issues.length) {
      focusFirstIssue(issues, { nameId: 'cfg-ms-name', addSelector: '.cfg-drawer .cfg-add-window' })
      return
    }
    onSave({ ...(mode === 'edit' ? { id: group.id } : null), name: draft.name.trim(), mute: muteOf(draft.windows) })
  }
  const title = mode === 'edit' ? `Edit ${group.name}` : mode === 'clone' ? 'Copy a mute schedule' : 'New mute schedule'

  const footer = (
    <>
      {mode === 'edit' && (
        <button
          type="button"
          className="hbtn cfg-delete"
          aria-disabled={mutes > 0 || undefined}
          title={mutes > 0 ? `Mutes ${mutes} rule${mutes === 1 ? '' : 's'}: take it off them first.` : undefined}
          onClick={mutes > 0 ? undefined : () => setAsking('delete')}
        >
          <Trash2 aria-hidden="true" />Delete
        </button>
      )}
      <span className="cfg-foot-note">{issues.length && attempted ? `${issues.length} to finish` : ''}</span>
      <button type="button" className="hbtn" onClick={close}>Cancel</button>
      <button type="button" className="hbtn primary" aria-disabled={issues.length > 0 || undefined} onClick={save}>
        {mutes > 0 ? `Save · changes muting for ${mutes} rule${mutes === 1 ? '' : 's'}` : 'Save schedule'}
      </button>
    </>
  )

  return (
    <>
      <ConfigDrawer title={title} onClose={close} footer={footer}>
        <div className="ae-field">
          <label className="ae-label" htmlFor="cfg-ms-name">Name</label>
          <input
            id="cfg-ms-name"
            className={`ae-input wide${shown.name ? ' invalid' : ''}`}
            value={draft.name}
            placeholder="Quiet hours"
            onChange={e => set({ name: e.target.value })}
          />
          {shown.name && <span className="ae-field-problem">{shown.name}</span>}
        </div>
        {mode === 'edit' && mutes > 0 && (
          <p className="ae-hint">
            It mutes {usedBy.slice(0, 4).map(r => r.name).join(', ')}{mutes > 4 ? `, and ${mutes - 4} more` : ''}. A change here changes when they keep quiet.
          </p>
        )}
        {draft.windows.map((w, i) => (
          <MuteWindowCard
            key={i}
            index={i}
            window={w}
            nowSec={nowSec}
            problem={shown[`mute-${i}`]}
            onChange={next => set({ windows: draft.windows.map((x, j) => (j === i ? next : x)) })}
            onRemove={() => set({ windows: draft.windows.filter((_, j) => j !== i) })}
          />
        ))}
        {shown.windows && <span className="ae-field-problem">{shown.windows}</span>}
        <button type="button" className="ae-link cfg-add-window" onClick={() => set({ windows: [...draft.windows, newMuteWindow()] })}>
          <Plus aria-hidden="true" />Add a mute window
        </button>
      </ConfigDrawer>
      {asking && (
        <div className="cfg-dialog-layer">
          {asking === 'discard' ? (
            <AlertDialog
              title="Discard changes to this schedule?"
              onCancel={() => setAsking(null)}
              initialFocus={stayRef}
              footer={(
                <>
                  <button ref={stayRef} type="button" className="hbtn" onClick={() => setAsking(null)}>Keep editing</button>
                  <button type="button" className="hbtn alr-btn-danger" onClick={onClose}>Discard changes</button>
                </>
              )}
            >
              <p>Nothing you changed here has been saved.</p>
            </AlertDialog>
          ) : (
            <AlertDialog
              title={`Delete ${group.name}?`}
              onCancel={() => setAsking(null)}
              initialFocus={stayRef}
              footer={(
                <>
                  <button ref={stayRef} type="button" className="hbtn" onClick={() => setAsking(null)}>Cancel</button>
                  <button type="button" className="hbtn alr-btn-danger" onClick={() => onDelete(group)}>Delete schedule</button>
                </>
              )}
            >
              <p>No rule is muted by it. Notifications it held stay in the history.</p>
            </AlertDialog>
          )}
        </div>
      )}
    </>
  )
}
