// A rule started from a template (Browse Templates, ruleTemplates.js), held
// against that template while it is edited: which template it is, where the
// draft has moved off what the template sets, and how to put those back.
//
// A template sets the rule's measurement and its trigger: the data source and
// query, the alert type, the two thresholds, how long the condition holds and
// how often it is checked. Those are what "moving off the template" means.
// The name, folder, tags, details, receivers, mutes and access are the
// viewer's own from the start, so changing them never counts.

import { RULE_TEMPLATES, templatePayload } from './ruleTemplates'
import { draftFromPayload, queryOf, ruleFromDraft, tiersOfDraft } from './editorDraft'
import { ruleMetric } from './model'
import { formatDuration, tierShort } from './describe'
import { datasourceId } from './catalog'

const SOURCE_LABEL = { metrics: 'Metrics', logs: 'Logs', traces: 'Traces', mobile: 'Mobile' }
const KIND_LABEL = { static: 'Static', anomaly: 'Anomaly' }

/** The catalogue template a draft carries the tag of, or null. */
export function templateOfDraft(draft) {
  const id = draft?.tags?.find(t => t.key === 'template')?.value
  return (id && RULE_TEMPLATES.find(t => t.id === id)) ?? null
}

/** A template's own settings, as the editor's draft holds them. */
export const templateDraft = t => draftFromPayload(templatePayload(t))

const unitOf = draft => ({ kind: draft.kind, unit: ruleMetric(ruleFromDraft(draft)).unit })
const timing = sec => (sec ? formatDuration(sec) : 'at once')

/**
 * Where `draft` has moved off template `t`, in the editor's order:
 * `[{ key, label, from, to, step }]`. `from` and `to` are null when the
 * difference cannot be said in a few characters (a query). `step` is the
 * editor step the setting lives in. Empty when the draft still matches.
 */
export function templateDrift(draft, t) {
  if (!draft || !t) return []
  const tpl = templateDraft(t)
  const out = []
  const sourceNow = datasourceId(draft.datasource)
  const sourceThen = datasourceId(tpl.datasource)
  if (sourceNow !== sourceThen) {
    out.push({ key: 'source', label: 'Data source', from: SOURCE_LABEL[sourceThen] ?? sourceThen, to: SOURCE_LABEL[sourceNow] ?? sourceNow, step: 1 })
  } else if (queryOf(draft).trim() !== queryOf(tpl).trim()) {
    out.push({ key: 'query', label: 'Query', from: null, to: null, step: 1 })
  }
  if (draft.kind !== tpl.kind) {
    out.push({ key: 'kind', label: 'Alert type', from: KIND_LABEL[tpl.kind], to: KIND_LABEL[draft.kind], step: 1 })
  } else {
    const now = tiersOfDraft(draft)
    const then = tiersOfDraft(tpl)
    for (const [key, label] of [['warning', 'Warning threshold'], ['critical', 'Critical threshold']]) {
      if (JSON.stringify(now[key]) !== JSON.stringify(then[key])) {
        out.push({ key, label, from: tierShort(unitOf(tpl), then[key]), to: tierShort(unitOf(draft), now[key]), step: 1 })
      }
    }
  }
  if (draft.forSec !== tpl.forSec) out.push({ key: 'forSec', label: 'Fire after', from: timing(tpl.forSec), to: timing(draft.forSec), step: 2 })
  if (draft.intervalSec !== tpl.intervalSec) out.push({ key: 'intervalSec', label: 'Check every', from: formatDuration(tpl.intervalSec), to: formatDuration(draft.intervalSec), step: 2 })
  return out
}

/** `draft` with what template `t` sets put back, and everything the viewer owns kept. */
export function restoreTemplate(draft, t) {
  const tpl = templateDraft(t)
  return {
    ...draft,
    datasource: tpl.datasource,
    editors: tpl.editors,
    kind: tpl.kind,
    tiers: tpl.tiers,
    forSec: tpl.forSec,
    intervalSec: tpl.intervalSec,
  }
}
