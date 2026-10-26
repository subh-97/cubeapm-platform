import { useCallback, useEffect, useRef, useState } from 'react'

// A press-and-drag that picks a run of cells: buckets along one axis (the
// latency histogram), or a rectangle of them on two (the heatmap's columns of
// time and rows of latency). The cells are the chart's own, so a selection is
// always whole buckets — production's "8.8 ms - 27.83 ms" runs from the low
// edge of the first bar to the high edge of the last.
//
// The gesture is useTimeFocus's, rule for rule, because a reader learns it once
// for every chart on the platform: left button only (a touch is a clean no-op),
// a 3 px slop before a press becomes a drag (a click to read a tooltip must not
// select anything), release anywhere on the page commits, and Escape, a scroll
// under the pointer or the window losing focus abandons it. Two guards it adds,
// from Home's health strip: a move that arrives with the button already up (the
// release happened outside the window) abandons it, and the selection is
// sorted, so a drag right to left selects what a drag left to right does.
//
// What it does not share with useTimeFocus is the commit. A drag here sets a
// filter the chart owns, not the page's time range, so there is no five-minute
// floor and no zoom: `onCommit(rect)` hands the caller the cells.

/** The cells between two corners, sorted: `{ x0, x1, y0, y1 }` (y's absent on one axis). */
export function brushRect(a, b) {
  const rect = { x0: Math.min(a.x, b.x), x1: Math.max(a.x, b.x) }
  if (a.y != null && b.y != null) {
    rect.y0 = Math.min(a.y, b.y)
    rect.y1 = Math.max(a.y, b.y)
  }
  return rect
}

/** Whether a cell is inside a rectangle (on one axis, the y's are not asked). */
export function inRect(rect, x, y) {
  if (!rect) return false
  if (x < rect.x0 || x > rect.x1) return false
  if (rect.y0 != null && y != null && (y < rect.y0 || y > rect.y1)) return false
  return true
}

const DRAG_SLOP_PX = 3

/**
 * The gesture's state and its two handlers. The caller works out which cell is
 * under the pointer — `down(cell, event)` on press, `move(cell, event)` on
 * every move — and passes null for a pointer outside the cells, which freezes
 * the selection where it last was rather than dropping it.
 *
 * Returns `{ preview, dragging, down, move, cancel }`: `preview` is the
 * rectangle being dragged out (null until the slop is crossed).
 */
export function useBucketBrush({ onCommit, enabled = true }) {
  const anchor = useRef(null) // { cell, x, y, moved }
  const [preview, setPreview] = useState(null)
  const previewRef = useRef(null)

  const cancel = useCallback(() => {
    anchor.current = null
    previewRef.current = null
    setPreview(null)
  }, [])

  // Release commits wherever the pointer is: the document hears it, so a drag
  // can finish outside the chart ("from here to the end").
  useEffect(() => {
    if (!enabled) return undefined
    const onUp = () => {
      const a = anchor.current
      const p = previewRef.current
      anchor.current = null
      previewRef.current = null
      setPreview(null)
      if (a?.moved && p) onCommit?.(p)
    }
    document.addEventListener('mouseup', onUp)
    return () => document.removeEventListener('mouseup', onUp)
  }, [enabled, onCommit])

  // Abandoned, not committed, on Escape, on a scroll that would slide the chart
  // under a still pointer, and when the window loses focus mid-drag.
  useEffect(() => {
    if (!preview) return undefined
    const onKey = e => { if (e.key === 'Escape') cancel() }
    document.addEventListener('keydown', onKey)
    document.addEventListener('scroll', cancel, true)
    window.addEventListener('blur', cancel)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('scroll', cancel, true)
      window.removeEventListener('blur', cancel)
    }
  }, [preview, cancel])

  const down = useCallback((cell, e) => {
    if (!enabled || !cell || !e || e.button !== 0) return
    anchor.current = { cell, x: e.clientX, y: e.clientY, moved: false }
  }, [enabled])

  const move = useCallback((cell, e) => {
    const a = anchor.current
    if (!a) return
    if (e && (e.buttons & 1) === 0) { cancel(); return }
    if (!cell) return
    if (!a.moved) {
      const same = cell.x === a.cell.x && cell.y === a.cell.y
      const far = Math.hypot((e?.clientX ?? a.x) - a.x, (e?.clientY ?? a.y) - a.y) >= DRAG_SLOP_PX
      if (same && !far) return
      a.moved = true
    }
    const rect = brushRect(a.cell, cell)
    previewRef.current = rect
    setPreview(prev => (prev && prev.x0 === rect.x0 && prev.x1 === rect.x1 && prev.y0 === rect.y0 && prev.y1 === rect.y1 ? prev : rect))
  }, [cancel])

  return { preview, dragging: !!preview, down, move, cancel }
}
