import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { LogoIcon, LogoWordmark } from './Logo'

const ICONS = {
  home: <><path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/></>,
  pulse: <path d="M3 12h4l2 8 4-16 2 8h6"/>,
  fileSearch: <><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M4.268 21a2 2 0 0 0 1.727 1H18a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v3"/><path d="m9 18-1.5-1.5"/><circle cx="5" cy="14" r="3"/></>,
  server: <><rect x="3" y="4" width="18" height="6" rx="1"/><rect x="3" y="14" width="18" height="6" rx="1"/><circle cx="7" cy="7" r=".7"/><circle cx="7" cy="17" r=".7"/></>,
  appWindow: <><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M10 4v4"/><path d="M2 8h20"/><path d="M6 4v4"/></>,
  textSearch: <><path d="M21 6H3"/><path d="M10 12H3"/><path d="M10 18H3"/><circle cx="17" cy="15" r="3"/><path d="m21 19-1.9-1.9"/></>,
  phoneCode: <><rect x="5" y="2" width="14" height="20" rx="2"/><path d="M10 9.5 8 12l2 2.5"/><path d="M14 9.5 16 12l-2 2.5"/></>,
  flame: <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>,
  bug: <><path d="m8 2 1.88 1.88"/><path d="M14.12 3.88 16 2"/><path d="M9 7.13v-1a3.003 3.003 0 1 1 6 0v1"/><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6"/><path d="M12 20v-9"/><path d="M6.53 9C4.6 8.8 3 7.1 3 5"/><path d="M6 13H2"/><path d="M3 21c0-2.1 1.7-3.9 3.8-4"/><path d="M20.97 5c0 2.1-1.6 3.8-3.5 4"/><path d="M22 13h-4"/><path d="M17.2 17c2.1.1 3.8 1.9 3.8 4"/></>,
  phone: <><rect x="5" y="2" width="14" height="20" rx="2"/><path d="M12 18h.01"/></>,
  dashboard: <><rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="5" rx="1"/><rect x="13" y="10" width="8" height="11" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/></>,
  compass: <><circle cx="12" cy="12" r="9"/><path d="M15 9l-2 6-6 2 2-6z"/></>,
  target: <><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r=".7"/></>,
  bell: <><path d="M6 10a6 6 0 1112 0c0 5 2 6 2 6H4s2-1 2-6"/><path d="M10 20a2 2 0 004 0"/></>,
  bot: <><path d="M12 8V4H8"/><rect x="4" y="8" width="16" height="12" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></>,
  scanSearch: <><path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="12" r="3"/><path d="m16 16-1.9-1.9"/></>,
  help: <><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></>,
  chevLeft: <path d="M15 18l-6-6 6-6"/>,
  chevRight: <path d="M9 6l6 6-6 6"/>,
}

function Icon({ name, className }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      {ICONS[name]}
    </svg>
  )
}

// Home, then the production app's list in its order, mostly with its short
// labels. `title` spells out the short ones in the hover text, where there is
// room for it.
const NAV_GROUPS = [
  { label: 'Workspace', items: [
    { id: 'home', label: 'Home', icon: 'home', enabled: true },
    { id: 'services', label: 'APM & Services', icon: 'pulse', enabled: true },
    { id: 'logs', label: 'Logs', icon: 'fileSearch', enabled: true },
    { id: 'infra', label: 'Infrastructure', icon: 'server', enabled: true },
    { id: 'rum', label: 'Browser', title: 'Browser (RUM)', icon: 'appWindow' },
    { id: 'traces', label: 'Traces', icon: 'textSearch', enabled: true },
    { id: 'mtraces', label: 'MTraces', title: 'Mobile Traces', icon: 'phoneCode', enabled: true },
    { id: 'profiles', label: 'Profiles', icon: 'flame' },
    { id: 'errors', label: 'Errors', icon: 'bug', enabled: true },
    { id: 'mobile', label: 'Mobile', icon: 'phone' },
    { id: 'dash', label: 'Dash', title: 'Dashboards', icon: 'dashboard' },
  ]},
  { label: 'Analyze', items: [
    { id: 'explore', label: 'Explore', icon: 'compass', enabled: true },
    { id: 'slo', label: 'SLO', title: 'SLOs', icon: 'target' },
    { id: 'alerts', label: 'Alerts', icon: 'bell' },
    { id: 'monitors', label: 'Monitors', title: 'Synthetic Monitors', icon: 'bot' },
    { id: 'investigation', label: 'Investigation', icon: 'scanSearch' },
  ]},
]

// The view each enabled item opens. Home is the exception: it goes through
// goHome, which also closes the settings drawer. APM & Services opens the service
// page, on the service and tab it was last left on.
const NAV_VIEWS = {
  services: 'service',
  logs: 'logs',
  infra: 'infra',
  traces: 'traces',
  mtraces: 'mtraces',
  errors: 'errors',
  explore: 'explore',
}

// `trace` and `mtrace` are the one trace view seen from its two datasets: App
// hands over `mtrace` while a mobile trace is open, so the item lit is the list
// the trace was opened from.
const ACTIVE_ITEM = {
  home: 'home', service: 'services',
  logs: 'logs', infra: 'infra', traces: 'traces', trace: 'traces',
  mtraces: 'mtraces', mtrace: 'mtraces',
  errors: 'errors', explore: 'explore',
}

