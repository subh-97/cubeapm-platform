// How many series one chart draws before it holds the rest back.
//
// A page can carry many multi-series charts at once, and an SVG chart's cost is
// lines × points: a fleet chart of 64 hosts is 64 paths, rebuilt on every
// hover of every chart synced to it. Points are already bounded — the window's
// step ladder keeps every range to a few dozen buckets — so the number of
// SERIES is what a wide fleet or a high-cardinality group-by blows up.
//
// The rule follows the production platform: draw the first N series in the
// order they arrive, say how many are held back, and let the reader ask for the
// rest. Two things differ from it:
//
//   1. N depends on the chart's own width. A third-width card cannot make
//      twenty lines legible anyway, so it starts at eight; a full-width chart
//      gets twenty.
//   2. "Show all" does not land everything in one frame. It adds the held-back
//      series a chunk per animation frame, so the page keeps painting and
//      answering input while a chart fills in, and past a ceiling it declines
//      and asks for a narrower query instead of drawing hundreds of paths.
//
// Pure, so the thresholds can be tested; the hook and footer that use it live
// in useSeriesBudget.js and SeriesBudgetFooter.jsx.

/** Series added per animation frame once "Show all" is pressed. */
export const SERIES_CHUNK = 10

/** Above this many series, "Show all" is not offered: filter instead. */
export const SERIES_CEILING = 200

/** Most rows a multi-series tooltip lists before it counts the rest. */
export const TOOLTIP_ROWS = 12

/**
 * The cap for a chart this wide, in px.
 *
 * An unmeasured chart (width 0, its first paint) gets the smallest cap, so a
 * chart never draws more on the frame before it knows its size than after.
 */
export function seriesCapForWidth(width) {
  if (!(width >= 480)) return 8
  if (width < 760) return 12
  return 20
}

/**
 * What a chart draws right now, from its budget state.
 *
 * `drawn` is how far an expansion has got; it only means anything while
 * `expanded` is on. The cap still applies to an expansion's floor, so pressing
 * "Show all" never draws fewer lines than the capped chart already did.
 *
 * status:
 *   'all'      — nothing held back; no footer
 *   'capped'   — drawing `cap`, holding the rest back
 *   'drawing'  — "Show all" pressed, still adding chunks
 *   'expanded' — every series drawn
 *
 * Two rules hold whatever was pressed earlier, because the list and the width
 * keep moving after the click — a filter narrows, a window widens, a search is
 * cleared:
 *   - a list that fits under the cap is 'all', so a chart that no longer holds
 *     anything back drops its footer and its fixed axis, exactly as one where
 *     "Show all" was never pressed;
 *   - a list over the ceiling is 'capped', so an expansion begun on a shorter
 *     list cannot go on to draw hundreds of paths when the list grows.
 */
export function budgetView({ total, cap, expanded = false, drawn = 0, ceiling = SERIES_CEILING }) {
  const n = Math.max(0, total | 0)
  if (n <= cap) return { count: n, status: 'all' }
  if (!expanded || n > ceiling) return { count: cap, status: 'capped' }
  const count = Math.min(n, Math.max(cap, drawn))
  return { count, status: count < n ? 'drawing' : 'expanded' }
}

/**
 * Whether a chart should fix its value axis to every series rather than let
 * Recharts fit it to what is drawn.
 *
 * Only while a budget is actually in play: then the axis must not jump as
 * "Show all" adds lines, and the capped chart's scale should still admit that a
 * held-back series runs higher. A chart that draws everything keeps the
 * automatic axis it always had.
 */
export function fixesAxis(status) {
  return status !== 'all'
}

/** The next expansion step: one more chunk, never past the total. */
export function nextDrawn(drawn, total, chunk = SERIES_CHUNK) {
  return Math.min(total, drawn + chunk)
}
