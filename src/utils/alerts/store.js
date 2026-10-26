// The Alerts module's state: the seed, plus whatever this viewer has changed
// (docs/alerts/DESIGN.md D15; signed off as Q9).
//
// The seed is written relative to BASE_TIME — the snooze taken "nineteen
// minutes ago", the deploy window open "now" — so it is rebuilt fresh on every
// load. What is saved is only the viewer's EDITS, as an overlay keyed by id:
// a rule paused, a snooze added, a contact point deleted. Saving the whole
// state instead would freeze the seed's relative times at the moment of the
// save, and a reload an hour later would show the demo's snooze long expired.
//
// One store for the page (`alertsStore`), read through useSyncExternalStore
// (hooks/useAlerts.js), so every component sees the same state and an edit on
// the rule page is there when the list mounts. Persisted to localStorage under
// a versioned key, inside try/catch: a private window, or storage that throws,
// keeps edits for the session and nothing breaks. A new seed version discards
// edits made against the old one rather than mixing them in.

import {
  alertsSeed, ruleDefsFor, evaluateRules, ruleHistory, ruleTimelineForWindow, notificationLogForWindow,
  alertStatsForWindow, ruleSeriesForWindow, previousWindowOf, lastDeliveries, SEED_VERSION, ALERTS_NOW, HORIZON_SEC,
} from '@/data/alerts'
import { ruleView, sortRules } from './model.js'

const STORAGE_KEY = 'cubeapm.alerts.edits'
const COLLECTIONS = ['rules', 'receiverGroups', 'muteGroups', 'silences']

// What evaluation adds to a rule; never stored.
const EVALUATED = ['state', 'health', 'lastEvaluation', 'lastError', 'alerts', 'seriesCount']
const definitionOf = rule => Object.fromEntries(Object.entries(rule).filter(([k]) => !EVALUATED.includes(k)))

const emptyOverlay = () => ({ rules: {}, receiverGroups: {}, muteGroups: {}, silences: {} })

/**
 * The seed with an overlay applied: an id mapped to an object replaces (or
 * adds) that item, mapped to null removes it. Seed order is kept; additions
 * follow in the order they were made.
 */
export function applyOverlay(seed, overlay) {
  const out = { ...seed }
  for (const name of COLLECTIONS) {
    const edits = overlay?.[name] ?? {}
    const list = (seed[name] ?? [])
      .filter(item => edits[String(item.id)] !== null)
      .map(item => (edits[String(item.id)] ? edits[String(item.id)] : item))
    const known = new Set((seed[name] ?? []).map(item => String(item.id)))
    for (const [id, item] of Object.entries(edits)) if (item && !known.has(id)) list.push(item)
    out[name] = list
  }
  return out
}

function readStored(storage) {
  try {
    const raw = storage?.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (parsed?.version !== SEED_VERSION || typeof parsed.overlay !== 'object' || !parsed.overlay) return null
    return { ...emptyOverlay(), ...parsed.overlay }
  } catch {
    return null
  }
}

const uuid = () => (globalThis.crypto?.randomUUID?.()
  ?? `s-${Date.now().toString(16)}-${Math.floor(Math.random() * 0xffffffff).toString(16)}`)

const iso = sec => new Date(sec * 1000).toISOString()

/**
 * A store over the seed and a viewer's edits.
 *
 * `storage` is anything with getItem/setItem (localStorage by default; tests
 * pass a Map-backed one). `seed` and `now` are injectable for the same reason.
 * Every action returns an `undo` function that restores exactly what it
 * changed — the Undo on the toast it raises (D16) — or null when it changed
 * nothing (a rule an SLO owns, a contact point still in use).
 */
