import { useState, useId, useRef, useEffect } from 'react'
import { Plus, Trash2, Upload } from 'lucide-react'
import BreakAtSlashes from './BreakAtSlashes'
import './browser.css'

// The Browser page's settings drawer body: production's two tabs, Path
// Patterns and Source Maps, drawn with the drawer's own classes so it reads as
// the same drawer the service page opens.
//
// Both lists belong to App, not to this component. The drawer is unmounted
// every time it closes, so a list kept here would be gone the next time the
// gear is pressed; App holds them, as it holds the Infra nav's hidden items,
// and this only reads them and hands changes back through the setters. The
// source maps are also read by the Browser page itself: the error modal shows
// an un-minified stack only for a bundle whose map is in this list.
//
// Production adds a path pattern in a modal. Here it is a form inline in the
// drawer: the only modal style in the app sits below the drawer (z-index 500
// against 599), and a form in place keeps the list it adds to in view.

// Ids for rows created here. Module-level, so they stay unique across the
// drawer closing and opening again; the seeded rows carry ids of their own.
let createdRows = 0
const newRowId = prefix => `${prefix}-new-${++createdRows}`

// Production's help text, as its Add Path Pattern modal words it.
const HOST_HELP = 'Leave blank for the web application\'s own pages. For external urls, provide domain name and port, e.g., abc.com:443.'
const PATTERN_HELP = 'For example /api/v1/users/:id. A \':\' matches one path segment, and a \'*\' matches everything afterwards.'

// What is wrong with a field, in a sentence, or '' when nothing is. A mistake
// that is one already, whatever comes next (a scheme, a path, a space), is
// said as it is typed: hearing it early is help. One that is only a field not
// finished yet (a host still without its port, half a URL) waits until the
// reader leaves the field or presses Create — flagging every keystroke of a
// correct URL in red would only be noise. Create itself is never greyed out:
// pressed too early it says what is missing and puts focus on it, where a
// disabled button would say nothing at all to a keyboard or a screen reader.
function hostProblem(host, finished) {
  if (!host) return ''
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) return 'Leave the scheme out: abc.com:443, not https://abc.com:443.'
  if (/[\s/]/.test(host)) return 'A host is a domain name and port only, with no path: abc.com:443.'
  // Production's own help asks for the port, so it is checked for: the same
  // host on two ports is two different origins.
  if (finished && !/^[^\s/:]+:\d{1,5}$/.test(host)) return `Add the port: ${host.split(':')[0]}:443.`
  return ''
}

function patternProblem(pattern) {
  if (!pattern) return ''
  if (!pattern.startsWith('/')) return 'A path pattern starts with \'/\', as in /api/v1/users/:id.'
  if (/\s/.test(pattern)) return 'A path pattern cannot contain spaces.'
  return ''
}

function sourceFileProblem(url, finished) {
  if (!url) return ''
  if (/\s/.test(url)) return 'A URL cannot contain spaces.'
  if (finished && !/^https?:\/\/[^\s/]+\/\S+$/i.test(url)) return 'Enter the file\'s full URL, starting with https://, as the page loads it.'
  return ''
}

// A field's "finished" state: once the reader has left it, or pressed the
// form's submit, its unfinished-value checks apply (see above).
function useFinished() {
  const [left, setLeft] = useState(false)
  return [left, () => setLeft(true)]
}

// Focus goes back to the button that opened a form once it closes, whether
// it was created, uploaded or cancelled - otherwise it falls to the top of
// the document, far from the list the reader was working in.
function useReturnFocus(open) {
  const triggerRef = useRef(null)
  const wasOpen = useRef(open)
  useEffect(() => {
    if (wasOpen.current && !open) triggerRef.current?.focus()
    wasOpen.current = open
  }, [open])
  return triggerRef
}

function Field({ id, label, optional, help, problem, children }) {
  return (
    <div className="drawer-section">
      <label className="drawer-section-label" htmlFor={id}>
        {label}
        {optional && <span className="brw-set-optional">optional</span>}
      </label>
      {children}
      {help && <p className="drawer-description brw-set-help" id={`${id}-help`}>{help}</p>}
      {/* Polite, not an alert: it changes as the reader types, and an alert
          would interrupt them on every keystroke. */}
      <p className="brw-set-error" id={`${id}-problem`} aria-live="polite">{problem}</p>
    </div>
  )
}

