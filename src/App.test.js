// The app shell's way past the sidebar: "Skip to content" is the first thing
// Tab reaches on every page, and it points at the main column, which can take
// focus. Where focus goes when the page changes needs a DOM, and is checked in
// the running app.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server.browser'
import { MemoryRouter } from 'react-router-dom'
import { services } from '@/data/services'
import { serviceUrl } from '@/utils/route'
import App from './App.jsx'

// The shell is drawn only for a signed-in reader, and App reads that from
// localStorage, which node has only behind a flag.
const stored = new Map([['cubeapm-auth', 'true']])
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: key => stored.get(key) ?? null,
    setItem: (key, value) => { stored.set(key, String(value)) },
    removeItem: key => { stored.delete(key) },
  },
})

// Two warnings are a server render's, not the app's (BrowserView.test.js says
// the same): a chart's frame has no size to draw at, and the pages settle in
// layout effects a server render skips. Anything else still reaches the console.
const EXPECTED = /width\(\d+\) and height\(\d+\) of chart|useLayoutEffect does nothing on the server/
function render(url) {
  const { warn, error } = console
  const quiet = log => (...args) => { if (!EXPECTED.test(String(args[0]))) log(...args) }
  console.warn = quiet(warn)
  console.error = quiet(error)
  try {
    return renderToStaticMarkup(<MemoryRouter initialEntries={[url]}><App /></MemoryRouter>)
  } finally {
    Object.assign(console, { warn, error })
  }
}

// Every tag a Tab press can stop on: a link with an href, a form control, or
// anything with a tabindex of 0 or more (the sidebar's items are divs).
const TABBABLE = /<(?:a\s[^>]*\bhref="|button\b|input\b(?![^>]*type="hidden")|select\b|textarea\b|[a-z]+\s[^>]*\btabindex="\d+")[^>]*>/
const attr = (tag, name) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1] ?? null

const PAGES = ['/home', serviceUrl(services[0].id), '/logs']

for (const url of PAGES) {
  test(`the first Tab stop is "Skip to content", ahead of the sidebar (${url})`, () => {
    const out = render(url)
    const first = out.match(TABBABLE)
    assert.ok(first, 'something on the page takes Tab')
    assert.equal(attr(first[0], 'class'), 'skip-link')
    assert.match(out.slice(first.index), /^<a [^>]*>Skip to content<\/a>/)
    assert.ok(first.index < out.indexOf('<nav'), 'the link comes before the sidebar')
  })

  test(`the skip link points at the main column, which can take focus but is no Tab stop (${url})`, () => {
    const out = render(url)
    const link = out.match(/<a [^>]*class="skip-link"[^>]*>/)[0]
    assert.equal(attr(link, 'href'), '#main-content')

    const targets = out.match(/<[a-z]+ [^>]*\bid="main-content"[^>]*>/g) ?? []
    assert.equal(targets.length, 1, 'one element carries the id')
    assert.match(targets[0], /^<main /, 'it is the main landmark')
    assert.equal(attr(targets[0], 'tabindex'), '-1')
    assert.equal(out.match(/<main\b/g).length, 1, 'the app has one main landmark')

    // The main column holds the one floating card, and not the sidebar.
    const start = out.indexOf(targets[0])
    const end = out.indexOf('</main>')
    const card = out.indexOf('class="surface-card')
    assert.ok(start < card && card < end, 'the surface card is inside it')
    assert.ok(out.indexOf('</nav>') < start, 'the sidebar is not')
  })
}
