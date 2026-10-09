import { useRef, useState } from 'react'
import ErrorSpark from './ErrorSpark'
import SeriesBudgetFooter from '@/components/charts/SeriesBudgetFooter'
import SearchGlyph from '@/components/shared/SearchGlyph'
import { deltaChip } from '@/utils/errorsPage'
// errors.css for .errp-delta, each row's comparison chip, and the
// `.err-row .err-count` rule that stacks it under the count. Said here rather
// than left to the page having loaded it: the APM service page happens to, the
// Browser page would not.
import './errors.css'
import './error-groups-panel.css'

// The APM service page's two sides: the requests a service served, and the
// calls it made. Browser passes its own (Script | Ajax).
const APM_SIDES = [
  { id: 'server', label: 'Server' },
  { id: 'client', label: 'Client' },
]

// An exception class with a line-break opportunity after every '.', so a
// column that wraps it (the APM service page's does) breaks between package
// segments — 'redis.clients.jedis.' / 'exceptions.JedisPoolException' — rather
// than mid-word. Where the column cuts the text instead, they change nothing.
function BreakAtDots({ text }) {
  const parts = String(text ?? '').split(/(?<=\.)/)
  return parts.map((p, i) => (i === 0 ? p : <span key={i}><wbr />{p}</span>))
}

/**
 * One panel of error groups: a side toggle, a search, then a row per group —
 * where it happens, what was thrown, how many against the previous period, and
 * an errors-over-time chart that can be dragged into the page's range.
 *
 * It is the APM service page's Errors tab with the data and the destinations
 * taken out: the caller hands it the groups and says what a row and an
 * exception open. The service page sends a row to the Traces page and an
 * exception to the Errors page's drawer; the Browser page sends a row to its
 * own Traces tab and an exception to the stack-trace modal. Everything it
 * draws is the tab's own markup, so on the service page nothing changed.
 *
 *   sides / side / onSide  the toggle; `side` is the caller's when given, so a
 *                          link that names a side lands on it
 *   whereOf(group)         what the Endpoint column says (default: the route on
 *                          Server, the outgoing call on Client)
 *   renderError(group)     the Error cell's content (default: the exception
 *                          class as its own button, then the message)
 *   onOpenRow, onOpenException(group)
 *   prevText               what the count's chip compares against, worded
 *                          from the picked range ("the previous hour"); left
 *                          out, the count stands alone with no chip
 *   limit / noun           show the first `limit` groups, with the series
 *                          budget's "Showing N of M · Show all" line under them
 *   renderWhere(group)     the Endpoint cell's content, when it should be more
 *                          than the text (default: whereOf's text)
 *   sparkHeight            each row's chart height (ErrorSpark's 132 by
 *                          default); the row's CSS must agree with it
 *
 * A row opens on a click anywhere outside its own controls, as it always has.
 * For the keyboard and a screen reader the way in is a real button: the
 * Endpoint text itself, named for what it does ("See traces for /checkout,
 * TypeError"). The row is not a role=button, because a row-sized button would
 * swallow the exception button inside it — ARIA reads a button's children as
 * flat text, and that one control would never be announced.
 */
