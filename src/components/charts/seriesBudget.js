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
// rest. Three things differ from it:
//
//   1. N depends on the chart's own width. A third-width card cannot make
//      twenty lines legible anyway, so it starts at eight; a full-width chart
//      gets twenty.
//   2. The reader asks for the rest in steps as well as all at once. "Show 20
//      more" adds the next SERIES_STEP, so the next few hosts are a click away
//      without drawing all sixty-four; "Show all" draws the rest.
//   3. Nothing asked for lands in one frame. The held-back series are added a
//      chunk per animation frame, so the page keeps painting and answering
//      input while a chart fills in, and no chart draws past a ceiling: past
//      it, "Show all" is not offered, the steps stop there, and the footer asks
//      for a narrower query instead of drawing hundreds of paths.
//
// Pure, so the thresholds can be tested; the hook and footer that use it live
// in useSeriesBudget.js and SeriesBudgetFooter.jsx.

/** Series one "Show 20 more" adds. */
export const SERIES_STEP = 20

/** Series added per animation frame while a chart fills in what was asked for. */
export const SERIES_CHUNK = 10

/** No chart draws more series than this: above it "Show all" is not offered, and the steps stop here. */
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
 * `want` is how many series the reader has asked for: 0 for the chart's own
 * cap (nothing pressed, or reset by the page), a number after "Show 20 more", and
 * Infinity after "Show all". It is held as a count rather than as a number of
 * presses, so a card that widens under it keeps what was asked for, and never
 * draws fewer than its cap. `drawn` is how far the chunked drawing has got
 * towards it.
 *
 * Returns `count` (series to draw now), `target` (what the drawing is heading
 * for), `limit` (the most this chart may ever draw: the list, or the ceiling
 * when the list is longer) and a status:
 *   'all'      — nothing held back; no footer
 *   'capped'   — settled, holding some back (at the cap, or some steps past it)
 *   'drawing'  — adding chunks towards the target
 *   'expanded' — every series drawn
 *
 * Rules that hold whatever was pressed earlier, because the list and the width
 * keep moving after the click — a filter narrows, a window widens, a search is
 * cleared:
 *   - a list that fits under the cap is 'all', so a chart that no longer holds
 *     anything back drops its footer and its fixed axis, exactly as one where
 *     nothing was ever pressed;
 *   - a request never draws past the list or the ceiling, so an expansion
 *     begun on a shorter list cannot go on to draw hundreds of paths when the
 *     list grows past it.
 */
export function budgetView({ total, cap, want = 0, drawn = 0, ceiling = SERIES_CEILING }) {
  const n = Math.max(0, total | 0)
  const limit = Math.min(n, ceiling)
  if (n <= cap) return { count: n, target: n, limit: n, status: 'all' }
  const target = Math.max(cap, Math.min(limit, want))
  const count = Math.min(target, Math.max(cap, drawn))
  const status = count < target ? 'drawing' : count === n ? 'expanded' : 'capped'
  return { count, target, limit, status }
}

/**
 * The footer's offer, from a budget view: how many "Show N more" adds, whether
 * "Show all" is on the table, and whether there is anything for a way back
 * to take away. Nothing is added while a chart is still filling in.
 *
 *   - "Show N more" adds a step, or what is left below the limit when that is
 *     less. It is not offered when it would do exactly what "Show all" does: a
 *     second button with the same effect is a question the reader has to stop
 *     and answer.
 *   - "Show all" is offered while the limit is the whole list. A limit below
 *     the list is the ceiling cutting it (`tooMany`): the steps stop there, and
 *     the reader is asked to narrow the query instead.
 *   - `fewer`: the chart draws more than its own cap. Only Explore's legend
 *     offers a way back ("Hide all"); the chart footer does not.
 *
 * `limit` and `cap` default to "no ceiling" and "no cap of its own", for a
 * list that borrows the footer without a budget behind it.
 */
export function budgetOffer({ status, count, total, limit = total, cap = Infinity, step = SERIES_STEP }) {
  const settled = status === 'capped' || status === 'expanded'
  const tooMany = limit < total
  const more = settled ? Math.min(step, Math.max(0, limit - count)) : 0
  return {
    more: more > 0 && (tooMany || total - count > step) ? more : 0,
    all: status === 'capped' && !tooMany,
    fewer: status === 'expanded' || (settled && count > cap),
    tooMany,
  }
}

/**
 * Whether a chart should fix its value axis to every series rather than let
 * Recharts fit it to what is drawn.
 *
 * Only while a budget is actually in play: then the axis must not jump as
 * "Show 20 more" or "Show all" adds lines, and the capped chart's scale should
 * still admit that a held-back series runs higher. A chart that draws
 * everything keeps the automatic axis it always had.
 */
export function fixesAxis(status) {
  return status !== 'all'
}

/** The next drawing step: one more chunk, never past the target. */
export function nextDrawn(drawn, target, chunk = SERIES_CHUNK) {
  return Math.min(target, drawn + chunk)
}
