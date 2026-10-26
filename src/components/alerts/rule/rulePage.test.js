// The rule page's own logic, on the seeded incident (docs/alerts/DESIGN.md D5,
// D14). The risks are quiet ones: a notification link that re-centres the
// range when it should not (or stays put when it is old), a banner whose
// numbers drift from the words describe.js uses everywhere else, an alert_id
// that names an instance's other tier and finds no row, a state strip that
// leaves a gap or overlaps itself, and bands that are not the rule's tiers.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ReferenceArea, ReferenceLine } from 'recharts'
import { resolveWindow, REFERENCE_WINDOW } from '@/data/timeWindow'
import { createAlertsStore, alertsFor } from '@/utils/alerts/store'
import { formatElapsed, formatValue, formatThreshold, multipleText } from '@/utils/alerts/describe'
import {
  notifyRange, NOTIFY_STALE_SEC, bannerSentence, rootCauseFor, crossedTier, instanceRows, rowForAlertId,
  stripSegments, incidentsStarted, recentEvents, shiftedWindow, sendCounts,
} from './rulePage.js'
import { tierBands } from './ruleOverlays.jsx'
import { ruleChartModel, firingShades } from './chartModel.js'

const win = resolveWindow({ kind: 'preset', value: '1h' })
const nowSec = win.nowSec
const alerts = alertsFor(createAlertsStore({ storage: null }).getState(), win)
const view = id => alerts.byId(id)

// ---------- notifyTime (production §1.3) ----------

test('an old notification link moves the range to the hour around it, as an absolute range', () => {
  const notifyTime = win.end - 2 * 3600
  assert.deepEqual(notifyRange(notifyTime, win.end), {
    kind: 'absolute', from: (notifyTime - 1800) * 1000, to: (notifyTime + 1800) * 1000,
  })
})

test('a recent link leaves the range alone, up to and including 35 minutes after it', () => {
  assert.equal(notifyRange(win.end - 600, win.end), null)
  assert.equal(notifyRange(win.end - NOTIFY_STALE_SEC, win.end), null, 'exactly 35 minutes is not yet old')
  assert.ok(notifyRange(win.end - NOTIFY_STALE_SEC - 1, win.end), 'one second more is')
  // An absolute range that already ends near the notification is not moved.
  assert.equal(notifyRange(1_760_000_000, 1_760_000_000 + 1200), null)
  for (const bad of [null, undefined, NaN, 'x']) assert.equal(notifyRange(bad, win.end), null)
})

// ---------- the banner ----------

test('the banner sentence says how long, the reading against the crossed threshold, and the cause, in describe.js\'s words', () => {
  const v = view(501)
  assert.equal(v.state, 'firing')
  assert.equal(v.severity, 'critical')
  const s = bannerSentence(v, nowSec, rootCauseFor(v.scope.service))
  const expected = `Firing for ${formatElapsed(nowSec - v.since)}. `
    + `${formatValue(v, v.value)} now, ${multipleText(v)} the ${formatThreshold(v, v.tiers.critical.threshold)} threshold. `
    + 'Likely cause: Redis connection pool exhaustion (redis.0).'
  assert.equal(s.text, expected)
  // The incident is 22 minutes old; the rule waits 5 minutes before firing.
  assert.ok(nowSec - v.since >= 15 * 60 && nowSec - v.since <= 18 * 60, `fired ${(nowSec - v.since) / 60} minutes ago`)
  assert.ok(v.value > 10 && v.value < 20, `about 14% now: ${v.value}`)
})

test('a warning rule crosses its warning tier; a rule that is not firing has no banner sentence', () => {
  const demo = view(437)
  assert.equal(demo.severity, 'warning')
  assert.equal(crossedTier(demo).severity, 'warning')
  assert.match(bannerSentence(demo, nowSec, null).text, /the 0\.1% threshold\.$/)
  for (const id of [503, 510, 512, 513, 427]) assert.equal(bannerSentence(view(id), nowSec), null, String(id))
  assert.equal(rootCauseFor('notify-service'), null)
  assert.equal(rootCauseFor('order-service'), 'Downstream call to payment-service')
})

