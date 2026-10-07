// The Explore results fetch: one committed query over one time window, plus
// the comparison window beside it.
//
// Three rules it exists to keep, all of them about what happens BETWEEN runs
// (ARCH D5, D6, D8):
//
//   - A run in flight never blanks what is on screen. The previous series stay
//     with `stale` set, so a refresh, an auto-refresh tick or a Legend value
//     change dims the chart rather than strobing it to empty and back. The
//     shape of the last answer is the best available guess at the next one.
//   - A superseded run is aborted. A 5s auto-refresh over a 400ms query can
//     leave several runs outstanding; only the newest may write to state, and
//     the rest are cancelled through their AbortSignal instead of being left
//     to resolve into a component that has moved on.
//   - The comparison window is a second, parallel fetch whose failure is not
//     the main result's failure. Compare is context: losing it costs the delta
//     chips, it does not take the chart away.
//
// Everything below talks to `utils/explore/api.js` and nothing else — that is
// the only data source the UI has (ARCH D10), so swapping in a real backend
// later is a change to that module, not to this hook.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { queryRange, queryReduced } from '@/utils/explore/api'
import { resolveRange, shiftRange, compareShift } from '@/utils/timeRange'

/**
 * @typedef {Object} ExploreResult
 * @property {'idle'|'loading'|'ready'|'empty'|'error'} status
 *   `empty` is a run that succeeded and returned no series — a finding, not a
 *   failure, so it is its own state rather than a `ready` the caller has to
 *   test for.
 * @property {Array<{metric:object, values:Array<{x:number,y:number}>, value?:number}>} series
 *   The newest series that arrived — kept across a loading run and across an
 *   error, which is what `stale` is for.
 * @property {Array|null} prevSeries  the comparison window, or null when
 *   Compare is off OR its fetch failed; `prevFailed` tells the two apart, and
 *   series.js needs the distinction (an unknown comparison reads "—", a
 *   missing one reads "new").
 * @property {boolean} prevFailed
 * @property {string|null} error  a ready-to-render sentence, never an object
 * @property {boolean} stale   `series` is not from the current inputs
 * @property {ReturnType<typeof resolveRange>|null} resolved  the window this
 *   run actually asked for — the chart's x axis comes from it, so it must be
 *   the run's own resolution and not a second `resolveRange(range)` at a
 *   different `now`.
 * @property {number} compareShiftSec  how far back the comparison window sits
 * @property {() => void} retry
 */

const IDLE = Object.freeze({
  status: 'idle',
  series: [],
  prevSeries: null,
  prevFailed: false,
  error: null,
  stale: false,
  resolved: null,
  compareShiftSec: 0,
})

const isAbort = (err) => err?.name === 'AbortError'

/**
 * One window's worth of series.
 *
 * "latest" takes the range query and lets series.js reduce it: the chart needs
 * the points whatever the Legend value is, and `queryReduced('last')` is an
 * instant query that returns none. Average and sum go through `queryReduced`,
 * which is the path the table and the CSV share, so the value in a legend row
 * and the value in the exported file are computed once, in one place.
 */
async function fetchWindow({ datasource, query, formula, window, signal }) {
  const { start, end, step } = window
  if (formula === 'avg' || formula === 'sum') {
    const { series } = await queryReduced({ datasource, query, start, end, step, formula, signal })
    return series
  }
  const { series } = await queryRange({ datasource, query, start, end, step, signal })
  return series
}

/**
 * @param {Object} args
 * @param {{ datasource:string, query:string }|null} args.committed
 *   the COMMITTED query — editing without pressing Generate Graph must not
 *   reach this hook (ARCH D2).
 * @param {{kind:'preset',value:string}|{kind:'absolute',from:number,to:number}} args.range
 * @param {'last'|'avg'|'sum'} [args.formula]
 * @param {'off'|'previous'|'day'|'week'} [args.compare]
 * @param {number} [args.runId]  bump to re-run the same inputs (Refresh,
 *   auto-refresh). Relative presets re-resolve against now on every run.
 * @returns {ExploreResult}
 */
export function useExploreResult({ committed, range, formula = 'avg', compare = 'off', runId = 0 }) {
  const [state, setState] = useState(IDLE)
  const [attempt, setAttempt] = useState(0)

  // Identity of a run. A page that rebuilds `range` or `committed` on every
  // render would otherwise re-fetch on every render; comparing by value means
  // only a real change starts a run.
  const runKey = useMemo(() => JSON.stringify({
    d: committed?.datasource ?? null,
    q: committed?.query ?? null,
    r: range ?? null,
    f: formula,
    c: compare,
    n: runId,
    a: attempt,
  }), [committed?.datasource, committed?.query, range, formula, compare, runId, attempt])

  // The effect keys on `runKey` alone, so the inputs travel to it by ref
  // rather than as dependencies — listing them would re-run the effect on an
  // object that is new but equal, which is exactly what `runKey` exists to
  // prevent.
  const argsRef = useRef(null)
  argsRef.current = { committed, range, formula, compare }

  useEffect(() => {
    const args = argsRef.current
    if (!args.committed?.query) {
      setState(s => (s === IDLE ? s : IDLE))
      return undefined
    }

    const { datasource, query } = args.committed
    const resolved = resolveRange(args.range)
    const compareShiftSec = compareShift(args.compare, resolved)
    const controller = new AbortController()
    const { signal } = controller
    let live = true

    // Nothing is cleared here but the error: the band belonged to the run that
    // failed, and this is a different one.
    setState(s => ({ ...s, status: 'loading', stale: s.series.length > 0, error: null, resolved, compareShiftSec }))

    // Started before the main fetch is awaited, so both windows are in flight
    // at once; its rejection is handled here and never reaches the caller.
    const prevRun = compareShiftSec > 0
      ? fetchWindow({
        datasource, query, formula: args.formula, signal,
        window: shiftRange(resolved, compareShiftSec),
      }).then(
        series => ({ series, failed: false }),
        err => ({ series: null, failed: !isAbort(err) }),
      )
      : Promise.resolve({ series: null, failed: false })

    ;(async () => {
      try {
        const series = await fetchWindow({ datasource, query, formula: args.formula, window: resolved, signal })
        const prev = await prevRun
        if (!live) return
        setState({
          status: series.length ? 'ready' : 'empty',
          series,
          prevSeries: prev.series,
          prevFailed: prev.failed,
          error: null,
          stale: false,
          resolved,
          compareShiftSec,
        })
      } catch (err) {
        if (!live || isAbort(err)) return
        // ARCH D10: the page shows the server's own wording behind this prefix.
        setState(s => ({
          ...s,
          status: 'error',
          error: `Failed to fetch data: ${err?.message || err}`,
          stale: s.series.length > 0,
        }))
      }
    })()

    return () => {
      live = false
      controller.abort()
    }
  }, [runKey])

  const retry = useCallback(() => setAttempt(a => a + 1), [])

  return useMemo(() => ({ ...state, retry }), [state, retry])
}

export default useExploreResult
