// The status resolvers every severity colour on the platform goes through.
//
// The risk is at the edges. A threshold written `<` where the standard says
// `≤` moves a page that sits exactly on 2.5 s from Good to Needs improvement,
// and nothing on screen looks wrong — the dot is just a different colour. The
// web-vital bands are Google's, inclusive at both ends, so both ends are
// pinned for each metric; and the older resolvers are pinned beside them so
// adding a scale for the Browser page cannot quietly move the service page's.
//
// The HTTP-code resolver below is the Mobile Traces page's: a mobile record's
// status_code is the code the server answered with, not OTel's ERROR/UNSET, and
// every severity colour on that page resolves through it. No answer and 5xx are
// critical, 4xx a warning, the rest healthy, and anything that is not a code
// says nothing.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  STATUS, WEB_VITAL_THRESHOLDS, WEB_VITAL_RATINGS, statusForWebVital, statusForHttpStatus,
  statusForLatency, statusForErrorRate, worstStatus,
} from './status.js'

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

test('LCP is good to 2.5 s, needs improvement to 4 s, and poor past it', () => {
  assert.equal(statusForWebVital('lcp', 0), STATUS.healthy)
  assert.equal(statusForWebVital('lcp', 2500), STATUS.healthy)
  assert.equal(statusForWebVital('lcp', 2501), STATUS.warning)
  assert.equal(statusForWebVital('lcp', 4000), STATUS.warning)
  assert.equal(statusForWebVital('lcp', 4001), STATUS.critical)
  assert.equal(statusForWebVital('lcp', 4550), STATUS.critical, "production's /product/:sku")
})

test('INP is good to 200 ms, needs improvement to 500 ms, and poor past it', () => {
  assert.equal(statusForWebVital('inp', 200), STATUS.healthy)
  assert.equal(statusForWebVital('inp', 200.01), STATUS.warning)
  assert.equal(statusForWebVital('inp', 500), STATUS.warning)
  assert.equal(statusForWebVital('inp', 500.01), STATUS.critical)
  assert.equal(statusForWebVital('inp', 569.73), STATUS.critical, "production's /checkout")
})

test('CLS is good to 0.1, needs improvement to 0.25, and poor past it', () => {
  assert.equal(statusForWebVital('cls', 0.1), STATUS.healthy)
  assert.equal(statusForWebVital('cls', 0.11), STATUS.warning)
  assert.equal(statusForWebVital('cls', 0.25), STATUS.warning)
  assert.equal(statusForWebVital('cls', 0.26), STATUS.critical)
  assert.equal(statusForWebVital('cls', 0), STATUS.healthy, 'a page that never shifts')
})

test('no reading, or a metric nobody rates, is no data rather than a guess', () => {
  for (const v of [null, undefined, NaN, '2500']) assert.equal(statusForWebVital('lcp', v), STATUS.neutral, String(v))
  assert.equal(statusForWebVital('fid', 50), STATUS.neutral)
  assert.equal(statusForWebVital(undefined, 50), STATUS.neutral)
})

test('every rating has a name, and the bands are in order', () => {
  for (const s of [STATUS.healthy, STATUS.warning, STATUS.critical]) assert.ok(WEB_VITAL_RATINGS[s], s)
  assert.deepEqual(WEB_VITAL_RATINGS, { healthy: 'Good', warning: 'Needs improvement', critical: 'Poor' })
  for (const [metric, t] of Object.entries(WEB_VITAL_THRESHOLDS)) assert.ok(t.good < t.poor, metric)
})

// The Browser page's thresholds are additive. The service page's scales stay
// where they were: p90 at 150 / 300 ms, errors at 1% / 3%.
test('the server latency and error-rate scales are unchanged', () => {
  assert.equal(statusForLatency(149), STATUS.healthy)
  assert.equal(statusForLatency(150), STATUS.warning)
  assert.equal(statusForLatency(300), STATUS.critical)
  assert.equal(statusForLatency(null), STATUS.neutral)
  assert.equal(statusForErrorRate(0.99), STATUS.healthy)
  assert.equal(statusForErrorRate(1), STATUS.warning)
  assert.equal(statusForErrorRate(3), STATUS.critical)
  assert.equal(worstStatus(STATUS.healthy, statusForWebVital('inp', 600)), STATUS.critical)
})
