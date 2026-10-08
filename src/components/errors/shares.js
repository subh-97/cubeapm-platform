// The percentages beside the Error details drawer's host and version bars.
//
// Rounding each share on its own does not add up: 145 and 87 of 232 read 63%
// and 38%, and a reader adding them up gets 101% on the incident's headline
// group. The shares here are rounded together instead (largest remainder), so
// the list always comes to 100.

import { largestRemainder } from '@/utils/apportion'

/** Whole-number percentages of `counts`, in the same order, summing to exactly 100 whenever anything is counted. */
export const sharePercents = counts => largestRemainder(counts, 100)

// A share that rounds to nothing is still there; '0%' would say it is not.
export const shareText = (pct, count) => (count > 0 && pct < 1 ? '<1%' : `${pct}%`)
