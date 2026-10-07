import { useCallback, useEffect, useRef, useState } from 'react'
import { ReferenceArea } from 'recharts'
import { zoomRange } from '@/utils/timeRange'

// Drag across any chart to make that span the page's time range.
//
// The gesture already existed on the Logs and Traces volume charts, hand-rolled
// twice. This is the same gesture as one thing, so every chart can have it and
// they all behave identically — which matters more than it sounds, because the
// range it sets is shared: drag on one chart and every other chart on the page
// redraws for the new window.
//
// DESKTOP ONLY, deliberately. Recharts routes touch through the mouse handlers
// badly — `handleTouchStart` hands `onMouseDown` a `Touch` object, which has no
// `button` and no `preventDefault`, and it commits through `onMouseUp` rather
// than the document `mouseup` this hook listens on. The `button !== 0` guard
// below makes a touch a clean no-op instead of a half-started drag that can
// never finish. Nothing else in this product supports touch either.
//
// A chart needs a <Tooltip> child for the move events to arrive at all:
// Recharts only attaches `onMouseMove` to the wrapper when a Tooltip is present
// and the tooltip's event type is 'axis' (parseEventsOfWrapper). Every chart
// that adopts this hook has one; a chart without a tooltip cannot be brushed.

/**
 * The shortest window a drag may produce. The product's own shortest preset —
 * below it the bucket count collapses (a one-minute window is four 15-second
 * buckets) and the chart reads as broken rather than as zoomed. A selection
 * under the floor is grown around its centre, not refused: the reader asked for
 * "around here", and the floor is a rendering limit rather than a rejection.
 */
export const MIN_FOCUS_MS = 5 * 60 * 1000

/** How far the pointer must travel before a click becomes a drag. */
const DRAG_SLOP_PX = 3

/**
 * Resolve whatever Recharts reports as `activeLabel` to one of the window's
 * buckets. A numeric axis reports the x value in ms; a category axis reports
 * the bucket's label string. Both land on the same bucket.
 */
function bucketFrom(win, activeLabel) {
  if (activeLabel == null) return null
  if (typeof activeLabel === 'number') {
    if (!Number.isFinite(activeLabel)) return null
    const i = Math.floor((activeLabel / 1000 - win.start) / win.step)
    return win.buckets[Math.max(0, Math.min(win.buckets.length - 1, i))] ?? null
  }
  return win.buckets.find(b => b.label === activeLabel) ?? null
}

/**
 * @param {object} win   the resolved window the chart is drawing
 * @param {object} opts
 * @param {(range: {kind:'absolute', from:number, to:number}) => void} opts.onFocus
 *        called once, on release, with the range the reader selected
 * @param {'time'|'category'} [opts.kind] which axis the chart plots on
 * @param {boolean} [opts.enabled] false for a chart that should not be brushed
 */
