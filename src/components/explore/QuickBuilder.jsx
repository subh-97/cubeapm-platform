import { useMemo } from 'react'
import ExSelect from './ExSelect.jsx'
import FilterRows from './FilterRows.jsx'
import GeneratedQuery from './GeneratedQuery.jsx'
import { LABEL_DOCS, QUICK_CALCULATE, QUICK_LABELS } from '@/utils/explore/catalogs'
import { emptyPair, parsePercentile } from '@/utils/explore/builders'
import { tokenizePromql } from '@/utils/explore/promql'
import './explore-metrics.css'

// Quick: the four questions that cover most of what anyone asks a metrics
// backend — how many, how many failed, how slow at the tail, how slow on
// average — with the PromQL they generate shown underneath.
//
// It edits a MODEL and nothing else. `MetricsEditor` turns that model into the
// query through `buildQuickQuery`, so every quirk of the generated text —
// `span_kind` always appended, `default 0`, the special-label split in the
// Error % denominator — lives in one place and is identical to the
// playground's. Nothing here builds a string.
//
// The label list is fixed (`QUICK_LABELS`), not fetched: Quick only ever reads
// the APM metrics, and all of them carry these seven. Only the VALUES are
// looked up, through `loadValues`.

const LABEL_OPTIONS = QUICK_LABELS.map(l => ({
  value: l.label,
  label: l.label,
  description: LABEL_DOCS[l.label],
}))

// GROUP BY offers the same labels without the descriptions — the reference's
// own split, kept because the two pickers answer different questions: WHERE
// asks "what is this label?", GROUP BY asks "which of them do I already know?".
const GROUP_OPTIONS = QUICK_LABELS.map(l => ({ value: l.label, label: l.label }))

export default function QuickBuilder({ model, query, onChange, onSubmit, loadValues }) {
  const calculate = model?.calculate ?? ''
  const percentile = model?.value ?? '90'
  const groupBy = model?.groupBy ?? []
  const rows = useMemo(
    () => (model?.labelPairs?.length ? model.labelPairs : [emptyPair()]),
    [model]
  )

  const needsPercentile = calculate === 'latency_percentile'
  // No bounds: the reference accepts 150 and means it (quantile 1.5). Only
  // "is this a number at all" decides whether a query can be generated.
  const badPercentile = needsPercentile && parsePercentile(percentile) === undefined

  const patch = (changes) => onChange?.({
    type: 'quick',
    calculate,
    value: percentile,
    labelPairs: rows,
    groupBy,
    ...changes,
  })

  // A form with no <form> around it still owes Enter a meaning, and the only
  // one it can have here is the page's Run.
  const onEnter = (e) => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    onSubmit?.()
  }

  return (
    <>
      <div className="ex-met-row">
        <span className="ex-met-cap">Calculate</span>
        <div className="ex-met-ctl">
          <ExSelect
            className="ex-met-calc"
            value={calculate || null}
            options={QUICK_CALCULATE}
            onChange={v => patch({ calculate: v })}
            placeholder="Choose a calculation"
            ariaLabel="Calculate"
          />

          {needsPercentile && (
            <>
              {/* Text, not `type=number`: the value is inserted into the query
                  verbatim, and a number input throws away the intermediate
                  "99." on the way to "99.9". */}
              <input
                className={`ex-met-num${badPercentile ? ' is-invalid' : ''}`}
                type="text"
                inputMode="decimal"
                value={percentile}
                onChange={e => patch({ value: e.target.value })}
                onKeyDown={onEnter}
                aria-label="Percentile"
                aria-invalid={badPercentile || undefined}
                aria-describedby={badPercentile ? 'ex-met-pct-err' : undefined}
                autoComplete="off"
                spellCheck={false}
              />
              <span className="ex-met-suffix" aria-hidden="true">%ile</span>
              {badPercentile && (
                <span className="ex-met-invalid" id="ex-met-pct-err" role="alert">
                  Enter a number, for example 90 or 99.9 — the query stays empty until then.
                </span>
              )}
            </>
          )}
        </div>
      </div>

      <FilterRows
        rows={rows}
        onChange={labelPairs => patch({ labelPairs })}
        labelOptions={LABEL_OPTIONS}
        loadValues={loadValues}
      />

      <div className="ex-met-row">
        <span className="ex-met-cap">Group by</span>
        <div className="ex-met-ctl">
          <ExSelect
            className="ex-met-group"
            value={groupBy}
            options={GROUP_OPTIONS}
            onChange={v => patch({ groupBy: v })}
            multiple
            searchable
            placeholder="No grouping"
            ariaLabel="Group by"
          />
        </div>
      </div>

      <div className="ex-met-row">
        <span className="ex-met-cap" />
        <GeneratedQuery
          query={query}
          tokenize={tokenizePromql}
          empty={calculate ? 'Nothing to run yet' : 'Choose a calculation to build a query'}
        />
      </div>
    </>
  )
}
