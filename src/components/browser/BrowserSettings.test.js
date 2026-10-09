// The Browser settings drawer's two tabs, read off the rendered markup: what
// each says when its list is empty, how a row reads, and that every delete
// button says what it deletes. The lists are App's (the drawer unmounts on
// close), so the component is rendered here straight from the props App
// passes it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server.browser'
import { createElement } from 'react'
import { BROWSER_APPS, BROWSER_SOURCE_MAP_SEED } from '@/data/browser'
import BrowserSettings from './BrowserSettings.jsx'

const noop = () => {}
const render = props => renderToStaticMarkup(createElement(BrowserSettings, {
  tab: 'Path Patterns',
  pathPatterns: [],
  setPathPatterns: noop,
  sourceMaps: [],
  setSourceMaps: noop,
  apps: BROWSER_APPS,
  appId: BROWSER_APPS[0].id,
  ...props,
}))

// Text as a reader gets it: tags dropped, entities decoded where they matter.
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&apos;/g, '\'').replace(/&quot;/g, '"')
  .replace(/&amp;/g, '&').replace(/\s+/g, ' ')
const ariaLabels = html => [...html.matchAll(/aria-label="([^"]*)"/g)].map(m => m[1].replace(/&#x27;/g, '\''))

test('Path Patterns starts empty and says what a pattern is for, with search and New ready', () => {
  const html = render({})
  assert.match(html, /placeholder="Search patterns"/)
  assert.ok(ariaLabels(html).includes('Search patterns'), 'the search box is labelled for a screen reader')
  assert.match(text(html), /\bNew\b/)
  assert.match(text(html), /No path patterns yet/)
  assert.doesNotMatch(html, /brw-set-list/, 'no list is drawn for an empty one')
  // The form only opens on New.
  assert.doesNotMatch(html, /<form/)
})

test('a path pattern row reads its pattern, its host or the app\'s own pages, and its description', () => {
  const app = BROWSER_APPS[0]
  const html = render({
    pathPatterns: [
      { id: 'a', appId: app.id, host: '', pattern: '/docs/*', description: 'Every docs page as one' },
      { id: 'b', appId: app.id, host: 'api.cubedemo.com:443', pattern: '/v1/users/:id', description: '' },
    ],
  })
  const t = text(html)
  assert.doesNotMatch(t, /No path patterns yet/)
  // Kept in the order App holds them (newest first is App's doing), each
  // wrapping only between its segments.
  assert.ok(t.replace(/ /g, '').indexOf('/docs/*') < t.replace(/ /g, '').indexOf('/v1/users/:id'))
  assert.match(html, /<wbr\/>/)
  assert.ok(t.includes(`${app.name}'s own pages`), t)
  assert.match(t, /api\.cubedemo\.com:443/)
  assert.match(t, /Every docs page as one/)
  const labels = ariaLabels(html)
  assert.ok(labels.includes('Delete path pattern /docs/*'), labels.join(' | '))
  assert.ok(labels.includes('Delete path pattern api.cubedemo.com:443/v1/users/:id'), labels.join(' | '))
})

test('Source Maps lists the seeded maps, naming the app when there is more than one', () => {
  const html = render({ tab: 'Source Maps', sourceMaps: BROWSER_SOURCE_MAP_SEED })
  const t = text(html)
  // The URLs carry break opportunities after their slashes, which text()
  // turns into spaces.
  const joined = t.replace(/ /g, '')
  assert.match(t, /Add source map/)
  assert.match(t, /Current source maps/)
  for (const m of BROWSER_SOURCE_MAP_SEED) {
    assert.ok(joined.includes(m.sourceFile), m.sourceFile)
    assert.ok(t.includes(m.sourceMap.split('/').pop()), m.sourceMap)
    assert.ok(t.includes(BROWSER_APPS.find(a => a.id === m.appId).name), m.appId)
    assert.ok(ariaLabels(html).includes(`Delete source map for ${m.sourceFile}`), m.sourceFile)
  }
  assert.doesNotMatch(t, /No source maps yet/)
})

test('with one app, a source map row does not repeat which app it belongs to', () => {
  const only = BROWSER_APPS[0]
  const maps = BROWSER_SOURCE_MAP_SEED.filter(m => m.appId === only.id)
  const t = text(render({ tab: 'Source Maps', sourceMaps: maps, apps: [only] }))
  assert.ok(maps.length > 0)
  assert.ok(t.replace(/ /g, '').includes(maps[0].sourceFile))
  assert.ok(!t.includes(only.name), t)
})

test('Source Maps with every map deleted says what that means for the stack traces', () => {
  const t = text(render({ tab: 'Source Maps', sourceMaps: [] }))
  assert.match(t, /No source maps yet/)
  assert.match(t, /minified/)
})

test('a tab the drawer does not know falls back to Path Patterns rather than drawing nothing', () => {
  assert.match(text(render({ tab: 'Display' })), /No path patterns yet/)
})

test('path patterns belong to the app they were made on; the drawer lists the shown app\'s', () => {
  const [web, admin] = BROWSER_APPS
  const pathPatterns = [
    { id: 'w', appId: web.id, host: '', pattern: '/web-only/*', description: '' },
    { id: 'a', appId: admin.id, host: '', pattern: '/admin-only/*', description: '' },
  ]
  const onWeb = text(render({ pathPatterns, appId: web.id })).replace(/ /g, '')
  assert.ok(onWeb.includes('/web-only/*') && !onWeb.includes('/admin-only/*'), onWeb)
  const onAdmin = text(render({ pathPatterns, appId: admin.id })).replace(/ /g, '')
  assert.ok(onAdmin.includes('/admin-only/*') && !onAdmin.includes('/web-only/*'), onAdmin)
  // An app with none of its own says so, whatever the other app has.
  assert.match(text(render({ pathPatterns: pathPatterns.slice(1), appId: web.id })), /No path patterns yet/)
})

test('a source map row names the map by its file, seeded or uploaded alike, and wraps its URL at the slashes', () => {
  const [seeded] = BROWSER_SOURCE_MAP_SEED
  const uploaded = { id: 'u', appId: seeded.appId, sourceFile: 'https://shop.cubedemo.com/assets/vendor-1a2b3c.js', sourceMap: 'vendor-1a2b3c.js.map', description: '' }
  const html = render({ tab: 'Source Maps', sourceMaps: [uploaded, seeded] })
  const seededFile = seeded.sourceMap.split('/').pop()
  assert.ok(html.includes(`<span title="${seeded.sourceMap}">Map <span class="mono">${seededFile}</span></span>`), html)
  assert.ok(html.includes(`<span title="${uploaded.sourceMap}">Map <span class="mono">${uploaded.sourceMap}</span></span>`), html)
  assert.ok(html.includes(`<div class="brw-set-row-title" title="${seeded.sourceFile}">https:/<span><wbr/>/</span>`), html)
})

test('the source map list heading can take focus from script, never as a Tab stop', () => {
  // Where focus goes when the last map is deleted while the upload form has
  // taken the Add button's place; with no maps the heading still stands.
  for (const sourceMaps of [BROWSER_SOURCE_MAP_SEED, []]) {
    const html = render({ tab: 'Source Maps', sourceMaps })
    assert.match(html, /<div class="drawer-section-label" id="[^"]+" tabindex="-1">Current source maps<\/div>/)
  }
})
