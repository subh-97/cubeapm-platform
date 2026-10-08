// The drawer's "First seen" and "Last seen", read off the rendered markup for
// every group of every range they are worded differently in.
//
// The group carries both as bucket edges, which is right for a table export
// and wrong beside the samples: at a week a single error read "first seen 21
// hours ago, last seen 18 hours ago" over its one occurrence 20 hours ago, and
// an error that was failing all along was dated to the moment the range began,
// next to a chip saying how many there had been before it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server.browser'
import { createElement } from 'react'
import { BASE_TIME, REFERENCE_WINDOW, INCIDENT_START_MIN, resolveWindow } from '@/data/timeWindow'
import { ERROR_SIDES, errorGroupsForWindow, errorSamplesFor } from '@/data/errors'
import { fullInstant, timeAgo } from '@/components/charts/ChartTooltip'
import ErrorDetailsDrawer from './ErrorDetailsDrawer.jsx'

// Pinned to a half-hour boundary as errors.test.js does, so every range ends
// exactly at its own now and holds the same share of the incident on each run.
const OFF_SEC = -new Date(BASE_TIME).getTimezoneOffset() * 60
const BASE_SEC = Math.floor(BASE_TIME.getTime() / 1000)
const nowMs = (BASE_SEC - ((BASE_SEC - OFF_SEC) % 1800)) * 1000
const preset = v => (v === '1h' ? REFERENCE_WINDOW : resolveWindow({ kind: 'preset', value: v }, nowMs))
const RANGES = ['15m', '1h', '24h', '7d']

const noop = () => {}
const render = (group, win) => renderToStaticMarkup(createElement(ErrorDetailsDrawer, {
  group, win, onClose: noop, onOpenTrace: noop, onOpenLink: noop, onViewTraces: noop, setToast: noop,
}))

const unescape = s => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

// One summary item: what it says, and what its tooltip says.
function seen(html, key) {
  const m = new RegExp(`<span class="errd-sum-item"(?: title="([^"]*)")?><span class="errd-sum-key">${key}</span>([^<]*)</span>`).exec(html)
  assert.ok(m, `no "${key}" in the summary`)
  return { text: unescape(m[2]), title: m[1] == null ? null : unescape(m[1]) }
}

const groupsOf = win => ERROR_SIDES.flatMap(side => errorGroupsForWindow(win, { side }))

test('an error the previous period had too is not dated to the edge of this one', () => {
  for (const v of RANGES) {
    const win = preset(v)
    const before = groupsOf(win).filter(g => g.prevCount > 0)
    assert.ok(before.length > 0, `${v}: no group to check`)
    for (const g of before) {
      const first = seen(render(g, win), 'First seen')
      assert.equal(first.text, 'before this range', `${v} ${g.id}`)
      assert.match(first.title, new RegExp(`\\(${g.prevCount.toLocaleString()} then\\)`), `${v} ${g.id}: the tooltip says how many before`)
    }
  }
})

test('with ten errors or fewer, first and last seen are the oldest and newest of them', () => {
  let ones = 0
  for (const v of RANGES) {
    const win = preset(v)
    const now = win.nowSec * 1000
    for (const g of groupsOf(win).filter(x => x.count <= 10)) {
      const samples = errorSamplesFor(g, win, 10)
      assert.equal(samples.length, g.count, `${v} ${g.id}: every error is a sample`)
      const newest = samples[0].timeMs
      const oldest = samples[samples.length - 1].timeMs
      const html = render(g, win)
      const last = seen(html, 'Last seen')
      assert.equal(last.text, timeAgo(newest, now), `${v} ${g.id}: last seen is the newest error`)
      assert.equal(last.title, fullInstant(newest))
      if (g.prevCount === 0) {
        const first = seen(html, 'First seen')
        assert.equal(first.text, timeAgo(oldest, now), `${v} ${g.id}: first seen is the oldest error`)
        assert.equal(first.title, fullInstant(oldest))
      }
      if (g.count === 1) {
        ones++
        // One error is one instant, whichever end it is read from.
        assert.equal(newest, oldest)
      }
    }
  }
  assert.ok(ones > 0, 'no single-error group was checked')
})

test('a new error with more than ten keeps the group\'s own first and last seen', () => {
  for (const v of ['24h', '7d']) {
    const win = preset(v)
    const now = win.nowSec * 1000
    const fresh = groupsOf(win).filter(g => g.prevCount === 0 && g.count > 10)
    assert.ok(fresh.length > 0, `${v}: no group to check`)
    for (const g of fresh) {
      const html = render(g, win)
      assert.equal(seen(html, 'First seen').text, timeAgo(g.firstSeenMs, now), `${v} ${g.id}`)
      assert.equal(seen(html, 'Last seen').text, timeAgo(g.lastSeenMs, now), `${v} ${g.id}`)
    }
    // The outage is the case the group's own value was corrected for: it
    // began 22 minutes ago, not at the edge of a three-hour bucket.
    const pools = fresh.filter(g => g.exception === 'redis.clients.jedis.exceptions.JedisPoolException')
    assert.ok(pools.length > 0, `${v}: the outage is not a new group`)
    for (const g of pools) {
      assert.equal(seen(render(g, win), 'First seen').text, timeAgo(now - INCIDENT_START_MIN * 60000, now), `${v} ${g.id}`)
    }
  }
})
