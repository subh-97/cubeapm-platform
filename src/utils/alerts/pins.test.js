// The viewer's pinned rules (docs/alerts/DESIGN.md D3). Risks: a pin that does
// not survive a reload, an Undo that restores the wrong thing, storage that
// throws taking the page down, and a pin made in another tab never arriving.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPinStore } from './pins.js'

const KEY = 'cubeapm.alerts.pinned'
const memoryStorage = (init = {}) => {
  const m = new Map(Object.entries(init))
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), raw: m }
}

test('a pin toggles by id as text, and its Undo puts back exactly what was there', () => {
  const store = createPinStore({ storage: memoryStorage() })
  assert.equal(store.getSnapshot().size, 0)
  const undo = store.toggle(501)
  assert.ok(store.isPinned('501'), 'a view\'s number and a URL\'s string name the same rule')
  assert.deepEqual([...store.getSnapshot()], ['501'])
  undo()
  assert.ok(!store.isPinned(501))
  undo()
  assert.ok(!store.isPinned(501), 'a second undo changes nothing')

  store.toggle(501)
  const unpin = store.toggle(501)
  assert.ok(!store.isPinned(501))
  unpin()
  assert.ok(store.isPinned(501), 'undoing an unpin pins it again')
})

test('the snapshot changes identity only when a pin does, and listeners hear each change', () => {
  const store = createPinStore()
  let heard = 0
  const off = store.subscribe(() => { heard += 1 })
  const before = store.getSnapshot()
  assert.equal(store.getSnapshot(), before)
  store.toggle(7)
  assert.notEqual(store.getSnapshot(), before)
  assert.equal(heard, 1)
  off()
  store.toggle(7)
  assert.equal(heard, 1, 'an unsubscribed listener hears nothing')
})

test('pins survive a reload, in the order they were made; a stored list of another shape is ignored', () => {
  const storage = memoryStorage()
  const a = createPinStore({ storage })
  a.toggle(502)
  a.toggle(501)
  assert.deepEqual(JSON.parse(storage.raw.get(KEY)), { version: 1, ids: ['502', '501'] })
  assert.deepEqual([...createPinStore({ storage }).getSnapshot()], ['502', '501'])

  for (const raw of ['not json', '{"version":2,"ids":["1"]}', '{"version":1,"ids":"1"}', 'null']) {
    assert.equal(createPinStore({ storage: memoryStorage({ [KEY]: raw }) }).getSnapshot().size, 0, raw)
  }
  assert.deepEqual([...createPinStore({ storage: memoryStorage({ [KEY]: '{"version":1,"ids":[1,"1",2]}' }) }).getSnapshot()], ['1', '2'])
})

test('storage that throws keeps the pins for the session and breaks nothing', () => {
  const throwing = { getItem() { throw new Error('denied') }, setItem() { throw new Error('quota') } }
  const store = createPinStore({ storage: throwing })
  store.toggle(501)
  assert.ok(store.isPinned(501))
})

const fakeWindow = () => {
  const handlers = new Set()
  return {
    addEventListener: (type, fn) => type === 'storage' && handlers.add(fn),
    removeEventListener: (type, fn) => handlers.delete(fn),
    fire: e => { for (const fn of handlers) fn(e) },
    handlers,
  }
}

test('a pin made in another tab arrives through the storage event, whether or not the list is mounted', () => {
  const storage = memoryStorage()
  const win = fakeWindow()
  const store = createPinStore({ storage, win })
  assert.equal(win.handlers.size, 1, 'listening from the start, not only while subscribed')

  // The Rules tab is left (nothing subscribed) while another tab pins 501.
  storage.setItem(KEY, JSON.stringify({ version: 1, ids: ['501'] }))
  win.fire({ key: 'something-else' })
  assert.ok(!store.isPinned(501), 'another key is not ours')
  win.fire({ key: KEY })
  assert.ok(store.isPinned(501), 'back on the tab, 501 shows pinned')

  // Pinning here keeps the other tab's pin rather than writing over it.
  let heard = 0
  const off = store.subscribe(() => { heard += 1 })
  store.toggle(502)
  assert.deepEqual(JSON.parse(storage.raw.get(KEY)).ids, ['501', '502'])
  assert.equal(heard, 1)

  win.fire({ key: KEY })
  assert.equal(heard, 1, 'an event that changes nothing re-renders nothing')
  // Another tab clearing all of storage sends a null key.
  storage.raw.clear()
  win.fire({ key: null })
  assert.equal(store.getSnapshot().size, 0)
  off()
})

test('drop unpins a rule being deleted and hands back the undo; an unpinned rule has nothing to drop', () => {
  const store = createPinStore({ storage: memoryStorage() })
  assert.equal(store.drop(501), null)
  store.toggle(501)
  const repin = store.drop(501)
  assert.ok(!store.isPinned(501))
  repin()
  assert.ok(store.isPinned(501))
})
