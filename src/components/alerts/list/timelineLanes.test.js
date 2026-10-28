// The alert timeline (docs/alerts/DESIGN.md D4): lanes built from the seed's
// timeline at Last 1 hour, and the swimlanes drawn from them.
//
// The risks: a lane for a rule that did nothing in the range, a rule firing on
// three hosts drawn as one bar, lanes in an order that buries the critical
// ones, a bar whose colour is its only word (D17 wants "Status: Critical" in
// its title), and a click that freezes a live range for nothing.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server.browser'
import { resolveWindow } from '@/data/timeWindow'
import { seededAlerts } from './fixtures.js'
import {
  LANE_CAP, buildLanes, clipIntervals, xPct, barTitle, focusRangeFor, seriesLabelText, timelineSummary,
} from './timelineLanes.js'
import AlertTimeline from './AlertTimeline.jsx'

const hour = resolveWindow({ kind: 'preset', value: '1h' })
const seeded = seededAlerts(hour)
const lanes = buildLanes(seeded.timeline, seeded.byId, hour, seeded.seriesFor)
const lanesOf = id => lanes.filter(l => String(l.ruleId) === String(id))

test('one lane per rule that fired or pended in the range, and only those', () => {
  const ruleIds = new Set(lanes.map(l => String(l.ruleId)))
  for (const id of ['501', '502', '503', '507']) assert.ok(ruleIds.has(id), `${id} has a lane`)
  for (const id of ['511', '512', '513', '427']) assert.ok(!ruleIds.has(id), `${id} did nothing in the range`)
  assert.ok(lanes.every(l => l.bars.length > 0))
})

test('a rule firing on several series gets a lane per series, named by what tells them apart', () => {
  const cpu = lanesOf(515)
  assert.equal(cpu.length, 3)
  assert.deepEqual(cpu.map(l => l.sub).sort(), ['ip-10-0-142-133', 'ip-10-0-142-2', 'ip-10-0-143-40'])
  assert.ok(cpu.every(l => l.name === 'CPU high on ‹host.name›'), 'the rule\'s name, its label named in place')
  assert.ok(cpu.every(l => l.alertId), 'each lane names its own alert, for alert_id')
  assert.equal(new Set(cpu.map(l => l.alertId)).size, 3)
  assert.equal(seriesLabelText({ service: 'a', 'host.name': 'b' }), 'service=a · host.name=b')
})

test('lanes come worst first: critical, then warning, then only ever pending', () => {
  const order = ['critical', 'warning', 'pending']
  const worst = lanes.map(l => order.indexOf(l.worst))
  assert.deepEqual(worst, [...worst].sort((a, b) => a - b))
  assert.equal(lanes.at(-1).worst, 'pending')
  assert.equal(String(lanesOf(503)[0].ruleId), '503')
})

test('a stretch is cut to the window, and an ongoing one runs to now and says so', () => {
  const win = { start: 1000, end: 2000, nowSec: 1900 }
  const cut = clipIntervals([
    { start: 500, end: 1200, state: 'firing' },
    { start: 1500, end: null, state: 'firing' },
    { start: 100, end: 900, state: 'pending' },
  ], win)
  assert.deepEqual(cut.map(i => [i.start, i.end, i.ongoing]), [[1000, 1200, false], [1500, 1900, true]])
  assert.equal(xPct(1500, win), 50)
  assert.equal(xPct(5000, win), 100)
})

// A bar's clock time carries its date when the bar began on another day than
// now, which is what happens just after midnight ("Oct 15 23:52–now").
const CLOCK = String.raw`(?:[A-Z][a-z]{2} \d{1,2} )?\d\d:\d\d`

test('every bar carries its state as a word, with when, how long and its peak', () => {
  const lane = lanesOf(502)[0]
  // It escalated: a Warning stretch, then the Critical one it is still in.
  const firing = lane.bars.find(b => b.state === 'firing' && b.ongoing)
  assert.match(barTitle(firing, lane, hour), new RegExp(`^Status: Critical · ${CLOCK}–now · \\d+m · peak \\d+ ms$`))
  assert.ok(lane.bars.some(b => b.state === 'firing' && b.severity === 'warning' && !b.ongoing))
  const pending = lane.bars.find(b => b.state === 'pending')
  assert.match(barTitle(pending, lane, hour), new RegExp(`^Status: Pending · ${CLOCK}–${CLOCK} · \\d+m`))
})

