// The Alerts data module (docs/alerts/DESIGN.md D15). Pinned the way the other
// data modules are: the reference hour, a quiet window, and the ends of a wide
// one — plus the one property this module adds, that the timeline, the
// notification log and the noise report are read off one history and agree.
//
// The incident is fixed: payment-service's Redis pool fails 22 minutes before
// BASE_TIME, ramping over four (timeWindow.js). Every expectation below is a
// consequence of that and of services.js' published figures, not a number
// written down here.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveWindow, BASE_TIME } from './timeWindow'
import {
  alertsSeed, ruleDefsFor, evaluateRules, ruleHistory, ruleTimelineForWindow, notificationLogForWindow,
  alertStatsForWindow, ruleSeriesForWindow, sloRules, bindingFor, previewRule, ALERTS_NOW, HORIZON_SEC, SEED_VERSION,
} from './alerts'
import { engineCacheSize, clearEngineCache, NEEDS_CLOSING_PIPE } from './alertsEngine'
import { tiersOf } from '@/utils/alerts/condition'

const NOW = Math.floor(BASE_TIME.getTime() / 1000)
const state = alertsSeed()
const defs = ruleDefsFor(state)
const rules = evaluateRules(defs, state)
const byId = new Map(rules.map(r => [r.id, r]))
const HOUR = resolveWindow({ kind: 'preset', value: '1h' })
const WEEK = resolveWindow({ kind: 'preset', value: '7d' })

const worst = r => {
  if (r.status === 'PAUSED') return 'paused'
  if (r.health !== 'ok') return 'error'
  if (r.seriesCount === 0) return 'nodata'
  if (r.state === 'inactive') return 'ok'
  if (r.state === 'pending') return 'pending'
  return (r.alerts ?? []).some(a => a.state === 'firing' && a.labels.severity === 'critical') ? 'critical' : 'warning'
}

// ---------- The seed ----------

