// A rule's condition (docs/alerts/DESIGN.md D7). Three risks:
//
//   1. Storage. A rule saved here has to read back in production, so the two
//      stored formats are pinned against real production expressions.
//   2. The tier mapping. Our "Warning when / Critical when" has to round-trip
//      through production's query / query2 / severity tag in every combination.
//   3. Time. Pending, firing and resolving follow Prometheus' state machine; an
//      off-by-one-tick here moves every "firing since" on the page.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  splitCondition, joinCondition, tiersOf, expressionsFor, holds, holdsAnomaly,
  stateIntervals, mergeTierIntervals, backtest, suggestThreshold,
} from './condition.js'

// Production's demo rule #437, as its API returns it.
const DEMO_QUERY = '(sum(increase((cube_apm_calls_total{env="UNSET",service="payment-service",root_name="POST /v1/payments",span_kind=~"server|consumer",status_code="ERROR"} default 0)[5m])) * 100 / sum(increase((cube_apm_calls_total{env="UNSET",service="payment-service",root_name="POST /v1/payments",span_kind=~"server|consumer"} default 0)[5m]))) > 0.1'
const DEMO_BASE = DEMO_QUERY.slice(1, DEMO_QUERY.lastIndexOf(')'))

// ---------- Storage ----------

test('production\'s demo rule splits into its query, operator and threshold', () => {
  assert.deepEqual(splitCondition(DEMO_QUERY), { query: DEMO_BASE, op: '>', threshold: 0.1 })
  assert.equal(joinCondition(DEMO_BASE, '>', 0.1), DEMO_QUERY, 'and joins back to the same text')
})

test('only one wrapping group is removed, and only when it wraps the whole query', () => {
  assert.deepEqual(splitCondition('(a) / (b) >= 2'), { query: '(a) / (b)', op: '>=', threshold: 2 })
  assert.deepEqual(splitCondition('((a) / (b)) < 2'), { query: '(a) / (b)', op: '<', threshold: 2 })
  assert.deepEqual(splitCondition('(max(x{l=")"})) == 0'), { query: 'max(x{l=")"})', op: '==', threshold: 0 }, 'a paren inside a string is not a paren')
  assert.deepEqual(splitCondition('rate(x[5m]) != -1.5e3'), { query: 'rate(x[5m])', op: '!=', threshold: -1500 })
})

test('an expression with no trailing condition comes back whole, not misread', () => {
  assert.deepEqual(splitCondition('sum(rate(x[5m]))'), { query: 'sum(rate(x[5m]))', op: null, threshold: null })
  assert.deepEqual(splitCondition(''), { query: '', op: null, threshold: null })
})

test('a log rule is stored in the LogsQL form, with == written =', () => {
  const stored = '{env="UNSET"} (*) | stats count() as result | filter result: > 100'
  assert.deepEqual(splitCondition(stored, 'vlogs'), { query: '{env="UNSET"} (*) | stats count()', op: '>', threshold: 100 })
  assert.equal(joinCondition('{env="UNSET"} (*) | stats count()', '>', 100, 'vlogs'), stored)
  assert.equal(joinCondition('x | stats count()', '==', 0, 'traces'), 'x | stats count() as result | filter result: = 0')
  assert.deepEqual(splitCondition('x | stats count() as result | filter result: = 0', 'mobile'), { query: 'x | stats count()', op: '==', threshold: 0 })
})

test('a query ending in a # comment keeps its closing paren on a line of its own', () => {
  const q = 'sum(rate(x[5m]))\n# per second'
  const stored = joinCondition(q, '>', 3)
  assert.equal(stored, '(sum(rate(x[5m]))\n# per second\n) > 3')
  assert.deepEqual(splitCondition(stored), { query: q, op: '>', threshold: 3 })
})

// ---------- Tiers ----------

test('production\'s demo rule is one warning tier', () => {
  assert.deepEqual(tiersOf({ query: DEMO_QUERY, query2: '', labels: { group: 'Payments' }, kind: 'static', datasource: 'prometheus' }), {
    kind: 'static', query: DEMO_BASE, warning: { op: '>', threshold: 0.1 }, critical: null,
  })
})

