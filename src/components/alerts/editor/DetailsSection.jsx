import { useId, useMemo, useState } from 'react'
import { Plus, X } from 'lucide-react'
import ExSelect from '@/components/explore/ExSelect'
import InfoTip from '@/components/shared/InfoTip'
import { EVALUATION_INTERVALS, WAIT_FOR, REPEAT_AFTER, SETTINGS_HELP } from '@/utils/alerts/catalog'
import { formatDuration } from '@/utils/alerts/describe'
import { renderTemplate } from '@/utils/alerts/template'
import { insertLabel, nameIsTemplated } from '@/utils/alerts/editorDraft'

const options = (list, zero) => list.map(sec => ({ value: sec, label: sec === 0 ? zero : formatDuration(sec) }))
const INTERVAL_OPTIONS = options(EVALUATION_INTERVALS)
const WAIT_OPTIONS = options(WAIT_FOR, 'Immediately')
const REPEAT_OPTIONS = options(REPEAT_AFTER)

/**
 * Section 2, Evaluation & details (docs/alerts/DESIGN.md D8): production's
 * "Settings" step, renamed where it said two things for one (R4): Check every,
 * Fire after, Re-notify every; then what the rule is called and where it is
 * filed.
 *
 * The name and grouping are one decision. A templated name ("CPU high on
 * {{ index .Labels "host.name" }}") only reads right when each series is
 * notified on its own, and production's only warning is a red hint on another
 * step (R28). Here, Insert label writes the template for you — from the labels
 * the preview's series actually carry — and switches Send to one notification
 * per series, saying so beside the field.
 */
