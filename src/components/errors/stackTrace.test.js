// How the Error details drawer reads a stack trace: which line is the throw,
// which frames are the application's, where a wrapped cause starts, and what a
// folded trace keeps. The last test runs every sample the data layer hands the
// drawer, so a change to the generated traces cannot quietly turn the root
// cause into a library frame.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { REFERENCE_WINDOW, resolveWindow } from '@/data/timeWindow'
import { ERROR_SIDES, errorGroupsForWindow, errorSamplesFor } from '@/data/errors'
import {
  classifyStackLines, countFrames, foldStack, isAppFrame, isFrame, FOLD_FRAMES,
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