test('a click focuses the range on its bar, unless the bar is most of the range already', () => {
  const lane = lanesOf(501)[0]
  const bar = lane.bars.find(b => b.state === 'firing')
  const focus = focusRangeFor(bar, hour)
  assert.ok(focus.start < bar.start && focus.end <= hour.nowSec)
  const chronic = lanesOf(508)[0].bars[0]
  assert.equal(focusRangeFor(chronic, hour), null, 'a stretch across the whole hour leaves the live range alone')
})

const markup = props => renderToStaticMarkup(
  <AlertTimeline timeline={seeded.timeline} byId={seeded.byId} seriesFor={seeded.seriesFor} win={hour} {...props} />,
)

test('the swimlanes draw five lanes, then offer the rest in the series-budget footer', () => {
  const html = markup({ setTimeRange: () => {} })
  const labels = html.match(/class="rtab-tl-label"/g) ?? []
  assert.equal(labels.length, Math.min(LANE_CAP, lanes.length))
  assert.ok(lanes.length > LANE_CAP, 'the seed fires on more series than one screenful')
  assert.match(html, new RegExp(`Showing ${LANE_CAP} of ${lanes.length} lanes`))
  assert.match(html, />Show all</)
  assert.match(html, /title="Drag across the timeline to zoom"/)
  // A lane's name is just its name: the bars beside it already carry the colour.
  const names = html.slice(html.indexOf('class="rtab-tl-labels"'), html.indexOf('class="rtab-tl-plot"'))
  assert.doesNotMatch(names, /status-dot/)
})

test('each bar is a real link to its rule and alert, titled with its word', () => {
  const html = markup({})
  const bars = [...html.matchAll(/<a href="([^"]+)" class="rtab-tl-bar" aria-label="([^"]+)">\s*<title>([^<]+)<\/title>/g)]
  assert.ok(bars.length > 0)
  for (const [, href, label, title] of bars) {
    assert.match(href, /^\/alerts\/\d+(\?alert_id=\d+)?$/)
    assert.match(title, /^Status: (Critical|Warning|Pending) · /)
    assert.ok(label.endsWith(title.replace(/&#x27;/g, '\'')) || label.includes(title), 'the accessible name carries the word too')
  }
  assert.doesNotMatch(html, /Drag across the timeline to zoom/, 'no zoom without a range to set')
  assert.match(html, /<pattern id="rtab-hatch-/, 'pending is hatched')
})

test('the head sums the range up, short, and folds the panel to itself', () => {
  const critical = lanes.filter(l => l.worst === 'critical').length
  const warning = lanes.filter(l => l.worst === 'warning').length
  assert.ok(critical > 0 && warning > 0)
  assert.equal(timelineSummary(lanes, hour), `Last 1 hr · ${critical} critical · ${warning} warning`)
  const at = value => timelineSummary([], resolveWindow({ kind: 'preset', value }))
  assert.equal(at('15m'), 'Last 15 min · 0 critical · 0 warning')
  assert.equal(at('24h'), 'Last 24 hr · 0 critical · 0 warning')
  assert.equal(at('7d'), 'Last 7 days · 0 critical · 0 warning')

  // The whole head is the button: its name is what it says, and it arrives folded.
  const html = markup({})
  assert.match(html, /^<div class="panel rtab-tl is-collapsed">/)
  const head = html.match(/<button[^>]*class="panel-head rtab-tl-head"[^>]*>[\s\S]*?<\/button>/)?.[0] ?? ''
  assert.match(head, new RegExp(`>Last 1 hr · ${critical} critical · ${warning} warning<`))
  assert.match(head, /aria-expanded="false"/)
  assert.doesNotMatch(head, /aria-label=/, 'named by its own words')
  const bodyId = head.match(/aria-controls="([^"]+)"/)?.[1]
  assert.match(html, new RegExp(`id="${bodyId}" class="rtab-tl-body" hidden="">`), 'the head names the body it folds')

  const opened = markup({ defaultOpen: true })
  assert.match(opened, /^<div class="panel rtab-tl">/)
  assert.match(opened, /class="panel-head rtab-tl-head is-divided" aria-expanded="true"/)
  assert.match(opened, new RegExp(`id="[^"]+" class="rtab-tl-body">`))
})

test('a quiet range says so instead of drawing empty lanes', () => {
  const html = renderToStaticMarkup(<AlertTimeline timeline={[]} byId={seeded.byId} win={hour} />)
  assert.match(html, /Nothing fired or pended in the last 1 hour\./)
  assert.doesNotMatch(html, /rtab-tl-bar/)
})
