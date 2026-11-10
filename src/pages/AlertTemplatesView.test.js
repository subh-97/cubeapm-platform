// Browse Templates (/alerts/templates), rendered from a URL the way a cold load
// or a shared link renders it. The risks: a page that loses its way back to
// Alerts; a rail whose layers or counts disagree with the catalogue (a
// template counted twice, or in the wrong home); a view that drops what its
// URL says; a card missing a part of its definition, or a template the
// platform cannot run offered as if it could be used; a card that cannot say
// which rules already use it; an empty view that does not say what emptied it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server.browser'
import { MemoryRouter } from 'react-router-dom'
import {
  RULE_TEMPLATES, DOMAINS, SUBDOMAINS, PROBLEM_TYPES, DATA_SOURCES, HOSTINGS,
  domainOf, filterTemplates, templateCounts, templatePayload, templateSource, fullName, visitingIn,
} from '@/utils/alerts/ruleTemplates'
import { draftFromPayload, ruleFromDraft } from '@/utils/alerts/editorDraft'
import { alertsStore } from '@/utils/alerts/store'
import TemplateCard from '@/components/alerts/templates/TemplateCard'
import AlertTemplatesView from './AlertTemplatesView.jsx'

const noop = () => {}
// React says so once per useLayoutEffect on the server; nothing else is expected.
const EXPECTED = /useLayoutEffect does nothing on the server/
function quietly(render) {
  const { warn, error } = console
  const quiet = log => (...args) => { if (!EXPECTED.test(String(args[0]))) log(...args) }
  console.warn = quiet(warn)
  console.error = quiet(error)
  try {
    return render()
  } finally {
    console.warn = warn
    console.error = error
  }
}
const page = (search = '') => quietly(() => renderToStaticMarkup(
  <MemoryRouter initialEntries={[`/alerts/templates${search}`]}>
    <AlertTemplatesView goHome={noop} timeRange={{ kind: 'preset', value: '1h' }} setTimeRange={noop} setToast={noop} onOpenLink={noop} />
  </MemoryRouter>,
))
const ENTITIES = { '&#x27;': '\'', '&amp;': '&', '&gt;': '>', '&lt;': '<', '&quot;': '"' }
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&amp;|&gt;|&lt;|&quot;/g, e => ENTITIES[e]).replace(/\s+/g, ' ').trim()
const esc = str => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const html = str => str.replace(/&/g, '&amp;').replace(/'/g, '&#x27;').replace(/"/g, '&quot;')
// A card's markup runs to the next card (its tags are list items of their own).
const cards = markup => markup.split(/(?=<li class="tpl-card)/).slice(1)
const titles = markup => [...markup.matchAll(/<h3 class="tpl-title">([^<]+)<\/h3>/g)].map(m => text(m[1]))
const railRows = markup => [...markup.matchAll(/<button type="button" class="svc-sidebar-item tpl-rail-row[^"]*"[^>]*>([\s\S]*?)<\/button>/g)].map(m => m[0])
const meta = markup => text(/<span class="tpl-scope-meta" role="status">([\s\S]*?)<\/span>/.exec(markup)[1])
const clears = markup => (markup.match(/>Clear search and filters<\/button>/g) ?? []).length
const emptyTitle = markup => text(/<div class="[^"]*tpl-empty[^"]*">[\s\S]*?<h3 class="[^"]*">([\s\S]*?)<\/h3>/.exec(markup)?.[1] ?? '')

test('a page of Alerts: its crumbs lead back, it has no time picker, and a rule can still start blank', () => {
  const markup = page()
  const crumbs = [...markup.matchAll(/<span class="crumb-seg[^"]*">[\s\S]*?<span class="crumb-body">([\s\S]*?)<\/span><\/span>/g)].map(m => m[1])
  assert.deepEqual(crumbs.slice(-3).map(text), ['CubeAPM', 'Alerts', 'Browse Templates'])
  assert.match(markup, /<span class="crumb-body"><a href="\/alerts">Alerts<\/a><\/span>/, 'Alerts is the way back')
  assert.match(markup, /<span class="current">Browse Templates<\/span>/)
  assert.match(markup, /<h1 class="sr-only">Browse Templates<\/h1>/)
  assert.doesNotMatch(markup, /Last 1 hour/, 'configuration, not history: no time picker')
  assert.match(markup, /<a class="hbtn" href="\/alerts\/new">[\s\S]*?Create from scratch<\/a>/)
})

test('the rail is the two layers, every template counted once at its home, and counts what a search leaves', () => {
  const markup = page()
  assert.deepEqual(railRows(markup).map(r => text(r)), [
    'All templates 37',
    'APM 17', 'Services 9', 'Errors 4', 'Mobile 2', 'Browser 2',
    'Cloud & Hosts 6', 'Host 6',
    'Containers & Kubernetes 6', 'Kubernetes 6',
    'Databases 8', 'MySQL 4', 'PostgreSQL 4',
  ])
  assert.match(railRows(markup)[0], /aria-current="true"/, 'All templates is the view')
  assert.match(markup, /<nav class="tpl-rail" aria-label="Template categories">/)
  // Under a search, each row counts what the search leaves at its homes.
  const found = filterTemplates(RULE_TEMPLATES, {}, { q: 'k8s' })
  assert.ok(found.length > 0)
  const rows = railRows(page('?q=k8s')).map(r => text(r))
  assert.equal(rows[0], `All templates ${found.length}`)
  assert.ok(rows.includes(`Kubernetes ${found.filter(t => t.home === 'kubernetes').length}`))
  assert.ok(rows.includes('MySQL 0'), 'a row the search empties says 0, and stays to be chosen')
})

// Each Domain's chevron, and whether the Sub-domains it controls are open.
// Each head's chevron — All templates, then every Domain — and whether what it controls is open.
const HEADS = [['all', 'All templates'], ...DOMAINS.map(d => [d.id, d.label])]
const accordion = markup => HEADS.map(([id, label]) => {
  const toggle = new RegExp(`<button type="button" class="tpl-rail-toggle" aria-expanded="(true|false)" aria-controls="([^"]+)" aria-label="${esc(html(label))} categories" title="(Collapse|Expand) ${esc(html(label))}">`).exec(markup)
  assert.ok(toggle, `${id}: a labelled chevron`)
  const subs = new RegExp(`<div id="${esc(toggle[2])}" class="tpl-rail-subs( is-closed)?">`).exec(markup)
  assert.ok(subs, `${id}: the chevron controls the rows under it`)
  assert.equal(toggle[1] === 'true', !subs[1], `${id}: the chevron says what the list is`)
  assert.equal(toggle[3], toggle[1] === 'true' ? 'Collapse' : 'Expand', id)
  return [id, toggle[1] === 'true']
})

test('the rail is a tree of accordions: All templates and the Domain in view open with the page, the rest start closed', () => {
  const markup = page()
  assert.doesNotMatch(markup, /svc-sidebar-label|>Categories</, 'no "Categories" label: All templates heads the rail')
  assert.deepEqual(accordion(markup), HEADS.map(([id]) => [id, id === 'all']), 'All templates: five rows until one is asked for')
  for (const d of DOMAINS) {
    const open = HEADS.map(([id]) => [id, id === 'all' || id === d.id])
    assert.deepEqual(accordion(page(`?domain=${d.id}`)), open, d.id)
    for (const sub of d.subs) assert.deepEqual(accordion(page(`?sub=${sub}`)), open, sub)
  }
  // The Domains sit under All templates, the Sub-domains under their Domain, a level in each time; each row scopes the page and its chevron is a control of its own.
  const mysql = page('?sub=mysql')
  assert.match(mysql, /<div class="tpl-rail-head"><button type="button" class="svc-sidebar-item tpl-rail-row tpl-rail-l0" data-node="all">/)
  assert.match(mysql, /<div class="tpl-rail-head"><button type="button" class="svc-sidebar-item tpl-rail-row tpl-rail-l1" data-node="databases" data-parent="all">/)
  assert.match(mysql, /<button type="button" class="svc-sidebar-item tpl-rail-row tpl-rail-l2 svc-sidebar-child active" data-parent="databases" aria-current="true">/)
  // Only a Sub-domain carries a mark; All templates and the Domains are names alone.
  for (const r of railRows(mysql)) assert.equal(/tpl-rail-mark/.test(r), /tpl-rail-l2/.test(r), text(r))
  const tree = mysql.slice(mysql.indexOf('<nav class="tpl-rail"'), mysql.indexOf('</nav>'))
  const allChildren = new RegExp(`aria-label="All templates categories"[\\s\\S]*?<div id="([^"]+)" class="tpl-rail-subs">`).exec(tree)
  assert.ok(allChildren && DOMAINS.every(d => tree.indexOf(`data-node="${d.id}"`) > tree.indexOf(`id="${allChildren[1]}"`)), 'every Domain is inside All templates')
})

test('the URL scopes the page: a Sub-domain lists its own first, then what is also listed there', () => {
  for (const sub of Object.keys(SUBDOMAINS)) {
    const markup = page(`?sub=${sub}`)
    const want = filterTemplates(RULE_TEMPLATES, { domain: SUBDOMAINS[sub].domain, sub })
    assert.deepEqual(titles(markup), want.map(t => t.title), sub)
    const current = railRows(markup).find(r => /aria-current="true"/.test(r))
    assert.equal(text(current).replace(/ \d+$/, ''), SUBDOMAINS[sub].label, sub)
    const homed = templateCounts(RULE_TEMPLATES).subs[sub]
    assert.match(meta(markup), new RegExp(`^${esc(domainOf(sub).label)} · ${homed} templates?$`), sub)
    // Every card's path names its home, a template listed here from elsewhere included.
    cards(markup).forEach((c, i) => {
      assert.match(c, new RegExp(`<span class="tpl-path">[\\s\\S]*?${esc(html(domainOf(want[i].home).label))} · ${esc(SUBDOMAINS[want[i].home].label)}</span>`), `${sub}: ${want[i].id}`)
      assert.doesNotMatch(c, /tpl-parent|Also in|From </, `${sub}: ${want[i].id}: no parents line`)
    })
  }
})

test('a Domain counts what it holds as the rail does, and a card from another Domain names its home', () => {
  const counts = templateCounts(RULE_TEMPLATES)
  for (const d of DOMAINS) {
    const markup = page(`?domain=${d.id}`)
    const want = filterTemplates(RULE_TEMPLATES, { domain: d.id })
    assert.deepEqual(titles(markup), want.map(t => t.title), d.id)
    const visiting = want.filter(t => visitingIn(t, { domain: d.id })).length
    assert.equal(want.length - visiting, counts.domains[d.id], d.id)
    assert.match(meta(markup), new RegExp(`^${counts.domains[d.id]} templates?$`), d.id)
    cards(markup).forEach((c, i) => {
      assert.match(c, new RegExp(`<span class="tpl-path">[\\s\\S]*?${esc(html(domainOf(want[i].home).label))} · ${esc(SUBDOMAINS[want[i].home].label)}</span>`), `${d.id}: ${want[i].id}`)
    })
  }
  // Databases lists the dependency template from Services too, but counts only what it holds, as the rail does.
  assert.match(meta(page('?domain=databases')), /^8 templates$/)
  assert.equal(cards(page('?domain=databases')).length, 9)
})

test('the URL filters the page, and a filtered view offers to clear what filtered it', () => {
  const markup = page('?type=latency&urgency=medium')
  const want = RULE_TEMPLATES.filter(t => t.problem === 'latency' && t.urgency === 'medium')
  assert.ok(want.length > 1)
  assert.deepEqual(new Set(titles(markup)), new Set(want.map(t => t.title)))
  assert.equal(cards(markup).length, want.length)
  assert.equal(clears(markup), 1)
  assert.equal(clears(page()), 0, 'nothing to clear on the plain view')
  // Only the data sources some template reads are offered.
  assert.equal(page('?source=traces').match(/<li class="tpl-card/g).length, RULE_TEMPLATES.length, 'a source no template reads is dropped from the URL')
})

test('a search that empties a category says so, and offers the matches elsewhere', () => {
  const elsewhere = filterTemplates(RULE_TEMPLATES, {}, { q: 'k8s' }).length
  assert.ok(elsewhere > 0)
  assert.equal(filterTemplates(RULE_TEMPLATES, { domain: 'databases', sub: 'mysql' }, { q: 'k8s' }).length, 0)
  const markup = page('?sub=mysql&q=k8s')
  assert.equal(emptyTitle(markup), 'No templates in MySQL match “k8s”')
  assert.match(text(markup), new RegExp(`${elsewhere} templates match in other categories`))
  assert.match(markup, new RegExp(`>Show all ${elsewhere}</button>`))
  assert.equal(clears(markup), 1, 'the head keeps the clear while the empty state offers the rest')
})

test('an empty view names the filters that emptied it, never "in All templates", with one clear', () => {
  const low = page('?sub=mysql&urgency=low')
  assert.equal(emptyTitle(low), 'No MySQL templates with Low urgency')
  const lowAnywhere = RULE_TEMPLATES.filter(t => t.urgency === 'low').length
  assert.match(low, new RegExp(`>Show all ${lowAnywhere}</button>`))
  const none = page('?q=no-such-thing&type=latency')
  assert.equal(emptyTitle(none), 'No templates match “no-such-thing” with Latency')
  assert.doesNotMatch(text(none), /All templates match|in All templates/)
  assert.equal(clears(none), 1, 'the empty state\'s clear, not a second one in the head')
})

test('a card: where it lives, Subject + state, a line of definition, its tags, and its one control', () => {
  const markup = page()
  const all = cards(markup)
  assert.equal(all.length, RULE_TEMPLATES.length)
  const order = filterTemplates(RULE_TEMPLATES)
  all.forEach((c, i) => {
    const t = order[i]
    const home = SUBDOMAINS[t.home]
    const words = text(c)
    assert.match(c, new RegExp(`<span class="tpl-path">[\\s\\S]*?${esc(html(domainOf(t.home).label))} · ${esc(home.label)}</span>`), t.id)
    assert.match(c, new RegExp(`<h3 class="tpl-title">${esc(html(t.title))}</h3>`), t.id)
    assert.match(c, new RegExp(`<p class="tpl-def">${esc(html(t.subtitle))}</p>`), t.id)
    assert.doesNotMatch(words, /Why it matters/, `${t.id}: why it matters goes to the rule's description, not the card`)
    assert.match(c, /<li class="tpl-tag tpl-urgency"[^>]*><span class="status-dot (critical|warning|neutral)" aria-hidden="true"><\/span>(High|Medium|Low) urgency<span class="sr-only">: (wake someone|act today|review)<\/span><\/li>/, t.id)
    assert.match(c, new RegExp(`<li class="tpl-tag">${PROBLEM_TYPES.find(x => x.id === t.problem).label}</li>`), t.id)
    assert.match(c, new RegExp(`<li class="tpl-tag">${DATA_SOURCES.find(x => x.id === templateSource(t)).label}</li>`), t.id)
    for (const h of t.hosting) assert.match(c, new RegExp(`<li class="tpl-tag tpl-hosting">[\\s\\S]*?${HOSTINGS.find(x => x.id === h).label}</li>`), `${t.id}: ${h}`)
    assert.doesNotMatch(c, /tpl-sysid|<code/, `${t.id}: the system ID is not on the card`)
    if (t.blocked) {
      const reason = /<span class="tpl-blocked-why" id="([^"]+)">([^<]+)<\/span>/.exec(c)
      assert.ok(reason, `${t.id} says why it cannot be used`)
      assert.equal(text(reason[2]), t.blocked)
      assert.match(c, new RegExp(`<div class="tpl-card-foot"><span class="tpl-blocked-why"[^>]*>[^<]+</span><button type="button" class="hbtn tpl-use" aria-disabled="true" aria-label="Not available yet: ${esc(html(fullName(t)))}" aria-describedby="${esc(reason[1])}">`), `${t.id}: the reason, then the button at the right`)
      assert.ok(text(c).includes('Not available yet'), 'the name starts with what the button says')
    } else {
      assert.match(c, new RegExp(`<button type="button" class="hbtn primary tpl-use" aria-label="Use template: ${esc(html(fullName(t)))}">`), t.id)
    }
    if (t.needs) assert.ok(words.includes(`Needs ${t.needs}`), t.id)
  })
  // Every control's name is its own, though MySQL and PostgreSQL share titles.
  const names = [...markup.matchAll(/class="hbtn[^"]*tpl-use"[^>]*aria-label="([^"]+)"/g)].map(m => m[1])
  assert.equal(names.length, RULE_TEMPLATES.length)
  assert.equal(new Set(names).size, names.length)
  // Usable templates come before those waiting on data, which come before the blocked.
  const rank = t => (t.blocked ? 2 : t.needs ? 1 : 0)
  assert.deepEqual(order.map(rank), [...order.map(rank)].sort((a, b) => a - b))
})

test('a card in use names the rules, to a pointer and to a screen reader', () => {
  const t = RULE_TEMPLATES.find(x => !x.blocked && !x.needs)
  const markup = renderToStaticMarkup(<TemplateCard template={t} usedBy={[{ name: 'Checkout errors' }]} />)
  const pill = /<span class="tpl-inuse" id="([^"]+)" title="Already used by Checkout errors">In use<span class="sr-only"> by Checkout errors<\/span><\/span>/.exec(markup)
  assert.ok(pill, markup)
  assert.match(markup, new RegExp(`aria-label="Use template: ${esc(html(fullName(t)))}" aria-describedby="${esc(pill[1])}"`))
  assert.doesNotMatch(renderToStaticMarkup(<TemplateCard template={t} />), /tpl-inuse|aria-describedby/)
})

test('a rule saved from a template marks its card In use, and only its card', () => {
  const t = RULE_TEMPLATES.find(x => !x.blocked && !x.needs)
  const { undo } = alertsStore().actions.saveRule(ruleFromDraft({ ...draftFromPayload(templatePayload(t)), name: 'Checkout errors', receiverGroupIds: [11] }))
  try {
    const inUse = cards(page()).filter(c => c.includes('tpl-inuse'))
    assert.equal(inUse.length, 1)
    assert.match(inUse[0], new RegExp(`<h3 class="tpl-title">${esc(html(t.title))}</h3>`))
    assert.match(inUse[0], /<span class="tpl-inuse" id="[^"]+" title="Already used by Checkout errors">In use/)
  } finally {
    undo()
  }
  assert.ok(cards(page()).every(c => !c.includes('tpl-inuse')), 'the seed uses no template')
})
