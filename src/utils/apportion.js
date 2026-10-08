// Largest-remainder rounding, shared by the data layer and the drawer.

/**
 * `total` split into whole numbers in proportion to `counts`, in the same
 * order, summing to exactly `total` whenever anything is counted; all zeros
 * otherwise, and a count that is not a positive number counts as nothing. The
 * floor of each exact share first; the units left over go to the largest
 * fractions, ties to the bigger count and then to the earlier entry, so the
 * result does not depend on how the input was sorted beyond that. Any total,
 * not just 100, because the data layer's host and version breakdown (a sampled
 * tally scaled up to a group's count) is the same rounding.
 */
export function largestRemainder(counts, total) {
  const clean = counts.map(c => (c > 0 ? c : 0))
  const n = clean.reduce((a, c) => a + c, 0)
  if (!(n > 0) || !(total > 0)) return counts.map(() => 0)
  const parts = clean.map((c, i) => {
    const exact = (c * total) / n
    return { i, c, share: Math.floor(exact), frac: exact - Math.floor(exact) }
  })
  let left = total - parts.reduce((a, p) => a + p.share, 0)
  for (const p of [...parts].sort((a, b) => b.frac - a.frac || b.c - a.c || a.i - b.i)) {
    if (left <= 0) break
    p.share += 1
    left -= 1
  }
  return parts.map(p => p.share)
}
