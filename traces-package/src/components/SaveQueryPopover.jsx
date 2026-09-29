// Naming a query so it can be found again — and deciding whether that means
// keeping a new one or correcting the one it came from.

import { useState, useEffect, useRef } from 'react'
import PipePopover from '@/components/PipePopover'

export const DESCRIPTION_MAX = 500

// Saving keeps the chips and pipes, not the string it renders to. Reapplying a
// saved query should put the builder back exactly as it was — a string would
// have to be reparsed, and anything the parser cannot express would come back
// as free text instead of the filters the user actually saved.
export default function SaveQueryPopover({
  anchorRef, open, onClose, onSave, onUpdate, preview, existingNames,
  origin, previousQuery,
}) {
  // 'update' overwrites the query this one came from; 'new' keeps both. Offered
  // as tabs rather than a checkbox because they are two different outcomes, and
  // which one is wanted depends on whether the edit corrected the saved query
  // or branched off it — something only the user knows.
  const [tab, setTab] = useState('new')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const inputRef = useRef(null)

  const updating = tab === 'update' && !!origin

  // Opening picks the tab; changing tab reloads the fields under it. Update
  // starts from what the origin already says, so the common case — fixing the
  // query, keeping everything else — is no typing at all.
  useEffect(() => {
    if (!open) return
    setTab(origin ? 'update' : 'new')
  }, [open, origin])

  useEffect(() => {
    if (!open) return
    const from = tab === 'update' ? origin : null
    setName(from?.name ?? '')
    setDescription(from?.description ?? '')
    // The field is the only thing in here; landing anywhere else costs a click.
    const t = setTimeout(() => inputRef.current?.focus(), 0)
    return () => clearTimeout(t)
  }, [open, tab, origin])

  const trimmed = name.trim()
  // Its own name is not a clash with itself.
  const duplicate = existingNames.some(n =>
    n.toLowerCase() === trimmed.toLowerCase()
    && !(updating && n.toLowerCase() === (origin?.name ?? '').toLowerCase()))
  const submit = () => {
    if (!trimmed || duplicate) return
    if (updating) onUpdate(origin.id, trimmed, description.trim())
    else onSave(trimmed, description.trim())
    onClose()
  }

  return (
    <PipePopover
      anchorRef={anchorRef}
      open={open}
      onClose={onClose}
      title={updating ? 'Update query' : 'Save query'}
      subtitle={updating
        ? 'Replaces the saved filters and pipes with these'
        : 'Keeps the filters and pipes as they are now'}
      align="right"
      width={320}
    >
      <div className="agg-form">
        {origin && (
          <div className="sq-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'update'}
              className={`sq-tab${tab === 'update' ? ' is-active' : ''}`}
              onClick={() => setTab('update')}
            >
              Update Query
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'new'}
              className={`sq-tab${tab === 'new' ? ' is-active' : ''}`}
              onClick={() => setTab('new')}
            >
              Save as New
            </button>
          </div>
        )}
        <label className="agg-field">
          <span className="agg-lbl">Name</span>
          <input
            ref={inputRef}
            className="agg-input"
            value={name}
            placeholder="e.g. Checkout errors"
            onChange={e => setName(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); submit() }
            }}
          />
        </label>
        <label className="agg-field">
          <span className="agg-lbl">
            Description <span className="sq-optional">optional</span>
            {description.length > 0 && (
              <span className={`sq-count${description.length >= DESCRIPTION_MAX ? ' is-full' : ''}`}>
                {description.length}/{DESCRIPTION_MAX}
              </span>
            )}
          </span>
          <textarea
            className="agg-input sq-textarea"
            rows={2}
            value={description}
            maxLength={DESCRIPTION_MAX}
            placeholder="What is this for? When would you reach for it?"
            onChange={e => setDescription(e.target.value.slice(0, DESCRIPTION_MAX))}
            onKeyDown={e => {
              // Enter submits from the name field; here it should make a line.
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit() }
            }}
          />
        </label>
        {updating && previousQuery && previousQuery !== preview ? (
          <div className="sq-preview">
            <span className="sq-preview-label">Replacing</span>
            <code className="sq-was">{previousQuery}</code>
            <span className="sq-preview-label">With</span>
            <code>{preview}</code>
          </div>
        ) : (
          <div className="sq-preview">
            <span className="sq-preview-label">Saving</span>
            <code>{preview}</code>
          </div>
        )}
        {duplicate && <div className="sq-warn">A query called “{trimmed}” already exists.</div>}
        <div className="agg-actions">
          <button type="button" className="agg-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="agg-btn is-primary" disabled={!trimmed || duplicate} onClick={submit}>
            {updating ? 'Update' : 'Save'}
          </button>
        </div>
      </div>
    </PipePopover>
  )
}
