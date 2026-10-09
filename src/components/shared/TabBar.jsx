import { clsx } from 'clsx'

/**
 * Compact pill tab bar - the one tab pattern on the platform.
 *
 * It renders the .tabbar / .tab classes from the stylesheet rather than
 * carrying its own utility styling. There used to be two tab looks that drifted
 * apart: this component for Alerts, Settings, Logs and Metrics, and the same
 * markup written by hand on Home. Both now read from one rule, so a change to
 * the selected pill lands everywhere at once.
 *
 * `idPrefix` makes it a full tablist for a caller whose panels can carry ids:
 * each tab gets `${idPrefix}-tab-<id>` and points at its panel,
 * `${idPrefix}-panel-<id>` (the caller puts that id on the panel), and the
 * arrow keys, Home and End move between the tabs and open them, with only the
 * open tab in the Tab order. Without it the bar is exactly what it was.
 */
export default function TabBar({ tabs, active, onChange, className = '', ariaLabel, idPrefix }) {
  const onKeyDown = idPrefix ? (e) => {
    const i = tabs.findIndex(t => t.id === active)
    const to = e.key === 'ArrowRight' ? (i + 1) % tabs.length
      : e.key === 'ArrowLeft' ? (i - 1 + tabs.length) % tabs.length
        : e.key === 'Home' ? 0
          : e.key === 'End' ? tabs.length - 1
            : null
    if (to == null || !tabs[to]) return
    e.preventDefault()
    onChange(tabs[to].id)
    // The tab is still the old one's button until the change renders, so the
    // new one is found by its id once it has.
    requestAnimationFrame(() => document.getElementById(`${idPrefix}-tab-${tabs[to].id}`)?.focus())
  } : undefined
  return (
    <div className={clsx('tabbar', className)} role="tablist" aria-label={ariaLabel} onKeyDown={onKeyDown}>
      {tabs.map(tab => (
        <button
          key={tab.id}
          {...(idPrefix ? {
            id: `${idPrefix}-tab-${tab.id}`,
            'aria-controls': `${idPrefix}-panel-${tab.id}`,
            tabIndex: active === tab.id ? 0 : -1,
          } : null)}
          type="button"
          role="tab"
          aria-selected={active === tab.id}
          className={clsx('tab', active === tab.id && 'active')}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
          {tab.count != null && <span className="tab-count">{tab.count}</span>}
        </button>
      ))}
    </div>
  )
}
