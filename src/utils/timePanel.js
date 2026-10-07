// The pure parts of PageBar's time panel and auto-refresh control.
//
// They live here rather than inside the component for two reasons: .jsx files
// in this repo export components only, and this is the logic that is actually
// worth a test — seeding the From/To fields, keeping the offered intervals and
// the tick period in step, and placing a fixed-position panel without pushing
// it off the viewport. The component keeps the DOM and the state; everything
// below is a function of its arguments.
//
// The range model, formatting and validation all come from
// `src/utils/timeRange.js` (ARCH D5). Nothing here invents a second one.

import { AUTO_REFRESH_OPTIONS, formatDateTimeInput, resolveRange } from '@/utils/timeRange'

/**
 * The text the custom From/To fields open on, for whichever form the current
 * range took. An absolute range shows its own ends; a preset shows the window
 * it currently resolves to, so narrowing "Last 6 hours" by an hour is an edit
 * rather than a date lookup.
 *
 * @param {{kind:'preset', value:string} | {kind:'absolute', from:number, to:number} | null} range
 * @returns {{ from:string, to:string }} 'YYYY-MM-DD HH:mm:ss' in local time.
 */
export function seedCustomRange(range, nowMs = Date.now()) {
  if (range?.kind === 'absolute') {
    return { from: formatDateTimeInput(range.from), to: formatDateTimeInput(range.to) }
  }
  // The resolved (step-aligned) ends, not the raw ones: that is the window the
  // charts actually drew, so the fields agree with what is on screen.
  const r = resolveRange(range, nowMs)
  return { from: formatDateTimeInput(r.start * 1000), to: formatDateTimeInput(r.end * 1000) }
}

/**
 * Seconds a page asked for → one of the intervals the control offers, or 0
 * (Off) for anything else. Both the menu value and the tick period go through
 * this, so the control can never say "Off" while a timer is still running.
 */
export function normalizeAutoRefresh(seconds) {
  const n = Number(seconds)
  return AUTO_REFRESH_OPTIONS.some(o => o.value === n) ? n : 0
}

/** What the auto-refresh control reads for a value: 'Off', '30s', '1m'. */
export function autoRefreshLabel(seconds) {
  const n = normalizeAutoRefresh(seconds)
  return AUTO_REFRESH_OPTIONS.find(o => o.value === n).label
}

/**
 * Where the time panel sits: directly under its trigger with the right edges
 * aligned, pulled back inside the viewport rather than overflowing it. The
 * panel is `position: fixed`, so these are viewport coordinates.
 *
 * @param {DOMRect|{right:number,bottom:number}|null} rect the trigger's rect
 * @returns {{top:number, left:number}|null} null before the trigger has a box.
 */
export function panelPosition(rect, viewportWidth, panelWidth = 460, gap = 4, margin = 8) {
  if (!rect) return null
  const left = Math.min(rect.right - panelWidth, viewportWidth - panelWidth - margin)
  return { top: rect.bottom + gap, left: Math.max(margin, left) }
}