// ---------- instances and alert_id ----------

test('instances are one row per label set, worst first, with every alert id of the series on its row', () => {
  const v = view(515)
  const rows = instanceRows(v, alerts.seriesFor(515))
  assert.ok(rows.length >= 3)
  assert.equal(new Set(rows.map(r => r.name)).size, rows.length, 'one row per series')
  for (const a of v.rule.alerts) {
    const row = rowForAlertId(rows, a.id)
    assert.ok(row, `alert ${a.id} finds its row`)
    assert.equal(row.labels['host.name'], a.labels['host.name'])
  }
  const rank = r => ({ critical: 0, warning: 1, pending: 2 }[r.state === 'firing' ? r.severity : r.state] ?? 3)
  for (let i = 1; i < rows.length; i++) assert.ok(rank(rows[i - 1]) <= rank(rows[i]), 'worst first')
})

test('an alert_id for the warning tier of a series firing critical lands on the same row', () => {
  const v = view(501)
  const rows = instanceRows(v, alerts.seriesFor(501))
  assert.equal(rows.length, 1)
  const ids = v.rule.alerts.map(a => a.id)
  assert.equal(ids.length, 2, 'a warning and a critical alert for one series')
  for (const id of ids) assert.equal(rowForAlertId(rows, id), rows[0])
  assert.equal(rowForAlertId(rows, '123'), null)
  assert.equal(rowForAlertId(rows, null), null)
})

// ---------- the state strip ----------

test('the strip covers the window without gaps: OK, then pending, then firing, until now', () => {
  const v = view(501)
  const lane = alerts.timeline.find(t => String(t.ruleId) === '501').intervals
  const segs = stripSegments(lane, win, nowSec)
  assert.deepEqual(segs.map(s => s.key), ['ok', 'pending', 'warning', 'critical'].filter(k => segs.some(s => s.key === k)))
  assert.equal(segs[0].from, win.start)
  for (let i = 1; i < segs.length; i++) assert.equal(segs[i].from, segs[i - 1].to, 'abutting')
  const last = segs[segs.length - 1]
  assert.equal(last.key === 'future' ? segs[segs.length - 2].key : last.key, 'critical')
  const width = segs.reduce((a, s) => a + s.widthPct, 0)
  assert.ok(Math.abs(width - 100) < 1e-6, `${width}%`)
  assert.equal(segs.find(s => s.key === 'critical').tone, v.tone)
  for (const s of segs) assert.match(s.tone, /^(healthy|info|warning|critical|neutral)$/)
})

test('a paused rule, one that cannot evaluate and one with no data are one segment that says so', () => {
  for (const [id, key] of [[427, 'paused'], [513, 'error'], [512, 'nodata']]) {
    const segs = stripSegments([], win, nowSec, view(id).state)
    assert.equal(segs[0].key, key, String(id))
    assert.equal(segs[0].tone, 'neutral')
  }
})

// ---------- counts ----------

test('incidents count firing that began in the range; an escalation is the same incident', () => {
  const ivs = [
    { state: 'pending', start: 100, end: 400 },
    { state: 'firing', severity: 'warning', start: 400, end: 500 },
    { state: 'firing', severity: 'critical', start: 500, end: 900 },
    { state: 'firing', severity: 'warning', start: 1200, end: null },
  ]
  assert.equal(incidentsStarted(ivs, 0, 2000), 2)
  assert.equal(incidentsStarted(ivs, 450, 2000), 1, 'one began before the range')
  assert.equal(incidentsStarted([{ state: 'firing', start: 0, end: 50, openStart: true }], 0, 100), 0, 'already open when we looked')
  const lane = alerts.timeline.find(t => String(t.ruleId) === '501').intervals
  assert.equal(incidentsStarted(lane, win.start, nowSec), 1, 'the payment incident')
})

