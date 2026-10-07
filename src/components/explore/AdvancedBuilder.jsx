import { useCallback, useEffect, useMemo, useState } from 'react'
import { X } from 'lucide-react'
import ExSelect from './ExSelect.jsx'
import FilterRows from './FilterRows.jsx'
import GeneratedQuery from './GeneratedQuery.jsx'
import { metricLabelNames, metricNames } from '@/utils/explore/api'
import { advancedMatchFor, emptyPair, newOperation } from '@/utils/explore/builders'
import { ADVANCED_OPERATIONS, FUNCTION_DOCS, LABEL_DOCS, METRIC_DOCS } from '@/utils/explore/catalogs'
import { tokenizePromql } from '@/utils/explore/promql'
import './explore-metrics.css'

// Advanced: pick a metric, narrow it, then wrap it in operations — the long
// way round that Quick's four calculations are shorthand for.
//
// Like Quick it edits a MODEL only; `MetricsEditor` runs it through
// `buildAdvancedQuery`. The reference's two MetricsQL affordances live there
// and are deliberate, not oversights: a range function carries no `[window]`
// (the server supplies one from the step) and a metric name containing a dot
// is emitted bare. Neither is legal Prometheus; both are legal MetricsQL, which
// is what CubeAPM speaks.
//
// Unlike Quick, this tab does not know its vocabulary in advance. The metric
// list and the chosen metric's label names are fetched, scoped to the chart's
// own window — a label that only exists outside the window is not an option —
// so both are state with a loading, an error and a retry. The reference has
// none of the three: a failed lookup there is a toast and a dropdown that is
// indistinguishable from "nothing to choose" (ARCH D12, reference bug R8).

// The default FROM list. The backend carries hundreds of metrics; six of them
// are what an APM question is actually asked of, so they are what is offered
// until someone asks for the rest.
const APM_PREFIX = 'cube_apm_'

// Flattened once: ExSelect draws a header each time `group` changes, and the
// catalogue is already in picker order.
const OPERATION_OPTIONS = ADVANCED_OPERATIONS.flatMap(group => group.options.map(op => ({
  value: op.value,
  label: op.value,
  group: group.label,
  description: FUNCTION_DOCS[op.value],
})))

const OPERATION_BY_VALUE = new Map(
  ADVANCED_OPERATIONS.flatMap(group => group.options.map(op => [op.value, op]))
)

/** `{loading, error, list}` for a metadata fetch that has not started yet. */
const IDLE = { loading: false, error: null, list: [] }

