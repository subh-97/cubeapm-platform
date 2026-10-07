// The footer for a chart under a series budget (useSeriesBudget).

/**
 * The line under a chart that says what it is holding back. Renders nothing
 * when the chart draws everything, so a small chart carries no footer at all.
 *
 * The visible count changes every frame while a chart fills in, which is too
 * chatty to announce; the screen-reader line only speaks when the state does.
 */
export default function SeriesBudgetFooter({ budget, noun = 'series' }) {
  const { status, count, total, tooMany } = budget
  if (status === 'all') return null
  const announce = status === 'drawing' ? `Drawing all ${total} ${noun}`
    : status === 'expanded' ? `Showing all ${total} ${noun}`
      : `Showing ${count} of ${total} ${noun}`
  return (
    <div className="series-budget">
      <span className="sr-only" aria-live="polite">{announce}</span>
      {status === 'capped' && (
        <>
          <span aria-hidden="true">Showing {count} of {total} {noun}</span>
          {tooMany
            ? <span className="series-budget-note">Too many to draw at once. Narrow the query to see the rest.</span>
            : <button type="button" className="series-budget-btn" onClick={budget.showAll}>Show all</button>}
        </>
      )}
      {status === 'drawing' && (
        <>
          <span aria-hidden="true">Drawing {count} of {total} {noun}…</span>
          <span className="series-budget-progress" aria-hidden="true">
            <span style={{ width: `${(count / total) * 100}%` }} />
          </span>
        </>
      )}
      {status === 'expanded' && (
        <>
          <span aria-hidden="true">Showing all {total} {noun}</span>
          <button type="button" className="series-budget-btn" onClick={budget.showFewer}>Show fewer</button>
        </>
      )}
    </div>
  )
}
