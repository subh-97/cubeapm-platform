// The Browser page's exception modal: a browser script error's stack, readable
// only when a source map for its bundle is uploaded.
//
// The gate is the whole point of the Source Maps setting, so it is checked
// both ways over real samples from the data layer: with the seeded maps the
// modal opens on the source-mapped frames; with no map for the bundle (none at
// all, or only the other app's) the first tab says so, names the bundle file,
// offers the settings, and the modal opens on the minified original instead.
// (Esc, focus and the button's click run in effects and handlers, which a
// static render does not reach.)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server.browser'
import { REFERENCE_WINDOW } from '@/data/timeWindow'
import {
  BROWSER_SOURCE_MAP_SEED, browserErrorGroupsForWindow, browserExceptionFor, browserGroupSampleTrace,
  browserTracesForWindow,
} from '@/data/browser'
import BrowserExceptionModal from './BrowserExceptionModal.jsx'

const noop = () => {}
const html = el => renderToStaticMarkup(el)
const win = REFERENCE_WINDOW
const APP = 'cubedemo-web'

// React escapes text, so a stack is compared the way it is printed.
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#x27;').replace(/"/g, '&quot;')

// The newest occurrence of the storefront's top script error, as the Errors
// tab's exception button opens it, and the production link's wishlist error.
const top = browserErrorGroupsForWindow(win, APP, 'server')[0]
const SAMPLES = [
  browserGroupSampleTrace(win, APP, top),
  browserTracesForWindow(win, APP, { kind: 'server', endpoint: '/account/:userId/wishlist', error: 'TypeError', limit: 1 })[0]?.traceId,
]

test('the samples are browser script errors with a bundle the seed maps', () => {
  for (const id of SAMPLES) {
    const ex = browserExceptionFor(id)
    assert.ok(ex, id)
    assert.ok(BROWSER_SOURCE_MAP_SEED.some(m => m.sourceFile === ex.bundle), ex.bundle)
  }
})

