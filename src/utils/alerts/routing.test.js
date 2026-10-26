// Routing and holding back (docs/alerts/DESIGN.md D9, D10). The risks: a
// contact point's receivers not reaching a rule that uses it; a snooze matched
// to the wrong rule; and a mute window read in the viewer's zone instead of its
// own, which silently moves "21:00 · 10h · Asia/Calcutta" by hours.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  effectiveReceivers, ruleContactPoints, receiverSummary, sendsResolved,
  ruleMuteIntervals, ruleSilences, silenceMatchesRule, muteStretches, muteCovering, nextMute,
} from './routing.js'

const groups = [
  { id: 7, name: 'Payments on-call (demo)', receiver: { webhook_configs: [{ url: 'http://127.0.0.1:3140/api/logs/insert/jsonline?_stream_fields=receiver', headers: {}, body: '', send_resolved: true }] } },
  { id: 11, name: 'Payments on-call', receiver: { slack_configs: [{ channel: 'C0PAY', send_resolved: true }], pagerduty_configs: [{ service_name: 'Payments', routing_key: 'k', send_resolved: false }] } },
]

test('a rule notifies its contact points\' receivers, then its own one-off ones', () => {
  const rule = { config: { receiver_group_ids: [11, 99, 7] }, receiver: { email_configs: [{ to: 'a@x.example, b@x.example', send_resolved: true }] } }
  const rs = effectiveReceivers(rule, groups)
  assert.deepEqual(rs.map(r => [r.type, r.groupName, r.oneOff]), [
    ['slack', 'Payments on-call', false], ['pagerduty', 'Payments on-call', false],
    ['webhook', 'Payments on-call (demo)', false], ['email', null, true],
  ])
  assert.deepEqual(ruleContactPoints(rule, groups), [{ id: 11, name: 'Payments on-call' }, { id: 7, name: 'Payments on-call (demo)' }], 'a missing group is skipped')
  assert.equal(sendsResolved(rs[1]), false)
  assert.equal(sendsResolved(rs[0]), true)
})

test('each receiver is said briefly, in names rather than ids', () => {
  const lookups = { slackChannels: [{ id: 'C0PAY', name: 'payments-oncall' }], opsgenieTeams: [{ team: 'cubedemo-oncall', api_key: 'og1' }] }
  const say = (configs, data) => receiverSummary({ type: { email_configs: 'email', slack_configs: 'slack', opsgenie_configs: 'opsgenie', webhook_configs: 'webhook', jira_configs: 'jira' }[configs], configs, data }, lookups)
  assert.deepEqual(say('slack_configs', { channel: 'C0PAY' }), { label: 'Slack', target: '#payments-oncall', full: '#payments-oncall' })
  assert.equal(say('email_configs', { to: 'a@x.example, b@x.example' }).target, '2 recipients')
  assert.equal(say('email_configs', { to: 'oncall@cubedemo.example' }).target, 'oncall@cubedemo.example')
  assert.equal(say('opsgenie_configs', { api_key: 'og1' }).target, 'cubedemo-oncall')
  assert.equal(say('webhook_configs', { url: 'http://127.0.0.1:3140/api/logs/insert/jsonline' }).target, '127.0.0.1:3140')
  assert.equal(say('jira_configs', { project: 'OPS', issue_type: 'Incident' }).target, 'OPS · Incident')
})

test('a snooze belongs to the rule its rule_id matcher names, and has a state at any instant', () => {
  const s = { id: 'x', matchers: [{ name: 'rule_id', value: '507', isEqual: true, isRegex: false }], startsAt: '2026-10-15T10:00:00Z', endsAt: '2026-10-15T10:30:00Z' }
  assert.equal(silenceMatchesRule(s, { id: 507 }), true)
  assert.equal(silenceMatchesRule(s, { id: 508 }), false)
  assert.equal(silenceMatchesRule({ ...s, matchers: [{ name: 'rule_id', value: '507', isEqual: false }] }, { id: 507 }), false)
  const at = iso => Date.parse(iso) / 1000
  assert.deepEqual(['2026-10-15T09:59:00Z', '2026-10-15T10:10:00Z', '2026-10-15T10:30:00Z'].map(t => ruleSilences({ id: 507 }, [s], at(t))[0].state), ['pending', 'active', 'expired'])
})

