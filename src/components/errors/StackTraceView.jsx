import { useMemo, useState } from 'react'
// Why this file is StackTraceView.jsx and not StackTrace.jsx: beside
// stackTrace.js, on macOS's case-blind filesystem, an extensionless
// './stackTrace' would resolve to StackTrace.jsx in esbuild (the tests; it
// tries .jsx first) and './StackTrace' to stackTrace.js in Vite (.js first).
import { classifyStackLines, countFrames, foldStack, FOLD_FRAMES } from './stackTrace.js'
// The .errd-stack* look is the Error details drawer's. Said here rather than
// left to the drawer having loaded it first: the exception modal on the Browser
// page draws this stack with no drawer anywhere on the screen.
import './error-details.css'

// The stack, one line per line so each can say what it is: the throw in red,
// the application's own frames at full strength (that is where a fix goes),
// library frames stepped back, and each wrapped cause as a heading. Folded to a
// dozen frames in a way that keeps the root cause on screen; see foldStack.
//
// Which frames are the application's is the caller's to say when the trace is
// not the JVM's: `isApp(frame)` replaces the package-prefix test (a browser's
// JavaScript trace passes isJsAppFrame, which reads the file a frame points
// at). Left out, the drawer's JVM reading applies unchanged.
//
// `expanded`/`onToggle` are the drawer's: it keeps the fold open while the
// reader steps between occurrences. Without them the component keeps its own,
// so a one-off stack (the exception modal's) needs no state of its caller's.
export default function StackTraceView({
  text, expanded, onToggle, isApp,
  emptyText = 'No stack trace was recorded on this occurrence.',
}) {
  const [ownExpanded, setOwnExpanded] = useState(false)
  const open = expanded ?? ownExpanded
  const toggle = onToggle ?? (() => setOwnExpanded(v => !v))
  const lines = useMemo(() => classifyStackLines(text, { isApp }), [text, isApp])
  const frames = countFrames(lines)
  const foldable = frames > FOLD_FRAMES
  const shown = open || !foldable ? lines : foldStack(lines)

  if (!lines.length) return <div className="errd-none-note">{emptyText}</div>
  return (
    <div className="errd-stack-box">
      {/* Focusable because it scrolls both ways: a keyboard reader has to be
          able to reach the end of a long frame. ←/→ scroll it rather than
          stepping samples while it has focus. */}
      <pre className="errd-stack mono" tabIndex={0} role="region" aria-label="Stack trace">
        {shown.map((l, i) => (
          l.kind === 'fold'
            ? <span key={i} className="errd-stack-line is-fold">{`… ${l.hidden} frame${l.hidden === 1 ? '' : 's'} folded`}</span>
            : <span key={i} className={`errd-stack-line is-${l.kind}`}>{l.text}</span>
        ))}
      </pre>
      {foldable && (
        <button type="button" className="errd-stack-toggle" aria-expanded={open} onClick={toggle}>
          {open ? 'Show fewer frames' : `Show all ${frames} frames`}
        </button>
      )}
    </div>
  )
}
