import { useEffect, useMemo, useRef, useState } from 'react'
import { Trash2 } from 'lucide-react'
import AlertDialog from '@/components/alerts/shared/AlertDialog'
import { integrationIcon } from '@/components/alerts/rule/integrationIcons'
import DestinationCard from '@/components/alerts/editor/DestinationCard'
import { RECEIVER_TYPES } from '@/utils/alerts/catalog'
import { newDestination, receiverOf } from '@/utils/alerts/editorDraft'
import { contactPointIssues, contactPointDraft } from '@/utils/alerts/configViews'
import ConfigDrawer from './ConfigDrawer.jsx'
import { focusFirstIssue } from './focusIssue'

/**
 * A contact point's drawer (docs/alerts/DESIGN.md D9): its name, and its
 * integrations, each the same card the rule editor's one-off destinations use
 * — production's per-type fields, Send test inline, Notify when resolved — so
 * the two places cannot drift apart.
 *
 * Integrations are added from a labelled grid of production's eight types, in
 * its order, rather than production's "Add Receiver" that always adds a
 * Webhook. A type the server has not enabled stays in the grid, disabled, with
 * the reason (production hides it).
 *
 * Saving a contact point other rules use says what it touches: "Save ·
 * changes routing for 3 rules". Production re-routes them without a word.
 * Delete is refused while any rule still sends here, with the reason and the
 * rules, rather than production's silently disabled button.
 */
export default function ContactPointDrawer({ group, mode, usedBy, others, lookups, onSave, onDelete, onClose }) {
  const initial = useMemo(() => {
    const d = contactPointDraft(group)
    return mode === 'clone' ? { ...d, name: `Copy of ${d.name}` } : d
  }, [group, mode])
  const [draft, setDraft] = useState(initial)
  const [attempted, setAttempted] = useState(false)
  const [asking, setAsking] = useState(null)
  const stayRef = useRef(null)
  // The integration just added, whose card takes focus as it appears.
  const added = useRef(null)
  useEffect(() => { added.current = null })
  const issues = contactPointIssues(draft, others)
  const shown = Object.fromEntries(issues.filter(i => attempted || (i.field === 'name' && draft.name.trim())).map(i => [i.field, i.message]))
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial)
  const routes = mode === 'edit' ? usedBy.length : 0
  const set = patch => setDraft(d => ({ ...d, ...patch }))

  const close = () => (dirty ? setAsking('discard') : onClose())
  const save = () => {
    setAttempted(true)
    if (issues.length) {
      focusFirstIssue(issues, { nameId: 'cfg-cp-name', addSelector: '.cfg-drawer .cfg-type-grid button:not([aria-disabled="true"])' })
      return
    }
    onSave({ ...(mode === 'edit' ? { id: group.id } : null), name: draft.name.trim(), receiver: receiverOf(draft.destinations) })
  }
  const title = mode === 'edit' ? `Edit ${group.name}` : mode === 'clone' ? 'Copy a contact point' : 'New contact point'

  const footer = (
    <>
      {mode === 'edit' && (
        <button
          type="button"
          className="hbtn cfg-delete"
          aria-disabled={routes > 0 || undefined}
          title={routes > 0 ? `Used by ${routes} rule${routes === 1 ? '' : 's'}: move them to another contact point first.` : undefined}
          onClick={routes > 0 ? undefined : () => setAsking('delete')}
        >
          <Trash2 aria-hidden="true" />Delete
        </button>
      )}
      <span className="cfg-foot-note">{issues.length && attempted ? `${issues.length} to finish` : ''}</span>
      <button type="button" className="hbtn" onClick={close}>Cancel</button>
      <button type="button" className="hbtn primary" aria-disabled={issues.length > 0 || undefined} onClick={save}>
        {routes > 0 ? `Save · changes routing for ${routes} rule${routes === 1 ? '' : 's'}` : 'Save contact point'}
      </button>
    </>
  )

  return (
    <>
    <ConfigDrawer title={title} onClose={close} footer={footer}>
      <div className="ae-field">
        <label className="ae-label" htmlFor="cfg-cp-name">Name</label>
        <input
          id="cfg-cp-name"
          className={`ae-input wide${shown.name ? ' invalid' : ''}`}
          value={draft.name}
          placeholder="Payments on-call"
          onChange={e => set({ name: e.target.value })}
        />
        {shown.name && <span className="ae-field-problem">{shown.name}</span>}
      </div>

      {mode === 'edit' && routes > 0 && (
        <p className="ae-hint">
          {routes} rule{routes === 1 ? '' : 's'} send{routes === 1 ? 's' : ''} here: {usedBy.slice(0, 4).map(r => r.name).join(', ')}{routes > 4 ? `, and ${routes - 4} more` : ''}. A change here changes where they notify.
        </p>
      )}

      <div className="ae-field">
        <span className="ae-label">Integrations</span>
        {draft.destinations.map((d, i) => (
          <DestinationCard
            key={i}
            index={i}
            dest={d}
            lookups={lookups}
            problem={shown[`destination-${i}`]}
            onChange={next => set({ destinations: draft.destinations.map((x, j) => (j === i ? next : x)) })}
            onRemove={() => set({ destinations: draft.destinations.filter((_, j) => j !== i) })}
            autoFocus={added.current === i}
          />
        ))}
        {shown.destinations && <span className="ae-field-problem">{shown.destinations}</span>}
      </div>

      <div className="ae-field">
        <span className="ae-label" id="cfg-cp-add">Add an integration</span>
        <div className="cfg-type-grid" role="group" aria-labelledby="cfg-cp-add">
          {RECEIVER_TYPES.map((t) => {
            const Icon = integrationIcon(t.type)
            const off = t.enabled === false
            return (
              <button
                key={t.type}
                type="button"
                className={`cfg-type${off ? ' is-disabled' : ''}`}
                aria-disabled={off || undefined}
                title={off ? 'Not enabled on this server' : `Add ${t.label}`}
                onClick={off ? undefined : () => { added.current = draft.destinations.length; set({ destinations: [...draft.destinations, newDestination(t.type)] }) }}
              >
                <Icon aria-hidden="true" />
                {t.label}
              </button>
            )
          })}
        </div>
      </div>

    </ConfigDrawer>
    {/* Beside the drawer, not in it: the drawer is transformed, which would
        trap a fixed dialog inside its box, and it sits above the page's
        dialogs. The layer lifts them over it. */}
    {asking && (
      <div className="cfg-dialog-layer">
      {asking === 'discard' && (
        <AlertDialog
          title="Discard changes to this contact point?"
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
      )}
      {asking === 'delete' && (
        <AlertDialog
          title={`Delete ${group.name}?`}
          onCancel={() => setAsking(null)}
          initialFocus={stayRef}
          footer={(
            <>
              <button ref={stayRef} type="button" className="hbtn" onClick={() => setAsking(null)}>Cancel</button>
              <button type="button" className="hbtn alr-btn-danger" onClick={() => onDelete(group)}>Delete contact point</button>
            </>
          )}
        >
          <p>No rule sends here. Its past notifications stay in the history.</p>
        </AlertDialog>
      )}
      </div>
    )}
    </>
  )
}
