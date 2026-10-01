import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { LogoIcon, LogoWordmark } from './Logo'

const ICONS = {
  home: <><path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/></>,
  pulse: <path d="M3 12h4l2 8 4-16 2 8h6"/>,
  logs: <><path d="M4 5h16M4 9h16M4 13h10M4 17h7"/></>,
  server: <><rect x="3" y="4" width="18" height="6" rx="1"/><rect x="3" y="14" width="18" height="6" rx="1"/><circle cx="7" cy="7" r=".7"/><circle cx="7" cy="17" r=".7"/></>,
  monitor: <><rect x="3" y="4" width="18" height="12" rx="1"/><path d="M8 20h8M12 16v4"/></>,
  branch: <><circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="9" r="2"/><path d="M6 8v8M6 8c0 5 6 3 12 1"/></>,
  triangle: <><path d="M12 3l9 17H3z"/><path d="M12 10v4M12 17v.01"/></>,
  dashboard: <><rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="5" rx="1"/><rect x="13" y="10" width="8" height="11" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/></>,
  compass: <><circle cx="12" cy="12" r="9"/><path d="M15 9l-2 6-6 2 2-6z"/></>,
  target: <><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r=".7"/></>,
  bell: <><path d="M6 10a6 6 0 1112 0c0 5 2 6 2 6H4s2-1 2-6"/><path d="M10 20a2 2 0 004 0"/></>,
  radio: <><circle cx="12" cy="12" r="2.2"/><path d="M7 9a6.5 6.5 0 000 6M17 9a6.5 6.5 0 010 6M4 5a11 11 0 000 14M20 5a11 11 0 010 14"/></>,
  shield: <path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/>,
  sliders: <><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></>,
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

const NAV_GROUPS = [
  { label: 'Workspace', items: [
    { id: 'home', label: 'Home', icon: 'home', enabled: true },
    { id: 'apm', label: 'APM & Services', icon: 'pulse', enabled: true },
    { id: 'logs', label: 'Logs', icon: 'logs', enabled: true },
    { id: 'infra', label: 'Infrastructure', icon: 'server', enabled: true },
    { id: 'rum', label: 'Browser (RUM)', icon: 'monitor' },
    { id: 'traces', label: 'Traces', icon: 'branch', enabled: true },
    { id: 'errors', label: 'Errors', icon: 'triangle' },
    { id: 'dash', label: 'Dashboards', icon: 'dashboard' },
  ]},
  { label: 'Analyze', items: [
    { id: 'explore', label: 'Explore', icon: 'compass' },
    { id: 'slo', label: 'SLOs', icon: 'target' },
    { id: 'alerts', label: 'Alerts', icon: 'bell' },
    { id: 'synthetic', label: 'Synthetic', icon: 'radio' },
  ]},
  { label: 'Manage', items: [
    { id: 'admin', label: 'Admin', icon: 'shield' },
    { id: 'settings', label: 'Controls', icon: 'sliders' },
  ]},
]

export default function Sidebar({ navCollapsed, setNavCollapsed, view, goHome, setView, onOpenHelp, onLogout, theme, setTheme }) {
  // A single trace's waterfall belongs to Traces, so the nav keeps that item lit
  // while you are inside one rather than jumping the highlight to APM.
  const activeId = view === 'home' ? 'home' : view === 'logs' ? 'logs'
    : view === 'traces' || view === 'trace' ? 'traces'
    : view === 'infra' ? 'infra' : 'apm'
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
              return (
                <div
                  key={it.id}
                  className={`nav-item${on ? ' active' : ''}${enabled ? '' : ' disabled'}`}
                  title={enabled ? it.label : `${it.label} - later redesign phase`}
                  onClick={enabled ? (it.id === 'home' ? goHome : it.id === 'apm' ? () => setView('service') : it.id === 'logs' ? () => setView('logs') : it.id === 'traces' ? () => setView('traces') : it.id === 'infra' ? () => setView('infra') : undefined) : undefined}
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
                  <div className="pop-sec-lbl">Settings</div>
                  <div className="pop-item">User preferences</div>
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
