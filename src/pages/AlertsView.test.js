// The Alerts hub's frame (docs/alerts/DESIGN.md D2, D14, D16), rendered from a
// URL the way a cold load or a pasted production link renders it: the tab
// strip is the service page's tablist under our labels, a production `tab`
// value opens its tab, the panel is labelled by its tab, and the tabs the range
// says nothing about leave the time picker out. What the Rules tab draws is
// checked beside it (components/alerts/list); what a click does, in the page.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server.browser'
import { MemoryRouter } from 'react-router-dom'
import { ALERTS_TABS } from '@/utils/alertsUrl'
import AlertsView from './AlertsView.jsx'

const noop = () => {}
const EXPECTED = /width\(\d+\) and height\(\d+\) of chart|useLayoutEffect does nothing on the server/
function page(search = '') {
  const { warn, error } = console
  const quiet = log => (...args) => { if (!EXPECTED.test(String(args[0]))) log(...args) }
  console.warn = quiet(warn)
  console.error = quiet(error)
  try {
    return renderToStaticMarkup(
      <MemoryRouter initialEntries={[`/alerts${search}`]}>
        <AlertsView goHome={noop} timeRange={{ kind: 'preset', value: '1h' }} setTimeRange={noop} setToast={noop} onOpenLink={noop} />
      </MemoryRouter>,
    )
  } finally {
    Object.assign(console, { warn, error })
  }
}
const attr = (tag, name) => tag.match(new RegExp(`${name}="([^"]*)"`))?.[1]
const tabsOf = out => out.match(/<button[^>]*role="tab"[^>]*>[\s\S]*?<\/button>/g) ?? []

test('five tabs, in production\'s order and by its tab values, under our labels', () => {
  const tabs = tabsOf(page())
  assert.deepEqual(tabs.map(t => attr(t, 'data-tab')), ALERTS_TABS)
  assert.deepEqual(tabs.map(t => t.replace(/<span class="view-tab-count">[\s\S]*?<\/span>/, '').replace(/<[^>]+>/g, '')), ['Rules', 'Insights', 'Contact points', 'Mute schedules', 'Notifications'])
  assert.match(page(), /role="tablist" aria-label="Alerts views"/)
})

test('the configuration tabs count what they hold; Rules and Insights carry no count', () => {
  const tabs = tabsOf(page())
  assert.match(tabs[2], /<span class="view-tab-count">\d+<\/span>/)
  assert.match(tabs[3], /<span class="view-tab-count">\d+<\/span>/)
  assert.doesNotMatch(tabs[0], /view-tab-count|firing/)
  assert.doesNotMatch(tabs[1], /view-tab-count/)
})

test('a production link opens its tab, and the panel says which tab it is', () => {
  for (const tab of ALERTS_TABS) {
    const out = page(`?tab=${tab}`)
    const open = tabsOf(out).find(t => attr(t, 'aria-selected') === 'true')
    assert.equal(attr(open, 'data-tab'), tab)
    assert.equal(attr(open, 'tabindex'), '0', 'the open tab is the strip\'s one Tab stop')
    const panel = out.match(/<div[^>]*role="tabpanel"[^>]*>/)?.[0]
    assert.equal(attr(panel, 'aria-labelledby'), `alr-tab-${tab}`)
    assert.equal(attr(panel, 'class'), 'alerts-panel')
  }
  const study = page('?service=cubedemo-web&index=cube%3Aerror&name=POST+api.stripe.com%2Fv1%2Fpayment_intents&kind=server&time=7d&refresh=1792040553713&view=graph&env=UNSET')
  assert.equal(attr(tabsOf(study).find(t => attr(t, 'aria-selected') === 'true'), 'data-tab'), 'alerts', 'the study link is the rules list')
})

test('the time picker shows where the range applies and nowhere else', () => {
  for (const tab of ['alerts', 'alert-stats', 'alert-logs']) assert.match(page(`?tab=${tab}`), /time-btn/, tab)
  for (const tab of ['receiver-groups', 'mute-groups']) assert.doesNotMatch(page(`?tab=${tab}`), /time-btn/, tab)
})

test('every tab is built: none says it is reserved', () => {
  for (const tab of ALERTS_TABS) assert.doesNotMatch(page(`?tab=${tab}`), /Reserved for the next redesign pass/, tab)
  assert.match(page('?tab=alert-stats'), /Flagged rules/)
  assert.match(page('?tab=alert-logs'), /Showing \d+ of [\d,]+/)
  const contacts = page('?tab=receiver-groups')
  assert.doesNotMatch(contacts, /Reserved for the next redesign pass/)
  assert.match(contacts, /Infra paging/)
  const mutes = page('?tab=mute-groups')
  assert.match(mutes, /Quiet hours/)
  assert.match(mutes, />Snoozes</)
})

test('the crumb home is a real link, and the trail ends at Alerts', () => {
  const out = page()
  assert.match(out, /<a href="\/">CubeAPM<\/a>/)
  assert.match(out, /<span class="current">Alerts<\/span>/)
})

test('how old the data is sits in the page bar, just ahead of Auto, on every tab', () => {
  for (const tab of ALERTS_TABS) {
    const out = page(`?tab=${tab}`)
    const right = out.slice(out.indexOf('class="card-crumbs-right"'))
    const updated = right.indexOf('class="alr-updated"')
    assert.ok(updated > 0, `${tab}: in the bar`)
    assert.ok(updated < right.indexOf('ex-auto'), `${tab}: before Auto`)
    assert.match(right, /class="alr-updated" title="\d{4}-\d\d-\d\d \d\d:\d\d:\d\d">Updated just now</)
    assert.equal((out.match(/Updated /g) ?? []).length, 1, `${tab}: once`)
  }
})
