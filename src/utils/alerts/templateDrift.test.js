// A rule started from a template, held against it while it is edited
// (templateDrift.js). The risks: a template that does not match itself, so
// the banner cries "moved off" on a rule nobody touched; a change to what the
// template sets that goes unremarked; a change to what the viewer owns (name,
// receivers) reported as moving off; and a restore that loses the viewer's own.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RULE_TEMPLATES } from './ruleTemplates'
import { setKind, setTier } from './editorDraft'
import { templateOfDraft, templateDraft, templateDrift, restoreTemplate } from './templateDrift'

const byId = id => RULE_TEMPLATES.find(t => t.id === id)
const keys = drift => drift.map(d => d.key)

test('every template matches itself, and is found from the tag its rule carries', () => {
  for (const t of RULE_TEMPLATES) {
    const draft = templateDraft(t)
    assert.deepEqual(templateDrift(draft, t), [], t.id)
    assert.equal(templateOfDraft(draft), t, t.id)
  }
  assert.equal(templateOfDraft({ tags: [] }), null)
  assert.equal(templateOfDraft({ tags: [{ key: 'template', value: 'no.such-template' }] }), null)
})

test('changing what the template sets is moving off it, each change said as template against now', () => {
  const t = byId('services.error-rate-high')
  const draft = templateDraft(t)
  const warned = setTier(draft, 'warning', { value: '2' })
  assert.deepEqual(templateDrift(warned, t), [{ key: 'warning', label: 'Warning threshold', from: '> 1%', to: '> 2%', step: 1 }])
  assert.deepEqual(templateDrift({ ...draft, forSec: 600 }, t), [{ key: 'forSec', label: 'Fire after', from: '5m', to: '10m', step: 2 }])
  assert.deepEqual(templateDrift({ ...draft, forSec: 0 }, t)[0].to, 'at once')
  assert.deepEqual(keys(templateDrift({ ...draft, intervalSec: 300 }, t)), ['intervalSec'])
  assert.deepEqual(keys(templateDrift(setTier(draft, 'critical', { value: '' }), t)), ['critical'])
  assert.equal(templateDrift(setTier(draft, 'critical', { value: '' }), t)[0].to, 'none')
  // The alert type stands for its thresholds: one entry, not three.
  assert.deepEqual(keys(templateDrift(setKind(draft, 'anomaly'), t)), ['kind'])
})

test('a changed query, or another data source, is moving off the template', () => {
  const t = byId('services.avg-latency-up')
  const draft = templateDraft(t)
  const code = draft.editors.prometheus
  const edited = { ...draft, editors: { ...draft.editors, prometheus: { ...code, tab: 'code', code: { ...code.code, query: `${code.code.query} * 2`, touched: true } } } }
  assert.deepEqual(keys(templateDrift(edited, t)), ['query'])
  assert.deepEqual(templateDrift({ ...draft, datasource: 'vlogs' }, t).find(d => d.key === 'source'), { key: 'source', label: 'Data source', from: 'Metrics', to: 'Logs', step: 1 })
})

test('what the viewer owns never counts: name, folder, tags, details, receivers, mutes, access', () => {
  const t = byId('host.cpu-high')
  const draft = templateDraft(t)
  const own = {
    ...draft,
    name: 'My CPU rule', group: 'Infra', tags: [...draft.tags, { key: 'team', value: 'core' }], summary: 'x', description: 'y',
    receiverGroupIds: [11], destinations: [{ type: 'email', to: 'a@b.c' }], muteGroupIds: [1], repeatSec: 7200, access: { mode: 'custom', rows: [] },
  }
  assert.deepEqual(templateDrift(own, t), [])
})

test('restoring puts back what the template sets, and keeps what the viewer owns', () => {
  const t = byId('services.error-rate-high')
  const moved = { ...setKind(setTier(templateDraft(t), 'warning', { value: '9' }), 'anomaly'), forSec: 60, intervalSec: 300, name: 'Mine', receiverGroupIds: [11] }
  assert.ok(templateDrift(moved, t).length >= 3)
  const back = restoreTemplate(moved, t)
  assert.deepEqual(templateDrift(back, t), [])
  assert.equal(back.name, 'Mine')
  assert.deepEqual(back.receiverGroupIds, [11])
})
