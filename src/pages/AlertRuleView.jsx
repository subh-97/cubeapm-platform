import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { ArrowLeft, ChartLine, FileCode, History, Layers } from 'lucide-react'
import PageBar from '@/components/layout/PageBar'
import ViewTabs from '@/components/shared/ViewTabs'
import { viewTabId, viewTabPanelId } from '@/components/shared/viewTabIds'
import { DeleteRuleDialog, UndoMessage } from '@/components/alerts/shared'
import { resolveWindow } from '@/data/timeWindow'
import { parseAlertsSearch } from '@/utils/alertsUrl'
import { displayName, durationWords } from '@/utils/alerts/describe'
import { copyText } from '@/utils/clipboard'
import { useRuleData } from '@/components/alerts/rule/adapters'
import {
  notifyRange, bannerSentence, rootCauseFor, instanceRows, rowForAlertId, stripSegments, clockText, seriesName,
} from '@/components/alerts/rule/rulePage'
import { handoffsFor, tracesHandoff, handoffScope, handoffRange, logsHandoff, hostHandoff } from '@/components/alerts/rule/handoffs'
import { failingExceptions } from '@/components/alerts/rule/evidence'
import {
  alertsHref, ruleHref, ruleEditHref, newRuleHref, groupHref, ruleNotificationsHref, ruleIdFromPath, ALERTS_PATH,
} from '@/components/alerts/rule/links'
import RuleHead from '@/components/alerts/rule/RuleHead'
import RuleBanner from '@/components/alerts/rule/RuleBanner'
import RuleOverview from '@/components/alerts/rule/RuleOverview'
import RuleInstances from '@/components/alerts/rule/RuleInstances'
import RuleNotifications from '@/components/alerts/rule/RuleNotifications'
import RuleDefinition from '@/components/alerts/rule/RuleDefinition'
import '@/components/alerts/rule/alert-rule.css'

const TAB_PREFIX = 'alr-rule-tab'
const PANEL_ID = viewTabPanelId(TAB_PREFIX)

// The strip and stretches of a rule that has none to draw: it says why.
const WHOLE_RANGE_STATES = new Set(['paused', 'error', 'nodata'])

/**
 * One alert rule's page, /alerts/:id (docs/alerts/DESIGN.md D5; PLAN P3): why
 * it fires, how it has behaved over the range, and one click to the evidence.
 *
 * Production titles this page "Alert", shows its rule's query in a read-only
 * editor whose tabs cannot be clicked, draws the series in green with only the
 * primary threshold, and has no firing history, notifications or "since".
 * Here the head names the rule and says it as a sentence; a firing rule gets
 * an incident banner with the root cause and its ways out; and four tabs hold
 * the rest — Overview (chart, state strip, KPIs, events), Instances,
 * Notifications and Definition. The tab is component state, not URL.
 *
 * What a notification link carries is honoured (D14): `alert_id` selects that
 * instance and isolates its series (production ignores it, R10); an old
 * `notifyTime` moves the range to the hour around it, once, on arrival; and
 * `incidentTime` anchors the Traces and log handoffs.
 *
 * @param {object} props
 * @param {() => void} props.goHome
 * @param {object} props.timeRange       App's range
 * @param {(range: object) => void} props.setTimeRange
 * @param {(message: import('react').ReactNode) => void} [props.setToast]
 * @param {(link: object) => void} [props.onOpenLink]  App's openLink
 * @param {string|number} [props.ruleId]  the rule in the path; read from it when absent
 */