const describedBy = (id, help, problem) => [help && `${id}-help`, problem && `${id}-problem`].filter(Boolean).join(' ') || undefined

function SettingsEmpty({ title, sub }) {
  return (
    <div className="drawer-empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="22" height="22" aria-hidden="true">
        <rect x="2" y="4" width="20" height="16" rx="2" /><path d="M2 8h20" /><path d="M6 4v4" /><path d="M10 4v4" />
      </svg>
      <div className="drawer-empty-title">{title}</div>
      <div className="drawer-empty-sub">{sub}</div>
    </div>
  )
}

function DeleteButton({ label, onClick, buttonRef }) {
  return (
    <button ref={buttonRef} type="button" className="brw-set-del" title={label} aria-label={label} onClick={onClick}>
      <Trash2 size={14} strokeWidth={1.75} aria-hidden="true" />
    </button>
  )
}

// Deleting a row takes its focused delete button with it. Focus moves to the
// next row's delete button (or the previous one's, at the end of the list),
// and to the list's own button once nothing is left, so deleting several in a
// row is a matter of pressing Enter again — and a polite status line says
// what went.
//
// `fallbacks` are refs tried in order once no row is left to land on. The
// list's own button is the first, but it is not always there to take focus:
// New is disabled while its form is open, and Add source map gives way to its
// form. So each list names a second place that always is (the pattern search,
// the source map list's heading), and focus never falls to <body>.
function useDeleteFocus(...fallbacks) {
  const buttons = useRef(new Map())
  const pending = useRef(null)
  const [said, setSaid] = useState('')
  useEffect(() => {
    if (pending.current == null) return
    const usable = el => el != null && el.isConnected && !el.disabled
    const target = [buttons.current.get(pending.current), ...fallbacks.map(r => r.current)].find(usable)
    pending.current = null
    target?.focus()
  })
  const refFor = id => el => { if (el) buttons.current.set(id, el); else buttons.current.delete(id) }
  // `ids` is the list as shown, `id` the row going, `what` how to say it.
  const removed = (ids, id, what) => {
    const i = ids.indexOf(id)
    pending.current = ids[i + 1] ?? ids[i - 1] ?? ''
    setSaid(`${what} deleted`)
  }
  return { refFor, removed, said }
}

/* ---- Path Patterns ---- */

function PathPatternForm({ existing, onCreate, onCancel }) {
  const id = useId()
  const [host, setHost] = useState('')
  const [pattern, setPattern] = useState('')
  const [description, setDescription] = useState('')
  const [hostDone, leaveHost] = useFinished()
  const [submitted, setSubmitted] = useState(false)
  const firstRef = useRef(null)
  const patternRef = useRef(null)
  useEffect(() => { firstRef.current?.focus() }, [])

  const h = host.trim()
  const p = pattern.trim()
  // The host is a domain, so its case says nothing; the path's does.
  const duplicate = p && existing.some(x => x.host.toLowerCase() === h.toLowerCase() && x.pattern === p)
  const hostErr = hostProblem(h, hostDone || submitted)
  const patternErr = patternProblem(p) || (duplicate ? 'This pattern is already in the list.' : '')
    || (submitted && !p ? 'Enter a path pattern, as in /api/v1/users/:id.' : '')

  const submit = (e) => {
    e.preventDefault()
    setSubmitted(true)
    // Checked with the host as finished, which is what pressing Create says.
    const hostNow = hostProblem(h, true)
    if (hostNow) { firstRef.current?.focus(); return }
    if (!p || patternErr) { patternRef.current?.focus(); return }
    onCreate({ id: newRowId('pp'), host: h, pattern: p, description: description.trim() })
  }

  return (
    <form
      className="brw-set-form"
      aria-label="Add path pattern"
      noValidate
      onSubmit={submit}
      // Escape abandons the form, as it would close production's modal. It
      // stops here so nothing behind the drawer hears it too.
      onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); onCancel() } }}
    >
      <div className="brw-set-form-title">Add path pattern</div>
      <Field id={`${id}-host`} label="Host" optional help={HOST_HELP} problem={hostErr}>
        <div className="drawer-input-wrap">
          <input
            ref={firstRef}
            id={`${id}-host`}
            placeholder="abc.com:443"
            value={host}
            onChange={e => setHost(e.target.value)}
            onBlur={leaveHost}
            aria-invalid={hostErr ? true : undefined}
            aria-describedby={describedBy(`${id}-host`, HOST_HELP, hostErr)}
            spellCheck={false}
          />
        </div>
      </Field>
      <Field id={`${id}-pattern`} label="Path pattern" help={PATTERN_HELP} problem={patternErr}>
        <div className="drawer-input-wrap">
          <input
            ref={patternRef}
            id={`${id}-pattern`}
            className="mono"
            placeholder="/api/v1/users/:id"
            value={pattern}
            onChange={e => setPattern(e.target.value)}
            aria-invalid={patternErr ? true : undefined}
            aria-describedby={describedBy(`${id}-pattern`, PATTERN_HELP, patternErr)}
            spellCheck={false}
            required
          />
        </div>
      </Field>
      <Field id={`${id}-desc`} label="Description" optional>
        <div className="drawer-input-wrap">
          <input id={`${id}-desc`} placeholder="What this pattern groups" value={description} onChange={e => setDescription(e.target.value)} />
        </div>
      </Field>
      <div className="drawer-row">
        <button type="submit" className="hbtn primary">Create</button>
        <button type="button" className="hbtn" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  )
}

