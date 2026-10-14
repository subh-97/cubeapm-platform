// The arithmetic behind PageBar's trail folding from the middle
// (Breadcrumbs.jsx). Kept free of the DOM so it can be tested on its own.

import { Children, Fragment, isValidElement } from 'react'

// Pages mark the gaps between crumbs with their own `<span className="sep">`.
const isSep = node =>
  isValidElement(node)
  && typeof node.type === 'string'
  && /(^|\s)sep(\s|$)/.test(node.props.className || '')

// Pages build their trails out of conditionals and fragments (InfraView nests
// three deep), so the trail is flattened before it is cut. `toArray` already
// drops the `false` and `null` a conditional leaves behind.
function flatten(children, out) {
  Children.toArray(children).forEach(node => {
    if (isValidElement(node) && node.type === Fragment) flatten(node.props.children, out)
    else out.push(node)
  })
  return out
}

/**
 * Cut a page's breadcrumb children into crumbs at its separators. Each crumb
 * is `{ sep, content }`: the separator in front of it (null for the first) and
 * whatever the page put between that separator and the next one — a link, the
 * current page's name, InfraView's host picker.
 */
export function splitCrumbs(children) {
  const crumbs = []
  let crumb = { sep: null, content: [] }
  for (const node of flatten(children, [])) {
    if (isSep(node)) {
      if (crumb.content.length) crumbs.push(crumb)
      crumb = { sep: node, content: [] }
    } else {
      crumb.content.push(node)
    }
  }
  if (crumb.content.length) crumbs.push(crumb)
  return crumbs
}

/**
 * How many crumbs to fold into "…" so the trail fits `available` px.
 *
 * The first crumb (the way home) and the last (where you are) always stay; the
 * crumbs between them fold from the root end inward, so the ones kept are the
 * nearest parents of the current page — the ones a reader most likely wants
 * back. Returns 0 when everything fits, and at most `widths.length - 2`. If
 * even that is too wide, the caller lets the last crumb shrink.
 *
 * widths         each crumb's width, its separator included
 * ellipsisWidth  the "…" stand-in's width, its separator included
 * gap            the space between crumbs
 */
export function crumbsToHide(widths, ellipsisWidth, gap, available) {
  const n = widths.length
  if (n <= 2) return 0
  // Half a pixel of slack: the widths are fractional, and a trail that misses
  // by rounding alone should not lose a crumb for it.
  const fits = total => total <= available + 0.5
  let total = widths.reduce((sum, w, i) => sum + w + (i ? gap : 0), 0)
  if (fits(total)) return 0
  total += gap + ellipsisWidth
  for (let k = 1; k < n - 1; k++) {
    total -= gap + widths[k]
    if (fits(total)) return k
  }
  return n - 2
}
