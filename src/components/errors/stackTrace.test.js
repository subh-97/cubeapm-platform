// How the Error details drawer reads a stack trace: which line is the throw,
// which frames are the application's, where a wrapped cause starts, and what a
// folded trace keeps. The last test runs every sample the data layer hands the
// drawer, so a change to the generated traces cannot quietly turn the root
// cause into a library frame. The browser's JavaScript traces — V8 frames,
// the bare frames source-map tools print, and genuinely minified bundles —
// are read by the same function with the file-based app test.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { REFERENCE_WINDOW, resolveWindow } from '@/data/timeWindow'
import { ERROR_SIDES, errorGroupsForWindow, errorSamplesFor } from '@/data/errors'
import {
  classifyStackLines, countFrames, foldStack, isAppFrame, isFrame, isJsAppFrame, jsFramePath, FOLD_FRAMES,
} from './stackTrace.js'

const POOL_TRACE = [
  'redis.clients.jedis.exceptions.JedisPoolException: Could not get a resource from the pool',
  '\tat redis.clients.jedis.util.Pool.getResource(Pool.java:84)',
  '\tat com.cubedemo.payment.cache.SessionCache.get(SessionCache.java:41)',
  '\tat java.base/java.lang.Thread.run(Thread.java:840)',
  'Caused by: java.util.NoSuchElementException: Timeout waiting for idle object',
  '\tat org.apache.commons.pool2.impl.GenericObjectPool.borrowObject(GenericObjectPool.java:298)',
  '\t... 2 more',
].join('\n')

const kinds = lines => lines.map(l => l.kind)

// A trace with `main` frames under the throw and `cause` frames under one
// Caused by, the shape every generated trace has.
function traceOf(main, cause) {
  const lines = ['com.example.BoomException: boom']
  for (let i = 0; i < main; i++) lines.push(`\tat ${i % 3 ? 'org.lib' : 'com.cubedemo.app'}.F${i}.run(F${i}.java:${i + 1})`)
  if (cause) {
    lines.push('Caused by: java.io.IOException: closed')
    for (let i = 0; i < cause; i++) lines.push(`\tat org.io.C${i}.read(C${i}.java:${i + 1})`)
    lines.push(`\t... ${main - 1} more`)
  }
  return lines.join('\n')
}

test('a trace reads as its throw, its frames, its causes and the JVM elision', () => {
  assert.deepEqual(kinds(classifyStackLines(POOL_TRACE)), ['head', 'lib', 'app', 'lib', 'cause', 'lib', 'more'])
})

test('a frame is the application\'s when its class is, whatever module or loader prefix it carries', () => {
  assert.equal(isAppFrame('com.cubedemo.payment.PaymentsController.capture(PaymentsController.java:182)'), true)
  assert.equal(isAppFrame('app//com.cubedemo.server.HttpServer.dispatch(HttpServer.java:203)'), true)
  assert.equal(isAppFrame('java.base/java.lang.Thread.run(Thread.java:840)'), false)
  assert.equal(isAppFrame('redis.clients.jedis.JedisPool.getResource(JedisPool.java:370)'), false)
  // The prefix is a package, not a substring: a library that mentions it
  // further in is still a library.
  assert.equal(isAppFrame('org.proxy.Wrap.com.cubedemo(Wrap.java:1)'), false)
  assert.equal(isAppFrame('com.acme.Billing.charge(Billing.java:9)', ['com.acme.']), true)
})

test('a message that runs over several lines stays with its exception', () => {
  const text = [
    'java.lang.IllegalStateException: first line',
    'second line of the same message',
    '\tat com.cubedemo.a.B.c(B.java:1)',
    'Caused by: java.lang.RuntimeException: cause line',
    'cause continues',
    '\tat org.x.Y.z(Y.java:2)',
  ].join('\n')
  assert.deepEqual(kinds(classifyStackLines(text)), ['head', 'head', 'app', 'cause', 'cause', 'lib'])
})

test('empty text has no lines, and a trailing newline adds none', () => {
  assert.deepEqual(classifyStackLines(''), [])
  assert.deepEqual(classifyStackLines(null), [])
  assert.equal(classifyStackLines(`${POOL_TRACE}\n`).length, 7)
  assert.equal(classifyStackLines(POOL_TRACE.replace(/\n/g, '\r\n'))[0].text.endsWith('pool'), true)
})

test('only frames count as frames, not headings or elisions', () => {
  assert.equal(countFrames(classifyStackLines(POOL_TRACE)), 4)
})

