import { memo, useEffect, useRef, useState } from 'react'
import { ArrowUpRight } from 'lucide-react'
import ErrorSpark from '@/components/errors/ErrorSpark'
import { STATUS_LABELS } from '@/utils/status'
import { exceptionParts, httpReason, httpCodeClass, deltaChip } from '@/utils/errorsPage'
import './errors.css'

// The row spark's height, and the height its placeholder holds until it mounts.
const SPARK_H = 104

// Every spark on the page shares one crosshair: hovering a minute on one row
// shows the same minute on every other, which is how a reader sees that two
// exceptions started together.
const SPARK_SYNC = 'errors-page'

// Rows whose chart mounts straight away. Past this the rest wait until they
// are near the viewport: at a week a Client table runs to ~70 groups, and
// seventy Recharts charts mounting in one frame is a visible stall for rows
// nobody has scrolled to yet. Enough rows to fill a tall screen go eagerly so
// the first paint never shows a placeholder.
const EAGER_SPARKS = 8

// How far ahead of the viewport a spark mounts, so scrolling meets charts that
// are already drawn rather than charts appearing under the cursor.
const LAZY_MARGIN = '320px 0px'

const SORT_WORDS = {
  count: { desc: 'most errors first', asc: 'fewest errors first' },
  endpoint: { asc: 'worst service first', desc: 'healthiest service first' },
  error: { asc: 'class name A to Z', desc: 'class name Z to A' },
}

function SortHead({ id, label, sort, onSort }) {
  const active = sort.key === id
  return (
    <button
      type="button"
      className="errp-sort"
      onClick={() => onSort(id)}
      title={active ? `Sorted by ${label.toLowerCase()}, ${SORT_WORDS[id][sort.dir]}. Click to reverse.` : `Sort by ${label.toLowerCase()}`}
    >
      {label}
      <svg
        className={`sortable-th-arrow${active ? ' active' : ''}${active && sort.dir === 'asc' ? ' asc' : ''}`}
        viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor"
        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      >
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v8M9 13l3 3 3-3" />
      </svg>
    </button>
  )
}

/**
 * Holds a row's chart back until the row is close to being seen. Once shown it
 * stays mounted: unmounting on the way out would redraw it on the way back.
 * `root` is the page's scroll container — the margin has to be measured
 * against that box, since the viewport never clips the rows itself.
 */
function LazySpark({ lazy, root, children }) {
  const ref = useRef(null)
  const [seen, setSeen] = useState(!lazy)
  const shown = seen || !lazy
  useEffect(() => {
    if (seen) return undefined
    // A re-sort can move a row out of the eager few after it has drawn; it
    // keeps its chart rather than dropping back to a placeholder.
    if (!lazy) { setSeen(true); return undefined }
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') { setSeen(true); return undefined }
    const io = new IntersectionObserver((entries) => {
      if (entries.some(e => e.isIntersecting)) { setSeen(true); io.disconnect() }
    }, { root: root ?? null, rootMargin: LAZY_MARGIN })
    io.observe(el)
    return () => io.disconnect()
  }, [seen, lazy, root])
  return (
    <div ref={ref} style={{ height: SPARK_H }}>
      {shown ? children : <div className="errp-spark-ph" aria-hidden="true" />}
    </div>
  )
}

function HttpCodes({ codes, withReason }) {
  if (!codes.length) return <span className="errp-none">No HTTP status</span>
  return codes.map(c => (
    <span key={c.code} className="errp-code-item">
      <span className={`tw-code ${httpCodeClass(c.code)}`}>{c.code}</span>
      {withReason && <span className="errp-code-reason">{httpReason(c.code)}</span>}
    </span>
  ))
}

