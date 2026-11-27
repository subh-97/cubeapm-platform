// How the Rules list is laid out and how its rows behave (docs/alerts/
// DESIGN.md D1, D3), over the seed at Last 1 hour.
//
// The risks are production's own defects: rules sorted A→Z with the only
// firing one buried (R6), paused rules at full height hiding the one that
// fires (R47), and a row that only its chevron toggles (R12), here with the
// opposite mistake to avoid: a click on the name link or a menu must not
// toggle the row underneath it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveWindow } from '@/data/timeWindow'
import { seededAlerts } from './fixtures.js'
import {
  listRules, byUrgency, isPaused, isFolded, asksForPaused, foldText, toggleExpanded, withUrlRule,
  clickTogglesRow, isPlainClick, rowStep, ruleDomId,
} from './rulesList.js'

const win = resolveWindow({ kind: 'preset', value: '1h' })
const { rules } = seededAlerts(win)

test('rules come worst first: unsuppressed critical, warning, pending, error, suppressed, OK, no data, paused', () => {
  const ranks = rules.map(r => r.rank)
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b))
  assert.equal(rules[0].stateKey, 'critical')
  assert.equal(rules.at(-1).state, 'paused')
  const snoozed = rules.find(r => String(r.id) === '507')
  assert.equal(snoozed.suppression?.kind, 'snooze')
  assert.ok(rules.indexOf(snoozed) > rules.findIndex(r => r.state === 'error'), 'a snoozed rule that fires sorts below a rule that cannot evaluate')
  assert.ok(rules.indexOf(snoozed) < rules.findIndex(r => r.state === 'ok'), 'and above every OK rule')
})

test('one list, worst first, with no groups: the incident leads, whatever its group is called', () => {
  const list = listRules(rules)
  assert.equal(String(list.rules[0].id), '501')
  const ranks = list.rules.map(r => r.rank)
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b))
  assert.ok(!('key' in list) && !('label' in list), 'no group to head it')
  // Rules from different groups interleave by how bad they are, never by group.
  const groupsInOrder = list.rules.map(r => r.group)
  const firstRunOf = g => groupsInOrder.indexOf(g)
  const lastRunOf = g => groupsInOrder.lastIndexOf(g)
  assert.ok(new Set(groupsInOrder).size > 1)
  assert.ok([...new Set(groupsInOrder)].some(g => groupsInOrder.slice(firstRunOf(g), lastRunOf(g) + 1).some(x => x !== g)), 'groups are not kept together')
})

test('within a state, the rule furthest past its threshold leads; the name only breaks a tie', () => {
  const critical = listRules(rules).rules.filter(r => r.stateKey === 'critical')
  const multiples = critical.map(r => r.thresholdMultiple)
  assert.deepEqual(multiples, [...multiples].sort((a, b) => b - a), 'furthest past first')
  assert.notDeepEqual(critical.map(r => r.name), critical.map(r => r.name).sort((a, b) => a.localeCompare(b)), 'not A→Z')
  const v = (rank, thresholdMultiple, name) => ({ rank, thresholdMultiple, name })
  assert.ok(byUrgency(v(0, 1.2, 'b'), v(1, 9, 'a')) < 0, 'a worse state wins over a bigger multiple')
  assert.ok(byUrgency(v(0, 1.2, 'a'), v(0, 4, 'b')) > 0)
  assert.ok(byUrgency(v(0, null, 'a'), v(0, 1.1, 'b')) > 0, 'past no threshold sorts after one past it')
  assert.ok(byUrgency(v(0, 2, 'Alpha'), v(0, 2, 'beta')) < 0, 'a tie falls to the name, case aside')
})

test('paused rules fold to one line at the list\'s end, unless asked for or opened', () => {
  const paused = rules.filter(isPaused)
  const list = listRules(rules)
  assert.equal(list.pausedCount, paused.length)
  assert.equal(list.foldOpen, false)
  assert.ok(list.rules.every(r => !isPaused(r)), 'no paused rule has a row')
  assert.equal(list.rules.length + list.paused.length, rules.length)
  assert.equal(foldText(list.pausedCount), `${paused.length} paused rules`)
  assert.equal(foldText(1), '1 paused rule')

  const opened = listRules(rules, { foldOpen: true })
  assert.equal(opened.foldOpen, true)
  assert.equal(opened.rules.length, rules.length)
  assert.ok(opened.rules.slice(-paused.length).every(isPaused), 'opened, they follow every other rule')

  const asked = listRules(rules, { unfoldPaused: true })
  assert.equal(asked.paused.length, 0)
  assert.deepEqual(listRules([]), { rules: [], paused: [], pausedCount: 0, pinnedCount: 0, foldOpen: true })
})

test('pinned rules lead the list, worst first among themselves, then everything else worst first', () => {
  const unpinned = listRules(rules)
  const ok = unpinned.rules.find(r => r.state === 'ok')
  const warning = unpinned.rules.find(r => r.stateKey === 'warning')
  const pinned = new Set([String(ok.id), String(warning.id)])
  const list = listRules(rules, { pinned })
  assert.equal(list.pinnedCount, 2)
  assert.deepEqual(list.rules.slice(0, 2).map(r => r.id), [warning.id, ok.id], 'the warning above the OK one, whichever was pinned first')
  const rest = list.rules.slice(2)
  assert.equal(String(rest[0].id), '501', 'the incident leads everything unpinned')
  assert.deepEqual(rest.map(r => r.id), unpinned.rules.filter(r => !pinned.has(String(r.id))).map(r => r.id), 'the rest keep their order')
  assert.equal(list.rules.length, unpinned.rules.length, 'a pin moves a rule, never adds or drops one')
  assert.equal(listRules(rules, { pinned: new Set(['no-such-rule']) }).pinnedCount, 0, 'a pin on a deleted rule pins nothing')
})

