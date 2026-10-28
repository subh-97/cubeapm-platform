import { useMemo } from 'react'
import { Plus, X } from 'lucide-react'
import ExSelect from '@/components/explore/ExSelect'
import { radioGroupKeyDown } from '@/components/alerts/shared/alertShared'
import { newMuteWindow } from '@/utils/alerts/editorDraft'
import { formatDuration } from '@/utils/alerts/describe'
import MuteWindowCard from './MuteWindowCard.jsx'

const ROLE_HELP = 'Users with the Viewer role can view it. Users with the Editor role can edit it.'

// "21:00 for 10h, every day (Asia/Calcutta)": a schedule as its option reads.
function scheduleText(group) {
  return (group.mute?.time_intervals ?? []).flatMap(iv => (iv.times ?? []).map(t => {
    const days = iv.weekdays?.length ? iv.weekdays.map(d => d.slice(0, 3)).join(', ') : 'every day'
    return `${t.start_time} for ${formatDuration(t.duration_minutes * 60)}, ${days} (${iv.location})`
  })).join(' · ')
}

/**
 * Section 4, Mutes & access (docs/alerts/DESIGN.md D6, D10): when the rule
 * keeps quiet, and who may change it.
 *
 * Mute schedules are a multi-select, each saying when it holds; a one-off
 * window is drawn as a week. Access keeps production's two choices — by role,
 * or specific teams and people as Viewer or Editor — and its rule that a
 * custom list needs at least one Editor, said in words when it is missing.
 */
export default function MutesAccessSection({ draft, onDraft, muteGroups, lookups, problems, nowSec }) {
  const set = patch => onDraft({ ...draft, ...patch })
  const scheduleOptions = useMemo(() => muteGroups.map(g => ({ value: g.id, label: g.name, description: scheduleText(g) })), [muteGroups])
  const entities = useMemo(() => [
    ...(lookups.teams ?? []).map(t => ({ value: `team:${t.id}`, label: `${t.name} (team)` })),
    ...(lookups.users ?? []).map(u => ({ value: `user:${u.id}`, label: `${u.first_name} ${u.last_name}`, description: u.email })),
  ], [lookups])
  const rows = draft.access.rows
  const setRows = next => set({ access: { mode: 'custom', rows: next } })

  return (
    <div className="ae-mutes">
      <div className="ae-field" id="ae-field-mutes">
        <span className="ae-label">Mute during</span>
        <ExSelect
          multiple
          value={draft.muteGroupIds}
          options={scheduleOptions}
          onChange={ids => set({ muteGroupIds: ids })}
          placeholder="No mute schedule"
          ariaLabel="Mute schedules"
          width={360}
        />
        <span className="ae-hint">Notifications inside a mute window are held and logged as Muted; the rule keeps evaluating.</span>
      </div>
      {draft.muteWindows.map((w, i) => (
        <MuteWindowCard
          key={i}
          index={i}
          window={w}
          nowSec={nowSec}
          problem={problems[`mute-${i}`]}
          onChange={next => set({ muteWindows: draft.muteWindows.map((x, j) => (j === i ? next : x)) })}
          onRemove={() => set({ muteWindows: draft.muteWindows.filter((_, j) => j !== i) })}
        />
      ))}
      <button type="button" className="ae-link" onClick={() => set({ muteWindows: [...draft.muteWindows, newMuteWindow()] })}>
        <Plus aria-hidden="true" />Add a one-off mute window
      </button>

      <fieldset className="ae-field ae-access" id="ae-field-access">
        <legend className="ae-label">Access</legend>
        <div className="seg-toggle" role="radiogroup" aria-label="Who can change this rule" onKeyDown={radioGroupKeyDown}>
          {[['role', 'By role'], ['custom', 'Specific teams and people']].map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={draft.access.mode === mode}
              className={`seg${draft.access.mode === mode ? ' active' : ''}`}
              tabIndex={draft.access.mode === mode ? 0 : -1}
              onClick={() => set({ access: mode === 'role' ? { mode: 'role', rows: [] } : { mode: 'custom', rows: rows.length ? rows : [{ entity: '', permission: 'editor' }] } })}
            >
              {label}
            </button>
          ))}
        </div>
        {draft.access.mode === 'role' ? (
          <span className="ae-hint">{ROLE_HELP}</span>
        ) : (
          <>
            {rows.map((r, i) => {
              const taken = new Set(rows.filter((_, j) => j !== i).map(x => x.entity))
              return (
                <div key={i} className="ae-tag-row">
                  <ExSelect
                    value={r.entity || null}
                    searchable
                    options={entities.filter(o => !taken.has(o.value))}
                    onChange={v => setRows(rows.map((x, j) => (j === i ? { ...x, entity: v } : x)))}
                    placeholder="Team or person"
                    ariaLabel={`Access row ${i + 1}: team or person`}
                    width={260}
                  />
                  <ExSelect
                    value={r.permission}
                    options={[{ value: 'viewer', label: 'Viewer' }, { value: 'editor', label: 'Editor' }]}
                    onChange={v => setRows(rows.map((x, j) => (j === i ? { ...x, permission: v } : x)))}
                    ariaLabel={`Access row ${i + 1}: permission`}
                    width={110}
                  />
                  <button type="button" className="hbtn icon-only" aria-label={`Remove access row ${i + 1}`} title="Remove" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                    <X aria-hidden="true" />
                  </button>
                </div>
              )
            })}
            <button type="button" className="ae-link" onClick={() => setRows([...rows, { entity: '', permission: 'viewer' }])}>
              <Plus aria-hidden="true" />Add a team or person
            </button>
          </>
        )}
        {problems.access && <span className="ae-field-problem">{problems.access}</span>}
      </fieldset>
    </div>
  )
}
