// How the rules list is laid out and how its rows behave, without rendering
// anything: the paused fold, the group headers' words, and the contract for
// what a click or a key on a row does (docs/alerts/DESIGN.md D3).

import { groupRules } from './adapters'

export const isPaused = view => view?.state === 'paused' || view?.status === 'PAUSED'

/**
 * The groups the list draws — each rule under the group a person put it in —
 * each with its paused rules split off. Seven of
 * production's nine demo rules are paused, each at full height with seven
 * controls, which is the noise that hides the one that fires (R47). So a group
 * shows its paused rules as one line, unless the reader opened that line or
 * asked for paused rules outright (`unfoldPaused`: a State or Status filter
 * naming them, or a search, which is an explicit ask for whatever matches).
 *
 * `{ key, label, rules, paused, foldOpen, total, firing, worst }`, where
 * `rules` are the rows drawn above the fold and `paused` the folded ones.
 */
export function listGroups(rules, { openFolds = new Set(), unfoldPaused = false } = {}) {
  return groupRules(rules).map(g => {
    const active = g.rules.filter(r => !isPaused(r))
    const paused = g.rules.filter(isPaused)
    // A group of nothing but paused rules stays folded too: a header and one
    // line is the point, however few rules it holds.
    const foldOpen = unfoldPaused || openFolds.has(g.key) || paused.length === 0
    return {
      key: g.key,
      label: g.label,
      rules: foldOpen ? g.rules : active,
      paused: foldOpen ? [] : paused,
      pausedCount: paused.length,
      foldOpen,
      total: g.rules.length,
      firing: g.firing,
      worst: g.worst,
    }
  })
}

/** Whether a filter or a search asks for paused rules, so none are folded away. */
export function asksForPaused(selection, q) {
  return !!(selection?.state?.has('paused') || selection?.status?.has('paused') || (q ?? '').trim())
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** "3 rules · 2 firing", or "1 rule" when nothing in it fires. */
export function groupHeaderText(group) {
  const firing = group.firing ? ` · ${group.firing} firing` : ''
  return `${plural(group.total, 'rule')}${firing}`
}

/** "‖ 2 paused rules". */
export const foldText = n => `${plural(n, 'paused rule')}`

// ---------- Expansion ----------

// Rule ids as text: the URL's rule_id is a string and a view's id a number,
// and the two must name the same row.
export const ruleKey = id => String(id)

/** The open rows (as `ruleKey`s) with one toggled. More than one can be open at once. */
export function toggleExpanded(expanded, id) {
  const key = ruleKey(id)
  const next = new Set(expanded)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  return next
}

/** The open rows with the URL's `rule_id` among them (production expands it too). */
export function withUrlRule(expanded, ruleId) {
  if (ruleId == null || ruleId === '' || expanded.has(ruleKey(ruleId))) return expanded
  return new Set(expanded).add(ruleKey(ruleId))
}

/** The group a rule is listed in first, so a link to a paused rule can open its fold. */
export function groupKeyOf(groups, ruleId) {
  const key = ruleKey(ruleId)
  const here = r => ruleKey(r.id) === key
  for (const g of groups) {
    if (g.rules.some(here) || g.paused.some(here)) return g.key
  }
  return null
}

// What a click on a row may not toggle it from: anything with its own job. The
// name is a link to the rule page, the menus are menus, and a dialog a menu
// opened is rendered inside the row but is not part of it.
const OWN_JOB_TAGS = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL', 'SUMMARY'])
const OWN_JOB_ROLES = new Set(['button', 'link', 'menu', 'menuitem', 'dialog', 'checkbox', 'tab', 'option'])

/**
 * Whether a click that landed on `target` toggles the row `row`. Walks from
 * the target up to the row: an element with its own job on the way (a link, a
 * button, a menu, a dialog, or anything marked `data-no-row-toggle`) keeps the
 * click; the row's own toggle button (`data-row-toggle`) hands it on. A target
 * outside the row toggles nothing.
 */
export function clickTogglesRow(target, row) {
  for (let el = target; el; el = el.parentElement) {
    if (el === row) return true
    if (el.hasAttribute?.('data-row-toggle')) return true
    if (el.hasAttribute?.('data-no-row-toggle')) return false
    if (OWN_JOB_TAGS.has(el.tagName)) return false
    if (OWN_JOB_ROLES.has(el.getAttribute?.('role'))) return false
  }
  return false
}

/**
 * A click the page handles itself: the main button with no modifier. Anything
 * else (⌘ or Ctrl for a new tab, Shift for a window, the middle button) is the
 * browser's, which can open the link's href on its own.
 */
export function isPlainClick(e) {
  return !!e && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey
}

/**
 * Where ↑ / ↓ go from the row toggle at `index` of `count` (D17). The list
 * does not wrap: past either end the key does nothing, as in a menu bar.
 */
export function rowStep(index, count, key) {
  if (key === 'ArrowDown') return index + 1 < count ? index + 1 : null
  if (key === 'ArrowUp') return index > 0 ? index - 1 : null
  if (key === 'Home') return count ? 0 : null
  if (key === 'End') return count ? count - 1 : null
  return null
}

/** A DOM id for a rule's row, safe whatever characters the rule id holds. */
export function ruleDomId(prefix, groupKey, id) {
  const safe = s => String(s).replace(/[^A-Za-z0-9_-]/g, c => `_${c.charCodeAt(0).toString(16)}`)
  return `${prefix}-${safe(groupKey)}-${safe(id)}`
}
