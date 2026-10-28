// The Rules tab's bridge to Phase 1's alert modules (docs/alerts/PLAN.md, P1):
// the order, the groups, the counts and the facet values come from the model,
// the words from describe. Everything the list reads about a rule comes
// through here, so a move in Phase 1 is a change to this one file.

import { routeUrl } from '@/utils/route'

export {
  ALERT_ORDER, sortRules, groupRules, countRules, ruleFacets,
} from '@/utils/alerts/model'

export {
  formatValue, formatThreshold, formatDuration, formatElapsed, durationWords,
  conditionText, ruleSentence, multipleText, sinceText, displayName,
} from '@/utils/alerts/describe'

/** A rule's page, as production spells it: /alerts/:id. */
export const rulePath = ruleId => routeUrl({ view: 'alertRule', ruleId })
/** The editor on a rule; with no id, on a new one (/alerts/new). */
export const ruleEditPath = ruleId => routeUrl({ view: 'alertEditor', ruleId })
export const NEW_RULE_PATH = routeUrl({ view: 'alertEditor', ruleId: null })

/**
 * Whether a snooze or a mute is holding the rule's notifications now. The
 * model's `suppression` is only ever the one in force: a scheduled snooze is
 * listed in `snoozes` and holds nothing yet.
 */
export const isSuppressed = view => !!view?.suppression
