// What the time picker is allowed to change, and what it must not.
//
// The risk this guards is specific: the mock layer is generated, so a plausible
// looking refactor can quietly move every number on the product at once. These
// tests pin the two ends of that — the default range still reads what it has
// always read, and a window that does not contain the incident does not report
// one.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BASE_TIME, REFERENCE_WINDOW, resolveWindow, incidentWeight, incidentWeightOver,
  windowMean, windowSeries, INCIDENT_START_MIN,
} from './timeWindow.js'
import {
  servicesForWindow, redEndpointsForWindow, externalEndpointsForWindow, dbEndpointsForWindow,
  infraCorrelationForWindow, latencyDrilldownForWindow, latencyDrilldownSeriesForWindow,
  latencyDrilldownTotalForWindow, slowRequestsForWindow, errorRequestsForWindow, healthHistoryForWindow,
  externalEndpointSeriesForWindow, dbEndpointSeriesForWindow, externalEndpointCallers, dbEndpointCallers,
  redEndpoints, externalEndpoints, dbEndpoints, infraCorrelation, latencyDrilldown,
  slowRequests, errorRequests,
} from './services.js'
import { logVolumeForWindow, logTotalsForWindow, infraHostsForWindow } from './observability.js'

const preset = v => resolveWindow({ kind: 'preset', value: v })
const payment = win => servicesForWindow(win).find(s => s.id === 'payment-service')

// The figures in RAW_SERVICES are what Last 1 hour averages to. Everything else
// in this module is calibrated against them, so if this drifts the whole
// product has moved.
test('the default hour still reports the published figures', () => {
  const p = payment(REFERENCE_WINDOW)
  assert.equal(p.latencyP90, 612)
  assert.equal(p.errorRatePct, 4.8)
  assert.equal(Math.round(p.rpm), 453)
  assert.equal(p.status, 'critical')
})

test('Last 1 hour resolves to the hour of minute buckets the charts expect', () => {
  assert.equal(REFERENCE_WINDOW.step, 60)
  assert.equal(REFERENCE_WINDOW.buckets.length, 60)
  assert.equal(REFERENCE_WINDOW.buckets.at(-1).label, 'now')
  // The oldest label is -59m or -60m depending on how far the end floored back
  // from the current second; what matters is that it is relative at all.
  assert.match(REFERENCE_WINDOW.buckets[0].label, /^-(59|60)m$/)
})

// The point of the feature. A percentile falls off a cliff because it is a
// percentile; a rate fades because it is a mean. Both are the window telling
// the truth about a 22-minute incident.
//
// Only the ends are pinned. In between, p90 turns over wherever the incident's
// share of requests crosses 10%, and exactly where that lands depends on how
// the window's buckets happen to sit against the incident — so asserting a
// value at, say, three hours would be asserting the time of day.
test('widening the window dilutes the incident', () => {
  const p90 = v => payment(preset(v)).latencyP90
  const err = v => payment(preset(v)).errorRatePct

  assert.ok(p90('5m') >= 600, 'five minutes is all incident')
  assert.ok(p90('2h') > 300, 'two hours is still a sixth incident, which p90 sits inside')
  assert.ok(p90('24h') < 200, 'a day of requests buries twenty minutes of slow ones')
  assert.ok(p90('7d') < 200, 'and a week buries them completely')

  const rates = ['5m', '1h', '6h', '24h', '7d'].map(err)
  for (let i = 1; i < rates.length; i++) {
    assert.ok(rates[i] <= rates[i - 1], `error rate should not rise as the window widens: ${rates}`)
  }
})

// Status answers "did this breach", not "what did this average to". The two
// readings diverge on any range wide enough to dilute a 22-minute outage, and
// both are reported — the badge from the first, the figures from the second.
test('a service that broke in the window stays critical however wide it is', () => {
  for (const v of ['5m', '15m', '1h', '3h', '6h', '24h', '2d', '7d', 'today']) {
    assert.equal(payment(preset(v)).status, 'critical',
      `${v}: payment-service breached and should say so`)
  }
  // And the figures beside it stay honest rather than being floored to match.
  assert.equal(payment(preset('1h')).aggregateStatus, 'critical')
  assert.equal(payment(preset('7d')).aggregateStatus, 'healthy')
  assert.ok(payment(preset('7d')).latencyP90 < 200, 'the published p90 is still the window average')
})

test('a window that never contained the incident reports no breach', () => {
  const now = BASE_TIME.getTime()
  const before = resolveWindow({
    kind: 'absolute',
    from: now - 180 * 60000,
    to: now - (INCIDENT_START_MIN + 15) * 60000,
  })
  const p = servicesForWindow(before).find(s => s.id === 'payment-service')
  assert.equal(p.status, 'healthy', 'nothing broke in that window, so nothing is red')
  assert.equal(p.aggregateStatus, 'healthy')
})

