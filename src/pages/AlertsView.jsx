import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { BellRing, ChartColumn, Send, CalendarClock, History } from 'lucide-react'
import PageBar from '@/components/layout/PageBar'
import ViewTabs from '@/components/shared/ViewTabs'
import { viewTabId, viewTabPanelId } from '@/components/shared/viewTabIds'
import RulesTab from '@/components/alerts/list/RulesTab'
import { UpdatedAgo } from '@/components/alerts/list/ListStates'
import ContactPointsTab from '@/components/alerts/config/ContactPointsTab'
import MuteSchedulesTab from '@/components/alerts/config/MuteSchedulesTab'
import InsightsTab from '@/components/alerts/insights/InsightsTab'
import NotificationsTab from '@/components/alerts/notifications/NotificationsTab'
import '@/components/alerts/config/alerts-config.css'
import { useAlerts } from '@/hooks/useAlerts'
import { resolveWindow } from '@/data/timeWindow'
import { parseAlertsSearch, alertsSearch, ALERTS_TABS } from '@/utils/alertsUrl'
import { sameSearch } from '@/utils/searchParams'
import './alerts-view.css'

// The Alerts hub (docs/alerts/DESIGN.md D2): production's five tabs, by
// production's `tab` values so its links land here, under our labels (signed
// off as Q1). The strip is the service page's (ViewTabs, full tablist form).
const TAB_META = {
  alerts: { label: 'Rules', Icon: BellRing },
  'alert-stats': { label: 'Insights', Icon: ChartColumn },
  'receiver-groups': { label: 'Contact points', Icon: Send },
  'mute-groups': { label: 'Mute schedules', Icon: CalendarClock },
  'alert-logs': { label: 'Notifications', Icon: History },
}
const TAB_PREFIX = 'alr-tab'

// Tabs the time range says nothing about: their lists are configuration, not
// history, so the bar leaves the picker out there (D16) — production shows it
// everywhere and it does nothing on these two.
const TIMELESS = new Set(['receiver-groups', 'mute-groups'])

export default function AlertsView({ goHome, timeRange, setTimeRange, setToast, onOpenLink }) {
  const location = useLocation()
  const navigate = useNavigate()
  const url = useMemo(() => parseAlertsSearch(location.search), [location.search])
  const win = useMemo(() => resolveWindow(timeRange), [timeRange])
  const alerts = useAlerts(win)
  const [autoRefresh, setAutoRefresh] = useState(0)

  // A link's preset range is taken once, on arrival. The range is App's, so it
  // is never written back (the Errors page's convention).
  const tookTime = useRef(false)
  useEffect(() => {
    if (tookTime.current) return
    tookTime.current = true
    if (url.time) setTimeRange({ kind: 'preset', value: url.time })
  }, [url.time, setTimeRange])

  // Refinements replace the entry; a tab switch pushes one, so Back returns to
  // the tab you were on (Browser's convention). A switch keeps the rule a link
  // is about — production keeps rule_id across tabs — and drops the old tab's
  // search, grouping and facets, which mean nothing on the new one.
  const onUrlChange = useCallback((patch) => {
    const next = alertsSearch({ ...url, ...patch })
    if (!sameSearch(next, location.search)) navigate({ search: next }, { replace: true })
  }, [url, location.search, navigate])
  const selectTab = useCallback((tab) => {
    if (tab === url.tab) return
    navigate({ search: alertsSearch({ tab, ruleId: url.ruleId }) })
  }, [url.tab, url.ruleId, navigate])

  // The configuration tabs count what they hold. Rules carries no count: its
  // list says how many rules there are and which fire, worst first.
  const tabs = ALERTS_TABS.map(id => ({
    id,
    ...TAB_META[id],
    count: id === 'receiver-groups' ? alerts.receiverGroups.length
      : id === 'mute-groups' ? alerts.muteGroups.length
        : null,
  }))

  // A real link, so it is in the Tab order and read as one; a plain click goes
  // Home in the app, a modified one is left to the browser (as on Browser).
  const goHomeLink = (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
    e.preventDefault()
    goHome()
  }

  return (
    <>
      <PageBar
        timeRange={timeRange}
        setTimeRange={setTimeRange}
        showTime={!TIMELESS.has(url.tab)}
        onRefresh={alerts.refresh}
        actions={<UpdatedAgo updatedAt={alerts.updatedAt} />}
        autoRefresh={autoRefresh}
        onAutoRefreshChange={setAutoRefresh}
      >
        <a href="/" onClick={goHomeLink}>CubeAPM</a>
        <span className="sep">/</span>
        <span className="current">Alerts</span>
      </PageBar>
      <div className="card-tab-strip alr-tab-strip">
        <ViewTabs tabs={tabs} active={url.tab} onSelect={selectTab} ariaLabel="Alerts views" idPrefix={TAB_PREFIX} />
      </div>
      {/* A neutral flex column: each tab's body owns its scroller, so the
          sticky headers inside it stick to the thing that scrolls. */}
      <div
        id={viewTabPanelId(TAB_PREFIX)}
        role="tabpanel"
        aria-labelledby={viewTabId(TAB_PREFIX, url.tab)}
        className="alerts-panel"
      >
        {url.tab === 'alerts' ? (
          <RulesTab
            win={win}
            alerts={alerts}
            url={url}
            onUrlChange={onUrlChange}
            onOpenLink={onOpenLink}
            setToast={setToast}
            setTimeRange={setTimeRange}
            onRetry={alerts.refresh}
          />
        ) : url.tab === 'receiver-groups' ? (
          <ContactPointsTab alerts={alerts} setToast={setToast} />
        ) : url.tab === 'mute-groups' ? (
          <MuteSchedulesTab alerts={alerts} setToast={setToast} />
        ) : url.tab === 'alert-stats' ? (
          <InsightsTab alerts={alerts} win={win} />
        ) : (
          <NotificationsTab alerts={alerts} url={url} onUrlChange={onUrlChange} />
        )}
      </div>
    </>
  )
}
