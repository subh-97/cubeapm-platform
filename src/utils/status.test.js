// The HTTP-code severity resolver. A mobile record's status_code is the code
// the server answered with, not OTel's ERROR/UNSET, and every severity colour
// on the Mobile Traces page — the row gutter, the status cell, the drawer badge,
// the histogram band — resolves through this one function. These pin the
// readings the page's legend promises: no answer and 5xx are critical, 4xx a
// warning, the rest healthy, and anything that is not a code says nothing.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { STATUS, statusForHttpStatus } from './status.js'

test('no answer and server errors are critical', () => {
  for (const code of ['0', '500', '502', '503', '504', '599', 0, 503]) {
    assert.equal(statusForHttpStatus(code), STATUS.critical, String(code))
  }
})

test('client errors are a warning', () => {
  for (const code of ['400', '404', '429', '499', 404]) {
    assert.equal(statusForHttpStatus(code), STATUS.warning, String(code))
  }
})

test('informational, success and redirects are healthy, and so is UNSET', () => {
  for (const code of ['100', '200', '204', '301', '304', '399', 200, 'UNSET']) {
    assert.equal(statusForHttpStatus(code), STATUS.healthy, String(code))
  }
})

test('anything that is not a code is neutral', () => {
  for (const code of ['', null, undefined, 'ERROR', 'OK', '600', '99', '2xx', '-1', '20 0']) {
    assert.equal(statusForHttpStatus(code), STATUS.neutral, String(code))
  }
})
