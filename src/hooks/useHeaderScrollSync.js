import { useRef, useCallback } from 'react'

/**
 * Keeps a sticky table header level with the rows under it as they scroll
 * sideways — the Logs stream and the Traces span table.
 *
 * The header cannot sit inside the rows' horizontal scroller: that scroller
 * would become the box it sticks to, and since it never scrolls vertically the
 * header would scroll off with the page. So the header has a scroller of its
 * own (.logs-stream-head-scroll) and follows the rows: the rows report every
 * scroll, and the header is set to match.
 *
 * It only ever follows. The header's scroller hides its overflow, so a
 * sideways swipe over it would go nowhere; that swipe is handed to the rows
 * instead, and the header then follows them like any other scroll. Syncing
 * both ways would let the header — which can be a few pixels narrower than
 * the widest row — clamp the rows back whenever it ran out of room first.
 */
export function useHeaderScrollSync() {
  const headRef = useRef(null)
  const bodyRef = useRef(null)

  const onBodyScroll = useCallback(e => {
    if (headRef.current) headRef.current.scrollLeft = e.currentTarget.scrollLeft
  }, [])

  // Shift + wheel is how a mouse without a horizontal wheel scrolls sideways.
  const onHeadWheel = useCallback(e => {
    const dx = e.deltaX || (e.shiftKey ? e.deltaY : 0)
    if (dx && bodyRef.current) bodyRef.current.scrollLeft += dx
  }, [])

  return { headRef, bodyRef, onBodyScroll, onHeadWheel }
}
