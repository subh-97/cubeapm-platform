// The configuration tabs and their drawers (docs/alerts/DESIGN.md D9, D10),
// rendered from the real seed: what each contact point and schedule says about
// itself, which Delete is refused and why, and what a Save says it changes.
// What a click does is checked in the browser.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server.browser'
import { MemoryRouter } from 'react-router-dom'
import { alertsSeed, ALERTS_NOW } from '@/data/alerts'
import { alertsFor } from '@/utils/alerts/store'
import { usageByContactPoint, usageBySchedule } from '@/utils/alerts/configViews'
import ContactPointsTab from './ContactPointsTab.jsx'
import MuteSchedulesTab from './MuteSchedulesTab.jsx'
import ContactPointDrawer from './ContactPointDrawer.jsx'
import MuteScheduleDrawer from './MuteScheduleDrawer.jsx'

const noop = () => {}
const render = el => renderToStaticMarkup(<MemoryRouter>{el}</MemoryRouter>)
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, '\'').replace(/&amp;/g, '&').replace(/\s+/g, ' ')
const withUnused = () => {
  const state = alertsSeed()
  state.receiverGroups.push({ id: 99, name: 'Spare pager', receiver: { email_configs: [{ to: 'spare@cubedemo.example', send_resolved: true }] } })
  return state
}
const alertsOf = state => ({ ...alertsFor(state, null), actions: {} })
const items = html => html.split('<li class="cfg-item').slice(1)

test('contact points: the failing one first, with its error, and every count is its rules', () => {
  const state = withUnused()
  const alerts = alertsOf(state)
  const html = render(<ContactPointsTab alerts={alerts} setToast={noop} />)
  assert.match(text(html), /8 contact points · 1 failing/)
  const rows = items(html)
  assert.match(rows[0], /Infra paging/)
  assert.match(rows[0], /is-failing/)
  assert.match(text(rows[0]), /Failed \S+ ago Post "https:\/\/hooks\.internal\.cubedemo\.example\/alerts": 503 Service Unavailable/)
  const usage = usageByContactPoint(alerts.rules)
  for (const g of state.receiverGroups) {
    const row = rows.find(r => r.includes(`>${g.name}</button>`))
    const n = usage.get(g.id)?.length ?? 0
    assert.match(text(row), n ? new RegExp(`Used by ${n} rules?`) : /Not used by any rule/, g.name)
  }
})

test('a contact point in use cannot be deleted, and says why; one in use by nothing can', () => {
  const html = render(<ContactPointsTab alerts={alertsOf(withUnused())} setToast={noop} />)
  const rows = items(html)
  const used = rows.find(r => r.includes('>Payments on-call</button>'))
  assert.match(used, /aria-disabled="true" title="Used by 3 rules: move them to another contact point first\."/)
  const spare = rows.find(r => r.includes('>Spare pager</button>'))
  assert.match(text(spare), /Not used by any rule/)
  assert.match(spare, /title="Delete Spare pager"/)
  assert.doesNotMatch(spare, /aria-disabled="true" title=/)
})

test('a contact point\'s Save says how many rules it re-routes; a new one just saves', () => {
  const state = alertsSeed()
  const alerts = alertsOf(state)
  const payments = state.receiverGroups.find(g => g.id === 11)
  const edit = render(<ContactPointDrawer mode="edit" group={payments} usedBy={usageByContactPoint(alerts.rules).get(11)} others={[]} lookups={alerts.lookups} onSave={noop} onDelete={noop} onClose={noop} />)
  assert.match(edit, />Save · changes routing for 3 rules</)
  assert.match(edit, /aria-disabled="true" title="Used by 3 rules: move them to another contact point first\."/)
  assert.deepEqual([...edit.matchAll(/class="ae-dest-type">([^<]+)</g)].map(m => m[1]), ['Slack', 'PagerDuty'])
  assert.deepEqual([...edit.matchAll(/class="cfg-type"[^>]*>(?:<svg[\s\S]*?<\/svg>)?([^<]+)</g)].map(m => m[1]),
    ['Email', 'Slack', 'PagerDuty', 'Jira', 'Opsgenie', 'Google Chat', 'Microsoft Teams', 'Webhook'])
  const fresh = render(<ContactPointDrawer mode="new" group={null} usedBy={[]} others={[]} lookups={alerts.lookups} onSave={noop} onDelete={noop} onClose={noop} />)
  assert.match(fresh, />Save contact point</)
  assert.match(fresh, /New contact point/)
  assert.doesNotMatch(fresh, />Delete</)
})

test('mute schedules: each says whether it is muting now, and the snoozes are all listed', () => {
  const state = alertsSeed()
  const alerts = alertsOf(state)
  const html = render(<MuteSchedulesTab alerts={alerts} setToast={noop} />)
  const rows = items(html)
  const deploy = rows.find(r => r.includes('>Daily deploy window</button>'))
  assert.match(text(deploy), /Muting now · ends /, 'the deploy window is open as the demo loads')
  const quiet = rows.find(r => r.includes('>Quiet hours</button>'))
  assert.match(text(quiet), /Muting now · ends |Next: /)
  assert.match(text(quiet), /21:00 for 10h, every day/)
  assert.match(text(quiet), /Hours are Asia\/Calcutta \(UTC\+5:30\)/)
  const usage = usageBySchedule(alerts.rules)
  assert.match(text(quiet), new RegExp(`Used by ${usage.get(2).length} rules?`))
  const snoozes = html.split('cfg-snooze"').slice(1)
  assert.equal(snoozes.length, 2)
  assert.match(text(snoozes[0]), /shipment-service p90 latency .* left, until .* Unsnooze/)
  assert.match(text(snoozes[1]), /search-service traffic anomaly Starts .* for 2 hours Cancel snooze/)
  assert.ok(ALERTS_NOW > 0)
})

test('a schedule\'s Save says how many rules it changes; Delete waits until none use it', () => {
  const state = alertsSeed()
  const alerts = alertsOf(state)
  const quiet = state.muteGroups.find(g => g.name === 'Quiet hours')
  const html = render(<MuteScheduleDrawer mode="edit" group={quiet} usedBy={usageBySchedule(alerts.rules).get(2)} others={[]} nowSec={ALERTS_NOW} onSave={noop} onDelete={noop} onClose={noop} />)
  assert.match(html, />Save · changes muting for 1 rule</)
  assert.match(html, /aria-disabled="true" title="Mutes 1 rule: take it off them first\."/)
  assert.match(html, /role="img" aria-label="Muted 14 stretches a week/, 'every night, wrapping into the morning')
})
