// PageBar's trail folding from the middle: cutting a page's children into
// crumbs, and choosing how many of them fold into "…".

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement as h, Fragment } from 'react'
import { renderToStaticMarkup } from 'react-dom/server.browser'
import { splitCrumbs, crumbsToHide } from './breadcrumbFold.js'

const sep = () => h('span', { className: 'sep' }, '/')
const text = crumb => renderToStaticMarkup(h(Fragment, null, ...crumb.content))

test('a trail is cut at its separators, each crumb keeping the one in front of it', () => {
  const crumbs = splitCrumbs([
    h('a', null, 'CubeAPM'), sep(),
    h('a', null, 'Infrastructure'), sep(),
    h('span', { className: 'current' }, 'Hosts'),
  ])
  assert.equal(crumbs.length, 3)
  assert.equal(crumbs[0].sep, null)
  assert.ok(crumbs[1].sep && crumbs[2].sep)
  assert.deepEqual(crumbs.map(text), [
    '<a>CubeAPM</a>',
    '<a>Infrastructure</a>',
    '<span class="current">Hosts</span>',
  ])
})

test('fragments and the false a conditional leaves are seen through, as InfraView nests them', () => {
  const k8sPod = null
  const crumbs = splitCrumbs([
    h('a', null, 'CubeAPM'), sep(),
    h(Fragment, null,
      h('a', null, 'Infrastructure'), sep(),
      h(Fragment, null, h('span', { className: 'current' }, 'Kubernetes'), sep()),
      h('a', null, 'Nodes'),
      k8sPod && h(Fragment, null, sep(), h('span', null, 'pod')),
    ),
  ])
  assert.deepEqual(crumbs.map(text), [
    '<a>CubeAPM</a>',
    '<a>Infrastructure</a>',
    '<span class="current">Kubernetes</span>',
    '<a>Nodes</a>',
  ])
})

test('only an element whose class is exactly "sep" separates — not one that merely contains it', () => {
  const crumbs = splitCrumbs([
    h('a', null, 'CubeAPM'),
    h('span', { className: 'sep-like' }, '·'),
    h('span', { className: 'muted sep' }, '/'),
    h('span', null, 'Logs'),
  ])
  assert.equal(crumbs.length, 2)
  assert.equal(text(crumbs[0]), '<a>CubeAPM</a><span class="sep-like">·</span>')
})

test('a stray separator with nothing after it does not make an empty crumb', () => {
  const crumbs = splitCrumbs([h('a', null, 'CubeAPM'), sep(), h('span', null, 'Logs'), sep()])
  assert.equal(crumbs.length, 2)
})

test('an empty trail is no crumbs', () => {
  assert.deepEqual(splitCrumbs(null), [])
  assert.deepEqual(splitCrumbs([false, undefined]), [])
})

// Widths, separator included: CubeAPM 60, then 100, 80, 70, 90. Gap 6, "…" 20.
const W = [60, 100, 80, 70, 90]
const full = 60 + 100 + 80 + 70 + 90 + 4 * 6 // 424

test('a trail that fits folds nothing', () => {
  assert.equal(crumbsToHide(W, 20, 6, full), 0)
  assert.equal(crumbsToHide(W, 20, 6, 1000), 0)
})

test('half a pixel short is rounding, not a reason to fold', () => {
  assert.equal(crumbsToHide(W, 20, 6, full - 0.4), 0)
  assert.equal(crumbsToHide(W, 20, 6, full - 1), 1)
})

test('crumbs fold from the root end of the middle, keeping the nearest parents', () => {
  // Folding the 100 for a 20 "…" saves 80: 424 → 344.
  assert.equal(crumbsToHide(W, 20, 6, 344), 1)
  assert.equal(crumbsToHide(W, 20, 6, 343), 2)
  // 344 - 86 = 258, then 258 - 76 = 182 with only the first and last left.
  assert.equal(crumbsToHide(W, 20, 6, 258), 2)
  assert.equal(crumbsToHide(W, 20, 6, 182), 3)
})

test('the first and last crumb never fold, however narrow the room', () => {
  assert.equal(crumbsToHide(W, 20, 6, 100), 3)
  assert.equal(crumbsToHide(W, 20, 6, 0), 3)
})

test('a trail of two crumbs or fewer has no middle to fold', () => {
  assert.equal(crumbsToHide([60, 400], 20, 6, 100), 0)
  assert.equal(crumbsToHide([600], 20, 6, 100), 0)
  assert.equal(crumbsToHide([], 20, 6, 100), 0)
})
