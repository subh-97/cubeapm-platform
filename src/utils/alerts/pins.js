// The rules this viewer has pinned to the top of the Rules list
// (docs/alerts/DESIGN.md D3). A pin is the viewer's own arrangement of the
// list, as an open row is, not part of the rule: production has no pins, the
// API has nowhere to keep one, and a teammate's list is not reordered by it.
// So it lives beside the alerts store rather than in its overlay of edits,
// under its own key, and outlives a new seed version (rule ids do).
//
// Persisted to localStorage inside try/catch, as the store is: a private
// window, or storage that throws, keeps the pins for the session. Another tab
// pinning a rule is picked up through the `storage` event, listened to for
// the store's whole life: a list that mounts later must not start from pins
// another tab has since changed, nor write them back over that tab's.

const STORAGE_KEY = 'cubeapm.alerts.pinned'
const VERSION = 1

const key = id => String(id)

function readStored(storage) {
  try {
    const raw = storage?.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (parsed?.version !== VERSION || !Array.isArray(parsed.ids)) return []
    return [...new Set(parsed.ids.map(key))]
  } catch {
    return []
  }
}

/**
 * A store of pinned rule ids (as text: a URL's rule_id and a view's id must
 * name the same rule). `getSnapshot` is a Set that changes identity only when
 * a pin does, for useSyncExternalStore. `toggle(id)` returns its undo;
 * `drop(id)` unpins a rule being deleted, returning the undo, or null when it
 * was not pinned.
 * `storage` is anything with getItem/setItem; `win` is what `storage` events
 * come from (tests pass neither).
 */
export function createPinStore({ storage = null, win = null } = {}) {
  let ids = readStored(storage)
  let snapshot = new Set(ids)
  const listeners = new Set()

  const publish = (next, { save = true } = {}) => {
    ids = next
    snapshot = new Set(ids)
    if (save) {
      try {
        storage?.setItem(STORAGE_KEY, JSON.stringify({ version: VERSION, ids }))
      } catch {
        // Not remembered across reloads; still pinned for the session.
      }
    }
    for (const fn of listeners) fn()
  }

  // `key` is null when another tab cleared all of storage.
  win?.addEventListener?.('storage', (e) => {
    if (e.key !== STORAGE_KEY && e.key !== null) return
    const next = readStored(storage)
    if (next.join('\n') !== ids.join('\n')) publish(next, { save: false })
  })

  const store = {
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    getSnapshot: () => snapshot,
    isPinned: id => snapshot.has(key(id)),
    /** Pin a rule that is not pinned, unpin one that is; returns the undo. */
    toggle(id) {
      const k = key(id)
      const was = snapshot.has(k)
      publish(was ? ids.filter(x => x !== k) : [...ids, k])
      return () => {
        if (snapshot.has(k) === was) return
        publish(was ? [...ids, k] : ids.filter(x => x !== k))
      }
    },
    drop: id => (snapshot.has(key(id)) ? store.toggle(id) : null),
  }
  return store
}

function browser() {
  try {
    return typeof window !== 'undefined' ? { storage: window.localStorage, win: window } : {}
  } catch {
    return {}
  }
}

let shared = null
/** The page's one pin store, made on first use. */
export function pinStore() {
  if (!shared) shared = createPinStore(browser())
  return shared
}
