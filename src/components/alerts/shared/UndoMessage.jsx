import { useEffect } from 'react'
import './alerts-shared.css'

const isMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '')

// Somewhere that types keeps its own ⌘Z / Ctrl+Z.
const typing = el => !!el && (el.isContentEditable || ['TEXTAREA', 'SELECT'].includes(el.tagName)
  || (el.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit', 'reset'].includes(el.type)))

/**
 * A toast message with an Undo, for the changes that can be taken back: pause,
 * resume, snooze, unsnooze (DESIGN D16). Production confirms none of these; it
 * just changes state silently, and a misclick on its row switch stops a rule
 * evaluating with no trace.
 *
 * ⌘Z (Ctrl+Z off a Mac) undoes too, while the toast is up and focus is not in
 * a field that types (7c): the toast sits after the whole page in tab order,
 * so from the keyboard its button is out of reach before it goes.
 *
 * The app's Toast takes any node as its message, so this needs nothing from it:
 *   setToast(<UndoMessage text="Paused payment-service error rate."
 *     onUndo={() => { actions.resume(id); setToast(null) }} />)
 */
export default function UndoMessage({ text, onUndo }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.defaultPrevented || e.altKey || e.shiftKey || !(e.metaKey || e.ctrlKey)) return
      if (e.key !== 'z' && e.key !== 'Z') return
      if (typing(document.activeElement)) return
      if (document.querySelector('[role="dialog"], [role="menu"]')) return
      e.preventDefault()
      onUndo?.()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onUndo])

  const keys = isMac() ? '⌘Z' : 'Ctrl+Z'
  return (
    <span className="alr-undo">
      <span>{text}</span>
      <button
        type="button"
        className="alr-undo-btn"
        onClick={onUndo}
        aria-keyshortcuts="Meta+Z Control+Z"
        title={`Undo (${keys})`}
      >
        Undo
      </button>
      <kbd className="alr-undo-kbd" aria-hidden="true">{keys}</kbd>
    </span>
  )
}
