// The Rules tab's facets and search (docs/alerts/DESIGN.md D3), over the seed
// as the page shell hands it over.
//
// The risk: a rail that counts one way and filters another, or a link that
// names a value no rule has and leaves the reader looking at an empty list
// with nothing on screen saying why. Production also searched label keys but
// not their values (R18), so the search is checked on values too.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveWindow } from '@/data/timeWindow'
import { services } from '@/data/services'
import { seededAlerts } from './fixtures.js'
import {
  RULE_FACETS, buildRuleFacets, applyRuleFacets, selectionFromUrl, toggleFacetValue, clearRuleFacets,
  filterRules, parseRuleSearch, explainNoMatches, facetValueLabel, suggestedRules,
} from './rulesQuery.js'

const win = resolveWindow({ kind: 'preset', value: '1h' })
const { rules } = seededAlerts(win)
const ids = list => list.map(r => String(r.id))
const search = q => ids(filterRules(rules, {}, parseRuleSearch(q)))

test('the rail is D3\'s nine facets, in its order, under the URL\'s own keys', () => {
  assert.deepEqual(RULE_FACETS.map(f => f.title), ['State', 'Severity', 'Group', 'Service', 'Source', 'Type', 'Notifies', 'Status', 'Suppressed'])
  assert.deepEqual(RULE_FACETS.map(f => f.key), ['state', 'severity', 'group', 'svc', 'source', 'type', 'notifies', 'status', 'suppressed'])
})

test('facet counts are over every rule, whatever else is selected', () => {
  const all = buildRuleFacets(rules, {})
  const narrowed = buildRuleFacets(rules, selectionFromUrl({ state: ['critical'], group: ['Payments'] }))
  assert.deepEqual(narrowed.group, all.group, 'a group\'s count does not shrink because a state is picked')
  const total = all.state.reduce((n, o) => n + o.count, 0)
  assert.equal(total, rules.length, 'every rule has exactly one state')
  assert.equal(all.status.find(o => o.value === 'paused').count, 4, 'four synthetic monitors are paused')
})

test('closed sets keep their order; open sets sort by count', () => {
  const f = buildRuleFacets(rules, {})
  const order = ['critical', 'warning', 'pending', 'error', 'ok', 'nodata', 'paused']
  const states = f.state.map(o => o.value)
  assert.deepEqual(states, order.filter(s => states.includes(s)))
  const counts = f.group.map(o => o.count)
  assert.deepEqual(counts, [...counts].sort((a, b) => b - a))
})

test('a value a link seeded stays in the rail at 0, and the list says what emptied it', () => {
  const selection = selectionFromUrl({ state: ['error'], svc: ['no-such-service'] })
  const facets = buildRuleFacets(rules, selection)
  assert.deepEqual(facets.svc.find(o => o.value === 'no-such-service'), { value: 'no-such-service', count: 0 })
  assert.equal(filterRules(rules, selection, null).length, 0)
  const why = explainNoMatches(rules, selection, 'redis')
  assert.deepEqual(why.filters.map(f => [f.title, f.label, f.count]), [['State', 'Rule error', 1], ['Service', 'no-such-service', 0]])
  assert.equal(why.search, 'redis')
})

test('values are ORed inside a facet and facets are ANDed', () => {
  const either = applyRuleFacets(rules, selectionFromUrl({ state: ['pending', 'error'] }))
  assert.deepEqual(ids(either).sort(), ['503', '513'])
  const both = applyRuleFacets(rules, selectionFromUrl({ state: ['critical'], svc: ['payment-service'] }))
  assert.ok(both.length >= 2 && both.every(r => r.stateKey === 'critical' && r.scope.service === 'payment-service'))
})

test('severity is the highest tier a rule defines, not its state', () => {
  const critical = applyRuleFacets(rules, selectionFromUrl({ severity: ['critical'] }))
  assert.ok(critical.some(r => r.state === 'ok'), 'an OK rule with a critical tier is still severity critical')
})

test('a rule with no service is filterable as "No service", and a synthetic rule says Synthetic', () => {
  const none = applyRuleFacets(rules, selectionFromUrl({ svc: ['No service'] }))
  assert.ok(none.length > 0 && none.every(r => !r.scope.service))
  const synthetic = applyRuleFacets(rules, selectionFromUrl({ source: ['synthetic'] }))
  assert.deepEqual(ids(synthetic).sort(), ['426', '427', '428', '432', '433'])
  assert.equal(facetValueLabel('source', 'slo'), 'SLO')
  assert.equal(facetValueLabel('status', 'paused'), 'Paused')
})

test('the search reads name:, group:, service: and label:, and free text reads label values', () => {
  assert.ok(search('name:payment').includes('501'))
  assert.deepEqual(search('service:order-service').sort(), ['505', '506'])
  assert.deepEqual(search('group:Fulfilment'), ['507'])
  assert.deepEqual(search('redis'), ['514'], 'free text over names')
  // The host is a label only an alert carries: production searched label keys, never values.
  assert.deepEqual(search('ip-10-0-143-40'), ['515'])
  assert.deepEqual(search('label.host.name:ip-10-0-142-2'), ['515'])
  assert.deepEqual(search('label.kind:synthetic').sort(), ['426', '427', '428', '432', '433'])
})

test('filtering never reorders: the severity sort survives a search', () => {
  const hit = filterRules(rules, {}, parseRuleSearch('payment'))
  const positions = hit.map(r => rules.indexOf(r))
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b))
})

test('a search that does not parse filters nothing rather than everything', () => {
  assert.equal(parseRuleSearch('name:(payment'), null)
  assert.equal(filterRules(rules, {}, parseRuleSearch('name:(payment')).length, rules.length)
})

test('toggling a value writes the facets back without empty keys, and clearing leaves other tabs\' keys', () => {
  const on = toggleFacetValue({ state: ['critical'] }, 'state', 'warning')
  assert.deepEqual(on, { state: ['critical', 'warning'] })
  assert.deepEqual(toggleFacetValue(on, 'state', 'critical'), { state: ['warning'] })
  assert.deepEqual(toggleFacetValue({ state: ['critical'] }, 'state', 'critical'), {})
  assert.deepEqual(clearRuleFacets({ state: ['critical'], svc: ['x'], event: ['fired'] }), { event: ['fired'] })
})

test('an empty workspace is offered an error-rate rule for each uncovered service, at the card thresholds', () => {
  const suggestions = suggestedRules(services, [])
  assert.equal(suggestions[0].service, services[0].id, 'worst service first')
  assert.equal(suggestions[0].sentence, 'Error % > 3% critical, > 1% warning, for 5m')
  const covered = suggestedRules(services, rules)
  assert.ok(covered.every(s => !rules.some(r => r.scope.service === s.service)))
})