test('a trace within the limit is left whole', () => {
  const lines = classifyStackLines(traceOf(FOLD_FRAMES, 0))
  assert.equal(foldStack(lines), lines)
})

test('a folded trace shows the limit in frames and keeps the root cause in view', () => {
  const lines = classifyStackLines(traceOf(14, 2))
  const folded = foldStack(lines)
  assert.equal(countFrames(folded), FOLD_FRAMES)
  // The Caused by heading, both of its frames and its elision all survive;
  // what gave way is the bottom of the throw's own block.
  const at = folded.findIndex(l => l.kind === 'cause')
  assert.deepEqual(kinds(folded.slice(at)), ['cause', 'lib', 'lib', 'more'])
  assert.deepEqual(kinds(folded.slice(0, at)), ['head', ...kinds(lines.slice(1, 11)), 'fold'])
  assert.equal(folded.find(l => l.kind === 'fold').hidden, 4)
})

test('every block keeps its top frames, and the hidden counts add up to what was left out', () => {
  const text = [traceOf(10, 6), 'Caused by: java.net.SocketException: reset', '\tat a.B.c(B.java:1)', '\tat a.B.d(B.java:2)', '\tat a.B.e(B.java:3)'].join('\n')
  const lines = classifyStackLines(text)
  const folded = foldStack(lines, 9)
  assert.equal(countFrames(folded), 9)
  const hidden = folded.filter(l => l.kind === 'fold').reduce((a, l) => a + l.hidden, 0)
  assert.equal(hidden, countFrames(lines) - 9)
  // Three blocks, three frames each: shared a round at a time.
  const perBlock = []
  for (const l of folded) {
    if (l.kind === 'head' || l.kind === 'cause') perBlock.push(0)
    else if (isFrame(l)) perBlock[perBlock.length - 1]++
  }
  assert.deepEqual(perBlock, [3, 3, 3])
  // A fold marker sits where its block's frames stop, never at the top of one.
  for (const [i, l] of folded.entries()) if (l.kind === 'fold') assert.ok(isFrame(folded[i - 1]))
})

test('every sample the drawer is handed opens on its own throw and keeps its cause when folded', () => {
  const windows = [REFERENCE_WINDOW, resolveWindow({ kind: 'preset', value: '7d' })]
  let checked = 0
  for (const win of windows) {
    for (const side of ERROR_SIDES) {
      for (const group of errorGroupsForWindow(win, { side }).slice(0, 12)) {
        for (const s of errorSamplesFor(group, win, 3)) {
          const lines = classifyStackLines(s.stacktrace)
          assert.equal(lines[0].kind, 'head')
          assert.equal(lines[0].text, `${s.exception}: ${s.message}`)
          assert.ok(lines.some(l => l.kind === 'app'), `${s.exception} has an application frame`)
          const causes = lines.filter(l => l.kind === 'cause').length
          assert.equal(foldStack(lines).filter(l => l.kind === 'cause').length, causes)
          assert.ok(countFrames(foldStack(lines)) <= FOLD_FRAMES)
          checked++
        }
      }
    }
  }
  assert.ok(checked > 50)
})

// ── JavaScript ────────────────────────────────────────────────────────────

const JS_HEAD = "TypeError: Cannot read properties of undefined (reading 'clientSecret')"

// Source-mapped, as V8 prints it: two of the shop's own frames under src/,
// then React's event plumbing, a vendor chunk and V8's async marker.
const JS_UNMINIFIED = [
  JS_HEAD,
  '    at CheckoutForm.submit (src/pages/checkout/CheckoutForm.jsx:142:37)',
  '    at CartSummary (src/components/cart.js:118:22)',
  '    at HTMLUnknownElement.callCallback (node_modules/react-dom/cjs/react-dom.development.js:4164:14)',
  '    at Object.invokeGuardedCallbackDev (react-dom/cjs/react-dom.development.js:4213:16)',
  '    at https://shop.cubedemo.com/assets/vendor-8b1d3e.js:1:52011',
  '    at async Promise.all (index 0)',
].join('\n')

// What the browser actually reported: every frame a position in a bundle.
const JS_MINIFIED = [
  JS_HEAD,
  '    at t.render (https://shop.cubedemo.com/assets/index-4f2a9c.js:2:184310)',
  '    at Ji (https://shop.cubedemo.com/assets/vendor-8b1d3e.js:1:52011)',
  '    at https://shop.cubedemo.com/assets/index-4f2a9c.js:2:9921',
].join('\n')

const js = text => classifyStackLines(text, { isApp: isJsAppFrame })

