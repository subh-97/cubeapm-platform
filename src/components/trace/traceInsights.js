/**
 * How a waterfall opens a trace, wherever it is drawn: which spans start
 * folded, and which to unfold so one span is on screen. Pure, so the trace
 * page, the Traces explorer's drawer and their tests fold a trace alike.
 */

/** A trace longer than this opens with its deep subtrees folded. */
export const LARGE_TRACE = 40
/** The depth folding starts at: the request and its first calls stay open. */
export const AUTO_FOLD_DEPTH = 2

/**
 * The spans a trace opens with folded: none for one that fits on a screen, and
 * every parent from AUTO_FOLD_DEPTH down for one longer than LARGE_TRACE. The
 * trace page's rule, kept here so the drawer folds the same trace the same way.
 */
export function autoFolds(spans) {
  if (!spans || spans.length <= LARGE_TRACE) return new Set()
  return new Set(spans.filter(s => s.childIds.length && s.depth >= AUTO_FOLD_DEPTH).map(s => s.id))
}

/**
 * `folds` with every ancestor of span `id` unfolded, so that span is on screen.
 * The same set comes back when nothing had to change, so a caller can compare
 * by identity.
 */
export function revealing(folds, trace, id) {
  if (!folds?.size || !trace?.byId || !id) return folds
  let next = null
  let node = trace.byId[id]
  while (node?.parentId) {
    if (folds.has(node.parentId)) {
      next ??= new Set(folds)
      next.delete(node.parentId)
    }
    node = trace.byId[node.parentId]
  }
  return next ?? folds
}