test('the breach is reported with the numbers that justify it', () => {
  const p = payment(preset('7d'))
  assert.ok(p.peakLatencyP90 > 500, `peak p90 should carry the incident, got ${p.peakLatencyP90}`)
  assert.ok(p.peakErrorRatePct > 3, `peak error rate should carry the incident, got ${p.peakErrorRatePct}`)
  // The pair the UI shows side by side: averaged fine, peaked badly.
  assert.ok(p.latencyP90 < p.peakLatencyP90 / 3)
})

test('services stay sorted worst-first at every range', () => {
  const rank = { healthy: 0, warning: 1, critical: 2 }
  for (const v of ['5m', '1h', '6h', '7d']) {
    const list = servicesForWindow(preset(v))
    for (let i = 1; i < list.length; i++) {
      assert.ok(rank[list[i - 1].status] >= rank[list[i].status],
        `${v}: ${list[i - 1].id} (${list[i - 1].status}) sorted above ${list[i].id} (${list[i].status})`)
    }
  }
})

// The bug this replaces: the incident was measured from the window's end, so
// ANY window reported an outage in its own final minutes.
test('a window that ends before the incident does not contain it', () => {
  const now = BASE_TIME.getTime()
  const before = resolveWindow({
    kind: 'absolute',
    from: now - 180 * 60000,
    to: now - (INCIDENT_START_MIN + 15) * 60000,
  })
  const p = payment(before)
  assert.ok(p.latencyP90 < 200, `quiet window should be quiet, got ${p.latencyP90}ms`)
  assert.ok(p.errorRatePct < 0.5, `quiet window should be quiet, got ${p.errorRatePct}%`)
  assert.equal(p.status, 'healthy')
  assert.equal(p.aggregateStatus, 'healthy')

  const during = resolveWindow({ kind: 'absolute', from: now - 20 * 60000, to: now })
  assert.ok(payment(during).latencyP90 > 500, 'a window inside the incident sees it')
})

test('the incident is averaged across a bucket, not sampled at its edge', () => {
  // A five-minute bucket whose oldest edge is just outside the incident is
  // still mostly inside it.
  const edge = INCIDENT_START_MIN + 2
  assert.equal(incidentWeight(edge), 0)
  assert.ok(incidentWeightOver(edge, 5) > 0.2, 'most of that bucket was during the incident')
  // And a bucket wider than the whole incident carries its share, not its peak.
  const wide = incidentWeightOver(180, 180)
  assert.ok(wide > 0.1 && wide < 0.13, `a three-hour bucket is ~11% incident, got ${wide}`)
})

test('every bucket in a window carries a distinct label', () => {
  // The volume chart's drag-to-zoom looks buckets up by label, so a collision
  // silently zooms to the wrong place.
  for (const v of ['5m', '15m', '30m', '1h', '6h', '24h', '2d', '7d', 'today']) {
    const win = preset(v)
    const labels = new Set(win.buckets.map(b => b.label))
    assert.equal(labels.size, win.buckets.length, `${v} has duplicate bucket labels`)
  }
})

test('Today starts at local midnight and leaves the rest of the day empty', () => {
  const win = preset('today')
  const first = new Date(win.buckets[0].ms)
  assert.equal(first.getHours(), 0)
  assert.equal(first.getMinutes(), 0)

  assert.ok(win.pastBuckets.length < win.buckets.length, 'part of today has not happened')
  const series = windowSeries(win, { baseline: 100 })
  assert.ok(series.some(d => d.value === null), 'future buckets draw nothing')

  const vol = logVolumeForWindow(win)
  assert.ok(vol.at(-1).total === 0, 'the last bar of today is empty')

  // And the future must not drag the aggregate down.
  const mean = windowMean(win, { baseline: 100 })
  assert.ok(Math.abs(mean - 100) < 1, `future buckets leaked into the mean: ${mean}`)
})

test('volume scales with the window rather than being resliced from one hour', () => {
  const hour = logTotalsForWindow(preset('1h')).total
  const day = logTotalsForWindow(preset('24h')).total
  assert.ok(day > hour * 15, `a day should hold far more than an hour: ${day} vs ${hour}`)
})

