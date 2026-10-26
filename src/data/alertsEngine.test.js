// The engine binding (alertsEngine.js): rules no profile describes, read the
// way production reads them, by running their query. What is pinned is what
// makes it trustworthy as an evaluator: it refuses what production cannot run
// with production's own words, it reads the same number at an instant however
// wide the window that asked, and a Logs count read at t is the step ending at t.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BASE_TIME } from './timeWindow'
import { engineBinding, queryProblem, seriesKeyOf, UNSUPPORTED_VARIABLES, NEEDS_CLOSING_PIPE, clearEngineCache } from './alertsEngine'

const NOW = Math.floor(BASE_TIME.getTime() / 60000) * 60
const ERR = 'sum(increase(cube_apm_calls_total{service="payment-service", span_kind=~"server|consumer", status_code="ERROR"}[1m])) * 100 / sum(increase(cube_apm_calls_total{service="payment-service", span_kind=~"server|consumer"}[1m]))'

test('what production cannot run is refused in words, before anything runs', () => {
  assert.equal(queryProblem('prometheus', ''), 'The rule has no query.')
  assert.equal(queryProblem('prometheus', 'sum(rate(x[$__range]))'), UNSUPPORTED_VARIABLES)
  assert.equal(queryProblem('vlogs', 'error'), NEEDS_CLOSING_PIPE)
  assert.equal(queryProblem('vlogs', 'error | stats count() as c'), null)
  assert.equal(queryProblem('mobile', '* | stats count()'), 'Mobile alerts aren\'t available yet.')
  assert.match(queryProblem('prometheus', 'sum(rate(x[1m]'), /./, 'a parse error comes back in the engine\'s words')
  assert.deepEqual(Object.keys(engineBinding({ datasource: 'vlogs', query: 'error' }, { from: NOW - 3600, to: NOW })), ['error'])
})

test('one reading per instant, whichever window asked', () => {
  clearEngineCache()
  const hour = engineBinding({ datasource: 'prometheus', query: ERR, interval: 60 }, { from: NOW - 3600, to: NOW })
  const week = engineBinding({ datasource: 'prometheus', query: ERR, interval: 60 }, { from: NOW - 7 * 86400, to: NOW })
  assert.equal(hour.series.length, 1)
  for (const t of [NOW, NOW - 600, NOW - 1800]) assert.equal(hour.series[0].valueAt(t), week.series[0].valueAt(t))
  assert.ok(hour.series[0].valueAt(NOW) > 3, 'payment-service is failing now')
  assert.ok(hour.series[0].valueAt(NOW - 3600) < 1, 'and was not an hour ago')
  assert.equal(hour.series[0].valueAt(NOW + 30), hour.series[0].valueAt(NOW), 'an instant reads the evaluation at or before it')
})

test('a Logs count is a series per group, read at the end of its step', () => {
  const b = engineBinding({ datasource: 'vlogs', query: '* | stats by (service) count() as c', interval: 60 }, { from: NOW - 3600, to: NOW })
  assert.ok(b.series.length > 1, 'one series per service')
  for (const s of b.series) assert.equal(s.key, seriesKeyOf(s.labels))
  assert.ok(b.series.some(s => s.valueAt(NOW) > 0))
  const five = engineBinding({ datasource: 'vlogs', query: '* | stats count() as c', interval: 300 }, { from: NOW - 3600, to: NOW })
  assert.ok(five.series[0].valueAt(NOW) > b.series.reduce((a, s) => a + (s.valueAt(NOW) ?? 0), 0) * 2,
    'a 5-minute rule counts five minutes of records')
})
