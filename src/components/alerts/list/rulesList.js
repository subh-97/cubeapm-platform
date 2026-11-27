// How the rules list is laid out and how its rows behave, without rendering
// anything: one list worst first, the viewer's pinned rules at its head, the
// paused fold at its end, and the contract for what a click or a key on a row
// does (docs/alerts/DESIGN.md D3).

export const isPaused = view => view?.state === 'paused' || view?.status === 'PAUSED'

// How far past its threshold a rule reads (the row's "4.8×"); none for a rule
// past no threshold, which sorts after those that are.
const breach = view => (Number.isFinite(view?.thresholdMultiple) ? view.thresholdMultiple : -1)

/**
 * The list's order: worst state first (critical, warning, pending, rule error,
 * suppressed, OK, no data, paused); within a state, the rule furthest past its
 * threshold first, so the incident leads its tier rather than whichever name
 * sorts first; the name only when nothing else tells two rules apart (never
 * alphabetical first: CLAUDE.md rule 3).
 */
export function byUrgency(a, b) {
  return a.rank - b.rank || breach(b) - breach(a) || String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' })
}

/**
 * The list the Rules tab draws: every rule in one list, worst first
 * (`byUrgency`), with no groups — a rule's group is a tag on its expanded row,
 * and the Group facet narrows to one.
 *
 * The rules the viewer pinned (`pinned`, a Set of ids as text) come first, and
 * worst first among themselves, so a pin never reorders the incident below it
 * within the pins; then everything else, worst first. A pin is an ask to keep
 * that rule in sight, so a pinned rule is never folded away, paused or not.
 *
 * Paused rules that are not pinned are split off. Seven of production's nine
 * demo rules are paused, each at full height with seven controls, which is the
 * noise that hides the one that fires (R47). So they are one line at the
 * list's end, unless the reader opened that line (`foldOpen`) or asked for
 * paused rules outright (`unfoldPaused`: a State or Status filter naming them,
 * or a search, which is an explicit ask for whatever matches).
 *
 * `{ rules, paused, pausedCount, pinnedCount, foldOpen }`, where `rules` are
 * the rows drawn above the fold (its first `pinnedCount` the pinned ones) and
 * `paused` the folded ones.
 */
export function listRules(rules, { foldOpen: opened = false, unfoldPaused = false, pinned = NO_PINS } = {}) {
  const isPinned = r => pinned.has(ruleKey(r.id))
  const sorted = [...rules].sort(byUrgency)
  const pins = sorted.filter(isPinned)
  const rest = sorted.filter(r => !isPinned(r))
  const paused = rest.filter(isPaused)
  const foldOpen = unfoldPaused || opened || paused.length === 0
  return {
    rules: [...pins, ...(foldOpen ? rest : rest.filter(r => !isPaused(r)))],
    paused: foldOpen ? [] : paused,
    pausedCount: paused.length,
    pinnedCount: pins.length,
    foldOpen,
  }
}

const NO_PINS = new Set()

/** Whether a filter or a search asks for paused rules, so none are folded away. */
export function asksForPaused(selection) {
  return !!(selection?.enabled?.has('off') || selection?.alert?.size || selection?.query?.size)
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** "‖ 7 paused rules". */
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

/** Whether a rule is folded away among the paused ones, so a link to it can open the fold. */
export const isFolded = (list, ruleId) => list.paused.some(r => ruleKey(r.id) === ruleKey(ruleId))

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
export function ruleDomId(prefix, id) {
  const safe = s => String(s).replace(/[^A-Za-z0-9_-]/g, c => `_${c.charCodeAt(0).toString(16)}`)
  return `${prefix}-${safe(id)}`
}
