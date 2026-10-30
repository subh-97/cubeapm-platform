import { createContext } from 'react'

// What a chart card's Expand and Compare need to know about the chart they
// open, and what they tell it once it is drawn inside the modal.
//
// A card hands its header a VIEW: the window it draws now, and how to draw its
// chart over any other window. Compare draws the chart twice — over the page's
// window, and over the same span an hour, a day or a week earlier
// (`shiftWindow`) — and Expand draws it once, larger. Neither copies data out
// of the card: each draw runs the card's own derivation for the window it is
// given, so a figure in the modal is the one the card would show.
//
// The modal then sets the FRAME every chart inside it reads through TimeChart
// and ChartTooltip — the chart components do not have to be told they are in a
// modal, and their page-level props keep working:
//
//   syncId, syncMethod  the modal's own crosshair group, synced by bucket
//                       index. The page's group would drive the charts behind
//                       the overlay, and synced by value an earlier window
//                       never matches a single x of the current one.
//   height              the plot's height, over whatever the card set
//   brush               false on the earlier copy: a drag there would zoom the
//                       page into the past. The hover, and so the tooltip, stay.
//   nowMs               the instant a tooltip's "… ago" counts back from, so a
//                       point on the 1-day-ago chart reads "1 day ago" rather
//                       than "12 mins ago"
//
// What a reader has done to a card's legend (an isolated row, a search) is the
// card's own state, handed to every drawing of it, so the modal opens on the
// legend as the card shows it and a Compare's two drawings move together.
//
// Outside a modal the context is null, and every chart draws as it always has.

/** @type {import('react').Context<null | {syncId:string, syncMethod:'index', height:(number|string), brush:boolean, nowMs:number}>} */
export const ChartFrameContext = createContext(null)

/**
 * What Compare offers, as production's chart Compare does ("Compare with"
 * 1 hour ago / 1 day ago / 1 week ago; docs/alerts/reference/production.md
 * §15.3). These are not timeRange's COMPARE_OPTIONS (Explore's toolbar, which
 * offers "Previous period" and Off): a chart's Compare is always a comparison,
 * and always a fixed distance back.
 */
export const CHART_COMPARE_OPTIONS = [
  { value: 'hour', label: '1 hour ago', sec: 3600 },
  { value: 'day', label: '1 day ago', sec: 86400 },
  { value: 'week', label: '1 week ago', sec: 604800 },
]

/** Production's modal opens on "1 day ago". */
export const DEFAULT_CHART_COMPARE = 'day'

/** The option for a value, falling back to the default for anything unknown. */
export function chartCompareOption(value) {
  return CHART_COMPARE_OPTIONS.find(o => o.value === value)
    ?? CHART_COMPARE_OPTIONS.find(o => o.value === DEFAULT_CHART_COMPARE)
}

// Plot heights inside the modal. Strings, because the plot's inline height
// takes any CSS length and these follow the viewport: the two charts of a
// Compare share the screen, an expanded chart has it to itself. Each keeps a
// floor a chart stays legible at, and a ceiling past which a taller plot only
// stretches the lines.
export const COMPARE_PLOT_HEIGHT = 'clamp(170px, calc((100vh - 330px) / 2), 300px)'
export const EXPAND_PLOT_HEIGHT = 'clamp(240px, calc(100vh - 250px), 600px)'
