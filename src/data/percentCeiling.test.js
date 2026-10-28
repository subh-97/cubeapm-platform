// A utilisation percentage reads no more than 100, and keeping it there must
// not move a figure the reference hour publishes.
//
// Nothing in a profile's shape stops a CPU at 100. ip-10-0-142-133 publishes
// 92.4% for the hour, and its 1.4 peak drew the outage at 112–121%. The
// Infrastructure Correlation table's quiet ratio put the same host at 140%.
// `ceilingPeak` is the fix, and these tests pin what it promises: under 100
// everywhere, the published hour unmoved, and the outage still plain to see on
// the hosts it pegs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  REFERENCE_WINDOW, INCIDENT_START_MIN, INCIDENT_RAMP_MIN, resolveWindow, pinToReference, windowMean,
} from './timeWindow.js'
import { ceilingPeak, PERCENT_CEILING } from './percentCeiling.js'
import { infraHostsForWindow, k8sNodesForWindow } from './observability.js'
import { infraCorrelationForWindow, infraSeriesForWindow } from './services.js'

const PRESETS = ['5m', '15m', '30m', '1h', '3h', '6h', '12h', '24h', '2d', '7d', 'today']
const windowOf = v => (v === '1h' ? REFERENCE_WINDOW : resolveWindow({ kind: 'preset', value: v }))

test('ceilingPeak puts the jitter\'s top on the ceiling and keeps the hour on its figure', () => {
  for (const [published, noise] of [[92.4, 0.01], [87.5, 0.12], [88, 0.06]]) {
    const peak = ceilingPeak(published, { noise, seed: 7 })
    const p = pinToReference({ baseline: published, peak, noise, seed: 7 }, windowMean, published)
    assert.ok(Math.abs(windowMean(REFERENCE_WINDOW, p) - published) < 1e-9, `${published}: the hour still averages to the figure`)
    assert.ok(Math.abs(p.baseline * p.peak * (1 + noise / 2) - PERCENT_CEILING) < 1e-9, `${published}: the plateau's jitter tops out at the ceiling`)
    assert.ok(peak > 1, `${published}: there is still an incident to see`)
  }
  // The plateau only ever approaches published / lift, about three times the
  // figure, so a quiet host's peak can be anything.
  assert.equal(ceilingPeak(26.2, { noise: 0.12, seed: 7 }), Infinity)
})

test('the reference hour still reads the figures the host and node tables publish', () => {
  const hosts = new Map(infraHostsForWindow(REFERENCE_WINDOW).map(h => [h.host, h]))
  for (const [host, cpu, mem] of [['ip-10-0-142-133', 92.4, 88.2], ['ip-10-0-142-2', 89.1, 84.4], ['ip-10-0-143-40', 87.5, 86.7]]) {
    assert.equal(hosts.get(host).cpu, cpu, `${host} CPU %`)
    assert.equal(hosts.get(host).mem, mem, `${host} memory %`)
  }
  const nodes = new Map(k8sNodesForWindow(REFERENCE_WINDOW).map(n => [n.name, n]))
  for (const [node, cpu, mem] of [['ip-10-0-142-133', 92.4, 88.2], ['ip-10-0-143-40', 87.5, 86.7]]) {
    assert.equal(nodes.get(node).cpu, cpu, `node ${node} CPU Used %`)
    assert.equal(nodes.get(node).mem, mem, `node ${node} memory %`)
  }
})

test('no CPU, memory or disk percentage reads over 100, in a table or on a chart, on any range', () => {
  for (const v of PRESETS) {
    const win = windowOf(v)
    const readings = [
      ...infraHostsForWindow(win).flatMap(h => ['cpu', 'mem', 'disk'].map(k => [`host ${h.host} ${k}`, h[k], h[`${k}Series`]])),
      ...k8sNodesForWindow(win).flatMap(n => ['cpu', 'mem', 'disk'].map(k => [`node ${n.name} ${k}`, n[k], n[`${k}Series`]])),
      ...infraCorrelationForWindow(win).flatMap(c => ['cpuUsedPct', 'memUsedPct']
        .map(k => [`correlation ${c.host} ${k}`, c[k], infraSeriesForWindow(win, c.host, k)])),
    ]
    for (const [name, figure, series] of readings) {
      assert.ok(figure <= 100, `${v} ${name}: the table reads ${figure}`)
      for (const p of series) if (p.value != null) assert.ok(p.value <= 100, `${v} ${name}: the chart reads ${p.value}`)
    }
  }
})

test('a host the incident pegs still shows the outage, clear of the lines its CPU alert is drawn at', () => {
  // Rule 515 in data/alerts.js warns over 90 and pages over 95. A hot host's
  // quiet line has to stay under the first, and its plateau over the second,
  // or the alert warns on noise all week, or drops out of critical mid-outage.
  const hot = infraHostsForWindow(REFERENCE_WINDOW).filter(h => h.status === 'critical')
  assert.equal(hot.length, 3)
  for (const h of hot) {
    // A bucket is `m` minutes back at its start and one minute long.
    const quiet = h.cpuSeries.filter(p => p.m - 1 >= INCIDENT_START_MIN).map(p => p.value)
    const plateau = h.cpuSeries.filter(p => p.m <= INCIDENT_START_MIN - INCIDENT_RAMP_MIN).map(p => p.value)
    assert.ok(quiet.length >= 30 && plateau.length >= 15, `${h.host}: ${quiet.length} quiet buckets, ${plateau.length} on the plateau`)
    assert.ok(Math.max(...quiet) < 90, `${h.host}: quiet CPU reaches ${Math.max(...quiet)}`)
    assert.ok(Math.min(...plateau) > 95, `${h.host}: the plateau dips to ${Math.min(...plateau)}`)
    assert.ok(Math.max(...plateau) <= 100, `${h.host}: the plateau reaches ${Math.max(...plateau)}`)
    assert.ok(Math.min(...plateau) - Math.max(...quiet) > 5, `${h.host}: the outage stands clear of the quiet line`)
  }
})
