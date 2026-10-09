// trapTab keeps Tab inside a dialog — the exception modal and the settings
// drawer. There is no DOM library here, so a dialog is played by a few plain
// objects: each control answers focus() by becoming document.activeElement,
// and getClientRects() says whether it is drawn. What is checked is where Tab
// and Shift+Tab land from each place focus can be: a control in the middle
// (left to the browser), either end (wrapped round), the dialog itself (where
// a click on its text leaves focus) and somewhere outside it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { trapTab } from './focusTrap.js'

function control(name, { drawn = true, tabIndex = 0 } = {}) {
  const el = {
    name,
    tabIndex,
    getClientRects: () => (drawn ? [{}] : []),
    focus: () => { globalThis.document.activeElement = el },
  }
  return el
}

function dialog(items) {
  const box = {
    name: 'dialog',
    querySelectorAll: () => items,
    contains: el => el === box || items.includes(el),
  }
  return box
}

// A Tab keydown on the dialog, with focus at `at`. Returns where focus is
// afterwards, or 'browser' when the handler left the move to the browser.
function press(box, at, shiftKey = false) {
  globalThis.document = { activeElement: at }
  let prevented = false
  trapTab({ key: 'Tab', shiftKey, currentTarget: box, preventDefault: () => { prevented = true } })
  return prevented ? globalThis.document.activeElement.name : 'browser'
}

const close = control('close')
const copy = control('copy')
const hidden = control('closed tab panel', { drawn: false })
const pre = control('stack')
const box = dialog([close, copy, hidden, pre])
const page = control('sidebar item')

test('between the first and last control, Tab is the browser\'s own', () => {
  assert.equal(press(box, copy), 'browser')
  assert.equal(press(box, copy, true), 'browser')
})

test('past either end, Tab comes round to the other, skipping what is not drawn', () => {
  assert.equal(press(box, pre), 'close')
  assert.equal(press(box, close, true), 'stack')
})

test('from the dialog itself (a click on its text), Tab goes in rather than out', () => {
  assert.equal(press(box, box), 'close')
  assert.equal(press(box, box, true), 'stack', 'Shift+Tab must not step to the page behind')
})

test('from outside the dialog, Tab is brought back in', () => {
  assert.equal(press(box, page), 'close')
  assert.equal(press(box, page, true), 'stack')
})

test('other keys, and a dialog with nothing to tab to, are left alone', () => {
  globalThis.document = { activeElement: pre }
  let prevented = false
  trapTab({ key: 'Enter', currentTarget: box, preventDefault: () => { prevented = true } })
  assert.equal(prevented, false)
  assert.equal(press(dialog([hidden]), hidden), 'browser')
})

// A roving tab group leaves its inactive tabs in the markup with tabIndex -1:
// the browser never stops on them, so neither end of the cycle may be one.
test('a control the browser skips (tabIndex -1) is never an end of the cycle', () => {
  const first = control('first')
  const last = control('last')
  const inactiveTab = control('inactive tab', { tabIndex: -1 })
  const box = dialog([first, last, inactiveTab])
  assert.equal(press(box, last), 'first')
  assert.equal(press(box, first, true), 'last')
})
