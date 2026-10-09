import { useState, useMemo, useRef, useCallback, useEffect, useLayoutEffect } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { PanelsTopLeft, ArrowLeftRight, Activity, TriangleAlert, TextSearch } from 'lucide-react'
import { resolveWindow } from '@/data/timeWindow'
import { browserAppsForWindow, browserEndpointOptions, browserErrorOptions } from '@/data/browser'
import { BROWSER_PATH, BROWSER_TABS, BROWSER_KINDS, parseBrowserSearch, browserSearch } from '@/utils/browserUrl'
import { sameSearch } from '@/utils/searchParams'
import { rumExploreQuery } from '@/data/explore/eventsStore'
import PageBar from '@/components/layout/PageBar'
import ServicePicker from '@/components/ServicePicker'
import FilterSelect from '@/components/shared/FilterSelect'
import { CardActionContext } from '@/components/CardMenu'
import { useScrollReveal, revealClass } from '@/hooks/useScrollReveal'
import PageViewsTab from '@/components/browser/PageViewsTab'
import AjaxCallsTab from '@/components/browser/AjaxCallsTab'
import WebVitalsTab from '@/components/browser/WebVitalsTab'
import BrowserErrorsTab from '@/components/browser/BrowserErrorsTab'
import BrowserTracesTab from '@/components/browser/BrowserTracesTab'
import '@/components/browser/browser.css'

// Which tabs there are, and their order, is BROWSER_TABS in utils/browserUrl -
// the list a ?tab= is checked against - so the strip cannot offer a tab the URL
// cannot name. The labels are production's; Errors keeps the icon it has on the
// service page, and Traces the sidebar's Traces glyph.
const TAB_META = {
  pageviews: { label: 'Page Views', Icon: PanelsTopLeft },
  'ajax-calls': { label: 'Ajax Calls', Icon: ArrowLeftRight },
  'web-vitals': { label: 'Web Vitals', Icon: Activity },
  errors: { label: 'Errors', Icon: TriangleAlert },
  traces: { label: 'Traces', Icon: TextSearch },
}
const TAB_STRIP = BROWSER_TABS.map(id => ({ id, ...TAB_META[id] }))
// The tab strip names the body it controls, and the body says which tab it is.
const tabId = id => `brw-tab-${id}`
const PANEL_ID = 'brw-tab-panel'

// The URL says server|client, production's values, so a pasted link still
// reads; the Type filter says what they mean in a browser (BROWSER_KINDS).
const KIND_LABEL = Object.fromEntries(BROWSER_KINDS.map(k => [k.id, k.label]))
const KIND_FOR_LABEL = Object.fromEntries(BROWSER_KINDS.map(k => [k.label, k.id]))
const KIND_OPTIONS = BROWSER_KINDS.map(k => k.label)

// How long a refresh dims the tab. The data is read synchronously, so without
// it ↻ would do nothing visible and read as broken; with a backend this is
// where the request's own round trip goes. The Errors page's figure.
const REFRESH_MS = 280

// A filter value the list does not offer - a pasted link's endpoint that this
// range never saw, an error class from another week - is still the filter in
// force, so it stays in the list, shown as chosen, rather than the select
// claiming nothing is picked while the traces below say otherwise.
const withValue = (options, value) => (value && !options.includes(value) ? [...options, value] : options)

/**
 * Browser (RUM): what real users' browsers saw of the storefront and the back
 * office - page loads, the Ajax calls the pages made, Core Web Vitals, the
 * script and Ajax errors, and the traces behind them.
 *
 * The frame is the service page's, piece for piece: the same bar, the same
 * picker over a tab strip, the same scroller with the same sticky strip on the
 * one tab that filters by endpoint. A reader who knows one page knows this one.
 *
 * Everything the page is showing - which app, which tab, Graph or Table, Script
 * or Ajax, the Traces filters - is the URL, in production's own dialect
 * (utils/browserUrl), and nowhere else. It is parsed on every render and
 * changed only by navigating, so Back, a reload and a link pasted out of
 * production all land on the same screen. Moving to another app or tab is a
 * step Back undoes, so it pushes; flipping Graph|Table or a filter refines the
 * screen you are on, so it replaces, and Back leaves the page rather than
 * walking through every click.
 */
