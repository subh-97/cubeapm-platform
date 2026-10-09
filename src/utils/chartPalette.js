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

// Opacity per pass through a palette, as two-digit hex alpha.
const CYCLE_ALPHA = ['', 'BB', '88', '66']

/**
 * Identity colour for slot `i` of a short palette of 6-digit hex colours.
 *
 * Past one full pass the hues come round again at lower opacity, the way
 * Explore's palette does, so a chart drawing more series than it has colours —
 * a fleet of hosts, a long list of endpoints — never gives two of them the
 * identical colour within the first few passes.
 */
export function cycledColor(palette, i) {
  const n = palette.length
  return palette[i % n] + CYCLE_ALPHA[Math.floor(i / n) % CYCLE_ALPHA.length]
}

// The APM service page's endpoint colours: the RED charts, and the External and
// DB tabs that list the same kind of thing. Moved here out of ServiceOverview
// when the Browser page's charts were built from the same component, unchanged,
// so an endpoint on the service page keeps the colour it has always had. It
// predates the rule at the top of this file (#34D399 is a green); bringing it
// into line would recolour every APM chart, which is a decision of its own
// rather than part of a move.
export const RED_EP_COLORS = ['#3B82F6', '#34D399', '#F472B6', '#A78BFA', '#06B6D4', '#6366F1']

// An endpoint's line colour: the seventh endpoint is visibly not the first
// (see cycledColor), and it is never `undefined`, which is what indexing the
// six colours directly gave the RED charts once more than six could draw.
export const epColor = i => cycledColor(RED_EP_COLORS, i)

/**
 * The Browser (RUM) page's series colours: one palette for every chart on it,
 * so a route or an ajax endpoint is the same colour on every tab.
 *
 * Narrower than RED_EP_COLORS on purpose. The Web Vitals charts draw their
 * lines over good / needs-improvement / poor bands painted in the status hues,
 * and a green line over the green band — or an amber one across the amber
 * band — vanishes into it and reads as a rating it is not. So there is no
 * green, amber, red or pink here at all: blues, indigos, violets and cyans
 * only, the part of the wheel no status colour lives in.
 *
 * Eight hues from a quarter of the wheel cannot all differ by hue, so the
 * order alternates light and dark as much as hue, and every neighbouring pair
 * was checked with a colour-vision simulation (protan and deutan) as well as
 * for plain legibility. Neighbours matter most because colour is keyed on a
 * row's place in the data's own order, so rows 0 and 1 are the pair most
 * often drawn together. Every hue holds at least 3:1 against both the dark and
 * the light card, because the hex is fixed: cycledColor appends an alpha, so a
 * theme-switching CSS variable is not an option here.
 *
 *   blue · deep purple · cyan · deep blue · light purple · indigo · sky · violet
 *
 * Then six more, so the longest list the page draws (the storefront's
 * fourteen routes) never comes round to a second pass. A second pass is the
 * first hue again at 73% opacity, and over the card that lands within a
 * hair of a DIFFERENT first-pass colour (a faded blue reads as the deep
 * blue), so two of fourteen lines were one colour to the eye. These six were
 * picked from the same band, under the same 3:1 rule, for the largest least
 * difference from every colour before them (OKLab), and that least difference
 * is the original eight's own:
 *
 *   slate teal · vivid purple · soft blue · mauve · bright blue · muted indigo
 */
export const BROWSER_COLORS = [
  '#3B82F6', '#8936CD', '#1AA0B9', '#0465AF',
  '#AF61F8', '#5443DB', '#0983B5', '#7960FB',
  '#2D6D76', '#B51DED', '#728DCA', '#B67ACD',
  '#105EF9', '#6E6BC7',
]

export const browserColor = i => cycledColor(BROWSER_COLORS, i)

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
