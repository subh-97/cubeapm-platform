import { useState, useCallback, useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import HomeSkeleton from '@/pages/HomeSkeleton'
import Walkthrough from '@/components/Walkthrough'
import Toast from '@/components/Toast'
import Sidebar from '@/components/layout/Sidebar'
import InfraIcon from '@/components/layout/InfraIcons'
import HomePage from '@/pages/HomePage'
import ServiceOverview from '@/pages/ServiceOverview'
import LogsView from '@/pages/LogsView'
import TracesView from '@/pages/TracesView'
import ExploreView from '@/pages/ExploreView'
import ErrorsView from '@/pages/ErrorsView'
import InfraView from '@/pages/InfraView'
import TraceDetail from '@/pages/TraceDetail'
import LoginPage from '@/pages/LoginPage'
import DesignSystemPage from '@/pages/DesignSystemPage'
import { services, redEndpoints } from '@/data/services'
import { INFRA_SOURCES, infraHosts } from '@/data/observability'
import { TIME_PRESETS, DEFAULT_PRESET, rangeLabel } from '@/utils/timeRange'
import { filtersToChips } from '@/utils/tracesHandoff'
import { useTheme } from '@/hooks/useTheme'
import { parseRoute, canonicalUrl, routeUrl, serviceUrl, traceUrl, DEFAULT_SERVICE_TAB } from '@/utils/route'
import { traceViewFor } from '@/data/traceResolvers'
import { MOBILE_TRACES_SOURCE } from '@/utils/explorerSources'

function getInfraNavItems() {
  const items = []
  INFRA_SOURCES.forEach(s => {
    if (s.group) {
      s.children.forEach(c => items.push({ id: c.id, label: `${s.label} ${c.label}` }))
    } else {
      items.push({ id: s.id, label: s.label })
    }
  })
  return items
}
const INFRA_NAV_ITEMS = getInfraNavItems()

// Explore applies an incoming payload once per nonce (ARCH D13), so clicking
// the same card twice has to arrive as two different payloads.
let exploreNonce = 0
// The same for Errors: a second "open in Errors" for the same scope, while the
// page is already up, still has to land.
let errorsNonce = 0

// The views of one service, listed in the card's left column. Which service
// you are looking at is picked in the page itself, by ServicePicker.
export default function App() {
  const navigate = useNavigate()
  const location = useLocation()
  const { theme, setTheme } = useTheme()

  // Standalone reference route — always reachable, bypasses auth and the app shell.
  const isDesignSystem = location.pathname === '/design-system'

  const [loggedIn, setLoggedIn] = useState(() => {
    try {
      return localStorage.getItem('cubeapm-auth') === 'true'
    } catch {
      return false
    }
  })
  const [loadingIn, setLoadingIn] = useState(false)
  const [walkthroughOpen, setWalkthroughOpen] = useState(false)
  const [toast, setToast] = useState(null)
  // Page, service, tab and trace are read from the URL on every render and
  // changed only by navigating (utils/route), so a reload, a shared link and
  // Back/Forward all agree with the address bar.
  const currentUrl = location.pathname + location.search
  const route = parseRoute(location.pathname, location.search)
  const { view } = route
  // A link opened while signed out - an Errors URL pasted from a chat, say - is
  // where the user was going; the sign-in screen only stands in front of it.
  // Only a path that names a page counts: '/', '/home' and anything unknown
  // land on Home anyway, and '/design-system' sits outside the app, so
  // returning there would send a user who just left it straight back.
  const [returnTo, setReturnTo] = useState(() => (
    !loggedIn && route.view !== 'home' ? currentUrl : null
  ))
  const [logsQuery, setLogsQuery] = useState(null)
  const [tracesQuery, setTracesQuery] = useState(null)
  const [exploreIncoming, setExploreIncoming] = useState(null)
  const [errorsIncoming, setErrorsIncoming] = useState(null)
  const [navCollapsed, setNavCollapsed] = useState(true)
  // One range for the whole app, in the form the data layer reads:
  // { kind: 'preset', value: '1h' } or { kind: 'absolute', from, to }. Pages
  // pass it through to PageBar and resolve it for their own data; none of them
  // needs to know which form it is in.
  const [timeRange, setTimeRange] = useState({ kind: 'preset', value: DEFAULT_PRESET })
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState(null)
  const [serviceEndpoint, setServiceEndpoint] = useState('')
  // Which side the service page's Errors tab shows. Held here, not in the tab,
  // so a link that names one (the Errors drawer's "Open service" on a Client
  // group) lands on it even when the tab is already mounted.
  const [serviceErrorsSide, setServiceErrorsSide] = useState('server')
  const [infraSource, setInfraSource] = useState('host')
  const [infraHost, setInfraHost] = useState(null)
  // What a link asked for, whatever kind of resource that source drills into.
  const [infraResource, setInfraResource] = useState(null)
  const [infraExpanded, setInfraExpanded] = useState({})
  const [hiddenNavItems, setHiddenNavItems] = useState(() => new Set())

  // The service page remembers where it was left: APM in the sidebar reopens
  // it, picking another service keeps the tab, and the settings drawer still
  // names that service on other pages.
  const [lastService, setLastService] = useState(() => ({
    id: route.serviceId ?? services[0].id,
    tab: route.serviceSubTab ?? DEFAULT_SERVICE_TAB,
  }))
  useEffect(() => {
    if (route.view === 'service') setLastService({ id: route.serviceId, tab: route.serviceSubTab })
  }, [route.view, route.serviceId, route.serviceSubTab])
  const serviceId = route.serviceId ?? lastService.id
  const serviceSubTab = route.serviceSubTab ?? lastService.tab
  const traceId = route.traceId ?? ''
  // Which dataset the open trace belongs to. Only a mobile trace's route names
  // one; everything else is a backend trace.
  const traceDatasource = route.datasource ?? 'traces'

  // Pushing the URL you are already on would add an entry Back steps through
  // for nothing.
  const go = useCallback((url) => {
    if (url !== currentUrl) navigate(url)
  }, [currentUrl, navigate])

  // A page, by name. Already on it, nothing happens: its own query string (the
  // Errors page's filters) stays, and Back gets no entry for the click.
  const showView = useCallback((v) => {
    if (v === 'service') return go(serviceUrl(lastService.id, lastService.tab))
    const url = routeUrl({ view: v })
    if (location.pathname !== url) navigate(url)
  }, [go, lastService, location.pathname, navigate])

  const setServiceSubTab = useCallback((tab) => {
    go(serviceUrl(serviceId, tab))
  }, [go, serviceId])

  // The datasource travels in the URL beside the id, so a reload or a pasted
  // link looks the id up in the same store the click did.
  const openTrace = useCallback((id, datasource) => {
    go(traceUrl(id, datasource))
    setSettingsOpen(false)
  }, [go])

  // Kept in App because a link may cross pages: a record in Logs can send you
  // to a trace, a service or an infrastructure resource, and only App knows how
  // to reach all three.
  const openLink = useCallback((link) => {
    if (!link) return
    if (link.view === 'traces') {
      // A record's trace link names no dataset of its own, so a page whose
      // records are not backend spans (Mobile Traces) tags it on the way out.
      if (link.traceId) return openTrace(link.traceId, link.datasource)
      // A link that names what it wants to see arrives as chips, so Traces
      // opens already filtered to it and says so in its own query bar —
      // rather than on every span in the window with the filter lost on the way.
      const chips = filtersToChips(link.filters)
      if (chips.length) setTracesQuery({ chips })
      showView('traces')
      return
    }
    if (link.view === 'errors') {
      // Applied once per nonce, as Explore's payload is: the page reads its
      // scope from this when it arrives, not from the URL it is about to get.
      setErrorsIncoming({ ...link, nonce: ++errorsNonce })
      showView('errors')
      setSettingsOpen(false)
      return
    }
    if (link.view === 'service') {
      setServiceEndpoint(link.endpoint ?? '')
      setServiceErrorsSide(link.errorsSide === 'client' ? 'client' : 'server')
      go(serviceUrl(link.serviceId, link.subTab))
      return
    }
    if (link.view === 'explore') {
      // The payload travels whole; Explore reads it once and says so.
      setExploreIncoming({ ...link, nonce: ++exploreNonce })
      showView('explore')
      setSettingsOpen(false)
      return
    }
    if (link.view === 'infra') {
      setInfraSource(link.source)
      // A record names its resource the way its agent spelled it, which is not
      // always a host this source knows - a span's net.peer.name is the
      // database endpoint, not the box the collector scrapes. Drill in when the
      // name matches, and land on the source when it does not, rather than
      // selecting a host that is not there.
      const known = infraHosts.some(h => h.host === link.resource)
      setInfraHost(known ? link.resource : null)
      setInfraResource(link.resource ?? null)
      showView('infra')
    }
  }, [openTrace, go, showView])

  // Mobile Traces opens its trace ids as mobile traces: the table's trace_id
  // cell directly, and the drawer's "Open this trace" by tagging the link,
  // which names no dataset of its own. Every other link goes where it says.
  const openMobileTrace = useCallback((id) => openTrace(id, 'mobile'), [openTrace])
  const openMobileLink = useCallback((link) => {
    openLink(link?.view === 'traces' && link.traceId ? { ...link, datasource: 'mobile' } : link)
  }, [openLink])

  const openLogsForTrace = useCallback((id) => {
    setLogsQuery({ concept: 'traceId', field: 'trace_id', value: id })
    showView('logs')
  }, [showView])

  // Picking another service keeps the tab you are on, as the production app does.
  const selectService = useCallback((id) => {
    setServiceErrorsSide('server')
    go(serviceUrl(id, serviceSubTab))
    setSettingsOpen(false)
    setSettingsTab(null)
  }, [go, serviceSubTab])

  const goHome = useCallback(() => {
    setServiceErrorsSide('server')
    showView('home')
    setSettingsOpen(false)
    setSettingsTab(null)
  }, [showView])

  const openHelp = useCallback(() => {
    setToast('Help Center is not built yet. This was only a preview of the user journey.')
  }, [])

  const signIn = (firstTime) => {
    const target = returnTo ?? '/home'
    setReturnTo(null)
    setLoadingIn(true)
    setLoggedIn(true)
    // Replace rather than push: Back from here should not return to the
    // sign-in address, which would only bounce straight back.
    navigate(target, { replace: true })
    setTimeout(() => {
      setLoadingIn(false)
      if (firstTime) setWalkthroughOpen(true)
    }, 2000)
  }

  useEffect(() => {
    try {
      localStorage.setItem('cubeapm-auth', loggedIn ? 'true' : 'false')
    } catch (e) {
      console.error('Failed to save auth state:', e)
    }
  }, [loggedIn])

  // Signed out, every URL is the sign-in page at /. Signed in, the address is
  // corrected in place to its one spelling - / becomes /home, an unknown
  // service the first one - so Back never lands on a URL that redirects.
  // Nothing here follows a copy of the page held anywhere else: that is what
  // used to push you back to the page Back had just left.
  const targetUrl = loggedIn ? canonicalUrl(location.pathname, location.search) : '/'
  useEffect(() => {
    if (isDesignSystem) return
    if (currentUrl !== targetUrl) navigate(targetUrl, { replace: true })
  }, [isDesignSystem, currentUrl, targetUrl, navigate])

  if (isDesignSystem) {
    return <DesignSystemPage theme={theme} setTheme={setTheme} />
  }

  if (!loggedIn) {
    return <LoginPage onSignIn={signIn} theme={theme} setTheme={setTheme} />
  }

  const isService = view === 'service'
  const isLogs = view === 'logs'
  const isTraces = view === 'traces'
  const isMTraces = view === 'mtraces'
  const isInfra = view === 'infra'
  const isTrace = view === 'trace'
  const isExplore = view === 'explore'
  const isErrors = view === 'errors'

  return (
    <div className={`app${navCollapsed ? ' nav-collapsed' : ''}`}>
      <Sidebar
        navCollapsed={navCollapsed}
        setNavCollapsed={setNavCollapsed}
        // A mobile trace is the trace view under another list, so the sidebar
        // is told which one to keep lit.
        view={isTrace && traceDatasource === 'mobile' ? 'mtrace' : view}
        goHome={goHome}
        setView={showView}
        onOpenHelp={openHelp}
        onLogout={() => setLoggedIn(false)}
        theme={theme}
        setTheme={setTheme}
      />
      <div className="main">
        <div className={`surface-card${isInfra ? ' svc-view' : ''}`}>
          {isInfra && (
            <div className="svc-sidebar">
              <div className="svc-sidebar-label">Sources</div>
              {INFRA_SOURCES.map(s => {
                if (s.group) {
                  const open = !!infraExpanded[s.id]
                  return (
                    <div key={s.id}>
                      <div
                        className="svc-sidebar-item group-head"
                        onClick={() => setInfraExpanded(e => ({ ...e, [s.id]: !e[s.id] }))}
                      >
                        <InfraIcon id={s.id} />
                        <span className="svc-sidebar-name">{s.label}</span>
                        <svg className={`svc-sidebar-group-chev${open ? ' open' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
                      </div>
                      {open && (
                        <div className="svc-sidebar-children">
                          {s.children.filter(c => !hiddenNavItems.has(c.id)).map(c => (
                            <div
                              key={c.id}
                              className={`svc-sidebar-item svc-sidebar-child${infraSource === c.id ? ' active' : ''}`}
                              onClick={() => { setInfraSource(c.id); setInfraHost(null); setInfraResource(null) }}
                            >
                              <span className="svc-sidebar-name">{c.label}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                }
                if (hiddenNavItems.has(s.id)) return null
                const isActive = infraSource === s.id
                const count = s.id === 'host' ? infraHosts.length : s.count
                return (
                  <div
                    key={s.id}
                    className={`svc-sidebar-item${isActive ? ' active' : ''}${s.enabled ? '' : ' disabled'}`}
                    onClick={s.enabled ? () => { setInfraSource(s.id); setInfraHost(null); setInfraResource(null) } : undefined}
                    title={s.enabled ? s.label : `${s.label} - no data connected yet`}
                  >
                    <InfraIcon id={s.id} />
                    <span className="svc-sidebar-name">{s.label}</span>
                    {s.enabled && count != null && <span className="svc-sidebar-count">{count}</span>}
                  </div>
                )
              })}
            </div>
          )}
          <div className="card-scroll">
            {isService ? (
              <ServiceOverview
                serviceId={serviceId}
                onSelectService={selectService}
                onOpenTrace={openTrace}
                goHome={goHome}
                serviceSubTab={serviceSubTab}
                setServiceSubTab={setServiceSubTab}
                serviceEndpoint={serviceEndpoint}
                setServiceEndpoint={setServiceEndpoint}
                errorsSide={serviceErrorsSide}
                onErrorsSide={setServiceErrorsSide}
                setToast={setToast}
                onOpenLink={openLink}
                settingsOpen={settingsOpen}
                setSettingsOpen={setSettingsOpen}
                settingsTab={settingsTab}
                setSettingsTab={setSettingsTab}
                timeRange={timeRange}
                setTimeRange={setTimeRange}
              />
            ) : isTrace ? (
              <TraceDetail
                // Keyed on the dataset too: the same id in two datasets is two
                // different traces, and neither may inherit the other's state.
                key={`${traceDatasource}:${traceId}`}
                traceId={traceId}
                datasource={traceDatasource}
                goHome={goHome}
                goTraces={() => showView(traceViewFor(traceDatasource).listView)}
                goLogs={openLogsForTrace}
                timeRange={timeRange}
                setTimeRange={setTimeRange}
                settingsOpen={settingsOpen}
                setSettingsOpen={setSettingsOpen}
              />
            ) : isTraces ? (
              <TracesView
                // Keyed per page, as the Mobile Traces instance is: both are the
                // same component, and without a key React would hand one page's
                // query, columns and saved queries to the other.
                key="traces"
                goHome={goHome} timeRange={timeRange} setTimeRange={setTimeRange} setToast={setToast}
                onOpenLink={openLink}
                onOpenTrace={openTrace}
                incomingChip={tracesQuery}
                onIncomingChipApplied={() => setTracesQuery(null)}
              />
            ) : isMTraces ? (
              // The Mobile Traces explorer: the same page over the mobile
              // dataset. No incomingChip — tracesQuery is a handoff to the
              // backend Traces page, written in span fields.
              <TracesView
                key="mtraces"
                source={MOBILE_TRACES_SOURCE}
                goHome={goHome} timeRange={timeRange} setTimeRange={setTimeRange} setToast={setToast}
                onOpenLink={openMobileLink}
                onOpenTrace={openMobileTrace}
              />
            ) : isLogs ? (
              <LogsView
                goHome={goHome} timeRange={timeRange} setTimeRange={setTimeRange} setToast={setToast}
                onOpenLink={openLink}
                incomingChip={logsQuery}
                onIncomingChipApplied={() => setLogsQuery(null)}
              />
            ) : isExplore ? (
              <ExploreView
                goHome={goHome} timeRange={timeRange} setTimeRange={setTimeRange} setToast={setToast}
                incoming={exploreIncoming}
                onIncomingApplied={() => setExploreIncoming(null)}
              />
            ) : isErrors ? (
              <ErrorsView
                goHome={goHome} timeRange={timeRange} setTimeRange={setTimeRange} setToast={setToast}
                onOpenLink={openLink}
                onOpenTrace={openTrace}
                incoming={errorsIncoming}
                onIncomingApplied={() => setErrorsIncoming(null)}
              />
            ) : isInfra ? (
              <InfraView
                key={`${infraSource}:${infraResource ?? ''}`}
                goHome={goHome}
                source={infraSource}
                resource={infraResource}
                selectedHost={infraHost}
                setSelectedHost={setInfraHost}
                timeRange={timeRange}
                setTimeRange={setTimeRange}
                settingsOpen={settingsOpen}
                setSettingsOpen={setSettingsOpen}
              />
            ) : loadingIn ? (
              <HomeSkeleton />
            ) : (
              <HomePage selectService={selectService} timeRange={timeRange} setTimeRange={setTimeRange} />
            )}
          </div>
        </div>
      </div>
      {settingsOpen && (
        <>
          <div className="settings-backdrop open" onClick={() => { setSettingsOpen(false); setSettingsTab(null) }} />
          <SettingsDrawer
            view={view}
            serviceSubTab={serviceSubTab}
            serviceId={serviceId}
            settingsTab={settingsTab}
            setSettingsTab={setSettingsTab}
            onClose={() => { setSettingsOpen(false); setSettingsTab(null) }}
            timeRange={timeRange}
            hiddenNavItems={hiddenNavItems}
            setHiddenNavItems={setHiddenNavItems}
          />
        </>
      )}
      {walkthroughOpen && (
        <Walkthrough
          onFinish={() => setWalkthroughOpen(false)}
          onOpenHelp={openHelp}
        />
      )}
      {toast && <Toast message={toast} onClose={() => setToast(null)} />}
    </div>
  )
}

function SettingsDrawer({ view, serviceSubTab, serviceId, settingsTab, setSettingsTab, onClose, timeRange, hiddenNavItems, setHiddenNavItems }) {
  const isInfra = view === 'infra'

  const tabs = view === 'home'
    ? ['General', 'Notifications']
    : serviceSubTab === 'red'
      ? ['Display', 'Thresholds']
      : ['Apdex', 'Thresholds', 'Alerts']

  const activeTab = settingsTab && tabs.includes(settingsTab) ? settingsTab : tabs[0]

  useEffect(() => {
    if (isInfra) return
    if (!settingsTab || !tabs.includes(settingsTab)) {
      setSettingsTab(tabs[0])
    }
  }, [view, serviceSubTab])

  const svc = services.find(s => s.id === serviceId)

  return (
    <div className="settings-drawer open">
      <div className="drawer-header">
        <button className="drawer-close" onClick={onClose} aria-label="Close settings">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
        </button>
        <span className="drawer-title">Settings</span>
        {isInfra && <button className="drawer-done" onClick={onClose}>Done</button>}
      </div>
      {!isInfra && (
        <div className="drawer-tabs">
          {tabs.map(t => (
            <div key={t} className={`drawer-tab${t === activeTab ? ' active' : ''}`} onClick={() => setSettingsTab(t)}>{t}</div>
          ))}
        </div>
      )}
      <div className="drawer-body">
        {isInfra ? (
          <InfraNavSettings hiddenNavItems={hiddenNavItems} setHiddenNavItems={setHiddenNavItems} />
        ) : (
          <SettingsBody tab={activeTab} view={view} serviceSubTab={serviceSubTab} svc={svc} timeRange={timeRange} redEndpoints={redEndpoints} />
        )}
      </div>
    </div>
  )
}

function InfraNavSettings({ hiddenNavItems, setHiddenNavItems }) {
  const [search, setSearch] = useState('')
  const filtered = search
    ? INFRA_NAV_ITEMS.filter(i => i.label.toLowerCase().includes(search.toLowerCase()))
    : INFRA_NAV_ITEMS

  const toggle = (id) => {
    setHiddenNavItems(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <>
      <p className="drawer-description">Select the components you want to see in the navigation list.</p>
      <div className="drawer-links">
        <a onClick={() => setHiddenNavItems(new Set())}>Show All</a>
        <span>|</span>
        <a onClick={() => setHiddenNavItems(new Set(INFRA_NAV_ITEMS.map(i => i.id)))}>Hide All</a>
      </div>
      <div className="drawer-nav-search">
        <input placeholder="Search…" value={search} onChange={e => setSearch(e.target.value)} />
      </div>
      <div className="drawer-nav-list">
        {filtered.map(i => (
          <label key={i.id} className="drawer-nav-item">
            <input type="checkbox" checked={!hiddenNavItems.has(i.id)} onChange={() => toggle(i.id)} />
            <span>{i.label}</span>
          </label>
        ))}
        {filtered.length === 0 && <div className="drawer-nav-empty">No components match "{search}"</div>}
      </div>
    </>
  )
}

function SettingsBody({ tab, view, serviceSubTab, svc, timeRange, redEndpoints }) {
  if (view === 'home') {
    if (tab === 'General') return (
      <>
        <p className="drawer-description">Configure display and refresh preferences for the Home view.</p>
        <div className="drawer-section">
          <div className="drawer-section-label">Auto-refresh interval</div>
          <div className="drawer-row">
            <select className="drawer-select" defaultValue="1 minute">
              <option>Off</option><option>30 seconds</option><option>1 minute</option><option>5 minutes</option>
            </select>
            <button className="drawer-save">Save</button>
          </div>
        </div>
        <div className="drawer-section">
          <div className="drawer-section-label">Default time range</div>
          <div className="drawer-row">
            <select className="drawer-select" defaultValue={rangeLabel(timeRange)}>
              {TIME_PRESETS.map(p => <option key={p.value}>{p.label}</option>)}
            </select>
            <button className="drawer-save">Save</button>
          </div>
        </div>
        <div className="drawer-section">
          <div className="drawer-section-label">Services per page</div>
          <div className="drawer-row">
            <div className="drawer-input-wrap"><input type="number" defaultValue={50} /><span className="drawer-suffix">rows</span></div>
            <button className="drawer-save">Save</button>
          </div>
        </div>
      </>
    )
    if (tab === 'Notifications') return (
      <>
        <p className="drawer-description">Control where CubeAPM sends alert notifications. Webhook and PagerDuty settings apply globally.</p>
        <div className="drawer-section">
          <div className="drawer-section-label">Webhook URL</div>
          <div className="drawer-row">
            <div className="drawer-input-wrap" style={{ flex: 1 }}><input type="url" placeholder="https://hooks.example.com/…" style={{ width: '100%', fontFamily: "'JetBrains Mono',monospace", fontSize: '10.5px' }} /></div>
            <button className="drawer-save">Save</button>
          </div>
        </div>
        <div className="drawer-section">
          <div className="drawer-section-label">Notify on</div>
          <div className="drawer-row">
            <select className="drawer-select"><option>All status changes</option><option>Critical only</option><option>Warning + Critical</option></select>
            <button className="drawer-save">Save</button>
          </div>
        </div>
        <div className="drawer-section">
          <div className="drawer-section-label">Suppression window</div>
          <div className="drawer-row">
            <select className="drawer-select"><option>None</option><option>5 minutes</option><option>15 minutes</option><option>1 hour</option></select>
            <button className="drawer-save">Save</button>
          </div>
        </div>
      </>
    )
  }

  if (tab === 'Apdex') return (
    <>
      <p className="drawer-description">Thresholds are considered from most specific to least specific - if a threshold is set for a particular endpoint, other values are not considered for that endpoint. Setting a threshold to 0 effectively unsets it. A negative value means "remove from Apdex calculations".</p>
      <div className="drawer-section">
        <div className="drawer-section-label">Default Apdex Threshold</div>
        <div className="drawer-row">
          <div className="drawer-input-wrap"><input type="number" placeholder="300" /><span className="drawer-suffix">ms</span></div>
          <button className="drawer-save">Save</button>
        </div>
      </div>
      <div className="drawer-section">
        <div className="drawer-section-label">Default Apdex Threshold for Env</div>
        <select className="drawer-select"><option value="">UNSET</option><option>production</option><option>staging</option><option>development</option></select>
        <div className="drawer-row">
          <div className="drawer-input-wrap"><input type="number" placeholder="-" /><span className="drawer-suffix">ms</span></div>
          <button className="drawer-save">Save</button>
        </div>
      </div>
      <div className="drawer-section">
        <div className="drawer-section-label">Default Apdex Threshold for Service</div>
        <select className="drawer-select" defaultValue={svc?.id || ''}>
          <option value="">Select service</option>
          {services.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <div className="drawer-row">
          <div className="drawer-input-wrap"><input type="number" placeholder="-" /><span className="drawer-suffix">ms</span></div>
          <button className="drawer-save">Save</button>
        </div>
      </div>
      <div className="drawer-section">
        <div className="drawer-section-label">Apdex Threshold for Endpoint</div>
        <select className="drawer-select">
          <option value="">Select endpoint</option>
          {redEndpoints.map(e => <option key={e.endpoint}>{e.endpoint}</option>)}
        </select>
        <div className="drawer-row">
          <div className="drawer-input-wrap"><input type="number" placeholder="-" /><span className="drawer-suffix">ms</span></div>
          <button className="drawer-save">Save</button>
        </div>
      </div>
    </>
  )

  if (tab === 'Thresholds') {
    const isRed = serviceSubTab === 'red'
    const desc = isRed
      ? <>Per-service RED metric threshold overrides. These supersede the global defaults set in Overview → Thresholds.</>
      : <>Override latency and error rate thresholds for <strong style={{ color: 'var(--text-primary)', fontFamily: "'JetBrains Mono',monospace" }}>{svc?.name}</strong>. These values drive KPI card coloring and alert state.</>
    const fields = isRed
      ? [['Response time - Warning', 150, 'ms'], ['Response time - Critical', 300, 'ms'], ['Error rate - Warning', 1, '%'], ['Error rate - Critical', 3, '%']]
      : [['p90 Latency - Warning', 150, 'ms'], ['p90 Latency - Critical', 300, 'ms'], ['Error Rate - Warning', 1, '%'], ['Error Rate - Critical', 3, '%']]
    return (
      <>
        <p className="drawer-description">{desc}</p>
        {fields.map(([label, val, suffix]) => (
          <div className="drawer-section" key={label}>
            <div className="drawer-section-label">{label}</div>
            <div className="drawer-row">
              <div className="drawer-input-wrap"><input type="number" defaultValue={val} /><span className="drawer-suffix">{suffix}</span></div>
              <button className="drawer-save">Save</button>
            </div>
          </div>
        ))}
      </>
    )
  }

  if (tab === 'Alerts') return (
    <>
      <p className="drawer-description">Configure alert rules scoped to <strong style={{ color: 'var(--text-primary)', fontFamily: "'JetBrains Mono',monospace" }}>{svc?.name}</strong>. Alert state is derived from threshold breaches configured in the Thresholds tab.</p>
      <div className="drawer-section">
        <div className="drawer-section-label">Alert channel</div>
        <div className="drawer-row">
          <select className="drawer-select"><option>Email</option><option>Webhook</option><option>PagerDuty</option><option>Slack</option></select>
          <button className="drawer-save">Save</button>
        </div>
      </div>
      <div className="drawer-section">
        <div className="drawer-section-label">Suppression window</div>
        <div className="drawer-row">
          <select className="drawer-select"><option>None</option><option>5 minutes</option><option>15 minutes</option><option>1 hour</option></select>
          <button className="drawer-save">Save</button>
        </div>
      </div>
      <div className="drawer-section">
        <div className="drawer-section-label">Auto-resolve after</div>
        <div className="drawer-row">
          <select className="drawer-select"><option>Never</option><option>10 minutes</option><option>30 minutes</option><option>1 hour</option></select>
          <button className="drawer-save">Save</button>
        </div>
      </div>
    </>
  )

  if (tab === 'Display') return (
    <>
      <p className="drawer-description">Set default display preferences for the RED tab on <strong style={{ color: 'var(--text-primary)', fontFamily: "'JetBrains Mono',monospace" }}>{svc?.name}</strong>.</p>
      <div className="drawer-section">
        <div className="drawer-section-label">Default view</div>
        <div className="drawer-row">
          <select className="drawer-select"><option>Table</option><option>Graph</option></select>
          <button className="drawer-save">Save</button>
        </div>
      </div>
      <div className="drawer-section">
        <div className="drawer-section-label">Max endpoints shown</div>
        <div className="drawer-row">
          <div className="drawer-input-wrap"><input type="number" defaultValue={10} /><span className="drawer-suffix">rows</span></div>
          <button className="drawer-save">Save</button>
        </div>
      </div>
    </>
  )

  return (
    <div className="drawer-empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" width="22" height="22">
        <circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
      <div className="drawer-empty-title">No settings here yet</div>
      <div className="drawer-empty-sub">Settings for this tab will appear in a future update.</div>
    </div>
  )
}
