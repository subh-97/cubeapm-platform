// The template drawer (TemplateDrawer.jsx), rendered. The risks: a drawer that
// is not a dialog a keyboard can live in; categories that do not say how many
// each holds; a card whose condition reads differently from the rule it
// makes; sixteen buttons all named just "Use template"; and a template
// someone already uses offered as if new.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server.browser'
import { resolveWindow } from '@/data/timeWindow'
import { draftFromPayload, ruleFromDraft } from '@/utils/alerts/editorDraft'
import { tiersOf } from '@/utils/alerts/condition'
import { RULE_TEMPLATES } from '@/utils/alerts/ruleTemplates'
import TemplateDrawer from './TemplateDrawer.jsx'

const hour = resolveWindow({ kind: 'preset', value: '1h' })
const noop = () => {}
const render = props => renderToStaticMarkup(
  <TemplateDrawer win={hour} rules={[]} onPick={noop} onScratch={noop} onClose={noop} {...props} />,
)
const ENTITIES = { '&#x27;': '\'', '&amp;': '&', '&gt;': '>', '&lt;': '<', '&quot;': '"' }
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&amp;|&gt;|&lt;|&quot;/g, e => ENTITIES[e]).replace(/\s+/g, ' ').trim()
const cards = html => [...html.matchAll(/<li class="tpl-card">([\s\S]*?)<\/li>/g)].map(m => m[1])

test('a dialog titled Browse Templates, with a search, the categories as counted capsules, and a way out to scratch', () => {
  const html = render()
  assert.match(html, /role="dialog" aria-modal="true"/)
  assert.match(html, /class="settings-drawer open cfg-drawer tpl-drawer"/)
  assert.match(html, />Browse Templates<\/h2>/)
  assert.match(html, /aria-label="Search templates"/)
  assert.doesNotMatch(html, /tpl-lead/, 'no lead line: the cards say what they do')
  assert.match(html, /role="radiogroup" aria-label="Template categories"/)
  const chips = [...html.matchAll(/<button[^>]*role="radio"[^>]*>([\s\S]*?)<\/button>/g)].map(m => m[1])
  assert.deepEqual(chips.map(c => text(c)), ['All 16', 'Services 5', 'Dependencies 3', 'Logs 2', 'Hosts 2', 'Kubernetes 4'])
  assert.doesNotMatch(chips[0], /chip-icon/, 'All carries no mark')
  assert.ok(chips.slice(1).every(c => /<span class="chip-icon" aria-hidden="true">/.test(c)), 'every category carries its mark')
  assert.match(chips[5], /class="infra-source-icon-svg"/, 'Kubernetes is the vendor\'s mark')
  assert.match(html, /role="radio" aria-checked="true" tabindex="0" class="chip is-on">All/)
  assert.match(text(html), /Nothing here fits\? Create a rule from scratch$/)
})

test('a card says what it watches, the condition in the rule list\'s words, and a blue button named for it', () => {
  const html = render()
  const all = cards(html)
  assert.equal(all.length, RULE_TEMPLATES.length)
  const errorRate = text(all[0])
  assert.match(errorRate, /^APM · Services Service error rate high Warns when more than 1% /)
  assert.match(errorRate, /Error % > 3% critical, > 1% warning, for 5m · one alert per service/)
  assert.doesNotMatch(all[0], /tpl-preview|tpl-strip/, 'no preview on the card: the editor previews')
  assert.match(all[0], /<button type="button" class="hbtn primary tpl-use" aria-label="Use template: Service error rate high">/)
  assert.match(text(all.find(c => /Redis connections climbing/.test(c))), /Redis clients > 200 critical, > 150 warning, for 5m · one alert per instance/)
  assert.match(text(all.find(c => /Pods crash-looping/.test(c))), /K8s event count > 35, for 10m · one alert per namespace/)
  // The vendor's mark for infrastructure, the sidebar's glyph for APM and Logs.
  assert.match(all.find(c => /Redis connections climbing/.test(c)), /class="infra-source-icon-svg"/)
  assert.match(all[0], /class="lucide lucide-activity tpl-source-glyph"/)
})

test('a template a rule already uses says so, and names the rule', () => {
  const t = RULE_TEMPLATES.find(x => x.id === 'redis-clients')
  const rule = ruleFromDraft(draftFromPayload(t.payload()))
  const html = render({ rules: [{ name: 'Redis pool', baseQuery: tiersOf(rule).query, datasource: 'metrics' }] })
  const used = cards(html).filter(c => /tpl-inuse/.test(c))
  assert.equal(used.length, 1)
  assert.match(used[0], /Redis connections climbing/)
  assert.match(used[0], /<span class="tpl-inuse" title="Already used by Redis pool">In use<\/span>/)
})
