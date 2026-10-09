// The Browser metric tabs' labels and figures: what a headline, a chip, a
// legend row and a table's status dot actually say.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { REFERENCE_WINDOW as win } from '@/data/timeWindow'
import { BROWSER_APPS, ajaxCallsForWindow, pageViewsForWindow, webVitalsForWindow } from '@/data/browser'
import { statusForWebVital } from '@/utils/status'
import { fmtLoadTime, fmtCls, labelMatches } from '@/components/charts/chartDefaults'
import {
  splitFigure, figureDelta, ajaxLabel, pagePath, filterByLabel,
  vitalThresholdText, vitalRating, vitalFigure, worstVitalTitle, vitalsBySeverity,
} from './metricLabels'

test('a headline splits into its figure and its unit', () => {
  assert.deepEqual(splitFigure('1.18 s'), { value: '1.18', unit: 's' })
  assert.deepEqual(splitFigure('982 ms'), { value: '982', unit: 'ms' })
  assert.deepEqual(splitFigure('5.94%'), { value: '5.94', unit: '%' })
  // No unit, or a unit-like suffix that is part of the figure: kept whole.
  assert.deepEqual(splitFigure('439.02'), { value: '439.02', unit: '' })
  assert.deepEqual(splitFigure('1.23K'), { value: '1.23K', unit: '' })
  assert.deepEqual(splitFigure('0.28'), { value: '0.28', unit: '' })
  assert.deepEqual(splitFigure(''), { value: '', unit: '' })
  assert.deepEqual(splitFigure(null), { value: '', unit: '' })
})

test('the comparison chip names the earlier figure in the card\'s own units', () => {
  const d = figureDelta(1267.61, 1252.26, 'the previous hour', fmtLoadTime)
  assert.equal(d.dir, 'up')
  assert.equal(d.label, '↑1.2%')
  assert.equal(d.title, '↑1.2% vs the previous hour (1.25 s then)')
  const down = figureDelta(5, 10, 'the previous 7 days', v => `${v.toFixed(2)}%`)
  assert.equal(down.dir, 'down')
  assert.equal(down.title, '↓50% vs the previous 7 days (10.00% then)')
  // Nothing before: deltaChip's own wording, which names no figure.
  assert.equal(figureDelta(3, 0, 'the previous hour', String).label, 'New')
  assert.equal(figureDelta(null, 3, 'the previous hour', String).label, '—')
})

test('an ajax label loses the default port and nothing else', () => {
  assert.equal(ajaxLabel('GET order.cubedemo.com:443/v1/orders'), 'GET order.cubedemo.com/v1/orders')
  assert.equal(ajaxLabel('POST payment.cubedemo.com:443/v1/payments'), 'POST payment.cubedemo.com/v1/payments')
  assert.equal(ajaxLabel('GET api.example.com:443'), 'GET api.example.com')
  assert.equal(ajaxLabel('GET api.example.com:8443/v1/x'), 'GET api.example.com:8443/v1/x')
  assert.equal(ajaxLabel(undefined), '')
})

test('a page URL loses the app\'s origin', () => {
  const origin = 'https://shop.cubedemo.com'
  assert.equal(pagePath('https://shop.cubedemo.com/product/:sku', origin), '/product/:sku')
  assert.equal(pagePath('https://shop.cubedemo.com/', origin), '/')
  assert.equal(pagePath('https://shop.cubedemo.com', origin), '/')
  assert.equal(pagePath('https://admin.cubedemo.com/orders', origin), 'https://admin.cubedemo.com/orders')
  assert.equal(pagePath('/cart', undefined), '/cart')
})

test('the table search matches the stored label or the shown one, ignoring case', () => {
  const rows = [
    { endpoint: 'GET search.cubedemo.com:443/v1/search/wealth' },
    { endpoint: 'GET order.cubedemo.com:443/v1/orders' },
  ]
  assert.equal(filterByLabel(rows, ''), rows)
  assert.equal(filterByLabel(rows, '   '), rows)
  assert.deepEqual(filterByLabel(rows, 'WEALTH').map(r => r.endpoint), [rows[0].endpoint])
  // Only the shown label has 'cubedemo.com/v1' (the stored one has :443 between).
  assert.equal(filterByLabel(rows, 'search.cubedemo.com/v1').length, 0)
  assert.deepEqual(filterByLabel(rows, 'search.cubedemo.com/v1', ajaxLabel), [rows[0]])
  assert.deepEqual(filterByLabel(rows, 'nothing', ajaxLabel), [])
})

test('the table and the chart legends find a row by the label the legend shows', () => {
  // Each tab hands its table search the function its charts get as
  // formatLabel; both searches then run labelMatches, so typing what a legend
  // row says finds that row in Table view and in every legend alike.
  for (const app of BROWSER_APPS) {
    const tabs = [
      [ajaxCallsForWindow(win, app.id).rows, ajaxLabel],
      [webVitalsForWindow(win, app.id).rows, (full, r) => r?.route ?? pagePath(full, app.origin)],
      [pageViewsForWindow(win, app.id).rows, undefined],
    ]
    for (const [rows, shortLabel] of tabs) {
      for (const r of rows) {
        const shown = shortLabel ? shortLabel(r.endpoint, r) : r.endpoint
        assert.ok(filterByLabel(rows, shown, shortLabel).includes(r), `${app.id}: the table finds '${shown}'`)
        assert.ok(labelMatches(r, shown.toUpperCase(), shortLabel), `${app.id}: a legend finds '${shown}'`)
        assert.deepEqual(filterByLabel(rows, shown, shortLabel), rows.filter(x => labelMatches(x, shown, shortLabel)))
      }
    }
  }
})

