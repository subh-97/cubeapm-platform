// The footer for a chart under a series budget (useSeriesBudget).
import { budgetOffer } from './seriesBudget'

/**
 * The line under a chart that says what it is holding back, and lets the
 * reader take more of it in steps or all of it. Renders nothing when the chart
 * draws everything, so a small chart carries no footer at all.
 *
 *   Showing 8 of 64 hosts     Show 20 more · Show all
 *   Showing 28 of 64 hosts    Show 20 more · Show all
 *   Showing all 64 hosts
 *
 * A chart's footer has no way back to its own count: once more is drawn it
 * stays drawn until the list or the page changes. A footer that asks for one
 * (`collapsible`, the alert timeline's lanes) offers "Show less" whenever more
 * than the cap is shown, through the budget's `showFewer`. Otherwise an action
 * is offered only when the budget has a handler for it, so a list that borrows
 * this footer with Show all alone (the error groups panel) draws exactly that.
 *
 * The visible count changes every frame while a chart fills in, which is too
 * chatty to announce; the screen-reader line only speaks when the state does.
 */
export default function SeriesBudgetFooter({ budget, noun = 'series', collapsible = false }) {
  const { status, count, total } = budget
  if (status === 'all') return null
  const offer = budgetOffer(budget)
  const more = budget.showMore ? offer.more : 0
  const all = budget.showAll ? offer.all : false
  const less = collapsible && budget.showFewer ? offer.fewer : false
  const announce = status === 'drawing' ? `Drawing ${budget.target ?? total} of ${total} ${noun}`
    : status === 'expanded' ? `Showing all ${total} ${noun}`
      : `Showing ${count} of ${total} ${noun}`
  const actions = [
    more > 0 && <button key="more" type="button" className="series-budget-btn" onClick={budget.showMore}>Show {more} more</button>,
    all && <button key="all" type="button" className="series-budget-btn" onClick={budget.showAll}>Show all</button>,
    less && <button key="less" type="button" className="series-budget-btn" onClick={budget.showFewer}>Show less</button>,
  ].filter(Boolean)
  return (
    <div className="series-budget">
      <span className="sr-only" aria-live="polite">{announce}</span>
      {status === 'drawing' ? (
        <>
          <span aria-hidden="true">Drawing {count} of {total} {noun}…</span>
          <span className="series-budget-progress" aria-hidden="true">
            <span style={{ width: `${(count / (budget.target ?? total)) * 100}%` }} />
          </span>
        </>
      ) : (
        <>
          <span aria-hidden="true">{status === 'expanded' ? `Showing all ${total} ${noun}` : `Showing ${count} of ${total} ${noun}`}</span>
          {(actions.length > 0 || (offer.tooMany && status === 'capped')) && (
            <span className="series-budget-actions">
              {actions.flatMap((a, i) => (i === 0 ? [a] : [<span key={`sep-${i}`} className="series-budget-sep" aria-hidden="true">·</span>, a]))}
              {offer.tooMany && status === 'capped' && !more && (
                <span className="series-budget-note">Too many to draw at once. Narrow the query to see the rest.</span>
              )}
            </span>
          )}
        </>
      )}
    </div>
  )
}
