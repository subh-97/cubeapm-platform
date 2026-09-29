import { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import PageBar from '@/components/layout/PageBar'
import { FileText, Database as DatabaseIcon, CircleAlert, Flame, Maximize2, Copy, X, Download } from 'lucide-react'
import { buildTrace, traceSummary, traceDatabase } from '@/data/traceDetail'
import { colorForName } from '@/utils/chartPalette'
import { spanSearchFields, spanSearchRow, spanValueIndex } from '@/utils/traceFields'
import TableQuerySearch from '@/components/TableQuerySearch'
import { matchesPod } from '@/utils/tableQuery'

/* The icon is a second handle on the tab, not decoration: at 12px the four
   labels are one grey word each, and the shape is what the eye comes back to
   after reading the table under them. Each is paired with its label — an icon
   alone would be a guess. */
const TABS = [
  { id: 'summary', label: 'Summary', Icon: FileText },
  { id: 'database', label: 'Database', Icon: DatabaseIcon },
  { id: 'errors', label: 'Errors', Icon: CircleAlert },
  { id: 'profiles', label: 'Profiles', Icon: Flame },
]

// Above this many spans a trace opens folded below the second level. Fully
// expanded, a fan-out trace is a hundred-odd rows of leaf queries with the
// shape of the request buried in them — and the shape is what a waterfall is
// for. Small traces are legible whole, so they are left alone.
// Enough of each pane to stay usable at the extremes of the drag: a couple of
// table rows, and a few waterfall rows plus its header and search.
const TABLES_MIN_PX = 96
const WATERFALL_MIN_PX = 168

const LARGE_TRACE = 40
const AUTO_FOLD_DEPTH = 2

/** ms with the precision the number deserves — 2.34 ms, 184.2 ms, 1.24 s. */
function msLabel(v) {
  if (!Number.isFinite(v)) return '—'
  if (v >= 1000) return `${(v / 1000).toFixed(2)} s`
  if (v >= 100) return `${v.toFixed(1)} ms`
  return `${v.toFixed(2)} ms`
}

/** Nanosecond source, millisecond display — three places is the real floor. */
const round3 = (n) => Math.round(n * 1000) / 1000

function clockLabel(d) {
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`
}

function DbIcon() {
  return (
    <svg className="tw-row-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5" /><path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
    </svg>
  )
}

function ErrorIcon() {
  return (
    <svg className="tw-row-icon is-error" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" /><path d="M12 7v6" /><path d="M12 16.5v.01" />
    </svg>
  )
}

/* The bar is laid across the row rather than into a column of its own, so the
   timeline gets the full width instead of a third of it. A left gutter is held
   back for the indent and the caret — without it a span starting at zero would
   put colour under the one control on the row. */
const TRACK_GUTTER_PCT = 10

/**
 * One waterfall row.
 *
 * The bar runs behind the label, the way the product draws it: the row IS the
 * track. What that buys is resolution — a span is measured against the whole
 * row instead of a narrow column, so two calls a few milliseconds apart are
 * still visibly apart.
 *
 * What it costs is a coloured ground under the text, and that was worth being
 * careful about. The bar is a tint rather than a slab of colour, so the label
 * keeps its full contrast reading straight through it. No glow behind the
 * glyphs either — a halo blurs the text it is meant to rescue.
 *
 * The colour says WHICH SERVICE the span ran in. Severity is deliberately not
 * in it: a span that failed is marked by the status chip, the exception icon
 * and a red edge on the row, so spending the bar on severity too would say the
 * same thing three times and leave the service unsaid.
 */
function WaterfallRow({ span, trace, depth, expandable, expanded, selected, color, matched, current, rowRef, onToggle, onSelect }) {
  const startPct = trace.totalMs ? (span.start / trace.totalMs) * 100 : 0
  const endPct = trace.totalMs ? Math.min(100, ((span.start + span.duration) / trace.totalMs) * 100) : 0
  const width = Math.max(endPct - startPct, 0.5)
  const track = 100 - TRACK_GUTTER_PCT
  const barLeft = TRACK_GUTTER_PCT + (startPct * track) / 100
  const barWidth = (width * track) / 100

  const status = span.httpStatus
  return (
    <div
      ref={rowRef}
      className={`tw-row${selected ? ' is-selected' : ''}${span.status === 'error' ? ' is-error' : ''}${matched ? ' is-match' : ''}${current ? ' is-match-current' : ''}`}
      onClick={() => onSelect(span)}
      role="button"
      tabIndex={0}
      aria-current={selected || undefined}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(span) } }}
    >
      <span
        className="tw-bar"
        style={{ left: `${barLeft}%`, width: `${barWidth}%`, '--bar-color': color }}
        aria-hidden="true"
      />
      <span className="tw-label">
        <span className="tw-row-indent" aria-hidden="true">
          {Array.from({ length: depth }, (_, i) => <span key={i} className="tw-guide" />)}
        </span>
        {expandable ? (
          <button
            type="button"
            className={`tw-chev${expanded ? ' is-open' : ''}`}
            aria-expanded={expanded}
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${span.name}`}
            onClick={e => { e.stopPropagation(); onToggle(span.id) }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
          </button>
        ) : <span className="tw-chev is-empty" aria-hidden="true" />}

        {span.exception && <ErrorIcon />}
        {!span.exception && span.db && <DbIcon />}
        {status && <span className={`tw-code${Number(status) >= 500 ? ' is-5xx' : Number(status) >= 400 ? ' is-4xx' : ' is-2xx'}`}>{status}</span>}

        {/* No colour chip here: the bar behind this row already carries the
            service's colour across the full width, so a 7px square repeating
            it beside the name said the same thing twice. The tables keep
            theirs — they have no bar to read it off. */}
        <span className="tw-svc">{span.service}</span>
        <span className="tw-name">{span.name} <span className="tw-kind">({span.kind})</span></span>
      </span>

      <span className="tw-dur mono">{msLabel(span.duration)}</span>
    </div>
  )
}

