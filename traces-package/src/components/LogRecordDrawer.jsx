// The log record drawer: the panel that opens when a log row is clicked.
//
// Extracted from LogsView so the drawer is a component rather than a region of
// a page file. It owns no query state — every action it offers is handed back
// to the parent as a callback, which is what lets the same drawer sit in front
// of a different data source.

import { useState, useEffect, useRef, useMemo } from 'react'
import { ArrowUpRight, Filter as FilterIcon } from 'lucide-react'
import { services } from '@/data/services'
import StatusBadge from '@/components/shared/StatusBadge'
import { statusForLogLevel } from '@/utils/status'
import {
  linkFor as resolveLink, highlightFields, fieldGroupsFor,
  recordType, recordTitle, TYPE_LABELS, durationGloss, conceptOf,
} from '@/utils/logFields'
import { highlightTerms } from '@/utils/highlight'

// Fields that lead somewhere else in the product. The destination is described
// here rather than at each render site, so the marker beside the value and the
// entry in the field menu can never name different places. Wiring navigation
// later means giving each entry an href — nothing about the signifier changes.
//
// Deliberately inert for now: a marker that reads as a live link and does
// nothing is worse than no marker at all.
// A log's service is not always an APM service: on a real instance log rows
// carry `search` while APM knows `search-service`. Linking anyway produces a
// page that loads, shows nothing, and blames the user, so the link resolver is
// told which names actually exist.
const KNOWN_SERVICES = new Set(services.map(s => s.id))

function linkFor(field, value, record) {
  return resolveLink({ field, value, record, knownServices: KNOWN_SERVICES })
}

// Marks a value as a doorway, and opens it when there is somewhere to go.
function LinkMarker({ link, onOpen }) {
  // Guarded because this is a decoration: if a caller ever stops passing a
  // link, the field should lose its marker, not blank the whole drawer.
  if (!link) return null
  const filter = link.kind === 'filter'
  const icon = filter
    ? <FilterIcon size={10} strokeWidth={2.25} />
    : <ArrowUpRight size={11} strokeWidth={2.25} />

  // An open link goes somewhere, so it is a button. A filter marker is not:
  // the filter itself is offered in the field menu, where include and exclude
  // already live, and a second way to press it would be two answers to one
  // question.
  if (filter || !onOpen) {
    return (
      <span className={`log-link-hint${filter ? ' is-filter' : ''}`}
        role="img" aria-label={link.hint} title={link.hint}>{icon}</span>
    )
  }
  return (
    <button type="button" className="log-link-hint is-open"
      aria-label={link.label} title={link.hint}
      onClick={(e) => { e.stopPropagation(); onOpen(link) }}>{icon}</button>
  )
}

// These exist only on error records. Elsewhere the rows are labels for things
// that are not there, which reads as missing data rather than as "this log did
// not throw" - and since they are a whole group, an info record would otherwise
// end with a heading-shaped gap. With both empty the group drops out entirely.
//
// The JSON view deliberately keeps them: that view is the raw record, this one
// is what the record actually has.
const ERROR_ONLY_FIELDS = new Set(['log.exception.type', 'log.stacktrace'])

function isHiddenField(k, v) {
  return ERROR_ONLY_FIELDS.has(k) && (v == null || v === '')
}

// What the record is about leads, and what it is stamped with follows. Which
// fields those are depends on the shape of the record: a database call opens on
// the statement, a cluster event on what happened to what.
function recordFieldGroups(log) {
  return fieldGroupsFor(log, { isHidden: isHiddenField })
}

// The SDK's resource block and the Kubernetes API's managedFields are on every
// record of their kind, identical every time. Sorted alphabetically they are
// the first screen of the record, which is how a drawer opens on a wall of
// things nobody came to read. They are still part of the record, so they stay -
// folded, counted, and one click away.
function NoiseGroup({ fields, hits, record, canPin, onTogglePin, onMenu, onOpenLink }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="log-detail-group is-noise">
      <button type="button" className="log-noise-toggle"
        aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          strokeLinecap="round" strokeLinejoin="round"
          className={open ? 'is-open' : undefined}><path d="M9 18l6-6-6-6" /></svg>
        {fields.length} agent and platform {fields.length === 1 ? 'field' : 'fields'}
      </button>
      {open && fields.map(([k, v]) => (
        <FieldRow
          key={k} name={k} value={v} hits={hits} record={record}
          pinned={false} pinnable={canPin(k)}
          onTogglePin={onTogglePin} onMenu={onMenu} onOpenLink={onOpenLink}
        />
      ))}
    </div>
  )
}

