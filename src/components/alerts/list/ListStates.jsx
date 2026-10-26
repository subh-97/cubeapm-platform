import { useEffect, useState } from 'react'
import { BellRing, FilterX, Plus, TriangleAlert } from 'lucide-react'
import EmptyState from '@/components/shared/EmptyState'
import { formatLocal } from '@/utils/timeRange'
import { updatedText, staleText } from './firingSummary'

/**
 * "Updated just now" (D16): the alerts refresh on their own, so the page bar
 * says how old they are, beside the refresh controls. It reads "just now" for
 * the first minute, so it wakes once when that minute is up and every 15
 * seconds after. It is not a live region: a line that keeps changing would
 * talk over everything else a screen reader is saying.
 */
export function UpdatedAgo({ updatedAt }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!Number.isFinite(updatedAt)) return undefined
    const age = now / 1000 - updatedAt
    const wait = age < 60 ? Math.max(250, (60 - age) * 1000) : 15000
    const t = setTimeout(() => setNow(Date.now()), wait)
    return () => clearTimeout(t)
  }, [updatedAt, now])
  const text = updatedText(updatedAt, now)
  if (!text) return null
  return <span className="alr-updated" title={formatLocal(updatedAt * 1000, 'YYYY-MM-DD HH:mm:ss')}>{text}</span>
}

/**
 * One line for a refresh that failed, however many in a row (R43: production
 * stacked a toast per failed poll). The last good data stays on screen under it.
 */
export function StaleLine({ stale, onRetry }) {
  const text = staleText(stale)
  if (!text) return null
  return (
    <div className="rtab-stale" role="status">
      <TriangleAlert aria-hidden="true" />
      <span>{text}</span>
      {onRetry && (
        <>
          <span aria-hidden="true">·</span>
          <button type="button" className="rtab-stale-retry" onClick={onRetry}>Retry</button>
        </>
      )}
    </div>
  )
}

const bone = (style, extra = '') => <span className={`ovsk-bone ${extra}`} style={style} aria-hidden="true" />

/**
 * The band while the first load is out: the timeline's three lanes at the
 * size they will arrive at, so nothing below moves when they do (R44).
 */
export function BandSkeleton() {
  return (
    <div className="rtab-band" aria-hidden="true">
      <div className="panel rtab-tl">
        <div className="panel-head is-divided">{bone({ width: 120, height: 11 })}</div>
        <div className="rtab-tl-body">
          {[72, 58, 40].map(w => <span key={w} className="ovsk-bone rtab-sk-lane" style={{ width: `${w}%`, marginLeft: `${100 - w}%` }} />)}
        </div>
      </div>
    </div>
  )
}

/** Skeleton rows, in the rows' own columns (the HomeSkeleton precedent). */
export function RowsSkeleton({ rows = 6 }) {
  return (
    <div aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="rtab-sk-row">
          {bone({ width: 12, height: 12 })}
          {bone({ width: 68, height: 18 })}
          <span className="rtab-sk-lines">
            {bone({ width: `${62 - (i % 3) * 9}%`, height: 12 })}
            {bone({ width: `${44 + (i % 2) * 12}%`, height: 10 })}
          </span>
          <span className="rtab-sk-lines" style={{ alignItems: 'flex-end' }}>
            {bone({ width: 64, height: 12 })}
            {bone({ width: 96, height: 10 })}
          </span>
          <span className="rtab-sk-lines">
            {bone({ width: 70, height: 12 })}
            {bone({ width: 110, height: 10 })}
          </span>
          {bone({ width: 150, height: 24 }, 'is-inline')}
        </div>
      ))}
    </div>
  )
}

/**
 * No rules at all: what goes here, why it is empty, and what fills it (the UX
 * review's three questions, §2.6). The suggestions start from the services
 * nothing watches yet, at the thresholds that already colour their cards.
 */
export function NoRules({ suggestions = [], onNewRule, onSuggest }) {
  return (
    <EmptyState
      icon={BellRing}
      title="No alert rules yet"
      description="A rule watches a query and tells a contact point when it crosses a threshold. This workspace has none, so nothing here can fire or notify anyone."
      action={(
        <>
          {suggestions.length > 0 && (
            <>
              <div className="rtab-d-muted" style={{ fontSize: 11.5 }}>Start from a service:</div>
              <ul className="rtab-empty-suggest" aria-label="Suggested rules">
                {suggestions.map(s => (
                  <li key={s.service}>
                    <span className="svc">{s.service}</span>
                    <span className="what">{s.sentence}</span>
                    {onSuggest && (
                      <button type="button" className="rtab-link-btn" style={{ marginLeft: 'auto' }} onClick={() => onSuggest(s)}>
                        Create
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
          {onNewRule && (
            <div className="rtab-empty-actions">
              <button type="button" className="hbtn small primary" onClick={onNewRule}>
                <Plus aria-hidden="true" />
                New rule
              </button>
            </div>
          )}
        </>
      )}
    />
  )
}

/**
 * The filters left nothing: say which ones, with how many rules each value
 * matches (a value a link seeded at 0 is the usual culprit), and clear them.
 */
export function NoMatches({ explanation, onClear }) {
  const { filters = [], search = '' } = explanation ?? {}
  return (
    <EmptyState
      icon={FilterX}
      title="No rules match these filters"
      description="Every rule is still here; the filters below hide all of them."
      action={(
        <>
          {(filters.length > 0 || search) && (
            <ul className="rtab-empty-list" aria-label="Active filters">
              {filters.map(f => (
                <li key={`${f.key}=${f.value}`} className="rtab-empty-filter" title={`${f.title} = ${f.label}: ${f.count} rule${f.count === 1 ? '' : 's'}`}>
                  <span>{f.title}</span>
                  <span className="v">{f.label}</span>
                  <span className="zero">· {f.count}</span>
                </li>
              ))}
              {search && (
                <li className="rtab-empty-filter" title={search}>
                  <span>search</span>
                  <span className="v">{search}</span>
                </li>
              )}
            </ul>
          )}
          <div className="rtab-empty-actions">
            <button type="button" className="search-empty-clear" onClick={onClear}>Clear filters</button>
          </div>
        </>
      )}
    />
  )
}
