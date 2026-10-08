import { useState, useEffect, useCallback } from 'react'
import { seriesCapForWidth, budgetView, nextDrawn, SERIES_CEILING } from './seriesBudget'

/**
 * A chart's series budget: how many of `total` series to draw at `width`, and
 * the two actions its footer (SeriesBudgetFooter) offers. The rules are in
 * seriesBudget.js.
 *
 * Pass the chart's measured width, not its container's guess: the cap is about
 * how many lines that chart can make legible, which only its own width knows.
 */
export function useSeriesBudget(total, width) {
  const cap = seriesCapForWidth(width)
  const [state, setState] = useState({ expanded: false, drawn: 0 })
  const view = budgetView({ total, cap, ...state })

  // One chunk per animation frame. Each step commits, the browser paints, and
  // only then is the next chunk scheduled — so "Show all" on a big fleet is a
  // run of short frames rather than one long one that freezes the page.
  useEffect(() => {
    if (view.status !== 'drawing') return undefined
    const id = requestAnimationFrame(() => {
      setState(s => (s.expanded ? { expanded: true, drawn: nextDrawn(Math.max(cap, s.drawn), total) } : s))
    })
    return () => cancelAnimationFrame(id)
  }, [view.status, view.count, cap, total])

  // budgetView also enforces the ceiling on every render, so a list that grows
  // past it after Show all falls back to the cap; this only stops the click.
  const tooMany = total > SERIES_CEILING
  const showAll = useCallback(() => {
    if (!tooMany) setState({ expanded: true, drawn: cap })
  }, [tooMany, cap])
  const showFewer = useCallback(() => setState({ expanded: false, drawn: 0 }), [])

  return { ...view, cap, total, tooMany, showAll, showFewer }
}
