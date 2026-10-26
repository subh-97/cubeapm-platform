// TableQuerySearch gained one prop, `defaultValue`, so a page that carries its
// search in the URL (Alerts' ?q=) can seed the box instead of showing it empty
// while the list underneath is filtered. Home and Infra pass no such prop, and
// must draw exactly what they drew before it existed.
//
// The fixtures below are the component's markup as committed before the prop
// was added, rendered for the three field sets those pages use. Every default
// render is compared to them character for character.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server.browser'
import TableQuerySearch from './TableQuerySearch.jsx'
import { HOST_FIELDS, POD_FIELDS, SERVICE_FIELDS } from '@/utils/tableQuery'

const noop = () => {}

/* ── Fixtures: the pre-`defaultValue` markup, verbatim ── */
const BEFORE = {
  host: "<div class=\"pod-search-wrap\"><div class=\"svc-search pod-search-field\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" aria-hidden=\"true\"><circle cx=\"11\" cy=\"11\" r=\"7\"></circle><path d=\"M21 21l-4.3-4.3\"></path></svg><div class=\"pod-search-ink-wrap\"><div class=\"pod-search-ink\" aria-hidden=\"true\"></div><input type=\"text\" placeholder=\"Search host or service ( eg. host:abc AND service:def )\" aria-label=\"Search host or service ( eg. host:abc AND service:def )\" spellcheck=\"false\" autoComplete=\"off\" value=\"\"/></div></div></div>",
  pod: "<div class=\"pod-search-wrap\"><div class=\"svc-search pod-search-field\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" aria-hidden=\"true\"><circle cx=\"11\" cy=\"11\" r=\"7\"></circle><path d=\"M21 21l-4.3-4.3\"></path></svg><div class=\"pod-search-ink-wrap\"><div class=\"pod-search-ink\" aria-hidden=\"true\"></div><input type=\"text\" placeholder=\"Search pod or namespace ( eg. pod:abc AND pod.tag:value )\" aria-label=\"Search pod or namespace ( eg. pod:abc AND pod.tag:value )\" spellcheck=\"false\" autoComplete=\"off\" value=\"\"/></div></div></div>",
  service: "<div class=\"pod-search-wrap\"><div class=\"svc-search pod-search-field\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" aria-hidden=\"true\"><circle cx=\"11\" cy=\"11\" r=\"7\"></circle><path d=\"M21 21l-4.3-4.3\"></path></svg><div class=\"pod-search-ink-wrap\"><div class=\"pod-search-ink\" aria-hidden=\"true\"></div><input type=\"text\" placeholder=\"Search service ( eg. service:abc or service.tag:value )\" aria-label=\"Search service ( eg. service:abc or service.tag:value )\" spellcheck=\"false\" autoComplete=\"off\" value=\"\"/></div></div></div>",
}

test('without defaultValue, every field set draws exactly what it drew before', () => {
  assert.equal(renderToStaticMarkup(<TableQuerySearch onApply={noop} fields={HOST_FIELDS} />), BEFORE.host)
  assert.equal(renderToStaticMarkup(<TableQuerySearch onApply={noop} fields={POD_FIELDS} />), BEFORE.pod)
  assert.equal(renderToStaticMarkup(<TableQuerySearch onApply={noop} fields={SERVICE_FIELDS} />), BEFORE.service)
})

test('an empty defaultValue is the same as none', () => {
  assert.equal(renderToStaticMarkup(<TableQuerySearch onApply={noop} fields={HOST_FIELDS} defaultValue="" />), BEFORE.host)
})

test('a defaultValue seeds the box, so a query that arrives in a link is visible', () => {
  const out = renderToStaticMarkup(<TableQuerySearch onApply={noop} fields={SERVICE_FIELDS} defaultValue="service:payment" />)
  assert.match(out, /value="service:payment"/)
})
