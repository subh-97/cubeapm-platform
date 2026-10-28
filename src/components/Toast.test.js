// The toast's markup: what a screen reader is told, and what index.css hangs
// its look on. The countdown lives in effects, which a static render does not
// run; utils/toastTimer.test.js covers it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server.browser'
import { createElement } from 'react'
import Toast from './Toast.jsx'

const noop = () => {}
const render = props => renderToStaticMarkup(createElement(Toast, { onClose: noop, ...props }))

test('the toast is a polite status, with its message and a labelled close', () => {
  const html = render({ message: 'Help Center is not built yet.' })
  assert.match(html, /^<div class="toast-bar" role="status" aria-live="polite">/)
  assert.match(html, /<span class="toast-msg">Help Center is not built yet\.<\/span>/)
  assert.match(html, /<button class="toast-close" aria-label="Dismiss">/)
})

// The toast looks inside .toast-msg for a control to decide between 4.5s and
// 10s. Every toast has the close, so it has to stay outside that span, or
// every notice would count as carrying a control.
test('a control the message brings sits in .toast-msg, and the close outside it', () => {
  const message = createElement('span', null, 'Paused payment-service error rate.',
    createElement('button', { type: 'button' }, 'Undo'))
  const html = render({ message })
  assert.match(html, /<span class="toast-msg"><span>Paused payment-service error rate\.<button type="button">Undo<\/button><\/span><\/span><button class="toast-close"/)
})
