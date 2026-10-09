import { useMemo } from 'react'
import { Settings } from 'lucide-react'
import ExceptionModal from '@/components/errors/ExceptionModal'
import { browserExceptionFor } from '@/data/browser'
import { buildTrace } from '@/data/traceDetail'
import { formatLocal } from '@/utils/timeRange'
import './browser-traces.css'

// "Chrome 129", not "Chrome 129.0.6668.89": in a one-line subtitle the build
// number is noise, and the full version is one tab over, in Attributes.
function browserLabel(attrs) {
  const name = attrs?.['browser.name']
  if (!name) return null
  const major = String(attrs['browser.version'] ?? '').split('.')[0]
  return major ? `${name} ${major}` : name
}

// The bundle's file name, which is what a person recognises in a build's
// output folder; the full URL rides along as the tooltip.
const fileOf = url => String(url ?? '').split(/[?#]/)[0].split('/').pop() || String(url ?? '')

/**
 * The stack trace of one JavaScript exception a browser reported — production's
 * error modal (Un-minified | Original | Attributes) on the shared ExceptionModal.
 *
 * What the browser sent is a stack of minified bundle positions
 * (`at Q (…/index-4f2a9c.js:2:63037)`), which nobody can read. The readable,
 * source-mapped stack is only honest to show when the app has a source map for
 * that bundle uploaded in Settings › Source Maps — so it is gated on exactly
 * that, and the first tab otherwise says what is missing and offers the way to
 * fix it, while the modal opens on the original, which is always there.
 * Deleting the map in Settings and reopening the modal is the demo of why the
 * setting exists.
 *
 * Both Browser tabs open it — the Errors tab on a group's newest sample, the
 * Traces tab on the trace being previewed — and so does the trace page for the
 * same trace, with nothing but the trace id: the exception, the page, the
 * browser and the instant are all read off the id, so no two screens can
 * describe one error differently.
 *
 * It is not portalled, so the caller renders it at the tab's root rather than
 * inside a clickable row, whose click a click in the modal would bubble to.
 *
 * It opens on the readable stack when there is one. `initialTab` ('unminified'
 * | 'original' | 'attributes', ExceptionModal's) opens it on another; no page
 * does, but its tests render each tab through it, the way a link to one tab
 * would.
 */
export default function BrowserExceptionModal({ traceId, sourceMaps, onClose, onOpenSourceMaps, initialTab }) {
  const ex = useMemo(() => (traceId ? browserExceptionFor(traceId) : null), [traceId])
  // Where and when it happened, for the subtitle: the route the page load is
  // filed under (the row the user came from says the same) and the instant it
  // started. Both come off the trace this id rebuilds, as on the trace page.
  const root = useMemo(() => (ex ? buildTrace(traceId)?.root ?? null : null), [ex, traceId])
  if (!ex) return null

  // A map is uploaded for one app's bundle (Settings keys it on both), so only
  // this app's map of this bundle un-minifies its stack — not a map someone
  // filed under the other app with the same URL.
  const mapped = (sourceMaps ?? []).some(m => m.appId === ex.appId && m.sourceFile === ex.bundle)
  const browser = browserLabel(ex.attributes)
  const parts = [
    root?.name && <span key="route" className="mono">{root.name}</span>,
    browser,
    root?.startTime && formatLocal(root.startTime.getTime(), 'MMM DD, HH:mm:ss'),
  ].filter(Boolean)
  const subtitle = parts.length > 0
    ? parts.flatMap((p, i) => (i === 0 ? [p] : [<span key={`sep${i}`} className="sep">&middot;</span>, p]))
    : null

  const openSettings = () => {
    onClose?.()
    onOpenSourceMaps?.()
  }
  const note = (
    <div className="brw-srcmap-note">
      <p>
        No source map is uploaded for{' '}
        <span className="mono" title={ex.bundle}>{fileOf(ex.bundle)}</span>, so this
        stack can only be read as the minified bundle positions the browser
        reported — see Original stack trace. Upload the bundle&rsquo;s source map
        and this tab shows the stack in your source files.
      </p>
      {onOpenSourceMaps && (
        <button type="button" className="hbtn small" onClick={openSettings}>
          <Settings aria-hidden="true" />
          Open Source Maps settings
        </button>
      )}
    </div>
  )

  return (
    <ExceptionModal
      type={ex.type}
      message={ex.message}
      subtitle={subtitle}
      stack={ex.stack}
      unminified={mapped ? ex.unminified : undefined}
      unminifiedNote={mapped ? undefined : note}
      attributes={ex.attributes}
      initialTab={initialTab}
      onClose={onClose}
    />
  )
}