// Memoised because the page re-renders for things no row depends on — the
// rail being dragged wider re-renders on every pointer move — and each row
// carries a chart.
const ErrorGroupRow = memo(function ErrorGroupRow({
  group, side, win, onFocus, status, prevText, selected, onSelect, onOpenTraces, lazy, scrollRoot,
}) {
  // A drag across the spark that ends outside it finishes its click on the row,
  // which would open the drawer behind a zoom. Where the press started decides.
  const pressedInSpark = useRef(false)
  const { pkg, short } = exceptionParts(group.exception)
  const delta = deltaChip(group.count, group.prevCount, prevText)
  const codesTitle = group.httpCodes.map(c => `${c.code} × ${c.count.toLocaleString()}`).join(', ')
  const open = () => onSelect(group)
  // On Client one endpoint fails the same way through several calls (GET and
  // SETEX on the same Redis key), so the call is what tells those rows apart
  // for someone hearing the row rather than seeing it.
  const where = side === 'client' ? `${group.endpoint}, calling ${group.spanName}` : group.endpoint

  return (
    <div
      className={`errp-row${selected ? ' is-selected' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={`${group.service}, ${where}: ${group.exceptionShort || short}, ${group.count.toLocaleString()} errors. Open error details`}
      onMouseDown={(e) => { pressedInSpark.current = !!e.target.closest?.('.errp-spark') }}
      onClick={() => {
        if (pressedInSpark.current) return
        // Selecting a message to copy it is not a request to open the row.
        if (window.getSelection()?.isCollapsed === false) return
        open()
      }}
      onKeyDown={(e) => {
        // Enter on the Traces button inside is that button's, not the row's.
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open() }
      }}
    >
      <div className="errp-where">
        <div className="errp-svc">
          <span
            className={`status-dot ${status}`}
            role="img"
            aria-label={`Status: ${STATUS_LABELS[status]}`}
            title={`Status: ${STATUS_LABELS[status]}`}
          />
          <span className="errp-svc-name" title={group.service}>{group.service}</span>
        </div>
        <div className="errp-ep" title={group.endpoint}>{group.endpoint}</div>
      </div>

      <div className="errp-err">
        <span className="errp-exc" title={group.exception}>
          {pkg && <span className="errp-exc-pkg"><bdi>{pkg}</bdi></span>}
          <span className="errp-exc-cls">{short}</span>
        </span>
        <span className="errp-msg" title={group.message}>{group.message}</span>
        {side === 'client' ? (
          <span className="errp-call">
            <span className="errp-call-name" title={group.spanName}>{group.spanName}</span>
            <span className="errp-cat">{group.category}</span>
            {group.httpCodes.length > 0 && <span className="errp-codes" title={codesTitle}><HttpCodes codes={group.httpCodes} /></span>}
          </span>
        ) : (
          <span className="errp-codes" title={codesTitle || undefined}>
            <HttpCodes codes={group.httpCodes} withReason />
          </span>
        )}
      </div>

      <div className="errp-count">
        <span className="errp-count-n">{group.count.toLocaleString()}</span>
        <span className="errp-delta" data-dir={delta.dir} title={delta.title}>{delta.label}</span>
      </div>

      <div className="errp-spark" onClick={e => e.stopPropagation()}>
        <LazySpark lazy={lazy} root={scrollRoot}>
          <ErrorSpark series={group.series} win={win} onFocus={onFocus} syncId={SPARK_SYNC} height={SPARK_H} />
        </LazySpark>
      </div>

      <div className="errp-actions">
        <button
          type="button"
          className="errp-traces-link"
          title="View these errors in Traces"
          onClick={(e) => { e.stopPropagation(); onOpenTraces(group) }}
        >
          Traces
          <ArrowUpRight strokeWidth={2} aria-hidden="true" />
        </button>
      </div>
    </div>
  )
})

/**
 * The error groups, one row each: where, what, how many against before, when,
 * and a way into the spans. The order is the page's (see sortErrorGroups); the
 * header only asks for a different one.
 */
export default function ErrorGroupTable({
  groups, side, win, onFocus, sort, onSort, selectedId, onSelect, onOpenTraces,
  serviceStatus, prevText, scrollRoot,
}) {
  const lazy = groups.length > EAGER_SPARKS
  return (
    <div className="errp-table">
      <div className="errp-head">
        <SortHead id="endpoint" label="Endpoint" sort={sort} onSort={onSort} />
        <SortHead id="error" label="Error" sort={sort} onSort={onSort} />
        <SortHead id="count" label="Count" sort={sort} onSort={onSort} />
        <span>Errors over time</span>
        {/* A real cell holding the hidden label: .sr-only is positioned out of
            the grid, which left the header a column short of its rows and the
            last column rule stopping at the header. */}
        <span><span className="sr-only">Actions</span></span>
      </div>
      {groups.map((g, i) => (
        <ErrorGroupRow
          key={g.id}
          group={g}
          side={side}
          win={win}
          onFocus={onFocus}
          status={serviceStatus[g.service] ?? 'neutral'}
          prevText={prevText}
          selected={g.id === selectedId}
          onSelect={onSelect}
          onOpenTraces={onOpenTraces}
          lazy={lazy && i >= EAGER_SPARKS}
          scrollRoot={scrollRoot}
        />
      ))}
    </div>
  )
}