test('a rule\'s mute windows are its schedules\', then its own', () => {
  const muteGroups = [{ id: 2, name: 'Quiet hours', mute: { time_intervals: [{ times: [{ start_time: '21:00', duration_minutes: 600 }], weekdays: [], location: 'Asia/Calcutta' }] } }]
  const rule = { config: { mute_group_ids: [2] }, mute: { time_intervals: [{ times: [{ start_time: '01:00', duration_minutes: 30 }], weekdays: ['monday'], location: 'UTC' }] } }
  assert.deepEqual(ruleMuteIntervals(rule, muteGroups).map(m => [m.scheduleId, m.name]), [[2, 'Quiet hours'], [null, null]])
})

// Production's TestMuteGroup: 21:00 for 10h, every day, Asia/Calcutta (UTC+5:30).
const QUIET = { times: [{ start_time: '21:00', duration_minutes: 600 }], weekdays: [], location: 'Asia/Calcutta' }
const utc = iso => Date.parse(iso) / 1000

test('a mute window is read in its own zone, and one that crosses midnight runs into the next day', () => {
  // 21:00 IST is 15:30 UTC; ten hours later is 01:30 UTC.
  const day = muteStretches(QUIET, utc('2026-10-14T00:00:00Z'), utc('2026-10-16T00:00:00Z'))
  assert.deepEqual(day.map(s => [new Date(s.start * 1000).toISOString(), new Date(s.end * 1000).toISOString()]), [
    ['2026-10-13T15:30:00.000Z', '2026-10-14T01:30:00.000Z'],
    ['2026-10-14T15:30:00.000Z', '2026-10-15T01:30:00.000Z'],
    ['2026-10-15T15:30:00.000Z', '2026-10-16T01:30:00.000Z'],
  ])
  assert.ok(muteCovering(QUIET, utc('2026-10-15T00:00:00Z')), '05:30 IST is inside the 21:00 window')
  assert.equal(muteCovering(QUIET, utc('2026-10-15T09:00:00Z')), null, '14:30 IST is not')
  assert.equal(new Date(nextMute(QUIET, utc('2026-10-15T09:00:00Z')).start * 1000).toISOString(), '2026-10-15T15:30:00.000Z')
})

test('weekdays are the day a window opens on', () => {
  // 2026-10-16 is a Friday. A Friday-only 23:00 UTC window for 2h ends Saturday 01:00.
  const fri = { times: [{ start_time: '23:00', duration_minutes: 120 }], weekdays: ['friday'], location: 'UTC' }
  const week = muteStretches(fri, utc('2026-10-12T00:00:00Z'), utc('2026-10-19T00:00:00Z'))
  assert.deepEqual(week.map(s => new Date(s.start * 1000).toISOString()), ['2026-10-16T23:00:00.000Z'])
  assert.ok(muteCovering(fri, utc('2026-10-17T00:30:00Z')), 'Saturday 00:30 is still Friday\'s window')
})

test('an unknown zone is read as UTC rather than breaking the page; an empty interval mutes nothing', () => {
  const bad = { times: [{ start_time: '10:00', duration_minutes: 60 }], weekdays: [], location: 'Mars/Olympus' }
  assert.deepEqual(muteStretches(bad, utc('2026-10-15T00:00:00Z'), utc('2026-10-15T23:59:00Z')).map(s => new Date(s.start * 1000).toISOString()), ['2026-10-15T10:00:00.000Z'])
  assert.deepEqual(muteStretches({ times: [], weekdays: [] }, 0, 1e9), [])
})
