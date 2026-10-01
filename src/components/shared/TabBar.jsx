import { clsx } from 'clsx'

/**
 * Compact pill tab bar - the one tab pattern on the platform.
 *
 * It renders the .tabbar / .tab classes from the stylesheet rather than
 * carrying its own utility styling. There used to be two tab looks that drifted
 * apart: this component for Alerts, Settings, Logs and Metrics, and the same
 * markup written by hand on Home. Both now read from one rule, so a change to
 * the selected pill lands everywhere at once.
 */
export default function TabBar({ tabs, active, onChange, className = '', ariaLabel }) {
  return (
    <div className={clsx('tabbar', className)} role="tablist" aria-label={ariaLabel}>
      {tabs.map(tab => (
        <button
          key={tab.id}
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