export function useTimeFocus(win, { onFocus, kind = 'time', enabled = true } = {}) {
  const [sel, setSel] = useState(null) // { fromMs, toMs, x1, x2 } while dragging
  // Which chart the pointer is actually in. Charts that share a syncId all go
  // active together — that is the point of syncing — but only one of them is
  // being READ, and only that one should open a panel over itself. The rest
  // show the crosshair alone, which is what the sync is for.
  const [hovered, setHovered] = useState(false)
  const anchor = useRef(null)          // { bucket, x1, clientX, moved }

  const cancel = useCallback(() => { anchor.current = null; setSel(null) }, [])

  // A drag is abandoned rather than committed when the reader presses Escape,
  // or when the panel scrolls underneath the pointer — on a scrolling page the
  // chart would otherwise slide under a stationary cursor and the selection
  // would grow on its own.
  useEffect(() => {
    if (!sel) return undefined
    const onKey = e => { if (e.key === 'Escape') cancel() }
    document.addEventListener('keydown', onKey)
    document.addEventListener('scroll', cancel, true)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('scroll', cancel, true)
    }
  }, [sel, cancel])

  // Release commits, wherever the pointer happens to be. Listening on the
  // document rather than on the chart is what lets a drag finish outside the
  // plot — which is how a reader selects "from here to the end".
  useEffect(() => {
    if (!enabled) return undefined
    const onUp = () => {
      const a = anchor.current
      const s = sel
      anchor.current = null
      setSel(null)
      if (!a || !s || !a.moved) return
      const stepMs = win.step * 1000
      const lo = Math.min(s.fromMs, s.toMs)
      // The later bucket contributes its whole span: a drag that ends on a
      // bucket means "including that bucket", not "up to where it starts".
      const hi = Math.max(s.fromMs, s.toMs) + stepMs
      const next = zoomRange(lo, Math.min(hi, win.end * 1000), {
        // Snap to the bucket when buckets are finer than a minute, or a
        // two-bucket drag on a 5-minute window would hand back twice the span
        // that was actually selected.
        snapMs: Math.min(stepMs, 60000),
        minSpanMs: MIN_FOCUS_MS,
        notAfterMs: win.nowSec * 1000,
      })
      if (next) onFocus?.(next)
    }
    document.addEventListener('mouseup', onUp)
    return () => document.removeEventListener('mouseup', onUp)
  }, [enabled, sel, win, onFocus])

  const onMouseDown = useCallback((state, ev) => {
    if (!enabled) return
    // Left button only. A Touch object has no `button`, so this is also what
    // makes the gesture a no-op on touch rather than a drag that cannot commit.
    if (!ev || ev.button !== 0) return
    const b = bucketFrom(win, state?.activeLabel)
    if (!b) return
    anchor.current = { bucket: b, chartX: state?.chartX ?? 0, moved: false }
  }, [enabled, win])

  const onMouseMove = useCallback((state) => {
    const a = anchor.current
    if (!a) return
    const b = bucketFrom(win, state?.activeLabel)
    if (!b) return
    // Below the slop this is still a click — a reader who clicks a chart to
    // read a tooltip must not have the page's range changed underneath them.
    if (!a.moved) {
      const dx = Math.abs((state?.chartX ?? 0) - a.chartX)
      if (b.i === a.bucket.i && dx < DRAG_SLOP_PX) return
      a.moved = true
    }
    const x = kind === 'category' ? b.label : b.ms
    const x1 = kind === 'category' ? a.bucket.label : a.bucket.ms
    setSel({ fromMs: a.bucket.ms, toMs: b.ms, x1, x2: x })
  }, [win, kind])

  const overlay = sel && sel.x1 !== sel.x2
    ? (
      <ReferenceArea
        x1={sel.x1}
        x2={sel.x2}
        stroke="var(--brand)"
        strokeOpacity={0.6}
        fill="var(--brand)"
        fillOpacity={0.14}
        // The band must not be allowed to stretch the axis it is drawn on.
        ifOverflow="hidden"
      />
    )
    : null

  return {
    dragging: !!sel,
    hovered,
    overlay,
    chartProps: enabled
      ? {
        onMouseDown,
        onMouseMove,
        onMouseEnter: () => setHovered(true),
        onMouseLeave: () => setHovered(false),
        style: { cursor: sel ? 'ew-resize' : 'crosshair', userSelect: 'none' },
      }
      : {},
  }
}

/**
 * The chart's own width in pixels, for sizing the tick ladder.
 *
 * The ladder has to know how much room it has — the whole point is that a
 * narrow chart gets fewer labels rather than overlapping ones — and
 * ResponsiveContainer does not hand that number out. Attach `ref` to the
 * element wrapping the container and read `width`.
 *
 * Starts at 0, which every ladder treats as "no room": the first paint shows
 * the coarsest tick set for a frame, then settles. That is the right direction
 * to be wrong in — too few labels reads as sparse, too many as broken.
 */
export function useMeasuredWidth() {
  const ref = useRef(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect?.width
      if (w != null) setWidth(Math.round(w))
    })
    ro.observe(el)
    setWidth(Math.round(el.getBoundingClientRect().width))
    return () => ro.disconnect()
  }, [])
  return [ref, width]
}

/**
 * Which series the pointer is on, and the props that report it.
 *
 * A multi-series chart's tooltip lists every series at once, so without this
 * the reader has to work out which of five rows belongs to the line they are
 * actually pointing at. With it, that row stays at full strength and the others
 * step back — the answer is where their eye already is.
 *
 * Spread `hoverProps(key)` onto each <Line>/<Area>/<Bar> and hand `hoverKey` to
 * the tooltip. Recharts applies child event handlers to every rendered shape
 * (`adaptEventsOfChild`), and the tooltip's own cursor rectangle is
 * `pointerEvents: 'none'`, so these do reach the series.
 */
export function useSeriesHover() {
  const [hoverKey, setHoverKey] = useState(null)
  const hoverProps = useCallback(key => ({
    onMouseEnter: () => setHoverKey(key),
    // Clear only if this series is still the one recorded. Crossing straight
    // from one band into its neighbour delivers enter-then-leave or
    // leave-then-enter depending on the geometry, and the naive version lands
    // on "nothing hovered" in one of those orders.
    onMouseLeave: () => setHoverKey(cur => (cur === key ? null : cur)),
  }), [])
  return [hoverKey, hoverProps]
}
