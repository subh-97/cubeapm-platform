// After a Save that can't go through, focus moves to the first thing left to
// finish, as the rule editor's Save does (7c): the name field, the way to add
// what is missing, or into the card that is wrong. Without it the problems
// appear and focus stays on Save, with nothing said to a keyboard where.

const FIELD = 'input, textarea, button, [tabindex="0"]'
const usable = el => !el.disabled && el.getAttribute('aria-disabled') !== 'true' && !el.closest('.ae-dest-head')

/**
 * `issues` are the drawer's, in its order (`[{ field }]`); `nameId` is its
 * name input's id, `addSelector` the control that adds the first missing item.
 * A card's issue (`destination-0`, `mute-1`) is found by the card's
 * `ae-field-…` id.
 */
export function focusFirstIssue(issues, { nameId, addSelector }) {
  const field = issues?.[0]?.field
  if (!field || typeof document === 'undefined') return
  requestAnimationFrame(() => {
    const el = field === 'name' ? document.getElementById(nameId)
      : field === 'destinations' || field === 'windows' ? document.querySelector(addSelector)
        : document.getElementById(`ae-field-${field}`)
    if (!el) return
    const target = el.matches(FIELD) && usable(el) ? el : [...el.querySelectorAll(FIELD)].find(usable) ?? el
    target.focus()
  })
}
