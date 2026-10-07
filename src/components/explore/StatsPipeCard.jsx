import { Plus, X } from 'lucide-react'
import ExSelect from './ExSelect.jsx'
import CodeEditor from './CodeEditor.jsx'
import { LOGS_STATS_FUNCTIONS } from '@/utils/explore/catalogs'
import { newStatsAgg, withStatsFunction } from '@/utils/explore/builders'
import { tokenizeLogsql } from '@/utils/explore/logsql'
import './explore-logs.css'

// A `| stats` pipe: what the rows are grouped by, and one row per aggregate —
// the function, its arguments, an optional `if` filter that narrows the rows
// THAT aggregate sees, and the name the column gets.
//
// The function list is `LOGS_STATS_FUNCTIONS` (nine entries), not the 25-name
// `LOGSQL_STATS_FUNCTIONS` the Code tab completes from. The reference's builder
// reaches only these nine too, and `withStatsFunction` knows how to re-seed the
// arguments for exactly these; feeding it the longer list would offer functions
// whose argument shapes nothing here can render.
//
// The reference hides every `_`-prefixed field from this card. We do not
// (reference note, divergence 10): `count(_msg)` and `stats by ("_stream")` are
// real queries, and the Code tab on the same page already offers them.

const FN_OPTIONS = LOGS_STATS_FUNCTIONS.map(f => ({ value: f.value, label: f.value }))
const SPEC = Object.fromEntries(LOGS_STATS_FUNCTIONS.map(f => [f.value, f]))

// A field argument can legitimately be empty — `count()` counts rows rather
// than non-empty values of something — so the picker has to be able to get
// back to empty. The reference's `allowClear` is this row.
const NO_FIELD = { value: '', label: '(none)', description: 'count every row' }

/**
 * @param {Object} props
 * @param {{value:'stats', by:string[], aggs:Array<{fn:string,args:string[],filter:string,alias:string}>}} props.pipe
 * @param {number} props.ordinal                   1-based position, for accessible names
 * @param {(pipe:object) => void} props.onChange
 * @param {() => void} props.onRemove
 * @param {Array<string|{value:string}>} props.fieldOptions   the field-name catalogue
 * @param {(text:string, caret:number) => Promise} [props.suggest]  memoised by the caller
 * @param {() => void} [props.onSubmit]            Enter in an `if` filter runs the query
 */
export default function StatsPipeCard({
  pipe, ordinal = 1, onChange, onRemove, fieldOptions = [], suggest, onSubmit,
  // The example filter is worth getting right per datasource: a span has no
  // `level`, so the logs example would be teaching the wrong vocabulary.
  ifPlaceholder = 'level:="error"',
}) {
  // An incoming model may carry a stats pipe with no aggregates; the card
  // always shows one, and `buildLogsqlQuery` substitutes the same default.
  const aggs = pipe.aggs?.length ? pipe.aggs : [newStatsAgg()]

  const setAggs = next => onChange?.({ ...pipe, aggs: next })
  const setAgg = (i, agg) => setAggs(aggs.map((a, j) => (j === i ? agg : a)))

  return (
    <div className="ex-lq-card">
      <div className="ex-lq-card-head">
        <span className="ex-lq-card-name">stats</span>
        <button
          type="button"
          className="ex-lq-card-x"
          onClick={onRemove}
          title={`Remove stats pipe ${ordinal}`}
          aria-label={`Remove stats pipe ${ordinal}`}
        >
          <X size={12} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>

      <div className="ex-lq-card-body">
        <div className="ex-lq-agg">
          <span className="ex-lq-field is-grow">
            <span className="ex-lq-field-lbl">group by</span>
            <ExSelect
              value={pipe.by ?? []}
              options={fieldOptions}
              onChange={by => onChange?.({ ...pipe, by })}
              multiple
              searchable
              placeholder="Whole result"
              ariaLabel={`group by (stats pipe ${ordinal})`}
            />
          </span>
        </div>

        {aggs.map((agg, i) => {
          const n = i + 1
          const args = SPEC[agg.fn]?.args ?? []
          return (
            // Aggregates are positional — the index is what "this row" means to
            // every handler above — so the index is the key.
            <div className="ex-lq-agg" key={i}>
              <span className="ex-lq-field is-wide">
                <span className="ex-lq-field-lbl">function</span>
                <ExSelect
                  value={agg.fn}
                  options={FN_OPTIONS}
                  onChange={fn => setAgg(i, withStatsFunction(agg, fn))}
                  searchable
                  ariaLabel={`function ${n} (stats pipe ${ordinal})`}
                />
              </span>

              {args.map((spec, ai) => (
                <span className="ex-lq-field is-wide" key={spec.label}>
                  <span className="ex-lq-field-lbl">{spec.label}</span>
                  {spec.type === 'field' ? (
                    <ExSelect
                      value={agg.args?.[ai] ?? ''}
                      options={[NO_FIELD, ...fieldOptions]}
                      onChange={v => setAgg(i, {
                        ...agg,
                        args: (agg.args ?? []).map((a, j) => (j === ai ? (v ?? '') : a)),
                      })}
                      searchable
                      placeholder="Select field"
                      ariaLabel={`${spec.label} of function ${n} (stats pipe ${ordinal})`}
                    />
                  ) : (
                    <input
                      className="ex-lq-input is-num"
                      type="number"
                      step="any"
                      value={agg.args?.[ai] ?? spec.default ?? ''}
                      onChange={e => setAgg(i, {
                        ...agg,
                        args: (agg.args ?? []).map((a, j) => (j === ai ? e.target.value : a)),
                      })}
                      aria-label={`${spec.label} of function ${n} (stats pipe ${ordinal})`}
                    />
                  )}
                </span>
              ))}

              <span className="ex-lq-field is-grow">
                <span className="ex-lq-field-lbl">if</span>
                <CodeEditor
                  className="ex-lq-if"
                  value={agg.filter ?? ''}
                  onChange={v => setAgg(i, { ...agg, filter: v })}
                  tokenize={tokenizeLogsql}
                  suggest={suggest}
                  onSubmit={onSubmit}
                  placeholder={ifPlaceholder}
                  minRows={1}
                  maxRows={3}
                  ariaLabel={`if filter for function ${n} (stats pipe ${ordinal})`}
                />
              </span>

              <span className="ex-lq-field is-wide">
                <span className="ex-lq-field-lbl">as</span>
                <input
                  className="ex-lq-input"
                  value={agg.alias ?? ''}
                  onChange={e => setAgg(i, { ...agg, alias: e.target.value })}
                  placeholder="column name"
                  aria-label={`as (function ${n} column name, stats pipe ${ordinal})`}
                  spellCheck={false}
                  autoComplete="off"
                />
              </span>

              {aggs.length > 1 && (
                <button
                  type="button"
                  className="ex-row-btn"
                  onClick={() => setAggs(aggs.filter((_, j) => j !== i))}
                  aria-label={`Remove function ${n} from stats pipe ${ordinal}`}
                >
                  <X size={12} strokeWidth={2} aria-hidden="true" />
                  Remove
                </button>
              )}

              {i === aggs.length - 1 && (
                <button
                  type="button"
                  className="ex-row-btn is-add"
                  onClick={() => setAggs([...aggs, newStatsAgg()])}
                >
                  <Plus size={12} strokeWidth={2} aria-hidden="true" />
                  Add function
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