// Every derived table is a profile that gets PINNED with one aggregate and READ
// with another, and getting the pair out of step is silent: the shape of the
// curve stays plausible and only the numbers are wrong. It has already happened
// twice — a p90 pinned as a mean read 2.6x high, a slow request pinned as a
// percentile and read as a mean read 2.1x low — so the reference hour
// reproducing every published figure is checked table by table.
test('the reference hour reproduces every derived table exactly', () => {
  const w = REFERENCE_WINDOW
  const check = (name, got, want, keys) => {
    assert.equal(got.length, want.length, `${name}: row count`)
    got.forEach((g, i) => {
      for (const k of keys) {
        assert.equal(g[k], want[i][k], `${name}[${i}].${k} drifted from the published figure`)
      }
    })
  }

  check('redEndpoints', redEndpointsForWindow(w), redEndpoints, ['endpoint', 'rpm', 'p90', 'avg', 'errPct', 'totalReq'])
  check('externalEndpoints', externalEndpointsForWindow(w), externalEndpoints, ['endpoint', 'rpm', 'p90', 'avg', 'errPct'])
  check('dbEndpoints', dbEndpointsForWindow(w), dbEndpoints, ['endpoint', 'rpm', 'p90', 'avg', 'errPct'])
  check('infraCorrelation', infraCorrelationForWindow(w), infraCorrelation, ['host', 'rpm', 'latencyP90', 'errorRatePct', 'cpuUsedPct', 'memUsedPct'])
  check('latencyDrilldown', latencyDrilldownForWindow(w), latencyDrilldown, ['label', 'ms'])
  check('slowRequests', slowRequestsForWindow(w), slowRequests, ['traceId', 'latencyMs', 'timestamp'])
  check('errorRequests', errorRequestsForWindow(w), errorRequests, ['traceId', 'latencyMs', 'timestamp'])
})

test('derived tables dilute with the window, and counts grow instead', () => {
  const day = resolveWindow({ kind: 'preset', value: '24h' })
  const hour = REFERENCE_WINDOW

  const redHour = redEndpointsForWindow(hour)[0]
  const redDay = redEndpointsForWindow(day)[0]
  assert.ok(redDay.p90 < redHour.p90 / 2, `endpoint p90 should fall: ${redHour.p90} → ${redDay.p90}`)
  assert.ok(redDay.errPct < redHour.errPct, 'endpoint error rate should fall')
  // A count is the one figure that goes the other way.
  const reqs = t => Number(String(t).replace('K', '')) * (String(t).includes('K') ? 1000 : 1)
  assert.ok(reqs(redDay.totalReq) > reqs(redHour.totalReq) * 10, 'total requests should grow with the window')

  // Over a day the Redis layer stops being the thing to look at.
  const drillHour = latencyDrilldownForWindow(hour)
  const drillDay = latencyDrilldownForWindow(day)
  const redis = l => l.find(x => x.label === 'DB redis').ms
  assert.ok(redis(drillHour) > drillHour.reduce((a, b) => a + b.ms, 0) / 2, 'Redis dominates the hour')
  assert.ok(redis(drillDay) < drillDay.reduce((a, b) => a + b.ms, 0) / 3, 'Redis is a minor layer across a day')
})

test('the drilldown Total is the caller latency, and runs below the stack', () => {
  // Total is measured, not summed: the Twilio send overlaps the database work,
  // so the layers consume more time than the caller waits. If Total ever goes
  // back to being the layers' sum it lands on the top edge of the stack again
  // and stops being a line you can see.
  for (const v of ['5m', '1h', '24h', '7d']) {
    const w = v === '1h' ? REFERENCE_WINDOW : preset(v)
    const total = latencyDrilldownTotalForWindow(w)
    const kpi = servicesForWindow(w).find(s => s.id === 'payment-service').latencyAvg
    assert.equal(total.ms, kpi, `${v}: Total should read the Avg Latency KPI`)

    const layers = latencyDrilldownSeriesForWindow(w)
    total.series.forEach((p, i) => {
      if (p.value == null) return
      const sum = layers.reduce((a, l) => a + (l.series[i]?.value ?? 0), 0)
      assert.ok(sum - p.value > 20, `${v} bucket ${i}: Total ${p.value} should sit clearly below the stack ${sum}`)
    })
  }
  assert.equal(latencyDrilldownTotalForWindow(REFERENCE_WINDOW).ms, 340, 'the hour still reads 340 ms')
})

