// The series palettes. RED_EP_COLORS and epColor moved here from the service
// page and must keep every endpoint's colour; BROWSER_COLORS must keep clear of
// every status hue, because its lines are drawn over status-coloured bands.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { REFERENCE_WINDOW as win } from '@/data/timeWindow'
import { BROWSER_APPS, pageViewsForWindow, ajaxCallsForWindow, webVitalsForWindow } from '@/data/browser'
import { RED_EP_COLORS, epColor, BROWSER_COLORS, browserColor, cycledColor } from './chartPalette.js'

const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)

function hue(hex) {
  const [r, g, b] = rgb(hex)
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b)
  if (d === 0) return null
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return (h * 60 + 360) % 360
}

// WCAG contrast, for a line against the card it is drawn on.
const lum = hex => {
  const [r, g, b] = rgb(hex).map(c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
const DARK_CARD = '#080B11'
const LIGHT_CARD = '#FFFFFF'

test('the service page keeps its endpoint colours', () => {
  assert.deepEqual(RED_EP_COLORS, ['#3B82F6', '#34D399', '#F472B6', '#A78BFA', '#06B6D4', '#6366F1'])
  assert.equal(epColor(0), '#3B82F6')
  assert.equal(epColor(5), '#6366F1')
  assert.equal(epColor(6), '#3B82F6BB', 'the second pass comes round fainter')
  for (let i = 0; i < 30; i++) assert.equal(epColor(i), cycledColor(RED_EP_COLORS, i))
})

test('the Browser palette has at least eight distinct six-digit colours', () => {
  assert.ok(BROWSER_COLORS.length >= 8)
  // Enough for the storefront's fourteen routes without a second, fainter
  // pass, whose colours sit too close to other first-pass ones.
  assert.ok(BROWSER_COLORS.length >= 14)
  for (const c of BROWSER_COLORS) assert.match(c, /^#[0-9A-F]{6}$/, 'cycledColor appends an alpha, so a plain hex')
  assert.equal(new Set(BROWSER_COLORS).size, BROWSER_COLORS.length)
  assert.equal(browserColor(0), BROWSER_COLORS[0])
  assert.equal(browserColor(BROWSER_COLORS.length), `${BROWSER_COLORS[0]}BB`)
})

test('no Browser colour sits near a status hue: blues, indigos, violets and cyans only', () => {
  // Green runs to about 160°, pink starts past 300°, red and amber are far off.
  for (const c of BROWSER_COLORS) {
    const h = hue(c)
    assert.ok(h >= 180 && h <= 285, `${c} has hue ${h?.toFixed(0)}°`)
  }
})

test('every Browser colour holds 3:1 against the card in both themes', () => {
  for (const c of BROWSER_COLORS) {
    assert.ok(contrast(c, DARK_CARD) >= 3, `${c} on the dark card: ${contrast(c, DARK_CARD).toFixed(2)}`)
    assert.ok(contrast(c, LIGHT_CARD) >= 3, `${c} on the light card: ${contrast(c, LIGHT_CARD).toFixed(2)}`)
  }
})

// OKLab, the perceptual space the six later Browser colours were picked in:
// a straight-line distance in it is roughly how different two colours look.
const linear = c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
function oklab(hex) {
  const [r, g, b] = rgb(hex).map(linear)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ]
}
const distance = (a, b) => Math.hypot(...oklab(a).map((v, i) => v - oklab(b)[i]))

test('no two Browser colours sit closer than the original eight do to each other', () => {
  // The colours past the eighth were added because a second, fainter pass of
  // the first eight looked like a different first-pass colour. A new colour
  // that sits closer to an existing one than any two of the eight do would
  // bring that back, so the eight's own least difference is the floor.
  const least = colors => {
    let min = Infinity
    colors.forEach((a, i) => colors.slice(0, i).forEach(b => { min = Math.min(min, distance(a, b)) }))
    return min
  }
  const floor = least(BROWSER_COLORS.slice(0, 8))
  assert.ok(floor > 0.08, `the first eight differ by ${floor.toFixed(3)} at least`)
  assert.ok(least(BROWSER_COLORS) >= floor - 1e-9, `the whole palette's least difference is ${least(BROWSER_COLORS).toFixed(3)}`)
})

test('every list the Browser page charts fits in one pass of its palette', () => {
  // A row past the palette's length is drawn in a first-pass hue at 73%
  // opacity, which reads as another line's colour. Routes, ajax endpoints
  // and pages are the lists the Browser charts colour by row.
  for (const app of BROWSER_APPS) {
    const lists = { routes: pageViewsForWindow(win, app.id).rows, endpoints: ajaxCallsForWindow(win, app.id).rows, pages: webVitalsForWindow(win, app.id).rows }
    for (const [noun, rows] of Object.entries(lists)) {
      assert.ok(rows.length <= BROWSER_COLORS.length, `${app.id} charts ${rows.length} ${noun}, more than the palette's ${BROWSER_COLORS.length} colours`)
      const colors = rows.map((_, i) => browserColor(i))
      assert.equal(new Set(colors).size, rows.length)
      for (const c of colors) assert.match(c, /^#[0-9A-F]{6}$/, `${app.id}'s ${noun}: no faded second-pass colour`)
    }
  }
})