export function createAlertsStore({ storage = null, seed = alertsSeed, now = () => ALERTS_NOW } = {}) {
  let overlay = readStored(storage) ?? emptyOverlay()
  let base = seed()
  let state = { ...applyOverlay(base, overlay), refreshedAt: now() }
  const listeners = new Set()

  const persist = () => {
    try {
      storage?.setItem(STORAGE_KEY, JSON.stringify({ version: SEED_VERSION, overlay }))
    } catch {
      // Not remembered across reloads; still applied for the session.
    }
  }
  const publish = () => {
    state = { ...applyOverlay(base, overlay), refreshedAt: state.refreshedAt }
    persist()
    for (const fn of listeners) fn()
  }

  // Sets one overlay entry and returns the undo for it.
  const commit = (collection, id, value) => {
    const key = String(id)
    const had = Object.prototype.hasOwnProperty.call(overlay[collection], key)
    const prev = overlay[collection][key]
    overlay = { ...overlay, [collection]: { ...overlay[collection], [key]: value } }
    publish()
    return () => {
      const next = { ...overlay[collection] }
      if (had) next[key] = prev
      else delete next[key]
      overlay = { ...overlay, [collection]: next }
      publish()
    }
  }
  const find = (collection, id) => state[collection].find(item => String(item.id) === String(id))
  const ruleUses = (field, id) => state.rules.some(r => (r.config?.[field] ?? []).includes(id))

  const setStatus = (ruleId, status) => {
    const rule = find('rules', ruleId)
    if (!rule || rule.status === status) return null
    return commit('rules', ruleId, { ...definitionOf(rule), status })
  }

  const actions = {
    pause: ruleId => setStatus(ruleId, 'PAUSED'),
    resume: ruleId => setStatus(ruleId, 'ACTIVE'),

    /**
     * Snooze a rule: `minutes` from now (production's presets floor the start
     * to the minute), or `{ start, end, comment }` in unix seconds for Custom.
     * The whole rule, as production's snooze is (§10). Any rule can be
     * snoozed, an SLO's included (D18): a snooze holds notifications by
     * rule_id and changes nothing the rule's owner set.
     */
    snooze(ruleId, spec) {
      const t = now()
      const start = typeof spec === 'number' ? Math.floor(t / 60) * 60 : Math.floor(Number(spec?.start ?? t))
      const end = typeof spec === 'number' ? start + spec * 60 : Math.floor(Number(spec?.end))
      if (!(end > start)) return null
      const id = uuid()
      return commit('silences', id, {
        id,
        matchers: [{ name: 'rule_id', value: String(ruleId), isEqual: true, isRegex: false }],
        startsAt: iso(start),
        endsAt: iso(end),
        createdBy: 'you',
        comment: typeof spec === 'object' ? spec?.comment ?? '' : '',
        status: { state: start > t ? 'pending' : 'active' },
        updatedAt: iso(t),
      })
    },

    /**
     * End a snooze. One in force is expired now, so its history stays; one
     * that has not started yet never held anything and is simply removed.
     */
    unsnooze(silenceId) {
      const s = find('silences', silenceId)
      if (!s) return null
      const t = now()
      if (Date.parse(s.startsAt) / 1000 > t) return commit('silences', silenceId, null)
      if (Date.parse(s.endsAt) / 1000 <= t) return null
      return commit('silences', silenceId, { ...s, endsAt: iso(t), status: { state: 'expired' } })
    },

    remove(ruleId) {
      return find('rules', ruleId) ? commit('rules', ruleId, null) : null
    },

    /**
     * Save a rule from the editor. A rule without an id is new and gets the
     * next free one; the saved definition comes back with `undo`, so the
     * editor can go to its page.
     */
    saveRule(rule) {
      let id = rule?.id
      if (id == null || id === 0 || id === '') id = Math.max(1000, ...state.rules.map(r => Number(r.id) || 0)) + 1
      const saved = { ...definitionOf(rule), id }
      const undo = commit('rules', id, saved)
      return { rule: saved, undo }
    },

    saveReceiverGroup(group) {
      let id = group?.id
      if (id == null || id === 0 || id === '') id = Math.max(100, ...state.receiverGroups.map(g => Number(g.id) || 0)) + 1
      const saved = { ...group, id }
      return { group: saved, undo: commit('receiverGroups', id, saved) }
    },
    /** Refused while any rule still sends to it (D9). */
    removeReceiverGroup(id) {
      if (!find('receiverGroups', id) || ruleUses('receiver_group_ids', id)) return null
      return commit('receiverGroups', id, null)
    },

    saveMuteGroup(group) {
      let id = group?.id
      if (id == null || id === 0 || id === '') id = Math.max(100, ...state.muteGroups.map(g => Number(g.id) || 0)) + 1
      const saved = { ...group, id }
      return { group: saved, undo: commit('muteGroups', id, saved) }
    },
    /** Refused while any rule is still muted by it. */
    removeMuteGroup(id) {
      if (!find('muteGroups', id) || ruleUses('mute_group_ids', id)) return null
      return commit('muteGroups', id, null)
    },

    /** Forget every edit and go back to the seed. */
    reset() {
      overlay = emptyOverlay()
      base = seed()
      publish()
    },
  }

  return {
    getState: () => state,
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    actions,
    /**
     * Read again. The mock's evaluation is fixed at load, so this re-reads
     * the same answer; what it changes is when the page last asked, which is
     * what "Updated 12s ago" says (D16).
     */
    refresh() {
      state = { ...state, refreshedAt: Math.floor(Date.now() / 1000) }
      for (const fn of listeners) fn()
    },
  }
}

