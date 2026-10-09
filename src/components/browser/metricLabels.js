// The words and figures the Browser page's three metric tabs (Page Views, Ajax
// Calls, Web Vitals) print around their numbers: a headline split into figure
// and unit, the comparison chip's wording, the short labels a legend shows for
// a long URL, and how a web vital is rated in words. Kept out of the tab
// components so it can be tested, and so those files export nothing but
// components.

import { deltaChip } from '@/utils/errorsPage'
import { WEB_VITAL_THRESHOLDS, WEB_VITAL_RATINGS, statusForWebVital } from '@/utils/status'
import { fmtLoadTime, fmtCls, labelMatches } from '@/components/charts/chartDefaults'

/* ---- headline figures ---- */

/**
 * A formatted figure as the card draws it: the number large, the unit small
 * beside it (.cval and .cval .u). The page's formatters print the unit into the
 * string ("1.18 s", "982 ms", "5.94%"), so it is split back off the end rather
 * than every card carrying a second formatter that must agree with the first.
 * A figure with no unit (a rate, a CLS score) comes back whole.
 */
export function splitFigure(text) {
  const s = String(text ?? '')
  const m = /^(.*?)\s*(ms|s|%)$/.exec(s)
  return m && m[1] ? { value: m[1], unit: m[2] } : { value: s, unit: '' }
}

/**
 * The comparison chip for a headline figure (CLAUDE.md rule 6): the Errors
 * tab's own chip, from deltaChip, so it reads ↑12% / ↓4% / ↑2.1× and is the
 * same info colour whichever way the figure moved.
 *
 * deltaChip was written for counts and says what the earlier window held with
 * toLocaleString ("1,165.19 then"). A load time or a percentage reads wrong
 * that way, so the tooltip names the earlier figure through the card's own
 * formatter instead ("↑2% vs the previous hour (1.17 s then)"). "New" and "—"
 * keep deltaChip's wording, which names no figure.
 */
export function figureDelta(cur, prev, prevText, fmt) {
  const d = deltaChip(cur, prev, prevText)
  if (d.dir === 'new' || d.dir === 'none') return d
  return { ...d, title: `${d.label} vs ${prevText} (${fmt(prev)} then)` }
}

/**
 * The width every figure column of the three metric tables asks for. Left to
 * the table, a column is as wide as its header's words, so 'RPM' got a third
 * of the room 'Response Time (median)' did and the figures stood at uneven
 * intervals across the row. The same width on each lets the table share any
 * room left over between them evenly.
 */
export const FIGURE_COLUMN_WIDTH = 200

/* ---- short labels for long names ---- */

/**
 * An ajax endpoint without its default port: 'GET order.cubedemo.com:443/v1/orders'
 * reads 'GET order.cubedemo.com/v1/orders' in a legend and a tooltip. Every
 * call the browser makes is HTTPS, so ':443' says nothing, and it is what pushes
 * the part that tells two calls apart (the path) off the end of a legend row.
 * Only the default port goes; any other port is part of the address.
 */
export function ajaxLabel(endpoint) {
  return String(endpoint ?? '').replace(/:443(?=\/|$)/, '')
}

/**
 * A page URL without the app's own origin: 'https://shop.cubedemo.com/product/:sku'
 * reads '/product/:sku'. Every page of an app shares the origin, so it is the
 * one part of the URL that never tells two rows apart. The bare origin reads
 * '/'; a URL on another origin keeps all of itself.
 */
export function pagePath(url, origin) {
  const s = String(url ?? '')
  if (origin && s.startsWith(origin)) return s.slice(origin.length) || '/'
  return s
}

/**
 * Rows whose label contains the search, either as stored or as the page shows
 * it (`shortLabel`), ignoring case — so 'search.cubedemo.com/v1' finds the
 * search calls the legend shows without their port, and '/checkout' finds the
 * checkout page by the path a reader sees. No search returns `rows` itself.
 *
 * The test per row is chartDefaults' labelMatches, the one every chart legend
 * on the tab searches with too: a tab hands the table this `shortLabel` and
 * its charts the same function as `formatLabel`, so a query typed in Table
 * view finds the rows it finds in Graph view.
 */
export function filterByLabel(rows, query, shortLabel, labelKey = 'endpoint') {
  if (!String(query ?? '').trim()) return rows
  return rows.filter(r => labelMatches(r, query, shortLabel, labelKey))
}

/* ---- web vitals ---- */

export const VITALS = ['lcp', 'inp', 'cls']

export const VITAL_SHORT = { lcp: 'LCP', inp: 'INP', cls: 'CLS' }

export const VITAL_TITLES = {
  lcp: 'Largest Contentful Paint (LCP)',
  inp: 'Interaction to Next Paint (INP)',
  cls: 'Cumulative Layout Shift (CLS)',
}