export default function DetailsSection({ draft, onDraft, series, groups, problems }) {
  const nameId = useId()
  const [switchedNote, setSwitchedNote] = useState(false)
  const labelKeys = useMemo(() => {
    const keys = new Set()
    for (const s of series ?? []) for (const k of Object.keys(s.labels ?? {})) keys.add(k)
    return [...keys].sort()
  }, [series])
  const rendered = useMemo(() => {
    if (!nameIsTemplated(draft)) return []
    const seen = new Set()
    return (series ?? []).map(s => renderTemplate(draft.name, { labels: s.labels, value: null }))
      .filter(n => (seen.has(n) ? false : seen.add(n))).slice(0, 3)
  }, [draft, series])
  const newGroup = draft.group.trim() && !groups.includes(draft.group.trim())
  const set = patch => onDraft({ ...draft, ...patch })
  const tags = draft.tags

  return (
    <div className="ae-details">
      <div className="ae-row ae-settings">
        <div className="ae-setting" id="ae-field-intervalSec">
          <span className="ae-label">Check every <InfoTip label="About Check every">{SETTINGS_HELP.interval}</InfoTip></span>
          <ExSelect value={draft.intervalSec} options={INTERVAL_OPTIONS} onChange={v => set({ intervalSec: v })} ariaLabel="Check every" width={110} />
        </div>
        <div className="ae-setting" id="ae-field-forSec">
          <span className="ae-label">Fire after <InfoTip label="About Fire after">{SETTINGS_HELP.duration}</InfoTip></span>
          <ExSelect value={draft.forSec} options={WAIT_OPTIONS} onChange={v => set({ forSec: v })} ariaLabel="Fire after" width={130} />
        </div>
        <div className="ae-setting" id="ae-field-repeatSec">
          <span className="ae-label">Re-notify every <InfoTip label="About Re-notify every">{SETTINGS_HELP.repeatInterval}</InfoTip></span>
          <ExSelect value={draft.repeatSec} options={REPEAT_OPTIONS} onChange={v => set({ repeatSec: v })} ariaLabel="Re-notify every" width={110} />
        </div>
      </div>

      <div className="ae-field" id="ae-field-name">
        <label className="ae-label" htmlFor={nameId}>Name</label>
        <div className="ae-name-row">
          <input
            id={nameId}
            className={`ae-input wide${problems.name ? ' invalid' : ''}`}
            value={draft.name}
            placeholder="payment-service error rate"
            aria-invalid={problems.name ? true : undefined}
            onChange={e => set({ name: e.target.value })}
          />
          <ExSelect
            value={null}
            options={labelKeys.map(k => ({ value: k, label: k }))}
            placeholder="Insert label"
            ariaLabel="Insert a label into the name"
            disabled={!labelKeys.length}
            searchable={labelKeys.length > 8}
            onChange={(key) => {
              const { draft: next, switched } = insertLabel(draft, key)
              onDraft(next)
              setSwitchedNote(switched)
            }}
            width={150}
          />
        </div>
        {problems.name && <span className="ae-field-problem">{problems.name}</span>}
        {rendered.length > 0 && (
          <p className="ae-hint">
            Reads as {rendered.map((n, i) => <span key={n}>{i ? ', ' : ''}<q>{n}</q></span>)}
            {(series?.length ?? 0) > rendered.length ? ', …' : ''}
          </p>
        )}
        {switchedNote && draft.groupingDisable && (
          <p className="ae-hint">Send switched to one notification per series, so each one carries its own name.</p>
        )}
        {nameIsTemplated(draft) && !draft.groupingDisable && (
          <p className="ae-hint warn">
            A name with labels in it reads right only when each series is notified on its own.{' '}
            <button type="button" className="ae-link" onClick={() => set({ groupingDisable: true })}>Send one per series</button>
          </p>
        )}
        <p className="ae-hint">The environment is added to notification titles whenever the query returns an env label, so don&apos;t add it to the name.</p>
      </div>

      <div className="ae-field" id="ae-field-group">
        <span className="ae-label"><label htmlFor={`${nameId}-group`}>Group</label> <InfoTip label="About Group">{SETTINGS_HELP.group}</InfoTip></span>
        <input
          id={`${nameId}-group`}
          className="ae-input"
          list={`${nameId}-groups`}
          value={draft.group}
          onChange={e => set({ group: e.target.value })}
        />
        <datalist id={`${nameId}-groups`}>
          {groups.map(g => <option key={g} value={g} />)}
        </datalist>
        {newGroup && <span className="ae-hint">A new group, “{draft.group.trim()}”, is created when the rule is saved.</span>}
      </div>

      <div className="ae-field" id="ae-field-tags">
        <span className="ae-label">Tags <InfoTip label="About tags">{SETTINGS_HELP.tags}</InfoTip></span>
        {tags.map((t, i) => (
          <div key={i} className="ae-tag-row" id={`ae-field-tag-${i}`}>
            <input
              className={`ae-input${problems[`tag-${i}`] ? ' invalid' : ''}`}
              placeholder="Key"
              aria-label={`Tag ${i + 1} key`}
              value={t.key}
              onChange={e => set({ tags: tags.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)) })}
            />
            <span aria-hidden="true">=</span>
            <input
              className="ae-input"
              placeholder="Value"
              aria-label={`Tag ${i + 1} value`}
              value={t.value}
              onChange={e => set({ tags: tags.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })}
            />
            <button type="button" className="hbtn icon-only" aria-label={`Remove tag ${t.key || i + 1}`} title="Remove tag" onClick={() => set({ tags: tags.filter((_, j) => j !== i) })}>
              <X aria-hidden="true" />
            </button>
            {problems[`tag-${i}`] && <span className="ae-field-problem">{problems[`tag-${i}`]}</span>}
          </div>
        ))}
        <button type="button" className="ae-link" onClick={() => set({ tags: [...tags, { key: '', value: '' }] })}>
          <Plus aria-hidden="true" />Add tag
        </button>
      </div>

      <div className="ae-field">
        <label className="ae-label" htmlFor={`${nameId}-summary`}>Summary</label>
        <input id={`${nameId}-summary`} className="ae-input wide" value={draft.summary} placeholder={'payment-service is failing {{ printf "%.2f" .Value }}% of requests'} onChange={e => set({ summary: e.target.value })} />
        <span className="ae-hint">One line under the title of every notification, and on the rule&apos;s page. Labels and the value work here too.</span>
      </div>
      <div className="ae-field">
        <label className="ae-label" htmlFor={`${nameId}-description`}>Description</label>
        <textarea id={`${nameId}-description`} className="ae-input wide" rows={2} value={draft.description} onChange={e => set({ description: e.target.value })} />
      </div>
      <div className="ae-field">
        <label className="ae-label" htmlFor={`${nameId}-runbook`}>Runbook</label>
        <input id={`${nameId}-runbook`} className="ae-input wide" type="url" value={draft.runbook} placeholder="https://" onChange={e => set({ runbook: e.target.value })} />
      </div>
    </div>
  )
}
