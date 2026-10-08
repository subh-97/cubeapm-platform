// Reading a stack trace the way the Error details drawer shows it.
//
// A JVM trace is one document with three kinds of line in it that matter to a
// reader: the throw (`Type: message`), the frames, and a `Caused by:` heading
// for every exception it wraps. Among the frames, the ones in the
// application's own packages are where a fix will go; the rest are the
// libraries and the runtime the call passed through. Kept out of the component
// so the classification is tested rather than eyeballed.

// Packages that are this platform's own code. Everything else is a library.
export const APP_FRAME_PREFIXES = ['com.cubedemo.']

// Past this many frames the drawer folds the trace until asked for all of it.
export const FOLD_FRAMES = 12

const CAUSE = /^(Caused by|Suppressed):/
// The JVM's own elision at the end of a wrapped exception's frames, and
// Logback's spelling of the same thing.
const ELIDED = /^\.\.\. \d+ (more|common frames omitted)$/

// The class and method a frame names, without the module or class-loader
// prefix Java 9+ puts in front (`java.base/`, `app//`). Only the part before
// the parenthesis is looked at: the file position after it can hold slashes of
// its own on a JavaScript frame.
function frameSymbol(frame) {
  const paren = frame.indexOf('(')
  const sig = paren >= 0 ? frame.slice(0, paren) : frame
  return sig.slice(sig.lastIndexOf('/') + 1)
}

export function isAppFrame(frame, appPrefixes = APP_FRAME_PREFIXES) {
  const symbol = frameSymbol(frame)
  return appPrefixes.some(p => symbol.startsWith(p))
}

export const isFrame = line => line.kind === 'app' || line.kind === 'lib'

/**
 * One entry per line of `text`, each `{ text, kind }`:
 *
 *   head   the throw, `Type: message`, and any further lines of its message
 *   cause  a `Caused by:` / `Suppressed:` heading, and the rest of its message
 *   app    a frame in the application's own packages
 *   lib    any other frame
 *   more   the JVM's `... N more`
 *   other  anything else after the first frame
 *
 * A message can run over several lines, so a line is only a frame or a
 * heading by its shape: until the first frame, whatever is not one belongs to
 * the message above it.
 */
export function classifyStackLines(text, { appPrefixes = APP_FRAME_PREFIXES } = {}) {
  const raw = String(text ?? '')
  if (!raw.trim()) return []
  let header = 'head'
  // A trailing newline is the end of the text, not an empty last line.
  return raw.replace(/[\r\n]+$/, '').split('\n').map(full => {
    const line = full.replace(/\r$/, '')
    const t = line.trim()
    if (t.startsWith('at ')) {
      header = null
      return { text: line, kind: isAppFrame(t.slice(3), appPrefixes) ? 'app' : 'lib' }
    }
    if (CAUSE.test(t)) {
      header = 'cause'
      return { text: line, kind: 'cause' }
    }
    if (ELIDED.test(t)) return { text: line, kind: 'more' }
    return { text: line, kind: header ?? 'other' }
  })
}

export function countFrames(lines) {
  return lines.reduce((n, l) => n + (isFrame(l) ? 1 : 0), 0)
}

/**
 * The lines to show while a trace is folded to `limit` frames, with a
 * `{ kind: 'fold', hidden }` marker wherever frames were left out.
 *
 * Cutting the document at its twelfth frame would be the obvious fold and the
 * wrong one: the root cause is the LAST block, under a run of reflection,
 * Spring and Tomcat frames that every request shares, so a plain cut hides the
 * one line a reader opened the trace for. Instead every block — the throw and
 * each `Caused by:` — keeps its heading and its top frames, the frames are
 * shared out a round at a time in block order (so the throw keeps the most),
 * and what gives way is the bottom of each block, which is where the shared
 * plumbing lives. Headings and `... N more` lines are always kept.
 */
export function foldStack(lines, limit = FOLD_FRAMES) {
  if (countFrames(lines) <= limit) return lines

  const blocks = []
  let prevKind = null
  for (const l of lines) {
    if (!blocks.length || (l.kind === 'cause' && prevKind !== 'cause')) blocks.push([])
    blocks[blocks.length - 1].push(l)
    prevKind = l.kind
  }

  const frames = blocks.map(countFrames)
  const keep = frames.map(() => 0)
  for (let left = limit; left > 0;) {
    let gave = false
    for (let b = 0; b < blocks.length && left > 0; b++) {
      if (keep[b] < frames[b]) { keep[b]++; left--; gave = true }
    }
    if (!gave) break
  }

  const out = []
  blocks.forEach((block, b) => {
    const hidden = frames[b] - keep[b]
    let seen = 0
    for (const l of block) {
      if (!isFrame(l)) { out.push(l); continue }
      seen++
      if (seen <= keep[b]) out.push(l)
      else if (seen === keep[b] + 1) out.push({ kind: 'fold', hidden, text: '' })
    }
  })
  return out
}
