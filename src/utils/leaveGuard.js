// One page with unsaved work, and everything that would leave it asking first.
//
// The app runs on a plain BrowserRouter, which has no blocker: react-router's
// `useBlocker` needs a data router. So the page that holds a draft registers a
// guard here, and App's own ways out — the sidebar, the crumbs, a handoff —
// go through `requestLeave`, which either leaves at once or lets the guard ask
// and call `proceed` if the answer is yes. The page covers what App cannot
// see itself: the browser's Back button and closing the tab.

let guard = null

/**
 * Register the guard: `(proceed) => void`, called instead of leaving. Returns
 * the function that removes it, which removes only this guard.
 */
export function setLeaveGuard(fn) {
  guard = fn
  return () => {
    if (guard === fn) guard = null
  }
}

/** Leave now, or let the registered guard decide. */
export function requestLeave(proceed) {
  if (guard) guard(proceed)
  else proceed()
}

/** Whether something would ask first. */
export const hasLeaveGuard = () => guard != null
