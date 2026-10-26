import { useId, useRef } from 'react'
import AlertDialog from './AlertDialog'

/**
 * Deleting a rule says what deleting does, and the button names the act.
 * Production asks "Are you sure you want to delete <name>?" and answers with a
 * bare "Yes" (DESIGN D16). Focus starts on Cancel: this is the one dialog where
 * a reflexive Enter should do nothing.
 */
export default function DeleteRuleDialog({ ruleName, onConfirm, onCancel }) {
  const cancelRef = useRef(null)
  const bodyId = useId()
  return (
    <AlertDialog
      title="Delete rule"
      onCancel={onCancel}
      initialFocus={cancelRef}
      describedBy={bodyId}
      footer={(
        <>
          <button ref={cancelRef} type="button" className="hbtn" onClick={onCancel}>Cancel</button>
          <button type="button" className="hbtn alr-btn-danger" onClick={onConfirm}>Delete rule</button>
        </>
      )}
    >
      <p id={bodyId} className="alr-dialog-text">
        <strong>{ruleName}</strong> stops evaluating and notifying. Its notification history is kept.
      </p>
    </AlertDialog>
  )
}
