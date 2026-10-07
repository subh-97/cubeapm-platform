// The Explore result as a table: one row per distinct label text, the value
// under the current Legend value, and — while Compare is on — what it was and
// how far it has moved.
//
// The row model, the merge rule, the sort order and the 20-row limit are all
// decided in utils/explore/series.js; this file renders them and owns the
// three pieces of state that are nobody else's business: the search text, the
// sort column, and whether "Show all" has been pressed. They stay local
// because nothing outside the table reads them — unlike the legend's search,
// which also decides which lines the chart draws and therefore belongs to the
// page.
//
// The search field is the SearchQL one (utils/explore/searchQuery.js), drawn
// with the ink-layer technique from components/TableQuerySearch.jsx: the input
// holds the caret with transparent text, and a layer beneath it holds the
// colour. Every metric shared between the two has to match or the two copies
// of the text drift apart as you type.

import { useEffect, useMemo, useRef, useState } from 'react'
import { clsx } from 'clsx'
import { DEFAULT_TABLE_SORT, searchValues, tableView, toggleSort } from '@/utils/explore/series'
import { segmentSearch, suggestSearch } from '@/utils/explore/searchQuery'
import { formatValue } from '@/utils/explore/format'
import ValueSparkPopover from './ValueSparkPopover'
import './explore-results.css'

const SEARCH_PLACEHOLDER = 'Filter rows — e.g. label:cart OR "gateway"'

// ---------------------------------------------------------------- search box

