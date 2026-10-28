import { useId } from 'react'
import { ChevronDown } from 'lucide-react'

/**
 * One of the editor's four numbered sections (docs/alerts/DESIGN.md D6), in
 * production's order: Query & condition, Evaluation & details, Notifications,
 * Mutes & access. Production shows them one at a time as wizard steps, so the
 * name is out of sight while the condition is set; here they stack on one page
 * and a finished one folds to the line that summarises it.
 *
 * The header is one button — the whole row toggles — with the number, the
 * title and, while folded, the summary, so a folded section still says what
 * it holds. `issues` counts what is left to fix inside it.
 */
export default function EditorSection({ n, title, summary, open, onToggle, issues = 0, className, children }) {
  const bodyId = useId()
  return (
    <section className={`ae-section${open ? ' open' : ''}${className ? ` ${className}` : ''}`} aria-label={title}>
      <h2 className="ae-section-head">
        <button type="button" className="ae-section-toggle" aria-expanded={open} aria-controls={bodyId} onClick={onToggle}>
          <span className="ae-section-n" aria-hidden="true">{n}</span>
          <span className="ae-section-title">{title}</span>
          {!open && summary && <span className="ae-section-summary">{summary}</span>}
          {issues > 0 && (
            <span className="ae-section-issues" title={`${issues} thing${issues === 1 ? '' : 's'} to finish here`}>
              {issues} to finish
            </span>
          )}
          <ChevronDown className="ae-section-chev" aria-hidden="true" />
        </button>
      </h2>
      <div id={bodyId} className="ae-section-body" hidden={!open}>
        {children}
      </div>
    </section>
  )
}
