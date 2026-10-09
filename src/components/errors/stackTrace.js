// Reading a stack trace the way the Error details drawer shows it.
//
// A JVM trace is one document with three kinds of line in it that matter to a
// reader: the throw (`Type: message`), the frames, and a `Caused by:` heading
// for every exception it wraps. Among the frames, the ones in the
// application's own packages are where a fix will go; the rest are the
// libraries and the runtime the call passed through. Kept out of the component
// so the classification is tested rather than eyeballed.
//
// A browser's JavaScript trace has the same shape with other spellings: the
// throw (`TypeError: …`), then V8's `at fn (file:line:col)` frames — or, from
// some source-map tools and from Firefox and Safari, the same frame with no
// `at` in front. What makes a JS frame the application's is the FILE it points
// at, not a package prefix on its symbol, so a caller reading one passes its
// own `isApp` test (isJsAppFrame below is the stock one).

// Packages that are this platform's own code. Everything else is a library.
export const APP_FRAME_PREFIXES = ['com.cubedemo.']

// Past this many frames the drawer folds the trace until asked for all of it.
export const FOLD_FRAMES = 12

const CAUSE = /^(Caused by|Suppressed):/
// The JVM's own elision at the end of a wrapped exception's frames, and
// Logback's spelling of the same thing.
const ELIDED = /^\.\.\. \d+ (more|common frames omitted)$/

// Where a JavaScript frame points: `file:line:col`, ending the line on its own
// (an anonymous frame) or inside the parentheses after the function name. A
// JVM frame's position names one number (`Pool.java:84`), so it never matches.
const JS_POSITION = /:\d+:\d+\)?$/

// A frame written without V8's `at `: `CartSummary (src/components/cart.js:118:22)`
// as source-map tools print an un-minified trace, or `render@https://…:2:184310`
// as Firefox and Safari do. Read before this, such a line was taken for more of
// the throw's message and painted red with it. What tells it from the throw is
// the `Type: ` separator: a throw line always has it, a frame never does — and
// a URL's `https://` is not one, having no space after its colon.
const isBareJsFrame = t => JS_POSITION.test(t) && !t.includes(': ')

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

// The directories that hold a web app's own source in a source-mapped trace.
// Everything else — react-dom, anything under node_modules, a vendor chunk, a
// minified bundle nobody has mapped — is a library as far as a reader is
// concerned: the fix does not go there.
export const JS_APP_DIRS = ['src/']

/**
 * The file a JavaScript frame points at, as a path inside the project: the
 * position in the parentheses (or after `@`, or the whole frame when it is
 * anonymous), without its `:line:col`, its origin (`https://shop…/`,
 * `webpack:///`, `file://`) or a leading `./` or `/`.
 */
export function jsFramePath(frame) {
  const s = String(frame ?? '').trim()
  const open = s.lastIndexOf('(')
  const loc = open >= 0 && s.endsWith(')') ? s.slice(open + 1, -1) : s.slice(s.indexOf('@') + 1)
  return loc
    .replace(/:\d+:\d+$/, '')
    .replace(/^[a-z][\w+.-]*:\/\/[^/]*\/?/i, '')
    .replace(/^(\.?\/)+/, '')
}

/**
 * Whether a JavaScript frame is in the application's own source: its file sits
 * under one of `appDirs` (anywhere in the path, so a dev server's
 * `https://host/src/…` and a `file:///…/shop/src/…` both count) and nowhere
 * under node_modules (a package ships a src/ of its own). Pass it as
 * classifyStackLines' `isApp`.
 */
export function isJsAppFrame(frame, appDirs = JS_APP_DIRS) {
  const path = `/${jsFramePath(frame)}`
  if (path.includes('/node_modules/')) return false
  return appDirs.some(d => path.includes(`/${d.replace(/^\/+/, '')}`))
}

export const isFrame = line => line.kind === 'app' || line.kind === 'lib'

/**
 * One entry per line of `text`, each `{ text, kind }`:
 *
 *   head   the throw, `Type: message`, and any further lines of its message
 *   cause  a `Caused by:` / `Suppressed:` heading, and the rest of its message
 *   app    a frame in the application's own code (its packages, or for
 *          JavaScript its source files)
 *   lib    any other frame
 *   more   the JVM's `... N more`
 *   other  anything else after the first frame
 *
 * A message can run over several lines, so a line is only a frame or a
 * heading by its shape: until the first frame, whatever is not one belongs to
 * the message above it.
 *
 * A frame is the application's by `isApp(frame)` when one is given — handed
 * the frame without its `at ` — and otherwise by the JVM package test against
 * `appPrefixes`. JavaScript traces pass isJsAppFrame, since a JS symbol
 * (`t.render`, `CartSummary`) says nothing about whose code it is.
 */
export function classifyStackLines(text, { appPrefixes = APP_FRAME_PREFIXES, isApp } = {}) {
  const raw = String(text ?? '')
  if (!raw.trim()) return []
  const appFrame = isApp ?? (frame => isAppFrame(frame, appPrefixes))
  let header = 'head'
  // A trailing newline is the end of the text, not an empty last line.
  return raw.replace(/[\r\n]+$/, '').split('\n').map(full => {
    const line = full.replace(/\r$/, '')
    const t = line.trim()
    const at = t.startsWith('at ')
    if (at || isBareJsFrame(t)) {
      header = null
      return { text: line, kind: appFrame(at ? t.slice(3) : t) ? 'app' : 'lib' }
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
