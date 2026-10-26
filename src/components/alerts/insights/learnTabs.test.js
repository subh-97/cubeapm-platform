// Insights and Notifications (docs/alerts/DESIGN.md D11, D12), rendered from
// the real seed over the last hour: the chronic rule is flagged with Tune, an
// SLO's rule cannot be tuned here and says why, production's rule_id link
// filters the log to that rule, and a status facet filters by production's
// values. What a click does is checked in the browser.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server.browser'
import { MemoryRouter } from 'react-router-dom'
import { alertsSeed } from '@/data/alerts'
import { resolveWindow } from '@/data/timeWindow'
import { alertsFor } from '@/utils/alerts/store'
import { parseAlertsSearch } from '@/utils/alertsUrl'
import InsightsTab from './InsightsTab.jsx'
import NotificationsTab from '@/components/alerts/notifications/NotificationsTab.jsx'

const HOUR = resolveWindow({ kind: 'preset', value: '1h' })
const alerts = { ...alertsFor(alertsSeed(), HOUR), actions: {} }
const render = el => renderToStaticMarkup(<MemoryRouter>{el}</MemoryRouter>)
const rowsOf = html => html.split('<tr').slice(2)
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, '\'').replace(/&amp;/g, '&').replace(/\s+/g, ' ')

test('Insights: every rule, the chronic one first, flagged and offered Tune', () => {
  const html = render(<InsightsTab alerts={alerts} win={HOUR} />)
  const rows = rowsOf(html)
  assert.equal(rows.length, alerts.rules.length)
  assert.match(rows[0], /notify-service slow sends/)
  assert.match(rows[0], /class="ins-flag alwaysFiring"[^>]*>Always firing</)
  assert.match(rows[0], /<button type="button" class="hbtn ins-tune" title="Open notify-service slow sends in the editor/)
  const slo = rows.find(r => r.includes('#9011'))
  assert.match(slo, /aria-disabled="true" title="Its thresholds are set by its SLO\."/)
  assert.match(text(html), /Incidents \d+ [↑↓]?\d* ?(same )?vs the previous 1 hour|Incidents \d+ same vs the previous 1 hour/)
  assert.match(text(html), /Flagged \(\d+\)/)
  assert.match(html, />Download CSV</)
})

test('Notifications: production\'s rule_id link shows that rule\'s sends only, under a chip that clears it', () => {
  const url = parseAlertsSearch('?tab=alert-logs&rule_id=514')
  const html = render(<NotificationsTab alerts={alerts} url={url} onUrlChange={() => {}} />)
  assert.match(text(html), /Rule redis\.0 memory/)
  assert.match(html, /aria-label="Show every rule&#x27;s notifications"/)
  const rows = html.split('class="nlog-toggle"').slice(1)
  assert.ok(rows.length > 0)
  for (const r of rows) assert.match(r, /class="nlog-rule">redis\.0 memory/)
})

test('Notifications: a status facet filters by production\'s value, and every held or failed row says why', () => {
  const url = parseAlertsSearch('?tab=alert-logs&status=ERROR&status=MUTE')
  const html = render(<NotificationsTab alerts={alerts} url={url} onUrlChange={() => {}} />)
  const rows = html.split('class="nlog-toggle"').slice(1)
  assert.ok(rows.length > 0)
  for (const r of rows) {
    assert.match(r, /title="Status: (ERROR|MUTE)">(Failed|Muted)</)
    assert.match(r, /class="nlog-why">[^<]+</, 'and says why')
  }
})
