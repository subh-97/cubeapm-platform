import { useCallback, useState } from 'react'
import { ALERT_RECENT_SEEDS } from '@/components/alerts/list/alertFilters'

/**
 * The Rules tab's recent searches for the filter bar's overlay (the same
 * recents section Logs, Traces and Errors have). A search is a chip array;
 * running one moves it to the front, deduped, capped, and persisted per
 * browser. Reads and writes are wrapped so a private window keeps them for the
 * session and nothing breaks.
 */
const KEY = 'cubeapm.alerts.recent-searches'
const MAX = 6

const read = () => {
  try {
    const r = JSON.parse(localStorage.getItem(KEY))
    return Array.isArray(r) && r.every(Array.isArray) ? r : null
  } catch {
    return null
  }
}

export function useRecentSearches() {
  const [recents, setRecents] = useState(() => read() ?? ALERT_RECENT_SEEDS)
  const addRecent = useCallback((chips) => {
    if (!chips?.length) return
    setRecents((prev) => {
      const key = JSON.stringify(chips)
      const next = [chips, ...prev.filter(r => JSON.stringify(r) !== key)].slice(0, MAX)
      try { localStorage.setItem(KEY, JSON.stringify(next)) } catch { /* kept for the session only */ }
      return next
    })
  }, [])
  return { recents, addRecent }
}