export default function AlertRuleView({ goHome, timeRange, setTimeRange, setToast, onOpenLink, ruleId }) {
  const location = useLocation()
  const navigate = useNavigate()
  const url = useMemo(() => parseAlertsSearch(location.search), [location.search])
  const id = ruleId ?? ruleIdFromPath(location.pathname)

  const win = useMemo(() => resolveWindow(timeRange), [timeRange])
  const nowSec = win.nowSec
  const data = useRuleData(win, id)
  const { view, series, prevSeries, timeline, log, prev, lookups, actions } = data

  const [tab, setTab] = useState('overview')
  const [compare, setCompare] = useState('previous')
  const [deleting, setDeleting] = useState(false)
  // The isolated series, by name. Until someone picks, a notification's
  // alert_id picks for them.
  const [picked, setPicked] = useState(undefined)

  // A notification link that is old moves the range to the hour around the
  // notification — once, on arrival, as production does (reference §1.3).
  // Before paint, so the page never draws the wrong hour first.
  const arrived = useRef(false)
  useLayoutEffect(() => {
    if (arrived.current) return
    arrived.current = true
    const range = notifyRange(url.notifyTime, win.end)
    if (!range) return
    setTimeRange(range)
    setToast?.(`Showing the hour around this notification (${clockText(url.notifyTime, nowSec)}).`)
  }, [url.notifyTime, win.end, nowSec, setTimeRange, setToast])

  const rows = useMemo(() => (view ? instanceRows(view, series) : []), [view, series])
  const linkedRow = useMemo(() => rowForAlertId(rows, url.alertId), [rows, url.alertId])
  const selected = picked !== undefined ? picked : linkedRow?.name ?? null
  const selectedRow = rows.find(r => r.name === selected) ?? null

  const name = view ? displayName(view) : ''
  const toast = useCallback(msg => setToast?.(msg), [setToast])

  // ---- what the strip and the chart's shading read ----
  const lane = useMemo(() => {
    if (!view) return []
    if (selectedRow) {
      const s = series.find(x => seriesName(x, view) === selectedRow.name)
      return timeline?.series?.find(x => x.key === s?.key)?.intervals ?? []
    }
    return timeline?.intervals ?? []
  }, [view, selectedRow, series, timeline])
  const segments = useMemo(
    () => (view ? stripSegments(lane, win, nowSec, WHOLE_RANGE_STATES.has(view.state) ? view.state : null) : []),
    [view, lane, win, nowSec],
  )

  // ---- the ways out ----
  // Anchored on the link's incidentTime, else on when the alert (the picked
  // instance, or the worst one) became active, else when the rule's state began.
  const anchorSec = url.incidentTime ?? selectedRow?.activeAt ?? rows[0]?.activeAt ?? view?.since ?? null
  const handoffs = useMemo(
    () => (view ? handoffsFor(view, { row: selectedRow, anchorSec, nowSec }) : []),
    [view, selectedRow, anchorSec, nowSec],
  )
  const follow = useCallback((h) => {
    let { link, range } = h
    if (h.id === 'traces') {
      // What the failures threw in that window, read now rather than on every
      // render: named, the Traces page brings in the spans that recorded them.
      const scope = handoffScope(view, selectedRow)
      const exceptions = failingExceptions(handoffRange(anchorSec, nowSec), scope.service, scope.endpoint)
      const t = tracesHandoff(view, { row: selectedRow, anchorSec, nowSec, exceptions })
      if (t) ({ link, range } = t)
    }
    if (range) setTimeRange(range)
    onOpenLink?.(link)
  }, [view, selectedRow, anchorSec, nowSec, setTimeRange, onOpenLink])
  const traceRow = useCallback((row) => {
    const scope = handoffScope(view, row)
    const anchor = url.incidentTime ?? row.activeAt ?? anchorSec
    const exceptions = failingExceptions(handoffRange(anchor, nowSec), scope.service, scope.endpoint)
    const t = tracesHandoff(view, { row, anchorSec: anchor, nowSec, exceptions })
    if (!t) return
    if (t.range) setTimeRange(t.range)
    onOpenLink?.(t.link)
  }, [view, url.incidentTime, anchorSec, nowSec, setTimeRange, onOpenLink])
  const logsRow = useCallback((row) => {
    const l = logsHandoff(view, { row, anchorSec: url.incidentTime ?? row.activeAt ?? anchorSec, nowSec })
    if (!l) return
    if (l.range) setTimeRange(l.range)
    onOpenLink?.(l.link)
  }, [view, url.incidentTime, anchorSec, nowSec, setTimeRange, onOpenLink])
  const hostRow = useCallback((row) => {
    const link = hostHandoff(view, { row })
    if (link) onOpenLink?.(link)
  }, [view, onOpenLink])

  // ---- what can be done to it: each confirms, the reversible ones with Undo ----
  const report = useCallback((undo, done, failed) => {
    if (!undo) { toast(failed); return }
    toast(<UndoMessage text={done} onUndo={() => { undo(); toast(null) }} />)
  }, [toast])
  const pause = useCallback(() => report(actions.pause(view.id), `Paused ${name}. It stops evaluating until it is resumed.`, `${name} was not paused.`), [report, actions, view, name])
  const resume = useCallback(() => report(actions.resume(view.id), `Resumed ${name}.`, `${name} was not resumed.`), [report, actions, view, name])
  const snooze = useCallback((spec) => {
    const until = typeof spec === 'number' ? `for ${durationWords(spec * 60)}` : `until ${clockText(spec.end, nowSec)}`
    report(actions.snooze(view.id, spec), `Snoozed ${name} ${until}. It still fires; nobody is notified.`, `${name} was not snoozed.`)
  }, [report, actions, view, name, nowSec])
  const unsnooze = useCallback((s) => {
    report(actions.unsnooze(s.silenceId), s.scheduled ? 'Scheduled snooze cancelled.' : `Snooze ended. ${name} notifies again.`, 'That snooze has already ended.')
  }, [report, actions, name])
  const edit = useCallback(() => navigate(ruleEditHref(view.id)), [navigate, view])
  const remove = useCallback(() => {
    const undo = actions.remove(view.id)
    setDeleting(false)
    if (!undo) { toast(`${name} was not deleted.`); return }
    navigate(alertsHref())
    toast(<UndoMessage text={`Deleted ${name}. Its notification history is kept.`} onUndo={() => { undo(); toast(null) }} />)
  }, [actions, view, name, navigate, toast])
  const onAction = useCallback((action) => {
    if (action === 'pause') pause()
    else if (action === 'resume') resume()
    else if (action === 'edit') edit()
    // The editor (P4) reads what to clone from the history entry's state.
    else if (action === 'clone') navigate(newRuleHref(), { state: { cloneOf: view.id } })
    else if (action === 'history') setTab('notifications')
    else if (action === 'copyLink') {
      const href = typeof window !== 'undefined' ? `${window.location.origin}${ruleHref(view.id)}` : ruleHref(view.id)
      copyText(href).then(ok => toast(ok ? 'Link copied.' : 'Couldn\'t copy the link.'))
    } else if (action === 'delete') setDeleting(true)
  }, [pause, resume, edit, navigate, view, toast])

  const goHomeLink = (e) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    goHome?.()
  }
  const goTo = href => (e) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    navigate(href)
  }

  if (!view) {
    return (
      <>
        <PageBar timeRange={timeRange} setTimeRange={setTimeRange}>
          <a href="/" onClick={goHomeLink}>CubeAPM</a>
          <span className="sep">/</span>
          <a href={ALERTS_PATH} onClick={goTo(alertsHref())}>Alerts</a>
          <span className="sep">/</span>
          <span className="current">Not found</span>
        </PageBar>
        <div className="svc-main">
          <div className="alr-notfound" role="alert">
            <h2>Alert not found</h2>
            <p>
              {id != null && id !== ''
                ? <>No alert rule has the id <span className="mono">{String(id)}</span>. It may have been deleted, or the link may be mistyped.</>
                : 'This link names no alert rule.'}
            </p>
            <button type="button" className="hbtn primary" onClick={() => navigate(alertsHref())}>
              <ArrowLeft aria-hidden="true" />Back to Alerts
            </button>
          </div>
        </div>
      </>
    )
  }

  const sentence = bannerSentence(view, nowSec, rootCauseFor(view.scope?.service))
  const toGroup = groupHref(view.group)
  const tabs = [
    { id: 'overview', label: 'Overview', Icon: ChartLine },
    { id: 'instances', label: 'Instances', Icon: Layers, count: rows.length },
    { id: 'notifications', label: 'Notifications', Icon: History, count: log.length },
    { id: 'definition', label: 'Definition', Icon: FileCode },
  ]

  return (
    <div className="alr-rule-page">
      <PageBar timeRange={timeRange} setTimeRange={setTimeRange} onRefresh={data.refresh}>
        <a href="/" onClick={goHomeLink}>CubeAPM</a>
        <span className="sep">/</span>
        <a href={ALERTS_PATH} onClick={goTo(alertsHref())}>Alerts</a>
        <span className="sep">/</span>
        <a href={toGroup} onClick={goTo(toGroup)} title={`Rules in ${view.group}`}>{view.group}</a>
        <span className="sep">/</span>
        <span className="current">{name}</span>
      </PageBar>
      <div className="card-tab-strip alr-rule-top">
        <RuleHead
          view={{ ...view, name }}
          nowSec={nowSec}
          onSnooze={snooze}
          onPause={pause}
          onResume={resume}
          onEdit={edit}
          onAction={onAction}
          onBlocked={toast}
        />
        <RuleBanner sentence={sentence} severity={view.severity} handoffs={handoffs} onHandoff={follow} onBlocked={toast} />
        {/* The strip is one Tab stop; the arrows, Home and End move along it,
            and Enter or Space opens the tab (ViewTabs). */}
        <ViewTabs tabs={tabs} active={tab} onSelect={setTab} ariaLabel="Rule views" idPrefix={TAB_PREFIX} />
      </div>
      <div id={PANEL_ID} role="tabpanel" aria-labelledby={viewTabId(TAB_PREFIX, tab)} className="svc-main alr-rule-main">
        {tab === 'overview' && (
          <RuleOverview
            view={view} series={series} prevSeries={prevSeries} compare={compare} onCompare={setCompare}
            timeline={timeline} lane={lane} prev={prev} log={log} segments={segments} win={win} nowSec={nowSec}
            timeRange={timeRange} onFocus={setTimeRange} selected={selected} onSelect={setPicked}
            lookups={lookups} headline={selectedRow ?? rows[0] ?? null}
            staleAlertId={url.alertId && !linkedRow ? url.alertId : null}
          />
        )}
        {tab === 'instances' && (
          <RuleInstances
            view={view} rows={rows} log={log} nowSec={nowSec} selected={selected} onSelect={setPicked}
            scrollToSelected={picked === undefined && !!linkedRow}
            onTraces={traceRow}
            onLogs={logsRow}
            onHost={hostRow}
          />
        )}
        {tab === 'notifications' && (
          <RuleNotifications
            view={view} log={log} nowSec={nowSec} lookups={lookups}
            historyHref={ruleNotificationsHref(view.id)}
          />
        )}
        {tab === 'definition' && (
          <RuleDefinition
            view={view} nowSec={nowSec} muteGroups={data.muteGroups} lookups={lookups}
            onEdit={edit} onUnsnooze={unsnooze} onBlocked={toast}
          />
        )}
      </div>
      {deleting && <DeleteRuleDialog ruleName={name} onConfirm={remove} onCancel={() => setDeleting(false)} />}
    </div>
  )
}
