import { X } from 'lucide-react'
import './explore-logs.css'

// A `| math` pipe: one expression over the columns a `stats` pipe produced,
// and the name to give the result.
//
// The expression is free text in the reference and free text here. It is
// arithmetic over aliases that only exist once the query has run — `errors /
// requests * 100` is meaningless until something named `errors` and
// `requests` exists — so there is nothing to offer in a picker and nothing to
// check against until then. `buildLogsqlQuery` drops an empty one rather than
// emitting the reference's stray `* ` (R3).

/**
 * @param {Object} props
 * @param {{value:'math', expr:string, alias:string}} props.pipe
 * @param {number} props.ordinal        1-based position, for accessible names
 * @param {(pipe:object) => void} props.onChange
 * @param {() => void} props.onRemove
 */
export default function MathPipeCard({ pipe, ordinal = 1, onChange, onRemove }) {
  const set = patch => onChange?.({ ...pipe, ...patch })

  return (
    <div className="ex-lq-card">
      <div className="ex-lq-card-head">
        <span className="ex-lq-card-name">math</span>
        <button
          type="button"
          className="ex-lq-card-x"
          onClick={onRemove}
          title={`Remove math pipe ${ordinal}`}
          aria-label={`Remove math pipe ${ordinal}`}
        >
          <X size={12} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>

      <div className="ex-lq-card-body">
        <div className="ex-lq-agg">
          <span className="ex-lq-field is-grow">
            <span className="ex-lq-field-lbl">expression</span>
            <input
              className="ex-lq-input is-expr"
              value={pipe.expr ?? ''}
              onChange={e => set({ expr: e.target.value })}
              placeholder="e.g. errors / requests * 100"
              aria-label={`expression (math pipe ${ordinal})`}
              spellCheck={false}
              autoComplete="off"
            />
          </span>

          <span className="ex-lq-field is-wide">
            <span className="ex-lq-field-lbl">as</span>
            <input
              className="ex-lq-input"
              value={pipe.alias ?? ''}
              onChange={e => set({ alias: e.target.value })}
              placeholder="result name"
              aria-label={`as (math pipe ${ordinal} result name)`}
              spellCheck={false}
              autoComplete="off"
            />
          </span>
        </div>
      </div>
    </div>
  )
}
