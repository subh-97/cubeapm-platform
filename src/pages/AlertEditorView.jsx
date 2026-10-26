import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { FileQuestion, Lock } from 'lucide-react'
import PageBar from '@/components/layout/PageBar'
import EmptyState from '@/components/shared/EmptyState'
import AlertDialog from '@/components/alerts/shared/AlertDialog'
import UndoMessage from '@/components/alerts/shared/UndoMessage'
import EditorHead from '@/components/alerts/editor/EditorHead'
import EditorSection from '@/components/alerts/editor/EditorSection'
import QuerySection from '@/components/alerts/editor/QuerySection'
import DetailsSection from '@/components/alerts/editor/DetailsSection'
import NotifySection from '@/components/alerts/editor/NotifySection'
import MutesAccessSection from '@/components/alerts/editor/MutesAccessSection'
import PreviewRail from '@/components/alerts/editor/PreviewRail'
import { useRulePreview } from '@/components/alerts/editor/useRulePreview'
import { useAlerts } from '@/hooks/useAlerts'
import { resolveWindow } from '@/data/timeWindow'
import { ALERTS_NOW } from '@/data/alerts'
import { ruleView } from '@/utils/alerts/model'
import { conditionText, displayName, formatDuration } from '@/utils/alerts/describe'
import { RECEIVER_TYPES } from '@/utils/alerts/catalog'
import {
  blankDraft, draftFromRule, draftFromPayload, draftFromSuggestion, ruleFromDraft, validateDraft, isDirty, setTier,
} from '@/utils/alerts/editorDraft'
import { groupForService } from '@/utils/alerts/editorPayloads'
import { alertRuleUrl, routeUrl } from '@/utils/route'
import { requestLeave, setLeaveGuard } from '@/utils/leaveGuard'
import './alerts-view.css'
import '@/components/alerts/editor/alert-editor.css'

const ALERTS_PATH = routeUrl({ view: 'alerts' })

// Which section a validation item belongs to, for the "N to finish" on its head.
const SECTION_OF = field => (/^(query|kind|tiers|tier-)/.test(field) ? 1
  : /^(name|group|tag-)/.test(field) ? 2
    : /^(notify|destination-)/.test(field) ? 3 : 4)
// What shows inline before the first Save: only what was typed wrong. What is
// missing waits until someone tries to save, so a new rule does not open red.
const EARLY = field => /^(query|tier-|tag-)/.test(field)

const isPlain = e => !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0)

/**
 * /alerts/new and /alerts/:id/edit (docs/alerts/DESIGN.md D6): one page for
 * New, Edit and Clone, with the four sections production steps through as a
 * wizard laid out at once, and a preview beside them that shows where the rule
 * would have fired before it is saved.
 *
 * Where the draft comes from, in order: the rule being edited; a rule being
 * cloned (`state.cloneOf`, from the Rules tab and the rule page); a service
 * the empty Rules tab suggested (`state.suggestion`); a payload another page
 * handed App (`incoming`, from a card's or a query bar's Create Alert); or a
 * blank rule. All of it arrives as router or App state, never in the URL,
 * as production's entry points do.
 */