test('with a source map for the bundle it opens on the un-minified stack', () => {
  for (const id of SAMPLES) {
    const ex = browserExceptionFor(id)
    const out = html(<BrowserExceptionModal traceId={id} sourceMaps={BROWSER_SOURCE_MAP_SEED} onClose={noop} onOpenSourceMaps={noop} />)
    assert.match(out, /class="tw-modal excm"/)
    assert.match(out, new RegExp(`<div class="tw-modal-type mono">${ex.type}</div>`))
    assert.ok(new RegExp(`<div class="tw-modal-msg" id="[^"]*">`).test(out) && out.includes(`>${esc(ex.message)}</div>`))
    // All three tabs, the un-minified one open with its frames.
    for (const t of ['Un-minified stack trace', 'Original stack trace', 'Attributes']) assert.ok(out.includes(t), t)
    assert.match(out, /role="tabpanel" aria-labelledby="[^"]*-tab-unminified"/)
    assert.match(out, /class="errd-stack/)
    const appFrame = ex.unminified.split('\n').find(l => l.includes('src/'))
    assert.ok(appFrame && out.includes(esc(appFrame.trim())), 'the app frame is drawn')
    assert.doesNotMatch(out, /No source map is uploaded/)
    assert.doesNotMatch(out, /Open Source Maps settings/)
    // Not the minified original: that is one tab over.
    assert.doesNotMatch(out, /class="tw-modal-stack mono"/)
  }
})

test('without a map for the bundle it opens on the original, and the first tab says which file is missing', () => {
  const otherApp = BROWSER_SOURCE_MAP_SEED.filter(m => m.appId !== APP)
  for (const maps of [[], undefined, otherApp]) {
    for (const id of SAMPLES) {
      const ex = browserExceptionFor(id)
      const file = ex.bundle.split('/').pop()
      // What opens is the stack the browser sent: the minified bundle frames.
      // The un-minified tab is still offered, first, holding the note.
      const opened = html(<BrowserExceptionModal traceId={id} sourceMaps={maps} onClose={noop} onOpenSourceMaps={noop} />)
      assert.match(opened, /role="tab" aria-selected="false" class="tab">Un-minified stack trace</)
      assert.match(opened, /role="tabpanel" aria-labelledby="[^"]*-tab-original"/)
      assert.ok(opened.includes(esc(ex.stack)), 'the minified stack is drawn')
      assert.doesNotMatch(opened, /class="errd-stack/)

      const note = html(<BrowserExceptionModal traceId={id} sourceMaps={maps} onClose={noop} onOpenSourceMaps={noop} initialTab="unminified" />)
      assert.match(note, /role="tabpanel" aria-labelledby="[^"]*-tab-unminified"/)
      assert.match(note, /No source map is uploaded for/)
      assert.ok(note.includes(`title="${ex.bundle}">${file}</span>`), file)
      assert.match(note, /<button type="button" class="hbtn small">.*Open Source Maps settings<\/button>/)
      // Nothing source-mapped leaks through, and Copy has nothing to copy.
      assert.doesNotMatch(note, /class="errd-stack/)
      assert.match(note, /class="tw-modal-copy" disabled=""/)
    }
  }
})

test('with nowhere to send the user, the note has no settings button', () => {
  const out = html(<BrowserExceptionModal traceId={SAMPLES[0]} sourceMaps={[]} onClose={noop} initialTab="unminified" />)
  assert.match(out, /No source map is uploaded for/)
  assert.doesNotMatch(out, /Open Source Maps settings/)
})

test('the subtitle names the route, the browser and the instant; Attributes carries the rest', () => {
  const id = SAMPLES[1]
  const ex = browserExceptionFor(id)
  const out = html(<BrowserExceptionModal traceId={id} sourceMaps={BROWSER_SOURCE_MAP_SEED} onClose={noop} />)
  const sub = /<div class="tw-modal-sub">(.*?)<\/div>/.exec(out)?.[1] ?? ''
  assert.ok(sub.includes('<span class="mono">/account/:userId/wishlist</span>'), sub)
  assert.ok(sub.includes(`${ex.attributes['browser.name']} ${ex.attributes['browser.version'].split('.')[0]}`), sub)
  assert.match(sub, /[A-Z][a-z]{2} \d{2}, \d{2}:\d{2}:\d{2}$/)
  // The full version is not in the one-line subtitle; it is in Attributes,
  // with the page, session and release the agent recorded.
  assert.ok(!sub.includes(ex.attributes['browser.version']), sub)
  const attrs = html(<BrowserExceptionModal traceId={id} sourceMaps={BROWSER_SOURCE_MAP_SEED} onClose={noop} initialTab="attributes" />)
  assert.match(attrs, /role="tabpanel" aria-labelledby="[^"]*-tab-attributes"/)
  for (const k of ['exception.type', 'page.url', 'browser.version', 'session.id', 'app.release']) {
    assert.ok(attrs.includes(`<dt class="mono">${k}</dt><dd class="mono">${esc(String(ex.attributes[k]))}</dd>`), k)
  }
  // Production's own tags lead: the event, then the exception as recorded,
  // its stack as the browser sent it (minified) included.
  const keys = [...attrs.matchAll(/<dt class="mono">([^<]*)<\/dt>/g)].map(m => m[1])
  assert.deepEqual(keys.slice(0, 4), ['event', 'exception.type', 'exception.message', 'exception.stacktrace'])
  assert.equal(ex.attributes.event, 'exception')
  assert.equal(ex.attributes['exception.stacktrace'], ex.stack)
})

test('a map gates the stack only for the app it was uploaded under', () => {
  const id = SAMPLES[0]
  const ex = browserExceptionFor(id)
  assert.equal(ex.appId, APP)
  // The storefront's bundle URL, filed under the back office: not this app's map.
  const misfiled = [{ id: 'x', appId: 'cubedemo-admin', sourceFile: ex.bundle, sourceMap: 'index.js.map', description: '' }]
  const out = html(<BrowserExceptionModal traceId={id} sourceMaps={misfiled} onClose={noop} initialTab="unminified" />)
  assert.match(out, /No source map is uploaded for/)
  const own = html(<BrowserExceptionModal traceId={id} sourceMaps={[{ ...misfiled[0], appId: APP }]} onClose={noop} />)
  assert.match(own, /role="tabpanel" aria-labelledby="[^"]*-tab-unminified"/)
  assert.doesNotMatch(own, /No source map is uploaded for/)
})

test('an id with no browser exception renders nothing', () => {
  const ajax = browserTracesForWindow(win, APP, { kind: 'client', limit: 1 })[0].traceId
  for (const id of [ajax, 'not-a-trace', null]) {
    assert.equal(browserExceptionFor(id ?? ''), null)
    assert.equal(html(<BrowserExceptionModal traceId={id} sourceMaps={BROWSER_SOURCE_MAP_SEED} onClose={noop} />), '')
  }
})
