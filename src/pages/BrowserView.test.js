// The Browser page's own frame, rendered from a URL the way a cold load or a
// pasted link renders it: the tab strip's semantics, the crumb, the Traces
// tab's Type filter, and where a card menu's Explore item lands. What a click
// or a key does needs a DOM and is checked in the running page; what the tabs
// draw is checked beside them (components/browser/*.test.js).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server.browser'
import { MemoryRouter } from 'react-router-dom'
import { BROWSER_APPS, BROWSER_SOURCE_MAP_SEED } from '@/data/browser'
import { BASE_TIME } from '@/data/timeWindow'
import { rumExploreQuery } from '@/data/explore/eventsStore'
import { queryRange, setSimulatedLatency } from '@/utils/explore/api'
import { BROWSER_TABS, BROWSER_KINDS } from '@/utils/browserUrl'
import BrowserView from './BrowserView.jsx'

const noop = () => {}

// Two warnings are a server render's, not the page's (LegendLineChart.test.js
// says the same): a chart's frame has no size to draw at, and the page, its
// card menus and the router settle in layout effects a server render skips.
// Anything else still reaches the console.
const EXPECTED = /width\(\d+\) and height\(\d+\) of chart|useLayoutEffect does nothing on the server/
function page(search) {
  const { warn, error } = console
  const quiet = log => (...args) => { if (!EXPECTED.test(String(args[0]))) log(...args) }
  console.warn = quiet(warn)
  console.error = quiet(error)
  try {
    return renderToStaticMarkup(
      <MemoryRouter initialEntries={[`/browser${search}`]}>
        <BrowserView
          goHome={noop} timeRange={{ kind: 'preset', value: '1h' }} setTimeRange={noop}
          settingsOpen={false} setSettingsOpen={noop} setToast={noop}
          onOpenLink={noop} onOpenTrace={noop}
          sourceMaps={BROWSER_SOURCE_MAP_SEED} onOpenSettingsTab={noop}
        />
      </MemoryRouter>,
    )
  } finally {
    Object.assign(console, { warn, error })
  }
}

const tabsOf = out => (out.match(/<button[^>]*role="tab"[^>]*>/g) ?? [])
const attr = (tag, name) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1] ?? null

// A screen-reader user expects the tablist pattern: each tab names the panel
// it controls, the panel names the tab it shows, and only the open tab is a
// Tab stop (the arrows move along the rest).
test('the tab strip is one tablist that names its panel, and the open tab is its one Tab stop', () => {
  for (const tab of BROWSER_TABS) {
    const out = page(`?service=cubedemo-web&tab=${tab}`)
    const tabs = tabsOf(out)
    assert.equal(tabs.length, BROWSER_TABS.length, tab)
    assert.deepEqual(tabs.map(t => attr(t, 'id')), BROWSER_TABS.map(id => `brw-tab-${id}`))
    assert.ok(tabs.every(t => attr(t, 'aria-controls') === 'brw-tab-panel'), `${tab}: every tab controls the panel`)
    const stops = tabs.filter(t => attr(t, 'tabindex') === '0')
    assert.equal(stops.length, 1, `${tab}: one Tab stop`)
    assert.equal(attr(stops[0], 'id'), `brw-tab-${tab}`)
    assert.equal(attr(stops[0], 'aria-selected'), 'true')
    assert.ok(tabs.filter(t => t !== stops[0]).every(t => attr(t, 'tabindex') === '-1' && attr(t, 'aria-selected') === 'false'))
    assert.match(out, /role="tablist" aria-label="Browser views"/)
    const panel = out.match(/<div[^>]*id="brw-tab-panel"[^>]*>/)?.[0]
    assert.ok(panel, `${tab}: the panel is there`)
    assert.equal(attr(panel, 'role'), 'tabpanel')
    assert.equal(attr(panel, 'aria-labelledby'), `brw-tab-${tab}`)
  }
})

// It was an <a> with no href: not in the Tab order, and not read as a link.
test('the CubeAPM crumb is a real link home', () => {
  assert.match(page('?service=cubedemo-web'), /<a href="\/">CubeAPM<\/a>/)
})

// The URL says server|client, production's values; the filter says what they
// mean in a browser. Off the Traces tab the filters are not drawn at all.
test('the Traces tab\'s Type filter reads the URL\'s kind in the page\'s words', () => {
  const [script, ajax] = BROWSER_KINDS
  for (const { search, label } of [
    { search: '?service=cubedemo-web&tab=traces', label: script.label },
    { search: '?service=cubedemo-web&tab=traces&kind=client', label: ajax.label },
  ]) {
    const out = page(search)
    assert.match(out, /class="subtab-filters"/, search)
    // Only the filters' own markup: the tab strip below says "Ajax Calls".
    const filters = out.slice(out.indexOf('class="subtab-filters"'), out.indexOf('class="view-tabs"'))
    assert.ok(filters.indexOf(`>${label}<`) > 0, `${search}: Type reads ${label}`)
    const other = BROWSER_KINDS.find(k => k.label !== label).label
    assert.equal(filters.indexOf(`>${other}<`), -1, `${search}: not ${other}`)
    assert.match(out, /class="endpoint-strip is-sticky brw-strip/, `${search}: the Endpoint strip`)
  }
  const errors = page('?service=cubedemo-web&tab=errors&kind=client')
  assert.doesNotMatch(errors, /class="subtab-filters"/)
  assert.doesNotMatch(errors, /endpoint-strip/)
})

// A card menu's Explore item opens Explore on the app's RUM events through
// Explore's own engine, so the query must chart events there, not an error
// or an empty chart. An app with none there gets the toast instead.
test('a card menu\'s Explore item lands on events for an app that has them, and on none for one that does not', async () => {
  const prev = setSimulatedLatency(0)
  try {
    const end = Math.floor(BASE_TIME.getTime() / 60_000) * 60
    const hour = { start: end - 3600, end, step: 60 }
    let opened = 0
    for (const { id } of BROWSER_APPS) {
      const query = rumExploreQuery(id)
      if (query == null) continue
      opened++
      const { series } = await queryRange({ datasource: 'vlogs', query, ...hour })
      const total = series.reduce((a, s) => a + s.values.reduce((b, p) => b + p.y, 0), 0)
      assert.ok(series.length > 0 && total > 0, `${id}: ${query} charts its events`)
    }
    assert.equal(opened, 1, 'only the storefront sends RUM events to Explore')
    assert.equal(rumExploreQuery('cubedemo-admin'), null)
  } finally {
    setSimulatedLatency(prev)
  }
})