export default function AlertEditorView({ ruleId, goHome, timeRange, setTimeRange, setToast, incoming, onIncomingApplied }) {
  const navigate = useNavigate()
  const location = useLocation()
  const alerts = useAlerts()
  const win = useMemo(() => resolveWindow(timeRange), [timeRange])
  const ctx = useMemo(() => ({
    receiverGroups: alerts.receiverGroups, muteGroups: alerts.muteGroups, silences: alerts.silences,
    slos: alerts.slos, monitors: alerts.monitors, ...alerts.lookups,
  }), [alerts])

  const cloneOf = location.state?.cloneOf ?? null
  const mode = ruleId != null ? 'edit' : cloneOf != null ? 'clone' : 'new'
  const source = ruleId != null ? alerts.byId(ruleId) : cloneOf != null ? alerts.byId(cloneOf) : null
  const sloManaged = source?.managedBy?.kind === 'slo'

  const [initial] = useState(() => {
    if (ruleId != null) return source && !sloManaged ? draftFromRule(source.rule) : null
    if (cloneOf != null) return source && !sloManaged ? draftFromRule(source.rule, { clone: true }) : blankDraft()
    if (location.state?.suggestion) return draftFromSuggestion(location.state.suggestion)
    if (incoming) {
      const d = draftFromPayload(incoming)
      if (incoming.service && !incoming.group) d.group = groupForService(alerts.rules, incoming.service) ?? d.group
      return d
    }
    return blankDraft()
  })
  const [draft, setDraft] = useState(initial)
  const [attempted, setAttempted] = useState(false)
  const [open, setOpen] = useState({ 1: true, 2: true, 3: true, 4: true })
  const [leaveAsk, setLeaveAsk] = useState(null)
  const done = useRef(false)
  const armed = useRef(false)

  // An incoming payload is applied once, then handed back (as Explore's is).
  useEffect(() => {
    if (incoming) onIncomingApplied?.()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const rule = useMemo(() => (draft ? ruleFromDraft(draft) : null), [draft])
  const view = useMemo(() => (rule
    ? ruleView({ ...rule, id: rule.id ?? 'draft', state: 'inactive', health: 'ok', alerts: null, seriesCount: 1, lastEvaluation: null, lastError: '' }, { ...ctx, history: null, nowSec: ALERTS_NOW })
    : null), [rule, ctx])
  const { result, stale } = useRulePreview(rule, win, ctx)
  const issues = useMemo(() => (draft ? validateDraft(draft) : []), [draft])
  const problems = useMemo(() => {
    const out = {}
    for (const it of issues) if (!(it.field in out) && (attempted || EARLY(it.field))) out[it.field] = it.message
    return out
  }, [issues, attempted])
  const sectionIssues = n => (attempted ? issues.filter(it => SECTION_OF(it.field) === n).length : 0)
  const dirty = draft ? isDirty(draft, initial) : false

  // ---- leaving with unsaved changes (R24) ----

  useEffect(() => {
    if (!dirty || done.current) return undefined
    const remove = setLeaveGuard(proceed => setLeaveAsk(() => proceed))
    const onBeforeUnload = (e) => { e.preventDefault(); e.returnValue = '' }
    // Back: a copy of this entry to step back onto, so the browser's own
    // button lands here first and can be asked about. Pushed once per page,
    // however often the form goes clean and dirty again.
    if (!armed.current) {
      armed.current = true
      window.history.pushState(window.history.state, '', window.location.href)
    }
    const onPop = () => {
      if (done.current) return
      // Back again past this entry and the copy it was re-armed with.
      setLeaveAsk(() => () => { done.current = true; window.history.go(-2) })
      window.history.pushState(window.history.state, '', window.location.href)
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    window.addEventListener('popstate', onPop)
    return () => {
      remove()
      window.removeEventListener('beforeunload', onBeforeUnload)
      window.removeEventListener('popstate', onPop)
    }
  }, [dirty])

  const leave = useCallback((go) => requestLeave(() => { done.current = true; go() }), [])
  const backUrl = mode === 'edit' && source ? alertRuleUrl(source.id) : ALERTS_PATH
  const cancel = () => leave(() => navigate(backUrl))
  const crumbHome = (e) => { if (!isPlain(e)) return; e.preventDefault(); leave(goHome) }
  const crumbTo = url => (e) => { if (!isPlain(e)) return; e.preventDefault(); leave(() => navigate(url)) }

  // ---- fields ----

  const focusField = useCallback((field) => {
    setOpen(o => ({ ...o, [SECTION_OF(field)]: true }))
    requestAnimationFrame(() => {
      const el = document.getElementById(`ae-field-${field}`)
      if (!el) return
      el.scrollIntoView({ block: 'center', behavior: 'smooth' })
      const target = el.matches('input, textarea, button') ? el : el.querySelector('input, textarea, button:not([aria-disabled="true"])') ?? el
      target.focus({ preventScroll: true })
    })
  }, [])

  // Insights' Tune opens here on the thresholds (D11), where its preview is
  // already offering a better one for the same range.
  useEffect(() => {
    if (draft && location.state?.focus) focusField(location.state.focus)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const save = () => {
    setAttempted(true)
    if (issues.length) return
    const before = mode === 'edit' ? source.rule : null
    const { rule: saved } = alerts.actions.saveRule(rule)
    done.current = true
    const name = displayName(saved)
    setToast?.(before
      ? <UndoMessage text={`Saved ${name}.`} onUndo={() => { alerts.actions.saveRule(before); setToast?.(null) }} />
      : `Created ${name}.`)
    // Replace, not push: Back from the rule should not reopen a finished form.
    navigate(alertRuleUrl(saved.id), { replace: true })
  }

  // ---- states with no form ----

  const crumbs = (current) => (
    <PageBar timeRange={timeRange} setTimeRange={setTimeRange}>
      <a href="/" onClick={crumbHome}>CubeAPM</a>
      <span className="sep">/</span>
      <a href={ALERTS_PATH} onClick={crumbTo(ALERTS_PATH)}>Alerts</a>
      {mode === 'edit' && source && (
        <>
          <span className="sep">/</span>
          <a href={alertRuleUrl(source.id)} onClick={crumbTo(alertRuleUrl(source.id))}>{displayName(source)}</a>
        </>
      )}
      <span className="sep">/</span>
      <span className="current">{current}</span>
    </PageBar>
  )

  if (mode === 'edit' && !source) {
    return (
      <>
        {crumbs('Edit rule')}
        <div className="svc-main alerts-reserved">
          <EmptyState
            icon={FileQuestion}
            title="Alert not found"
            description={`There is no rule ${ruleId} to edit. It may have been deleted.`}
            action={<a className="hbtn" href={ALERTS_PATH} onClick={crumbTo(ALERTS_PATH)}>Back to Alerts</a>}
          />
        </div>
      </>
    )
  }
  if (sloManaged && mode === 'edit') {
    return (
      <>
        {crumbs('Edit rule')}
        <div className="svc-main alerts-reserved">
          <EmptyState
            icon={Lock}
            title="This rule belongs to its SLO"
            description={`${displayName(source)} is generated by the SLO it watches, so its thresholds and receivers are set there. You can still snooze it from its page.`}
            action={<a className="hbtn" href={alertRuleUrl(source.id)} onClick={crumbTo(alertRuleUrl(source.id))}>Back to the rule</a>}
          />
        </div>
      </>
    )
  }

  // ---- the form ----

  const groups = [...new Set(alerts.rules.map(v => v.group).filter(Boolean))].sort()
  const chosen = alerts.receiverGroups.filter(g => draft.receiverGroupIds.includes(g.id)).map(g => g.name)
  const oneOff = draft.destinations.map(d => RECEIVER_TYPES.find(t => t.type === d.type)?.label).filter(Boolean)
  const destinationsText = [...chosen, ...oneOff].join(', ')
  const summary = {
    1: conditionText(view),
    2: [`every ${formatDuration(draft.intervalSec)}`, draft.forSec ? `fire after ${formatDuration(draft.forSec)}` : 'fires at once', draft.group].join(' · '),
    3: destinationsText ? `${destinationsText} · ${draft.groupingDisable ? 'one per series' : 'one for all series'}` : 'Nobody yet',
    4: [draft.muteGroupIds.length || draft.muteWindows.length ? `${draft.muteGroupIds.length + draft.muteWindows.length} mute window${draft.muteGroupIds.length + draft.muteWindows.length === 1 ? '' : 's'}` : 'No mutes', draft.access.mode === 'role' ? 'access by role' : 'specific access'].join(' · '),
  }
  const section = (n, title, body) => (
    <EditorSection n={n} title={title} summary={summary[n]} open={open[n]} issues={sectionIssues(n)} className={`ae-s${n}`} onToggle={() => setOpen(o => ({ ...o, [n]: !o[n] }))}>
      {body}
    </EditorSection>
  )
  const title = mode === 'edit' ? `Edit ${displayName(source)}` : mode === 'clone' ? draft.name || 'Copy' : 'New rule'

  return (
    <>
      {crumbs(mode === 'edit' ? 'Edit' : mode === 'clone' ? 'Clone' : 'New rule')}
      <div className="svc-main ae-page">
        <h1 className="sr-only">{title}</h1>
        <EditorHead
          view={view}
          mode={mode}
          status={draft.status}
          onStatus={status => setDraft(d => ({ ...d, status }))}
          issues={issues}
          onFocusField={focusField}
          onCancel={cancel}
          onSave={save}
        />
        {source?.managedBy?.kind === 'synthetic' && (
          <p className="ae-managed">
            Created from the monitor “{source.managedBy.monitorName ?? source.managedBy.monitorId}”. Changes apply to this rule only, not to the monitor.
          </p>
        )}
        <div className="ae-layout">
          {section(1, 'Query & condition', (
            <QuerySection draft={draft} onDraft={setDraft} view={view} range={timeRange} problems={problems} />
          ))}
          <PreviewRail
            result={result}
            stale={stale}
            rule={rule}
            view={view}
            win={win}
            nowSec={ALERTS_NOW}
            onFocus={setTimeRange}
            destinationsText={destinationsText}
            onUseThreshold={(t) => {
              const name = draft.tiers[draft.kind].warning.value !== '' ? 'warning' : 'critical'
              setDraft(d => setTier(d, name, { value: String(t) }))
            }}
          />
          {section(2, 'Evaluation & details', (
            <DetailsSection draft={draft} onDraft={setDraft} series={result?.series} groups={groups} problems={problems} />
          ))}
          {section(3, 'Notifications', (
            <NotifySection draft={draft} onDraft={setDraft} receiverGroups={alerts.receiverGroups} lookups={alerts.lookups} problems={problems} />
          ))}
          {section(4, 'Mutes & access', (
            <MutesAccessSection draft={draft} onDraft={setDraft} muteGroups={alerts.muteGroups} lookups={alerts.lookups} problems={problems} nowSec={ALERTS_NOW} />
          ))}
        </div>
      </div>
      {leaveAsk && (
        <LeaveDialog
          onStay={() => setLeaveAsk(null)}
          onLeave={() => { const go = leaveAsk; setLeaveAsk(null); done.current = true; go() }}
        />
      )}
    </>
  )
}

function LeaveDialog({ onStay, onLeave }) {
  const stayRef = useRef(null)
  return (
    <AlertDialog
      title="Discard changes to this rule?"
      onCancel={onStay}
      initialFocus={stayRef}
      footer={(
        <>
          <button ref={stayRef} type="button" className="hbtn" onClick={onStay}>Keep editing</button>
          <button type="button" className="hbtn alr-btn-danger" onClick={onLeave}>Discard changes</button>
        </>
      )}
    >
      <p>Nothing you changed here has been saved. Leaving now loses it.</p>
    </AlertDialog>
  )
}
