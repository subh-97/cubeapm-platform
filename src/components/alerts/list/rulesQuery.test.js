// The Rules tab's one selection (docs/alerts/DESIGN.md D3, revised 2026-11-26):
// the URL turned into `{ key: Set }` and back, old links folded onto the new
// keys, and the rules filtered through it.
//
// The risks: a link that no longer filters after the chip rewrite, and a rail
// that counts one way and filters another (checked in alertFilters.test.js).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveWindow } from '@/data/timeWindow'
import { services } from '@/data/services'
import { seededAlerts } from './fixtures.js'
import { parseAlertsSearch, alertsSearch } from '@/utils/alertsUrl'
import {
  selectionFromUrl, selectionToPatch, hasSelection, toggleFilterValue, setTextFilter,
  clearSelection, filterRules, explainNoMatches, quickChipActive, toggleQuickChip,
  QUICK_CHIPS, suggestedRules, selectionToChips, chipsToSelection,
} from './rulesQuery.js'

const win = resolveWindow({ kind: 'preset', value: '1h' })
const { rules } = seededAlerts(win)
const plain = sel => Object.fromEntries(Object.entries(sel).map(([k, v]) => [k, [...v].sort()]))

test('new keys, tag keys and text keys read straight off the URL', () => {
  const sel = selectionFromUrl({ facets: { group: ['Payments'], state: ['firing'], 'tag.kind': ['synthetic'], alert: ['pay'], query: ['cube_'] } })
  assert.deepEqual(plain(sel), { group: ['Payments'], state: ['firing'], 'tag.kind': ['synthetic'], alert: ['pay'], query: ['cube_'] })
})

test('old links still filter: the old keys fold onto the new ones, service and severity read past', () => {
  const sel = selectionFromUrl({
    facets: { status: ['paused'], state: ['critical', 'ok'], notifies: ['Platform team'], suppressed: ['muted'], svc: ['checkout'], severity: ['critical'] },
    q: 'payment label.kind:synthetic',
  })
  assert.deepEqual(plain(sel), {
    enabled: ['off'],
    state: ['firing', 'normal'],
    receiver_group: ['Platform team'],
    muted: ['yes'],
    alert: ['payment'],
    'tag.kind': ['synthetic'],
  })
})

test('an old state=error / state=paused link lands on Health / Enabled', () => {
  assert.deepEqual(plain(selectionFromUrl({ facets: { state: ['error'] } })), { health: ['error'] })
  assert.deepEqual(plain(selectionFromUrl({ facets: { state: ['paused'] } })), { enabled: ['off'] })
})

test('a selection round-trips through the URL', () => {
  const sel = { group: new Set(['Payments']), state: new Set(['firing', 'pending']), enabled: new Set(['off']), 'tag.kind': new Set(['synthetic']), alert: new Set(['pay']) }
  const patch = selectionToPatch(sel)
  assert.equal(patch.q, '', 'the old q is dropped')
  const back = selectionFromUrl(parseAlertsSearch(alertsSearch({ facets: patch.facets })))
  assert.deepEqual(plain(back), plain(sel))
})

test('toggling, text and clear edit the selection', () => {
  let sel = {}
  sel = toggleFilterValue(sel, 'state', 'firing')
  sel = toggleFilterValue(sel, 'state', 'pending')
  assert.deepEqual([...sel.state].sort(), ['firing', 'pending'])
  sel = toggleFilterValue(sel, 'state', 'firing')
  assert.deepEqual([...sel.state], ['pending'])
  sel = setTextFilter(sel, 'alert', 'pay')
  assert.deepEqual([...sel.alert], ['pay'])
  sel = setTextFilter(sel, 'alert', '')
  assert.ok(!('alert' in sel), 'an empty text drops the key')
  assert.ok(hasSelection(sel) && !hasSelection(clearSelection()))
})

test('filtering keeps the severity sort — the survivors stay in rule order', () => {
  const selection = { state: new Set(['firing']) }
  const kept = filterRules(rules, selection)
  const ranks = kept.map(r => r.rank)
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b))
  assert.ok(kept.length > 0 && kept.every(r => r.state === 'firing'))
  assert.equal(filterRules(rules, {}).length, rules.length, 'no selection keeps every rule')
})

test('a quick chip is active when its values are selected, and toggles them', () => {
  const firing = QUICK_CHIPS.find(c => c.id === 'firing')
  let sel = {}
  assert.ok(!quickChipActive(sel, firing))
  sel = toggleQuickChip(sel, firing)
  assert.ok(quickChipActive(sel, firing) && [...sel.state].includes('firing'))
  sel = toggleQuickChip(sel, firing)
  assert.ok(!quickChipActive(sel, firing) && !hasSelection(sel))
})

test('a toggle-key quick chip replaces, never leaving a boolean key holding both values', () => {
  // Rail sets Enabled = On; the "Switched off" chip must not OR Off onto it
  // (enabled: {on, off} would match every rule).
  const off = QUICK_CHIPS.find(c => c.id === 'off')
  const next = toggleQuickChip({ enabled: new Set(['on']) }, off)
  assert.deepEqual([...next.enabled], ['off'])
  // And it still toggles back off cleanly.
  assert.ok(!hasSelection(toggleQuickChip(next, off)))
})

test('the selection round-trips through the builder\'s chips (eq, in, contains)', () => {
  const sel = { state: new Set(['firing']), group: new Set(['Payments', 'Checkout']), alert: new Set(['pay']), 'tag.kind': new Set(['synthetic']) }
  const chips = selectionToChips(sel)
  assert.ok(chips.find(c => c.field === 'group')?.op === 'in', 'a multi-value key is an in-list chip')
  assert.ok(chips.find(c => c.field === 'state')?.op === 'eq', 'a single value is an exact chip')
  assert.ok(chips.find(c => c.field === 'alert')?.op === 'contains', 'a text key is a contains chip')
  assert.deepEqual(plain(chipsToSelection(chips)), plain(sel))
  // A negation the builder can make has no rail home and is dropped.
  assert.deepEqual(chipsToSelection([{ field: 'state', op: 'neq', value: 'firing' }]), {})
})

test('the empty state names every selected value with its count, text filters included', () => {
  const selection = { source: new Set(['nosuch']), alert: new Set(['xyz']) }
  const { filters } = explainNoMatches(rules, selection)
  const source = filters.find(f => f.key === 'source')
  assert.ok(source && source.count === 0 && source.title === 'Source')
  const name = filters.find(f => f.key === 'alert')
  assert.ok(name && name.count == null && name.label === 'xyz', 'a text filter has no count')
})

test('suggestedRules still offers an error-rate rule per uncovered service', () => {
  const out = suggestedRules(services, [])
  assert.ok(out.length > 0 && out[0].spec.calculate === 'error_percentage')
})
