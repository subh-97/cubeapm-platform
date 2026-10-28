// The rules behind the shared alert controls, apart from any rendering: what a
// rule's Actions menu offers and why an item is disabled, what a custom snooze
// resolves to, and how a snooze or mute reads on its chip.
//
// The risks: an SLO rule offering Pause or Delete, which would contradict the
// SLO's own switch (DESIGN D18); a custom snooze with no duration reaching the
// store; a snooze's time-left reading "0m" while it is still running; and the
// menu's arrow keys landing on a separator or a disabled item.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SNOOZE_PRESETS, suppressionText, customSnoozeSpec,
  ruleActionItems, snoozeBlockedReason, nextMenuIndex, radioGroupKeyDown,
} from './alertShared.js'

const ids = items => items.filter(i => !i.sep).map(i => i.id)

test('the snooze presets are production\'s, in production\'s order and spelling', () => {
  assert.deepEqual(SNOOZE_PRESETS.map(p => p.id), ['5m', '15m', '30m', '1h'])
  assert.deepEqual(SNOOZE_PRESETS.map(p => p.minutes), [5, 15, 30, 60])
  assert.deepEqual(SNOOZE_PRESETS.map(p => p.spoken), ['5 minutes', '15 minutes', '30 minutes', '1 hour'])
})

test('an ordinary rule offers pause, edit, clone, history, link and delete, each a word', () => {
  const items = ruleActionItems({ id: 'r1', name: 'x', status: 'ACTIVE', managedBy: null })
  assert.deepEqual(ids(items), ['pause', 'edit', 'clone', 'history', 'copyLink', 'delete'])
  for (const i of items.filter(x => !x.sep)) assert.ok(i.label && i.label.trim(), `${i.id} has a label`)
  assert.ok(items.find(i => i.id === 'delete').danger)
})

test('a paused rule offers Resume where an active one offers Pause', () => {
  const items = ruleActionItems({ id: 'r1', name: 'x', status: 'PAUSED' })
  assert.ok(ids(items).includes('resume'))
  assert.ok(!ids(items).includes('pause'))
})

test('an SLO rule keeps its history and link, and leaves changes to its SLO', () => {
  const items = ruleActionItems({ id: 's1', name: 'x', status: 'ACTIVE', managedBy: { kind: 'slo' } })
  assert.deepEqual(ids(items), ['history', 'copyLink', 'editInSlo'])
  const edit = items.find(i => i.id === 'editInSlo')
  assert.ok(edit.disabled)
  assert.equal(edit.title, 'The SLO page comes later')
})

test('a synthetic rule is editable here, like any other', () => {
  const items = ruleActionItems({ id: 'm1', name: 'x', status: 'ACTIVE', managedBy: { kind: 'synthetic', monitorName: 'Docs' } })
  assert.ok(ids(items).includes('edit'))
  assert.ok(!items.find(i => i.id === 'edit').disabled)
})

test('a read-only rule can be read and cloned, and says why it cannot be changed', () => {
  const items = ruleActionItems({ id: 'r1', name: 'x', status: 'ACTIVE', readonly: true })
  for (const id of ['pause', 'edit', 'delete']) {
    const item = items.find(i => i.id === id)
    assert.ok(item.disabled, `${id} is disabled`)
    assert.equal(item.title, 'This rule is read-only')
  }
  assert.ok(!items.find(i => i.id === 'clone').disabled)
  assert.ok(!items.find(i => i.id === 'history').disabled)
})

test('snooze is blocked only where there is nothing to hold or nothing may change', () => {
  assert.equal(snoozeBlockedReason({ status: 'ACTIVE' }), null)
  assert.match(snoozeBlockedReason({ status: 'PAUSED' }), /paused/)
  assert.match(snoozeBlockedReason({ status: 'ACTIVE', readonly: true }), /read-only/)
})

test('an SLO rule can be snoozed although the model marks it read-only (D18)', () => {
  // The model sets readonly on SLO rules, because their configuration is the
  // SLO's; snoozing holds notifications and changes none of it.
  assert.equal(snoozeBlockedReason({ status: 'ACTIVE', readonly: true, managedBy: { kind: 'slo' } }), null)
  assert.equal(snoozeBlockedReason({ status: 'ACTIVE', managedBy: { kind: 'slo' } }), null)
})

