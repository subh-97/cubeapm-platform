// The Error details drawer: one error group, opened from a row of the Errors
// page, with up to ten of its occurrences to step through.
//
// It sits in front of the table the way the Logs and Traces record drawer does
// — an overlay inside .logs-main, built on .log-detail — so opening it never
// reflows the page under the row that was clicked. Everything it shows is a
// pure function of the group and the window it was handed: the occurrences and
// the host/version breakdown are read off the data layer synchronously, so
// stepping never shows a loading state, and the trace each occurrence names is
// the one /trace/<id> draws.
//
// Top to bottom it goes from the group to one occurrence of it: how many and
// since when, where they land, then the occurrence itself, its stack and its
// attributes. Prev/Next only changes the second half.

import { useState, useMemo, useEffect, useRef, useCallback } from 'react'
import { ArrowUpRight, ChevronLeft, ChevronRight, Copy, X } from 'lucide-react'
import { errorSamplesFor, errorBreakdownFor } from '@/data/errors'
import { httpReason, httpCodeClass, previousPeriodText, deltaChip } from '@/utils/errorsPage'
import { TIME_PRESETS } from '@/utils/timeRange'
import { copyText } from '@/utils/clipboard'
import { fullInstant, timeAgo } from '@/components/charts/ChartTooltip'
import { msLabel } from '@/components/trace/Waterfall'
import { classifyStackLines, countFrames, foldStack, FOLD_FRAMES } from './stackTrace'
import { sharePercents, shareText } from './shares'
// errors.css for .errp-delta, the table row's count chip, which the summary
// reuses; said here rather than left to the page having loaded it first.
import './errors.css'
import './error-details.css'

// A breakdown list past this many rows stops being a glance. The tail is
// summed into one line rather than dropped, so the counts still add up.
const DIST_ROWS = 5

// The drawer is handed the window, not the range it was resolved from. The
// label is enough to recover a listed preset, which is what the comparison is
// worded from; anything else reads as "the previous period".
function rangeOf(win) {
  const preset = !win.isAbsolute && TIME_PRESETS.find(p => p.label === win.label)
  return preset ? { kind: 'preset', value: preset.value } : { kind: 'absolute' }
}

// Esc belongs to whatever the reader is typing in or has open, not to the
// drawer behind it — one key, one dismissal, as ExSelect puts it: a text field,
// the query builder (its suggestion overlay closes on Esc), or a popup open
// elsewhere on the page, such as the time-range picker. Inside the drawer
// nothing opens a popup, so an expanded control there (the stack toggle) does
// not count.
//
// Only an input that takes typing is a text field. A checkbox has no Esc of
// its own, and ticking a facet in the rail beside the drawer leaves focus on
// one (Chrome focuses what it clicks), so Esc from there is still the drawer's.
// A select stays in: its native list closes on Esc, and so do the pickers of
// the date and time inputs, which are not on this list either.
const NOT_TYPED_INTO = ['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image']
const TEXT_ENTRY = [
  `input${NOT_TYPED_INTO.map(t => `:not([type="${t}"])`).join('')}`,
  'textarea', 'select', '[contenteditable=""]', '[contenteditable="true"]',
].join(', ')
// Inside a popup, or on the control that has one open.
const IN_POPUP = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [aria-expanded="true"]'
const OPEN_TRIGGER = '[aria-haspopup]:not([aria-haspopup="false"])[aria-expanded="true"]'

function escapeBelongsElsewhere(target, drawer) {
  const outside = node => !drawer?.contains(node)
  if (target instanceof Element) {
    if (target.closest(TEXT_ENTRY)) return true
    if (target.closest('[class^="qb-"], [class*=" qb-"]')) return true
    if (outside(target) && target.closest(IN_POPUP)) return true
  }
  // The picker can be open with focus somewhere else entirely — Safari does
  // not focus a button it clicks — and its own document-wide Esc handler will
  // close it all the same, so the page is asked as well as the target.
  return [...document.querySelectorAll(OPEN_TRIGGER)].some(outside)
}

// Comparison context for the count (CLAUDE.md rule 6), worded by the same
// helper as the table row's chip so the two never disagree. Information, never
// severity: one info colour whichever way the number moved.
function DeltaChip({ count, prevCount, versus }) {
  const d = deltaChip(count, prevCount, versus)
  return <span className="errp-delta" data-dir={d.dir} title={d.title}>{d.label}</span>
}