export default function AdvancedBuilder({ model, query, onChange, onSubmit, loadValues, start, end }) {
  const metric = model?.metric ?? ''
  const functions = useMemo(() => model?.functions ?? [], [model])
  const rows = useMemo(
    () => (model?.labelPairs?.length ? model.labelPairs : [emptyPair()]),
    [model]
  )

  // Whether the FROM list is the whole backend or just the APM metrics. A view
  // setting, not part of the query, so it stays out of the model — and turning
  // it off never clears a selection made while it was on.
  const [showAll, setShowAll] = useState(false)

  const [metrics, setMetrics] = useState(IDLE)
  const [labels, setLabels] = useState(IDLE)
  // Bumped by Retry. A nonce rather than a direct call so the one effect below
  // stays the only place that fetches, aborts and writes.
  const [metricNonce, setMetricNonce] = useState(0)
  const [labelNonce, setLabelNonce] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setMetrics(s => ({ ...s, loading: true, error: null }))
    metricNames({ start, end, signal: controller.signal }).then(
      (list) => {
        if (controller.signal.aborted) return
        setMetrics({ loading: false, error: null, list })
      },
      (err) => {
        if (controller.signal.aborted) return
        setMetrics({ loading: false, error: err?.message || 'Could not load metrics', list: [] })
      }
    )
    return () => controller.abort()
  }, [start, end, metricNonce])

  useEffect(() => {
    if (!metric) {
      setLabels(IDLE)
      return undefined
    }
    const controller = new AbortController()
    setLabels(s => ({ ...s, loading: true, error: null }))
    // Row 0's narrowing is the metric alone, which is exactly the selector the
    // label names of this metric are asked for.
    metricLabelNames({ match: advancedMatchFor(metric, [], 0), start, end, signal: controller.signal }).then(
      (list) => {
        if (controller.signal.aborted) return
        setLabels({ loading: false, error: null, list })
      },
      (err) => {
        if (controller.signal.aborted) return
        setLabels({ loading: false, error: err?.message || 'Could not load labels', list: [] })
      }
    )
    return () => controller.abort()
  }, [metric, start, end, labelNonce])

  const metricOptions = useMemo(() => {
    const visible = showAll ? metrics.list : metrics.list.filter(n => n.startsWith(APM_PREFIX))
    // A metric chosen with Show all on must stay readable after it is turned
    // off, so the current selection is always in its own list.
    const names = !metric || visible.includes(metric) ? visible : [metric, ...visible]
    return names.map(n => ({ value: n, label: n, description: METRIC_DOCS[n] }))
  }, [metric, metrics.list, showAll])

  const labelOptions = useMemo(
    () => labels.list.map(l => ({ value: l, label: l, description: LABEL_DOCS[l] })),
    [labels.list]
  )

  // The group-by picker on an aggregation card offers the same names without
  // the help text — the reference's own split, and the right one: by the time
  // someone is grouping they have already read what the label is.
  const groupOptions = useMemo(() => labels.list.map(l => ({ value: l, label: l })), [labels.list])

  const patch = useCallback(changes => onChange?.({
    type: 'advanced',
    metric,
    labelPairs: rows,
    functions,
    ...changes,
  }), [functions, metric, onChange, rows])

  const addOperation = (value) => {
    const option = OPERATION_BY_VALUE.get(value)
    if (!option) return
    patch({ functions: [...functions, newOperation(option)] })
  }

  const removeOperation = (index) => patch({ functions: functions.filter((_, i) => i !== index) })

  const setArg = (fnIndex, argIndex, value) => patch({
    functions: functions.map((fn, i) => (i === fnIndex
      ? { ...fn, args: fn.args.map((arg, j) => (j === argIndex ? { ...arg, value } : arg)) }
      : fn)),
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
        <span className="ex-met-cap">From</span>
        <div className="ex-met-ctl">
          <ExSelect
            className="ex-met-metric"
            value={metric || null}
            options={metricOptions}
            onChange={v => patch({ metric: v })}
            searchable
            placeholder="Choose a metric"
            ariaLabel="Metric"
            loading={metrics.loading}
            error={metrics.error}
            onRetry={() => setMetricNonce(n => n + 1)}
          />

          <label className="ex-met-check">
            <input
              type="checkbox"
              checked={showAll}
              onChange={e => setShowAll(e.target.checked)}
            />
            Show all metrics
          </label>

          {!metrics.loading && !metrics.error && !metricOptions.length && (
            <span className="ex-met-note">
              {metrics.list.length
                ? 'No cube_apm_ metrics in this time range — turn on Show all metrics.'
                : 'No metrics reported anything in this time range.'}
            </span>
          )}
        </div>
      </div>

      {/* Read-only until a metric is chosen. Every label these rows could
          offer is a label OF that metric, so before one is picked the list is
          empty and the reference's rows are present but inert — a control that
          looks live and answers nothing. Disabled says the same thing
          honestly, and the placeholder says what to do about it. */}
      <FilterRows
        rows={rows}
        onChange={labelPairs => patch({ labelPairs })}
        labelOptions={labelOptions}
        loadValues={loadValues}
        labelPlaceholder={metric ? 'Select label' : 'Choose a metric first'}
        readOnly={!metric}
      />

      {metric && labels.error && (
        <div className="ex-met-row">
          <span className="ex-met-cap" />
          <p className="ex-met-note" role="alert">
            {labels.error}{' '}
            <button type="button" className="ex-met-link" onClick={() => setLabelNonce(n => n + 1)}>
              Retry
            </button>
          </p>
        </div>
      )}

      <div className="ex-met-row">
        <span className="ex-met-cap">Select</span>
        <div className="ex-met-ctl is-column">
          {functions.map((fn, i) => {
            const doc = FUNCTION_DOCS[fn.value]
            return (
              // Operations are addressed by position everywhere — they apply in
              // insertion order and there is no reordering — so the index is
              // the key, and two `rate`s in a row do not collide.
              <div className="ex-met-op" key={i}>
                <div className="ex-met-op-head">
                  <span className="ex-met-op-step">Step {i + 1}</span>
                  <span className="ex-met-op-name">{fn.value}</span>
                  <button
                    type="button"
                    className="ex-met-op-del"
                    onClick={() => removeOperation(i)}
                    aria-label={`Remove operation ${i + 1}, ${fn.value}`}
                  >
                    <X size={12} strokeWidth={2} aria-hidden="true" />
                    Remove
                  </button>
                </div>

                {/* The reference hides this behind an info icon. Shown, it
                    costs one muted line and answers "what does deriv do?"
                    without a hover (CLAUDE.md rule 4). */}
                {doc && <p className="ex-met-op-doc">{doc}</p>}

                {!!fn.args?.length && (
                  <div className="ex-met-op-args">
                    {fn.args.map((arg, j) => (
                      <div className="ex-met-arg" key={j}>
                        <span className="ex-met-arg-cap">
                          {arg.type === 'aggregation' ? 'Group by' : (arg.label || 'Value')}
                        </span>
                        <div className="ex-met-arg-ctl">
                          {arg.type === 'aggregation' ? (
                            <>
                              <ExSelect
                                value={Array.isArray(arg.value) ? arg.value : []}
                                options={groupOptions}
                                onChange={v => setArg(i, j, v)}
                                multiple
                                searchable
                                placeholder="No grouping"
                                disabled={!metric}
                                loading={labels.loading}
                                error={labels.error}
                                onRetry={() => setLabelNonce(n => n + 1)}
                                ariaLabel={`${fn.value} group by`}
                              />
                              {/* The reference renders nothing at all here
                                  until a metric is chosen, leaving an empty
                                  card body. Saying why is cheaper than
                                  guessing. */}
                              {!metric && (
                                <span className="ex-met-note">Choose a metric to list its labels.</span>
                              )}
                            </>
                          ) : (
                            // Text, not `type=number`: the value is inserted
                            // into the query verbatim, and a number input
                            // throws away the intermediate "0." on the way
                            // to "0.95".
                            <input
                              className="ex-met-num"
                              type="text"
                              inputMode="decimal"
                              value={arg.value ?? ''}
                              onChange={e => setArg(i, j, e.target.value)}
                              onKeyDown={onEnter}
                              aria-label={`${fn.value} ${arg.label || 'value'}`}
                              autoComplete="off"
                              spellCheck={false}
                            />
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}

          <div className="ex-met-ops-add">
            <ExSelect
              className="ex-met-add"
              // Always a placeholder: the picker is an action, not a setting —
              // the operation it adds becomes a card. The reference leaves the
              // literal `* ` sitting in the closed control instead (bug R10).
              value={null}
              options={OPERATION_OPTIONS}
              onChange={addOperation}
              searchable
              placeholder={functions.length ? 'Add another operation' : 'Add an operation'}
              ariaLabel="Add operation"
            />
            {!functions.length && (
              <span className="ex-met-note">
                Without one the query is the raw metric — every series, as stored.
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="ex-met-row">
        <span className="ex-met-cap" />
        <GeneratedQuery
          query={query}
          tokenize={tokenizePromql}
          empty={metric ? 'Nothing to run yet' : 'Choose a metric to build a query'}
        />
      </div>
    </>
  )
}
