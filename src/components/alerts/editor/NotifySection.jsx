import { useEffect, useMemo, useRef } from 'react'
import ExSelect from '@/components/explore/ExSelect'
import { RECEIVER_TYPES } from '@/utils/alerts/catalog'
import { newDestination, nameIsTemplated, contactPointText } from '@/utils/alerts/editorDraft'
import DestinationCard from './DestinationCard.jsx'

const SEND_OPTIONS = [
  { value: false, label: 'One notification for all series', description: 'Series firing together arrive as one message.' },
  { value: true, label: 'One notification per series', description: 'Each series gets its own message, and its own name.' },
]

/**
 * Section 3, Notifications (docs/alerts/DESIGN.md D9): who hears about it,
 * and in how many messages.
 *
 * Contact points are a multi-select, each option saying where it sends, and a
 * one-off destination is an inline card for a rule that needs somewhere no
 * contact point covers. A rule must notify someone, as in production, but it
 * starts with nobody chosen and says so (R23) — production starts with an
 * empty Webhook card, the least common destination there is. Its "Add more"
 * that always added the first group, duplicates and all (R32), is gone: the
 * select cannot pick a contact point twice.
 */
export default function NotifySection({ draft, onDraft, receiverGroups, lookups, problems }) {
  // The destination just added, whose card takes focus as it appears.
  const added = useRef(null)
  useEffect(() => { added.current = null })
  const options = useMemo(() => receiverGroups.map(g => ({ value: g.id, label: g.name, description: contactPointText(g, lookups) })), [receiverGroups, lookups])
  const set = patch => onDraft({ ...draft, ...patch })
  return (
    <div className="ae-notify">
      <div className="ae-field" id="ae-field-notify" tabIndex={-1}>
        <span className="ae-label">Notify</span>
        <ExSelect
          multiple
          searchable
          value={draft.receiverGroupIds}
          options={options}
          onChange={ids => set({ receiverGroupIds: ids })}
          placeholder="Choose contact points"
          ariaLabel="Contact points to notify"
          width={360}
        />
        {problems.notify && <span className="ae-field-problem">{problems.notify}</span>}
      </div>

      {draft.destinations.map((d, i) => (
        <DestinationCard
          key={i}
          index={i}
          dest={d}
          lookups={lookups}
          problem={problems[`destination-${i}`]}
          onChange={next => set({ destinations: draft.destinations.map((x, j) => (j === i ? next : x)) })}
          onRemove={() => set({ destinations: draft.destinations.filter((_, j) => j !== i) })}
          autoFocus={added.current === i}
        />
      ))}
      <div className="ae-row">
        <ExSelect
          value={null}
          options={RECEIVER_TYPES.map(t => ({ value: t.type, label: t.label }))}
          onChange={(type) => { added.current = draft.destinations.length; set({ destinations: [...draft.destinations, newDestination(type)] }) }}
          placeholder="Add a one-off destination"
          ariaLabel="Add a one-off destination of type"
          width={240}
        />
        <span className="ae-hint">For somewhere no contact point covers. It belongs to this rule only.</span>
      </div>

      <div className="ae-field" id="ae-field-grouping">
        <span className="ae-label">Send</span>
        <ExSelect value={draft.groupingDisable} options={SEND_OPTIONS} onChange={v => set({ groupingDisable: v })} ariaLabel="How many notifications to send" width={300} />
        {nameIsTemplated(draft) && !draft.groupingDisable && (
          <span className="ae-hint warn">The name has labels in it, so it reads right only with one notification per series.</span>
        )}
      </div>
    </div>
  )
}