test('a custom snooze floors its start to the minute and needs a duration', () => {
  const start = 1_800_000_037
  assert.deepEqual(
    customSnoozeSpec({ startSec: start, hours: '2', minutes: '0', comment: '  waiting on the fix ' }),
    { start: 1_800_000_000, end: 1_800_000_000 + 7200, comment: 'waiting on the fix' },
  )
  assert.equal(customSnoozeSpec({ startSec: start, hours: '0', minutes: '0' }), null)
  assert.equal(customSnoozeSpec({ startSec: start, hours: '-1', minutes: '30' }), null)
  assert.equal(customSnoozeSpec({ startSec: NaN, hours: '1', minutes: '0' }), null)
  assert.equal(customSnoozeSpec({ startSec: start, hours: '0', minutes: '45' }).end, 1_800_000_000 + 2700)
})

test('an active snooze says how long is left; a scheduled one says when it starts', () => {
  const now = 1_800_000_000
  const active = suppressionText({ kind: 'snooze', startsAt: now - 600, endsAt: now + 23 * 60, createdBy: 'maya', comment: 'known' }, now)
  assert.equal(active.text, 'Snoozed · 23m left')
  assert.match(active.title, /by maya: known$/)
  const scheduled = suppressionText({ kind: 'snooze', startsAt: now + 3600, endsAt: now + 7200, scheduled: true }, now)
  assert.match(scheduled.text, /^Snooze from \d\d:\d\d|^Snooze from [A-Z][a-z]{2} \d\d \d\d:\d\d/)
  assert.match(scheduled.title, /^Snooze scheduled /)
})

test('a snooze in its last seconds counts seconds, never "0m left"', () => {
  const now = 1_800_000_000
  assert.equal(suppressionText({ kind: 'snooze', startsAt: now - 60, endsAt: now + 20 }, now).text, 'Snoozed · 20s left')
  assert.equal(suppressionText({ kind: 'snooze', startsAt: now - 60, endsAt: now + 90 * 60 }, now).text, 'Snoozed · 1h 30m left')
})

test('a mute names its schedule, and says only "Muted" when it has no end', () => {
  const now = 1_800_000_000
  const t = suppressionText({ kind: 'mute', name: 'Maintenance window', until: now + 3600 }, now)
  assert.match(t.text, /^Muted until /)
  assert.match(t.title, /"Maintenance window" schedule/)
  assert.equal(suppressionText({ kind: 'mute', name: 'x', until: null }, now).text, 'Muted')
  assert.equal(suppressionText(null, now), null)
})

test('arrow keys skip separators and disabled items, and wrap', () => {
  const items = [{ id: 'a' }, { sep: true }, { id: 'b', disabled: true }, { id: 'c' }]
  assert.equal(nextMenuIndex(items, -1, 1), 0)
  assert.equal(nextMenuIndex(items, 0, 1), 3)
  assert.equal(nextMenuIndex(items, 3, 1), 0)
  assert.equal(nextMenuIndex(items, 0, -1), 3)
  assert.equal(nextMenuIndex([{ sep: true }], -1, 1), -1)
  assert.equal(nextMenuIndex([], -1, 1), -1)
})

test('a radio group\'s arrows move to the next option and choose it, past one that is unavailable', () => {
  const chosen = []
  const radio = (name, { checked = false, unavailable = false } = {}) => ({
    name,
    disabled: false,
    getAttribute: a => (a === 'aria-checked' ? String(checked) : a === 'aria-disabled' && unavailable ? 'true' : null),
    focus() { globalThis.document.activeElement = this },
    click() { chosen.push(name) },
  })
  const radios = [radio('static', { checked: true }), radio('blocked', { unavailable: true }), radio('anomaly')]
  const saved = globalThis.document
  globalThis.document = { activeElement: radios[0] }
  try {
    const key = (k) => {
      let prevented = false
      radioGroupKeyDown({ key: k, currentTarget: { querySelectorAll: () => radios }, preventDefault: () => { prevented = true } })
      return prevented
    }
    assert.equal(key('ArrowRight'), true)
    assert.equal(globalThis.document.activeElement.name, 'anomaly', 'the unavailable option is skipped')
    assert.deepEqual(chosen, ['anomaly'], 'moving chooses')
    key('ArrowRight')
    assert.equal(globalThis.document.activeElement.name, 'static', 'and wraps')
    key('End')
    assert.equal(globalThis.document.activeElement.name, 'anomaly')
    assert.equal(key('Tab'), false, 'any other key is left alone')
  } finally {
    globalThis.document = saved
  }
})
