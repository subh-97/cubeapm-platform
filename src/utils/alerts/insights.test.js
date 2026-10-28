// Insights (insights.js; docs/alerts/DESIGN.md D11): its numbers are the
// timeline's, every rule is listed, and each flag trips exactly at its edge.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveWindow } from '@/data/timeWindow'
import { alertsSeed, ruleDefsFor, alertStatsForWindow, ruleTimelineForWindow, previousWindowOf } from '@/data/alerts'
import { alertsFor } from './store'
import { insightFlags, insightRows, insightsSummary, insightsCsv } from './insights'

const state = alertsSeed()
const defs = ruleDefsFor(state)
const DAY = resolveWindow({ kind: 'preset', value: '24h' })
const { rules: views } = alertsFor(state, null)

test('incidents and time firing are the timeline\'s, over the same range', () => {
  const timeline = new Map(ruleTimelineForWindow(DAY, defs, state).map(t => [t.ruleId, t]))
  const end = Math.min(DAY.end, DAY.nowSec)
  for (const s of alertStatsForWindow(DAY, defs, state)) {
    const firing = (timeline.get(s.ruleId)?.intervals ?? []).filter(iv => iv.state === 'firing')
    const sec = firing.reduce((a, iv) => a + Math.min(iv.end ?? end, end) - Math.max(iv.start, DAY.start), 0)
    assert.ok(Math.abs(sec - s.firingSec) <= 1, `${s.ruleId}: ${sec} vs ${s.firingSec}`)
    // A warning running straight into a critical is one incident; one already firing when the range opens is not counted.
    let starts = 0
    firing.forEach((iv, i) => { if (iv.start >= DAY.start && !iv.openStart && firing[i - 1]?.end !== iv.start) starts++ })
    assert.equal(s.incidents, starts, String(s.ruleId))
  }
})

test('each flag trips exactly at its edge', () => {
  const base = { spanSec: 3600, firingPct: 0, incidents: 0, medianSec: null, active: true }
  assert.equal(insightFlags({ ...base, firingPct: 49.99 }).alwaysFiring, false)
  assert.equal(insightFlags({ ...base, firingPct: 50 }).alwaysFiring, true)
  const flap = { ...base, incidents: 6, medianSec: 599 }
  assert.equal(insightFlags(flap).flapping, true)
  assert.equal(insightFlags({ ...flap, incidents: 5 }).flapping, false)
  assert.equal(insightFlags({ ...flap, medianSec: 600 }).flapping, false)
  assert.equal(insightFlags({ ...flap, spanSec: 6 * 3600 }).flapping, false, '6 in 6 hours is one an hour, not flapping')
  assert.equal(insightFlags({ ...flap, spanSec: 1.5 * 3600 }).flapping, true, '6 in 90 minutes is 4 an hour')
  const quiet = { ...base, spanSec: 86400, active: false }
  assert.equal(insightFlags(quiet).neverFired, true)
  assert.equal(insightFlags({ ...quiet, spanSec: 86399 }).neverFired, false)
  assert.equal(insightFlags({ ...quiet, active: true }).neverFired, false, 'a rule that went pending is alive')
  assert.equal(insightFlags({ ...quiet, error: true }).neverFired, false)
  assert.deepEqual(insightFlags({ paused: true, spanSec: 86400, firingPct: 100, incidents: 9, medianSec: 1, active: false }), { alwaysFiring: false, flapping: false, neverFired: false })
})

test('every rule is listed, the noisy first, with its change against the previous period', () => {
  const rows = insightRows(views, alertStatsForWindow(DAY, defs, state), alertStatsForWindow(previousWindowOf(DAY), defs, state))
  assert.equal(rows.length, views.length)
  assert.equal(rows[0].id, 508, 'the chronic rule leads: always firing')
  assert.ok(rows[0].flags.alwaysFiring)
  assert.equal(rows[1].id, 509, 'then the flapping one')
  assert.ok(rows[1].flags.flapping)
  assert.equal(rows.find(r => r.id === 503).flags.neverFired, false, 'a pending rule is not dead')
  assert.ok(rows.every(r => r.deltas && Number.isFinite(r.deltas.incidents)))
  assert.ok(rows.filter(r => r.paused).every(r => !Object.values(r.flags).some(Boolean)))
  const pay = rows.find(r => r.id === 501)
  assert.equal(pay.deltas.incidents, pay.incidents, 'the incident is new: nothing the day before')
  const summary = insightsSummary(rows)
  assert.equal(summary.incidents, rows.reduce((a, r) => a + r.incidents, 0))
  assert.ok(summary.alwaysFiring >= 1 && summary.flagged >= 2)
  const csv = insightsCsv(rows).split('\n')
  assert.equal(csv[0], 'id,group,name,incidents,firing_minutes,firing_pct,median_incident_minutes,notifications,failed,flags')
  assert.equal(csv.length, rows.length + 1)
  assert.match(csv[1], /^"508","Platform","notify-service slow sends",.*"Always firing"$/)
})
