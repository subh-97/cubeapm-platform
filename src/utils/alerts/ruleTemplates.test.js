// The template catalogue behind Browse Templates (ruleTemplates.js). The risks:
// a layer that drifts from the brief (eight Sub-domains in four Domains, a set
// number in each); a card that breaks its own grammar (a title over 45
// characters, a definition that runs on); a template that opens the editor on
// a rule it cannot save; one whose preview is a dead end with no word why;
// one that cries wolf in the demo it ships in, or never catches the incident
// its data moves with; a notification that reads like the catalogue; a search
// that misses a name people use ("k8s", "postgres", "rds"); and a template
// counted twice.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  RULE_TEMPLATES, DOMAINS, SUBDOMAINS, PROBLEM_TYPES, DATA_SOURCES, SOURCES_IN_USE, URGENCIES, HOSTINGS,
  domainOf, fullName, templatePayload, templateSource, filterTemplates, templateCounts, rulesUsing, visitingIn,
} from './ruleTemplates'
import { parseTemplatesSearch, templatesSearch } from './templatesUrl'
import { draftFromPayload, ruleFromDraft, validateDraft } from './editorDraft'
import { tiersOf } from './condition'
import { ruleMetric, ruleView } from './model'
import { renderTemplate, templateLabels, usesTemplate } from './template'
import { previewRule, ALERTS_NOW } from '@/data/alerts'
import { resolveWindow, INCIDENT_START_MIN } from '@/data/timeWindow'

const hour = resolveWindow({ kind: 'preset', value: '1h' })
const day = resolveWindow({ kind: 'preset', value: '24h' })
const ruleOf = t => ruleFromDraft({ ...draftFromPayload(templatePayload(t)), receiverGroupIds: [11] })
const ids = list => new Set(list.map(x => x.id))
const byId = id => RULE_TEMPLATES.find(t => t.id === id)

// ---------- The layers ----------

test('four Domains, eight Sub-domains named as the Infrastructure page and the sidebar name them', () => {
  assert.deepEqual(DOMAINS.map(d => [d.label, d.subs.map(s => SUBDOMAINS[s].label)]), [
    ['APM', ['Services', 'Errors', 'Mobile', 'Browser']],
    ['Cloud & Hosts', ['Host']],
    ['Containers & Kubernetes', ['Kubernetes']],
    ['Databases', ['MySQL', 'PostgreSQL']],
  ])
  for (const d of DOMAINS) for (const s of d.subs) assert.equal(domainOf(s), d, s)
})

test('the brief\'s count in every Sub-domain, each template counted once, at its home', () => {
  const homed = id => RULE_TEMPLATES.filter(t => t.home === id).length
  assert.deepEqual(
    Object.fromEntries(Object.keys(SUBDOMAINS).map(id => [id, homed(id)])),
    { services: 9, errors: 4, mobile: 2, browser: 2, host: 6, kubernetes: 6, mysql: 4, postgresql: 4 },
  )
  assert.equal(RULE_TEMPLATES.length, 37)
  const counts = templateCounts(RULE_TEMPLATES)
  assert.equal(counts.all, 37)
  assert.equal(Object.values(counts.subs).reduce((a, b) => a + b, 0), 37)
  assert.equal(Object.values(counts.domains).reduce((a, b) => a + b, 0), 37)
})

// ---------- A card's grammar ----------

test('every template keeps the card\'s grammar and uses only the catalogue\'s words', () => {
  assert.equal(new Set(RULE_TEMPLATES.map(t => t.id)).size, RULE_TEMPLATES.length, 'system IDs are unique')
  for (const t of RULE_TEMPLATES) {
    assert.match(t.id, new RegExp(`^${t.home}\\.[a-z0-9-]+$`), `${t.id}: "<home>.<slug>"`)
    assert.ok(t.title.length <= 45, `${t.id}: "${t.title}" is over 45 characters`)
    assert.match(t.title, /^[A-Za-z0-9]/, t.id)
    assert.ok(!t.title.startsWith(`${SUBDOMAINS[t.home].label}:`), `${t.id}: the title does not repeat its Sub-domain`)
    assert.ok(t.subtitle.length <= 110 && t.why.length <= 110, `${t.id}: a definition line runs on`)
    assert.ok(t.alsoIn.every(s => SUBDOMAINS[s] && s !== t.home), `${t.id}: Also in names other Sub-domains`)
    assert.ok(ids(PROBLEM_TYPES).has(t.problem) && ids(URGENCIES).has(t.urgency), t.id)
    assert.ok(t.hosting.every(h => ids(HOSTINGS).has(h)), t.id)
    assert.ok(ids(DATA_SOURCES).has(templateSource(t)), t.id)
    assert.ok(Array.isArray(t.aliases), t.id)
  }
  assert.equal(fullName(byId('mysql.connections-near-limit')), 'MySQL: Connections near limit')
  assert.equal(fullName(byId('services.error-rate-high')), 'Services: Error rate is high')
  assert.equal(fullName(byId('kubernetes.node-not-ready')), 'Kubernetes: Node is not ready')
})

