import { useEffect, useMemo, useRef, useState } from 'react'
import { previewRule } from '@/data/alerts'

const DEBOUNCE_MS = 350

/**
 * The draft's preview, worked out a moment after it stops changing (R25: no
 * "Generate Graph"), by the evaluator a saved rule's page reads. Returns
 * `{ result, stale }`: the last answer, and whether a newer one is on its way —
 * the old answer stays up meanwhile, so the chart dims rather than blinking
 * empty on every keystroke.
 *
 * Keyed on the rule's contents, not its identity: the page rebuilds the rule
 * object on every render, and only a change to what it says should rerun it.
 */
export function useRulePreview(rule, win, ctx) {
  const [result, setResult] = useState(null)
  const [stale, setStale] = useState(true)
  const key = useMemo(() => JSON.stringify(rule), [rule])
  const latest = useRef({ rule, win, ctx })
  latest.current = { rule, win, ctx }

  useEffect(() => {
    setStale(true)
    const timer = setTimeout(() => {
      const { rule: r, win: w, ctx: c } = latest.current
      if (!r) return
      setResult(previewRule(r, w, c))
      setStale(false)
    }, result ? DEBOUNCE_MS : 0)
    return () => clearTimeout(timer)
    // `result` is read for the first run only: the first answer comes at once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, win, ctx])

  return { result, stale }
}
