// The Rules tab's templates (ruleTemplates.js): each opens the editor on a
// rule it can save once a contact point is chosen, and previews real data —
// a template that previewed nothing would be a dead end dressed as a start.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RULE_TEMPLATES } from './ruleTemplates'
import { draftFromPayload, ruleFromDraft, validateDraft } from './editorDraft'
import { previewRule } from '@/data/alerts'
import { resolveWindow } from '@/data/timeWindow'

const hour = resolveWindow({ kind: 'preset', value: '1h' })

test('the picker lists the common rules, each with a title and what it watches', () => {
  assert.deepEqual(RULE_TEMPLATES.map(t => t.id), ['error-rate', 'p90-latency', 'throughput', 'host-cpu', 'error-logs'])
  for (const t of RULE_TEMPLATES) {
    assert.ok(t.title && t.description, t.id)
  }
})

for (const t of RULE_TEMPLATES) {
  test(`${t.title}: a draft whose only gap is who to tell, previewing real series`, () => {
    const draft = draftFromPayload(t.payload())
    assert.equal(draft.name, t.payload().name)
    const problems = validateDraft(draft).map(p => p.field)
    assert.ok(!problems.includes('query'), `${t.id}: ${JSON.stringify(validateDraft(draft))}`)
    const preview = previewRule(ruleFromDraft({ ...draft, receiverGroupIds: [11] }), hour)
    assert.equal(preview.error, null, t.id)
    assert.ok(preview.series.length > 0, `${t.id} previews data`)
  })
}

test('templates that know the platform\'s thresholds set them; throughput leaves its own to you', () => {
  const tiers = id => RULE_TEMPLATES.find(t => t.id === id).payload().tiers
  assert.deepEqual(tiers('error-rate'), { warning: { op: '>', threshold: 1 }, critical: { op: '>', threshold: 3 } })
  assert.deepEqual(tiers('p90-latency'), { warning: { op: '>', threshold: 150 }, critical: { op: '>', threshold: 300 } })
  assert.equal(tiers('throughput'), undefined)
})
