/**
 * A link into Traces: the chips it arrives as, and the rows it lands on.
 *
 * A link is only worth following if the table it opens has something in it.
 * The Errors page and the service page's Errors tab count exceptions off the
 * error profiles, while the span table is a few hundred seeded rows, so a
 * group's filter (`tracesFiltersFor`) would land on nothing for more than nine
 * groups in ten. The data layer therefore keeps one sample span per error group
 * (`errorSpanRowsForWindow`), and the Traces page merges in the ones a query
 * names the exception of (`errorSamplesFor`); every other query reads the
 * seeded spans alone. The pieces are pure and live here, so the promise "every
 * group's link finds a span" can be tested without mounting the page.
 */

import { errorSpanRowsForWindow } from '@/data/errors'
import { applyChipsToLog } from '@/components/QueryBuilder'
import { flattenLeaves } from '@/utils/queryTree'
import { getSpanFieldValue } from '@/utils/traceFields'

/**
 * The Traces page's chips for a list of `{ field, op?, value }` filters: every
 * leaf an `eq` unless it says otherwise, AND-ed together. This is the shape
 * TracesView's incoming `{ chips }` payload takes.
 */
export function filtersToChips(filters) {
  return (filters ?? [])
    .filter(f => f?.field && f.value != null && f.value !== '')
    .map((f, i) => ({
      field: f.field,
      op: f.op ?? 'eq',
      value: f.value,
      ...(i > 0 ? { connector: 'AND' } : {}),
    }))
}

// The fields an error sample records its exception under. errors.js stamps
// both spellings, so a query written with either one names it.
const EXCEPTION_FIELDS = new Set(['exception.type', 'exception'])

// Leaves that select by leaving a value out. `exception.type != X` is a query
// about every other exception, not a request for anyone's samples.
const EXCLUDING_OPS = new Set(['neq', 'not_in', 'nregex', 'empty'])

const NO_SAMPLES = []

/**
 * The window's error samples a query is about: the ones it finds, and whose
 * exception it names in a leaf of its own.
 *
 * The samples (`errorSpanRowsForWindow`, one span per error group) exist so a
 * link from Errors lands on rows. They are not part of the seeded stream the
 * histogram, the facet rail and the unfiltered table describe. Merged into
 * every view, they took the table's ERROR share from about 6% to 16-23% under
 * a chart still drawing the old share, and put hosts and a version on the rail
 * whose every span failed. So a sample joins only a query that asks for its
 * exception. Every Errors link does (`tracesFiltersFor` always ends on
 * `exception.type`), and so does the same query typed by hand. That way a link
 * and its query text find the same rows, and editing any other chip leaves the
 * samples in reach.
 *
 * The naming leaf has to match the sample on its own, not just the query as a
 * whole: `exception.type = X OR service = payment-service` asks for X's
 * samples, not every payment-service one.
 *
 * Returns one shared empty array when nothing is named, so a page with no such
 * query keeps the seeded stream itself and nothing downstream recomputes.
 */
export function errorSamplesFor(win, chips, getValue = getSpanFieldValue) {
  const named = flattenLeaves(chips).filter(c => EXCEPTION_FIELDS.has(c.field) && !EXCLUDING_OPS.has(c.op))
  if (!named.length) return NO_SAMPLES
  return errorSpanRowsForWindow(win).filter(r =>
    applyChipsToLog(r, chips, getValue) && named.some(c => applyChipsToLog(r, [c], getValue)))
}

/**
 * The window's spans with `extra` merged in, newest first, as one new array —
 * or `rows` itself when there is nothing to merge.
 *
 * Neither input is touched: `extra` is usually a memoised array shared with
 * every other reader of the window. The sort is stable, so on a tie the
 * seeded span keeps its place ahead of the merged one.
 */
export function mergeErrorSpans(rows, extra) {
  if (!extra?.length) return rows
  return [...rows, ...extra].sort((a, b) => b.time - a.time)
}