test('a lone condition tagged severity=critical is the critical tier (production\'s synthetic rules)', () => {
  const synthetic = { query: 'max(cube_synthetic_monitor{id="15"}) by (id, group, name) == 0', query2: '', labels: { kind: 'synthetic', severity: 'critical' }, kind: 'static', datasource: 'prometheus' }
  assert.deepEqual(tiersOf(synthetic), {
    kind: 'static', query: 'max(cube_synthetic_monitor{id="15"}) by (id, group, name)', warning: null, critical: { op: '==', threshold: 0 },
  })
})

test('query2 is the critical tier, and an anomaly rule\'s numbers are deviations', () => {
  assert.deepEqual(tiersOf({ query: '(x) > 1', query2: '(x) > 3', labels: {}, kind: 'static' }).critical, { op: '>', threshold: 3 })
  const anomaly = tiersOf({ query: '(rpm) <> 2', query2: '(rpm) <> 3', labels: {}, kind: 'anomaly' })
  assert.deepEqual([anomaly.warning, anomaly.critical], [{ op: '<>', deviations: 2 }, { op: '<>', deviations: 3 }])
})

test('the editor\'s tiers round-trip through production\'s storage in every combination', () => {
  const w = { op: '>', threshold: 1 }
  const c = { op: '>=', threshold: 3 }
  for (const [warning, critical] of [[w, null], [null, c], [w, c]]) {
    for (const datasource of ['prometheus', 'vlogs']) {
      const stored = expressionsFor({ datasource, query: 'q', warning, critical, labels: { team: 'payments' } })
      const back = tiersOf({ ...stored, kind: 'static', datasource })
      assert.deepEqual([back.query, back.warning, back.critical], ['q', warning, critical], `${datasource} ${JSON.stringify([warning, critical])}`)
      assert.equal(stored.labels.team, 'payments', 'other tags kept')
    }
  }
})

test('severity=critical is set for a lone critical tier and removed otherwise', () => {
  assert.equal(expressionsFor({ query: 'q', critical: { op: '>', threshold: 3 } }).labels.severity, 'critical')
  const stale = { severity: 'critical', team: 'x' }
  assert.deepEqual(expressionsFor({ query: 'q', warning: { op: '>', threshold: 1 }, labels: stale }).labels, { team: 'x' })
  assert.deepEqual(expressionsFor({ query: 'q', warning: { op: '>', threshold: 1 }, critical: { op: '>', threshold: 3 }, labels: stale }).labels, { team: 'x' })
  assert.equal(expressionsFor({ query: 'q', labels: { severity: 'warning' } }).labels.severity, 'warning', 'a warning tag is the author\'s own')
})

// ---------- Truth ----------

test('each operator tests what it says, and no reading satisfies nothing', () => {
  const t = op => ({ op, threshold: 2 })
  assert.deepEqual(['>', '<', '>=', '<=', '==', '!='].map(op => [1, 2, 3].map(v => holds(t(op), v))), [
    [false, false, true], [true, false, false], [false, true, true], [true, true, false], [false, true, false], [true, false, true],
  ])
  for (const v of [null, undefined, NaN, Infinity]) assert.equal(holds(t('<'), v), false, String(v))
  assert.equal(holds(null, 5), false)
})

test('an anomaly tier tests the side it names', () => {
  const at = (op, v) => holdsAnomaly({ op, deviations: 2 }, v, 100, 5)
  assert.deepEqual([at('>', 111), at('>', 89), at('<', 89), at('<', 111), at('<>', 111), at('<>', 89), at('<>', 105)], [true, false, true, false, true, true, false])
})

// ---------- Time ----------

const run = (forSec, truth, to = 600) => stateIntervals({ from: 0, to, every: 60, forSec, holdsAt: truth })

test('with no wait, an alert fires on the first tick that holds and resolves on the first that does not', () => {
  assert.deepEqual(run(0, t => t >= 120 && t < 300), [{ state: 'firing', start: 120, end: 300 }])
})

test('an alert is pending until the condition has held for the wait, then fires', () => {
  assert.deepEqual(run(120, t => t >= 60), [
    { state: 'pending', start: 60, end: 180 },
    { state: 'firing', start: 180, end: null },
  ])
})

