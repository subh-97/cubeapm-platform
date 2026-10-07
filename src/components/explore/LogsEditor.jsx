import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  logFieldNames, logFieldValues, logStreamFieldNames, logStreamFieldValues,
} from '@/utils/explore/api'
import { buildLogsqlQuery, logsqlValueQueryFor } from '@/utils/explore/builders'
import { suggestLogsql } from '@/utils/explore/complete/logsqlComplete'
import { resolveRange } from '@/utils/timeRange'
import LogsqlBuilder from './LogsqlBuilder.jsx'
import LogsqlCodeTab from './LogsqlCodeTab.jsx'
import './explore-logs.css'

// The Logs and Traces editor: Builder and Code, and the state that joins them.
//
// It renders the ACTIVE TAB'S BODY and nothing else. The datasource switch and
// the Builder|Code toggle live in the page's card head (ARCH D1), so this
// component never decides which tab is shown — it is told, and reports the next
// state back through `onChange`.
//
// The two datasources are one component because they are one editor: logs and
// traces speak the same LogsQL against the same endpoints, and all that differs
// is which catalogue the field pickers read (ARCH D11, reference §1). Passing
// `datasource` through to every call is what keeps that difference in one word
// rather than in two copies of this file.
//
// Four things it owns, and why they are here rather than in the two tabs:
//
//   · The query. The Builder edits a MODEL; the query is what that model
//     generates, every time, through `buildLogsqlQuery`. Nothing below this
//     line concatenates LogsQL.
//   · The time window. Field names and values are metadata about the window the
//     chart is drawn over — a field that only appears outside it is not an
//     option — so the range is resolved once here and handed down as two
//     numbers. The reference asks its pickers about the step-aligned window and
//     its autocomplete about the raw one (reference §9, divergence 17); one
//     window for both is correct.
//   · The field catalogues, refetched when the datasource or the committed
//     range changes. The reference keys that on a `refresh` URL parameter, so
//     its lists go stale the moment the time picker moves (bug R4,
//     divergence 18).
//   · Every metadata fetch's cancellation. A row's value list and the
//     completion menu are both things a person fires repeatedly and out of
//     order, so each request is aborted by its own successor and all of them on
//     unmount — reference bug R8's race, fixed per ARCH D12.
//
// Tab carry-over (ARCH D3) belongs to the page's state machine. What this does
// with it is pass down the one line that explains it: Code may have been SEEDED
// from the Builder, and until it is touched that text is a copy which editing
// will not push back.

