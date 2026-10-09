// The exception modal, in both of its shapes.
//
// With a stack alone it is the trace detail page's stack modal, moved: the
// original is kept below as a fixture, copied exactly as it stood in
// TraceDetail.jsx, and the render TraceDetail will ask for is compared to it
// character for character — so the page can switch to this module without a
// pixel moving. With an un-minified stack or attributes it is the browser
// exception's tabbed modal, checked for which tab opens and what each one
// draws. (Esc, focus and Copy run in effects and handlers, which a static
// render does not reach.)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server.browser'
import { useState, useRef, useEffect } from 'react'
import { Copy, X } from 'lucide-react'
import { msLabel } from '@/components/trace/Waterfall'
import ExceptionModal from './ExceptionModal.jsx'

const noop = () => {}
const html = el => renderToStaticMarkup(el)

/* ── Fixture: TraceDetail.jsx's StackModal, verbatim ── */

function StackModal({ span, onClose }) {
  const [copied, setCopied] = useState(false)
  const closeRef = useRef(null)

  useEffect(() => {
    closeRef.current?.focus()
    const onKey = e => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const stack = span.exception.stack || 'No stack trace was recorded on this span.'
  const copy = () => {
    try {
      navigator.clipboard.writeText(`${span.exception.type}: ${span.exception.message}\n${stack}`)?.catch(() => {})
    } catch (_) { /* clipboard blocked — the text is on screen either way */ }
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1400)
  }

  return (
    <div className="tw-modal-overlay" onClick={onClose}>
      <div
        className="tw-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Stack trace for ${span.name}`}
        onClick={e => e.stopPropagation()}
      >
        <div className="tw-modal-head">
          <div className="tw-modal-titles">
            <div className="tw-modal-type mono">{span.exception.type}</div>
            <div className="tw-modal-sub">
              {span.service}
              <span className="sep">&middot;</span>
              <span className="mono">{span.name}</span>
              <span className="sep">&middot;</span>
              {msLabel(span.duration)}
            </div>
          </div>
          <div className="tw-modal-acts">
            <button type="button" className="tw-modal-copy" onClick={copy}>
              <Copy size={12} strokeWidth={2} aria-hidden="true" />
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button ref={closeRef} type="button" className="tw-modal-close" onClick={onClose} aria-label="Close">
              <X size={15} strokeWidth={2} aria-hidden="true" />
            </button>
          </div>
        </div>
        {span.exception.message && (
          <div className="tw-modal-msg">{span.exception.message}</div>
        )}
        <pre className="tw-modal-stack mono">{stack}</pre>
      </div>
    </div>
  )
}

// What TraceDetail hands the moved modal for one failed span.
function fromSpan(span) {
  return (
    <ExceptionModal
      type={span.exception.type}
      subtitle={<>{span.service}<span className="sep">&middot;</span><span className="mono">{span.name}</span><span className="sep">&middot;</span>{msLabel(span.duration)}</>}
      message={span.exception.message}
      stack={span.exception.stack}
      ariaLabel={`Stack trace for ${span.name}`}
      onClose={noop}
    />
  )
}

const JVM_SPAN = {
  name: 'POST /v1/payments',
  service: 'payment-service',
  duration: 1843.27,
  exception: {
    type: 'redis.clients.jedis.exceptions.JedisPoolException',
    message: 'Could not get a resource from the pool',
    stack: 'redis.clients.jedis.exceptions.JedisPoolException: Could not get a resource from the pool\n\tat redis.clients.jedis.util.Pool.getResource(Pool.java:84)\n\tat com.cubedemo.payment.cache.SessionCache.get(SessionCache.java:41)',
  },
}

/* ── Browser exception ── */

const TYPE = 'TypeError'
const MESSAGE = "Cannot read properties of undefined (reading 'clientSecret')"
const MINIFIED = [
  `${TYPE}: ${MESSAGE}`,
  '    at t.render (https://shop.cubedemo.com/assets/index-4f2a9c.js:2:184310)',
  '    at Ji (https://shop.cubedemo.com/assets/vendor-8b1d3e.js:1:52011)',
].join('\n')
const UNMINIFIED = [
  `${TYPE}: ${MESSAGE}`,
  '    at CheckoutForm.submit (src/pages/checkout/CheckoutForm.jsx:142:37)',
  '    at callCallback (node_modules/react-dom/cjs/react-dom.development.js:4164:14)',
].join('\n')
const ATTRS = { 'exception.type': TYPE, 'page.url': 'https://shop.cubedemo.com/checkout', 'browser.name': 'Chrome 129' }

const browser = props => html(<ExceptionModal type={TYPE} message={MESSAGE} stack={MINIFIED} onClose={noop} {...props} />)
const activeTab = h => /<button [^>]*role="tab" aria-selected="true" class="tab active">([^<]*)<\/button>/.exec(h)?.[1]
// What the modal added for the keyboard and a screen reader, which draws
// nothing: the message is the dialog's description, and the dialog box takes
// focus (never as a Tab stop) when its text is clicked, so the Tab trap still
// hears the next key.
const DIALOG_FOCUS = ' tabindex="-1"'
const withoutA11y = h => h.replace(/ aria-describedby="[^"]*"/, '').replace(/(<div class="tw-modal-msg") id="[^"]*"/, '$1')
  .replace(/(<div class="tw-modal"[^>]*?) tabindex="-1"/, '$1')
  .replace('<pre class="tw-modal-stack mono" tabindex="0" aria-label="Stack trace">', '<pre class="tw-modal-stack mono">')
const tabs = h => [...h.matchAll(/role="tab" aria-selected="(?:true|false)" class="tab[^"]*">([^<]*)</g)].map(m => m[1])

test('with a stack alone it draws exactly what the trace page\'s stack modal drew', () => {
  const h = html(fromSpan(JVM_SPAN))
  assert.match(h, /aria-describedby="([^"]*)"[^]*<div class="tw-modal-msg" id="\1">/, 'the message describes the dialog')
  assert.match(h, new RegExp(`<div class="tw-modal" role="dialog"[^>]*${DIALOG_FOCUS}>`), 'the dialog box can hold focus')
  assert.equal(withoutA11y(h), html(<StackModal span={JVM_SPAN} onClose={noop} />))
  // No message, and no stack recorded: the same gaps, said the same way, and
  // nothing to be described by.
  const bare = { ...JVM_SPAN, exception: { type: 'java.lang.RuntimeException', message: '', stack: '' } }
  const bareHtml = html(fromSpan(bare))
  assert.doesNotMatch(bareHtml, /aria-describedby/)
  assert.equal(withoutA11y(bareHtml), html(<StackModal span={bare} onClose={noop} />))
})

test('with a stack alone there are no tabs and none of the tabbed layout', () => {
  const h = html(fromSpan(JVM_SPAN))
  assert.doesNotMatch(h, /tabbar|excm|role="tab/)
})

test('an exception with a source-mapped stack opens on it, frames classified, with the original and attributes a tab away', () => {
  const h = browser({ unminified: UNMINIFIED, attributes: ATTRS })
  assert.deepEqual(tabs(h), ['Un-minified stack trace', 'Original stack trace', 'Attributes'])
  assert.equal(activeTab(h), 'Un-minified stack trace')
  assert.match(h, /class="tw-modal excm"/)
  assert.match(h, /aria-label="Exception details for TypeError"/)
  // The app's own source at full strength, React stepped back, the throw red.
  assert.match(h, /<span class="errd-stack-line is-head">TypeError: Cannot read/)
  assert.match(h, /<span class="errd-stack-line is-app"> {4}at CheckoutForm\.submit/)
  assert.match(h, /<span class="errd-stack-line is-lib"> {4}at callCallback/)
  assert.doesNotMatch(h, /tw-modal-stack/)
  assert.match(h, /title="Copy the un-minified stack trace"/)
})

test('with no source map the first tab explains and the original stack is what opens', () => {
  const note = <span className="probe-note">No source map for index-4f2a9c.js</span>
  const h = browser({ unminifiedNote: note, attributes: ATTRS })
  assert.equal(activeTab(h), 'Original stack trace')
  assert.match(h, /<pre class="tw-modal-stack mono" tabindex="0" role="tabpanel" aria-labelledby="[^"]*-tab-original" id="[^"]*-panel-original">TypeError: Cannot read/)
  assert.match(h, /at t\.render \(https:\/\/shop\.cubedemo\.com\/assets\/index-4f2a9c\.js:2:184310\)/)

  // Asked for, the un-minified tab shows the caller's note, and Copy has
  // nothing to copy there.
  const un = browser({ unminifiedNote: note, attributes: ATTRS, initialTab: 'unminified' })
  assert.equal(activeTab(un), 'Un-minified stack trace')
  assert.match(un, /<div class="excm-note"><span class="probe-note">No source map for index-4f2a9c\.js<\/span><\/div>/)
  assert.match(un, /<button type="button" class="tw-modal-copy" disabled="" title="No un-minified stack to copy">/)
})

test('the attributes tab lists what was recorded, in order', () => {
  const h = browser({ unminified: UNMINIFIED, attributes: ATTRS, initialTab: 'attributes' })
  assert.equal(activeTab(h), 'Attributes')
  const rows = [...h.matchAll(/<div class="errd-attr"><dt class="mono">([^<]*)<\/dt><dd class="mono">([^<]*)<\/dd><\/div>/g)].map(m => [m[1], m[2]])
  assert.deepEqual(rows, Object.entries(ATTRS))
  // Pairs work as well as an object, and none at all is said rather than blank.
  assert.match(browser({ attributes: [['session.id', 's_1']], initialTab: 'attributes' }), /<dt class="mono">session\.id<\/dt>/)
  assert.match(browser({ attributes: {}, initialTab: 'attributes' }), /No attributes were recorded on this exception\./)
})

test('only the tabs the caller has content for are offered, and an unknown initial tab falls back', () => {
  assert.deepEqual(tabs(browser({ attributes: ATTRS })), ['Original stack trace', 'Attributes'])
  assert.deepEqual(tabs(browser({ unminified: UNMINIFIED })), ['Un-minified stack trace', 'Original stack trace'])
  assert.equal(activeTab(browser({ unminified: UNMINIFIED, initialTab: 'attributes' })), 'Un-minified stack trace')
})

test('each tab names the panel it opens, and only the open tab is a Tab stop', () => {
  const h = browser({ unminified: UNMINIFIED, attributes: ATTRS })
  const tabEls = [...h.matchAll(/<button id="([^"]*)" aria-controls="([^"]*)" tabindex="(-?\d)" type="button" role="tab" aria-selected="(true|false)"/g)]
  assert.equal(tabEls.length, 3)
  for (const [, id, controls, tabindex, selected] of tabEls) {
    assert.match(id, /-tab-(unminified|original|attributes)$/)
    assert.equal(controls, id.replace('-tab-', '-panel-'))
    assert.equal(tabindex, selected === 'true' ? '0' : '-1')
  }
  // The open panel carries the id its tab points at, and is named by that tab
  // in turn (aria-labelledby), so a screen reader names it as the strip does.
  const [, openTab, open] = tabEls.find(m => m[4] === 'true')
  assert.ok(h.includes(`id="${open}"`), open)
  assert.match(h, new RegExp(`role="tabpanel" aria-labelledby="${openTab}"[^>]* id="${open}"`))
  // Every panel, whichever tab is open.
  for (const initialTab of ['unminified', 'original', 'attributes']) {
    const p = browser({ unminified: UNMINIFIED, attributes: ATTRS, initialTab })
    const panel = /role="tabpanel" aria-labelledby="([^"]*)"[^>]* id="([^"]*)"/.exec(p)
    assert.ok(panel, initialTab)
    assert.match(panel[1], new RegExp(`-tab-${initialTab}$`))
    assert.equal(panel[2], panel[1].replace('-tab-', '-panel-'))
    assert.ok(p.includes(`<button id="${panel[1]}"`), `the ${initialTab} tab is there to name it`)
  }
})