test('a breach shorter than the wait never fires', () => {
  assert.deepEqual(run(300, t => t >= 60 && t < 180), [{ state: 'pending', start: 60, end: 180 }])
})

test('a series that stops reporting resolves the alert', () => {
  assert.deepEqual(run(0, t => (t >= 300 ? null : t >= 60)), [{ state: 'firing', start: 60, end: 300 }])
})

test('a stretch already active when the run starts is marked: its true start is earlier', () => {
  const ivs = run(120, () => true, 300)
  assert.deepEqual(ivs, [
    { state: 'pending', start: 0, end: 120, openStart: true },
    { state: 'firing', start: 120, end: null, openStart: true },
  ])
})

test('tiers merge into the worst of what is active, handing over without gaps', () => {
  const merged = mergeTierIntervals([
    { severity: 'warning', intervals: [{ state: 'pending', start: 40, end: 100 }, { state: 'firing', start: 100, end: 400 }] },
    { severity: 'critical', intervals: [{ state: 'pending', start: 160, end: 200 }, { state: 'firing', start: 200, end: 300 }] },
  ])
  assert.deepEqual(merged, [
    { state: 'pending', severity: null, start: 40, end: 100 },
    { state: 'firing', severity: 'warning', start: 100, end: 200 },
    { state: 'firing', severity: 'critical', start: 200, end: 300 },
    { state: 'firing', severity: 'warning', start: 300, end: 400 },
  ])
  assert.deepEqual(mergeTierIntervals([{ severity: 'critical', intervals: [{ state: 'firing', start: 5, end: null }] }]), [{ state: 'firing', severity: 'critical', start: 5, end: null }])
  assert.deepEqual(mergeTierIntervals([]), [])
})

test('series that already carry their severity merge into one lane, worst on top', () => {
  const lane = mergeTierIntervals([
    { intervals: [{ state: 'firing', severity: 'warning', start: 0, end: 300 }] },
    { intervals: [{ state: 'firing', severity: 'critical', start: 100, end: 200 }, { state: 'pending', severity: null, start: 250, end: 400 }] },
  ])
  assert.deepEqual(lane, [
    { state: 'firing', severity: 'warning', start: 0, end: 100 },
    { state: 'firing', severity: 'critical', start: 100, end: 200 },
    { state: 'firing', severity: 'warning', start: 200, end: 300 },
    { state: 'pending', severity: null, start: 300, end: 400 },
  ])
})

// ---------- The editor's preview ----------

const series = vals => vals.map((value, i) => ({ t: i * 60, value }))

test('the backtest counts incidents and the share of the range spent firing', () => {
  const r = backtest(series([0, 5, 5, 0, 0, 5, 5, 5, 0, 0]), { warning: { op: '>', threshold: 1 } })
  assert.equal(r.incidents, 2)
  assert.equal(r.firingSec, 300)
  assert.equal(r.share, 0.5)
})

test('a warning running straight into a critical is one incident', () => {
  const r = backtest(series([0, 2, 5, 5, 2, 0]), { warning: { op: '>', threshold: 1 }, critical: { op: '>', threshold: 3 } })
  assert.equal(r.incidents, 1)
  assert.deepEqual(r.intervals.map(iv => iv.severity), ['warning', 'critical', 'warning'])
})

test('a threshold the series always crosses would fire the whole range; Fire after delays it', () => {
  assert.equal(backtest(series([3, 3, 3, 3]), { warning: { op: '>', threshold: 0.1 } }).share, 1)
  const waited = backtest(series([3, 3, 3, 3]), { warning: { op: '>', threshold: 0.1 }, forSec: 120 })
  assert.equal(waited.share, 0.5)
})

test('the suggested threshold is one the series rarely crosses, written the way a person would', () => {
  const vals = Array.from({ length: 101 }, (_, i) => 0.17 + i * 0.0026) // 0.17 → 0.43, like production's demo rule
  assert.equal(suggestThreshold(vals, '>'), 0.5)
  assert.equal(suggestThreshold([10, 20, 30, 40, 50], '<'), 10)
  assert.equal(suggestThreshold(vals, '=='), null)
  assert.equal(suggestThreshold([], '>'), null)
})
