import { AlertTriangle } from 'lucide-react'
import MetricsEditor from '@/components/explore/MetricsEditor'
import LogsEditor from '@/components/explore/LogsEditor'
import { tabsFor } from '@/utils/explore/editorState'
import { DATASOURCES } from '@/utils/alerts/catalog'
import { UNSUPPORTED_VARIABLES } from '@/data/alertsEngine'
import { radioGroupKeyDown } from '@/components/alerts/shared/alertShared'
import {
  setKind, setDatasource, setTab, setEditor, setTier, needsClosingPipe, queryOf, fixUnsupportedVariables,
} from '@/utils/alerts/editorDraft'
import TierRows from './TierRows.jsx'

const ANOMALY_ONLY_METRICS = 'Anomaly rules watch Metrics only.'
const MOBILE_DEFERRED = 'Mobile alerts aren\'t available yet'

/**
 * Section 1, Query & condition (docs/alerts/DESIGN.md D6, D7): what the rule
 * watches and when it fires.
 *
 * The query editors are Explore's own — Production renders the same editor
 * inside its alert editor — driven by the draft's per-datasource state. Two
 * things differ from Explore, both production's: a Quick latency reads in
 * milliseconds, and the datasource row has four sources. Mobile is listed and
 * disabled with its reason, as are Logs and Traces for an anomaly rule, rather
 * than silently greyed out (R30).
 *
 * A Logs or Traces rule only works if its query ends in a stats or math pipe,
 * and production never says so (R31). The Builder starts with `stats count()`,
 * and the section says so the moment the pipe goes missing.
 */
export default function QuerySection({ draft, onDraft, view, range, problems }) {
  const editor = draft.editors[draft.datasource]
  const query = queryOf(draft)
  const missingPipe = needsClosingPipe(draft)
  const variables = problems.query === UNSUPPORTED_VARIABLES
  const anomaly = draft.kind === 'anomaly'

  const fixVariables = () => {
    const ed = draft.editors[draft.datasource]
    onDraft(setEditor(setTab(draft, 'code'), { ...ed, tab: 'code', code: { query: fixUnsupportedVariables(query), touched: true, seededFrom: null } }))
  }

  return (
    <div className="ae-query" id="ae-field-query" tabIndex={-1}>
      <div className="ae-row">
        <span className="ae-label" id="ae-kind-label">Type</span>
        <div className="seg-toggle" role="radiogroup" aria-labelledby="ae-kind-label" id="ae-field-kind" onKeyDown={radioGroupKeyDown}>
          {[['static', 'Static'], ['anomaly', 'Anomaly']].map(([k, label]) => {
            const blocked = k === 'anomaly' && draft.datasource !== 'prometheus'
            return (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={draft.kind === k}
                aria-disabled={blocked || undefined}
                title={blocked ? ANOMALY_ONLY_METRICS : undefined}
                className={`seg${draft.kind === k ? ' active' : ''}${blocked ? ' is-disabled' : ''}`}
                tabIndex={draft.kind === k ? 0 : -1}
                onClick={blocked ? undefined : () => onDraft(setKind(draft, k))}
              >
                {label}
              </button>
            )
          })}
        </div>
      </div>

      <div className="ex-card ae-query-card">
        <div className="ex-card-head">
          <div className="tabbar" role="tablist" aria-label="Datasource">
            {DATASOURCES.map(d => {
              const reason = d.value === 'mobile' ? MOBILE_DEFERRED : anomaly && d.value !== 'prometheus' ? ANOMALY_ONLY_METRICS : null
              const active = d.value === draft.datasource
              return (
                <button
                  key={d.value}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  aria-disabled={reason ? true : undefined}
                  title={reason ?? undefined}
                  className={`tab${active ? ' active' : ''}${reason ? ' is-disabled' : ''}`}
                  onClick={reason ? undefined : () => onDraft(setDatasource(draft, d.value))}
                >
                  {d.label}
                </button>
              )
            })}
          </div>
          <div className="seg-toggle" role="tablist" aria-label="Query mode">
            {tabsFor(draft.datasource).map(t => (
              <button
                key={t.value}
                type="button"
                role="tab"
                aria-selected={t.value === editor.tab}
                className={`seg${t.value === editor.tab ? ' active' : ''}`}
                onClick={() => onDraft(setTab(draft, t.value))}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
        <div className="ex-card-editor" role="tabpanel" aria-label={`${draft.datasource === 'prometheus' ? 'Metrics' : draft.datasource === 'vlogs' ? 'Logs' : 'Traces'} query editor`}>
          {draft.datasource === 'prometheus' ? (
            <MetricsEditor state={editor} onChange={ed => onDraft(setEditor(draft, ed))} range={range} latencyInMs />
          ) : (
            <LogsEditor
              key={draft.datasource}
              datasource={draft.datasource}
              state={editor}
              onChange={ed => onDraft(setEditor(draft, ed))}
              range={range}
            />
          )}
        </div>
      </div>

      {variables && (
        <div className="ae-banner warn" role="alert">
          <AlertTriangle aria-hidden="true" />
          <span>{UNSUPPORTED_VARIABLES}</span>
          <button type="button" className="hbtn primary small" onClick={fixVariables}>Fix query</button>
        </div>
      )}
      {missingPipe && (
        <p className="ae-hint warn" role="status">
          A Logs or Traces rule compares a number, so its query has to end in a stats or math pipe —
          add <code>| stats count()</code> to count the matching records.
        </p>
      )}

      <TierRows
        kind={draft.kind}
        rows={draft.tiers[draft.kind]}
        unit={view.unit}
        problems={problems}
        onTier={(name, patch) => onDraft(setTier(draft, name, patch))}
      />
    </div>
  )
}