// One field row, shared by the pinned block and the grouped list so a field
// looks and behaves the same wherever it currently sits.
function FieldRow({ name, value, hits, record, isMsg, pinned, pinnable, onTogglePin, onMenu, onOpenLink }) {
  const link = isMsg ? null : linkFor(name, value, record)
  // Any of the four spellings a stack trace arrives under. Matching one name
  // meant an Elastic agent's error.stack_trace rendered as a wrapped paragraph
  // with its frames run together - the exact thing this view exists to fix.
  const isStack = conceptOf(name) === 'stacktrace' && !!value
  const gloss = isMsg ? null : durationGloss(name, value)
  const block = isStack || isMsg
  return (
    <div className={`log-detail-field${block ? ' is-block' : ''}`}>
      <span className="log-detail-key">{highlightTerms(name, hits)}</span>
      {isStack ? (
        <StackTrace text={String(value)} />
      ) : isMsg ? (
        <div className="log-detail-val is-msg mono">{highlightTerms(String(value ?? ''), hits)}</div>
      ) : (
        <span className={`log-detail-val mono${link ? ' is-link' : ''}`} data-log-field={name} data-log-value={value}>
          {highlightTerms(String(value ?? ''), hits)}
          {gloss && <span className="log-detail-gloss">{gloss}</span>}
          {link && <LinkMarker link={link} onOpen={onOpenLink} />}
        </span>
      )}
      <div className="log-field-actions">
        <button
          type="button"
          className="log-field-menu-btn"
          aria-label={`Actions for ${name}`}
          title={`Actions for ${name}`}
          onClick={(e) => { e.stopPropagation(); onMenu(name, value, e.currentTarget) }}
        >
          <svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="12" cy="5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="19" r="1.7"/></svg>
        </button>
        {pinnable && <PinButton name={name} pinned={pinned} onToggle={onTogglePin} />}
      </div>
    </div>
  )
}