/**
 * A threshold as it is spoken: '2.5 s', '200 ms', '0.25'. Round numbers, so
 * not the two-decimal figures the readings themselves are printed with — also
 * the label a chart's dashed threshold rule carries.
 */
export function vitalThresholdFigure(metric, v) {
  if (metric === 'cls') return String(v)
  return v >= 1000 ? `${v / 1000} s` : `${v} ms`
}

/** 'good ≤ 2.5 s, poor > 4 s' — the two thresholds a vital is rated against. */
export function vitalThresholdText(metric) {
  const t = WEB_VITAL_THRESHOLDS[metric]
  if (!t) return ''
  return `good ≤ ${vitalThresholdFigure(metric, t.good)}, poor > ${vitalThresholdFigure(metric, t.poor)}`
}

/**
 * The rating chip's words and its tooltip: 'Needs improvement' and
 * 'Needs improvement · good ≤ 2.5 s, poor > 4 s'. Null for a reading that
 * has no rating (no data), so the card draws no chip rather than a blank one.
 */
export function vitalRating(metric, status) {
  const label = WEB_VITAL_RATINGS[status]
  if (!label) return null
  return { status, label, title: `${label} · ${vitalThresholdText(metric)}` }
}

// The figure back as a number in the vital's own units (ms for LCP and INP),
// to check what a printed figure would be rated.
function parseVital(metric, text) {
  const m = /^(-?[\d.]+)\s*(ms|s)?$/.exec(text)
  if (!m) return NaN
  const n = Number(m[1])
  return metric !== 'cls' && m[2] === 's' ? Number((n * 1000).toPrecision(12)) : n
}

// The same reading with `extra` more decimals than the page normally prints.
// Three more is as far as it goes: the data keeps LCP and INP to a hundredth
// of a millisecond ('4.00001 s') and CLS to a thousandth, so no reading it
// hands out needs a fourth.
function vitalText(metric, v, extra) {
  if (metric === 'cls') return v.toFixed(2 + extra)
  return Math.round(v) < 1000 ? `${v.toFixed(extra)} ms` : `${(v / 1000).toFixed(2 + extra)} s`
}

/**
 * A web vital printed so the figure and its rating agree.
 *
 * Normally that is just the page's formatter: LCP and INP as load times
 * ('2.56 s', '177 ms'), CLS to two decimals. But a reading a hair over a
 * threshold rounds back onto it — an LCP of 2504 ms prints '2.50 s' and rates
 * "Needs improvement", a CLS of 0.104 prints '0.10' and does too — and a
 * figure that reads as exactly the threshold beside a chip saying it missed
 * looks like a bug. Such a reading gets the extra decimal (or three) it takes
 * to say which side of the line it is on: '2.504 s', '0.104', '200.4 ms'.
 */
export function vitalFigure(metric, v) {
  const fmt = metric === 'cls' ? fmtCls : fmtLoadTime
  const text = fmt(v)
  if (!text) return text
  const rating = statusForWebVital(metric, v)
  if (statusForWebVital(metric, parseVital(metric, text)) === rating) return text
  for (let extra = 1; extra < 3; extra++) {
    const finer = vitalText(metric, v, extra)
    if (statusForWebVital(metric, parseVital(metric, finer)) === rating) return finer
  }
  return vitalText(metric, v, 3)
}

/**
 * The tooltip of a Web Vitals row's one status dot: its worst rating, and the
 * vitals that earned it — 'Poor · LCP 4.55 s, CLS 0.28'. A page whose three
 * vitals are all good lists all three, so the dot's title still says something.
 */
export function worstVitalTitle(row) {
  const worst = row?.status?.worst
  const label = WEB_VITAL_RATINGS[worst]
  if (!label) return 'No web vitals recorded'
  const which = VITALS.filter(k => row.status[k] === worst)
  return `${label} · ${which.map(k => `${VITAL_SHORT[k]} ${vitalFigure(k, row[k])}`).join(', ')}`
}

const SEVERITY_RANK = { critical: 0, warning: 1, healthy: 2 }
const rankOf = r => SEVERITY_RANK[r?.status?.worst] ?? 3
const lcpOf = r => (Number.isFinite(r?.lcp) ? r.lcp : -Infinity)

/**
 * Web Vitals rows in the order the table opens in: worst rating first
 * (CLAUDE.md rule 3), then the slowest LCP first within a rating, and the
 * data's own order after that. A copy; the rows the charts draw from stay in
 * their canonical order, which their series are aligned to.
 */
export function vitalsBySeverity(rows) {
  return [...rows].sort((a, b) => (rankOf(a) - rankOf(b)) || (lcpOf(b) === lcpOf(a) ? 0 : lcpOf(b) > lcpOf(a) ? 1 : -1))
}
