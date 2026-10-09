import { useMemo, useState } from 'react'
import ErrorGroupsPanel from '@/components/errors/ErrorGroupsPanel'
import BrowserExceptionModal from '@/components/browser/BrowserExceptionModal'
import BreakAtSlashes from '@/components/browser/BreakAtSlashes'
import { browserErrorGroupsForWindow, browserGroupSampleTrace } from '@/data/browser'
import { previousPeriodText, httpCodeClass, httpReason } from '@/utils/errorsPage'
import { BROWSER_KINDS } from '@/utils/browserUrl'
// For .errp-codes / .errp-code-item, the Errors page's status-chip cell that
// the Ajax side borrows. ErrorGroupsPanel loads the file too; said here as
// well because this module names its classes itself.
import '@/components/errors/errors.css'
import './browser-traces.css'

// The toggle is production's two kinds, under its own words (Script | Ajax).
// The ids are the URL's `kind` (server | client), which is also the span kind
// each is recorded as: a script error on the page-load span, an Ajax error on
// the call's.
const SIDES = BROWSER_KINDS

// Production shows ten and offers the rest, and so does this: a storefront
// throws on every route it has, and forty-two rows bury the page's own fold.
const LIMIT = 10

// Each row's chart, lower than APM's 132px so ten rows fit a screen; the
// .err-spark height in browser-traces.css says the same.
const SPARK_HEIGHT = 88

// An endpoint with a line-break opportunity after every '/': a URL holds none
// of its own, so a long Ajax call would otherwise be cut mid-segment ('v' /
// '1/payments') where the column ends.
const renderWhere = g => <BreakAtSlashes text={whereOf(g)} />

// A Script group is filed under the page route it was thrown on, an Ajax one
// under the call that failed (`GET host:443/path`); the data gives both as
// `endpoint`, and `spanName` is the same call for Ajax. A row hands this to
// the Traces tab as its Endpoint filter, so it must be spelled exactly as that
// filter's options are.
const whereOf = g => g.endpoint || g.spanName

// An Ajax error is a status code, not a thrown class: the code as the trace
// waterfall and the Errors page chip it (4xx amber, 5xx red, through the
// status tokens on .tw-code), then its reason phrase in the place a script
// error's message goes. Nothing opens from it — there is no stack behind a
// 404 — so the whole row is the one way on, to the calls themselves.
function AjaxError({ group }) {
  const code = group.exception
  const reason = httpReason(code) || group.message
  return (
    <span className="errp-codes" title={reason ? `HTTP ${code} ${reason}` : `HTTP ${code}`}>
      <span className="errp-code-item">
        <span className={`tw-code ${httpCodeClass(code)}`}>{code}</span>
        {reason && <span className="errp-code-reason">{reason}</span>}
      </span>
    </span>
  )
}

/**
 * The Browser page's Errors tab: the APM service page's Errors tab body
 * (ErrorGroupsPanel), filled with what the app's own JavaScript reported.
 *
 *   Script  page route | JS exception class + message | count + delta | spark
 *   Ajax    call       | status chip + reason          | count + delta | spark
 *
 * A row is production's ↗: it opens the Traces tab filtered to that kind,
 * endpoint and error, so the list there is that row's occurrences (pushed, so
 * Back returns here). The exception class on a Script row is a second, nearer
 * way in: the stack trace of the group's newest occurrence, in the modal the
 * Traces tab opens for the same trace. There is no "Open in Errors" as the APM
 * tab has — the Errors page lists backend groups only, and a browser error
 * sent there would land on an empty page.
 *
 * `kind` and `onKind` are the page URL's, so the toggle, a pasted link and
 * Back all agree on which list this is.
 */
export default function BrowserErrorsTab({
  app, win, timeRange, syncId, onFocus, kind, onKind, onOpenTraces, sourceMaps, onOpenSourceMaps,
}) {
  // `kind` is already one of the two (parseBrowserSearch sees to it).
  const side = kind
  const isScript = side === 'server'
  const groups = useMemo(() => browserErrorGroupsForWindow(win, app.id, side), [win, app.id, side])
  // What each count's chip compares against, worded from the picked range
  // ("the previous hour"), as on the APM tab (rule 6).
  const prevText = previousPeriodText(timeRange)

  // The trace whose exception the modal shows. A trace id rather than the
  // group: the modal reads everything off the id, and a refresh that rebuilds
  // the groups does not swap the stack being read for a newer one.
  const [sampleId, setSampleId] = useState(null)
  const openException = g => {
    const id = browserGroupSampleTrace(win, app.id, g)
    if (id) setSampleId(id)
  }

  const openRow = g => onOpenTraces?.({ kind: side, endpoint: whereOf(g), error: g.exception })

  return (
    <>
      {/* The wrapper scopes browser-traces.css's changes to the panel: a
          wider Endpoint column that wraps at its '/'s, and a lower chart. */}
      <div className="brw-errors">
        <ErrorGroupsPanel
          sides={SIDES}
          side={side}
          onSide={onKind}
          groups={groups}
          whereOf={whereOf}
          renderWhere={renderWhere}
          sparkHeight={SPARK_HEIGHT}
          renderError={isScript ? undefined : g => <AjaxError group={g} />}
          onOpenRow={openRow}
          onOpenException={isScript ? openException : undefined}
          prevText={prevText}
          win={win}
          onFocus={onFocus}
          syncId={syncId}
          // Production marks each row's way on with a ↗; here the whole row is
          // it (a 4-cell grid, as on APM, with the 3px brand bar on hover). The
          // caption says so once, in the head, the way Infra's tables say
          // "click a row to drill in".
          headRight={<span className="hint">Click a row to see its traces</span>}
          searchPlaceholder={isScript ? 'Search pages or errors…' : 'Search endpoints or status codes…'}
          limit={LIMIT}
        />
      </div>
      {/* At the tab's root, not in a row: the modal is not portalled, and a
          click inside it must not bubble to a row's open-traces handler. */}
      {sampleId && (
        <BrowserExceptionModal
          traceId={sampleId}
          sourceMaps={sourceMaps}
          onClose={() => setSampleId(null)}
          onOpenSourceMaps={onOpenSourceMaps}
        />
      )}
    </>
  )
}
