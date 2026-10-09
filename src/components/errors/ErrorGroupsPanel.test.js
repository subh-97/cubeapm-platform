// The error-groups panel: the APM service page's Errors tab with its data and
// destinations handed in, so the Browser page's Errors tab can be the same
// panel.
//
// The original tab is kept below as a fixture, copied exactly as it stood in
// ServiceOverview.jsx, beside the thin wrapper the service page switches to.
// Their renders are compared character for character over real groups — both
// sides, two ranges, and the empty state — so the switch moves nothing. The
// differences allowed are what the extraction added on purpose, none of which
// draws anything: the side toggle's role, focus and pressed state; each row's
// way in for the keyboard moved from the row (a role=button around another
// button) to a button on its Endpoint text; and the message's title. The new
// options are then checked for what they add.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server.browser'
import { useState, useMemo } from 'react'
import { ArrowUpRight } from 'lucide-react'
import { REFERENCE_WINDOW, resolveWindow } from '@/data/timeWindow'
import { errorGroupsForWindow, tracesFiltersFor } from '@/data/errors'
import { previousPeriodText, deltaChip } from '@/utils/errorsPage'
import ErrorSpark from '@/components/errors/ErrorSpark'
import ErrorGroupsPanel from './ErrorGroupsPanel.jsx'

const noop = () => {}
const html = el => renderToStaticMarkup(el)

/* ── Fixtures: the originals, verbatim (ServiceOverview.jsx) ── */

function SearchGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" />
    </svg>
  )
}

const CLIENT_ERRORS_BY = ['side', 'service', 'spanName', 'exception']

function ErrorsTab({ win, timeRange, serviceId, onFocus, syncId, onOpenLink, side: sideProp, onSide }) {
  const [ownSide, setOwnSide] = useState('server')
  const side = sideProp ?? ownSide
  const setSide = onSide ?? setOwnSide
  // What each count's chip compares against, worded from the picked range
  // ("the previous hour") as the Errors page words it (rule 6).
  const prevText = previousPeriodText(timeRange)
  const [q, setQ] = useState('')
  const groups = useMemo(
    () => errorGroupsForWindow(win, { side, service: serviceId, by: side === 'client' ? CLIENT_ERRORS_BY : undefined }),
    [win, side, serviceId],
  )
  // What the Endpoint column names: the route on Server, the call on Client.
  const where = e => (side === 'client' ? e.spanName : e.endpoint)
  const filtered = q
    ? groups.filter(e => (where(e) + ' ' + e.exception + ' ' + e.message).toLowerCase().includes(q.toLowerCase()))
    : groups
  // A row click lands on the Traces page filtered to exactly the spans the row
  // counts: this service, this side, failed, this span, this exception. The
  // Traces stream carries a span for every error group, so it is never empty.
  const openRow = (e) => onOpenLink?.({ view: 'traces', filters: tracesFiltersFor(e) })
  // The exception goes one step further than the row: to the Errors page,
  // filtered to this group, with its details drawer open — the stack trace,
  // the sample occurrences and their traces are there.
  const openDetails = (e) => onOpenLink?.({
    view: 'errors', service: serviceId, kind: side, exception: e.exception,
    ...(side === 'client' ? { spanName: e.spanName } : { endpoint: e.endpoint }),
    open: true,
  })
  return (
    <div className="panel">
      <div className="panel-head">
        <div className="panel-head-left">
          <div className="seg-toggle">
            <div className={`seg${side === 'server' ? ' active' : ''}`} onClick={() => setSide('server')}>Server</div>
            <div className={`seg${side === 'client' ? ' active' : ''}`} onClick={() => setSide('client')}>Client</div>
          </div>
        </div>
        <div className="panel-head-right">
          <button
            type="button"
            className="hbtn small"
            title={`Open ${serviceId}'s ${side} errors on the Errors page`}
            onClick={() => onOpenLink?.({ view: 'errors', service: serviceId, kind: side })}
          >
            Open in Errors
            <ArrowUpRight size={12} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className="split-endpoints-search" style={{ borderTop: '1px solid var(--border-subtle)' }}>
        <div className="search-with-icon">
          <SearchGlyph />
          <input placeholder="Search endpoints or exceptions…" aria-label="Search endpoints or exceptions" value={q} onChange={e => setQ(e.target.value)} />
        </div>
      </div>
      <div className="err-head">
        <span>Endpoint</span><span>Error</span><span>Count</span><span />
      </div>
      {filtered.map(e => {
        const delta = deltaChip(e.count, e.prevCount, prevText)
        return (
          <div
            key={e.id}
            className="err-row is-clickable"
            role="button"
            tabIndex={0}
            onClick={() => openRow(e)}
            onKeyDown={ev => {
              // Keys pressed on the exception button are that button's own.
              if (ev.target !== ev.currentTarget) return
              if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openRow(e) }
            }}
          >
            <div className="err-endpoint" title={where(e)}>{where(e)}</div>
            <div className="err-exc">
              {/* The row goes to Traces; the exception goes to its details and
                  stack trace. Two destinations in one row, so this one is its
                  own control. */}
              <button
                type="button"
                className="err-exc-cls"
                onClick={ev => { ev.stopPropagation(); openDetails(e) }}
                title={`Show the details and stack trace for ${e.exception}`}
              >
                {e.exception}
              </button>
              <span className="err-exc-msg">{e.message}</span>
            </div>
            {/* The chip sits under the number, as on the Errors page, so the
                count keeps its size in the narrow column. Stacked flush right,
                anything wider than the column (a 7d "12,239") spills left into
                the gap rather than right into the spark (errors.css). */}
            <div className="err-count">
              <span>{e.count.toLocaleString()}</span>
              <span className="errp-delta" data-dir={delta.dir} title={delta.title}>{delta.label}</span>
            </div>
            <div className="err-spark" onClick={ev => ev.stopPropagation()}>
              <ErrorSpark series={e.series} win={win} onFocus={onFocus} syncId={syncId} />
            </div>
          </div>
        )
      })}
      {filtered.length === 0 && (
        <div className="err-empty">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="10"/></svg>
          <div>{groups.length === 0 ? `No ${side} errors in ${win.label}` : `No errors match "${q}"`}</div>
        </div>
      )}
    </div>
  )
}

