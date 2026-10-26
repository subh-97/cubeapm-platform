// How the Rules list is laid out and how its rows behave (docs/alerts/
// DESIGN.md D1, D3), over the seed at Last 1 hour.
//
// The risks are production's own defects: groups sorted A→Z with the only
// firing one buried last (R6), paused rules at full height hiding the one that
// fires (R47), and a row that only its chevron toggles (R12), here with the
// opposite mistake to avoid: a click on the name link or a menu must not
// toggle the row underneath it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveWindow } from '@/data/timeWindow'
import { ALERT_ORDER } from '@/utils/alerts/model'
import { seededAlerts } from './fixtures.js'
import {
  listGroups, asksForPaused, groupHeaderText, foldText, toggleExpanded, withUrlRule, groupKeyOf,
  clickTogglesRow, isPlainClick, rowStep, ruleDomId,
} from './rulesList.js'
import { selectionFromUrl } from './rulesQuery.js'

const win = resolveWindow({ kind: 'preset', value: '1h' })
const { rules } = seededAlerts(win)
const rank = key => ALERT_ORDER.indexOf(key)

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

test('groups are ordered by their worst rule, never A→Z, and the incident\'s group leads', () => {
  const groups = listGroups(rules)
  assert.deepEqual(groups.slice(0, 2).map(g => g.label), ['Payments', 'Infrastructure'])
  const worst = groups.map(g => rank(g.worst))
  assert.deepEqual(worst, [...worst].sort((a, b) => a - b))
  assert.equal(groups.at(-1).label, 'External Deps', 'a group of nothing but paused rules comes last')
  assert.notDeepEqual(groups.map(g => g.label), groups.map(g => g.label).sort())
})

test('a group header counts its rules and its firing ones', () => {
  const payments = listGroups(rules).find(g => g.label === 'Payments')
  assert.equal(groupHeaderText(payments), `${payments.total} rules · ${payments.firing} firing`)
  assert.equal(groupHeaderText({ total: 1, firing: 0 }), '1 rule')
})

test('paused rules fold to one line per group, unless asked for or opened', () => {
  const groups = listGroups(rules)
  const pub = groups.find(g => g.label === 'CubeAPM Public')
  assert.equal(pub.pausedCount, 2)
  assert.equal(pub.foldOpen, false)
  assert.deepEqual(pub.rules.map(r => String(r.id)), ['426'], 'only the live monitor rule has a row')
  assert.equal(foldText(pub.pausedCount), '2 paused rules')
  const ext = groups.find(g => g.label === 'External Deps')
  assert.equal(ext.rules.length, 0, 'an all-paused group is a header and one line')
  assert.equal(ext.paused.length, 2)

  const opened = listGroups(rules, { openFolds: new Set([pub.key]) }).find(g => g.key === pub.key)
  assert.equal(opened.foldOpen, true)
  assert.equal(opened.rules.length, 3)

  const asked = listGroups(rules, { unfoldPaused: true })
  assert.ok(asked.every(g => g.paused.length === 0))
})

test('a filter on paused rules, or any search, unfolds them', () => {
  assert.equal(asksForPaused(selectionFromUrl({ state: ['paused'] }), ''), true)
  assert.equal(asksForPaused(selectionFromUrl({ status: ['paused'] }), ''), true)
  assert.equal(asksForPaused({}, 'docs'), true)
  assert.equal(asksForPaused(selectionFromUrl({ state: ['critical'] }), '  '), false)
})

test('more than one row can be open; a link\'s rule_id opens its row and finds its group', () => {
  let open = new Set()
  open = toggleExpanded(open, 501)
  open = toggleExpanded(open, 502)
  assert.deepEqual([...open], ['501', '502'])
  assert.deepEqual([...toggleExpanded(open, '501')], ['502'], 'the URL\'s "501" and a view\'s 501 are one row')
  assert.deepEqual([...withUrlRule(new Set(), '427')], ['427'])
  const same = new Set(['427'])
  assert.equal(withUrlRule(same, 427), same, 'already open: the same set, so nothing re-renders')
  assert.equal(withUrlRule(same, null), same)

  const groups = listGroups(rules)
  const key = groupKeyOf(groups, '427')
  assert.equal(groups.find(g => g.key === key).label, 'CubeAPM Public', 'a paused rule is found inside its fold, by the URL\'s id')
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

test('a row\'s DOM id is safe whatever its rule id or group holds', () => {
  const id = ruleDomId('rtab-rule', 'group:Checkout & orders', 'a/b c')
  assert.match(id, /^[A-Za-z0-9_-]+$/)
  assert.notEqual(ruleDomId('x', 'g', 'a/b'), ruleDomId('x', 'g', 'a_b'))
})