export default function ErrorGroupsPanel({
  sides = APM_SIDES, side: sideProp, onSide,
  groups, whereOf, renderError, onOpenRow, onOpenException,
  prevText, win, onFocus, syncId, headRight,
  searchPlaceholder = 'Search endpoints or exceptions…',
  limit, noun = 'error groups', renderWhere, sparkHeight,
}) {
  const [ownSide, setOwnSide] = useState(sides[0]?.id)
  const side = sideProp ?? ownSide
  const setSide = onSide ?? setOwnSide
  const sideLabel = sides.find(s => s.id === side)?.label ?? side
  const [q, setQ] = useState('')
  // "Show all" belongs to the side it was asked on: the other side's list is a
  // different length, and opening it already expanded would skip the cap.
  const [expandedFor, setExpandedFor] = useState(null)
  // A drag across a row's chart (a zoom) that ends outside the chart finishes
  // its click on the row, which would open the row behind the zoom. Where the
  // press started decides — the same guard as the Errors page's table.
  const pressedInSpark = useRef(false)

  const where = whereOf ?? (e => (side === 'client' ? e.spanName : e.endpoint))
  const filtered = q
    ? groups.filter(e => (where(e) + ' ' + e.exception + ' ' + e.message).toLowerCase().includes(q.toLowerCase()))
    : groups
  const capped = limit != null && filtered.length > limit
  const expanded = expandedFor === side
  const shown = capped && !expanded ? filtered.slice(0, limit) : filtered

  const openRow = e => onOpenRow?.(e)
  const errorCell = renderError ?? (e => (
    <>
      {/* The row goes to Traces; the exception goes to its details and
          stack trace. Two destinations in one row, so this one is its
          own control. */}
      {onOpenException ? (
        <button
          type="button"
          className="err-exc-cls"
          onClick={ev => { ev.stopPropagation(); onOpenException(e) }}
          title={`Show the details and stack trace for ${e.exception}`}
        >
          <BreakAtDots text={e.exception} />
        </button>
      ) : (
        <span className="err-exc-cls is-static"><BreakAtDots text={e.exception} /></span>
      )}
      {/* Cut to the column, so the whole message is its title: six of a
          storefront's top ten TypeErrors share their first 45 characters. */}
      <span className="err-exc-msg" title={e.message || undefined}>{e.message}</span>
    </>
  ))
  // The toggle keeps the tab's <div class="seg"> look; role, focus and keys
  // make it reachable without a mouse, which it was not before.
  const segKey = (ev, id) => {
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); setSide(id) }
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <div className="panel-head-left">
          <div className="seg-toggle">
            {sides.map(s => (
              <div
                key={s.id}
                className={`seg${side === s.id ? ' active' : ''}`}
                role="button"
                tabIndex={0}
                aria-pressed={side === s.id}
                onClick={() => setSide(s.id)}
                onKeyDown={ev => segKey(ev, s.id)}
              >
                {s.label}
              </div>
            ))}
          </div>
        </div>
        {headRight != null && <div className="panel-head-right">{headRight}</div>}
      </div>
      <div className="split-endpoints-search" style={{ borderTop: '1px solid var(--border-subtle)' }}>
        <div className="search-with-icon">
          <SearchGlyph />
          <input placeholder={searchPlaceholder} aria-label={searchPlaceholder.replace(/…$/, '')} value={q} onChange={e => setQ(e.target.value)} />
        </div>
      </div>
      <div className="err-head">
        <span>Endpoint</span><span>Error</span><span className="err-count-head">Count</span><span />
      </div>
      {shown.map(e => {
        const delta = prevText != null ? deltaChip(e.count, e.prevCount, prevText) : null
        return (
          <div
            key={e.id}
            className="err-row is-clickable"
            onMouseDown={ev => { pressedInSpark.current = !!ev.target.closest?.('.err-spark') }}
            onClick={() => {
              if (pressedInSpark.current) return
              // Selecting a message to copy it is not a request to open the row.
              if (window.getSelection()?.isCollapsed === false) return
              openRow(e)
            }}
          >
            <div className="err-endpoint" title={where(e)}>
              {/* The row's own control (see above). Its click is handled here
                  and goes no further, so a press that started in a chart —
                  which the row's handler guards against — cannot cancel a
                  key press on it. */}
              <button
                type="button"
                className="err-open"
                aria-label={`See traces for ${where(e)}, ${e.exception}`}
                onClick={ev => { ev.stopPropagation(); openRow(e) }}
              >
                {renderWhere ? renderWhere(e) : where(e)}
              </button>
            </div>
            <div className="err-exc">{errorCell(e)}</div>
            {/* The chip sits under the number, as on the Errors page, so the
                count keeps its size in the narrow column. Stacked flush right,
                anything wider than the column (a 7d "12,239") spills left into
                the gap rather than right into the spark (errors.css). */}
            <div className="err-count">
              <span>{e.count.toLocaleString()}</span>
              {delta && <span className="errp-delta" data-dir={delta.dir} title={delta.title}>{delta.label}</span>}
            </div>
            <div className="err-spark" onClick={ev => ev.stopPropagation()}>
              <ErrorSpark series={e.series} win={win} onFocus={onFocus} syncId={syncId} height={sparkHeight} />
            </div>
          </div>
        )
      })}
      {capped && (
        <div className="errg-foot">
          <SeriesBudgetFooter
            noun={noun}
            budget={expanded
              ? { status: 'expanded', count: filtered.length, total: filtered.length, showFewer: () => setExpandedFor(null) }
              : { status: 'capped', count: limit, total: filtered.length, showAll: () => setExpandedFor(side) }}
          />
        </div>
      )}
      {filtered.length === 0 && (
        <div className="err-empty">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="10"/></svg>
          <div>{groups.length === 0 ? `No ${sideLabel.toLowerCase()} errors in ${win.label}` : `No errors match "${q}"`}</div>
        </div>
      )}
    </div>
  )
}
