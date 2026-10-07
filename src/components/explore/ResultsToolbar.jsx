// Everything between the Generate Graph row and the result: how to draw it,
// what to call each series, what the numbers mean, and how to take them away.
//
// Four of the reference's bugs are fixed here rather than inherited (ARCH
// D12): the CSV button carries the word "CSV" as well as its arrow, the Stack
// checkbox has a visible label, Stack says in its title why it is disabled
// outside the line view instead of just going grey, and every select is named
// by a <label> rather than by the position it happens to sit in.
//
// None of these controls re-runs the query by itself. Legend value and Compare
// change what is fetched and the page re-runs on them; Labels, Type and Stack
// are display-only (ARCH D2), so they must never cost a round trip.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Download } from 'lucide-react'
import { COMPARE_OPTIONS } from '@/utils/timeRange'
import { buildCsv, downloadCsv } from '@/utils/explore/csv'
import ExSelect from './ExSelect'
import './explore-results.css'

const VIEWS = [
  { value: 'line', label: 'Line' },
  { value: 'table', label: 'Table' },
]

// The reference's Legend value options, in its order and wording.
const FORMULAS = [
  { value: 'last', label: 'Latest' },
  { value: 'avg', label: 'Average' },
  { value: 'sum', label: 'Sum' },
]

// What a value IS, which is what decides how it is written: a count of
// requests and a duration in seconds are both numbers and read nothing alike.
const UNITS = [
  { value: 'number', label: 'Number' },
  { value: 'time', label: 'Time' },
]

const STACK_OFF_REASON = 'Stacking applies to the line chart. Switch to Line to use it.'

// A labelled control, built on the page's shared ExSelect so the toolbar's
// dropdowns behave exactly like the editor's. The word beside it is visible
// AND passed as the control's accessible name: ExSelect's trigger is a button,
// not a <select>, so a wrapping <label> would name nothing.
//
// Labels is searchable past a handful of options — a group-by on `instance`
// can list a hundred keys, and scrolling to one is not finding it.
const SEARCHABLE_FROM = 8

function Field({ label, value, onChange, options, disabled, title }) {
  return (
    <span className="ex-field" title={title}>
      <span className="ex-field-label">{label}</span>
      <ExSelect
        value={value}
        options={options}
        onChange={onChange}
        disabled={disabled}
        ariaLabel={label}
        searchable={options.length >= SEARCHABLE_FROM}
      />
    </span>
  )
}

/**
 * @param {Object} props
 * @param {'line'|'table'} props.view
 * @param {(v:'line'|'table') => void} props.setView
 * @param {string[]} props.labelsSet          label keys seen in the result
 * @param {string} props.legendLabel          '' = all labels
 * @param {(v:string) => void} props.setLegendLabel
 * @param {'last'|'avg'|'sum'} props.formula
 * @param {(v:string) => void} props.setFormula
 * @param {'number'|'time'} props.unit
 * @param {(v:string) => void} props.setUnit
 * @param {boolean} props.stack
 * @param {(v:boolean) => void} props.setStack
 * @param {'off'|'previous'|'day'|'week'} props.compare
 * @param {(v:string) => void} props.setCompare
 * @param {() => (Array|Promise<Array>|void)} props.onCsv
 *   Returns the rows to export — `queryReduced`'s series, highest value first
 *   — and this component writes the file. Returning nothing means the caller
 *   handled the download itself.
 * @param {boolean} [props.csvBusy]           the caller's own busy state
 * @param {number} [props.seriesCount]
 */
export default function ResultsToolbar({
  view, setView, labelsSet = [], legendLabel, setLegendLabel,
  formula, setFormula, unit, setUnit, stack, setStack, compare, setCompare,
  onCsv, csvBusy = false, seriesCount,
}) {
  const [running, setRunning] = useState(false)
  const liveRef = useRef(true)
  useEffect(() => () => { liveRef.current = false }, [])

  const busy = csvBusy || running

  const handleCsv = useCallback(async () => {
    if (!onCsv || busy) return
    setRunning(true)
    try {
      const results = await onCsv()
      // The file carries raw numbers, not the formatted ones on screen, so a
      // spreadsheet can do arithmetic on them (see utils/explore/csv.js).
      if (Array.isArray(results)) downloadCsv(buildCsv(results, formula))
    } finally {
      if (liveRef.current) setRunning(false)
    }
  }, [onCsv, busy, formula])

  const labelOptions = [
    { value: '', label: 'All labels' },
    ...labelsSet.map(k => ({ value: k, label: k })),
  ]
  const stackDisabled = view !== 'line'

  return (
    <div className="ex-toolbar">
      <div className="seg-toggle" role="group" aria-label="Result view">
        {VIEWS.map(v => (
          <button
            key={v.value}
            type="button"
            className={`seg${view === v.value ? ' active' : ''}`}
            aria-pressed={view === v.value}
            onClick={() => setView(v.value)}
          >
            {v.label}
          </button>
        ))}
      </div>

      <Field
        label="Labels"
        value={legendLabel ?? ''}
        onChange={setLegendLabel}
        options={labelOptions}
        title="Which label names each series. All labels uses every key that differs between them."
      />
      <Field
        label="Legend value"
        value={formula}
        onChange={setFormula}
        options={FORMULAS}
        title="How each series is reduced to the one number shown beside it."
      />
      <Field
        label="Type"
        value={unit}
        onChange={setUnit}
        options={UNITS}
        title="How values are written. Time formats seconds as ns / μs / ms / s."
      />

      <label
        className={`ex-check${stackDisabled ? ' is-disabled' : ''}`}
        title={stackDisabled ? STACK_OFF_REASON : 'Stack the series so the bands add up to the total.'}
      >
        <input
          type="checkbox"
          checked={!!stack && !stackDisabled}
          disabled={stackDisabled}
          onChange={e => setStack(e.target.checked)}
        />
        Stack
      </label>

      <Field
        label="Compare"
        value={compare}
        onChange={setCompare}
        options={COMPARE_OPTIONS.map(o => ({ value: o.value, label: o.label }))}
        title="Run the same query over an earlier window and show how far each series has moved."
      />

      <span className="ex-toolbar-spacer" />

      {Number.isFinite(seriesCount) && (
        <span className="ex-count">{seriesCount} series</span>
      )}

      <button
        type="button"
        className="ex-btn"
        onClick={handleCsv}
        disabled={busy || !onCsv}
        title="Download as CSV"
      >
        <Download size={13} strokeWidth={2} aria-hidden="true" />
        {busy ? 'Preparing…' : 'CSV'}
      </button>
    </div>
  )
}
