import { useEffect, useRef } from 'react'
import { TABBABLE } from '@/utils/focusTrap'
import { countdown, toastDuration } from '@/utils/toastTimer'

/**
 * The app's one toast. It goes by itself, but never out from under someone
 * using it: the pointer resting on it, or focus anywhere inside it, holds the
 * countdown, and leaving resumes it from where it stopped (WCAG 2.2.1, Timing
 * Adjustable). A message carrying a control of its own, such as UndoMessage's
 * Undo, is given 10s rather than a plain notice's 4.5s. `duration` sets the
 * time outright, and 0 keeps the toast until it is closed.
 *
 * A new `message` is a new toast with a fresh countdown. Any other re-render,
 * App's inline `onClose` included, leaves the countdown where it is.
 */
export default function Toast({ message, onClose, duration }) {
  const barRef = useRef(null)
  const msgRef = useRef(null)
  const timerRef = useRef(null)
  // Read through a ref: App hands over a new inline onClose on every render,
  // and the countdown must not start over each time it does.
  const onCloseRef = useRef(onClose)
  useEffect(() => { onCloseRef.current = onClose })

  useEffect(() => {
    const bar = barRef.current
    const t = countdown(
      toastDuration({ duration, interactive: msgRef.current.querySelector(TABBABLE) != null }),
      () => onCloseRef.current?.(),
    )
    // A message that takes over from another while the pointer is still on the
    // toast, or focus still in it, starts held: no enter or focus event is
    // coming to say so.
    if (bar.matches(':hover')) t.hold('pointer')
    if (bar.contains(document.activeElement)) t.hold('focus')
    timerRef.current = t
    return () => t.cancel()
  }, [message, duration])

  return (
    <div
      ref={barRef}
      className="toast-bar"
      role="status"
      aria-live="polite"
      onMouseEnter={() => timerRef.current?.hold('pointer')}
      onMouseLeave={() => timerRef.current?.release('pointer')}
      onFocus={() => timerRef.current?.hold('focus')}
      // Focus moving between the toast's own controls has not left it.
      onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) timerRef.current?.release('focus') }}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v.01M11 12h1v4h1" />
      </svg>
      <span className="toast-msg" ref={msgRef}>{message}</span>
      <button className="toast-close" onClick={onClose} aria-label="Dismiss">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
      </button>
    </div>
  )
}
