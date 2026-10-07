import { useRef, Fragment } from 'react'
import { fmtDur } from '@/data/runtimeHosts'

// The Runtime tab's host control: a rail flush on the card's left edge, one
// row per host that reported in the window, each with a lifeline.
//
// A lifeline is the selected range on the same time domain as the charts beside
// it, oldest on the left — a timeline, not a progress bar, so it says WHEN a
// host ran and not only how much. Solid where the JVM sent runtime data, a
// hairline where it did not, dotted for the part of "Today" still to come. A
// round end is a JVM starting or stopping; a square end is a run that carries
// on past the edge, or is still going now. Brand blue and neutrals only: this
// list deliberately says nothing about health.

const FLOOR_PX = 3
const CAP_INSET_PX = FLOOR_PX / 2

/** Focus a host row by id, or the first row when that one is gone. */
function focusRow(root, id) {
  const scope = root ?? document.querySelector('.rt-rail')
  if (!scope) return
  const row = (id && scope.querySelector(`[data-host="${id}"]`)) || scope.querySelector('.rt-host')
  row?.focus()
}

/**
 * Geometry for one piece, in CSS so it needs no measuring.
 *
 * Two guarantees, both for the wide ranges where a true-scale piece is
 * sub-pixel. A run is never narrower than 3px — a host that joined fourteen
 * minutes ago is still visible on a seven-day bar. And a round end is inset
 * 1.5px, so two runs either side of a restart always leave a 3px notch centred
 * on the restart, which is why the rolling deploy's notches line up across
 * rows at any width.
 *
 * A square right end only happens where the run meets the edge of what has
 * happened — the range's end, or "now" on Today — so such a run is anchored at
 * that end and its floor grows leftward, never into the future. Every earlier
 * run stops short of the room the later pieces' floors need, so a restart a
 * few minutes before now never reads as the bar ending.
 */
function pieceStyle(p, i, pieces) {
  const pct = v => `${v * 100}%`
  if (p.kind !== 'run') return { left: pct(p.x0), width: pct(p.x1 - p.x0) }

  const insetL = p.capL === 'round' ? CAP_INSET_PX : 0
  const insetR = p.capR === 'round' ? CAP_INSET_PX : 0
  if (p.capR === 'flat') {
    return { right: pct(1 - p.x1), width: `max(${FLOOR_PX}px, calc(${pct(p.x1 - p.x0)} - ${insetL}px))` }
  }
  const pastEnd = pieces.find(q => q.kind === 'future')?.x0 ?? 1
  const reserve = pieces.slice(i + 1)
    .reduce((s, q) => s + (q.kind === 'run' || (q.kind === 'gap' && q.role === 'inner') ? FLOOR_PX : 0), 0)
  const natural = `calc(${pct(p.x1 - p.x0)} - ${insetL + insetR}px)`
  const room = `calc(${pct(pastEnd - p.x0)} - ${insetL + reserve}px)`
  return { left: `calc(${pct(p.x0)} + ${insetL}px)`, width: `max(${FLOOR_PX}px, min(${natural}, ${room}))` }
}

function Track({ pieces }) {
  return (
    <span className="rt-track" aria-hidden="true">
      {pieces.map((p, i) => (
        <span
          key={i}
          className={`rt-piece ${p.kind}${p.capL === 'round' ? ' cap-l' : ''}${p.capR === 'round' ? ' cap-r' : ''}`}
          style={pieceStyle(p, i, pieces)}
        />
      ))}
    </span>
  )
}

function coverageLine(h, win) {
  if (!h.present) return 'No runtime data in this range'
  if (h.coverage >= 1) return 'Reported for the whole range'
  const sofar = win.end > win.nowSec ? ' so far' : ''
  return `Reported ${h.coverageText} of this range · ${fmtDur(h.reportedSec)} of ${fmtDur(h.pastSec)}${sofar}`
}

// The row shows only the host's name; this says what its lifeline shows.
function srSummary(h, win) {
  return [h.note.text && `${h.note.text[0].toUpperCase()}${h.note.text.slice(1)}.`, `${coverageLine(h, win)}.`]
    .filter(Boolean)
    .join(' ')
}