test('a subtitle says how long the condition holds, in the figure the payload holds it', () => {
  for (const t of RULE_TEMPLATES) {
    const { forSec = 0, intervalSec } = t.payload
    if (!forSec) continue
    if (intervalSec && forSec === intervalSec) assert.match(t.subtitle, /twice running/, t.id)
    else assert.match(t.subtitle, new RegExp(`\\b(held|for) ${forSec / 60} min`), t.id)
  }
})

test('a summary is one firing series in its own words: its labels, its value, no thresholds', () => {
  for (const t of RULE_TEMPLATES) {
    assert.ok(usesTemplate(t.summary), `${t.id}: the summary names the series`)
    // Lower case: Kubernetes' own "Warning" events are a subject, not a tier.
    assert.doesNotMatch(t.summary, /\b(warns?|warning|critical|threshold|above|below)\b/, `${t.id}: the tiers are the rule's, and a tune changes them`)
    const blank = t.summary.replace(/\{\{[\s\S]*?\}\}/g, '')
    for (const tier of Object.values(t.payload.tiers ?? {})) {
      if (tier.threshold != null && tier.threshold !== 0) assert.doesNotMatch(blank, new RegExp(`(^|[^\\w.])${tier.threshold}(?![\\w.])`), `${t.id} states a threshold`)
    }
  }
})

test('"Use template" hands the editor the full name, the Sub-domain as folder, the two lines, and a tag that knows the template', () => {
  const t = RULE_TEMPLATES.find(x => !x.blocked)
  const p = templatePayload(t)
  assert.equal(p.name, fullName(t))
  assert.equal(p.group, SUBDOMAINS[t.home].label)
  assert.equal(p.summary, t.summary)
  assert.equal(p.description, `Why it matters: ${t.why}`)
  assert.deepEqual(p.tags, { template: t.id })
  assert.equal(p.from, 'templates')
  const saved = ruleOf(t)
  assert.equal(saved.labels.template, t.id)
  assert.equal(saved.labels.group, SUBDOMAINS[t.home].label)
  assert.equal(saved.annotations.summary, t.summary)
  if (t.payload.model) assert.notEqual(p.model, t.payload.model, 'a copy: the editor cannot change the catalogue')
})

// ---------- Against the demo's data ----------

for (const t of RULE_TEMPLATES.filter(x => !x.blocked)) {
  test(`${fullName(t)}: a rule whose only gap is who to tell, ${t.needs ? `waiting on ${t.needs}` : 'reading real data'}`, () => {
    const draft = draftFromPayload(templatePayload(t))
    assert.deepEqual(validateDraft(draft).map(p => p.field), ['notify'])
    const preview = previewRule(ruleOf(t), hour)
    assert.equal(preview.error, null)
    if (t.needs) assert.equal(preview.series.length, 0, 'the demo has none of it, and the card says which source it waits on')
    else assert.ok(preview.series.length > 0, 'reads data')
    assert.notEqual(ruleMetric(ruleOf(t)).metric, 'Value', 'the rule list can name what it measures')
    // The summary reads labels the series carry: every one, on every series.
    if (!t.needs) {
      for (const s of preview.series) assert.doesNotMatch(renderTemplate(t.summary, { labels: s.labels, value: 1 }), /<no value>/, `${t.id}: ${JSON.stringify(s.labels)}`)
    } else {
      // No series to read: a label is one the query names, or one every scrape carries.
      for (const key of templateLabels(t.summary)) assert.ok(tiersOf(ruleOf(t)).query.includes(key) || ['instance', 'node'].includes(key), `${t.id}: ${key}`)
    }
  })
}

test('a template the platform cannot run says why, and is not handed to the editor as if it could', () => {
  const blocked = RULE_TEMPLATES.filter(t => t.blocked)
  // Mobile alerts are deferred (Q6); Browser's are Logs rules, which run, waiting only on their events.
  assert.deepEqual(blocked.map(t => t.home), ['mobile', 'mobile'])
  for (const t of blocked) {
    assert.match(t.blocked, /^[A-Z].*\.$/, `${t.id}: the reason is a sentence`)
    assert.equal(templateSource(t), 'mobile', t.id)
    assert.equal(t.needs, null, `${t.id}: one reason, not two`)
  }
  for (const t of RULE_TEMPLATES.filter(x => x.home === 'browser')) assert.equal(templateSource(t), 'logs', t.id)
})

