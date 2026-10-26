import { Server, HardDrive, Route, ScrollText, Bug, Compass } from 'lucide-react'

const ICONS = { service: Server, host: HardDrive, traces: Route, logs: ScrollText, errors: Bug, explore: Compass }

/**
 * The firing rule's incident banner (D5): the style guide's "surface an
 * active-problem explanation" pattern (`.incident-banner`), with the rule's
 * own sentence — how long, how bad against the threshold it crossed, and the
 * root cause the app already tells — and every way out to the evidence as a
 * labelled button. A warning banner is amber; only a critical one is red.
 *
 * `handoffs` are handoffs.js's `handoffsFor` entries; `onHandoff(entry)`
 * follows one, and `onBlocked(reason)` answers a press on one that is
 * unavailable (Explore on a query its parser cannot read). A rule that is not
 * firing has no banner, and gets the same buttons as a plain row.
 */
export default function RuleBanner({ sentence, severity, handoffs = [], onHandoff, onBlocked }) {
  const actions = handoffs.length > 0 && (
    <div className="alr-banner-actions" role="group" aria-label="Evidence">
      {handoffs.map(h => {
        const Icon = ICONS[h.id]
        return (
          <button
            key={h.id}
            type="button"
            className={`hbtn small${h.disabled ? ' is-inert' : ''}`}
            title={h.title}
            // Unavailable stays visible, with its reason (DESIGN rule 4): a
            // disabled <button> would swallow the hover that shows it.
            aria-disabled={h.disabled || undefined}
            onClick={() => (h.disabled ? onBlocked?.(h.title) : onHandoff?.(h))}
          >
            {Icon && <Icon aria-hidden="true" />}
            {h.label}
          </button>
        )
      })}
    </div>
  )
  // Not firing: no banner, but the ways out stay one click away — Explore is
  // always there (D5), and a resolved or pending rule is investigated too.
  if (!sentence) return actions ? <div className="alr-evidence">{actions}</div> : null
  const warn = severity !== 'critical'
  return (
    <div className={`incident-banner alr-banner${warn ? ' warn' : ''}`} role="status">
      <div className="alr-banner-text">
        <span className={`incident-pulse${warn ? ' warn' : ''}`} aria-hidden="true" />
        <p className="alr-banner-sentence">
          <strong className="incident-title">{sentence.lead}</strong>
          {sentence.reading && <span className="alr-banner-reading"> {sentence.reading}</span>}
          {sentence.cause && <span className="incident-desc alr-banner-cause"> {sentence.cause}</span>}
        </p>
      </div>
      {actions}
    </div>
  )
}