export default function BrowserView({
  goHome, timeRange, setTimeRange, settingsOpen, setSettingsOpen, setToast,
  onOpenLink, onOpenTrace, sourceMaps, onOpenSettingsTab,
}) {
  const location = useLocation()
  const navigate = useNavigate()

  const win = useMemo(() => resolveWindow(timeRange), [timeRange])
  // Most severe first (rule 3): the picker lists them in this order, and an
  // address that names no app - or one that is gone - opens on the first.
  const apps = useMemo(() => browserAppsForWindow(win), [win])
  const appIds = useMemo(() => apps.map(a => a.id), [apps])

  // ---- the URL is the state ----

  const state = useMemo(() => parseBrowserSearch(location.search, appIds), [location.search, appIds])
  const { tab, view, kind, endpoint, error } = state
  const app = apps.find(a => a.id === state.service) ?? apps[0]

  // A link's time preset is the range everything else is read for, so it is
  // applied before the first paint - after it, the page would draw an hour and
  // then redraw a week. Read once, on arrival, before the correcting write
  // below takes it out of the address; after that the range is the app's.
  const [initialTime] = useState(() => (
    location.pathname === BROWSER_PATH ? parseBrowserSearch(location.search).time : null
  ))
  const hydrated = useRef(false)
  useLayoutEffect(() => {
    if (hydrated.current) return
    hydrated.current = true
    if (initialTime) setTimeRange({ kind: 'preset', value: initialTime })
  }, [initialTime, setTimeRange])

  // The address is corrected in place to its one spelling: a bare /browser
  // gains the app it opened on, production's link loses the keys this page
  // does not read (index, name, refresh, time) and has its own put in order.
  // Replace, never push, so Back does not land on a URL that only redirects.
  // Only while the address is ours - the page can render once more for a
  // location App is already taking elsewhere, and writing then would rewrite
  // the page being opened. Writing the parse of what it reads, it settles
  // after one write (browserUrl.test.js checks the fixed point).
  const canonical = browserSearch(state)
  useEffect(() => {
    if (location.pathname !== BROWSER_PATH) return
    if (sameSearch(canonical, location.search)) return
    navigate(BROWSER_PATH + canonical, { replace: true })
  }, [canonical, location.pathname, location.search, navigate])

  const update = useCallback((patch, { replace = false } = {}) => {
    const next = browserSearch({ ...state, ...patch })
    // Pushing the screen you are already on would give Back a step that
    // changes nothing.
    if (sameSearch(next, location.search)) return
    navigate(BROWSER_PATH + next, { replace })
  }, [state, location.search, navigate])

  // ---- moving around: push ----

  const selectTab = useCallback(id => update({ tab: id }), [update])
  // The Traces filters name one app's routes and calls, so they do not carry
  // over to another app; Graph|Table and Script|Ajax do.
  const selectApp = useCallback(id => update({ service: id, endpoint: '', error: '' }), [update])
  // The Errors tab's row: production's ↗, the Traces tab filtered to that
  // row's errors - a new screen, so Back returns to the list it came from.
  // The row's kind is the parsed one the tab was handed, so it goes on as it
  // is; browserSearch writes anything but 'client' as the default anyway.
  const openTraces = useCallback(({ kind: k, endpoint: ep, error: err }) => update({
    tab: 'traces', kind: k, endpoint: ep ?? '', error: err ?? '',
  }), [update])

  // ---- refining the screen: replace ----

  const setView = useCallback(v => update({ view: v }, { replace: true }), [update])

  // Script and Ajax are different endpoints and different errors, so a filter
  // picked for one is dropped when the other is chosen - production keeps the
  // stale error and answers "No results", which is the bug this fixes. The
  // Errors tab's toggle and the Traces tab's Type are the same URL key, so
  // both go through here.
  const setKind = useCallback((next) => {
    if (next === kind) return
    const ep = browserEndpointOptions(app.id, next).includes(endpoint) ? endpoint : ''
    const err = browserErrorOptions(win, app.id, next, ep || null).includes(error) ? error : ''
    update({ kind: next, endpoint: ep, error: err }, { replace: true })
  }, [kind, endpoint, error, app.id, win, update])

  // An endpoint that never threw the chosen error would only answer "No
  // results", so the error goes with it; one it did throw is kept.
  const setEndpoint = useCallback((next) => {
    const keep = !error || browserErrorOptions(win, app.id, kind, next || null).includes(error)
    update({ endpoint: next, error: keep ? error : '' }, { replace: true })
  }, [error, win, app.id, kind, update])

  const setError = useCallback(next => update({ error: next }, { replace: true }), [update])
  const clearFilters = useCallback(() => update({ endpoint: '', error: '' }, { replace: true }), [update])

  // The Traces tab's filter lists. Only that tab draws them, so only it pays
  // for the error tally.
  const onTraces = tab === 'traces'
  const endpointOptions = useMemo(
    () => (onTraces ? withValue(browserEndpointOptions(app.id, kind), endpoint) : []),
    [onTraces, app.id, kind, endpoint],
  )
  const errorOptions = useMemo(
    () => (onTraces ? withValue(browserErrorOptions(win, app.id, kind, endpoint || null), error) : []),
    [onTraces, win, app.id, kind, endpoint, error],
  )

  // ---- links out ----

  // The trace page names where it was opened from, so its trail leads back
  // to this exact screen - app, tab, filters - rather than to the Traces
  // explorer, and the sidebar keeps Browser lit while you are in it.
  //
  // The Traces tab also hands over its place - how many results, which
  // request was open - which the URL does not hold (production keeps them out
  // of it too). It goes into this history entry's state, so Back finds the
  // list as it was left, and rides along with the origin, so the trace page's
  // Browser crumb does too.
  const openTrace = useCallback((id, place) => {
    const url = location.pathname + location.search
    const state = place ? { brwTraces: place } : undefined
    if (state) navigate(url, { replace: true, state: { ...(location.state ?? {}), ...state } })
    onOpenTrace?.(id, { view: 'browser', label: 'Browser', url, state })
  }, [onOpenTrace, navigate, location.pathname, location.search, location.state])
  // Where the Traces tab was left, when this entry was left for a trace.
  const tracesPlace = location.state?.brwTraces ?? null

  const openSourceMaps = useCallback(() => onOpenSettingsTab?.('Source Maps'), [onOpenSettingsTab])

  const goHomeLink = (e) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    goHome?.()
  }

  // The card menus offer what production's do. Explore is built, so its items
  // open it on this app's RUM events, the browser's own log stream - the query
  // comes from the events store (rumExploreQuery), which knows whose events it
  // holds. Only the storefront has events there yet; for the back office the
  // item says so rather than opening an empty chart. The rest - alerts,
  // comparison, CSV - are screens this prototype does not have yet, and the
  // toast says so rather than the menu doing nothing.
  const onCardAction = useCallback((action, title) => {
    if (/^Explore\b/.test(String(action ?? ''))) {
      const query = rumExploreQuery(app.id)
      if (query) {
        onOpenLink?.({ view: 'explore', datasource: 'vlogs', query })
      } else {
        setToast?.(`${action} · ${title} - ${app.name}'s RUM events are not in Explore in this prototype yet.`)
      }
      return
    }
    setToast?.(`${action} · ${title} - that screen is not part of this prototype yet.`)
  }, [onOpenLink, setToast, app.id, app.name])

  // ---- refresh ----

  const [refreshing, setRefreshing] = useState(false)
  // The interval chosen in the bar's Auto control. The bar runs the timer; the
  // page only remembers the choice while it is open, as Explore does.
  const [autoRefresh, setAutoRefresh] = useState(0)
  const refreshTimer = useRef(null)
  const refresh = useCallback(() => {
    clearTimeout(refreshTimer.current)
    setRefreshing(true)
    refreshTimer.current = setTimeout(() => setRefreshing(false), REFRESH_MS)
  }, [])
  useEffect(() => () => clearTimeout(refreshTimer.current), [])

  // ---- the scroller ----

  // The Traces filter strip slides away while the list scrolls down and comes
  // back on the way up, as the service page's Endpoint strip does. A new tab
  // or app is new content under it, so the scroller starts again from the top
  // and the strip from its place.
  const bodyKey = `${app.id}:${tab}`
  const { reveal, onScroll } = useScrollReveal(bodyKey)
  const mainRef = useRef(null)
  useLayoutEffect(() => {
    if (mainRef.current) mainRef.current.scrollTop = 0
  }, [bodyKey])

  // A new tab body replaces the old one, and with it whatever control had
  // focus — an Errors row's button that handed off to Traces, say. Focus that
  // falls to the document is put on the tab now showing, so a keyboard reader
  // goes on from the strip rather than from the top of the page. Not on the
  // first render: the page opening is not a move to put focus anywhere.
  const tabRefs = useRef({})
  const shownBody = useRef(bodyKey)
  useEffect(() => {
    if (shownBody.current === bodyKey) return
    shownBody.current = bodyKey
    const at = document.activeElement
    if (!at || at === document.body) tabRefs.current[tab]?.focus()
  }, [bodyKey, tab])

  // The tab strip is one Tab stop; the arrows, Home and End move along it, and
  // Enter or Space opens the tab (a new screen, so it is not done on arrow).
  const onTabKeyDown = (e) => {
    const ids = TAB_STRIP.map(t => t.id)
    const i = ids.indexOf(document.activeElement?.dataset?.tab ?? tab)
    const to = e.key === 'ArrowRight' ? (i + 1) % ids.length
      : e.key === 'ArrowLeft' ? (i - 1 + ids.length) % ids.length
        : e.key === 'Home' ? 0
          : e.key === 'End' ? ids.length - 1
            : null
    if (to == null) return
    e.preventDefault()
    tabRefs.current[ids[to]]?.focus()
  }

  // One syncId per tab: hovering any chart lines up the cursor on the others.
  const syncId = `rum-${tab}`

  let body
  if (tab === 'pageviews' || tab === 'ajax-calls' || tab === 'web-vitals') {
    const Tab = tab === 'pageviews' ? PageViewsTab : tab === 'ajax-calls' ? AjaxCallsTab : WebVitalsTab
    body = (
      <Tab
        key={bodyKey}
        app={app} win={win} timeRange={timeRange} syncId={syncId} onFocus={setTimeRange}
        view={view} onView={setView}
      />
    )
  } else if (tab === 'errors') {
    body = (
      <BrowserErrorsTab
        key={bodyKey}
        app={app} win={win} timeRange={timeRange} syncId={syncId} onFocus={setTimeRange}
        kind={kind} onKind={setKind} onOpenTraces={openTraces}
        sourceMaps={sourceMaps} onOpenSourceMaps={openSourceMaps}
      />
    )
  } else {
    body = (
      <BrowserTracesTab
        key={bodyKey}
        app={app} win={win} kind={kind} endpoint={endpoint} error={error}
        onOpenTrace={openTrace} onClearFilters={clearFilters}
        sourceMaps={sourceMaps} onOpenSourceMaps={openSourceMaps}
        place={tracesPlace}
      />
    )
  }

  return (
    <CardActionContext.Provider value={onCardAction}>
      <PageBar
        timeRange={timeRange}
        setTimeRange={setTimeRange}
        showSettings
        settingsOpen={settingsOpen}
        setSettingsOpen={setSettingsOpen}
        onRefresh={refresh}
        refreshing={refreshing}
        autoRefresh={autoRefresh}
        onAutoRefreshChange={setAutoRefresh}
      >
        {/* A real link, so it is in the Tab order and read as one; a plain
            click goes Home in the app, while a modified one (new tab,
            new window) is left to the browser, which can open "/" itself. */}
        <a href="/" onClick={goHomeLink}>CubeAPM</a>
        <span className="sep">/</span>
        <span className="current">Browser</span>
      </PageBar>
      <div className="card-tab-strip">
        <div className="subtab-row">
          <div className="subtab-left">
            <ServicePicker serviceId={app.id} onSelect={selectApp} items={apps} label="Service" noun="app" idPrefix="brw-app" />
          </div>
          {/* Production's Type and Error filters, beside the picker as the
              service page's Category/Host/Version are. Only the Traces tab
              is filtered by them; Endpoint has the sticky strip below. */}
          {onTraces && (
            <div className="subtab-filters">
              <FilterSelect
                label="Type"
                value={KIND_LABEL[kind]}
                options={KIND_OPTIONS}
                onSelect={label => setKind(KIND_FOR_LABEL[label] ?? 'server')}
              />
              <FilterSelect
                label="Error"
                value={error}
                options={errorOptions}
                onSelect={setError}
                placeholder="All errors"
                clearLabel="All errors"
              />
            </div>
          )}
        </div>
        <div className="view-tabs" role="tablist" aria-label="Browser views" onKeyDown={onTabKeyDown}>
          {TAB_STRIP.map(({ Icon, ...t }) => (
            <button
              key={t.id}
              ref={el => { tabRefs.current[t.id] = el }}
              id={tabId(t.id)}
              data-tab={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              aria-controls={PANEL_ID}
              tabIndex={tab === t.id ? 0 : -1}
              className={`view-tab${tab === t.id ? ' active' : ''}`}
              onClick={() => selectTab(t.id)}
            >
              <Icon size={14} strokeWidth={1.75} aria-hidden="true" />
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <div
        ref={mainRef}
        id={PANEL_ID}
        role="tabpanel"
        aria-labelledby={tabId(tab)}
        className={`svc-main${refreshing ? ' brw-stale' : ''}`}
        aria-busy={refreshing || undefined}
        onScroll={onScroll}
      >
        {onTraces && (
          // brw-strip: slid away, it still comes back for a keyboard that
          // reaches its select (browser.css).
          <div className={`endpoint-strip is-sticky brw-strip${revealClass(reveal)}`}>
            <FilterSelect
              className="is-endpoint"
              label="Endpoint"
              value={endpoint}
              options={endpointOptions}
              onSelect={setEndpoint}
              placeholder="All endpoints"
              clearLabel="All endpoints"
            />
          </div>
        )}
        {body}
      </div>
    </CardActionContext.Provider>
  )
}
