import { useMemo } from 'react'
import { colorForName } from '@/utils/chartPalette'

/**
 * The trace waterfall - the one the trace details page is built on.
 *
 * It lives here rather than inside that page because the service overview shows
 * the same thing for the trace behind a slow request. Two waterfalls would be
 * two answers to "what did this request do", and the second one would be the
 * one nobody maintains.
 */

/** ms with the precision the number deserves — 2.34 ms, 184.2 ms, 1.24 s. */
export function msLabel(v) {
  if (!Number.isFinite(v)) return '—'
  if (v >= 1000) return `${(v / 1000).toFixed(2)} s`
  if (v >= 100) return `${v.toFixed(1)} ms`
  return `${v.toFixed(2)} ms`
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
export function visibleSpans(spans, collapsed) {
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

export default function Waterfall({ trace, selected, onSelect, collapsed, onToggle, matchIds, currentMatchId, rowRefs }) {
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