test('the seed is production-shaped, and production\'s own rules keep their ids', () => {
  const demo = state.rules.find(r => r.id === 437)
  assert.equal(demo.name, 'Payment error rate high (POST /v1/payments)')
  assert.deepEqual(demo.config, { model: null, receiver_group_ids: [7], mute_group_ids: [] })
  assert.match(demo.query, /^\(sum\(increase\(\(cube_apm_calls_total\{env="UNSET",service="payment-service"/)
  for (const id of [426, 427, 428, 432, 433]) assert.ok(state.rules.some(r => r.id === id), `synthetic rule ${id}`)
  assert.equal(state.rules.find(r => r.id === 426).query, 'max(cube_synthetic_monitor{id="15"}) by (id, group, name) == 0', 'stored verbatim')
  assert.equal(state.receiverGroups.find(g => g.id === 7).name, 'Payments on-call (demo)')
  for (const r of state.rules) {
    for (const key of ['id', 'name', 'datasource', 'kind', 'query', 'query2', 'interval', 'duration', 'repeatInterval', 'groupingDisable', 'labels', 'annotations', 'config', 'receiver', 'mute', 'status', 'permission', 'readonly']) {
      assert.ok(key in r, `${r.id} has ${key}`)
    }
    assert.ok(!('state' in r) && !('alerts' in r), `${r.id}: a seed rule carries no evaluated state`)
  }
  assert.ok(SEED_VERSION)
})

test('each call is a fresh copy: one store\'s edits cannot leak into another\'s', () => {
  const a = alertsSeed()
  a.rules[0].name = 'changed'
  a.receiverGroups.pop()
  assert.notEqual(alertsSeed().rules[0].name, 'changed')
  assert.equal(alertsSeed().receiverGroups.length, state.receiverGroups.length)
})

test('Quick rules store exactly the query production\'s editor would generate', () => {
  const r = state.rules.find(x => x.id === 502)
  assert.equal(tiersOf(r).query, 'histogram_quantile(0.9, sum(increase(cube_apm_latency_bucket{service="payment-service", span_kind=~"server|consumer"} default 0)) by (vmrange)) * 1000')
  assert.deepEqual([tiersOf(r).warning, tiersOf(r).critical], [{ op: '>', threshold: 150 }, { op: '>', threshold: 300 }])
})

// ---------- Now: the reference hour ----------

test('twenty-odd minutes into the incident, every state is on show and where it should be', () => {
  const at = Object.fromEntries(rules.map(r => [r.id, worst(r)]))
  assert.equal(at[501], 'critical', 'payment-service error rate: 14% against 3%')
  assert.equal(at[502], 'critical', 'payment-service p90: 612 ms against 300')
  assert.equal(at[514], 'critical', 'redis.0 memory: the pool exhaustion')
  assert.equal(at[515], 'critical', 'the payment and shipment hosts\' CPU')
  assert.equal(at[9011], 'critical', 'the payment SLO\'s fast burn')
  assert.equal(at[437], 'warning', 'production\'s demo rule has no severity label, so it reads Warning (Q2)')
  assert.equal(at[505], 'warning', 'order-service p90: 188 ms, warning but not critical')
  assert.equal(at[506], 'warning', 'order-service errors: 1.4%')
  assert.equal(at[507], 'warning', 'shipment-service p90: 165 ms')
  assert.equal(at[508], 'warning', 'notify-service, chronically')
  assert.equal(at[504], 'warning', 'the log stream\'s error records')
  assert.equal(at[9012], 'warning', 'the payment SLO\'s slow burn')
  assert.equal(at[503], 'pending', 'thirty minutes\' wait, twenty-odd minutes in')
  assert.equal(at[510], 'ok', 'search-service traffic is as expected')
  assert.equal(at[511], 'ok')
  assert.equal(at[426], 'ok', 'Docs answers')
  assert.equal(at[512], 'nodata', 'billing-legacy reports nothing')
  assert.equal(at[513], 'error', 'the many-to-many join')
  for (const id of [427, 428, 432, 433]) assert.equal(at[id], 'paused')
})

test('a rule that cannot evaluate says why; a paused one was never evaluated', () => {
  assert.equal(byId.get(513).health, 'err')
  assert.match(byId.get(513).lastError, /many-to-many matching not allowed/)
  assert.equal(byId.get(427).lastEvaluation, '0001-01-01T00:00:00Z', 'production\'s value for never')
  assert.equal(byId.get(501).health, 'ok')
})

test('the incident\'s alerts started on its ramp and fire after their wait', () => {
  const crit = byId.get(501).alerts.find(a => a.labels.severity === 'critical')
  const active = Date.parse(crit.activeAt) / 1000
  assert.ok(NOW - active > 20 * 60 && NOW - active <= 22 * 60, `active ${(NOW - active) / 60} min ago, on the 22→18 min ramp`)
  assert.equal(crit.firingAt - active, 300, 'pending for exactly the five-minute wait')
  assert.equal(crit.state, 'firing')
  const pending = byId.get(503).alerts[0]
  assert.equal(pending.state, 'pending')
  assert.equal(pending.firingAt, null)
})

test('alerts are production-shaped: one per series per tier, the critical one tagged', () => {
  const r = byId.get(501)
  assert.deepEqual(r.alerts.map(a => a.labels.severity ?? null).sort(), ['critical', null].sort())
  for (const a of r.alerts) {
    assert.equal(a.rule_id, '501')
    assert.equal(a.labels.alertname, 'payment-service error rate')
    assert.match(a.id, /^\d+$/)
    assert.equal(a.source, `/alerts/501?alert_id=${a.id}`)
    assert.ok(Number(a.value) > 3)
  }
  assert.equal(new Set(rules.flatMap(x => (x.alerts ?? []).map(a => a.id))).size, rules.flatMap(x => x.alerts ?? []).length, 'alert ids are unique')
})

test('a templated name renders per series: one CPU alert per breaching host, named for it', () => {
  const cpu = byId.get(515)
  const hosts = [...new Set(cpu.alerts.map(a => a.labels['host.name']))].sort()
  assert.deepEqual(hosts, ['ip-10-0-142-133', 'ip-10-0-142-2', 'ip-10-0-143-40'])
  assert.ok(cpu.alerts.every(a => a.name === `CPU high on ${a.labels['host.name']}`))
  assert.ok(cpu.seriesCount > 50, 'every host is a series; only the incident\'s breach')
})

// ---------- The window ----------

test('the timeline, the log and the noise report agree about the same window', () => {
  for (const win of [HOUR, WEEK]) {
    const timeline = ruleTimelineForWindow(win, defs, state)
    const log = notificationLogForWindow(win, defs, state)
    const stats = alertStatsForWindow(win, defs, state)
    for (const entry of timeline) {
      const st = stats.find(s => s.ruleId === entry.ruleId)
      const firing = entry.intervals.filter(iv => iv.state === 'firing')
      const to = Math.min(win.end, NOW)
      const secs = firing.reduce((a, iv) => a + Math.min(iv.end ?? NOW, to) - Math.max(iv.start, win.start), 0)
      assert.ok(Math.abs(secs - st.firingSec) <= 1, `${entry.ruleId}: timeline ${secs}s vs stats ${st.firingSec}s`)
      const sends = new Set(log.filter(r => r.rule_id === entry.ruleId && (r.status === 'SUCCESS' || r.status === 'ERROR')).map(r => Date.parse(r.created_at) / 1000))
      assert.deepEqual(entry.notifications, [...sends].sort((a, b) => a - b), `${entry.ruleId}: ticks are the sends`)
    }
  }
})

test('the reference hour\'s log: fired, reminded, snoozed, muted and failed, each saying why', () => {
  const log = notificationLogForWindow(HOUR, defs, state)
  assert.ok(log.length > 0)
  for (let i = 1; i < log.length; i++) assert.ok(log[i - 1].created_at >= log[i].created_at, 'newest first')
  const fired = log.filter(r => r.rule_id === 501 && r.event === 'fired')
  assert.ok(fired.some(r => r.receiver_type === 'slack') && fired.some(r => r.receiver_type === 'pagerduty'), 'both of Payments on-call\'s receivers')
  assert.ok(log.some(r => r.rule_id === 507 && r.status === 'SNOOZE' && /fulfilment-oncall/.test(r.details)), 'shipment\'s snooze holds its sends')
  assert.ok(log.some(r => r.rule_id === 505 && r.status === 'MUTE' && /Daily deploy window/.test(r.details)), 'order-service\'s deploy window holds its sends')
  const broken = log.filter(r => r.status === 'ERROR')
  assert.ok(broken.length > 0 && broken.every(r => r.receiver_type === 'webhook' && /503/.test(r.details)), 'Infra paging\'s webhook fails, and says how')
  assert.ok(!log.some(r => [427, 428, 432, 433, 512, 513].includes(r.rule_id)), 'paused, empty and broken rules send nothing')
  for (const r of log) for (const k of ['id', 'rule_id', 'rule_name', 'receiver_type', 'receiver_data', 'status', 'details', 'created_at']) assert.ok(k in r, k)
})

test('a resolved notification goes only to receivers that send them', () => {
  const log = notificationLogForWindow(WEEK, defs, state)
  const resolved = log.filter(r => r.event === 'resolved')
  assert.ok(resolved.length > 0)
  assert.ok(resolved.every(r => r.receiver_data?.send_resolved !== false))
})

test('the noise report flags the chronic rule and the flapping one, and nothing on the incident\'s path', () => {
  const stats = new Map(alertStatsForWindow(WEEK, defs, state).map(s => [s.ruleId, s]))
  assert.equal(stats.get(508).flags.alwaysFiring, true, 'notify-service fires above 60 ms all week')
  assert.ok(stats.get(508).firingPct > 95)
  assert.equal(stats.get(509).flags.flapping, true, 'search-service p90 crosses its threshold all day')
  assert.equal(stats.get(501).flags.alwaysFiring, false)
  assert.equal(stats.get(501).incidents, 1, 'one incident: the payment pool, still open')
  assert.equal(stats.get(511).flags.neverFired, true, 'a week with nothing is worth saying')
  assert.equal(stats.get(427).flags.neverFired, false, 'a paused rule is not "never fired"')
})

test('a quiet absolute window, before the incident, fires nothing on its path', () => {
  const quiet = resolveWindow({ kind: 'absolute', from: (NOW - 6 * 3600) * 1000, to: (NOW - 3 * 3600) * 1000 })
  const timeline = new Map(ruleTimelineForWindow(quiet, defs, state).map(t => [t.ruleId, t]))
  for (const id of [501, 502, 503, 505, 506, 507, 514, 515, 9011, 437]) {
    assert.deepEqual(timeline.get(id).intervals.filter(iv => iv.state === 'firing'), [], `rule ${id} is quiet three hours before`)
  }
  assert.ok(timeline.get(508).intervals.length > 0, 'the chronic rule fires anyway')
})

test('a wide window\'s far end reaches the horizon, and its near end is now', () => {
  const tl = ruleTimelineForWindow(WEEK, defs, state).find(t => t.ruleId === 508)
  assert.equal(tl.intervals[0].openStart, true, 'firing since before the horizon: its start is not known')
  assert.equal(tl.intervals[tl.intervals.length - 1].end, null, 'still firing now')
  assert.ok(ALERTS_NOW - ruleHistory(defs.find(d => d.id === 508), state).from <= HORIZON_SEC)
})

test('suppressions are drawn where they held: the snooze now, the deploy window, the old snooze', () => {
  const week = new Map(ruleTimelineForWindow(WEEK, defs, state).map(t => [t.ruleId, t]))
  const snooze = week.get(507).suppressed.find(s => s.kind === 'snooze')
  assert.ok(snooze && snooze.end === null && snooze.until > NOW, 'still in force')
  assert.ok(week.get(505).suppressed.some(s => s.kind === 'mute' && s.name === 'Daily deploy window'))
  assert.ok(week.get(508).suppressed.some(s => s.kind === 'snooze' && s.end != null && s.end < NOW), 'an expired snooze is history, not gone')
  assert.ok(week.get(509).suppressed.filter(s => s.kind === 'mute').length >= 6, 'quiet hours, nightly')
})

// ---------- Series for charts ----------

test('a rule\'s chart is what its evaluator read: the newest point is the value its state was decided on', () => {
  for (const win of [HOUR, WEEK]) {
    for (const def of defs) {
      const h = ruleHistory(def, state)
      if (h.error || h.paused) continue
      const drawn = new Map(ruleSeriesForWindow(win, def, state).map(s => [s.key, s.points.at(-1).value]))
      for (const s of h.series) {
        assert.equal(drawn.get(s.key), Number.isFinite(s.value) ? Math.round(s.value * 1e8) / 1e8 : null, `${def.id} ${s.key || '(one series)'} over ${win.label}`)
      }
      for (const a of byId.get(def.id).alerts ?? []) {
        assert.ok([...drawn.values()].includes(Number(a.value)), `${def.id}: an alert's value is a point on its chart`)
      }
    }
  }
  const r501 = defs.find(d => d.id === 501)
  assert.ok(ruleSeriesForWindow(WEEK, r501, state)[0].points.at(-1).value > tiersOf(r501).critical.threshold,
    'a week-wide chart does not average a firing rule back under the threshold it fires over')
  const fiveMinute = ruleSeriesForWindow(HOUR, defs.find(d => d.id === 504), state)[0].points
  const changes = fiveMinute.slice(1).filter((p, i) => p.value !== fiveMinute[i].value).length
  assert.ok(changes <= 12, `a 5-minute rule reads every five minutes, not every bucket: ${changes} changes in an hour`)
})

test('a rule\'s chart draws the same profile the service page does', () => {
  const r = defs.find(d => d.id === 502)
  const [s] = ruleSeriesForWindow(HOUR, r, state)
  assert.equal(s.points.length, HOUR.buckets.length)
  const last = s.points.filter(p => p.value != null).pop()
  assert.ok(last.value > 500, `p90 at the plateau, ${last.value} ms`)
  const anomaly = ruleSeriesForWindow(HOUR, defs.find(d => d.id === 510), state)[0].points.find(p => p.value != null)
  assert.ok(anomaly.expected > 0 && anomaly.sigma > 0, 'an anomaly rule\'s points carry its band')
  assert.deepEqual(ruleSeriesForWindow(HOUR, defs.find(d => d.id === 513), state), [], 'nothing to draw for a broken query')
})

// ---------- The editor's preview ----------

const clipped = (ivs, win) => ivs
  .filter(iv => iv.end == null || iv.end > win.start)
  .map(iv => [iv.state, iv.severity ?? null, Math.max(iv.start, win.start), iv.end])

test('a clone reads what its original reads: a seeded query binds under any id', () => {
  for (const id of [437, 504, 513, 514, 515]) {
    const def = defs.find(d => d.id === id)
    const clone = { ...def, id: 2001, name: `Copy of ${def.name}` }
    assert.deepEqual(bindingFor(clone, state).error, bindingFor(def, state).error, `${id}`)
    assert.deepEqual(
      ruleSeriesForWindow(HOUR, clone, state).map(x => x.points.at(-1).value),
      ruleSeriesForWindow(HOUR, def, state).map(x => x.points.at(-1).value), `${id}`)
  }
})

test('no seeded rule needs the engine, so the list costs nothing more to load', () => {
  clearEngineCache()
  for (const def of defs) bindingFor(def, state)
  assert.equal(engineCacheSize(), 0)
})

test('the preview is the saved rule\'s history over the window, at any range', () => {
  for (const win of [HOUR, WEEK]) {
    for (const id of [501, 502, 503, 508, 509, 515, 9011, 9012]) {
      const def = defs.find(d => d.id === id)
      assert.deepEqual(clipped(previewRule(def, win, state).lane, win), clipped(ruleHistory(def, state).intervals, win), `${id} over ${win.label}`)
    }
  }
  const pay = previewRule(defs.find(d => d.id === 501), HOUR, state)
  assert.equal(pay.incidents, 1)
  assert.ok(pay.share > 0.15 && pay.share < 0.4, `fired for the incident's part of the hour: ${pay.share}`)
  assert.equal(pay.suggestion, null, 'a rule that fires a quarter of the time gets no suggestion')
  const chronic = previewRule(defs.find(d => d.id === 508), WEEK, state)
  assert.ok(chronic.share > 0.9, `notify-service fires all week: ${chronic.share}`)
  assert.ok(chronic.suggestion > tiersOf(defs.find(d => d.id === 508)).warning.threshold, 'and is offered a threshold above where it sits')
})

test('a query no profile describes is previewed, and saved, through the engine', () => {
  const query = 'sum(increase(cube_apm_calls_total{service="payment-service", span_kind=~"server|consumer", status_code="ERROR"}[1m])) * 100 / sum(increase(cube_apm_calls_total{service="payment-service", span_kind=~"server|consumer"}[1m]))'
  const draft = {
    id: 2002, name: 'typed in Code', datasource: 'prometheus', kind: 'static', status: 'ACTIVE', interval: 60, duration: 120,
    query: `(${query}) > 1`, query2: `(${query}) > 3`, labels: { group: 'Payments' }, config: {},
  }
  const p = previewRule(draft, HOUR, state)
  assert.equal(p.error, null)
  assert.equal(p.series.length, 1)
  assert.ok(p.lane.some(iv => iv.state === 'firing' && iv.severity === 'critical'), 'it fires critical in the incident')
  assert.deepEqual(clipped(p.lane, HOUR), clipped(ruleHistory(draft, state).intervals, HOUR), 'and saving it changes nothing the preview showed')
  const logs = previewRule({ ...draft, id: 2003, datasource: 'vlogs', query: 'error as result | filter result: > 5', query2: '' }, HOUR, state)
  assert.equal(logs.error, NEEDS_CLOSING_PIPE)
  assert.deepEqual(logs.series, [])
})

test('rules SLOs generate are read-only, paired fast and slow, and follow the SLO\'s switch', () => {
  const gen = sloRules(state.slos)
  assert.deepEqual(gen.map(r => [r.id, r.labels.speed, r.labels.severity ?? null, r.readonly]), [[9011, 'fast', 'critical', true], [9012, 'slow', null, true]])
  assert.deepEqual(sloRules(state.slos.map(s => ({ ...s, alertsEnabled: false }))), [])
})

test('a rule the editor makes from a service card binds to that service', () => {
  const made = { id: 9999, datasource: 'prometheus', kind: 'static', query: '(x) > 1', query2: '', status: 'ACTIVE', interval: 60, duration: 0, labels: {}, config: { model: { type: 'quick', calculate: 'error_percentage', value: '90', labelPairs: [{ label: 'service', operator: '=', values: ['order-service'] }], groupBy: [] } } }
  assert.equal(bindingFor(made, state).series.length, 1)
  const byService = { ...made, config: { model: { ...made.config.model, labelPairs: [], groupBy: ['service'] } } }
  assert.equal(bindingFor(byService, state).series.length, 7, 'grouped by service: one series each')
  const unknown = { ...made, config: { model: null }, query: '(made_up_metric) > 1' }
  assert.deepEqual(bindingFor(unknown, state), { series: [] })
})
