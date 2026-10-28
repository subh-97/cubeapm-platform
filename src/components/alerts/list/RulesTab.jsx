import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { DeleteRuleDialog, UndoMessage } from '@/components/alerts/shared'
import { services as SERVICES } from '@/data/services'
import { zoomRange } from '@/utils/timeRange'
import { copyText } from '@/utils/clipboard'
import { MIN_FOCUS_MS } from '@/components/charts/useTimeFocus'
import { rulePath, ruleEditPath, NEW_RULE_PATH, displayName } from './adapters'
import { suggestedRules } from './rulesQuery'
import { toggleExpanded, withUrlRule, ruleKey } from './rulesList'
import { historyHref, windowAgo } from './ruleDisplay'
import { changeRule } from './ruleActions'
import FiringNow from './FiringNow'
import CreateRuleBanners from './CreateRuleBanners'
import RulesTable from './RulesTable'
import { BandSkeleton } from './ListStates'
import './alerts-list.css'

const NO_RULES = []
const NO_TIMELINE = []
const NO_RULE = () => null
const NO_SERIES = () => []

// A keyboard shortcut is the page's only when focus is not somewhere that
// types: a search box, a field in a dialog. A row's select box types nothing.
const typing = el => !!el && (el.isContentEditable || ['TEXTAREA', 'SELECT'].includes(el.tagName)
  || (el.tagName === 'INPUT' && !['checkbox', 'radio'].includes(el.type)))

/**
 * The Rules tab (docs/alerts/PLAN.md, P2; DESIGN D2–D4, D10, D16–D18): what is
 * firing now, the range's timeline, and every rule in severity order, grouped,
 * filtered and searched the way the explorer pages are, each expanding in place.
 *
 * Everything comes in through props, so the page shell owns the data and the
 * URL: `alerts` is `useAlerts(win)` (rule views worst first, `byId`,
 * `seriesFor`, the timeline, `actions`), `url` is
 * `parseAlertsSearch(location.search)`, and `onUrlChange(patch)` merges a patch
 * into it and writes it with replace. `setTimeRange`, `loading`, `stale`
 * ({ since }) and `onRetry` are optional: without them there is no zoom, and
 * no stale line. "Updated …" is the page bar's (AlertsView).
 *
 * Every change says so in a toast, offering the store's own undo (D16);
 * production confirms none of them.
 */