// The payment incident, with room for a five-minute check that reaches back into its first minutes.
const INCIDENT_FROM = ALERTS_NOW - INCIDENT_START_MIN * 60 - 300

test('none cries wolf: over a day, everything a template fires on is the incident', () => {
  for (const t of RULE_TEMPLATES.filter(x => !x.blocked && !x.needs)) {
    const early = previewRule(ruleOf(t), day).lane.filter(iv => iv.state === 'firing' && iv.start < INCIDENT_FROM)
    assert.deepEqual(early, [], `${t.id} fired before the incident`)
  }
})

// Their data moves with the payment incident.
const CATCHES = [
  'services.error-rate-high', 'services.p90-latency-high', 'services.avg-latency-up', 'services.endpoint-error-rate-high',
  'services.endpoint-p99-latency-high', 'services.version-error-rate-high', 'services.dependency-calls-surging',
  'errors.exceptions-spiking', 'errors.5xx-climbing', 'host.cpu-high', 'host.memory-climbing',
]
// Theirs does not: traffic holds, every host fails alike, Kubernetes and the host's own links are untouched.
const QUIET = [
  'services.traffic-stopped', 'services.traffic-anomaly', 'errors.host-error-rate', 'host.network-dropped', 'host.not-reporting',
  'kubernetes.pod-cpu-high', 'kubernetes.pods-crash-looping', 'kubernetes.warning-events-surging',
]

test('the incident is caught where its data moves with it, and the rest stay quiet through it', () => {
  for (const id of [...CATCHES, ...QUIET]) assert.ok(byId(id) && !byId(id).needs && !byId(id).blocked, id)
  for (const id of CATCHES) assert.ok(previewRule(ruleOf(byId(id)), hour).incidents > 0, `${id} missed the incident`)
  for (const id of QUIET) assert.equal(previewRule(ruleOf(byId(id)), hour).incidents, 0, `${id} fired`)
})

// ---------- Finding a template ----------

test('a Sub-domain lists its own and what is also listed there; a Domain lists its Sub-domains\'', () => {
  for (const sub of Object.keys(SUBDOMAINS)) {
    const shown = filterTemplates(RULE_TEMPLATES, { sub })
    assert.deepEqual(new Set(shown.map(t => t.id)), new Set(RULE_TEMPLATES.filter(t => t.home === sub || t.alsoIn.includes(sub)).map(t => t.id)), sub)
  }
  const dbs = filterTemplates(RULE_TEMPLATES, { domain: 'databases' })
  assert.ok(dbs.every(t => [t.home, ...t.alsoIn].some(s => SUBDOMAINS[s].domain === 'databases')))
  // A scope's own come first; what is listed there from elsewhere follows.
  const scopes = [...Object.keys(SUBDOMAINS).map(sub => ({ sub })), ...DOMAINS.map(d => ({ domain: d.id }))]
  for (const scope of scopes) {
    const visiting = filterTemplates(RULE_TEMPLATES, scope).map(t => visitingIn(t, scope))
    assert.deepEqual(visiting, [...visiting].sort((a, b) => a - b), JSON.stringify(scope))
  }
  // What a Domain holds itself is what the rail counts for it.
  const counts = templateCounts(RULE_TEMPLATES)
  for (const d of DOMAINS) {
    assert.equal(filterTemplates(RULE_TEMPLATES, { domain: d.id }).filter(t => !visitingIn(t, { domain: d.id })).length, counts.domains[d.id], d.id)
  }
  assert.deepEqual(filterTemplates(RULE_TEMPLATES, { domain: 'databases' }).filter(t => visitingIn(t, { domain: 'databases' })).map(t => t.id), ['services.dependency-calls-surging'])
  assert.equal(visitingIn(byId('host.cpu-high'), {}), false, 'nothing visits All templates')
})

test('search reads names, parents and aliases, every word: k8s, postgres, rds, the full name', () => {
  const homes = q => new Set(filterTemplates(RULE_TEMPLATES, {}, { q }).map(t => t.home))
  assert.ok(homes('k8s').has('kubernetes'))
  assert.ok(homes('postgres').has('postgresql') && homes('postgress').has('postgresql'), 'and the misspelling people type')
  assert.ok(homes('rds').has('mysql') && homes('rds').has('postgresql'))
  assert.deepEqual(homes('aws postgres'), new Set(['postgresql']), 'every word: PostgreSQL\'s, on AWS')
  const t = RULE_TEMPLATES.find(x => x.home === 'mysql')
  assert.deepEqual(filterTemplates(RULE_TEMPLATES, {}, { q: fullName(t) }).map(x => x.id).includes(t.id), true, 'the full alert name finds it')
  assert.equal(filterTemplates(RULE_TEMPLATES, {}, { q: 'no-such-thing' }).length, 0)
})

