// Keeping the keyboard inside a dialog: the exception modal, and the settings
// drawer that sits over the page behind a backdrop.

// What Tab can land on, in document order.
const TABBABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * A keydown handler for the dialog's own element: Tab past its last control
 * comes back to the first, and Shift+Tab before the first goes round to the
 * last — the trap aria-modal promises. Controls that are not drawn (a closed
 * tab's panel) are skipped. Any other key passes through untouched.
 *
 * The dialog itself counts as outside its controls. A dialog carries
 * tabIndex={-1} so that a click on its text (the message, a heading) leaves
 * focus on the dialog rather than dropping it to <body>, where this handler
 * would never hear the next key. From there the browser's own Shift+Tab would
 * step to whatever precedes the dialog in the document — the page behind it —
 * so both directions are taken in hand: Tab to the first control, Shift+Tab to
 * the last, as if focus had come round from the other end.
 */
export function trapTab(e) {
  if (e.key !== 'Tab') return
  const box = e.currentTarget
  // A control the browser skips (a roving tab group's inactive tabs carry
  // tabIndex -1) is no end of the cycle either, however the selector matched it.
  const items = [...box.querySelectorAll(TABBABLE)].filter(el => el.tabIndex >= 0 && el.getClientRects().length > 0)
  if (items.length === 0) return
  const first = items[0]
  const last = items[items.length - 1]
  const at = document.activeElement
  const onAControl = at !== box && box.contains(at)
  if (e.shiftKey && (at === first || !onAControl)) { e.preventDefault(); last.focus() }
  else if (!e.shiftKey && (at === last || !onAControl)) { e.preventDefault(); first.focus() }
}