export default function RulesTab({
  win, alerts, url, onUrlChange, onOpenLink, setToast,
  setTimeRange, loading = false, stale, onRetry,
}) {
  const navigate = useNavigate()
  const rules = alerts?.rules ?? NO_RULES
  const byId = alerts?.byId ?? NO_RULE
  const seriesFor = alerts?.seriesFor ?? NO_SERIES
  const timeline = alerts?.timeline ?? NO_TIMELINE
  const actions = alerts?.actions
  const nowSec = win.nowSec
  const page = url ?? {}
  const ruleId = page.ruleId ?? null
  const agoText = windowAgo(win)

  // ---- what is open ----

  // Several rows can be open at once; the one a link names (`rule_id`) opens
  // with the page, and again if a later link names another.
  const [expanded, setExpanded] = useState(() => withUrlRule(new Set(), ruleId))
  useEffect(() => {
    if (ruleId) setExpanded(cur => withUrlRule(cur, ruleId))
  }, [ruleId])
  const onToggleRow = useCallback(id => setExpanded(cur => toggleExpanded(cur, id)), [])

  // ---- toasts ----

  const say = useCallback(({ text, undo }) => {
    if (!setToast || !text) return
    setToast(undo
      ? <UndoMessage text={text} onUndo={() => { undo(); setToast(null) }} />
      : text)
  }, [setToast])

  // ---- ways out ----

  // A rule's page. From a timeline bar it also focuses the range on that bar,
  // and names the alert (alert_id) the bar is about (D4).
  const onOpenRule = useCallback((id, focus) => {
    if (focus && setTimeRange && Number.isFinite(focus.start) && Number.isFinite(focus.end)) {
      const next = zoomRange(focus.start * 1000, focus.end * 1000, {
        snapMs: 60000, minSpanMs: MIN_FOCUS_MS, notAfterMs: nowSec * 1000,
      })
      if (next) setTimeRange(next)
    }
    navigate(`${rulePath(id)}${focus?.alertId ? `?alert_id=${encodeURIComponent(focus.alertId)}` : ''}`)
  }, [navigate, setTimeRange, nowSec])
  const onHistory = useCallback(id => navigate(historyHref(id)), [navigate])
  const onNewRule = useCallback(() => navigate(NEW_RULE_PATH), [navigate])
  // The editor (P4) reads these from router state, as production's Clone does.
  const onSuggest = useCallback(s => navigate(NEW_RULE_PATH, { state: { suggestion: s.spec } }), [navigate])
  const openLink = useCallback(link => { if (link) onOpenLink?.(link) }, [onOpenLink])

  // ---- changes ----

  const [deleting, setDeleting] = useState(null)

  const onSnooze = useCallback((view, spec) => {
    say(changeRule(actions, view, { kind: 'snooze', spec }, nowSec))
  }, [actions, nowSec, say])
  const onUnsnooze = useCallback((view, snooze) => {
    say(changeRule(actions, view, { kind: 'unsnooze', snooze }, nowSec))
  }, [actions, nowSec, say])

  const onAction = useCallback((view, id) => {
    switch (id) {
      case 'pause':
      case 'resume':
        say(changeRule(actions, view, { kind: id }, nowSec))
        break
      case 'edit':
        navigate(ruleEditPath(view.id))
        break
      case 'clone':
        navigate(NEW_RULE_PATH, { state: { cloneOf: view.id } })
        break
      case 'history':
        onHistory(view.id)
        break
      case 'copyLink':
        copyText(`${window.location.origin}${rulePath(view.id)}`).then(ok => say({
          text: ok ? `Copied the link to ${displayName(view)}.` : 'The browser blocked the clipboard, so nothing was copied.',
        }))
        break
      case 'delete':
        setDeleting(view)
        break
      default:
        break
    }
  }, [actions, navigate, nowSec, onHistory, say])

  const confirmDelete = useCallback(() => {
    const view = deleting
    setDeleting(null)
    if (!view) return
    const outcome = changeRule(actions, view, { kind: 'remove' }, nowSec)
    if (outcome.undo) setExpanded(cur => { const next = new Set(cur); next.delete(ruleKey(view.id)); return next })
    say(outcome)
  }, [deleting, actions, nowSec, say])

  const handlers = useMemo(() => ({
    onOpenRule, onOpenLink: openLink, onHistory, onSnooze, onUnsnooze, onAction,
  }), [onOpenRule, openLink, onHistory, onSnooze, onUnsnooze, onAction])

  // ---- keys: / searches, n starts a new rule (D17) ----

  const rootRef = useRef(null)
  useEffect(() => {
    const onKey = (e) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || typing(document.activeElement)) return
      if (document.querySelector('[role="dialog"], [role="menu"]')) return
      if (e.key === '/') {
        const input = rootRef.current?.querySelector('.rtab-toolbar input')
        if (!input) return
        e.preventDefault()
        input.focus()
      } else if (e.key === 'n' && !e.shiftKey) {
        e.preventDefault()
        onNewRule()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onNewRule])

  const suggestions = useMemo(() => (rules.length ? [] : suggestedRules(SERVICES, rules)), [rules])

  return (
    <div className="rtab" ref={rootRef}>
      <CreateRuleBanners
        onTemplate={t => openLink({ view: 'alertEditor', ...t.payload() })}
        onScratch={onNewRule}
      />
      {loading ? <BandSkeleton /> : (
        <FiringNow
          rules={rules}
          timeline={timeline}
          byId={byId}
          seriesFor={seriesFor}
          win={win}
          onOpenRule={onOpenRule}
          setTimeRange={setTimeRange}
          stale={stale ?? alerts?.stale ?? null}
          onRetry={onRetry ?? alerts?.refresh}
        />
      )}
      <RulesTable
        rules={rules}
        url={{ ...page, facets: page.facets ?? {}, q: page.q ?? '' }}
        onUrlChange={patch => onUrlChange?.(patch)}
        loading={loading}
        expanded={expanded}
        onToggleRow={onToggleRow}
        nowSec={nowSec}
        agoText={agoText}
        seriesFor={seriesFor}
        handlers={handlers}
        suggestions={suggestions}
        onNewRule={onNewRule}
        onSuggest={onSuggest}
      />
      {deleting && (
        <DeleteRuleDialog ruleName={displayName(deleting)} onConfirm={confirmDelete} onCancel={() => setDeleting(null)} />
      )}
    </div>
  )
}