// Pinning is what someone does when they are reading the same field across many
// records, so the button stays visible once set rather than hiding with the row.
function PinButton({ name, pinned, onToggle }) {
  return (
    <button
      type="button"
      className={`log-field-pin-btn${pinned ? ' is-pinned' : ''}`}
      aria-pressed={pinned}
      aria-label={pinned ? `Unpin ${name}` : `Pin ${name} to the top`}
      title={pinned ? `Unpin ${name}` : `Pin ${name} to the top`}
      onClick={(e) => { e.stopPropagation(); onToggle(name) }}
    >
      <svg viewBox="0 0 24 24" fill={pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 17v5"/><path d="M9 10.76V4h6v6.76l2 2.24v2H7v-2z"/>
      </svg>
    </button>
  )
}

// What the message row is called in the Overview. The record's own field is
// still _msg — that is what the JSON view shows and what a chip filters on —
// but "text" is what the column is called in the table this drawer opens from.
const MSG_LABEL = 'text'

// The message is fixed at the top like the identity cards, so it takes a copy
// button rather than the field menu, and cannot be pinned — it is already there.
//
// Clamping is done in CSS rather than by counting newlines, so a single long
// line that wraps past two rows collapses the same way a multi-line one does.
function MessageCard({ text, hits, onCopy }) {
  const [expanded, setExpanded] = useState(true)
  const [clamped, setClamped] = useState(false)
  const valRef = useRef(null)

  useEffect(() => { setExpanded(true) }, [text])

  // Measured by line count rather than by comparing scrollHeight to clientHeight:
  // the box is only shorter than its content while collapsed, so a height
  // comparison would report nothing to collapse whenever it is already open.
  // scrollHeight carries the full content in either state.
  useEffect(() => {
    const el = valRef.current
    if (!el) return
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 1
    setClamped(Math.round(el.scrollHeight / lineHeight) > 2)
  }, [text])

  return (
    <div className="log-detail-field is-block">
      <span className="log-detail-key">{highlightTerms(MSG_LABEL, hits)}</span>
      <div
        ref={valRef}
        className={`log-detail-val is-msg mono log-msg-text${expanded ? ' is-expanded' : ''}`}
      >{highlightTerms(String(text ?? ''), hits)}</div>
      <div className="log-field-actions">
        <button
          type="button"
          className="log-field-menu-btn"
          aria-label="Copy message"
          title="Copy message"
          onClick={(e) => { e.stopPropagation(); onCopy(String(text ?? ''), 'Message copied to clipboard') }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
        </button>
        {clamped && (
          <button
            type="button"
            className="log-msg-toggle"
            aria-expanded={expanded}
            onClick={() => setExpanded(v => !v)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d={expanded ? 'M18 15l-6-6-6 6' : 'M6 9l6 6 6-6'} />
            </svg>
            {expanded ? 'Show less' : 'Show more'}
          </button>
        )}
      </div>
    </div>
  )
}

// Collapsed height. Two frames is enough to see where the throw happened
// without a trace taking over the panel.
const COLLAPSED_FRAMES = 2

// Returns two grid children rather than one box: the exception message belongs
// on the label's line, where every other field puts its value, and only the
// frames need the full width beneath.
function StackTrace({ text }) {
  const [expanded, setExpanded] = useState(false)
  const [head, ...frames] = String(text).split('\n')
  const collapsible = frames.length > COLLAPSED_FRAMES
  const shown = expanded || !collapsible ? frames : frames.slice(0, COLLAPSED_FRAMES)
  const hidden = frames.length - shown.length

  return (
    <>
      <div className="log-stack-msg">{head}</div>
      {frames.length > 0 && (
        <div className="log-stack-frames">
          {/* The scroll lives on the inner list so the toggle stays put rather
              than scrolling away with the frames it controls. */}
          <div className={`log-stack-scroll${expanded ? ' is-expanded' : ''}`}>
            {shown.map((line, i) => <div className="log-stack-frame" key={i}>{line}</div>)}
          </div>
          {collapsible && (
            <button
              type="button"
              className="log-stack-toggle"
              aria-expanded={expanded}
              onClick={() => setExpanded(v => !v)}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d={expanded ? 'M18 15l-6-6-6 6' : 'M6 9l6 6 6-6'} />
              </svg>
              {expanded ? 'Show less' : `${hidden} more frame${hidden === 1 ? '' : 's'}`}
            </button>
          )}
        </div>
      )}
    </>
  )
}

// How old the record is, in days, read the way people say it. Compared by
// calendar day rather than elapsed hours: a log from 23:55 seen at 00:05 is
// "yesterday", not "today", even though only ten minutes have passed.
function relativeDayLabel(date, now = new Date()) {
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86400000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  return `${days} days ago`
}

// The record as one object — what the JSON view renders and Copy JSON writes.
// Mirrors what the Fields view lists: timestamp and message alongside the tags.
//
// Undefined values are normalised to empty strings. A tag can be undefined when
// the source has no value for it, and JSON.stringify drops those keys entirely —
// so without this, Copy JSON would quietly hand over a record missing fields the
// Fields view had just listed.
function toRecord(log) {
  const out = {
    _time: `${log.dateStr}T${log.timeStr}Z`,
    _msg: log.message,
  }
  for (const [k, v] of Object.entries(log.tags)) out[k] = v ?? ''
  return out
}

// One JSON line. Recurses on objects so a nested payload renders correctly if
// the data ever grows one — today every record is flat.
// Flattens the record into the lines a JSON document would have, so each one
// can carry a number. Recursing here rather than in the renderer keeps line
// numbering a simple index — a nested object spans several lines, and a
// component that returns a fragment cannot number its own output.
function jsonLines(data) {
  const out = [{ kind: 'open', depth: 0 }]
  const walk = (obj, depth, prefix) => {
    const entries = Object.entries(obj)
    entries.forEach(([name, value], i) => {
      const path = prefix ? `${prefix}.${name}` : name
      const comma = i < entries.length - 1
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        out.push({ kind: 'open', depth, name, path, value })
        walk(value, depth + 1, path)
        out.push({ kind: 'close', depth, comma })
      } else {
        out.push({ kind: 'pair', depth, name, path, value, comma })
      }
    })
  }
  walk(data, 1, '')
  out.push({ kind: 'close', depth: 0 })
  return out
}

function JsonLine({ line, number, record, onKeyMenu, onOpenLink }) {
  const { kind, depth, name, path, value, comma } = line
  const keyBtn = name != null && (
    <button
      type="button"
      className="log-json-key"
      onClick={(e) => { e.stopPropagation(); onKeyMenu(path, value, e.currentTarget) }}
      title={`Actions for ${path}`}
    >"{name}"</button>
  )
  const isNum = typeof value === 'number'
  const link = kind === 'pair' ? linkFor(name, value, record) : null

  return (
    <div className="log-json-line">
      <span className="log-json-ln" aria-hidden="true">{number}</span>
      {/* Indented in `ch` so the step lands on the monospace grid, the way an
          editor would show it, rather than on an arbitrary pixel value. */}
      <span className="log-json-code" style={{ paddingLeft: `${depth * 2}ch` }}>
        {kind === 'open' && (
          name == null
            ? <span className="log-json-punc">{'{'}</span>
            : <>{keyBtn}<span className="log-json-punc">: {'{'}</span></>
        )}
        {kind === 'close' && <span className="log-json-punc">{'}'}{comma ? ',' : ''}</span>}
        {kind === 'pair' && (
          <>
            {keyBtn}
            <span className="log-json-punc">: </span>
            <span className={`log-json-val${isNum ? ' num' : ''}`}>
              {isNum ? String(value) : JSON.stringify(value ?? '')}
            </span>
            <span className="log-json-punc">{comma ? ',' : ''}</span>
            {link && <LinkMarker link={link} onOpen={onOpenLink} />}
          </>
        )}
      </span>
    </div>
  )
}

// Every action here already existed somewhere — Include/Exclude in the
// text-selection menu, columns in the Fields dropdown, grouping in the pipe
// toolbar. What was missing was reaching any of them from the field you are
// looking at, instead of memorising its name and retyping it in the bar.
export function LogRecordDrawer({
  record, onClose, searchTerms,
  onAddChip, onDistribution, onCopy,
  index = 0, total = 0, onNavigate,
  pinned = [], onTogglePin, onOpenLink,
  initialView = 'fields',
  badge,
}) {
  const [view, setView] = useState(initialView)
  const [menu, setMenu] = useState(null)   // { field, value, x, y }
  const [fieldQuery, setFieldQuery] = useState('')
  // Navigation runs on time, not position: logs are ordered newest-first and
  // paginated, so a total is only ever "what has loaded" and an ordinal would
  // describe that window rather than the result set. Newest is always knowable —
  // it is the top of the list — while oldest is not, so the jump anchor has no
  // counterpart.
  //
  // Once the backend paginates, Older at the loaded edge should fetch the next
  // page rather than disable; the in-flight and stale states for that already
  // exist on the query path.
  const hasNewer = index > 0
  const hasOlder = index >= 0 && index < total - 1

  // Matches a field on either half of the pair. Someone looking for "payment"
  // is as likely to be hunting the value as the field holding it, and which one
  // it turns out to be is exactly what they are trying to find out.
  const q = fieldQuery.trim().toLowerCase()
  const hits = q ? [fieldQuery.trim()] : []
  const matches = (k, v) =>
    !q || k.toLowerCase().includes(q) || String(v ?? '').toLowerCase().includes(q)

  const groups = useMemo(() => recordFieldGroups(record)
    .map(g => ({ ...g, fields: g.fields.filter(([k, v]) => !pinned.includes(k) && matches(k, v)) }))
    .filter(g => g.fields.length > 0),
  [record, q, pinned])   // eslint-disable-line react-hooks/exhaustive-deps

  const shape = recordType(record)
  const title = recordTitle(record)

  const valueOf = (k) => (k === '_msg' ? record.message : record.tags[k])
  // The stack trace and its exception type are the two fields that cannot be
  // pinned: one is a block, and neither exists on most records, so pinning them
  // would leave a gap at the top of every non-error log.
  // Every list field can be pinned. The message cannot: it already has a fixed
  // place of its own above, so pinning it would only move it a few pixels.
  const canPin = (k) => k !== '_msg'

  // Pin order is insertion order, so the newest pin lands at the bottom of the
  // block and the ones above it never move.
  // isHiddenField applies here too: a pinned stack trace is still absent from a
  // record that did not throw, and should leave no empty row behind when it is.
  // The pin itself survives — it reappears on the next error record.
  const pinnedRows = pinned
    .filter(k => canPin(k) && k in record.tags
      && !isHiddenField(k, valueOf(k)) && matches(k, valueOf(k)))
    .map(k => [k, valueOf(k)])

  // Which fields lead depends on the shape of the record, and each is resolved
  // through the alias table, so a New Relic service.name occupies the same card
  // an OTel service would.
  const highlights = highlightFields(record).filter(([k, v]) => matches(k, v))

  const msgMatches = !!title.detail && (matches(MSG_LABEL, title.detail) || matches('_msg', title.detail))
  const matchCount = groups.reduce((n, g) => n + g.fields.length, 0)
    + pinnedRows.length + highlights.length + (msgMatches ? 1 : 0)

  const json = useMemo(() => toRecord(record), [record])

  // A menu belongs to the row it was opened from; switching record or view
  // leaves it pointing at something no longer on screen.
  useEffect(() => { setMenu(null) }, [record, view])

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close() } }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', close, true)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', close, true)
    }
  }, [menu])

  const openMenu = (field, value, anchor) => {
    const r = anchor.getBoundingClientRect()
    setMenu({ field, value: value == null ? '' : String(value), x: r.right, y: r.bottom + 4 })
  }

  const run = (fn) => { fn(); setMenu(null) }

  return (
    <aside className="log-detail">
      <div className="log-detail-head">
        <div className="log-detail-heading">
          <div className="log-detail-title-row">
            {/* A log record's severity IS its level. A span's is its
                status_code, and calling an ordinary span "Info" would state a
                severity the span never claimed — so the caller can name the
                badge, and only falls back to the level when it does not. */}
            <StatusBadge
              status={badge?.status ?? statusForLogLevel(record.level)}
              label={badge?.label ?? (record.level.charAt(0).toUpperCase() + record.level.slice(1))}
            />
            {/* A Kubernetes event stores the literal "UNSET" where a message
                would go, so the shape and the built title are the only things
                that say what you are looking at. */}
            <span className="log-detail-shape">{TYPE_LABELS[shape]}</span>
            {title.title && <span className="log-detail-built-title">{title.title}</span>}
          </div>
          <div className="log-detail-sub mono">
            {record.dateStr}T{record.timeStr}Z
            <span className="log-detail-age">({relativeDayLabel(record.time)})</span>
          </div>
        </div>
        <div className="log-detail-head-right">
          {total > 1 && (
            <nav className="log-detail-nav" aria-label="Record navigation">
              <button
                className="icon-only"
                onClick={() => onNavigate(0)}
                disabled={!hasNewer}
                title="Jump to newest record"
                aria-label="Jump to newest record"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 4h14"/><path d="M12 21V9"/><path d="M6 15l6-6 6 6"/></svg>
              </button>
              <button onClick={() => onNavigate(index - 1)} disabled={!hasNewer} title="Newer record">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
                Newer
              </button>
              <button onClick={() => onNavigate(index + 1)} disabled={!hasOlder} title="Older record">
                Older
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6"/></svg>
              </button>
            </nav>
          )}
          <button className="log-detail-close" onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </div>
      </div>

      <div className="log-detail-tabs" role="tablist">
        <button role="tab" aria-selected={view === 'fields'}
          className={`log-detail-tab${view === 'fields' ? ' active' : ''}`}
          onClick={() => setView('fields')}>Overview</button>
        <button role="tab" aria-selected={view === 'json'}
          className={`log-detail-tab${view === 'json' ? ' active' : ''}`}
          onClick={() => setView('json')}>JSON</button>
        {view === 'json' && (
          <button className="log-detail-copyjson"
            onClick={() => onCopy(JSON.stringify(json, null, 2), 'Record copied to clipboard as JSON')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
            Copy JSON
          </button>
        )}
      </div>

        {view === 'fields' && highlights.length > 0 && (
          <div
            className="log-detail-highlights"
            style={{ gridTemplateColumns: `repeat(${highlights.length}, minmax(0, 1fr))` }}
          >
            {highlights.map(([k, v]) => {
              const link = linkFor(k, v, record)
              return (
                <div className="log-hl-card" key={k}>
                  <div className="log-hl-head">
                    <span className="log-hl-key">{highlightTerms(k, hits)}</span>
                    <button
                        type="button"
                        className="log-field-menu-btn"
                        aria-label={`Actions for ${k}`}
                        title={`Actions for ${k}`}
                        onClick={(e) => { e.stopPropagation(); openMenu(k, v, e.currentTarget) }}
                      >
                        <svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="12" cy="5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="19" r="1.7"/></svg>
                      </button>
                  </div>
                  <div className="log-hl-value-row">
                    {v == null || v === '' ? (
                      <span className="log-hl-value is-empty" aria-label="No value">—</span>
                    ) : (
                      <>
                        <span
                          className={`log-hl-value mono${link ? ' is-link' : ''}`}
                          title={String(v)}
                          data-log-field={k}
                          data-log-value={v}
                        >{highlightTerms(String(v), hits)}</span>
                        {durationGloss(k, v) && (
                          <span className="log-detail-gloss">{durationGloss(k, v)}</span>
                        )}
                        {link && <LinkMarker link={link} onOpen={onOpenLink} />}
                      </>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}

      {/* Overview only. Filtering the JSON view would hand back something that
          reads as the record but no longer parses as one. */}
      {view === 'fields' && (
        <div className="log-detail-search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
          <input
            value={fieldQuery}
            onChange={(e) => setFieldQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape' && fieldQuery) { e.stopPropagation(); setFieldQuery('') } }}
            placeholder="Search fields and values…"
            spellCheck={false}
            autoComplete="off"
            aria-label="Search fields and values"
          />
          {fieldQuery && (
            <button type="button" onClick={() => setFieldQuery('')} aria-label="Clear search" title="Clear search">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
            </button>
          )}
        </div>
      )}

      {view === 'fields' ? (
        <div className="log-detail-body" data-log-content>
          {matchCount === 0 && (
            <div className="log-detail-nomatch">
              No field or value matches <span className="mono">{fieldQuery.trim()}</span>
            </div>
          )}
          {msgMatches && (
            <div className="log-detail-group is-msg-card">
              <MessageCard
                text={title.detail}
                hits={q ? hits : searchTerms}
                onCopy={onCopy}
              />
            </div>
          )}

          {pinnedRows.length > 0 && (
            <div className="log-detail-pinned">
              {pinnedRows.map(([k, v]) => (
                <FieldRow
                  key={k} name={k} value={v} hits={hits} record={record}
                  isMsg={k === '_msg'}
                  pinned pinnable
                  onTogglePin={onTogglePin} onMenu={openMenu} onOpenLink={onOpenLink}
                />
              ))}
            </div>
          )}
          {groups.map((group, gi) => (
            group.noise
              ? <NoiseGroup key={gi} fields={group.fields} hits={hits} record={record}
                  canPin={canPin} onTogglePin={onTogglePin} onMenu={openMenu} onOpenLink={onOpenLink} />
              : (
                <div className="log-detail-group" key={gi}>
                  {group.fields.map(([k, v]) => (
                    <FieldRow
                      key={k} name={k} value={v} hits={hits} record={record}
                      pinned={false} pinnable={canPin(k)}
                      onTogglePin={onTogglePin} onMenu={openMenu} onOpenLink={onOpenLink}
                    />
                  ))}
                </div>
              )
          ))}
        </div>
      ) : (
        <div className="log-detail-body log-json-body">
          <div className="log-json">
            {jsonLines(json).map((line, i) => (
              <JsonLine key={i} line={line} number={i + 1} record={record} onKeyMenu={openMenu} onOpenLink={onOpenLink} />
            ))}
          </div>
        </div>
      )}

      {menu && (() => {
        const isMsg = menu.field === '_msg' || menu.field === '_time'
        const hasValue = menu.value !== ''
        const width = 208
        const left = Math.max(8, Math.min(menu.x - width, window.innerWidth - width - 8))
        const top = Math.min(menu.y, window.innerHeight - 300)
        return (
          <div className="log-sel-menu log-field-menu" style={{ left, top, width }}
            onMouseDown={(e) => e.stopPropagation()}>
            {/* Names the destination in words, so the marker beside the value
                does not have to be decoded from an arrow alone. Rendered as a
                div rather than a button: nothing happens on press yet, and it
                should not take focus pretending otherwise. */}
            {(() => {
              const link = linkFor(menu.field, menu.value, record)
              if (!link) return null
              // A filter link is something we can actually do today, so it is a
              // button. An open link is not wired to a destination yet, and a
              // control that swallows the press teaches people it is broken.
              return (
                <>
                  {link.kind === 'filter' ? (
                    <button className="log-sel-item" title={link.hint}
                      onClick={() => run(() => onAddChip({ field: link.field, op: 'eq', value: link.value }))}>
                      <FilterIcon size={14} strokeWidth={2} />
                      {link.label}
                    </button>
                  ) : onOpenLink ? (
                    <button className="log-sel-item" title={link.hint}
                      onClick={() => run(() => onOpenLink(link))}>
                      <ArrowUpRight size={14} strokeWidth={2} />
                      {link.label}
                    </button>
                  ) : (
                    <div className="log-sel-item is-pending" aria-disabled="true" title={link.hint}>
                      <ArrowUpRight size={14} strokeWidth={2} />
                      {link.label}
                    </div>
                  )}
                  <div className="log-sel-sep" />
                </>
              )
            })()}
            {/* Include/Exclude are offered on tags only. Filtering on a whole
                message body would pin the query to one record — the useful
                message filter is a phrase, which the text-selection menu
                already handles by letting the user pick one. */}
            {!isMsg && hasValue && (
              <>
                <button className="log-sel-item" onClick={() => run(() => onAddChip({ field: menu.field, op: 'eq', value: menu.value }))}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                  Include
                </button>
                <button className="log-sel-item" onClick={() => run(() => onAddChip({ field: menu.field, op: 'neq', value: menu.value }))}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>
                  Exclude
                </button>
              </>
            )}
            {!isMsg && (
              <button className="log-sel-item" onClick={() => run(() => onAddChip({ field: menu.field, op: 'exists' }))}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                Exists
              </button>
            )}
            {isMsg && (
              <div className="log-sel-note">Select any phrase in the value to filter on it.</div>
            )}
            {!isMsg && (
              <>
                <div className="log-sel-sep" />
                <button className="log-sel-item" onClick={() => run(() => onDistribution(menu.field, menu.x, menu.y))}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="12" width="4" height="9"/><rect x="10" y="7" width="4" height="14"/><rect x="17" y="3" width="4" height="18"/></svg>
                  View distribution
                </button>
              </>
            )}
            {hasValue && (
              <>
                <div className="log-sel-sep" />
                <button className="log-sel-item" onClick={() => run(() => onCopy(menu.value, 'Value copied to clipboard'))}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
                  Copy value
                </button>
              </>
            )}
          </div>
        )
      })()}
    </aside>
  )
}
