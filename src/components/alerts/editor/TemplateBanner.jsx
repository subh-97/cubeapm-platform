import { useEffect, useRef } from 'react'
import { ArrowRight, Info, RotateCcw } from 'lucide-react'

// Which field a moved setting jumps to.
const FIELD_FOR = { source: 'query', query: 'query', kind: 'kind', warning: 'tiers', critical: 'tiers', forSec: 'forSec', intervalSec: 'intervalSec' }

/**
 * The editor's word on a rule started from a template (templateDrift.js),
 * once the draft has moved off what the template sets — its query, alert
 * type, thresholds, hold and check interval: it says so, lists each change,
 * the template's value against the new one, each a link to its field, and
 * offers to put the template's settings back. While the draft still runs as
 * the template does, nothing shows here; the head's sentence box names the
 * template it came from (EditorHead, `#ae-tpl-head`). The name, folder,
 * receivers and mutes are the viewer's own and never count.
 *
 * A live region stays in the page either way, so moving off the template is
 * announced. Restore takes the block away with its button, so focus moves to
 * the head's line naming the template.
 */
export default function TemplateBanner({ drift, onRestore, onFocusField }) {
  const restoring = useRef(false)
  const moved = drift.length > 0
  const restore = () => {
    restoring.current = true
    onRestore()
  }
  // Once the restore has landed and the block is gone, the head's template line takes focus.
  useEffect(() => {
    if (!restoring.current || moved) return
    restoring.current = false
    document.getElementById('ae-tpl-head')?.focus()
  }, [moved])
  return (
    <>
      <div className="sr-only" role="status">
        {moved ? 'Moved off the template\'s settings.' : ''}
      </div>
      {moved && (
        <section className="ae-tpl" aria-label="Changed from the template">
          <div className="ae-tpl-text">
            <p className="ae-tpl-verdict"><Info aria-hidden="true" />You&apos;ve moved off the template&apos;s settings. The rule still saves; it just won&apos;t run as the template does.</p>
            <ul className="ae-tpl-drift">
              {drift.map(d => (
                <li key={d.key}>
                  <button type="button" className="ae-tpl-change" onClick={() => onFocusField(FIELD_FOR[d.key])} title="Go to this field">
                    <span className="ae-tpl-change-label">{d.label}</span>
                    {d.from != null ? (
                      <>
                        <span className="ae-tpl-from"><span className="sr-only">template: </span>{d.from}</span>
                        <ArrowRight aria-hidden="true" />
                        <span className="ae-tpl-to"><span className="sr-only">now: </span>{d.to}</span>
                      </>
                    ) : <span className="ae-tpl-to">changed</span>}
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <button type="button" className="hbtn ae-tpl-restore" onClick={restore}>
            <RotateCcw aria-hidden="true" />Restore template settings
          </button>
        </section>
      )}
    </>
  )
}