// A collapsed span hides its whole subtree, not just its direct children — the
// point of collapsing a call is to stop reading everything under it.
//
// Out here rather than inside the list because the heading counts these rows
// too, and two copies of this rule would eventually disagree about how many
// spans are on screen.
function visibleSpans(spans, collapsed) {
  const out = []
  let hideBelow = null
  for (const s of spans) {
    if (hideBelow !== null) {
      if (s.depth > hideBelow) continue
      hideBelow = null
    }
    out.push(s)
    if (collapsed.has(s.id) && s.childIds.length) hideBelow = s.depth
  }
  return out
}

function Waterfall({ trace, selected, onSelect, collapsed, onToggle, matchIds, currentMatchId, rowRefs }) {
  const visible = useMemo(() => visibleSpans(trace.spans, collapsed), [trace.spans, collapsed])

  // Ordered by first appearance, so the root's service is always the first
  // colour and a given trace looks the same on every visit.
  const services = useMemo(() => [...new Set(trace.spans.map(s => s.service))], [trace.spans])

  return (
    <>
      {/* No legend: every row already names its service beside a dot in that
          same colour, so a strip above the list repeated the key eight times
          over without adding a reading of it. */}
      <div className="tw-rows" role="tree" aria-label="Trace waterfall">
        {visible.map(span => (
          <WaterfallRow
            key={span.id}
            span={span}
            trace={trace}
            depth={span.depth}
            expandable={span.childIds.length > 0}
            expanded={!collapsed.has(span.id)}
            selected={selected?.id === span.id}
            color={colorForName(span.service, services)}
            matched={matchIds?.has(span.id)}
            current={currentMatchId === span.id}
            rowRef={el => { if (rowRefs) rowRefs.current[span.id] = el }}
            onToggle={onToggle}
            onSelect={onSelect}
          />
        ))}
      </div>
    </>
  )
}