test('filters narrow by problem type, data source and urgency, every option finds some; the best come first', () => {
  const check = (key, options, of) => {
    for (const id of ids(options)) {
      const found = filterTemplates(RULE_TEMPLATES, {}, { [key]: id })
      assert.ok(found.length > 0, `${key}=${id} finds nothing`)
      assert.ok(found.every(t => of(t) === id), `${key}=${id}`)
      // The rail counts what the filter leaves, once each, at its home.
      const counts = templateCounts(RULE_TEMPLATES, { [key]: id })
      assert.equal(counts.all, found.length)
      assert.equal(Object.values(counts.subs).reduce((a, b) => a + b, 0), found.length)
      assert.equal(Object.values(counts.domains).reduce((a, b) => a + b, 0), found.length)
    }
  }
  check('problem', PROBLEM_TYPES, t => t.problem)
  check('source', SOURCES_IN_USE, templateSource)
  check('urgency', URGENCIES, t => t.urgency)
  assert.deepEqual([...ids(SOURCES_IN_USE)], ['metrics', 'logs', 'mobile'], 'no template reads Traces, so the filter does not offer it')
  assert.ok(ids(DATA_SOURCES).has('traces'), 'though a card could still say so')
  const order = filterTemplates(RULE_TEMPLATES)
  const rank = t => (t.blocked ? 2 : t.needs ? 1 : 0)
  for (let i = 1; i < order.length; i++) assert.ok(rank(order[i - 1]) <= rank(order[i]), 'usable, then waiting, then blocked')
})

test('a rule made from a template, or running its query unchanged, marks it In use', () => {
  const t = RULE_TEMPLATES.find(x => !x.blocked)
  const base = tiersOf(ruleOf(t)).query
  assert.equal(rulesUsing(t, [{ tags: { template: t.id } }], base).length, 1)
  assert.equal(rulesUsing(t, [{ tags: {}, baseQuery: base, datasource: templateSource(t) }], base).length, 1)
  assert.equal(rulesUsing(t, [{ tags: {}, baseQuery: `${base} `, datasource: templateSource(t) }], base).length, 0)
  // Through the model, as the rule list holds a saved rule: its tag survives.
  assert.equal(rulesUsing(t, [ruleView(ruleOf(t))], null).length, 1)
  assert.equal(rulesUsing(RULE_TEMPLATES.find(x => x !== t && !x.blocked), [ruleView(ruleOf(t))], null).length, 0)
})

test('an error rate per endpoint keeps every route: only the p99 sets slow-by-design batch routes aside', () => {
  assert.doesNotMatch(tiersOf(ruleOf(byId('services.endpoint-error-rate-high'))).query, /root_name!~/)
  assert.match(tiersOf(ruleOf(byId('services.endpoint-p99-latency-high'))).query, /root_name!~"\.\*\/batch"/)
})

// ---------- The URL ----------

test('the view round-trips through its own keys, and drops what it does not know', () => {
  const view = { domain: 'databases', sub: 'mysql', q: 'lag ', problem: 'latency', source: 'metrics', urgency: 'medium' }
  const search = templatesSearch(view)
  assert.equal(search, '?sub=mysql&q=lag+&type=latency&source=metrics&urgency=medium')
  assert.deepEqual(parseTemplatesSearch(search), view, 'a Sub-domain names its Domain')
  assert.deepEqual(parseTemplatesSearch('?domain=apm'), { domain: 'apm', sub: null, q: '', problem: null, source: null, urgency: null })
  const nothing = { domain: null, sub: null, q: '', problem: null, source: null, urgency: null }
  assert.deepEqual(parseTemplatesSearch('?sub=redis&type=vibes&domain=x'), nothing)
  for (const key of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    assert.deepEqual(parseTemplatesSearch(`?sub=${key}`), nothing, `${key} is on every object, not a Sub-domain`)
    assert.equal(templatesSearch({ sub: key }), '', key)
  }
  assert.equal(parseTemplatesSearch('?source=traces').source, null, 'a source no template reads')
  assert.equal(templatesSearch({}), '')
  assert.doesNotMatch(templatesSearch(view), /\b(service|category|host)=/, 'none of the keys production carries everywhere')
})
