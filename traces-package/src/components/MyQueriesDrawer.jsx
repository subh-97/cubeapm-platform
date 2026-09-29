// The list of saved queries — the user's own alongside the seeded examples.

import { useState } from 'react'
import { chipsToString } from '@/components/QueryBuilder'
import { composeQuery, withImpliedCount } from '@/utils/pipes'

// Absolute, not "2h ago". The seeded history is anchored to the mock
// BASE_TIME, but a saved query is stamped with the real clock, so a relative
// figure would be measured against a clock that is not running.
function formatSavedAt(ts) {
  if (!ts) return null
  return new Date(ts).toLocaleString(undefined, {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

// The seeded examples are listed alongside what the user has saved so the panel
// is never empty on a first visit, but only their own are removable — deleting
// a worked example out of a prototype leaves nothing to put back.
export default function MyQueriesDrawer({ onClose, saved, onApply, onDelete }) {
  const [search, setSearch] = useState('')

  const match = (q) => !search
    || q.name.toLowerCase().includes(search.toLowerCase())
    || chipsToString(q.chips).toLowerCase().includes(search.toLowerCase())

  const mine = saved.filter(match)

  const Row = ({ q, onRemove }) => (
    <div className="qh-item" onClick={() => onApply(q)}>
      <div className="qh-item-top">
        <span className="sq-item-name">{q.name}</span>
        {onRemove && (
          <button
            className="sq-item-del"
            title={`Delete “${q.name}”`}
            aria-label={`Delete ${q.name}`}
            onClick={(e) => { e.stopPropagation(); onRemove(q.id) }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        )}
      </div>
      {q.description && <div className="sq-item-desc">{q.description}</div>}
      <div className="qh-item-meta">
        <code className="qh-item-query">{composeQuery(chipsToString(q.chips), withImpliedCount(q.pipes || []))}</code>
      </div>
      {q.savedAt && (
        <div className="sq-item-tags">
          <span className="sq-item-saved">Saved {formatSavedAt(q.savedAt)}</span>
        </div>
      )}
    </div>
  )

  return (
    <div className="alert-drawer-overlay" onClick={onClose}>
      <aside className="alert-drawer qh-drawer" onClick={e => e.stopPropagation()}>
        <div className="alert-drawer-head">
          <div>
            <div className="alert-drawer-title">My Queries</div>
            <div className="alert-drawer-sub">Saved filters and pipes, ready to reapply</div>
          </div>
          <button className="log-detail-close" onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </div>
        {saved.length > 0 && (
          <div className="qh-toolbar">
            <div className="qh-search">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
              <input placeholder="Search saved queries…" value={search} onChange={e => setSearch(e.target.value)} />
            </div>
          </div>
        )}
        <div className="qh-list">
          {/* Two different nothings: an empty shelf, and a search that found
              none of what is on it. Only the first is worth explaining. */}
          {saved.length === 0 ? (
            <div className="sq-empty">
              <span className="sq-empty-icon"><Bookmark strokeWidth={1.5} /></span>
              <div className="sq-empty-title">No saved queries yet</div>
              <p className="sq-empty-text">
                Run a query you want to keep, then choose <strong>Save Query</strong>.
                It comes back with its filters and pipes exactly as you left them.
              </p>
            </div>
          ) : mine.length === 0 ? (
            <div className="qh-empty">No saved queries match your search</div>
          ) : (
            mine.map(q => <Row key={q.id} q={q} onRemove={onDelete} />)
          )}
        </div>
      </aside>
    </div>
  )
}
