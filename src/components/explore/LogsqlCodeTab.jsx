import { useMemo } from 'react'
import { Info } from 'lucide-react'
import CodeEditor from './CodeEditor.jsx'
import { parseLogsql, tokenizeLogsql } from '@/utils/explore/logsql'
import './explore-logs.css'

// The Code tab: the reference's `Query Editor` heading over one LogsQL editor.
//
// Two things the reference's Explore editor does not do, both deliberate (ARCH
// D12, reference note divergence 15). It passes neither `searchSurface` nor
// `paintChips`, so a syntax error there surfaces only when the request comes
// back 4xx; we have a parser, so the error is on screen as it is typed. And
// because the server will reject a query with no `| stats` pipe, this says so
// before the run rather than after it — quietly, since the text may simply be
// half-written.

const SEEDED_FROM = {
  builder: 'Builder',
  quick: 'Quick',
  advanced: 'Advanced',
}

/**
 * One parse, two answers: whether the text is legal, and whether it would
 * produce a series. The server rules `api.js` enforces start with a `| stats`
 * pipe — without one there is nothing to plot — but a query that does not
 * parse yet has a bigger problem, so only the error is reported for it.
 */
function inspect(text) {
  const q = String(text ?? '').trim()
  if (!q) return { error: null, noStats: false }
  try {
    const ast = parseLogsql(q)
    return { error: null, noStats: !ast.pipes.some(p => p.name === 'stats') }
  } catch (err) {
    return { error: err?.message || 'Could not parse the query', noStats: false }
  }
}

/**
 * @param {Object} props
 * @param {string} props.value
 * @param {(text:string) => void} props.onChange
 * @param {() => void} [props.onSubmit]
 * @param {(text:string, caret:number) => Promise} [props.suggest]  memoised by the caller
 * @param {?string} [props.seededFrom]  the tab this text was copied from, while untouched
 */
export default function LogsqlCodeTab({ value = '', onChange, onSubmit, suggest, seededFrom }) {
  const { error, noStats } = useMemo(() => inspect(value), [value])
  const from = seededFrom ? (SEEDED_FROM[seededFrom] ?? seededFrom) : null

  return (
    <div className="ex-lq-code">
      <h2 className="ex-lq-code-title">Query Editor</h2>

      {from && (
        // The same sentence the Metrics editor shows for the same carry-over.
        <p className="ex-lq-hint is-seed">
          <Info size={13} strokeWidth={2} aria-hidden="true" />
          <span>Started from the {from} tab. Editing here will not change it.</span>
        </p>
      )}

      <CodeEditor
        value={value}
        onChange={onChange}
        onSubmit={onSubmit}
        tokenize={tokenizeLogsql}
        suggest={suggest}
        placeholder={'{"service"="order-service"} | stats by ("log.level") count()'}
        minRows={2}
        maxRows={10}
        ariaLabel="LogsQL query"
        error={error}
      />

      {noStats && (
        <p className="ex-lq-hint">
          <Info size={12} strokeWidth={2} aria-hidden="true" />
          <span>
            A graph needs a <code>| stats …</code> pipe. Add one — for example{' '}
            <code>| stats count()</code> — to turn the matching rows into a series.
          </span>
        </p>
      )}
    </div>
  )
}
