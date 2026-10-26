// The words above the rules (docs/alerts/DESIGN.md D2, D16), over the seed
// and over a calm day.
//
// The risks: leading with a rule somebody has already silenced or with
// whichever critical rule sorts first by name, a band that says "Nothing
// firing" while something is, and one stale line per failed poll (R43)
// instead of one line.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveWindow } from '@/data/timeWindow'
import { seededAlerts, quietAlerts } from './fixtures.js'
import {
  worstFiring, bannerFacts, quietLine, lastResolvedAt, updatedText, staleText,
} from './firingSummary.js'

const hour = resolveWindow({ kind: 'preset', value: '1h' })
const seeded = seededAlerts(hour)

test('the worst unsilenced rule is payment-service\'s error rate, said against its threshold', () => {
  const worst = worstFiring(seeded.rules)
  assert.equal(String(worst.id), '501')
  assert.match(bannerFacts(worst, hour.nowSec), /^[\d.]+% now, [\d.]+× its 3% critical threshold, firing for \d+m$/)
  // The list's own tie-break is the name, which would have led with a host's CPU.
  assert.notEqual(String(seeded.rules[0].id), '501')
})

test('a snoozed or muted rule is never the one to lead with', () => {
  const onlyHeld = seeded.rules.filter(r => r.suppression || r.state !== 'firing')
  const worst = worstFiring(onlyHeld)
  assert.equal(worst, null)
})

test('a calm day is one line: nothing firing, and when the last alert resolved', () => {
  const quietHour = quietAlerts(hour)
  assert.equal(worstFiring(quietHour.rules), null)
  assert.equal(quietLine({ rules: quietHour.rules, timeline: quietHour.timeline, win: hour }), 'Nothing firing · no alert fired in the last 1 hour')
  const six = resolveWindow({ kind: 'preset', value: '6h' })
  const quietSix = quietAlerts(six)
  assert.equal(lastResolvedAt(quietSix.timeline), six.nowSec - 3 * 3600)
  assert.equal(quietLine({ rules: quietSix.rules, timeline: quietSix.timeline, win: six }), 'Nothing firing · last alert resolved 3h ago')
})

test('nothing unsilenced firing still owns up to what fires under a snooze or a mute', () => {
  const held = seeded.rules.filter(r => r.suppression || r.state !== 'firing')
  const n = held.filter(r => r.state === 'firing').length
  assert.match(quietLine({ rules: held, timeline: [], win: hour }), new RegExp(`^Nothing firing · ${n} more firing under a snooze or mute · `))
})

test('how old the list is, and the one line a failed refresh shows', () => {
  const now = 1_792_000_000_000
  // "just now" for the whole first minute, never a count of seconds.
  for (const s of [0, 2, 12, 36, 59]) assert.equal(updatedText(now / 1000 - s, now), 'Updated just now', `${s}s`)
  assert.equal(updatedText(now / 1000 - 60, now), 'Updated 1m ago')
  assert.equal(updatedText(now / 1000 - 180, now), 'Updated 3m ago')
  assert.equal(updatedText(undefined, now), null)
  assert.equal(staleText(null), null)
  assert.match(staleText({ since: 1_792_000_000 }), /^Couldn't refresh, showing data from \d\d:\d\d$/)
})
