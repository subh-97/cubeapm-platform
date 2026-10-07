import { useCallback, useEffect, useMemo, useRef } from 'react'
import { Info } from 'lucide-react'
import CodeEditor from './CodeEditor.jsx'
import { metricLabelNames, metricLabelValues, metricNames } from '@/utils/explore/api'
import { suggestPromql } from '@/utils/explore/complete/promqlComplete'
import { parsePromql, tokenizePromql } from '@/utils/explore/promql'
import './explore-metrics.css'

// The Code tab: the reference's `Query Editor` heading over one PromQL editor.
//
// Three things the reference does not do, all deliberate.
//
// It has no validation at all — `onValidate` is unwired and nothing parses the
// text before it is sent, so a typo surfaces only when the request comes back
// 4xx. We have a parser, so the error is on screen as it is typed, which is
// also what the Logs/Traces Code tab does.
//
// Its Monaco instance swallows Tab and has no run key, which makes the field a
// keyboard trap (reference bug R11). `CodeEditor` answers both: Tab accepts a
// suggestion or leaves the field, and Enter / Cmd+Enter run (ARCH D4).
//
// And it never explains why the editor opened with text already in it. Coming
// from Quick or Advanced seeds this tab once (ARCH D3); until the first
// keystroke the text is a COPY, and saying so is the difference between a
// carry-over and a tab that appears to have rewritten itself.

const SEEDED_FROM = {
  quick: 'Quick',
  advanced: 'Advanced',
  builder: 'Builder',
}

const PLACEHOLDER = 'sum(rate(cube_apm_calls_total)) by (service) * 60'

/** The parser's complaint about `text`, or null while it is empty or legal. */
function parseError(text) {
  const q = String(text ?? '').trim()
  if (!q) return null
  try {
    parsePromql(q)
    return null
  } catch (err) {
    return err?.message || 'Could not parse the query'
  }
}

/**
 * @param {Object} props
 * @param {string} props.value
 * @param {(text:string) => void} props.onChange
 * @param {() => void} [props.onSubmit]
 * @param {number} props.start  resolved window, seconds — metadata is scoped to it
 * @param {number} props.end
 * @param {?string} [props.seededFrom]  the tab this text was copied from, while untouched
 */
export default function PromqlCodeTab({ value = '', onChange, onSubmit, start, end, seededFrom }) {
  const error = useMemo(() => parseError(value), [value])
  const from = seededFrom ? (SEEDED_FROM[seededFrom] ?? seededFrom) : null

  // Completion is asked for on every keystroke while the menu is open, so each
  // request supersedes the one before it. `CodeEditor` already discards a stale
  // ANSWER; aborting stops the stale REQUEST from being computed at all.
  const pending = useRef(null)
  useEffect(() => () => pending.current?.abort(), [])

  // Memoised because `CodeEditor` lists `suggest` as an effect dependency: a new
  // function identity per render would re-ask for completions forever.
  const suggest = useCallback((text, caret) => {
    pending.current?.abort()
    const controller = new AbortController()
    pending.current = controller
    const signal = controller.signal
    return suggestPromql(text, caret, {
      metricNames: () => metricNames({ start, end, signal }),
      labelNames: match => metricLabelNames({ match, start, end, signal }),
      labelValues: (label, match) => metricLabelValues({ label, match, start, end, signal }),
    })
  }, [start, end])

  return (
    <div className="ex-met-code">
      <h2 className="ex-met-title">Query Editor</h2>

      {from && (
        <p className="ex-met-hint">
          <Info size={13} strokeWidth={2} aria-hidden="true" />
          <span>Started from the {from} tab. Editing here will not change it.</span>
        </p>
      )}

      <CodeEditor
        value={value}
        onChange={onChange}
        onSubmit={onSubmit}
        tokenize={tokenizePromql}
        suggest={suggest}
        placeholder={PLACEHOLDER}
        minRows={2}
        maxRows={10}
        ariaLabel="PromQL query"
        error={error}
      />
    </div>
  )
}
