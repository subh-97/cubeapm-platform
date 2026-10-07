import { useCallback, useRef, useState } from 'react'
import { Plus, X } from 'lucide-react'
import ExSelect from './ExSelect.jsx'
import { MATCH_OPERATORS } from '@/utils/explore/catalogs.js'
import './explore-controls.css'

// The WHERE / AND row editor, shared by the Metrics Quick and Advanced tabs and
// by the Logs and Traces Builder. One row is one matcher: a label, an operator,
// and the value or values it is matched against.
//
// The operator decides the shape of the row, not just its text. `in` and
// `not in` are regex matchers underneath (`=~` / `!~`), so they take a LIST —
// the value select turns multiple. Going back to a single-value operator keeps
// the first value rather than emptying the row: dropping a person's work to
// punish a mis-click is not a correction.
//
// Values are fetched on every open, because what a label can be depends on the
// rows above it and on the time range, both of which move. That is also where
// the reference has a real bug: open a row, open it again before the first
// answer lands, and the earlier, wider list overwrites the newer, narrower one.
// Every request here carries an id, and only the newest id for a row is allowed
// to write — a late answer is dropped, not shown.

const BLANK = { label: '', operator: '=', values: [] }

const isMulti = op => op === '=~' || op === '!~'

const toOptions = list => (list ?? []).map(o => (typeof o === 'string' ? { value: o, label: o } : o))

export default function FilterRows({
  rows,
  onChange,
  labelOptions,
  loadValues,
  firstCaption = 'WHERE',
  nextCaption = 'AND',
  labelPlaceholder = 'Select label',
  valuePlaceholder = 'Select value',
  readOnly = false,
  className,
}) {
  // One entry per row index: what its last value fetch produced.
  const [state, setState] = useState({})
  // The id of the newest request per row index. A response whose id is no
  // longer the row's id is a stale answer and is thrown away.
  const seqRef = useRef(new Map())
  const nextId = useRef(0)

  const list = rows?.length ? rows : [BLANK]

  const commit = (next) => onChange?.(next)

  // Row indices shift when a row is removed, so every cached list and every
  // request in flight stops meaning what it meant. Replacing the id map is what
  // discards the in-flight ones: their id is no longer anybody's id.
  const invalidate = useCallback(() => {
    seqRef.current = new Map()
    setState({})
  }, [])

  const fetchValues = useCallback((index, label) => {
    if (typeof loadValues !== 'function' || !label) return
    const id = ++nextId.current
    seqRef.current.set(index, id)
    setState(s => ({ ...s, [index]: { ...(s[index] ?? {}), loading: true, error: null } }))
    const fresh = () => seqRef.current.get(index) === id
    Promise.resolve()
      .then(() => loadValues(index, label))
      .then(
        (res) => {
          if (!fresh()) return
          setState(s => ({ ...s, [index]: { loading: false, error: null, options: toOptions(res) } }))
        },
        (err) => {
          if (!fresh()) return
          setState(s => ({
            ...s,
            [index]: {
              loading: false,
              error: err?.message || 'Could not load values',
              options: s[index]?.options ?? [],
            },
          }))
        }
      )
  }, [loadValues])

  const setRow = (index, patch) => {
    commit(list.map((r, i) => (i === index ? { ...r, ...patch } : r)))
  }

  const onLabel = (index, label) => {
    // A new label makes the old values meaningless — they belonged to the
    // previous one — so the row starts over rather than carrying them across.
    seqRef.current.delete(index)
    setState(s => ({ ...s, [index]: undefined }))
    setRow(index, { label, values: [] })
  }

  const onOperator = (index, operator) => {
    const row = list[index]
    const was = isMulti(row.operator ?? '=')
    const now = isMulti(operator)
    const values = was && !now ? (row.values ?? []).slice(0, 1) : (row.values ?? [])
    setRow(index, { operator, values })
  }

  const onValues = (index, next) => {
    setRow(index, { values: Array.isArray(next) ? next : (next == null || next === '' ? [] : [next]) })
  }

  const addRow = () => commit([...list, { ...BLANK }])

  const removeRow = (index) => {
    invalidate()
    commit(list.filter((_, i) => i !== index))
  }

  return (
    <div className={['ex-rows', className].filter(Boolean).join(' ')}>
      {list.map((row, i) => {
        const multi = isMulti(row.operator ?? '=')
        const values = row.values ?? []
        const cell = state[i] ?? {}
        // A value already picked must stay visible in the trigger even before
        // the list it came from has been fetched again.
        const known = new Set((cell.options ?? []).map(o => o.value))
        const options = [...(cell.options ?? []), ...values.filter(v => !known.has(v)).map(v => ({ value: v, label: v }))]
        const n = i + 1

        return (
          // Rows are positional — the caption, the fetch cache and the match[]
          // narrowing are all "the row at index i" — so the index is the key.
          <div className="ex-row" key={i}>
            <span className="ex-row-cap">{i === 0 ? firstCaption : nextCaption}</span>

            <ExSelect
              className="ex-row-label"
              value={row.label || null}
              options={toOptions(labelOptions)}
              onChange={v => onLabel(i, v)}
              searchable
              placeholder={labelPlaceholder}
              disabled={readOnly}
              ariaLabel={`Filter ${n} label`}
            />

            <ExSelect
              className="ex-row-op"
              value={row.operator ?? '='}
              options={MATCH_OPERATORS}
              onChange={v => onOperator(i, v)}
              disabled={readOnly}
              ariaLabel={`Filter ${n} operator`}
            />

            <ExSelect
              className="ex-row-val"
              value={multi ? values : (values[0] ?? null)}
              options={options}
              onChange={v => onValues(i, v)}
              multiple={multi}
              searchable
              placeholder={valuePlaceholder}
              onOpen={() => fetchValues(i, row.label)}
              loading={!!cell.loading}
              error={cell.error}
              onRetry={() => fetchValues(i, row.label)}
              disabled={readOnly || !row.label}
              ariaLabel={`Filter ${n} value`}
            />

            {!readOnly && list.length > 1 && (
              <button
                type="button"
                className="ex-row-btn"
                onClick={() => removeRow(i)}
                aria-label={`Remove filter ${n}`}
              >
                <X size={12} strokeWidth={2} aria-hidden="true" />
                Remove
              </button>
            )}

            {!readOnly && i === list.length - 1 && (
              <button type="button" className="ex-row-btn is-add" onClick={addRow}>
                <Plus size={12} strokeWidth={2} aria-hidden="true" />
                Add more
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}
