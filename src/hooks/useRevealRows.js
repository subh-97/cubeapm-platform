import { createElement, useEffect, useRef, useState } from 'react'

// How many rows a table draws at first, and how many more arrive each time
// its end scrolls near.
export const REVEAL_STEP = 20

// How far below the visible rows the end may still be when the next twenty
// are fetched: a few rows' worth. A screenful would fetch them before anyone
// scrolled, wherever the first twenty end below the fold.
const LEAD = '0px 0px 200px 0px'

/**
 * A table's rows, twenty at a time: the first twenty draw, and the next twenty
 * arrive as the end of the list scrolls to within a few rows of the screen
 * (LEAD), so a reader scrolling down rarely meets it. A table of hundreds
 * mounts what is near the screen rather than all of it. A short page whose
 * twenty rows already end on screen takes the next twenty at once: with
 * nothing to scroll, the reader would otherwise never see them.
 *
 *   rows   the table's rows, already searched, filtered and sorted
 *   keep   the index of a row that must be drawn however far down it sits (the
 *          selected one), or -1. The rows down to it stay drawn after it is let
 *          go, so closing a drawer can hand focus back to its row and the list
 *          does not shrink under the reader.
 *   reset  what makes a new list, which starts again at twenty: the search and
 *          filters (or query) the rows answer. By default the number of rows,
 *          for a table with nothing else to go by; a table whose rows also come
 *          and go for other reasons (a fold opened, a row deleted) passes its
 *          search, so those keep what is drawn.
 *
 * Returns `rows`, the ones to draw, and `sentinel`: an element for the caller
 * to place after the last row (after a <table>, never inside its body), null
 * once every row is drawn. Rendered on the server, as the tests do, it is the
 * first twenty (and any kept row).
 */
export function useRevealRows(rows, keep = -1, reset = rows.length) {
  const [count, setCount] = useState(() => Math.max(REVEAL_STEP, keep + 1))
  const [seen, setSeen] = useState(reset)
  if (!Object.is(seen, reset)) {
    setSeen(reset)
    setCount(Math.max(REVEAL_STEP, keep + 1))
  } else if (keep >= count) {
    setCount(keep + 1)
  }
  const limit = Math.max(count, keep + 1)
  const more = rows.length > limit
  const ref = useRef(null)

  useEffect(() => {
    const el = ref.current
    if (!more || !el) return undefined
    if (typeof IntersectionObserver === 'undefined') { setCount(Infinity); return undefined }
    // Observed afresh after every step: a new observer reports at once, so a
    // screen tall enough to still show the end takes the next twenty too.
    const io = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) setCount(c => Math.max(c, limit) + REVEAL_STEP)
    }, { root: scroller(el), rootMargin: LEAD })
    io.observe(el)
    return () => io.disconnect()
  }, [more, limit])

  return {
    rows: more ? rows.slice(0, limit) : rows,
    sentinel: more ? createElement('div', { ref, className: 'reveal-sentinel', 'aria-hidden': true }) : null,
  }
}

// The box the rows scroll in: the nearest ancestor that scrolls vertically,
// so the lead is measured against it (the viewport never clips the rows
// itself), or the viewport when nothing scrolls yet. A table's sideways
// scroller (.table-scroll) computes overflow-y: auto too, but never overflows
// downwards, so it is passed over.
function scroller(el) {
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (p.scrollHeight > p.clientHeight && /auto|scroll/.test(getComputedStyle(p).overflowY)) return p
  }
  return null
}
