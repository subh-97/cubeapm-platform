/**
 * Create an alert from the query currently on screen.
 *
 * Shared by Logs and Traces. The only thing that differs is what an empty query
 * means — every log, or every span — so that phrase is a prop and the rest of
 * the form is one definition.
 */
export default function AlertDrawer({ filters, query, onClose, emptyLabel = 'All records', namePlaceholder }) {
  const activeFilters = Object.entries(filters ?? {}).filter(([, s]) => s?.size)
  return (
    <div className="alert-drawer-overlay" onClick={onClose}>
      <aside className="alert-drawer" onClick={e => e.stopPropagation()}>
        <div className="alert-drawer-head">
          <div>
            <div className="alert-drawer-title">Create Alert</div>
            <div className="alert-drawer-sub">Alert fires when this query exceeds a threshold</div>
          </div>
          <button className="log-detail-close" onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </div>
        <div className="alert-drawer-body">
          <div className="alert-field">
            <label className="alert-label">Query</label>
            <div className="alert-value mono">{query || <span style={{ color: 'var(--text-muted)' }}>{emptyLabel}</span>}</div>
          </div>
          {activeFilters.length > 0 && (
            <div className="alert-field">
              <label className="alert-label">Active filters</label>
              <div className="alert-filters">
                {activeFilters.map(([k, s]) => (
                  <div key={k} className="alert-filter-row">
                    <span className="alert-filter-key">{k}</span>
                    <span className="alert-filter-vals">{[...s].join(', ')}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="alert-field">
            <label className="alert-label">Condition</label>
            <div className="alert-row">
              <select className="alert-select"><option>Count</option><option>Error rate</option></select>
              <select className="alert-select"><option>is above</option><option>is below</option></select>
              <input className="alert-input" type="number" defaultValue={100} />
            </div>
          </div>
          <div className="alert-field">
            <label className="alert-label">Evaluate every</label>
            <div className="alert-row">
              <select className="alert-select"><option>1 minute</option><option>5 minutes</option><option>15 minutes</option></select>
              <span className="alert-label" style={{ margin: 0 }}>for</span>
              <select className="alert-select"><option>1 minute</option><option>5 minutes</option></select>
            </div>
          </div>
          <div className="alert-field">
            <label className="alert-label">Alert name</label>
            <input className="alert-input wide" type="text" placeholder={namePlaceholder || 'e.g. High error rate on payment-service'} />
          </div>
          <div className="alert-field">
            <label className="alert-label">Notify via</label>
            <select className="alert-select wide"><option>Email</option><option>Slack</option><option>PagerDuty</option><option>Webhook</option></select>
          </div>
        </div>
        <div className="alert-drawer-foot">
          <button className="alert-btn-cancel" onClick={onClose}>Cancel</button>
          <button className="alert-btn-create" onClick={onClose}>Create Alert</button>
        </div>
      </aside>
    </div>
  )
}
