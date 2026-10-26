import { useCallback, useEffect, useRef } from 'react'

/**
 * Keeps keyboard focus in a list whose items can leave it (7c). When the item
 * that held focus is gone — deleted, filtered away — and focus has dropped to
 * the page, it moves to the item that took its place (the last one, if it was
 * last), or to `fallback()` when the list is empty, instead of leaving someone
 * on the keyboard back at the top of the page.
 *
 * Items are `item` elements carrying `data-key`; `target` is the control to
 * focus in one. Returns the `onFocus` for the list's container.
 *
 *   const onListFocus = useFocusHandoff(listRef, { item: '.cfg-item', target: '.cfg-item-name', fallback })
 *   <ul ref={listRef} onFocus={onListFocus}>…</ul>
 */
export function useFocusHandoff(listRef, { item, target, fallback }) {
  const last = useRef(null)
  const fallbackRef = useRef(fallback)
  fallbackRef.current = fallback

  const onFocus = useCallback((e) => {
    const el = e.target.closest?.(item)
    const list = listRef.current
    if (!el || !list?.contains(el)) return
    last.current = { key: el.dataset.key, index: [...list.querySelectorAll(item)].indexOf(el) }
  }, [item, listRef])

  useEffect(() => {
    const was = last.current
    if (!was) return
    const active = document.activeElement
    if (active && active !== document.body) return
    const list = listRef.current
    if (list && was.key != null && list.querySelector(`${item}[data-key="${CSS.escape(String(was.key))}"]`)) return
    last.current = null
    const items = list ? [...list.querySelectorAll(item)] : []
    const next = items[Math.min(was.index, items.length - 1)]
    const to = next?.querySelector(target) ?? fallbackRef.current?.()
    to?.focus()
  })

  return onFocus
}