export default function LogsEditor({ datasource = 'vlogs', state, onChange, onSubmit, range }) {
  // Resolved once per range change. `range` is one object on the page's state,
  // so this is stable between real changes rather than per render.
  const { start, end } = useMemo(() => resolveRange(range), [range])

  const tab = state?.tab === 'code' ? 'code' : 'builder'
  const model = state?.builder?.model
  const code = state?.code

  // The hit counts the server returns are what make one field worth picking
  // over another, so they are kept as the option's second line rather than
  // discarded the way the reference's builder path discards them (§5).
  const noun = datasource === 'traces' ? 'spans' : 'logs'
  const decorate = useCallback((rows) => (rows ?? []).map(r => (
    typeof r === 'string'
      ? { value: r, label: r }
      : { value: r.value, label: r.value, description: r.hits ? `${r.hits.toLocaleString()} ${noun}` : undefined }
  )), [noun])

  const [meta, setMeta] = useState({ fields: [], stream: [], loading: true, error: null })
  const [reload, setReload] = useState(0)
  const retry = useCallback(() => setReload(n => n + 1), [])

  useEffect(() => {
    const controller = new AbortController()
    let alive = true
    setMeta(m => ({ ...m, loading: true, error: null }))
    Promise.all([
      logFieldNames({ datasource, start, end, signal: controller.signal }),
      logStreamFieldNames({ datasource, start, end, signal: controller.signal }),
    ]).then(
      ([fields, stream]) => {
        if (!alive) return
        setMeta({ fields: decorate(fields), stream: decorate(stream), loading: false, error: null })
      },
      (err) => {
        // An abort is this effect being superseded, not a failure anyone asked
        // about; the successor is already loading.
        if (!alive || controller.signal.aborted) return
        setMeta({ fields: [], stream: [], loading: false, error: err?.message || 'Could not load the field list' })
      }
    )
    return () => { alive = false; controller.abort() }
  }, [datasource, start, end, reload, decorate])

  const catalog = useMemo(() => ({ ...meta, retry }), [meta, retry])

  // One AbortController per filter row, keyed by section and row index: opening
  // a row again supersedes its own previous request, and a STREAM row never
  // cancels the FIELDS row at the same index.
  const pending = useRef(new Map())
  useEffect(() => () => {
    for (const controller of pending.current.values()) controller.abort()
    pending.current.clear()
  }, [])

  const loadValues = useCallback((key, fetch, field, query) => {
    pending.current.get(key)?.abort()
    const controller = new AbortController()
    pending.current.set(key, controller)
    return fetch({ datasource, field, query, start, end, signal: controller.signal }).then(decorate)
  }, [datasource, start, end, decorate])

  // Narrowing is prefix-only, as the reference's is: a row's options are
  // constrained by the rows above it and by nothing after it. `logsqlValueQueryFor`
  // is that rule, including the `*` the reference sends as a bare space (B1).
  const loadStreamValues = useCallback((index, field) => loadValues(
    `stream:${index}`, logStreamFieldValues, field, logsqlValueQueryFor(model, 'stream', index)
  ), [loadValues, model])

  const loadFieldValues = useCallback((index, field) => loadValues(
    `fields:${index}`, logFieldValues, field, logsqlValueQueryFor(model, 'fields', index)
  ), [loadValues, model])

  // Only one completion menu can be open at a time — a menu needs focus, and
  // the Code tab and the stats cards' `if` editors are never focused together —
  // so a new request always supersedes the one before it, and the abandoned
  // fetch is cancelled rather than left to resolve into a menu nobody is
  // looking at. `CodeEditor` already drops out-of-order answers; this is about
  // the work, not the result.
  const completing = useRef(null)
  useEffect(() => () => completing.current?.abort(), [])

  const suggest = useCallback((text, caret) => {
    completing.current?.abort()
    const controller = new AbortController()
    completing.current = controller
    const signal = controller.signal
    return suggestLogsql(text, caret, {
      fieldNames: () => logFieldNames({ datasource, start, end, signal }),
      fieldValues: field => logFieldValues({ datasource, field, start, end, signal }),
      streamFieldNames: () => logStreamFieldNames({ datasource, start, end, signal }),
      streamFieldValues: field => logStreamFieldValues({ datasource, field, start, end, signal }),
    })
  }, [datasource, start, end])

  const onModel = useCallback((next) => {
    onChange?.({ ...state, builder: { model: next, query: buildLogsqlQuery(next) } })
  }, [onChange, state])

  // The first keystroke in Code is what makes it the author of its own text:
  // the seed hint goes, and the page stops re-seeding it from the Builder.
  const onCodeText = useCallback((query) => {
    onChange?.({ ...state, code: { ...state?.code, query, touched: true } })
  }, [onChange, state])

  return (
    <div className="ex-lq">
      {tab === 'builder' ? (
        <LogsqlBuilder
          model={model}
          onChange={onModel}
          onSubmit={onSubmit}
          catalog={catalog}
          loadStreamValues={loadStreamValues}
          loadFieldValues={loadFieldValues}
          suggest={suggest}
          ifPlaceholder={datasource === 'traces' ? 'status_code:="ERROR"' : 'level:="error"'}
        />
      ) : (
        <LogsqlCodeTab
          value={code?.query ?? ''}
          onChange={onCodeText}
          onSubmit={onSubmit}
          suggest={suggest}
          seededFrom={code?.seededFrom && !code.touched ? code.seededFrom : null}
        />
      )}
    </div>
  )
}
