import { useEffect, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import clsx from 'clsx'
import './explore-controls.css'

// What the Quick, Advanced and Builder tabs produce, shown as the query it is.
//
// It is read-only on purpose: there is no parsing back from text into a builder
// model (ARCH D3), so an editable box here would promise an edit it cannot
// keep. Showing the query anyway is how someone learns the language from the
// rows they are already filling in — and the Copy button is how they take it to
// the Code tab, an alert, or a terminal.

export default function GeneratedQuery({
  query = '',
  tokenize,
  title = 'Generated Query',
  empty = 'Nothing to run yet',
  className,
}) {
  const [copied, setCopied] = useState(false)
  const timer = useRef(null)

  useEffect(() => () => clearTimeout(timer.current), [])

  let tokens = null
  if (query && typeof tokenize === 'function') {
    try {
      tokens = tokenize(query)
    } catch {
      tokens = null   // uncoloured beats blank
    }
  }

  const copy = () => {
    try {
      navigator.clipboard?.writeText(query)
    } catch {
      // A clipboard the browser refuses has nothing to recover from; the query
      // is on screen and selectable either way.
    }
    setCopied(true)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), 1600)
  }

  return (
    <div className={clsx('ex-genq', className)}>
      <div className="ex-genq-head">
        <span className="ex-genq-title">{title}</span>
        <button
          type="button"
          className={clsx('ex-genq-copy', { 'is-done': copied })}
          onClick={copy}
          disabled={!query}
          aria-label={`Copy ${title.toLowerCase()}`}
        >
          {copied
            ? <Check size={12} strokeWidth={2.4} aria-hidden="true" />
            : <Copy size={12} strokeWidth={2} aria-hidden="true" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {/* A live region: the query is rebuilt as the rows above change, and a
          screen reader should hear the result rather than only the controls. */}
      <pre className={clsx('ex-genq-body', { 'is-empty': !query })} aria-live="polite">
        {!query && empty}
        {query && (tokens
          ? tokens.map((t, i) => <span key={i} className={`ex-tok-${t.type}`}>{t.value}</span>)
          : query)}
      </pre>
    </div>
  )
}