/* ── What the service page switches to ── */

// The tab keeps its state, its data and its destinations; the panel draws.
function ErrorsTabOnPanel({ win, timeRange, serviceId, onFocus, syncId, onOpenLink, side: sideProp, onSide }) {
  const [ownSide, setOwnSide] = useState('server')
  const side = sideProp ?? ownSide
  const setSide = onSide ?? setOwnSide
  const groups = useMemo(
    () => errorGroupsForWindow(win, { side, service: serviceId, by: side === 'client' ? CLIENT_ERRORS_BY : undefined }),
    [win, side, serviceId],
  )
  return (
    <ErrorGroupsPanel
      side={side}
      onSide={setSide}
      groups={groups}
      prevText={previousPeriodText(timeRange)}
      win={win}
      onFocus={onFocus}
      syncId={syncId}
      onOpenRow={e => onOpenLink?.({ view: 'traces', filters: tracesFiltersFor(e) })}
      onOpenException={e => onOpenLink?.({
        view: 'errors', service: serviceId, kind: side, exception: e.exception,
        ...(side === 'client' ? { spanName: e.spanName } : { endpoint: e.endpoint }),
        open: true,
      })}
      headRight={(
        <button
          type="button"
          className="hbtn small"
          title={`Open ${serviceId}'s ${side} errors on the Errors page`}
          onClick={() => onOpenLink?.({ view: 'errors', service: serviceId, kind: side })}
        >
          Open in Errors
          <ArrowUpRight size={12} strokeWidth={2} aria-hidden="true" />
        </button>
      )}
    />
  )
}

// The extraction's deliberate changes to the markup, undone so the rest can be
// compared: the side toggle can be reached and pressed from the keyboard, and
// a row is opened by the button on its Endpoint text instead of being a
// role=button itself.
const withoutSegA11y = h => h
  .replace(/(<div class="seg(?: active)?") role="button" tabindex="0" aria-pressed="(?:true|false)"/g, '$1')
  .replace(/<button type="button" class="err-open" aria-label="[^"]*">(.*?)<\/button>/g, '$1')
  .replace(/(<span class="err-exc-msg") title="[^"]*"/g, '$1')
const withoutRowButton = h => h.replace(/(<div class="err-row is-clickable") role="button" tabindex="0"/g, '$1')
const rowCount = h => (h.match(/class="err-row is-clickable"/g) ?? []).length

const RANGES = {
  '1h': { win: REFERENCE_WINDOW, timeRange: { kind: 'preset', value: '1h' } },
  '7d': { win: resolveWindow({ kind: 'preset', value: '7d' }), timeRange: { kind: 'preset', value: '7d' } },
}

test('on the service page the panel draws exactly what the Errors tab drew, both sides, any range', () => {
  let rows = 0
  for (const [label, { win, timeRange }] of Object.entries(RANGES)) {
    for (const serviceId of ['payment-service', 'order-service']) {
      for (const side of ['server', 'client']) {
        const props = { win, timeRange, serviceId, side, onSide: noop, onFocus: noop, syncId: 'svc-errors', onOpenLink: noop }
        const before = html(<ErrorsTab {...props} />)
        const after = html(<ErrorsTabOnPanel {...props} />)
        assert.equal(withoutSegA11y(after), withoutRowButton(before), `${label} ${serviceId} ${side}`)
        rows += rowCount(before)
      }
    }
  }
  assert.ok(rows > 10, 'compared real rows, not only empty states')
})

test('a service with no errors gets the same empty state as before', () => {
  const { win, timeRange } = RANGES['1h']
  for (const side of ['server', 'client']) {
    const props = { win, timeRange, serviceId: 'no-such-service', side, onSide: noop, onFocus: noop, syncId: 's', onOpenLink: noop }
    const h = html(<ErrorsTabOnPanel {...props} />)
    assert.equal(withoutSegA11y(h), withoutRowButton(html(<ErrorsTab {...props} />)))
    assert.match(h, new RegExp(`No ${side} errors in ${win.label}`))
  }
})

