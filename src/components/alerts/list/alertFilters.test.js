// The Rules tab's filter catalog (docs/alerts/DESIGN.md D3, revised 2026-11-26):
// one vocabulary read the same way by the chips, the rail, the counts and the
// URL. The risk the old split had — a rail that counts one way and filters
// another — is held off here by checking the counts against the filter.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveWindow } from '@/data/timeWindow'
import { seededAlerts } from './fixtures.js'
import {
  ALERT_FILTERS, FILTER_BY_KEY, matchSelection, buildFilterValues, tagKeysOf,
  QUICK_CHIPS, filterLabel, keyLabel, ruleNameText,
} from './alertFilters.js'

const win = resolveWindow({ kind: 'preset', value: '1h' })
const { rules } = seededAlerts(win)
const byId = id => rules.find(r => String(r.id) === String(id))
const sel = obj => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, new Set(v)]))
const matching = selection => rules.filter(r => matchSelection(r, selection))

test('the catalog is the spec\'s 15 filters, in the rail\'s order, by control', () => {
  assert.deepEqual(ALERT_FILTERS.map(f => f.key), [
    'group', 'alert', 'state', 'enabled', 'health', 'source', 'tag', 'receiver_group',
    'has_receiver', 'muted', 'type', 'receiver_type', 'mute_group', 'grouping', 'query',
  ])
  assert.equal(FILTER_BY_KEY.get('alert').control, 'text')
  assert.equal(FILTER_BY_KEY.get('query').control, 'text')
  assert.deepEqual(['enabled', 'has_receiver', 'muted', 'grouping'].map(k => FILTER_BY_KEY.get(k).control), ['toggle', 'toggle', 'toggle', 'toggle'])
  assert.equal(FILTER_BY_KEY.get('tag').control, 'tag')
})

test('every enum and toggle value filters to exactly the rules its count names', () => {
  // The invariant that the old two-mechanism design kept breaking: the number
  // the rail shows beside a value is the number the filter leaves.
  const values = buildFilterValues(rules, {}, tagKeysOf(rules))
  for (const [key, options] of Object.entries(values)) {
    for (const { value, count } of options) {
      assert.equal(matching(sel({ [key]: [value] })).length, count, `${key}=${value}`)
    }
  }
})

test('values are ORed within a key and keys are ANDed across', () => {
  const firing = matching(sel({ state: ['firing'] }))
  const pending = matching(sel({ state: ['pending'] }))
  const both = matching(sel({ state: ['firing', 'pending'] }))
  assert.equal(both.length, firing.length + pending.length, 'OR within state')
  assert.ok(both.length > firing.length)
  // AND across: Payments group AND firing is a subset of each.
  const grp = byId(501).group
  const byGroup = matching(sel({ group: [grp] }))
  const andAcross = matching(sel({ group: [grp], state: ['firing'] }))
  assert.ok(andAcross.length <= Math.min(byGroup.length, firing.length))
  assert.ok(andAcross.every(r => r.group === grp && matchSelection(r, sel({ state: ['firing'] }))))
})

test('a text filter is a case-insensitive substring of the name or the query', () => {
  const pay = matching(sel({ alert: ['PAYMENT'] }))
  assert.ok(pay.length > 0)
  assert.ok(pay.every(r => ruleNameText(r).toLowerCase().includes('payment')))
  assert.ok(matching(sel({ alert: ['no-such-rule-name-xyz'] })).length === 0)
  const q = matching(sel({ query: ['cube_'] }))
  assert.ok(q.length > 0, 'a query substring matches the rules whose PromQL holds it')
})

test('a tag filter matches one of a label\'s values; health and enabled read paused/erroring rules', () => {
  const tagKeys = tagKeysOf(rules)
  assert.ok(tagKeys.includes('kind'), 'synthetic rules carry a kind tag')
  const synthetic = matching(sel({ 'tag.kind': ['synthetic'] }))
  assert.ok(synthetic.length > 0 && synthetic.every(r => r.tags?.kind === 'synthetic' || r.state === 'paused'))
  // Health and Enabled address rules that State (firing/pending/normal) cannot.
  assert.ok(matching(sel({ health: ['error'] })).every(r => r.health === 'error'))
  assert.ok(matching(sel({ enabled: ['off'] })).every(r => r.status === 'PAUSED'))
})

test('a seeded-but-absent value stays listed at 0 so it can be unticked', () => {
  const values = buildFilterValues(rules, sel({ source: ['nosuchsource'] }), [])
  const seeded = values.source.find(o => o.value === 'nosuchsource')
  assert.ok(seeded && seeded.count === 0)
  assert.equal(matching(sel({ source: ['nosuchsource'] })).length, 0)
})

test('the quick chips are the spec\'s four presets', () => {
  assert.deepEqual(QUICK_CHIPS.map(c => c.id), ['firing', 'off', 'no_receiver', 'muted'])
  assert.deepEqual(QUICK_CHIPS.find(c => c.id === 'firing').sel, { state: ['firing'] })
  assert.deepEqual(QUICK_CHIPS.find(c => c.id === 'no_receiver').sel, { has_receiver: ['no'] })
})

test('labels: a value reads for people, a key by its spec name', () => {
  assert.equal(filterLabel('state', 'firing'), 'Firing')
  assert.equal(filterLabel('enabled', 'off'), 'Off')
  assert.equal(filterLabel('source', 'metrics'), 'Metrics')
  assert.equal(keyLabel('alert'), 'Alert name')
  assert.equal(keyLabel('receiver_group'), 'Receiver group')
})
