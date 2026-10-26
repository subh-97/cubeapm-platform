// PageBar gained `showTime` for the Alerts page's configuration tabs, where the
// range says nothing (docs/alerts/DESIGN.md D16). The risk is every other page:
// left out, the prop must change nothing, so the default render is compared
// with an explicit `showTime` character for character.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server.browser'
import PageBar from './PageBar.jsx'

const noop = () => {}
const range = { kind: 'preset', value: '1h' }
const bar = props => renderToStaticMarkup(
  <PageBar timeRange={range} setTimeRange={noop} {...props}><span className="current">Alerts</span></PageBar>,
)

test('a page that does not pass showTime gets the bar it always had', () => {
  assert.equal(bar({}), bar({ showTime: true }))
  assert.match(bar({}), /class="hbtn time-btn"/)
  assert.match(bar({}), /title="Time range: Last 1 hour"/)
})

test('showTime={false} leaves only the picker out', () => {
  const without = bar({ showTime: false })
  assert.doesNotMatch(without, /time-btn/)
  assert.match(without, /aria-label="Refresh"/, 'refresh stays')
  assert.match(without, /<span class="current">Alerts<\/span>/, 'and the crumbs')
})