test('the side toggle is reachable from the keyboard and says which side is on', () => {
  const h = html(<ErrorGroupsPanel groups={[]} side="client" onSide={noop} win={REFERENCE_WINDOW} />)
  assert.match(h, /<div class="seg" role="button" tabindex="0" aria-pressed="false">Server<\/div>/)
  assert.match(h, /<div class="seg active" role="button" tabindex="0" aria-pressed="true">Client<\/div>/)
})

/* ── What the Browser page asks of it ── */

const { win: WIN } = RANGES['1h']
const GROUPS = errorGroupsForWindow(WIN, { side: 'server' })
const BROWSER_SIDES = [{ id: 'server', label: 'Script' }, { id: 'client', label: 'Ajax' }]

test('the empty state names the side by its label, not its id', () => {
  const h = html(<ErrorGroupsPanel sides={BROWSER_SIDES} side="server" groups={[]} win={WIN} />)
  assert.match(h, new RegExp(`No script errors in ${WIN.label}`))
  assert.match(h, />Script<\/div>.*>Ajax<\/div>/)
})

test('a limit shows the first groups and says how many there are, in the series budget\'s footer', () => {
  assert.ok(GROUPS.length > 4, 'enough groups to cap')
  const h = html(<ErrorGroupsPanel side="server" groups={GROUPS} win={WIN} limit={3} noun="errors" />)
  assert.equal(rowCount(h), 3)
  assert.match(h, /<div class="errg-foot"><div class="series-budget">/)
  assert.match(h, new RegExp(`Showing 3 of ${GROUPS.length} errors`))
  assert.match(h, /<button type="button" class="series-budget-btn">Show all<\/button>/)
  // Within the limit there is nothing to say.
  const all = html(<ErrorGroupsPanel side="server" groups={GROUPS} win={WIN} limit={GROUPS.length} />)
  assert.equal(rowCount(all), GROUPS.length)
  assert.doesNotMatch(all, /series-budget/)
})

test('the Endpoint and Error cells are the caller\'s to word', () => {
  const g = GROUPS[0]
  const h = html(
    <ErrorGroupsPanel
      side="client"
      groups={[g]}
      win={WIN}
      whereOf={e => `GET shop.cubedemo.com:443${e.endpoint}`}
      renderError={e => <span className="probe-error">{e.exception.length}</span>}
    />,
  )
  assert.match(h, new RegExp(`<div class="err-endpoint" title="GET shop\\.cubedemo\\.com:443${g.endpoint.replace(/[/.]/g, '\\$&')}">`))
  assert.match(h, new RegExp(`<div class="err-exc"><span class="probe-error">${g.exception.length}</span></div>`))
})

test('without an exception destination the class is text, not a button that does nothing', () => {
  const h = html(<ErrorGroupsPanel side="server" groups={GROUPS.slice(0, 1)} win={WIN} />)
  assert.match(h, /<span class="err-exc-cls is-static">/)
  assert.doesNotMatch(h, /<button type="button" class="err-exc-cls"/)
  // Nor an empty head-right box when nothing goes there.
  assert.doesNotMatch(h, /panel-head-right/)
})

test('a search box worded for the page keeps its label free of the ellipsis', () => {
  const h = html(<ErrorGroupsPanel side="server" groups={[]} win={WIN} searchPlaceholder="Search pages or errors…" />)
  assert.match(h, /placeholder="Search pages or errors…" aria-label="Search pages or errors"/)
})

test('a row is opened by a named button on its Endpoint, not by a row-sized button around the exception\'s', () => {
  const g = GROUPS[0]
  const h = html(<ErrorGroupsPanel side="server" groups={[g]} win={WIN} onOpenRow={noop} onOpenException={noop} />)
  assert.doesNotMatch(h, /class="err-row[^"]*" role="button"/, 'the row itself is not a button')
  const name = `See traces for ${g.endpoint}, ${g.exception}`.replace(/'/g, '&#x27;')
  assert.ok(h.includes(`<button type="button" class="err-open" aria-label="${name}">${g.endpoint}</button>`), h)
  // The exception keeps its own button, now a sibling of the row's.
  assert.match(h, /<button type="button" class="err-exc-cls"/)
  // The message, cut to its column, is whole in its title.
  assert.ok(h.includes(`title="${g.message.replace(/'/g, '&#x27;').replace(/"/g, '&quot;')}"`))
})

test('the Endpoint can be drawn as more than its text, and the spark at another height', () => {
  const g = GROUPS[0]
  const h = html(
    <ErrorGroupsPanel side="server" groups={[g]} win={WIN} renderWhere={e => <span className="probe-where">{e.endpoint.length}</span>} />,
  )
  assert.match(h, new RegExp(`class="err-open"[^>]*><span class="probe-where">${g.endpoint.length}</span></button>`))
  // The title keeps the text, whatever is drawn.
  assert.ok(h.includes(`<div class="err-endpoint" title="${g.endpoint}">`))
})
