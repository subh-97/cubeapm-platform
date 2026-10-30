import { autoFolds, revealing } from './traceInsights'

/**
 * The Traces drawer's Waterfall tab (SpanTraceTab), as plain transitions, so
 * what it keeps and drops as the reader steps through records can be tested
 * without a DOM. The state is `{ at, picked, folds }`:
 *
 *   at      the record on screen and its place, `<record>|<traceId>|<spanId>`,
 *           or null for a record with no trace (undefined before the first
 *           one). The record is part of it because two records can share a
 *           place: a failed span and its exception event have one span id
 *   picked  a span clicked in the waterfall, for that record only
 *   folds   the folded span ids per trace id, so stepping between two spans
 *           of one trace finds it as it was left (RequestTraceSplit's reason)
 */
export const INITIAL = { at: undefined, picked: null, folds: new Map() }

/**
 * The tab has record `recordKey`, span `spanId` of `trace`, on screen (trace
 * null for a record with none). Another record drops the pick, and unfolds the
 * span's ancestors so it is on screen — then, and only then, so a fold made
 * after that stands. The same record returns the same state, so a caller can
 * compare by identity.
 */
export function arrive(state, trace, spanId, recordKey = '') {
  const at = trace ? `${recordKey}|${trace.traceId}|${spanId ?? ''}` : null
  if (state.at === at) return state
  if (!trace) return { ...state, at, picked: null }
  const stored = state.folds.get(trace.traceId)
  const next = revealing(stored ?? autoFolds(trace.spans), trace, spanId)
  return { at, picked: null, folds: next === stored ? state.folds : new Map(state.folds).set(trace.traceId, next) }
}

/** A span clicked in the waterfall: selected until the record changes. */
export function pick(state, span) {
  return { ...state, picked: span }
}

/** Folds or unfolds span `id` of trace `traceId`. */
export function toggleFold(state, traceId, id) {
  const next = new Set(state.folds.get(traceId))
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return { ...state, folds: new Map(state.folds).set(traceId, next) }
}
