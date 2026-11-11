import { useId } from 'react'
import { Check } from 'lucide-react'

/**
 * One step of the editor's vertical stepper (docs/alerts/DESIGN.md D6, as
 * revised 2026-11-11), in production's order: Query & condition, Evaluation
 * & details, Notifications, Mutes & access. One step is open at a time, as in
 * production's wizard, but every step's header stays in view with what it
 * holds, any step opens from its header in any order, and the preview stays
 * beside the stepper whichever is open.
 *
 * The header is one button: the step's mark (its number, or a check once it is
 * done), its title and, closed, the line that summarises it; `issues` counts
 * what is left to finish inside it. The open step ends with its own way on
 * (`footer`: Back, Continue, or Save on the last).
 */
export default function EditorStep({ n, of, title, summary, current, done, issues = 0, onOpen, footer, children }) {
  const bodyId = useId()
  return (
    <li className={`ae-step${current ? ' is-current' : ''}${done ? ' is-done' : ''}`}>
      <section aria-label={title}>
        <h2 className="ae-step-head">
          <button
            type="button"
            id={`ae-step-${n}`}
            className="ae-step-toggle"
            aria-expanded={current}
            aria-controls={bodyId}
            aria-current={current ? 'step' : undefined}
            onClick={onOpen}
          >
            <span className="ae-step-mark" aria-hidden="true">{done ? <Check /> : n}</span>
            <span className="sr-only">{`Step ${n} of ${of}${done ? ', done' : ''}: `}</span>
            <span className="ae-step-title">{title}</span>
            {!current && summary && <span className="ae-step-summary">{summary}</span>}
            {issues > 0 && <span className="ae-step-issues">{issues} to finish</span>}
          </button>
        </h2>
        <div id={bodyId} className="ae-step-body" hidden={!current}>
          {children}
          {footer && <div className="ae-step-foot">{footer}</div>}
        </div>
      </section>
    </li>
  )
}