test('a vital\'s thresholds and rating read as words', () => {
  assert.equal(vitalThresholdText('lcp'), 'good ≤ 2.5 s, poor > 4 s')
  assert.equal(vitalThresholdText('inp'), 'good ≤ 200 ms, poor > 500 ms')
  assert.equal(vitalThresholdText('cls'), 'good ≤ 0.1, poor > 0.25')
  assert.deepEqual(vitalRating('lcp', 'warning'), {
    status: 'warning', label: 'Needs improvement', title: 'Needs improvement · good ≤ 2.5 s, poor > 4 s',
  })
  assert.equal(vitalRating('cls', 'critical').title, 'Poor · good ≤ 0.1, poor > 0.25')
  assert.equal(vitalRating('inp', 'neutral'), null)
})

test('a vital prints as the page prints it, unless that would contradict its rating', () => {
  // The everyday case is the shared formatter, untouched.
  for (const v of [1840, 4550, 2557.01, 999.6]) assert.equal(vitalFigure('lcp', v), fmtLoadTime(v))
  for (const v of [108.16, 569.73, 176.66]) assert.equal(vitalFigure('inp', v), fmtLoadTime(v))
  for (const v of [0.03, 0.28, 0.099]) assert.equal(vitalFigure('cls', v), fmtCls(v))
  // A hair over a threshold gets the decimals that show which side it is on.
  assert.equal(vitalFigure('lcp', 2504), '2.504 s')
  assert.equal(vitalFigure('lcp', 4000.4), '4.0004 s')
  assert.equal(vitalFigure('inp', 200.4), '200.4 ms')
  assert.equal(vitalFigure('cls', 0.104), '0.104')
  // Exactly on a threshold is still good (inclusive), and prints plainly.
  assert.equal(vitalFigure('lcp', 2500), '2.50 s')
  assert.equal(vitalFigure('cls', 0.1), '0.10')
  assert.equal(vitalFigure('lcp', null), '')
  // Whatever it prints rates the way the reading does, down to the precision
  // the data is kept at (LCP and INP to the hundredth of a ms, CLS to 0.001).
  for (const [m, vs] of Object.entries({ lcp: [2500.01, 2504.9, 3999.99, 4000.01], inp: [199.99, 200.01, 500.4], cls: [0.101, 0.251, 0.099] })) {
    for (const v of vs) {
      const text = vitalFigure(m, v)
      const back = m === 'cls' ? Number(text) : text.endsWith(' s') ? Number(text.slice(0, -2)) * 1000 : Number(text.slice(0, -3))
      assert.equal(statusForWebVital(m, back), statusForWebVital(m, v), `${m} ${v} printed ${text}`)
    }
  }
})

test('a page\'s status dot says its worst rating and which vitals earned it', () => {
  const rows = webVitalsForWindow(win, 'cubedemo-web').rows
  const product = rows.find(r => r.route === '/product/:sku')
  assert.equal(worstVitalTitle(product), 'Poor · LCP 4.55 s, CLS 0.28')
  const home = rows.find(r => r.route === '/')
  assert.equal(worstVitalTitle(home), 'Good · LCP 1.84 s, INP 108 ms, CLS 0.03')
  assert.equal(worstVitalTitle({ status: { worst: 'neutral' } }), 'No web vitals recorded')
})

test('the Web Vitals table opens worst rating first, then slowest LCP, and leaves its input alone', () => {
  const rows = webVitalsForWindow(win, 'cubedemo-web').rows
  const before = rows.map(r => r.endpoint)
  const ordered = vitalsBySeverity(rows)
  assert.deepEqual(rows.map(r => r.endpoint), before)
  assert.equal(ordered.length, rows.length)
  const rank = { critical: 0, warning: 1, healthy: 2 }
  for (let i = 1; i < ordered.length; i++) {
    const a = ordered[i - 1], b = ordered[i]
    assert.ok(rank[a.status.worst] <= rank[b.status.worst], `${a.route} before ${b.route}`)
    if (a.status.worst === b.status.worst) assert.ok(a.lcp >= b.lcp, `${a.route} LCP before ${b.route}`)
  }
  assert.equal(ordered[0].route, '/product/:sku')
  // A row with no LCP goes last within its rating rather than breaking the sort.
  const odd = vitalsBySeverity([
    { endpoint: 'a', lcp: null, status: { worst: 'healthy' } },
    { endpoint: 'b', lcp: 1200, status: { worst: 'healthy' } },
    { endpoint: 'c', lcp: 900, status: { worst: 'warning' } },
  ])
  assert.deepEqual(odd.map(r => r.endpoint), ['c', 'b', 'a'])
})