export default function Sidebar({ navCollapsed, setNavCollapsed, view, goHome, setView, onOpenHelp, onLogout, theme, setTheme }) {
  // A single trace's waterfall belongs to the list it was opened from — Traces,
  // or Mobile Traces for a device's request — so the nav keeps that item lit
  // while you are inside one rather than moving the highlight.
  const activeId = ACTIVE_ITEM[view] ?? 'services'
  const [profileOpen, setProfileOpen] = useState(false)
  const [popPos, setPopPos] = useState({ left: 0, bottom: 0 })
  const btnRef = useRef(null)

  useEffect(() => {
    if (!profileOpen) return
    const handler = (e) => {
      if (!e.target.closest('.nav-profile-btn') && !e.target.closest('.nav-pop')) {
        setProfileOpen(false)
      }
    }
    document.addEventListener('click', handler)
    return () => document.removeEventListener('click', handler)
  }, [profileOpen])

  function openProfile(e) {
    e.stopPropagation()
    if (!profileOpen && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect()
      setPopPos({ left: r.left, bottom: window.innerHeight - r.top + 8 })
    }
    setProfileOpen(o => !o)
  }

  return (
    <nav className="nav">
      <div className="nav-top">
        <LogoIcon size={28} />
        <span className="nav-wordmark"><LogoWordmark height={16} /></span>
      </div>
      <div className="nav-scroll">
        {NAV_GROUPS.map(g => (
          <div key={g.label}>
            <div className="nav-group-label"><span>{g.label}</span></div>
            {g.items.map(it => {
              const on = it.id === activeId
              const enabled = !!it.enabled
              const open = !enabled ? undefined
                : it.id === 'home' ? goHome
                : NAV_VIEWS[it.id] ? () => setView(NAV_VIEWS[it.id])
                : undefined
              return (
                <div
                  key={it.id}
                  className={`nav-item${on ? ' active' : ''}${enabled ? '' : ' disabled'}`}
                  title={enabled ? (it.title ?? it.label) : `${it.title ?? it.label} - later redesign phase`}
                  onClick={open}
                  // Focusable already, so it has to answer the keys a focused
                  // control answers; without this Tab reached an item that
                  // Enter could not open.
                  onKeyDown={open ? (e) => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open() }
                  } : undefined}
                  role={enabled ? 'link' : undefined}
                  aria-current={on ? 'page' : undefined}
                  tabIndex={enabled ? 0 : undefined}
                >
                  <Icon name={it.icon} />
                  <span className="nav-text">{it.label}</span>
                </div>
              )
            })}
          </div>
        ))}
      </div>
      <div className="nav-bottom">
        <div className="nav-user-row">
          <button
            className="nav-user-btn help-btn"
            onClick={() => onOpenHelp?.()}
            title="Help and documentation"
            aria-label="Help and documentation"
          >
            <Icon name="help" />
            <span className="nav-text">Help</span>
          </button>
          <div>
            <button
              ref={btnRef}
              className={`nav-user-btn nav-profile-btn${profileOpen ? ' active' : ''}`}
              onClick={openProfile}
              title="Account"
              aria-label="Account menu"
            >
              <span className="nav-avatar">S</span>
              <span className="nav-text">Account</span>
            </button>
            {profileOpen && createPortal(
              <div
                className="pop nav-pop"
                style={{ position: 'fixed', left: popPos.left, bottom: popPos.bottom, top: 'auto', right: 'auto' }}
                onClick={e => e.stopPropagation()}
              >
                <div className="pop-head">
                  <div className="pop-name">CubeAPM <span className="pop-plan">Full platform</span></div>
                  <div className="pop-email">tech@cubeapm.com</div>
                </div>
                <div className="pop-sec">
                  <div className="pop-sec-lbl">Profile</div>
                  <div className="pop-item">User preferences</div>
                  <div className="pop-item">Settings</div>
                  <div className="pop-item">Theme <span className="theme-seg">
                    {['light', 'dark', 'auto'].map(t => (
                      <span
                        key={t}
                        className={theme === t ? 'on' : ''}
                        onClick={() => setTheme?.(t)}
                        style={{ cursor: 'pointer', textTransform: 'capitalize' }}
                      >{t}</span>
                    ))}
                  </span></div>
                </div>
                <div className="pop-sec">
                  <div className="pop-sec-lbl">Manage</div>
                  <div className="pop-item">Administration</div>
                  <div className="pop-item">API keys</div>
                  <div className="pop-item">Manage your plan</div>
                </div>
                <div className="pop-sec"><div className="pop-item danger" onClick={() => { setProfileOpen(false); onLogout?.() }}>Log out</div></div>
              </div>,
              document.body
            )}
          </div>
        </div>
        <button className="nav-collapse" onClick={() => setNavCollapsed(c => !c)} aria-label={navCollapsed ? 'Expand navigation' : 'Collapse navigation'}>
          <Icon name={navCollapsed ? 'chevRight' : 'chevLeft'} />
          <span className="nav-text">{navCollapsed ? 'Expand' : 'Collapse'}</span>
        </button>
      </div>
    </nav>
  )
}
