import { useCallback, useEffect, useMemo, useRef } from 'react'
import { buildAdvancedQuery, buildQuickQuery, advancedMatchFor, quickMatchFor } from '@/utils/explore/builders'
import { metricLabelValues } from '@/utils/explore/api'
import { resolveRange } from '@/utils/timeRange'
import QuickBuilder from './QuickBuilder.jsx'
import AdvancedBuilder from './AdvancedBuilder.jsx'
import PromqlCodeTab from './PromqlCodeTab.jsx'
import './explore-metrics.css'

// The Metrics editor: Quick, Advanced and Code, and the state that joins them.
//
// It renders the ACTIVE TAB'S BODY and nothing else. The datasource switch and
// the Quick|Advanced|Code toggle live in the page's card head (ARCH D1), so
// this component never decides which tab is shown — it is told, and it reports
// the next state back through `onChange`.
//
// Three things it owns, and why they are here rather than in the three tabs:
//
//   · The query. A builder tab edits a MODEL; the query is what that model
//     generates, every time, through builders.js. Keeping the generation in one
//     place is what stops a tab from hand-rolling a string that the other tabs,
//     the Copy button and the backend would then read differently.
//   · The time window. Every metadata lookup is scoped to the range the chart
//     is drawn over — a label value that exists only outside the window is not
//     an option — so the range is resolved once here and handed down as two
//     numbers rather than resolved again per tab, which for a relative preset
//     would resolve to a slightly different window each time.
//   · The filter rows' value fetches. They are the one request a person can
//     fire repeatedly and out of order (open a row, narrow it, open it again),
//     so each row's in-flight request is aborted by its own successor and all
//     of them on unmount — reference bug R8's race, fixed per ARCH D12.
//
// Tab carry-over (ARCH D3) belongs to the page's state machine, not here. What
// this component does with it is name the tab Code was seeded from, so Code can
// say that its text is a copy which editing will not push back — the same
// sentence, in the same words, that the Logs/Traces Code tab shows.

export default function MetricsEditor({ state, onChange, onSubmit, range }) {
  // Resolved once per range change. `range` is one object on the page's state,
  // so this is stable between real changes rather than per render.
  const { start, end } = useMemo(() => resolveRange(range), [range])

  const tab = state?.tab === 'advanced' || state?.tab === 'code' ? state.tab : 'quick'
  const quickModel = state?.quick?.model
  const advancedModel = state?.advanced?.model
  const code = state?.code

  // One AbortController per filter row, keyed by tab and row index: opening a
  // row again supersedes its own previous request, and a row in Quick never
  // cancels the row at the same index in Advanced.
  const pending = useRef(new Map())
  useEffect(() => () => {
    for (const controller of pending.current.values()) controller.abort()
    pending.current.clear()
  }, [])

  const loadValues = useCallback((key, label, match) => {
    pending.current.get(key)?.abort()
    const controller = new AbortController()
    pending.current.set(key, controller)
    return metricLabelValues({ label, match, start, end, signal: controller.signal })
  }, [start, end])

  // Quick always narrows on cube_apm_calls_total, even for a latency
  // calculation — reference bug R2, kept because `quickMatchFor` is the
  // contract the generated query shares with the playground.
  const quickValues = useCallback(
    (index, label) => loadValues(`quick:${index}`, label, quickMatchFor(quickModel?.labelPairs, index)),
    [loadValues, quickModel]
  )

  const advancedValues = useCallback(
    (index, label) => loadValues(
      `advanced:${index}`, label, advancedMatchFor(advancedModel?.metric, advancedModel?.labelPairs, index)
    ),
    [loadValues, advancedModel]
  )

  const onQuickModel = useCallback((model) => {
    onChange?.({ ...state, quick: { model, query: buildQuickQuery(model) } })
  }, [onChange, state])

  const onAdvancedModel = useCallback((model) => {
    onChange?.({ ...state, advanced: { model, query: buildAdvancedQuery(model) } })
  }, [onChange, state])

  // The first keystroke in Code is what makes it the author of its own text:
  // the seed hint goes, and the page stops re-seeding it from a builder.
  const onCodeText = useCallback((query) => {
    onChange?.({ ...state, code: { ...state?.code, query, touched: true } })
  }, [onChange, state])

  return (
    <div className="ex-met">
      {tab === 'quick' && (
        <QuickBuilder
          model={quickModel}
          query={state?.quick?.query ?? ''}
          onChange={onQuickModel}
          onSubmit={onSubmit}
          loadValues={quickValues}
        />
      )}

      {tab === 'advanced' && (
        <AdvancedBuilder
          model={advancedModel}
          query={state?.advanced?.query ?? ''}
          onChange={onAdvancedModel}
          onSubmit={onSubmit}
          loadValues={advancedValues}
          start={start}
          end={end}
        />
      )}

      {tab === 'code' && (
        <PromqlCodeTab
          value={code?.query ?? ''}
          onChange={onCodeText}
          onSubmit={onSubmit}
          start={start}
          end={end}
          seededFrom={code?.touched ? null : code?.seededFrom}
        />
      )}
    </div>
  )
}
