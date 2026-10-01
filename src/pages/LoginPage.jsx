import { useState } from 'react'
import { LogoIcon, LogoWordmark } from '@/components/layout/Logo'

// Same three choices as the account menu's Theme row, so the preference picked
// here is the one the app opens with.
const THEMES = [
  { id: 'light', label: 'Light', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg> },
  { id: 'dark', label: 'Dark', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg> },
  { id: 'auto', label: 'Auto', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg> },
]

export default function LoginPage({ onSignIn, theme, setTheme }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [loading, setLoading] = useState(false)
  const [firstTime, setFirstTime] = useState(true)

  const submit = (e) => {
    e.preventDefault()
    if (!email || !password) return
    setLoading(true)
    setTimeout(() => { setLoading(false); onSignIn?.(firstTime) }, 300)
  }

  return (
    <div className="login-shell">
      <div className="login-ambient" aria-hidden />

      {setTheme && (
        <div className="login-theme" role="group" aria-label="Theme">
          {THEMES.map(t => (
            <button
              key={t.id}
              type="button"
              className={theme === t.id ? 'on' : ''}
              aria-pressed={theme === t.id}
              title={t.id === 'auto' ? 'Follow your system setting' : `${t.label} theme`}
              onClick={() => setTheme(t.id)}
            >
              {t.icon}{t.label}
            </button>
          ))}
        </div>
      )}

      <div className="login-card">
        <div className="login-brand">
          <LogoIcon size={40} />
          <LogoWordmark height={22} />
        </div>

        <div className="login-heading">
          <div className="login-title">Welcome back</div>
          <div className="login-sub">Sign in to your CubeAPM workspace</div>
        </div>

        <form className="login-form" onSubmit={submit}>
          <label className="login-field">
            <span className="login-field-lbl">Email</span>
            <div className="login-input-wrap">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>
              <input
                type="email"
                autoComplete="email"
                placeholder="you@company.com"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
              />
            </div>
          </label>

          <label className="login-field">
            <span className="login-field-lbl">
              Password
              <a className="login-forgot" href="#" onClick={e => e.preventDefault()}>Forgot?</a>
            </span>
            <div className="login-input-wrap">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 018 0v4"/></svg>
              <input
                type={showPw ? 'text' : 'password'}
                autoComplete="current-password"
                placeholder="Enter your password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
              />
              <button
                type="button"
                className="login-pw-toggle"
                onClick={() => setShowPw(s => !s)}
                aria-label={showPw ? 'Hide password' : 'Show password'}
                tabIndex={-1}
              >
                {showPw ? (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0112 20c-7 0-11-8-11-8a20.34 20.34 0 015.06-5.94M9.9 4.24A10.94 10.94 0 0112 4c7 0 11 8 11 8a20.4 20.4 0 01-3.17 4.24M9.88 9.88a3 3 0 004.24 4.24M1 1l22 22"/></svg>
                ) : (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                )}
              </button>
            </div>
          </label>

          <button type="submit" className={`login-submit${loading ? ' loading' : ''}`} disabled={loading || !email || !password}>
            {loading ? (
              <span className="login-spinner" />
            ) : (
              <>Sign in <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 5l7 7-7 7"/></svg></>
            )}
          </button>
        </form>

        <div className="login-divider"><span>or continue with</span></div>

        <div className="login-sso">
          <button className="login-sso-btn" onClick={() => onSignIn?.(firstTime)}>
            <svg viewBox="0 0 24 24" width="14" height="14">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z"/>
            </svg>
            Google
          </button>
          <button className="login-sso-btn" onClick={() => onSignIn?.(firstTime)}>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.57.1.78-.25.78-.55v-2.02c-3.2.69-3.88-1.36-3.88-1.36-.52-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.28 1.19-3.08-.12-.29-.52-1.47.11-3.06 0 0 .97-.31 3.18 1.18a11 11 0 015.79 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.77.11 3.06.74.8 1.19 1.82 1.19 3.08 0 4.41-2.7 5.39-5.26 5.67.41.35.77 1.05.77 2.12v3.14c0 .3.21.66.79.55C20.21 21.39 23.5 17.08 23.5 12 23.5 5.65 18.35.5 12 .5z"/></svg>
            GitHub
          </button>
          <button className="login-sso-btn" onClick={() => onSignIn?.(firstTime)}>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/></svg>
            SSO
          </button>
        </div>

        <label className="login-first-time">
          <input type="checkbox" checked={firstTime} onChange={e => setFirstTime(e.target.checked)} />
          <span>Consider me as a first time user</span>
        </label>

        <div className="login-footer-note">
          Trouble signing in? <a href="#" onClick={e => e.preventDefault()}>Contact your CubeAPM admin</a>
        </div>
      </div>

      <div className="login-status">
        <span className="login-status-dot" />
        All systems operational
        <span className="login-status-sep">·</span>
        <a href="#" onClick={e => e.preventDefault()}>status.cubeapm.com</a>
      </div>
    </div>
  )
}
