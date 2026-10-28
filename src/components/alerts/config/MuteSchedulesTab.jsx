import { useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Copy, Pencil, Plus, Trash2 } from 'lucide-react'
import UndoMessage from '@/components/alerts/shared/UndoMessage'
import AlertDialog from '@/components/alerts/shared/AlertDialog'
import { useFocusHandoff } from '@/components/alerts/shared/useFocusHandoff'
import WeekGrid from '@/components/alerts/editor/WeekGrid'
import { ALERTS_NOW } from '@/data/alerts'
import { muteWindowsOf } from '@/utils/alerts/editorDraft'
import { weekSegments } from '@/utils/alerts/muteWeek'
import { usageBySchedule, scheduleWords, scheduleState, dayClock } from '@/utils/alerts/configViews'
import { UsedBy } from './ContactPointsTab.jsx'
import MuteScheduleDrawer from './MuteScheduleDrawer.jsx'
import SnoozeList from './SnoozeList.jsx'

const isPlain = e => !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0)
const viewerZone = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone } catch { return 'UTC' }
})()
// "Asia/Calcutta (UTC+5:30)": a zone and its offset now.
function zoneText(zone) {
  try {
    const off = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'shortOffset' }).formatToParts(new Date())
      .find(p => p.type === 'timeZoneName')?.value?.replace('GMT', 'UTC') || 'UTC'
    return `${zone.replace(/_/g, ' ')} (${off})`
  } catch {
    return zone
  }
}
const when = sec => dayClock(sec, ALERTS_NOW)

/**
 * The Mute schedules tab (production's Mute Groups; docs/alerts/DESIGN.md
 * D10): each schedule drawn as a week, saying whether it is muting right now
 * and until when, or when it next starts — production says only "Start at
 * 21:00 · Mute for 10h · Everyday" — in its own timezone beside the viewer's.
 * Then every snooze, active and scheduled, in one list, which production does
 * not have at all.
 */
