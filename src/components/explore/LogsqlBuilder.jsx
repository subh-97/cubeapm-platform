import { useMemo } from 'react'
import { ExternalLink, Info, RotateCw } from 'lucide-react'
import ExSelect from './ExSelect.jsx'
import FilterRows from './FilterRows.jsx'
import GeneratedQuery from './GeneratedQuery.jsx'
import StatsPipeCard from './StatsPipeCard.jsx'
import MathPipeCard from './MathPipeCard.jsx'
import { buildLogsqlQuery, newLogsqlPipe } from '@/utils/explore/builders'
import { tokenizeLogsql } from '@/utils/explore/logsql'
import './explore-logs.css'

// The row-and-card Builder the reference has (ARCH D11) — STREAM rows, FIELDS
// rows, then pipes — rather than the Logs page's chip query builder. The two
// read nothing alike and solve different problems: the chips are for narrowing
// a log stream you are reading, these rows are for shaping a series you are
// about to plot.
//
// STREAM and FIELDS are the same `FilterRows` the Metrics editor's WHERE rows
// use, with different captions and different catalogues, so the three sections
// share one caption column and one set of controls.

const DOCS_URL = 'https://docs.cubeapm.com/logs/querying?utm_source=cubeapm&utm_medium=in-app&utm_campaign=logs-explorer'

// Two entries, not the 60 of `LOGSQL_PIPES` — `newLogsqlPipe` knows these two
// shapes and the cards below render exactly them. The reference renders this
// control as a permanently blank 280px box with no placeholder (R8); this one
// says what it is.
const PIPE_KINDS = [
  { value: 'stats', label: 'stats', description: 'group rows and aggregate them' },
  { value: 'math', label: 'math', description: 'compute over a stats result' },
]

/**
 * @param {Object} props
 * @param {{type:'builder', streamPairs:Array, labelPairs:Array, pipes:Array}} props.model
 * @param {(model:object) => void} props.onChange
 * @param {{fields:string[], stream:string[], loading:boolean, error:?string, retry:() => void}} props.catalog
 * @param {(index:number, field:string) => Promise<Array>} props.loadStreamValues
 * @param {(index:number, field:string) => Promise<Array>} props.loadFieldValues
 * @param {(text:string, caret:number) => Promise} [props.suggest]  memoised by the caller
 * @param {() => void} [props.onSubmit]
 */
export default function LogsqlBuilder({
  model, onChange, catalog, loadStreamValues, loadFieldValues, suggest, onSubmit, ifPlaceholder,
}) {
  const pipes = model?.pipes ?? []
  const query = useMemo(() => buildLogsqlQuery(model), [model])

  // `type` is restated rather than spread through: an incoming model may be
  // undefined, and the page routes a model to its tab by that key alone.
  const set = patch => onChange?.({ ...model, type: 'builder', ...patch })
  const setPipe = (i, pipe) => set({ pipes: pipes.map((p, j) => (j === i ? pipe : p)) })
  const removePipe = i => set({ pipes: pipes.filter((_, j) => j !== i) })
  // A fresh object every time: the reference appends the catalogue constant
  // itself, so two cards can end up sharing one pipe (R9).
  const addPipe = kind => set({ pipes: [...pipes, newLogsqlPipe(kind)] })

  return (
    <div className="ex-lq-sections">
      <FilterRows
        rows={model?.streamPairs}
        onChange={rows => set({ streamPairs: rows })}
        labelOptions={catalog?.stream ?? []}
        loadValues={loadStreamValues}
        firstCaption="STREAM"
        nextCaption="AND"
        labelPlaceholder="Select stream field"
      />

      <FilterRows
        rows={model?.labelPairs}
        onChange={rows => set({ labelPairs: rows })}
        labelOptions={catalog?.fields ?? []}
        loadValues={loadFieldValues}
        firstCaption="FIELDS"
        nextCaption="AND"
        labelPlaceholder="Select field"
      />

      {/* A field picker that opens empty is indistinguishable from one with
          nothing to offer — the reference's dead end (§5, "Failure, empty and
          loading states"), so both states say which they are. */}
      {catalog?.error ? (
        <div className="ex-lq-note is-error" role="status">
          <span>{catalog.error}</span>
          <button type="button" className="ex-lq-note-btn" onClick={catalog.retry}>
            <RotateCw size={11} strokeWidth={2} aria-hidden="true" />
            Retry
          </button>
        </div>
      ) : catalog?.loading ? (
        <p className="ex-lq-hint" role="status">
          <Info size={12} strokeWidth={2} aria-hidden="true" />
          <span>Loading the field list for this time range…</span>
        </p>
      ) : null}

      <div>
        <div className="ex-lq-pipes-head">
          <span className="ex-row-cap">PIPES</span>
          <a className="ex-lq-docs" href={DOCS_URL} target="_blank" rel="noreferrer">
            docs
            <ExternalLink size={11} strokeWidth={2} aria-hidden="true" />
          </a>
        </div>

        <div className="ex-lq-pipes">
          {pipes.length === 0 && (
            <p className="ex-lq-hint">
              <Info size={12} strokeWidth={2} aria-hidden="true" />
              <span>
                No pipes yet. A graph needs a <code>stats</code> pipe — add one below to count
                or measure the matching rows.
              </span>
            </p>
          )}

          {pipes.map((pipe, i) => (
            // Pipes are positional and cannot be reordered, so the index is
            // what identifies one.
            pipe?.value === 'math'
              ? (
                <MathPipeCard
                  key={i}
                  pipe={pipe}
                  ordinal={i + 1}
                  onChange={p => setPipe(i, p)}
                  onRemove={() => removePipe(i)}
                />
              )
              : (
                <StatsPipeCard
                  key={i}
                  pipe={pipe}
                  ordinal={i + 1}
                  onChange={p => setPipe(i, p)}
                  onRemove={() => removePipe(i)}
                  fieldOptions={catalog?.fields ?? []}
                  suggest={suggest}
                  onSubmit={onSubmit}
                  ifPlaceholder={ifPlaceholder}
                />
              )
          ))}
        </div>

        <div className="ex-lq-add">
          <ExSelect
            value={null}
            options={PIPE_KINDS}
            onChange={addPipe}
            placeholder="Add pipe…"
            ariaLabel="Add pipe"
            width={240}
          />
        </div>
      </div>

      <GeneratedQuery query={query} tokenize={tokenizeLogsql} />
    </div>
  )
}
