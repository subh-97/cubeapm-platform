import { useState } from 'react'
import { BASE_TIME } from '@/data/observability'

function formatHistoryTime(d) {
  const now = BASE_TIME.getTime()
  const diff = now - d.getTime()
  if (diff < 60000) return 'just now'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
  return `${Math.floor(diff / 86400000)}d ago`
}

/**
 * Recent queries run on this workspace.
 *
 * The history itself is per-dataset — a span query is not a log query and
 * offering one on the other page would be offering a query that cannot run —
 * so the entries are a prop and only the panel is shared.
 */
export default function QueryHistoryDrawer({ history = [], onClose, onApply, subject = 'workspace' }) {
  const [search, setSearch] = useState('')

  const items = history.filter(h =>
    !search || h.query.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div className="alert-drawer-overlay" onClick={onClose}>
      <aside className="alert-drawer qh-drawer" onClick={e => e.stopPropagation()}>
        <div className="alert-drawer-head">
          <div>
            <div className="alert-drawer-title">Query History</div>
            <div className="alert-drawer-sub">Recent queries run on this {subject}</div>
          </div>
          <button className="log-detail-close" onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </div>
        <div className="qh-toolbar">
          <div className="qh-search">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
            <input placeholder="Search queries…" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
        </div>
        <div className="qh-list">
          {items.length === 0 && <div className="qh-empty">No queries match your search</div>}
          {items.map(h => (
            <div key={h.id} className="qh-item" onClick={() => onApply(h.query)}>
              <div className="qh-item-top">
                <code className="qh-item-query">{h.query}</code>
                <span className="qh-item-time">{formatHistoryTime(h.time)}</span>
              </div>
              <div className="qh-item-meta">
                <span className="qh-item-results">{h.results.toLocaleString()} results</span>
              </div>
            </div>
          ))}
        </div>
      </aside>
    </div>
  )
}
