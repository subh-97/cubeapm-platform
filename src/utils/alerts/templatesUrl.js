// Browse Templates' query string (/alerts/templates): where the catalogue is
// scoped and how it is filtered, so a link, a reload and Back all land on the
// same view. Our own keys, in a fixed order, written with replace
// (docs/alerts/DESIGN.md D14) — and none of the keys production's pages carry
// into every module and ours read past (`service`, `category`, `host`, …).
//
//   domain   a Domain id (DOMAINS), when no Sub-domain narrows it
//   sub      a Sub-domain id (SUBDOMAINS)
//   q        the search
//   type     a problem type
//   source   a data source some template reads
//   urgency  an urgency

import { DOMAINS, SUBDOMAINS, PROBLEM_TYPES, SOURCES_IN_USE, URGENCIES } from './ruleTemplates'

const ids = list => new Set(list.map(x => x.id))
const DOMAIN_IDS = ids(DOMAINS)
const PROBLEM_IDS = ids(PROBLEM_TYPES)
const SOURCE_IDS = ids(SOURCES_IN_USE)
const URGENCY_IDS = ids(URGENCIES)

const known = (set, v) => (v && set.has(v) ? v : null)
// An own key only: "constructor" and "__proto__" are on every object.
const isSub = v => Boolean(v) && Object.hasOwn(SUBDOMAINS, v)

/** The view a query string names: `{ domain, sub, q, problem, source, urgency }`, unknown values dropped. */
export function parseTemplatesSearch(search) {
  const p = new URLSearchParams(search)
  const sub = isSub(p.get('sub')) ? p.get('sub') : null
  return {
    // A Sub-domain names its Domain; a Domain alone is the Domain's view.
    domain: sub ? SUBDOMAINS[sub].domain : known(DOMAIN_IDS, p.get('domain')),
    sub,
    q: p.get('q') ?? '',
    problem: known(PROBLEM_IDS, p.get('type')),
    source: known(SOURCE_IDS, p.get('source')),
    urgency: known(URGENCY_IDS, p.get('urgency')),
  }
}

/** The query string for a view, in a fixed order, with nothing for what is unset. */
export function templatesSearch(view = {}) {
  const p = new URLSearchParams()
  if (isSub(view.sub)) p.set('sub', view.sub)
  else if (view.domain && DOMAIN_IDS.has(view.domain)) p.set('domain', view.domain)
  // As typed: trimming here would eat the space between two words mid-typing.
  if (view.q?.trim()) p.set('q', view.q)
  if (view.problem) p.set('type', view.problem)
  if (view.source) p.set('source', view.source)
  if (view.urgency) p.set('urgency', view.urgency)
  const s = p.toString()
  return s ? `?${s}` : ''
}
