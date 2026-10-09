import { useState, useRef, useEffect, useId } from 'react'
import { Copy, X } from 'lucide-react'
import TabBar from '@/components/shared/TabBar'
import { copyText } from '@/utils/clipboard'
import { trapTab } from '@/utils/focusTrap'
import StackTraceView from './StackTraceView'
import { isJsAppFrame } from './stackTrace.js'
import './exception-modal.css'

/**
 * The full stack trace for one exception.
 *
 * A stack trace is the one piece of a span that cannot be read in a table cell
 * or a side panel: it is forty lines wide and tall, and truncating it hides the
 * frame that matters, which is rarely the first one. So it gets the screen.
 *
 * Copy is here because it is what anyone actually does with a stack trace next
 * — paste it into a ticket or a search.
 *
 * Two shapes, chosen by what the caller hands it:
 *
 *   - `stack` alone: the trace detail page's modal, one raw `pre` under the
 *     message, exactly as it was before this left TraceDetail.
 *   - with `unminified`, `unminifiedNote` or `attributes`: a browser exception,
 *     whose recorded stack is minified bundle positions nobody can read. Tabs
 *     then put the source-mapped reading first (the frames classified like the
 *     Errors drawer's, the app's own source at full strength), keep the raw
 *     original one tab over for whoever has to match it against a bundle, and
 *     list the attributes the page recorded with it. With no source map for
 *     the bundle, `unminifiedNote` says so in the first tab and the original
 *     is what opens.
 *
 * It is opened from page content, never from the settings drawer, so it sits
 * at the trace modal's z-index (500), under the drawer (599) and the toast.
 *
 * It is modal for the keyboard as well as the eye: Tab and Shift+Tab cycle
 * through its own controls and never reach the page dimmed behind it. The
 * dialog box itself takes focus (tabIndex -1, so never as a Tab stop) when its
 * text is clicked: otherwise that click would drop focus to <body>, outside
 * the box whose keydown keeps Tab in, and the next Tab would walk into the
 * page. A pointer's focus draws no ring, so the box looks as it always has.
 */

const NO_STACK = 'No stack trace was recorded on this span.'

const TABS = {
  unminified: 'Un-minified stack trace',
  original: 'Original stack trace',
  attributes: 'Attributes',
}

// What Copy puts on the clipboard for a stack: the throw, then the frames. A
// V8 stack (and the JVM's) already opens on its throw line, and repeating it
// would paste the first line twice; a stack without one gets it put in front.
function withThrow(type, message, stack) {
  const first = stack.split('\n', 1)[0].trim()
  if (first === type || first.startsWith(`${type}:`)) return stack
  return `${message ? `${type}: ${message}` : type}\n${stack}`
}

const entriesOf = attributes => (Array.isArray(attributes) ? attributes : Object.entries(attributes ?? {}))