test('External and DB charts draw each row\'s own series: a rate stays a rate, and the line agrees with its row', () => {
  // These charts used to rescale the SERVICE's error series by the row's figure
  // over the service's quiet 0.05%, which multiplied the incident as well: a
  // Redis call at 3.2% errors drew about 900%. Sampling the row's own profile
  // keeps every point a percentage and makes the line average to the table.
  const tables = [
    ['external', externalEndpointSeriesForWindow, externalEndpointsForWindow],
    ['db', dbEndpointSeriesForWindow, dbEndpointsForWindow],
  ]
  for (const v of ['5m', '1h', '24h', '7d']) {
    const w = v === '1h' ? REFERENCE_WINDOW : preset(v)
    for (const [name, sample] of tables) {
      for (const { endpoint, series } of sample(w, 'errPct')) {
        for (const p of series) {
          if (p.value == null) continue
          assert.ok(p.value >= 0 && p.value <= 100, `${name} ${endpoint} on ${v}: error % ${p.value} is not a percentage`)
        }
      }
    }
  }
  for (const [name, sample, table] of tables) {
    const rows = table(REFERENCE_WINDOW)
    sample(REFERENCE_WINDOW, 'errPct').forEach(({ endpoint, series }, i) => {
      const vals = series.map(p => p.value).filter(x => x != null)
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length
      assert.equal(endpoint, rows[i].endpoint, `${name}: series and table rows in the same order`)
      assert.ok(Math.abs(mean - rows[i].errPct) <= 0.05, `${name} ${endpoint}: line averages ${mean.toFixed(3)}, table says ${rows[i].errPct}`)
    })
  }
})

test('a DB or external row reconciles with its callers: rpm, shares, and the average they wait', () => {
  // The callers split one row by the endpoint that made the call, so they have
  // to add back up to it. The average is the one that is easy to get wrong by
  // hand: it is the callers' rpm-weighted mean, read at the row's own precision.
  for (const [name, rows, callers] of [['db', dbEndpoints, dbEndpointCallers], ['external', externalEndpoints, externalEndpointCallers]]) {
    for (const r of rows) {
      const c = callers[r.endpoint]
      assert.ok(c?.length, `${name} ${r.endpoint}: has callers`)
      const rpm = c.reduce((a, x) => a + x.rpm, 0)
      assert.equal(Math.round(rpm * 10) / 10, r.rpm, `${name} ${r.endpoint}: caller rpm adds up`)
      assert.equal(c.reduce((a, x) => a + x.timeConsumedPct, 0), 100, `${name} ${r.endpoint}: caller shares add to 100`)
      const weighted = c.reduce((a, x) => a + x.rpm * x.avg, 0) / rpm
      const decimals = String(r.avg).split('.')[1]?.length ?? 0
      assert.ok(Math.abs(weighted - r.avg) < 0.5 * 10 ** -decimals, `${name} ${r.endpoint}: callers average ${weighted.toFixed(3)}, row says ${r.avg}`)
    }
    assert.equal(rows.reduce((a, r) => a + r.timeConsumedPct, 0), 100, `${name}: row shares add to 100`)
  }
})

test('a fleet worker\'s status dot agrees with its own bars on every range', () => {
  // Status is fixed at the reference hour, the bars are coloured from each
  // range's mean. The generated workers are kept clear of the thresholds so the
  // two can never disagree, however the range moves the noise.
  const level = v => (v >= 85 ? 2 : v >= 70 ? 1 : 0)
  const STATUS = ['healthy', 'warning', 'critical']
  for (const v of ['5m', '15m', '1h', '2h', '3h', '6h', '12h', '24h', '2d', '3d', '7d', 'today']) {
    for (const h of infraHostsForWindow(preset(v)).filter(h => h.service == null)) {
      assert.equal(STATUS[Math.max(level(h.cpu), level(h.mem))], h.status, `${v} ${h.host}: dot ${h.status} beside cpu ${h.cpu} / mem ${h.mem}`)
    }
  }
})

test('the health strip puts the incident where the incident was', () => {
  const hour = healthHistoryForWindow(REFERENCE_WINDOW, 'payment-service', 36)
  assert.equal(hour.at(-1), 'critical', 'the newest block of the hour is the live incident')
  assert.equal(hour[0], 'healthy', 'the oldest block of the hour is before it')
  // A third of an hour is the incident, so roughly a third of the blocks.
  const bad = hour.filter(b => b !== 'healthy').length
  assert.ok(bad >= 10 && bad <= 18, `expected about a third of 36 blocks to be unhealthy, got ${bad}`)

  // On a week it survives as a single block rather than vanishing — the window
  // used to be floored to a 3-hour step, which pushed its end up to three hours
  // into the past and dropped the incident out of the range entirely.
  const week = healthHistoryForWindow(resolveWindow({ kind: 'preset', value: '7d' }), 'payment-service', 36)
  assert.equal(week.at(-1), 'critical', 'the incident is still visible at the right-hand edge of a week')
  assert.ok(week.slice(0, -2).every(b => b === 'healthy'), 'and nowhere else')
})

test('a trailing window actually reaches now', () => {
  for (const v of ['1h', '6h', '24h', '7d']) {
    const win = resolveWindow({ kind: 'preset', value: v })
    const gapMin = (win.nowSec - win.end) / 60
    assert.ok(gapMin < 15, `${v} ends ${gapMin.toFixed(0)} minutes short of now`)
  }
})
