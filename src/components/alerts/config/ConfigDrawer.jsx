import { useEffect, useId, useRef } from 'react'
import { X } from 'lucide-react'
import { trapTab } from '@/utils/focusTrap'

/**
 * The right-hand drawer the configuration tabs edit in (docs/alerts/DESIGN.md
 * D9): App's settings drawer, its look and its keyboard contract — a dialog
 * over a dimmed page, focus brought in as it opens and kept in it, Escape to
 * close, and focus handed back to whatever opened it. Production's drawers
 * close on a click outside and discard what was typed without a word; here
 * the backdrop and Escape go through `onClose`, which can ask first.
 */
export default function ConfigDrawer({ title, onClose, footer, className, children }) {
  const ref = useRef(null)
  const titleId = useId()
  useEffect(() => {
    const opener = document.activeElement
    const first = ref.current?.querySelector('input, textarea, select, button:not(.drawer-close)')
    ;(first ?? ref.current)?.focus({ preventScroll: true })
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true })
    }
  }, [])
  const onKeyDown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); return }
    trapTab(e)
  }
  return (
    <>
      <div className="settings-backdrop open" onClick={onClose} />
      <div ref={ref} className={`settings-drawer open cfg-drawer${className ? ` ${className}` : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={onKeyDown}>
        <div className="cfg-drawer-head">
          <h2 id={titleId} className="cfg-drawer-title">{title}</h2>
          <button type="button" className="drawer-close hbtn icon-only" aria-label="Close" title="Close" onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </div>
        <div className="cfg-drawer-body">{children}</div>
        {footer && <div className="cfg-drawer-foot">{footer}</div>}
      </div>
    </>
  )
}
