// The template drawer's catalogue (ruleTemplates.js). The risks: a template
// that opens the editor on a rule it cannot save; one whose preview is a dead
// end, with no data and no word why; one that cries wolf in the demo it ships
// in; thresholds that drift from the badges they say they match; and a search
// or a tab that loses a template.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  RULE_TEMPLATES, TEMPLATE_CATEGORIES, filterTemplates, templateTabs,
} from './ruleTemplates'
import { draftFromPayload, ruleFromDraft, validateDraft } from './editorDraft'
import { tiersOf } from './condition'
import { THRESHOLDS } from '@/utils/status'
import { previewRule, ALERTS_NOW } from '@/data/alerts'
import { resolveWindow, INCIDENT_START_MIN } from '@/data/timeWindow'

const hour = resolveWindow({ kind: 'preset', value: '1h' })
const day = resolveWindow({ kind: 'preset', value: '24h' })
const byId = id => RULE_TEMPLATES.find(t => t.id === id)
const ruleOf = t => ruleFromDraft({ ...draftFromPayload(t.payload()), receiverGroupIds: [11] })

test('five categories by what a rule watches, and every template in one of them', () => {
  assert.deepEqual(TEMPLATE_CATEGORIES.map(c => c.id), ['services', 'dependencies', 'logs', 'hosts', 'kubernetes'])
  assert.equal(new Set(RULE_TEMPLATES.map(t => t.id)).size, RULE_TEMPLATES.length, 'ids are unique')
  const count = id => RULE_TEMPLATES.filter(t => t.category === id).length
  assert.deepEqual(TEMPLATE_CATEGORIES.map(c => count(c.id)), [5, 3, 2, 2, 4])
  for (const t of RULE_TEMPLATES) {
    assert.ok(t.title && t.description && t.source.label && t.per.one && t.per.many && t.keywords.length, t.id)
    assert.doesNotMatch(t.source.label, /^(\w+) · \1$/, `${t.id}: a tag that repeats itself says nothing`)
  }
})

for (const t of RULE_TEMPLATES) {
  test(`${t.title}: a rule whose only gap is who to tell, ${t.needs ? `waiting on ${t.needs}` : 'previewing real data'}`, () => {
    const draft = draftFromPayload(t.payload())
    assert.equal(draft.name, t.title, 'the rule is named for the template')
    assert.deepEqual(validateDraft(draft).map(p => p.field), ['notify'])
    const preview = previewRule(ruleOf(t), hour)
    assert.equal(preview.error, null)
    if (t.needs) assert.equal(preview.series.length, 0, 'the demo has no such data, and the card says which source it needs')
    else assert.ok(preview.series.length > 0, 'previews data')
  })
}

// The payment incident, with room for a five-minute log check that reaches
// back into its first minutes.
const INCIDENT_FROM = ALERTS_NOW - INCIDENT_START_MIN * 60 - 300

test('none cries wolf: over a day, everything a template fires on is the incident', () => {
  for (const t of RULE_TEMPLATES) {
    const early = previewRule(ruleOf(t), day).lane.filter(iv => iv.state === 'firing' && iv.start < INCIDENT_FROM)
    assert.deepEqual(early, [], `${t.id} fired before the incident`)
  }
})

test('the incident is caught where the platform says it is, and the quiet ones stay quiet', () => {
  const fired = id => previewRule(ruleOf(byId(id)), hour).incidents > 0
  for (const id of ['error-rate', 'p90-latency', 'exceptions', 'redis-clients', 'host-cpu', 'host-memory', 'dependency-surge']) {
    assert.ok(fired(id), `${id} catches the payment incident`)
  }
  for (const id of ['traffic-stopped', 'mysql-threads', 'pod-cpu']) assert.ok(!fired(id), `${id} stays quiet`)
})

test('thresholds are the platform\'s own where it has them; the others are the template\'s', () => {
  const tiers = id => {
    const { warning, critical } = tiersOf(ruleOf(byId(id)))
    return [warning?.op, warning?.threshold, critical?.op, critical?.threshold]
  }
  assert.deepEqual(tiers('error-rate'), ['>', THRESHOLDS.errorRatePct.warn, '>', THRESHOLDS.errorRatePct.critical])
  assert.deepEqual(tiers('p90-latency'), ['>', THRESHOLDS.latencyP90Ms.warn, '>', THRESHOLDS.latencyP90Ms.critical])
  assert.deepEqual(tiers('host-cpu'), ['>=', 70, '>=', 85], 'the host table\'s own colours')
  assert.deepEqual(tiers('traffic-stopped'), [undefined, undefined, '<', 1])
  const anomaly = draftFromPayload(byId('traffic-anomaly').payload())
  assert.equal(anomaly.kind, 'anomaly')
  assert.equal(draftFromPayload(byId('error-logs').payload()).intervalSec, 300, 'a log count is a five-minute check')
})

test('search wants every word somewhere in a template; the tabs count what it leaves', () => {
  const ids = (opts) => filterTemplates(RULE_TEMPLATES, opts).map(t => t.id)
  assert.deepEqual(ids({ q: 'redis pool' }), ['redis-clients'])
  assert.deepEqual(ids({ q: 'K8S' }), ['pod-cpu', 'crash-loop', 'container-restarts', 'node-not-ready'], 'any case, and the keywords count')
  assert.deepEqual(ids({ q: 'latency' }), ['p90-latency', 'slow-request-logs'])
  assert.deepEqual(ids({ category: 'hosts', q: 'k8s' }), [])
  assert.equal(ids({}).length, RULE_TEMPLATES.length)
  assert.deepEqual(templateTabs(RULE_TEMPLATES, 'latency').map(t => `${t.id}:${t.count}`), [
    'all:2', 'services:1', 'dependencies:0', 'logs:1', 'hosts:0', 'kubernetes:0',
  ])
})