/**
 * @param {object}   props
 * @param {object}   props.win        the page's window
 * @param {object}   props.roster     runtimeRoster(win, selectedId)
 * @param {string|null} props.selectedId  null = every host, averaged
 * @param {Function} props.onSelect   id → toggles that host
 * @param {Function} props.onClear    back to every host
 */
export default function RuntimeRail({ win, roster, selectedId, onSelect, onClear }) {
  const railRef = useRef(null)

  // Clear unmounts itself, so focus goes to the row that was selected rather
  // than falling to the document — or to the first row, when the selected one
  // was a ghost that clearing removes.
  const clear = () => {
    const prev = selectedId
    onClear()
    requestAnimationFrame(() => focusRow(railRef.current, prev))
  }

  // Escape clears the selection; focus stays on whichever row the reader is on.
  const onKeyDown = e => {
    if (e.key !== 'Escape' || !selectedId) return
    e.stopPropagation()
    const ghostFocused = document.activeElement?.closest?.('.rt-host.is-ghost')
    onClear()
    if (ghostFocused) requestAnimationFrame(() => focusRow(railRef.current, null))
  }

  return (
    <aside
      ref={railRef}
      className={`rt-rail${selectedId ? ' has-selection' : ''}`}
      aria-label="Hosts"
      onKeyDown={onKeyDown}
    >
      <div className="rt-head">
        <span id="rt-hosts-title">Hosts · {roster.count}</span>
        {selectedId && (
          <button
            type="button"
            className="logs-filters-clear"
            title="Show all hosts on the charts"
            onClick={clear}
          >
            Clear
          </button>
        )}
      </div>
      <div className="rt-list" role="group" aria-labelledby="rt-hosts-title">
        {roster.hosts.length === 0 && <div className="rt-empty">No hosts reported in this range.</div>}
        {roster.hosts.map(h => (
          <Fragment key={h.id}>
            {h.ghost && <div className="rt-ghost-divider" role="presentation" />}
            <button
              type="button"
              data-host={h.id}
              className={`rt-host${h.ghost ? ' is-ghost' : ''}`}
              aria-pressed={h.id === selectedId}
              aria-describedby={`rt-desc-${h.id}`}
              onClick={() => onSelect(h.id)}
            >
              <span className="rt-host-name">{h.name}</span>
              <Track pieces={h.pieces} />
            </button>
            {/* Outside the button: inside, it would also be read as part of
                the button's name, and the summary would be announced twice. */}
            <span id={`rt-desc-${h.id}`} className="sr-only">{srSummary(h, win)}</span>
          </Fragment>
        ))}
      </div>
    </aside>
  )
}

/**
 * The strip across the top of the charts saying what they are drawn from — the
 * same band the Detail tab's endpoint picker sits in. The rail's default (no
 * host picked) is the only host control on the tab, so it has to read as a
 * choice ("all hosts") and not as nothing selected.
 */
export function RuntimeScope({ roster, selectedId, onShowAll, win, reveal = 'natural' }) {
  const host = roster.hosts.find(h => h.id === selectedId)
  const strip = (
    <div className={`rt-scope${reveal === 'hidden' ? ' is-hidden' : ''}${reveal === 'revealed' ? ' is-revealed' : ''}`}>
      <span>
        Showing runtime results for{' '}
        {host ? <>host - <span className="rt-scope-host">{host.name}</span></> : <span className="rt-scope-what">all hosts</span>}
      </span>
    </div>
  )
  if (!host) return strip

  const drawable = host.bucketCoverage.filter(c => c != null && c >= 0.5).length
  const notice = !host.present
    ? `${host.name} sent no runtime data in this range.`
    : drawable < 2
      ? `${host.name} reported for ${fmtDur(host.reportedSec)} of this range — too little to draw at this range's ${fmtDur(win.step)} step.`
      : null

  return (
    <>
      {strip}
      {notice && (
        <div className="rt-notice" role="status">
          <span>{notice}</span>
          <button
            type="button"
            className="logs-filters-clear"
            onClick={() => {
              const prev = selectedId
              onShowAll()
              // The notice unmounts with the selection; land on the host instead.
              requestAnimationFrame(() => focusRow(null, prev))
            }}
          >
            Show all hosts
          </button>
        </div>
      )}
    </>
  )
}
