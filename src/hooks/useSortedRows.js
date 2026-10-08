import { useState, useMemo, useCallback } from 'react'

// Column sort state for a table. Clicking the header toggles asc → desc →
// unsorted. `rows` are returned already ordered. A `defaultKey` is used when
// nothing is picked.
export function useSortedRows(rows, defaultKey = null, defaultDir = 'desc') {
  const [sort, setSort] = useState(defaultKey ? { key: defaultKey, dir: defaultDir } : null)
  const sorted = useMemo(() => {
    if (!sort) return rows
    const list = [...rows]
    list.sort((a, b) => {
      const av = a[sort.key], bv = b[sort.key]
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      if (typeof av === 'number' && typeof bv === 'number') return sort.dir === 'asc' ? av - bv : bv - av
      return sort.dir === 'asc'
        ? String(av).localeCompare(String(bv))
        : String(bv).localeCompare(String(av))
    })
    return list
  }, [rows, sort])
  const toggle = useCallback(key => setSort(cur => {
    if (!cur || cur.key !== key) return { key, dir: 'desc' }
    if (cur.dir === 'desc') return { key, dir: 'asc' }
    return null
  }), [])
  return { rows: sorted, sort, toggle }
}
