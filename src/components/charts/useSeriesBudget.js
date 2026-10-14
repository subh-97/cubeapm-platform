import { useState, useEffect, useCallback } from 'react'
import { seriesCapForWidth, budgetView, nextDrawn, SERIES_CEILING, SERIES_STEP } from './seriesBudget'

/**
 * A chart's series budget: how many of `total` series to draw at `width`, and
 * the actions its footer (SeriesBudgetFooter) offers — "Show 20 more" and
 * "Show all" — plus showFewer, which puts the chart back to its cap when the
 * page changes what it lists (the DB tab's kind filter). The rules are in
 * seriesBudget.js.
 *
 * Pass the chart's measured width, not its container's guess: the cap is about
 * how many lines that chart can make legible, which only its own width knows.
 */
export function useSeriesBudget(total, width) {
  const cap = seriesCapForWidth(width)
  const [state, setState] = useState({ want: 0, drawn: 0 })
  const view = budgetView({ total, cap, ...state })

  // One chunk per animation frame. Each step commits, the browser paints, and
  // only then is the next chunk scheduled — so "Show all" on a big fleet is a
  // run of short frames rather than one long one that freezes the page.
  useEffect(() => {
    if (view.status !== 'drawing') return undefined
    const id = requestAnimationFrame(() => {
      setState(s => ({ ...s, drawn: nextDrawn(Math.max(cap, s.drawn), view.target) }))
    })
    return () => cancelAnimationFrame(id)
  }, [view.status, view.count, view.target, cap])

  // Each request starts drawing from what is on the chart now, so a chart that
  // already holds 28 lines adds the next 20 rather than redrawing from its cap.
  // A second press while the first is still drawing builds on what the first
  // asked for, not on what has landed so far.
  //
  // budgetView also holds the ceiling on every render, so a list that grows
  // past it after "Show all" stops there; this only stops the click.
  const tooMany = total > SERIES_CEILING
  const showMore = useCallback(() => {
    setState(s => ({ want: Math.max(cap, s.want) + SERIES_STEP, drawn: Math.max(cap, s.drawn) }))
  }, [cap])
  const showAll = useCallback(() => {
    if (!tooMany) setState(s => ({ want: Infinity, drawn: Math.max(cap, s.drawn) }))
  }, [tooMany, cap])
  const showFewer = useCallback(() => setState({ want: 0, drawn: 0 }), [])

  return { ...view, cap, total, tooMany, showMore, showAll, showFewer }
}