test('the previous period is the same window one span back, bucket for bucket, before the incident', () => {
  const prev = shiftedWindow(win, win.end - win.start)
  assert.equal(prev.buckets.length, win.buckets.length)
  assert.equal(prev.start, win.start - (win.end - win.start))
  for (let i = 0; i < win.buckets.length; i++) assert.equal(prev.buckets[i].t, win.buckets[i].t - (win.end - win.start))
  assert.ok(prev.buckets.every(b => b.w === 0), 'the hour before the last one never saw the pool fail')
  assert.ok(REFERENCE_WINDOW.buckets.some(b => b.w > 0))
})

// ---------- recent events and sends ----------

test('recent events are newest first: fired and escalated from the lane, each send from the log', () => {
  const v = view(501)
  const lane = alerts.timeline.find(t => String(t.ruleId) === '501').intervals
  const log = alerts.log.filter(r => String(r.rule_id) === '501')
  const events = recentEvents({ intervals: lane, log, view: v, from: win.start, to: nowSec, lookups: alerts.lookups, limit: 20 })
  for (let i = 1; i < events.length; i++) assert.ok(events[i - 1].t >= events[i].t, 'newest first')
  const kinds = new Set(events.map(e => e.kind))
  for (const k of ['pending', 'notified']) assert.ok(kinds.has(k), `${k}: ${[...kinds]}`)
  assert.ok(kinds.has('fired') || kinds.has('escalated'))
  assert.ok(events.some(e => /Payments on-call · Slack/.test(e.text)), events.map(e => e.text).join(' | '))
  const counts = sendCounts(log, win.start, nowSec)
  assert.equal(counts.sent, log.filter(r => r.status === 'SUCCESS').length)
})

// ---------- the chart ----------

test('the bands are the rule\'s stored tiers: good below 1%, amber to 3%, red above', () => {
  const v = view(501)
  const els = tierBands(v)
  const zones = els.filter(e => e.type === ReferenceArea)
  const rules = els.filter(e => e.type === ReferenceLine)
  assert.deepEqual(zones.map(z => [z.props.y1, z.props.y2 ?? null, z.props.fill]), [
    [0, v.tiers.warning.threshold, 'var(--healthy)'],
    [v.tiers.warning.threshold, v.tiers.critical.threshold, 'var(--warning)'],
    [v.tiers.critical.threshold, null, 'var(--critical)'],
  ])
  assert.deepEqual(rules.map(r => [r.props.y, r.props.label.value]), [[1, '1%'], [3, '3%']])
  // A lone critical tier at "== 0" (a monitor down) is a rule, not a zone.
  const synthetic = tierBands(view(426))
  assert.deepEqual(synthetic.map(e => e.type), [ReferenceLine])
  assert.equal(synthetic[0].props.stroke, 'var(--critical)')
  assert.deepEqual(tierBands(view(510)), [], 'an anomaly rule draws its expected range instead')
})

test('the chart keeps both tiers in view, draws series in palette colours, and shades only firing', () => {
  const v = view(501)
  const series = alerts.seriesFor(501)
  const m = ruleChartModel({ view: v, series, compare: series.map(s => ({ ...s, points: s.previousPoints })) })
  assert.ok(m.yTop >= 3 * 1.2, `top ${m.yTop}`)
  assert.ok(m.axisTop >= Math.max(...series[0].points.map(p => p.value ?? 0)))
  assert.equal(m.compareKey, 'ep1', 'the previous period rides past the legend rows')
  assert.equal(m.colorFor(1), m.colorFor(0), 'in its series\' colour')
  assert.doesNotMatch(m.colorFor(0), /#(22C55E|F59E0B|EF4444)/i, 'never a status hue')
  assert.equal(m.formatLabel('', undefined), 'Previous period')
  const lane = alerts.timeline.find(t => String(t.ruleId) === '501').intervals
  const shades = firingShades(lane, nowSec)
  assert.ok(shades.length >= 1)
  assert.ok(shades.every(s => s.tone === 'critical' || s.tone === 'warning'))
})
