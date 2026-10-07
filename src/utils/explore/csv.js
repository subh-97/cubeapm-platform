// CSV export for Explore, in the reference's format so a file downloaded here
// opens the same way as one from the reference: one column per label key
// (sorted, `__name__` included), then `value_<formula>`, every cell quoted.
//
// It exports the COMMITTED query at the current Legend value and nothing else
// the view is doing — Labels, legend search and selection, table search and
// Compare are all ways of looking at the result, not the result.

import { formatLocal } from './format.js'

// Reference `p4e`: always quoted, inner quotes doubled, null/undefined empty.
// Numbers go out as JS prints them — full precision, never the formatted
// `1.23K` the screen shows — so the file is data, not a screenshot of it.
export function csvCell(v) {
  return `"${`${v ?? ''}`.replaceAll('"', '""')}"`
}

/**
 * @param {Array<{ metric: object, value?: number, reduceValue?: number }>} results
 *   in the order they should appear (the API's value-descending order)
 * @param {'last'|'avg'|'sum'} formula
 * @returns {string} '' when there is nothing to export
 */
export function buildCsv(results, formula) {
  if (!results?.length) return ''
  const keys = new Set()
  for (const r of results) for (const k of Object.keys(r.metric || {})) keys.add(k)
  const cols = [...keys].sort()
  const header = [...cols, `value_${formula}`]
  const rows = results.map(r => [
    ...cols.map(k => r.metric?.[k]),
    r.value ?? r.reduceValue,
  ])
  return [header, ...rows].map(row => row.map(csvCell).join(',')).join('\n')
}

/** `cubeapm_explore_20261001_143005.csv`, local time. */
export function csvFilename(name = 'explore', date = new Date()) {
  return `cubeapm_${name.replace(/[^a-zA-Z0-9_.-]/g, '_')}_${formatLocal(date.getTime(), 'yyyyMMdd_HHmmss')}.csv`
}

/**
 * Hands the text to the browser as a download. Nothing to export is not an
 * error, and the reference says nothing about it either — but the caller gets
 * `false` back so it can say "Nothing to export" instead of appearing broken.
 */
export function downloadCsv(text, name = 'explore') {
  if (!text) return false
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8;' }))
  const a = document.createElement('a')
  a.href = url
  a.download = csvFilename(name)
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoking in the same tick can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 0)
  return true
}