function SummaryTab({ trace, onFocus }) {
  const rows = useMemo(() => traceSummary(trace), [trace])
  const services = useMemo(() => [...new Set(trace.spans.map(s => s.service))], [trace.spans])
  if (!rows.length) return <div className="tw-empty">This trace has a root span and nothing else.</div>
  return (
    <table className="tw-table">
      <thead>
        <tr>
          <th>Operation</th><th>Service</th>
          <th className="num">Count</th><th className="num">Duration</th><th className="num">Duration %</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(r => (
          <tr
            key={r.key}
            className="tw-row-link"
            onClick={() => onFocus(r.slowestId)}
            role="button"
            tabIndex={0}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onFocus(r.slowestId) } }}
            title={r.count > 1
              ? `Show the slowest of the ${r.count} ${r.name} spans in the waterfall`
              : `Show ${r.name} in the waterfall`}
          >
            <td className="mono">{r.name}</td>
            {/* The dot is the same colour the service carries in the waterfall,
                so "which service is slow" answers itself in one glance and the
                answer survives the jump between the two views. */}
            <td className="tw-svc-cell">
              <span className="tw-svc-dot" style={{ background: colorForName(r.service, services) }} aria-hidden="true" />
              {r.service}
            </td>
            <td className="num mono">{r.count}</td>
            <td className="num mono">{msLabel(r.duration)}</td>
            <td className="num mono">{r.pct.toFixed(2)} %</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function DatabaseTab({ trace, onFocus }) {
  const rows = useMemo(() => traceDatabase(trace), [trace])
  const services = useMemo(() => [...new Set(trace.spans.map(s => s.service))], [trace.spans])
  if (!rows.length) return <div className="tw-empty">No database calls in this trace.</div>
  return (
    <table className="tw-table tw-table-db">
      <thead>
        <tr>
          <th>Query</th>
          <th className="num tw-dbdur">Duration</th><th>Service</th><th className="num">Count</th>
          <th className="tw-db-name">Database</th><th>Instance</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(r => (
          <tr
            key={r.key}
            className="tw-row-link"
            onClick={() => onFocus(r.slowestId)}
            role="button"
            tabIndex={0}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onFocus(r.slowestId) } }}
            title={r.count > 1
              ? `Show the slowest of the ${r.count} calls in the waterfall`
              : 'Show this call in the waterfall'}
          >
            {/* The statement leads: it is what identifies the row. The
                measures that follow are what you compare once you have found
                the query you came for. */}
            <td className="mono tw-stmt">{r.query}</td>
            {/* One column, because the three were one measurement. Total is
                the headline — it is what the rows are ranked by — with the
                average and the worst call beneath it. All three are always
                shown: hiding the pair on single-call rows saved a redundant
                line and cost the reader any way of knowing the numbers were
                still there. */}
            <td className="num mono tw-dbdur">
              <span className="tw-dbdur-total">{msLabel(r.total)}</span>
              <span className="tw-dbdur-line"><span className="tw-dbdur-k">avg</span>{msLabel(r.avg)}</span>
              <span className="tw-dbdur-line"><span className="tw-dbdur-k">max</span>{msLabel(r.max)}</span>
            </td>
            {/* Same dot as the waterfall and the summary: which service issued
                the query is the first thing you ask of a slow one. */}
            <td className="tw-svc-cell">
              <span className="tw-svc-dot" style={{ background: colorForName(r.service, services) }} aria-hidden="true" />
              {r.service}
            </td>
            <td className="num mono">{r.count}</td>
            <td className="mono tw-db-name">{r.database}</td>
            <td className="mono dim">{r.instance}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function ErrorsTab({ trace, onFocus, onOpenStack }) {
  const services = useMemo(() => [...new Set(trace.spans.map(s => s.service))], [trace.spans])
  if (!trace.errors.length) return <div className="tw-empty">No span in this trace failed.</div>
  return (
    <table className="tw-table">
      <thead><tr><th>Operation</th><th>Service</th><th>Type</th><th>Message</th></tr></thead>
      <tbody>
        {/* The row is the fastest way from "something failed" to the span that
            failed, so the whole row selects it in the waterfall — the message
            is as good a thing to aim at as the operation. */}
        {trace.errors.map(s => (
          <tr
            key={s.id}
            className="tw-row-link"
            onClick={() => onFocus(s.id)}
            role="button"
            tabIndex={0}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onFocus(s.id) } }}
            title="Show this span in the waterfall"
          >
            <td className="mono">{s.name} <span className="tw-kind">({s.kind})</span></td>
            <td className="tw-svc-cell">
              <span className="tw-svc-dot" style={{ background: colorForName(s.service, services) }} aria-hidden="true" />
              {s.service}
            </td>
            {/* The row goes to the span; this cell goes to the stack trace.
                Two destinations in one row need the second one to look like a
                control, so the type carries the icon that says it opens. */}
            <td className="mono tw-errtype">
              <button
                type="button"
                className="tw-stackbtn"
                onClick={e => { e.stopPropagation(); onOpenStack(s) }}
                title={`Show the full stack trace for ${s.exception.type}`}
              >
                <span>{s.exception.type}</span>
                <Maximize2 size={11} strokeWidth={2.2} aria-hidden="true" />
              </button>
            </td>
            <td className="mono">{s.exception.message}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/**
 * The full stack trace for one failed span.
 *
 * A stack trace is the one piece of a span that cannot be read in a table cell
 * or a side panel: it is forty lines wide and tall, and truncating it hides the
 * frame that matters, which is rarely the first one. So it gets the screen.
 *
 * Copy is here because it is what anyone actually does with a stack trace next
 * — paste it into a ticket or a search.
 */
function StackModal({ span, onClose }) {
  const [copied, setCopied] = useState(false)
  const closeRef = useRef(null)

  useEffect(() => {
    closeRef.current?.focus()
    const onKey = e => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const stack = span.exception.stack || 'No stack trace was recorded on this span.'
  const copy = () => {
    try {
      navigator.clipboard.writeText(`${span.exception.type}: ${span.exception.message}\n${stack}`)?.catch(() => {})
    } catch (_) { /* clipboard blocked — the text is on screen either way */ }
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1400)
  }

  return (
    <div className="tw-modal-overlay" onClick={onClose}>
      <div
        className="tw-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Stack trace for ${span.name}`}
        onClick={e => e.stopPropagation()}
      >
        <div className="tw-modal-head">
          <div className="tw-modal-titles">
            <div className="tw-modal-type mono">{span.exception.type}</div>
            <div className="tw-modal-sub">
              {span.service}
              <span className="sep">&middot;</span>
              <span className="mono">{span.name}</span>
              <span className="sep">&middot;</span>
              {msLabel(span.duration)}
            </div>
          </div>
          <div className="tw-modal-acts">
            <button type="button" className="tw-modal-copy" onClick={copy}>
              <Copy size={12} strokeWidth={2} aria-hidden="true" />
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button ref={closeRef} type="button" className="tw-modal-close" onClick={onClose} aria-label="Close">
              <X size={15} strokeWidth={2} aria-hidden="true" />
            </button>
          </div>
        </div>
        {span.exception.message && (
          <div className="tw-modal-msg">{span.exception.message}</div>
        )}
        <pre className="tw-modal-stack mono">{stack}</pre>
      </div>
    </div>
  )
}

/**
 * Profiles.
 *
 * The control and the count are the product's; the body is empty because
 * nothing in this build is producing profile records yet. That is the same
 * state the playground is in, and it is a truthful one — a tab filled with
 * invented flame data would be read as a measurement of this trace.
 *
 * `traceProfiles` in the data layer already does the rollup this will render:
 * by function, charged to self time, narrowable to one span. Point the body at
 * it when there is a profiler to point at.
 */
function ProfilesTab({ span, narrow, setNarrow }) {
  return (
    <div className="tw-prof">
      <div className="tw-prof-head">
        <label className={`tw-prof-narrow${span ? '' : ' is-off'}`}>
          <input
            type="checkbox"
            checked={narrow && !!span}
            disabled={!span}
            onChange={e => setNarrow(e.target.checked)}
          />
          <span>Narrow to selected span</span>
          {span
            ? <span className="mono dim">({span.name})</span>
            : <span className="dim">— pick a span in the waterfall</span>}
        </label>
        <span className="tw-prof-count">0 records</span>
      </div>
      <div className="tw-empty">No profile records overlap this trace.</div>
    </div>
  )
}

function SpanDetails({ span, trace }) {
  const [q, setQ] = useState('')
  const needle = q.trim().toLowerCase()
  const tags = Object.entries(span.tags)
    .filter(([k, v]) => !needle || k.toLowerCase().includes(needle) || String(v).toLowerCase().includes(needle))

  return (
    <aside className="tw-side" aria-label="Span details">
      <div className="tw-side-head">
        <div className="tw-side-svc">{span.service}</div>
        <div className="tw-side-name mono">{span.name}</div>
      </div>
      <dl className="tw-side-meta">
        <dt>Parent ID</dt><dd className="mono">{span.parentId ?? 'none'}</dd>
        <dt>Span ID</dt><dd className="mono">{span.id}</dd>
        <dt>Start Time</dt>
        <dd className="mono">
          {clockLabel(span.startTime)} <span className="dim">({msLabel(span.start)} in)</span>
        </dd>
        <dt>Duration</dt><dd className="mono">{msLabel(span.duration)}</dd>
        {span.exception && (<>
          <dt>Exception</dt>
          <dd className="mono tw-errtype">{span.exception.type}</dd>
        </>)}
      </dl>
      {span.exception?.message && (
        <div className="tw-side-exc">{span.exception.message}</div>
      )}
      <div className="tw-side-tagbar">
        <span>Tags</span>
        <input
          value={q} onChange={e => setQ(e.target.value)}
          placeholder="Search tags…" aria-label="Search tags" spellCheck={false}
        />
      </div>
      <div className="tw-side-tags">
        {tags.length === 0
          ? <div className="tw-empty">No tag matches “{q}”</div>
          : tags.map(([k, v]) => (
            <div className="tw-tag" key={k}>
              <div className="tw-tag-k mono">{k}</div>
              <div className="tw-tag-v mono">{v}</div>
            </div>
          ))}
      </div>
      {trace.origin && (
        <div className="tw-side-origin">
          Opened from a log record on <span className="mono">{trace.origin.service || 'this trace'}</span>.
        </div>
      )}
    </aside>
  )
}

export default function TraceDetail({ traceId, goHome, goTraces, goLogs, timeRange, setTimeRange, settingsOpen, setSettingsOpen }) {
  const trace = useMemo(() => buildTrace(traceId), [traceId])
  const [selectedId, setSelectedId] = useState(null)
  const [tab, setTab] = useState('summary')
  // Lives here rather than in the tab so the choice survives a trip to the
  // waterfall to pick a different span — which is the whole point of it.
  const [narrowProfile, setNarrowProfile] = useState(false)
  const [stackSpan, setStackSpan] = useState(null)
  // Height of the tables pane. The waterfall takes whatever is left, so one
  // number describes the whole split.
  const [tablePx, setTablePx] = useState(300)
  const [dragging, setDragging] = useState(false)
  const leftRef = useRef(null)
  const tablesRef = useRef(null)
  const splitRef = useRef(null)
  const dragRef = useRef(null)

  const [collapsed, setCollapsed] = useState(() => {
    const spans = trace?.spans ?? []
    if (spans.length <= LARGE_TRACE) return new Set()
    return new Set(spans.filter(sp => sp.childIds.length && sp.depth >= AUTO_FOLD_DEPTH).map(sp => sp.id))
  })
  // Search lives beside the waterfall, not inside a tab, so it behaves the same
  // whichever table is on screen above it. The field owns the text and only
  // hands up a query that parsed, so a half-written one never blanks the marks.
  const [queryNode, setQueryNode] = useState(null)
  const [queryText, setQueryText] = useState('')
  const [matchIdx, setMatchIdx] = useState(0)
  // The span the waterfall should reveal and scroll to, whoever asked for it.
  const [revealId, setRevealId] = useState(null)
  const rowRefs = useRef({})

  const onSearch = useCallback((text, node) => {
    setQueryText(text)
    setQueryNode(node)
  }, [])
  // The explorer's rows are one service's spans; a trace usually crosses more
  // than one. Off, the waterfall stays with the service the root ran in, which
  // is the request as its owner sees it; on, it shows every process it touched.
  const [fullTrace, setFullTrace] = useState(true)

  const toggle = useCallback((id) => {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }, [])

  const select = useCallback((s) => setSelectedId(s.id), [])

  // What a table row does: select the span, unfold whatever hides it, scroll to
  // it. A row that stands for several spans hands over the slowest, which is
  // the one it earned its place in the table with.
  const focusSpan = useCallback((id) => {
    if (!id) return
    setSelectedId(id)
    // Re-point even at the span already targeted, so clicking the same row
    // twice scrolls back to it rather than doing nothing.
    setRevealId(null)
    window.requestAnimationFrame(() => setRevealId(id))
  }, [])

  // Both panes need to stay usable at every position, so the clamp leaves room
  // for a couple of table rows above and a few waterfall rows below rather than
  // letting either collapse to nothing — a pane dragged shut looks like a bug,
  // and there is no affordance left to drag it back open by.
  const clampSplit = useCallback((px) => {
    const leftEl = leftRef.current
    const tablesEl = tablesRef.current
    const splitEl = splitRef.current
    if (!leftEl || !tablesEl || !splitEl) return Math.max(TABLES_MIN_PX, px)
    // The column scrolls, so the waterfall is as tall as its rows and there is
    // no shared pool to divide. What the tables pane must not do is take the
    // whole visible column: dragged that far there is nothing left on screen to
    // show a waterfall in, and the separator lands below the fold with it.
    // Everything above the tables — the head and the tabs — is measured rather
    // than assumed, which is why offsetTop is read instead of a constant.
    const sc = getComputedStyle(splitEl)
    const splitH = splitEl.getBoundingClientRect().height
      + parseFloat(sc.marginTop) + parseFloat(sc.marginBottom)
    const room = leftEl.clientHeight - tablesEl.offsetTop - splitH - WATERFALL_MIN_PX
    const max = Math.max(TABLES_MIN_PX, room)
    return Math.min(max, Math.max(TABLES_MIN_PX, px))
  }, [])

  const startSplitDrag = useCallback((e) => {
    e.preventDefault()
    dragRef.current = { startY: e.clientY, startPx: tablePx }
    setDragging(true)
    const onMove = (ev) => {
      const { startY, startPx } = dragRef.current
      setTablePx(clampSplit(startPx + (ev.clientY - startY)))
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      setDragging(false)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
  }, [tablePx, clampSplit])

  // A separator that only answers the mouse is one a keyboard cannot move at
  // all, and this one decides how much of the screen each half gets.
  const onSplitKey = useCallback((e) => {
    const step = e.shiftKey ? 80 : 24
    if (e.key === 'ArrowUp') { e.preventDefault(); setTablePx(px => clampSplit(px - step)) }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setTablePx(px => clampSplit(px + step)) }
    else if (e.key === 'Home') { e.preventDefault(); setTablePx(clampSplit(TABLES_MIN_PX)) }
    else if (e.key === 'End') { e.preventDefault(); setTablePx(clampSplit(Number.MAX_SAFE_INTEGER)) }
  }, [clampSplit])

  // A window that shrank can leave the tables taller than the column they sit
  // in, which would push the waterfall off the bottom with no way back.
  useEffect(() => {
    const onResize = () => setTablePx(px => clampSplit(px))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [clampSplit])

  const collapseAll = useCallback(() => {
    setCollapsed(new Set((trace?.spans ?? []).filter(sp => sp.childIds.length && sp.depth > 0).map(sp => sp.id)))
  }, [trace])
  const expandAll = useCallback(() => setCollapsed(new Set()), [])

  const shown = useMemo(() => {
    if (!trace) return null
    if (fullTrace) return trace
    const svc = trace.root.service
    const spans = trace.spans.filter(s => s.service === svc)
    return { ...trace, spans, errors: trace.errors.filter(s => s.service === svc) }
  }, [trace, fullTrace])

  // Errors is only offered when there is something in it. An always-present
  // tab that usually says "no span in this trace failed" trains you to skip
  // it, which is the one tab you want read on the day it has something.
  //
  // It follows the Show Full Trace toggle rather than the whole trace, so the
  // tabs describe the waterfall on screen — the same rule the counts above
  // them follow.
  const tabs = useMemo(
    () => TABS.filter(t => t.id !== 'errors' || (shown?.errors.length ?? 0) > 0),
    [shown]
  )
  // Derived rather than corrected in an effect: the selected tab can vanish
  // under the toggle, and falling back here avoids a frame rendered with no
  // panel. `tab` itself is left alone, so turning the toggle back on returns
  // you to where you were.
  const activeTab = tabs.some(t => t.id === tab) ? tab : 'summary'

  const totalCount = shown?.spans.length ?? 0
  const shownServiceCount = useMemo(
    () => (shown ? new Set(shown.spans.map(sp => sp.service)).size : 0),
    [shown]
  )
  const visibleCount = useMemo(
    () => (shown ? visibleSpans(shown.spans, collapsed).length : 0),
    [shown, collapsed]
  )
  // How deep the call nests. Counted from one rather than from the 0-based
  // depth the rows carry, because a root on its own is one level of call, not
  // zero — and it answers a different question from the span count: a hundred
  // spans three deep is a fan-out, the same hundred twelve deep is a chain,
  // and the two are read completely differently.
  const depthCount = useMemo(
    () => (shown?.spans.length ? Math.max(...shown.spans.map(sp => sp.depth)) + 1 : 0),
    [shown]
  )

  const searchFields = useMemo(() => spanSearchFields(shown?.spans ?? []), [shown])
  const valueIndex = useMemo(() => spanValueIndex(shown?.spans ?? []), [shown])
  const valuesFor = useCallback(name => valueIndex[name] ?? null, [valueIndex])

  const matchList = useMemo(() => {
    if (!queryNode || !shown) return []
    return shown.spans.filter(sp => matchesPod(queryNode, spanSearchRow(sp), searchFields))
  }, [queryNode, shown, searchFields])
  const matchIds = useMemo(() => new Set(matchList.map(m => m.id)), [matchList])

  // A new query starts at its first hit rather than wherever the last one left
  // off, and a shrinking result set must not strand the index past the end.
  useEffect(() => { setMatchIdx(0) }, [queryText])
  const safeIdx = matchList.length ? Math.min(matchIdx, matchList.length - 1) : 0
  const currentMatch = matchList[safeIdx] ?? null

  const stepMatch = useCallback((delta) => {
    setMatchIdx(prev => {
      if (matchList.length === 0) return 0
      const next = (prev + delta + matchList.length) % matchList.length
      const target = matchList[next]
      // Stepping is "selecting a result", so the detail panel follows.
      if (target) setSelectedId(target.id)
      return next
    })
  }, [matchList])

  // Stepping through search results is one way of pointing at a span; clicking
  // a row in any of the three tables is another. Both mean the same thing —
  // show me this one — so they set the same target and share what follows.
  useEffect(() => { if (currentMatch) setRevealId(currentMatch.id) }, [currentMatch])

  // A span inside a folded subtree is not on screen, so scrolling to it would
  // scroll to nothing. Unfold its ancestors first.
  useEffect(() => {
    if (!revealId || !shown) return
    setCollapsed(prev => {
      if (prev.size === 0) return prev
      const next = new Set(prev)
      let node = shown.spans.find(sp => sp.id === revealId)
      let changed = false
      while (node?.parentId) {
        if (next.delete(node.parentId)) changed = true
        node = shown.spans.find(sp => sp.id === node.parentId)
      }
      return changed ? next : prev
    })
  }, [revealId, shown])

  // Bring it into view once it is actually rendered.
  useEffect(() => {
    if (!revealId) return
    const el = rowRefs.current[revealId]
    if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [revealId, collapsed])

  // One hit identifies one span, so it selects it outright rather than waiting
  // to be stepped to — which is what makes pasting a span id a jump.
  useEffect(() => {
    if (queryNode && matchList.length === 1) setSelectedId(matchList[0].id)
  }, [queryNode, matchList])

  /**
   * The trace as a portable document, not as this view holds it.
   *
   * `trace` carries a byId index and the log record it was reached from —
   * view-model shape that would be noise in a file someone attaches to a
   * ticket. What goes out is the span tree with real attributes, spelled the
   * way the API spells it.
   *
   * Always the whole trace, never the Show Full Trace subset: that toggle is
   * about what is on screen, and a file that quietly dropped seven services
   * because of a checkbox would be found out much later than it was set.
   */
  const downloadTrace = useCallback(() => {
    if (!trace) return
    const doc = {
      traceId: trace.traceId,
      startTime: trace.startTime.toISOString(),
      durationMs: round3(trace.totalMs),
      services: trace.services,
      spanCount: trace.spans.length,
      spans: trace.spans.map(sp => ({
        spanId: sp.id,
        parentSpanId: sp.parentId,
        name: sp.name,
        service: sp.service,
        kind: sp.kind,
        startTime: sp.startTime.toISOString(),
        startOffsetMs: round3(sp.start),
        durationMs: round3(sp.duration),
        status: sp.status,
        ...(sp.exception ? { exception: sp.exception } : {}),
        attributes: sp.tags,
      })),
    }
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' })
    )
    const a = document.createElement('a')
    a.href = url
    a.download = `trace-${trace.traceId}.json`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }, [trace])

  if (!trace) {
    return (
      <>
        <PageBar timeRange={timeRange} setTimeRange={setTimeRange}>
          <a onClick={goHome}>CubeAPM</a><span className="sep">/</span><span className="current">Trace</span>
        </PageBar>
        <div className="tw-main"><div className="tw-empty">No trace id in the URL.</div></div>
      </>
    )
  }

  const span = (selectedId && trace.byId[selectedId]) || trace.root
  const hiddenServices = trace.services.length - 1

  return (
    <>
      <PageBar
        timeRange={timeRange} setTimeRange={setTimeRange}
        showSettings settingsOpen={settingsOpen} setSettingsOpen={setSettingsOpen}
        actions={
          <button
            className="hbtn icon"
            title="Download this trace as JSON"
            aria-label="Download this trace as JSON"
            onClick={downloadTrace}
          >
            <Download aria-hidden="true" />
          </button>
        }
      >
        <a onClick={goHome}>CubeAPM</a>
        <span className="sep">/</span>
        {/* A trace is reached from the Traces explorer, and the sidebar keeps
            that item lit while you are inside one — so the trail names the page
            you came from and goes back to it, rather than to a section this
            view no longer belongs to. */}
        <a onClick={goTraces ?? goHome}>Traces</a>
        <span className="sep">/</span>
        <span className="current mono">Trace {trace.traceId.slice(0, 12)}…</span>
      </PageBar>

      <div className="tw-main">
        <div className="tw-left" ref={leftRef}>
          {/* The head sits in the left column rather than above both, so the
              span panel starts level with it instead of a header-height below.
              It stays put while the tabs and waterfall scroll under it. */}
          <div className="tw-head">
            <div className="tw-head-left">
              <h1 className="mono">{trace.traceId}</h1>
              {/* Counts follow the Show Full Trace toggle. Reading the full
                  trace's totals beside a waterfall showing one service's spans
                  described a view that was not on screen. */}
              <div className="tw-head-sub">
                {clockLabel(trace.startTime)}
                <span className="sep">&middot;</span>
                {totalCount} spans across {shownServiceCount} service{shownServiceCount === 1 ? '' : 's'}
              </div>
            </div>
            <div className="tw-head-actions">
              {hiddenServices > 0 && (
                <label className="tw-toggle">
                  <input type="checkbox" checked={fullTrace} onChange={e => setFullTrace(e.target.checked)} />
                  <span className="tw-toggle-track" aria-hidden="true"><span className="tw-toggle-knob" /></span>
                  <span>Show Full Trace</span>
                </label>
              )}
              {/* The reverse of the link that got you here: the drawer sends you
                  to the trace, and the trace sends you back to every log it
                  produced. */}
              <button type="button" className="tw-checklogs" onClick={() => goLogs(trace.traceId)}>
                Check Logs
              </button>
            </div>
          </div>

          {/* Outside the scroll region: the tabs say which view you are in, and
              a control that scrolls out of sight stops answering that the
              moment you start reading the thing it switched to. */}
          <div className="tw-tabs" role="tablist">
            {tabs.map(({ id, label, Icon }) => (
              <button key={id} role="tab" aria-selected={activeTab === id}
                className={`tw-tab${activeTab === id ? ' active' : ''}`} onClick={() => setTab(id)}>
                <Icon size={13} strokeWidth={2} aria-hidden="true" />
                {label}
                {/* The tab is only here when it has errors, so the dot is no
                    longer news — it is what makes the tab's presence land.
                    A missing tab is not something anyone notices. */}
                {id === 'errors' && <span className="tw-tab-dot" />}
              </button>
            ))}
          </div>
          {/* The tables and the waterfall each scroll on their own, and the
              separator between them decides how the height is split. Reading a
              trace moves between the two — which operation is slow, then where
              it sits in the call — and how much room each deserves depends on
              the trace, so it is the reader's call rather than a fixed ratio. */}
          <div className="tw-tables" ref={tablesRef} style={{ height: tablePx }}>
            <div className="tw-tabbody">
              {activeTab === 'summary' && <SummaryTab trace={shown} onFocus={focusSpan} />}
              {activeTab === 'database' && <DatabaseTab trace={shown} onFocus={focusSpan} />}
              {activeTab === 'errors' && (
                <ErrorsTab trace={shown} onFocus={focusSpan} onOpenStack={setStackSpan} />
              )}
              {activeTab === 'profiles' && (
                <ProfilesTab span={span} narrow={narrowProfile} setNarrow={setNarrowProfile} />
              )}
            </div>
          </div>

          <div
            ref={splitRef}
            className={`tw-split${dragging ? ' is-dragging' : ''}`}
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize the waterfall"
            aria-valuenow={Math.round(tablePx)}
            tabIndex={0}
            onMouseDown={startSplitDrag}
            onKeyDown={onSplitKey}
          >
            <span className="tw-split-grip" aria-hidden="true" />
          </div>

          <div className="tw-wf">
            <div className="tw-wf-head">
              <span>Waterfall</span>
              {/* Saying how many rows are folded is what keeps an auto-folded
                  trace from looking like a short one. */}
              <span className="dim">
                {visibleCount === totalCount
                  ? `${totalCount} spans`
                  : `showing ${visibleCount} of ${totalCount} spans`}
                {depthCount > 0 && ` · ${depthCount} depth`}
              </span>
              <span className="tw-wf-actions">
                <button type="button" onClick={expandAll} disabled={collapsed.size === 0}>Expand all</button>
                <button type="button" onClick={collapseAll}>Collapse all</button>
              </span>
            </div>
            <TableQuerySearch
              onApply={onSearch}
              fields={searchFields}
              suggest
              valuesFor={valuesFor}
              placeholder="Search spans ( eg. service:payment-service AND http.status_code:500 )"
              status={queryText.trim() ? (
                <div className="tw-search-status" role="status">
                  {matchList.length === 0
                    ? <span className="tw-search-none">No spans match</span>
                    : <span>{matchList.length} match{matchList.length === 1 ? '' : 'es'} · showing {safeIdx + 1} of {matchList.length}</span>}
                  {matchList.length > 1 && (
                    <span className="tw-search-nav">
                      <button type="button" onClick={() => stepMatch(-1)} aria-label="Previous match" title="Previous match">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 15l-6-6-6 6" /></svg>
                      </button>
                      <button type="button" onClick={() => stepMatch(1)} aria-label="Next match" title="Next match">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
                      </button>
                    </span>
                  )}
                </div>
              ) : null}
            />
            <div className="tw-wf-scroll">
              <Waterfall
                trace={shown}
                selected={span}
                onSelect={select}
                collapsed={collapsed}
                onToggle={toggle}
                matchIds={matchIds}
                currentMatchId={currentMatch?.id ?? null}
                rowRefs={rowRefs}
              />
            </div>
          </div>
        </div>
        <SpanDetails span={span} trace={trace} />
      </div>
      {stackSpan && <StackModal span={stackSpan} onClose={() => setStackSpan(null)} />}
    </>
  )
}
