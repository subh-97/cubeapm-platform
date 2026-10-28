import { useEffect, useId, useRef } from 'react'
import { X } from 'lucide-react'
import { trapTab } from '@/utils/focusTrap'
import './alerts-shared.css'

/**
 * The small modal the alert controls share: a custom snooze, a delete. Built on
 * the platform's existing dialog (the trace exception modal's overlay and box,
 * `.tw-modal-*`), with its keyboard contract: focus moves in on open and goes
 * back to whatever opened it on close, Tab stays inside (`trapTab`), Escape and
 * a click on the backdrop cancel.
 *
 * `initialFocus` names the control that takes focus first. A destructive dialog
 * points it at Cancel, so an Enter pressed out of habit does not delete.
 */
export default function AlertDialog({ title, onCancel, children, footer, initialFocus, describedBy }) {
  const boxRef = useRef(null)
  const titleId = useId()

  useEffect(() => {
    const opener = document.activeElement
    const target = initialFocus?.current ?? boxRef.current
    target?.focus()
    return () => { if (opener && typeof opener.focus === 'function') opener.focus() }
  }, [initialFocus])

  return (
    <div className="tw-modal-overlay" onClick={onCancel}>
      <div
        ref={boxRef}
        className="tw-modal alr-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedBy}
        tabIndex={-1}
        onClick={e => e.stopPropagation()}
        onKeyDown={e => {
          e.stopPropagation()
          if (e.key === 'Escape') { e.preventDefault(); onCancel?.() }
          else trapTab(e)
        }}
      >
        <div className="alr-dialog-head">
          <div className="alr-dialog-title" id={titleId}>{title}</div>
          <button type="button" className="tw-modal-close" onClick={onCancel} aria-label="Close" title="Close">
            <X size={15} aria-hidden="true" />
          </button>
        </div>
        <div className="alr-dialog-body">{children}</div>
        {footer && <div className="alr-dialog-foot">{footer}</div>}
      </div>
    </div>
  )
}