// A host goes to Infrastructure, where the box itself can be looked at: is it
// the one that restarted, the one under memory pressure.
function HostLink({ host, onOpenLink }) {
  if (!onOpenLink) return <span className="mono">{host}</span>
  return (
    <button
      type="button"
      className="errd-link mono"
      onClick={() => onOpenLink({ view: 'infra', source: 'host', resource: host })}
      title={`Open ${host} in Infrastructure`}
    >
      <span>{host}</span>
      <ArrowUpRight aria-hidden="true" />
    </button>
  )
}

// One side of "Where it happens". The bars are the group's own errors split by
// one field, so they are drawn in the identity colour: a host with most of the
// errors is where to look, not a host that is more severe than the others.
// Each bar is drawn to its exact share; the figures beside them are rounded
// together so the list reads 100% (see shares.js), the folded tail included.
function Distribution({ title, rows, total, renderValue }) {
  const shown = rows.slice(0, DIST_ROWS)
  const rest = rows.slice(DIST_ROWS)
  const restCount = rest.reduce((a, r) => a + r.count, 0)
  const pcts = sharePercents([...shown.map(r => r.count), restCount])
  return (
    <div className="errd-dist">
      <div className="errd-dist-head">
        {title}
        <span className="errd-dist-n">{rows.length}</span>
      </div>
      <ul className="errd-dist-list">
        {shown.map((r, i) => {
          const pct = total > 0 ? (r.count / total) * 100 : 0
          const share = shareText(pcts[i], r.count)
          return (
            <li
              className="errd-dist-row"
              key={r.value}
              title={`${r.value}: ${r.count.toLocaleString()} of ${total.toLocaleString()} errors (${share})`}
            >
              <div className="errd-dist-line">
                <span className="errd-dist-val">{renderValue(r.value)}</span>
                <span className="errd-dist-pct">{share}</span>
                <span className="errd-dist-count">{r.count.toLocaleString()}</span>
              </div>
              <div className="errd-dist-track" aria-hidden="true">
                <span className="errd-dist-fill" style={{ width: `${pct}%` }} />
              </div>
            </li>
          )
        })}
      </ul>
      {rest.length > 0 && (
        <div className="errd-dist-more">
          {rest.length} more · {restCount.toLocaleString()} errors · {shareText(pcts[shown.length], restCount)}
        </div>
      )}
    </div>
  )
}

// The stack, one line per line so each can say what it is: the throw in red,
// the application's own frames at full strength (that is where a fix goes),
// library frames stepped back, and each wrapped cause as a heading. Folded to a
// dozen frames in a way that keeps the root cause on screen; see foldStack.
function StackTrace({ text, expanded, onToggle }) {
  const lines = useMemo(() => classifyStackLines(text), [text])
  const frames = countFrames(lines)
  const foldable = frames > FOLD_FRAMES
  const shown = expanded || !foldable ? lines : foldStack(lines)

  if (!lines.length) return <div className="errd-none-note">No stack trace was recorded on this occurrence.</div>
  return (
    <div className="errd-stack-box">
      {/* Focusable because it scrolls both ways: a keyboard reader has to be
          able to reach the end of a long frame. ←/→ scroll it rather than
          stepping samples while it has focus. */}
      <pre className="errd-stack mono" tabIndex={0} role="region" aria-label="Stack trace">
        {shown.map((l, i) => (
          l.kind === 'fold'
            ? <span key={i} className="errd-stack-line is-fold">{`… ${l.hidden} frame${l.hidden === 1 ? '' : 's'} folded`}</span>
            : <span key={i} className={`errd-stack-line is-${l.kind}`}>{l.text}</span>
        ))}
      </pre>
      {foldable && (
        <button type="button" className="errd-stack-toggle" aria-expanded={expanded} onClick={onToggle}>
          {expanded ? 'Show fewer frames' : `Show all ${frames} frames`}
        </button>
      )}
    </div>
  )
}