test('a pinned paused rule is never folded away; the fold counts only the unpinned ones', () => {
  const paused = rules.filter(isPaused)
  const one = paused[0]
  const list = listRules(rules, { pinned: new Set([String(one.id)]) })
  assert.equal(list.rules[0].id, one.id, 'it leads, paused and all')
  assert.equal(list.pausedCount, paused.length - 1)
  assert.ok(!list.paused.some(r => r.id === one.id))
  assert.ok(!isFolded(list, one.id))
  const opened = listRules(rules, { pinned: new Set([String(one.id)]), foldOpen: true })
  assert.equal(opened.rules.filter(r => r.id === one.id).length, 1, 'opening the fold does not draw it twice')
  const all = listRules(paused, { pinned: new Set(paused.map(r => String(r.id))) })
  assert.equal(all.pausedCount, 0)
  assert.equal(all.foldOpen, true, 'every paused rule pinned: nothing to fold')
})

test('a filter for switched-off rules, or a name or query search, unfolds the paused ones', () => {
  assert.equal(asksForPaused({ enabled: new Set(['off']) }), true)
  assert.equal(asksForPaused({ alert: new Set(['docs']) }), true)
  assert.equal(asksForPaused({ query: new Set(['cube']) }), true)
  assert.equal(asksForPaused({ state: new Set(['firing']) }), false, 'a plain state filter does not')
  assert.equal(asksForPaused({}), false)
})

test('more than one row can be open; a link\'s rule_id opens its row and finds it in the fold', () => {
  let open = new Set()
  open = toggleExpanded(open, 501)
  open = toggleExpanded(open, 502)
  assert.deepEqual([...open], ['501', '502'])
  assert.deepEqual([...toggleExpanded(open, '501')], ['502'], 'the URL\'s "501" and a view\'s 501 are one row')
  assert.deepEqual([...withUrlRule(new Set(), '427')], ['427'])
  const same = new Set(['427'])
  assert.equal(withUrlRule(same, 427), same, 'already open: the same set, so nothing re-renders')
  assert.equal(withUrlRule(same, null), same)

  assert.equal(isFolded(listRules(rules), '427'), true, 'a paused rule is found inside the fold, by the URL\'s id')
  assert.equal(isFolded(listRules(rules), '501'), false)
  assert.equal(isFolded(listRules(rules, { foldOpen: true }), '427'), false)
})

// A minimal element: what clickTogglesRow reads while walking up from a click.
function el(tagName, attrs = {}, parent = null) {
  return {
    tagName,
    parentElement: parent,
    hasAttribute: name => Object.prototype.hasOwnProperty.call(attrs, name),
    getAttribute: name => attrs[name] ?? null,
  }
}

test('a click toggles the row from anywhere on it except its link, its menus and what they open', () => {
  const row = el('DIV')
  const toggle = el('BUTTON', { 'data-row-toggle': '' }, row)
  const chevron = el('svg', {}, toggle)
  const main = el('DIV', {}, row)
  const sentence = el('SPAN', {}, main)
  const link = el('A', { href: '/alerts/501' }, main)
  const linkText = el('SPAN', {}, link)
  const actions = el('DIV', { 'data-no-row-toggle': '' }, row)
  const menuButton = el('BUTTON', {}, actions)
  const dialogBackdrop = el('DIV', {}, actions)
  const menuItem = el('DIV', { role: 'menuitem' }, row)

  assert.equal(clickTogglesRow(sentence, row), true, 'the sentence')
  assert.equal(clickTogglesRow(main, row), true, 'empty space in the row')
  assert.equal(clickTogglesRow(row, row), true, 'the row itself')
  assert.equal(clickTogglesRow(chevron, row), true, 'the toggle, Enter and Space included')
  assert.equal(clickTogglesRow(link, row), false, 'the name opens the rule instead')
  assert.equal(clickTogglesRow(linkText, row), false)
  assert.equal(clickTogglesRow(menuButton, row), false, 'Snooze and Actions')
  assert.equal(clickTogglesRow(dialogBackdrop, row), false, 'a dialog a menu opened')
  assert.equal(clickTogglesRow(menuItem, row), false)
  assert.equal(clickTogglesRow(el('DIV'), row), false, 'nothing outside the row')
})

test('only a plain click is the page\'s; a modified one opens the link the browser\'s way', () => {
  assert.equal(isPlainClick({ button: 0 }), true)
  for (const mod of ['metaKey', 'ctrlKey', 'shiftKey', 'altKey']) assert.equal(isPlainClick({ button: 0, [mod]: true }), false, mod)
  assert.equal(isPlainClick({ button: 1 }), false, 'the middle button')
})

test('↑ and ↓ step between rows without wrapping; Home and End go to the ends', () => {
  assert.equal(rowStep(0, 3, 'ArrowDown'), 1)
  assert.equal(rowStep(2, 3, 'ArrowDown'), null)
  assert.equal(rowStep(0, 3, 'ArrowUp'), null)
  assert.equal(rowStep(2, 3, 'Home'), 0)
  assert.equal(rowStep(0, 3, 'End'), 2)
  assert.equal(rowStep(0, 3, 'Enter'), null)
})

test('a row\'s DOM id is safe whatever its rule id holds', () => {
  const id = ruleDomId('rtab-rule', 'Checkout & orders/a b')
  assert.match(id, /^[A-Za-z0-9_-]+$/)
  assert.notEqual(ruleDomId('x', 'a/b'), ruleDomId('x', 'a_b'))
})