function SearchField({ value, onChange, values }) {
  const [caret, setCaret] = useState(0)
  const [focused, setFocused] = useState(false)
  const [active, setActive] = useState(0)
  // Escape closes the list without clearing the query; typing brings it back.
  const [dismissed, setDismissed] = useState(false)
  const inputRef = useRef(null)
  const inkRef = useRef(null)
  const listRef = useRef(null)

  const segments = useMemo(() => segmentSearch(value), [value])
  const suggest = useMemo(
    () => suggestSearch({ text: value, cursor: caret, values }),
    [value, caret, values],
  )

  useEffect(() => { setActive(0); setDismissed(false) }, [value])

  const open = focused && !dismissed && suggest.items.length > 0
  const activeIdx = Math.min(active, suggest.items.length - 1)

  useEffect(() => {
    if (!open) return
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [open, activeIdx])

  // Replaces only the fragment the caret is in, so a suggestion can be taken
  // in the middle of an expression.
  const apply = (item) => {
    const next = `${value.slice(0, suggest.from)}${item.insertText}${value.slice(suggest.to)}`
    const pos = suggest.from + item.insertText.length
    onChange(next)
    window.requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.setSelectionRange(pos, pos)
      setCaret(pos)
    })
  }

  // The ink layer does not scroll itself, so it follows the input once the
  // text is longer than the field.
  const syncScroll = () => {
    if (inkRef.current && inputRef.current) inkRef.current.scrollLeft = inputRef.current.scrollLeft
  }

  return (
    <div className="ex-search-wrap">
      <div className="svc-search ex-search-field">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" />
        </svg>

        <div className="ex-search-ink-wrap">
          <div className="ex-search-ink" ref={inkRef} aria-hidden="true">
            {segments.map((seg, i) => (
              <span key={i} className={`ex-ink-${seg.type}`}>{seg.text}</span>
            ))}
          </div>
          <input
            ref={inputRef}
            type="text"
            value={value}
            role="combobox"
            aria-expanded={open}
            aria-controls="ex-table-suggest"
            aria-activedescendant={open ? `ex-table-suggest-${activeIdx}` : undefined}
            aria-autocomplete="list"
            aria-label={SEARCH_PLACEHOLDER}
            placeholder={SEARCH_PLACEHOLDER}
            spellCheck={false}
            autoComplete="off"
            onChange={e => { onChange(e.target.value); setCaret(e.target.selectionStart ?? e.target.value.length) }}
            onSelect={e => setCaret(e.target.selectionStart ?? 0)}
            onScroll={syncScroll}
            onFocus={e => { setFocused(true); setCaret(e.target.selectionStart ?? 0) }}
            onBlur={() => setFocused(false)}
            onKeyDown={e => {
              // The overlay takes the arrows and Enter only while it is open,
              // so no key changes meaning under you while it is not.
              if (open) {
                if (e.key === 'ArrowDown') { e.preventDefault(); setActive(i => (i + 1) % suggest.items.length); return }
                if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => (i - 1 + suggest.items.length) % suggest.items.length); return }
                if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); apply(suggest.items[activeIdx]); return }
                if (e.key === 'Escape') { e.preventDefault(); setDismissed(true); return }
              }
              if (e.key === 'Escape') onChange('')
            }}
          />
        </div>

        {value && (
          <button
            type="button"
            className="svc-search-clear"
            onClick={() => { onChange(''); inputRef.current?.focus() }}
            title="Clear the row filter"
            aria-label="Clear the row filter"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        )}
      </div>

      {open && (
        <div className="ex-suggest" id="ex-table-suggest" role="listbox" ref={listRef} aria-label="Search suggestions">
          {suggest.items.map((item, i) => (
            <button
              key={`${item.kind}:${item.label}`}
              id={`ex-table-suggest-${i}`}
              type="button"
              role="option"
              aria-selected={i === activeIdx}
              data-active={i === activeIdx}
              className={clsx('ex-suggest-item', { 'is-active': i === activeIdx })}
              onMouseEnter={() => setActive(i)}
              onMouseDown={e => { e.preventDefault(); apply(item) }}
            >
              <span>{item.label}</span>
              <span className="ex-suggest-kind">{item.kind}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ headers

// Label sorts A→Z unreversed; a numeric column sorts high to low unreversed,
// because the first thing anyone wants from a Value column is the top of it.
function direction(sort, col) {
  if (sort.col !== col) return null
  return (col === 'label' ? !sort.reversed : sort.reversed) ? 'ascending' : 'descending'
}

// Module level, not nested in ExploreTable: a component redefined on every
// render is a new type every render, so React would remount the header and
// drop focus from the very button that was just pressed.
function SortHeader({ col, label, className, sort, onSort }) {
  const dir = direction(sort, col)
  return (
    <th className={className} aria-sort={dir || 'none'}>
      <button type="button" className="ex-sort" onClick={() => onSort(col)} title={`Sort by ${label}`}>
        {label}
        {dir && <span className="ex-sort-arrow" aria-hidden="true">{dir === 'ascending' ? '▲' : '▼'}</span>}
      </button>
    </th>
  )
}

// -------------------------------------------------------------------- table

/**
 * @param {Object} props
 * @param {import('@/utils/explore/series').TableRow[]} props.rows  buildTableRows(...)
 * @param {'number'|'time'} [props.unit]
 * @param {boolean} [props.comparing]   adds the Previous and Change columns
 * @param {string} [props.compareLabel] e.g. "vs previous period"
 * @param {string|number} [props.resetKey]
 *   changing it clears the search, the sort and the row limit. Pass the
 *   committed query's identity, NOT the run id — a refresh that returns the
 *   same query's rows should not throw away the sort you were reading them in.
 * @param {'idle'|'loading'|'ready'|'empty'|'error'} [props.status]
 * @param {boolean} [props.stale]
 * @param {string} [props.emptyHint]
 */
export default function ExploreTable({
  rows = [], unit = 'number', comparing = false, compareLabel = '',
  resetKey = '', status = 'ready', stale = false, emptyHint,
}) {
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState(DEFAULT_TABLE_SORT)
  const [limitOn, setLimitOn] = useState(true)
  const [spark, setSpark] = useState(null)

  useEffect(() => {
    setSearch('')
    setSort(DEFAULT_TABLE_SORT)
    setLimitOn(true)
    setSpark(null)
  }, [resetKey])

  const values = useMemo(() => searchValues(rows), [rows])
  const view = useMemo(() => tableView({ rows, search, sort, limitOn }), [rows, search, sort, limitOn])

  const sortBy = (col) => { setSort(s => toggleSort(s, col)); setSpark(null) }

  const openSpark = (e, row) => {
    if (!row.series?.values?.length) return
    setSpark({ key: row.key, rect: e.currentTarget.getBoundingClientRect(), row })
  }

  if (!rows.length) {
    return (
      <div className="ex-table-wrap">
        <div className="ex-empty">
          <div className="ex-empty-title">
            {status === 'idle' ? 'Nothing to show yet'
              : status === 'loading' ? 'Running query…'
                : 'The query returned no series'}
          </div>
          <div className="ex-empty-hint">
            {emptyHint ?? (status === 'idle'
              ? 'Build a query above and press Generate Graph.'
              : 'Nothing matched in this window. Widen the time range, drop a filter, or check the metric name.')}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="ex-table-wrap" aria-busy={status === 'loading'}>
      <div className="ex-table-head">
        <SearchField value={search} onChange={v => { setSearch(v); setSpark(null) }} values={values} />
      </div>

      <div className={clsx('ex-table-scroll', { 'ex-stale': stale })} onScroll={() => setSpark(null)}>
        <table className="agg-table ex-table">
          <thead>
            <tr>
              <SortHeader col="label" label="Label" className="agg-th-group ex-th-label" sort={sort} onSort={sortBy} />
              <SortHeader col="value" label="Value" className="agg-th-num" sort={sort} onSort={sortBy} />
              {comparing && <SortHeader col="prev" label="Previous" className="agg-th-num" sort={sort} onSort={sortBy} />}
              {comparing && <SortHeader col="change" label="Change" className="agg-th-num" sort={sort} onSort={sortBy} />}
            </tr>
          </thead>
          <tbody>
            {view.rows.map(row => (
              <tr key={row.key}>
                <td className="agg-td-group ex-td-label" title={row.label}>
                  {row.label || '-'}
                  {row.merged > 1 && (
                    <span className="ex-td-merged" title={`${row.merged} series share this label; the table shows the last of them.`}>
                      ×{row.merged}
                    </span>
                  )}
                </td>
                <td
                  className={clsx('ex-td-val', { 'has-spark': !!row.series?.values?.length })}
                  onMouseEnter={e => openSpark(e, row)}
                  onMouseLeave={() => setSpark(null)}
                >
                  {formatValue(row.value, unit)}
                </td>
                {comparing && <td className="ex-td-val">{formatValue(row.prevValue, unit)}</td>}
                {comparing && (
                  <td className="ex-td-val">
                    {row.delta && (
                      <span className="ex-delta" data-dir={row.delta.dir} title={compareLabel ? `${row.delta.text} ${compareLabel}` : undefined}>
                        {row.delta.text}
                      </span>
                    )}
                  </td>
                )}
              </tr>
            ))}
            {!view.rows.length && (
              <tr>
                <td className="agg-td-group ex-td-label" colSpan={comparing ? 4 : 2}>
                  No rows match this search.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="ex-table-foot">
        {/* "of" counts the rows the SEARCH left, not every row in the result —
            the reference counts all of them, which makes the footer disagree
            with the table above it (ARCH D9). */}
        {view.limited ? (
          <>
            <span>Showing {view.rows.length} of {view.total}</span>
            <button type="button" className="ex-link" onClick={() => setLimitOn(false)} title="List every row, however many there are">
              Show all
            </button>
          </>
        ) : (
          <span>{view.total} row{view.total === 1 ? '' : 's'}</span>
        )}
        {view.total !== view.allCount && <span>· filtered from {view.allCount}</span>}
      </div>

      {spark && (
        <ValueSparkPopover
          anchor={spark.rect}
          points={spark.row.series.values}
          label={spark.row.label || '-'}
          unit={unit}
        />
      )}
    </div>
  )
}