test('a V8 trace opens on its throw, with the app\'s own source frames apart from React and the vendor chunk', () => {
  const lines = js(JS_UNMINIFIED)
  assert.deepEqual(kinds(lines), ['head', 'app', 'app', 'lib', 'lib', 'lib', 'lib'])
  // The throw's own parentheses are part of its message, not a frame position.
  assert.equal(lines[0].text, JS_HEAD)
  assert.equal(countFrames(lines), 6)
})

test('a minified trace is all frames and no app code: nothing in a bundle can be attributed without its map', () => {
  const lines = js(JS_MINIFIED)
  assert.deepEqual(kinds(lines), ['head', 'lib', 'lib', 'lib'])
  assert.equal(lines[1].text, '    at t.render (https://shop.cubedemo.com/assets/index-4f2a9c.js:2:184310)')
})

test('frames printed without `at` are still frames, not more of the message', () => {
  const text = [
    JS_HEAD,
    'CheckoutForm.submit (src/pages/checkout/CheckoutForm.jsx:142:37)',
    'CartSummary (src/components/cart.js:118:22)',
    'callCallback (node_modules/react-dom/cjs/react-dom.development.js:4164:14)',
    'render@https://shop.cubedemo.com/assets/index-4f2a9c.js:2:184310',
    '@https://shop.cubedemo.com/assets/vendor-8b1d3e.js:1:52011',
  ].join('\n')
  assert.deepEqual(kinds(js(text)), ['head', 'app', 'app', 'lib', 'lib', 'lib'])
  // Before the first frame a line is still the message's, however it reads.
  assert.deepEqual(kinds(js(`Error: first line\nsecond line\n${JS_UNMINIFIED.split('\n')[1]}`)), ['head', 'head', 'app'])
})

test('without a JS test, a JS trace keeps its shape and no frame passes for the JVM app\'s', () => {
  assert.deepEqual(kinds(classifyStackLines(JS_UNMINIFIED)), ['head', 'lib', 'lib', 'lib', 'lib', 'lib', 'lib'])
})

test('isApp decides instead of the package prefixes, and is handed the frame without its `at`', () => {
  const seen = []
  const lines = classifyStackLines(POOL_TRACE, { isApp: f => { seen.push(f); return f.startsWith('redis.') } })
  assert.deepEqual(kinds(lines), ['head', 'app', 'lib', 'lib', 'cause', 'lib', 'more'])
  assert.equal(seen[0], 'redis.clients.jedis.util.Pool.getResource(Pool.java:84)')
})

test('a JS frame is the app\'s by the file it points at, wherever the file is served from', () => {
  assert.equal(jsFramePath('CartSummary (src/components/cart.js:118:22)'), 'src/components/cart.js')
  assert.equal(jsFramePath('t.render (https://shop.cubedemo.com/assets/index-4f2a9c.js:2:184310)'), 'assets/index-4f2a9c.js')
  assert.equal(jsFramePath('render@https://shop.cubedemo.com/assets/index-4f2a9c.js:2:184310'), 'assets/index-4f2a9c.js')
  assert.equal(jsFramePath('https://shop.cubedemo.com/assets/vendor-8b1d3e.js:1:52011'), 'assets/vendor-8b1d3e.js')
  assert.equal(isJsAppFrame('Cart (webpack:///./src/components/cart.js:1:2)'), true)
  assert.equal(isJsAppFrame('Cart (https://localhost:5173/src/components/cart.js:1:2)'), true)
  assert.equal(isJsAppFrame('Cart (file:///Users/me/shop/src/components/cart.js:1:2)'), true)
  // A package's own src/ is still the package's.
  assert.equal(isJsAppFrame('x (node_modules/@stripe/stripe-js/src/index.js:1:2)'), false)
  assert.equal(isJsAppFrame('x (react-dom/cjs/react-dom.development.js:4164:14)'), false)
  assert.equal(isJsAppFrame('new Promise (<anonymous>)'), false)
  assert.equal(isJsAppFrame('Cart (app/components/cart.js:1:2)', ['app/']), true)
})

test('a long JS trace folds like a JVM one, keeping its throw', () => {
  const text = [JS_HEAD, ...Array.from({ length: 20 }, (_, i) => `    at f${i} (src/f${i}.js:${i + 1}:1)`)].join('\n')
  const folded = foldStack(js(text))
  assert.equal(folded[0].kind, 'head')
  assert.equal(countFrames(folded), FOLD_FRAMES)
  assert.equal(folded.at(-1).kind, 'fold')
  assert.equal(folded.at(-1).hidden, 8)
})
