import { formatLocal } from '@/utils/timeRange'

// One tooltip for every time-series chart on the platform.
//
// There were nine of these, each with its own markup, and they had drifted into
// disagreeing about the two things a chart tooltip is for: WHEN this reading was
// taken, and WHAT each series was doing at the time.
//
// Three rules, all of them from comparing ours against the product this
// redesign is replacing:
//
//   1. THE HEADING IS A FULL INSTANT. `Oct 06 23:57` cannot be pasted into a
//      query, cross-referenced against a log line, or read a month later. The
//      axis is allowed to be terse because it is fighting its neighbours for
//      pixels; the tooltip is not, so it carries the year and the seconds.
//   2. THE SECOND LINE IS HOW LONG AGO, IN WORDS. "-27m" is axis shorthand — it
//      belongs on an axis, where it is one of twelve and the reader learns the
//      convention from its neighbours. On its own it needs reading twice.
//   3. COLOUR IS A TAG, NOT THE TEXT. Rows read in the body colour with a
//      swatch beside them. Colouring the text makes every row a different
//      contrast against the background — the pale ones get hard to read — and
//      it spends colour on identity that the swatch already carries. It also
//      keeps the one case where colour means severity (the log level bands)
//      honest: the swatch stays red, the number stays legible.
//
// The hovered series is emphasised and the rest recede, so pointing at a band
// answers "which one is that" without moving the eye off the chart.

const SWATCH = { width: 8, height: 8, borderRadius: 2, flexShrink: 0 }

/** `2026-10-06 23:57:00` — unambiguous on its own, a month from now. */
export function fullInstant(ms) {
  return formatLocal(ms, 'YYYY-MM-DD HH:mm:ss')
}

/**
 * `27 mins ago`, in words rather than in axis shorthand.
 *
 * Measured against the window's own right-hand edge rather than the wall clock,
 * so it agrees with the axis beside it: both call that edge "now", and a window
 * that stops short of the present must not describe its last bucket as current.
 */
export function timeAgo(ms, nowMs) {
  const secs = Math.max(0, Math.round((nowMs - ms) / 1000))
  if (secs < 45) return 'just now'
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins} ${mins === 1 ? 'min' : 'mins'} ago`
  const hours = Math.round(mins / 60)
  if (hours < 48) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`
  const days = Math.round(hours / 24)
  return `${days} ${days === 1 ? 'day' : 'days'} ago`
}

/**
 * @param {object}  props
 * @param {number}  props.tMs      the instant this reading was taken, in ms
 * @param {number}  props.nowMs    what the window calls "now" (win.end * 1000)
 * @param {Array}   props.items    [{ key, label, value, color }] — value is already formatted
 * @param {string}  [props.hoverKey]  the series being pointed at, emphasised
 * @param {object}  [props.footer] { label, value } under a rule
 * @param {number}  [props.minWidth]
 */
export default function ChartTooltip({ tMs, nowMs, items, hoverKey, footer, minWidth = 200, suppressed }) {
  // Charts that share a syncId all go active at once, so without this every
  // chart on the page opens a panel when any one of them is hovered — six
  // overlays for one question. The cursor line still draws on all of them
  // (Recharts renders it independently of this content), which is the part
  // that actually carries the link.
  if (suppressed) return null
  const dimmed = hoverKey != null && items.some(i => i.key === hoverKey)
  return (
    <div
      style={{
        background: 'var(--raised)',
        // The lighter of the two border tokens, and a shadow that only has to
        // lift the panel off the chart behind it. A tooltip is already the
        // brightest thing on screen and it sits still for a fraction of a
        // second — anything heavier reads as a modal rather than as a readout.
        border: '1px solid var(--border-subtle)',
        borderRadius: 6,
        padding: '7px 10px',
        fontSize: 11,
        lineHeight: '1.5',
        minWidth,
        boxShadow: '0 2px 6px rgba(0,0,0,.14)',
      }}
    >
      {tMs != null && (
        <>
          <div style={{ color: 'var(--text-primary)', fontWeight: 600, marginBottom: 1 }}>
            {fullInstant(tMs)}
          </div>
          <div style={{ color: 'var(--text-muted)', fontSize: 10, marginBottom: 5 }}>
            {timeAgo(tMs, nowMs)}
          </div>
        </>
      )}
      {items.map(it => {
        const isHovered = hoverKey != null && it.key === hoverKey
        return (
          <div
            key={it.key}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              // The pointed-at row reads at full strength and the rest step
              // back. Nothing moves and nothing changes size, so the list stays
              // readable as the pointer travels across the bands.
              opacity: dimmed && !isHovered ? 0.45 : 1,
              fontWeight: isHovered ? 600 : 400,
            }}
          >
            <span style={{ ...SWATCH, background: it.color }} />
            <span style={{ color: 'var(--text-primary)', flex: 1, minWidth: 0 }}>{it.label}</span>
            <span style={{ color: 'var(--text-primary)', fontWeight: isHovered ? 700 : 600, flexShrink: 0 }}>
              {it.value}
            </span>
          </div>
        )
      })}
      {footer && (
        <div
          style={{
            borderTop: '1px solid var(--border-panel)',
            marginTop: 5,
            paddingTop: 5,
            display: 'flex',
            justifyContent: 'space-between',
            gap: 16,
            color: 'var(--text-primary)',
            fontWeight: 600,
          }}
        >
          <span>{footer.label}</span><span>{footer.value}</span>
        </div>
      )}
    </div>
  )
}