function browserStorage() {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null
  } catch {
    return null
  }
}

let shared = null
/** The page's one store, made on first use. */
export function alertsStore() {
  if (!shared) shared = createAlertsStore({ storage: browserStorage() })
  return shared
}

/**
 * Everything the Alerts pages read, derived from a store state and a window:
 *
 *   { rules (views, worst first), byId(id), seriesFor(id), timeline, log,
 *     stats, receiverGroups, muteGroups, silences, slos, monitors, lookups,
 *     updatedAt, stale }
 *
 * `seriesFor(id)` is a rule's query over the window, for its chart and its
 * row's sparkline: `[{ key, labels, points, previousPoints, previous }]`,
 * where `previousPoints` is the same series one span earlier on the same
 * buckets (D3's delta, D5's dashed line) and `previous` its last reading.
 * Memoised per rule, so a page draws a rule without assembling the store's
 * state for the data module itself.
 *
 * `win` may be omitted by a page that reads no history; timeline, log and
 * stats are then empty. Pure: the hook adds the actions and memoises.
 */
export function alertsFor(state, win, nowSec = ALERTS_NOW) {
  const defs = ruleDefsFor(state)
  const defById = new Map(defs.map(d => [d.id, d]))
  const evaluated = evaluateRules(defs, state)
  const rules = sortRules(evaluated.map(r => ruleView(r, { ...state, history: ruleHistory(defById.get(r.id), state), nowSec })))
  const byIdMap = new Map(rules.map(v => [String(v.id), v]))
  const series = new Map()
  const prevWin = win ? previousWindowOf(win) : null
  const lastValue = points => {
    for (let i = points.length - 1; i >= 0; i--) if (points[i].value != null) return points[i].value
    return null
  }
  const seriesFor = id => {
    const key = String(id)
    if (!series.has(key)) {
      const view = byIdMap.get(key)
      if (!win || !view) series.set(key, [])
      else {
        const now = ruleSeriesForWindow(win, view.rule, state)
        const before = new Map(ruleSeriesForWindow(prevWin, view.rule, state).map(s => [s.key, s]))
        series.set(key, now.map(s => {
          const prev = before.get(s.key)
          const previousPoints = s.points.map((p, i) => ({ ...p, value: prev?.points[i]?.value ?? null }))
          return { ...s, previousPoints, previous: lastValue(previousPoints) }
        }))
      }
    }
    return series.get(key)
  }
  return {
    rules,
    byId: id => byIdMap.get(String(id)) ?? null,
    seriesFor,
    timeline: win ? ruleTimelineForWindow(win, defs, state) : [],
    log: win ? notificationLogForWindow(win, defs, state) : [],
    stats: win ? alertStatsForWindow(win, defs, state) : [],
    // The previous period's numbers, for Insights' deltas (D11): asked for, not
    // computed, and null when that period reaches past the evaluated history
    // (a week's previous week does), rather than a comparison with nothing.
    statsBefore: () => (prevWin && prevWin.start >= ALERTS_NOW - HORIZON_SEC ? alertStatsForWindow(prevWin, defs, state) : null),
    receiverGroups: state.receiverGroups,
    // Asked for, not computed: only the Contact points tab reads the whole
    // horizon's log (D9), and the data module memoises it on this state.
    deliveries: () => lastDeliveries(defs, state),
    muteGroups: state.muteGroups,
    silences: state.silences,
    slos: state.slos,
    monitors: state.monitors,
    lookups: {
      slackChannels: state.slackChannels,
      opsgenieTeams: state.opsgenieTeams,
      jiraProjects: state.jiraProjects,
      teams: state.teams,
      users: state.users,
    },
    updatedAt: state.refreshedAt ?? nowSec,
    // The mock never fails to refresh; the real API's failure state lands here (D16).
    stale: null,
  }
}