export default function ExceptionModal({
  type, subtitle, message, stack, onClose,
  unminified, unminifiedNote, attributes, initialTab, isApp = isJsAppFrame, ariaLabel,
}) {
  const [copied, setCopied] = useState(false)
  const closeRef = useRef(null)
  const uid = useId()
  const msgId = `${uid}-msg`
  // TabBar's idPrefix spelling: it names each tab `${uid}-tab-<id>` and points
  // it at `${uid}-panel-<id>`, so each panel below carries that id and is
  // named by its tab in turn, the tablist pattern both ways round.
  const panelId = id => `${uid}-panel-${id}`
  const tabDomId = id => `${uid}-tab-${id}`

  const tabbed = unminified != null || unminifiedNote != null || attributes != null
  const hasUnminified = typeof unminified === 'string' && unminified.trim() !== ''
  const tabs = tabbed ? [
    ...(unminified != null || unminifiedNote != null ? [{ id: 'unminified', label: TABS.unminified }] : []),
    { id: 'original', label: TABS.original },
    ...(attributes != null ? [{ id: 'attributes', label: TABS.attributes }] : []),
  ] : []
  // The readable stack when there is one; otherwise the stack there is, with
  // the first tab still saying why the readable one is missing.
  const firstTab = hasUnminified ? 'unminified' : 'original'
  const [picked, setTab] = useState(initialTab)
  // A tab the caller has since taken away (no attributes any more) falls back
  // rather than leaving the body blank.
  const tab = tabs.some(t => t.id === picked) ? picked : firstTab

  // Esc closes from anywhere on the page, the way the trace modal always has.
  // Read through a ref so a caller's inline onClose (a new function every
  // render) does not re-subscribe the listener on each render.
  const onCloseRef = useRef(onClose)
  useEffect(() => { onCloseRef.current = onClose })
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onCloseRef.current?.() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Focus moves into the dialog on open and goes back to whatever opened it on
  // close — the exception link in a row, which a keyboard reader would
  // otherwise have to find again from the top of the page.
  useEffect(() => {
    const opener = document.activeElement
    closeRef.current?.focus()
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true })
    }
  }, [])

  const original = stack || NO_STACK
  const copyable = !tabbed || tab === 'original' ? withThrow(type, message, original)
    : tab === 'unminified' ? (hasUnminified ? withThrow(type, message, unminified) : null)
      : entriesOf(attributes).map(([k, v]) => `${k}: ${v ?? ''}`).join('\n')
  const copy = () => {
    if (copyable == null) return
    copyText(copyable)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1400)
  }

  return (
    <div className="tw-modal-overlay" onClick={onClose}>
      <div
        className={`tw-modal${tabbed ? ' excm' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel ?? (tabbed ? `Exception details for ${type}` : `Stack trace for ${type}`)}
        aria-describedby={message ? msgId : undefined}
        tabIndex={-1}
        onClick={e => e.stopPropagation()}
        onKeyDown={trapTab}
      >
        <div className="tw-modal-head">
          <div className="tw-modal-titles">
            <div className="tw-modal-type mono">{type}</div>
            {subtitle != null && <div className="tw-modal-sub">{subtitle}</div>}
          </div>
          <div className="tw-modal-acts">
            <button
              type="button"
              className="tw-modal-copy"
              onClick={copy}
              disabled={copyable == null}
              title={tabbed ? (copyable == null ? 'No un-minified stack to copy' : `Copy the ${TABS[tab].toLowerCase()}`) : undefined}
            >
              <Copy size={12} strokeWidth={2} aria-hidden="true" />
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button ref={closeRef} type="button" className="tw-modal-close" onClick={onClose} aria-label="Close">
              <X size={15} strokeWidth={2} aria-hidden="true" />
            </button>
          </div>
        </div>
        {message && (
          <div className="tw-modal-msg" id={msgId}>{message}</div>
        )}
        {tabbed && (
          <div className="excm-tabs">
            <TabBar tabs={tabs} active={tab} onChange={setTab} ariaLabel="Exception views" idPrefix={uid} />
          </div>
        )}
        {(!tabbed || tab === 'original') && (
          <pre
            className="tw-modal-stack mono"
            // A Tab stop in both forms: the stack is a scroll box, and a box the
            // keyboard cannot reach is one it cannot scroll. Firefox and newer
            // Chrome would stop on it unasked; saying so makes every browser
            // agree, and puts it inside the dialog's focus trap, which only
            // wraps over elements that declare themselves tabbable.
            tabIndex={0}
            {...(tabbed
              ? { role: 'tabpanel', 'aria-labelledby': tabDomId('original'), id: panelId('original') }
              : { 'aria-label': 'Stack trace' })}
          >
            {original}
          </pre>
        )}
        {tabbed && tab === 'unminified' && (
          <div className="excm-body" role="tabpanel" aria-labelledby={tabDomId('unminified')} id={panelId('unminified')} tabIndex={0}>
            {hasUnminified
              ? <StackTraceView text={unminified} isApp={isApp} />
              : <div className="excm-note">{unminifiedNote ?? 'No un-minified stack trace for this exception.'}</div>}
          </div>
        )}
        {tabbed && tab === 'attributes' && (
          <div className="excm-body" role="tabpanel" aria-labelledby={tabDomId('attributes')} id={panelId('attributes')} tabIndex={0}>
            {entriesOf(attributes).length > 0 ? (
              <dl className="errd-attrs">
                {entriesOf(attributes).map(([k, v]) => (
                  <div className="errd-attr" key={k}>
                    <dt className="mono">{k}</dt>
                    <dd className="mono">{String(v ?? '')}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <div className="errd-none-note">No attributes were recorded on this exception.</div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