export default function ErrorDetailsDrawer({ group, win, onClose, onOpenTrace, onOpenLink, onViewTraces, setToast }) {
  // The data layer's ten: the original page fetched ten traces per group, and
  // ten is about as many as anyone steps through before opening one.
  const samples = useMemo(() => errorSamplesFor(group, win), [group, win])
  const breakdown = useMemo(() => errorBreakdownFor(group, win), [group, win])

  // The occurrence on screen, held by trace id rather than by position: a
  // refresh or a narrower filter hands back a new list, and the occurrence
  // being read should stay put while it is still in it. One that has gone
  // falls back to the newest.
  const [pickedId, setPickedId] = useState(null)
  const found = samples.findIndex(s => s.traceId === pickedId)
  const index = found >= 0 ? found : 0
  const sample = samples[index] ?? null
  // Kept across Prev/Next: the traces of one group share their shape, and a
  // reader comparing them wants the same view of each.
  const [allFrames, setAllFrames] = useState(false)

  const asideRef = useRef(null)
  const closeRef = useRef(null)
  const prevRef = useRef(null)
  const nextRef = useRef(null)

  const step = useCallback((d) => {
    const next = index + d
    if (next < 0 || next >= samples.length) return
    setPickedId(samples[next].traceId)
    // Reaching an end disables the button that got there, and a disabled
    // button drops focus to the page, taking ←/→ with it. The drawer keeps it.
    const active = document.activeElement
    if ((next === 0 && active === prevRef.current) || (next === samples.length - 1 && active === nextRef.current)) {
      asideRef.current?.focus({ preventScroll: true })
    }
  }, [index, samples])

  // Focus starts on the close button, so Esc, Tab and Enter all have somewhere
  // to go. Closing hands it back to the row that opened the drawer, so a
  // keyboard reader carries on down the table from where they were — but only
  // when focus went nowhere: a click on another row has already put it
  // somewhere better.
  //
  // The opener is read while rendering, not in the effect: Strict Mode runs the
  // effect twice, and by the second run focus is already on the close button.
  const [opener] = useState(() => (typeof document === 'undefined' ? null : document.activeElement))
  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true })
    return () => {
      const now = document.activeElement
      if ((!now || now === document.body) && opener instanceof HTMLElement && opener.isConnected) {
        opener.focus({ preventScroll: true })
      }
    }
  }, [opener])

  // Whose Esc it is gets decided on the key's way down, before any handler has
  // run. For a real keypress React re-renders between one listener and the
  // next, so by the time the key bubbles up to window the time picker that took
  // it has already closed itself, the page reads as if nothing had been open,
  // and the drawer would go with it. The drawer closes on the way back up, so a
  // handler that took the key on purpose (preventDefault) still keeps it.
  useEffect(() => {
    let elsewhere = false
    const onKeyCapture = (e) => {
      if (e.key === 'Escape') elsewhere = escapeBelongsElsewhere(e.target, asideRef.current)
    }
    const onKey = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented || elsewhere) return
      onClose?.()
    }
    window.addEventListener('keydown', onKeyCapture, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKeyCapture, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  // ←/→ step samples while focus is anywhere inside the drawer. Not while a
  // modifier is held (Alt+← is the browser's Back), and not in the stack trace,
  // which scrolls sideways on the same keys.
  const onKeyDown = (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
    if (e.target.closest?.('input, textarea, select, .errd-stack')) return
    e.preventDefault()
    step(e.key === 'ArrowLeft' ? -1 : 1)
  }

  const copyStack = () => {
    if (!sample?.stacktrace) return
    copyText(sample.stacktrace).then(ok => setToast?.(ok
      ? 'Stack trace copied'
      : 'The browser blocked the clipboard, so nothing was copied. Select the trace to copy it by hand.'))
  }

  const client = group.side === 'client'
  const versus = previousPeriodText(rangeOf(win))
  // "Ago" is measured from the now the data was generated against, not the
  // window's right-hand edge: on a window zoomed into the past, an occurrence
  // from three hours ago should still say so.
  const nowMs = win.nowSec * 1000
  const ago = ms => (ms == null ? '—' : timeAgo(ms, nowMs))
  // The group's own first and last seen are bucket edges, which at a week are
  // three hours apart. With ten errors or fewer the samples are every one of
  // them, so their own times are exact and the summary says the same as the
  // first and last occurrence below it.
  const exact = samples.length > 0 && samples.length === group.count
  const firstMs = exact ? samples[samples.length - 1].timeMs : group.firstSeenMs
  const lastMs = exact ? samples[0].timeMs : group.lastSeenMs
  // An error the previous period had too was not first seen in this one, so
  // the first error inside the range is not when it began. Dating it there
  // would put the start at the window's edge, beside a chip that says how many
  // there were before it.
  const seenBefore = (group.prevCount ?? 0) > 0
  const attrs = sample ? Object.entries(sample.attributes ?? {}) : []
  const hasBreakdown = breakdown.host.length > 0 || breakdown.version.length > 0

  return (
    <aside
      ref={asideRef}
      className="log-detail errd"
      aria-label="Error details"
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <div className="log-detail-head errd-head">
        <div className="log-detail-heading">
          <div className="errd-eyebrow">Error details</div>
          <div className="errd-title mono" title={group.exception}>{group.exceptionShort}</div>
          <div
            className="errd-sub"
            title={[group.service, group.endpoint, client ? group.spanName : null].filter(Boolean).join(' · ')}
          >
            {group.service}
            <span className="errd-sep" aria-hidden="true">·</span>
            <span className="mono">{group.endpoint}</span>
            {client && (
              <>
                <span className="errd-sep" aria-hidden="true">·</span>
                <span className="mono">{group.spanName}</span>
              </>
            )}
          </div>
        </div>
        <div className="log-detail-head-right">
          {samples.length > 1 && (
            <nav className="log-detail-nav errd-nav" aria-label="Samples">
              <button
                ref={prevRef}
                type="button"
                onClick={() => step(-1)}
                disabled={index === 0}
                aria-label="Previous sample"
                title="Newer sample (←)"
              >
                <ChevronLeft aria-hidden="true" />
                Prev
              </button>
              <span
                className="errd-pos"
                aria-live="polite"
                title={`Sample ${index + 1} of ${samples.length}, spread across the ${group.count.toLocaleString()} errors in ${win.label}, newest first`}
              >
                {index + 1} of {samples.length}
              </span>
              <button
                ref={nextRef}
                type="button"
                onClick={() => step(1)}
                disabled={index === samples.length - 1}
                aria-label="Next sample"
                title="Older sample (→)"
              >
                Next
                <ChevronRight aria-hidden="true" />
              </button>
            </nav>
          )}
          <button
            ref={closeRef}
            type="button"
            className="log-detail-close"
            onClick={onClose}
            aria-label="Close error details"
            title="Close (Esc)"
          >
            <X aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="errd-body">
        <div className="errd-summary">
          <span className="errd-sum-count">
            <span className="errd-count">{group.count.toLocaleString()}</span>
            {group.count === 1 ? 'error' : 'errors'} in {win.label}
            <DeltaChip count={group.count} prevCount={group.prevCount} versus={versus} />
          </span>
          {seenBefore ? (
            <span
              className="errd-sum-item"
              title={`Already seen in ${versus} (${group.prevCount.toLocaleString()} then)`
                + (firstMs == null ? '' : `; the earliest in ${win.label} was ${ago(firstMs)}`)}
            >
              <span className="errd-sum-key">First seen</span>before this range
            </span>
          ) : (
            <span className="errd-sum-item" title={firstMs == null ? undefined : fullInstant(firstMs)}>
              <span className="errd-sum-key">First seen</span>{ago(firstMs)}
            </span>
          )}
          <span className="errd-sum-item" title={lastMs == null ? undefined : fullInstant(lastMs)}>
            <span className="errd-sum-key">Last seen</span>{ago(lastMs)}
          </span>
        </div>

        {!sample ? (
          <div className="drawer-empty errd-empty">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M9 12l2 2 4-4" /><circle cx="12" cy="12" r="10" />
            </svg>
            <div className="drawer-empty-title">No occurrences to show</div>
            <div className="drawer-empty-sub">
              This error has no recorded occurrences in {win.label}. Widen the time range to look further back.
            </div>
          </div>
        ) : (
          <>
            {hasBreakdown && (
              <section className="errd-section">
                <div className="errd-section-head">
                  <h3 className="errd-section-title">Where it happens</h3>
                </div>
                <div className="errd-where">
                  <Distribution
                    title="Hosts"
                    rows={breakdown.host}
                    total={group.count}
                    renderValue={host => <HostLink host={host} onOpenLink={onOpenLink} />}
                  />
                  <Distribution
                    title="Versions"
                    rows={breakdown.version}
                    total={group.count}
                    renderValue={v => <span className="mono">{v}</span>}
                  />
                </div>
              </section>
            )}

            <section className="errd-section">
              <div className="errd-section-head">
                <h3 className="errd-section-title">Occurrence</h3>
                <span className="errd-section-meta">
                  {samples.length > 1 ? `sample ${index + 1} of ${samples.length}, newest first` : 'the only sample'}
                </span>
              </div>
              <div className="errd-when">
                <span className="mono">{fullInstant(sample.timeMs)}</span>
                <span className="errd-ago">({ago(sample.timeMs)})</span>
              </div>
              <div className="errd-msg">{sample.message}</div>
              <dl className="errd-grid">
                <dt>Trace ID</dt>
                <dd className="errd-trace">
                  <span className="mono">{sample.traceId}</span>
                  {onOpenTrace && (
                    <button
                      type="button"
                      className="errd-link is-action"
                      onClick={() => onOpenTrace(sample.traceId)}
                      title="Open the trace this occurrence failed in"
                    >
                      View full trace
                      <ArrowUpRight aria-hidden="true" />
                    </button>
                  )}
                </dd>
                <dt>Span ID</dt>
                <dd className="mono">{sample.spanId}</dd>
                <dt>Host</dt>
                <dd><HostLink host={sample.host} onOpenLink={onOpenLink} /></dd>
                <dt>Version</dt>
                <dd className="mono">{sample.version}</dd>
                <dt>HTTP status</dt>
                <dd>
                  {sample.httpCode ? (
                    <span className="errd-status">
                      <span className={`tw-code ${httpCodeClass(sample.httpCode)}`}>{sample.httpCode}</span>
                      {httpReason(sample.httpCode)}
                    </span>
                  ) : (
                    // Absent for a reason, and the reason differs: a database
                    // call has no HTTP status at all, and a call that timed out
                    // never got one back.
                    <span
                      className="errd-none"
                      title={!client ? 'No status code was recorded'
                        : group.category === 'db' ? 'A database call has no HTTP status'
                          : 'No response came back for this call'}
                    >—</span>
                  )}
                </dd>
                <dt>Duration</dt>
                <dd className="mono" title={client ? 'How long the whole request ran, not just this call' : undefined}>
                  {msLabel(sample.durationMs)}
                  {client && <span className="errd-gloss">whole request</span>}
                </dd>
                <dt>Endpoint</dt>
                <dd className="mono">{sample.endpoint}</dd>
                {client && (
                  <>
                    <dt>Call</dt>
                    <dd className="mono">{sample.spanName}</dd>
                  </>
                )}
              </dl>
            </section>

            <section className="errd-section">
              <div className="errd-section-head">
                <h3 className="errd-section-title">Stack trace</h3>
                {sample.stacktrace && (
                  <button type="button" className="errd-copy" onClick={copyStack} title="Copy the whole stack trace">
                    <Copy aria-hidden="true" />
                    Copy
                  </button>
                )}
              </div>
              <StackTrace text={sample.stacktrace} expanded={allFrames} onToggle={() => setAllFrames(v => !v)} />
            </section>

            <section className="errd-section">
              <div className="errd-section-head">
                <h3 className="errd-section-title">Attributes</h3>
                <span className="errd-section-meta">{attrs.length}</span>
              </div>
              {attrs.length > 0 ? (
                <dl className="errd-attrs">
                  {attrs.map(([k, v]) => (
                    <div className="errd-attr" key={k}>
                      <dt className="mono">{k}</dt>
                      <dd className="mono">{String(v ?? '')}</dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <div className="errd-none-note">No attributes were recorded on this occurrence.</div>
              )}
            </section>
          </>
        )}
      </div>

      {/* Outside the scrolling body, so the ways out stay in reach however far
          down the stack the reader has gone. */}
      <div className="errd-foot">
        <button
          type="button"
          className="hbtn primary"
          onClick={() => sample && onOpenTrace?.(sample.traceId)}
          disabled={!sample || !onOpenTrace}
          title={sample ? 'Open the trace this occurrence failed in' : 'No occurrence to open'}
        >
          View full trace
          <ArrowUpRight aria-hidden="true" />
        </button>
        <button
          type="button"
          className="hbtn"
          onClick={() => onViewTraces?.(group)}
          title="Every trace with this error, on the Traces page"
        >
          Traces for this error
        </button>
        <button
          type="button"
          className="hbtn"
          // The side travels with it: a Client group is keyed on the outgoing
          // call, which the service's Server list (keyed on its routes) does
          // not have, so landing there would lose the row the reader was on.
          onClick={() => onOpenLink?.({ view: 'service', serviceId: group.service, subTab: 'errors', errorsSide: group.side })}
          title={`Open ${group.service}'s ${group.side} errors on its service page`}
        >
          Open service
        </button>
      </div>
    </aside>
  )
}
