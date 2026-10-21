// A percentage has a ceiling, and a profile does not know it.
//
// Every profile in the mock layer is multiplicative: a quiet value, times a
// peak at the incident's worst, times jitter. `pinToReference` then solves for
// the quiet value that makes the reference hour average to the published
// figure. That is the right model for a rate or a latency, which have no top.
// A CPU or memory reading does. ip-10-0-142-133 publishes 92.4% CPU, the
// incident is a third of the hour, and its 1.4 peak put the plateau at 112–121%.
//
// The obvious fix is a clamp, `ceil: 100`, and it is the wrong one. A clamp is
// the one term in `sampleAt` that is not linear, so `pinToReference` leaves a
// clamped profile unpinned, and the hour silently stops reading its published
// figure. So nothing here clamps. The plateau is PLACED instead, where its
// jitter tops out at the ceiling, and the peak that gets there is solved for
// with the hour still averaging to the published figure. A profile asks for
// its own peak and takes the lower of the two, so a reading the ceiling never
// reaches is left exactly as it was.

import { REFERENCE_WINDOW, windowMean } from './timeWindow'

/** What a share of a whole reads at full: no CPU, memory or disk reads over it. */
export const PERCENT_CEILING = 100

/**
 * The highest peak a profile pinned to `published` over the reference hour
 * can take while its jitter stays at or under `ceiling`, or Infinity when no
 * peak would carry it there.
 *
 * Two equations in two unknowns. Every term in `sampleAt` is multiplicative,
 * so the hour's mean is linear in the peak: `baseline × (quiet + (peak − 1) ×
 * lift)`, where `quiet` and `lift` are measured once at a baseline of 1. The
 * plateau is `baseline × peak`, and its jitter tops out at `plateau × (1 +
 * noise / 2)`. Set the mean to the published figure and the top to the
 * ceiling, and the peak falls out. Solving it in closed form, rather than
 * clamping, keeps the profile linear, so `pinToReference` still makes the
 * hour exact.
 *
 * Not for a diurnal profile: the daily wave rides on top of the plateau and
 * would carry it over.
 */
export function ceilingPeak(published, { noise = 0, seed, ceiling = PERCENT_CEILING } = {}) {
  const unit = peak => windowMean(REFERENCE_WINDOW, { baseline: 1, peak, noise, seed })
  const quiet = unit(1)
  const lift = unit(2) - quiet
  const plateau = ceiling / (1 + noise / 2)
  // However high the peak, the plateau only approaches published / lift. A
  // figure that low leaves the ceiling out of reach.
  const room = published - plateau * lift
  return room > 0 ? (plateau * (quiet - lift)) / room : Infinity
}