export default function MuteSchedulesTab({ alerts, setToast }) {
  const navigate = useNavigate()
  const [drawer, setDrawer] = useState(null)
  // A deleted schedule hands focus to the one after it (7c).
  const listRef = useRef(null)
  const newRef = useRef(null)
  const onListFocus = useFocusHandoff(listRef, { item: '.cfg-item', target: '.cfg-item-name', fallback: () => newRef.current })
  const [confirming, setConfirming] = useState(null)
  const cancelRef = useRef(null)
  const groups = alerts.muteGroups
  const usage = useMemo(() => usageBySchedule(alerts.rules), [alerts.rules])
  const sorted = useMemo(() => [...groups].sort((a, b) => a.name.localeCompare(b.name)), [groups])
  const go = url => (e) => { if (!isPlain(e)) return; e.preventDefault(); navigate(url) }

  const save = (group) => {
    const { group: saved, undo } = alerts.actions.saveMuteGroup(group)
    setDrawer(null)
    setToast?.(<UndoMessage text={`Saved ${saved.name}.`} onUndo={() => { undo(); setToast?.(null) }} />)
  }
  const remove = (group) => {
    const undo = alerts.actions.removeMuteGroup(group.id)
    setDrawer(null)
    setConfirming(null)
    if (typeof undo !== 'function') {
      setToast?.(`${group.name} still mutes a rule; nothing was deleted.`)
      return
    }
    setToast?.(<UndoMessage text={`Deleted ${group.name}.`} onUndo={() => { undo(); setToast?.(null) }} />)
  }

  return (
    <div className="svc-main cfg-tab">
      <section className="cfg-section" aria-labelledby="cfg-schedules-title">
        <div className="cfg-toolbar">
          <h2 id="cfg-schedules-title" className="cfg-section-title">Schedules</h2>
          <p className="cfg-count">{groups.length} schedule{groups.length === 1 ? '' : 's'}</p>
          <button ref={newRef} type="button" className="hbtn primary" onClick={() => setDrawer({ mode: 'new', group: null })}>
            <Plus aria-hidden="true" />New mute schedule
          </button>
        </div>
        {groups.length === 0 ? (
          <p className="ae-hint">
            No mute schedules yet. A schedule holds a rule&apos;s notifications on a timetable — nights, weekends, a
            deploy window — while the rule keeps evaluating.
          </p>
        ) : (
          <ul className="cfg-list" ref={listRef} onFocus={onListFocus}>
            {sorted.map((g) => {
              const users = usage.get(g.id) ?? []
              const state = scheduleState(g, ALERTS_NOW)
              const zones = [...new Set(muteWindowsOf(g.mute).map(w => w.location))]
              const segments = muteWindowsOf(g.mute).flatMap(w => weekSegments(w))
              return (
                <li key={g.id} className={`cfg-item${state?.active ? ' is-muting' : ''}`} data-key={g.id}>
                  <div className="cfg-item-head">
                    <button type="button" className="cfg-item-name" onClick={() => setDrawer({ mode: 'edit', group: g })}>{g.name}</button>
                    <span className={`cfg-state${state?.active ? ' active' : ''}`}>
                      {state == null ? 'Never opens' : state.active ? `Muting now · ends ${when(state.end)}` : `Next: ${when(state.start)}`}
                    </span>
                    <UsedBy users={users} empty="Mutes no rule" go={go} filtered={null} />
                    <div className="cfg-item-actions">
                      <button type="button" className="hbtn" onClick={() => setDrawer({ mode: 'edit', group: g })}><Pencil aria-hidden="true" />Edit</button>
                      <button type="button" className="hbtn" onClick={() => setDrawer({ mode: 'clone', group: g })}><Copy aria-hidden="true" />Clone</button>
                      <button
                        type="button"
                        className="hbtn"
                        aria-disabled={users.length > 0 || undefined}
                        title={users.length ? `Mutes ${users.length} rule${users.length === 1 ? '' : 's'}: take it off them first.` : `Delete ${g.name}`}
                        onClick={users.length ? undefined : () => setConfirming(g)}
                      >
                        <Trash2 aria-hidden="true" />Delete
                      </button>
                    </div>
                  </div>
                  <div className="cfg-schedule">
                    <WeekGrid compact segments={segments} label={`${g.name}: ${scheduleWords(g).join('; ')}`} />
                    <div className="cfg-schedule-words">
                      {scheduleWords(g).map(w => <span key={w}>{w}</span>)}
                      <span className="ae-hint">
                        Hours are {zones.map(zoneText).join(', ')}
                        {zones.every(z => z === viewerZone) ? ', your own timezone.' : `; times above are in yours, ${zoneText(viewerZone)}.`}
                      </span>
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <SnoozeList views={alerts.rules} actions={alerts.actions} nowSec={ALERTS_NOW} setToast={setToast} />

      {drawer && (
        <MuteScheduleDrawer
          key={`${drawer.mode}-${drawer.group?.id ?? 'new'}`}
          mode={drawer.mode}
          group={drawer.group}
          usedBy={drawer.group ? usage.get(drawer.group.id) ?? [] : []}
          others={groups.filter(x => drawer.mode !== 'edit' || x.id !== drawer.group?.id).map(x => x.name)}
          nowSec={ALERTS_NOW}
          onSave={save}
          onDelete={remove}
          onClose={() => setDrawer(null)}
        />
      )}
      {confirming && (
        <div className="cfg-dialog-layer">
          <AlertDialog
            title={`Delete ${confirming.name}?`}
            onCancel={() => setConfirming(null)}
            initialFocus={cancelRef}
            footer={(
              <>
                <button ref={cancelRef} type="button" className="hbtn" onClick={() => setConfirming(null)}>Cancel</button>
                <button type="button" className="hbtn alr-btn-danger" onClick={() => remove(confirming)}>Delete schedule</button>
              </>
            )}
          >
            <p>No rule is muted by it. Notifications it held stay in the history.</p>
          </AlertDialog>
        </div>
      )}
    </div>
  )
}
