import { useSyncExternalStore } from 'react'
import { pinStore } from '@/utils/alerts/pins'

/**
 * The rules this viewer has pinned (utils/alerts/pins.js): `pinned`, a Set of
 * rule ids as text, and `togglePin(id)`, which returns its undo. One store
 * behind every caller, so a pin made anywhere is seen everywhere.
 */
export function usePinnedRules() {
  const store = pinStore()
  const pinned = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  return { pinned, togglePin: store.toggle }
}