function PathPatterns({ patterns, setPatterns, apps, appId }) {
  const [search, setSearch] = useState('')
  const [adding, setAdding] = useState(false)
  const newRef = useReturnFocus(adding)
  const searchRef = useRef(null)
  const del = useDeleteFocus(newRef, searchRef)

  // A pattern belongs to the app it was created on, as a source map does: the
  // storefront's /product/* is not the back office's. The drawer lists the
  // patterns of the app the page is showing, and names it.
  const appName = apps.find(a => a.id === appId)?.name ?? appId
  const own = patterns.filter(p => p.appId === appId)
  const q = search.trim().toLowerCase()
  const shown = q
    ? own.filter(p => [p.host, p.pattern, p.description].some(v => v?.toLowerCase().includes(q)))
    : own

  // Newest first: the pattern just created is the one the reader wants to
  // see land, and it lands at the top of the list rather than off the end.
  const create = (row) => {
    setPatterns(list => [{ ...row, appId }, ...list])
    setAdding(false)
  }
  const remove = (row) => {
    del.removed(shown.map(p => p.id), row.id, `Path pattern ${row.pattern}`)
    setPatterns(list => list.filter(p => p.id !== row.id))
  }

  return (
    <>
      <p className="drawer-description">
        Path patterns decide which of <span className="mono">{appName}</span>&apos;s page views and Ajax calls are
        counted together. CubeAPM already groups URLs that differ only by an id (/orders/8812 becomes
        /orders/:orderId); add a pattern where that grouping falls short. A pattern applies to data received
        after it is created.
      </p>
      <p className="sr-only" role="status">{del.said}</p>
      <div className="brw-set-toolbar">
        <div className="drawer-nav-search">
          <input ref={searchRef} placeholder="Search patterns" aria-label="Search patterns" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <button
          ref={newRef}
          type="button"
          className="hbtn primary"
          onClick={() => setAdding(true)}
          disabled={adding}
          aria-expanded={adding}
        >
          New
          <Plus size={14} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>
      {adding && <PathPatternForm existing={own} onCreate={create} onCancel={() => setAdding(false)} />}
      {own.length === 0 ? (
        !adding && (
          <SettingsEmpty
            title="No path patterns yet"
            sub={`Until one is added, ${appName}'s pages and calls are grouped by the routes CubeAPM detects. Press New to add one.`}
          />
        )
      ) : shown.length === 0 ? (
        <div className="drawer-nav-empty">No patterns match &ldquo;{search.trim()}&rdquo;</div>
      ) : (
        <ul className="brw-set-list" aria-label="Path patterns">
          {shown.map(p => (
            <li key={p.id} className="brw-set-row">
              <div className="brw-set-row-main">
                <div className="brw-set-row-title"><BreakAtSlashes text={p.pattern} /></div>
                <div className="brw-set-row-meta">
                  {p.host ? <span className="mono">{p.host}</span> : <span>{appName}&apos;s own pages</span>}
                </div>
                {p.description && <div className="brw-set-row-desc">{p.description}</div>}
              </div>
              <DeleteButton
                buttonRef={del.refFor(p.id)}
                label={`Delete path pattern ${p.host ? `${p.host}${p.pattern}` : p.pattern}`}
                onClick={() => remove(p)}
              />
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

/* ---- Source Maps ---- */

function SourceMapForm({ apps, appId, existing, onUpload, onCancel }) {
  const id = useId()
  const [app, setApp] = useState(() => (apps.some(a => a.id === appId) ? appId : apps[0]?.id ?? ''))
  const [sourceFile, setSourceFile] = useState('')
  // Only the file's name is kept: this is mock data, and nothing reads the
  // map's contents - the un-minified stacks are generated with the traces.
  const [mapName, setMapName] = useState('')
  const [description, setDescription] = useState('')
  const firstRef = useRef(null)
  useEffect(() => { firstRef.current?.focus() }, [])

  const [urlDone, leaveUrl] = useFinished()
  const [submitted, setSubmitted] = useState(false)
  const fileRef = useRef(null)
  const url = sourceFile.trim()
  const urlErr = sourceFileProblem(url, urlDone || submitted)
    || (submitted && !url ? 'Enter the source file\'s URL, as the page loads it.' : '')
  const mapErr = submitted && !mapName ? 'Choose the .map file for this bundle.' : ''
  const replaces = url ? existing.find(m => m.appId === app && m.sourceFile === url) : null
  const origin = apps.find(a => a.id === app)?.origin

  const submit = (e) => {
    e.preventDefault()
    setSubmitted(true)
    if (!url || sourceFileProblem(url, true)) { firstRef.current?.focus(); return }
    if (!mapName) { fileRef.current?.focus(); return }
    onUpload({ id: newRowId('sm'), appId: app, sourceFile: url, sourceMap: mapName, description: description.trim() })
  }

  return (
    <form
      className="brw-set-form"
      aria-label="Add source map"
      noValidate
      onSubmit={submit}
      onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); onCancel() } }}
    >
      <div className="brw-set-form-title">Add source map</div>
      {apps.length > 1 && (
        <Field id={`${id}-app`} label="App">
          <select id={`${id}-app`} className="drawer-select" value={app} onChange={e => setApp(e.target.value)}>
            {apps.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </Field>
      )}
      <Field
        id={`${id}-file`}
        label="Source file URL"
        help="The minified file's full URL, as the page loads it."
        problem={urlErr}
      >
        <div className="drawer-input-wrap">
          <input
            ref={firstRef}
            id={`${id}-file`}
            className="mono"
            type="url"
            placeholder={`${origin ?? 'https://example.com'}/assets/index.js`}
            value={sourceFile}
            onChange={e => setSourceFile(e.target.value)}
            onBlur={leaveUrl}
            aria-invalid={urlErr ? true : undefined}
            aria-describedby={describedBy(`${id}-file`, true, urlErr)}
            spellCheck={false}
            required
          />
        </div>
      </Field>
      <Field id={`${id}-map`} label="Source map" help="The .map file the build wrote next to that bundle." problem={mapErr}>
        <div className="brw-set-file">
          {/* The real input is kept (visually hidden, still focusable) so the
              keyboard and screen readers get the native file picker; the
              label is what is drawn. */}
          <input
            ref={fileRef}
            id={`${id}-map`}
            className="sr-only"
            type="file"
            accept=".map,.json,application/json"
            aria-describedby={describedBy(`${id}-map`, true, mapErr)}
            aria-invalid={mapErr ? true : undefined}
            onChange={e => setMapName(e.target.files?.[0]?.name ?? '')}
          />
          <label htmlFor={`${id}-map`} className="hbtn small">Choose file</label>
          <span className={`brw-set-file-name${mapName ? ' mono' : ''}`}>{mapName || 'No file chosen'}</span>
        </div>
      </Field>
      <Field id={`${id}-desc`} label="Description" optional>
        <div className="drawer-input-wrap">
          <input id={`${id}-desc`} placeholder="Release or bundle this map belongs to" value={description} onChange={e => setDescription(e.target.value)} />
        </div>
      </Field>
      {replaces && (
        <p className="brw-set-note" role="status">
          This file already has a source map (<span className="mono">{replaces.sourceMap}</span>); uploading replaces it.
        </p>
      )}
      <div className="drawer-row">
        <button type="submit" className="hbtn primary">
          <Upload size={13} strokeWidth={2} aria-hidden="true" />
          Upload
        </button>
        <button type="button" className="hbtn" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  )
}

// The file a map URL or a picked file names: 'index-4f2a9c.js.map'. A seeded
// map is filed under its full URL and an uploaded one under its file name, so
// a row shows the file name either way, with the full value as its title.
const fileOf = v => String(v ?? '').split(/[?#]/)[0].split('/').pop() || String(v ?? '')

function SourceMaps({ maps, setMaps, apps, appId }) {
  const listLabelId = useId()
  const [adding, setAdding] = useState(false)
  const addRef = useReturnFocus(adding)
  const listHeadRef = useRef(null)
  const del = useDeleteFocus(addRef, listHeadRef)
  const appName = Object.fromEntries(apps.map(a => [a.id, a.name]))
  // Which app a map belongs to only needs saying when there is a choice.
  const showApp = apps.length > 1

  // One map per bundle: uploading for a file that already has one replaces
  // it, in place, so the list keeps its order.
  const upload = (row) => {
    setMaps(list => (list.some(m => m.appId === row.appId && m.sourceFile === row.sourceFile)
      ? list.map(m => (m.appId === row.appId && m.sourceFile === row.sourceFile ? row : m))
      : [row, ...list]))
    setAdding(false)
  }
  const remove = (row) => {
    del.removed(maps.map(m => m.id), row.id, `Source map for ${fileOf(row.sourceFile)}`)
    setMaps(list => list.filter(m => m.id !== row.id))
  }

  return (
    <>
      <p className="drawer-description">
        Browsers report errors against the minified bundle the page loaded. With that bundle&apos;s source map
        uploaded, the Errors and Traces tabs show the un-minified stack: the original function, file and line.
      </p>
      <p className="sr-only" role="status">{del.said}</p>
      {adding ? (
        <SourceMapForm apps={apps} appId={appId} existing={maps} onUpload={upload} onCancel={() => setAdding(false)} />
      ) : (
        <div className="brw-set-toolbar">
          <button ref={addRef} type="button" className="hbtn primary" onClick={() => setAdding(true)}>
            <Upload size={13} strokeWidth={2} aria-hidden="true" />
            Add source map
          </button>
        </div>
      )}
      <div className="drawer-section">
        {/* Focusable only from script (tabIndex -1, never a Tab stop): where
            focus goes when the last map is deleted while the upload form has
            taken the Add button's place. */}
        <div ref={listHeadRef} className="drawer-section-label" id={listLabelId} tabIndex={-1}>Current source maps</div>
        {maps.length === 0 ? (
          <SettingsEmpty
            title="No source maps yet"
            sub="Until one is uploaded, stack traces show the minified bundle's frames."
          />
        ) : (
          <ul className="brw-set-list" aria-labelledby={listLabelId}>
            {maps.map(m => (
              <li key={m.id} className="brw-set-row">
                <div className="brw-set-row-main">
                  <div className="brw-set-row-title" title={m.sourceFile}><BreakAtSlashes text={m.sourceFile} /></div>
                  <div className="brw-set-row-meta">
                    <span title={m.sourceMap}>Map <span className="mono">{fileOf(m.sourceMap)}</span></span>
                    {showApp && <span>{appName[m.appId] ?? m.appId}</span>}
                  </div>
                  {m.description && <div className="brw-set-row-desc">{m.description}</div>}
                </div>
                <DeleteButton
                  buttonRef={del.refFor(m.id)}
                  label={`Delete source map for ${m.sourceFile}`}
                  onClick={() => remove(m)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  )
}

/**
 * `tab` is the drawer's active tab, 'Path Patterns' or 'Source Maps'.
 * `apps` are the browser apps ({ id, name, origin }); `appId` is the one the
 * page is showing. Path patterns are that app's (each row carries its
 * `appId`); the source map list shows every app's, naming each, and its upload
 * form starts on this one.
 */
export default function BrowserSettings({ tab, pathPatterns, setPathPatterns, sourceMaps, setSourceMaps, apps = [], appId }) {
  if (tab === 'Source Maps') {
    return <SourceMaps maps={sourceMaps ?? []} setMaps={setSourceMaps} apps={apps} appId={appId} />
  }
  return <PathPatterns patterns={pathPatterns ?? []} setPatterns={setPathPatterns} apps={apps} appId={appId} />
}
