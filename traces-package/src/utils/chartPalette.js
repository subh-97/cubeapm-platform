/**
 * Colours for series IDENTITY — which thing this is, never how bad it is.
 *
 * Blues, purples and teals only: red, amber and green are reserved for
 * severity across the whole product, so a chart that spends them on series
 * identity makes every other severity signal ambiguous.
 */
export const CHART_PALETTE = [
  '#3B82F6', '#8B5CF6', '#14B8A6', '#F472B6',
  '#0EA5E9', '#A855F7', '#22D3EE', '#EC4899',
  '#6366F1', '#06B6D4', '#818CF8', '#F59E0B',
]

export function paletteColor(i) {
  return CHART_PALETTE[i % CHART_PALETTE.length]
}

/**
 * A stable colour per name within one list.
 *
 * Keyed on position in the caller's list rather than on a hash of the name, so
 * the first service in a trace is always the first palette colour — a trace
 * reads the same way every time, and two adjacent services never collide.
 */
export function colorForName(name, names) {
  const i = names.indexOf(name)
  return paletteColor(i === -1 ? 0 : i)
}
